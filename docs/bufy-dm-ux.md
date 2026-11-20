# DM call UX, phases 1 and 2 (bufy fork)

Implements phases 1 and 2 of [`bufy-discord-ux.md`](bufy-discord-ux.md) for **DM calls only**
(Team Edition: channel/group calls stay license-gated and are not touched). Web and Mattermost desktop app.

| Feature | Where |
|---|---|
| Noise suppression pref | `src/voice_input_prefs.ts`, `client.ts` (`defaultAudioTrackOptions`, `applyNoiseSuppression`), settings section `components/user_settings/voice_input_settings_section.tsx` |
| Push-to-talk | `src/push_to_talk.ts`, prefs in `voice_input_prefs.ts`, wired in `index.tsx` and `standalone/src/widget/index.tsx` |
| Per-user volume | `src/user_volume.ts`, `components/user_volume_control.tsx`, remote track -> session mapping in `client.ts` |
| Speaking ring | `src/speaking.ts` (single `isSessionSpeaking`), `LOCAL_SPEAKING` state in `reducers.ts`, `components/use_speaking.tsx`, `components/avatar/speaking_ring.ts` |
| LIVE badge + click-to-watch | `src/screen_watch.ts`, `components/live_badge.tsx`, `components/stream_watch.tsx`, `expanded_view/stream_tile.tsx` |
| Focus / enlarge | `expanded_view/participants_grid.tsx` (avatar grid), speaker view in `expanded_view/component.tsx` (video cards) |

## Voice input

> Update: noise suppression switch + shortcut list + "PTT: key" hint in the widget menus, clearer settings summary and key capture/test: see [`bufy-auto-quality.md`](bufy-auto-quality.md).

- **Noise suppression** (Settings > Calls > Voice input, default on). Applied **on the fly**: saving calls
  `track.applyConstraints({noiseSuppression})` on the live mic track in the window that owns the call (no
  renegotiation, same track in SFU and P2P mode). If the browser refuses, the value is used the next time a mic
  track is created (unmute after a device change). The pref is read by `CallsClient` every time it requests a track.
- **Push-to-talk** (default off, user-chosen key, `KeyboardEvent.code`, modifier-only keys allowed). One document
  level key listener per window (`initPushToTalk`):
  - the window that owns the `CallsClient` unmutes on key down and mutes on key up (web: main window, pop out via
    its opener; desktop: the widget window);
  - a window without a client (desktop main window while the call lives in the widget window) forwards press and
    release over a `BroadcastChannel` to the owner;
  - ignored while typing in input/textarea/select/contenteditable, with ctrl/alt/meta held (unless the key itself is a
    modifier), on auto-repeat; always released on key up, window blur and tab hidden;
  - while PTT is on the mute button and shortcut do nothing (tooltip explains), turning PTT on mutes the mic;
  - **Focus limit**: a plugin cannot register a global hotkey, so PTT only works while a Mattermost window has focus.
    The settings text says so.
  - The upstream pop out `Space` hold-to-talk is kept **only while custom PTT is off**, so existing behaviour does not
    change for anyone who did not opt in. With custom PTT on it is disabled (two different "talk" keys would be confusing,
    and Space as the custom key would double-fire).
- **Per-user volume**: slider 0-200 % per remote user (widget: speaker button on the other user's avatar, expanded view:
  button on the tile / video card on hover). Stored in `localStorage` (`calls_user_volumes`, by user id), never sent anywhere.
  <= 100 % uses `audio.volume`; > 100 % routes that element through a WebAudio gain node. A change made in the pop out reaches
  the window that plays the audio through the `storage` event.
  - Track -> sender mapping: SFU tracks use `trackInfo.sender_id` of the media map, P2P tracks use the peer session
    (`sessionID` on the controller's `remotetrack` event). `CallsClient.getRemoteTrackSessionID(trackID)` and the second
    argument of `remoteVoiceStream`. Screen-share audio is mapped to the sharer, so their volume applies to it too.

## Speaking and LIVE

- **Speaking**: `isSessionSpeaking(session, local)` = server `session.voice` (SFU) OR locally measured (P2P). While P2P is
  active `CallsClient` runs a `SpeakingMonitor` (WebAudio analyser, RMS, hysteresis: 2 loud samples to start, 350 ms quiet to
  stop, on 0.02 / off 0.01) over the own mic and the peer's voice track and emits `speaking`; `<SpeakingSync/>` (mounted in widget and
  expanded view, so the pop out works too) copies it into the `localSpeaking` store slice. The monitor stops when P2P ends, so
  the SFU path is unchanged.
- **Ring**: one green ring (`#3DB887`, 3 px) from `components/avatar/speaking_ring.ts` on widget avatars, widget participant list,
  expanded view tiles, RHS list and video cards.
- **LIVE**: red pill on the sharer in the widget (avatar and list), grid tile, video card, RHS.
- **Click-to-watch**: viewers get a LIVE card (widget) / LIVE tile in the grid (expanded view) and nothing is rendered until they click
  Watch. The sharer always sees their own preview. Watching is forgotten when that share ends or someone else shares. The stream still
  arrives over SFU/P2P while not watched (UI opt-in, not bandwidth opt-in). The widget tells the pop out which share is being
  watched (`callActions.getWatchedScreenSession`) so "Pop out" lands on the stream.
  - Fullscreen: media-chrome button in the expanded view, a button in the widget. Pop out stream: the widget's existing pop out
    (expanded view window) and Picture-in-Picture (a floating always-on-top window) when the browser supports it.
- **Focus**: click a tile in the avatar grid (or the stream tile) to enlarge it, rest goes to a strip; click again / `Esc`
  to go back. In the video layout (speaker view) clicking the small card swaps it with the big one, clicking a card in grid view
  enlarges it. Single stream only.

## Manual test plan (2 people, DM call)

Do it once on web+web, once desktop+web, once with P2P forced off (`EnableP2PDirectCalls=false`) to compare.

1. **Voice input settings**: Settings > Calls > Voice input. Defaults: noise suppression on, voice activity.
2. **Noise suppression**: in a call, turn it off then on while the other side listens to a noisy background (fan, typing).
   Expect an audible difference without leaving the call.
3. **PTT**: enable, press a key, save. Join/stay in the call: mic starts muted. Hold the key: other side hears you, mic button
   lights; release: muted. Type the key in the message box: no unmute, the character is typed. Alt-tab away while holding: mic closes.
   With the pop out focused and with the widget/main window focused: both work. Desktop: press it while the main window is focused
   (call in the widget window) and while the widget window is focused. Click the mute button: nothing, tooltip says "Push to talk is on".
4. **Volume**: click the speaker on the other user's avatar (widget), drag to 50 %, 150 %: loudness changes locally only; reload, rejoin:
   value is kept. Check in P2P and in SFU mode (`calls` log line `p2p: connected`).
5. **Speaking ring** (P2P): the other person talks: green ring on their avatar in widget and expanded view, and yours when you talk.
   In SFU mode the same via the server. Check light and dark theme.
6. **LIVE / watch**: the other person shares a screen: you see a LIVE card (widget) / LIVE tile (expanded view), stream not shown;
   click Watch: stream plays, fullscreen and pop out stream work, Stop watching returns to the card. They stop and share again: card again.
   Your own share shows your preview immediately.
7. **Focus**: expanded view, click a tile: it enlarges; click again or Esc: back. Camera on: click the small card to swap.

## Known limits

- `AudioContext` based features (speaking in P2P, > 100 % volume) need the context to be running; they resume on the first user
  gesture, which joining a call already is.
- Participants list (not available in DMs) and RHS list have the speaking ring and LIVE badge but no volume control.
