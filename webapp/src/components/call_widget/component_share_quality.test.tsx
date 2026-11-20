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
import {STORAGE_CALLS_SHARE_QUALITY_KEY} from 'src/constants';
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

            fireEvent.change(screen.getByTestId('share-quality-modal-mode'), {target: {value: 'manual'}});
            fireEvent.change(screen.getByTestId('share-quality-modal-resolution'), {target: {value: '4k'}});
            fireEvent.change(screen.getByTestId('share-quality-modal-fps'), {target: {value: '30'}});
            fireEvent.change(screen.getByTestId('share-quality-modal-content'), {target: {value: 'text'}});
            await act(async () => {
                fireEvent.click(screen.getByTestId('share-quality-confirm'));
            });

            expect(client.shareScreen).toHaveBeenCalledTimes(1);
            expect(client.shareScreen).toHaveBeenCalledWith('', expect.any(Boolean), {auto: false, resolution: '4k', fps: 30, content: 'text', manualBitrateMbps: null});
            expect(getShareQuality()).toEqual({auto: false, resolution: '4k', fps: 30, content: 'text', manualBitrateMbps: null});
            expect(screen.queryByTestId('share-quality-modal')).not.toBeInTheDocument();
        });

        test('pre-selects the last choice', () => {
            setShareQuality({auto: false, resolution: '1440p', fps: 15, content: 'text', manualBitrateMbps: 12});
            renderWidget();
            clickShare();

            expect((screen.getByTestId('share-quality-modal-resolution') as HTMLSelectElement).value).toBe('1440p');
            expect((screen.getByTestId('share-quality-modal-fps') as HTMLSelectElement).value).toBe('15');
            expect((screen.getByTestId('share-quality-modal-content') as HTMLSelectElement).value).toBe('text');
            expect(screen.getByTestId('share-quality-modal-bitrate-value')).toHaveTextContent('12 Mbps');
        });

        test('starts with Auto selected when nothing was chosen before (new user)', () => {
            renderWidget();
            clickShare();

            expect((screen.getByTestId('share-quality-modal-mode') as HTMLSelectElement).value).toBe('auto');
            expect(screen.getByTestId('share-quality-modal-auto-hint')).toBeInTheDocument();
            expect(screen.queryByTestId('share-quality-modal-resolution')).not.toBeInTheDocument();
            expect(defaultShareQuality.auto).toBe(true);
        });

        test('keeps a manual choice stored before Auto existed', () => {
            window.localStorage.setItem(STORAGE_CALLS_SHARE_QUALITY_KEY, JSON.stringify({resolution: '1080p', fps: 60, content: 'game', manualBitrateMbps: null}));
            renderWidget();
            clickShare();

            expect((screen.getByTestId('share-quality-modal-mode') as HTMLSelectElement).value).toBe('manual');
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
            quality: {auto: false, resolution: '1440p', fps: 60, content: 'game', manualBitrateMbps: null},
            bitrateMbps: 12,
            captured: {width: 2560, height: 1440},
            auto: null,
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

            expect(client.setScreenQuality).toHaveBeenCalledWith({auto: false, resolution: '720p', fps: 60, content: 'game', manualBitrateMbps: null});
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

    describe('Auto quality and the sharing state', () => {
        const autoInfo = {
            quality: {auto: true, resolution: '1080p', fps: 60, content: 'game', manualBitrateMbps: null},
            bitrateMbps: 7.5,
            captured: {width: 1920, height: 1080},
            auto: {resolution: '1080p', fps: 60, limited: 'bandwidth'},
        };

        test('the sharer\'s quality label shows the Auto level and what limits it', () => {
            client.getScreenQualityInfo = jest.fn(() => autoInfo);
            renderWidget({screenSharingSession: mine});
            expect(screen.getByTestId('share-quality-label')).toHaveTextContent('Auto · 1080p60 · 7.5 Mbps (limited: bandwidth)');
        });

        test('the live panel offers Auto and manual', () => {
            client.getScreenQualityInfo = jest.fn(() => autoInfo);
            renderWidget({screenSharingSession: mine});
            fireEvent.click(screen.getByTestId('share-quality-toggle'));

            expect((screen.getByTestId('share-quality-live-mode') as HTMLSelectElement).value).toBe('auto');
            fireEvent.change(screen.getByTestId('share-quality-live-mode'), {target: {value: 'manual'}});
            expect(client.setScreenQuality).toHaveBeenCalledWith(expect.objectContaining({auto: false}));
        });

        test('a red strip with a Stop button is visible without opening any menu while the user shares', () => {
            client.unshareScreen = jest.fn();
            renderWidget({screenSharingSession: mine});

            expect(screen.getByTestId('calls-widget-sharing-strip')).toHaveTextContent('Sharing your screen');
            fireEvent.click(screen.getByTestId('calls-widget-sharing-strip-stop'));
            expect(client.unshareScreen).toHaveBeenCalledTimes(1);
        });

        test('no sharing strip when not sharing, or when somebody else shares', () => {
            renderWidget();
            expect(screen.queryByTestId('calls-widget-sharing-strip')).not.toBeInTheDocument();
        });

        test('no sharing strip for a viewer', () => {
            renderWidget({screenSharingSession: theirs});
            expect(screen.queryByTestId('calls-widget-sharing-strip')).not.toBeInTheDocument();
        });
    });

    describe('voice input hints', () => {
        test('the widget menu has a noise suppression switch that applies right away, and the shortcut list', () => {
            client.applyNoiseSuppression = jest.fn();
            (window as any).WebappUtils = {openUserSettings: jest.fn()};
            renderWidget();
            fireEvent.click(document.getElementById('calls-widget-toggle-menu-button')!);

            expect(screen.getByTestId('noise-suppression-state')).toHaveTextContent('On');
            fireEvent.click(screen.getByTestId('noise-suppression-toggle'));
            expect(screen.getByTestId('noise-suppression-state')).toHaveTextContent('Off');
            expect(client.applyNoiseSuppression).toHaveBeenCalled();

            fireEvent.click(screen.getByTestId('shortcuts-toggle'));
            expect(screen.getByTestId('shortcuts-list')).toBeInTheDocument();
        });

        test('shows PTT: <key> only while push to talk is on', () => {
            window.localStorage.setItem('calls_push_to_talk', JSON.stringify({enabled: true, code: 'KeyV'}));
            renderWidget();
            expect(screen.getByTestId('ptt-hint')).toHaveTextContent('PTT: V');
        });

        test('no PTT hint by default', () => {
            renderWidget();
            expect(screen.queryByTestId('ptt-hint')).not.toBeInTheDocument();
        });
    });
});
