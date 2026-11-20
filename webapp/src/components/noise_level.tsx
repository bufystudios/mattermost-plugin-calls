// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import React, {type KeyboardEvent as ReactKeyboardEvent, useEffect, useId, useState} from 'react';
import {useIntl} from 'react-intl';
import {type FallbackReason, type NoiseStatus, useNoiseStatus} from 'src/noise/status';
import {notifyVoiceInputPrefsChanged} from 'src/push_to_talk';
import {getCallsClient} from 'src/utils';
import {getNoiseLevel, NOISE_LEVELS, type NoiseLevel, onVoiceInputPrefsChanged, setNoiseLevel} from 'src/voice_input_prefs';
import styled from 'styled-components';

// The level the user chose, re-read whenever a voice input pref changes in this or another window (the settings
// dialog lives in another window than the call widget on desktop).
export function useNoiseLevel(): NoiseLevel {
    const [level, setLevel] = useState(getNoiseLevel);
    useEffect(() => onVoiceInputPrefsChanged(() => setLevel(getNoiseLevel())), []);
    return level;
}

// What actually runs: after a fallback that is Standard, whatever was asked for.
export function effectiveLevel(chosen: NoiseLevel, status: NoiseStatus): NoiseLevel {
    return status.fallback && status.requested === chosen ? 'standard' : chosen;
}

// The plain name of a level: Off, Standard, Enhanced, Maximum. The level names are kept in English-like game
// audio terms in every language, see the translations.
export function useNoiseLevelName(): (level: NoiseLevel) => string {
    const {formatMessage} = useIntl();
    return (level) => {
        switch (level) {
        case 'off':
            return formatMessage({defaultMessage: 'Off'});
        case 'standard':
            return formatMessage({defaultMessage: 'Standard'});
        case 'enhanced':
            return formatMessage({defaultMessage: 'Enhanced'});
        default:
            return formatMessage({defaultMessage: 'Maximum'});
        }
    };
}

// One-line description under a level in the menus.
export function useNoiseLevelDescription(): (level: NoiseLevel) => string {
    const {formatMessage} = useIntl();
    return (level) => {
        switch (level) {
        case 'off':
            return formatMessage({defaultMessage: 'Raw sound from the microphone'});
        case 'standard':
            return formatMessage({defaultMessage: 'The browser’s own filter · no delay'});
        case 'enhanced':
            return formatMessage({defaultMessage: 'Fans, keyboard, hum · very little CPU'});
        default:
            return formatMessage({defaultMessage: 'Cleanest sound · more CPU'});
        }
    };
}

// The visible notice after a processed level fell back to Standard during the call (nothing when all is well).
// role='status' so it is announced when it appears.
export function NoiseFallbackNotice({className, testId = 'noise-fallback-notice'}: {className?: string; testId?: string}) {
    const {formatMessage} = useIntl();
    const status = useNoiseStatus();
    const chosen = useNoiseLevel();
    const name = useNoiseLevelName();
    if (!status.fallback || status.requested !== chosen) {
        return null;
    }
    const level = name(status.fallback.from);
    const reason: FallbackReason = status.fallback.reason;
    let text: string;
    switch (reason) {
    case 'overload':
        text = formatMessage({defaultMessage: 'The {level} filter was too heavy for this computer, so the browser’s own noise suppression is used. Choose a level again to retry.'}, {level});
        break;
    case 'error':
        text = formatMessage({defaultMessage: 'The {level} filter stopped working, so the browser’s own noise suppression is used.'}, {level});
        break;
    default:
        text = formatMessage({defaultMessage: 'The {level} filter could not be loaded here, so the browser’s own noise suppression is used.'}, {level});
    }
    return (
        <Notice
            className={className}
            role='status'
            data-testid={testId}
        >
            {text}
        </Notice>
    );
}

// "Processing load: 12 % of the audio time budget", from the worklet's reports. Only while a processed level runs.
export function NoiseLoad({className}: {className?: string}) {
    const {formatMessage} = useIntl();
    const status = useNoiseStatus();
    if (!status.load || status.phase !== 'active' || (status.effective !== 'enhanced' && status.effective !== 'maximum')) {
        return null;
    }
    const percent = Math.round(status.load.busy * 100);
    return (
        <Help
            className={className}
            aria-live='off'
            data-testid='noise-load'
        >
            {formatMessage({defaultMessage: 'Processing load: {percent} % of the audio time budget (longest step {peak} ms)'}, {percent, peak: status.load.peakMs})}
        </Help>
    );
}

// Applies a chosen level: stores it, tells the windows that own the call (the widget, a pop out's opener) and
// starts the filter on the live microphone.
export function chooseNoiseLevel(level: NoiseLevel) {
    setNoiseLevel(level);
    notifyVoiceInputPrefsChanged();
    getCallsClient()?.applyNoiseSuppression();
}

