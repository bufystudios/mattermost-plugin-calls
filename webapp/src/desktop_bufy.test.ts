// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {EventEmitter} from 'events';

import {
    attachDesktopIntegration,
    claimMuteToggle,
    DesktopIntegration,
    getBufyAPI,
    getDesktopBindingInfo,
    isGlobalMuteActive,
    isGlobalPttActive,
    MUTE_ACCELERATOR,
    MUTE_SHORTCUT_ID,
    resetDesktopIntegration,
} from './desktop_bufy';
import {setDesktopPrefs, setPushToTalkConfig} from './voice_input_prefs';

jest.mock('./log');

type Listener = (...args: any[]) => void;

// A fake window.desktopAPI.bufy that records calls and lets the test fire its events.
function fakeBufy(caps: Partial<any> = {}) {
    const listeners: {[event: string]: Listener[]} = {};
    const on = (event: string) => (listener: Listener) => {
        (listeners[event] ||= []).push(listener);
        return () => {
            listeners[event] = listeners[event].filter((l) => l !== listener);
        };
    };
    const ok = jest.fn(async () => ({ok: true}));
    const api: any = {
        version: '1.1.0',
        getCapabilities: jest.fn(async () => ({
            version: '1.1.0',
            platform: 'linux',
            overlay: true,
            globalKeys: true,
            globalKeysBackend: 'uiohook',
            keyCapture: true,
            globalKeysPermission: 'not-required',
            shortcuts: true,
            tray: true,
            ...caps,
        })),
        showShareBorder: jest.fn(async () => ({ok: true, target: 'window'})),
        hideShareBorder: jest.fn(ok),
        onShareBorderLost: on('borderLost'),
        registerPushToTalk: jest.fn(async () => ({ok: true, backend: 'uiohook'})),
        unregisterPushToTalk: jest.fn(ok),
        onPttDown: on('pttDown'),
        onPttUp: on('pttUp'),
        registerShortcut: jest.fn(async () => ({ok: true, backend: 'electron'})),
        unregisterShortcut: jest.fn(ok),
        onShortcut: on('shortcut'),
        onShortcutTriggerChanged: on('trigger'),
        setVoiceStatus: jest.fn(ok),
        onTrayAction: on('tray'),
    };
    return {
        api,
        emit: (event: string, ...args: any[]) => (listeners[event] || []).slice().forEach((l) => l(...args)),
        listenerCount: () => Object.values(listeners).reduce((n, l) => n + l.length, 0),
    };
}

class FakeClient extends EventEmitter {
    audioTrack: {enabled: boolean} | null = {enabled: false};
    sourceID = '';
    stream: any = null;
    mute = jest.fn(() => {
        this.audioTrack!.enabled = false;
        this.emit('mute');
    });
    unmute = jest.fn(async () => {
        this.audioTrack!.enabled = true;
        this.emit('unmute');
    });
    unshareScreen = jest.fn(() => this.endShare());
    disconnect = jest.fn(() => this.emit('close'));
    getLocalScreenSourceID = () => this.sourceID;
    getLocalScreenStream = () => this.stream;

    videoTrack: any;
    startShare(sourceID: string) {
        this.sourceID = sourceID;
        const handlers: Listener[] = [];
        this.videoTrack = {addEventListener: (_: string, l: Listener) => handlers.push(l), end: () => handlers.forEach((l) => l())};
        this.stream = {getVideoTracks: () => [this.videoTrack]};
        this.emit('localScreenStream', this.stream);
    }
    endShare() {
        this.videoTrack?.end();
        this.stream = null;
        this.sourceID = '';
    }
}

const flush = async () => {
    for (let i = 0; i < 6; i++) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => setTimeout(resolve, 0));
    }
};

const options = {getRoomName: () => 'Alice', getLabels: (ptt: string | null) => (ptt ? {unmute: `PTT ${ptt}`} : {mute: 'Mute'})};

