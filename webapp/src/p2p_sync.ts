// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {GlobalState} from '@mattermost/types/store';
import {getCurrentUserId} from 'mattermost-redux/selectors/entities/users';

import type CallsClient from './client';
import type {P2PContext} from './p2p';
import {isRecordingInCurrentCall, liveCaptionsStateForCurrentCall, sessionsInCurrentCall} from './selectors';

// Derives from the call state the inputs that decide whether the client can use
// peer-to-peer media (see p2p.ts). Server side checks are authoritative, this
// only avoids pointless attempts.
export function getP2PContext(state: GlobalState, mySessionID: string | undefined): P2PContext {
    const sessions = sessionsInCurrentCall(state);
    const mine = sessions.find((s) => s.session_id === mySessionID);
    const other = sessions.find((s) => s.session_id !== mySessionID);

    // Exactly two sessions, from two distinct users.
    const eligiblePeer = Boolean(mine) && sessions.length === 2 && other && other.user_id !== getCurrentUserId(state);

    const liveCaptions = liveCaptionsStateForCurrentCall(state);

    return {
        peerSessionID: eligiblePeer && other ? other.session_id : null,

        // Recording (which includes transcription) and live captions need the media on the server.
        serverMediaNeeded: isRecordingInCurrentCall(state) || liveCaptions.init_at > liveCaptions.end_at,
    };
}

// Keeps the client's P2P context up to date with the store. Returns the unsubscribe function.
export function syncP2PContext(store: {getState: () => GlobalState; subscribe: (cb: () => void) => () => void}, client: CallsClient) {
    let last = '';
    const update = () => {
        const ctx = getP2PContext(store.getState(), client.getSessionID());
        const key = `${ctx.peerSessionID}|${ctx.serverMediaNeeded}`;
        if (key === last) {
            return;
        }
        last = key;
        client.setP2PContext(ctx);
    };

    update();
    return store.subscribe(update);
}
