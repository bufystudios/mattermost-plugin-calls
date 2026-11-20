// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {getCallShortcuts, shortcutKeyNames} from './shortcut_list';
import {keyMappings} from './shortcuts';

describe('shortcut list', () => {
    it('lists the upstream shortcuts with the keys that really work', () => {
        const list = getCallShortcuts({isDM: false});
        const byAction = Object.fromEntries(list.map((e) => [e.action, e.keys]));

        expect(Object.keys(byAction)).toEqual([
            'mute-unmute', 'raise-lower-hand', 'share-unshare-screen', 'participants-list-toggle', 'leave-call',
            'make-reaction', 'recording-toggle', 'join-call',
        ]);
        for (const [action, keys] of Object.entries(byAction)) {
            for (const key of keys) {
                expect(Object.values(keyMappings).some((m) => m[key] === action)).toBe(true);
            }
        }
        expect(byAction['mute-unmute'][0]).toMatch(/^(ctrl|meta)\+shift\+space$/);
        expect(byAction['participants-list-toggle']).toHaveLength(2);
    });

    it('has no participants shortcut in a DM and marks pop out only ones', () => {
        const list = getCallShortcuts({isDM: true});
        expect(list.find((e) => e.action === 'participants-list-toggle')).toBeUndefined();
        expect(list.filter((e) => e.popoutOnly).map((e) => e.action)).toEqual(['make-reaction', 'recording-toggle']);
    });

    it('names keys for Windows / Linux and for a Mac', () => {
        expect(shortcutKeyNames('ctrl+shift+space', false)).toEqual(['Ctrl', 'Shift', 'Space']);
        expect(shortcutKeyNames('meta+shift+y', true)).toEqual(['⌘', '⇧', 'Y']);
        expect(shortcutKeyNames('alt+p', true)).toEqual(['⌥', 'P']);
        expect(shortcutKeyNames('alt+p', false)).toEqual(['Alt', 'P']);
    });
});
