// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {
    AUTO_BITRATE_CAP_FRACTION,
    AUTO_FAILED_UP_TICKS,
    AUTO_SETTLE_TICKS,
    AUTO_STEP_DOWN_TICKS,
    AUTO_STEP_UP_TICKS,
    AUTO_WARMUP_TICKS,
    autoOutput,
    type AutoSnapshot,
    type AutoState,
    autoStep,
    buildLadder,
    createAutoState,
    currentRung,
    extractSnapshot,
    outputDiffers,
} from './auto_quality';

const k4 = {width: 3840, height: 2160};
const k1440 = {width: 2560, height: 1440};
const k1080 = {width: 1920, height: 1080};

const names = (state: AutoState) => state.ladder.map((r) => `${r.size.height}p${r.fps}`);
const level = (state: AutoState) => {
    const r = currentRung(state);
    return `${r.size.height}p${r.fps}`;
};

// Feeds snapshots with running counters, like successive polls of a real sender.
class Feeder {
    frames = 1000;
    encSeconds = 10;
    at = 0;
    state: AutoState;

    constructor(state: AutoState) {
        this.state = state;
    }

    // One 2 s sample. `enc` is the encode time per frame in ms (null: no encoder data), `over` overrides snapshot fields.
    tick(over: Partial<AutoSnapshot> & {enc?: number | null; fps?: number} = {}) {
        const {enc = 2, fps = 60, ...rest} = over;
        const frames = Math.round(fps * 2);
        this.frames += frames;
        if (enc !== null) {
            this.encSeconds += (frames * enc) / 1000;
        }
        this.at += 2000;
        const snap: AutoSnapshot = {
            at: this.at,
            reason: 'none',
            framesPerSecond: fps,
            frameWidth: 2560,
            frameHeight: 1440,
            framesEncoded: this.frames,
            totalEncodeTime: enc === null ? null : this.encSeconds,
            availableOutgoingBitrate: 60_000_000,
            fractionLost: 0,
            rttMs: 20,
            ...rest,
        };
        this.state = autoStep(this.state, snap);
        return this.state;
    }

    times(n: number, over: Parameters<Feeder['tick']>[0] = {}) {
        for (let i = 0; i < n; i++) {
            this.tick(over);
        }
        return this.state;
    }

    // Past warm-up and settling, at the current level, without moving it.
    warm() {
        return this.times(AUTO_WARMUP_TICKS + 1 > AUTO_STEP_UP_TICKS - 1 ? 3 : AUTO_WARMUP_TICKS + 1, {availableOutgoingBitrate: 60_000_000});
    }
}

describe('ladder', () => {
    it('Game on a 4K source: resolution first, frame rate last', () => {
        const state = createAutoState('game', k4);
        expect(names(state)).toEqual(['2160p60', '1440p60', '1080p60', '720p60', '720p30', '720p15']);
        expect(level(state)).toBe('1440p60');
    });

    it('Text on a 4K source: frame rate first, resolution last; starts at the source', () => {
        const state = createAutoState('text', k4);
        expect(names(state)).toEqual(['2160p30', '2160p15', '1440p15', '1080p15', '720p15']);
        expect(level(state)).toBe('2160p30');
    });

    it('never goes above the source: rungs are clamped and merged', () => {
        const game = createAutoState('game', k1080);
        expect(names(game)).toEqual(['1080p60', '720p60', '720p30', '720p15']);
        expect(level(game)).toBe('1080p60');

        const text = createAutoState('text', k1080);
        expect(names(text)).toEqual(['1080p30', '1080p15', '720p15']);
        expect(level(text)).toBe('1080p30');

        for (const r of [...game.ladder, ...text.ladder]) {
            expect(r.size.height).toBeLessThanOrEqual(1080);
            expect(r.size.width).toBeLessThanOrEqual(1920);
        }
    });

    it('Game on a 1440p source starts at the source (60 fps)', () => {
        const state = createAutoState('game', k1440);
        expect(level(state)).toBe('1440p60');
        expect(names(state)[0]).toBe('1440p60');
    });

    it('keeps the aspect ratio of an ultrawide and a 16:10 source', () => {
        const ultrawide = buildLadder('game', {width: 3440, height: 1440});
        expect(ultrawide[0].size).toEqual({width: 3440, height: 1440});
        expect(ultrawide[1].size).toEqual({width: 2580, height: 1080});

        const sixteenTen = buildLadder('text', {width: 1920, height: 1200});
        expect(sixteenTen[0].size).toEqual({width: 1920, height: 1200});
        expect(sixteenTen[0].fps).toBe(30);
    });

    it('a source below 720p still has a frame rate ladder', () => {
        const state = createAutoState('game', {width: 1280, height: 600});
        expect(names(state)).toEqual(['600p60', '600p30', '600p15']);
    });

    it('bitrates follow the automatic table (VP8) of the clamped size', () => {
        const ladder = buildLadder('game', k4);
        expect(ladder.map((r) => r.mbps)).toEqual([25, 12, 8, 4, 2.5, 1.5]);
    });
});

