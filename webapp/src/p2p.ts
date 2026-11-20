// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// Peer-to-peer (P2P) media path for 1:1 calls in DMs. See docs/bufy-p2p.md.
//
// P2PController owns a second RTCPeerConnection, signaled through the plugin
// websocket, that carries audio/video/screen directly between the two
// participants. The SFU connection managed by CallsClient is left untouched;
// CallsClient only reacts to the controller's `statechange` and `remotetrack`
// events. All the "which path carries the media" decisions live here.

import {EventEmitter} from 'events';

import {logDebug, logErr, logInfo, logWarn} from './log';
import {
    applyQualityToSender,
    type CaptureSize,
    getShareQuality,
    pickP2PScreenCodec,
    type ScreenSenderExtra,
    type ScreenSenderSettings,
    type ScreenShareQuality,
} from './screen_share_quality';

// sfu:            media goes through the SFU (default, and whenever P2P is not eligible).
// p2p-connecting: a P2P connection is being negotiated, media still goes through the SFU.
// p2p:            P2P is connected, media goes peer to peer (the SFU peer sends nothing).
// fallback-sfu:   P2P was abandoned for the current peer (failure/timeout/peer gave up),
//                 media goes through the SFU and P2P is not attempted again with this peer.
export type P2PState = 'sfu' | 'p2p-connecting' | 'p2p' | 'fallback-sfu';

export type P2PTrackType = 'voice' | 'video' | 'screen' | 'screen-audio';

export type P2PSignalKind = 'offer' | 'answer' | 'candidate' | 'bye';

// Why a peer sent a "bye":
// ineligible: the call stopped being eligible for P2P (e.g. a recording started or a
//             third participant joined). P2P can be tried again when it becomes eligible.
// failed:     the connection could not be established or was lost. P2P is not
//             attempted again with this peer.
export type P2PByeReason = 'ineligible' | 'failed';

// A signaling message received from the other peer (relayed by the server).
export type P2PSignal = {
    from: string;
    kind: P2PSignalKind;
    data?: any;
};

// The inputs that decide whether P2P can be used. They come from the call state.
export type P2PContext = {

    // Session ID of the other participant when the call has exactly two
    // sessions (and is a DM), null otherwise.
    peerSessionID: string | null;

    // True while a recording, transcription or live captions job needs the
    // media on the server.
    serverMediaNeeded: boolean;
};

export type P2PLocalMedia = {
    voice: MediaStreamTrack | null;
    video: MediaStreamTrack | null;
    screen: MediaStreamTrack | null;
    screenAudio: MediaStreamTrack | null;
};

// Camera video encodings. Screen sharing encodings come from the quality picker
// (see screen_share_quality.ts and P2PController.setScreenQuality).
export type P2PEncodings = {
    video: RTCRtpEncodingParameters;
};

export type P2PConfig = {
    iceServers: RTCIceServer[];
    sendSignal: (to: string, kind: P2PSignalKind, data?: unknown) => void;

    // Whether to prefer AV1 for screen sharing (it is used only if both sides support it).
    enableAV1: boolean;
    encodings: P2PEncodings;
    connectTimeoutMs?: number;
    disconnectGraceMs?: number;
};

export const P2P_CONNECT_TIMEOUT_MS = 5000;
export const P2P_DISCONNECT_GRACE_MS = 3000;

// Signals received before we became eligible (the peer's call state can be a
// little ahead of ours) are kept for a short while.
const pendingSignalsMaxAgeMs = 10000;
const pendingSignalsMaxCount = 100;

// The P2P connection always has the same four transceivers, in this order.
// Media is attached/detached with replaceTrack so there is never a
// renegotiation after the initial offer/answer.
const transceiverLayout: Array<{type: P2PTrackType; kind: 'audio' | 'video'}> = [
    {type: 'voice', kind: 'audio'},
    {type: 'video', kind: 'video'},
    {type: 'screen', kind: 'video'},
    {type: 'screen-audio', kind: 'audio'},
];

export const emptyP2PLocalMedia: P2PLocalMedia = {voice: null, video: null, screen: null, screenAudio: null};

