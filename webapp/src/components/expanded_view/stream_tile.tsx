// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {UserProfile} from '@mattermost/types/users';
import {Client4} from 'mattermost-redux/client';
import React from 'react';
import {useIntl} from 'react-intl';
import Avatar from 'src/components/avatar/avatar';
import LiveBadge from 'src/components/live_badge';
import {getUserDisplayName} from 'src/utils';
import styled from 'styled-components';

import {TileSize, tileSizePropsMap} from './participant_cell';

type Props = {
    profile?: UserProfile;
    tileSize: TileSize;
    focused?: boolean;
    onFocusToggle?: () => void;
    onWatch: () => void;
};

// The "card" of somebody's screen share in the participants grid. Nothing is rendered of the
// stream itself until the viewer clicks Watch.
export function StreamTile({profile, tileSize, focused = false, onFocusToggle, onWatch}: Props) {
    const {formatMessage} = useIntl();
    const tile = tileSizePropsMap[tileSize];
    const name = getUserDisplayName(profile);

    return (
        <li
            className='participantCell'
            data-testid='stream-tile'
            data-focused={onFocusToggle ? focused : undefined}
            style={{
                width: `${tile.avatarSize + (tile.padding * 2)}px`,
                padding: `${tile.padding}px`,
                gap: `${tile.gap}px`,
            }}
            onClick={onFocusToggle}
        >
            <div style={{position: 'relative'}}>
                <Avatar
                    size={tile.avatarSize}
                    fontSize={tile.fontSize}
                    border={false}
                    url={profile ? Client4.getProfilePictureUrl(profile.id, profile.last_picture_update) : ''}
                />
            </div>
            <LiveBadge/>
            <span
                className='participantName'
                style={{
                    fontSize: `${tile.fontSize}px`,
                    lineHeight: `${tile.lineHeight}px`,
                }}
            >
                {formatMessage({defaultMessage: '{name}\'s screen'}, {name})}
            </span>
            <WatchButton
                className='style--none'
                data-testid='watch-stream-button'
                onClick={(ev) => {
                    ev.stopPropagation();
                    onWatch();
                }}
            >
                {formatMessage({defaultMessage: 'Watch stream'})}
            </WatchButton>
        </li>
    );
}

const WatchButton = styled.button`
    padding: 6px 12px;
    border-radius: 4px;
    background: var(--button-bg);
    color: var(--button-color);
    font-size: 12px;
    font-weight: 600;
    line-height: 16px;
    border: none;
    cursor: pointer;

    &:hover {
        background: linear-gradient(0deg, rgba(0, 0, 0, 0.08), rgba(0, 0, 0, 0.08)), var(--button-bg);
    }
`;