// "Noise suppression" with Off / Standard / Enhanced / Maximum as a radio list, for the call widget menu and the
// pop out's "More options" menu: a check, a bold title, a muted one line description, an "Experimental" tag and a
// thin CPU bar on Maximum while it runs. The check is on what actually runs, so after a fallback it moves to
// Standard and the reason shows under the list. Arrow keys move the focus, Enter or Space chooses (so a
// model is not loaded per key press).
export function NoiseLevelMenuItems() {
    const {formatMessage} = useIntl();
    const chosen = useNoiseLevel();
    const status = useNoiseStatus();
    const name = useNoiseLevelName();
    const description = useNoiseLevelDescription();
    const labelId = useId();
    const effective = effectiveLevel(chosen, status);
    const showLoad = Boolean(status.load) && status.phase === 'active' && status.effective === 'maximum';

    const onKeys = (ev: ReactKeyboardEvent<HTMLDivElement>) => {
        const radios = Array.from(ev.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]'));
        const index = radios.indexOf(ev.currentTarget.ownerDocument.activeElement as HTMLElement);
        let next = -1;
        if (ev.key === 'ArrowDown' || ev.key === 'ArrowRight') {
            next = (index + 1) % radios.length;
        } else if (ev.key === 'ArrowUp' || ev.key === 'ArrowLeft') {
            next = (index + (radios.length - 1)) % radios.length;
        } else if (ev.key === 'Home') {
            next = 0;
        } else if (ev.key === 'End') {
            next = radios.length - 1;
        }
        if (next >= 0) {
            ev.preventDefault();
            radios[next].focus();
        }
    };

    return (
        <>
            <li
                className='MenuItem'
                role='none'
            >
                <Label
                    id={labelId}
                    data-testid='noise-level-label'
                >
                    {formatMessage({defaultMessage: 'Noise suppression'})}
                </Label>
            </li>
            <li
                className='MenuItem'
                role='none'
            >
                <Group
                    role='radiogroup'
                    aria-labelledby={labelId}
                    data-testid='noise-level-group'
                    onKeyDown={onKeys}
                >
                    {NOISE_LEVELS.map((level) => {
                        const checked = effective === level;
                        return (
                            <Row
                                key={level}
                                type='button'
                                role='radio'
                                aria-checked={checked}
                                aria-label={name(level)}
                                aria-describedby={`${labelId}-d-${level}`}
                                tabIndex={checked ? 0 : -1}
                                data-testid={`noise-level-${level}`}
                                className='style--none'
                                onClick={() => {
                                    if (level !== chosen || status.fallback) {
                                        chooseNoiseLevel(level);
                                    }
                                }}
                            >
                                <Check aria-hidden={true}>{checked && <i className='icon icon-check'/>}</Check>
                                <Text>
                                    <Title>
                                        {name(level)}
                                        {level === 'maximum' &&
                                            <Tag data-testid='noise-level-experimental'>{formatMessage({defaultMessage: 'Experimental'})}</Tag>
                                        }
                                    </Title>
                                    <Sub id={`${labelId}-d-${level}`}>{description(level)}</Sub>
                                    {level === 'maximum' && checked && showLoad && status.load &&
                                        <Load
                                            max={100}
                                            value={Math.min(100, Math.round(status.load.busy * 100))}
                                            aria-label={formatMessage({defaultMessage: 'Processing load'})}
                                            data-testid='noise-level-load'
                                        />
                                    }
                                </Text>
                            </Row>
                        );
                    })}
                </Group>
            </li>
            <li
                className='MenuItem'
                role='none'
            >
                <NoiseFallbackNotice className='NoiseLevel-menu-notice'/>
            </li>
        </>
    );
}

const Label = styled.div`
    padding: 6px 16px 2px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    line-height: 16px;
    text-transform: uppercase;
    color: rgba(var(--center-channel-color-rgb), 0.64);
`;

const Group = styled.div`
    display: flex;
    flex-direction: column;
    width: 100%;
    padding: 0 6px 4px;
`;

const Row = styled.button`
&&& {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    width: 100%;
    padding: 6px 10px;
    border-radius: 4px;
    text-align: left;
    background: transparent;
}

&&&:hover, &&&:focus-visible {
    background: rgba(var(--center-channel-color-rgb), 0.08);
}
`;

const Check = styled.span`
    flex-shrink: 0;
    width: 16px;
    padding-top: 1px;
    font-size: 14px;
    font-weight: 700;
    line-height: 20px;
    color: var(--button-bg);
`;

const Text = styled.span`
    display: flex;
    flex: 1;
    min-width: 0;
    flex-direction: column;
`;

const Title = styled.span`
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 14px;
    font-weight: 600;
    line-height: 20px;
    color: var(--center-channel-color);
`;

const Tag = styled.span`
    padding: 0 4px;
    border-radius: 4px;
    background: rgba(var(--away-indicator-rgb), 0.2);
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.04em;
    line-height: 16px;
    text-transform: uppercase;
    color: var(--center-channel-color);
`;

const Sub = styled.span`
    font-size: 12px;
    line-height: 16px;
    color: rgba(var(--center-channel-color-rgb), 0.64);
`;

const Load = styled.progress`
    width: 100%;
    height: 4px;
    margin-top: 4px;
    appearance: none;
    border: 0;
    border-radius: 2px;
    overflow: hidden;
    background: rgba(var(--center-channel-color-rgb), 0.08);

    &::-webkit-progress-bar {
        background: rgba(var(--center-channel-color-rgb), 0.08);
    }

    &::-webkit-progress-value {
        border-radius: 2px;
        background: var(--online-indicator, #3db887);
        transition: width 0.2s;
    }

    &::-moz-progress-bar {
        border-radius: 2px;
        background: var(--online-indicator, #3db887);
    }
`;

const Notice = styled.p`
    margin: 2px 16px 6px;
    font-size: 12px;
    line-height: 16px;
    color: var(--error-text);
`;

const Help = styled.p`
    margin: 4px 0 0;
    font-size: 12px;
    line-height: 16px;
    color: rgba(var(--center-channel-color-rgb), 0.64);
`;
