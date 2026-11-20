// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {
    DEFAULT_USER_VOLUME,
    getUserVolume,
    getUserVolumes,
    MAX_USER_VOLUME,
    RemoteAudioVolumes,
    setUserVolume,
    subscribeUserVolumes,
} from './user_volume';

describe('user volumes (persistence)', () => {
    afterEach(() => {
        window.localStorage.clear();
    });

    it('plays everybody at 100% by default', () => {
        expect(getUserVolume('someone')).toBe(DEFAULT_USER_VOLUME);
    });

    it('persists the volume per user id', () => {
        setUserVolume('user-a', 0.5);
        setUserVolume('user-b', 1.5);

        expect(getUserVolume('user-a')).toBe(0.5);
        expect(getUserVolume('user-b')).toBe(1.5);
        expect(JSON.parse(window.localStorage.getItem('calls_user_volumes')!)).toEqual({'user-a': 0.5, 'user-b': 1.5});
    });

    it('survives a reload (reads what is in storage)', () => {
        window.localStorage.setItem('calls_user_volumes', '{"user-a":0.25}');

        expect(getUserVolume('user-a')).toBe(0.25);
    });

    it('clamps to 0..200%', () => {
        setUserVolume('user-a', 5);
        setUserVolume('user-b', -1);

        expect(getUserVolume('user-a')).toBe(MAX_USER_VOLUME);
        expect(getUserVolume('user-b')).toBe(0);
    });

    it('does not store the default, so the entry disappears when reset', () => {
        setUserVolume('user-a', 0.5);
        setUserVolume('user-a', 1);

        expect(getUserVolumes()).toEqual({});
    });

    it('survives garbage in storage', () => {
        window.localStorage.setItem('calls_user_volumes', 'nope');
        expect(getUserVolume('user-a')).toBe(1);

        window.localStorage.setItem('calls_user_volumes', '{"user-a":"loud","user-b":0.5}');
        expect(getUserVolumes()).toEqual({'user-b': 0.5});

        window.localStorage.setItem('calls_user_volumes', '[1,2]');
        expect(getUserVolumes()).toEqual({});
    });

    it('keeps working when storage is unavailable', () => {
        const spy = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
            throw new Error('blocked');
        });
        const cb = jest.fn();
        const unsubscribe = subscribeUserVolumes(cb);

        expect(() => setUserVolume('user-a', 0.5)).not.toThrow();
        expect(cb).toHaveBeenCalled();

        unsubscribe();
        spy.mockRestore();
    });

    it('tells subscribers about changes, in this window and (storage event) in other windows', () => {
        const cb = jest.fn();
        const unsubscribe = subscribeUserVolumes(cb);

        setUserVolume('user-a', 0.5);
        expect(cb).toHaveBeenCalledTimes(1);

        window.dispatchEvent(new StorageEvent('storage', {key: 'calls_user_volumes'}));
        expect(cb).toHaveBeenCalledTimes(2);

        window.dispatchEvent(new StorageEvent('storage', {key: 'something_else'}));
        expect(cb).toHaveBeenCalledTimes(2);

        unsubscribe();
        setUserVolume('user-a', 0.7);
        expect(cb).toHaveBeenCalledTimes(2);
    });
});

describe('RemoteAudioVolumes', () => {
    const audioEl = () => ({volume: 1}) as unknown as HTMLAudioElement;
    const users: {[sessionID: string]: string} = {'sess-a': 'user-a', 'sess-b': 'user-b'};

    const fakeContext = () => {
        const gains: Array<{gain: {value: number}}> = [];
        const ctx = {
            state: 'running',
            destination: {},
            resume: jest.fn(async () => undefined),
            createGain: jest.fn(() => {
                const g = {gain: {value: 1}, connect: jest.fn()};
                gains.push(g);
                return g;
            }),
            createMediaElementSource: jest.fn(() => ({connect: jest.fn()})),
            setSinkId: jest.fn(async () => undefined),
        };
        return {ctx, gains};
    };

    let volumes: RemoteAudioVolumes;

    afterEach(() => {
        volumes?.destroy();
        window.localStorage.clear();
    });

    it('applies the stored volume of the sender to its element', () => {
        setUserVolume('user-a', 0.4);
        volumes = new RemoteAudioVolumes((sid) => users[sid]);
        const a = audioEl();
        const b = audioEl();

        volumes.add(a, 'sess-a');
        volumes.add(b, 'sess-b');

        expect(a.volume).toBe(0.4);
        expect(b.volume).toBe(1);
    });

    it('applies changes live', () => {
        volumes = new RemoteAudioVolumes((sid) => users[sid]);
        const a = audioEl();
        volumes.add(a, 'sess-a');

        setUserVolume('user-a', 0.2);

        expect(a.volume).toBe(0.2);
    });

    it('leaves elements whose sender is unknown at 100%, and fixes them once the session shows up', () => {
        setUserVolume('user-a', 0.3);
        const known: {[sid: string]: string} = {};
        volumes = new RemoteAudioVolumes((sid) => known[sid]);
        const a = audioEl();
        volumes.add(a, 'sess-a');
        expect(a.volume).toBe(1);

        known['sess-a'] = 'user-a';
        volumes.applyAll();

        expect(a.volume).toBe(0.3);
    });

    it('routes through a gain node above 100% and keeps using it afterwards', () => {
        const {ctx, gains} = fakeContext();
        volumes = new RemoteAudioVolumes((sid) => users[sid], () => 'speaker-1', () => ctx as never);
        const a = audioEl();
        volumes.add(a, 'sess-a');

        setUserVolume('user-a', 1.5);
        expect(gains).toHaveLength(1);
        expect(gains[0].gain.value).toBe(1.5);
        expect(a.volume).toBe(1);
        expect(ctx.setSinkId).toHaveBeenCalledWith('speaker-1');

        setUserVolume('user-a', 0.5);
        expect(gains).toHaveLength(1);
        expect(gains[0].gain.value).toBe(0.5);
    });

    it('stops tracking removed elements', () => {
        volumes = new RemoteAudioVolumes((sid) => users[sid]);
        const a = audioEl();
        volumes.add(a, 'sess-a');
        volumes.remove(a);

        setUserVolume('user-a', 0.1);

        expect(a.volume).toBe(1);
    });

    it('stays at 100% when WebAudio is not available', () => {
        volumes = new RemoteAudioVolumes((sid) => users[sid], () => undefined, () => null);
        const a = audioEl();
        volumes.add(a, 'sess-a');

        setUserVolume('user-a', 1.5);

        expect(a.volume).toBe(1);
    });
});