// The session with the lexicographically smaller ID makes the offer. This avoids glare
// without any extra signaling.
export function p2pRole(mySessionID: string, peerSessionID: string): 'offerer' | 'answerer' {
    return mySessionID < peerSessionID ? 'offerer' : 'answerer';
}

type MediaMap = {[mid: string]: P2PTrackType};

export class P2PController extends EventEmitter {
    private readonly mySessionID: string;
    private readonly cfg: P2PConfig;

    private state: P2PState = 'sfu';
    private ctx: P2PContext = {peerSessionID: null, serverMediaNeeded: false};

    // Peer of the current attempt (or of the last fallback).
    private peerSessionID: string | null = null;
    private failedPeers = new Set<string>();

    private pc: RTCPeerConnection | null = null;
    private mediaMap: MediaMap = {};
    private transceivers: Partial<Record<P2PTrackType, RTCRtpTransceiver>> = {};
    private remoteTracks: Array<{type: P2PTrackType; track: MediaStreamTrack; sessionID?: string}> = [];
    private pendingCandidates: RTCIceCandidateInit[] = [];
    private pendingSignals: Array<{signal: P2PSignal; at: number}> = [];
    private signalQueue: Promise<void> = Promise.resolve();
    private localMedia: P2PLocalMedia = emptyP2PLocalMedia;
    private connectTimer: ReturnType<typeof setTimeout> | null = null;
    private disconnectTimer: ReturnType<typeof setTimeout> | null = null;

    // Quality of the local screen share (null = not chosen yet, the stored one is used) and what
    // was last applied to the screen sender.
    private screenQuality: ScreenShareQuality | null = null;
    private screenCapture: Partial<CaptureSize> | null = null;
    private screenSettings: ScreenSenderSettings | null = null;
    private screenExtra: ScreenSenderExtra | null = null;

    constructor(mySessionID: string, cfg: P2PConfig) {
        super();
        this.mySessionID = mySessionID;
        this.cfg = cfg;
    }

    public getState(): P2PState {
        return this.state;
    }

    public isActive(): boolean {
        return this.state === 'p2p';
    }

    // Update the inputs that decide whether P2P can be used.
    public setContext(ctx: P2PContext) {
        this.ctx = ctx;
        this.evaluate();
    }

    // Set the local tracks that should be sent. null means "not sending".
    // It is safe to call this at any time (also when no P2P connection exists),
    // the current values are applied as soon as there is a connection.
    public setLocalMedia(media: P2PLocalMedia) {
        this.localMedia = media;
        this.applyLocalMedia();
    }

    // Sets the quality (and the real capture size) of the local screen share and
    // applies it right away when connected. Safe to call at any time.
    // `extra` carries what Auto adds at runtime (bitrate cap, encoder downscale).
    public setScreenQuality(quality: ScreenShareQuality | null, captured?: Partial<CaptureSize> | null, extra?: ScreenSenderExtra | null) {
        this.screenQuality = quality;
        this.screenCapture = captured ?? null;
        this.screenExtra = extra ?? null;
        if (!quality) {
            this.screenSettings = null;
            return;
        }
        if (this.state === 'p2p') {
            this.applySenderParams();
        }
    }

    // The sender that carries the local screen (empty when nothing is being sent), for stats polling.
    public getScreenSenders(): RTCRtpSender[] {
        const sender = this.transceivers.screen?.sender;
        return sender && sender.track ? [sender] : [];
    }

    // Settings last applied to the screen sender (bitrate, ...), null when nothing is being sent.
    public getScreenSendSettings(): ScreenSenderSettings | null {
        return this.screenSettings;
    }

    public handleSignal(signal: P2PSignal) {
        this.signalQueue = this.signalQueue.then(() => this.processSignal(signal)).catch((err) => {
            logErr('p2p: failed to handle signal', signal.kind, err);
            this.fallback('signal error');
        });
        return this.signalQueue;
    }

    // Closes everything without telling the peer (we are leaving the call).
    public destroy() {
        this.closeConnection();
        this.pendingSignals = [];
        this.removeAllListeners();
        this.state = 'sfu';
    }

