// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import CallsClient from './client';
import {STORAGE_CALLS_DEFAULT_AUDIO_INPUT_KEY, STORAGE_CALLS_NOISE_SUPPRESSION_KEY} from './constants';
import {getNoiseStatus} from './noise/status';

jest.mock('./log');

// A fake audio host: opens a graph per call, its track is what the client must send.
const mockGraphs: any[] = [];
const mockLoadAudioHost = jest.fn();
jest.mock('src/noise/host', () => ({
    loadAudioHost: (...args: any[]) => mockLoadAudioHost(...args),
    noiseProcessingSupported: () => true,
}));

class FakeMediaStream {
    private tracks: any[];
    id = 'stream-' + Math.random();
    constructor(tracks: any[] = []) {
        this.tracks = tracks;
    }
    getTracks() {
        return this.tracks;
    }
    getAudioTracks() {
        return this.tracks.filter((t) => t.kind === 'audio');
    }
    getVideoTracks() {
        return this.tracks.filter((t) => t.kind === 'video');
    }
    removeTrack(t: any) {
        this.tracks = this.tracks.filter((x) => x !== t);
    }
    addTrack(t: any) {
        this.tracks.push(t);
    }
}

const track = (id: string, enabled = false) => ({
    kind: 'audio',
    id,
    enabled,
    readyState: 'live',
    label: id,
    stop: jest.fn(),
    applyConstraints: jest.fn(async () => undefined),
}) as any;

function makeHost() {
    return {
        version: 1,
        dispose: jest.fn(),
        open: jest.fn(async (level: string, source: any) => {
            const graph = {
                level,
                source,
                track: track(`${level}-${mockGraphs.length}`, true),
                setActive: jest.fn(),
                onStats: jest.fn(),
                onError: jest.fn(),
                close: jest.fn(),
            };
            mockGraphs.push(graph);
            return graph;
        }),
    };
}

