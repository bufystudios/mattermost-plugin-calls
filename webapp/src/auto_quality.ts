// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// "Auto" screen share quality: a ladder of (resolution, frame rate) levels and a pure
// state machine that walks it from WebRTC stats snapshots. No I/O in here: the poller
// (auto_quality_runner.ts) feeds snapshots in and the client applies the output, so the
// whole policy can be unit tested. See docs/bufy-auto-quality.md.
//
//   Game ladder (drops resolution first, keeps the frame rate as long as it can):
//     4K60 > 1440p60 > 1080p60 > 720p60 > 720p30 > 720p15     starts at 1440p60
//   Text ladder (drops frame rate first, keeps the resolution as long as it can):
//     4K30 > 4K15 > 1440p15 > 1080p15 > 720p15                 starts at the top
//   A rung above the source is clamped to the source size (never upscale), rungs that end up
//   identical are merged: a 1080p source plays Game as 1080p60 > 720p60 > 720p30 > 720p15.
//
//   Step down: 2 consecutive bad samples (4 s). Step up: 8 consecutive good samples (16 s),
//   and every step up that is undone within 30 s doubles the wait for the next one.

import {
    autoBitrateMbps,
    type CaptureSize,
    effectiveCaptureSize,
    type ShareContent,
    type ShareFps,
    type ShareResolution,
} from 'src/screen_share_quality';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

export const AUTO_TICK_MS = 2000;

// Consecutive bad samples before a step down.
export const AUTO_STEP_DOWN_TICKS = 2;

// Consecutive good samples before a step up (8 x 2 s = 16 s).
export const AUTO_STEP_UP_TICKS = 8;

// After a change the stats still describe the old level: ignore this many samples.
export const AUTO_SETTLE_TICKS = 2;

// The bandwidth estimate of a connection that just started to send video is far too low:
// it is not trusted (no cap, no bandwidth based decision) for this many samples.
export const AUTO_WARMUP_TICKS = 4;

// A step up that is undone within this many samples counts as a failed step up.
export const AUTO_FAILED_UP_TICKS = 15;

// Each failed step up multiplies the wait for the next one by 2, up to this many times the base.
export const AUTO_MAX_UP_PENALTY = 4;

// Stable for this many samples (120 s): the penalty is forgotten.
export const AUTO_PENALTY_RESET_TICKS = 60;

// The bitrate is capped at this fraction of availableOutgoingBitrate.
export const AUTO_BITRATE_CAP_FRACTION = 0.85;

// A step up needs availableOutgoingBitrate >= this factor x the bitrate of the level above.
export const AUTO_HEADROOM_FACTOR = 1.3;

// Bandwidth is "starved" when the capped bitrate is below this fraction of what the level wants.
export const AUTO_STARVED_FRACTION = 0.5;

// A jump after bandwidth trouble lands on the first level whose bitrate x this fits the cap.
export const AUTO_JUMP_FIT_FRACTION = 0.6;

// Remote fractionLost (0-1): >= BAD counts as bandwidth trouble, < GOOD is needed to step up.
export const AUTO_LOSS_BAD = 0.05;
export const AUTO_LOSS_GOOD = 0.01;

// Encode time per frame / frame budget (1 / target fps): >= BAD is cpu trouble, a step up is only
// taken when the predicted ratio at the higher level stays below UP_MAX.
export const AUTO_ENCODE_BAD = 0.85;
export const AUTO_ENCODE_UP_MAX = 0.6;

// Delivered fps below this fraction of the target counts as cpu trouble if the encoder is also busy
// (an idle screen delivers few frames without any problem).
export const AUTO_FPS_SHORTFALL = 0.7;
export const AUTO_FPS_SHORTFALL_ENCODE = 0.6;

// Frames needed in a sampling window to trust the encode time per frame.
const MIN_FRAMES_FOR_ENCODE_TIME = 5;

const MIN_CAP_MBPS = 0.5;

// ---------------------------------------------------------------------------
// Ladder
// ---------------------------------------------------------------------------

