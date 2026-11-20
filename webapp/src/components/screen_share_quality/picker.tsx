// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import React from 'react';
import {useIntl} from 'react-intl';
import {
    autoBitrateMbps,
    bitratePixels,
    MANUAL_BITRATE_MAX_MBPS,
    MANUAL_BITRATE_MIN_MBPS,
    MANUAL_BITRATE_STEP_MBPS,
    type ScreenShareQuality,
    shareContents,
    shareFpsOptions,
    shareResolutions,
} from 'src/screen_share_quality';
import styled from 'styled-components';

type Props = {
    value: ScreenShareQuality;
    onChange: (value: ScreenShareQuality) => void;

    // Narrow layout (call widget, live changes): options stack, no long descriptions.
    compact?: boolean;

    // Prefix for ids / test ids, so several pickers can live on one page.
    idPrefix?: string;
};

// Discord-like screen share quality form: resolution, frame rate, content type and an
// optional manual bitrate. Controlled; the owner decides when the value is saved or applied.
export default function ScreenShareQualityPicker({value, onChange, compact = false, idPrefix = 'share-quality'}: Props) {
    const {formatMessage} = useIntl();

    const resolutionLabels = {
        '720p': formatMessage({defaultMessage: '720p'}),
        '1080p': formatMessage({defaultMessage: '1080p'}),
        '1440p': formatMessage({defaultMessage: '1440p'}),
        '4k': formatMessage({defaultMessage: '4K (3840×2160)'}),
        source: formatMessage({defaultMessage: 'Source (native size)'}),
    };
    const contentLabels = {
        game: formatMessage({defaultMessage: 'Game / video (smooth motion)'}),
        text: formatMessage({defaultMessage: 'Text / slides (sharp details)'}),
    };

    const autoMbps = autoBitrateMbps(bitratePixels(value), value.fps, 'vp8');
    const manual = value.manualBitrateMbps !== null;
    const heavy = value.resolution === '4k' || (value.resolution === 'source' && value.fps === 60);

    return (
        <Root $compact={compact}>
            <Row $compact={compact}>
                <label htmlFor={`${idPrefix}-resolution`}>{formatMessage({defaultMessage: 'Resolution'})}</label>
                <select
                    id={`${idPrefix}-resolution`}
                    data-testid={`${idPrefix}-resolution`}
                    value={value.resolution}
                    onChange={(ev) => onChange({...value, resolution: ev.target.value as ScreenShareQuality['resolution']})}
                >
                    {shareResolutions.map((r) => (
                        <option
                            key={r}
                            value={r}
                        >
                            {resolutionLabels[r]}
                        </option>
                    ))}
                </select>
            </Row>

            <Row $compact={compact}>
                <label htmlFor={`${idPrefix}-fps`}>{formatMessage({defaultMessage: 'Frame rate'})}</label>
                <select
                    id={`${idPrefix}-fps`}
                    data-testid={`${idPrefix}-fps`}
                    value={value.fps}
                    onChange={(ev) => onChange({...value, fps: Number(ev.target.value) as ScreenShareQuality['fps']})}
                >
                    {shareFpsOptions.map((fps) => (
                        <option
                            key={fps}
                            value={fps}
                        >
                            {formatMessage({defaultMessage: '{fps} fps'}, {fps})}
                        </option>
                    ))}
                </select>
            </Row>

            <Row $compact={compact}>
                <label htmlFor={`${idPrefix}-content`}>{formatMessage({defaultMessage: 'Content'})}</label>
                <select
                    id={`${idPrefix}-content`}
                    data-testid={`${idPrefix}-content`}
                    value={value.content}
                    onChange={(ev) => onChange({...value, content: ev.target.value as ScreenShareQuality['content']})}
                >
                    {shareContents.map((c) => (
                        <option
                            key={c}
                            value={c}
                        >
                            {contentLabels[c]}
                        </option>
                    ))}
                </select>
            </Row>

            <BitrateBox>
                <label>
                    <input
                        type='checkbox'
                        data-testid={`${idPrefix}-manual-bitrate`}
                        checked={manual}
                        onChange={(ev) => onChange({...value, manualBitrateMbps: ev.target.checked ? Math.max(MANUAL_BITRATE_MIN_MBPS, Math.round(autoMbps * 2) / 2) : null})}
                    />
                    {formatMessage({defaultMessage: 'Manual bitrate (advanced)'})}
                </label>
                {manual ? (
                    <SliderRow>
                        <input
                            type='range'
                            data-testid={`${idPrefix}-bitrate-slider`}
                            aria-label={formatMessage({defaultMessage: 'Bitrate'})}
                            min={MANUAL_BITRATE_MIN_MBPS}
                            max={MANUAL_BITRATE_MAX_MBPS}
                            step={MANUAL_BITRATE_STEP_MBPS}
                            value={value.manualBitrateMbps ?? autoMbps}
                            onChange={(ev) => onChange({...value, manualBitrateMbps: Number(ev.target.value)})}
                        />
                        <output data-testid={`${idPrefix}-bitrate-value`}>{formatMessage({defaultMessage: '{mbps} Mbps'}, {mbps: value.manualBitrateMbps})}</output>
                    </SliderRow>
                ) : (
                    <Hint data-testid={`${idPrefix}-auto-bitrate`}>
                        {formatMessage({defaultMessage: 'Automatic: about {mbps} Mbps'}, {mbps: autoMbps})}
                    </Hint>
                )}
            </BitrateBox>

            {!compact && heavy &&
                <Hint data-testid={`${idPrefix}-heavy-warning`}>
                    {formatMessage({defaultMessage: 'High quality needs a fast computer and a strong upload connection. If the stream stutters, lower the resolution or frame rate.'})}
                </Hint>
            }
        </Root>
    );
}

const Root = styled.div<{$compact: boolean}>`
    display: flex;
    flex-direction: column;
    gap: ${({$compact}) => ($compact ? '6px' : '12px')};
    width: 100%;
    font-size: ${({$compact}) => ($compact ? '12px' : '14px')};
    text-align: left;
`;

const Row = styled.div<{$compact: boolean}>`
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;

    label {
        margin: 0;
        font-weight: 400;
    }

    select {
        min-width: ${({$compact}) => ($compact ? '130px' : '220px')};
        max-width: 60%;
        padding: 4px 8px;
        border-radius: 4px;
        border: 1px solid rgba(var(--center-channel-color-rgb), 0.16);
        background: var(--center-channel-bg);
        color: var(--center-channel-color);
    }
`;

const BitrateBox = styled.div`
    display: flex;
    flex-direction: column;
    gap: 6px;

    label {
        display: flex;
        align-items: center;
        gap: 8px;
        margin: 0;
        font-weight: 400;
    }
`;

const SliderRow = styled.div`
    display: flex;
    align-items: center;
    gap: 8px;

    input {
        flex: 1;
        min-width: 0;
    }

    output {
        min-width: 64px;
        text-align: right;
    }
`;

const Hint = styled.span`
    color: rgba(var(--center-channel-color-rgb), 0.72);
    font-size: 12px;
    line-height: 16px;
`;
