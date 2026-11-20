// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import type {IntlShape} from 'react-intl';
import type {ScreenQualityInfo} from 'src/client';
import {formatAutoLabel, formatQualityLabel} from 'src/screen_share_quality';

// The label of the quality in use, e.g. "1440p60 · 12 Mbps" or, in Auto,
// "Auto · 1080p60 · 7.5 Mbps (limited: bandwidth)".
export function qualityInfoLabel(info: ScreenQualityInfo, formatMessage: IntlShape['formatMessage']): string {
    if (!info.auto) {
        return formatQualityLabel(info.quality, info.bitrateMbps, info.captured);
    }
    const level = formatAutoLabel(info.auto, info.bitrateMbps, info.captured);
    if (!info.auto.limited) {
        return formatMessage({defaultMessage: 'Auto · {level}'}, {level});
    }
    return formatMessage({defaultMessage: 'Auto · {level} (limited: {reason})'}, {
        level,
        reason: info.auto.limited === 'cpu' ? formatMessage({defaultMessage: 'cpu'}) : formatMessage({defaultMessage: 'bandwidth'}),
    });
}