    private evaluate() {
        const peer = this.ctx.peerSessionID;
        const eligible = Boolean(peer) && peer !== this.mySessionID && !this.ctx.serverMediaNeeded;

        if (!eligible) {
            if (this.state === 'p2p-connecting' || this.state === 'p2p') {
                logInfo('p2p: no longer eligible, going back to sfu', this.ctx);
                this.notifyBye('ineligible');
            }
            if (this.state !== 'sfu') {
                this.closeConnection();
                this.peerSessionID = null;
                this.setState('sfu');
            }
            return;
        }

        if (this.peerSessionID && this.peerSessionID !== peer) {
            logInfo('p2p: peer changed');
            if (this.state === 'p2p-connecting' || this.state === 'p2p') {
                this.notifyBye('ineligible');
            }
            this.closeConnection();
            this.peerSessionID = null;
            this.setState('sfu');
        }

        if (this.state === 'sfu' && peer && !this.failedPeers.has(peer)) {
            this.start(peer);
        }
    }

    private start(peer: string) {
        const role = p2pRole(this.mySessionID, peer);
        logInfo('p2p: starting', role, 'peer:', peer);

        this.peerSessionID = peer;
        this.setState('p2p-connecting');

        try {
            this.createConnection(peer);
        } catch (err) {
            logErr('p2p: failed to create peer connection', err);
            this.fallback('create error');
            return;
        }

        this.connectTimer = setTimeout(() => {
            if (this.state === 'p2p-connecting') {
                this.fallback('timed out waiting for connection');
            }
        }, this.cfg.connectTimeoutMs ?? P2P_CONNECT_TIMEOUT_MS);

        if (role === 'offerer') {
            this.signalQueue = this.signalQueue.then(() => this.makeOffer(peer)).catch((err) => {
                logErr('p2p: failed to make offer', err);
                this.fallback('offer error');
            });
        }

        // Signals that arrived before we were ready.
        const now = Date.now();
        const pending = this.pendingSignals;
        this.pendingSignals = [];
        for (const {signal, at} of pending) {
            if (signal.from === peer && now - at <= pendingSignalsMaxAgeMs) {
                this.handleSignal(signal);
            }
        }
    }

    private createConnection(peer: string) {
        const pc = new RTCPeerConnection({iceServers: this.cfg.iceServers});
        this.pc = pc;

        pc.onicecandidate = (ev) => {
            if (!ev.candidate || this.pc !== pc) {
                return;
            }
            const candidate = typeof ev.candidate.toJSON === 'function' ? ev.candidate.toJSON() : ev.candidate;
            logDebug('p2p: local candidate', JSON.stringify(candidate));
            this.cfg.sendSignal(peer, 'candidate', candidate);
        };
        pc.onconnectionstatechange = () => this.onConnectionStateChange(pc);
        pc.oniceconnectionstatechange = () => {
            logDebug('p2p: ice connection state ->', pc.iceConnectionState);
            if (this.pc === pc && typeof pc.connectionState === 'undefined') {
                this.onConnectionStateChange(pc);
            }
        };
        pc.ontrack = (ev) => {
            const type = this.mediaMap[ev.transceiver?.mid ?? ''];
            if (!type) {
                logWarn('p2p: track for unknown mid', ev.transceiver?.mid);
                return;
            }
            logDebug('p2p: remote track', type, ev.track.id);
            this.remoteTracks.push({type, track: ev.track, sessionID: this.peerSessionID ?? undefined});
            if (this.state === 'p2p') {
                this.emit('remotetrack', {type, track: ev.track, sessionID: this.peerSessionID ?? undefined});
            }
        };
    }

    private async makeOffer(peer: string) {
        const pc = this.pc;
        if (!pc || this.peerSessionID !== peer || pc.signalingState !== 'stable') {
            return;
        }

        for (const {type, kind} of transceiverLayout) {
            this.transceivers[type] = pc.addTransceiver(kind, {direction: 'sendrecv'});
        }
        this.setScreenCodecPreferences();
        this.applyLocalMedia();

        await pc.setLocalDescription();
        if (this.pc !== pc) {
            return;
        }

        const mediaMap: MediaMap = {};
        for (const {type} of transceiverLayout) {
            const mid = this.transceivers[type]?.mid;
            if (mid) {
                mediaMap[mid] = type;
            }
        }
        this.mediaMap = mediaMap;

        logDebug('p2p: sending offer');
        this.cfg.sendSignal(peer, 'offer', {sdp: pc.localDescription, tracks: mediaMap});
    }

