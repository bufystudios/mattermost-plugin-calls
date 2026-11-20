// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {OverloadDetector, STRUGGLING_IN_A_ROW, WARMUP_SAMPLES} from 'src/noise/overload';

const fine = {busy: 0.1, peakMs: 2, realtime: 1};
const slow = {busy: 0.95, peakMs: 9, realtime: 1};
const behind = {busy: 0.3, peakMs: 4, realtime: 0.7};

function warmUp(detector: OverloadDetector) {
    for (let i = 0; i < WARMUP_SAMPLES; i++) {
        detector.add(slow);
    }
}

test('the first reports are warm-up and never count', () => {
    const detector = new OverloadDetector();
    for (let i = 0; i < WARMUP_SAMPLES; i++) {
        expect(detector.add(slow)).toBe(false);
    }
});

test('a few struggling reports in a row are overload', () => {
    const detector = new OverloadDetector();
    warmUp(detector);
    const results = Array.from({length: STRUGGLING_IN_A_ROW}, () => detector.add(slow));
    expect(results).toEqual([false, false, true]);
});

test('one slow second is not enough: a good report resets the streak', () => {
    const detector = new OverloadDetector();
    warmUp(detector);
    detector.add(slow);
    detector.add(slow);
    expect(detector.add(fine)).toBe(false);
    detector.add(slow);
    expect(detector.add(slow)).toBe(false);
});

test('audio that falls behind the clock counts even when the processor is not busy', () => {
    const detector = new OverloadDetector();
    warmUp(detector);
    expect(Array.from({length: STRUGGLING_IN_A_ROW}, () => detector.add(behind)).pop()).toBe(true);
});

test('a healthy processor never trips', () => {
    const detector = new OverloadDetector();
    expect(Array.from({length: 60}, () => detector.add(fine)).some(Boolean)).toBe(false);
});