describe('stepping down', () => {
    it('needs consecutive bad samples: one is not enough, a good one resets', () => {
        const f = new Feeder(createAutoState('game', k4));
        f.tick({reason: 'cpu'});
        expect(level(f.state)).toBe('1440p60');
        f.tick();
        f.tick({reason: 'cpu'});
        expect(level(f.state)).toBe('1440p60');
        f.tick({reason: 'cpu'});
        expect(level(f.state)).toBe('1080p60');
    });

    it('steps down after 2 consecutive samples limited by cpu', () => {
        const f = new Feeder(createAutoState('game', k4));
        f.times(AUTO_STEP_DOWN_TICKS, {reason: 'cpu'});
        expect(level(f.state)).toBe('1080p60');
        expect(f.state.limited).toBe('cpu');
    });

    it('steps down after 2 consecutive samples limited by bandwidth', () => {
        const f = new Feeder(createAutoState('game', k4));
        f.times(AUTO_STEP_DOWN_TICKS, {reason: 'bandwidth'});
        expect(level(f.state)).toBe('1080p60');
        expect(f.state.limited).toBe('bandwidth');
    });

    it('steps down when the encoder takes too long per frame, without a limitation reason', () => {
        const f = new Feeder(createAutoState('game', k4));
        f.tick(); // first sample only sets the baseline for the deltas

        // 1440p60: 16.7 ms frame budget, 15 ms per frame is 90 %.
        f.times(AUTO_STEP_DOWN_TICKS, {enc: 15});
        expect(level(f.state)).toBe('1080p60');
        expect(f.state.limited).toBe('cpu');
    });

    it('does not step down for a low frame rate alone (a still screen delivers few frames)', () => {
        const f = new Feeder(createAutoState('game', k4));
        f.tick();
        f.times(10, {fps: 5, enc: 1, availableOutgoingBitrate: 20_000_000});
        expect(level(f.state)).toBe('1440p60');
        expect(f.state.limited).toBeNull();
    });

    it('steps down for a low frame rate when the encoder is also busy', () => {
        const f = new Feeder(createAutoState('game', k4));
        f.tick();

        // 20 fps of 60 with 11 ms per frame (66 % of the budget).
        f.times(AUTO_STEP_DOWN_TICKS, {fps: 20, enc: 11});
        expect(level(f.state)).toBe('1080p60');
    });

    it('steps down on heavy packet loss', () => {
        const f = new Feeder(createAutoState('game', k4));
        f.times(AUTO_STEP_DOWN_TICKS, {fractionLost: 0.08});
        expect(level(f.state)).toBe('1080p60');
        expect(f.state.limited).toBe('bandwidth');
    });

    it('stays at the lowest level and keeps reporting the limit', () => {
        const f = new Feeder(createAutoState('game', k1080));
        f.times(60, {reason: 'cpu'});
        expect(level(f.state)).toBe('720p15');
        expect(f.state.limited).toBe('cpu');
    });

    it('ignores samples while the previous change settles', () => {
        const f = new Feeder(createAutoState('game', k4));
        f.times(AUTO_STEP_DOWN_TICKS, {reason: 'cpu'});
        expect(level(f.state)).toBe('1080p60');

        // Stale samples that still show the old trouble: no second step.
        f.times(AUTO_SETTLE_TICKS, {reason: 'cpu'});
        expect(level(f.state)).toBe('1080p60');

        f.times(AUTO_STEP_DOWN_TICKS, {reason: 'cpu'});
        expect(level(f.state)).toBe('720p60');
    });

    it('Game drops resolution before frame rate', () => {
        const f = new Feeder(createAutoState('game', k4));
        const seen = [level(f.state)];
        for (let i = 0; i < 5; i++) {
            f.times(AUTO_STEP_DOWN_TICKS + AUTO_SETTLE_TICKS, {reason: 'cpu'});
            seen.push(level(f.state));
        }
        expect(seen).toEqual(['1440p60', '1080p60', '720p60', '720p30', '720p15', '720p15']);
    });

    it('Text drops frame rate before resolution', () => {
        const f = new Feeder(createAutoState('text', k4));
        const seen = [level(f.state)];
        for (let i = 0; i < 4; i++) {
            f.times(AUTO_STEP_DOWN_TICKS + AUTO_SETTLE_TICKS, {reason: 'cpu'});
            seen.push(level(f.state));
        }
        expect(seen).toEqual(['2160p30', '2160p15', '1440p15', '1080p15', '720p15']);
    });
});

