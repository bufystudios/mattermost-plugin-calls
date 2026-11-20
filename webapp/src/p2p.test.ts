// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {P2P_CONNECT_TIMEOUT_MS, P2P_DISCONNECT_GRACE_MS, P2PConfig, P2PController, p2pRole, P2PState} from './p2p';

jest.mock('./log');

class MockSender {
    track: MediaStreamTrack | null = null;
    replaceTrack = jest.fn(async (track: MediaStreamTrack | null) => {
        this.track = track;
    });
    getParameters = jest.fn(() => ({encodings: [{}], codecs: [{mimeType: 'video/VP8'}]} as any));
    setParameters = jest.fn(async () => {});
}

class MockTransceiver {
    mid: string | null = null;
    direction = 'sendrecv';
    sender = new MockSender();
    setCodecPreferences = jest.fn();
    kind: string;

    constructor(kind: string) {
        this.kind = kind;
    }
}

let pcs: MockPeerConnection[] = [];

class MockPeerConnection {
    config: any;
    transceivers: MockTransceiver[] = [];
    signalingState = 'stable';
    connectionState = 'new';
    iceConnectionState = 'new';
    remoteDescription: any = null;
    localDescription: any = null;
    onicecandidate: any = null;
    onconnectionstatechange: any = null;
    oniceconnectionstatechange: any = null;
    ontrack: any = null;
    addIceCandidate = jest.fn(async () => {});
    close = jest.fn();
    getStats = jest.fn(async () => new Map());

    constructor(config: any) {
        this.config = config;
        pcs.push(this);
    }

    addTransceiver(kind: string) {
        const trx = new MockTransceiver(kind);
        this.transceivers.push(trx);
        return trx;
    }

    getTransceivers() {
        return this.transceivers;
    }

    async setLocalDescription() {
        if (this.signalingState === 'stable') {
            this.signalingState = 'have-local-offer';
            this.localDescription = {type: 'offer', sdp: 'offer-sdp'};
            this.transceivers.forEach((t, i) => {
                t.mid = String(i);
            });
        } else {
            this.signalingState = 'stable';
            this.localDescription = {type: 'answer', sdp: 'answer-sdp'};
        }
    }

    async setRemoteDescription(desc: any) {
        this.remoteDescription = desc;
        if (desc.type === 'offer') {
            this.signalingState = 'have-remote-offer';
        } else {
            this.signalingState = 'stable';
        }
    }

    // Test helpers.
    setConnectionState(state: string) {
        this.connectionState = state;
        this.onconnectionstatechange?.();
    }
}

type Sent = {to: string; kind: string; data?: any};

const flush = async () => {
    for (let i = 0; i < 10; i++) {
        // eslint-disable-next-line no-await-in-loop
        await Promise.resolve();
    }
};

describe('p2pRole', () => {
    it('lets the smaller session ID make the offer', () => {
        expect(p2pRole('aaa', 'bbb')).toBe('offerer');
        expect(p2pRole('bbb', 'aaa')).toBe('answerer');
        expect(p2pRole('a1', 'a2')).toBe('offerer');
        expect(p2pRole('zz', 'a')).toBe('answerer');
    });

    it('gives the two sides opposite roles', () => {
        const a = 'k3j2h4g5h6j7k8l9m0n1b2v3c4';
        const b = 'k3j2h4g5h6j7k8l9m0n1b2v3c5';
        expect(p2pRole(a, b)).not.toBe(p2pRole(b, a));
    });
});

