// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {STORAGE_CALLS_NOISE_FALLBACK_KEY} from 'src/constants';
import type {NoiseLevel} from 'src/voice_input_prefs';

import {NoiseController} from './controller';
import type {AudioHost, NoiseGraph} from './host';
import {STRUGGLING_IN_A_ROW, WARMUP_SAMPLES} from './overload';
import {getNoiseStatus} from './status';

type FakeGraph = NoiseGraph & {
    level: string;
    source: MediaStreamTrack;
    closed: boolean;
    setActive: jest.Mock;
    emitStats: (busy: number) => void;
    emitError: () => void;
};

const mic = (id: string) => ({id, kind: 'audio', readyState: 'live'}) as unknown as MediaStreamTrack;

function setup(initial: NoiseLevel = 'enhanced') {
    const graphs: FakeGraph[] = [];
    let source: MediaStreamTrack | null = mic('mic1');
    const outputs: Array<MediaStreamTrack | null> = [];
    const calls: string[] = [];

    const host: AudioHost = {
        version: 1,
        dispose: jest.fn(),
        open: jest.fn(async (level, track) => {
            const statsListeners: Array<(s: any) => void> = [];
            const errorListeners: Array<(m: string) => void> = [];
            const graph: FakeGraph = {
                level,
                source: track,
                closed: false,
                track: {id: `out-${graphs.length}`, kind: 'audio'} as unknown as MediaStreamTrack,
                setActive: jest.fn(),
                onStats: (l) => statsListeners.push(l),
                onError: (l) => errorListeners.push(l),
                close: () => {
                    graph.closed = true;
                    calls.push(`close ${graph.track.id}`);
                },
                emitStats: (busy) => statsListeners.forEach((l) => l({busy, peakMs: 1, realtime: 1})),
                emitError: () => errorListeners.forEach((l) => l('boom')),
            };
            graphs.push(graph);
            return graph;
        }),
    };

    const deps = {
        getSource: () => source,
        loadHost: jest.fn(async () => host),
        setBrowserNoise: jest.fn(async (enabled: boolean) => {
            calls.push(`browser ${enabled}`);
        }),
        onOutput: jest.fn((track: MediaStreamTrack | null) => {
            outputs.push(track);
            calls.push(`output ${track ? track.id : 'raw'}`);
        }),
    };
    const controller = new NoiseController(deps, initial);
    return {controller,
        deps,
        host,
        graphs,
        outputs,
        calls,
        setSource: (s: MediaStreamTrack | null) => {
            source = s;
        }};
}

