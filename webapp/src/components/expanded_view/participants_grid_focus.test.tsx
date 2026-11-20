// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {UserSessionState} from '@mattermost/calls-common/lib/types';
import {UserProfile} from '@mattermost/types/users';
import {fireEvent, render, screen, within} from '@testing-library/react';
import React from 'react';
import {createIntl, RawIntlProvider} from 'react-intl';
import {useDMCallingState} from 'src/components/use_dm_calling_state';

import {TileSize} from './participant_cell';
import {ParticipantsGrid} from './participants_grid';

// Focus (enlarge a participant or the screen card) and the LIVE stream tile of the participants grid.

jest.mock('src/components/dot_menu/dot_menu', () => ({
    __esModule: true,
    default: 'div',
    DotMenuButton: 'div',
    DropdownMenu: 'div',
    DropdownMenuItem: 'div',
}));

// Tiles have their own tests; here they only report their size and let the test click them.
jest.mock('./participant_tile', () => ({
    ParticipantTile: ({session, tileSize, isSharingScreen, focused, onFocusToggle}: any) => (
        <li
            data-testid={'participant-tile'}
            data-size={tileSize}
            data-live={String(Boolean(isSharingScreen))}
            data-focused={String(Boolean(focused))}
        >
            {session.user_id}
            {onFocusToggle && (
                <button
                    data-testid={`focus-${session.user_id}`}
                    onClick={() => onFocusToggle(session.session_id)}
                />
            )}
        </li>
    ),
}));

jest.mock('./participant_tile_loading', () => ({
    ParticipantTileLoading: () => null,
}));

jest.mock('src/components/use_dm_calling_state', () => ({
    useDMCallingState: jest.fn(),
}));

const intl = createIntl({locale: 'en', messages: {}});

beforeAll(() => {
    (global as any).ResizeObserver = class {
        observe() {
            // jsdom has no layout.
        }
        disconnect() {
            // Nothing to release.
        }
    };
});

const session = (userID: string) => ({session_id: `${userID}-session`, user_id: userID}) as UserSessionState;
const sessions = [session('ann'), session('bob'), session('cy')];
const sharer = {id: 'bob', username: 'bob'} as UserProfile;

const renderGrid = (props: Partial<React.ComponentProps<typeof ParticipantsGrid>> = {}) => {
    (useDMCallingState as jest.Mock).mockReturnValue({isDM: false, isDMCalling: false});
    return render(
        <RawIntlProvider value={intl}>
            <ParticipantsGrid
                callID='call'
                callHostID='ann'
                profiles={{}}
                sessions={sessions}
                {...props}
            />
        </RawIntlProvider>,
    );
};

describe('ParticipantsGrid focus', () => {
    it('enlarges a clicked tile and moves the others to a strip of small tiles', () => {
        renderGrid();

        fireEvent.click(screen.getByTestId('focus-bob'));

        const layout = screen.getByTestId('calls-expanded-view-focused-layout');
        const tiles = within(layout).getAllByTestId('participant-tile');
        const bob = tiles.find((t) => t.textContent === 'bob')!;
        expect(bob).toHaveAttribute('data-size', String(TileSize.Focused));
        expect(bob).toHaveAttribute('data-focused', 'true');
        for (const other of tiles.filter((t) => t !== bob)) {
            expect(other).toHaveAttribute('data-size', String(TileSize.Small));
        }
        expect(tiles).toHaveLength(3);
    });

    it('goes back to the grid when the enlarged tile is clicked again', () => {
        renderGrid();
        fireEvent.click(screen.getByTestId('focus-bob'));

        fireEvent.click(screen.getByTestId('focus-bob'));

        expect(screen.queryByTestId('calls-expanded-view-focused-layout')).not.toBeInTheDocument();
    });

    it('goes back to the grid with Escape', () => {
        renderGrid();
        fireEvent.click(screen.getByTestId('focus-bob'));

        fireEvent.keyDown(window, {key: 'Escape'});

        expect(screen.queryByTestId('calls-expanded-view-focused-layout')).not.toBeInTheDocument();
    });

    it('moves the focus to another tile when it is clicked', () => {
        renderGrid();
        fireEvent.click(screen.getByTestId('focus-bob'));

        fireEvent.click(screen.getByTestId('focus-cy'));

        const tiles = within(screen.getByTestId('calls-expanded-view-focused-layout')).getAllByTestId('participant-tile');
        expect(tiles.find((t) => t.textContent === 'cy')).toHaveAttribute('data-size', String(TileSize.Focused));
        expect(tiles.find((t) => t.textContent === 'bob')).toHaveAttribute('data-size', String(TileSize.Small));
    });

    it('falls back to the grid when the focused participant leaves', () => {
        const {rerender} = renderGrid();
        fireEvent.click(screen.getByTestId('focus-bob'));

        rerender(
            <RawIntlProvider value={intl}>
                <ParticipantsGrid
                    callID='call'
                    callHostID='ann'
                    profiles={{}}
                    sessions={[session('ann'), session('cy')]}
                />
            </RawIntlProvider>,
        );

        expect(screen.queryByTestId('calls-expanded-view-focused-layout')).not.toBeInTheDocument();
        expect(screen.getAllByTestId('participant-tile')).toHaveLength(2);
    });

    it('has no focus in the recorder view (static picture)', () => {
        renderGrid({profileImages: {ann: 'blob:1'}});

        expect(screen.queryByTestId('focus-ann')).not.toBeInTheDocument();
    });
});

describe('ParticipantsGrid LIVE stream tile', () => {
    it('shows a Watch tile for a share the viewer did not open and badges the sharer', () => {
        const onWatch = jest.fn();
        renderGrid({liveStream: {sessionID: 'bob-session', profile: sharer, onWatch}});

        expect(screen.getByTestId('stream-tile')).toBeInTheDocument();
        expect(screen.getAllByTestId('participant-tile').find((t) => t.textContent === 'bob')).toHaveAttribute('data-live', 'true');
        expect(screen.getAllByTestId('participant-tile').find((t) => t.textContent === 'ann')).toHaveAttribute('data-live', 'false');

        fireEvent.click(screen.getByTestId('watch-stream-button'));
        expect(onWatch).toHaveBeenCalledTimes(1);
    });

    it('shows no stream tile when nobody shares', () => {
        renderGrid();

        expect(screen.queryByTestId('stream-tile')).not.toBeInTheDocument();
    });

    it('can enlarge the stream tile too, without that counting as watching', () => {
        const onWatch = jest.fn();
        renderGrid({liveStream: {sessionID: 'bob-session', profile: sharer, onWatch}});

        fireEvent.click(screen.getByTestId('stream-tile'));

        const layout = screen.getByTestId('calls-expanded-view-focused-layout');
        expect(within(layout).getByTestId('stream-tile')).toHaveAttribute('data-focused', 'true');
        expect(onWatch).not.toHaveBeenCalled();
        expect(within(layout).getAllByTestId('participant-tile')).toHaveLength(3);
    });
});
