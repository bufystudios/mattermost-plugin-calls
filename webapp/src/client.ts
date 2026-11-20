// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// eslint-disable max-lines
// eslint-disable-next-line simple-import-sort/imports
import {parseRTCStats, RTCMonitor, RTCPeer} from '@mattermost/calls-common';
import type {EmojiData, CallsClientJoinData, TrackInfo, RTPEncodingParameters} from '@mattermost/calls-common/lib/types';

import {EventEmitter} from 'events';

import {zlibSync, strToU8} from 'fflate';
import {MediaDevices, CallsClientConfig, CallsClientStats, TrackMetadata} from 'src/types/types';

import {logDebug, logErr, logInfo, logWarn, persistClientLogs, flushLogsToAccumulated} from './log';
import {P2PController, type P2PContext, type P2PState, type P2PTrackType} from './p2p';
import {getScreenStream, getPersistentStorage} from './utils';
import {WebSocketClient, WebSocketError, WebSocketErrorType} from './websocket';
import {
    STORAGE_CALLS_CLIENT_STATS_KEY,
    STORAGE_CALLS_DEFAULT_AUDIO_INPUT_KEY,
    STORAGE_CALLS_DEFAULT_AUDIO_OUTPUT_KEY,
    STORAGE_CALLS_DEFAULT_VIDEO_INPUT_KEY,
} from 'src/constants';
import {type BgBlurData, getBgBlurData} from 'src/local_storage';
import Segmenter from 'src/segmenter';

export const AudioInputPermissionsError = new Error('missing audio input permissions');
export const AudioInputMissingError = new Error('no audio input available');
export const VideoInputPermissionsError = new Error('missing video input permissions');
export const VideoInputMissingError = new Error('no video input available');
export const rtcPeerErr = new Error('rtc peer error');
export const rtcPeerTimeoutErr = new Error('timed out waiting for rtc connection');
export const rtcPeerCloseErr = new Error('rtc peer close');
export const insecureContextErr = new Error('insecure context');
export const userRemovedFromChannelErr = new Error('user was removed from channel');
export const userLeftChannelErr = new Error('user has left channel');
export const DefaultVideoTrackOptions: MediaTrackConstraints = {

    // TODO: consider exposing in user preferences
    frameRate: {
        ideal: 30,
    },
    width: {
        ideal: 640,
    },
    height: {
        ideal: 360,
    },
};

const rtcMonitorInterval = 10000;

// Screen sharing encodings (high quality). VP8 is the fallback track and is
// sent alongside AV1, so AV1 gets a lower cap (it is more efficient).
const screenEncodingsVP8 = {maxBitrate: 8_000_000, maxFramerate: 60, scaleResolutionDownBy: 1.0};
const screenEncodingsAV1 = {maxBitrate: 6_000_000, maxFramerate: 60, scaleResolutionDownBy: 1.0};

export default class CallsClient extends EventEmitter {
    public channelID: string;
    private readonly config: CallsClientConfig;
    private peer: RTCPeer | null;
    public ws: WebSocketClient | null;
    private localScreenTrack: MediaStreamTrack | null = null;
    public localVideoStream: MediaStream | null = null;
    private remoteScreenTrack: MediaStreamTrack | null = null;
    private remoteVoiceTracks: MediaStreamTrack[];
    private remoteVideoTracks: MediaStreamTrack[];
    public currentAudioInputDevice: MediaDeviceInfo | null = null;
    public currentAudioOutputDevice: MediaDeviceInfo | null = null;
    public currentVideoInputDevice: MediaDeviceInfo | null = null;
    private voiceTrackAdded: boolean;
    private videoTrackAdded: boolean;

    // ID of the track currently held by the video sender. The sender is kept
    // alive for the lifetime of the call (to avoid renegotiation), but the
    // underlying track is stopped and recreated as video is toggled off/on, so
    // we track the current ID to be able to replace it.
    private videoSenderTrackID = '';
    private streams: MediaStream[];
    private stream: MediaStream | null;
    private audioDevices: MediaDevices;
    private videoDevices: MediaDeviceInfo[];
    public audioTrack: MediaStreamTrack | null;
    private readonly onDeviceChange: () => void;
    private readonly onBeforeUnload: () => void;
    private closed = false;
    private connected = false;
    public initTime = Date.now();
    private rtcMonitor: RTCMonitor | null = null;
    private av1Codec: RTCRtpCodecCapability | null = null;
    private defaultAudioTrackOptions: MediaTrackConstraints;
    private defaultVideoTrackOptions: MediaTrackConstraints;
    private defaultVideoTrackEncodings: RTPEncodingParameters[];
    private segmenter: Segmenter | null = null;

    // P2P media path for 1:1 DM calls (see p2p.ts and docs/bufy-p2p.md).
    private p2p: P2PController | null = null;
    private pendingP2PContext: P2PContext | null = null;

    // True while the P2P connection carries the media. The SFU peer then sends
    // nothing (its senders are kept, holding null tracks) and the media is
    // sent again over the SFU if P2P is abandoned.
    private p2pActive = false;
    private localScreenStream: MediaStream | null = null;
    private localScreenAudioTrack: MediaStreamTrack | null = null;

    // Whether the screen senders exist on the SFU peer.
    private screenOnSFU = false;

    // Last screen track received from the SFU, to switch back to it if P2P goes away.
    private sfuRemoteScreenTrack: MediaStreamTrack | null = null;

    // Remote tracks received through the P2P connection.
    private p2pRemoteTracks = new Set<MediaStreamTrack>();

    constructor(config: CallsClientConfig) {
        logDebug('creating new calls client', JSON.stringify(config));
        super();
        this.ws = null;
        this.peer = null;
        this.audioTrack = null;
        this.currentAudioInputDevice = null;
        this.currentAudioInputDevice = null;
        this.currentVideoInputDevice = null;
        this.voiceTrackAdded = false;
        this.videoTrackAdded = false;
        this.videoSenderTrackID = '';
        this.streams = [];
        this.remoteVoiceTracks = [];
        this.remoteVideoTracks = [];
        this.stream = null;
        this.audioDevices = {inputs: [], outputs: []};
        this.videoDevices = [];
        this.channelID = '';
        this.config = config;
        this.defaultAudioTrackOptions = {
            autoGainControl: true,
            echoCancellation: true,
            noiseSuppression: true,
        };
        this.defaultVideoTrackOptions = DefaultVideoTrackOptions;
        this.defaultVideoTrackEncodings = [
            {maxBitrate: 1000 * 1000, maxFramerate: 30, scaleResolutionDownBy: 1.0},
        ];
        this.onDeviceChange = async () => {
            await this.updateDevices();
        };
        this.onBeforeUnload = () => {
            logDebug('unload');
            this.disconnect();
        };
        window.addEventListener('beforeunload', this.onBeforeUnload);
    }

