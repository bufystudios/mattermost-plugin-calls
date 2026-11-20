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
import {type AutoOutput, createAutoState} from 'src/auto_quality';
import {AutoQualityRunner, type AutoUpdateReason} from 'src/auto_quality_runner';
import {type BgBlurData, getBgBlurData} from 'src/local_storage';
import Segmenter from 'src/segmenter';
import {
    applyContentHint,
    applyQualityToSender,
    buildLiveConstraints,
    type CaptureSize,
    captureQuality,
    getShareQuality,
    normalizeShareQuality,
    type ScreenSenderExtra,
    type ScreenShareQuality,
    screenEncoding,
    screenSenderSettings,
    setShareQuality,
    type ShareCodec,
    type ShareFps,
    type ShareResolution,
} from 'src/screen_share_quality';
import {SpeakingMonitor} from 'src/speaking';
import {NoiseController} from 'src/noise/controller';
import {loadAudioHost, noiseProcessingSupported} from 'src/noise/host';
import {overloadedLevel} from 'src/noise/fallback';
import {browserNoiseSuppression, getNoiseLevel, isProcessedLevel, type NoiseLevel} from 'src/voice_input_prefs';

// How long the first unmute waits for a noise filter that is still loading.
const UnmuteNoiseWaitMs = 1500;

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

export type ScreenQualityInfo = {

    // What the user chose (may be Auto).
    quality: ScreenShareQuality;
    bitrateMbps: number;
    captured: CaptureSize | null;

    // Only in Auto mode: the level in use right now and why it is limited (if it is).
    auto: {resolution: ShareResolution; fps: ShareFps; limited: 'cpu' | 'bandwidth' | null} | null;
};

export default class CallsClient extends EventEmitter {
    public channelID: string;
    private readonly config: CallsClientConfig;
    private peer: RTCPeer | null;
    public ws: WebSocketClient | null;
    private localScreenTrack: MediaStreamTrack | null = null;

    // desktopCapturer id (`screen:…` / `window:…`) of the shared source in the desktop app, '' otherwise.
    private localScreenSourceID = '';

    // Quality of the current (or last requested) screen share, see screen_share_quality.ts.
    private screenQuality: ScreenShareQuality | null = null;

    // Auto quality: the poller that walks the level ladder (null when the share is manual or there is none)
    // and the native size of the shared source, which the ladder never exceeds.
    private autoRunner: AutoQualityRunner | null = null;
    private autoSource: CaptureSize | null = null;
    public localVideoStream: MediaStream | null = null;
    private remoteScreenTrack: MediaStreamTrack | null = null;
    private remoteVoiceTracks: MediaStreamTrack[];
    private remoteVideoTracks: MediaStreamTrack[];
    public currentAudioInputDevice: MediaDeviceInfo | null = null;
    public currentAudioOutputDevice: MediaDeviceInfo | null = null;
    public currentVideoInputDevice: MediaDeviceInfo | null = null;
    private voiceTrackAdded: boolean;
    private videoTrackAdded: boolean;

    // ID of the track the SFU voice sender was last given (RTCPeer keys its senders by it, also while the
    // sender holds null after a mute). It is the noise filter's output when one runs, the microphone otherwise.
    private voiceSenderTrackID = '';

    // Noise suppression levels (see noise/controller.ts): the filter's output track, which is sent instead of
    // the raw microphone track while Enhanced or Maximum run, on the SFU sender and on the P2P sender alike.
    private noise: NoiseController | null = null;
    private noiseOutput: MediaStreamTrack | null = null;

    // The browser noise suppression value the microphone was last reopened for (see setBrowserNoise), so a device
    // that ignores the constraint is reopened once, not in a loop. A device chosen by the user clears it.
    private noiseReopenedFor: boolean | null = null;

    // Bumped by every mute and unmute so an unmute that was waiting (for the noise filter) can tell it was overtaken
    // (a quick push-to-talk press and release) and leaves the mic closed.
    private micIntent = 0;

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

    // Which session sent a remote track (track id -> sender session id). Needed for per-user
    // volume. The SFU reports it in the media map (`sender_id`), a P2P track belongs to the peer.
    private remoteTrackSessions = new Map<string, string>();

