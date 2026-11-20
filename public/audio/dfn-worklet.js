// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// Worklet module for the Maximum level: DeepFilterNet 3 (MIT OR Apache-2.0) compiled from the upstream
// libDF `wasm` feature, see README.md. The audio runs in 480-sample frames (10 ms at 48 kHz); the
// worklet's own quantum is 128 samples, so the frames are cut from a small FIFO.
import './worklet-timing.js';
import {df_create, df_get_frame_length, df_process_frame, df_set_atten_lim, initSync} from './dfn/df.js';

// The generated glue wants a few globals that AudioWorkletGlobalScope lacks. crypto only seeds hash maps inside
// the WebAssembly, so a weak source is enough.
globalThis.self ??= globalThis;
globalThis.crypto ??= {
    getRandomValues(array) {
        for (let i = 0; i < array.length; i++) {
            array[i] = Math.floor(Math.random() * 256);
        }
        return array;
    },
};

const QUANTUM = 128;

class DeepFilterProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super(options);
        this.ready = false;
        try {
            const {wasmModule, modelBytes, attenuationLimitDb} = options.processorOptions;
            initSync(wasmModule);
            this.state = df_create(new Uint8Array(modelBytes), attenuationLimitDb);
            this.frame = df_get_frame_length(this.state);
            this.pending = new Float32Array(this.frame);
            this.pendingCount = 0;
            this.fifo = new Float32Array(this.frame * 4);
            this.fifoRead = 0;
            this.fifoCount = 0;
            this.ready = true;
        } catch (error) {
            this.port.postMessage({type: 'error', message: String(error && error.message ? error.message : error)});
        }
        this.port.onmessage = (event) => {
            if (event.data === 'destroy') {
                this.destroyed = true;
            } else if (this.ready && event.data && typeof event.data.attenuationLimitDb === 'number') {
                df_set_atten_lim(this.state, event.data.attenuationLimitDb);
            }
        };
    }

    process(inputs, outputs) {
        if (this.destroyed) {
            return false;
        }
        const output = outputs[0] && outputs[0][0];
        const input = inputs[0] && inputs[0][0];
        if (!this.ready || !output || !input) {
            return true;
        }

        for (let i = 0; i < input.length; i++) {
            this.pending[this.pendingCount++] = input[i];
            if (this.pendingCount === this.frame) {
                const cleaned = df_process_frame(this.state, this.pending);
                for (let j = 0; j < cleaned.length; j++) {
                    this.fifo[(this.fifoRead + this.fifoCount + j) % this.fifo.length] = cleaned[j];
                }
                this.fifoCount += cleaned.length;
                this.pendingCount = 0;
            }
        }

        // Until the first frame is done there is nothing to play: silence for the first few quanta.
        if (this.fifoCount >= QUANTUM) {
            for (let i = 0; i < QUANTUM; i++) {
                output[i] = this.fifo[(this.fifoRead + i) % this.fifo.length];
            }
            this.fifoRead = (this.fifoRead + QUANTUM) % this.fifo.length;
            this.fifoCount -= QUANTUM;
        }
        return true;
    }
}

registerProcessor('voice-rooms-deepfilternet3', DeepFilterProcessor);