    private async processSignal(signal: P2PSignal) {
        const {from, kind} = signal;

        if (kind === 'bye') {
            const retryable = (signal.data as {reason?: P2PByeReason} | undefined)?.reason === 'ineligible';
            if (from === this.peerSessionID && (this.state === 'p2p-connecting' || this.state === 'p2p')) {
                logInfo('p2p: peer asked to go back to sfu', retryable ? '(ineligible)' : '(failed)');
                if (retryable) {
                    this.closeConnection();
                    this.peerSessionID = null;
                    this.setState('sfu');
                } else {
                    this.fallback('peer left p2p', false);
                }
            } else if (this.state === 'sfu' && !retryable) {
                // The peer already gave up, there is no point in trying.
                this.failedPeers.add(from);
            }
            this.pendingSignals = this.pendingSignals.filter((p) => p.signal.from !== from);
            return;
        }

        if (this.state === 'sfu') {
            // We may just not be eligible yet, keep it around for a bit.
            if (!this.failedPeers.has(from)) {
                const now = Date.now();
                this.pendingSignals = this.pendingSignals.filter((p) => now - p.at <= pendingSignalsMaxAgeMs);
                if (this.pendingSignals.length < pendingSignalsMaxCount) {
                    this.pendingSignals.push({signal, at: now});
                }
            }
            return;
        }

        const pc = this.pc;
        if (!pc || from !== this.peerSessionID || (this.state !== 'p2p-connecting' && this.state !== 'p2p')) {
            logDebug('p2p: ignoring signal', kind, 'from', from, 'in state', this.state);
            return;
        }

        switch (kind) {
        case 'offer':
            await this.handleOffer(pc, signal.data);
            break;
        case 'answer':
            if (p2pRole(this.mySessionID, from) !== 'offerer' || pc.signalingState !== 'have-local-offer') {
                logWarn('p2p: unexpected answer');
                return;
            }
            await pc.setRemoteDescription(signal.data.sdp);
            await this.flushCandidates(pc);
            break;
        case 'candidate':
            if (pc.remoteDescription) {
                await this.addCandidate(pc, signal.data);
            } else {
                this.pendingCandidates.push(signal.data);
            }
            break;
        default:
            logWarn('p2p: invalid signal kind', kind);
        }
    }

    private async handleOffer(pc: RTCPeerConnection, data: {sdp: RTCSessionDescriptionInit; tracks: MediaMap}) {
        const peer = this.peerSessionID;
        if (!peer || p2pRole(this.mySessionID, peer) !== 'answerer' || pc.signalingState !== 'stable') {
            logWarn('p2p: unexpected offer');
            return;
        }

        // Needed before setRemoteDescription since that is when tracks show up.
        this.mediaMap = data.tracks || {};

        await pc.setRemoteDescription(data.sdp);
        if (this.pc !== pc) {
            return;
        }

        for (const trx of pc.getTransceivers()) {
            const type = this.mediaMap[trx.mid ?? ''];
            if (!type) {
                continue;
            }
            this.transceivers[type] = trx;
            trx.direction = 'sendrecv';
        }
        this.setScreenCodecPreferences();
        this.applyLocalMedia();
        await this.flushCandidates(pc);

        await pc.setLocalDescription();
        if (this.pc !== pc) {
            return;
        }

        logDebug('p2p: sending answer');
        this.cfg.sendSignal(peer, 'answer', {sdp: pc.localDescription});
    }

    private async flushCandidates(pc: RTCPeerConnection) {
        const candidates = this.pendingCandidates;
        this.pendingCandidates = [];
        for (const candidate of candidates) {
            // eslint-disable-next-line no-await-in-loop
            await this.addCandidate(pc, candidate);
        }
    }

