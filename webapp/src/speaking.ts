// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// "Is this participant speaking?"
//
// Through the SFU the server detects voice activity and tells everyone
// (`user_voice_on/off`, stored as `session.voice`). In a P2P call the server
// receives no audio, so the client measures the levels itself and reports them
// through the same UI path. `isSessionSpeaking` is the single place that
// decides; every UI surface (widget, popout, grid, lists) uses it.

import {UserSessionState} from '@mattermost/calls-common/lib/types';

export type LocalSpeakingState = {[sessionID: string]: boolean};

export function isSessionSpeaking(session: Pick<UserSessionState, 'session_id' | 'voice'> | undefined, local?: LocalSpeakingState): boolean {
    if (!session) {
        return false;
    }
    return Boolean(session.voice) || Boolean(local?.[session.session_id]);
}

export type HysteresisConfig = {

    // Level (RMS, 0..1) at or above which a sample counts as "loud".
    onThreshold: number;

    // Level below which a sample counts as "quiet". Lower than onThreshold: levels between the
    // two keep the current state, which avoids flicker around a single threshold.
    offThreshold: number;

    // How many consecutive loud samples are needed to start speaking (rejects clicks and keyboard noise).
    attackSamples: number;

    // How long the level must stay quiet before speaking stops (bridges the gaps between words).
    releaseMs: number;
};

export const defaultHysteresis: HysteresisConfig = {
    onThreshold: 0.02,
    offThreshold: 0.01,
    attackSamples: 2,
    releaseMs: 350,
};

export class SpeakingHysteresis {
    private speaking = false;
    private loudCount = 0;
    private quietSince: number | null = null;
    private cfg: HysteresisConfig;

    constructor(cfg: HysteresisConfig = defaultHysteresis) {
        this.cfg = cfg;
    }

    public get isSpeaking() {
        return this.speaking;
    }

    // Feeds one level sample and returns whether the participant is speaking now.
    public update(level: number, now: number): boolean {
        if (level >= this.cfg.onThreshold) {
            this.quietSince = null;
            this.loudCount++;
            if (!this.speaking && this.loudCount >= this.cfg.attackSamples) {
                this.speaking = true;
            }
        } else if (level < this.cfg.offThreshold) {
            this.loudCount = 0;
            if (this.speaking) {
                this.quietSince = this.quietSince ?? now;
                if (now - this.quietSince >= this.cfg.releaseMs) {
                    this.speaking = false;
                    this.quietSince = null;
                }
            }
        } else {
            // Between the thresholds: no evidence either way. Not speaking yet stays not speaking
            // (the attack run is broken), speaking stays speaking (the release timer is paused).
            this.loudCount = 0;
            this.quietSince = null;
        }
        return this.speaking;
    }

    public reset() {
        this.speaking = false;
        this.loudCount = 0;
        this.quietSince = null;
    }
}

// Root mean square of a block of samples in -1..1.
export function rmsLevel(samples: Float32Array): number {
    if (samples.length === 0) {
        return 0;
    }
    let sum = 0;
    for (let i = 0; i < samples.length; i++) {
        sum += samples[i] * samples[i];
    }
    return Math.sqrt(sum / samples.length);
}

type AnalyserLike = {fftSize: number; getFloatTimeDomainData: (arr: Float32Array) => void};
type SourceLike = {connect: (dest: AnalyserLike) => void; disconnect: () => void};
export type SpeakingAudioContext = {
    state: string;
    resume: () => Promise<void>;
    close: () => Promise<void>;
    createAnalyser: () => AnalyserLike;
    createMediaStreamSource: (stream: MediaStream) => SourceLike;
};

type Watched = {
    track: MediaStreamTrack;
    analyser: AnalyserLike;
    source: SourceLike;
    buffer: Float32Array;
    hysteresis: SpeakingHysteresis;
    speaking: boolean;
    sink?: HTMLAudioElement;
};

type SpeakingMonitorOptions = {
    intervalMs?: number;
    createContext?: () => SpeakingAudioContext | null;
    now?: () => number;
    hysteresis?: HysteresisConfig;

    // Chrome only delivers samples of a remote WebRTC track to WebAudio while a media element
    // consumes the stream, so the tracks get a muted element.
    attachSink?: boolean;
};

