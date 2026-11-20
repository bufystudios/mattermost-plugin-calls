// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import React from 'react';
import {useIntl} from 'react-intl';
import styled from 'styled-components';

type Props = {
    small?: boolean;
    className?: string;
};

// Red "LIVE" pill shown next to whoever is sharing their screen.
export default function LiveBadge({small = false, className}: Props) {
    const {formatMessage} = useIntl();

    return (
        <Pill
            className={className}
            $small={small}
            data-testid='live-badge'
        >
            {formatMessage({defaultMessage: 'LIVE'})}
        </Pill>
    );
}

const Pill = styled.span<{$small: boolean}>`
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    padding: ${({$small}) => ($small ? '0 4px' : '1px 6px')};
    border-radius: 4px;
    background: var(--dnd-indicator);
    color: white;
    font-family: 'Open Sans', sans-serif;
    font-size: ${({$small}) => ($small ? '9px' : '11px')};
    font-weight: 700;
    line-height: ${({$small}) => ($small ? '14px' : '16px')};
    letter-spacing: 0.4px;
`;
