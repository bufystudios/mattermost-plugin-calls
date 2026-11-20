// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// Integration with window.desktopAPI.bufy, the API of our desktop app fork (docs/bufy-noise-desktop.md):
//
// - global push to talk (and the mute shortcut) that also work while Mattermost is in the background,
// - a border around the shared screen/window while sharing,
// - the tray icon: voice status and a menu to mute, stop sharing and leave.
//
// Everything is feature-detected (`window.desktopAPI?.bufy?.version`): in a browser or in the stock desktop app
// nothing here does anything.
//
// Which window: the one that owns the CallsClient (web: the main window, which never has the API; desktop: the
// call widget window). `attachDesktopIntegration` is called where the client is created, and at most one
// integration exists per window. The desktop main window has no client, so it never registers anything: its
// in-window push-to-talk handler only forwards key presses to the widget (push_to_talk.ts).

import {createIntl} from 'react-intl';
import {getDesktopPrefs, getPushToTalkConfig, keyCodeLabel, onVoiceInputPrefsChanged} from 'src/voice_input_prefs';

import {logDebug, logWarn} from './log';
import type {BufyAPI, BufyCapabilities, BufyWindow, TrayAction, TrayLabelKey} from './types/desktop_api_bufy';
import {getTranslations} from './utils';

// Electron accelerator of the global mute toggle. It is the same combination as Calls' in-window mute
// shortcut (Ctrl+Shift+Space, Cmd+Shift+Space on a Mac), so one habit works in both places.
export const MUTE_ACCELERATOR = 'CommandOrControl+Shift+Space';
export const MUTE_SHORTCUT_ID = 'toggle-mute';

// The part of CallsClient the integration needs.
export type DesktopClient = {
    mute: () => void;
    unmute: () => void | Promise<void>;
    unshareScreen: () => void;
    disconnect: () => void;
    audioTrack: {enabled: boolean} | null;
    getLocalScreenSourceID: () => string;
    getLocalScreenStream: () => MediaStream | null;
    on: (event: string, listener: (...args: any[]) => void) => unknown;
    off: (event: string, listener: (...args: any[]) => void) => unknown;
};

export type DesktopOptions = {

    // Name shown in the tray tooltip and menu.
    getRoomName: () => string;

    // Localized strings for the tray menu. While push to talk owns the microphone the "unmute" item is only a
    // notice (it does nothing), so the caller gets the push-to-talk key to say so.
    getLabels: (pttCode: string | null) => Partial<Record<TrayLabelKey, string>>;
};

// Options with the tray menu in the user's language. `getLocale` is read on every status push, the profile may
// not be loaded yet when the call starts.
export function desktopIntegrationOptions(getRoomName: () => string, getLocale: () => string | undefined): DesktopOptions {
    return {
        getRoomName,
        getLabels: (pttCode) => {
            const locale = getLocale() || 'en';
            const intl = createIntl({locale, defaultLocale: 'en', messages: getTranslations(locale)});
            const {formatMessage} = intl;
            const labels: Partial<Record<TrayLabelKey, string>> = {
                mute: formatMessage({defaultMessage: 'Mute'}),
                unmute: formatMessage({defaultMessage: 'Unmute'}),
                stopSharing: formatMessage({defaultMessage: 'Stop presenting'}),
                leave: formatMessage({defaultMessage: 'Leave call'}),
            };
            if (pttCode) {
                // Push to talk owns the mic: the item is a notice, it does nothing.
                labels.unmute = formatMessage({defaultMessage: 'Push to talk: hold {key}'}, {key: keyCodeLabel(pttCode)});
            }
            return labels;
        },
    };
}

export function getBufyAPI(win: Window = window): BufyAPI | undefined {
    const api = (win as BufyWindow).desktopAPI?.bufy;
    return api && api.version ? api : undefined;
}

// Last bindings the system reported, kept so the settings dialog (another window) can show them.
const INFO_KEY = 'calls_desktop_bindings';

export type DesktopBindingInfo = {
    backend?: string;

    // What the compositor bound for push to talk (Wayland portal), as it displays it. '' = not bound.
    pttTrigger?: string;
    muteTrigger?: string;
};

export function getDesktopBindingInfo(): DesktopBindingInfo {
    try {
        const raw = window.localStorage.getItem(INFO_KEY);
        return raw ? JSON.parse(raw) : {};
    } catch {
        return {};
    }
}

function saveBindingInfo(patch: Partial<DesktopBindingInfo>) {
    try {
        window.localStorage.setItem(INFO_KEY, JSON.stringify({...getDesktopBindingInfo(), ...patch}));
    } catch {
        // Only the settings display depends on it.
    }
}

// True while push to talk is registered as a global key in this window: the in-window key handler then stays
// out of the way, or one key press would open the mic twice.
let globalPttActive = false;

export function isGlobalPttActive(): boolean {
    return globalPttActive;
}

// True while the global mute shortcut is registered in this window.
let globalMuteActive = false;

export function isGlobalMuteActive(): boolean {
    return globalMuteActive;
}

