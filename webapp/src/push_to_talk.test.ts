// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {initPushToTalk, isTypingTarget, PushToTalkHandler} from './push_to_talk';
import {getPushToTalkConfig, keyCodeLabel, pushToTalkDisabled, setPushToTalkConfig} from './voice_input_prefs';

const keyEvent = (type: 'keydown' | 'keyup', code: string, init: KeyboardEventInit = {}, target?: Element) => {
    const ev = new KeyboardEvent(type, {code, bubbles: true, cancelable: true, ...init});
    if (target) {
        Object.defineProperty(ev, 'target', {value: target});
    }
    return ev;
};

describe('isTypingTarget', () => {
    const el = (html: string) => {
        const div = document.createElement('div');
        div.innerHTML = html;
        document.body.appendChild(div);
        return div.firstElementChild as HTMLElement;
    };

    afterEach(() => {
        document.body.innerHTML = '';
    });

    it('treats text inputs and textareas as typing', () => {
        expect(isTypingTarget(el('<input type="text"/>'))).toBe(true);
        expect(isTypingTarget(el('<input/>'))).toBe(true);
        expect(isTypingTarget(el('<input type="search"/>'))).toBe(true);
        expect(isTypingTarget(el('<textarea></textarea>'))).toBe(true);
        expect(isTypingTarget(el('<select></select>'))).toBe(true);
    });

    it('treats contenteditable areas, and what is inside them, as typing', () => {
        const editor = el('<div contenteditable="true"><span id="inner">x</span></div>');
        expect(isTypingTarget(editor)).toBe(true);
        expect(isTypingTarget(editor.querySelector('#inner'))).toBe(true);
        expect(isTypingTarget(el('<div role="textbox"></div>'))).toBe(true);
    });

    it('does not treat buttons, checkboxes, sliders or the page itself as typing', () => {
        expect(isTypingTarget(el('<button>x</button>'))).toBe(false);
        expect(isTypingTarget(el('<input type="checkbox"/>'))).toBe(false);
        expect(isTypingTarget(el('<input type="range"/>'))).toBe(false);
        expect(isTypingTarget(el('<div contenteditable="false"></div>'))).toBe(false);
        expect(isTypingTarget(document.body)).toBe(false);
        expect(isTypingTarget(null)).toBe(false);
    });
});

describe('PushToTalkHandler', () => {
    let press: jest.Mock;
    let release: jest.Mock;
    let config: {enabled: boolean; code: string};
    let canHandle: boolean;
    let handler: PushToTalkHandler;

    beforeEach(() => {
        press = jest.fn();
        release = jest.fn();
        config = {enabled: true, code: 'KeyV'};
        canHandle = true;
        handler = new PushToTalkHandler({getConfig: () => config, canHandle: () => canHandle, press, release});
    });

    it('opens the mic on key down and closes it on key up', () => {
        handler.onKeyDown(keyEvent('keydown', 'KeyV'));
        expect(press).toHaveBeenCalledTimes(1);
        expect(handler.isHeld).toBe(true);

        handler.onKeyUp(keyEvent('keyup', 'KeyV'));
        expect(release).toHaveBeenCalledTimes(1);
        expect(handler.isHeld).toBe(false);
    });

    it('presses once while the key auto-repeats', () => {
        handler.onKeyDown(keyEvent('keydown', 'KeyV'));
        handler.onKeyDown(keyEvent('keydown', 'KeyV', {repeat: true}));
        handler.onKeyDown(keyEvent('keydown', 'KeyV', {repeat: true}));

        expect(press).toHaveBeenCalledTimes(1);
    });

    it('does nothing when push-to-talk is off', () => {
        config = {enabled: false, code: 'KeyV'};

        handler.onKeyDown(keyEvent('keydown', 'KeyV'));

        expect(press).not.toHaveBeenCalled();
    });

    it('ignores other keys', () => {
        handler.onKeyDown(keyEvent('keydown', 'KeyB'));
        handler.onKeyUp(keyEvent('keyup', 'KeyB'));

        expect(press).not.toHaveBeenCalled();
        expect(release).not.toHaveBeenCalled();
    });

    it('ignores the key while typing in an input, textarea or editable area', () => {
        for (const html of ['<input type="text"/>', '<textarea></textarea>', '<div contenteditable="true"></div>']) {
            const holder = document.createElement('div');
            holder.innerHTML = html;
            document.body.appendChild(holder);
            const target = holder.firstElementChild as HTMLElement;

            const ev = keyEvent('keydown', 'KeyV', {}, target);
            handler.onKeyDown(ev);

            expect(press).not.toHaveBeenCalled();

            // The key must still type its character, so it is not swallowed.
            expect(ev.defaultPrevented).toBe(false);
            holder.remove();
        }
    });

    it('does not try to talk without a call to act on', () => {
        canHandle = false;

        const ev = keyEvent('keydown', 'KeyV');
        handler.onKeyDown(ev);

        expect(press).not.toHaveBeenCalled();
        expect(ev.defaultPrevented).toBe(false);
    });

    it('swallows the key when it starts talking, so it does not also trigger the page', () => {
        const ev = keyEvent('keydown', 'KeyV');

        handler.onKeyDown(ev);

        expect(ev.defaultPrevented).toBe(true);
    });

    it('ignores the key combined with ctrl/alt/meta (some other shortcut)', () => {
        handler.onKeyDown(keyEvent('keydown', 'KeyV', {ctrlKey: true}));
        handler.onKeyDown(keyEvent('keydown', 'KeyV', {metaKey: true}));
        handler.onKeyDown(keyEvent('keydown', 'KeyV', {altKey: true}));

        expect(press).not.toHaveBeenCalled();
    });

    it('supports a modifier key as the push-to-talk key, without swallowing it', () => {
        config = {enabled: true, code: 'ControlLeft'};

        const ev = keyEvent('keydown', 'ControlLeft', {ctrlKey: true});
        handler.onKeyDown(ev);

        expect(press).toHaveBeenCalledTimes(1);
        expect(ev.defaultPrevented).toBe(false);
    });

    it('always lets go on key up, even if focus moved into an input meanwhile', () => {
        handler.onKeyDown(keyEvent('keydown', 'KeyV'));

        const input = document.createElement('input');
        document.body.appendChild(input);
        handler.onKeyUp(keyEvent('keyup', 'KeyV', {}, input));

        expect(release).toHaveBeenCalledTimes(1);
        input.remove();
    });

    it('lets go even if the setting was turned off while the key was held', () => {
        handler.onKeyDown(keyEvent('keydown', 'KeyV'));
        config = {enabled: false, code: 'KeyV'};

        handler.onKeyUp(keyEvent('keyup', 'KeyV'));

        expect(release).toHaveBeenCalledTimes(1);
    });

    it('lets go when the window loses focus (the key up is never seen)', () => {
        handler.onKeyDown(keyEvent('keydown', 'KeyV'));

        handler.onFocusLost();

        expect(release).toHaveBeenCalledTimes(1);
        expect(handler.isHeld).toBe(false);
    });

    it('does not release when nothing is held', () => {
        handler.onKeyUp(keyEvent('keyup', 'KeyV'));
        handler.onFocusLost();

        expect(release).not.toHaveBeenCalled();
    });
});

