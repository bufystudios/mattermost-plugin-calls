// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {STORAGE_CALLS_SHARE_QUALITY_KEY} from 'src/constants';

import {
    applyContentHint,
    applyQualityToSender,
    autoBitrateMbps,
    buildDisplayMediaConstraints,
    buildElectronMandatory,
    buildLiveConstraints,
    codecFromMimeType,
    defaultShareQuality,
    effectiveCaptureSize,
    formatQualityLabel,
    getShareQuality,
    normalizeShareQuality,
    pickP2PScreenCodec,
    presetWidth,
    resolveBitrateMbps,
    screenSenderSettings,
    type ScreenShareQuality,
    setShareQuality,
    shareFpsOptions,
} from './screen_share_quality';

jest.mock('./log');

const q = (over: Partial<ScreenShareQuality> = {}): ScreenShareQuality => ({...defaultShareQuality, auto: false, ...over});

const px = (height: '720p' | '1080p' | '1440p' | '4k') => {
    const h = {'720p': 720, '1080p': 1080, '1440p': 1440, '4k': 2160}[height];
    return presetWidth(height) * h;
};

describe('automatic bitrate table', () => {
    // The agreed table (VP8, Mbps): rows are the capture size, columns 15 / 30 / 60 fps.
    const table: Array<['720p' | '1080p' | '1440p' | '4k', number, number, number]> = [
        ['720p', 1.5, 2.5, 4],
        ['1080p', 2.5, 4, 8],
        ['1440p', 4, 6.5, 12],
        ['4k', 8, 15, 25],
    ];

    it.each(table)('matches the VP8 row of %s', (res, fps15, fps30, fps60) => {
        expect(autoBitrateMbps(px(res), 15, 'vp8')).toBe(fps15);
        expect(autoBitrateMbps(px(res), 30, 'vp8')).toBe(fps30);
        expect(autoBitrateMbps(px(res), 60, 'vp8')).toBe(fps60);
    });

    it('covers the examples of the spec', () => {
        expect(autoBitrateMbps(px('720p'), 30, 'vp8')).toBe(2.5);
        expect(autoBitrateMbps(px('1080p'), 30, 'vp8')).toBe(4);
        expect(autoBitrateMbps(px('1080p'), 60, 'vp8')).toBe(8);
        expect(autoBitrateMbps(px('1440p'), 60, 'vp8')).toBe(12);
        expect(autoBitrateMbps(px('4k'), 30, 'vp8')).toBe(15);
        expect(autoBitrateMbps(px('4k'), 60, 'vp8')).toBe(25);
    });

    it('is lower for AV1 and H.264 than for VP8 and AV1 is the lowest', () => {
        for (const [res, , , fps60] of table) {
            const vp8 = autoBitrateMbps(px(res), 60, 'vp8');
            const h264 = autoBitrateMbps(px(res), 60, 'h264');
            const av1 = autoBitrateMbps(px(res), 60, 'av1');
            expect(vp8).toBe(fps60);
            expect(h264).toBeLessThan(vp8);
            expect(av1).toBeLessThan(h264);
        }
        expect(autoBitrateMbps(px('4k'), 60, 'av1')).toBe(17.5);
        expect(autoBitrateMbps(px('4k'), 60, 'h264')).toBe(22.5);
    });

    it('grows with the frame rate and with the size', () => {
        for (const res of ['720p', '1080p', '1440p', '4k'] as const) {
            expect(autoBitrateMbps(px(res), 15, 'vp8')).toBeLessThan(autoBitrateMbps(px(res), 30, 'vp8'));
            expect(autoBitrateMbps(px(res), 30, 'vp8')).toBeLessThan(autoBitrateMbps(px(res), 60, 'vp8'));
        }
        for (const fps of shareFpsOptions) {
            let last = 0;
            for (const res of ['720p', '1080p', '1440p', '4k'] as const) {
                const mbps = autoBitrateMbps(px(res), fps, 'vp8');
                expect(mbps).toBeGreaterThan(last);
                last = mbps;
            }
        }
    });

    it('interpolates sizes between the rows by pixel count', () => {
        // 3440x1440 (ultrawide) sits between 1440p and 4K.
        const mbps = autoBitrateMbps(3440 * 1440, 60, 'vp8');
        expect(mbps).toBeGreaterThan(12);
        expect(mbps).toBeLessThan(25);
    });

    it('scales down below 720p and stays at the 4K value above it', () => {
        expect(autoBitrateMbps(640 * 360, 30, 'vp8')).toBeCloseTo((2.5 * (640 * 360)) / px('720p'), 1);
        expect(autoBitrateMbps(7680 * 4320, 60, 'vp8')).toBe(25);
    });

    it('never goes below the minimum', () => {
        expect(autoBitrateMbps(100 * 100, 15, 'av1')).toBe(0.5);
    });
});

