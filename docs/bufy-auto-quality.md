# Auto screen share quality, voice input UX, "you are sharing" indicator (bufy fork)

Builds on [`bufy-share-quality.md`](bufy-share-quality.md) and [`bufy-dm-ux.md`](bufy-dm-ux.md).

## 1. Auto screen share quality (default)

**Auto** is a choice next to Manual in the picker (start dialog, desktop source modal, live "Quality" panel, Settings > Calls > Screen share quality).
It is the default for new users. A choice stored before Auto existed has no `auto` field and stays **manual** (`normalizeShareQuality`); an
empty/missing value is a new user and gets Auto. In Auto only the content type (Game / Text) is asked, the manual resolution / fps / bitrate are kept
for when the user switches back.

### How it works

| Piece | File |
|---|---|
| Ladder, state machine (pure), stats snapshot extraction, tunables | `webapp/src/auto_quality.ts` (+ `.test.ts`) |
| Poller (every 2 s: `RTCRtpSender.getStats()` of the screen sender(s), steps the machine, reports level / cap changes) | `webapp/src/auto_quality_runner.ts` (+ `.test.ts`) |
| Wiring: start/stop, apply level live, SFU + P2P senders | `webapp/src/client.ts` (`startAuto`, `applyAutoOutput`, `screenQualityForSend`, `getScreenSenders`), `webapp/src/p2p.ts` (`getScreenSenders`, `extra`) |
| Auto capture constraints, bitrate cap, encoder downscale | `webapp/src/screen_share_quality.ts` (`captureQuality`, `ScreenSenderExtra`) |
| Label ("Auto · 1080p60 · 7.5 Mbps (limited: bandwidth)") | `components/screen_share_quality/label.ts` |

Flow: the capture is opened at the source size (`getDisplayMedia` without a size, fps 60 for Game / 30 for Text), its real size is the **native source size**
(the ladder never goes above it), the start level is picked, the capture is lowered to it with `applyConstraints` and the senders get `maxBitrate` /
`maxFramerate` / `degradationPreference`. Then the poller adapts. Same live path as a manual change, no re-share. If the capture refuses new
constraints (Electron legacy tracks) the encoder downscales (`scaleResolutionDownBy` = captured height / level height) and the bitrate is the level's.

### Ladder

Rungs are clamped to the source (never upscale) and rungs that become identical are merged.

| Content | Ladder (best first) | Starts at |
|---|---|---|
| Game (resolution first, fps last) | 4K60 > 1440p60 > 1080p60 > 720p60 > 720p30 > 720p15 | 1440p60, or the source if smaller |
| Text (fps first, resolution last) | 4K30 > 4K15 > 1440p15 > 1080p15 > 720p15 | the source size at 30 fps (top rung) |

Examples: Game on 1080p source: 1080p60 > 720p60 > 720p30 > 720p15. Text on 1080p: 1080p30 > 1080p15 > 720p15. Bitrates are the automatic table
of the clamped size (4K60 25, 1440p60 12, 1080p60 8, 720p60 4, 720p30 2.5, 720p15 1.5 Mbps VP8; H.264 x0.9, AV1 x0.7 as before).

### Signals (per 2 s sample) and thresholds

| Signal | Meaning |
|---|---|
| `outbound-rtp.qualityLimitationReason` = `cpu` | cpu trouble (bad) |
| encode time per frame (`Δ totalEncodeTime / Δ framesEncoded`, needs >= 5 frames) / frame budget (1/target fps) >= 0.85 | cpu trouble (bad) |
| `framesPerSecond` < 70 % of target **and** encode ratio >= 0.6 | cpu trouble (bad). A low fps alone is not bad: a still screen delivers few frames |
| `qualityLimitationReason` = `bandwidth`, remote-inbound `fractionLost` >= 5 %, or capped bitrate < 50 % of what the level wants | bandwidth trouble (bad) |
| candidate-pair `availableOutgoingBitrate` | bitrate cap = 85 % of it (min 0.5 Mbps); not trusted for the first 4 samples (8 s) because a new connection's estimate is too low |
| RTT | read, only logged (not used in decisions) |

