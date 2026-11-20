// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// Client-side voice input preferences (noise suppression level, push-to-talk, desktop app extras).
// Like the other call prefs they live in localStorage, which is shared by all
// windows of the same origin (main window, call widget, pop out), so every
// window sees a change without extra plumbing.

import {STORAGE_CALLS_DESKTOP_KEY, STORAGE_CALLS_NOISE_SUPPRESSION_KEY, STORAGE_CALLS_PUSH_TO_TALK_KEY} from 'src/constants';
import {clearOverload} from 'src/noise/fallback';

function readStorage(key: string): string | null {
    try {
        return window.localStorage.getItem(key);
    } catch {
        return null;
    }
}

const PREFS_CHANGED_EVENT = 'calls-voice-input-prefs-changed';

function writeStorage(key: string, value: string) {
    try {
        window.localStorage.setItem(key, value);
    } catch {
        // Storage can be unavailable (private mode, blocked site data): the pref simply won't persist.
    }

    // The 'storage' event only reaches the other windows of the origin, tell this one too.
    try {
        window.dispatchEvent(new Event(PREFS_CHANGED_EVENT));
    } catch {
        // No window/Event: nothing is listening.
    }
}

// Calls back whenever a voice input pref (noise level, push-to-talk, desktop extras) changes in this or any other
// window of the origin, so what is shown in the call widget / pop out follows the settings. Returns an unsubscribe.
export function onVoiceInputPrefsChanged(callback: () => void): () => void {
    const onStorage = (ev: StorageEvent) => {
        if (!ev.key || ev.key === STORAGE_CALLS_NOISE_SUPPRESSION_KEY || ev.key === STORAGE_CALLS_PUSH_TO_TALK_KEY || ev.key === STORAGE_CALLS_DESKTOP_KEY) {
            callback();
        }
    };
    window.addEventListener(PREFS_CHANGED_EVENT, callback);
    window.addEventListener('storage', onStorage);
    return () => {
        window.removeEventListener(PREFS_CHANGED_EVENT, callback);
        window.removeEventListener('storage', onStorage);
    };
}

// How the microphone is cleaned up:
// - off: nothing, the microphone as it is
// - standard: the browser's own noise suppression (WebRTC)
// - enhanced: RNNoise in an AudioWorklet (the browser's own filter is switched off, so the audio is not filtered twice)
// - maximum: DeepFilterNet 3 in an AudioWorklet (experimental, needs a faster CPU)
export type NoiseLevel = 'off' | 'standard' | 'enhanced' | 'maximum';

export const NOISE_LEVELS: NoiseLevel[] = ['off', 'standard', 'enhanced', 'maximum'];

// The levels that run our own AudioWorklet in the audio host (public/audio).
export type ProcessedLevel = 'enhanced' | 'maximum';

export function isProcessedLevel(level: NoiseLevel): level is ProcessedLevel {
    return level === 'enhanced' || level === 'maximum';
}

// The browser's own noise suppression constraint for a level: only Standard uses it.
export function browserNoiseSuppression(level: NoiseLevel): boolean {
    return level === 'standard';
}

export const DEFAULT_NOISE_LEVEL: NoiseLevel = 'enhanced';

// Turns whatever is stored into a level. The pref used to be a boolean ('true' / 'false'): on becomes Enhanced
// (the better filter is the new default), off stays Off. Nothing stored (a new user, who had it on by default)
// gets the default. The next save writes the level.
export function parseNoiseLevel(stored: string | null): NoiseLevel {
    if (stored === 'true') {
        return 'enhanced';
    }
    if (stored === 'false') {
        return 'off';
    }
    return NOISE_LEVELS.includes(stored as NoiseLevel) ? stored as NoiseLevel : DEFAULT_NOISE_LEVEL;
}

export function getNoiseLevel(): NoiseLevel {
    return parseNoiseLevel(readStorage(STORAGE_CALLS_NOISE_SUPPRESSION_KEY));
}

// A deliberate choice gives a level that overloaded this machine another chance.
export function setNoiseLevel(level: NoiseLevel) {
    clearOverload();
    writeStorage(STORAGE_CALLS_NOISE_SUPPRESSION_KEY, level);
}