describe('bitrate resolution', () => {
    it('uses the manual value regardless of codec and size', () => {
        const quality = q({manualBitrateMbps: 7.5});
        expect(resolveBitrateMbps(quality, 'vp8')).toBe(7.5);
        expect(resolveBitrateMbps(quality, 'av1', {width: 3840, height: 2160})).toBe(7.5);
    });

    it('is based on the real capture size when known (a small source is not given a 4K bitrate)', () => {
        const quality = q({resolution: '4k', fps: 30});
        expect(resolveBitrateMbps(quality, 'vp8', {width: 1920, height: 1080})).toBe(4);
        expect(resolveBitrateMbps(quality, 'vp8', {width: 3840, height: 2160})).toBe(15);
    });

    it('falls back to the preset when the capture size is not known yet', () => {
        expect(resolveBitrateMbps(q({resolution: '1440p', fps: 60}), 'vp8')).toBe(12);
        expect(resolveBitrateMbps(q({resolution: '4k', fps: 60}), 'vp8', {})).toBe(25);
    });

    it('assumes 1080p for source while the size is unknown', () => {
        expect(resolveBitrateMbps(q({resolution: 'source', fps: 60}), 'vp8')).toBe(8);
    });
});

describe('sender settings', () => {
    it('never scales the capture down in the encoder', () => {
        for (const resolution of ['720p', '1080p', '1440p', '4k', 'source'] as const) {
            expect(screenSenderSettings(q({resolution}), 'vp8').scaleResolutionDownBy).toBe(1);
        }
    });

    it('maps game to maintain-framerate and text to maintain-resolution', () => {
        expect(screenSenderSettings(q({content: 'game'}), 'vp8').degradationPreference).toBe('maintain-framerate');
        expect(screenSenderSettings(q({content: 'text'}), 'vp8').degradationPreference).toBe('maintain-resolution');
    });

    it('converts to bits per second and keeps the chosen frame rate', () => {
        const s = screenSenderSettings(q({resolution: '1440p', fps: 60}), 'vp8');
        expect(s).toMatchObject({maxBitrate: 12_000_000, maxFramerate: 60, bitrateMbps: 12});
    });
});

