// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// Imported first by every worklet module in this folder. It wraps `registerProcessor` so that each processor
// measures its own process() calls and reports how hard it works, about once a second:
//
//   { type: 'stats', busy, peakMs, realtime }
//     busy      share of the wall clock spent inside process(), 0 to 1
//     peakMs    the longest single call in the window
//     realtime  audio time per wall-clock time; below 1 the audio thread falls behind
//
// and { type: 'ready' } once, when the processor can process (`this.ready`, or the `this.processor` that the
// vendored RNNoise processor sets after it loaded its WebAssembly).
//
// AudioWorkletGlobalScope has no `performance`, so the time comes from Date.now(), which counts whole
// milliseconds. A call that takes 0.2 ms usually reads 0 and sometimes 1, so the sum over a second is a fair
// estimate even though a single reading is not.

const WINDOW_MS = 1000;
const registerProcessor = globalThis.registerProcessor;

globalThis.registerProcessor = (name, Processor) => {
    registerProcessor(name, class extends Processor {
        constructor(options) {
            super(options);
            this.vrWindowStart = Date.now();
            this.vrAudioStart = currentTime;
            this.vrBusy = 0;
            this.vrPeak = 0;
            this.vrReady = false;
        }

        process(inputs, outputs, parameters) {
            const start = Date.now();
            const keepAlive = super.process(inputs, outputs, parameters);
            const end = Date.now();

            const took = end - start;
            this.vrBusy += took;
            if (took > this.vrPeak) {
                this.vrPeak = took;
            }

            if (!this.vrReady && (this.ready || this.processor)) {
                this.vrReady = true;
                this.port.postMessage({type: 'ready'});
            }

            const wall = end - this.vrWindowStart;
            if (wall >= WINDOW_MS) {
                this.port.postMessage({
                    type: 'stats',
                    busy: this.vrBusy / wall,
                    peakMs: this.vrPeak,
                    realtime: ((currentTime - this.vrAudioStart) * 1000) / wall,
                });
                this.vrWindowStart = end;
                this.vrAudioStart = currentTime;
                this.vrBusy = 0;
                this.vrPeak = 0;
            }
            return keepAlive;
        }
    });
};