    // Measures audio levels while the media goes peer to peer (the SFU, and so its voice
    // activity detection, gets no audio then). Emits 'speaking' {sessionID, speaking}.
    private speakingMonitor: SpeakingMonitor | null = null;
    private ownSessionID = '';
    private p2pRemoteVoiceTracks = new Map<string, MediaStreamTrack>();

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

    // The level the microphone is captured for. A processed level whose filter can't run here (no AudioWorklet or
    // WebAssembly, or it overloaded this machine before) starts as Standard, so the capture is not opened without
    // any filtering only to be switched back a moment later.
    private captureNoiseLevel(): NoiseLevel {
        const level = getNoiseLevel();
        if (isProcessedLevel(level) && (!noiseProcessingSupported() || overloadedLevel() === level)) {
            return 'standard';
        }
        return level;
    }

    // Read every time a track is requested so a change applies on the next unmute/device change at the latest.
    private get defaultAudioTrackOptions(): MediaTrackConstraints {
        return {
            autoGainControl: true,
            echoCancellation: true,
            noiseSuppression: browserNoiseSuppression(this.captureNoiseLevel()),
        };
    }

    // The track that goes out as our voice: the noise filter's output while Enhanced/Maximum run, the
    // microphone track otherwise. Muting still works on the microphone track (a disabled track feeds the filter
    // silence, and the senders are emptied while muted).
    private get voiceTrack(): MediaStreamTrack | null {
        return this.noiseOutput ?? this.audioTrack;
    }

    private voiceSenderID(): string {
        return this.voiceSenderTrackID || this.audioTrack?.id || '';
    }

    // Applies the noise level pref to the live microphone: starts, switches or stops the filter. Resolves when it
    // runs or has fallen back to Standard (with the reason in the noise status).
    public async applyNoiseSuppression() {
        const level = getNoiseLevel();
        if (!this.noise) {
            // No microphone yet: initAudio starts the controller with the current level.
            return;
        }
        await this.noise.setLevel(level);
    }

    private startNoise() {
        const level = getNoiseLevel();
        if (!this.noise) {
            this.noise = new NoiseController({
                getSource: () => (this.audioTrack && this.audioTrack.readyState === 'live' ? this.audioTrack : null),
                loadHost: () => (noiseProcessingSupported() ? loadAudioHost() : Promise.reject(new Error('audio processing not supported'))),
                setBrowserNoise: (enabled) => this.setBrowserNoise(enabled),
                onOutput: (track) => this.onNoiseOutput(track),
            }, level);
            this.noise.setMuted(!this.audioTrack?.enabled);
        }
        this.noise.setLevel(level).catch((err) => logWarn('failed to apply the noise level', err));
    }

    // Switches the browser's own noise suppression on the live microphone. Chromium/Electron accept it on the
    // fly. If the track still reports the old value (some capture devices ignore it) the microphone is opened again.
    private async setBrowserNoise(enabled: boolean) {
        const track = this.audioTrack;
        if (!track || track.readyState !== 'live') {
            return;
        }
        try {
            await track.applyConstraints({noiseSuppression: enabled});
        } catch (err) {
            logWarn('failed to apply noise suppression on the live track', err);
        }

        // One reopen per wanted value: a device that ignores the constraint (and keeps ignoring it after the reopen)
        // must not be reopened over and over, every new microphone track runs the controller again.
        const actual = track.getSettings?.().noiseSuppression;
        if (actual !== undefined && actual !== enabled && this.peer && this.noiseReopenedFor !== enabled) {
            logDebug('microphone ignored the noise suppression constraint, reopening it');
            this.noiseReopenedFor = enabled;
            try {
                await this.reopenAudioInput(enabled);
            } catch (err) {
                logWarn('failed to reopen the microphone for the noise level', err);
            }
        }
    }

    // The noise filter's output changed (a new graph, or null: back to the raw microphone track). Both media paths
    // carry the new track: the SFU voice sender and, through syncP2PMedia, the P2P voice sender.
    private onNoiseOutput(track: MediaStreamTrack | null) {
        const before = this.voiceTrack;
        this.noiseOutput = track;
        const after = this.voiceTrack;
        if (!after || after === before) {
            return;
        }

        if (this.peer && this.voiceTrackAdded && this.audioTrack?.enabled && !this.p2pActive) {
            try {
                this.peer.replaceTrack(this.voiceSenderID(), after);
                this.voiceSenderTrackID = after.id;
            } catch (err) {
                logWarn('failed to switch the voice sender to the new track', err);
            }
        }
        this.syncP2PMedia();
    }