describe('capture constraints', () => {
    it('limits height, width and frame rate for a preset and never sets a minimum', () => {
        const c = buildDisplayMediaConstraints(q({resolution: '1440p', fps: 30}));
        expect(c.height).toEqual({ideal: 1440, max: 1440});
        expect(c.frameRate).toEqual({ideal: 30, max: 30});

        // Wide enough for 32:9, not a 16:9 box.
        expect((c.width as {max: number}).max).toBeGreaterThanOrEqual(3440);
        expect(JSON.stringify(c)).not.toContain('min');
    });

    it('asks for 3840x2160 class sizes at 4K', () => {
        const c = buildDisplayMediaConstraints(q({resolution: '4k', fps: 60}));
        expect(c.height).toEqual({ideal: 2160, max: 2160});
        expect((c.width as {max: number}).max).toBeGreaterThanOrEqual(3840);
    });

    it.each([['720p', 720], ['1080p', 1080], ['1440p', 1440], ['4k', 2160]] as const)('%s uses a %d px height', (resolution, height) => {
        expect(buildDisplayMediaConstraints(q({resolution})).height).toEqual({ideal: height, max: height});
    });

    it('sets no size at all for source in getDisplayMedia', () => {
        const c = buildDisplayMediaConstraints(q({resolution: 'source', fps: 60}));
        expect(c.width).toBeUndefined();
        expect(c.height).toBeUndefined();
        expect(c.frameRate).toEqual({ideal: 60, max: 60});
    });

    it('does not carry the old 2560x1440 caps', () => {
        for (const resolution of ['1080p', '1440p', '4k', 'source'] as const) {
            const c = buildDisplayMediaConstraints(q({resolution}));
            expect(c.height).not.toEqual({ideal: 1440});
            expect(JSON.stringify(c)).not.toContain('2560');
        }
        expect((buildDisplayMediaConstraints(q({resolution: '4k'})).width as {max: number}).max).toBeGreaterThan(2560);
    });

    describe('live changes', () => {
        it('uses the same limits as the start for a preset', () => {
            expect(buildLiveConstraints(q({resolution: '1080p', fps: 15}))).toEqual(buildDisplayMediaConstraints(q({resolution: '1080p', fps: 15})));
        });

        it('replaces an earlier limit with the largest ideal size for source, never with a minimum', () => {
            const c = buildLiveConstraints(q({resolution: 'source', fps: 30}));
            expect(c.height).toEqual({ideal: 4320});
            expect(c.width).toEqual({ideal: 7680});
            expect(JSON.stringify(c)).not.toContain('min');
        });
    });

    describe('Electron (legacy mandatory keys)', () => {
        it('is driven by the picker', () => {
            const m = buildElectronMandatory(q({resolution: '1440p', fps: 30}), 'screen:1:0');
            expect(m).toMatchObject({
                chromeMediaSource: 'desktop',
                chromeMediaSourceId: 'screen:1:0',
                maxHeight: 1440,
                maxFrameRate: 30,
            });
            expect(m.maxWidth).toBeGreaterThanOrEqual(3440);
            expect(m).not.toHaveProperty('minWidth');
            expect(m).not.toHaveProperty('minHeight');
        });

        it('does not cap 4K at 1440p anymore', () => {
            const m = buildElectronMandatory(q({resolution: '4k', fps: 60}));
            expect(m.maxHeight).toBe(2160);
            expect(m.maxFrameRate).toBe(60);
            expect(m).not.toHaveProperty('chromeMediaSourceId');
        });

        it('uses a hint-only minimum frame rate below the requested one', () => {
            expect(buildElectronMandatory(q({fps: 60})).minFrameRate).toBe(30);
            expect(buildElectronMandatory(q({fps: 15})).minFrameRate).toBe(7);
        });

        it('sets an upper bound only, no lower bound, for source', () => {
            const m = buildElectronMandatory(q({resolution: 'source'}));
            expect(m.maxHeight).toBeGreaterThanOrEqual(4320);
            expect(m.maxWidth).toBeGreaterThanOrEqual(7680);
            expect(JSON.stringify(m)).not.toMatch(/"min(Width|Height)"/);
        });
    });
});

describe('never upscale', () => {
    it('captures a smaller source at its own size', () => {
        expect(effectiveCaptureSize(q({resolution: '4k'}), {width: 1920, height: 1080})).toEqual({width: 1920, height: 1080});
        expect(effectiveCaptureSize(q({resolution: '1440p'}), {width: 1280, height: 720})).toEqual({width: 1280, height: 720});
    });

    it('shrinks a bigger source to the preset, keeping the aspect ratio', () => {
        expect(effectiveCaptureSize(q({resolution: '1080p'}), {width: 3840, height: 2160})).toEqual({width: 1920, height: 1080});
        expect(effectiveCaptureSize(q({resolution: '1440p'}), {width: 2560, height: 1600})).toEqual({width: 2304, height: 1440});
    });

    it('keeps ultrawide sources wide', () => {
        expect(effectiveCaptureSize(q({resolution: '1440p'}), {width: 3440, height: 1440})).toEqual({width: 3440, height: 1440});
    });

    it('keeps the source size for source', () => {
        expect(effectiveCaptureSize(q({resolution: 'source'}), {width: 5120, height: 2880})).toEqual({width: 5120, height: 2880});
    });
});