    private async addCandidate(pc: RTCPeerConnection, candidate: RTCIceCandidateInit) {
        try {
            await pc.addIceCandidate(candidate);
        } catch (err) {
            logWarn('p2p: failed to add ice candidate', err);
        }
    }

    private onConnectionStateChange(pc: RTCPeerConnection) {
        if (this.pc !== pc) {
            return;
        }

        const connState: string = pc.connectionState ?? pc.iceConnectionState;
        logDebug('p2p: connection state ->', connState);

        switch (connState) {
        case 'connected':
        case 'completed':
            this.clearTimer('disconnectTimer');
            if (this.state === 'p2p-connecting') {
                this.clearTimer('connectTimer');
                logInfo('p2p: connected');
                this.setState('p2p');
                this.applySenderParams();
                this.logSelectedCandidatePair(pc);
                for (const remote of this.remoteTracks) {
                    this.emit('remotetrack', remote);
                }
            }
            break;
        case 'disconnected':
            if (this.state === 'p2p' && !this.disconnectTimer) {
                this.disconnectTimer = setTimeout(() => {
                    this.disconnectTimer = null;
                    if (this.state === 'p2p') {
                        this.fallback('disconnected');
                    }
                }, this.cfg.disconnectGraceMs ?? P2P_DISCONNECT_GRACE_MS);
            }
            break;
        case 'failed':
            if (this.state === 'p2p-connecting' || this.state === 'p2p') {
                this.fallback('connection failed');
            }
            break;
        }
    }

    // Abandon P2P for the current peer and go back to the SFU for good (until
    // the peer or the call conditions change).
    private fallback(reason: string, notifyPeer = true) {
        if (this.state !== 'p2p-connecting' && this.state !== 'p2p') {
            return;
        }

        logWarn('p2p: falling back to sfu:', reason);

        const peer = this.peerSessionID;
        if (peer) {
            this.failedPeers.add(peer);
        }
        if (notifyPeer) {
            this.notifyBye('failed');
        }

        this.closeConnection();
        this.setState('fallback-sfu');
    }

    private notifyBye(reason: P2PByeReason) {
        if (this.peerSessionID) {
            try {
                this.cfg.sendSignal(this.peerSessionID, 'bye', {reason});
            } catch (err) {
                logWarn('p2p: failed to send bye', err);
            }
        }
    }

    private closeConnection() {
        this.clearTimer('connectTimer');
        this.clearTimer('disconnectTimer');

        const pc = this.pc;
        this.pc = null;
        this.transceivers = {};
        this.mediaMap = {};
        this.remoteTracks = [];
        this.pendingCandidates = [];

        if (pc) {
            pc.onicecandidate = null;
            pc.onconnectionstatechange = null;
            pc.oniceconnectionstatechange = null;
            pc.ontrack = null;
            try {
                pc.close();
            } catch (err) {
                logWarn('p2p: failed to close peer connection', err);
            }
        }
    }

    private clearTimer(name: 'connectTimer' | 'disconnectTimer') {
        const timer = this[name];
        if (timer) {
            clearTimeout(timer);
            this[name] = null;
        }
    }

    private setState(next: P2PState) {
        if (next === this.state) {
            return;
        }
        const prev = this.state;
        this.state = next;
        logInfo(`p2p: state ${prev} -> ${next}`);
        this.emit('statechange', next, prev);
    }

    private applyLocalMedia() {
        const map: Array<[P2PTrackType, MediaStreamTrack | null]> = [
            ['voice', this.localMedia.voice],
            ['video', this.localMedia.video],
            ['screen', this.localMedia.screen],
            ['screen-audio', this.localMedia.screenAudio],
        ];

        let screenOrVideoChanged = false;
        const replaced: Array<Promise<unknown>> = [];
        for (const [type, track] of map) {
            const sender = this.transceivers[type]?.sender;
            if (!sender || sender.track === track) {
                continue;
            }
            if (type === 'video' || type === 'screen') {
                screenOrVideoChanged = true;
            }
            replaced.push(sender.replaceTrack(track).catch((err) => {
                logWarn('p2p: failed to replace track', type, err);
            }));
        }

        // sender.track only reflects the new track once replaceTrack has settled, and the
        // sender parameters are applied to the track that is attached.
        if (screenOrVideoChanged && this.state === 'p2p') {
            Promise.all(replaced).then(() => {
                if (this.state === 'p2p') {
                    this.applySenderParams();
                }
            });
        }
    }