    // Puts the voice track on the SFU peer: replaces the track of the voice sender, or adds the sender.
    private async attachVoiceToSFU() {
        const track = this.voiceTrack;
        if (!this.peer || !track) {
            return;
        }
        if (this.voiceTrackAdded) {
            logDebug('replacing track to peer', track.id);
            this.peer.replaceTrack(this.voiceSenderID(), track);
            this.voiceSenderTrackID = track.id;
        } else if (this.stream) {
            logDebug('adding track to peer', track.id, this.stream.id);
            await this.peer.addTrack(track, this.stream);
            this.voiceTrackAdded = true;
            this.voiceSenderTrackID = track.id;
        }
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
        const missingCurrentDevice = !devices.some((device) => currentDevice?.deviceId === device.deviceId);

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
            this.startNoise();

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

        this.ownSessionID = ws.getOriginalConnID();
        const p2p = new P2PController(this.ownSessionID, {
            iceServers: this.config.iceServers || [],
            enableAV1: this.config.enableAV1,
            encodings: {
                video: this.defaultVideoTrackEncodings[0],
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
        p2p.on('remotetrack', ({type, track, sessionID}: {type: P2PTrackType; track: MediaStreamTrack; sessionID?: string}) => {
            // Same shape as the SFU media map entry so both origins map the track to its sender.
            this.onRemoteStream(new MediaStream([track]), {type, sender_id: sessionID}, 'p2p');
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
            voice: this.audioTrack?.enabled ? this.voiceTrack : null,
            video: videoTrack && videoTrack.enabled && videoTrack.readyState === 'live' ? videoTrack : null,
            screen: this.localScreenTrack,
            screenAudio: this.localScreenAudioTrack,
        });
    }

    private onP2PStateChange(state: P2PState, prev: P2PState) {
        if (state === 'p2p' && prev !== 'p2p') {
            this.p2pActive = true;
            this.suspendSFUMedia();
            this.refreshSpeakingMonitor();
        } else if (state !== 'p2p' && prev === 'p2p') {
            this.p2pActive = false;
            this.stopSpeakingMonitor();
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
            replaceWithNull(this.voiceSenderID());
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
                await this.attachVoiceToSFU();
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

        this.p2pRemoteTracks.forEach((track) => this.remoteTrackSessions.delete(track.id));
        this.p2pRemoteTracks.clear();
    }

    // P2P only: starts/updates the local audio level monitoring of our mic and of the peer's voice.
    // In SFU mode the server's voice activity detection is used and this stays off.
    private refreshSpeakingMonitor() {
        if (!this.p2pActive) {
            return;
        }
        const selfSessionID = this.ownSessionID;
        const tracks: {[sessionID: string]: MediaStreamTrack | null} = {};
        if (selfSessionID) {
            tracks[selfSessionID] = this.audioTrack;
        }
        this.p2pRemoteVoiceTracks.forEach((track, sessionID) => {
            tracks[sessionID] = track;
        });

        if (!this.speakingMonitor) {
            this.speakingMonitor = new SpeakingMonitor((sessionID, speaking) => {
                this.emit('speaking', {sessionID, speaking});
            }, {attachSink: true});
        }
        this.speakingMonitor.setTracks(tracks);
    }

    private stopSpeakingMonitor() {
        // Stopping reports everyone as not speaking, so the UI falls back to the server's state.
        this.speakingMonitor?.stop();
        this.speakingMonitor = null;
        this.p2pRemoteVoiceTracks.clear();
    }

    // Sessions currently reported as speaking by the local monitor (P2P calls).
    public getSpeakingSessions(): string[] {
        return this.speakingMonitor?.getSpeakingSessions() ?? [];
    }

    // Handles a remote track coming from either the SFU or the P2P connection.
    private onRemoteStream(remoteStream: MediaStream, trackInfo: {type?: P2PTrackType | string; sender_id?: string} | undefined, origin: 'sfu' | 'p2p') {
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

        const senderSessionID = trackInfo?.sender_id;
        if (senderSessionID) {
            remoteStream.getTracks().forEach((track) => this.remoteTrackSessions.set(track.id, senderSessionID));
        }

        logDebug('stream has', audioTracks.length, 'audio tracks and', videoTracks.length, 'video tracks');

        // Handle audio tracks based on type
        if (audioTracks.length > 0) {
            if (trackInfo?.type === 'screen-audio') {
                // Screen share audio - emit as voice stream so it gets played
                logDebug('received screen-audio track, emitting as remoteVoiceStream');
                this.emit('remoteVoiceStream', new MediaStream(audioTracks), senderSessionID);
                this.remoteVoiceTracks.push(...audioTracks);
            } else if (trackInfo?.type === 'voice' || !trackInfo?.type) {
                // Regular voice audio
                logDebug('received voice track, emitting as remoteVoiceStream');
                this.emit('remoteVoiceStream', remoteStream, senderSessionID);
                this.remoteVoiceTracks.push(...audioTracks);
                if (origin === 'p2p' && senderSessionID) {
                    this.p2pRemoteVoiceTracks.set(senderSessionID, audioTracks[0]);
                    this.refreshSpeakingMonitor();
                }
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
        this.stopAuto();
        this.removeAllListeners('close');
        this.removeAllListeners('connect');
        this.removeAllListeners('remoteVoiceStream');
        this.removeAllListeners('remoteScreenStream');
        this.removeAllListeners('speaking');
        this.removeAllListeners('localScreenStream');
        this.removeAllListeners('screenQuality');
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

        this.noiseReopenedFor = null;
        try {
            await this.swapMicrophone(device.deviceId, this.defaultAudioTrackOptions);
        } catch (err) {
            logErr('setAudioInputDevice: failed to switch audio input device', device.deviceId, err);
            throw err;
        }
    }

    // Opens the current microphone again with the browser's noise suppression set to `enabled` (the fallback of
    // setBrowserNoise for capture devices that ignore applyConstraints).
    private async reopenAudioInput(enabled: boolean) {
        // No device was ever chosen (the system default is in use): reopen the one the track came from.
        const deviceId = this.currentAudioInputDevice?.deviceId ?? this.audioTrack?.getSettings?.().deviceId;
        if (!deviceId) {
            return;
        }
        await this.swapMicrophone(deviceId, {...this.defaultAudioTrackOptions, noiseSuppression: enabled});
    }

    // Replaces the microphone track by a new one from `deviceId`. The old one is stopped only once the new one
    // exists. Whatever is being sent keeps going: the senders get the new raw track, or, while a noise filter runs,
    // keep the filter's output until the filter has been restarted on the new microphone (`sourceChanged`).
    private async swapMicrophone(deviceId: string, constraints: MediaTrackConstraints) {
        const oldTrack = this.audioTrack;
        if (!oldTrack || !this.stream || !this.peer) {
            return;
        }
        const isEnabled = oldTrack.enabled;

        const newStream = await navigator.mediaDevices.getUserMedia({
            video: false,
            audio: {
                ...constraints,
                deviceId: {
                    exact: deviceId,
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
            if (!this.noiseOutput) {
                logDebug('replacing track to peer', newTrack.id);
                this.peer.replaceTrack(this.voiceSenderID(), newTrack);
                this.voiceSenderTrackID = newTrack.id;
            }
        } else {
            // Not sending over the SFU (muted, or media goes peer to peer): the new
            // track is added to the SFU peer when needed.
            this.voiceTrackAdded = false;
        }
        this.audioTrack = newTrack;
        this.syncP2PMedia();
        this.refreshSpeakingMonitor();

        // A running filter moves to the new microphone.
        this.noise?.sourceChanged().catch((err) => logWarn('failed to move the noise filter to the new microphone', err));
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
        this.stopAuto();
        this.p2p?.destroy();
        this.p2p = null;
        this.p2pActive = false;
        this.stopSpeakingMonitor();
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
        this.noise?.dispose(getNoiseLevel());
        this.noise = null;
        this.noiseOutput = null;
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
            this.peer.replaceTrack(this.voiceSenderID(), null);
        }

        this.micIntent++;
        this.audioTrack.enabled = false;
        this.noise?.setMuted(true);
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
            const intent = ++this.micIntent;

            // A filter that is still starting (the first unmute right after joining) gets a moment, so the
            // first words do not go out unfiltered.
            if (this.noise) {
                await this.noise.settled(UnmuteNoiseWaitMs);
                if (intent !== this.micIntent || !this.audioTrack) {
                    return;
                }
                this.noise.setMuted(false);
            }

            // When the media goes peer to peer the SFU peer is updated if we fall back.
            if (!this.p2pActive) {
                await this.attachVoiceToSFU();
            }
            this.audioTrack.enabled = true;
            this.syncP2PMedia();
            this.refreshSpeakingMonitor();
        }

        this.emit('unmute');

        if (this.ws) {
            this.ws.send('unmute');
        }
    }

    // The desktopCapturer id of what we are sharing (desktop app), '' when unknown (browser picker) or not sharing.
    public getLocalScreenSourceID(): string {
        return this.localScreenTrack ? this.localScreenSourceID : '';
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

    // Session that sent a remote track (voice, screen audio, ...), if known.
    public getRemoteTrackSessionID(trackID: string): string | undefined {
        return this.remoteTrackSessions.get(trackID);
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

    public async setScreenStream(screenStream: MediaStream, quality?: ScreenShareQuality) {
        if (!this.ws || !this.peer || this.localScreenTrack || !screenStream) {
            return;
        }

        const screenTrack = screenStream.getVideoTracks()[0];
        this.localScreenTrack = screenTrack;

        // The picker's choice (or the last stored one) decides content hint, bitrate and codec.
        const shareQuality = quality ? normalizeShareQuality(quality) : getShareQuality();
        this.screenQuality = shareQuality;
        this.autoSource = null;
        if (!shareQuality.auto) {
            this.pushQualityToP2P();
        }

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
            this.screenQuality = null;
            this.stopAuto();
            this.autoSource = null;
            this.p2p?.setScreenQuality(null);
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
        this.emitScreenQuality();

        this.ws.send('screen_on', {
            data: JSON.stringify({
                screenStreamID: screenStream.id,
            }),
        });

        // Game: smoothness over sharpness. Text: sharpness over smoothness.
        applyContentHint(screenTrack, shareQuality.content);

        // Auto: the capture is at the source size now, pick the first level (and lower the capture to it)
        // before anything is sent.
        if (shareQuality.auto) {
            await this.startAuto(shareQuality, false);
        }

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

        const {quality, extra} = this.screenQualityForSend();
        const captured = this.getScreenCaptureSize();

        // Always send a fallback track (VP8 encoded) for receivers that don't yet support AV1.
        // addStream maps opts by getTracks() index, and Chromium lists audio
        // tracks before video, so build opts per track instead of assuming index 0.
        // Without explicit encodings calls-common caps screen tracks at 1Mbps/10fps.
        await this.peer.addStream(screenStream, screenStream.getTracks().map((t) => (
            t.kind === 'video' ? {encodings: [screenEncoding(screenSenderSettings(quality, 'vp8', captured, extra))]} : undefined
        )) as Parameters<RTCPeer['addStream']>[1]);

        if (this.config.enableAV1 && this.av1Codec) {
            logDebug(`AV1 supported, sending track: ${this.av1Codec}`);

            await this.peer.addTrack(screenTrack, screenStream, {
                codec: this.av1Codec,
                encodings: [screenEncoding(screenSenderSettings(quality, 'av1', captured, extra))],
            });
        }

        await this.applyScreenSenderParams(screenTrack.id);
    }

    // sendEncodings cannot carry degradationPreference, so the whole quality is applied
    // to the senders after they are created (and again on every live change). RTCPeer
    // keeps its senders in a private map keyed by track id, hence the cast. The
    // first sender carries the VP8 fallback, the second one (if any) AV1 (see sendScreenOverSFU).
    private async applyScreenSenderParams(trackID: string) {
        const senders = this.sfuScreenSenders(trackID);
        const {quality, extra} = this.screenQualityForSend();
        const captured = this.getScreenCaptureSize();
        const codecs: ShareCodec[] = ['vp8', 'av1'];
        for (let i = 0; i < senders.length; i++) {
            // eslint-disable-next-line no-await-in-loop
            await applyQualityToSender(senders[i], quality, {codec: codecs[i] ?? 'vp8', captured, extra});
        }
    }

    private sfuScreenSenders(trackID: string): RTCRtpSender[] {
        return (this.peer as unknown as {senders?: Record<string, RTCRtpSender[]>} | null)?.senders?.[trackID] ?? [];
    }

    // The sender(s) that carry the screen right now (P2P: one, SFU: VP8 and maybe AV1).
    private getScreenSenders(): RTCRtpSender[] {
        const track = this.localScreenTrack;
        if (!track) {
            return [];
        }
        if (this.p2pActive) {
            return this.p2p?.getScreenSenders() ?? [];
        }
        return this.sfuScreenSenders(track.id).filter((s) => s.track);
    }

    // The quality that is sent right now. Manual: what was chosen. Auto: the level the ladder is at
    // (as a manual quality, so the rest of the code needs no special case) plus its runtime extras.
    private screenQualityForSend(): {quality: ScreenShareQuality; extra: ScreenSenderExtra | null} {
        const chosen = this.screenQuality ?? getShareQuality();
        if (!chosen.auto) {
            return {quality: chosen, extra: null};
        }
        const output = this.autoRunner?.getOutput();
        if (!output) {
            return {quality: captureQuality(chosen), extra: null};
        }
        const captured = this.getScreenCaptureSize();
        const target = output.rung.size;

        // A capture that did not shrink to the level (refused constraints) is scaled down by the encoder.
        const scaleDown = captured && captured.height > target.height * 1.05 ? captured.height / target.height : 1;
        return {
            quality: {...chosen, auto: false, resolution: output.rung.resolution, fps: output.rung.fps, manualBitrateMbps: null},
            extra: {bitrateCapMbps: output.capMbps, scaleDown},
        };
    }

    private pushQualityToP2P() {
        const {quality, extra} = this.screenQualityForSend();
        this.p2p?.setScreenQuality(quality, this.getScreenCaptureSize(), extra);
    }

    private stopAuto() {
        this.autoRunner?.stop();
        this.autoRunner = null;
    }

    // Starts Auto for the share that is going on. `measureSource`: the capture may be at a smaller
    // size than the source (a manual choice was active), so it is opened up to the source size first.
    private async startAuto(chosen: ScreenShareQuality, measureSource: boolean) {
        const track = this.localScreenTrack;
        if (!track) {
            return;
        }
        this.stopAuto();

        if (measureSource || !this.autoSource) {
            if (measureSource) {
                const before = this.getScreenCaptureSize();
                try {
                    await track.applyConstraints(buildLiveConstraints(chosen));
                } catch (err) {
                    logWarn('failed to open the capture to the source size', err);
                }
                await this.waitForCaptureSizeChange(track, before, 1500);
                if (this.localScreenTrack !== track) {
                    return;
                }
            }
            this.autoSource = this.getScreenCaptureSize() ?? {width: 1920, height: 1080};
        }

        const runner: AutoQualityRunner = new AutoQualityRunner({
            state: createAutoState(chosen.content, this.autoSource!),
            getSenders: () => this.getScreenSenders(),
            getCaptured: () => this.getScreenCaptureSize(),
            onUpdate: (output, reason) => this.applyAutoOutput(runner, output, reason),
            onInfo: () => this.emitScreenQuality(),
        });
        this.autoRunner = runner;
        await this.applyAutoOutput(runner, runner.getOutput(), 'level');
        if (this.autoRunner === runner) {
            runner.start();
        }
    }

    // Applies an Auto level (or only a new bitrate cap) to the capture and the senders, live.
    private async applyAutoOutput(runner: AutoQualityRunner, output: AutoOutput, reason: AutoUpdateReason) {
        const track = this.localScreenTrack;
        if (!track || track.readyState !== 'live' || this.autoRunner !== runner) {
            return;
        }

        if (reason === 'level') {
            const {quality} = this.screenQualityForSend();
            try {
                await track.applyConstraints(buildLiveConstraints(quality));
            } catch (err) {
                // Electron's legacy capture may refuse: the senders below then scale / cap instead.
                logWarn('failed to apply auto quality constraints', err);
            }
            await this.waitForCaptureHeight(track, output.rung.size.height, 1500);
            if (this.localScreenTrack !== track || this.autoRunner !== runner) {
                return;
            }
        }

        if (this.screenOnSFU) {
            await this.applyScreenSenderParams(track.id);
        }
        this.pushQualityToP2P();
        runner.setApplied(output, this.getScreenCaptureSize());
        this.emitScreenQuality();
    }

    // Waits (bounded) until the capture is about `height` tall.
    private async waitForCaptureHeight(track: MediaStreamTrack, height: number, timeoutMs: number) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const s = track.getSettings?.();
            if (!s?.height || Math.abs(s.height - height) <= Math.max(2, height * 0.02)) {
                return;
            }
            // eslint-disable-next-line no-await-in-loop
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
    }

    // Size of the screen capture as reported by the track, null when unknown.
    private getScreenCaptureSize(): CaptureSize | null {
        const settings = this.localScreenTrack?.getSettings?.();
        if (settings?.width && settings?.height) {
            return {width: settings.width, height: settings.height};
        }
        return null;
    }

    // The quality of the share that is going on, as shown on the sharer's preview:
    // the chosen settings, the bitrate in use and the real capture size.
    public getScreenQualityInfo(): ScreenQualityInfo | null {
        if (!this.localScreenTrack || !this.screenQuality) {
            return null;
        }
        const captured = this.getScreenCaptureSize();
        const p2pSettings = this.p2pActive ? this.p2p?.getScreenSendSettings() : null;
        const {quality, extra} = this.screenQualityForSend();
        const output = this.screenQuality.auto ? this.autoRunner?.getOutput() : null;
        return {
            quality: this.screenQuality,
            bitrateMbps: p2pSettings?.bitrateMbps ?? screenSenderSettings(quality, 'vp8', captured, extra).bitrateMbps,
            captured,
            auto: output ? {resolution: output.rung.resolution, fps: output.rung.fps, limited: output.limited} : null,
        };
    }

    private emitScreenQuality() {
        const info = this.getScreenQualityInfo();
        if (info) {
            this.emit('screenQuality', info);
        }
    }

    // Changes the quality of a share that is going on, without sharing again: the
    // capture is re-constrained and the SFU and P2P senders get the new limits.
    public async setScreenQuality(quality: ScreenShareQuality) {
        const next = normalizeShareQuality(quality);
        setShareQuality(next);

        const track = this.localScreenTrack;
        if (!track || track.readyState !== 'live') {
            return;
        }

        const prev = this.screenQuality;
        this.screenQuality = next;
        applyContentHint(track, next.content);

        if (next.auto) {
            // (Re)start the ladder. Coming from a manual choice the capture is first opened up to the source size.
            await this.startAuto(next, !prev?.auto);
            return;
        }
        this.stopAuto();

        const before = this.getScreenCaptureSize();
        try {
            await track.applyConstraints(buildLiveConstraints(next));
        } catch (err) {
            // Electron's legacy desktop capture tracks may refuse new constraints. The senders
            // below still get the bitrate, frame rate and degradation preference.
            logWarn('failed to apply screen constraints', err);
        }
        if (this.localScreenTrack !== track) {
            return;
        }

        // The capture size follows the constraints a moment later: wait for it (bounded)
        // so the bitrate matches the real size.
        if (!prev || prev.auto || prev.resolution !== next.resolution) {
            await this.waitForCaptureSizeChange(track, before, 1500);
            if (this.localScreenTrack !== track) {
                return;
            }
        }

        const captured = this.getScreenCaptureSize();
        if (this.screenOnSFU) {
            await this.applyScreenSenderParams(track.id);
        }
        this.p2p?.setScreenQuality(next, captured);
        this.emitScreenQuality();
    }

    private async waitForCaptureSizeChange(track: MediaStreamTrack, before: CaptureSize | null, timeoutMs: number) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const s = track.getSettings?.();
            if (!before || (s?.width && s?.height && (s.width !== before.width || s.height !== before.height))) {
                return;
            }
            // eslint-disable-next-line no-await-in-loop
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
    }

    public async shareScreen(sourceID?: string, withAudio?: boolean, quality?: ScreenShareQuality) {
        if (!this.ws || !this.peer) {
            return null;
        }

        const shareQuality = quality ? normalizeShareQuality(quality) : getShareQuality();
        const screenStream = await getScreenStream(sourceID, withAudio, shareQuality);
        if (screenStream === null) {
            return null;
        }

        this.localScreenSourceID = sourceID || '';
        await this.setScreenStream(screenStream, shareQuality);

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
