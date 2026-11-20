// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {browserNoiseSuppression, isProcessedLevel, type NoiseLevel} from 'src/voice_input_prefs';

import {overloadedLevel, rememberOverload} from './fallback';
import type {AudioHost, NoiseGraph} from './host';
import {type LoadSample, OverloadDetector} from './overload';
import {type FallbackReason, resetNoiseStatus, setNoiseStatus, updateNoiseStatus} from './status';

export type NoiseDeps = {

    // The live (raw) microphone track, if there is one.
    getSource: () => MediaStreamTrack | null;
    loadHost: () => Promise<AudioHost>;

    // Turns the browser's own noise suppression on or off for the live microphone.
    setBrowserNoise: (enabled: boolean) => Promise<void>;

    // The track the client must send instead of the raw microphone track (the filter's output), or null to send
    // the raw track again. Called whenever the output changes: a level switch, a new microphone, a fallback.
    onOutput: (track: MediaStreamTrack | null) => void;
};

// Keeps the microphone processing at the level the user chose, while a call runs.
//
// - Off / Standard: no graph; only the browser's own noise suppression constraint differs.
// - Enhanced / Maximum: the browser's filter is switched off and the audio host runs the worklet on the
//   microphone track. The cleaned track goes out through `onOutput`; the client puts it on the SFU voice sender and
//   on the P2P voice sender. A failure to load, a dying processor or a CPU that can't keep up falls back to
//   Standard, with `status.fallback` saying why. A level that overloaded the CPU is remembered so the next call does
//   not start it again until the user chooses a level.
//
// Changes go through one queue and the last wanted level wins.
export class NoiseController {
    private deps: NoiseDeps;
    private wanted: NoiseLevel;
    private queue: Promise<void> = Promise.resolve();
    private host: AudioHost | undefined;
    private graph: {graph: NoiseGraph; level: NoiseLevel; source: MediaStreamTrack} | undefined;
    private detector = new OverloadDetector();
    private muted = true;
    private generation = 0;

    constructor(deps: NoiseDeps, level: NoiseLevel) {
        this.deps = deps;
        this.wanted = level;
        resetNoiseStatus(level);
    }

    // The user chose a level (or the call just started with one). Resolves when it is running or has fallen back.
    setLevel(level: NoiseLevel): Promise<void> {
        this.wanted = level;
        return this.enqueue(() => this.apply());
    }

    // The microphone track changed (device switch, new track): re-run the current level on it.
    sourceChanged(): Promise<void> {
        return this.enqueue(() => this.apply());
    }

    // The microphone was muted or unmuted: a muted processor stops working so it costs nothing.
    setMuted(muted: boolean) {
        this.muted = muted;
        this.graph?.graph.setActive(!muted);
    }

    // Resolves when the queued work is done, or after `maxMs`, whichever is first.
    settled(maxMs: number): Promise<void> {
        const queue = this.queue;
        return new Promise((resolve) => {
            const timer = setTimeout(resolve, maxMs);
            queue.then(() => {
                clearTimeout(timer);
                resolve();
            });
        });
    }

    // The call ended. Drops the graph and the audio host and clears the status.
    dispose(level: NoiseLevel) {
        this.generation++;
        this.wanted = level;
        this.closeGraph();
        this.releaseHost();
        this.detector.reset();
        resetNoiseStatus(level);
    }

    private enqueue(work: () => Promise<void>): Promise<void> {
        this.queue = this.queue.then(work).catch(() => undefined);
        return this.queue;
    }

    private async apply(): Promise<void> {
        const wanted = this.wanted;
        const generation = this.generation;

        // A level that overloaded this machine earlier stays off until the user chooses a level again.
        if (isProcessedLevel(wanted) && overloadedLevel() === wanted) {
            await this.setStandard(wanted, 'overload', generation);
            return;
        }

        if (!this.deps.getSource()) {
            // Nothing to process yet; `sourceChanged` runs again once the microphone track exists.
            setNoiseStatus({requested: wanted, effective: wanted, phase: 'idle'});
            return;
        }

        if (!isProcessedLevel(wanted)) {
            this.closeGraph();
            await this.deps.setBrowserNoise(browserNoiseSuppression(wanted)).catch(() => undefined);
            this.releaseHost();
            setNoiseStatus({requested: wanted, effective: wanted, phase: 'active'});
            return;
        }

        setNoiseStatus({requested: wanted, effective: wanted, phase: 'loading'});
        try {
            // The browser's filter goes off first, so the audio is never filtered twice. This may swap the
            // microphone track for a new one, so the source is read after it.
            await this.deps.setBrowserNoise(false);
            const source = this.deps.getSource();
            if (!source) {
                setNoiseStatus({requested: wanted, effective: wanted, phase: 'idle'});
                return;
            }
            if (this.graph && this.graph.level === wanted && this.graph.source === source) {
                setNoiseStatus({requested: wanted, effective: wanted, phase: 'active'});
                return;
            }

            this.host ??= await this.deps.loadHost();
            const graph = await this.host.open(wanted, source);
            if (generation !== this.generation) {
                graph.close();
                return;
            }

            this.detector.reset();
            graph.onStats((sample) => this.onStats(wanted, graph, sample));
            graph.onError(() => this.fail(wanted, graph, 'error', generation));
            graph.setActive(!this.muted);

            // The sender gets the new track before the old graph is closed, so it always has a live one.
            const previous = this.graph;
            this.graph = {graph, level: wanted, source};
            this.deps.onOutput(graph.track);
            previous?.graph.close();
            setNoiseStatus({requested: wanted, effective: wanted, phase: 'active'});
        } catch {
            await this.setStandard(wanted, 'unavailable', generation);
        }
    }

    private onStats(level: NoiseLevel, graph: NoiseGraph, sample: LoadSample) {
        if (this.graph?.graph !== graph) {
            return;
        }
        updateNoiseStatus({load: sample});
        if (this.detector.add(sample)) {
            rememberOverload(level);
            this.fail(level, graph, 'overload', this.generation);
        }
    }

    // A running graph gave up (overloaded, died). Goes through the queue so it can't race a level change.
    private fail(level: NoiseLevel, graph: NoiseGraph, reason: FallbackReason, generation: number) {
        if (generation !== this.generation || this.wanted !== level || this.graph?.graph !== graph) {
            return;
        }
        this.enqueue(() => this.setStandard(level, reason, generation));
    }

    private async setStandard(from: NoiseLevel, reason: FallbackReason, generation: number) {
        if (generation !== this.generation) {
            return;
        }
        const hasSource = Boolean(this.deps.getSource());
        this.closeGraph();
        if (hasSource) {
            await this.deps.setBrowserNoise(true).catch(() => undefined);
        }
        this.releaseHost();
        setNoiseStatus({requested: this.wanted, effective: 'standard', phase: hasSource ? 'active' : 'idle', fallback: {from, reason}});
    }

    // Stops the graph and tells the client to send the raw track again.
    private closeGraph() {
        const current = this.graph;
        if (!current) {
            return;
        }
        this.graph = undefined;
        this.deps.onOutput(null);
        current.graph.close();
    }

    private releaseHost() {
        this.host?.dispose();
        this.host = undefined;
    }
}
