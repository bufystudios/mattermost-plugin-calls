// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// Local, per-user playback volume of remote participants ("Discord style").
// Never sent to the server or to the other side: it only changes how loud we
// hear someone. Stored in localStorage by user id, so it sticks across calls
// and is shared by all windows of the same origin.

import {STORAGE_CALLS_USER_VOLUMES_KEY} from 'src/constants';

export const DEFAULT_USER_VOLUME = 1;
export const MIN_USER_VOLUME = 0;

// 200%. Anything above 1 needs a WebAudio gain node (HTMLMediaElement.volume caps at 1).
export const MAX_USER_VOLUME = 2;

export type UserVolumes = {[userID: string]: number};

function clampVolume(v: number): number {
    if (!Number.isFinite(v)) {
        return DEFAULT_USER_VOLUME;
    }
    return Math.min(MAX_USER_VOLUME, Math.max(MIN_USER_VOLUME, v));
}

export function getUserVolumes(): UserVolumes {
    try {
        const data = window.localStorage.getItem(STORAGE_CALLS_USER_VOLUMES_KEY);
        if (!data) {
            return {};
        }
        const parsed = JSON.parse(data);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return {};
        }
        const volumes: UserVolumes = {};
        for (const [userID, v] of Object.entries(parsed)) {
            if (typeof v === 'number' && Number.isFinite(v)) {
                volumes[userID] = clampVolume(v);
            }
        }
        return volumes;
    } catch {
        return {};
    }
}

export function getUserVolume(userID: string): number {
    return getUserVolumes()[userID] ?? DEFAULT_USER_VOLUME;
}

const listeners = new Set<() => void>();

// Calls cb when any volume changes, in this window or in another one.
export function subscribeUserVolumes(cb: () => void): () => void {
    listeners.add(cb);

    // `storage` only fires in windows other than the one that wrote.
    const onStorage = (ev: StorageEvent) => {
        if (ev.key === null || ev.key === STORAGE_CALLS_USER_VOLUMES_KEY) {
            cb();
        }
    };
    window.addEventListener('storage', onStorage);

    return () => {
        listeners.delete(cb);
        window.removeEventListener('storage', onStorage);
    };
}

export function setUserVolume(userID: string, volume: number) {
    const volumes = getUserVolumes();
    const v = clampVolume(volume);

    // The default is not stored so the map does not grow with every user we ever heard.
    if (v === DEFAULT_USER_VOLUME) {
        delete volumes[userID];
    } else {
        volumes[userID] = v;
    }

    try {
        window.localStorage.setItem(STORAGE_CALLS_USER_VOLUMES_KEY, JSON.stringify(volumes));
    } catch {
        // Storage unavailable: the change still applies for the current page via the listeners below.
    }
    listeners.forEach((cb) => cb());
}

type AudioContextLike = {
    state: string;
    destination: unknown;
    resume: () => Promise<void>;
    createGain: () => {gain: {value: number}; connect: (dest: unknown) => void};
    createMediaElementSource: (el: HTMLMediaElement) => {connect: (dest: unknown) => void};
    setSinkId?: (id: string) => Promise<void>;
};

const ignore = () => undefined;

type Entry = {
    sessionID?: string;
    gain?: {gain: {value: number}};
};

// Applies the stored volumes to the <audio> elements that play remote voices.
// Values up to 100% just use element.volume. The first time a user is pushed
// above 100% the element is routed through a WebAudio gain node instead
// (an element can only be captured once, so it then stays on the gain node).
export class RemoteAudioVolumes {
    private entries = new Map<HTMLAudioElement, Entry>();
    private ctx: AudioContextLike | null = null;
    private unsubscribe: (() => void) | null = null;
    private resolveUserID: (sessionID: string) => string | undefined;
    private getOutputDeviceID: () => string | undefined;
    private createContext: () => AudioContextLike | null;

    // resolveUserID maps the sender session of a track to the user, which is what the volume is stored by.
    constructor(
        resolveUserID: (sessionID: string) => string | undefined,
        getOutputDeviceID: () => string | undefined = () => undefined,
        createContext: () => AudioContextLike | null = defaultCreateContext,
    ) {
        this.resolveUserID = resolveUserID;
        this.getOutputDeviceID = getOutputDeviceID;
        this.createContext = createContext;
        this.unsubscribe = subscribeUserVolumes(() => this.applyAll());
    }

    public add(el: HTMLAudioElement, sessionID?: string) {
        this.entries.set(el, {sessionID});
        this.apply(el);
    }

    public remove(el: HTMLAudioElement) {
        this.entries.delete(el);
    }

    public destroy() {
        this.unsubscribe?.();
        this.unsubscribe = null;
        this.entries.clear();
    }

    public applyAll() {
        for (const el of this.entries.keys()) {
            this.apply(el);
        }
    }

    private apply(el: HTMLAudioElement) {
        const entry = this.entries.get(el);
        if (!entry) {
            return;
        }

        const userID = entry.sessionID ? this.resolveUserID(entry.sessionID) : undefined;
        const volume = userID ? getUserVolume(userID) : DEFAULT_USER_VOLUME;

        if (volume > DEFAULT_USER_VOLUME && !entry.gain) {
            this.routeThroughGain(el, entry);
        }

        if (entry.gain) {
            el.volume = 1;
            entry.gain.gain.value = volume;
            if (this.ctx?.state === 'suspended') {
                // Allowed because a slider change is a user gesture.
                this.ctx.resume().catch(ignore);
            }
        } else {
            // HTMLMediaElement.volume throws above 1: without a gain node we cap at 100%.
            el.volume = Math.min(DEFAULT_USER_VOLUME, volume);
        }
    }

    private routeThroughGain(el: HTMLAudioElement, entry: Entry) {
        try {
            this.ctx = this.ctx ?? this.createContext();
            if (!this.ctx) {
                return;
            }
            const gain = this.ctx.createGain();
            this.ctx.createMediaElementSource(el).connect(gain);
            gain.connect(this.ctx.destination);
            entry.gain = gain;

            // Once captured, the element no longer decides where the sound goes: the context does.
            const deviceID = this.getOutputDeviceID();
            if (deviceID && typeof this.ctx.setSinkId === 'function') {
                this.ctx.setSinkId(deviceID).catch(ignore);
            }
        } catch {
            // Boosting is a nicety: without WebAudio we stay capped at 100%.
        }
    }
}

function defaultCreateContext(): AudioContextLike | null {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    return Ctor ? (new Ctor() as unknown as AudioContextLike) : null;
}
