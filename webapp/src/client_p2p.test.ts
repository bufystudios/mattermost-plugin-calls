// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import CallsClient from './client';

jest.mock('./log');

// Tests the client side of switching media between the SFU peer and the P2P connection.

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

const track = (kind: string, id: string, enabled = true) => ({kind, id, enabled, readyState: 'live', label: id, stop: jest.fn()}) as any;

describe('CallsClient p2p media routing', () => {
    let client: any;
    let peer: any;
    let p2p: any;
    let voice: any;

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

        peer = {
            replaceTrack: jest.fn(),
            addTrack: jest.fn(async () => {}),
            addStream: jest.fn(async () => {}),
            removeTrack: jest.fn(async () => {}),
        };
        client.peer = peer;
        client.ws = {send: jest.fn()};

        // Creates the real controller (and wires its events), with its inputs mocked.
        client.initP2P({getOriginalConnID: () => 'me', send: jest.fn()});
        p2p = client.p2p;
        p2p.setLocalMedia = jest.fn();
        p2p.setContext = jest.fn();

        voice = track('audio', 'voice1');
        client.audioTrack = voice;
        client.stream = new FakeMediaStream([voice]);
        client.voiceTrackAdded = true;
    });

    afterEach(() => {
        client.destroy();
        delete (global as any).MediaStream;
    });

    const activateP2P = () => client.onP2PStateChange('p2p', 'p2p-connecting');
    const deactivateP2P = async () => {
        client.onP2PStateChange('fallback-sfu', 'p2p');
        await new Promise((resolve) => setTimeout(resolve, 0));
    };

    it('forwards the p2p context to the controller', () => {
        client.setP2PContext({peerSessionID: 'b', serverMediaNeeded: false});
        expect(p2p.setContext).toHaveBeenCalledWith({peerSessionID: 'b', serverMediaNeeded: false});
    });

    it('stops sending over the SFU when p2p becomes active', () => {
        const video = track('video', 'video1');
        client.localVideoStream = new FakeMediaStream([video]);
        client.videoTrackAdded = true;
        client.videoSenderTrackID = 'video1';

        const screen = track('video', 'screen1');
        const screenAudio = track('audio', 'screenaudio1');
        client.localScreenTrack = screen;
        client.localScreenAudioTrack = screenAudio;
        client.screenOnSFU = true;

        activateP2P();

        expect(peer.replaceTrack).toHaveBeenCalledWith('voice1', null);
        expect(peer.replaceTrack).toHaveBeenCalledWith('video1', null);
        expect(peer.replaceTrack).toHaveBeenCalledWith('screen1', null);
        expect(peer.replaceTrack).toHaveBeenCalledWith('screenaudio1', null);
    });

    it('does not touch SFU senders that do not exist', () => {
        client.voiceTrackAdded = false;
        activateP2P();
        expect(peer.replaceTrack).not.toHaveBeenCalled();
    });

    it('keeps mute/unmute off the SFU while p2p is active and tells p2p about it', async () => {
        voice.enabled = false;
        activateP2P();
        peer.replaceTrack.mockClear();

        await client.unmute();
        expect(voice.enabled).toBe(true);
        expect(peer.replaceTrack).not.toHaveBeenCalled();
        expect(peer.addTrack).not.toHaveBeenCalled();
        expect(p2p.setLocalMedia).toHaveBeenLastCalledWith(expect.objectContaining({voice}));
        expect(client.ws.send).toHaveBeenCalledWith('unmute');

        client.mute();
        expect(voice.enabled).toBe(false);
        expect(peer.replaceTrack).not.toHaveBeenCalled();
        expect(p2p.setLocalMedia).toHaveBeenLastCalledWith(expect.objectContaining({voice: null}));
        expect(client.ws.send).toHaveBeenCalledWith('mute');
    });

    it('still uses the SFU for mute/unmute when p2p is not active', async () => {
        client.mute();
        expect(peer.replaceTrack).toHaveBeenCalledWith('voice1', null);

        await client.unmute();
        expect(peer.replaceTrack).toHaveBeenCalledWith('voice1', voice);
    });

    it('resumes sending the enabled voice over the SFU when p2p is abandoned', async () => {
        activateP2P();
        peer.replaceTrack.mockClear();

        await deactivateP2P();
        expect(peer.replaceTrack).toHaveBeenCalledWith('voice1', voice);
    });

    it('does not resume sending voice that is muted', async () => {
        activateP2P();
        voice.enabled = false;
        peer.replaceTrack.mockClear();

        await deactivateP2P();
        expect(peer.replaceTrack).not.toHaveBeenCalled();
        expect(peer.addTrack).not.toHaveBeenCalled();
    });

    it('adds the voice track to the SFU on fallback if it was unmuted for the first time during p2p', async () => {
        client.voiceTrackAdded = false;
        voice.enabled = false;
        activateP2P();
        await client.unmute();
        expect(peer.addTrack).not.toHaveBeenCalled();

        await deactivateP2P();
        expect(peer.addTrack).toHaveBeenCalledWith(voice, client.stream);
        expect(client.voiceTrackAdded).toBe(true);
    });

    it('sends a screen share started during p2p over the SFU on fallback', async () => {
        activateP2P();

        const screen = track('video', 'screen1');
        screen.getSettings = () => ({});
        await client.setScreenStream(new FakeMediaStream([screen]) as any);
        expect(client.ws.send).toHaveBeenCalledWith('screen_on', expect.anything());
        expect(peer.addStream).not.toHaveBeenCalled();
        expect(p2p.setLocalMedia).toHaveBeenLastCalledWith(expect.objectContaining({screen}));
        expect(screen.contentHint).toBe('motion');

        await deactivateP2P();
        expect(peer.addStream).toHaveBeenCalledTimes(1);
        expect(client.screenOnSFU).toBe(true);
    });

    it('re-attaches an existing SFU screen share on fallback instead of adding it again', async () => {
        const screen = track('video', 'screen1');
        await client.setScreenStream(new FakeMediaStream([screen]) as any);
        expect(peer.addStream).toHaveBeenCalledTimes(1);

        activateP2P();
        expect(peer.replaceTrack).toHaveBeenCalledWith('screen1', null);

        await deactivateP2P();
        expect(peer.replaceTrack).toHaveBeenCalledWith('screen1', screen);
        expect(peer.addStream).toHaveBeenCalledTimes(1);
    });

    it('stopping a screen share that was only sent over p2p does not touch the SFU peer', async () => {
        activateP2P();
        const screen = track('video', 'screen1');
        await client.setScreenStream(new FakeMediaStream([screen]) as any);

        await screen.onended();
        expect(peer.removeTrack).not.toHaveBeenCalled();
        expect(client.ws.send).toHaveBeenCalledWith('screen_off');
        expect(p2p.setLocalMedia).toHaveBeenLastCalledWith(expect.objectContaining({screen: null}));
    });

    it('plays remote p2p tracks like SFU ones', () => {
        const events: Array<[string, any]> = [];
        client.on('remoteVoiceStream', (s: any) => events.push(['voice', s]));
        client.on('remoteScreenStream', (s: any) => events.push(['screen', s]));
        client.on('remoteVideoStream', (s: any) => events.push(['video', s]));

        const remoteVoice = track('audio', 'rv');
        const remoteScreen = track('video', 'rs');
        const remoteVideo = track('video', 'rc');
        p2p.emit('remotetrack', {type: 'voice', track: remoteVoice});
        p2p.emit('remotetrack', {type: 'screen', track: remoteScreen});
        p2p.emit('remotetrack', {type: 'video', track: remoteVideo});

        expect(events.map((e) => e[0])).toEqual(['voice', 'screen', 'video']);
        expect(client.getRemoteVoiceTracks()).toEqual([remoteVoice]);
        expect(client.getRemoteScreenStream().getTracks()).toEqual([remoteScreen]);
        expect(client.getRemoteVideoStream().getTracks()).toEqual([remoteVideo]);
    });

    it('points the UI back to the SFU tracks when p2p goes away', async () => {
        const sfuScreen = track('video', 'sfu-screen');
        const sfuVideo = track('video', 'sfu-video');
        client.onRemoteStream(new FakeMediaStream([sfuScreen]), {type: 'screen'}, 'sfu');
        client.onRemoteStream(new FakeMediaStream([sfuVideo]), {type: 'video'}, 'sfu');

        activateP2P();
        const p2pScreen = track('video', 'p2p-screen');
        const p2pVideo = track('video', 'p2p-video');
        p2p.emit('remotetrack', {type: 'screen', track: p2pScreen});
        p2p.emit('remotetrack', {type: 'video', track: p2pVideo});
        expect(client.getRemoteScreenStream().getTracks()).toEqual([p2pScreen]);

        // The p2p connection closes (whether or not the browser marks its tracks as ended).
        const events: string[] = [];
        client.on('remoteScreenStream', () => events.push('screen'));
        client.on('remoteVideoStream', () => events.push('video'));
        await deactivateP2P();

        expect(events.sort()).toEqual(['screen', 'video']);
        expect(client.getRemoteScreenStream().getTracks()).toEqual([sfuScreen]);
        expect(client.getRemoteVideoStream().getTracks()).toEqual([sfuVideo]);
    });
});
