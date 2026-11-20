// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {act, fireEvent, render, screen} from '@testing-library/react';
import React from 'react';
import {createIntl, RawIntlProvider} from 'react-intl';
import {STORAGE_CALLS_NOISE_FALLBACK_KEY, STORAGE_CALLS_NOISE_SUPPRESSION_KEY} from 'src/constants';
import {resetNoiseStatus, setNoiseStatus, updateNoiseStatus} from 'src/noise/status';
import {getNoiseLevel, setNoiseLevel} from 'src/voice_input_prefs';

import {NoiseFallbackNotice, NoiseLevelMenuItems} from './noise_level';

const intl = createIntl({locale: 'en', messages: {}});
const wrap = (ui: React.ReactElement) => render(<RawIntlProvider value={intl}>
    <ul>{ui}</ul>
</RawIntlProvider>);

describe('NoiseLevelMenuItems', () => {
    let client: {applyNoiseSuppression: jest.Mock; mute: jest.Mock; unmute: jest.Mock; audioTrack: {enabled: boolean}};

    beforeEach(() => {
        client = {applyNoiseSuppression: jest.fn(), mute: jest.fn(), unmute: jest.fn(), audioTrack: {enabled: false}};
        (window as any).callsClient = client;
        resetNoiseStatus();
    });
    afterEach(() => {
        delete (window as any).callsClient;
        window.localStorage.clear();
        act(() => resetNoiseStatus());
    });

    it('lists the four levels with a description, Enhanced checked by default, Maximum tagged experimental', () => {
        wrap(<NoiseLevelMenuItems/>);

        const radios = screen.getAllByRole('radio');
        expect(radios.map((r) => r.getAttribute('aria-label'))).toEqual(['Off', 'Standard', 'Enhanced', 'Maximum']);
        expect(screen.getByTestId('noise-level-enhanced')).toHaveAttribute('aria-checked', 'true');
        expect(screen.getByTestId('noise-level-off')).toHaveAttribute('aria-checked', 'false');
        expect(screen.getByText('Cleanest sound · more CPU')).toBeInTheDocument();
        expect(screen.getByTestId('noise-level-experimental')).toHaveTextContent('Experimental');
        expect(screen.getByRole('radiogroup')).toHaveAccessibleName('Noise suppression');
    });

    it('shows the migrated level of an old boolean pref', () => {
        window.localStorage.setItem(STORAGE_CALLS_NOISE_SUPPRESSION_KEY, 'false');
        wrap(<NoiseLevelMenuItems/>);
        expect(screen.getByTestId('noise-level-off')).toHaveAttribute('aria-checked', 'true');
    });

    it('choosing a level stores it and applies it to the live microphone', () => {
        wrap(<NoiseLevelMenuItems/>);

        fireEvent.click(screen.getByTestId('noise-level-maximum'));

        expect(getNoiseLevel()).toBe('maximum');
        expect(screen.getByTestId('noise-level-maximum')).toHaveAttribute('aria-checked', 'true');
        expect(client.applyNoiseSuppression).toHaveBeenCalled();
    });

    it('does not fail without a call client in the window', () => {
        delete (window as any).callsClient;
        wrap(<NoiseLevelMenuItems/>);
        fireEvent.click(screen.getByTestId('noise-level-standard'));
        expect(getNoiseLevel()).toBe('standard');
    });

    it('follows a change made in the settings dialog', () => {
        wrap(<NoiseLevelMenuItems/>);
        act(() => setNoiseLevel('off'));
        expect(screen.getByTestId('noise-level-off')).toHaveAttribute('aria-checked', 'true');
    });

    it('moves the check to Standard and says why after a fallback', () => {
        wrap(<NoiseLevelMenuItems/>);
        act(() => setNoiseStatus({requested: 'enhanced', effective: 'standard', phase: 'active', fallback: {from: 'enhanced', reason: 'unavailable'}}));

        expect(screen.getByTestId('noise-level-standard')).toHaveAttribute('aria-checked', 'true');
        expect(screen.getByTestId('noise-level-enhanced')).toHaveAttribute('aria-checked', 'false');
        expect(screen.getByRole('status')).toHaveTextContent('The Enhanced filter could not be loaded here, so the browser’s own noise suppression is used.');
    });

    it('choosing the level that fell back again retries it', () => {
        wrap(<NoiseLevelMenuItems/>);
        act(() => setNoiseStatus({requested: 'enhanced', effective: 'standard', phase: 'active', fallback: {from: 'enhanced', reason: 'overload'}}));
        client.applyNoiseSuppression.mockClear();

        fireEvent.click(screen.getByTestId('noise-level-enhanced'));
        expect(client.applyNoiseSuppression).toHaveBeenCalled();
        expect(window.localStorage.getItem(STORAGE_CALLS_NOISE_FALLBACK_KEY)).toBeNull();
    });

    it('shows a CPU bar under Maximum only while it runs', () => {
        setNoiseLevel('maximum');
        wrap(<NoiseLevelMenuItems/>);
        expect(screen.queryByTestId('noise-level-load')).not.toBeInTheDocument();

        act(() => setNoiseStatus({requested: 'maximum', effective: 'maximum', phase: 'active', load: {busy: 0.2, peakMs: 3, realtime: 1}}));
        expect(screen.getByTestId('noise-level-load')).toHaveAttribute('value', '20');

        act(() => updateNoiseStatus({load: {busy: 3, peakMs: 3, realtime: 1}}));
        expect(screen.getByTestId('noise-level-load')).toHaveAttribute('value', '100');
    });

    it('arrow keys move the focus between the levels without choosing', () => {
        wrap(<NoiseLevelMenuItems/>);
        screen.getByTestId('noise-level-enhanced').focus();

        fireEvent.keyDown(screen.getByTestId('noise-level-enhanced'), {key: 'ArrowDown'});
        expect(screen.getByTestId('noise-level-maximum')).toHaveFocus();
        fireEvent.keyDown(screen.getByTestId('noise-level-maximum'), {key: 'ArrowDown'});
        expect(screen.getByTestId('noise-level-off')).toHaveFocus();
        expect(getNoiseLevel()).toBe('enhanced');
    });
});

describe('NoiseFallbackNotice', () => {
    afterEach(() => {
        window.localStorage.clear();
        act(() => resetNoiseStatus());
    });

    it('is not shown for a stale fallback of another level', () => {
        setNoiseLevel('off');
        act(() => setNoiseStatus({requested: 'maximum', effective: 'standard', phase: 'active', fallback: {from: 'maximum', reason: 'error'}}));
        render(<RawIntlProvider value={intl}><NoiseFallbackNotice/></RawIntlProvider>);
        expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });
});
