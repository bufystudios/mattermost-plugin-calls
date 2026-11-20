// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import React, {useState} from 'react';
import {useIntl} from 'react-intl';
import ScreenShareQualityPicker from 'src/components/screen_share_quality/picker';
import {getShareQuality, type ScreenShareQuality, setShareQuality} from 'src/screen_share_quality';

// The default of the screen share quality picker. The picker pre-selects the last quality
// used, which is this same stored value, so saving here changes what it starts with.
export default function ScreenShareQualitySettingsSection() {
    const {formatMessage} = useIntl();
    const [active, setActive] = useState(false);
    const [quality, setQuality] = useState<ScreenShareQuality>(getShareQuality());

    const title = formatMessage({defaultMessage: 'Screen share quality'});
    const editLabel = formatMessage({defaultMessage: 'Edit'});

    const saved = getShareQuality();
    const resolutionNames = {
        '720p': '720p',
        '1080p': '1080p',
        '1440p': '1440p',
        '4k': '4K',
        source: formatMessage({defaultMessage: 'source size'}),
    };
    const summary = formatMessage({defaultMessage: 'Default: {resolution} at {fps} fps, {content}, {bitrate}.'}, {
        resolution: resolutionNames[saved.resolution],
        fps: saved.fps,
        content: saved.content === 'game' ? formatMessage({defaultMessage: 'game / video'}) : formatMessage({defaultMessage: 'text / slides'}),
        bitrate: saved.manualBitrateMbps === null ? formatMessage({defaultMessage: 'automatic bitrate'}) : formatMessage({defaultMessage: '{mbps} Mbps'}, {mbps: saved.manualBitrateMbps}),
    });

    // Re-read the stored value every time the section is opened (the picker updates it too).
    const open = () => {
        setQuality(getShareQuality());
        setActive(true);
    };

    const handleSave = () => {
        setShareQuality(quality);
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
                        <ScreenShareQualityPicker
                            idPrefix='share-quality-settings'
                            value={quality}
                            onChange={setQuality}
                        />
                        <p className='mt-5'>
                            {formatMessage({defaultMessage: 'You can still change the quality every time you start sharing, and while you are sharing.'})}
                        </p>
                    </div>
                    <div className='setting-list-item'>
                        <hr/>
                        <button
                            type='submit'
                            className='btn btn-primary'
                            data-testid='share-quality-settings-save'
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
