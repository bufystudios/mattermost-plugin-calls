// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {
    defaultHysteresis,
    isSessionSpeaking,
    rmsLevel,
    SpeakingHysteresis,
    SpeakingMonitor,
} from './speaking';

describe('isSessionSpeaking (single source of truth)', () => {
    it('uses the server voice activity in SFU calls', () => {
        expect(isSessionSpeaking({session_id: 's1', voice: true})).toBe(true);
        expect(isSessionSpeaking({session_id: 's1', voice: false})).toBe(false);
    });

    it('uses the locally measured state when the server sees no audio (P2P)', () => {
        expect(isSessionSpeaking({session_id: 's1', voice: false}, {s1: true})).toBe(true);
        expect(isSessionSpeaking({session_id: 's2', voice: false}, {s1: true})).toBe(false);
    });

    it('is false for an unknown session', () => {
        expect(isSessionSpeaking(undefined, {s1: true})).toBe(false);
    });
});

describe('SpeakingHysteresis', () => {
    const loud = defaultHysteresis.onThreshold * 3;
    const quiet = 0;
    const between = (defaultHysteresis.onThreshold + defaultHysteresis.offThreshold) / 2;

    it('needs consecutive loud samples before it starts speaking (ignores clicks)', () => {
        const h = new SpeakingHysteresis();

        expect(h.update(loud, 0)).toBe(false);
        expect(h.update(quiet, 50)).toBe(false);
        expect(h.update(loud, 100)).toBe(false);
        expect(h.update(loud, 150)).toBe(true);
    });

    it('keeps speaking through short pauses between words', () => {
        const h = new SpeakingHysteresis();
        h.update(loud, 0);
        h.update(loud, 50);

        expect(h.update(quiet, 100)).toBe(true);
        expect(h.update(quiet, (100 + defaultHysteresis.releaseMs) - 1)).toBe(true);
    });

    it('stops after the level stayed quiet for the release time', () => {
        const h = new SpeakingHysteresis();
        h.update(loud, 0);
        h.update(loud, 50);
        h.update(quiet, 100);

        expect(h.update(quiet, 100 + defaultHysteresis.releaseMs)).toBe(false);
    });

    it('restarts the release timer when speech resumes', () => {
        const h = new SpeakingHysteresis();
        h.update(loud, 0);
        h.update(loud, 50);
        h.update(quiet, 100);
        h.update(loud, 300);

        expect(h.update(quiet, 400)).toBe(true);
        expect(h.update(quiet, (400 + defaultHysteresis.releaseMs) - 1)).toBe(true);
        expect(h.update(quiet, 400 + defaultHysteresis.releaseMs)).toBe(false);
    });

    it('does not flicker around the threshold: between on and off keeps the state', () => {
        const h = new SpeakingHysteresis();
        for (let t = 0; t < 10; t++) {
            expect(h.update(between, t * 50)).toBe(false);
        }

        h.update(loud, 600);
        h.update(loud, 650);
        for (let t = 0; t < 40; t++) {
            expect(h.update(between, 700 + (t * 50))).toBe(true);
        }
    });

    it('can be reset', () => {
        const h = new SpeakingHysteresis();
        h.update(loud, 0);
        h.update(loud, 50);

        h.reset();

        expect(h.isSpeaking).toBe(false);
    });
});

describe('rmsLevel', () => {
    it('is zero for silence and for no samples', () => {
        expect(rmsLevel(new Float32Array(8))).toBe(0);
        expect(rmsLevel(new Float32Array(0))).toBe(0);
    });

    it('is the amplitude for a constant signal', () => {
        expect(rmsLevel(new Float32Array(8).fill(0.5))).toBeCloseTo(0.5);
    });
});

describe('SpeakingMonitor', () => {
    let levels: {[trackID: string]: number};
    let now: number;
    let changes: Array<[string, boolean]>;

    const track = (id: string) => ({id, kind: 'audio'}) as unknown as MediaStreamTrack;

    const newMonitor = () => {
        // Each analyser reads the level of the track its source was created from.
        const createContext = () => ({
            state: 'running',
            resume: jest.fn(async () => undefined),
            close: jest.fn(async () => undefined),
            createAnalyser: () => ({
                fftSize: 0,
                level: 0,
                getFloatTimeDomainData(arr: Float32Array) {
                    arr.fill(this.level);
                },
            }),
            createMediaStreamSource: (stream: MediaStream) => ({
                connect: (analyser: {level: number}) => {
                    Object.defineProperty(analyser, 'level', {get: () => levels[stream.getTracks()[0].id] ?? 0});
                },
                disconnect: jest.fn(),
            }),
        });

        return new SpeakingMonitor((id, speaking) => changes.push([id, speaking]), {
            createContext: createContext as never,
            now: () => now,
            intervalMs: 50,
        });
    };

    beforeEach(() => {
        jest.useFakeTimers();
        levels = {};
        now = 0;
        changes = [];
        (global as any).MediaStream = class {
            tracks: MediaStreamTrack[];
            constructor(tracks: MediaStreamTrack[]) {
                this.tracks = tracks;
            }
            getTracks() {
                return this.tracks;
            }
        };
    });

    afterEach(() => {
        jest.useRealTimers();
        delete (global as any).MediaStream;
    });

    const advance = (ms: number) => {
        for (let t = 0; t < ms; t += 50) {
            now += 50;
            jest.advanceTimersByTime(50);
        }
    };

    it('reports a session as speaking once its track gets loud, and not speaking after it went quiet', () => {
        const monitor = newMonitor();
        monitor.setTracks({'sess-a': track('ta')});

        levels.ta = 0.2;
        advance(200);
        expect(changes).toEqual([['sess-a', true]]);
        expect(monitor.getSpeakingSessions()).toEqual(['sess-a']);

        levels.ta = 0;
        advance(defaultHysteresis.releaseMs + 100);
        expect(changes).toEqual([['sess-a', true], ['sess-a', false]]);
        expect(monitor.getSpeakingSessions()).toEqual([]);

        monitor.stop();
    });

    it('tracks sessions independently (own mic and the peer)', () => {
        const monitor = newMonitor();
        monitor.setTracks({me: track('mine'), peer: track('theirs')});

        levels.theirs = 0.2;
        advance(200);

        expect(monitor.getSpeakingSessions()).toEqual(['peer']);
        monitor.stop();
    });

    it('reports not speaking for a session when its track is replaced or removed', () => {
        const monitor = newMonitor();
        monitor.setTracks({'sess-a': track('ta')});
        levels.ta = 0.2;
        advance(200);

        monitor.setTracks({'sess-a': null});

        expect(changes[changes.length - 1]).toEqual(['sess-a', false]);
        expect(monitor.getSpeakingSessions()).toEqual([]);
        monitor.stop();
    });

    it('clears everyone when stopped (P2P ended, the server takes over again)', () => {
        const monitor = newMonitor();
        monitor.setTracks({'sess-a': track('ta')});
        levels.ta = 0.2;
        advance(200);

        monitor.stop();

        expect(changes[changes.length - 1]).toEqual(['sess-a', false]);
    });

    it('does nothing without WebAudio', () => {
        const monitor = new SpeakingMonitor((id, speaking) => changes.push([id, speaking]), {createContext: () => null});

        monitor.setTracks({'sess-a': track('ta')});
        advance(300);

        expect(changes).toEqual([]);
        monitor.stop();
    });
});
