# Noise suppression levels and the Bufy desktop API (bufy fork)

Builds on [`bufy-auto-quality.md`](bufy-auto-quality.md) and [`bufy-p2p.md`](bufy-p2p.md). Same feature set as our Voice Rooms plugin
(`docs/voice-input.md` there), applied to Calls DM calls (SFU and P2P).

## 1. Noise suppression levels

| Level | What runs | Notes |
|---|---|---|
| Off | nothing (`noiseSuppression: false`) | raw microphone |
| Standard | the browser's own filter (`noiseSuppression: true`) | no delay, almost no CPU |
| Enhanced (default) | RNNoise (WebAssembly AudioWorklet) | about 50 ms delay |
| Maximum (experimental) | DeepFilterNet 3 (WebAssembly AudioWorklet) | about 75 ms delay, more CPU |

Pref `calls_noise_suppression` (localStorage). The old boolean is migrated on read (`true` becomes Enhanced, `false` becomes Off, nothing stored
gets the default); the next save writes the level (`parseNoiseLevel`, `webapp/src/voice_input_prefs.ts`).

### Why an iframe

Mattermost 12.1 sends `Content-Security-Policy: script-src 'self'`: the main page cannot compile WebAssembly or load an AudioWorklet from a blob.
Everything in the plugin's `public/` folder is served without such a policy, so `public/audio/host.html` runs the WebAssembly and the worklets.
The webapp loads it into a hidden same-origin iframe (`webapp/src/noise/host.ts`), `window.callsAudioHost.open(level, micTrack)` returns the cleaned
track as a plain `MediaStreamTrack`. Files and licences: `public/audio/README.md`.

### Wiring

| Piece | File |
|---|---|
| Controller (levels, loading, switching, muted pause, fallback) | `webapp/src/noise/controller.ts` |
| Overload detection (stats from the worklet; Maximum that cannot keep up falls back) | `webapp/src/noise/overload.ts` |
| Status shown in the UI / stored for the other windows (`calls_noise_status`, `calls_noise_fallback`) | `webapp/src/noise/status.ts` |
| Fallback reasons (`unavailable`, `overload`, `error`) | `webapp/src/noise/fallback.ts` |
| SFU voice sender and P2P voice sender both carry the controller's output | `webapp/src/client.ts` (`voiceTrack`, `onNoiseOutput`, `attachVoiceToSFU`, `syncP2PMedia`) |
| 4 level radio list: widget / pop out menu, Settings > Calls > Voice input | `webapp/src/components/noise_level.tsx`, `voice_input_settings_section.tsx` |

Rules the client keeps:

- The senders carry the processed track while Enhanced/Maximum run, the raw microphone track otherwise. Switching a level replaces the track of the
  existing sender (no new sender, no renegotiation).
- Mute empties the senders and pauses the worklet. A quick push-to-talk press/release that overtakes the filter start leaves the mic closed (`micIntent`).
- The **selected microphone is never changed by a level change.** Live changes use `applyConstraints({noiseSuppression})` (no device in it). A capture
  device that ignores the constraint is reopened once per wanted value (`noiseReopenedFor`, no loop) on exactly the same device: the chosen one, or
  for the system default the one the track came from. Tests: `client_noise.test.ts`.
- If the host cannot load (an operator's CSP, an old server), the filter dies, or Maximum overloads the computer, the client falls back to Standard
  and shows a notice in the menu / settings (`NoiseFallbackNotice`). Choosing a level again retries.
- A new microphone track (device change) moves a running filter to it (`sourceChanged`) while the filter's output keeps being sent.
- Media that went peer to peer while the SFU voice sender was still being added is not left on the SFU (`attachVoiceToSFU`).

## 2. Bufy desktop API (`window.desktopAPI.bufy`)

Spec (desktop fork): `mattermost-desktop/docs/bufy/desktop-api-bufy.d.ts`, `README.md`, `wayland.md`. Types copy: `webapp/src/types/desktop_api_bufy.d.ts`.
Everything is feature detected (`window.desktopAPI?.bufy?.version`); without it nothing here does anything (browser, stock desktop app).

| What | File |
|---|---|
| Integration (global push to talk, global mute toggle, share border, tray status and actions) | `webapp/src/desktop_bufy.ts` |
| In-window push to talk steps aside while the global key is registered (no double trigger); mouse buttons | `webapp/src/push_to_talk.ts` |
| Settings: "Work while Mattermost is in the background (desktop app)", push to talk capture / bound trigger, share border | `voice_input_settings_section.tsx`, pref `calls_desktop_prefs` |

- **One window.** Only the window that owns the `CallsClient` registers anything. Desktop app: the call widget window (`standalone/src/init.ts`).
  The desktop main window (and `webapp/src/index.tsx` when the join is forwarded to the widget) never reaches `attachDesktopIntegration`; in a browser the
  main window owns the client but has no API. `attachDesktopIntegration` is idempotent per client and stops on the client's `close`.
- **Push to talk**: with the background setting on, the key is registered through `registerPushToTalk` (uiohook; on Wayland through the portal, the
  compositor decides the trigger, which is shown in the settings together with `openShortcutSettings()`). `onPttDown` unmutes, `onPttUp` mutes.
  If the registration fails the in-window handler keeps working.
- **Global mute toggle**: `CommandOrControl+Shift+Space`, registered only while push to talk is off. Deduplicated with Calls' own in-window shortcut (300 ms).
- **Share border**: after the desktop source picker the client knows the `desktopCapturer` source id; `showShareBorder({sourceId})` for `screen:`/`window:`
  sources when the setting is on and the platform has the overlay; `onShareBorderLost` (the window was closed) ends the share.
- **Tray**: `setVoiceStatus` (connected, muted, live, room name, localized labels) on every change; `onTrayAction` handles mute, stop sharing and leave
  (Calls has no deafen).

## 3. Tests

`webapp/src/noise/*.test.ts`, `client_noise.test.ts`, `components/noise_level.test.tsx`, `voice_input_prefs.test.ts`, `desktop_bufy.test.ts`,
`push_to_talk.test.ts`. Live (podman Mattermost 12.1, two headless Chromes, fake audio devices, DM call): see the release notes of
`v1.12.12-bufy.nd.1`.
