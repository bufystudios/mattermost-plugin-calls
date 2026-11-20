// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import React, {useEffect, useState} from 'react';
import {createPortal} from 'react-dom';
import {useIntl} from 'react-intl';
import {getShareQuality, type ScreenShareQuality, setShareQuality} from 'src/screen_share_quality';
import styled from 'styled-components';

import ScreenShareQualityPicker from './picker';

type Props = {
    show: boolean;
    onConfirm: (quality: ScreenShareQuality) => void;
    onCancel: () => void;
};

// Asks for the quality right before a screen share starts (browser / pop out). The
// last choice is pre-selected and stored again on confirm. The confirm click is the user
// gesture getDisplayMedia needs, so the owner must start the share from onConfirm.
export default function ScreenShareQualityModal({show, onConfirm, onCancel}: Props) {
    const {formatMessage} = useIntl();
    const [quality, setQuality] = useState<ScreenShareQuality>(getShareQuality());

    useEffect(() => {
        if (show) {
            setQuality(getShareQuality());
        }
    }, [show]);

    useEffect(() => {
        if (!show) {
            // eslint-disable-next-line no-undefined
            return undefined;
        }
        const onKey = (ev: KeyboardEvent) => {
            if (ev.key === 'Escape') {
                onCancel();
            }
        };
        document.addEventListener('keydown', onKey, true);
        return () => document.removeEventListener('keydown', onKey, true);
    }, [show, onCancel]);

    if (!show) {
        return null;
    }

    const confirm = () => {
        setShareQuality(quality);
        onConfirm(quality);
    };

    return createPortal(
        <Overlay
            data-testid='share-quality-modal'
            onMouseDown={(ev) => {
                if (ev.target === ev.currentTarget) {
                    onCancel();
                }
            }}
        >
            <Dialog
                role='dialog'
                aria-modal='true'
                aria-label={formatMessage({defaultMessage: 'Screen share quality'})}
            >
                <Title>{formatMessage({defaultMessage: 'Screen share quality'})}</Title>
                <ScreenShareQualityPicker
                    value={quality}
                    onChange={setQuality}
                    idPrefix='share-quality-modal'
                />
                <Footer>
                    <button
                        className='btn btn-tertiary'
                        data-testid='share-quality-cancel'
                        onClick={onCancel}
                    >
                        {formatMessage({defaultMessage: 'Cancel'})}
                    </button>
                    <button
                        className='btn btn-primary'
                        data-testid='share-quality-confirm'
                        onClick={confirm}
                    >
                        {formatMessage({defaultMessage: 'Share'})}
                    </button>
                </Footer>
            </Dialog>
        </Overlay>,
        document.body,
    );
}

const Overlay = styled.div`
    position: fixed;
    inset: 0;
    z-index: 10000;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(0, 0, 0, 0.64);
`;

const Dialog = styled.div`
    display: flex;
    flex-direction: column;
    gap: 16px;
    width: min(480px, calc(100vw - 32px));
    max-height: calc(100vh - 32px);
    overflow: auto;
    padding: 24px;
    border-radius: 8px;
    border: 1px solid rgba(var(--center-channel-color-rgb), 0.16);
    background: var(--center-channel-bg);
    color: var(--center-channel-color);
    box-shadow: 0 20px 32px rgba(var(--center-channel-color-rgb), 0.12);
`;

const Title = styled.h4`
    margin: 0;
    font-size: 18px;
    font-weight: 600;
`;

const Footer = styled.div`
    display: flex;
    justify-content: flex-end;
    gap: 8px;
`;
