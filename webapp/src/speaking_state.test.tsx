// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {act, render} from '@testing-library/react';
import {EventEmitter} from 'events';
import React from 'react';
import {Provider} from 'react-redux';
import {LOCAL_SESSION_CLOSE, LOCAL_SPEAKING} from 'src/action_types';
import SpeakingSync, {useIsSessionSpeaking} from 'src/components/use_speaking';
import pluginReducer from 'src/reducers';
import {isSessionSpeakingSelector, localSpeakingSessions} from 'src/selectors';
import {mockStore} from 'src/testUtils';

const reduce = (state: any, action: any) => pluginReducer(state, action);
const initial = reduce(undefined, {type: '@@INIT'});

const speaking = (sessionID: string, on: boolean) => ({type: LOCAL_SPEAKING, data: {sessionID, speaking: on}});

describe('local speaking state', () => {
    it('records who the client measured as speaking', () => {
        let state = reduce(initial, speaking('s1', true));
        state = reduce(state, speaking('s2', true));

        expect(state.localSpeaking).toEqual({s1: true, s2: true});

        state = reduce(state, speaking('s1', false));
        expect(state.localSpeaking).toEqual({s2: true});
    });

    it('keeps the same object for no-op updates (no needless re-renders)', () => {
        const state = reduce(initial, speaking('s1', true));

        expect(reduce(state, speaking('s1', true)).localSpeaking).toBe(state.localSpeaking);
        expect(reduce(state, speaking('other', false)).localSpeaking).toBe(state.localSpeaking);
    });

    it('is cleared when the local session closes', () => {
        const state = reduce(reduce(initial, speaking('s1', true)), {type: LOCAL_SESSION_CLOSE, data: {}});

        expect(state.localSpeaking).toEqual({});
    });
});

describe('isSessionSpeakingSelector', () => {
    const globalState = (localSpeaking: Record<string, boolean>) => ({
        'plugins-com.mattermost.calls': {...initial, localSpeaking},
    }) as any;

    it('combines server voice activity (SFU) and local levels (P2P)', () => {
        const state = globalState({'p2p-session': true});

        expect(isSessionSpeakingSelector(state, {session_id: 'sfu-session', voice: true} as any)).toBe(true);
        expect(isSessionSpeakingSelector(state, {session_id: 'p2p-session', voice: false} as any)).toBe(true);
        expect(isSessionSpeakingSelector(state, {session_id: 'quiet', voice: false} as any)).toBe(false);
    });

    it('works when the store has no local speaking slice (recorder client)', () => {
        const state = {'plugins-com.mattermost.calls': {}} as any;

        expect(localSpeakingSessions(state)).toEqual({});
        expect(isSessionSpeakingSelector(state, {session_id: 's', voice: true} as any)).toBe(true);
    });
});

describe('SpeakingSync', () => {
    let client: EventEmitter & {getSpeakingSessions: () => string[]};

    beforeEach(() => {
        client = Object.assign(new EventEmitter(), {getSpeakingSessions: () => ['already']});
        window.callsClient = client as never;
    });

    afterEach(() => {
        window.callsClient = undefined;
    });

    const Probe = ({sessionID}: {sessionID: string}) => {
        const isSpeaking = useIsSessionSpeaking({session_id: sessionID, voice: false} as never);
        return <span data-testid='probe'>{String(isSpeaking)}</span>;
    };

    it('mirrors the client levels into the store the UI reads', () => {
        const store = mockStore({'plugins-com.mattermost.calls': {...initial}} as never);
        const dispatched: any[] = [];
        const realDispatch = store.dispatch;
        store.dispatch = ((a: any) => {
            dispatched.push(a);
            return realDispatch(a);
        }) as never;

        render(
            <Provider store={store}>
                <SpeakingSync/>
            </Provider>,
        );

        expect(dispatched).toContainEqual(speaking('already', true));

        act(() => {
            client.emit('speaking', {sessionID: 'peer', speaking: true});
        });
        expect(dispatched).toContainEqual(speaking('peer', true));

        act(() => {
            client.emit('speaking', {sessionID: 'peer', speaking: false});
        });
        expect(dispatched).toContainEqual(speaking('peer', false));
    });

    it('stops listening when unmounted', () => {
        const store = mockStore({'plugins-com.mattermost.calls': {...initial}} as never);
        const {unmount} = render(
            <Provider store={store}>
                <SpeakingSync/>
            </Provider>,
        );
        expect(client.listenerCount('speaking')).toBe(1);

        unmount();

        expect(client.listenerCount('speaking')).toBe(0);
    });

    it('useIsSessionSpeaking reads the store', () => {
        const store = mockStore({'plugins-com.mattermost.calls': {...initial, localSpeaking: {p: true}}} as never);
        const {getByTestId} = render(
            <Provider store={store}>
                <Probe sessionID='p'/>
            </Provider>,
        );

        expect(getByTestId('probe').textContent).toBe('true');
    });
});
