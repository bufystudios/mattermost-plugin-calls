// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// The audio host: runs the Enhanced (RNNoise) and Maximum (DeepFilterNet 3) noise suppression.
//
// Mattermost sends `Content-Security-Policy: script-src 'self'`, which forbids WebAssembly.compile() and loading
// an AudioWorklet from a blob in the main page. This page is served from the plugin's public/ folder with no
// policy of its own, so it is where the WebAssembly and the worklets run. The plugin webapp loads it into a
// hidden same-origin iframe (webapp/src/noise/host.ts) and calls window.callsAudioHost.open() with the
// microphone track; the cleaned track comes back as a plain MediaStreamTrack, which the Calls client puts on its voice senders (SFU and P2P).
//
// Nothing here talks to the network except fetching the model files that sit next to this page.

const HOST_VERSION = 1;
const SAMPLE_RATE = 48000; // RNNoise and DeepFilterNet both work at 48 kHz.

const LEVELS = {
    enhanced: {processor: '@sapphi-red/web-noise-suppressor/rnnoise', timeoutMs: 8000},
    maximum: {processor: 'voice-rooms-deepfilternet3', timeoutMs: 40000},
};

// Attenuation limit for DeepFilterNet in dB; 100 means no limit.
const DEEPFILTER_ATTENUATION_DB = 100;

let context;
const resources = new Map(); // level -> Promise of what the level needs, loaded once
const graphs = new Set();
const statsHistory = []; // the last reports of all graphs, for the smoke tests

function getContext() {
    if (!context || context.state === 'closed') {
        context = new AudioContext({sampleRate: SAMPLE_RATE, latencyHint: 'interactive'});
    }
    return context;
}

async function fetchBytes(url) {
    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`${url}: HTTP ${response.status}`);
    }
    return response.arrayBuffer();
}

// WebAssembly SIMD, detected the way the wasm-feature-detect package does it.
const hasSimd = () => WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]));

async function loadRnnoise(ctx) {
    const [wasmBinary] = await Promise.all([
        fetchBytes(hasSimd() ? './vendor/rnnoise_simd.wasm' : './vendor/rnnoise.wasm'),
        ctx.audioWorklet.addModule('./rnnoise-worklet.js'),
    ]);
    return {processorOptions: {maxChannels: 1, wasmBinary}};
}

async function loadDeepFilter(ctx) {
    const [wasmBytes, modelBytes] = await Promise.all([
        fetchBytes('./dfn/df_bg.wasm'),
        fetchBytes('./dfn/DeepFilterNet3_onnx.tar.gz'),
        ctx.audioWorklet.addModule('./dfn-worklet.js'),
    ]);

    // Compiled here and handed to the worklet, so the worklet only instantiates it.
    const wasmModule = await WebAssembly.compile(wasmBytes);
    return {processorOptions: {wasmModule, modelBytes, attenuationLimitDb: DEEPFILTER_ATTENUATION_DB}};
}

function loadLevel(level, ctx) {
    if (!resources.has(level)) {
        const promise = level === 'maximum' ? loadDeepFilter(ctx) : loadRnnoise(ctx);

        // A failed load is not cached, so a later try starts again.
        promise.catch(() => resources.delete(level));
        resources.set(level, promise);
    }
    return resources.get(level);
}

function withTimeout(promise, ms, what) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${what} timed out`)), ms);
        promise.then((value) => {
            clearTimeout(timer);
            resolve(value);
        }, (error) => {
            clearTimeout(timer);
            reject(error);
        });
    });
}

async function open(level, track) {
    const config = LEVELS[level];
    if (!config) {
        throw new Error(`unknown level ${level}`);
    }
    const ctx = getContext();
    if (ctx.state === 'suspended') {
        await ctx.resume();
    }
    const {processorOptions} = await withTimeout(loadLevel(level, ctx), config.timeoutMs, 'loading the model');

    const source = ctx.createMediaStreamSource(new MediaStream([track]));
    const node = new AudioWorkletNode(ctx, config.processor, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 1,
        channelCountMode: 'explicit',
        outputChannelCount: [1],
        processorOptions,
    });
    const destination = ctx.createMediaStreamDestination();
    destination.channelCount = 1;

    const statsListeners = [];
    const errorListeners = [];
    let rejectReady;
    let resolveReady;
    const ready = new Promise((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
    });
    let closed = false;

    const fail = (message) => {
        rejectReady(new Error(message));
        errorListeners.forEach((listener) => listener(message));
    };
    node.port.onmessage = (event) => {
        const message = event.data;
        if (message.type === 'ready') {
            resolveReady();
        } else if (message.type === 'error') {
            fail(message.message);
        } else if (message.type === 'stats') {
            const sample = {busy: message.busy, peakMs: message.peakMs, realtime: message.realtime};
            statsHistory.push({level, ...sample});
            if (statsHistory.length > 600) {
                statsHistory.shift();
            }
            statsListeners.forEach((listener) => listener(sample));
        }
    };
    node.onprocessorerror = () => fail('the audio processor stopped');

    source.connect(node);
    node.connect(destination);

    const graph = {
        track: destination.stream.getAudioTracks()[0],
        setActive(active) {
            if (closed) {
                return;
            }
            try {
                if (active) {
                    source.connect(node);
                } else {
                    source.disconnect(node);
                }
            } catch {
                // Already connected or disconnected.
            }
        },
        onStats: (listener) => statsListeners.push(listener),
        onError: (listener) => errorListeners.push(listener),
        close() {
            if (closed) {
                return;
            }
            closed = true;
            try {
                node.port.postMessage('destroy');
                source.disconnect();
                node.disconnect();
                destination.disconnect();
            } catch {
                // Closing is best effort.
            }
            graph.track.stop();
            graphs.delete(graph);
            if (graphs.size === 0 && context.state === 'running') {
                context.suspend().catch(() => undefined);
            }
        },
    };
    graphs.add(graph);

    try {
        await withTimeout(ready, config.timeoutMs, 'starting the processor');
    } catch (error) {
        graph.close();
        throw error;
    }
    return graph;
}

window.callsAudioHost = {
    version: HOST_VERSION,
    open,

    // For the smoke tests (scripts/smoke/noise.mjs): the audio context that runs the graphs.
    audioContext: () => context,
    statsHistory: () => statsHistory.slice(),
};