describe('available outgoing bitrate', () => {
    it('caps the bitrate at 85 % of the estimate once it is trusted, and not during warm-up', () => {
        const f = new Feeder(createAutoState('game', k4));
        for (let i = 0; i < AUTO_WARMUP_TICKS; i++) {
            f.tick({availableOutgoingBitrate: 10_000_000});
            expect(f.state.capMbps).toBeNull();
        }
        f.tick({availableOutgoingBitrate: 10_000_000});
        expect(f.state.capMbps).toBe(8.5);
        expect(autoOutput(f.state).capMbps).toBe(10 * AUTO_BITRATE_CAP_FRACTION);

        f.tick({availableOutgoingBitrate: null});
        expect(f.state.capMbps).toBeNull();
    });

    it('never caps below 0.5 Mbps', () => {
        const f = new Feeder(createAutoState('game', k4));
        f.times(AUTO_WARMUP_TICKS + 1, {availableOutgoingBitrate: 300_000});
        expect(f.state.capMbps).toBe(0.5);
    });

    it('a starved estimate is not held against the level during warm-up', () => {
        const f = new Feeder(createAutoState('game', k4));
        f.times(AUTO_WARMUP_TICKS, {availableOutgoingBitrate: 300_000});
        expect(level(f.state)).toBe('1440p60');
    });

    it('jumps straight to a level that fits when the estimate is far too low', () => {
        const f = new Feeder(createAutoState('game', k4));
        f.times(AUTO_WARMUP_TICKS, {availableOutgoingBitrate: 60_000_000});

        // 3 Mbps: cap 2.55 Mbps, 1440p60 wants 12 (starved). First level whose 60 % fits: 720p60 (4 Mbps).
        f.times(AUTO_STEP_DOWN_TICKS, {availableOutgoingBitrate: 3_000_000});
        expect(level(f.state)).toBe('720p60');
        expect(f.state.limited).toBe('bandwidth');
    });

    it('does not jump for cpu trouble, one step at a time', () => {
        const f = new Feeder(createAutoState('game', k4));
        f.times(AUTO_WARMUP_TICKS, {availableOutgoingBitrate: 3_000_000});
        f.times(AUTO_STEP_DOWN_TICKS, {reason: 'cpu', availableOutgoingBitrate: 60_000_000});
        expect(level(f.state)).toBe('1080p60');
    });

    it('a cap tighter than the level wants shows as limited by bandwidth without stepping down', () => {
        const f = new Feeder(createAutoState('game', k4));

        // 1440p60 wants 12; cap 0.85 x 16 = 13.6 Mbps is fine, 0.85 x 10 = 8.5 is below 12 but not starved (>= 6).
        f.times(AUTO_WARMUP_TICKS + 3, {availableOutgoingBitrate: 10_000_000});
        expect(level(f.state)).toBe('1440p60');
        expect(f.state.limited).toBe('bandwidth');
    });
});

