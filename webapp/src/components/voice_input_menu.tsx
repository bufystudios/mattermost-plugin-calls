// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import React, {useEffect, useState} from 'react';
import {useIntl} from 'react-intl';
import {getCallShortcuts, shortcutKeyNames} from 'src/shortcut_list';
import {isMac, JOIN_CALL, LEAVE_CALL, MAKE_REACTION, MUTE_UNMUTE, PARTICIPANTS_LIST_TOGGLE, RAISE_LOWER_HAND, RECORDING_TOGGLE, SHARE_UNSHARE_SCREEN} from 'src/shortcuts';
import {
    getPushToTalkConfig,
    keyCodeLabel,
    onVoiceInputPrefsChanged,
    type PushToTalkConfig,
} from 'src/voice_input_prefs';
import styled from 'styled-components';

// Re-renders when a voice input pref changes in this or another window, so the menu, the PTT hint and the
// shortcut list always show what is really set (the settings dialog lives in another window on desktop).
export function useVoiceInputPrefs(): {ptt: PushToTalkConfig} {
    const [, setVersion] = useState(0);
    useEffect(() => {
        const refresh = () => setVersion((v) => v + 1);
        return onVoiceInputPrefsChanged(refresh);
    }, []);
    return {ptt: getPushToTalkConfig()};
}

// "PTT: Ctrl" on the call widget / pop out while push to talk is on, so people know why the mute
// button does nothing and which key opens the mic.
export function PushToTalkHint({onDark = false}: {onDark?: boolean}) {
    const {formatMessage} = useIntl();
    const {ptt} = useVoiceInputPrefs();
    if (!ptt.enabled || !ptt.code) {
        return null;
    }
    const key = keyCodeLabel(ptt.code);
    return (
        <Hint
            data-testid='ptt-hint'
            $onDark={onDark}
            title={formatMessage({defaultMessage: 'Push to talk is on: hold {key} to talk. The mute button does not work while it is on.'}, {key})}
        >
            {formatMessage({defaultMessage: 'PTT: {key}'}, {key})}
        </Hint>
    );
}

// "Keyboard shortcuts": a menu item that unfolds the list of the shortcuts of a call.
export function ShortcutsMenuItem({isDM}: {isDM: boolean}) {
    const {formatMessage} = useIntl();
    const [open, setOpen] = useState(false);
    const label = formatMessage({defaultMessage: 'Keyboard shortcuts'});

    return (
        <>
            <li
                className='MenuItem'
                role='menuitem'
                aria-label={label}
            >
                <ItemButton
                    id='calls-menu-shortcuts'
                    data-testid='shortcuts-toggle'
                    className='style--none'
                    aria-expanded={open}
                    onClick={() => setOpen(!open)}
                >
                    <ItemText>
                        <span>{label}</span>
                    </ItemText>
                    <Chevron $open={open}/>
                </ItemButton>
            </li>
            {open &&
                <li
                    className='MenuItem'
                    role='none'
                >
                    <ShortcutsList isDM={isDM}/>
                </li>
            }
        </>
    );
}

