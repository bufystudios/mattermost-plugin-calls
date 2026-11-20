// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {fireEvent, render, screen} from '@testing-library/react';
import React from 'react';
import {createIntl, RawIntlProvider} from 'react-intl';
import {getNoiseSuppression, getPushToTalkConfig} from 'src/voice_input_prefs';

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

    it('defaults to noise suppression on and push-to-talk off', () => {
        renderSection();

        expect(screen.getByText(/Noise suppression: on\. Input mode: voice activity/)).toBeInTheDocument();
        open();

        expect(screen.getByTestId('noise-suppression-checkbox')).toBeChecked();
        expect(screen.getByTestId('input-mode-voice-activity')).toBeChecked();
        expect(screen.queryByTestId('ptt-key-button')).not.toBeInTheDocument();
    });

    it('states that push to talk only works while a Mattermost window has focus', () => {
        renderSection();
        open();

        expect(screen.getByText(/only works while a Mattermost window .* has focus/)).toBeInTheDocument();
    });

    it('turns noise suppression off and applies it to the live call right away', () => {
        renderSection();
        open();

        fireEvent.click(screen.getByTestId('noise-suppression-checkbox'));
        fireEvent.click(screen.getByText('Save'));

        expect(getNoiseSuppression()).toBe(false);
        expect(client.applyNoiseSuppression).toHaveBeenCalled();
    });

    it('captures the next key as the push-to-talk key and saves it', () => {
        renderSection();
        open();
        fireEvent.click(screen.getByTestId('input-mode-push-to-talk'));

        fireEvent.click(screen.getByTestId('ptt-key-button'));
        fireEvent.keyDown(window, {code: 'KeyV'});
        expect(screen.getByTestId('ptt-key-button')).toHaveTextContent('V');

        fireEvent.click(screen.getByText('Save'));

        expect(getPushToTalkConfig()).toEqual({enabled: true, code: 'KeyV'});
    });

    it('cancels key capture with Escape', () => {
        renderSection();
        open();
        fireEvent.click(screen.getByTestId('input-mode-push-to-talk'));

        fireEvent.click(screen.getByTestId('ptt-key-button'));
        fireEvent.keyDown(window, {code: 'Escape'});

        expect(screen.getByTestId('ptt-key-button')).toHaveTextContent('Click to set a key');
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
});