    private async updateDevices() {
        logDebug('a/v device change detected');

        try {
            const devices = await navigator.mediaDevices.enumerateDevices();

            logDebug('enumerated devices', devices);

            const inputs = devices.filter((device) => device.kind === 'audioinput');
            const outputs = devices.filter((device) => device.kind === 'audiooutput');

            this.audioDevices = {
                inputs,
                outputs,
            };

            if (this.config.enableVideo) {
                this.videoDevices = devices.filter((device) => device.kind === 'videoinput');
            }

            if (this.currentAudioInputDevice) {
                await this.handleAudioDeviceFallback('input');
            }

            if (this.currentAudioOutputDevice) {
                await this.handleAudioDeviceFallback('output');
            }

            this.emit('devicechange', this.audioDevices, this.videoDevices);
        } catch (err) {
            logErr(err);
        }
    }

    private async handleAudioDeviceFallback(deviceType: string) {
        const currentDevice = deviceType === 'input' ? this.currentAudioInputDevice : this.currentAudioOutputDevice;
        const devices = deviceType === 'input' ? this.audioDevices.inputs : this.audioDevices.outputs;
        const missingCurrentDevice = !devices.some(device => currentDevice?.deviceId === device.deviceId);

        // Fallback to the system default device if the current one is not available.
        if (missingCurrentDevice && devices.length > 0) {
            logDebug(`selected audio ${deviceType} device not available, falling back to system default`, currentDevice, devices[0]);

            if (deviceType === 'input') {
                await this.setAudioInputDevice(devices[0], false);
            } else if (deviceType === 'output') {
                await this.setAudioOutputDevice(devices[0], false);
            }

            this.emit('devicefallback', devices[0]);

            return;
        }

        // If the user selected (i.g. stored) device comes back, we want to switch to it.
        const selectedDevice = this.getSelectedAudioDevice(deviceType);
        if (selectedDevice && selectedDevice.label !== currentDevice?.label) {
            logDebug(`selected audio ${deviceType} device is back, switching`, selectedDevice, currentDevice);

            if (deviceType === 'input') {
                await this.setAudioInputDevice(selectedDevice, false);
            } else if (deviceType === 'output') {
                await this.setAudioOutputDevice(selectedDevice, false);
            }

            this.emit('devicefallback', selectedDevice);
        }
    }

    private getSelectedAudioDevice(deviceType: string) {
        let selectedDevice: {deviceId: string; label?: string} = {
            deviceId: '',
        };

        const deviceKey = deviceType === 'input' ? STORAGE_CALLS_DEFAULT_AUDIO_INPUT_KEY : STORAGE_CALLS_DEFAULT_AUDIO_OUTPUT_KEY;

        const data = window.localStorage.getItem(deviceKey);

        if (data) {
            try {
                selectedDevice = JSON.parse(data);
            } catch {
                // Backwards compatibility case when we used to store the device id directly (before MM-63274).
                selectedDevice = {
                    deviceId: data,
                };
            }
        }

        if (!selectedDevice.deviceId) {
            return null;
        }

        let devices = deviceType === 'input' ? this.audioDevices.inputs : this.audioDevices.outputs;
        devices = devices.filter((dev) => {
            return dev.deviceId === selectedDevice.deviceId || dev.label === selectedDevice.label;
        });

        if (devices.length > 1) {
            // If there are multiple devices with the same label, we select the selected device by ID.
            logInfo(`getSelectedAudioDevice: multiple audio ${deviceType} devices found with the same label, checking by id`, devices);
            return devices.find((dev) => dev.deviceId === selectedDevice.deviceId) || null;
        } else if (devices.length === 1) {
            logDebug(`getSelectedAudioDevice: found selected audio ${deviceType} device to use`, devices[0]);
            return devices[0];
        }

        logDebug(`getSelectedAudioDevice: audio ${deviceType} device not found`, selectedDevice);

        return null;
    }