    // The negotiation default for screen sharing is AV1 (when enabled and supported by both
    // sides) then VP8, like the SFU path. The sender then switches codec per share (H.264 for
    // 1440p and above) in applySenderParams, which needs no renegotiation: all of these are
    // negotiated, this only decides which one is first.
    private setScreenCodecPreferences() {
        const trx = this.transceivers.screen;
        if (!trx || typeof trx.setCodecPreferences !== 'function' || typeof RTCRtpReceiver === 'undefined' || !RTCRtpReceiver.getCapabilities) {
            return;
        }

        const codecs = RTCRtpReceiver.getCapabilities('video')?.codecs;
        if (!codecs) {
            return;
        }

        const rank = (codec: RTCRtpCodecCapability) => {
            const mime = codec.mimeType.toLowerCase();
            if (mime === 'video/av1') {
                return this.cfg.enableAV1 ? 0 : 3;
            }
            return mime === 'video/vp8' ? 1 : 2;
        };
        const sorted = codecs.map((c, i) => ({c, i}))
            .sort((a, b) => (rank(a.c) - rank(b.c)) || (a.i - b.i))
            .map(({c}) => c);

        try {
            trx.setCodecPreferences(sorted);
        } catch (err) {
            logWarn('p2p: failed to set screen codec preferences', err);
        }
    }

    // Same quality settings as the SFU path. Encodings and degradationPreference
    // are set on the senders once they are negotiated.
    private applySenderParams() {
        const applyVideo = async () => {
            const sender = this.transceivers.video?.sender;
            if (!sender || !sender.track) {
                return;
            }

            try {
                const params = sender.getParameters();
                if (!params.encodings || params.encodings.length === 0) {
                    params.encodings = [{}];
                }
                Object.assign(params.encodings[0], this.cfg.encodings.video);
                await sender.setParameters(params);
            } catch (err) {
                logWarn('p2p: failed to set sender parameters', 'video', err);
            }
        };

        const applyScreen = async () => {
            const sender = this.transceivers.screen?.sender;
            if (!sender || !sender.track) {
                this.screenSettings = null;
                return;
            }

            const quality = this.screenQuality ?? getShareQuality();
            const captured = this.screenCapture;
            const settings = await applyQualityToSender(sender, quality, {
                codec: 'vp8',
                captured,
                extra: this.screenExtra,
                chooseCodec: (negotiated) => pickP2PScreenCodec({
                    quality,
                    captured,
                    negotiated,
                    enableAV1: this.cfg.enableAV1,
                }) as RTCRtpCodecParameters | null,
            });
            this.screenSettings = settings;
            if (settings) {
                const encoding = sender.getParameters().encodings?.[0] as {codec?: {mimeType?: string}} | undefined;
                logInfo('p2p: screen sender codec', encoding?.codec?.mimeType ?? sender.getParameters().codecs?.[0]?.mimeType,
                    'bitrate (Mbps):', settings.bitrateMbps, 'fps:', settings.maxFramerate);
            }
        };

        applyVideo();
        applyScreen();
    }

    // Logs the type of the selected candidate pair (host/srflx/relay), useful to
    // confirm the connection really is direct.
    private async logSelectedCandidatePair(pc: RTCPeerConnection) {
        try {
            const stats = await pc.getStats();
            const byID: {[id: string]: any} = {};
            stats.forEach((s: any) => {
                byID[s.id] = s;
            });
            stats.forEach((s: any) => {
                if (s.type === 'candidate-pair' && (s.selected || (s.nominated && s.state === 'succeeded'))) {
                    const local = byID[s.localCandidateId];
                    const remote = byID[s.remoteCandidateId];
                    logInfo('p2p: selected candidate pair',
                        'local:', local?.candidateType, local?.protocol,
                        'remote:', remote?.candidateType, remote?.protocol);
                }
            });
        } catch (err) {
            logDebug('p2p: failed to read candidate pair stats', err);
        }
    }
}
