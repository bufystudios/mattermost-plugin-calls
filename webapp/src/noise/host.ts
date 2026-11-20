// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {getPluginPath} from 'src/utils';
import type {ProcessedLevel} from 'src/voice_input_prefs';

import type {LoadSample} from './overload';

// One running processing graph: microphone track in, cleaned track out.
export type NoiseGraph = {

    // The cleaned track to send.
    track: MediaStreamTrack;

    // Pauses the processor while the microphone is muted (the worklet then costs nothing), resumes it on true.
    setActive: (active: boolean) => void;

    // Called about once a second with how hard the processor works.
    onStats: (listener: (sample: LoadSample) => void) => void;

    // Called when the processor or its audio context dies.
    onError: (listener: (message: string) => void) => void;
    close: () => void;
};

// What the audio host page (public/audio/host.js) exposes on its window. The host runs in a same-origin iframe
// because Mattermost's Content-Security-Policy (`script-src 'self'`) forbids compiling WebAssembly and loading
// a worklet from a blob in the main page; the host's own response carries no such policy. See docs/bufy-noise-desktop.md.
export type AudioHostApi = {
    version: number;

    // Builds the graph for a level. Rejects when WebAssembly, the worklet or the model files can't be loaded.
    open: (level: ProcessedLevel, track: MediaStreamTrack) => Promise<NoiseGraph>;
};

export type AudioHost = AudioHostApi & {

    // Removes the iframe and with it the audio context, the worklets and the models in memory.
    dispose: () => void;
};

export const HOST_VERSION = 1;
const LOAD_TIMEOUT_MS = 10000;

declare global {
    interface Window {
        callsAudioHost?: AudioHostApi;
    }
}

// Where the plugin serves the audio host: the public/ folder of the bundle.
export function audioHostUrl(): string {
    return `${getPluginPath()}/public/audio/host.html`;
}

// True when the browser can run the filters at all (AudioWorklet and WebAssembly).
export function noiseProcessingSupported(): boolean {
    return typeof window !== 'undefined' &&
        typeof AudioContext !== 'undefined' &&
        typeof AudioWorkletNode !== 'undefined' &&
        typeof WebAssembly !== 'undefined';
}

// Loads the audio host into a hidden iframe. Rejects when it can't be loaded (an operator's CSP with a
// frame-src, a proxy that strips public/, an old server), which the caller turns into a fallback to Standard.
export function loadAudioHost(): Promise<AudioHost> {
    return new Promise((resolve, reject) => {
        const frame = document.createElement('iframe');
        frame.className = 'Calls-AudioHost';
        frame.title = 'Calls audio processing';
        frame.hidden = true;
        frame.setAttribute('aria-hidden', 'true');
        frame.tabIndex = -1;

        let settled = false;
        const finish = (error?: Error, api?: AudioHostApi) => {
            if (settled) {
                return;
            }
            settled = true;
            window.clearTimeout(timer);
            if (error || !api) {
                frame.remove();
                reject(error ?? new Error('audio host missing'));
                return;
            }
            resolve({
                ...api,
                open: (level, track) => api.open(level, track),
                dispose: () => frame.remove(),
            });
        };
        const timer = window.setTimeout(() => finish(new Error('audio host timed out')), LOAD_TIMEOUT_MS);

        // The host's module script runs before the load event. Reading a blocked or error page throws.
        frame.addEventListener('load', () => {
            try {
                const api = frame.contentWindow?.callsAudioHost;
                if (api?.version === HOST_VERSION) {
                    finish(undefined, api);
                } else {
                    finish(new Error('audio host has the wrong version'));
                }
            } catch (error) {
                finish(error as Error);
            }
        });
        frame.addEventListener('error', () => finish(new Error('audio host failed to load')));
        frame.src = audioHostUrl();
        document.body.appendChild(frame);
    });
}