describe('codec choice for P2P', () => {
    const vp8 = {mimeType: 'video/VP8'};
    const av1 = {mimeType: 'video/AV1'};
    const h264Baseline = {mimeType: 'video/H264', sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f'};
    const h264High = {mimeType: 'video/H264', sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=640032'};
    const h264NonInterleaved = {mimeType: 'video/H264', sdpFmtpLine: 'level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=640032'};
    const rtx = {mimeType: 'video/rtx'};

    const pick = (quality: ScreenShareQuality, negotiated: Array<{mimeType: string; sdpFmtpLine?: string}>, enableAV1 = false, captured?: {width: number; height: number}) => (
        pickP2PScreenCodec({quality, negotiated, enableAV1, captured})
    );

    it('prefers H.264 from 1440p up when both sides support it, even over AV1', () => {
        expect(pick(q({resolution: '1440p'}), [av1, vp8, h264High], true)).toBe(h264High);
        expect(pick(q({resolution: '4k'}), [vp8, h264High])).toBe(h264High);
    });

    it('picks the best H.264 variant (packetization mode 1, highest profile)', () => {
        expect(pick(q({resolution: '4k'}), [vp8, h264Baseline, h264NonInterleaved, h264High])).toBe(h264High);
    });

    it('uses H.264 for source when the real size is 1440p or more, VP8 when it is smaller', () => {
        expect(pick(q({resolution: 'source'}), [vp8, h264High], false, {width: 3840, height: 2160})).toBe(h264High);
        expect(pick(q({resolution: 'source'}), [vp8, h264High], false, {width: 1920, height: 1080})).toBe(vp8);
    });

    it('treats a 16:10 capture limited to 1440p as 1440p', () => {
        expect(pick(q({resolution: '1440p'}), [vp8, h264High], false, {width: 2304, height: 1440})).toBe(h264High);
    });

    it('does not use H.264 below 1440p', () => {
        expect(pick(q({resolution: '1080p'}), [vp8, h264High])).toBe(vp8);
        expect(pick(q({resolution: '720p'}), [vp8, h264High])).toBe(vp8);
    });

    it('does not use H.264 when the source is smaller than the chosen 4K', () => {
        expect(pick(q({resolution: '4k'}), [vp8, h264High], false, {width: 1920, height: 1080})).toBe(vp8);
    });

    it('falls back to AV1 if enabled and negotiated, else VP8', () => {
        expect(pick(q({resolution: '4k'}), [av1, vp8], true)).toBe(av1);
        expect(pick(q({resolution: '1080p'}), [av1, vp8], true)).toBe(av1);
        expect(pick(q({resolution: '1080p'}), [av1, vp8], false)).toBe(vp8);
        expect(pick(q({resolution: '4k'}), [vp8], true)).toBe(vp8);
    });

    it('returns null when none of the codecs is negotiated', () => {
        expect(pick(q(), [rtx])).toBeNull();
    });

    it('maps mime types', () => {
        expect(codecFromMimeType('video/VP8')).toBe('vp8');
        expect(codecFromMimeType('video/h264')).toBe('h264');
        expect(codecFromMimeType('video/AV1')).toBe('av1');
        expect(codecFromMimeType('video/rtx')).toBeNull();
    });
});

describe('applyQualityToSender', () => {
    const makeSender = (params: Record<string, unknown>) => {
        const sender = {
            getParameters: jest.fn(() => params),
            setParameters: jest.fn(async () => {}),
        };
        return sender as unknown as RTCRtpSender & typeof sender;
    };

    it('sets encoding limits and degradation preference', async () => {
        const sender = makeSender({encodings: [{}], codecs: []});
        const s = await applyQualityToSender(sender, q({resolution: '1440p', fps: 30, content: 'text'}), {codec: 'vp8'});

        expect(s?.maxBitrate).toBe(6_500_000);
        const params = sender.setParameters.mock.calls[0] as unknown as Array<Record<string, any>>;
        expect(params[0].encodings[0]).toMatchObject({maxBitrate: 6_500_000, maxFramerate: 30, scaleResolutionDownBy: 1});
        expect(params[0].degradationPreference).toBe('maintain-resolution');
    });

    it('creates the encoding when the sender has none', async () => {
        const sender = makeSender({});
        await applyQualityToSender(sender, q(), {codec: 'vp8'});
        const params = sender.setParameters.mock.calls[0] as unknown as Array<Record<string, any>>;
        expect(params[0].encodings).toHaveLength(1);
    });

    it('uses the AV1 row for an AV1 sender', async () => {
        const sender = makeSender({encodings: [{}], codecs: []});
        const s = await applyQualityToSender(sender, q({resolution: '1080p', fps: 60}), {codec: 'av1'});
        expect(s?.bitrateMbps).toBe(5.6);
    });

    it('returns null instead of throwing when the browser refuses', async () => {
        const sender = makeSender({encodings: [{}]});
        sender.setParameters.mockRejectedValueOnce(new Error('nope'));
        expect(await applyQualityToSender(sender, q(), {codec: 'vp8'})).toBeNull();
    });
});

describe('content hint', () => {
    const track = (supportsText: boolean) => {
        let hint = '';
        return {
            get contentHint() {
                return hint;
            },
            set contentHint(v: string) {
                if (v !== 'text' || supportsText) {
                    hint = v;
                }
            },
        } as unknown as MediaStreamTrack;
    };

    it('uses motion for game', () => {
        const t = track(true);
        applyContentHint(t, 'game');
        expect(t.contentHint).toBe('motion');
    });

    it('uses text where supported and detail otherwise', () => {
        const a = track(true);
        applyContentHint(a, 'text');
        expect(a.contentHint).toBe('text');

        const b = track(false);
        applyContentHint(b, 'text');
        expect(b.contentHint).toBe('detail');
    });
});

describe('persistence', () => {
    afterEach(() => {
        window.localStorage.clear();
        jest.restoreAllMocks();
    });

    it('returns the defaults when nothing is stored, and Auto is the default', () => {
        expect(getShareQuality()).toEqual(defaultShareQuality);
        expect(getShareQuality().auto).toBe(true);
    });

    it('keeps an existing manual choice from before Auto existed as it is', () => {
        window.localStorage.setItem(STORAGE_CALLS_SHARE_QUALITY_KEY, JSON.stringify({resolution: '1440p', fps: 30, content: 'text', manualBitrateMbps: 12}));
        expect(getShareQuality()).toEqual({auto: false, resolution: '1440p', fps: 30, content: 'text', manualBitrateMbps: 12});
    });

    it('stores and restores an Auto choice, with the manual values kept for later', () => {
        setShareQuality({auto: true, resolution: '720p', fps: 15, content: 'text', manualBitrateMbps: null});
        expect(getShareQuality()).toEqual({auto: true, resolution: '720p', fps: 15, content: 'text', manualBitrateMbps: null});
    });

    it('treats an empty stored object like a new user', () => {
        window.localStorage.setItem(STORAGE_CALLS_SHARE_QUALITY_KEY, '{}');
        expect(getShareQuality().auto).toBe(true);
    });

    it('remembers the last choice', () => {
        setShareQuality({auto: false, resolution: '4k', fps: 30, content: 'text', manualBitrateMbps: 20});
        expect(getShareQuality()).toEqual({auto: false, resolution: '4k', fps: 30, content: 'text', manualBitrateMbps: 20});
    });

    it('survives garbage and partially valid values field by field', () => {
        window.localStorage.setItem(STORAGE_CALLS_SHARE_QUALITY_KEY, '{not json');
        expect(getShareQuality()).toEqual(defaultShareQuality);

        window.localStorage.setItem(STORAGE_CALLS_SHARE_QUALITY_KEY, JSON.stringify({resolution: '8k', fps: 45, content: 'text', manualBitrateMbps: 'x'}));

        // A stored choice without the Auto field is from before Auto existed: it stays manual.
        expect(getShareQuality()).toEqual({...defaultShareQuality, auto: false, content: 'text'});
    });

    it('clamps the manual bitrate', () => {
        expect(normalizeShareQuality({manualBitrateMbps: 500}).manualBitrateMbps).toBe(50);
        expect(normalizeShareQuality({manualBitrateMbps: 0.1}).manualBitrateMbps).toBe(1);
        expect(normalizeShareQuality({manualBitrateMbps: null}).manualBitrateMbps).toBeNull();
    });

    it('does not throw when localStorage is unavailable', () => {
        jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
            throw new Error('blocked');
        });
        jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new Error('blocked');
        });
        expect(getShareQuality()).toEqual(defaultShareQuality);
        expect(() => setShareQuality(defaultShareQuality)).not.toThrow();
    });
});

describe('label', () => {
    it('shows resolution, frame rate and bitrate', () => {
        expect(formatQualityLabel(q({resolution: '1440p', fps: 60}), 12)).toBe('1440p60 · 12 Mbps');
        expect(formatQualityLabel(q({resolution: '4k', fps: 30}), 22.5)).toBe('4K30 · 22.5 Mbps');
    });

    it('shows the real height for source', () => {
        expect(formatQualityLabel(q({resolution: 'source', fps: 60}), 8, {width: 1920, height: 1080})).toBe('1080p60 · 8 Mbps');
        expect(formatQualityLabel(q({resolution: 'source', fps: 60}), 8)).toBe('Source60 · 8 Mbps');
    });
});
