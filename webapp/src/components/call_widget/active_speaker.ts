// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {UserSessionState} from '@mattermost/calls-common/lib/types';
import {UserProfile} from '@mattermost/types/users';
import {IDMappedObjects} from '@mattermost/types/utilities';
import {isSessionSpeaking, type LocalSpeakingState} from 'src/speaking';

export function getActiveSpeakerProfile(sessions: UserSessionState[], profiles: IDMappedObjects<UserProfile>, localSpeaking?: LocalSpeakingState): UserProfile | null {
    for (const session of sessions) {
        const profile = profiles[session.user_id];
        if (isSessionSpeaking(session, localSpeaking) && profile) {
            return profile;
        }
    }

    return null;
}
