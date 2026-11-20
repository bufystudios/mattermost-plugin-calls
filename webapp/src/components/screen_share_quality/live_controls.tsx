// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import React, {useEffect, useState} from 'react';
import {useIntl} from 'react-intl';
import type {default as CallsClient, ScreenQualityInfo} from 'src/client';
import {sameShareQuality, type ScreenShareQuality} from 'src/screen_share_quality';
import styled from 'styled-components';

import {qualityInfoLabel} from './label';
import ScreenShareQualityPicker from './picker';

type Props = {

    // The client that owns the share (widget: window.callsClient, pop out: its opener's client).
    getClient: () => CallsClient | undefined | null;
    onDark?: boolean;
};

// Shown on the sharer's own preview: the quality that is in use (e.g. "1440p60 · 12 Mbps")
// and a way to change it without sharing again.
export default function ScreenShareQualityLive({getClient, onDark = false}: Props) {
    const {formatMessage} = useIntl();
    const [info, setInfo] = useState<ScreenQualityInfo | null>(() => getClient()?.getScreenQualityInfo?.() ?? null);
    const [open, setOpen] = useState(false);

    useEffect(() => {
        const client = getClient();
        if (!client) {
            // eslint-disable-next-line no-undefined
            return undefined;
        }
        setInfo(client.getScreenQualityInfo?.() ?? null);
        const onQuality = (next: ScreenQualityInfo) => setInfo(next);
        client.on?.('screenQuality', onQuality);
        return () => {
            client.off?.('screenQuality', onQuality);
        };

        // The client does not change during a share.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    if (!info) {
        return null;
    }

    const change = (next: ScreenShareQuality) => {
        // Reflect the choice in the form right away, the client reports the applied values back.
        setInfo({...info, quality: next, auto: next.auto ? info.auto : null});
        getClient()?.setScreenQuality(next);
    };

    const label = qualityInfoLabel(info, formatMessage);

    return (
        <Root $onDark={onDark}>
            <Summary>
                <Label data-testid='share-quality-label'>
                    {label}
                </Label>
                <button
                    className='style--none'
                    data-testid='share-quality-toggle'
                    aria-expanded={open}
                    onClick={() => setOpen(!open)}
                >
                    {formatMessage({defaultMessage: 'Quality'})}
                </button>
            </Summary>
            {open &&
                <Panel data-testid='share-quality-live-panel'>
                    <ScreenShareQualityPicker
                        compact={true}
                        idPrefix='share-quality-live'
                        value={info.quality}
                        onChange={(next) => {
                            if (!sameShareQuality(next, info.quality)) {
                                change(next);
                            }
                        }}
                    />
                </Panel>
            }
        </Root>
    );
}

const Root = styled.div<{$onDark: boolean}>`
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 6px;
    width: 100%;
    padding: 4px 8px;
    color: ${({$onDark}) => ($onDark ? 'rgba(255, 255, 255, 0.72)' : 'rgba(var(--center-channel-color-rgb), 0.72)')};
    font-size: 12px;

    select, input[type='range'] {
        color-scheme: ${({$onDark}) => ($onDark ? 'dark' : 'normal')};
    }
`;

const Summary = styled.div`
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;

    button {
        color: var(--button-bg);
        font-weight: 600;
        text-decoration: underline;
    }
`;

const Label = styled.span`
    font-variant-numeric: tabular-nums;
`;

const Panel = styled.div`
    padding: 8px;
    border-radius: 4px;
    border: 1px solid rgba(var(--center-channel-color-rgb), 0.16);
    background: var(--center-channel-bg);
    color: var(--center-channel-color);
`;