// Calls' in-window mute shortcut and the global one can both be delivered for one key press (platform
// dependent). Whichever comes second within this window is dropped.
const DEDUPE_MS = 300;
let lastMuteToggle = 0;

export function claimMuteToggle(now: number = Date.now()): boolean {
    if (now - lastMuteToggle < DEDUPE_MS) {
        return false;
    }
    lastMuteToggle = now;
    return true;
}

export function resetMuteToggleClaim() {
    lastMuteToggle = 0;
}

type Registered = {
    ptt: string; // key of the registered push to talk, '' if none
    mute: boolean;
};

export class DesktopIntegration {
    private api: BufyAPI;
    private client: DesktopClient;
    private opts: DesktopOptions;
    private caps: BufyCapabilities | null = null;
    private registered: Registered = {ptt: '', mute: false};
    private queue: Promise<void> = Promise.resolve();
    private unsubscribers: Array<() => void> = [];
    private borderSource = '';
    private borderShown = '';
    private borderGeneration = 0;
    private stopped = false;
    private clientListeners: Array<[string, (...args: any[]) => void]> = [];

    constructor(api: BufyAPI, client: DesktopClient, opts: DesktopOptions) {
        this.api = api;
        this.client = client;
        this.opts = opts;
    }

    // Registers what the user's settings ask for and starts following the call. Resolves when the first round
    // of registrations is done (they may wait for a system dialog on Wayland).
    start(): Promise<void> {
        this.unsubscribers.push(
            this.api.onPttDown(() => this.onPttDown()),
            this.api.onPttUp(() => this.onPttUp()),
            this.api.onShortcut((id) => this.onShortcut(id)),
            this.api.onTrayAction((action) => this.onTrayAction(action)),
            this.api.onShareBorderLost(() => this.onBorderLost()),
            this.api.onShortcutTriggerChanged(({id, trigger}) => {
                if (id === 'ptt') {
                    saveBindingInfo({pttTrigger: trigger});
                } else if (id === MUTE_SHORTCUT_ID) {
                    saveBindingInfo({muteTrigger: trigger});
                }
            }),
            onVoiceInputPrefsChanged(() => this.reconcile()),
        );

        const listen = (event: string, listener: (...args: any[]) => void) => {
            this.client.on(event, listener);
            this.clientListeners.push([event, listener]);
        };
        listen('mute', () => this.pushStatus());
        listen('unmute', () => this.pushStatus());
        listen('localScreenStream', (stream: MediaStream) => this.onLocalScreen(stream));
        listen('close', () => this.stop());

        return this.reconcile();
    }

    // Everything is released: keys, border, tray status. Safe to call twice.
    stop(): Promise<void> {
        if (this.stopped) {
            return this.queue;
        }
        this.stopped = true;
        this.unsubscribers.forEach((unsubscribe) => unsubscribe());
        this.unsubscribers = [];
        this.clientListeners.forEach(([event, listener]) => this.client.off(event, listener));
        this.clientListeners = [];
        globalPttActive = false;
        globalMuteActive = false;
        this.borderSource = '';
        this.borderShown = '';
        this.borderGeneration++;
        return this.enqueue(async () => {
            await Promise.allSettled([
                this.api.unregisterPushToTalk(),
                this.api.unregisterShortcut(MUTE_SHORTCUT_ID),
                this.api.hideShareBorder(),
                this.api.setVoiceStatus({connected: false}),
            ]);
            this.registered = {ptt: '', mute: false};
        });
    }

    // The screen was shared (source id known to the client), or the settings changed: apply the border.
    onLocalScreen(stream: MediaStream | null) {
        const video = stream?.getVideoTracks?.()[0];
        if (!video) {
            return;
        }
        const generation = ++this.borderGeneration;
        const sourceId = this.client.getLocalScreenSourceID();
        this.borderSource = sourceId;
        video.addEventListener('ended', () => {
            if (this.borderGeneration === generation) {
                this.borderSource = '';
                this.enqueue(() => this.applyBorder());
                this.pushStatus();
            }
        });
        this.pushStatus();
        this.enqueue(() => this.applyBorder());
    }

    private enqueue(work: () => Promise<void>): Promise<void> {
        this.queue = this.queue.then(work).catch((err) => logWarn('desktop integration', err));
        return this.queue;
    }

    private async loadCaps(): Promise<BufyCapabilities | null> {
        if (!this.caps) {
            try {
                this.caps = await this.api.getCapabilities();
            } catch (err) {
                logWarn('desktop integration: capabilities', err);
            }
        }
        return this.caps;
    }

    // Brings the registrations in line with the settings. Called at the start and on every settings change.
    reconcile(): Promise<void> {
        return this.enqueue(async () => {
            if (this.stopped) {
                return;
            }
            const caps = await this.loadCaps();
            if (!caps || this.stopped) {
                return;
            }
            const prefs = getDesktopPrefs();
            const ptt = getPushToTalkConfig();

            // Push to talk
            const wantPTT = prefs.background && ptt.enabled && Boolean(ptt.code) && caps.globalKeys;
            const key = wantPTT ? ptt.code : '';
            if (key !== this.registered.ptt) {
                await this.applyPTT(key);
            }

            // The global mute toggle. Not while push to talk owns the microphone (it does nothing then).
            const wantMute = prefs.background && !ptt.enabled && caps.shortcuts;
            if (wantMute !== this.registered.mute) {
                await this.applyMuteShortcut(wantMute);
            }

            // Border: follows the setting while sharing.
            await this.applyBorder();
            this.pushStatusNow();
        });
    }

