// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// The keyboard shortcuts of a call, for the "Keyboard shortcuts" list (call widget menu, pop out menu).
// The key combinations come straight from shortcuts.ts, so the list cannot drift from what actually works.

import {
    JOIN_CALL,
    keyMappings,
    LEAVE_CALL,
    MAKE_REACTION,
    MUTE_UNMUTE,
    PARTICIPANTS_LIST_TOGGLE,
    RAISE_LOWER_HAND,
    RECORDING_TOGGLE,
    SHARE_UNSHARE_SCREEN,
} from 'src/shortcuts';

export type ShortcutEntry = {

    // One of the action names of shortcuts.ts.
    action: string;

    // Key sequences in shortcuts.ts notation ("ctrl+shift+space", "meta+shift+y" on a Mac).
    keys: string[];

    // Only works in the pop out (expanded view) window.
    popoutOnly?: boolean;
};

// Where an action is found, in the order the list shows them.
const order: Array<{action: string; scope: 'global' | 'widget' | 'popout'; popoutOnly?: boolean; notInDM?: boolean}> = [
    {action: MUTE_UNMUTE, scope: 'widget'},
    {action: RAISE_LOWER_HAND, scope: 'widget'},
    {action: SHARE_UNSHARE_SCREEN, scope: 'widget'},
    {action: PARTICIPANTS_LIST_TOGGLE, scope: 'widget', notInDM: true},
    {action: LEAVE_CALL, scope: 'widget'},
    {action: MAKE_REACTION, scope: 'popout', popoutOnly: true},
    {action: RECORDING_TOGGLE, scope: 'popout', popoutOnly: true},
    {action: JOIN_CALL, scope: 'global'},
];

export function getCallShortcuts(opts: {isDM: boolean}): ShortcutEntry[] {
    const entries: ShortcutEntry[] = [];
    for (const item of order) {
        if (item.notInDM && opts.isDM) {
            continue;
        }
        const keys = Object.entries(keyMappings[item.scope]).filter(([, action]) => action === item.action).map(([sequence]) => sequence);
        if (keys.length > 0) {
            entries.push({action: item.action, keys, popoutOnly: item.popoutOnly});
        }
    }
    return entries;
}

const macSymbols: {[key: string]: string} = {
    meta: '⌘',
    alt: '⌥',
    shift: '⇧',
    ctrl: '⌃',
};

const names: {[key: string]: string} = {
    ctrl: 'Ctrl',
    alt: 'Alt',
    shift: 'Shift',
    meta: 'Meta',
    space: 'Space',
};

// "ctrl+shift+space" -> ['Ctrl', 'Shift', 'Space'], on a Mac ['⌃', '⇧', 'Space'] (the mappings use meta there: ['⌘', '⇧', 'Space']).
export function shortcutKeyNames(sequence: string, mac: boolean): string[] {
    return sequence.split('+').map((key) => {
        if (mac && macSymbols[key]) {
            return macSymbols[key];
        }
        return names[key] ?? (key.length === 1 ? key.toUpperCase() : key);
    });
}