// The shortcuts of a call: upstream's (mute, raise hand, share screen, ...) with their real key combination for
// this OS, and our push to talk key.
export function ShortcutsList({isDM}: {isDM: boolean}) {
    const {formatMessage} = useIntl();
    const {ptt} = useVoiceInputPrefs();
    const mac = isMac();

    const labels: {[action: string]: string} = {
        [MUTE_UNMUTE]: formatMessage({defaultMessage: 'Mute / unmute'}),
        [RAISE_LOWER_HAND]: formatMessage({defaultMessage: 'Raise / lower hand'}),
        [SHARE_UNSHARE_SCREEN]: formatMessage({defaultMessage: 'Start / stop presenting'}),
        [PARTICIPANTS_LIST_TOGGLE]: formatMessage({defaultMessage: 'Show / hide participants'}),
        [LEAVE_CALL]: formatMessage({defaultMessage: 'Leave call'}),
        [MAKE_REACTION]: formatMessage({defaultMessage: 'Add a reaction'}),
        [RECORDING_TOGGLE]: formatMessage({defaultMessage: 'Start / stop recording'}),
        [JOIN_CALL]: formatMessage({defaultMessage: 'Start or join a call in this channel'}),
    };

    const pttOn = ptt.enabled && Boolean(ptt.code);

    return (
        <List data-testid='shortcuts-list'>
            <Row data-testid='shortcut-push-to-talk'>
                <span>{formatMessage({defaultMessage: 'Push to talk (hold)'})}</span>
                {pttOn ? (
                    <Keys><Key>{keyCodeLabel(ptt.code)}</Key></Keys>
                ) : (
                    <Muted>{formatMessage({defaultMessage: 'off'})}</Muted>
                )}
            </Row>
            {!pttOn &&
                <Note>{formatMessage({defaultMessage: 'Turn push to talk on in Settings > Calls > Voice input. In the pop out, holding Space also opens the mic.'})}</Note>
            }
            {getCallShortcuts({isDM}).map((entry) => {
                const disabled = pttOn && entry.action === MUTE_UNMUTE;
                return (
                    <Row
                        key={entry.action}
                        data-testid={`shortcut-${entry.action}`}
                        $disabled={disabled}
                    >
                        <span>
                            {labels[entry.action]}
                            {entry.popoutOnly && <PopOutOnly>{formatMessage({defaultMessage: '(pop out)'})}</PopOutOnly>}
                        </span>
                        <Keys>
                            {shortcutKeyNames(entry.keys[0], mac).map((key) => (
                                <Key key={key}>{key}</Key>
                            ))}
                        </Keys>
                    </Row>
                );
            })}
            {pttOn &&
                <Note>{formatMessage({defaultMessage: 'The mute shortcut and the mute button do nothing while push to talk is on.'})}</Note>
            }
        </List>
    );
}

const Hint = styled.span<{$onDark: boolean}>`
    display: inline-flex;
    align-items: center;
    padding: 0 6px;
    border-radius: 4px;
    font-size: 11px;
    font-weight: 600;
    line-height: 16px;
    white-space: nowrap;
    background: ${({$onDark}) => ($onDark ? 'rgba(255, 255, 255, 0.16)' : 'rgba(var(--button-bg-rgb), 0.12)')};
    color: ${({$onDark}) => ($onDark ? 'rgba(255, 255, 255, 0.88)' : 'var(--button-bg)')};
`;

const ItemButton = styled.button`
&&& {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    width: 100%;
    padding: 6px 16px;
    line-height: 20px;
    font-size: 14px;
    text-align: left;
}
`;

const ItemText = styled.span`
    display: flex;
    flex-direction: column;
`;

const Chevron = styled.span<{$open: boolean}>`
    flex-shrink: 0;
    width: 7px;
    height: 7px;
    margin-right: 4px;
    border-right: 2px solid rgba(var(--center-channel-color-rgb), 0.56);
    border-bottom: 2px solid rgba(var(--center-channel-color-rgb), 0.56);
    transform: rotate(${({$open}) => ($open ? '45deg' : '-45deg')});
    transition: transform 0.15s;
`;

const List = styled.div`
    display: flex;
    flex-direction: column;
    gap: 6px;
    width: 100%;
    padding: 4px 16px 8px;
    font-size: 12px;
    line-height: 16px;
    color: var(--center-channel-color);
`;

const Row = styled.div<{$disabled?: boolean}>`
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    opacity: ${({$disabled}) => ($disabled ? 0.48 : 1)};
    text-decoration: ${({$disabled}) => ($disabled ? 'line-through' : 'none')};
`;

const Keys = styled.span`
    display: inline-flex;
    gap: 3px;
    flex-shrink: 0;
`;

const Key = styled.span`
    padding: 0 5px;
    border-radius: 4px;
    border: 1px solid rgba(var(--center-channel-color-rgb), 0.24);
    background: rgba(var(--center-channel-color-rgb), 0.04);
    font-size: 11px;
    font-weight: 600;
    white-space: nowrap;
`;

const Muted = styled.span`
    color: rgba(var(--center-channel-color-rgb), 0.56);
`;

const PopOutOnly = styled.span`
    margin-left: 4px;
    color: rgba(var(--center-channel-color-rgb), 0.56);
`;

const Note = styled.span`
    color: rgba(var(--center-channel-color-rgb), 0.64);
`;
