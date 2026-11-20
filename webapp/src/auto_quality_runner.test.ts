// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {AUTO_STEP_DOWN_TICKS, createAutoState, currentRung} from './auto_quality';
import {AutoQualityRunner} from './auto_quality_runner';

jest.mock('./log');

const k4 = {width: 3840, height: 2160};

// A sender whose stats come from a function, like RTCRtpSender.getStats().
const fakeSender = (entries: () => Array<Record<string, unknown>>) => ({
    getStats: jest.fn(async () => {
        const map = new Map<string, unknown>();
        for (const e of entries()) {
            map.set(String(e.id), e);
        }
        return map;
    }),
}) as unknown as RTCRtpSender;

const outbound = (over: Record<string, unknown> = {}) => ({
    id: 'o1', type: 'outbound-rtp', kind: 'video', qualityLimitationReason: 'none', framesPerSecond: 60, framesEncoded: 100, totalEncodeTime: 1, ...over,
});

describe('AutoQualityRunner', () => {
    it('reports a new level once the state machine steps down, and only once', async () => {
        let senders: RTCRtpSender[] = [fakeSender(() => [outbound({qualityLimitationReason: 'cpu'})])];
        const onUpdate = jest.fn();
        const runner = new AutoQualityRunner({
            state: createAutoState('game', k4),
            getSenders: () => senders,
            getCaptured: () => k4,
            onUpdate,
        });
        runner.start();
        runner.setApplied(runner.getOutput(), k4);

        for (let i = 0; i < AUTO_STEP_DOWN_TICKS - 1; i++) {
            // eslint-disable-next-line no-await-in-loop
            await runner.tick();
        }
        expect(onUpdate).not.toHaveBeenCalled();

        await runner.tick();
        expect(onUpdate).toHaveBeenCalledTimes(1);
        const [output, reason] = onUpdate.mock.calls[0];
        expect(reason).toBe('level');
        expect(`${output.rung.size.height}p${output.rung.fps}`).toBe('1080p60');

        // The next (settling) sample does not report it again.
        await runner.tick();
        expect(onUpdate).toHaveBeenCalledTimes(1);
        expect(currentRung(runner.getState()).size.height).toBe(1080);

        // No senders yet (e.g. a connection being set up): nothing happens, nothing throws.
        senders = [];
        await expect(runner.tick()).resolves.toBeUndefined();
        runner.stop();
    });

    it('reports a clearly different bitrate cap, and a capture that changed size on its own', async () => {
        let available = 60_000_000;
        const sender = fakeSender(() => [
            outbound(),
            {id: 'cp', type: 'candidate-pair', nominated: true, state: 'succeeded', availableOutgoingBitrate: available},
        ]);
        let captured = {...k4};
        const onUpdate = jest.fn();
        const runner = new AutoQualityRunner({
            state: createAutoState('game', k4),
            getSenders: () => [sender],
            getCaptured: () => captured,
            onUpdate,
        });
        runner.start();
        runner.setApplied(runner.getOutput(), k4);

        // Warm-up: no cap yet, so nothing to report.
        for (let i = 0; i < 4; i++) {
            // eslint-disable-next-line no-await-in-loop
            await runner.tick();
        }
        expect(onUpdate).not.toHaveBeenCalled();

        await runner.tick();
        expect(onUpdate).toHaveBeenLastCalledWith(expect.objectContaining({capMbps: 51}), 'cap');

        // Same estimate: no new report. A much lower one: reported.
        onUpdate.mockClear();
        await runner.tick();
        expect(onUpdate).not.toHaveBeenCalled();
        available = 20_000_000;
        await runner.tick();
        expect(onUpdate).toHaveBeenLastCalledWith(expect.objectContaining({capMbps: 17}), 'cap');

        // The capture follows an earlier constraint late.
        onUpdate.mockClear();
        captured = {width: 2560, height: 1440};
        await runner.tick();
        expect(onUpdate).toHaveBeenLastCalledWith(expect.anything(), 'capture');
        runner.stop();
    });

    it('polls on a timer until stopped', async () => {
        const sender = fakeSender(() => [outbound()]);
        const runner = new AutoQualityRunner({
            state: createAutoState('game', k4),
            getSenders: () => [sender],
            getCaptured: () => k4,
            onUpdate: jest.fn(),
            intervalMs: 10,
        });
        runner.start();
        await new Promise((resolve) => setTimeout(resolve, 80));
        const polls = (sender.getStats as jest.Mock).mock.calls.length;
        expect(polls).toBeGreaterThanOrEqual(3);

        runner.stop();
        await new Promise((resolve) => setTimeout(resolve, 60));
        expect((sender.getStats as jest.Mock).mock.calls.length).toBeLessThanOrEqual(polls + 1);
    });

    it('survives a sender whose stats fail', async () => {
        const sender = {getStats: jest.fn(async () => {
            throw new Error('closed');
        })} as unknown as RTCRtpSender;
        const runner = new AutoQualityRunner({
            state: createAutoState('game', k4),
            getSenders: () => [sender],
            getCaptured: () => k4,
            onUpdate: jest.fn(),
        });
        runner.start();
        await expect(runner.tick()).resolves.toBeUndefined();
        runner.stop();
    });
});
