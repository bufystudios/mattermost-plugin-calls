// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {act, fireEvent, render, screen} from '@testing-library/react';
import React from 'react';
import {createIntl, RawIntlProvider} from 'react-intl';
import {getShareQuality, setShareQuality} from 'src/screen_share_quality';

import ScreenSourceModal from './component';

// Desktop app: the quality picker lives in the screen source modal, next to the source choice.

jest.mock('src/utils', () => ({
    getPlatformInfo: () => 'Linux',
    sendDesktopEvent: jest.fn(),
    shareAudioWithScreen: () => false,
    shouldRenderDesktopWidget: () => false,
}));

const intl = createIntl({locale: 'en', messages: {}});

describe('ScreenSourceModal quality picker', () => {
    let getDesktopSources: jest.Mock;
    let shareScreen: jest.Mock;
    const hide = jest.fn();

    const renderModal = async () => {
        const ui = (show: boolean) => (
            <RawIntlProvider value={intl}>
                <ScreenSourceModal
                    intl={intl}
                    show={show}
                    hideScreenSourceModal={hide}
                />
            </RawIntlProvider>
        );
        const view = render(ui(false));
        await act(async () => {
            view.rerender(ui(true));
        });
    };

    beforeEach(() => {
        getDesktopSources = jest.fn(async () => [
            {id: 'screen:0:0', name: 'Entire screen', thumbnailURL: 'data:image/png;base64,'},
            {id: 'window:1:0', name: 'Game', thumbnailURL: 'data:image/png;base64,'},
        ]);
        shareScreen = jest.fn();
        (window as any).desktopAPI = {getDesktopSources, shareScreen};
    });

    afterEach(() => {
        delete (window as any).desktopAPI;
        window.localStorage.clear();
        hide.mockClear();
    });

    it('offers the picker with the last choice pre-selected', async () => {
        setShareQuality({auto: false, resolution: '4k', fps: 60, content: 'game', manualBitrateMbps: null});
        await renderModal();

        expect((screen.getByTestId('share-quality-source-resolution') as HTMLSelectElement).value).toBe('4k');
        expect((screen.getByTestId('share-quality-source-fps') as HTMLSelectElement).value).toBe('60');
    });

    it('stores the choice before telling the desktop app to share, so the widget window uses it', async () => {
        await renderModal();

        fireEvent.change(screen.getByTestId('share-quality-source-mode'), {target: {value: 'manual'}});
        fireEvent.change(screen.getByTestId('share-quality-source-resolution'), {target: {value: 'source'}});
        fireEvent.change(screen.getByTestId('share-quality-source-fps'), {target: {value: '30'}});
        fireEvent.change(screen.getByTestId('share-quality-source-content'), {target: {value: 'text'}});

        shareScreen.mockImplementation(() => {
            // The widget window reads the stored value when the share starts.
            expect(getShareQuality()).toEqual({auto: false, resolution: 'source', fps: 30, content: 'text', manualBitrateMbps: null});
        });
        fireEvent.click(screen.getByText('Share'));

        expect(shareScreen).toHaveBeenCalledWith('screen:0:0', false);
        expect(shareScreen).toHaveBeenCalledTimes(1);
        expect(hide).toHaveBeenCalled();
    });

    it('does not store anything when cancelled', async () => {
        await renderModal();
        fireEvent.change(screen.getByTestId('share-quality-source-mode'), {target: {value: 'manual'}});
        fireEvent.change(screen.getByTestId('share-quality-source-resolution'), {target: {value: '720p'}});
        fireEvent.click(screen.getByText('Cancel'));

        expect(shareScreen).not.toHaveBeenCalled();
        expect(getShareQuality().resolution).not.toBe('720p');
    });
});
