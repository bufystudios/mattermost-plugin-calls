// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// Click-to-watch for screen sharing ("Go Live").
//
// The share keeps arriving over the SFU/P2P connection regardless, so this is
// purely a UI opt-in: a viewer sees a LIVE card and only starts rendering the
// stream after clicking it. The watched share is remembered by the session id
// of the sharer and forgotten as soon as that session stops being the sharer,
// so a new share always starts as a LIVE card again.

export type WatchState = string | null;

export const notWatching: WatchState = null;

// Called with the current state whenever the sharing session changes.
// sharerSessionID is empty/undefined when nobody shares.
export function reconcileWatch(watching: WatchState, sharerSessionID?: string): WatchState {
    if (!sharerSessionID || watching !== sharerSessionID) {
        return notWatching;
    }
    return watching;
}

export function startWatching(sharerSessionID?: string): WatchState {
    return sharerSessionID || notWatching;
}

export type StreamView = 'none' | 'live-card' | 'player';

// What a participant sees for the current share:
// - the sharer always sees their own preview (no gate, they are not a viewer),
// - everybody else sees a LIVE card until they click it.
export function streamView(opts: {sharerSessionID?: string; mySessionID?: string; watching: WatchState}): StreamView {
    if (!opts.sharerSessionID) {
        return 'none';
    }
    if (opts.sharerSessionID === opts.mySessionID || opts.watching === opts.sharerSessionID) {
        return 'player';
    }
    return 'live-card';
}
