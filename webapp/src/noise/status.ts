// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {useSyncExternalStore} from 'react';
import {STORAGE_CALLS_NOISE_STATUS_KEY} from 'src/constants';
import {getNoiseLevel, type NoiseLevel} from 'src/voice_input_prefs';

// Why a processed level was given up for Standard.
export type FallbackReason =

    // The audio host (iframe, WebAssembly, worklet or model files) could not be loaded.
    'unavailable' |

    // The processor kept missing its deadline: the CPU cannot keep up.
    'overload' |

    // The processor died while running.
    'error';

// What the microphone processing is doing right now. The settings and the call menus show it.
export type NoiseStatus = {

    // What the user chose.
    requested: NoiseLevel;

    // What actually runs; differs from `requested` after a fallback.
    effective: NoiseLevel;
    phase: 'idle' | 'loading' | 'active';

    // Set when `requested` could not be kept.
    fallback?: {from: NoiseLevel; reason: FallbackReason};

    // Share of the audio time budget the processor uses, from its last report. Not shared between windows.
    load?: {busy: number; peakMs: number; realtime: number};
};

function initial(): NoiseStatus {
    const level = getNoiseLevel();
    return {requested: level, effective: level, phase: 'idle'};
}

let status: NoiseStatus = initial();
const listeners = new Set<() => void>();

function emit() {
    listeners.forEach((listener) => listener());
}

// The window that owns the call (the desktop widget) writes the status without the load numbers, so the settings
// dialog in another window can show a fallback notice too. Other windows only mirror it.
function share(next: NoiseStatus) {
    try {
        const {load: _load, ...rest} = next;
        window.localStorage.setItem(STORAGE_CALLS_NOISE_STATUS_KEY, JSON.stringify(rest));
    } catch {
        // Not shared: the other windows show no notice.
    }
}

function parseShared(raw: string | null): NoiseStatus | null {
    if (!raw) {
        return null;
    }
    try {
        const value = JSON.parse(raw);
        if (value && typeof value.requested === 'string' && typeof value.effective === 'string' && typeof value.phase === 'string') {
            return value as NoiseStatus;
        }
    } catch {
        // Ignored.
    }
    return null;
}

if (typeof window !== 'undefined') {
    window.addEventListener('storage', (ev: StorageEvent) => {
        if (ev.key !== STORAGE_CALLS_NOISE_STATUS_KEY) {
            return;
        }
        const next = parseShared(ev.newValue);
        if (next) {
            status = next;
            emit();
        }
    });
}

export function getNoiseStatus(): NoiseStatus {
    return status;
}

export function setNoiseStatus(next: NoiseStatus) {
    status = next;
    share(next);
    emit();
}

export function updateNoiseStatus(patch: Partial<NoiseStatus>) {
    status = {...status, ...patch};
    emit();
}

// Back to "nothing running", with the level the user chose.
export function resetNoiseStatus(level: NoiseLevel = getNoiseLevel()) {
    setNoiseStatus({requested: level, effective: level, phase: 'idle'});
}

export function subscribeNoiseStatus(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

export function useNoiseStatus(): NoiseStatus {
    return useSyncExternalStore(subscribeNoiseStatus, getNoiseStatus);
}
