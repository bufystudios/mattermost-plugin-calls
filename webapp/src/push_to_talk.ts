// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// Configurable push-to-talk (PTT).
//
// A plugin cannot register a global hotkey, so this only works while a
// Mattermost window has keyboard focus. The key handling is hoisted out of the
// individual components so the main window, the call widget and the pop out
// all behave the same:
//
// - every window that loads the plugin installs one document level listener;
// - the window that owns the CallsClient (web: the main window, desktop: the
//   widget window) mutes/unmutes directly, a pop out uses the opener's client;
// - a window that has no client at all (desktop main window while the call
//   lives in the widget window) forwards press/release through a
//   BroadcastChannel to the window that owns it.

import {getPushToTalkConfig, isModifierCode, type PushToTalkConfig} from 'src/voice_input_prefs';

const nonTextInputTypes = new Set([
    'button', 'checkbox', 'radio', 'range', 'color', 'file', 'image', 'reset', 'submit',
]);

// True when the event target is somewhere the user is typing text: pressing a
// PTT key there must keep typing normally and must not open the mic.
export function isTypingTarget(target: EventTarget | null): boolean {
    // Duck typing instead of instanceof: the target may belong to another window (pop out).
    const el = target as HTMLElement | null;
    if (!el || typeof el.tagName !== 'string') {
        return false;
    }

    const tag = el.tagName.toUpperCase();
    if (tag === 'TEXTAREA' || tag === 'SELECT') {
        return true;
    }
    if (tag === 'INPUT') {
        const type = ((el as HTMLInputElement).type || 'text').toLowerCase();
        return !nonTextInputTypes.has(type);
    }

    if (el.isContentEditable) {
        return true;
    }
    const editable = typeof el.closest === 'function' ? el.closest('[contenteditable], [role="textbox"]') : null;
    if (editable) {
        return editable.getAttribute('contenteditable') !== 'false';
    }

    return false;
}

export type PushToTalkDeps = {

    // Read on every key event so a change in the settings applies immediately, in every window.
    getConfig: () => PushToTalkConfig;

    // Whether there is a call this window can act on. Without it the key is left alone.
    canHandle: () => boolean;
    press: () => void;
    release: () => void;
};

export class PushToTalkHandler {
    private deps: PushToTalkDeps;
    private heldCode = '';

    constructor(deps: PushToTalkDeps) {
        this.deps = deps;
    }

    public get isHeld() {
        return this.heldCode !== '';
    }

    public onKeyDown = (ev: KeyboardEvent) => {
        const config = this.deps.getConfig();
        if (!config.enabled || ev.code !== config.code || !this.deps.canHandle()) {
            return;
        }

        if (this.isHeld) {
            // Auto-repeat while the key is held.
            if (ev.repeat) {
                ev.preventDefault();
            }
            return;
        }

        if (ev.isComposing || isTypingTarget(ev.target)) {
            return;
        }

        // A normal key combined with ctrl/alt/meta is some other shortcut (copy, ...), not PTT.
        // The configured key being a modifier itself is of course fine.
        if (!isModifierCode(config.code) && (ev.ctrlKey || ev.altKey || ev.metaKey)) {
            return;
        }

        this.heldCode = config.code;
        if (!isModifierCode(config.code)) {
            ev.preventDefault();
        }
        this.deps.press();
    };

    public onKeyUp = (ev: KeyboardEvent) => {
        // Intentionally not filtered by typing target or config: once talking, the release must always
        // go through or the mic would stay open.
        if (this.isHeld && ev.code === this.heldCode) {
            this.releaseNow();
        }
    };

    // Window blur / tab hidden: we will never see the keyup.
    public onFocusLost = () => {
        if (this.isHeld) {
            this.releaseNow();
        }
    };

    private releaseNow() {
        this.heldCode = '';
        this.deps.release();
    }
}

type PTTMessage = {type: 'press' | 'release' | 'config'};

const PTT_CHANNEL_NAME = 'calls_push_to_talk';

type ClientLike = {
    mute: () => void;
    unmute: () => void | Promise<void>;
    applyNoiseSuppression?: () => Promise<void>;
    audioTrack?: {enabled: boolean} | null;
};