    private async initVideo(startVideo: boolean, deviceId?: string) {
        const videoOptions: MediaTrackConstraints = {
            ...this.defaultVideoTrackOptions,
        };

        if (deviceId) {
            videoOptions.deviceId = {
                exact: deviceId,
            };
        } else if (this.currentVideoInputDevice) {
            videoOptions.deviceId = {
                exact: this.currentVideoInputDevice.deviceId,
            };
        } else {
            let defaultInputDevice: {deviceId: string; label?: string} = {
                deviceId: '',
            };
            const defaultVideoInputData = window.localStorage.getItem(STORAGE_CALLS_DEFAULT_VIDEO_INPUT_KEY);
            if (defaultVideoInputData) {
                try {
                    defaultInputDevice = JSON.parse(defaultVideoInputData);
                } catch (err) {
                    logErr('failed to parse default video input device', err);
                }
            }

            if (defaultInputDevice.deviceId) {
                let devices = this.videoDevices.filter((dev) => {
                    return dev.deviceId === defaultInputDevice.deviceId || dev.label === defaultInputDevice.label;
                });

                if (devices.length > 1) {
                // If there are multiple devices with the same label, we select the default device by ID.
                    logInfo('multiple video input devices found with the same label, checking by id', devices);
                    devices = devices.filter((dev) => dev.deviceId === defaultInputDevice.deviceId);
                }

                if (devices && devices.length === 1) {
                    logDebug(`found default video input device to use: ${devices[0].label}`);
                    videoOptions.deviceId = {
                        exact: devices[0].deviceId,
                    };
                    this.currentVideoInputDevice = devices[0];
                } else {
                    logDebug('video input device not found');
                    window.localStorage.removeItem(STORAGE_CALLS_DEFAULT_VIDEO_INPUT_KEY);
                }
            }
        }

        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                video: videoOptions,
                audio: false,
            });

            // updating the devices again cause some browsers (e.g Firefox) will
            // return empty labels unless permissions were previously granted.
            await this.updateDevices();

            // Video should be off by default (for now). We initialize it to ensure permissions are there but
            // don't need to keep it active until the user explicitly starts it from UI.
            if (startVideo) {
                this.localVideoStream = stream;
                this.streams.push(stream);
                stream.getVideoTracks()[0].enabled = false;
            } else {
                stream.getVideoTracks()[0].stop();
                stream.getVideoTracks()[0].dispatchEvent(new Event('ended'));
            }

            this.emit('initvideo');
        } catch (err) {
            logErr(err);
            if (this.videoDevices.length > 0) {
                throw VideoInputPermissionsError;
            }
            throw VideoInputMissingError;
        }
    }

    private async initAudio(deviceId?: string) {
        const audioOptions: MediaTrackConstraints = {
            ...this.defaultAudioTrackOptions,
        };

        if (deviceId) {
            audioOptions.deviceId = {
                exact: deviceId,
            };
        }

        try {
            this.stream = await navigator.mediaDevices.getUserMedia({
                video: false,
                audio: audioOptions,
            });

            // If no deviceId is provided, we use the getUserMedia call purely to get permissions.
            // This is because if permissions were missing upon joining, we may have not gotten the right device labels
            // which would cause us to potentially fail to initialize a previously saved input device.
            // Now that we have permission, we update the devices once more and try again to see if we can use the stored input device.
            if (!deviceId) {
                this.stream.getAudioTracks().forEach((track) => {
                    track.stop();
                    track.dispatchEvent(new Event('ended'));
                });
            }

            // updating the devices again cause some browsers will
            // return empty labels unless permissions were previously granted.
            await this.updateDevices();

            if (!deviceId) {
                const selectedAudioInputDevice = this.getSelectedAudioDevice('input');
                if (selectedAudioInputDevice) {
                    audioOptions.deviceId = {
                        exact: selectedAudioInputDevice.deviceId,
                    };
                    this.currentAudioInputDevice = selectedAudioInputDevice;
                }

                const selectedAudioOutputDevice = this.getSelectedAudioDevice('output');
                if (selectedAudioOutputDevice) {
                    this.currentAudioOutputDevice = selectedAudioOutputDevice;
                }

                this.stream = await navigator.mediaDevices.getUserMedia({
                    video: false,
                    audio: audioOptions,
                });
            }

            this.audioTrack = this.stream.getAudioTracks()[0];
            this.streams.push(this.stream);

            this.audioTrack.enabled = false;

            this.emit('initaudio');
        } catch (err) {
            logErr(err);
            if (this.audioDevices.inputs.length > 0) {
                throw AudioInputPermissionsError;
            }
            throw AudioInputMissingError;
        }
    }

    private collectICEStats() {
        const start = Date.now();
        const seenMap: {[key: string]: string} = {};

        const gatherStats = async () => {
            if (!this.ws || !this.peer) {
                return;
            }

            try {
                const stats = parseRTCStats(await this.peer.getStats()).iceStats;
                for (const state of Object.keys(stats)) {
                    for (const pair of stats[state]) {
                        const seenState = seenMap[pair.id];
                        seenMap[pair.id] = pair.state;

                        if (seenState !== pair.state) {
                            logDebug('ice candidate pair stats', JSON.stringify(pair));
                        }

                        if (seenState === 'succeeded' || state !== 'succeeded') {
                            continue;
                        }

                        if (!pair.local || !pair.remote) {
                            continue;
                        }

                        this.ws.send('metric', {
                            metric_name: 'client_ice_candidate_pair',
                            data: JSON.stringify({
                                state: pair.state,
                                local: {
                                    type: pair.local.candidateType,
                                    protocol: pair.local.protocol,
                                },
                                remote: {
                                    type: pair.remote.candidateType,
                                    protocol: pair.remote.protocol,
                                },
                            }),
                        });
                    }
                }
            } catch (err) {
                logErr('failed to parse ICE stats', err);
            }

            // Repeat the check for at most 30 seconds.
            if (Date.now() < start + 30000) {
                // We check every two seconds.
                setTimeout(gatherStats, 2000);
            }
        };

        gatherStats();
    }

    public async init(joinData: CallsClientJoinData) {
        this.channelID = joinData.channelID;

        if (this.config.enableAV1 && !this.config.simulcast) {
            this.av1Codec = await RTCPeer.getVideoCodec('video/AV1');
            if (this.av1Codec) {
                logDebug('client has AV1 support');
                joinData.av1Support = true;
            }
        } else if (this.config.enableAV1 && this.config.simulcast) {
            logWarn('both simulcast and av1 support are enabled');
        }

        if (this.config.dcSignaling) {
            logDebug('enabling DC signaling on client');
            joinData.dcSignaling = true;
        }

        if (!window.isSecureContext) {
            throw insecureContextErr;
        }

        await this.updateDevices();
        navigator.mediaDevices.addEventListener('devicechange', this.onDeviceChange);

        try {
            const initializers = [this.initAudio()];
            if (this.config.enableVideo) {
                initializers.push(this.initVideo(false));
            }

            await Promise.all(initializers);

            if (this.closed) {
                this.cleanup();
                return;
            }
        } catch (err) {
            this.emit('error', err);
        }

        const ws = new WebSocketClient(this.config.wsURL, this.config.authToken);
        this.ws = ws;

        ws.on('error', (err: WebSocketError) => {
            logErr('ws error', err);
            switch (err.type) {
            case WebSocketErrorType.Native:
                break;
            case WebSocketErrorType.ReconnectTimeout:
                this.disconnect(err);
                break;
            case WebSocketErrorType.Join:
                this.disconnect(err);
                break;
            default:
            }
        });

        ws.on('close', (code?: number) => {
            logDebug(`ws close: ${code}`);
        });

        ws.on('open', (originalConnID: string, prevConnID: string, isReconnect: boolean) => {
            if (isReconnect) {
                logDebug('ws reconnect, sending reconnect msg');
                ws.send('reconnect', {
                    channelID: joinData.channelID,
                    originalConnID,
                    prevConnID,
                });
            } else {
                logDebug('ws open, sending join msg');
                ws.send('join', joinData);
            }
        });

        ws.on('join', async () => {
            if (this.closed) {
                return;
            }
            logDebug('join ack received, initializing connection');

            const peer = new RTCPeer({
                iceServers: this.config.iceServers || [],
                logger: {
                    logDebug,
                    logErr,
                    logWarn,
                    logInfo,
                },
                simulcast: this.config.simulcast,
                dcSignaling: this.config.dcSignaling,
                dcLocking: this.config.dcLocking,
            });

            this.peer = peer;

            this.collectICEStats();

            this.rtcMonitor = new RTCMonitor({
                peer,
                logger: {
                    logDebug,
                    logErr,
                    logWarn,
                    logInfo,
                },
                monitorInterval: rtcMonitorInterval,
            });
            this.rtcMonitor.on('mos', (mos: number) => this.emit('mos', mos));

            const sdpHandler = (sdp: RTCSessionDescription) => {
                const payload = JSON.stringify(sdp);

                // SDP data is compressed using zlib since it's text based
                // and can grow substantially, potentially hitting the maximum
                // message size (4KB).
                ws.send('sdp', {
                    data: zlibSync(strToU8(payload)),
                }, true);
            };
            peer.on('offer', sdpHandler);
            peer.on('answer', sdpHandler);

            peer.on('candidate', (candidate) => {
                ws.send('ice', {
                    data: JSON.stringify(candidate),
                });
            });

            peer.on('error', (err) => {
                logErr('peer error', err);
                if (!this.closed) {
                    this.disconnect(err === rtcPeerTimeoutErr.message ? rtcPeerTimeoutErr : rtcPeerErr);
                }
            });

            peer.on('stream', (remoteStream: MediaStream, trackInfo: TrackInfo) => {
                this.onRemoteStream(remoteStream, trackInfo, 'sfu');
            });

            peer.on('connect', () => {
                logDebug('rtc connected');

                this.emit('connect');
                this.rtcMonitor?.start();
                this.connected = true;
            });

            peer.on('close', () => {
                logDebug('rtc closed');

                if (!this.closed) {
                    this.disconnect(rtcPeerCloseErr);
                }
            });

            this.initP2P(ws);
        });

        ws.on('message', async ({data}) => {
            try {
                const msg = JSON.parse(data);
                if (!msg) {
                    return;
                }
                if (msg.type === 'answer' || msg.type === 'offer' || msg.type === 'candidate') {
                    if (this.peer) {
                        await this.peer.signal(data);
                    }
                } else if (msg.type === 'p2p_signal') {
                    this.p2p?.handleSignal({from: msg.from, kind: msg.kind, data: msg.data});
                }
            } catch (err) {
                logErr('ws.on(message): failed to handle message', err, 'data:', data);
            }
        });
    }

    private initP2P(ws: WebSocketClient) {
        if (!this.config.p2pEnabled || this.p2p) {
            return;
        }

        const p2p = new P2PController(ws.getOriginalConnID(), {
            iceServers: this.config.iceServers || [],
            enableAV1: this.config.enableAV1,
            encodings: {
                video: this.defaultVideoTrackEncodings[0],
                screenVP8: screenEncodingsVP8,
                screenAV1: screenEncodingsAV1,
            },
            sendSignal: (to, kind, data) => {
                // Compressed like SDP data since the offer can be large.
                ws.send('p2p_signal', {
                    data: zlibSync(strToU8(JSON.stringify({to, kind, data}))),
                }, true);
            },
        });
        this.p2p = p2p;

        p2p.on('statechange', (state: P2PState, prev: P2PState) => this.onP2PStateChange(state, prev));
        p2p.on('remotetrack', ({type, track}: {type: P2PTrackType; track: MediaStreamTrack}) => {
            this.onRemoteStream(new MediaStream([track]), {type}, 'p2p');
        });

        this.syncP2PMedia();
        if (this.pendingP2PContext) {
            p2p.setContext(this.pendingP2PContext);
        }
    }

    // Tells the client whether P2P media can be used. Called whenever the call
    // state (sessions, recording, ...) changes.
    public setP2PContext(ctx: P2PContext) {
        this.pendingP2PContext = ctx;
        this.p2p?.setContext(ctx);
    }

    public getP2PState(): P2PState | null {
        return this.p2p?.getState() ?? null;
    }

    // The local tracks that should be sent, regardless of the path (SFU or P2P).
    private syncP2PMedia() {
        if (!this.p2p) {
            return;
        }

        const videoTrack = this.localVideoStream?.getVideoTracks()[0];
        this.p2p.setLocalMedia({
            voice: this.audioTrack?.enabled ? this.audioTrack : null,
            video: videoTrack && videoTrack.enabled && videoTrack.readyState === 'live' ? videoTrack : null,
            screen: this.localScreenTrack,
            screenAudio: this.localScreenAudioTrack,
        });
    }

    private onP2PStateChange(state: P2PState, prev: P2PState) {
        if (state === 'p2p' && prev !== 'p2p') {
            this.p2pActive = true;
            this.suspendSFUMedia();
        } else if (state !== 'p2p' && prev === 'p2p') {
            this.p2pActive = false;
            this.restoreRemoteTracksFromSFU();
            this.resumeSFUMedia().catch((err) => logErr('failed to resume sending media over the SFU', err));
        }
    }

    // Stops sending media over the SFU. Senders are kept (with null tracks)
    // so that sending can be resumed without renegotiating.
    private suspendSFUMedia() {
        if (!this.peer) {
            return;
        }

        logDebug('p2p active, suspending media over the SFU');

        const replaceWithNull = (trackID: string) => {
            try {
                // @ts-ignore: we actually mean (and need) to pass null here
                this.peer?.replaceTrack(trackID, null);
            } catch (err) {
                logWarn('failed to suspend sfu sender', trackID, err);
            }
        };

        if (this.audioTrack && this.voiceTrackAdded) {
            replaceWithNull(this.audioTrack.id);
        }
        if (this.videoTrackAdded) {
            replaceWithNull(this.videoSenderTrackID);
        }
        if (this.screenOnSFU && this.localScreenTrack) {
            replaceWithNull(this.localScreenTrack.id);
            if (this.localScreenAudioTrack) {
                replaceWithNull(this.localScreenAudioTrack.id);
            }
        }
    }

    // Sends over the SFU whatever is currently enabled locally.
    private async resumeSFUMedia() {
        if (!this.peer || this.p2pActive) {
            return;
        }

        logDebug('p2p not active anymore, resuming media over the SFU');

        try {
            if (this.audioTrack?.enabled && this.stream) {
                if (this.voiceTrackAdded) {
                    this.peer.replaceTrack(this.audioTrack.id, this.audioTrack);
                } else {
                    await this.peer.addTrack(this.audioTrack, this.stream);
                    this.voiceTrackAdded = true;
                }
            }
        } catch (err) {
            logErr('failed to resume voice over the SFU', err);
        }

        try {
            const videoTrack = this.localVideoStream?.getVideoTracks()[0];
            if (videoTrack?.enabled && videoTrack.readyState === 'live') {
                await this.sendVideoOverSFU(videoTrack);
            }
        } catch (err) {
            logErr('failed to resume video over the SFU', err);
        }

        try {
            if (this.localScreenTrack && this.localScreenStream) {
                if (this.screenOnSFU) {
                    this.peer.replaceTrack(this.localScreenTrack.id, this.localScreenTrack);
                    if (this.localScreenAudioTrack) {
                        this.peer.replaceTrack(this.localScreenAudioTrack.id, this.localScreenAudioTrack);
                    }
                } else {
                    await this.sendScreenOverSFU(this.localScreenStream, this.localScreenTrack);
                }
            }
        } catch (err) {
            logErr('failed to resume screen over the SFU', err);
        }
    }

    // The remote P2P tracks are gone (their connection was closed) so we point the
    // UI back to the tracks received from the SFU, which resume as soon as
    // the other side sends over the SFU again.
    private restoreRemoteTracksFromSFU() {
        const isSFUTrack = (track: MediaStreamTrack) => !this.p2pRemoteTracks.has(track) && track.readyState === 'live';

        this.remoteVoiceTracks = this.remoteVoiceTracks.filter(isSFUTrack);

        this.remoteVideoTracks = this.remoteVideoTracks.filter(isSFUTrack);
        const videoTrack = this.remoteVideoTracks[this.remoteVideoTracks.length - 1];
        if (videoTrack) {
            this.emit('remoteVideoStream', new MediaStream([videoTrack]));
        }

        if (this.remoteScreenTrack && this.p2pRemoteTracks.has(this.remoteScreenTrack)) {
            this.remoteScreenTrack = null;
            if (this.sfuRemoteScreenTrack && isSFUTrack(this.sfuRemoteScreenTrack)) {
                this.remoteScreenTrack = this.sfuRemoteScreenTrack;
                this.emit('remoteScreenStream', new MediaStream([this.sfuRemoteScreenTrack]));
            }
        }

        this.p2pRemoteTracks.clear();
    }

    // Handles a remote track coming from either the SFU or the P2P connection.
    private onRemoteStream(remoteStream: MediaStream, trackInfo: {type?: P2PTrackType | string} | undefined, origin: 'sfu' | 'p2p') {
        logDebug('new remote stream received', origin, remoteStream.id, 'trackInfo:', trackInfo);
        for (const track of remoteStream.getTracks()) {
            logDebug('remote track', track.kind, track.id, 'label:', track.label);
        }

        this.streams.push(remoteStream);
        if (origin === 'p2p') {
            remoteStream.getTracks().forEach((track) => this.p2pRemoteTracks.add(track));
        }

        const audioTracks = remoteStream.getAudioTracks();
        const videoTracks = remoteStream.getVideoTracks();

        logDebug('stream has', audioTracks.length, 'audio tracks and', videoTracks.length, 'video tracks');

        // Handle audio tracks based on type
        if (audioTracks.length > 0) {
            if (trackInfo?.type === 'screen-audio') {
                // Screen share audio - emit as voice stream so it gets played
                logDebug('received screen-audio track, emitting as remoteVoiceStream');
                this.emit('remoteVoiceStream', new MediaStream(audioTracks));
                this.remoteVoiceTracks.push(...audioTracks);
            } else if (trackInfo?.type === 'voice' || !trackInfo?.type) {
                // Regular voice audio
                logDebug('received voice track, emitting as remoteVoiceStream');
                this.emit('remoteVoiceStream', remoteStream);
                this.remoteVoiceTracks.push(...audioTracks);
            } else {
                logDebug('unexpected audio track type:', trackInfo?.type);
            }
        }

        // Handle video tracks based on type
        if (videoTracks.length > 0) {
            if (trackInfo?.type === 'video') {
                logDebug('received video track, emitting as remoteVideoStream');
                this.emit('remoteVideoStream', remoteStream);
                this.remoteVideoTracks.push(videoTracks[0]);
            } else if (trackInfo?.type === 'screen') {
                logDebug('received screen track, emitting as remoteScreenStream');
                this.emit('remoteScreenStream', remoteStream);
                this.remoteScreenTrack = videoTracks[0];
                if (origin === 'sfu') {
                    this.sfuRemoteScreenTrack = videoTracks[0];
                }
            } else {
                logDebug('unexpected video track type:', trackInfo?.type);
            }
        }
    }

    public destroy() {
        this.removeAllListeners('close');
        this.removeAllListeners('connect');
        this.removeAllListeners('remoteVoiceStream');
        this.removeAllListeners('remoteScreenStream');
        this.removeAllListeners('localScreenStream');
        this.removeAllListeners('localVideoStream');
        this.removeAllListeners('devicechange');
        this.removeAllListeners('devicefallback');
        this.removeAllListeners('error');
        this.removeAllListeners('initaudio');
        this.removeAllListeners('initvideo');
        this.removeAllListeners('mute');
        this.removeAllListeners('unmute');
        this.removeAllListeners('raise_hand');
        this.removeAllListeners('lower_hand');
        this.removeAllListeners('mos');
        this.removeAllListeners('video_on');
        this.removeAllListeners('video_off');
        window.removeEventListener('beforeunload', this.onBeforeUnload);
        navigator.mediaDevices?.removeEventListener('devicechange', this.onDeviceChange);
        this.segmenter?.stop();
        this.segmenter = null;
        persistClientLogs();
    }

    public async setAudioInputDevice(device: MediaDeviceInfo, store: boolean = true) {
        if (!this.peer) {
            return;
        }

        if (store) {
            window.localStorage.setItem(STORAGE_CALLS_DEFAULT_AUDIO_INPUT_KEY, JSON.stringify(device));
        }
        this.currentAudioInputDevice = device;

        // We emit this event so it's easier to keep state in sync between widget and pop out.
        this.emit('devicechange', this.audioDevices, this.videoDevices);

        // If no track/stream exists we need to initialize again.
        // This edge case can happen if the default input device failed
        // but there are potentially more valid ones to choose (MM-48822).
        if (!this.audioTrack || !this.stream) {
            await this.initAudio(device.deviceId);
            return;
        }

        const isEnabled = this.audioTrack.enabled;
        const oldTrack = this.audioTrack;

        try {
            const newStream = await navigator.mediaDevices.getUserMedia({
                video: false,
                audio: {
                    ...this.defaultAudioTrackOptions,
                    deviceId: {
                        exact: device.deviceId,
                    },
                },
            });
            this.streams.push(newStream);
            const newTrack = newStream.getAudioTracks()[0];

            // Stop old track only after successfully getting new track
            oldTrack.stop();

            this.stream.removeTrack(oldTrack);
            this.stream.addTrack(newTrack);
            newTrack.enabled = isEnabled;
            if (isEnabled && !this.p2pActive) {
                // voiceTrackAdded must be true if the track is enabled.
                logDebug('replacing track to peer', newTrack.id);
                this.peer.replaceTrack(oldTrack.id, newTrack);
            } else {
                // Not sending over the SFU (muted, or media goes peer to peer): the new
                // track is added to the SFU peer when needed.
                this.voiceTrackAdded = false;
            }
            this.audioTrack = newTrack;
            this.syncP2PMedia();
        } catch (err) {
            logErr('setAudioInputDevice: failed to switch audio input device', device.deviceId, err);
            throw err;
        }
    }

    public async setVideoInputDevice(device: MediaDeviceInfo) {
        if (!this.peer) {
            return;
        }

        window.localStorage.setItem(STORAGE_CALLS_DEFAULT_VIDEO_INPUT_KEY, JSON.stringify(device));
        this.currentVideoInputDevice = device;

        // We emit this event so it's easier to keep state in sync between widget and pop out.
        this.emit('devicechange', this.audioDevices, this.videoDevices);

        // If no track/stream exists we need to initialize again.
        // This edge case can happen if the default input device failed
        // but there are potentially more valid ones to choose (MM-48822).
        if (!this.localVideoStream) {
            await this.initVideo(false, device.deviceId);
            return;
        }

        const videoTrack = this.localVideoStream.getVideoTracks()[0];
        const isEnabled = videoTrack.enabled;
        const oldSegmenter = this.segmenter;

        try {
            const newStream = await navigator.mediaDevices.getUserMedia({
                audio: false,
                video: {
                    ...this.defaultVideoTrackOptions,
                    deviceId: {
                        exact: device.deviceId,
                    },
                },
            });
            this.streams.push(newStream);

            let newTrack = newStream.getVideoTracks()[0];

            const bgBlurData = getBgBlurData();
            if (bgBlurData.blurBackground && bgBlurData.blurIntensity > 0) {
                logDebug('background blur enabled', bgBlurData);
                newTrack = await this.initBgBackgroundTrack(newStream, bgBlurData);
            }

            // Stop old track and segmenter only after successfully getting and processing new track
            videoTrack.stop();
            videoTrack.dispatchEvent(new Event('ended'));
            if (oldSegmenter) {
                oldSegmenter.stop();

                // Clear segmenter reference if blur is now disabled
                if (!bgBlurData.blurBackground) {
                    this.segmenter = null;
                }
            }

            this.localVideoStream.removeTrack(videoTrack);
            this.localVideoStream.addTrack(newTrack);
            this.localVideoStream = newStream;

            newTrack.enabled = isEnabled;
            if (isEnabled) {
                if (!this.p2pActive) {
                    // videoTrackAdded must be true if the track is enabled.
                    logDebug('replacing track to peer', newTrack.id);
                    this.peer.replaceTrack(videoTrack.id, newTrack);

                    // Keep track of the new ID the sender holds so a later stopVideo
                    // can replace it (the peer re-keys its senders map by track ID).
                    this.videoSenderTrackID = newTrack.id;
                }
                this.emit('localVideoStream', newStream);
            } else {
                this.videoTrackAdded = false;
            }
            this.syncP2PMedia();
        } catch (err) {
            logErr('setVideoInputDevice: failed to switch video input device', device.deviceId, err);
            throw err;
        }
    }

    public async setAudioOutputDevice(device: MediaDeviceInfo, store: boolean = true) {
        if (!this.peer) {
            return;
        }

        if (store) {
            window.localStorage.setItem(STORAGE_CALLS_DEFAULT_AUDIO_OUTPUT_KEY, JSON.stringify(device));
        }
        this.currentAudioOutputDevice = device;

        // We emit this event so it's easier to keep state in sync between widget and pop out.
        this.emit('devicechange', this.audioDevices, this.videoDevices);
    }

    public disconnect(err?: Error) {
        logDebug('disconnect');

        if (this.closed) {
            logErr('client already disconnected');
            return;
        }

        this.rtcMonitor?.stop();

        this.closed = true;
        this.p2p?.destroy();
        this.p2p = null;
        this.p2pActive = false;
        if (this.peer) {
            this.getStats().then((stats) => {
                // Flush logs with stats to accumulated buffer
                flushLogsToAccumulated(stats);

                // Also save to stats storage for backwards compatibility
                getPersistentStorage().setItem(STORAGE_CALLS_CLIENT_STATS_KEY, JSON.stringify(stats));
            }).catch((statsErr) => {
                logErr(statsErr);

                // Still flush logs even if stats failed
                flushLogsToAccumulated();
            });
            this.peer.destroy();
            this.peer = null;
        }

        this.cleanup();

        if (this.ws) {
            this.ws.sendLeaveAndClose();
            this.ws = null;
        }

        this.emit('close', err);
    }

    private cleanup() {
        this.streams.forEach((s) => {
            s.getTracks().forEach((track) => {
                track.stop();
                track.dispatchEvent(new Event('ended'));
            });
        });
    }

    public mute() {
        if (!this.peer || !this.audioTrack || !this.stream) {
            return;
        }

        if (!this.p2pActive) {
            logDebug('replacing track to peer', null);

            // @ts-ignore: we actually mean (and need) to pass null here
            this.peer.replaceTrack(this.audioTrack.id, null);
        }

        this.audioTrack.enabled = false;
        this.syncP2PMedia();

        this.emit('mute');

        if (this.ws) {
            this.ws.send('mute');
        }
    }

    public async unmute() {
        if (!this.peer) {
            return;
        }

        if (!this.audioTrack) {
            try {
                await this.initAudio();
            } catch (err) {
                this.emit('error', err);
                return;
            }
        }

        // NOTE: we purposely clear the monitor's stats cache upon unmuting
        // in order to skip some calculations since upon muting we actually
        // stop sending packets which would result in stats to be skewed as
        // soon as we resume sending.
        // This is not perfect but it avoids having to constantly send
        // silence frames when muted.
        this.rtcMonitor?.clearCache();

        if (this.audioTrack) {
            // When the media goes peer to peer the SFU peer is updated if we fall back.
            if (!this.p2pActive) {
                if (this.voiceTrackAdded) {
                    logDebug('replacing track to peer', this.audioTrack.id);
                    this.peer.replaceTrack(this.audioTrack.id, this.audioTrack);
                } else if (this.stream) {
                    logDebug('adding track to peer', this.audioTrack.id, this.stream.id);
                    await this.peer.addTrack(this.audioTrack, this.stream);
                    this.voiceTrackAdded = true;
                }
            }
            this.audioTrack.enabled = true;
            this.syncP2PMedia();
        }

        this.emit('unmute');

        if (this.ws) {
            this.ws.send('unmute');
        }
    }

    public getLocalScreenStream(): MediaStream|null {
        if (!this.localScreenTrack) {
            return null;
        }
        return new MediaStream([this.localScreenTrack]);
    }

    public getRemoteScreenStream(): MediaStream|null {
        if (!this.remoteScreenTrack || this.remoteScreenTrack.readyState !== 'live') {
            return null;
        }
        return new MediaStream([this.remoteScreenTrack]);
    }

    public getRemoteVideoStream(): MediaStream|null {
        if (this.remoteVideoTracks.length < 1 || this.remoteVideoTracks[this.remoteVideoTracks.length - 1].readyState !== 'live') {
            return null;
        }
        return new MediaStream([this.remoteVideoTracks[this.remoteVideoTracks.length - 1]]);
    }

    public getRemoteVoiceTracks(): MediaStreamTrack[] {
        const tracks = [];
        for (const track of this.remoteVoiceTracks) {
            if (track.readyState === 'live') {
                tracks.push(track);
            }
        }
        return tracks;
    }

    public async setScreenStream(screenStream: MediaStream) {
        if (!this.ws || !this.peer || this.localScreenTrack || !screenStream) {
            return;
        }

        const screenTrack = screenStream.getVideoTracks()[0];
        this.localScreenTrack = screenTrack;

        const screenAudioTrack = screenStream.getAudioTracks()[0];

        if (screenAudioTrack) {
            logDebug(`screen sharing with audio - track id: ${screenAudioTrack.id}, kind: ${screenAudioTrack.kind}, label: ${screenAudioTrack.label}`);
            screenStream = new MediaStream([screenTrack, screenAudioTrack]);
        } else {
            logDebug('screen sharing WITHOUT audio');
            screenStream = new MediaStream([screenTrack]);
        }

        this.localScreenAudioTrack = screenAudioTrack || null;
        this.localScreenStream = screenStream;
        this.streams.push(screenStream);

        screenTrack.onended = async () => {
            if (screenAudioTrack) {
                screenAudioTrack.stop();
            }

            this.localScreenTrack = null;
            this.localScreenAudioTrack = null;
            this.localScreenStream = null;
            this.syncP2PMedia();

            if (!this.ws || !this.peer) {
                return;
            }

            if (this.screenOnSFU) {
                this.screenOnSFU = false;
                try {
                    await this.peer.removeTrack(screenTrack.id);
                    if (screenAudioTrack) {
                        await this.peer.removeTrack(screenAudioTrack.id);
                    }
                } catch (err) {
                    logErr('screenTrack.onended: failed to remove track', err);
                }
            }

            this.ws?.send('screen_off');
        };

        logDebug(`adding screen stream to peer: ${screenStream.id}`);

        this.emit('localScreenStream', screenStream);

        this.ws.send('screen_on', {
            data: JSON.stringify({
                screenStreamID: screenStream.id,
            }),
        });

        // Smoothness over text sharpness: we mostly share game footage.
        screenTrack.contentHint = 'motion';

        // When the media goes peer to peer the screen is sent through the P2P
        // connection instead and only added to the SFU peer if we fall back.
        this.syncP2PMedia();
        if (!this.p2pActive) {
            await this.sendScreenOverSFU(screenStream, screenTrack);
        }
    }

    private async sendScreenOverSFU(screenStream: MediaStream, screenTrack: MediaStreamTrack) {
        if (!this.peer) {
            return;
        }

        this.screenOnSFU = true;

        // Always send a fallback track (VP8 encoded) for receivers that don't yet support AV1.
        // addStream maps opts by getTracks() index, and Chromium lists audio
        // tracks before video, so build opts per track instead of assuming index 0.
        // Without explicit encodings calls-common caps screen tracks at 1Mbps/10fps.
        await this.peer.addStream(screenStream, screenStream.getTracks().map((t) => (
            t.kind === 'video' ? {encodings: [{...screenEncodingsVP8}]} : undefined
        )) as Parameters<RTCPeer['addStream']>[1]);

        if (this.config.enableAV1 && this.av1Codec) {
            logDebug(`AV1 supported, sending track: ${this.av1Codec}`);

            await this.peer.addTrack(screenTrack, screenStream, {
                codec: this.av1Codec,
                encodings: [{...screenEncodingsAV1}],
            });
        }

        await this.applyScreenSenderParams(screenTrack.id);
    }

    // sendEncodings cannot carry degradationPreference, so it is set on the
    // senders after they are created. RTCPeer keeps its senders in a private
    // map keyed by track id, hence the cast.
    private async applyScreenSenderParams(trackID: string) {
        const senders = (this.peer as unknown as {senders?: Record<string, RTCRtpSender[]>} | null)?.senders?.[trackID] ?? [];
        for (const sender of senders) {
            try {
                const params = sender.getParameters();
                params.degradationPreference = 'maintain-framerate';
                // eslint-disable-next-line no-await-in-loop
                await sender.setParameters(params);
            } catch (err) {
                logWarn('failed to set screen sender parameters', err);
            }
        }
    }

    public async shareScreen(sourceID?: string, withAudio?: boolean) {
        if (!this.ws || !this.peer) {
            return null;
        }

        const screenStream = await getScreenStream(sourceID, withAudio);
        if (screenStream === null) {
            return null;
        }

        await this.setScreenStream(screenStream);

        return screenStream;
    }

    public unshareScreen() {
        if (!this.ws || !this.localScreenTrack) {
            return;
        }

        this.localScreenTrack.stop();
        this.localScreenTrack.dispatchEvent(new Event('ended'));
        this.localScreenTrack = null;
    }

    private async initBgBackgroundTrack(stream: MediaStream, bgBlurData: BgBlurData) {
        const localVideoTrack = stream.getVideoTracks()[0];

        if (this.segmenter) {
            return localVideoTrack;
        }

        const canvas = document.createElement('canvas');
        const video = document.createElement('video');
        canvas.width = localVideoTrack.getSettings().width!;
        canvas.height = localVideoTrack.getSettings().height!;
        video.autoplay = true;
        video.srcObject = new MediaStream([localVideoTrack]);

        const outStream = canvas.captureStream(30);
        this.streams.push(outStream);
        const outTrack = outStream.getVideoTracks()[0];

        stream.removeTrack(localVideoTrack);
        stream.addTrack(outTrack);

        outTrack.onended = () => {
            localVideoTrack.stop();
            localVideoTrack.dispatchEvent(new Event('ended'));
            canvas.remove();
            video.remove();
        };

        this.segmenter = new Segmenter({
            inputVideo: video,
            outputCanvas: canvas,
        });
        this.segmenter.setBlurIntensity(bgBlurData.blurIntensity);

        return outTrack;
    }

    public async startVideo() {
        if (!this.ws || !this.peer || !this.config.enableVideo) {
            return null;
        }

        if (!this.localVideoStream) {
            try {
                logDebug('no local video stream, initializing');
                await this.initVideo(true);
            } catch (err) {
                this.emit('error', err);
                return null;
            }
        }

        // NOTE: we purposely clear the monitor's stats cache upon starting video
        // in order to skip some calculations since upon starting video we actually
        // stop sending packets which would result in stats to be skewed as
        // soon as we resume sending.
        // This is not perfect but it avoids having to constantly send
        // empty frames when the video is off.
        this.rtcMonitor?.clearCache();

        if (!this.localVideoStream) {
            logWarn('no local video stream');
            return null;
        }

        let localVideoTrack = this.localVideoStream.getVideoTracks()[0];
        localVideoTrack.enabled = true;

        const bgBlurData = getBgBlurData();
        if (bgBlurData.blurBackground && bgBlurData.blurIntensity > 0) {
            logDebug('background blur enabled', bgBlurData);
            localVideoTrack = await this.initBgBackgroundTrack(this.localVideoStream, bgBlurData);
        }

        // When the media goes peer to peer the SFU peer is updated if we fall back.
        if (!this.p2pActive) {
            await this.sendVideoOverSFU(localVideoTrack);
        }
        this.syncP2PMedia();

        this.emit('localVideoStream', this.localVideoStream);

        this.ws.send('video_on', {
            data: JSON.stringify({
                videoStreamID: this.localVideoStream.id,
            }),
        });
        this.emit('video_on');

        return this.localVideoStream;
    }

    private async sendVideoOverSFU(localVideoTrack: MediaStreamTrack) {
        if (!this.peer || !this.localVideoStream) {
            return;
        }

        if (this.videoTrackAdded) {
            // The sender already exists from a previous startVideo. Its track may
            // currently be null (video was stopped) or a now-stopped track, so we
            // replace whatever it holds with the freshly initialized one.
            await this.peer.replaceTrack(this.videoSenderTrackID, localVideoTrack);
        } else {
            await this.peer.addTrack(localVideoTrack, this.localVideoStream, {encodings: this.defaultVideoTrackEncodings});
            if (this.config.enableAV1 && this.av1Codec) {
                logDebug('AV1 supported, sending track', this.av1Codec);
                await this.peer.addTrack(localVideoTrack, this.localVideoStream, {
                    codec: this.av1Codec,
                    encodings: this.defaultVideoTrackEncodings,
                });
            }
            this.videoTrackAdded = true;
        }
        this.videoSenderTrackID = localVideoTrack.id;
    }

    public stopVideo() {
        if (!this.ws || !this.peer || !this.localVideoStream) {
            return;
        }

        // Detach the track from the sender so we stop transmitting video. We keep
        // the sender itself around (videoTrackAdded stays true) to avoid a
        // renegotiation when video is started again.
        // There is no sender if the video was only ever sent peer to peer.
        if (this.videoSenderTrackID) {
            // @ts-ignore: we actually mean (and need) to pass null here
            this.peer.replaceTrack(this.videoSenderTrackID, null);
        }

        // Fully stop and release the camera device so its hardware indicator (LED)
        // turns off. Simply disabling the track (enabled = false) keeps the device
        // open and the LED lit (MM-68796). The stream (and its segmenter, if
        // background blur is enabled) is released here and re-initialized on the
        // next startVideo. When blur is active the stream holds the canvas track,
        // whose 'ended' event stops the underlying camera track.
        this.segmenter?.stop();
        this.segmenter = null;
        for (const track of this.localVideoStream.getVideoTracks()) {
            track.stop();
            track.dispatchEvent(new Event('ended'));
        }
        this.localVideoStream = null;
        this.syncP2PMedia();

        this.emit('video_off');
        this.ws.send('video_off');
    }

    public raiseHand() {
        this.emit('raise_hand');
        this.ws?.send('raise_hand');
    }

    public unraiseHand() {
        this.emit('lower_hand');
        this.ws?.send('unraise_hand');
    }

    public async setBlurSettings(blurEnabled: boolean, blurIntensity: number) {
        // If segmenter exists and blur is still enabled, just update intensity
        if (this.segmenter && blurEnabled) {
            this.segmenter.setBlurIntensity(blurIntensity);
            return;
        }

        // If blur state is changing and video is active, re-initialize the video track
        const blurStateChanging = (blurEnabled && !this.segmenter) || (!blurEnabled && this.segmenter);
        if (blurStateChanging && this.localVideoStream) {
            let device = this.currentVideoInputDevice;

            // Fallback: get device from current track settings if not stored
            if (!device) {
                const track = this.localVideoStream.getVideoTracks()[0];
                const settings = track?.getSettings();
                if (settings?.deviceId) {
                    device = {deviceId: settings.deviceId, label: ''} as MediaDeviceInfo;
                }
            }

            if (device) {
                await this.setVideoInputDevice(device);
            }
        }
    }

    public sendUserReaction(data: EmojiData) {
        this.ws?.send('react', {
            data: JSON.stringify(data),
        });
    }

    public async getStats(): Promise<CallsClientStats | null> {
        if (!this.peer) {
            throw new Error('not connected');
        }

        const tracksInfo : TrackMetadata[] = [];
        this.streams.forEach((stream) => {
            return stream.getTracks().forEach((track) => {
                tracksInfo.push({
                    streamID: stream.id,
                    id: track.id,
                    kind: track.kind,
                    label: track.label,
                    enabled: track.enabled,
                    readyState: track.readyState,
                });
            });
        });

        const stats = await this.peer.getStats();

        return {
            initTime: this.initTime,
            channelID: this.channelID,
            tracksInfo,
            rtcStats: stats ? parseRTCStats(stats) : null,
        };
    }

    public getAudioDevices() {
        return this.audioDevices;
    }

    public getVideoDevices() {
        return this.videoDevices;
    }

    public getSessionID() {
        return this.ws?.getOriginalConnID();
    }
}
