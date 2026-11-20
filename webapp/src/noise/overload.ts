// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

/** One report from the audio worklet, covering about a second. */
export type LoadSample = {

    /** Share of the time the processor was busy, 0 to 1 (1 = a whole core of the audio thread). */
    busy: number;

    /** The longest single process() call in the window, in milliseconds. */
    peakMs: number;

    /** Audio time that passed per second of wall time. Below 1 the audio thread falls behind the clock. */
    realtime: number;
};

/** Busy above this share of the audio budget, or audio running slower than this, counts as struggling. */
export const MAX_BUSY = 0.8;
export const MIN_REALTIME = 0.9;

/** How many struggling reports in a row make it overload, and how many reports at the start are ignored (JIT warm-up). */
export const STRUGGLING_IN_A_ROW = 3;
export const WARMUP_SAMPLES = 2;

/**
 * Decides when the CPU can't keep up: a few reports in a row over the budget. One slow second (a garbage
 * collection, a busy tab) is not enough, and the first reports are skipped because the WebAssembly code is
 * still warming up.
 */
export class OverloadDetector {
    private seen = 0;
    private streak = 0;

    /** Feeds a report. Returns true once the processor has been struggling for long enough. */
    add(sample: LoadSample): boolean {
        this.seen++;
        if (this.seen <= WARMUP_SAMPLES) {
            return false;
        }
        if (sample.busy > MAX_BUSY || sample.realtime < MIN_REALTIME) {
            this.streak++;
        } else {
            this.streak = 0;
        }
        return this.streak >= STRUGGLING_IN_A_ROW;
    }

    reset() {
        this.seen = 0;
        this.streak = 0;
    }
}
