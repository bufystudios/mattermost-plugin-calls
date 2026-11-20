// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {STORAGE_CALLS_NOISE_FALLBACK_KEY, STORAGE_CALLS_NOISE_SUPPRESSION_KEY} from 'src/constants';

import {
    browserNoiseSuppression,
    DEFAULT_DESKTOP_PREFS,
    getDesktopPrefs,
    getNoiseLevel,
    isMouseCode,
    isProcessedLevel,
    keyCodeLabel,
    NOISE_LEVELS,
    parseNoiseLevel,
    setDesktopPrefs,
    setNoiseLevel,
} from './voice_input_prefs';

describe('noise level pref', () => {
    afterEach(() => window.localStorage.clear());

    it('migrates the old boolean pref: true is Enhanced, false is Off', () => {
        expect(parseNoiseLevel('true')).toBe('enhanced');
        expect(parseNoiseLevel('false')).toBe('off');

        window.localStorage.setItem(STORAGE_CALLS_NOISE_SUPPRESSION_KEY, 'false');
        expect(getNoiseLevel()).toBe('off');
        window.localStorage.setItem(STORAGE_CALLS_NOISE_SUPPRESSION_KEY, 'true');
        expect(getNoiseLevel()).toBe('enhanced');
    });

    it('is Enhanced for a new user and for a garbage value', () => {
        expect(getNoiseLevel()).toBe('enhanced');
        expect(parseNoiseLevel('loud')).toBe('enhanced');
        expect(parseNoiseLevel(null)).toBe('enhanced');
    });

    it('reads every level it writes, and the next save replaces the boolean', () => {
        window.localStorage.setItem(STORAGE_CALLS_NOISE_SUPPRESSION_KEY, 'true');
        for (const level of NOISE_LEVELS) {
            setNoiseLevel(level);
            expect(window.localStorage.getItem(STORAGE_CALLS_NOISE_SUPPRESSION_KEY)).toBe(level);
            expect(getNoiseLevel()).toBe(level);
        }
    });

    it('choosing a level gives an overloaded level another chance', () => {
        window.localStorage.setItem(STORAGE_CALLS_NOISE_FALLBACK_KEY, 'maximum');
        setNoiseLevel('maximum');
        expect(window.localStorage.getItem(STORAGE_CALLS_NOISE_FALLBACK_KEY)).toBeNull();
    });

    it('only Standard uses the browser filter, only Enhanced and Maximum are processed', () => {
        expect(NOISE_LEVELS.filter(browserNoiseSuppression)).toEqual(['standard']);
        expect(NOISE_LEVELS.filter(isProcessedLevel)).toEqual(['enhanced', 'maximum']);
    });
});

describe('desktop prefs', () => {
    afterEach(() => window.localStorage.clear());

    it('work in the background and the share border are on by default', () => {
        expect(getDesktopPrefs()).toEqual({background: true, shareBorder: true});
        expect(DEFAULT_DESKTOP_PREFS).toEqual({background: true, shareBorder: true});
    });

    it('are stored, and a broken value falls back to the defaults', () => {
        setDesktopPrefs({background: false, shareBorder: true});
        expect(getDesktopPrefs()).toEqual({background: false, shareBorder: true});

        window.localStorage.setItem('calls_desktop_prefs', '{nope');
        expect(getDesktopPrefs()).toEqual(DEFAULT_DESKTOP_PREFS);
    });
});

describe('mouse buttons as push-to-talk keys', () => {
    it('knows the three bindable buttons and labels them', () => {
        expect(['Mouse3', 'Mouse4', 'Mouse5', 'Mouse1', 'KeyV'].map(isMouseCode)).toEqual([true, true, true, false, false]);
        expect(keyCodeLabel('Mouse4')).toBe('Mouse back button');
    });
});
