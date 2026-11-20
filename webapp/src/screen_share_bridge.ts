// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// Lets a window that does not own the call client (the desktop app's main window, while the call lives in the
// widget window) stop the screen share and show its quality. Same origin windows share a BroadcastChannel,
// push to talk (push_to_talk.ts) works the same way.

import type {ScreenQualityInfo} from 'src/client';
import {logDebug} from 'src/log';
import {getCallsClient} from 'src/utils';

const CHANNEL_NAME = 'calls_screen_share';

type Message =
    | {type: 'stop'}
    | {type: 'quality-request'}
    | {type: 'quality'; info: ScreenQualityInfo | null};

function open(): BroadcastChannel | null {
    try {
        return typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(CHANNEL_NAME);
    } catch {
        return null;
    }
}

function post(msg: Message) {
    const channel = open();
    try {
        channel?.postMessage(msg);
    } catch (err) {
        logDebug('screen share bridge: failed to post', err);
    }
    channel?.close();
}

// Stops the local screen share, from any window.
export function stopOwnScreenShare() {
    const client = getCallsClient();
    if (client) {
        client.unshareScreen();
        return;
    }
    post({type: 'stop'});
}

type BridgeClient = {
    unshareScreen: () => void;
    getScreenQualityInfo: () => ScreenQualityInfo | null;
    on: (event: string, cb: (info: ScreenQualityInfo) => void) => unknown;
    off: (event: string, cb: (info: ScreenQualityInfo) => void) => unknown;
};

// In the window that owns the client: acts on stop requests of other windows and tells them the
// quality of the share. Returns a function that removes it.
export function serveScreenShareBridge(getClient: () => BridgeClient | undefined | null): () => void {
    const channel = open();
    const sendQuality = (info: ScreenQualityInfo | null) => {
        try {
            channel?.postMessage({type: 'quality', info} as Message);
        } catch {
            // Channel closed or the info could not be cloned: the other window just has no label.
        }
    };

    if (channel) {
        channel.onmessage = (ev: MessageEvent<Message>) => {
            const client = getClient();
            if (ev.data?.type === 'stop') {
                client?.unshareScreen();
            } else if (ev.data?.type === 'quality-request') {
                // A window that just opened asks for the current quality.
                sendQuality(client?.getScreenQualityInfo() ?? null);
            }
        };
    }

    const client = getClient();
    client?.on('screenQuality', sendQuality);
    return () => {
        client?.off('screenQuality', sendQuality);
        channel?.close();
    };
}

// In a window without a client: calls back with the quality of the share, null when it is not known.
// Asks the owning window for the current value right away.
export function listenForScreenShareQuality(callback: (info: ScreenQualityInfo | null) => void): () => void {
    const channel = open();
    if (!channel) {
        // eslint-disable-next-line no-empty-function
        return () => {};
    }
    channel.onmessage = (ev: MessageEvent<Message>) => {
        if (ev.data?.type === 'quality') {
            callback(ev.data.info);
        }
    };
    try {
        channel.postMessage({type: 'quality-request'} as Message);
    } catch {
        // Nothing to ask.
    }
    return () => channel.close();
}
