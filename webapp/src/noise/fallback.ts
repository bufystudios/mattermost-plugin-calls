// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {STORAGE_CALLS_NOISE_FALLBACK_KEY} from 'src/constants';
import type {NoiseLevel} from 'src/voice_input_prefs';

// A processed level that overloaded this machine is remembered, so the next call does not start it, struggle
// for a few seconds and fall back again. Choosing a level (setNoiseLevel) clears it. Per device, like the rest of
// the voice input choices; every access is guarded.

// The level that overloaded this device, if one did.
export function overloadedLevel(): NoiseLevel | undefined {
    try {
        const stored = window.localStorage.getItem(STORAGE_CALLS_NOISE_FALLBACK_KEY);
        return stored === 'enhanced' || stored === 'maximum' ? stored : undefined;
    } catch {
        return undefined;
    }
}

export function rememberOverload(level: NoiseLevel) {
    try {
        window.localStorage.setItem(STORAGE_CALLS_NOISE_FALLBACK_KEY, level);
    } catch {
        // Falling back again next time is harmless.
    }
}

export function clearOverload() {
    try {
        window.localStorage.removeItem(STORAGE_CALLS_NOISE_FALLBACK_KEY);
    } catch {
        // Nothing to clear.
    }
}