describe('P2PController', () => {
    let sent: Sent[];
    let states: Array<[P2PState, P2PState]>;
    let remoteTracks: Array<{type: string; track: any}>;

    const newTrack = (kind: string, id: string) => ({kind, id, enabled: true, readyState: 'live'} as any as MediaStreamTrack);

    const newController = (me: string, cfg: Partial<P2PConfig> = {}) => {
        const ctrl = new P2PController(me, {
            iceServers: [{urls: 'stun:stun.example.com:3478'}],
            enableAV1: false,
            encodings: {
                video: {maxBitrate: 1000},
            },
            sendSignal: (to, kind, data) => sent.push({to, kind, data}),
            ...cfg,
        });
        ctrl.on('statechange', (state: P2PState, prev: P2PState) => states.push([state, prev]));
        ctrl.on('remotetrack', (t: any) => remoteTracks.push(t));
        return ctrl;
    };

    beforeEach(() => {
        jest.useFakeTimers();
        pcs = [];
        sent = [];
        states = [];
        remoteTracks = [];
        (global as any).RTCPeerConnection = MockPeerConnection;
    });

    afterEach(() => {
        jest.useRealTimers();
        delete (global as any).RTCPeerConnection;
    });

    describe('eligibility', () => {
        it('stays on the sfu without a peer', () => {
            const ctrl = newController('a');
            ctrl.setContext({peerSessionID: null, serverMediaNeeded: false});
            expect(ctrl.getState()).toBe('sfu');
            expect(pcs).toHaveLength(0);
        });

        it('stays on the sfu when media is needed on the server', () => {
            const ctrl = newController('a');
            ctrl.setContext({peerSessionID: 'b', serverMediaNeeded: true});
            expect(ctrl.getState()).toBe('sfu');
            expect(pcs).toHaveLength(0);
        });

        it('ignores a peer that is ourselves', () => {
            const ctrl = newController('a');
            ctrl.setContext({peerSessionID: 'a', serverMediaNeeded: false});
            expect(ctrl.getState()).toBe('sfu');
            expect(pcs).toHaveLength(0);
        });

        it('starts connecting when eligible, using the provided ICE servers', () => {
            const ctrl = newController('a');
            ctrl.setContext({peerSessionID: 'b', serverMediaNeeded: false});
            expect(ctrl.getState()).toBe('p2p-connecting');
            expect(pcs).toHaveLength(1);
            expect(pcs[0].config.iceServers).toEqual([{urls: 'stun:stun.example.com:3478'}]);
        });
    });

    describe('offerer', () => {
        it('creates the four transceivers and sends an offer with the media map', async () => {
            const ctrl = newController('a');
            ctrl.setContext({peerSessionID: 'b', serverMediaNeeded: false});
            await flush();

            expect(pcs[0].transceivers.map((t) => t.kind)).toEqual(['audio', 'video', 'video', 'audio']);
            expect(sent).toHaveLength(1);
            expect(sent[0].to).toBe('b');
            expect(sent[0].kind).toBe('offer');
            expect(sent[0].data.tracks).toEqual({0: 'voice', 1: 'video', 2: 'screen', 3: 'screen-audio'});
            expect(sent[0].data.sdp).toEqual({type: 'offer', sdp: 'offer-sdp'});
        });

        it('applies the answer and queued candidates', async () => {
            const ctrl = newController('a');
            ctrl.setContext({peerSessionID: 'b', serverMediaNeeded: false});
            await flush();

            // A candidate showing up before the answer must be kept until the answer is applied.
            ctrl.handleSignal({from: 'b', kind: 'candidate', data: {candidate: 'c1'}});
            await flush();
            expect(pcs[0].addIceCandidate).not.toHaveBeenCalled();

            ctrl.handleSignal({from: 'b', kind: 'answer', data: {sdp: {type: 'answer', sdp: 'x'}}});
            await flush();
            expect(pcs[0].remoteDescription).toEqual({type: 'answer', sdp: 'x'});
            expect(pcs[0].addIceCandidate).toHaveBeenCalledWith({candidate: 'c1'});

            ctrl.handleSignal({from: 'b', kind: 'candidate', data: {candidate: 'c2'}});
            await flush();
            expect(pcs[0].addIceCandidate).toHaveBeenCalledWith({candidate: 'c2'});
        });

        it('relays local ICE candidates to the peer', async () => {
            const ctrl = newController('a');
            ctrl.setContext({peerSessionID: 'b', serverMediaNeeded: false});
            await flush();

            pcs[0].onicecandidate({candidate: {toJSON: () => ({candidate: 'local'})}});
            expect(sent[sent.length - 1]).toEqual({to: 'b', kind: 'candidate', data: {candidate: 'local'}});
        });
    });

    describe('answerer', () => {
        const offer = {sdp: {type: 'offer', sdp: 'o'}, tracks: {0: 'voice', 1: 'video', 2: 'screen', 3: 'screen-audio'}};

        const setupAnswerer = async () => {
            const ctrl = newController('b');
            ctrl.setContext({peerSessionID: 'a', serverMediaNeeded: false});
            await flush();
            return ctrl;
        };

        it('does not make an offer', async () => {
            await setupAnswerer();
            expect(sent).toHaveLength(0);
            expect(pcs[0].transceivers).toHaveLength(0);
        });

        it('answers an offer and sets the transceivers to sendrecv', async () => {
            const ctrl = await setupAnswerer();
            const pc = pcs[0];
            const trxs = [0, 1, 2, 3].map((i) => {
                const t = new MockTransceiver(i % 3 === 0 ? 'audio' : 'video');
                t.mid = String(i);
                t.direction = 'recvonly';
                return t;
            });
            pc.transceivers = trxs;

            // Candidates received before the offer are queued.
            ctrl.handleSignal({from: 'a', kind: 'candidate', data: {candidate: 'early'}});
            ctrl.handleSignal({from: 'a', kind: 'offer', data: offer});
            await flush();

            expect(trxs.every((t) => t.direction === 'sendrecv')).toBe(true);
            expect(pc.addIceCandidate).toHaveBeenCalledWith({candidate: 'early'});
            expect(sent).toHaveLength(1);
            expect(sent[0]).toEqual({to: 'a', kind: 'answer', data: {sdp: {type: 'answer', sdp: 'answer-sdp'}}});
        });

        it('keeps signals received before it was eligible and uses them when it becomes eligible', async () => {
            const ctrl = newController('b');
            ctrl.handleSignal({from: 'a', kind: 'offer', data: offer});
            await flush();
            expect(pcs).toHaveLength(0);

            ctrl.setContext({peerSessionID: 'a', serverMediaNeeded: false});
            await flush();
            expect(pcs).toHaveLength(1);
            expect(pcs[0].remoteDescription).toEqual(offer.sdp);
            expect(sent.map((s) => s.kind)).toEqual(['answer']);
        });

        it('drops stale signals received before it was eligible', async () => {
            const ctrl = newController('b');
            ctrl.handleSignal({from: 'a', kind: 'offer', data: offer});
            await flush();

            jest.advanceTimersByTime(15000);
            ctrl.setContext({peerSessionID: 'a', serverMediaNeeded: false});
            await flush();
            expect(pcs[0].remoteDescription).toBeNull();
            expect(sent).toHaveLength(0);
        });

        it('ignores signals from other sessions', async () => {
            const ctrl = await setupAnswerer();
            ctrl.handleSignal({from: 'someone-else', kind: 'offer', data: offer});
            await flush();
            expect(pcs[0].remoteDescription).toBeNull();
            expect(sent).toHaveLength(0);
        });
    });

    describe('state machine', () => {
        const connect = async (ctrl: P2PController) => {
            ctrl.setContext({peerSessionID: 'b', serverMediaNeeded: false});
            await flush();
            ctrl.handleSignal({from: 'b', kind: 'answer', data: {sdp: {type: 'answer', sdp: 'x'}}});
            await flush();
            pcs[0].setConnectionState('connected');
        };

        it('goes sfu -> p2p-connecting -> p2p when the connection is established', async () => {
            const ctrl = newController('a');
            await connect(ctrl);

            expect(ctrl.getState()).toBe('p2p');
            expect(ctrl.isActive()).toBe(true);
            expect(states).toEqual([['p2p-connecting', 'sfu'], ['p2p', 'p2p-connecting']]);
        });

        it('does not time out once connected', async () => {
            const ctrl = newController('a');
            await connect(ctrl);
            jest.advanceTimersByTime(P2P_CONNECT_TIMEOUT_MS * 2);
            expect(ctrl.getState()).toBe('p2p');
        });

        it('falls back to the sfu if the connection is not established in time', async () => {
            const ctrl = newController('a');
            ctrl.setContext({peerSessionID: 'b', serverMediaNeeded: false});
            await flush();

            jest.advanceTimersByTime(P2P_CONNECT_TIMEOUT_MS - 1);
            expect(ctrl.getState()).toBe('p2p-connecting');
            jest.advanceTimersByTime(2);
            expect(ctrl.getState()).toBe('fallback-sfu');
            expect(pcs[0].close).toHaveBeenCalled();
            expect(sent[sent.length - 1]).toEqual({to: 'b', kind: 'bye', data: {reason: 'failed'}});
        });

        it('falls back when the connection fails while connecting', async () => {
            const ctrl = newController('a');
            ctrl.setContext({peerSessionID: 'b', serverMediaNeeded: false});
            await flush();

            pcs[0].setConnectionState('failed');
            expect(ctrl.getState()).toBe('fallback-sfu');
            expect(states).toEqual([['p2p-connecting', 'sfu'], ['fallback-sfu', 'p2p-connecting']]);
        });

        it('falls back when an established connection fails', async () => {
            const ctrl = newController('a');
            await connect(ctrl);

            pcs[0].setConnectionState('failed');
            expect(ctrl.getState()).toBe('fallback-sfu');
            expect(states[states.length - 1]).toEqual(['fallback-sfu', 'p2p']);
        });

        it('tolerates a short disconnection but falls back if it lasts', async () => {
            const ctrl = newController('a');
            await connect(ctrl);

            pcs[0].setConnectionState('disconnected');
            jest.advanceTimersByTime(P2P_DISCONNECT_GRACE_MS - 100);
            pcs[0].setConnectionState('connected');
            jest.advanceTimersByTime(P2P_DISCONNECT_GRACE_MS * 2);
            expect(ctrl.getState()).toBe('p2p');

            pcs[0].setConnectionState('disconnected');
            jest.advanceTimersByTime(P2P_DISCONNECT_GRACE_MS + 1);
            expect(ctrl.getState()).toBe('fallback-sfu');
        });

        it('does not retry with a peer after falling back', async () => {
            const ctrl = newController('a');
            ctrl.setContext({peerSessionID: 'b', serverMediaNeeded: false});
            await flush();
            pcs[0].setConnectionState('failed');
            expect(ctrl.getState()).toBe('fallback-sfu');

            // Same inputs again, or flapping eligibility, must not start another attempt.
            ctrl.setContext({peerSessionID: 'b', serverMediaNeeded: false});
            ctrl.setContext({peerSessionID: null, serverMediaNeeded: false});
            ctrl.setContext({peerSessionID: 'b', serverMediaNeeded: false});
            expect(pcs).toHaveLength(1);
            expect(ctrl.getState()).toBe('sfu');
        });

        it('tries again with a different peer after falling back', async () => {
            const ctrl = newController('a');
            ctrl.setContext({peerSessionID: 'b', serverMediaNeeded: false});
            await flush();
            pcs[0].setConnectionState('failed');

            ctrl.setContext({peerSessionID: 'c', serverMediaNeeded: false});
            expect(pcs).toHaveLength(2);
            expect(ctrl.getState()).toBe('p2p-connecting');
        });

        it('goes back to the sfu (and can retry later) when it stops being eligible', async () => {
            const ctrl = newController('a');
            await connect(ctrl);

            // e.g. a recording starts.
            ctrl.setContext({peerSessionID: 'b', serverMediaNeeded: true});
            expect(ctrl.getState()).toBe('sfu');
            expect(pcs[0].close).toHaveBeenCalled();
            expect(sent[sent.length - 1]).toEqual({to: 'b', kind: 'bye', data: {reason: 'ineligible'}});

            // The recording ends.
            ctrl.setContext({peerSessionID: 'b', serverMediaNeeded: false});
            expect(pcs).toHaveLength(2);
            expect(ctrl.getState()).toBe('p2p-connecting');
        });

        it('goes back to the sfu when a third session joins (no peer anymore)', async () => {
            const ctrl = newController('a');
            await connect(ctrl);

            ctrl.setContext({peerSessionID: null, serverMediaNeeded: false});
            expect(ctrl.getState()).toBe('sfu');
        });

        it('falls back for good when the peer says it failed', async () => {
            const ctrl = newController('a');
            await connect(ctrl);

            ctrl.handleSignal({from: 'b', kind: 'bye', data: {reason: 'failed'}});
            await flush();
            expect(ctrl.getState()).toBe('fallback-sfu');

            // It must not answer with a bye of its own.
            expect(sent.filter((s) => s.kind === 'bye')).toHaveLength(0);
        });

        it('goes back to the sfu but may retry when the peer is just ineligible', async () => {
            const ctrl = newController('a');
            await connect(ctrl);

            ctrl.handleSignal({from: 'b', kind: 'bye', data: {reason: 'ineligible'}});
            await flush();
            expect(ctrl.getState()).toBe('sfu');

            ctrl.setContext({peerSessionID: 'b', serverMediaNeeded: false});
            expect(ctrl.getState()).toBe('p2p-connecting');
        });

        it('does not start when the peer already gave up', async () => {
            const ctrl = newController('a');
            ctrl.handleSignal({from: 'b', kind: 'bye', data: {reason: 'failed'}});
            await flush();

            ctrl.setContext({peerSessionID: 'b', serverMediaNeeded: false});
            expect(pcs).toHaveLength(0);
            expect(ctrl.getState()).toBe('sfu');
        });

        it('falls back when creating the peer connection throws', () => {
            (global as any).RTCPeerConnection = function throwing() {
                throw new Error('boom');
            };
            const ctrl = newController('a');
            ctrl.setContext({peerSessionID: 'b', serverMediaNeeded: false});
            expect(ctrl.getState()).toBe('fallback-sfu');
        });
    });

    describe('media', () => {
        it('attaches local media to the transceivers and detaches it', async () => {
            const ctrl = newController('a');
            ctrl.setContext({peerSessionID: 'b', serverMediaNeeded: false});
            await flush();

            const voice = newTrack('audio', 'v1');
            const screen = newTrack('video', 's1');
            ctrl.setLocalMedia({voice, video: null, screen, screenAudio: null});

            const [voiceTrx, videoTrx, screenTrx] = pcs[0].transceivers;
            expect(voiceTrx.sender.track).toBe(voice);
            expect(videoTrx.sender.track).toBeNull();
            expect(screenTrx.sender.track).toBe(screen);

            ctrl.setLocalMedia({voice: null, video: null, screen: null, screenAudio: null});
            expect(voiceTrx.sender.track).toBeNull();
            expect(screenTrx.sender.track).toBeNull();
        });

        it('uses media set before the connection existed', async () => {
            const ctrl = newController('a');
            const voice = newTrack('audio', 'v1');
            ctrl.setLocalMedia({voice, video: null, screen: null, screenAudio: null});

            ctrl.setContext({peerSessionID: 'b', serverMediaNeeded: false});
            await flush();
            expect(pcs[0].transceivers[0].sender.track).toBe(voice);
        });

        const connectWithScreen = async (cfg: Partial<P2PConfig> = {}, codecs: any[] = [{mimeType: 'video/VP8'}]) => {
            const ctrl = newController('a', cfg);
            ctrl.setContext({peerSessionID: 'b', serverMediaNeeded: false});
            await flush();
            const screenSender = pcs[0].transceivers[2].sender;
            screenSender.getParameters.mockImplementation(() => ({encodings: [{}], codecs}));
            return {ctrl, screenSender};
        };

        const goP2P = async (ctrl: P2PController) => {
            ctrl.handleSignal({from: 'b', kind: 'answer', data: {sdp: {type: 'answer', sdp: 'x'}}});
            await flush();
            pcs[0].setConnectionState('connected');
            await flush();
        };

        const lastParams = (sender: MockSender) => (sender.setParameters.mock.calls[sender.setParameters.mock.calls.length - 1] as any)[0];

        it('applies the screen sharing quality settings once connected', async () => {
            const {ctrl, screenSender} = await connectWithScreen();
            ctrl.setLocalMedia({voice: null, video: null, screen: newTrack('video', 's1'), screenAudio: null});
            await goP2P(ctrl);

            // Default quality (1080p60, game): 8 Mbps VP8, framerate over resolution.
            expect(screenSender.setParameters).toHaveBeenCalledTimes(1);
            const params = lastParams(screenSender);
            expect(params.degradationPreference).toBe('maintain-framerate');
            expect(params.encodings[0]).toMatchObject({maxBitrate: 8_000_000, maxFramerate: 60, scaleResolutionDownBy: 1});
            expect(params.encodings[0].codec).toBeUndefined();
        });

        it('uses the AV1 bitrate row when AV1 is enabled and negotiated', async () => {
            const {ctrl, screenSender} = await connectWithScreen({enableAV1: true}, [{mimeType: 'video/AV1'}, {mimeType: 'video/VP8'}]);
            ctrl.setLocalMedia({voice: null, video: null, screen: newTrack('video', 's1'), screenAudio: null});
            await goP2P(ctrl);

            expect(lastParams(screenSender).encodings[0].maxBitrate).toBe(5_600_000);
        });

        it('switches the sender to H.264 from 1440p up when both sides negotiated it', async () => {
            const h264 = {mimeType: 'video/H264', sdpFmtpLine: 'packetization-mode=1;profile-level-id=640032'};
            const {ctrl, screenSender} = await connectWithScreen({enableAV1: true}, [{mimeType: 'video/AV1'}, {mimeType: 'video/VP8'}, h264]);
            ctrl.setScreenQuality({auto: false, resolution: '1440p', fps: 60, content: 'game', manualBitrateMbps: null}, {width: 2560, height: 1440});
            ctrl.setLocalMedia({voice: null, video: null, screen: newTrack('video', 's1'), screenAudio: null});
            await goP2P(ctrl);

            const params = lastParams(screenSender);
            expect(params.encodings[0].codec).toBe(h264);
            expect(params.encodings[0].maxBitrate).toBe(10_800_000);
        });

        it('falls back to the default codec when H.264 was not negotiated', async () => {
            const {ctrl, screenSender} = await connectWithScreen({}, [{mimeType: 'video/VP8'}]);
            ctrl.setScreenQuality({auto: false, resolution: '4k', fps: 60, content: 'game', manualBitrateMbps: null}, {width: 3840, height: 2160});
            ctrl.setLocalMedia({voice: null, video: null, screen: newTrack('video', 's1'), screenAudio: null});
            await goP2P(ctrl);

            const params = lastParams(screenSender);
            expect(params.encodings[0].codec).toBeUndefined();
            expect(params.encodings[0].maxBitrate).toBe(25_000_000);
        });

        it('does not use H.264 when the source is smaller than 1440p', async () => {
            const h264 = {mimeType: 'video/H264', sdpFmtpLine: 'packetization-mode=1;profile-level-id=640032'};
            const {ctrl, screenSender} = await connectWithScreen({}, [{mimeType: 'video/VP8'}, h264]);

            // 4K was chosen but only 1080p is available: never upscale, encode what is there.
            ctrl.setScreenQuality({auto: false, resolution: '4k', fps: 30, content: 'game', manualBitrateMbps: null}, {width: 1920, height: 1080});
            ctrl.setLocalMedia({voice: null, video: null, screen: newTrack('video', 's1'), screenAudio: null});
            await goP2P(ctrl);

            const params = lastParams(screenSender);
            expect(params.encodings[0].codec).toBeUndefined();
            expect(params.encodings[0].maxBitrate).toBe(4_000_000);
        });

        it('re-applies the quality to the live sender when it changes, and clears the codec override', async () => {
            const h264 = {mimeType: 'video/H264', sdpFmtpLine: 'packetization-mode=1;profile-level-id=640032'};
            const {ctrl, screenSender} = await connectWithScreen({}, [{mimeType: 'video/VP8'}, h264]);
            ctrl.setScreenQuality({auto: false, resolution: '1440p', fps: 60, content: 'game', manualBitrateMbps: null}, {width: 2560, height: 1440});
            ctrl.setLocalMedia({voice: null, video: null, screen: newTrack('video', 's1'), screenAudio: null});
            await goP2P(ctrl);
            expect(lastParams(screenSender).encodings[0].codec).toBe(h264);

            // The sender keeps the override that was set before.
            screenSender.getParameters.mockImplementation(() => ({encodings: [{codec: h264}], codecs: [{mimeType: 'video/VP8'}, h264]}));
            ctrl.setScreenQuality({auto: false, resolution: '720p', fps: 30, content: 'text', manualBitrateMbps: 3}, {width: 1280, height: 720});
            await flush();

            const params = lastParams(screenSender);
            expect(params.encodings[0].codec).toBeUndefined();
            expect(params.encodings[0]).toMatchObject({maxBitrate: 3_000_000, maxFramerate: 30});
            expect(params.degradationPreference).toBe('maintain-resolution');
            expect(ctrl.getScreenSendSettings()?.bitrateMbps).toBe(3);
        });

        it('emits remote tracks by type only once connected', async () => {
            const ctrl = newController('a');
            ctrl.setContext({peerSessionID: 'b', serverMediaNeeded: false});
            await flush();

            const voice = newTrack('audio', 'rv');
            const screen = newTrack('video', 'rs');
            pcs[0].ontrack({track: voice, transceiver: {mid: '0'}});
            pcs[0].ontrack({track: screen, transceiver: {mid: '2'}});
            pcs[0].ontrack({track: newTrack('video', 'unknown'), transceiver: {mid: '9'}});
            expect(remoteTracks).toHaveLength(0);

            ctrl.handleSignal({from: 'b', kind: 'answer', data: {sdp: {type: 'answer', sdp: 'x'}}});
            await flush();
            pcs[0].setConnectionState('connected');

            // Each track says which session (the peer) it came from, for per-user volume.
            expect(remoteTracks).toEqual([
                {type: 'voice', track: voice, sessionID: 'b'},
                {type: 'screen', track: screen, sessionID: 'b'},
            ]);
        });

        it('does not emit remote tracks of a connection that was abandoned', async () => {
            const ctrl = newController('a');
            ctrl.setContext({peerSessionID: 'b', serverMediaNeeded: false});
            await flush();
            pcs[0].ontrack({track: newTrack('audio', 'rv'), transceiver: {mid: '0'}});

            jest.advanceTimersByTime(P2P_CONNECT_TIMEOUT_MS + 1);
            expect(ctrl.getState()).toBe('fallback-sfu');
            expect(remoteTracks).toHaveLength(0);
        });
    });

    it('closes without telling the peer on destroy', async () => {
        const ctrl = newController('a');
        ctrl.setContext({peerSessionID: 'b', serverMediaNeeded: false});
        await flush();
        const before = sent.length;

        ctrl.destroy();
        expect(pcs[0].close).toHaveBeenCalled();
        expect(sent).toHaveLength(before);
    });
});