type InitOptions = {

    // The client in this window or, for a pop out, in its opener.
    getClient?: () => ClientLike | undefined;

    // Whether the current user is in a call even though this window has no client (desktop main window).
    isInCall?: () => boolean;
};

function defaultGetClient(win: Window): ClientLike | undefined {
    return (win as unknown as {callsClient?: ClientLike}).callsClient ??
        (win.opener as unknown as {callsClient?: ClientLike} | null)?.callsClient;
}

// Installs push-to-talk in a window. Returns a function that removes it.
export function initPushToTalk(win: Window = window, options: InitOptions = {}): () => void {
    const getClient = options.getClient ?? (() => defaultGetClient(win));

    let channel: BroadcastChannel | null = null;
    try {
        channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(PTT_CHANNEL_NAME);
    } catch {
        channel = null;
    }

    const post = (msg: PTTMessage) => {
        try {
            channel?.postMessage(msg);
        } catch {
            // Channel already closed.
        }
    };

    const handler = new PushToTalkHandler({
        getConfig: getPushToTalkConfig,
        canHandle: () => Boolean(getClient()) || Boolean(options.isInCall?.()),
        press: () => {
            const client = getClient();
            if (client) {
                client.unmute();
            } else {
                post({type: 'press'});
            }
        },
        release: () => {
            const client = getClient();
            if (client) {
                client.mute();
            } else {
                post({type: 'release'});
            }
        },
    });

    // Windows that own a client act on messages from windows that don't.
    const onMessage = (ev: MessageEvent<PTTMessage>) => {
        const client = (win as unknown as {callsClient?: ClientLike}).callsClient;
        if (!client) {
            return;
        }
        switch (ev.data?.type) {
        case 'press':
            if (getPushToTalkConfig().enabled) {
                client.unmute();
            }
            break;
        case 'release':
            client.mute();
            break;
        case 'config':
            applyVoiceInputPrefs(client);
            break;
        }
    };
    if (channel) {
        channel.onmessage = onMessage;
    }

    const onVisibility = () => {
        if (win.document.visibilityState === 'hidden') {
            handler.onFocusLost();
        }
    };

    win.document.addEventListener('keydown', handler.onKeyDown, true);
    win.document.addEventListener('keyup', handler.onKeyUp, true);
    win.addEventListener('blur', handler.onFocusLost);
    win.document.addEventListener('visibilitychange', onVisibility);

    return () => {
        win.document.removeEventListener('keydown', handler.onKeyDown, true);
        win.document.removeEventListener('keyup', handler.onKeyUp, true);
        win.removeEventListener('blur', handler.onFocusLost);
        win.document.removeEventListener('visibilitychange', onVisibility);
        channel?.close();
    };
}

// While push-to-talk is on the mic must be closed unless the key is held. Called
// when the setting is turned on, so someone who was unmuted does not stay open.
export function enforcePushToTalkMute(client: ClientLike | undefined) {
    if (client?.audioTrack?.enabled && getPushToTalkConfig().enabled) {
        client.mute();
    }
}

function applyVoiceInputPrefs(client: ClientLike) {
    enforcePushToTalkMute(client);
    client.applyNoiseSuppression?.();
}

// Tells every window (including this one) that a voice input setting (push-to-talk key,
// noise suppression) changed, so the window that owns the client applies it right away.
export function notifyVoiceInputPrefsChanged(win: Window = window) {
    const client = (win as unknown as {callsClient?: ClientLike}).callsClient;
    if (client) {
        applyVoiceInputPrefs(client);
    }
    try {
        const channel = new BroadcastChannel(PTT_CHANNEL_NAME);
        channel.postMessage({type: 'config'} as PTTMessage);
        channel.close();
    } catch {
        // No BroadcastChannel: windows without a client keep their old behaviour until the next key press.
    }
}

// True when the mute button/shortcut must not toggle the mic because push-to-talk owns it.
export function isPushToTalkActive(): boolean {
    return getPushToTalkConfig().enabled;
}
