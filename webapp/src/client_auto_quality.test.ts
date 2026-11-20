// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import CallsClient from './client';
import {defaultShareQuality, type ScreenShareQuality} from './screen_share_quality';

jest.mock('./log');

// Auto screen share quality wired into the client: the first level, steps driven by sender stats,
// the bitrate cap, live switches between Auto and manual, and the quality shown to the sharer.

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

// A capture of a native `source` size that follows height constraints like a real one (never upscales).
const screenTrack = (source = {width: 3840, height: 2160}, id = 'screen1') => {
    const t: any = {
        kind: 'video',
        id,
        enabled: true,
        readyState: 'live',
        label: id,
        contentHint: '',
        stop: jest.fn(),
        size: {...source},
        getSettings: () => ({...t.size}),
        applyConstraints: jest.fn(async (c: any) => {
            const wanted = c?.height?.max ?? c?.height?.ideal ?? source.height;
            const h = Math.min(source.height, wanted > 4000 ? source.height : wanted);
            t.size = {width: Math.round((source.width * h) / source.height), height: h};
        }),
    };
    return t;
};

type Stats = {reason?: string; available?: number | null; loss?: number};

const makeSender = (stats: () => Stats) => {
    let frames = 1000;
    let enc = 10;
    const sender: any = {
        track: {},
        params: {encodings: [{}], codecs: []},
        getParameters: jest.fn(() => sender.params),
        setParameters: jest.fn(async (p: any) => {
            sender.params = p;
        }),
        getStats: jest.fn(async () => {
            const s = stats();
            frames += 120;
            enc += 0.24;
            const entries: any[] = [
                {id: 'o', type: 'outbound-rtp', kind: 'video', remoteId: 'r', qualityLimitationReason: s.reason ?? 'none', framesPerSecond: 60, framesEncoded: frames, totalEncodeTime: enc},
                {id: 'r', type: 'remote-inbound-rtp', fractionLost: s.loss ?? 0, roundTripTime: 0.02},
            ];
            if (s.available !== null) {
                entries.push({id: 'cp', type: 'candidate-pair', nominated: true, state: 'succeeded', availableOutgoingBitrate: s.available ?? 80_000_000});
            }
            const map = new Map<string, unknown>();
            entries.forEach((e) => map.set(e.id, e));
            return map;
        }),
    };
    return sender;
};

const auto = (over: Partial<ScreenShareQuality> = {}): ScreenShareQuality => ({...defaultShareQuality, auto: true, ...over});
const manual = (over: Partial<ScreenShareQuality> = {}): ScreenShareQuality => ({...defaultShareQuality, auto: false, ...over});