type LadderStep = {height: 2160 | 1440 | 1080 | 720; fps: ShareFps};

const gameLadder: readonly LadderStep[] = [
    {height: 2160, fps: 60},
    {height: 1440, fps: 60},
    {height: 1080, fps: 60},
    {height: 720, fps: 60},
    {height: 720, fps: 30},
    {height: 720, fps: 15},
];

const textLadder: readonly LadderStep[] = [
    {height: 2160, fps: 30},
    {height: 2160, fps: 15},
    {height: 1440, fps: 15},
    {height: 1080, fps: 15},
    {height: 720, fps: 15},
];

// Where Game starts (it may step up to the top later when there is plenty of headroom).
const GAME_START_HEIGHT = 1440;

const heightToResolution: Record<LadderStep['height'], ShareResolution> = {
    2160: '4k',
    1440: '1440p',
    1080: '1080p',
    720: '720p',
};

export type AutoRung = {

    // The preset the level asks for (the capture is never larger than the source).
    resolution: ShareResolution;
    fps: ShareFps;

    // Size the capture ends up at: the preset clamped to the source.
    size: CaptureSize;

    // Reference bitrate (VP8 table value) for this level.
    mbps: number;

    // Pixels per second, a rough cost of encoding this level.
    load: number;
};

// The rungs of the ladder for a content type and source size, best first, without rungs
// that would be identical after clamping to the source.
export function buildLadder(content: ShareContent, source: CaptureSize): AutoRung[] {
    const steps = content === 'game' ? gameLadder : textLadder;
    const rungs: AutoRung[] = [];
    const seen = new Set<string>();
    for (const step of steps) {
        const resolution = heightToResolution[step.height];
        const size = effectiveCaptureSize({auto: false, resolution, fps: step.fps, content, manualBitrateMbps: null}, source);
        const key = `${size.width}x${size.height}@${step.fps}`;
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        rungs.push({
            resolution,
            fps: step.fps,
            size,
            mbps: autoBitrateMbps(size.width * size.height, step.fps, 'vp8'),
            load: size.width * size.height * step.fps,
        });
    }
    return rungs;
}

// Index of the level Auto starts at: Game at up to 1440p60 (or the source if smaller), Text at the top
// (the source size at 30 fps).
export function startIndex(content: ShareContent, ladder: AutoRung[]): number {
    if (content === 'text') {
        return 0;
    }
    const i = ladder.findIndex((r) => r.size.height <= GAME_START_HEIGHT);
    return i < 0 ? 0 : i;
}

// ---------------------------------------------------------------------------
// Stats snapshot
// ---------------------------------------------------------------------------

export type LimitationReason = 'none' | 'cpu' | 'bandwidth' | 'other';

// What one poll of the screen sender(s) produces. Fields are null where the browser does not report them.
export type AutoSnapshot = {

    // Timestamp in ms (only used to order snapshots).
    at: number;
    reason: LimitationReason | null;
    framesPerSecond: number | null;
    frameWidth: number | null;
    frameHeight: number | null;

    // Cumulative counters. With several senders (SFU: VP8 + AV1) framesEncoded is the largest
    // one (= source frames) and totalEncodeTime (seconds) the sum, so the ratio is the whole
    // encoding cost per source frame.
    framesEncoded: number | null;
    totalEncodeTime: number | null;

    // Bits per second, from the selected candidate pair.
    availableOutgoingBitrate: number | null;

    // 0-1, from the receiver report, and the round trip time in ms.
    fractionLost: number | null;
    rttMs: number | null;
};

type StatEntry = Record<string, unknown>;

const reasonSeverity: Record<LimitationReason, number> = {none: 0, other: 1, bandwidth: 2, cpu: 3};

