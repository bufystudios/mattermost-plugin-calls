// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {act, fireEvent, render, screen} from '@testing-library/react';
import React from 'react';
import {createIntl, RawIntlProvider} from 'react-intl';
import {getPushToTalkConfig, setPushToTalkConfig} from 'src/voice_input_prefs';

import {PushToTalkHint, ShortcutsList, ShortcutsMenuItem} from './voice_input_menu';

const intl = createIntl({locale: 'en', messages: {}});
const wrap = (ui: React.ReactElement) => render(<RawIntlProvider value={intl}>{ui}</RawIntlProvider>);

describe('voice input menu items', () => {
    let client: {applyNoiseSuppression: jest.Mock; mute: jest.Mock; unmute: jest.Mock; audioTrack: {enabled: boolean}};

    beforeEach(() => {
        client = {applyNoiseSuppression: jest.fn(), mute: jest.fn(), unmute: jest.fn(), audioTrack: {enabled: false}};
        (window as any).callsClient = client;
    });
    afterEach(() => {
        delete (window as any).callsClient;
        window.localStorage.clear();
    });

    describe('push to talk hint', () => {
        it('is not shown while push to talk is off', () => {
            wrap(<PushToTalkHint/>);
            expect(screen.queryByTestId('ptt-hint')).not.toBeInTheDocument();
        });

        it('shows the key while push to talk is on, and follows settings changes', () => {
            setPushToTalkConfig({enabled: true, code: 'ControlLeft'});
            wrap(<PushToTalkHint/>);
            expect(screen.getByTestId('ptt-hint')).toHaveTextContent('PTT: Left Ctrl');

            act(() => setPushToTalkConfig({enabled: true, code: 'KeyV'}));
            expect(screen.getByTestId('ptt-hint')).toHaveTextContent('PTT: V');

            act(() => setPushToTalkConfig({enabled: false, code: 'KeyV'}));
            expect(screen.queryByTestId('ptt-hint')).not.toBeInTheDocument();
        });
    });

    describe('keyboard shortcuts', () => {
        it('the menu item unfolds the list and folds it again', () => {
            wrap(<ShortcutsMenuItem isDM={true}/>);
            expect(screen.queryByTestId('shortcuts-list')).not.toBeInTheDocument();

            fireEvent.click(screen.getByTestId('shortcuts-toggle'));
            expect(screen.getByTestId('shortcuts-list')).toBeInTheDocument();

            fireEvent.click(screen.getByTestId('shortcuts-toggle'));
            expect(screen.queryByTestId('shortcuts-list')).not.toBeInTheDocument();
        });

        it('lists the upstream shortcuts with their keys', () => {
            wrap(<ShortcutsList isDM={false}/>);

            const mute = screen.getByTestId('shortcut-mute-unmute');
            expect(mute).toHaveTextContent('Mute / unmute');
            expect(mute).toHaveTextContent(/(Ctrl|⌘)Shift/);
            expect(mute).toHaveTextContent('Space');
            expect(screen.getByTestId('shortcut-raise-lower-hand')).toHaveTextContent('Raise / lower hand');
            expect(screen.getByTestId('shortcut-share-unshare-screen')).toHaveTextContent('Start / stop presenting');
            expect(screen.getByTestId('shortcut-participants-list-toggle')).toBeInTheDocument();
            expect(screen.getByTestId('shortcut-leave-call')).toBeInTheDocument();
            expect(screen.getByTestId('shortcut-make-reaction')).toHaveTextContent('(pop out)');
        });

        it('has no participants shortcut in a DM', () => {
            wrap(<ShortcutsList isDM={true}/>);
            expect(screen.queryByTestId('shortcut-participants-list-toggle')).not.toBeInTheDocument();
        });

        it('shows our push-to-talk key, and that the mute shortcut does nothing while it is on', () => {
            setPushToTalkConfig({enabled: true, code: 'KeyV'});
            wrap(<ShortcutsList isDM={true}/>);

            expect(screen.getByTestId('shortcut-push-to-talk')).toHaveTextContent('Push to talk (hold)V');
            expect(screen.getByText(/mute shortcut and the mute button do nothing/)).toBeInTheDocument();
        });

        it('says how to turn push to talk on when it is off', () => {
            wrap(<ShortcutsList isDM={true}/>);
            expect(screen.getByTestId('shortcut-push-to-talk')).toHaveTextContent('off');
            expect(screen.getByText(/Turn push to talk on in Settings/)).toBeInTheDocument();
            expect(getPushToTalkConfig().enabled).toBe(false);
        });
    });
});