describe('CallsClient auto screen share quality', () => {
    let client: any;
    let peer: any;
    let sender: any;
    let stats: Stats;

    const newClient = (p2pEnabled = false) => {
        client = new CallsClient({
            wsURL: 'wss://test.com',
            iceServers: [],
            enableAV1: false,
            enableVideo: true,
            dcSignaling: false,
            dcLocking: false,
            p2pEnabled,
        });
        stats = {};
        sender = makeSender(() => stats);
        peer = {
            senders: {} as Record<string, any[]>,
            replaceTrack: jest.fn(),
            addTrack: jest.fn(),
            addStream: jest.fn(async (stream: any) => {
                peer.senders[stream.getVideoTracks()[0].id] = [sender];
            }),
            removeTrack: jest.fn(async () => {}),
        };
        client.peer = peer;
        client.ws = {send: jest.fn()};
    };

    const start = async (quality: ScreenShareQuality, source = {width: 3840, height: 2160}) => {
        const track = screenTrack(source);
        await client.setScreenStream(new FakeMediaStream([track]), quality);
        return track;
    };

    const lastParams = () => sender.setParameters.mock.calls[sender.setParameters.mock.calls.length - 1][0];
    const tick = async (n = 1) => {
        for (let i = 0; i < n; i++) {
            // eslint-disable-next-line no-await-in-loop
            await client.autoRunner.tick();
        }
    };

    beforeEach(() => {
        (global as any).MediaStream = FakeMediaStream;
        window.localStorage.clear();
        newClient();
    });

    afterEach(() => {
        client?.destroy();
        delete (global as any).MediaStream;
        window.localStorage.clear();
    });

    it('Game on a 4K source starts at 1440p60: lowers the capture and sends 12 Mbps', async () => {
        const track = await start(auto({content: 'game'}));

        expect(track.applyConstraints).toHaveBeenCalledWith(expect.objectContaining({height: {ideal: 1440, max: 1440}, frameRate: {ideal: 60, max: 60}}));
        expect(track.size.height).toBe(1440);
        expect(peer.addStream.mock.calls[0][1][0].encodings[0]).toMatchObject({maxBitrate: 12_000_000, maxFramerate: 60, scaleResolutionDownBy: 1});
        expect(lastParams().degradationPreference).toBe('maintain-framerate');
        expect(track.contentHint).toBe('motion');

        const info = client.getScreenQualityInfo();
        expect(info.quality.auto).toBe(true);
        expect(info.auto).toEqual({resolution: '1440p', fps: 60, limited: null});
        expect(info.bitrateMbps).toBe(12);
        expect(info.captured).toEqual({width: 2560, height: 1440});
    });

    it('Text on a 4K source starts at the source size at 30 fps', async () => {
        const track = await start(auto({content: 'text'}));

        expect(track.size.height).toBe(2160);
        expect(peer.addStream.mock.calls[0][1][0].encodings[0]).toMatchObject({maxBitrate: 15_000_000, maxFramerate: 30});
        expect(lastParams().degradationPreference).toBe('maintain-resolution');
        expect(client.getScreenQualityInfo().auto).toMatchObject({resolution: '4k', fps: 30});
    });

    it('never asks for more than a smaller source offers', async () => {
        const track = await start(auto({content: 'game'}), {width: 1920, height: 1080});
        expect(track.size.height).toBe(1080);
        expect(client.getScreenQualityInfo().auto).toMatchObject({fps: 60});
        expect(peer.addStream.mock.calls[0][1][0].encodings[0].maxBitrate).toBe(8_000_000);
    });

    it('captures a new Auto share at the source size, then lowers it live', async () => {
        const {buildDisplayMediaConstraints} = jest.requireActual('./screen_share_quality');
        expect(buildDisplayMediaConstraints(auto({content: 'game'}))).toEqual({frameRate: {ideal: 60, max: 60}});
        expect(buildDisplayMediaConstraints(auto({content: 'text'}))).toEqual({frameRate: {ideal: 30, max: 30}});
    });

    it('steps down from sender stats: cpu limitation lowers the capture and the bitrate, no re-share', async () => {
        const track = await start(auto({content: 'game'}));
        client.ws.send.mockClear();
        peer.addStream.mockClear();
        track.applyConstraints.mockClear();

        stats = {reason: 'cpu'};
        await tick(2);

        expect(track.applyConstraints).toHaveBeenCalledWith(expect.objectContaining({height: {ideal: 1080, max: 1080}}));
        expect(track.size.height).toBe(1080);
        expect(lastParams().encodings[0]).toMatchObject({maxBitrate: 8_000_000, maxFramerate: 60});
        expect(client.getScreenQualityInfo().auto).toEqual({resolution: '1080p', fps: 60, limited: 'cpu'});
        expect(client.getScreenQualityInfo().bitrateMbps).toBe(8);

        expect(peer.addStream).not.toHaveBeenCalled();
        expect(client.ws.send).not.toHaveBeenCalled();
    });

    it('caps the bitrate at 85 % of the available outgoing bitrate and shows the limit', async () => {
        await start(auto({content: 'game'}));

        stats = {available: 8_000_000};
        await tick(5);

        // 1440p60 wants 12 Mbps, the cap is 6.8.
        expect(lastParams().encodings[0].maxBitrate).toBe(6_800_000);
        expect(client.getScreenQualityInfo().auto.limited).toBe('bandwidth');
        expect(client.getScreenQualityInfo().bitrateMbps).toBe(6.8);
    });

    it('jumps several levels when the upload cannot carry the current one', async () => {
        await start(auto({content: 'game'}));

        stats = {available: 80_000_000};
        await tick(4);
        stats = {available: 3_000_000};
        await tick(2);

        // 3 Mbps estimate: cap 2.6 Mbps (85 %), the first level whose bitrate x 0.6 fits is 720p60 (4 Mbps table value).
        expect(client.getScreenQualityInfo().auto).toMatchObject({resolution: '720p', fps: 60});
        expect(lastParams().encodings[0].maxBitrate).toBe(2_600_000);
    });

    it('steps back up after ~16 s of headroom', async () => {
        await start(auto({content: 'game'}));
        stats = {reason: 'cpu'};
        await tick(2);
        expect(client.getScreenQualityInfo().auto.resolution).toBe('1080p');

        stats = {};
        await tick(2 + 8);
        expect(client.getScreenQualityInfo().auto).toMatchObject({resolution: '1440p', fps: 60, limited: null});
    });

    it('scales down in the encoder when the capture refuses to shrink (Electron legacy tracks)', async () => {
        const track = screenTrack({width: 3840, height: 2160});
        track.applyConstraints.mockRejectedValue(new Error('OverconstrainedError'));
        await client.setScreenStream(new FakeMediaStream([track]), auto({content: 'game'}));

        expect(track.size.height).toBe(2160);
        const enc = lastParams().encodings[0];
        expect(enc.scaleResolutionDownBy).toBeCloseTo(1.5, 2);

        // The bitrate is the one of the level (1440p60), not of the 4K capture.
        expect(enc.maxBitrate).toBe(12_000_000);
    });

    it('switching to manual live stops Auto and applies the manual values', async () => {
        const track = await start(auto({content: 'game'}));
        expect(client.autoRunner).not.toBeNull();

        await client.setScreenQuality(manual({resolution: '1080p', fps: 30, content: 'text'}));

        expect(client.autoRunner).toBeNull();
        expect(track.size.height).toBe(1080);
        expect(lastParams().encodings[0]).toMatchObject({maxBitrate: 4_000_000, maxFramerate: 30, scaleResolutionDownBy: 1});
        expect(client.getScreenQualityInfo().auto).toBeNull();

        // Stats are no longer looked at.
        sender.getStats.mockClear();
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(sender.getStats).not.toHaveBeenCalled();
    });

    it('switching from manual to Auto live opens the capture to the source first, then picks the level', async () => {
        // A manual 720p share of a 4K screen: the capture is at 720p already.
        const track = screenTrack({width: 3840, height: 2160});
        track.size = {width: 1280, height: 720};
        await client.setScreenStream(new FakeMediaStream([track]), manual({resolution: '720p', fps: 30}));
        track.applyConstraints.mockClear();

        await client.setScreenQuality(auto({content: 'game'}));

        // First the source size (a very large ideal), then the level.
        expect(track.applyConstraints.mock.calls[0][0]).toMatchObject({height: {ideal: 4320}});
        expect(track.applyConstraints.mock.calls[1][0]).toMatchObject({height: {ideal: 1440, max: 1440}});
        expect(track.size.height).toBe(1440);
        expect(client.getScreenQualityInfo().auto).toMatchObject({resolution: '1440p', fps: 60});
        expect(lastParams().encodings[0].maxBitrate).toBe(12_000_000);
    });

    it('changing the content type in Auto restarts the ladder at the other content\'s start', async () => {
        const track = await start(auto({content: 'game'}));
        await client.setScreenQuality(auto({content: 'text'}));

        expect(track.size.height).toBe(2160);
        expect(client.getScreenQualityInfo().auto).toMatchObject({resolution: '4k', fps: 30});
        expect(lastParams().degradationPreference).toBe('maintain-resolution');
    });

    it('stops polling when the share ends', async () => {
        const track = await start(auto());
        await track.onended();
        expect(client.autoRunner).toBeNull();
        expect(client.getScreenQualityInfo()).toBeNull();
    });

    it('hands the level and the cap to the p2p controller', async () => {
        client.destroy();
        newClient(true);
        client.initP2P({getOriginalConnID: () => 'me', send: jest.fn()});
        client.p2p.setScreenQuality = jest.fn();
        client.p2p.setLocalMedia = jest.fn();
        client.p2p.getScreenSenders = jest.fn(() => [sender]);
        client.p2pActive = true;

        await start(auto({content: 'game'}));
        expect(client.p2p.setScreenQuality).toHaveBeenLastCalledWith(
            expect.objectContaining({auto: false, resolution: '1440p', fps: 60}),
            {width: 2560, height: 1440},
            {bitrateCapMbps: null, scaleDown: 1},
        );

        // With p2p active the stats come from the p2p sender.
        stats = {available: 8_000_000};
        await tick(5);
        expect(client.p2p.setScreenQuality).toHaveBeenLastCalledWith(expect.anything(), expect.anything(), {bitrateCapMbps: 6.8, scaleDown: 1});
        expect(sender.getStats).toHaveBeenCalled();
    });
});
