// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {notWatching, reconcileWatch, startWatching, streamView} from './screen_watch';

describe('click-to-watch state', () => {
    describe('streamView', () => {
        it('shows nothing while nobody shares', () => {
            expect(streamView({mySessionID: 'me', watching: notWatching})).toBe('none');
        });

        it('shows a LIVE card, not the stream, to a viewer who did not click', () => {
            expect(streamView({sharerSessionID: 'them', mySessionID: 'me', watching: notWatching})).toBe('live-card');
        });

        it('shows the stream once the viewer clicked Watch', () => {
            expect(streamView({sharerSessionID: 'them', mySessionID: 'me', watching: startWatching('them')})).toBe('player');
        });

        it('always shows the sharer their own preview', () => {
            expect(streamView({sharerSessionID: 'me', mySessionID: 'me', watching: notWatching})).toBe('player');
        });

        it('does not treat watching an old share as watching a new one', () => {
            expect(streamView({sharerSessionID: 'other', mySessionID: 'me', watching: 'them'})).toBe('live-card');
        });
    });

    describe('reconcileWatch', () => {
        it('keeps watching the same share', () => {
            expect(reconcileWatch('them', 'them')).toBe('them');
        });

        it('forgets the watch when the share stops, so the next share starts as a LIVE card again', () => {
            expect(reconcileWatch('them', undefined)).toBe(notWatching);
            expect(reconcileWatch('them', '')).toBe(notWatching);
        });

        it('forgets the watch when somebody else starts sharing', () => {
            expect(reconcileWatch('them', 'someone-else')).toBe(notWatching);
        });

        it('stays not watching', () => {
            expect(reconcileWatch(notWatching, 'them')).toBe(notWatching);
        });
    });

    describe('startWatching', () => {
        it('watches the given share, or nothing without one', () => {
            expect(startWatching('them')).toBe('them');
            expect(startWatching(undefined)).toBe(notWatching);
        });
    });
});