const flush = async () => {
    for (let i = 0; i < 5; i++) {
        // eslint-disable-next-line no-await-in-loop
        await Promise.resolve();
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
};

describe('CallsClient noise levels on the voice senders', () => {
    let client: any;
    let peer: any;
    let p2pSender: any;
    let raw: any;
    let host: any;

    const setLevel = async (level: string) => {
        window.localStorage.setItem(STORAGE_CALLS_NOISE_SUPPRESSION_KEY, level);
        await client.applyNoiseSuppression();
    };

    // The microphone as initAudio leaves it: a muted raw track in the stream, the controller started.
    const joinWithMic = async (level: string) => {
        window.localStorage.setItem(STORAGE_CALLS_NOISE_SUPPRESSION_KEY, level);
        client.audioTrack = raw;
        client.stream = new FakeMediaStream([raw]);
        client.startNoise();
        await client.noise.settled(1000);
    };

    beforeEach(() => {
        mockGraphs.length = 0;
        host = makeHost();
        mockLoadAudioHost.mockReset();
        mockLoadAudioHost.mockResolvedValue(host);
        (global as any).MediaStream = FakeMediaStream;

        client = new CallsClient({
            wsURL: 'wss://test.com',
            iceServers: [],
            enableAV1: false,
            enableVideo: false,
            dcSignaling: false,
            dcLocking: false,
            p2pEnabled: true,
        });
        peer = {
            replaceTrack: jest.fn(),
            addTrack: jest.fn(async () => undefined),
            addStream: jest.fn(async () => undefined),
            removeTrack: jest.fn(async () => undefined),
        };
        client.peer = peer;
        client.ws = {send: jest.fn()};
        client.initP2P({getOriginalConnID: () => 'me', send: jest.fn()});

        // The real P2P controller, with a fake voice sender.
        p2pSender = {track: null,
            replaceTrack: jest.fn(async (t: any) => {
                p2pSender.track = t;
            })};
        client.p2p.transceivers = {voice: {sender: p2pSender}};
        client.p2p.setContext = jest.fn();

        raw = track('raw1');
    });

    afterEach(() => {
        client.destroy();
        delete (global as any).MediaStream;
        window.localStorage.clear();
    });

    it('Enhanced: the first unmute sends the processed track on the SFU, not the microphone', async () => {
        await joinWithMic('enhanced');
        expect(host.open).toHaveBeenCalledWith('enhanced', raw);
        const processed = mockGraphs[0].track;

        await client.unmute();

        expect(peer.addTrack).toHaveBeenCalledWith(processed, client.stream);
        expect(raw.enabled).toBe(true);
        expect(mockGraphs[0].setActive).toHaveBeenLastCalledWith(true);
    });

    it('Enhanced: the P2P voice sender carries the processed track too', async () => {
        await joinWithMic('enhanced');
        client.onP2PStateChange('p2p', 'p2p-connecting');

        await client.unmute();
        await flush();

        expect(p2pSender.replaceTrack).toHaveBeenLastCalledWith(mockGraphs[0].track);
        expect(p2pSender.track).toBe(mockGraphs[0].track);

        // And nothing goes over the SFU meanwhile.
        expect(peer.addTrack).not.toHaveBeenCalled();
    });

    it('switching levels in a call replaces the SFU sender track each time, with no new sender', async () => {
        await joinWithMic('enhanced');
        await client.unmute();
        const enhanced = mockGraphs[0].track;
        peer.addTrack.mockClear();

        await setLevel('maximum');
        const maximum = mockGraphs[1].track;
        expect(peer.replaceTrack).toHaveBeenLastCalledWith(enhanced.id, maximum);

        await setLevel('standard');
        expect(peer.replaceTrack).toHaveBeenLastCalledWith(maximum.id, raw);
        expect(mockGraphs[1].close).toHaveBeenCalled();

        await setLevel('enhanced');
        const again = mockGraphs[2].track;
        expect(peer.replaceTrack).toHaveBeenLastCalledWith(raw.id, again);
        expect(peer.addTrack).not.toHaveBeenCalled();
    });

    it('switching levels in a call replaces the P2P sender track as well', async () => {
        await joinWithMic('enhanced');
        client.onP2PStateChange('p2p', 'p2p-connecting');
        await client.unmute();
        await flush();
        peer.replaceTrack.mockClear();

        await setLevel('maximum');
        await flush();
        expect(p2pSender.track).toBe(mockGraphs[1].track);

        await setLevel('off');
        await flush();
        expect(p2pSender.track).toBe(raw);

        // The SFU peer is not used while the media goes peer to peer.
        expect(peer.replaceTrack).not.toHaveBeenCalled();
    });

    it('mute empties both senders, unmute fills them with the processed track again', async () => {
        await joinWithMic('enhanced');
        await client.unmute();
        const processed = mockGraphs[0].track;

        client.mute();
        expect(peer.replaceTrack).toHaveBeenLastCalledWith(processed.id, null);
        expect(mockGraphs[0].setActive).toHaveBeenLastCalledWith(false);
        expect(raw.enabled).toBe(false);

        await client.unmute();
        expect(peer.replaceTrack).toHaveBeenLastCalledWith(processed.id, processed);
    });

    it('a level change while muted sends nothing, the next unmute uses the new track', async () => {
        await joinWithMic('enhanced');
        await client.unmute();
        client.mute();
        peer.replaceTrack.mockClear();

        await setLevel('maximum');
        expect(peer.replaceTrack).not.toHaveBeenCalled();

        const first = mockGraphs[0].track;
        const maximum = mockGraphs[1].track;
        await client.unmute();

        // The sender is still keyed by the track it last held.
        expect(peer.replaceTrack).toHaveBeenLastCalledWith(first.id, maximum);
    });

    it('falling back from p2p to the SFU resumes with the processed track', async () => {
        await joinWithMic('enhanced');
        client.onP2PStateChange('p2p', 'p2p-connecting');
        await client.unmute();
        client.voiceTrackAdded = false;

        client.onP2PStateChange('fallback-sfu', 'p2p');
        await flush();

        expect(peer.addTrack).toHaveBeenCalledWith(mockGraphs[0].track, client.stream);
    });

    it('a device change keeps sending the filter output and moves the filter to the new microphone', async () => {
        await joinWithMic('enhanced');
        await client.unmute();
        const processed = mockGraphs[0].track;
        peer.replaceTrack.mockClear();

        const newRaw = track('raw2');
        (navigator as any).mediaDevices = {
            getUserMedia: jest.fn(async () => new FakeMediaStream([newRaw])),
            addEventListener: jest.fn(),
            removeEventListener: jest.fn(),
            enumerateDevices: jest.fn(async () => []),
        };
        client.emit = jest.fn();
        await client.setAudioInputDevice({deviceId: 'dev2', label: 'dev2'} as MediaDeviceInfo, false);
        await client.noise.settled(1000);

        // Only the processed track moves: the old filter output was never replaced by the raw new track.
        expect(raw.stop).toHaveBeenCalled();
        expect(host.open).toHaveBeenLastCalledWith('enhanced', newRaw);
        expect(peer.replaceTrack).toHaveBeenCalledTimes(1);
        expect(peer.replaceTrack).toHaveBeenLastCalledWith(processed.id, mockGraphs[1].track);
        expect(newRaw.enabled).toBe(true);

        delete (navigator as any).mediaDevices;
    });

    it('Standard device change replaces the SFU track with the new raw microphone track', async () => {
        await joinWithMic('standard');
        await client.unmute();
        peer.replaceTrack.mockClear();

        const newRaw = track('raw2');
        (navigator as any).mediaDevices = {
            getUserMedia: jest.fn(async () => new FakeMediaStream([newRaw])),
            addEventListener: jest.fn(),
            removeEventListener: jest.fn(),
            enumerateDevices: jest.fn(async () => []),
        };
        client.emit = jest.fn();
        await client.setAudioInputDevice({deviceId: 'dev2', label: 'dev2'} as MediaDeviceInfo, false);

        expect(peer.replaceTrack).toHaveBeenCalledWith(raw.id, newRaw);
        expect(host.open).not.toHaveBeenCalled();

        delete (navigator as any).mediaDevices;
    });

    it('reopens the microphone when it ignores the noise suppression constraint (the browser filter must go off)', async () => {
        raw.getSettings = jest.fn(() => ({noiseSuppression: true, deviceId: 'dev1'}));
        const newRaw = track('raw2');
        newRaw.getSettings = jest.fn(() => ({noiseSuppression: false, deviceId: 'dev1'}));
        const getUserMedia = jest.fn(async () => new FakeMediaStream([newRaw]));
        (navigator as any).mediaDevices = {getUserMedia, addEventListener: jest.fn(), removeEventListener: jest.fn(), enumerateDevices: jest.fn(async () => [])};

        await joinWithMic('enhanced');

        // Enhanced switches the browser filter off; the first track still reported it on, so it was reopened.
        expect(raw.applyConstraints).toHaveBeenCalledWith({noiseSuppression: false});
        expect(getUserMedia).toHaveBeenCalledWith({video: false, audio: expect.objectContaining({noiseSuppression: false, deviceId: {exact: 'dev1'}})});
        expect(client.audioTrack).toBe(newRaw);
        expect(host.open).toHaveBeenCalledWith('enhanced', newRaw);
        expect(host.open).toHaveBeenCalledTimes(1);

        // The new track still reports the old value (a device that ignores the constraint): no reopen loop.
        newRaw.getSettings = jest.fn(() => ({noiseSuppression: true, deviceId: 'dev1'}));
        await client.applyNoiseSuppression();
        await client.noise.sourceChanged();
        await client.noise.settled(500);
        expect(getUserMedia).toHaveBeenCalledTimes(1);

        delete (navigator as any).mediaDevices;
    });

    it('changing the noise level never changes the selected microphone', async () => {
        const stored = JSON.stringify({deviceId: 'dev2', label: 'USB mic'});
        window.localStorage.setItem(STORAGE_CALLS_DEFAULT_AUDIO_INPUT_KEY, stored);
        const device = {deviceId: 'dev2', label: 'USB mic'} as MediaDeviceInfo;
        client.currentAudioInputDevice = device;

        // A device that ignores the constraint: every wanted value reopens the microphone once, on the same device.
        const opened: any[] = [];
        const getUserMedia = jest.fn(async (constraints: any) => {
            const t = track(`raw-${opened.length + 2}`);
            t.getSettings = jest.fn(() => ({noiseSuppression: !constraints.audio.noiseSuppression, deviceId: 'dev2'}));
            opened.push(t);
            return new FakeMediaStream([t]);
        });
        (navigator as any).mediaDevices = {getUserMedia, addEventListener: jest.fn(), removeEventListener: jest.fn(), enumerateDevices: jest.fn(async () => [])};
        raw.getSettings = jest.fn(() => ({noiseSuppression: true, deviceId: 'dev2'}));
        await joinWithMic('standard');
        await client.unmute();

        for (const level of ['enhanced', 'maximum', 'off', 'standard', 'enhanced']) {
            // eslint-disable-next-line no-await-in-loop
            await setLevel(level);
            // eslint-disable-next-line no-await-in-loop
            await client.noise.settled(1000);
        }

        // Live constraint changes never carry a device, and every reopen asks for exactly the selected one.
        const live = [raw, ...opened].flatMap((t) => t.applyConstraints.mock.calls.map((c: any[]) => c[0]));
        expect(live.length).toBeGreaterThan(0);
        live.forEach((c) => expect(c).not.toHaveProperty('deviceId'));
        expect(getUserMedia).toHaveBeenCalled();
        getUserMedia.mock.calls.forEach(([c]: any[]) => expect(c.audio.deviceId).toEqual({exact: 'dev2'}));
        expect(client.currentAudioInputDevice).toBe(device);
        expect(window.localStorage.getItem(STORAGE_CALLS_DEFAULT_AUDIO_INPUT_KEY)).toBe(stored);

        delete (navigator as any).mediaDevices;
    });

    it('with no chosen device the reopen keeps the device the track came from', async () => {
        raw.getSettings = jest.fn(() => ({noiseSuppression: true, deviceId: 'sys-default'}));
        const newRaw = track('raw2');
        newRaw.getSettings = jest.fn(() => ({noiseSuppression: false, deviceId: 'sys-default'}));
        const getUserMedia = jest.fn(async () => new FakeMediaStream([newRaw]));
        (navigator as any).mediaDevices = {getUserMedia, addEventListener: jest.fn(), removeEventListener: jest.fn(), enumerateDevices: jest.fn(async () => [])};
        expect(client.currentAudioInputDevice).toBeNull();

        await joinWithMic('enhanced');

        expect(getUserMedia).toHaveBeenCalledWith({video: false, audio: expect.objectContaining({deviceId: {exact: 'sys-default'}})});
        expect(client.currentAudioInputDevice).toBeNull();

        delete (navigator as any).mediaDevices;
    });

    describe('fallback', () => {
        it('a host that can not load leaves the raw track on the senders and says why', async () => {
            mockLoadAudioHost.mockRejectedValue(new Error('blocked by CSP'));
            await joinWithMic('enhanced');
            await client.unmute();

            expect(peer.addTrack).toHaveBeenCalledWith(raw, client.stream);
            expect(getNoiseStatus()).toMatchObject({effective: 'standard', fallback: {from: 'enhanced', reason: 'unavailable'}});
            expect(raw.applyConstraints).toHaveBeenLastCalledWith({noiseSuppression: true});
        });

        it('a filter that dies mid-call puts the raw track back on the SFU sender', async () => {
            await joinWithMic('enhanced');
            await client.unmute();
            const processed = mockGraphs[0].track;
            peer.replaceTrack.mockClear();

            mockGraphs[0].onError.mock.calls[0][0]('boom');
            await client.noise.settled(1000);

            expect(peer.replaceTrack).toHaveBeenLastCalledWith(processed.id, raw);
            expect(getNoiseStatus().fallback).toEqual({from: 'enhanced', reason: 'error'});
        });
    });

    it('a push-to-talk press that is released while the filter still loads leaves the mic closed', async () => {
        let release: (h: any) => void = () => undefined;
        mockLoadAudioHost.mockImplementation(() => new Promise((resolve) => {
            release = resolve;
        }));
        await joinWithMic('enhanced').catch(() => undefined);
        client.noise.settled = (ms: number) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 30)));

        const unmuting = client.unmute();
        client.mute();
        await unmuting;
        release(host);

        expect(raw.enabled).toBe(false);
        expect(peer.addTrack).not.toHaveBeenCalled();
    });
});