describe('stepping up', () => {
    const atOneBelowTop = () => {
        const f = new Feeder(createAutoState('game', k4));
        f.times(AUTO_STEP_DOWN_TICKS, {reason: 'cpu'});
        f.times(AUTO_SETTLE_TICKS);
        expect(level(f.state)).toBe('1080p60');
        return f;
    };

    it('needs ~16 s of headroom: 7 good samples are not enough, the 8th steps up one level', () => {
        const f = atOneBelowTop();
        f.times(AUTO_STEP_UP_TICKS - 1);
        expect(level(f.state)).toBe('1080p60');
        f.tick();
        expect(level(f.state)).toBe('1440p60');
    });

    it('a bad sample in between starts the count again (hysteresis)', () => {
        const f = atOneBelowTop();
        f.times(AUTO_STEP_UP_TICKS - 1);
        f.tick({reason: 'bandwidth'});
        f.times(AUTO_STEP_UP_TICKS - 1);
        expect(level(f.state)).toBe('1080p60');
        f.tick();
        expect(level(f.state)).toBe('1440p60');
    });

    it('does not step up without bandwidth headroom for the level above (needs 1.3 x its bitrate)', () => {
        const f = atOneBelowTop();

        // 1440p60 wants 12 Mbps: 1.3 x 12 = 15.6 Mbps needed, 14 is not enough.
        f.times(AUTO_STEP_UP_TICKS * 3, {availableOutgoingBitrate: 14_000_000});
        expect(level(f.state)).toBe('1080p60');

        f.times(AUTO_STEP_UP_TICKS, {availableOutgoingBitrate: 16_000_000});
        expect(level(f.state)).toBe('1440p60');
    });

    it('does not step up when the encoder would not keep up at the level above', () => {
        const f = atOneBelowTop();

        // 1080p60 at 8 ms per frame (48 % of the budget) would be about 8 x (2560x1440 / 1920x1080) = 14.2 ms at 1440p: too much.
        f.times(AUTO_STEP_UP_TICKS * 3, {enc: 8});
        expect(level(f.state)).toBe('1080p60');
    });

    it('does not step up with remaining packet loss', () => {
        const f = atOneBelowTop();
        f.times(AUTO_STEP_UP_TICKS * 3, {fractionLost: 0.02});
        expect(level(f.state)).toBe('1080p60');
    });

    it('steps up even if the screen is idle (no frames to time the encoder)', () => {
        const f = atOneBelowTop();
        f.times(AUTO_STEP_UP_TICKS, {enc: null, fps: 1});
        expect(level(f.state)).toBe('1440p60');
    });

    it('never steps above the top of the ladder, which is never above the source', () => {
        const f = new Feeder(createAutoState('game', k1080));
        f.times(100);
        expect(level(f.state)).toBe('1080p60');
        expect(f.state.index).toBe(0);
    });

    it('Game can climb from its 1440p start to 4K60 when there is plenty of room', () => {
        const f = new Feeder(createAutoState('game', k4));
        f.times(AUTO_STEP_UP_TICKS, {availableOutgoingBitrate: 100_000_000});
        expect(level(f.state)).toBe('2160p60');
        f.times(100, {availableOutgoingBitrate: 100_000_000});
        expect(level(f.state)).toBe('2160p60');
    });

    it('a step up that is undone quickly makes the next one wait twice as long, and it is forgotten after a long calm', () => {
        const f = atOneBelowTop();
        f.times(AUTO_STEP_UP_TICKS);
        expect(level(f.state)).toBe('1440p60');
        expect(f.state.lastUpTick).not.toBeNull();

        // Trouble right after the step up: back down, and the next step up needs 2 x 8 samples.
        f.times(AUTO_SETTLE_TICKS);
        f.times(AUTO_STEP_DOWN_TICKS, {reason: 'cpu'});
        expect(level(f.state)).toBe('1080p60');
        expect(f.state.upNeeded).toBe(AUTO_STEP_UP_TICKS * 2);

        f.times(AUTO_SETTLE_TICKS);
        f.times((AUTO_STEP_UP_TICKS * 2) - 1);
        expect(level(f.state)).toBe('1080p60');
        f.tick();
        expect(level(f.state)).toBe('1440p60');

        // A calm two minutes later (no room to climb further) the penalty is gone.
        f.times(AUTO_FAILED_UP_TICKS * 5, {availableOutgoingBitrate: 20_000_000});
        expect(f.state.upNeeded).toBe(AUTO_STEP_UP_TICKS);
    });

    it('a step down long after a step up does not count as a failed step up', () => {
        const f = atOneBelowTop();
        f.times(AUTO_STEP_UP_TICKS);
        f.times(AUTO_FAILED_UP_TICKS + 5, {availableOutgoingBitrate: 20_000_000});
        f.times(AUTO_STEP_DOWN_TICKS, {reason: 'cpu'});
        expect(f.state.upNeeded).toBe(AUTO_STEP_UP_TICKS);
    });
});

describe('robustness', () => {
    it('does not fail when the browser reports nothing (no reason, no encoder data, no bandwidth)', () => {
        const f = new Feeder(createAutoState('game', k4));
        f.times(20, {reason: null, enc: null, availableOutgoingBitrate: null, fractionLost: null, framesPerSecond: null});
        expect(level(f.state)).toBe('1440p60');
        expect(f.state.capMbps).toBeNull();
    });

    it('ignores the encode time right after the counters restarted (new sender after SFU/P2P switch)', () => {
        const f = new Feeder(createAutoState('game', k4));
        f.times(3);
        f.frames = 10;
        f.encSeconds = 0;
        f.times(AUTO_STEP_DOWN_TICKS, {enc: 1});
        expect(level(f.state)).toBe('1440p60');
    });

    it('does not modify the state it is given', () => {
        const state = createAutoState('game', k4);
        const copy = JSON.stringify(state);
        autoStep(state, {
            at: 1,
            reason: 'cpu',
            framesPerSecond: 60,
            frameWidth: 1,
            frameHeight: 1,
            framesEncoded: 10,
            totalEncodeTime: 1,
            availableOutgoingBitrate: 1_000_000,
            fractionLost: 0.5,
            rttMs: 10,
        });
        expect(JSON.stringify(state)).toBe(copy);
    });
});

