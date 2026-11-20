// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import CallsClient from './client';
import {STORAGE_CALLS_NOISE_SUPPRESSION_KEY} from './constants';

jest.mock('./log');

// Remote track <-> sender session mapping (needed for per-user volume) for tracks arriving over
// the SFU and over P2P, and the noise suppression option of the client.

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
}

const track = (kind: string, id: string) => ({kind, id, enabled: true, readyState: 'live', label: id, stop: jest.fn(), applyConstraints: jest.fn(async () => undefined)}) as any;

describe('CallsClient remote track sessions', () => {
    let client: any;

    beforeEach(() => {
        (global as any).MediaStream = FakeMediaStream;
        client = new CallsClient({
            wsURL: 'wss://test.com',
            iceServers: [],
            enableAV1: false,
            enableVideo: true,
            dcSignaling: false,
            dcLocking: false,
            p2pEnabled: true,
        });
        client.peer = {replaceTrack: jest.fn(), addTrack: jest.fn(async () => undefined)};
        client.ws = {send: jest.fn()};
        client.initP2P({getOriginalConnID: () => 'me', send: jest.fn()});
    });

    afterEach(() => {
        client.destroy();
        delete (global as any).MediaStream;
        window.localStorage.clear();
    });

    it('maps an SFU voice track to the session that sent it (media map sender_id)', () => {
        const voice = track('audio', 'voice_sess-a_1');
        const onVoice = jest.fn();
        client.on('remoteVoiceStream', onVoice);

        client.onRemoteStream(new FakeMediaStream([voice]), {type: 'voice', sender_id: 'sess-a'}, 'sfu');

        expect(client.getRemoteTrackSessionID('voice_sess-a_1')).toBe('sess-a');
        expect(onVoice).toHaveBeenCalledWith(expect.anything(), 'sess-a');
    });

    it('keeps tracks of different senders apart', () => {
        client.onRemoteStream(new FakeMediaStream([track('audio', 'ta')]), {type: 'voice', sender_id: 'sess-a'}, 'sfu');
        client.onRemoteStream(new FakeMediaStream([track('audio', 'tb')]), {type: 'voice', sender_id: 'sess-b'}, 'sfu');

        expect(client.getRemoteTrackSessionID('ta')).toBe('sess-a');
        expect(client.getRemoteTrackSessionID('tb')).toBe('sess-b');
    });

    it('maps screen share audio to the sharer so their volume applies to it too', () => {
        client.onRemoteStream(new FakeMediaStream([track('audio', 'screen-audio-1')]), {type: 'screen-audio', sender_id: 'sess-a'}, 'sfu');

        expect(client.getRemoteTrackSessionID('screen-audio-1')).toBe('sess-a');
    });

    it('maps a P2P voice track to the peer session', () => {
        const voice = track('audio', 'p2p-voice');
        const onVoice = jest.fn();
        client.on('remoteVoiceStream', onVoice);

        client.p2p.emit('remotetrack', {type: 'voice', track: voice, sessionID: 'peer-sess'});

        expect(client.getRemoteTrackSessionID('p2p-voice')).toBe('peer-sess');
        expect(onVoice).toHaveBeenCalledWith(expect.anything(), 'peer-sess');
    });

    it('forgets P2P track sessions when P2P is abandoned, SFU ones stay', async () => {
        client.onRemoteStream(new FakeMediaStream([track('audio', 'sfu-voice')]), {type: 'voice', sender_id: 'peer-sess'}, 'sfu');
        client.p2p.emit('remotetrack', {type: 'voice', track: track('audio', 'p2p-voice'), sessionID: 'peer-sess'});
        client.onP2PStateChange('p2p', 'p2p-connecting');

        client.onP2PStateChange('fallback-sfu', 'p2p');
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(client.getRemoteTrackSessionID('p2p-voice')).toBeUndefined();
        expect(client.getRemoteTrackSessionID('sfu-voice')).toBe('peer-sess');
    });

    it('does not know the session of a track without sender information', () => {
        client.onRemoteStream(new FakeMediaStream([track('audio', 'anon')]), {type: 'voice'}, 'sfu');

        expect(client.getRemoteTrackSessionID('anon')).toBeUndefined();
    });
});

describe('CallsClient noise suppression', () => {
    let client: any;

    beforeEach(() => {
        client = new CallsClient({
            wsURL: 'wss://test.com',
            iceServers: [],
            enableAV1: false,
            enableVideo: false,
            dcSignaling: false,
            dcLocking: false,
            p2pEnabled: false,
        });
    });

    afterEach(() => {
        client.destroy();
        window.localStorage.clear();
    });

    // jsdom has no AudioWorklet or WebAssembly audio, so the processed levels (the default, Enhanced) cannot run
    // here and the capture starts with the browser's own filter, like Standard.
    it('captures with the browser filter by default when the processed levels cannot run', () => {
        expect(client.defaultAudioTrackOptions).toEqual({
            autoGainControl: true,
            echoCancellation: true,
            noiseSuppression: true,
        });
    });

    it('follows the user level when new tracks are requested', () => {
        window.localStorage.setItem(STORAGE_CALLS_NOISE_SUPPRESSION_KEY, 'off');
        expect(client.defaultAudioTrackOptions.noiseSuppression).toBe(false);

        window.localStorage.setItem(STORAGE_CALLS_NOISE_SUPPRESSION_KEY, 'standard');
        expect(client.defaultAudioTrackOptions.noiseSuppression).toBe(true);
    });

    it('reads the old boolean pref', () => {
        window.localStorage.setItem(STORAGE_CALLS_NOISE_SUPPRESSION_KEY, 'false');
        expect(client.defaultAudioTrackOptions.noiseSuppression).toBe(false);
    });

    it('applies Off and Standard on the live microphone track without recreating it', async () => {
        const mic = track('audio', 'mic');
        client.audioTrack = mic;
        window.localStorage.setItem(STORAGE_CALLS_NOISE_SUPPRESSION_KEY, 'off');
        client.startNoise();
        await client.applyNoiseSuppression();
        expect(mic.applyConstraints).toHaveBeenLastCalledWith({noiseSuppression: false});

        window.localStorage.setItem(STORAGE_CALLS_NOISE_SUPPRESSION_KEY, 'standard');
        await client.applyNoiseSuppression();
        expect(mic.applyConstraints).toHaveBeenLastCalledWith({noiseSuppression: true});
    });

    it('survives a browser that refuses to change constraints on a live track', async () => {
        const mic = track('audio', 'mic');
        mic.applyConstraints.mockRejectedValue(new Error('OverconstrainedError'));
        client.audioTrack = mic;
        window.localStorage.setItem(STORAGE_CALLS_NOISE_SUPPRESSION_KEY, 'standard');
        client.startNoise();

        await expect(client.applyNoiseSuppression()).resolves.toBeUndefined();
    });

    it('does nothing without a microphone track', async () => {
        client.audioTrack = null;

        await expect(client.applyNoiseSuppression()).resolves.toBeUndefined();
    });
});
