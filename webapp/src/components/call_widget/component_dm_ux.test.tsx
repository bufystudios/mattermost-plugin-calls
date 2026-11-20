// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import type {UserSessionState} from '@mattermost/calls-common/lib/types';
import type {Channel} from '@mattermost/types/channels';
import type {Team} from '@mattermost/types/teams';
import type {UserProfile} from '@mattermost/types/users';
import {fireEvent, render, screen, within} from '@testing-library/react';
import React from 'react';
import {createIntl, RawIntlProvider} from 'react-intl';
import {Provider} from 'react-redux';
import type CallsClient from 'src/client';
import {mockStore} from 'src/testUtils';
import {setPushToTalkConfig} from 'src/voice_input_prefs';

import CallWidget from './component';

// Click-to-watch, LIVE badge, local volume and push-to-talk in the call widget of a DM call.

type Props = React.ComponentProps<typeof CallWidget>;

jest.mock('src/components/incoming_calls/ringback_container', () => ({
    RingbackContainer: () => null,
}));

jest.mock('src/components/leave_call_menu', () => ({
    LeaveCallMenu: () => null,
}));

jest.mock('src/components/dot_menu/dot_menu', () => ({
    __esModule: true,
    default: ({children}: {children: React.ReactNode}) => <div>{children}</div>,
    DotMenuButton: 'div',
    DropdownMenu: 'div',
    DropdownMenuItem: 'div',
    DropdownMenuSeparator: () => null,
}));

const intl = createIntl({locale: 'en', messages: {}});

const dmChannelID = 'dm-channel-id';
const dmChannel = {id: dmChannelID, team_id: 'team-id', name: 'user-id__other-user', display_name: 'Other', type: 'D'} as Channel;
const stubTeam = {id: 'team-id', name: 'team', display_name: 'Team'} as Team;
const caller = {id: 'user-id', username: 'caller', first_name: 'Cal', last_name: 'Ler'} as UserProfile;
const callee = {id: 'other-user', username: 'callee', first_name: 'Cal', last_name: 'Lee'} as UserProfile;

const stubSession = (sessionID: string, userID: string, overrides: Partial<UserSessionState> = {}): UserSessionState => ({
    session_id: sessionID,
    user_id: userID,
    unmuted: false,
    raised_hand: 0,
    ...overrides,
});

const mine = stubSession('session-1', 'user-id');
const theirs = stubSession('session-2', 'other-user');

const state = {
    'plugins-com.mattermost.calls': {
        calls: {[dmChannelID]: {ID: 'call-id', channelID: dmChannelID, ownerID: 'user-id', startAt: Date.now(), threadID: ''}},
        sessions: {[dmChannelID]: {[mine.session_id]: mine, [theirs.session_id]: theirs}},
        dmCalleeAnsweredAt: {},
    },
    entities: {
        channels: {channels: {[dmChannelID]: dmChannel}},
        users: {currentUserId: 'user-id', profiles: {'other-user': callee}},
    },
};

const baseProps = {
    intl,
    currentUserID: 'user-id',
    channel: dmChannel,
    team: stubTeam,
    channelURL: '/dm',
    channelDisplayName: 'Other',
    sessions: [mine, theirs],
    otherSessions: [theirs],
    sessionsMap: {[mine.session_id]: mine, [theirs.session_id]: theirs},
    currentSession: mine,
    profiles: {'user-id': caller, 'other-user': callee},
    callHostID: 'user-id',
    callHostChangeAt: 0,
    isRecording: false,
    show: true,
    showExpandedView: jest.fn(),
    showScreenSourceModal: jest.fn(),
    recordingPromptDismissedAt: jest.fn(),
    allowScreenSharing: true,
    recentlyJoinedUsers: [],
    hostNotices: [],
    wider: false,
    callsIncoming: [],
    transcriptionsEnabled: false,
    clientConnecting: false,
    selectRHSPost: jest.fn(),
    startCallRecording: jest.fn(),
    stopCallRecording: jest.fn(),
    recordingsEnabled: false,
    openModal: jest.fn(),
    openCallsUserSettings: jest.fn(),
    enableVideo: true,
    currentUserProfile: caller,
    connectedDMUser: callee,
    isAdmin: false,
    isDMCalling: false,
    localSpeaking: {},
} as Props;

const renderWidget = (overrides: Partial<Props> = {}) => render(
    <Provider store={mockStore(state)}>
        <RawIntlProvider value={intl}>
            <CallWidget
                {...baseProps}
                {...overrides}
            />
        </RawIntlProvider>
    </Provider>,
);