describe('NoiseController', () => {
    afterEach(() => window.localStorage.clear());

    it('Enhanced: browser filter off, the host opens a graph on the microphone, its track becomes the output', async () => {
        const t = setup();
        await t.controller.setLevel('enhanced');

        expect(t.deps.setBrowserNoise).toHaveBeenCalledWith(false);
        expect(t.host.open).toHaveBeenCalledWith('enhanced', expect.objectContaining({id: 'mic1'}));
        expect(t.outputs).toEqual([t.graphs[0].track]);
        expect(getNoiseStatus()).toMatchObject({requested: 'enhanced', effective: 'enhanced', phase: 'active'});
        expect(getNoiseStatus().fallback).toBeUndefined();
    });

    it('Off and Standard run no graph and only set the browser filter', async () => {
        const t = setup('standard');
        await t.controller.setLevel('standard');
        expect(t.deps.setBrowserNoise).toHaveBeenLastCalledWith(true);
        expect(t.host.open).not.toHaveBeenCalled();
        expect(t.deps.loadHost).not.toHaveBeenCalled();

        await t.controller.setLevel('off');
        expect(t.deps.setBrowserNoise).toHaveBeenLastCalledWith(false);
        expect(t.host.open).not.toHaveBeenCalled();
    });

    it('switching Enhanced > Maximum sends the new track before the old graph is closed', async () => {
        const t = setup();
        await t.controller.setLevel('enhanced');
        t.calls.length = 0;
        await t.controller.setLevel('maximum');

        expect(t.host.open).toHaveBeenLastCalledWith('maximum', expect.anything());
        expect(t.calls.filter((c) => c.startsWith('output') || c.startsWith('close'))).toEqual(['output out-1', 'close out-0']);
        expect(t.deps.loadHost).toHaveBeenCalledTimes(1);
    });

    it('going back to Standard or Off stops the graph, sends the raw track again and releases the host', async () => {
        const t = setup();
        await t.controller.setLevel('enhanced');
        await t.controller.setLevel('standard');

        expect(t.outputs[t.outputs.length - 1]).toBeNull();
        expect(t.graphs[0].closed).toBe(true);
        expect(t.host.dispose).toHaveBeenCalled();
        expect(t.deps.setBrowserNoise).toHaveBeenLastCalledWith(true);
    });

    it('running the same level again does not rebuild the graph', async () => {
        const t = setup();
        await t.controller.setLevel('enhanced');
        await t.controller.setLevel('enhanced');
        await t.controller.sourceChanged();
        expect(t.host.open).toHaveBeenCalledTimes(1);
    });

    it('a new microphone gets a new graph, and the old one is closed after the new track is out', async () => {
        const t = setup();
        await t.controller.setLevel('enhanced');
        t.setSource(mic('mic2'));
        await t.controller.sourceChanged();

        expect(t.host.open).toHaveBeenLastCalledWith('enhanced', expect.objectContaining({id: 'mic2'}));
        expect(t.outputs).toEqual([t.graphs[0].track, t.graphs[1].track]);
        expect(t.graphs[0].closed).toBe(true);
        expect(t.graphs[1].closed).toBe(false);
    });

    it('without a microphone there is nothing to do yet', async () => {
        const t = setup();
        t.setSource(null);
        await t.controller.setLevel('enhanced');
        expect(t.host.open).not.toHaveBeenCalled();
        expect(getNoiseStatus().phase).toBe('idle');
    });

    it('a muted microphone pauses the graph, unmuting resumes it', async () => {
        const t = setup();
        await t.controller.setLevel('enhanced');

        // Calls start muted: the graph is told so as soon as it exists.
        expect(t.graphs[0].setActive).toHaveBeenLastCalledWith(false);

        t.controller.setMuted(false);
        expect(t.graphs[0].setActive).toHaveBeenLastCalledWith(true);
        t.controller.setMuted(true);
        expect(t.graphs[0].setActive).toHaveBeenLastCalledWith(false);
    });

    describe('fallback to Standard', () => {
        it('when the audio host can not be loaded', async () => {
            const t = setup();
            t.deps.loadHost.mockRejectedValue(new Error('csp'));
            await t.controller.setLevel('enhanced');

            expect(getNoiseStatus()).toMatchObject({requested: 'enhanced', effective: 'standard', fallback: {from: 'enhanced', reason: 'unavailable'}});
            expect(t.deps.setBrowserNoise).toHaveBeenLastCalledWith(true);
            expect(t.outputs.filter(Boolean)).toHaveLength(0);
        });

        it('when the worklet or model fails to start', async () => {
            const t = setup();
            (t.host.open as jest.Mock).mockRejectedValue(new Error('model'));
            await t.controller.setLevel('maximum');
            expect(getNoiseStatus().fallback).toEqual({from: 'maximum', reason: 'unavailable'});
        });

        it('when the processor dies while running', async () => {
            const t = setup();
            await t.controller.setLevel('enhanced');
            t.graphs[0].emitError();
            await t.controller.settled(50);

            expect(getNoiseStatus()).toMatchObject({effective: 'standard', fallback: {from: 'enhanced', reason: 'error'}});
            expect(t.outputs[t.outputs.length - 1]).toBeNull();
            expect(t.graphs[0].closed).toBe(true);
        });

        it('when the CPU can not keep up, and it is remembered for the next call', async () => {
            const t = setup();
            await t.controller.setLevel('maximum');
            for (let i = 0; i < WARMUP_SAMPLES + STRUGGLING_IN_A_ROW; i++) {
                t.graphs[0].emitStats(0.95);
            }
            await t.controller.settled(50);

            expect(getNoiseStatus()).toMatchObject({effective: 'standard', fallback: {from: 'maximum', reason: 'overload'}});
            expect(window.localStorage.getItem(STORAGE_CALLS_NOISE_FALLBACK_KEY)).toBe('maximum');

            // A new call with the same level does not even try.
            const next = setup('maximum');
            await next.controller.setLevel('maximum');
            expect(next.host.open).not.toHaveBeenCalled();
            expect(getNoiseStatus().fallback).toEqual({from: 'maximum', reason: 'overload'});
        });

        it('a fallback is cleared when another level is chosen', async () => {
            const t = setup();
            t.deps.loadHost.mockRejectedValueOnce(new Error('csp'));
            await t.controller.setLevel('enhanced');
            expect(getNoiseStatus().fallback).toBeDefined();

            await t.controller.setLevel('off');
            expect(getNoiseStatus().fallback).toBeUndefined();
        });
    });

    it('the last wanted level wins when changes pile up', async () => {
        const t = setup();
        const first = t.controller.setLevel('maximum');
        const second = t.controller.setLevel('standard');
        await Promise.all([first, second]);
        expect(getNoiseStatus()).toMatchObject({requested: 'standard', effective: 'standard'});

        // The level that was never really wanted is not even loaded.
        expect(t.host.open).not.toHaveBeenCalled();
        expect(t.outputs.filter(Boolean)).toHaveLength(0);
    });

    it('dispose closes everything and clears the status', async () => {
        const t = setup();
        await t.controller.setLevel('enhanced');
        t.controller.dispose('enhanced');

        expect(t.graphs[0].closed).toBe(true);
        expect(t.host.dispose).toHaveBeenCalled();
        expect(getNoiseStatus()).toMatchObject({phase: 'idle', effective: 'enhanced'});
    });

    it('settled gives up waiting after the limit', async () => {
        const t = setup();
        t.deps.loadHost.mockImplementation(() => new Promise(() => undefined));
        t.controller.setLevel('enhanced');
        const start = Date.now();
        await t.controller.settled(40);
        expect(Date.now() - start).toBeLessThan(500);
    });
});
