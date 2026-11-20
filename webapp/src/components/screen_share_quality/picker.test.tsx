// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {fireEvent, render, screen} from '@testing-library/react';
import React from 'react';
import {createIntl, RawIntlProvider} from 'react-intl';
import {defaultShareQuality, type ScreenShareQuality} from 'src/screen_share_quality';

import ScreenShareQualityPicker from './picker';

const intl = createIntl({locale: 'en', messages: {}});

const renderPicker = (value: ScreenShareQuality) => {
    const onChange = jest.fn();
    render(
        <RawIntlProvider value={intl}>
            <ScreenShareQualityPicker
                value={value}
                onChange={onChange}
            />
        </RawIntlProvider>,
    );
    return onChange;
};

describe('ScreenShareQualityPicker', () => {
    it('Auto is the default for a new user: only the content type is asked', () => {
        renderPicker(defaultShareQuality);

        expect((screen.getByTestId('share-quality-mode') as HTMLSelectElement).value).toBe('auto');
        expect(screen.getByTestId('share-quality-content')).toBeInTheDocument();
        expect(screen.queryByTestId('share-quality-resolution')).not.toBeInTheDocument();
        expect(screen.queryByTestId('share-quality-fps')).not.toBeInTheDocument();
        expect(screen.queryByTestId('share-quality-manual-bitrate')).not.toBeInTheDocument();
    });

    it('explains what Auto does for the chosen content', () => {
        renderPicker({...defaultShareQuality, content: 'game'});
        expect(screen.getByTestId('share-quality-auto-hint')).toHaveTextContent('1440p and 60 fps');
    });

    it('explains Text: frame rate goes first', () => {
        renderPicker({...defaultShareQuality, content: 'text'});
        expect(screen.getByTestId('share-quality-auto-hint')).toHaveTextContent('lowers the frame rate first');
    });

    it('switching to Manual keeps the manual values and shows all the controls', () => {
        const onChange = renderPicker(defaultShareQuality);
        fireEvent.change(screen.getByTestId('share-quality-mode'), {target: {value: 'manual'}});
        expect(onChange).toHaveBeenCalledWith({...defaultShareQuality, auto: false});
    });

    it('a manual choice shows resolution, frame rate, content and bitrate, and can go back to Auto', () => {
        const onChange = renderPicker({...defaultShareQuality, auto: false, resolution: '1440p'});

        expect((screen.getByTestId('share-quality-mode') as HTMLSelectElement).value).toBe('manual');
        expect((screen.getByTestId('share-quality-resolution') as HTMLSelectElement).value).toBe('1440p');
        expect(screen.getByTestId('share-quality-fps')).toBeInTheDocument();
        expect(screen.getByTestId('share-quality-content')).toBeInTheDocument();
        expect(screen.getByTestId('share-quality-auto-bitrate')).toBeInTheDocument();

        fireEvent.change(screen.getByTestId('share-quality-mode'), {target: {value: 'auto'}});
        expect(onChange).toHaveBeenCalledWith(expect.objectContaining({auto: true, resolution: '1440p'}));
    });

    it('changing the content in Auto keeps Auto on', () => {
        const onChange = renderPicker(defaultShareQuality);
        fireEvent.change(screen.getByTestId('share-quality-content'), {target: {value: 'text'}});
        expect(onChange).toHaveBeenCalledWith({...defaultShareQuality, content: 'text'});
    });
});
