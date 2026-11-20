// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {act, fireEvent, render, screen} from '@testing-library/react';
import React from 'react';
import {createIntl, RawIntlProvider} from 'react-intl';
import {Provider} from 'react-redux';
import {MemoryRouter, Route, Switch, useHistory} from 'react-router-dom';
import {createStore} from 'redux';
import {ownScreenSharing} from 'src/selectors';

import ScreenSharingBanner, {SHARING_TITLE_PREFIX} from './screen_sharing_banner';

const intl = createIntl({locale: 'en', messages: {}});

type PluginState = {
    clientStateReducer?: {channelID: string; sessionID: string} | null;
    screenSharingIDs: {[channelID: string]: string};
};

const makeStore = (plugin: PluginState) => createStore((state: any = {'plugins-com.mattermost.calls': plugin}, action: any) => {
    return action.type === 'set-plugin' ? {'plugins-com.mattermost.calls': action.plugin} : state;
});

const dmPage = 'dm';
let history: ReturnType<typeof useHistory>;
const Nav = () => {
    history = useHistory();
    return null;
};

const renderBanner = (store: ReturnType<typeof makeStore>) => render(
    <Provider store={store}>
        <RawIntlProvider value={intl}>
            <MemoryRouter initialEntries={['/team/channels/town-square']}>
                <ScreenSharingBanner/>
                <Nav/>
                <Switch>
                    <Route
                        path='/team/channels/:name'
                        render={({match}) => <div data-testid='page'>{match.params.name}</div>}
                    />
                    <Route
                        path='/team2/messages/:name'
                        render={() => <div data-testid='page'>{dmPage}</div>}
                    />
                </Switch>
            </MemoryRouter>
        </RawIntlProvider>
    </Provider>,
);

const setPlugin = (store: ReturnType<typeof makeStore>, plugin: PluginState) => act(() => {
    store.dispatch({type: 'set-plugin', plugin} as never);
});

