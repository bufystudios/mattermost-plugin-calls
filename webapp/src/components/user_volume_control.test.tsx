// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {act, fireEvent, render, screen} from '@testing-library/react';
import React from 'react';
import {createIntl, RawIntlProvider} from 'react-intl';
import {getUserVolume, setUserVolume} from 'src/user_volume';

import {UserVolumeButton, UserVolumeSlider} from './user_volume_control';

const intl = createIntl({locale: 'en', messages: {}});

const wrap = (ui: React.ReactElement) => render(<RawIntlProvider value={intl}>{ui}</RawIntlProvider>);

describe('UserVolumeSlider', () => {
    afterEach(() => {
        window.localStorage.clear();
    });

    it('starts at the stored volume', () => {
        setUserVolume('user-a', 0.35);
        wrap(
            <UserVolumeSlider
                userID='user-a'
                name='Ann'
            />,
        );

        expect(screen.getByRole('slider')).toHaveValue('35');
        expect(screen.getByText('35%')).toBeInTheDocument();
    });

    it('stores the volume per user when moved, up to 200%', () => {
        wrap(
            <UserVolumeSlider
                userID='user-a'
                name='Ann'
            />,
        );

        fireEvent.change(screen.getByRole('slider'), {target: {value: '170'}});

        expect(getUserVolume('user-a')).toBe(1.7);
        expect(screen.getByText('170%')).toBeInTheDocument();
        expect(getUserVolume('user-b')).toBe(1);
    });

    it('resets to 100%', () => {
        setUserVolume('user-a', 0.5);
        wrap(
            <UserVolumeSlider
                userID='user-a'
                name='Ann'
            />,
        );

        fireEvent.click(screen.getByText('Reset to 100%'));

        expect(getUserVolume('user-a')).toBe(1);
        expect(screen.getByText('Reset to 100%')).toBeDisabled();
    });

    it('follows a change made in another window', () => {
        wrap(
            <UserVolumeSlider
                userID='user-a'
                name='Ann'
            />,
        );

        act(() => {
            window.localStorage.setItem('calls_user_volumes', '{"user-a":0.6}');
            window.dispatchEvent(new StorageEvent('storage', {key: 'calls_user_volumes'}));
        });

        expect(screen.getByRole('slider')).toHaveValue('60');
    });
});

describe('UserVolumeButton', () => {
    afterEach(() => {
        window.localStorage.clear();
    });

    it('opens the slider in a popover and closes it on Escape or an outside click', () => {
        wrap(
            <div>
                <UserVolumeButton
                    userID='user-a'
                    name='Ann'
                />
                <span data-testid='outside'/>
            </div>,
        );
        expect(screen.queryByRole('slider')).not.toBeInTheDocument();

        fireEvent.click(screen.getByTestId('user-volume-button'));
        expect(screen.getByRole('slider')).toBeInTheDocument();

        fireEvent.keyDown(document, {key: 'Escape'});
        expect(screen.queryByRole('slider')).not.toBeInTheDocument();

        fireEvent.click(screen.getByTestId('user-volume-button'));
        fireEvent.mouseDown(screen.getByTestId('outside'));
        expect(screen.queryByRole('slider')).not.toBeInTheDocument();
    });
});
