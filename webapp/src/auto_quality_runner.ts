// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// Thin poller around the Auto quality state machine (auto_quality.ts): every AUTO_TICK_MS it
// reads the stats of the screen sender(s) (SFU: one or two RTCRtpSenders, P2P: one), turns them
// into a snapshot, steps the state machine and tells the owner when the level or the bitrate
// cap changed. It does not apply anything itself.

import {
    AUTO_TICK_MS,
    type AutoOutput,
    autoOutput,
    type AutoSnapshot,
    type AutoState,
    autoStep,
    extractSnapshot,
    outputDiffers,
} from 'src/auto_quality';
import {logDebug, logWarn} from 'src/log';
import type {CaptureSize} from 'src/screen_share_quality';

// 'level': a new level, 'cap': the bitrate cap moved clearly, 'capture': the capture size changed
// without a new level (a capture that took its time to follow the constraints).
export type AutoUpdateReason = 'level' | 'cap' | 'capture';

export type AutoRunnerOptions = {
    state: AutoState;

    // The screen senders to read the stats from (may be empty while a connection is being set up).
    getSenders: () => RTCRtpSender[];

    // The size the capture has right now.
    getCaptured: () => CaptureSize | null;

    // Called when something changed that has to be applied to the capture and the senders.
    onUpdate: (output: AutoOutput, reason: AutoUpdateReason) => Promise<void> | void;

    // The state machine reached a new output that only changes what the sharer sees (e.g. "limited").
    onInfo?: (output: AutoOutput) => void;

    intervalMs?: number;
};

export class AutoQualityRunner {
    private state: AutoState;
    private readonly opts: AutoRunnerOptions;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private running = false;
    private applied: AutoOutput | null = null;
    private appliedCapture: CaptureSize | null = null;

    constructor(opts: AutoRunnerOptions) {
        this.opts = opts;
        this.state = opts.state;
    }

    public getOutput(): AutoOutput {
        return autoOutput(this.state);
    }

    public getState(): AutoState {
        return this.state;
    }

    // Tells the runner what is applied now, so it only reports differences.
    public setApplied(output: AutoOutput, captured: CaptureSize | null) {
        this.applied = output;
        this.appliedCapture = captured;
    }

    public start() {
        if (this.running) {
            return;
        }
        this.running = true;
        this.schedule();
    }

    public stop() {
        this.running = false;
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }

    private schedule() {
        if (!this.running) {
            return;
        }
        this.timer = setTimeout(async () => {
            this.timer = null;
            try {
                await this.tick();
            } catch (err) {
                logWarn('auto quality: tick failed', err);
            }
            this.schedule();
        }, this.opts.intervalMs ?? AUTO_TICK_MS);
    }

    // One poll. Public for tests.
    public async tick() {
        const snapshot = await this.readSnapshot();
        if (!snapshot || !this.running) {
            return;
        }

        this.state = autoStep(this.state, snapshot);
        const output = autoOutput(this.state);
        logDebug('auto quality: sample', {
            level: `${output.rung.size.height}p${output.rung.fps}`,
            limited: output.limited,
            cap: output.capMbps,
            reason: snapshot.reason,
            available: snapshot.availableOutgoingBitrate,
            fps: snapshot.framesPerSecond,
        });

        let reason: AutoUpdateReason | null = outputDiffers(this.applied, output);
        if (!reason) {
            const captured = this.opts.getCaptured();
            if (captured && this.appliedCapture && (captured.width !== this.appliedCapture.width || captured.height !== this.appliedCapture.height)) {
                reason = 'capture';
            }
        }

        if (reason) {
            // Remember first: the apply takes a while and the next tick must not report the same change again.
            this.applied = output;
            this.appliedCapture = this.opts.getCaptured();
            await this.opts.onUpdate(output, reason);
        } else {
            this.opts.onInfo?.(output);
        }
    }

    private async readSnapshot(): Promise<AutoSnapshot | null> {
        const senders = this.opts.getSenders();
        if (senders.length === 0) {
            return null;
        }

        const entries: Array<Record<string, unknown>> = [];
        for (const sender of senders) {
            try {
                // eslint-disable-next-line no-await-in-loop
                const report = await sender.getStats();
                report.forEach((value: unknown) => entries.push(value as Record<string, unknown>));
            } catch (err) {
                logDebug('auto quality: failed to read sender stats', err);
            }
        }
        return extractSnapshot(entries, Date.now());
    }
}
