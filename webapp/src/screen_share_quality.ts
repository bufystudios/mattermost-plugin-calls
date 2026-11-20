// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// Screen share quality (resolution, frame rate, content type, bitrate).
//
// Everything that turns a user choice into capture constraints, encoder
// parameters and a bitrate lives here so the SFU path, the P2P path and the
// live "change quality during a share" path all agree. See
// docs/bufy-share-quality.md.

import {STORAGE_CALLS_SHARE_QUALITY_KEY} from 'src/constants';
import {logWarn} from 'src/log';

export type ShareResolution = '720p' | '1080p' | '1440p' | '4k' | 'source';
export type ShareFps = 15 | 30 | 60;
export type ShareContent = 'game' | 'text';
export type ShareCodec = 'vp8' | 'av1' | 'h264';

export type ScreenShareQuality = {

    // Automatic mode (the default): resolution, frame rate and bitrate are picked from the source
    // size and the content type and then adapted to the connection and the computer while sharing
    // (see auto_quality.ts). `resolution`, `fps` and `manualBitrateMbps` are the manual values and
    // are ignored while `auto` is on, they are kept so switching back to manual restores them.
    auto: boolean;
    resolution: ShareResolution;
    fps: ShareFps;
    content: ShareContent;

    // Manual bitrate in Mbps, null = automatic (see autoBitrateMbps).
    manualBitrateMbps: number | null;
};

export const shareResolutions: ShareResolution[] = ['720p', '1080p', '1440p', '4k', 'source'];
export const shareFpsOptions: ShareFps[] = [15, 30, 60];
export const shareContents: ShareContent[] = ['game', 'text'];

export const MANUAL_BITRATE_MIN_MBPS = 1;
export const MANUAL_BITRATE_MAX_MBPS = 50;
export const MANUAL_BITRATE_STEP_MBPS = 0.5;

export const defaultShareQuality: ScreenShareQuality = {
    auto: true,
    resolution: '1080p',
    fps: 60,
    content: 'game',
    manualBitrateMbps: null,
};

// Heights of the fixed presets (16:9 widths are derived from them).
const presetHeights = {
    '720p': 720,
    '1080p': 1080,
    '1440p': 1440,
    '4k': 2160,
} as const;

type SizedResolution = keyof typeof presetHeights;

// Largest capture size we ever ask for. Used where "no limit" has to be spelled out.
const MAX_CAPTURE_WIDTH = 7680;
const MAX_CAPTURE_HEIGHT = 4320;

// A preset limits the height; the width limit is wide enough for 32:9 monitors so
// ultrawide screens are not cropped down to a 16:9 box.
const WIDTH_PER_HEIGHT_LIMIT = 32 / 9;

function isSized(resolution: ShareResolution): resolution is SizedResolution {
    return resolution !== 'source';
}

export function presetHeight(resolution: SizedResolution): number {
    return presetHeights[resolution];
}