function num(v: unknown): number | null {
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function maxOf(a: number | null, b: number | null): number | null {
    if (a === null) {
        return b;
    }
    if (b === null) {
        return a;
    }
    return Math.max(a, b);
}

// Builds a snapshot from the entries of RTCRtpSender.getStats() reports of the screen sender(s).
// Returns null if no outbound video stream is among them.
export function extractSnapshot(entries: StatEntry[], at: number): AutoSnapshot | null {
    const byID = new Map<string, StatEntry>();
    for (const e of entries) {
        if (typeof e.id === 'string') {
            byID.set(e.id, e);
        }
    }

    const outbound = entries.filter((e) => e.type === 'outbound-rtp' && (e.kind === 'video' || e.mediaType === 'video'));
    if (outbound.length === 0) {
        return null;
    }

    const snap: AutoSnapshot = {
        at,
        reason: null,
        framesPerSecond: null,
        frameWidth: null,
        frameHeight: null,
        framesEncoded: null,
        totalEncodeTime: null,
        availableOutgoingBitrate: null,
        fractionLost: null,
        rttMs: null,
    };

    for (const o of outbound) {
        const r = o.qualityLimitationReason;
        if (r === 'none' || r === 'cpu' || r === 'bandwidth' || r === 'other') {
            if (snap.reason === null || reasonSeverity[r] > reasonSeverity[snap.reason]) {
                snap.reason = r;
            }
        }
        snap.framesPerSecond = maxOf(snap.framesPerSecond, num(o.framesPerSecond));
        snap.frameWidth = maxOf(snap.frameWidth, num(o.frameWidth));
        snap.frameHeight = maxOf(snap.frameHeight, num(o.frameHeight));
        snap.framesEncoded = maxOf(snap.framesEncoded, num(o.framesEncoded));
        const enc = num(o.totalEncodeTime);
        if (enc !== null) {
            snap.totalEncodeTime = (snap.totalEncodeTime ?? 0) + enc;
        }

        const remote = typeof o.remoteId === 'string' ? byID.get(o.remoteId) : undefined;
        if (remote) {
            snap.fractionLost = maxOf(snap.fractionLost, num(remote.fractionLost));
            const rtt = num(remote.roundTripTime);
            snap.rttMs = maxOf(snap.rttMs, rtt === null ? null : rtt * 1000);
        }
    }

    // Selected candidate pair: the transport names it, else the nominated pair that works.
    let pair: StatEntry | undefined;
    for (const e of entries) {
        if (e.type === 'transport' && typeof e.selectedCandidatePairId === 'string') {
            pair = byID.get(e.selectedCandidatePairId);
            if (pair) {
                break;
            }
        }
    }
    if (!pair) {
        pair = entries.find((e) => e.type === 'candidate-pair' && (e.selected === true || (e.nominated === true && e.state === 'succeeded')));
    }
    if (pair) {
        snap.availableOutgoingBitrate = num(pair.availableOutgoingBitrate);
        if (snap.rttMs === null) {
            const rtt = num(pair.currentRoundTripTime);
            snap.rttMs = rtt === null ? null : rtt * 1000;
        }
    }

    return snap;
}

// ---------------------------------------------------------------------------
// State machine
// ---------------------------------------------------------------------------

export type AutoLimit = 'cpu' | 'bandwidth';

export type AutoState = {
    content: ShareContent;
    source: CaptureSize;
    ladder: AutoRung[];

    // Current rung (0 = best).
    index: number;

    // Samples seen (snapshots that were fed in).
    ticks: number;
    badStreak: number;
    goodStreak: number;

    // Samples still to ignore after the last change.
    settle: number;

    // Good samples needed for the next step up (grows when a step up is undone quickly).
    upNeeded: number;
    lastUpTick: number | null;
    lastChangeTick: number;
    prev: AutoSnapshot | null;

    // Why the current level is limited (last sample) and the bitrate cap in Mbps (null = none).
    limited: AutoLimit | null;
    capMbps: number | null;
};

export function createAutoState(content: ShareContent, source: CaptureSize): AutoState {
    const ladder = buildLadder(content, source);
    return {
        content,
        source,
        ladder,
        index: startIndex(content, ladder),
        ticks: 0,
        badStreak: 0,
        goodStreak: 0,
        settle: 0,
        upNeeded: AUTO_STEP_UP_TICKS,
        lastUpTick: null,
        lastChangeTick: 0,
        prev: null,
        limited: null,
        capMbps: null,
    };
}

export function currentRung(state: AutoState): AutoRung {
    return state.ladder[state.index];
}

// What the client applies: the level, the cap and why it is limited.
export type AutoOutput = {
    rung: AutoRung;
    index: number;
    capMbps: number | null;
    limited: AutoLimit | null;
};

export function autoOutput(state: AutoState): AutoOutput {
    return {rung: currentRung(state), index: state.index, capMbps: state.capMbps, limited: state.limited};
}

type Metrics = {

    // Encode time per frame / frame budget at the target fps, null when unknown.
    encodeRatio: number | null;
    fps: number | null;
};

function computeMetrics(prev: AutoSnapshot | null, snap: AutoSnapshot, rung: AutoRung): Metrics {
    let encodeRatio: number | null = null;
    if (prev && snap.framesEncoded !== null && prev.framesEncoded !== null && snap.totalEncodeTime !== null && prev.totalEncodeTime !== null) {
        const frames = snap.framesEncoded - prev.framesEncoded;
        const seconds = snap.totalEncodeTime - prev.totalEncodeTime;
        if (frames >= MIN_FRAMES_FOR_ENCODE_TIME && seconds >= 0) {
            encodeRatio = (seconds / frames) / (1 / rung.fps);
        }
    }
    return {encodeRatio, fps: snap.framesPerSecond};
}

// The bitrate cap in Mbps for an availableOutgoingBitrate (bps), null when unknown or not trusted yet.
function capFor(available: number | null, warm: boolean): number | null {
    if (!warm || available === null || available <= 0) {
        return null;
    }
    return Math.max(MIN_CAP_MBPS, Math.round(((available * AUTO_BITRATE_CAP_FRACTION) / 1_000_000) * 10) / 10);
}

// First rung below `from` that fits the cap, the last rung if none does.
function jumpTarget(ladder: AutoRung[], from: number, capMbps: number): number {
    for (let i = from + 1; i < ladder.length; i++) {
        if (ladder[i].mbps * AUTO_JUMP_FIT_FRACTION <= capMbps) {
            return i;
        }
    }
    return ladder.length - 1;
}

// Feeds one snapshot into the state machine and returns the next state (the input is not modified).
export function autoStep(state: AutoState, snap: AutoSnapshot): AutoState {
    const next: AutoState = {...state, ticks: state.ticks + 1, prev: snap};
    const rung = currentRung(state);

    // A restart of the counters (new sender after a switch between SFU and P2P) makes the deltas meaningless.
    const counterReset = state.prev !== null && snap.framesEncoded !== null && state.prev.framesEncoded !== null && snap.framesEncoded < state.prev.framesEncoded;
    const metrics = counterReset ? {encodeRatio: null, fps: snap.framesPerSecond} : computeMetrics(state.prev, snap, rung);

    const warm = next.ticks > AUTO_WARMUP_TICKS;
    const cap = capFor(snap.availableOutgoingBitrate, warm);
    next.capMbps = cap;

    const reasonCpu = snap.reason === 'cpu';
    const reasonBandwidth = snap.reason === 'bandwidth';
    const cpuBad = reasonCpu ||
        (metrics.encodeRatio !== null && metrics.encodeRatio >= AUTO_ENCODE_BAD) ||
        (metrics.encodeRatio !== null && metrics.fps !== null && metrics.fps < rung.fps * AUTO_FPS_SHORTFALL && metrics.encodeRatio >= AUTO_FPS_SHORTFALL_ENCODE);
    const lossBad = snap.fractionLost !== null && snap.fractionLost >= AUTO_LOSS_BAD;
    const starved = cap !== null && cap < rung.mbps * AUTO_STARVED_FRACTION;
    const bandwidthBad = reasonBandwidth || lossBad || starved;
    const bad = cpuBad || bandwidthBad;

    // "limited" is what the sharer sees: the encoder says so, or our cap is tighter than what the level wants.
    if (cpuBad) {
        next.limited = 'cpu';
    } else if (bandwidthBad || (cap !== null && cap < rung.mbps)) {
        next.limited = 'bandwidth';
    } else {
        next.limited = null;
    }

    // The stats still describe the old level for a moment after a change.
    if (state.settle > 0) {
        next.settle = state.settle - 1;
        return next;
    }

    if (bad) {
        next.badStreak = state.badStreak + 1;
        next.goodStreak = 0;
    } else {
        next.badStreak = 0;
        next.goodStreak = isGood(state, snap, metrics, cap) ? state.goodStreak + 1 : 0;
    }

    const last = state.ladder.length - 1;
    if (next.badStreak >= AUTO_STEP_DOWN_TICKS && state.index < last) {
        // Bandwidth trouble with a trusted estimate can jump several levels at once, anything else is one step.
        let target = state.index + 1;
        if (!cpuBad && cap !== null) {
            target = Math.max(target, jumpTarget(state.ladder, state.index, cap));
        }
        const undoesUp = state.lastUpTick !== null && next.ticks - state.lastUpTick <= AUTO_FAILED_UP_TICKS;
        next.upNeeded = undoesUp ? Math.min(state.upNeeded * 2, AUTO_STEP_UP_TICKS * AUTO_MAX_UP_PENALTY) : state.upNeeded;
        return changed(next, target);
    }
    if (next.goodStreak >= state.upNeeded && state.index > 0) {
        next.lastUpTick = next.ticks;
        return changed(next, state.index - 1);
    }

    if (next.ticks - next.lastChangeTick >= AUTO_PENALTY_RESET_TICKS) {
        next.upNeeded = AUTO_STEP_UP_TICKS;
    }
    return next;
}

// Good = nothing limits us and the level above would fit in bandwidth and encoder time. Unknown
// numbers (idle screen: too few frames to time the encoder, browser without stats) do not block.
function isGood(state: AutoState, snap: AutoSnapshot, metrics: Metrics, cap: number | null): boolean {
    if (state.index === 0) {
        return false;
    }

    // Nothing to judge by (browser reports none of it): never climb blindly.
    if (snap.reason === null && snap.availableOutgoingBitrate === null && metrics.encodeRatio === null) {
        return false;
    }
    if (snap.reason === 'cpu' || snap.reason === 'bandwidth') {
        return false;
    }
    if (snap.fractionLost !== null && snap.fractionLost >= AUTO_LOSS_GOOD) {
        return false;
    }
    const above = state.ladder[state.index - 1];
    const rung = state.ladder[state.index];
    if (cap !== null && snap.availableOutgoingBitrate !== null && snap.availableOutgoingBitrate / 1_000_000 < above.mbps * AUTO_HEADROOM_FACTOR) {
        return false;
    }
    if (metrics.encodeRatio !== null && metrics.encodeRatio * (above.load / rung.load) >= AUTO_ENCODE_UP_MAX) {
        return false;
    }
    return true;
}

function changed(next: AutoState, index: number): AutoState {
    return {
        ...next,
        index,
        badStreak: 0,
        goodStreak: 0,
        settle: AUTO_SETTLE_TICKS,
        lastChangeTick: next.ticks,

        // Counters and the previous snapshot stay valid: only the level changed.
    };
}

// True when two outputs ask for a different level or a clearly different cap.
export function outputDiffers(a: AutoOutput | null, b: AutoOutput): 'level' | 'cap' | null {
    if (!a || a.index !== b.index || a.rung.fps !== b.rung.fps || a.rung.size.height !== b.rung.size.height) {
        return 'level';
    }
    const ca = a.capMbps;
    const cb = b.capMbps;
    if (ca === cb) {
        return null;
    }
    if (ca === null || cb === null) {
        return 'cap';
    }
    return Math.abs(ca - cb) / Math.max(ca, cb) >= 0.15 ? 'cap' : null;
}