export type PushToTalkConfig = {
    enabled: boolean;

    // KeyboardEvent.code of the key (layout independent), e.g. 'KeyV' or 'ControlLeft'.
    code: string;
};

export const pushToTalkDisabled: PushToTalkConfig = {enabled: false, code: ''};

// Returns the stored push-to-talk config. A config without a key is never enabled.
export function getPushToTalkConfig(): PushToTalkConfig {
    const data = readStorage(STORAGE_CALLS_PUSH_TO_TALK_KEY);
    if (!data) {
        return pushToTalkDisabled;
    }

    try {
        const parsed = JSON.parse(data);
        if (parsed && typeof parsed.code === 'string' && parsed.code !== '') {
            return {enabled: Boolean(parsed.enabled), code: parsed.code};
        }
    } catch {
        // Malformed value: treated as not configured.
    }
    return pushToTalkDisabled;
}

export function setPushToTalkConfig(config: PushToTalkConfig) {
    writeStorage(STORAGE_CALLS_PUSH_TO_TALK_KEY, JSON.stringify(config));
}

const modifierCodes = new Set([
    'ControlLeft', 'ControlRight', 'ShiftLeft', 'ShiftRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight',
]);

export function isModifierCode(code: string): boolean {
    return modifierCodes.has(code);
}

// Mouse buttons a push-to-talk key can be (desktop app only: Mouse3 = middle, Mouse4 = back, Mouse5 = forward).
export function isMouseCode(code: string): boolean {
    return (/^Mouse[345]$/).test(code);
}

// Human readable name for a KeyboardEvent.code.
export function keyCodeLabel(code: string): string {
    if (!code) {
        return '';
    }
    if ((/^Key[A-Z]$/).test(code)) {
        return code.slice(3);
    }
    if ((/^Digit[0-9]$/).test(code)) {
        return code.slice(5);
    }
    if ((/^Numpad/).test(code)) {
        return 'Num ' + code.slice(6);
    }
    const mouse: {[code: string]: string} = {Mouse3: 'Middle mouse button', Mouse4: 'Mouse back button', Mouse5: 'Mouse forward button'};
    if (mouse[code]) {
        return mouse[code];
    }
    const sides: {[prefix: string]: string} = {Control: 'Ctrl', Shift: 'Shift', Alt: 'Alt', Meta: 'Meta'};
    const side = (/^(Control|Shift|Alt|Meta)(Left|Right)$/).exec(code);
    if (side) {
        return `${side[2]} ${sides[side[1]]}`;
    }
    if ((/^Arrow/).test(code)) {
        return code.slice(5) + ' arrow';
    }

    // Space, Backquote, F13, CapsLock, ...: put a space before inner capitals.
    return code.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
}

// Desktop app extras (window.desktopAPI.bufy, see desktop_bufy.ts). Only used when the Bufy desktop app is running.
export type DesktopPrefs = {

    // Push to talk and the global shortcuts also work while Mattermost is in the background.
    background: boolean;

    // Frame around the shared screen/window while sharing.
    shareBorder: boolean;
};

export const DEFAULT_DESKTOP_PREFS: DesktopPrefs = {background: true, shareBorder: true};

export function getDesktopPrefs(): DesktopPrefs {
    const data = readStorage(STORAGE_CALLS_DESKTOP_KEY);
    if (!data) {
        return DEFAULT_DESKTOP_PREFS;
    }
    try {
        const parsed = JSON.parse(data);
        return {
            background: typeof parsed?.background === 'boolean' ? parsed.background : DEFAULT_DESKTOP_PREFS.background,
            shareBorder: typeof parsed?.shareBorder === 'boolean' ? parsed.shareBorder : DEFAULT_DESKTOP_PREFS.shareBorder,
        };
    } catch {
        return DEFAULT_DESKTOP_PREFS;
    }
}

export function setDesktopPrefs(prefs: DesktopPrefs) {
    writeStorage(STORAGE_CALLS_DESKTOP_KEY, JSON.stringify(prefs));
}
