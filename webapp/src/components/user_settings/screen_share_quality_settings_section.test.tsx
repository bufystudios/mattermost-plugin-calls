// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {fireEvent, render, screen} from '@testing-library/react';
import React from 'react';
import {createIntl, RawIntlProvider} from 'react-intl';
import {STORAGE_CALLS_SHARE_QUALITY_KEY} from 'src/constants';
import {defaultShareQuality, getShareQuality, setShareQuality} from 'src/screen_share_quality';

import ScreenShareQualitySettingsSection from './screen_share_quality_settings_section';

const intl = createIntl({locale: 'en', messages: {}});

const renderSection = () => render(
    <RawIntlProvider value={intl}>
        <ScreenShareQualitySettingsSection/>
    </RawIntlProvider>,
);

const open = () => fireEvent.click(screen.getByText('Edit'));

describe('ScreenShareQualitySettingsSection', () => {
    afterEach(() => {
        window.localStorage.clear();
    });

    it('summarizes the default: Auto for a new user', () => {
        renderSection();
        expect(screen.getByText(/Default: Auto, game \/ video\./)).toBeInTheDocument();
    });

    it('summarizes a manual choice that was stored before Auto existed', () => {
        window.localStorage.setItem(STORAGE_CALLS_SHARE_QUALITY_KEY, JSON.stringify({resolution: '1440p', fps: 30, content: 'text', manualBitrateMbps: null}));
        renderSection();
        expect(screen.getByText(/Default: 1440p at 30 fps, text \/ slides, automatic bitrate\./)).toBeInTheDocument();
    });

    it('saves a new default that the picker then starts with', () => {
        renderSection();
        open();

        fireEvent.change(screen.getByTestId('share-quality-settings-mode'), {target: {value: 'manual'}});
        fireEvent.change(screen.getByTestId('share-quality-settings-resolution'), {target: {value: '4k'}});
        fireEvent.change(screen.getByTestId('share-quality-settings-fps'), {target: {value: '30'}});
        fireEvent.click(screen.getByTestId('share-quality-settings-manual-bitrate'));
        fireEvent.change(screen.getByTestId('share-quality-settings-bitrate-slider'), {target: {value: '18'}});
        fireEvent.click(screen.getByTestId('share-quality-settings-save'));

        expect(getShareQuality()).toEqual({auto: false, resolution: '4k', fps: 30, content: 'game', manualBitrateMbps: 18});
        expect(screen.getByText(/Default: 4K at 30 fps, game \/ video, 18 Mbps\./)).toBeInTheDocument();
    });

    it('does not change anything on cancel', () => {
        renderSection();
        open();
        fireEvent.change(screen.getByTestId('share-quality-settings-mode'), {target: {value: 'manual'}});
        fireEvent.change(screen.getByTestId('share-quality-settings-resolution'), {target: {value: '720p'}});
        fireEvent.click(screen.getByText('Cancel'));

        expect(getShareQuality()).toEqual(defaultShareQuality);
    });

    it('re-reads the stored value when opened again', () => {
        renderSection();
        setShareQuality({auto: false, resolution: '1440p', fps: 15, content: 'text', manualBitrateMbps: null});
        open();
        expect((screen.getByTestId('share-quality-settings-resolution') as HTMLSelectElement).value).toBe('1440p');
    });
});