- **Step down**: 2 consecutive bad samples (4 s), one rung. Bandwidth trouble with a trusted estimate jumps straight to the first rung whose bitrate x 0.6 fits the cap.
- **Step up** (one rung): 8 consecutive good samples (16 s). Good = no limitation reason, loss < 1 %, `availableOutgoingBitrate` >= 1.3 x the bitrate of the rung above,
  and the encode time predicted at the rung above (current ratio x pixels/s ratio) < 0.6 of the budget. Unknown numbers (idle screen, browser without stats) do not block,
  but with no signal at all it never climbs.
- **Hysteresis**: 2 samples after a change are ignored (settling). A step up that is undone within 30 s doubles the wait for the next step up (16 s, 32 s, up to 64 s);
  120 s without a change forgets it.
- Limit shown in the label: `limited: cpu` / `limited: bandwidth` (last sample, or the cap being tighter than the level wants).
- retransmittedBytesSent is not used (fractionLost covers it).

The same poller runs on the SFU path (VP8 and optional AV1 senders; encode time summed, frames = largest) and the P2P path (one sender); it follows the switch between them.

## 2. Voice input UX

- **Noise suppression switch** in the call widget menu and the pop out "More options" menu (`components/voice_input_menu.tsx`): label + On/Off + switch; applies
  immediately (`applyNoiseSuppression`, also forwarded to the window that owns the call). It follows changes made in Settings (and vice versa) through
  `onVoiceInputPrefsChanged` (custom event + `storage`).
- **Settings > Calls > Voice input** summary now has two lines: **"Noise suppression: On/Off"** (bold) and "Input mode: voice activity / push to talk (hold <key>)".
  The section already rendered the current value (read on every render); it was easy to miss in one lowercase sentence.
- **Keyboard shortcuts** item (widget menu and pop out menu) unfolds the list (`shortcut_list.ts` reads `shortcuts.ts`, so it cannot drift): mute Ctrl+Shift+Space,
  raise hand Ctrl+Shift+Y, share Ctrl+Shift+E, participants Alt+P / Ctrl+Shift+P (not in DMs), leave Ctrl+Shift+L, pop out only: reaction Ctrl+Shift+X, recording
  Ctrl+Alt+R (host); global: join/start call Ctrl+Alt+S (Cmd/Option on a Mac). Plus our push-to-talk key (or how to turn it on) and a note that the mute shortcut does nothing while PTT is on.
- The mute button tooltip no longer shows the mute shortcut while push to talk is on (it does nothing then; the tooltip says "Hold <key> to talk").
- **"PTT: <key>" chip** on the widget (above the bottom bar) and the pop out (left of the controls) while push to talk is on.
- **PTT key control** in Settings: "Push-to-talk key: [ Ctrl ] Change"; while capturing the chip says "Press a key…" with a highlighted border, the button turns to Cancel,
  Esc cancels. **Test**: a light that turns on while the chosen key is held ("Key pressed: your mic would be open"). Only the key is tested, not the mic level.

## 3. "You are sharing" indicator

- **Global banner** (`components/screen_sharing_banner.tsx`, `registerGlobalComponent`): fixed, top center below the global + channel header (top: 104 px, so search and
  the channel header buttons stay reachable): `● You're sharing your screen · Auto · 1080p60 · 8 Mbps · [Stop sharing] [–]`. Theme-safe (`--dnd-indicator` red, white text).
  Minimize folds it to a pulsing red dot that stays visible; clicking the dot expands it. Survives channel and team navigation (it is outside the routes). Not shown in the pop out.
- **State**: selector `ownScreenSharing` = `screenSharingIDs[callChannel] === own session`. Own session = call client session (web, widget window, pop out) or, in the
  **desktop app main window** (no client there), `clientStateReducer.sessionID` set by `DESKTOP_WIDGET_CONNECTED`; the sharing session id comes from the `user_screen_on/off` websocket
  events every window receives. Verified by tests, not on a real desktop app.
- **Stop** from a window without the client: `screen_share_bridge.ts` posts `stop` on a `BroadcastChannel` (`calls_screen_share`, same approach as push to talk); the widget window
  (`serveScreenShareBridge` in `CallWidget`) calls `unshareScreen()`. It also publishes the quality info (and answers a request) so the main window shows the label.
- **Call widget**: red strip "Sharing your screen · Stop" above the bottom bar (always visible), red ring on the own avatar (plus the existing LIVE badge).
- **Tab title**: prefixed with a red circle while sharing, restored on stop; a MutationObserver puts it back when the app rewrites the title.