describe('ScreenSharingBanner', () => {
    afterEach(() => {
        delete (window as any).callsClient;
        delete (global as any).BroadcastChannel;
        document.title = '';
    });

    describe('selector: who is sharing', () => {
        const state = (plugin: PluginState) => ({'plugins-com.mattermost.calls': plugin}) as never;

        it('is the current user when the sharing session is the one of the call client', () => {
            (window as any).callsClient = {channelID: 'ch1', getSessionID: () => 's1'};
            expect(ownScreenSharing(state({screenSharingIDs: {ch1: 's1'}}))).toEqual({channelID: 'ch1', sessionID: 's1'});
            expect(ownScreenSharing(state({screenSharingIDs: {ch1: 'someone-else'}}))).toBeNull();
            expect(ownScreenSharing(state({screenSharingIDs: {}}))).toBeNull();
        });

        it('knows it in the desktop app main window, where the call lives in the widget window (no client here)', () => {
            const plugin = {clientStateReducer: {channelID: 'ch1', sessionID: 's1'}, screenSharingIDs: {ch1: 's1'}};
            expect(ownScreenSharing(state(plugin))).toEqual({channelID: 'ch1', sessionID: 's1'});
            expect(ownScreenSharing(state({...plugin, screenSharingIDs: {ch1: 's2'}}))).toBeNull();
        });

        it('is not sharing without a call', () => {
            expect(ownScreenSharing(state({screenSharingIDs: {ch1: 's1'}}))).toBeNull();
        });
    });

    it('shows while the user shares and goes away when the share stops', () => {
        const store = makeStore({clientStateReducer: {channelID: 'ch1', sessionID: 's1'}, screenSharingIDs: {}});
        renderBanner(store);
        expect(screen.queryByTestId('screen-sharing-banner')).not.toBeInTheDocument();

        setPlugin(store, {clientStateReducer: {channelID: 'ch1', sessionID: 's1'}, screenSharingIDs: {ch1: 's1'}});
        expect(screen.getByTestId('screen-sharing-banner')).toHaveTextContent('You\'re sharing your screen');
        expect(screen.getByTestId('screen-sharing-banner-stop')).toHaveTextContent('Stop sharing');

        setPlugin(store, {clientStateReducer: {channelID: 'ch1', sessionID: 's1'}, screenSharingIDs: {}});
        expect(screen.queryByTestId('screen-sharing-banner')).not.toBeInTheDocument();
    });

    it('does not show for somebody else\'s share', () => {
        const store = makeStore({clientStateReducer: {channelID: 'ch1', sessionID: 's1'}, screenSharingIDs: {ch1: 's2'}});
        renderBanner(store);
        expect(screen.queryByTestId('screen-sharing-banner')).not.toBeInTheDocument();
    });

    it('stays while navigating between channels and teams', () => {
        const store = makeStore({clientStateReducer: {channelID: 'ch1', sessionID: 's1'}, screenSharingIDs: {ch1: 's1'}});
        renderBanner(store);
        expect(screen.getByTestId('page')).toHaveTextContent('town-square');
        expect(screen.getByTestId('screen-sharing-banner')).toBeInTheDocument();

        act(() => history.push('/team/channels/off-topic'));
        expect(screen.getByTestId('page')).toHaveTextContent('off-topic');
        expect(screen.getByTestId('screen-sharing-banner')).toBeInTheDocument();

        act(() => history.push('/team2/messages/someone'));
        expect(screen.getByTestId('page')).toHaveTextContent('dm');
        expect(screen.getByTestId('screen-sharing-banner')).toBeInTheDocument();
    });

    it('Stop sharing stops the share through the call client when this window owns it', () => {
        const unshareScreen = jest.fn();
        (window as any).callsClient = {
            channelID: 'ch1', getSessionID: () => 's1', unshareScreen, getScreenQualityInfo: () => null, on: jest.fn(), off: jest.fn(),
        };
        const store = makeStore({screenSharingIDs: {ch1: 's1'}});
        renderBanner(store);

        fireEvent.click(screen.getByTestId('screen-sharing-banner-stop'));
        expect(unshareScreen).toHaveBeenCalledTimes(1);
    });

    it('Stop sharing asks the window that owns the call when there is no client here (desktop app main window)', () => {
        const posted: unknown[] = [];
        (global as any).BroadcastChannel = class {
            onmessage: unknown;
            postMessage(m: unknown) {
                posted.push(m);
            }
            close() {}
        };
        const store = makeStore({clientStateReducer: {channelID: 'ch1', sessionID: 's1'}, screenSharingIDs: {ch1: 's1'}});
        renderBanner(store);

        fireEvent.click(screen.getByTestId('screen-sharing-banner-stop'));
        expect(posted).toContainEqual({type: 'stop'});
    });

    it('shows the quality in use and follows its changes', () => {
        let onQuality: (info: unknown) => void = () => {};
        const info = (resolution: string) => ({
            quality: {auto: true, resolution: '1080p', fps: 60, content: 'game', manualBitrateMbps: null},
            bitrateMbps: 7.5,
            captured: {width: 1920, height: 1080},
            auto: {resolution, fps: 60, limited: 'bandwidth'},
        });
        (window as any).callsClient = {
            channelID: 'ch1',
            getSessionID: () => 's1',
            unshareScreen: jest.fn(),
            getScreenQualityInfo: () => info('1080p'),
            on: (event: string, cb: (i: unknown) => void) => {
                onQuality = cb;
            },
            off: jest.fn(),
        };
        renderBanner(makeStore({screenSharingIDs: {ch1: 's1'}}));

        expect(screen.getByTestId('screen-sharing-banner-quality')).toHaveTextContent('Auto · 1080p60 · 7.5 Mbps (limited: bandwidth)');

        act(() => onQuality({...info('720p'), captured: {width: 1280, height: 720}, bitrateMbps: 4, auto: {resolution: '720p', fps: 60, limited: null}}));
        expect(screen.getByTestId('screen-sharing-banner-quality')).toHaveTextContent('Auto · 720p60 · 4 Mbps');
    });

    it('can be folded to a dot and unfolded, but never disappears', () => {
        const store = makeStore({clientStateReducer: {channelID: 'ch1', sessionID: 's1'}, screenSharingIDs: {ch1: 's1'}});
        renderBanner(store);

        fireEvent.click(screen.getByTestId('screen-sharing-banner-collapse'));
        expect(screen.queryByTestId('screen-sharing-banner')).not.toBeInTheDocument();
        expect(screen.getByTestId('screen-sharing-banner-collapsed')).toBeInTheDocument();

        act(() => history.push('/team2/messages/someone'));
        expect(screen.getByTestId('screen-sharing-banner-collapsed')).toBeInTheDocument();

        fireEvent.click(screen.getByTestId('screen-sharing-banner-collapsed'));
        expect(screen.getByTestId('screen-sharing-banner')).toBeInTheDocument();
    });

    it('is not shown in the pop out window', () => {
        (window as any).callsClient = undefined;
        const opener = {callsClient: {channelID: 'ch1', getSessionID: () => 's1', unshareScreen: jest.fn(), getScreenQualityInfo: () => null, on: jest.fn(), off: jest.fn()}};
        Object.defineProperty(window, 'opener', {value: opener, configurable: true});
        try {
            renderBanner(makeStore({screenSharingIDs: {ch1: 's1'}}));
            expect(screen.queryByTestId('screen-sharing-banner')).not.toBeInTheDocument();
            expect(document.title.startsWith(SHARING_TITLE_PREFIX)).toBe(false);
        } finally {
            Object.defineProperty(window, 'opener', {value: null, configurable: true});
        }
    });

    describe('tab title', () => {
        it('gets a red dot prefix while sharing and is restored when it stops', () => {
            document.title = 'Town Square - Team';
            const store = makeStore({clientStateReducer: {channelID: 'ch1', sessionID: 's1'}, screenSharingIDs: {}});
            renderBanner(store);
            expect(document.title).toBe('Town Square - Team');

            setPlugin(store, {clientStateReducer: {channelID: 'ch1', sessionID: 's1'}, screenSharingIDs: {ch1: 's1'}});
            expect(document.title).toBe('🔴 Town Square - Team');

            setPlugin(store, {clientStateReducer: {channelID: 'ch1', sessionID: 's1'}, screenSharingIDs: {}});
            expect(document.title).toBe('Town Square - Team');
        });

        it('keeps the prefix when the app rewrites the title (navigation, unread counts)', async () => {
            document.title = 'Town Square';
            const store = makeStore({clientStateReducer: {channelID: 'ch1', sessionID: 's1'}, screenSharingIDs: {ch1: 's1'}});
            renderBanner(store);
            expect(document.title).toBe('🔴 Town Square');

            await act(async () => {
                document.title = '(2) Off-Topic';
                await new Promise((resolve) => setTimeout(resolve, 0));
            });
            expect(document.title).toBe('🔴 (2) Off-Topic');
        });

        it('does not double the prefix', () => {
            document.title = 'A';
            const store = makeStore({clientStateReducer: {channelID: 'ch1', sessionID: 's1'}, screenSharingIDs: {ch1: 's1'}});
            const first = renderBanner(store);
            first.unmount();
            expect(document.title).toBe('A');
            renderBanner(store);
            expect(document.title).toBe('🔴 A');
        });
    });
});