const ignore = () => undefined;

// Measures the audio level of a set of tracks (keyed by session id) with WebAudio
// and reports speaking changes. Used for P2P calls only.
export class SpeakingMonitor {
    private watched = new Map<string, Watched>();
    private ctx: SpeakingAudioContext | null = null;
    private timer: ReturnType<typeof setInterval> | null = null;
    private onChange: (sessionID: string, speaking: boolean) => void;
    private opts: SpeakingMonitorOptions;

    constructor(onChange: (sessionID: string, speaking: boolean) => void, opts: SpeakingMonitorOptions = {}) {
        this.onChange = onChange;
        this.opts = opts;
    }

    // Replaces the watched set. Tracks keep their state if they stay the same.
    public setTracks(tracks: {[sessionID: string]: MediaStreamTrack | null}) {
        for (const [sessionID, w] of this.watched) {
            if (tracks[sessionID] !== w.track) {
                this.unwatch(sessionID);
            }
        }

        for (const [sessionID, track] of Object.entries(tracks)) {
            if (track && !this.watched.has(sessionID)) {
                this.watch(sessionID, track);
            }
        }

        if (this.watched.size > 0 && !this.timer) {
            this.timer = setInterval(() => this.tick(), this.opts.intervalMs ?? 50);
        } else if (this.watched.size === 0) {
            this.clearTimer();
        }
    }

    public getSpeakingSessions(): string[] {
        return [...this.watched.entries()].filter(([, w]) => w.speaking).map(([id]) => id);
    }

    public stop() {
        for (const sessionID of [...this.watched.keys()]) {
            this.unwatch(sessionID);
        }
        this.clearTimer();
        this.ctx?.close().catch(ignore);
        this.ctx = null;
    }

    private clearTimer() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    private getContext(): SpeakingAudioContext | null {
        if (!this.ctx) {
            this.ctx = this.opts.createContext ? this.opts.createContext() : defaultContext();
        }
        return this.ctx;
    }

    private watch(sessionID: string, track: MediaStreamTrack) {
        const ctx = this.getContext();
        if (!ctx) {
            return;
        }

        try {
            const stream = new MediaStream([track]);
            let sink: HTMLAudioElement | undefined;
            if (this.opts.attachSink) {
                sink = new Audio();
                sink.muted = true;
                sink.autoplay = true;
                sink.srcObject = stream;

                // Muted playback is always allowed by autoplay policies.
                sink.play?.()?.catch?.(ignore);
            }

            const analyser = ctx.createAnalyser();
            analyser.fftSize = 1024;
            const source = ctx.createMediaStreamSource(stream);

            // Not connected to the destination: this only measures, it must never play.
            source.connect(analyser);

            this.watched.set(sessionID, {
                track,
                analyser,
                source,
                buffer: new Float32Array(analyser.fftSize),
                hysteresis: new SpeakingHysteresis(this.opts.hysteresis),
                speaking: false,
                sink,
            });
        } catch {
            // Without level data the session just never shows as speaking.
        }
    }

    private unwatch(sessionID: string) {
        const w = this.watched.get(sessionID);
        if (!w) {
            return;
        }
        this.watched.delete(sessionID);

        try {
            w.source.disconnect();
        } catch {
            // Already disconnected.
        }
        if (w.sink) {
            w.sink.srcObject = null;
        }
        if (w.speaking) {
            this.onChange(sessionID, false);
        }
    }

    // Exposed for tests; normally driven by the interval.
    public tick() {
        if (this.ctx?.state === 'suspended') {
            // Autoplay policy: keep trying, a user gesture (joining the call) eventually allows it.
            this.ctx.resume().catch(ignore);
        }

        const now = this.opts.now ? this.opts.now() : Date.now();
        for (const [sessionID, w] of this.watched) {
            w.analyser.getFloatTimeDomainData(w.buffer);
            const speaking = w.hysteresis.update(rmsLevel(w.buffer), now);
            if (speaking !== w.speaking) {
                w.speaking = speaking;
                this.onChange(sessionID, speaking);
            }
        }
    }
}

function defaultContext(): SpeakingAudioContext | null {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    return Ctor ? (new Ctor() as unknown as SpeakingAudioContext) : null;
}
