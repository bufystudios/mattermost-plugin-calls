// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {UserSessionState} from '@mattermost/calls-common/lib/types';
import {GlobalState} from '@mattermost/types/store';
import {useEffect} from 'react';
import {useDispatch, useSelector} from 'react-redux';
import {LOCAL_SPEAKING} from 'src/action_types';
import {isSessionSpeakingSelector, localSpeakingSessions} from 'src/selectors';
import type {LocalSpeakingState} from 'src/speaking';
import {getCallsClient} from 'src/utils';

// Hook version of the single "is speaking" selector (src/selectors.ts, src/speaking.ts).
export function useIsSessionSpeaking(session?: UserSessionState): boolean {
    return useSelector((state: GlobalState) => isSessionSpeakingSelector(state, session));
}

// The sessions measured as speaking locally (P2P). For callers that look at many sessions at once.
export function useLocalSpeaking(): LocalSpeakingState {
    return useSelector((state: GlobalState) => localSpeakingSessions(state));
}

// Mirrors the speaking levels the CallsClient measures in P2P calls into this window's store.
// The pop out has its own store but shares the opener's client, so it mounts this too.
// Renders nothing.
export default function SpeakingSync() {
    const dispatch = useDispatch();

    useEffect(() => {
        const client = getCallsClient();
        if (!client) {
            // eslint-disable-next-line no-undefined
            return undefined;
        }

        const report = (sessionID: string, speaking: boolean) => {
            dispatch({type: LOCAL_SPEAKING, data: {sessionID, speaking}});
        };
        const onSpeaking = ({sessionID, speaking}: {sessionID: string; speaking: boolean}) => report(sessionID, speaking);

        client.getSpeakingSessions().forEach((sessionID) => report(sessionID, true));
        client.on('speaking', onSpeaking);
        return () => {
            client.off('speaking', onSpeaking);
        };
    }, [dispatch]);

    return null;
}
