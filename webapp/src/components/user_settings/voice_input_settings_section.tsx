// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import React, {useEffect, useState} from 'react';
import {useIntl} from 'react-intl';
import {NoiseFallbackNotice, NoiseLoad, useNoiseLevelName} from 'src/components/noise_level';
import {Description, Fieldset} from 'src/components/user_settings/common';
import {getBufyAPI, getDesktopBindingInfo} from 'src/desktop_bufy';
import {useNoiseStatus} from 'src/noise/status';
import {notifyVoiceInputPrefsChanged} from 'src/push_to_talk';
import {isMac} from 'src/shortcuts';
import type {BufyCapabilities} from 'src/types/desktop_api_bufy';
import {
    getDesktopPrefs,
    getNoiseLevel,
    getPushToTalkConfig,
    isMouseCode,
    keyCodeLabel,
    NOISE_LEVELS,
    type NoiseLevel,
    setDesktopPrefs,
    setNoiseLevel,
    setPushToTalkConfig,
} from 'src/voice_input_prefs';
import styled from 'styled-components';

export default function VoiceInputSettingsSection() {
    const {formatMessage} = useIntl();
    const [active, setActive] = useState(false);

    const levelName = useNoiseLevelName();
    const noiseStatus = useNoiseStatus();
    const [noiseLevel, setNoiseLevelValue] = useState<NoiseLevel>(getNoiseLevel());
    const [desktopPrefs, setDesktopPrefsValue] = useState(getDesktopPrefs());

    // Desktop app fork (window.desktopAPI.bufy): what the system can do for push to talk.
    const bufy = getBufyAPI();
    const [caps, setCaps] = useState<BufyCapabilities | null>(null);
    const [captureError, setCaptureError] = useState('');
    useEffect(() => {
        let alive = true;
        bufy?.getCapabilities().then((c) => alive && setCaps(c)).catch(() => undefined);
        return () => {
            alive = false;
        };
    }, [bufy]);
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
        setNoiseLevelValue(getNoiseLevel());
        setDesktopPrefsValue(getDesktopPrefs());
        setCaptureError('');
        setPTTEnabled(ptt.enabled);
        setPTTCode(ptt.code);
        setCapturing(false);
        setActive(true);
    };

    // Desktop app with a native key hook: the next key or mouse button pressed anywhere (the page needs focus).
    const nativeCapture = Boolean(bufy && caps?.keyCapture && desktopPrefs.background);
    useEffect(() => {
        if (!capturing || !nativeCapture || !bufy) {
            // eslint-disable-next-line no-undefined
            return undefined;
        }
        let alive = true;
        bufy.captureNextKey({timeoutMs: 10000}).then((result) => {
            if (!alive) {
                return;
            }
            setCapturing(false);
            if (!result.ok) {
                setCaptureError(result.error === 'cancelled' || result.error === 'timeout' ? '' : (result.message || result.error));
                return;
            }
            if (result.captured.modifiers.length > 0) {
                setCaptureError(formatMessage({defaultMessage: 'Choose a single key or mouse button, not a combination.'}));
                return;
            }
            setCaptureError('');
            setPTTCode(result.captured.key);
        }).catch(() => alive && setCapturing(false));
        return () => {
            alive = false;
            bufy.cancelCaptureKey().catch(() => undefined);
        };
    }, [capturing, nativeCapture, bufy]);

    // While capturing, the next key press becomes the push-to-talk key (Escape cancels).
    useEffect(() => {
        if (!capturing || nativeCapture) {
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
    }, [capturing, nativeCapture]);

    // Key test: only while the section is open, push to talk is chosen and a key is not being captured.
    useEffect(() => {
        if (!active || !pttEnabled || !pttCode || capturing || isMouseCode(pttCode)) {
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
    const savedLevel = getNoiseLevel();
    const shownLevel: NoiseLevel = noiseStatus.fallback && noiseStatus.requested === savedLevel ? 'standard' : savedLevel;
    const noiseSummary = formatMessage({defaultMessage: 'Noise suppression: {level}'}, {level: levelName(shownLevel)});
    const inputSummary = formatMessage({defaultMessage: 'Input mode: {mode}'}, {
        mode: savedPTT.enabled ? formatMessage({defaultMessage: 'push to talk (hold {key})'}, {key: keyCodeLabel(savedPTT.code)}) : formatMessage({defaultMessage: 'voice activity'}),
    });

    const needsKey = pttEnabled && !pttCode;

    const noiseHelp = (level: NoiseLevel): string => {
        switch (level) {
        case 'off':
            return formatMessage({defaultMessage: 'Your microphone is sent as it is.'});
        case 'standard':
            return formatMessage({defaultMessage: 'The browser’s own filter. No extra delay and almost no CPU, but it lets keyboard clicks and fans through.'});
        case 'enhanced':
            return formatMessage({defaultMessage: 'RNNoise, a small neural filter that runs on your computer. Removes keyboard, fans and background noise well. Adds about 50 ms of delay and a few percent of one CPU core.'});
        default:
            return formatMessage({defaultMessage: 'Experimental. DeepFilterNet 3, the strongest filter, with the cleanest result on keyboards and fans. Adds about 75 ms of delay and noticeably more CPU (about a fifth of one core), so it may not suit a computer that is also running a game. If it can’t keep up, Calls switches back to Standard.'});
        }
    };

    // Desktop app: push to talk is a global key while Mattermost is in the background.
    const globalPTT = Boolean(bufy && caps?.globalKeys && desktopPrefs.background);
    const portal = globalPTT && caps?.globalKeysBackend === 'portal';
    const bound = getDesktopBindingInfo().pttTrigger;

    let keyButtonLabel = pttCode ? formatMessage({defaultMessage: 'Change'}) : formatMessage({defaultMessage: 'Set key'});
    if (capturing) {
        keyButtonLabel = formatMessage({defaultMessage: 'Cancel'});
    }

    const handleSave = () => {
        if (needsKey) {
            return;
        }
        if (noiseLevel !== getNoiseLevel() || noiseStatus.fallback) {
            setNoiseLevel(noiseLevel);
        }
        if (bufy) {
            setDesktopPrefs(desktopPrefs);
        }
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
                    <NoiseFallbackNotice testId='voice-input-summary-fallback'/>
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
                            <Legend>{formatMessage({defaultMessage: 'Noise suppression'})}</Legend>
                            {NOISE_LEVELS.map((level) => (
                                <LevelLabel key={level}>
                                    <input
                                        type='radio'
                                        name='calls-noise-level'
                                        data-testid={`noise-level-radio-${level}`}
                                        checked={noiseLevel === level}
                                        onChange={() => setNoiseLevelValue(level)}
                                    />
                                    <span>
                                        <LevelTitle>
                                            {level === 'maximum' ? formatMessage({defaultMessage: 'Maximum (experimental)'}) : levelName(level)}
                                        </LevelTitle>
                                        <LevelHelp>{noiseHelp(level)}</LevelHelp>
                                    </span>
                                </LevelLabel>
                            ))}
                            <Description>
                                {formatMessage({defaultMessage: 'Changes apply right away, also in a call.'})}
                            </Description>
                            <NoiseFallbackNotice testId='noise-fallback-settings'/>
                            <NoiseLoad/>

                            <Legend>{formatMessage({defaultMessage: 'Input mode'})}</Legend>
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
                                    {capturing && !nativeCapture &&
                                        <Description data-testid='ptt-capture-hint'>
                                            {formatMessage({defaultMessage: 'Press the key you want to hold to talk. Esc cancels.'})}
                                        </Description>
                                    }
                                    {capturing && nativeCapture &&
                                        <Description data-testid='ptt-capture-hint'>
                                            {formatMessage({defaultMessage: 'Press the key or mouse button (middle, back, forward) you want to hold to talk, in any app. Use Cancel to stop.'})}
                                        </Description>
                                    }
                                    {Boolean(captureError) &&
                                        <Description data-testid='ptt-capture-error'>{captureError}</Description>
                                    }
                                    {portal &&
                                        <KeyRow data-testid='ptt-portal-row'>
                                            <span>
                                                {bound ?
                                                    formatMessage({defaultMessage: 'Your system assigned: {key}'}, {key: bound}) :
                                                    formatMessage({defaultMessage: 'Your system assigns the key when you join a call.'})}
                                            </span>
                                            <button
                                                type='button'
                                                className='btn btn-tertiary btn-sm'
                                                data-testid='ptt-system-settings'
                                                onClick={() => bufy?.openShortcutSettings()}
                                            >
                                                {formatMessage({defaultMessage: 'Change in system settings'})}
                                            </button>
                                        </KeyRow>
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
                                {globalPTT ?
                                    formatMessage({defaultMessage: 'Push to talk also works while another app, such as a game, is in the foreground (desktop app). Combinations like Ctrl+Space are not supported, use a single key or mouse button.'}) :
                                    formatMessage({defaultMessage: 'Push to talk only works while a Mattermost window (the app, the call widget or the pop out) has focus. Mattermost cannot listen for keys while another app, such as a game, is in the foreground. The key is ignored while you type in a text field.'})}
                            </Description>
                        </Fieldset>
                    </div>
                    {bufy &&
                        <div
                            className='setting-list-item'
                            data-testid='desktop-settings'
                        >
                            <hr/>
                            <Fieldset>
                                <Legend>{formatMessage({defaultMessage: 'Desktop app'})}</Legend>
                                <LevelLabel>
                                    <input
                                        type='checkbox'
                                        data-testid='desktop-background-checkbox'
                                        checked={desktopPrefs.background}
                                        onChange={(ev) => setDesktopPrefsValue({...desktopPrefs, background: ev.target.checked})}
                                    />
                                    <span>
                                        <LevelTitle>{formatMessage({defaultMessage: 'Work while Mattermost is in the background (desktop app)'})}</LevelTitle>
                                        <LevelHelp>{formatMessage({defaultMessage: 'Push to talk and the mute shortcut ({shortcut}) also work while another app has focus.'}, {shortcut: MUTE_SHORTCUT_LABEL})}</LevelHelp>
                                    </span>
                                </LevelLabel>
                                {desktopPrefs.background && caps && !caps.globalKeys &&
                                    <Description data-testid='desktop-keys-unavailable'>
                                        {caps.globalKeysPermission === 'denied' ? (
                                            <>
                                                {formatMessage({defaultMessage: 'Allow Accessibility access for global push to talk.'})}
                                                {' '}
                                                <button
                                                    type='button'
                                                    className='btn btn-tertiary btn-sm'
                                                    onClick={() => bufy.openAccessibilitySettings()}
                                                >
                                                    {formatMessage({defaultMessage: 'Open settings'})}
                                                </button>
                                            </>
                                        ) : formatMessage({defaultMessage: 'Global push to talk is not available here ({reason}). It works while a Mattermost window has focus.'}, {reason: caps.globalKeysReason || 'unsupported'})}
                                    </Description>
                                }
                                <LevelLabel>
                                    <input
                                        type='checkbox'
                                        data-testid='desktop-border-checkbox'
                                        checked={desktopPrefs.shareBorder}
                                        onChange={(ev) => setDesktopPrefsValue({...desktopPrefs, shareBorder: ev.target.checked})}
                                    />
                                    <span>
                                        <LevelTitle>{formatMessage({defaultMessage: 'Show a border around the screen or window I share'})}</LevelTitle>
                                        <LevelHelp>{formatMessage({defaultMessage: 'A red frame reminds you what is being shared.'})}</LevelHelp>
                                    </span>
                                </LevelLabel>
                            </Fieldset>
                        </div>
                    }
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

const MUTE_SHORTCUT_LABEL = isMac() ? 'Cmd+Shift+Space' : 'Ctrl+Shift+Space';

const Legend = styled.div`
    margin: 8px 0 4px;
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: rgba(var(--center-channel-color-rgb), 0.64);
`;

const LevelLabel = styled.label`
    display: flex;
    align-items: flex-start;
    gap: 8px;
    margin: 0 0 6px;
    font-weight: 400;

    input {
        margin-top: 3px;
    }
`;

const LevelTitle = styled.span`
    display: block;
    font-weight: 600;
`;

const LevelHelp = styled.span`
    display: block;
    font-size: 12px;
    line-height: 16px;
    color: rgba(var(--center-channel-color-rgb), 0.64);
`;

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
