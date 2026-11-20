// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import React, {ChangeEvent} from 'react';
import {useIntl} from 'react-intl';
import {leftCol, RadioInput, RadioInputLabel, rightCol} from 'src/components/admin_console_settings/common';
import {CustomComponentProps} from 'src/types/mattermost-webapp';

export default function EnableP2PDirectCalls(props: CustomComponentProps) {
    const {formatMessage} = useIntl();

    const handleChange = (e: ChangeEvent<HTMLInputElement>) => {
        props.onChange(props.id, e.target.value === 'true');
    };

    // @ts-ignore val is a boolean, but the signature says 'string'. (being defensive here, just in case)
    const checked = props.value === 'true' || props.value === true;

    return (
        <div
            data-testid={props.id}
            className='form-group'
        >
            <label className={'control-label ' + leftCol}>
                {formatMessage({defaultMessage: 'Enable direct peer-to-peer media in 1:1 calls'})}
            </label>
            <div className={rightCol}>
                <RadioInputLabel $disabled={props.disabled}>
                    <RadioInput
                        data-testid={props.id + 'true'}
                        type='radio'
                        value='true'
                        id={props.id + 'true'}
                        name={props.id + 'true'}
                        checked={checked}
                        onChange={handleChange}
                        disabled={props.disabled}
                    />
                    {formatMessage({defaultMessage: 'True'})}
                </RadioInputLabel>
                <RadioInputLabel $disabled={props.disabled}>
                    <RadioInput
                        data-testid={props.id + 'false'}
                        type='radio'
                        value='false'
                        id={props.id + 'false'}
                        name={props.id + 'false'}
                        checked={!checked}
                        onChange={handleChange}
                        disabled={props.disabled}
                    />
                    {formatMessage({defaultMessage: 'False'})}
                </RadioInputLabel>
                <div
                    data-testid={props.id + 'help-text'}
                    className='help-text'
                >
                    {formatMessage({defaultMessage: 'When set to true, calls between two people in a direct message channel send audio, video and screen sharing directly between the two participants instead of through the server, falling back to the server automatically if a direct connection cannot be established. Calls with more than two participants, recordings, transcriptions and live captions always use the server. Note: with a direct connection the two participants can see each other\'s IP address.'})}
                </div>
            </div>
        </div>
    );
}