describe('outputDiffers', () => {
    const base = createAutoState('game', k4);
    const out = (over: Partial<AutoState> = {}) => autoOutput({...base, ...over});

    it('reports a new level, a clearly different cap, and nothing for small cap moves', () => {
        expect(outputDiffers(null, out())).toBe('level');
        expect(outputDiffers(out(), out())).toBeNull();
        expect(outputDiffers(out(), out({index: 2}))).toBe('level');
        expect(outputDiffers(out({capMbps: 10}), out({capMbps: 10.5}))).toBeNull();
        expect(outputDiffers(out({capMbps: 10}), out({capMbps: 6}))).toBe('cap');
        expect(outputDiffers(out({capMbps: null}), out({capMbps: 6}))).toBe('cap');
        expect(outputDiffers(out({capMbps: 6}), out({capMbps: null}))).toBe('cap');
    });
});

describe('extractSnapshot', () => {
    const vp8 = {
        id: 'OT01V1',
        type: 'outbound-rtp',
        kind: 'video',
        remoteId: 'RIV1',
        qualityLimitationReason: 'none',
        framesPerSecond: 58,
        frameWidth: 2560,
        frameHeight: 1440,
        framesEncoded: 500,
        totalEncodeTime: 4,
    };
    const av1 = {
        id: 'OT02V1',
        type: 'outbound-rtp',
        kind: 'video',
        remoteId: 'RIV2',
        qualityLimitationReason: 'cpu',
        framesPerSecond: 40,
        frameWidth: 2560,
        frameHeight: 1440,
        framesEncoded: 480,
        totalEncodeTime: 6,
    };
    const common = [
        {id: 'RIV1', type: 'remote-inbound-rtp', fractionLost: 0.01, roundTripTime: 0.03},
        {id: 'RIV2', type: 'remote-inbound-rtp', fractionLost: 0.04, roundTripTime: 0.05},
        {id: 'T01', type: 'transport', selectedCandidatePairId: 'CP2'},
        {id: 'CP1', type: 'candidate-pair', nominated: true, state: 'succeeded', availableOutgoingBitrate: 1_000_000},
        {id: 'CP2', type: 'candidate-pair', nominated: true, state: 'succeeded', availableOutgoingBitrate: 9_000_000, currentRoundTripTime: 0.02},
    ];

    it('reads one sender, the receiver report and the selected candidate pair', () => {
        const snap = extractSnapshot([vp8, ...common], 123)!;
        expect(snap).toEqual({
            at: 123,
            reason: 'none',
            framesPerSecond: 58,
            frameWidth: 2560,
            frameHeight: 1440,
            framesEncoded: 500,
            totalEncodeTime: 4,
            availableOutgoingBitrate: 9_000_000,
            fractionLost: 0.01,
            rttMs: 30,
        });
    });

    it('merges two senders (SFU: VP8 + AV1): worst reason, most source frames, summed encode time, worst loss', () => {
        const snap = extractSnapshot([vp8, av1, ...common], 1)!;
        expect(snap.reason).toBe('cpu');
        expect(snap.framesEncoded).toBe(500);
        expect(snap.totalEncodeTime).toBe(10);
        expect(snap.fractionLost).toBe(0.04);
        expect(snap.rttMs).toBe(50);
        expect(snap.framesPerSecond).toBe(58);
    });

    it('falls back to the nominated pair without a transport entry, and tolerates missing fields', () => {
        const snap = extractSnapshot([
            {id: 'o', type: 'outbound-rtp', mediaType: 'video'},
            {id: 'CP1', type: 'candidate-pair', nominated: true, state: 'succeeded', availableOutgoingBitrate: 2_000_000},
        ], 1)!;
        expect(snap.availableOutgoingBitrate).toBe(2_000_000);
        expect(snap.reason).toBeNull();
        expect(snap.fractionLost).toBeNull();
        expect(snap.totalEncodeTime).toBeNull();
    });

    it('returns null when there is no outbound video stream', () => {
        expect(extractSnapshot([{id: 'a', type: 'outbound-rtp', kind: 'audio'}, ...common], 1)).toBeNull();
        expect(extractSnapshot([], 1)).toBeNull();
    });
});