describe('CallWidget in a DM call', () => {
    let client: {mute: jest.Mock; unmute: jest.Mock};
    let handlers: {[event: string]: () => void};

    beforeEach(() => {
        handlers = {};
        client = {mute: jest.fn(), unmute: jest.fn()};
        window.callsClient = {
            ...client,
            disconnect: jest.fn(),
            channelID: dmChannelID,
            getSessionID: () => mine.session_id,
            getRemoteVoiceTracks: () => [],
            getRemoteTrackSessionID: () => undefined,
            getSpeakingSessions: () => [],
            getRemoteScreenStream: () => null,
            getLocalScreenStream: () => null,
            on: jest.fn((event: string, cb: () => void) => {
                handlers[event] = cb;
            }),
            off: jest.fn(),
        } as unknown as CallsClient;
    });

    afterEach(() => {
        window.callsClient = undefined;
        window.localStorage.clear();
    });

    describe('screen share', () => {
        test('shows a LIVE card, not the stream, until the viewer clicks Watch', () => {
            const {container} = renderWidget({screenSharingSession: theirs});

            expect(screen.getByTestId('live-stream-card')).toBeInTheDocument();
            expect(container.querySelector('#screen-player')).not.toBeInTheDocument();
        });

        test('clicking Watch shows the stream, Stop watching goes back to the card', () => {
            const {container} = renderWidget({screenSharingSession: theirs});

            fireEvent.click(screen.getByTestId('watch-stream-button'));
            expect(container.querySelector('#screen-player')).toBeInTheDocument();
            expect(screen.queryByTestId('live-stream-card')).not.toBeInTheDocument();

            fireEvent.click(screen.getByTestId('stop-watching-button'));
            expect(container.querySelector('#screen-player')).not.toBeInTheDocument();
            expect(screen.getByTestId('live-stream-card')).toBeInTheDocument();
        });

        test('the sharer sees their own preview without a Watch step', () => {
            const {container} = renderWidget({screenSharingSession: mine});

            expect(container.querySelector('#screen-player')).toBeInTheDocument();
            expect(screen.queryByTestId('live-stream-card')).not.toBeInTheDocument();
        });

        test('puts a LIVE badge on whoever shares', () => {
            renderWidget({screenSharingSession: theirs});

            expect(within(screen.getByTestId('calls-widget-profile-other')).getByTestId('live-badge')).toBeInTheDocument();
            expect(within(screen.getByTestId('calls-widget-profile-self')).queryByTestId('live-badge')).not.toBeInTheDocument();
        });

        test('shows no badge or card when nobody shares', () => {
            renderWidget();

            expect(screen.queryByTestId('live-badge')).not.toBeInTheDocument();
            expect(screen.queryByTestId('live-stream-card')).not.toBeInTheDocument();
        });
    });

    describe('speaking ring', () => {
        const ringOf = (testID: string) => getComputedStyle(screen.getByTestId(testID).querySelector('img')!).boxShadow;

        test('follows the server voice activity in SFU calls', () => {
            renderWidget({otherSessions: [{...theirs, voice: true}]});

            expect(ringOf('calls-widget-profile-other')).toContain('#3DB887');
            expect(ringOf('calls-widget-profile-self')).toBe('none');
        });

        test('follows the locally measured levels in P2P calls, where the server sees no audio', () => {
            renderWidget({localSpeaking: {[theirs.session_id]: true}});

            expect(ringOf('calls-widget-profile-other')).toContain('#3DB887');
        });

        test('shows no ring for a quiet participant', () => {
            renderWidget();

            expect(ringOf('calls-widget-profile-other')).toBe('none');
        });
    });

    describe('per-user volume', () => {
        test('the other participant has a volume button that opens a slider that is stored per user', () => {
            renderWidget();
            expect(screen.queryByTestId('user-volume-slider')).not.toBeInTheDocument();

            fireEvent.click(screen.getByTestId('calls-widget-volume-button'));
            const slider = screen.getByRole('slider');
            fireEvent.change(slider, {target: {value: '50'}});

            expect(JSON.parse(window.localStorage.getItem('calls_user_volumes')!)).toEqual({'other-user': 0.5});

            fireEvent.click(screen.getByTestId('calls-widget-volume-button'));
            expect(screen.queryByTestId('user-volume-slider')).not.toBeInTheDocument();
        });

        test('you cannot change your own volume', () => {
            renderWidget();

            expect(screen.getAllByTestId('calls-widget-volume-button')).toHaveLength(1);
        });
    });

    describe('push to talk', () => {
        test('a DM call starts unmuted when push-to-talk is off', () => {
            renderWidget();

            handlers.connect();

            expect((window.callsClient as unknown as typeof client).unmute).toHaveBeenCalledTimes(1);
        });

        test('with push-to-talk on the call starts muted (the mic only opens while the key is held)', () => {
            setPushToTalkConfig({enabled: true, code: 'KeyV'});
            renderWidget();

            handlers.connect();

            expect((window.callsClient as unknown as typeof client).unmute).not.toHaveBeenCalled();
        });

        test('the mute button still toggles the mic when push-to-talk is off', () => {
            renderWidget();

            fireEvent.click(document.getElementById('voice-mute-unmute')!);

            expect((window.callsClient as unknown as typeof client).unmute).toHaveBeenCalledTimes(1);
        });

        test('with push-to-talk on, the mute button leaves the mic alone (the key owns it)', () => {
            setPushToTalkConfig({enabled: true, code: 'KeyV'});
            renderWidget();

            fireEvent.click(document.getElementById('voice-mute-unmute')!);

            expect((window.callsClient as unknown as typeof client).unmute).not.toHaveBeenCalled();
            expect((window.callsClient as unknown as typeof client).mute).not.toHaveBeenCalled();
        });
    });
});
