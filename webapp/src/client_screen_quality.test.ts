// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import CallsClient from './client';
import {defaultShareQuality, getShareQuality, type ScreenShareQuality} from './screen_share_quality';

jest.mock('./log');

// Tests how the client applies the screen share quality: at the start of a share
// and when it is changed live, on the SFU senders (VP8 + AV1) and on the P2P sender.

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

const screenTrack = (id = 'screen1', size = {width: 2560, height: 1440}) => {
    const t: any = {
        kind: 'video',
        id,
        enabled: true,
        readyState: 'live',
        label: id,
        contentHint: '',
        stop: jest.fn(),
        size,
        getSettings: () => ({...t.size}),
        applyConstraints: jest.fn(async () => {}),
    };
    return t;
};

const makeSender = (codecs: Array<Record<string, unknown>> = []) => {
    const sender: any = {
        params: {encodings: [{}], codecs},
        getParameters: jest.fn(() => sender.params),
        setParameters: jest.fn(async (p: any) => {
            sender.params = p;
        }),
    };
    return sender;
};

const q = (over: Partial<ScreenShareQuality> = {}): ScreenShareQuality => ({...defaultShareQuality, ...over});

describe('CallsClient screen share quality', () => {
    let client: any;
    let peer: any;
    let vp8Sender: any;
    let av1Sender: any;

    const newClient = (enableAV1: boolean, p2pEnabled = false) => {
        client = new CallsClient({
            wsURL: 'wss://test.com',
            iceServers: [],
            enableAV1,
            enableVideo: true,
            dcSignaling: false,
            dcLocking: false,
            p2pEnabled,
        });
        vp8Sender = makeSender();
        av1Sender = makeSender();
        peer = {
            senders: {} as Record<string, any[]>,
            replaceTrack: jest.fn(),
            addTrack: jest.fn(async (track: any, _stream: any, opts: any) => {
                peer.senders[track.id] = peer.senders[track.id] || [];
                peer.senders[track.id].push(opts?.codec ? av1Sender : vp8Sender);
                peer.lastAddTrackOpts = opts;
            }),
            addStream: jest.fn(async (stream: any, opts: any[]) => {
                const t = stream.getVideoTracks()[0];
                peer.senders[t.id] = [vp8Sender];
                peer.addStreamOpts = opts;
            }),
            removeTrack: jest.fn(async () => {}),
        };
        client.peer = peer;
        client.ws = {send: jest.fn()};
        if (enableAV1) {
            client.av1Codec = {mimeType: 'video/AV1'};
        }
    };

    beforeEach(() => {
        (global as any).MediaStream = FakeMediaStream;
        window.localStorage.clear();
    });

    afterEach(() => {
        client?.destroy();
        delete (global as any).MediaStream;
        window.localStorage.clear();
    });

    const lastParams = (sender: any) => sender.setParameters.mock.calls[sender.setParameters.mock.calls.length - 1][0];

    describe('at the start of a share', () => {
        it('sends VP8 and AV1 with their own bitrate rows and the content type of the choice', async () => {
            newClient(true);
            const track = screenTrack('screen1', {width: 3840, height: 2160});
            await client.setScreenStream(new FakeMediaStream([track]), q({resolution: '4k', fps: 60, content: 'text'}));

            // sendEncodings carry the limits from the first moment on.
            expect(peer.addStreamOpts[0].encodings[0]).toMatchObject({maxBitrate: 25_000_000, maxFramerate: 60, scaleResolutionDownBy: 1});
            expect(peer.lastAddTrackOpts.encodings[0]).toMatchObject({maxBitrate: 17_500_000, maxFramerate: 60, scaleResolutionDownBy: 1});

            // The senders get degradationPreference for the content type.
            expect(lastParams(vp8Sender).encodings[0].maxBitrate).toBe(25_000_000);
            expect(lastParams(av1Sender).encodings[0].maxBitrate).toBe(17_500_000);
            expect(lastParams(vp8Sender).degradationPreference).toBe('maintain-resolution');
            expect(lastParams(av1Sender).degradationPreference).toBe('maintain-resolution');
            expect(['text', 'detail']).toContain(track.contentHint);
        });

        it('uses motion and maintain-framerate for game content', async () => {
            newClient(false);
            const track = screenTrack();
            await client.setScreenStream(new FakeMediaStream([track]), q({resolution: '1440p', fps: 30, content: 'game'}));

            expect(track.contentHint).toBe('motion');
            expect(lastParams(vp8Sender).degradationPreference).toBe('maintain-framerate');
            expect(lastParams(vp8Sender).encodings[0]).toMatchObject({maxBitrate: 6_500_000, maxFramerate: 30});
            expect(peer.addTrack).not.toHaveBeenCalled();
        });

        it('falls back to the stored quality when none is passed', async () => {
            newClient(false);
            window.localStorage.setItem('calls_share_quality', JSON.stringify({resolution: '720p', fps: 15, content: 'game', manualBitrateMbps: null}));
            await client.setScreenStream(new FakeMediaStream([screenTrack('screen1', {width: 1280, height: 720})]));
            expect(lastParams(vp8Sender).encodings[0]).toMatchObject({maxBitrate: 1_500_000, maxFramerate: 15});
        });

        it('does not give a small source the bitrate of the chosen 4K', async () => {
            newClient(false);
            await client.setScreenStream(new FakeMediaStream([screenTrack('screen1', {width: 1920, height: 1080})]), q({resolution: '4k', fps: 30}));
            expect(lastParams(vp8Sender).encodings[0].maxBitrate).toBe(4_000_000);
        });

        it('uses a manual bitrate when set', async () => {
            newClient(true);
            await client.setScreenStream(new FakeMediaStream([screenTrack()]), q({manualBitrateMbps: 9}));
            expect(lastParams(vp8Sender).encodings[0].maxBitrate).toBe(9_000_000);
            expect(lastParams(av1Sender).encodings[0].maxBitrate).toBe(9_000_000);
        });

        it('reports the quality that is in use', async () => {
            newClient(false);
            const events: any[] = [];
            client.on('screenQuality', (info: any) => events.push(info));
            await client.setScreenStream(new FakeMediaStream([screenTrack('screen1', {width: 2560, height: 1440})]), q({resolution: '1440p', fps: 60}));

            const info = client.getScreenQualityInfo();
            expect(info.bitrateMbps).toBe(12);
            expect(info.captured).toEqual({width: 2560, height: 1440});
            expect(events).toHaveLength(1);
        });
    });

    describe('shareScreen', () => {
        afterEach(() => {
            delete (global as any).navigator.mediaDevices;
        });

        it('captures with the picker values and starts the share with them', async () => {
            newClient(false);
            const track = screenTrack('screen1', {width: 1920, height: 1080});
            const getDisplayMedia = jest.fn(async () => new FakeMediaStream([track]));
            Object.defineProperty(global.navigator, 'mediaDevices', {value: {getDisplayMedia}, configurable: true});

            await client.shareScreen('', false, q({resolution: '1080p', fps: 30, content: 'game'}));

            const constraints = (getDisplayMedia.mock.calls[0] as any)[0].video;
            expect(constraints.height).toEqual({ideal: 1080, max: 1080});
            expect(constraints.frameRate).toEqual({ideal: 30, max: 30});
            expect(lastParams(vp8Sender).encodings[0]).toMatchObject({maxBitrate: 4_000_000, maxFramerate: 30});
        });
    });

    describe('live change', () => {
        const startShare = async (quality: ScreenShareQuality, size = {width: 2560, height: 1440}) => {
            const track = screenTrack('screen1', size);
            await client.setScreenStream(new FakeMediaStream([track]), quality);
            vp8Sender.setParameters.mockClear();
            av1Sender.setParameters.mockClear();
            return track;
        };

        it('re-constrains the capture and updates the SFU VP8 and AV1 senders without sharing again', async () => {
            newClient(true);
            const track = await startShare(q({resolution: '1080p', fps: 30}), {width: 1920, height: 1080});
            peer.addStream.mockClear();
            client.ws.send.mockClear();

            // The new size shows up on the track a moment after applyConstraints.
            track.applyConstraints.mockImplementation(async () => {
                track.size = {width: 3840, height: 2160};
            });
            await client.setScreenQuality(q({resolution: '4k', fps: 60, content: 'game'}));

            expect(track.applyConstraints).toHaveBeenCalledWith(expect.objectContaining({
                height: {ideal: 2160, max: 2160},
                frameRate: {ideal: 60, max: 60},
            }));
            expect(lastParams(vp8Sender).encodings[0]).toMatchObject({maxBitrate: 25_000_000, maxFramerate: 60, scaleResolutionDownBy: 1});
            expect(lastParams(av1Sender).encodings[0]).toMatchObject({maxBitrate: 17_500_000, maxFramerate: 60, scaleResolutionDownBy: 1});
            expect(lastParams(vp8Sender).degradationPreference).toBe('maintain-framerate');
            expect(track.contentHint).toBe('motion');

            // No new share: same stream, no websocket traffic, no new senders.
            expect(peer.addStream).not.toHaveBeenCalled();
            expect(client.ws.send).not.toHaveBeenCalled();
        });

        it('switches content type live', async () => {
            newClient(false);
            const track = await startShare(q({resolution: '1440p', fps: 60, content: 'game'}));

            await client.setScreenQuality(q({resolution: '1440p', fps: 60, content: 'text'}));

            expect(lastParams(vp8Sender).degradationPreference).toBe('maintain-resolution');
            expect(['text', 'detail']).toContain(track.contentHint);
        });

        it('applies a manual bitrate and goes back to automatic', async () => {
            newClient(false);
            await startShare(q({resolution: '1440p', fps: 60}));

            await client.setScreenQuality(q({resolution: '1440p', fps: 60, manualBitrateMbps: 20}));
            expect(lastParams(vp8Sender).encodings[0].maxBitrate).toBe(20_000_000);

            await client.setScreenQuality(q({resolution: '1440p', fps: 60, manualBitrateMbps: null}));
            expect(lastParams(vp8Sender).encodings[0].maxBitrate).toBe(12_000_000);
        });

        it('remembers the change as the last choice', async () => {
            newClient(false);
            await startShare(q({resolution: '1080p'}));
            await client.setScreenQuality(q({resolution: '720p', fps: 15}));
            expect(getShareQuality()).toMatchObject({resolution: '720p', fps: 15});
        });

        it('still updates the senders when the browser refuses new constraints (Electron legacy tracks)', async () => {
            newClient(false);
            const track = await startShare(q({resolution: '1080p', fps: 60}), {width: 1920, height: 1080});
            track.applyConstraints.mockRejectedValue(new Error('OverconstrainedError'));

            await client.setScreenQuality(q({resolution: '1080p', fps: 30}));

            expect(lastParams(vp8Sender).encodings[0]).toMatchObject({maxBitrate: 4_000_000, maxFramerate: 30});
        });

        it('only stores the choice when nothing is being shared', async () => {
            newClient(false);
            await client.setScreenQuality(q({resolution: '4k'}));
            expect(getShareQuality().resolution).toBe('4k');
            expect(vp8Sender.setParameters).not.toHaveBeenCalled();
        });

        it('forgets the quality of a share that ended', async () => {
            newClient(false);
            const track = await startShare(q());
            await track.onended();
            expect(client.getScreenQualityInfo()).toBeNull();
        });
    });

    describe('with p2p', () => {
        it('passes the quality and the real capture size to the p2p controller, at start and on live changes', async () => {
            newClient(false, true);
            client.initP2P({getOriginalConnID: () => 'me', send: jest.fn()});
            const p2p = client.p2p;
            p2p.setScreenQuality = jest.fn();
            p2p.setLocalMedia = jest.fn();

            const track = screenTrack('screen1', {width: 2560, height: 1440});
            await client.setScreenStream(new FakeMediaStream([track]), q({resolution: '1440p', fps: 60}));
            expect(p2p.setScreenQuality).toHaveBeenLastCalledWith(expect.objectContaining({resolution: '1440p', fps: 60}), {width: 2560, height: 1440});

            await client.setScreenQuality(q({resolution: '1080p', fps: 30, content: 'text'}));
            expect(p2p.setScreenQuality).toHaveBeenLastCalledWith(expect.objectContaining({resolution: '1080p', fps: 30, content: 'text'}), expect.anything());
            expect(track.applyConstraints).toHaveBeenCalled();

            await track.onended();
            expect(p2p.setScreenQuality).toHaveBeenLastCalledWith(null);
        });

        it('shows the bitrate p2p applied (e.g. the H.264 row) on the preview', async () => {
            newClient(false, true);
            client.initP2P({getOriginalConnID: () => 'me', send: jest.fn()});
            client.p2p.setLocalMedia = jest.fn();
            client.p2pActive = true;
            client.p2p.getScreenSendSettings = jest.fn(() => ({bitrateMbps: 10.8}));

            await client.setScreenStream(new FakeMediaStream([screenTrack()]), q({resolution: '1440p', fps: 60}));
            expect(client.getScreenQualityInfo().bitrateMbps).toBe(10.8);
        });
    });
});