describe('desktop integration (window.desktopAPI.bufy)', () => {
    let bufy: ReturnType<typeof fakeBufy>;
    let client: FakeClient;

    const start = async (caps: Partial<any> = {}) => {
        bufy = fakeBufy(caps);
        client = new FakeClient();
        (window as any).desktopAPI = {bufy: bufy.api};
        const integration = attachDesktopIntegration(client as any, options);
        await flush();
        return integration!;
    };

    afterEach(async () => {
        resetDesktopIntegration();
        await flush();
        delete (window as any).desktopAPI;
        window.localStorage.clear();
    });

    describe('feature detection', () => {
        it('does nothing in a browser or in the stock app', () => {
            expect(getBufyAPI()).toBeUndefined();
            expect(attachDesktopIntegration(new FakeClient() as any, options)).toBeNull();

            (window as any).desktopAPI = {};
            expect(getBufyAPI()).toBeUndefined();
            expect(attachDesktopIntegration(new FakeClient() as any, options)).toBeNull();
            expect(isGlobalPttActive()).toBe(false);
        });

        it('is used when the API has a version', async () => {
            await start();
            expect(bufy.api.getCapabilities).toHaveBeenCalled();
        });

        it('attaching the same client twice gives the same integration (one owner per window)', async () => {
            const first = await start();
            expect(attachDesktopIntegration(client as any, options)).toBe(first);
            expect(bufy.api.getCapabilities).toHaveBeenCalledTimes(1);
        });
    });

    describe('global push to talk', () => {
        beforeEach(() => setPushToTalkConfig({enabled: true, code: 'KeyV'}));

        it('registers the chosen key and opens and closes the mic with it', async () => {
            await start();
            expect(bufy.api.registerPushToTalk).toHaveBeenCalledWith({key: 'KeyV'});
            expect(isGlobalPttActive()).toBe(true);

            bufy.emit('pttDown');
            expect(client.unmute).toHaveBeenCalledTimes(1);
            bufy.emit('pttUp');
            expect(client.mute).toHaveBeenCalledTimes(1);
        });

        it('takes a mouse button as the key', async () => {
            setPushToTalkConfig({enabled: true, code: 'Mouse4'});
            await start();
            expect(bufy.api.registerPushToTalk).toHaveBeenCalledWith({key: 'Mouse4'});
        });

        it('does not register when push to talk is off, or the background option is off', async () => {
            setPushToTalkConfig({enabled: false, code: 'KeyV'});
            await start();
            expect(bufy.api.registerPushToTalk).not.toHaveBeenCalled();
            expect(isGlobalPttActive()).toBe(false);
            bufy.emit('pttDown');
            expect(client.unmute).not.toHaveBeenCalled();
            resetDesktopIntegration();

            setPushToTalkConfig({enabled: true, code: 'KeyV'});
            setDesktopPrefs({background: false, shareBorder: true});
            await start();
            expect(bufy.api.registerPushToTalk).not.toHaveBeenCalled();
        });

        it('stays out of the way when global keys are not available (the in-window handler keeps working)', async () => {
            await start({globalKeys: false, globalKeysReason: 'wayland-no-portal'});
            expect(bufy.api.registerPushToTalk).not.toHaveBeenCalled();
            expect(isGlobalPttActive()).toBe(false);
        });

        it('falls back to the in-window handler when the registration fails', async () => {
            bufy = fakeBufy();
            bufy.api.registerPushToTalk.mockResolvedValue({ok: false, error: 'in-use'});
            client = new FakeClient();
            (window as any).desktopAPI = {bufy: bufy.api};
            attachDesktopIntegration(client as any, options);
            await flush();

            expect(isGlobalPttActive()).toBe(false);
            bufy.emit('pttDown');
            expect(client.unmute).not.toHaveBeenCalled();
        });

        it('on Wayland (portal) remembers what the system bound and follows later changes', async () => {
            bufy = fakeBufy({globalKeysBackend: 'portal', keyCapture: false});
            bufy.api.registerPushToTalk.mockResolvedValue({ok: true, backend: 'portal', trigger: 'Ctrl+Alt+P'});
            client = new FakeClient();
            (window as any).desktopAPI = {bufy: bufy.api};
            attachDesktopIntegration(client as any, options);
            await flush();

            expect(getDesktopBindingInfo()).toMatchObject({backend: 'portal', pttTrigger: 'Ctrl+Alt+P'});
            bufy.emit('trigger', {id: 'ptt', trigger: ''});
            expect(getDesktopBindingInfo().pttTrigger).toBe('');
        });

        it('re-registers when the key changes in the settings, and unregisters when it is turned off', async () => {
            await start();
            bufy.api.registerPushToTalk.mockClear();

            setPushToTalkConfig({enabled: true, code: 'Mouse5'});
            await flush();
            expect(bufy.api.registerPushToTalk).toHaveBeenCalledWith({key: 'Mouse5'});

            setPushToTalkConfig({enabled: false, code: 'Mouse5'});
            await flush();
            expect(bufy.api.unregisterPushToTalk).toHaveBeenCalled();
            expect(isGlobalPttActive()).toBe(false);
        });
    });

    describe('global mute shortcut', () => {
        it('uses the same combination as the in-window mute shortcut and toggles the mic', async () => {
            await start();
            expect(bufy.api.registerShortcut).toHaveBeenCalledWith({id: MUTE_SHORTCUT_ID, accelerator: MUTE_ACCELERATOR});
            expect(MUTE_ACCELERATOR).toBe('CommandOrControl+Shift+Space');
            expect(isGlobalMuteActive()).toBe(true);

            bufy.emit('shortcut', MUTE_SHORTCUT_ID);
            expect(client.unmute).toHaveBeenCalledTimes(1);
        });

        it('ignores a second delivery of the same key press (no double trigger with the in-window shortcut)', async () => {
            await start();
            expect(claimMuteToggle()).toBe(true); // the in-window handler got there first
            bufy.emit('shortcut', MUTE_SHORTCUT_ID);
            expect(client.unmute).not.toHaveBeenCalled();
            expect(client.mute).not.toHaveBeenCalled();
        });

        it('is not registered while push to talk owns the mic, nor without the background option', async () => {
            setPushToTalkConfig({enabled: true, code: 'KeyV'});
            await start();
            expect(bufy.api.registerShortcut).not.toHaveBeenCalled();
            bufy.emit('shortcut', MUTE_SHORTCUT_ID);
            expect(client.unmute).not.toHaveBeenCalled();
            resetDesktopIntegration();

            setPushToTalkConfig({enabled: false, code: 'KeyV'});
            setDesktopPrefs({background: false, shareBorder: true});
            await start();
            expect(bufy.api.registerShortcut).not.toHaveBeenCalled();
        });

        it('is registered when push to talk gets turned off', async () => {
            setPushToTalkConfig({enabled: true, code: 'KeyV'});
            await start();
            setPushToTalkConfig({enabled: false, code: 'KeyV'});
            await flush();
            expect(bufy.api.registerShortcut).toHaveBeenCalledTimes(1);
            expect(bufy.api.unregisterPushToTalk).toHaveBeenCalled();
        });
    });

    describe('screen share border', () => {
        it('is shown for the source picked in the desktop source picker, and hidden when the share ends', async () => {
            await start();
            client.startShare('window:1234:0');
            await flush();
            expect(bufy.api.showShareBorder).toHaveBeenCalledWith({sourceId: 'window:1234:0'});

            client.endShare();
            await flush();
            expect(bufy.api.hideShareBorder).toHaveBeenCalled();
        });

        it('is not shown for a browser-picked share (no source id), or when the setting is off', async () => {
            await start();
            client.startShare('');
            await flush();
            expect(bufy.api.showShareBorder).not.toHaveBeenCalled();
            client.endShare();
            resetDesktopIntegration();

            setDesktopPrefs({background: true, shareBorder: false});
            await start();
            client.startShare('screen:0:0');
            await flush();
            expect(bufy.api.showShareBorder).not.toHaveBeenCalled();
        });

        it('follows the setting while sharing', async () => {
            await start();
            client.startShare('screen:0:0');
            await flush();
            expect(bufy.api.showShareBorder).toHaveBeenCalledTimes(1);

            setDesktopPrefs({background: true, shareBorder: false});
            await flush();
            expect(bufy.api.hideShareBorder).toHaveBeenCalled();

            // Another pref change does not flicker the border.
            bufy.api.showShareBorder.mockClear();
            setDesktopPrefs({background: true, shareBorder: true});
            await flush();
            expect(bufy.api.showShareBorder).toHaveBeenCalledTimes(1);
            setPushToTalkConfig({enabled: false, code: 'KeyV'});
            await flush();
            expect(bufy.api.showShareBorder).toHaveBeenCalledTimes(1);
        });

        it('stops the share when the shared window is closed', async () => {
            await start();
            client.startShare('window:1:0');
            bufy.emit('borderLost');
            expect(client.unshareScreen).toHaveBeenCalled();
        });

        it('does nothing without the overlay capability', async () => {
            await start({overlay: false});
            client.startShare('screen:0:0');
            await flush();
            expect(bufy.api.showShareBorder).not.toHaveBeenCalled();
        });
    });

    describe('tray', () => {
        it('shows the voice status and follows mute and sharing', async () => {
            await start();
            expect(bufy.api.setVoiceStatus).toHaveBeenLastCalledWith(expect.objectContaining({connected: true, muted: true, live: false, roomName: 'Alice'}));

            await client.unmute();
            await flush();
            expect(bufy.api.setVoiceStatus).toHaveBeenLastCalledWith(expect.objectContaining({muted: false}));

            client.startShare('screen:0:0');
            await flush();
            expect(bufy.api.setVoiceStatus).toHaveBeenLastCalledWith(expect.objectContaining({live: true}));
        });

        it('routes tray actions: mute, stop sharing, leave', async () => {
            await start();
            bufy.emit('tray', 'toggleMute');
            expect(client.unmute).toHaveBeenCalled();

            bufy.emit('tray', 'stopSharing');
            expect(client.unshareScreen).toHaveBeenCalled();

            bufy.emit('tray', 'toggleDeafen'); // Calls has no deafen
            expect(client.disconnect).not.toHaveBeenCalled();

            bufy.emit('tray', 'leave');
            expect(client.disconnect).toHaveBeenCalled();
        });

        it('with push to talk the mute item is a notice that does nothing', async () => {
            setPushToTalkConfig({enabled: true, code: 'KeyV'});
            await start();
            expect(bufy.api.setVoiceStatus).toHaveBeenLastCalledWith(expect.objectContaining({labels: {unmute: 'PTT KeyV'}}));
            bufy.emit('tray', 'toggleMute');
            expect(client.unmute).not.toHaveBeenCalled();
        });

        it('is not touched when the app has no tray', async () => {
            await start({tray: false});
            expect(bufy.api.setVoiceStatus).not.toHaveBeenCalled();
        });
    });

    describe('lifecycle', () => {
        it('releases everything when the call ends', async () => {
            setPushToTalkConfig({enabled: true, code: 'KeyV'});
            await start();
            client.startShare('screen:0:0');
            await flush();
            expect(bufy.listenerCount()).toBeGreaterThan(0);

            client.emit('close');
            await flush();

            expect(bufy.api.unregisterPushToTalk).toHaveBeenCalled();
            expect(bufy.api.unregisterShortcut).toHaveBeenCalledWith(MUTE_SHORTCUT_ID);
            expect(bufy.api.hideShareBorder).toHaveBeenCalled();
            expect(bufy.api.setVoiceStatus).toHaveBeenLastCalledWith({connected: false});
            expect(bufy.listenerCount()).toBe(0);
            expect(client.listenerCount('mute')).toBe(0);
            expect(isGlobalPttActive()).toBe(false);
            expect(isGlobalMuteActive()).toBe(false);
        });

        it('a stopped integration ignores events and settings changes', async () => {
            setPushToTalkConfig({enabled: true, code: 'KeyV'});
            const integration = await start();
            await integration.stop();
            bufy.api.registerPushToTalk.mockClear();

            setPushToTalkConfig({enabled: true, code: 'KeyB'});
            await flush();
            expect(bufy.api.registerPushToTalk).not.toHaveBeenCalled();
            await integration.stop();
        });

        it('calls that fail never reject into the call', async () => {
            bufy = fakeBufy();
            bufy.api.getCapabilities.mockRejectedValue(new Error('ipc'));
            client = new FakeClient();
            (window as any).desktopAPI = {bufy: bufy.api};
            expect(() => attachDesktopIntegration(client as any, options)).not.toThrow();
            await flush();
            expect(bufy.api.registerPushToTalk).not.toHaveBeenCalled();
        });
    });

    it('DesktopIntegration can be used directly with a given API', async () => {
        bufy = fakeBufy();
        client = new FakeClient();
        const integration = new DesktopIntegration(bufy.api, client as any, options);
        await integration.start();
        expect(bufy.api.registerShortcut).toHaveBeenCalled();
        await integration.stop();
    });
});
