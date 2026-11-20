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

    const savedPTT = getPushToTalkConfig();
    const summary = formatMessage({defaultMessage: 'Noise suppression: {ns}. Input mode: {mode}.'}, {
        ns: getNoiseSuppression() ? formatMessage({defaultMessage: 'on'}) : formatMessage({defaultMessage: 'off'}),
        mode: savedPTT.enabled ? formatMessage({defaultMessage: 'push to talk ({key})'}, {key: keyCodeLabel(savedPTT.code)}) : formatMessage({defaultMessage: 'voice activity'}),
    });

    const needsKey = pttEnabled && !pttCode;

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
                    <span>{summary}</span>
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
                                <KeyRow>
                                    <span>{formatMessage({defaultMessage: 'Push-to-talk key'})}</span>
                                    <KeyButton
                                        type='button'
                                        className='btn btn-tertiary'
                                        data-testid='ptt-key-button'
                                        onClick={() => setCapturing(!capturing)}
                                    >
                                        {capturing ? formatMessage({defaultMessage: 'Press a key… (Esc to cancel)'}) : (keyCodeLabel(pttCode) || formatMessage({defaultMessage: 'Click to set a key'}))}
                                    </KeyButton>
                                </KeyRow>
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
    justify-content: space-between;
    gap: 12px;
    padding-left: 24px;
`;

const KeyButton = styled.button`
    min-width: 160px;
`;
