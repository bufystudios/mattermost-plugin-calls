// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import React, {useEffect, useState} from 'react';
import {useIntl} from 'react-intl';
import {useSelector} from 'react-redux';
import type {ScreenQualityInfo} from 'src/client';
import {qualityInfoLabel} from 'src/components/screen_share_quality/label';
import {listenForScreenShareQuality, stopOwnScreenShare} from 'src/screen_share_bridge';
import {ownScreenSharing} from 'src/selectors';
import {getCallsClient, isCallsPopOut} from 'src/utils';
import styled, {keyframes} from 'styled-components';

export const SHARING_TITLE_PREFIX = '🔴 ';

// Prefixes the tab / window title while `active`, and takes it off again. The app rewrites the title on
// navigation and unread changes, so a MutationObserver puts the prefix back.
export function useSharingTitle(active: boolean) {
    useEffect(() => {
        if (!active) {
            // eslint-disable-next-line no-undefined
            return undefined;
        }
        const apply = () => {
            if (!document.title.startsWith(SHARING_TITLE_PREFIX)) {
                document.title = SHARING_TITLE_PREFIX + document.title;
            }
        };
        apply();

        let observer: MutationObserver | null = null;
        const titleEl = document.querySelector('title');
        if (titleEl && typeof MutationObserver !== 'undefined') {
            observer = new MutationObserver(apply);
            observer.observe(titleEl, {childList: true, characterData: true, subtree: true});
        }
        return () => {
            observer?.disconnect();
            if (document.title.startsWith(SHARING_TITLE_PREFIX)) {
                document.title = document.title.slice(SHARING_TITLE_PREFIX.length);
            }
        };
    }, [active]);
}

// The quality of the share that is going on: from the call client when this window owns it, else
// (desktop app main window) from the window that does.
function useShareQualityInfo(active: boolean): ScreenQualityInfo | null {
    const [info, setInfo] = useState<ScreenQualityInfo | null>(null);

    useEffect(() => {
        if (!active) {
            setInfo(null);
            // eslint-disable-next-line no-undefined
            return undefined;
        }
        const client = getCallsClient();
        if (client) {
            const update = (next?: ScreenQualityInfo) => setInfo(next ?? client.getScreenQualityInfo?.() ?? null);
            update();
            client.on?.('screenQuality', update);
            return () => {
                client.off?.('screenQuality', update);
            };
        }
        return listenForScreenShareQuality(setInfo);
    }, [active]);

    return info;
}

// Always visible while the current user shares their screen, whatever page they are on (registered as a
// global component): "You're sharing your screen · 1080p60 · 8 Mbps · Stop sharing". It can be folded to a
// small pulsing red dot but is never hidden. Not shown in the pop out, which has its own preview.
export default function ScreenSharingBanner() {
    const {formatMessage} = useIntl();
    const sharing = useSelector(ownScreenSharing);
    const active = Boolean(sharing);
    const popout = Boolean(isCallsPopOut());
    const [collapsed, setCollapsed] = useState(false);
    const info = useShareQualityInfo(active && !popout);

    useSharingTitle(active && !popout);

    // A new share starts expanded.
    useEffect(() => {
        setCollapsed(false);
    }, [sharing?.sessionID, active]);

    if (!sharing || popout) {
        return null;
    }

    const title = formatMessage({defaultMessage: 'You\'re sharing your screen'});

    if (collapsed) {
        return (
            <Collapsed
                data-testid='screen-sharing-banner-collapsed'
                className='style--none'
                aria-label={formatMessage({defaultMessage: 'You\'re sharing your screen. Click to show details.'})}
                title={title}
                onClick={() => setCollapsed(false)}
            />
        );
    }

    return (
        <Pill
            data-testid='screen-sharing-banner'
            role='status'
        >
            <Dot/>
            <Text>{title}</Text>
            {info &&
                <Quality data-testid='screen-sharing-banner-quality'>{qualityInfoLabel(info, formatMessage)}</Quality>
            }
            <StopButton
                data-testid='screen-sharing-banner-stop'
                className='style--none'
                onClick={stopOwnScreenShare}
            >
                {formatMessage({defaultMessage: 'Stop sharing'})}
            </StopButton>
            <FoldButton
                data-testid='screen-sharing-banner-collapse'
                className='style--none'
                aria-label={formatMessage({defaultMessage: 'Minimize'})}
                title={formatMessage({defaultMessage: 'Minimize'})}
                onClick={() => setCollapsed(true)}
            >
                <FoldIcon/>
            </FoldButton>
        </Pill>
    );
}

const pulse = keyframes`
    0% { box-shadow: 0 0 0 0 rgba(210, 75, 78, 0.6); }
    70% { box-shadow: 0 0 0 8px rgba(210, 75, 78, 0); }
    100% { box-shadow: 0 0 0 0 rgba(210, 75, 78, 0); }
`;

// Below the global header and the channel header (about 96 px with both), so their buttons and the search
// stay reachable; horizontally centered.
const TOP = '104px';

const Pill = styled.div`
    position: fixed;
    top: ${TOP};
    left: 50%;
    transform: translateX(-50%);
    z-index: 1040;
    display: flex;
    align-items: center;
    gap: 8px;
    max-width: calc(100vw - 32px);
    padding: 4px 6px 4px 12px;
    border-radius: 16px;
    background: var(--dnd-indicator, #d24b4e);
    color: white;
    font-size: 12px;
    font-weight: 600;
    line-height: 16px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.24);
`;

const Dot = styled.span`
    flex-shrink: 0;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: white;
    animation: ${pulse} 1.6s infinite;
`;

const Text = styled.span`
    white-space: nowrap;
`;

const Quality = styled.span`
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 400;
    font-variant-numeric: tabular-nums;
    opacity: 0.88;
`;

const StopButton = styled.button`
&&& {
    flex-shrink: 0;
    padding: 2px 10px;
    border-radius: 12px;
    background: white;
    color: #d24b4e;
    font-size: 12px;
    font-weight: 700;
    cursor: pointer;
}
`;

const FoldButton = styled.button`
&&& {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    color: white;
    cursor: pointer;

    &:hover {
        background: rgba(255, 255, 255, 0.24);
    }
}
`;

const FoldIcon = styled.span`
    width: 10px;
    border-top: 2px solid currentColor;
`;

const Collapsed = styled.button`
&&& {
    position: fixed;
    top: ${TOP};
    left: 50%;
    transform: translateX(-50%);
    z-index: 1040;
    width: 16px;
    height: 16px;
    padding: 0;
    border-radius: 50%;
    border: 2px solid white;
    background: var(--dnd-indicator, #d24b4e);
    box-shadow: 0 2px 6px rgba(0, 0, 0, 0.32);
    animation: ${pulse} 1.6s infinite;
    cursor: pointer;
}
`;
