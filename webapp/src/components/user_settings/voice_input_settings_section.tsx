// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import React, {useEffect, useState} from 'react';
import {useIntl} from 'react-intl';
import {Description, Fieldset} from 'src/components/user_settings/common';
import {notifyVoiceInputPrefsChanged} from 'src/push_to_talk';
import {
    getNoiseSuppression,
    getPushToTalkConfig,
    keyCodeLabel,
    setNoiseSuppression,
    setPushToTalkConfig,
} from 'src/voice_input_prefs';
import styled from 'styled-components';

export default function VoiceInputSettingsSection() {
    const {formatMessage} = useIntl();
    const [active, setActive] = useState(false);

    const [noiseSuppression, setNoiseSuppressionValue] = useState(getNoiseSuppression());
    const [pttEnabled, setPTTEnabled] = useState(getPushToTalkConfig().enabled);
    const [pttCode, setPTTCode] = useState(getPushToTalkConfig().code);
    const [capturing, setCapturing] = useState(false);

    // "Test": lights up while the chosen push-to-talk key is held down.
    const [keyHeld, setKeyHeld] = useState(false);

    const title = formatMessage({defaultMessage: 'Voice input'});
    const editLabel = formatMessage({defaultMessage: 'Edit'});

    // Re-read the stored values every time the section is opened.
    const open = () => {
        const ptt = getPushToTalkConfig();
        setNoiseSuppressionValue(getNoiseSuppression());
        setPTTEnabled(ptt.enabled);
        setPTTCode(ptt.code);
        setCapturing(false);
        setActive(true);
    };

    // While capturing, the next key press becomes the push-to-talk key (Escape cancels).
    useEffect(() => {
        if (!capturing) {
            // eslint-disable-next-line no-undefined
            return undefined;
        }
        const onKeyDown = (ev: KeyboardEvent) => {
            ev.preventDefault();
            ev.stopPropagation();
            if (ev.code !== 'Escape' && ev.code) {
                setPTTCode(ev.code);
            }
            setCapturing(false);
        };
        window.addEventListener('keydown', onKeyDown, true);
        return () => window.removeEventListener('keydown', onKeyDown, true);
    }, [capturing]);

    // Key test: only while the section is open, push to talk is chosen and a key is not being captured.
    useEffect(() => {
        if (!active || !pttEnabled || !pttCode || capturing) {
            setKeyHeld(false);
            // eslint-disable-next-line no-undefined
            return undefined;
        }
        const down = (ev: KeyboardEvent) => {
            if (ev.code === pttCode) {
                setKeyHeld(true);
            }
        };
        const up = (ev: KeyboardEvent) => {
            if (ev.code === pttCode) {
                setKeyHeld(false);
            }
        };
        const release = () => setKeyHeld(false);
        window.addEventListener('keydown', down, true);
        window.addEventListener('keyup', up, true);
        window.addEventListener('blur', release);
        return () => {
            window.removeEventListener('keydown', down, true);
            window.removeEventListener('keyup', up, true);
            window.removeEventListener('blur', release);
        };
    }, [active, pttEnabled, pttCode, capturing]);

    const savedPTT = getPushToTalkConfig();
    const noiseOn = getNoiseSuppression();
    const noiseSummary = formatMessage({defaultMessage: 'Noise suppression: {state}'}, {
        state: noiseOn ? formatMessage({defaultMessage: 'On'}) : formatMessage({defaultMessage: 'Off'}),
    });
    const inputSummary = formatMessage({defaultMessage: 'Input mode: {mode}'}, {
        mode: savedPTT.enabled ? formatMessage({defaultMessage: 'push to talk (hold {key})'}, {key: keyCodeLabel(savedPTT.code)}) : formatMessage({defaultMessage: 'voice activity'}),
    });

    const needsKey = pttEnabled && !pttCode;

    let keyButtonLabel = pttCode ? formatMessage({defaultMessage: 'Change'}) : formatMessage({defaultMessage: 'Set key'});
    if (capturing) {
        keyButtonLabel = formatMessage({defaultMessage: 'Cancel'});
    }

    const handleSave = () => {
        if (needsKey) {
            return;
        }
        setNoiseSuppression(noiseSuppression);
        setPushToTalkConfig({enabled: pttEnabled, code: pttCode});
        notifyVoiceInputPrefsChanged();
        setActive(false);
    };

    if (!active) {
        return (
            <div
                className='section-min'
                onClick={open}
            >
                <div className='secion-min__header'>
                    <h4 className='section-min__title'>
                        <span>{title}</span>
                    </h4>
                    <button
                        className='color--link style--none section-min__edit'
                        aria-labelledby=''
                        aria-expanded={active}
                    >
                        <i
                            className='icon-pencil-outline'
                            title={editLabel}
                        />
                        <span>{editLabel}</span>
                    </button>
                </div>
                <div className='section-min__describe'>
                    <div data-testid='voice-input-summary-noise'>
                        <strong>{noiseSummary}</strong>
                    </div>
                    <div data-testid='voice-input-summary-mode'>{inputSummary}</div>
                </div>
            </div>
        );
    }

    return (
        <section className='section-max form-horizontal'>
            <h4 className='col-sm-12 section-title'>
                <span>{title}</span>
            </h4>
            <div className='sectionContent col-sm-10 col-sm-offset-2'>
                <div
                    tabIndex={-1}
                    className='setting-list'
                >
                    <div className='setting-list-item'>
                        <Fieldset>
                            <label style={{display: 'flex', alignItems: 'center', gap: 8, margin: 0, fontWeight: 400}}>
                                <input
                                    type='checkbox'
                                    data-testid='noise-suppression-checkbox'
                                    checked={noiseSuppression}
                                    onChange={(ev) => setNoiseSuppressionValue(ev.target.checked)}
                                />
                                {formatMessage({defaultMessage: 'Noise suppression'})}
                            </label>
                            <Description>
                                {formatMessage({defaultMessage: 'Filters out background noise from your microphone. Applies right away while you are in a call.'})}
                            </Description>

                            <label style={{display: 'flex', alignItems: 'center', gap: 8, margin: 0, fontWeight: 400}}>
                                <input
                                    type='radio'
                                    name='calls-input-mode'
                                    data-testid='input-mode-voice-activity'
                                    checked={!pttEnabled}
                                    onChange={() => setPTTEnabled(false)}
                                />
                                {formatMessage({defaultMessage: 'Voice activity (use the mute button)'})}
                            </label>
                            <label style={{display: 'flex', alignItems: 'center', gap: 8, margin: 0, fontWeight: 400}}>
                                <input
                                    type='radio'
                                    name='calls-input-mode'
                                    data-testid='input-mode-push-to-talk'
                                    checked={pttEnabled}
                                    onChange={() => setPTTEnabled(true)}
                                />
                                {formatMessage({defaultMessage: 'Push to talk (hold a key to talk)'})}
                            </label>

                            {pttEnabled &&
                                <>
                                    <KeyRow>
                                        <span>{formatMessage({defaultMessage: 'Push-to-talk key:'})}</span>
                                        <KeyChip
                                            data-testid='ptt-key-chip'
                                            $capturing={capturing}
                                        >
                                            {capturing ? formatMessage({defaultMessage: 'Press a key…'}) : (keyCodeLabel(pttCode) || formatMessage({defaultMessage: 'Not set'}))}
                                        </KeyChip>
                                        <button
                                            type='button'
                                            className='btn btn-tertiary btn-sm'
                                            data-testid='ptt-key-button'
                                            onClick={() => setCapturing(!capturing)}
                                        >
                                            {keyButtonLabel}
                                        </button>
                                    </KeyRow>
                                    {capturing &&
                                        <Description data-testid='ptt-capture-hint'>
                                            {formatMessage({defaultMessage: 'Press the key you want to hold to talk. Esc cancels.'})}
                                        </Description>
                                    }
                                    {!capturing && Boolean(pttCode) &&
                                        <KeyRow>
                                            <span>{formatMessage({defaultMessage: 'Test: hold the key'})}</span>
                                            <TestLight
                                                data-testid='ptt-test-indicator'
                                                $on={keyHeld}
                                            >
                                                {keyHeld ? formatMessage({defaultMessage: 'Key pressed: your mic would be open'}) : formatMessage({defaultMessage: 'Not pressed'})}
                                            </TestLight>
                                        </KeyRow>
                                    }
                                </>
                            }
                            {needsKey &&
                                <Description data-testid='ptt-key-required'>
                                    {formatMessage({defaultMessage: 'Choose a key to use push to talk.'})}
                                </Description>
                            }
                            <Description>
                                {formatMessage({defaultMessage: 'Push to talk only works while a Mattermost window (the app, the call widget or the pop out) has focus. Mattermost cannot listen for keys while another app, such as a game, is in the foreground. The key is ignored while you type in a text field.'})}
                            </Description>
                        </Fieldset>
                    </div>
                    <div className='setting-list-item'>
                        <hr/>
                        <button
                            type='submit'
                            className='btn btn-primary'
                            disabled={needsKey}
                            onClick={handleSave}
                        >
                            {formatMessage({defaultMessage: 'Save'})}
                        </button>
                        <button
                            className='btn btn-tertiary'
                            onClick={() => setActive(false)}
                        >
                            {formatMessage({defaultMessage: 'Cancel'})}
                        </button>
                    </div>
                </div>
            </div>
        </section>
    );
}

const KeyRow = styled.div`
    display: flex;
    align-items: center;
    gap: 12px;
    padding-left: 24px;
    margin-top: 4px;
`;

const KeyChip = styled.span<{$capturing: boolean}>`
    min-width: 96px;
    padding: 2px 10px;
    border-radius: 4px;
    border: 2px solid ${({$capturing}) => ($capturing ? 'var(--button-bg)' : 'rgba(var(--center-channel-color-rgb), 0.24)')};
    background: ${({$capturing}) => ($capturing ? 'rgba(var(--button-bg-rgb), 0.08)' : 'rgba(var(--center-channel-color-rgb), 0.04)')};
    text-align: center;
    font-weight: 600;
`;

const TestLight = styled.span<{$on: boolean}>`
    padding: 2px 10px;
    border-radius: 10px;
    font-size: 12px;
    font-weight: 600;
    background: ${({$on}) => ($on ? 'rgba(61, 184, 135, 0.16)' : 'rgba(var(--center-channel-color-rgb), 0.08)')};
    color: ${({$on}) => ($on ? '#2a8a64' : 'rgba(var(--center-channel-color-rgb), 0.64)')};
`;