    private async applyPTT(key: string) {
        if (!key) {
            const result = await this.api.unregisterPushToTalk();
            if (!result.ok) {
                logWarn('desktop integration: unregisterPushToTalk', result);
            }
            this.registered.ptt = '';
            globalPttActive = false;
            return;
        }

        const result = await this.api.registerPushToTalk({key});
        if (result.ok) {
            this.registered.ptt = key;
            globalPttActive = true;
            saveBindingInfo({backend: result.backend, pttTrigger: result.trigger ?? ''});
            logDebug('desktop integration: global push to talk registered', key, result.backend);
        } else {
            // Not bound (key in use, permission missing, no portal, ...): the in-window handler keeps working.
            this.registered.ptt = '';
            globalPttActive = false;
            logWarn('desktop integration: registerPushToTalk failed', result);
        }
    }

    private async applyMuteShortcut(want: boolean) {
        if (!want) {
            await this.api.unregisterShortcut(MUTE_SHORTCUT_ID);
            this.registered.mute = false;
            globalMuteActive = false;
            return;
        }
        const result = await this.api.registerShortcut({id: MUTE_SHORTCUT_ID, accelerator: MUTE_ACCELERATOR});
        this.registered.mute = result.ok;
        globalMuteActive = result.ok;
        if (result.ok) {
            saveBindingInfo({muteTrigger: result.trigger ?? MUTE_ACCELERATOR});
        } else {
            logWarn('desktop integration: registerShortcut failed', result);
        }
    }

    private async applyBorder() {
        const wanted = this.borderSource;
        const caps = await this.loadCaps();
        const enabled = Boolean(caps?.overlay) && getDesktopPrefs().shareBorder && (/^(screen|window):/).test(wanted);
        if (!enabled) {
            if (this.borderShown) {
                this.borderShown = '';
                await this.api.hideShareBorder();
            }
            return;
        }
        if (this.borderShown === wanted) {
            return;
        }
        const result = await this.api.showShareBorder({sourceId: wanted});
        if (result.ok) {
            this.borderShown = wanted;
        } else {
            logWarn('desktop integration: showShareBorder failed', result);
        }
    }

    private onPttDown() {
        if (this.registered.ptt) {
            this.client.unmute();
        }
    }

    private onPttUp() {
        if (this.registered.ptt) {
            this.client.mute();
        }
    }

    private isMuted(): boolean {
        return !this.client.audioTrack?.enabled;
    }

    private toggleMute() {
        if (getPushToTalkConfig().enabled) {
            return;
        }
        if (!claimMuteToggle()) {
            return;
        }
        if (this.isMuted()) {
            this.client.unmute();
        } else {
            this.client.mute();
        }
    }

    private onShortcut(id: string) {
        if (id === MUTE_SHORTCUT_ID) {
            this.toggleMute();
        }
    }

    private onTrayAction(action: TrayAction) {
        switch (action) {
        case 'toggleMute':
            this.toggleMute();
            break;
        case 'stopSharing':
            this.client.unshareScreen();
            break;
        case 'leave':
            this.client.disconnect();
            break;

        // Calls has no deafen.
        default:
            break;
        }
    }

    private onBorderLost() {
        // The shared window was closed: the share ends with it.
        this.client.unshareScreen();
    }

    private pushStatus() {
        this.enqueue(async () => this.pushStatusNow());
    }

    private async pushStatusNow() {
        if (this.stopped) {
            return;
        }
        const caps = await this.loadCaps();
        if (!caps?.tray) {
            return;
        }
        const ptt = getPushToTalkConfig();
        await this.api.setVoiceStatus({
            connected: true,
            muted: this.isMuted(),
            live: Boolean(this.client.getLocalScreenStream()),
            roomName: this.opts.getRoomName(),
            labels: this.opts.getLabels(ptt.enabled && ptt.code ? ptt.code : null),
        });
    }
}

let current: {integration: DesktopIntegration; client: DesktopClient} | null = null;

// Starts the desktop integration for a client, if the Bufy API exists in this window. Returns the integration
// (or null). One per window: attaching the same client twice returns the first one.
export function attachDesktopIntegration(client: DesktopClient, opts: DesktopOptions, win: Window = window): DesktopIntegration | null {
    const api = getBufyAPI(win);
    if (!api) {
        return null;
    }
    if (current && current.client === client) {
        return current.integration;
    }
    current?.integration.stop();

    const integration = new DesktopIntegration(api, client, opts);
    current = {integration, client};
    integration.start().catch((err) => logWarn('desktop integration: start', err));
    return integration;
}

// For tests.
export function resetDesktopIntegration() {
    current?.integration.stop();
    current = null;
    globalPttActive = false;
    globalMuteActive = false;
    resetMuteToggleClaim();
}
