// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {fireEvent, render, screen} from '@testing-library/react';
import React from 'react';
import {createIntl, RawIntlProvider} from 'react-intl';
import {getNoiseLevel, getPushToTalkConfig} from 'src/voice_input_prefs';

import VoiceInputSettingsSection from './voice_input_settings_section';

// common.ts pulls in react-select, which this test does not need.
jest.mock('src/components/user_settings/common', () => ({
    Description: ({children, ...rest}: {children: React.ReactNode}) => <span {...rest}>{children}</span>,
    Fieldset: ({children}: {children: React.ReactNode}) => <fieldset>{children}</fieldset>,
}));

const intl = createIntl({locale: 'en', messages: {}});

const renderSection = () => render(
    <RawIntlProvider value={intl}>
        <VoiceInputSettingsSection/>
    </RawIntlProvider>,
);

const open = () => fireEvent.click(screen.getByText('Edit'));

describe('VoiceInputSettingsSection', () => {
    let client: {mute: jest.Mock; unmute: jest.Mock; audioTrack: {enabled: boolean}; applyNoiseSuppression: jest.Mock};

    beforeEach(() => {
        client = {mute: jest.fn(), unmute: jest.fn(), audioTrack: {enabled: true}, applyNoiseSuppression: jest.fn()};
        window.callsClient = client as never;
    });

    afterEach(() => {
        window.callsClient = undefined;
        window.localStorage.clear();
    });

    it('defaults to Enhanced noise suppression and push-to-talk off', () => {
        renderSection();

        expect(screen.getByTestId('voice-input-summary-noise')).toHaveTextContent('Noise suppression: Enhanced');
        expect(screen.getByTestId('voice-input-summary-mode')).toHaveTextContent('Input mode: voice activity');
        open();

        expect(screen.getByTestId('noise-level-radio-enhanced')).toBeChecked();
        expect(screen.getByText('Maximum (experimental)')).toBeInTheDocument();
        expect(screen.getByTestId('input-mode-voice-activity')).toBeChecked();
        expect(screen.queryByTestId('ptt-key-button')).not.toBeInTheDocument();
    });

    it('states that push to talk only works while a Mattermost window has focus', () => {
        renderSection();
        open();

        expect(screen.getByText(/only works while a Mattermost window .* has focus/)).toBeInTheDocument();
    });

    it('picks a noise level and applies it to the live call right away', () => {
        renderSection();
        open();

        fireEvent.click(screen.getByTestId('noise-level-radio-maximum'));
        fireEvent.click(screen.getByText('Save'));

        expect(getNoiseLevel()).toBe('maximum');
        expect(client.applyNoiseSuppression).toHaveBeenCalled();
    });

    it('does not show the desktop app options in a browser', () => {
        renderSection();
        open();

        expect(screen.queryByTestId('desktop-settings')).not.toBeInTheDocument();
    });

    it('captures the next key as the push-to-talk key and saves it', () => {
        renderSection();
        open();
        fireEvent.click(screen.getByTestId('input-mode-push-to-talk'));

        fireEvent.click(screen.getByTestId('ptt-key-button'));
        fireEvent.keyDown(window, {code: 'KeyV'});
        expect(screen.getByTestId('ptt-key-chip')).toHaveTextContent('V');
        expect(screen.getByTestId('ptt-key-button')).toHaveTextContent('Change');

        fireEvent.click(screen.getByText('Save'));

        expect(getPushToTalkConfig()).toEqual({enabled: true, code: 'KeyV'});
    });

    it('cancels key capture with Escape', () => {
        renderSection();
        open();
        fireEvent.click(screen.getByTestId('input-mode-push-to-talk'));

        fireEvent.click(screen.getByTestId('ptt-key-button'));
        fireEvent.keyDown(window, {code: 'Escape'});

        expect(screen.getByTestId('ptt-key-chip')).toHaveTextContent('Not set');
        expect(screen.getByTestId('ptt-key-button')).toHaveTextContent('Set key');
    });

    it('cannot save push-to-talk without a key', () => {
        renderSection();
        open();
        fireEvent.click(screen.getByTestId('input-mode-push-to-talk'));

        expect(screen.getByTestId('ptt-key-required')).toBeInTheDocument();
        expect(screen.getByText('Save')).toBeDisabled();
        expect(getPushToTalkConfig().enabled).toBe(false);
    });

    it('closes the mic of somebody who was unmuted when push-to-talk is turned on', () => {
        renderSection();
        open();
        fireEvent.click(screen.getByTestId('input-mode-push-to-talk'));
        fireEvent.click(screen.getByTestId('ptt-key-button'));
        fireEvent.keyDown(window, {code: 'KeyV'});

        fireEvent.click(screen.getByText('Save'));

        expect(client.mute).toHaveBeenCalledTimes(1);
    });

    it('switching back to voice activity keeps the chosen key but disables push-to-talk', () => {
        renderSection();
        open();
        fireEvent.click(screen.getByTestId('input-mode-push-to-talk'));
        fireEvent.click(screen.getByTestId('ptt-key-button'));
        fireEvent.keyDown(window, {code: 'KeyV'});
        fireEvent.click(screen.getByText('Save'));

        open();
        fireEvent.click(screen.getByTestId('input-mode-voice-activity'));
        fireEvent.click(screen.getByText('Save'));

        expect(getPushToTalkConfig()).toEqual({enabled: false, code: 'KeyV'});
    });

    it('shows the current noise level in the collapsed summary, also after it was turned off', () => {
        renderSection();
        open();
        fireEvent.click(screen.getByTestId('noise-level-radio-off'));
        fireEvent.click(screen.getByText('Save'));

        expect(screen.getByTestId('voice-input-summary-noise')).toHaveTextContent('Noise suppression: Off');
    });

    it('shows the push-to-talk key in the summary', () => {
        renderSection();
        open();
        fireEvent.click(screen.getByTestId('input-mode-push-to-talk'));
        fireEvent.click(screen.getByTestId('ptt-key-button'));
        fireEvent.keyDown(window, {code: 'ControlLeft'});
        fireEvent.click(screen.getByText('Save'));

        expect(screen.getByTestId('voice-input-summary-mode')).toHaveTextContent('push to talk (hold Left Ctrl)');
    });

    it('makes the capture state obvious and Esc cancels it without changing the key', () => {
        renderSection();
        open();
        fireEvent.click(screen.getByTestId('input-mode-push-to-talk'));
        fireEvent.click(screen.getByTestId('ptt-key-button'));
        fireEvent.keyDown(window, {code: 'KeyV'});

        fireEvent.click(screen.getByTestId('ptt-key-button'));
        expect(screen.getByTestId('ptt-key-chip')).toHaveTextContent('Press a key…');
        expect(screen.getByTestId('ptt-key-button')).toHaveTextContent('Cancel');
        expect(screen.getByTestId('ptt-capture-hint')).toHaveTextContent('Esc cancels');

        fireEvent.keyDown(window, {code: 'Escape'});
        expect(screen.getByTestId('ptt-key-chip')).toHaveTextContent('V');
    });

    it('test indicator lights up while the push-to-talk key is held', () => {
        renderSection();
        open();
        fireEvent.click(screen.getByTestId('input-mode-push-to-talk'));
        fireEvent.click(screen.getByTestId('ptt-key-button'));
        fireEvent.keyDown(window, {code: 'KeyV'});

        expect(screen.getByTestId('ptt-test-indicator')).toHaveTextContent('Not pressed');
        fireEvent.keyDown(window, {code: 'KeyV'});
        expect(screen.getByTestId('ptt-test-indicator')).toHaveTextContent('Key pressed');
        fireEvent.keyDown(window, {code: 'KeyB'});
        expect(screen.getByTestId('ptt-test-indicator')).toHaveTextContent('Key pressed');
        fireEvent.keyUp(window, {code: 'KeyV'});
        expect(screen.getByTestId('ptt-test-indicator')).toHaveTextContent('Not pressed');
    });
});
