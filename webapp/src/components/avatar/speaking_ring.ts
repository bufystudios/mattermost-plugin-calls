// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// The "is speaking" ring (green, like Discord's) used on every avatar in a call:
// call widget, expanded view / pop out, participants lists.
export const SPEAKING_RING_COLOR = '#3DB887';
export const SPEAKING_RING_WIDTH = 3;

// Spread into <Avatar/> props.
export function speakingRing(isSpeaking: boolean) {
    return {
        borderGlowWidth: isSpeaking ? SPEAKING_RING_WIDTH : 0,
        borderGlowColor: SPEAKING_RING_COLOR,
    };
}