export function presetWidth(resolution: SizedResolution): number {
    return Math.round((presetHeights[resolution] * 16) / 9);
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

function isOneOf<T>(list: readonly T[], value: unknown): value is T {
    return list.includes(value as T);
}

// Returns a sanitized copy of whatever was stored (or passed), falling back to the defaults field by field.
// Migration: a stored choice from before "Auto" existed has no `auto` field and stays manual. Only a
// missing / empty value (new user) gets the default, which is Auto.
export function normalizeShareQuality(value: unknown): ScreenShareQuality {
    const v = (value && typeof value === 'object' ? value : {}) as Partial<Record<keyof ScreenShareQuality, unknown>>;
    let auto = defaultShareQuality.auto;
    if (typeof v.auto === 'boolean') {
        auto = v.auto;
    } else if (Object.keys(v).length > 0) {
        auto = false;
    }
    let manual: number | null = null;
    if (typeof v.manualBitrateMbps === 'number' && Number.isFinite(v.manualBitrateMbps)) {
        manual = Math.min(MANUAL_BITRATE_MAX_MBPS, Math.max(MANUAL_BITRATE_MIN_MBPS, v.manualBitrateMbps));
    }
    return {
        auto,
        resolution: isOneOf(shareResolutions, v.resolution) ? v.resolution : defaultShareQuality.resolution,
        fps: isOneOf(shareFpsOptions, v.fps) ? v.fps : defaultShareQuality.fps,
        content: isOneOf(shareContents, v.content) ? v.content : defaultShareQuality.content,
        manualBitrateMbps: manual,
    };
}

// The last chosen quality. localStorage is shared by all windows of the origin
// (main window, desktop widget window, pop out), so a choice made in one is
// visible in the others.
export function getShareQuality(): ScreenShareQuality {
    try {
        const data = window.localStorage.getItem(STORAGE_CALLS_SHARE_QUALITY_KEY);
        if (data) {
            return normalizeShareQuality(JSON.parse(data));
        }
    } catch {
        // Storage unavailable or malformed value: use the defaults.
    }
    return {...defaultShareQuality};
}

export function setShareQuality(quality: ScreenShareQuality) {
    try {
        window.localStorage.setItem(STORAGE_CALLS_SHARE_QUALITY_KEY, JSON.stringify(normalizeShareQuality(quality)));
    } catch {
        // Storage can be unavailable (private mode, blocked site data): the choice just won't be remembered.
    }
}

export function sameShareQuality(a: ScreenShareQuality, b: ScreenShareQuality): boolean {
    return a.auto === b.auto && a.resolution === b.resolution && a.fps === b.fps && a.content === b.content && a.manualBitrateMbps === b.manualBitrateMbps;
}

// ---------------------------------------------------------------------------
// Capture constraints
// ---------------------------------------------------------------------------

// Frame rate Auto captures at before it knows better: the top of the content's ladder.
export function autoCaptureFps(content: ShareContent): ShareFps {
    return content === 'game' ? 60 : 30;
}

// Auto captures at the source size (it can only know that size once the capture exists) and
// at the top frame rate of its ladder, then lowers both live. Everything that turns a
// quality into capture constraints goes through this, manual qualities pass unchanged.
export function captureQuality(q: ScreenShareQuality): ScreenShareQuality {
    if (!q.auto) {
        return q;
    }
    return {...q, auto: false, resolution: 'source', fps: autoCaptureFps(q.content), manualBitrateMbps: null};
}

// Constraints for getDisplayMedia. Only upper bounds (`max`) and `ideal` values
// are used, never `min`, and an ideal above what the source can deliver does not
// upscale: the browser captures at the source size. `source` sets no size.
export function buildDisplayMediaConstraints(quality: ScreenShareQuality): MediaTrackConstraints {
    const q = captureQuality(quality);
    const constraints: MediaTrackConstraints = {
        frameRate: {ideal: q.fps, max: q.fps},
    };
    if (isSized(q.resolution)) {
        const height = presetHeights[q.resolution];
        constraints.height = {ideal: height, max: height};
        constraints.width = {max: Math.round(height * WIDTH_PER_HEIGHT_LIMIT)};
    }
    return constraints;
}

// Constraints for track.applyConstraints() during a live share. Unlike the
// getDisplayMedia case, `source` has to name its (very large) ideal size
// explicitly: constraints from the previous quality are replaced, and omitting the
// size would let the browser fall back to its default size instead of the native one.
export function buildLiveConstraints(quality: ScreenShareQuality): MediaTrackConstraints {
    const q = captureQuality(quality);
    if (isSized(q.resolution)) {
        return buildDisplayMediaConstraints(q);
    }
    return {
        frameRate: {ideal: q.fps, max: q.fps},
        height: {ideal: MAX_CAPTURE_HEIGHT},
        width: {ideal: MAX_CAPTURE_WIDTH},
    };
}

// Legacy Chromium "mandatory" keys used by Electron's desktop capture. For
// `source` the size is not left out but set to a very large maximum: a maximum is
// only an upper bound (it never upscales), and it avoids relying on the default
// capture size of Electron's desktop capturer.
export function buildElectronMandatory(quality: ScreenShareQuality, sourceID?: string): Record<string, unknown> {
    const q = captureQuality(quality);
    const mandatory: Record<string, unknown> = {
        chromeMediaSource: 'desktop',
        maxFrameRate: q.fps,

        // A hint only, desktop capture does not fail when the display refreshes slower.
        minFrameRate: Math.floor(q.fps / 2),
    };
    if (sourceID) {
        mandatory.chromeMediaSourceId = sourceID;
    }
    if (isSized(q.resolution)) {
        const height = presetHeights[q.resolution];
        mandatory.maxHeight = height;
        mandatory.maxWidth = Math.round(height * WIDTH_PER_HEIGHT_LIMIT);
    } else {
        mandatory.maxHeight = MAX_CAPTURE_HEIGHT;
        mandatory.maxWidth = MAX_CAPTURE_WIDTH;
    }
    return mandatory;
}

export type CaptureSize = {width: number; height: number};

// The size we expect to capture: the source size, shrunk (keeping the aspect
// ratio) to fit the preset, never enlarged.
export function effectiveCaptureSize(quality: ScreenShareQuality, source: CaptureSize): CaptureSize {
    const q = captureQuality(quality);
    if (!isSized(q.resolution) || source.width <= 0 || source.height <= 0) {
        return {...source};
    }
    const maxHeight = presetHeights[q.resolution];
    const maxWidth = Math.round(maxHeight * WIDTH_PER_HEIGHT_LIMIT);
    const scale = Math.min(1, maxHeight / source.height, maxWidth / source.width);
    return {
        width: Math.round(source.width * scale),
        height: Math.round(source.height * scale),
    };
}

// ---------------------------------------------------------------------------
// Bitrate
// ---------------------------------------------------------------------------

// Automatic bitrate in Mbps for VP8 by capture size (rows) and frame rate (columns).
// This is the one table to tune. Other codecs scale it with codecFactor. Sizes
// between the rows are interpolated by pixel count (see autoBitrateMbps).
export const autoBitrateTableVP8: ReadonlyArray<{height: SizedResolution; mbps: Record<ShareFps, number>}> = [
    {height: '720p', mbps: {15: 1.5, 30: 2.5, 60: 4}},
    {height: '1080p', mbps: {15: 2.5, 30: 4, 60: 8}},
    {height: '1440p', mbps: {15: 4, 30: 6.5, 60: 12}},
    {height: '4k', mbps: {15: 8, 30: 15, 60: 25}},
];

// AV1 is the most efficient. Hardware H.264 gets less out of a bit than libvpx VP8,
// so it is only 10 % lower.
export const codecFactor: Record<ShareCodec, number> = {
    vp8: 1,
    h264: 0.9,
    av1: 0.7,
};

const MIN_AUTO_MBPS = 0.5;

function roundMbps(mbps: number): number {
    return Math.round(mbps * 10) / 10;
}

// Automatic bitrate for a capture of `pixels` pixels. Below the first row it
// scales down linearly with the pixel count, above the last row it stays at the last
// row's value, in between it interpolates linearly by pixel count.
export function autoBitrateMbps(pixels: number, fps: ShareFps, codec: ShareCodec): number {
    const rows = autoBitrateTableVP8.map((r) => ({px: presetWidth(r.height) * presetHeights[r.height], mbps: r.mbps[fps]}));

    let mbps: number;
    if (pixels <= rows[0].px) {
        mbps = rows[0].mbps * (pixels / rows[0].px);
    } else if (pixels >= rows[rows.length - 1].px) {
        mbps = rows[rows.length - 1].mbps;
    } else {
        const hi = rows.findIndex((r) => r.px >= pixels);
        const lo = rows[hi - 1];
        mbps = lo.mbps + (((rows[hi].mbps - lo.mbps) * (pixels - lo.px)) / (rows[hi].px - lo.px));
    }

    return roundMbps(Math.max(MIN_AUTO_MBPS, mbps * codecFactor[codec]));
}

// The pixel count the bitrate is chosen for: the real capture size when known (it
// already includes "never upscale"), otherwise what the preset asks for.
export function bitratePixels(quality: ScreenShareQuality, captured?: Partial<CaptureSize> | null): number {
    const q = captureQuality(quality);
    if (captured?.width && captured?.height) {
        return captured.width * captured.height;
    }
    const resolution: SizedResolution = isSized(q.resolution) ? q.resolution : '1080p';
    return presetWidth(resolution) * presetHeights[resolution];
}

// Bitrate in Mbps used for the encoder: the manual value, or the automatic one.
export function resolveBitrateMbps(quality: ScreenShareQuality, codec: ShareCodec, captured?: Partial<CaptureSize> | null): number {
    const q = captureQuality(quality);
    if (q.manualBitrateMbps !== null) {
        return q.manualBitrateMbps;
    }
    return autoBitrateMbps(bitratePixels(q, captured), q.fps, codec);
}

// ---------------------------------------------------------------------------
// Sender parameters
// ---------------------------------------------------------------------------

export type ScreenSenderSettings = {
    maxBitrate: number;
    maxFramerate: number;

    // 1 unless Auto has to shrink a capture that refused to shrink (see ScreenSenderExtra.scaleDown):
    // normally the capture constraints already did the sizing and the encoder never scales.
    scaleResolutionDownBy: number;
    degradationPreference: RTCDegradationPreference;
    bitrateMbps: number;
};

export function degradationPreferenceFor(content: ShareContent): RTCDegradationPreference {
    return content === 'text' ? 'maintain-resolution' : 'maintain-framerate';
}

// Runtime extras of Auto quality (the quality itself only holds what the user chose).
export type ScreenSenderExtra = {

    // Upper bound for the bitrate in Mbps (a fraction of the available outgoing bitrate), null/absent = none.
    bitrateCapMbps?: number | null;

    // Encoder side downscale factor for a capture that is larger than the level asks for
    // (a capture track that refused new constraints). 1/absent = none.
    scaleDown?: number;
};

export function screenSenderSettings(
    quality: ScreenShareQuality,
    codec: ShareCodec,
    captured?: Partial<CaptureSize> | null,
    extra?: ScreenSenderExtra | null,
): ScreenSenderSettings {
    const q = captureQuality(quality);
    const scale = Math.max(1, extra?.scaleDown ?? 1);
    const scaledCapture = captured?.width && captured?.height && scale > 1 ? {width: Math.round(captured.width / scale), height: Math.round(captured.height / scale)} : captured;
    let bitrateMbps = resolveBitrateMbps(q, codec, scaledCapture);
    if (extra?.bitrateCapMbps && q.manualBitrateMbps === null) {
        bitrateMbps = roundMbps(Math.max(MIN_AUTO_MBPS, Math.min(bitrateMbps, extra.bitrateCapMbps)));
    }
    return {
        maxBitrate: Math.round(bitrateMbps * 1_000_000),
        maxFramerate: q.fps,
        scaleResolutionDownBy: scale,
        degradationPreference: degradationPreferenceFor(q.content),
        bitrateMbps,
    };
}

// The encoding part (what goes into sendEncodings / encodings[0]).
export function screenEncoding(settings: ScreenSenderSettings): {maxBitrate: number; maxFramerate: number; scaleResolutionDownBy: number} {
    return {
        maxBitrate: settings.maxBitrate,
        maxFramerate: settings.maxFramerate,
        scaleResolutionDownBy: settings.scaleResolutionDownBy,
    };
}

export function codecFromMimeType(mimeType?: string): ShareCodec | null {
    switch ((mimeType || '').toLowerCase()) {
    case 'video/vp8':
        return 'vp8';
    case 'video/av1':
        return 'av1';
    case 'video/h264':
        return 'h264';
    default:
        return null;
    }
}

// Ranks H.264 variants: a higher profile and level is better for big pictures.
// profile-level-id is 3 bytes: profile_idc, constraint flags, level_idc.
function h264Score(codec: {sdpFmtpLine?: string}): number {
    const fmtp = codec.sdpFmtpLine || '';
    const m = (/profile-level-id=([0-9a-fA-F]{6})/).exec(fmtp);
    const profileRank = (id: number) => {
        switch (id) {
        case 0x64: return 3; // High
        case 0x4d: return 2; // Main
        case 0x42: return 1; // Baseline / Constrained Baseline
        default: return 0;
        }
    };
    let score = fmtp.includes('packetization-mode=1') ? 1000 : 0;
    if (m) {
        score += (profileRank(parseInt(m[1].slice(0, 2), 16)) * 100) + (parseInt(m[1].slice(4, 6), 16) / 100);
    }
    return score;
}

export type CodecChoiceInput = {
    quality: ScreenShareQuality;

    // The size being captured (for Source and small sources the real size decides).
    captured?: Partial<CaptureSize> | null;

    // Codecs negotiated with the peer (RTCRtpSendParameters.codecs): both sides support them.
    negotiated: Array<{mimeType: string; sdpFmtpLine?: string}>;
    enableAV1: boolean;
};

// Codec for the P2P screen sender: H.264 for 1440p and above if both sides
// support it (hardware encoders are likelier), else AV1 if enabled and supported,
// else VP8. Returns null when none of them is negotiated (keep whatever the
// negotiation picked).
export function pickP2PScreenCodec(input: CodecChoiceInput): {mimeType: string; sdpFmtpLine?: string} | null {
    const {quality, captured, negotiated, enableAV1} = input;
    const byCodec = (codec: ShareCodec) => negotiated.filter((c) => codecFromMimeType(c.mimeType) === codec);

    const pixels = bitratePixels(quality, captured);
    const height = captured?.height || (isSized(quality.resolution) ? presetHeights[quality.resolution] : 0);
    const pixels1440 = presetWidth('1440p') * presetHeights['1440p'];

    // 1440p and above. A 16:10 capture limited to 1440p is 2304x1440, so height counts too.
    const wantH264 = height >= presetHeights['1440p'] * 0.95 || pixels >= pixels1440 * 0.9;
    if (wantH264) {
        const h264 = byCodec('h264').sort((a, b) => h264Score(b) - h264Score(a));
        if (h264.length > 0) {
            return h264[0];
        }
    }
    if (enableAV1) {
        const av1 = byCodec('av1');
        if (av1.length > 0) {
            return av1[0];
        }
    }
    return byCodec('vp8')[0] ?? null;
}

// Applies the quality to one video sender (SFU or P2P): encoding limits and
// degradation preference. `codec` selects the bitrate row; when a codec choice is
// given the encoder is switched to it (RTCRtpEncodingParameters.codec, Chromium 133+;
// without support the negotiated default codec simply stays). Returns the settings
// that were applied.
export async function applyQualityToSender(
    sender: RTCRtpSender,
    q: ScreenShareQuality,
    opts: {
        codec: ShareCodec;
        captured?: Partial<CaptureSize> | null;
        extra?: ScreenSenderExtra | null;
        chooseCodec?: (negotiated: RTCRtpCodecParameters[]) => RTCRtpCodecParameters | null;
    },
): Promise<ScreenSenderSettings | null> {
    try {
        const params = sender.getParameters();
        if (!params.encodings || params.encodings.length === 0) {
            params.encodings = [{}];
        }

        let codec = opts.codec;
        const encoding = params.encodings[0] as RTCRtpEncodingParameters & {codec?: unknown};
        if (opts.chooseCodec && params.codecs && params.codecs.length > 0) {
            const chosen = opts.chooseCodec(params.codecs);
            const chosenCodec = chosen ? codecFromMimeType(chosen.mimeType) : null;
            if (chosen && chosenCodec) {
                codec = chosenCodec;
                const first = params.codecs[0];
                if (chosen === first || (chosen.mimeType === first.mimeType && chosen.sdpFmtpLine === first.sdpFmtpLine)) {
                    // The default of the negotiation: no override needed (and clears an older one).
                    delete encoding.codec;
                } else {
                    encoding.codec = chosen;
                }
            }
        }

        const settings = screenSenderSettings(q, codec, opts.captured, opts.extra);
        Object.assign(encoding, screenEncoding(settings));
        params.degradationPreference = settings.degradationPreference;
        await sender.setParameters(params);
        return settings;
    } catch (err) {
        logWarn('failed to apply screen quality to sender', err);
        return null;
    }
}

// ---------------------------------------------------------------------------
// Track helpers
// ---------------------------------------------------------------------------

// 'detail' is understood everywhere contentHint is; 'text' (sharper for text
// shared at lower rates) only by newer Chromium, so it is tried first and checked.
export function applyContentHint(track: MediaStreamTrack, content: ShareContent) {
    if (content === 'game') {
        track.contentHint = 'motion';
        return;
    }
    track.contentHint = 'text';
    if (track.contentHint !== 'text') {
        track.contentHint = 'detail';
    }
}

// Short label, e.g. "1440p60 · 12 Mbps". `captured` is the real capture size, used for Source.
export function formatQualityLabel(q: ScreenShareQuality, bitrateMbps: number, captured?: Partial<CaptureSize> | null): string {
    let res: string;
    if (q.resolution === 'source') {
        res = captured?.height ? `${captured.height}p` : 'Source';
    } else {
        res = q.resolution === '4k' ? '4K' : q.resolution;
    }
    const mbps = Number.isInteger(bitrateMbps) ? String(bitrateMbps) : bitrateMbps.toFixed(1);
    return `${res}${q.fps} · ${mbps} Mbps`;
}

// Label of the level Auto is at, e.g. "1080p60 · 7.5 Mbps". The picture is never larger than the source,
// so the real capture size is preferred over what the level asks for (1080p source on a 4K level = 1080p).
export function formatAutoLabel(level: {resolution: ShareResolution; fps: ShareFps}, bitrateMbps: number, captured?: Partial<CaptureSize> | null): string {
    let res: string;
    if (captured?.height) {
        res = captured.height >= 2100 ? '4K' : `${captured.height}p`;
    } else {
        res = level.resolution === '4k' ? '4K' : level.resolution;
    }
    const mbps = Number.isInteger(bitrateMbps) ? String(bitrateMbps) : bitrateMbps.toFixed(1);
    return `${res}${level.fps} · ${mbps} Mbps`;
}