describe('initPushToTalk', () => {
    afterEach(() => {
        window.localStorage.clear();
    });

    it('unmutes the client while the configured key is held and mutes on release', () => {
        setPushToTalkConfig({enabled: true, code: 'KeyV'});
        const client = {mute: jest.fn(), unmute: jest.fn()};
        const dispose = initPushToTalk(window, {getClient: () => client});

        document.dispatchEvent(keyEvent('keydown', 'KeyV'));
        expect(client.unmute).toHaveBeenCalledTimes(1);

        document.dispatchEvent(keyEvent('keyup', 'KeyV'));
        expect(client.mute).toHaveBeenCalledTimes(1);

        dispose();
    });

    it('does nothing by default (off)', () => {
        const client = {mute: jest.fn(), unmute: jest.fn()};
        const dispose = initPushToTalk(window, {getClient: () => client});

        document.dispatchEvent(keyEvent('keydown', 'Space'));
        document.dispatchEvent(keyEvent('keydown', 'KeyV'));

        expect(client.unmute).not.toHaveBeenCalled();
        dispose();
    });

    it('stops listening once disposed', () => {
        setPushToTalkConfig({enabled: true, code: 'KeyV'});
        const client = {mute: jest.fn(), unmute: jest.fn()};
        initPushToTalk(window, {getClient: () => client})();

        document.dispatchEvent(keyEvent('keydown', 'KeyV'));

        expect(client.unmute).not.toHaveBeenCalled();
    });
});

describe('push-to-talk prefs', () => {
    afterEach(() => {
        window.localStorage.clear();
    });

    it('is off by default', () => {
        expect(getPushToTalkConfig()).toEqual(pushToTalkDisabled);
    });

    it('round trips the config', () => {
        setPushToTalkConfig({enabled: true, code: 'KeyV'});

        expect(getPushToTalkConfig()).toEqual({enabled: true, code: 'KeyV'});
    });

    it('never counts as set without a key, and survives garbage in storage', () => {
        window.localStorage.setItem('calls_push_to_talk', '{"enabled":true,"code":""}');
        expect(getPushToTalkConfig()).toEqual(pushToTalkDisabled);

        window.localStorage.setItem('calls_push_to_talk', 'not json');
        expect(getPushToTalkConfig()).toEqual(pushToTalkDisabled);
    });

    it('names keys for humans', () => {
        expect(keyCodeLabel('KeyV')).toBe('V');
        expect(keyCodeLabel('Digit5')).toBe('5');
        expect(keyCodeLabel('Space')).toBe('Space');
        expect(keyCodeLabel('ControlLeft')).toBe('Left Ctrl');
        expect(keyCodeLabel('CapsLock')).toBe('Caps Lock');
        expect(keyCodeLabel('')).toBe('');
    });
});
