// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {listenForScreenShareQuality, serveScreenShareBridge, stopOwnScreenShare} from './screen_share_bridge';

jest.mock('./log');

// A BroadcastChannel that delivers to the other instances of the same name, like the real one.
const instances: Array<{name: string; onmessage: ((ev: {data: unknown}) => void) | null; closed: boolean}> = [];
class FakeChannel {
    name: string;
    onmessage: ((ev: {data: unknown}) => void) | null = null;
    closed = false;
    constructor(name: string) {
        this.name = name;
        instances.push(this);
    }
    postMessage(data: unknown) {
        for (const other of instances) {
            if (other !== this && !other.closed && other.name === this.name) {
                other.onmessage?.({data});
            }
        }
    }
    close() {
        this.closed = true;
    }
}

describe('screen share bridge', () => {
    beforeEach(() => {
        instances.length = 0;
        (global as any).BroadcastChannel = FakeChannel;
    });
    afterEach(() => {
        delete (global as any).BroadcastChannel;
        delete (window as any).callsClient;
    });

    it('a window without a client stops the share of the window that owns it', () => {
        const owner = {unshareScreen: jest.fn(), getScreenQualityInfo: () => null, on: jest.fn(), off: jest.fn()};
        const stop = serveScreenShareBridge(() => owner);

        stopOwnScreenShare();
        expect(owner.unshareScreen).toHaveBeenCalledTimes(1);
        stop();
    });

    it('stops directly when this window has the client', () => {
        const unshareScreen = jest.fn();
        (window as any).callsClient = {unshareScreen};
        stopOwnScreenShare();
        expect(unshareScreen).toHaveBeenCalledTimes(1);
    });

    it('sends the quality to the other window, now and on every change', () => {
        let emit: (info: unknown) => void = () => {};
        const info = {bitrateMbps: 8};
        const owner = {
            unshareScreen: jest.fn(),
            getScreenQualityInfo: () => info as any,
            on: (_e: string, cb: (i: any) => void) => {
                emit = cb;
            },
            off: jest.fn(),
        };
        const stop = serveScreenShareBridge(() => owner);

        const seen: unknown[] = [];
        const unlisten = listenForScreenShareQuality((i) => seen.push(i));
        expect(seen).toEqual([info]);

        emit({bitrateMbps: 4});
        expect(seen).toEqual([info, {bitrateMbps: 4}]);

        unlisten();
        stop();
        expect(owner.off).toHaveBeenCalled();
    });

    it('does nothing without BroadcastChannel', () => {
        delete (global as any).BroadcastChannel;
        expect(() => stopOwnScreenShare()).not.toThrow();
        expect(() => listenForScreenShareQuality(jest.fn())()).not.toThrow();
        expect(() => serveScreenShareBridge(() => null)()).not.toThrow();
    });
});
