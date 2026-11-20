// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import type {UserSessionState} from '@mattermost/calls-common/lib/types';
import type {Channel} from '@mattermost/types/channels';
import type {Team} from '@mattermost/types/teams';
import type {UserProfile} from '@mattermost/types/users';
import {act, fireEvent, render, screen} from '@testing-library/react';
import React from 'react';
import {createIntl, RawIntlProvider} from 'react-intl';
import {Provider} from 'react-redux';
import type CallsClient from 'src/client';
import {defaultShareQuality, getShareQuality, setShareQuality} from 'src/screen_share_quality';
import {mockStore} from 'src/testUtils';

import CallWidget from './component';

// The screen share quality picker in the call widget: asked before a browser share starts, and
// the live controls on the sharer's own preview.

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

const stubSession = (sessionID: string, userID: string): UserSessionState => ({
    session_id: sessionID,
    user_id: userID,
    unmuted: false,
    raised_hand: 0,
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

describe('CallWidget screen share quality', () => {
    let client: Record<string, jest.Mock | unknown>;
    let handlers: {[event: string]: (arg: unknown) => void};

    beforeEach(() => {
        handlers = {};
        client = {
            disconnect: jest.fn(),
            channelID: dmChannelID,
            getSessionID: () => mine.session_id,
            getRemoteVoiceTracks: () => [],
            getRemoteTrackSessionID: () => undefined,
            getSpeakingSessions: () => [],
            getRemoteScreenStream: () => null,
            getLocalScreenStream: () => null,
            shareScreen: jest.fn(async () => null),
            setScreenQuality: jest.fn(async () => {}),
            getScreenQualityInfo: jest.fn(() => null),
            on: jest.fn((event: string, cb: (arg: unknown) => void) => {
                handlers[event] = cb;
            }),
            off: jest.fn(),
        };
        window.callsClient = client as unknown as CallsClient;
    });

    afterEach(() => {
        window.callsClient = undefined;
        window.localStorage.clear();
    });

    describe('starting a share in the browser', () => {
        const clickShare = () => fireEvent.click(screen.getByLabelText('Start presenting'));

        test('asks for the quality first and does not capture yet', () => {
            renderWidget();
            clickShare();

            expect(screen.getByTestId('share-quality-modal')).toBeInTheDocument();
            expect(client.shareScreen).not.toHaveBeenCalled();
        });

        test('starts the share with the confirmed choice, and remembers it', async () => {
            renderWidget();
            clickShare();

            fireEvent.change(screen.getByTestId('share-quality-modal-resolution'), {target: {value: '4k'}});
            fireEvent.change(screen.getByTestId('share-quality-modal-fps'), {target: {value: '30'}});
            fireEvent.change(screen.getByTestId('share-quality-modal-content'), {target: {value: 'text'}});
            await act(async () => {
                fireEvent.click(screen.getByTestId('share-quality-confirm'));
            });

            expect(client.shareScreen).toHaveBeenCalledTimes(1);
            expect(client.shareScreen).toHaveBeenCalledWith('', expect.any(Boolean), {resolution: '4k', fps: 30, content: 'text', manualBitrateMbps: null});
            expect(getShareQuality()).toEqual({resolution: '4k', fps: 30, content: 'text', manualBitrateMbps: null});
            expect(screen.queryByTestId('share-quality-modal')).not.toBeInTheDocument();
        });

        test('pre-selects the last choice', () => {
            setShareQuality({resolution: '1440p', fps: 15, content: 'text', manualBitrateMbps: 12});
            renderWidget();
            clickShare();

            expect((screen.getByTestId('share-quality-modal-resolution') as HTMLSelectElement).value).toBe('1440p');
            expect((screen.getByTestId('share-quality-modal-fps') as HTMLSelectElement).value).toBe('15');
            expect((screen.getByTestId('share-quality-modal-content') as HTMLSelectElement).value).toBe('text');
            expect(screen.getByTestId('share-quality-modal-bitrate-value')).toHaveTextContent('12 Mbps');
        });

        test('starts with the defaults when nothing was chosen before', () => {
            renderWidget();
            clickShare();

            expect((screen.getByTestId('share-quality-modal-resolution') as HTMLSelectElement).value).toBe(defaultShareQuality.resolution);
            expect(screen.getByTestId('share-quality-modal-auto-bitrate')).toBeInTheDocument();
        });

        test('Cancel and Escape do not start a share', () => {
            renderWidget();
            clickShare();
            fireEvent.click(screen.getByTestId('share-quality-cancel'));
            expect(screen.queryByTestId('share-quality-modal')).not.toBeInTheDocument();

            clickShare();
            fireEvent.keyDown(document, {key: 'Escape'});
            expect(screen.queryByTestId('share-quality-modal')).not.toBeInTheDocument();
            expect(client.shareScreen).not.toHaveBeenCalled();
        });
    });

    describe('while sharing', () => {
        const liveInfo = {
            quality: {resolution: '1440p', fps: 60, content: 'game', manualBitrateMbps: null},
            bitrateMbps: 12,
            captured: {width: 2560, height: 1440},
        };

        beforeEach(() => {
            client.getScreenQualityInfo = jest.fn(() => liveInfo);
        });

        test('shows the quality in use on the own preview', () => {
            renderWidget({screenSharingSession: mine});
            expect(screen.getByTestId('share-quality-label')).toHaveTextContent('1440p60 · 12 Mbps');
        });

        test('does not show it to a viewer', () => {
            renderWidget({screenSharingSession: theirs});
            expect(screen.queryByTestId('share-quality-label')).not.toBeInTheDocument();
        });

        test('follows what the client reports', () => {
            renderWidget({screenSharingSession: mine});
            act(() => handlers.screenQuality({...liveInfo, quality: {...liveInfo.quality, resolution: '1080p', fps: 30}, bitrateMbps: 4}));
            expect(screen.getByTestId('share-quality-label')).toHaveTextContent('1080p30 · 4 Mbps');
        });

        test('changing the quality is applied to the live share, without sharing again', () => {
            renderWidget({screenSharingSession: mine});
            fireEvent.click(screen.getByTestId('share-quality-toggle'));

            fireEvent.change(screen.getByTestId('share-quality-live-resolution'), {target: {value: '720p'}});

            expect(client.setScreenQuality).toHaveBeenCalledWith({resolution: '720p', fps: 60, content: 'game', manualBitrateMbps: null});
            expect(client.shareScreen).not.toHaveBeenCalled();
        });

        test('a manual bitrate can be set live', () => {
            renderWidget({screenSharingSession: mine});
            fireEvent.click(screen.getByTestId('share-quality-toggle'));

            fireEvent.click(screen.getByTestId('share-quality-live-manual-bitrate'));
            expect(client.setScreenQuality).toHaveBeenLastCalledWith(expect.objectContaining({manualBitrateMbps: 12}));

            fireEvent.change(screen.getByTestId('share-quality-live-bitrate-slider'), {target: {value: '20'}});
            expect(client.setScreenQuality).toHaveBeenLastCalledWith(expect.objectContaining({manualBitrateMbps: 20}));
        });
    });
});
