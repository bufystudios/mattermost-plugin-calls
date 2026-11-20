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

const ignore = () => undefined;

type CardProps = {
    profile: UserProfile;
    onWatch: () => void;

    // Smaller layout for the call widget.
    compact?: boolean;

    // The expanded view has a dark background regardless of the theme.
    onDark?: boolean;
};

// What a viewer sees for someone's screen share until they choose to watch it.
export function LiveStreamCard({profile, onWatch, compact = false, onDark = false}: CardProps) {
    const {formatMessage} = useIntl();
    const name = getUserDisplayName(profile);

    return (
        <CardRoot
            $compact={compact}
            $onDark={onDark}
            data-testid='live-stream-card'
        >
            <AvatarWrap>
                <Avatar
                    size={compact ? 40 : 72}
                    border={false}
                    url={Client4.getProfilePictureUrl(profile.id, profile.last_picture_update)}
                />
                <BadgeWrap>
                    <LiveBadge small={compact}/>
                </BadgeWrap>
            </AvatarWrap>
            <CardTitle $compact={compact}>
                {formatMessage({defaultMessage: '{name} is sharing their screen'}, {name})}
            </CardTitle>
            <WatchButton
                className='style--none'
                data-testid='watch-stream-button'
                onClick={onWatch}
            >
                {formatMessage({defaultMessage: 'Watch stream'})}
            </WatchButton>
        </CardRoot>
    );
}

type ActionsProps = {

    // The element showing the stream.
    getVideo: () => HTMLVideoElement | null;
    onStopWatching: () => void;
    onDark?: boolean;

    // The expanded view already has a fullscreen button on its player.
    showFullscreen?: boolean;
    className?: string;
};

// Fullscreen, picture-in-picture (a floating window that stays on top) and "stop watching".
export function StreamActions({getVideo, onStopWatching, onDark = false, showFullscreen = true, className}: ActionsProps) {
    const {formatMessage} = useIntl();

    const fullscreen = () => {
        getVideo()?.requestFullscreen?.().catch(ignore);
    };

    const popout = () => {
        const video = getVideo();
        if (video && typeof video.requestPictureInPicture === 'function') {
            video.requestPictureInPicture().catch(ignore);
        }
    };

    const canPopout = typeof document !== 'undefined' && Boolean(document.pictureInPictureEnabled);

    return (
        <ActionsRoot
            className={className}
            data-testid='stream-actions'
        >
            {showFullscreen &&
                <ActionButton
                    className='style--none'
                    $onDark={onDark}
                    onClick={fullscreen}
                >
                    {formatMessage({defaultMessage: 'Fullscreen'})}
                </ActionButton>
            }
            {canPopout &&
                <ActionButton
                    className='style--none'
                    $onDark={onDark}
                    data-testid='stream-popout-button'
                    onClick={popout}
                >
                    {formatMessage({defaultMessage: 'Pop out stream'})}
                </ActionButton>
            }
            <ActionButton
                className='style--none'
                $onDark={onDark}
                data-testid='stop-watching-button'
                onClick={onStopWatching}
            >
                {formatMessage({defaultMessage: 'Stop watching'})}
            </ActionButton>
        </ActionsRoot>
    );
}

const CardRoot = styled.div<{$compact: boolean, $onDark: boolean}>`
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: ${({$compact}) => ($compact ? '6px' : '12px')};
    padding: ${({$compact}) => ($compact ? '12px 8px' : '24px')};
    border-radius: 8px;
    text-align: center;
    background: ${({$onDark}) => ($onDark ? 'rgba(var(--sidebar-text-rgb), 0.08)' : 'rgba(var(--center-channel-color-rgb), 0.04)')};
    color: ${({$onDark}) => ($onDark ? 'white' : 'var(--center-channel-color)')};
`;

const AvatarWrap = styled.div`
    position: relative;
    display: flex;
`;

const BadgeWrap = styled.div`
    position: absolute;
    left: 50%;
    bottom: -6px;
    transform: translateX(-50%);
`;

const CardTitle = styled.span<{$compact: boolean}>`
    margin-top: 4px;
    font-size: ${({$compact}) => ($compact ? '12px' : '14px')};
    font-weight: 600;
    line-height: 16px;
`;

const WatchButton = styled.button`
    padding: 8px 16px;
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

const ActionsRoot = styled.div`
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 4px 12px;
`;

const ActionButton = styled.button<{$onDark: boolean}>`
    padding: 2px 0;
    color: ${({$onDark}) => ($onDark ? 'white' : 'var(--button-bg)')};
    font-size: 12px;
    font-weight: 600;
    line-height: 16px;
    background: none;
    border: none;
    cursor: pointer;
`;
