// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import React, {useEffect, useRef, useState} from 'react';
import {useIntl} from 'react-intl';
import SpeakerIcon from 'src/components/icons/speaker_icon';
import {
    DEFAULT_USER_VOLUME,
    getUserVolume,
    MAX_USER_VOLUME,
    MIN_USER_VOLUME,
    setUserVolume,
    subscribeUserVolumes,
} from 'src/user_volume';
import styled from 'styled-components';

// Current stored volume of a user (0..2, 1 = 100%). Follows changes made in any window.
export function useUserVolume(userID: string): number {
    const [volume, setVolume] = useState(() => getUserVolume(userID));

    useEffect(() => {
        setVolume(getUserVolume(userID));
        return subscribeUserVolumes(() => setVolume(getUserVolume(userID)));
    }, [userID]);

    return volume;
}

type SliderProps = {
    userID: string;
    name: string;
    className?: string;
};

// Slider + reset for the local playback volume of one remote participant.
export function UserVolumeSlider({userID, name, className}: SliderProps) {
    const {formatMessage} = useIntl();
    const volume = useUserVolume(userID);
    const percent = Math.round(volume * 100);
    const percentLabel = formatMessage({defaultMessage: '{percent}%'}, {percent});

    return (
        <SliderRoot
            className={className}
            data-testid='user-volume-slider'
        >
            <SliderHeader>
                <span>{formatMessage({defaultMessage: 'Volume for {name}'}, {name})}</span>
                <SliderPercent>{percentLabel}</SliderPercent>
            </SliderHeader>
            <input
                type='range'
                aria-label={formatMessage({defaultMessage: 'Volume for {name}'}, {name})}
                min={MIN_USER_VOLUME * 100}
                max={MAX_USER_VOLUME * 100}
                step={5}
                value={percent}
                onChange={(ev) => setUserVolume(userID, Number(ev.target.value) / 100)}
                onDoubleClick={() => setUserVolume(userID, DEFAULT_USER_VOLUME)}
                style={{width: '100%'}}
            />
            <ResetButton
                className='style--none'
                disabled={volume === DEFAULT_USER_VOLUME}
                onClick={() => setUserVolume(userID, DEFAULT_USER_VOLUME)}
            >
                {formatMessage({defaultMessage: 'Reset to 100%'})}
            </ResetButton>
        </SliderRoot>
    );
}

type ButtonProps = SliderProps & {

    // Where the popover opens relative to the button.
    placement?: 'bottom-start' | 'bottom-end';
};

// Small speaker button that opens the slider in a popover. For surfaces with room around
// them (expanded view). The call widget shows the slider in the flow instead, since its
// window size follows its content.
export function UserVolumeButton({userID, name, placement = 'bottom-start', className}: ButtonProps) {
    const {formatMessage} = useIntl();
    const [open, setOpen] = useState(false);
    const rootRef = useRef<HTMLDivElement>(null);
    const volume = useUserVolume(userID);

    useEffect(() => {
        if (!open) {
            // eslint-disable-next-line no-undefined
            return undefined;
        }
        const onDown = (ev: MouseEvent) => {
            if (!rootRef.current?.contains(ev.target as Node)) {
                setOpen(false);
            }
        };
        const onKey = (ev: KeyboardEvent) => {
            if (ev.key === 'Escape') {
                setOpen(false);
            }
        };
        document.addEventListener('mousedown', onDown, true);
        document.addEventListener('keydown', onKey, true);
        return () => {
            document.removeEventListener('mousedown', onDown, true);
            document.removeEventListener('keydown', onKey, true);
        };
    }, [open]);

    const label = formatMessage({defaultMessage: 'Volume for {name}'}, {name});

    return (
        <ButtonRoot
            ref={rootRef}
            className={className}
            onClick={(ev) => ev.stopPropagation()}
        >
            <IconButton
                className='style--none'
                aria-label={label}
                aria-expanded={open}
                title={label}
                data-testid='user-volume-button'
                $active={open || volume !== DEFAULT_USER_VOLUME}
                onClick={() => setOpen(!open)}
            >
                <SpeakerIcon style={{width: '14px', height: '14px', fill: 'currentColor'}}/>
            </IconButton>
            {open &&
                <Popover $placement={placement}>
                    <UserVolumeSlider
                        userID={userID}
                        name={name}
                    />
                </Popover>
            }
        </ButtonRoot>
    );
}

const SliderRoot = styled.div`
    display: flex;
    flex-direction: column;
    gap: 6px;
    min-width: 180px;
    color: var(--center-channel-color);
    font-size: 12px;
    line-height: 16px;
`;

const SliderHeader = styled.div`
    display: flex;
    justify-content: space-between;
    gap: 8px;
    font-weight: 600;
`;

const SliderPercent = styled.span`
    color: rgba(var(--center-channel-color-rgb), 0.72);
    font-variant-numeric: tabular-nums;
`;

const ResetButton = styled.button`
    align-self: flex-start;
    padding: 0;
    color: var(--button-bg);
    font-size: 12px;
    font-weight: 600;
    background: none;
    border: none;

    &:disabled {
        color: rgba(var(--center-channel-color-rgb), 0.32);
        cursor: default;
    }
`;

const ButtonRoot = styled.div`
    position: relative;
    display: inline-flex;
`;

const IconButton = styled.button<{$active: boolean}>`
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    border-radius: 50%;
    color: ${({$active}) => ($active ? 'var(--button-bg)' : 'rgba(var(--center-channel-color-rgb), 0.72)')};
    background: var(--center-channel-bg);
    border: 1px solid rgba(var(--center-channel-color-rgb), 0.16);
    cursor: pointer;

    &:hover {
        background: rgba(var(--button-bg-rgb), 0.08);
    }
`;

const Popover = styled.div<{$placement: string}>`
    position: absolute;
    top: calc(100% + 6px);
    ${({$placement}) => ($placement === 'bottom-end' ? 'right: 0;' : 'left: 0;')}
    z-index: 1100;
    padding: 12px;
    border-radius: 8px;
    background: var(--center-channel-bg);
    border: 1px solid rgba(var(--center-channel-color-rgb), 0.16);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
`;
