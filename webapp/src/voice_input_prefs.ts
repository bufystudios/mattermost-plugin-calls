// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// Client-side voice input preferences (noise suppression, push-to-talk).
// Like the other call prefs they live in localStorage, which is shared by all
// windows of the same origin (main window, call widget, pop out), so every
// window sees a change without extra plumbing.

import {STORAGE_CALLS_NOISE_SUPPRESSION_KEY, STORAGE_CALLS_PUSH_TO_TALK_KEY} from 'src/constants';

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

// Calls back whenever a voice input pref (noise suppression, push-to-talk) changes in this or any other
// window of the origin, so what is shown in the call widget / pop out follows the settings. Returns an unsubscribe.
export function onVoiceInputPrefsChanged(callback: () => void): () => void {
    const onStorage = (ev: StorageEvent) => {
        if (!ev.key || ev.key === STORAGE_CALLS_NOISE_SUPPRESSION_KEY || ev.key === STORAGE_CALLS_PUSH_TO_TALK_KEY) {
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

// Browser noise suppression is on unless the user turned it off.
export function getNoiseSuppression(): boolean {
    return readStorage(STORAGE_CALLS_NOISE_SUPPRESSION_KEY) !== 'false';
}

export function setNoiseSuppression(enabled: boolean) {
    writeStorage(STORAGE_CALLS_NOISE_SUPPRESSION_KEY, enabled ? 'true' : 'false');
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
