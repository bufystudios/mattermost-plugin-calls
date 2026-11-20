# Screen share quality picker (bufy fork)

Discord-like quality choice for screen sharing, including 4K30 / 4K60. Web and Mattermost desktop app, SFU and P2P.
Decided in [`bufy-discord-ux.md`](bufy-discord-ux.md) (team decisions); P2P background in [`bufy-p2p.md`](bufy-p2p.md).

## What the user sees

| Where | What |
|---|---|
| Starting a share in the browser (widget, pop out) | A "Screen share quality" dialog opens first; **Share** starts the capture (that click is the user gesture `getDisplayMedia` needs). |
| Starting a share in the desktop app | The same form is inside the "Choose what to share" modal, under the source list. The choice is stored before the desktop app is told to share. |
| Settings > Calls > "Screen share quality" (next to Voice input) | Edit the default. The default **is** the last choice (one stored value), so a change in the picker or while sharing becomes the new default. |
| While sharing (widget panel and pop out preview) | A line `1440p60 · 12 Mbps` and a **Quality** link that opens the compact form; changes apply live, no re-share. |

Options: resolution 720p / 1080p / 1440p / 4K (3840x2160) / Source; fps 15 / 30 / 60; content Game / Text; manual bitrate (checkbox +
1-50 Mbps slider; off = automatic). Default: 1080p, 60 fps, Game, automatic. Viewers have no quality UI (no simulcast).

## Code map

| Piece | File |
|---|---|
| Types, storage, constraints, bitrate table, codec choice, sender application | `webapp/src/screen_share_quality.ts` (+ `.test.ts`) |
| Capture (`getScreenStream`, quality argument) | `webapp/src/utils.ts` |
| Share start, SFU senders, live change (`setScreenQuality`), `screenQuality` event, `getScreenQualityInfo` | `webapp/src/client.ts` (+ `client_screen_quality.test.ts`) |
| P2P sender (`setScreenQuality`, per-share codec) | `webapp/src/p2p.ts` (+ `p2p.test.ts`) |
| Picker form / dialog / live controls | `webapp/src/components/screen_share_quality/{picker,modal,live_controls}.tsx` |
| Desktop picker | `webapp/src/components/screen_source_modal/component.tsx` |
| Settings section | `webapp/src/components/user_settings/screen_share_quality_settings_section.tsx` |
| Widget / pop out wiring | `webapp/src/components/call_widget/component.tsx`, `webapp/src/components/expanded_view/component.tsx` |
| Storage key | `calls_share_quality` (localStorage, shared by all windows of the origin) |

## Capture constraints

- Browser (`getDisplayMedia`): `frameRate {ideal,max}=fps`; for a preset `height {ideal,max}=H` and `width {max}` wide enough for 32:9
  (so ultrawide screens are not cropped to a 16:9 box); **Source sets no size**. Only `ideal`/`max`, never `min`.
- Electron (legacy `mandatory` keys): `maxFrameRate`, `minFrameRate = fps/2` (hint), `maxHeight`/`maxWidth` from the preset.
  The old 2560x1440 caps are gone.
- **Never upscale**: a maximum/ideal above what the source can deliver does not enlarge the picture, the capture stays at the source size. The
  real size is read from `track.getSettings()` and drives the bitrate, so a 1080p source with "4K" chosen gets the 1080p bitrate and
  `scaleResolutionDownBy` is always 1 (no encoder side downscale).
- Live change: `track.applyConstraints()` (same limits; Source uses a very large `ideal` because applyConstraints replaces the old
  constraints and omitting the size would fall back to the browser default), then the senders. If the browser refuses new constraints (Electron
  legacy tracks) the senders still get the new bitrate / fps / degradation preference.
- Content: Game → `contentHint 'motion'` + `degradationPreference 'maintain-framerate'`; Text → `contentHint 'text'` (falls back to `'detail'`
  where `'text'` is not accepted) + `'maintain-resolution'`.

## Automatic bitrate

One table in `screen_share_quality.ts` (`autoBitrateTableVP8`, `codecFactor`). VP8, Mbps, by capture size and fps:

| Capture size | 15 fps | 30 fps | 60 fps |
|---|---|---|---|
| 720p (1280x720) | 1.5 | 2.5 | 4 |
| 1080p (1920x1080) | 2.5 | 4 | 8 |
| 1440p (2560x1440) | 4 | 6.5 | 12 |
| 4K (3840x2160) | 8 | 15 | 25 |

- Other codecs scale the row: **H.264 x0.9**, **AV1 x0.7** (e.g. 4K60: VP8 25, H.264 22.5, AV1 17.5; 1440p60: 12 / 10.8 / 8.4).
- Sizes between rows (ultrawide, 16:10, odd window sizes) are interpolated linearly by pixel count; below 720p it scales down linearly, above 4K it
  stays at the 4K value. Minimum 0.5 Mbps. The pixel count is the real capture size (`track.getSettings()`), or the preset's 16:9 size before the
  capture exists (Source assumes 1080p until the real size is known).
- Manual bitrate replaces the automatic value for every codec.
- `maxBitrate` is a cap, the congestion controller still adapts below it. `maxFramerate` = chosen fps.

## Codecs

- **SFU path**: unchanged: VP8 track plus an optional AV1 track (`EnableAV1`), each with its own bitrate row. No H.264.
  - rtcd v1.2.6 (`service/rtc/sfu.go`, `rtpVideoCodecs`) registers only **VP8 and AV1** as video codecs (media engine + the forwarding switch);
    anything else, including H.264, is not negotiated with the server and would not be forwarded. H.264 on the SFU would need an rtcd change
    (register the codec, forward it, add it to the screen track mime handling and the AV1/VP8 selection in `sfu.go:632-650`), so it is deliberately not touched.
  - The SFU's own bandwidth estimator in rtcd 1.2.6 is capped at 3.75 Mbps (`simulcastRates` high 2.5 Mbps x 1.5, `sfu.go:196-204`). It is used for simulcast level
    selection and the downstream estimate; with our single (non simulcast) screen layer the SFU forwards the layer as is, but bitrates well above 8 Mbps through the
    SFU are not verified. P2P is where 1440p60 / 4K are meant to run.
- **P2P path**: `pickP2PScreenCodec`: for a capture of 1440p or more (height >= ~1368 px, or >= 90 % of 1440p pixels) prefer **H.264** if it was negotiated (both sides
  support it), else **AV1** if `EnableAV1` and negotiated, else **VP8**. Below 1440p: AV1 if enabled, else VP8. Several H.264 variants are ranked by
  packetization mode 1, profile (High > Main > Baseline) and level.
  - No renegotiation: all supported codecs are already negotiated (the connection only reorders them), the sender selects one per share with
    `RTCRtpEncodingParameters.codec` (Chromium 133+; checked on Chrome 157). A sender follows the codec order of the *receiving* side's SDP, so changing local codec
    preferences would not help the sender anyway (verified with a loopback test).
  - Without `encodings[].codec` support the negotiated default (AV1/VP8) is used, quality limits still apply.

## Manual test plan

Prerequisite: two accounts in a DM call. Use `chrome://webrtc-internals` (see below) on the **sharer's** machine.

1. **Picker**: web, click Start presenting: dialog opens with the default (1080p, 60 fps, Game, auto ~8 Mbps). Cancel: nothing is captured. Esc: same.
2. **Web, P2P (default DM)**: share 4K, 30 fps, Game. Expect `4K30 · 13.5 Mbps` (H.264 row, 15 x 0.9) if H.264 is negotiated, `15 Mbps` with VP8. Repeat 4K60, 1440p60, 1080p60, 720p30, Source (on a 4K screen and on a smaller screen).
3. **Desktop app**: Start presenting: the source modal has the picker. Choose a window and 1440p60. Check the widget panel label. Repeat with a screen at 4K.
4. **SFU**: set `EnableP2PDirectCalls=false` (or add a third person / start a recording) and repeat 1080p60 and 1440p30: VP8 (and AV1 with `EnableAV1`) senders appear, no H.264.
5. **Text vs Game**: share a text editor as Text 15 fps: sharper text, resolution is kept under pressure (`maintain-resolution`); Game with a video / game: frame rate is kept.
6. **Live change** (while sharing, widget panel or pop out preview > Quality): 1080p -> 4K, 60 -> 30 fps, Game -> Text, switch on manual bitrate and move the slider, switch back to auto. The share must not restart (no new screen_on, the viewer's stream continues), the label updates, webrtc-internals shows the new size / fps / bitrate.
7. **Never upscale**: share a 1080p monitor / small window with 4K chosen: captured size stays at the source, label shows `1080p...`, bitrate is the 1080p one.
8. **Settings**: Settings > Calls > Screen share quality: change the default, Save; the picker starts with it. Reload the page: it is kept. Private window with storage blocked: no errors, defaults apply.
9. **Viewer**: sees the stream, no quality UI. Compare received resolution / fps in the viewer's webrtc-internals (`inbound-rtp` frameWidth / frameHeight / framesPerSecond).

### Reading chrome://webrtc-internals

Open `chrome://webrtc-internals` before starting the share, expand the peer connection (the P2P one has no server URL in its config; the SFU one does) and look at
the `outbound-rtp (kind=video)` entry of the screen sender (the one with the large `frameWidth`):
- **resolution / fps**: `frameWidth`, `frameHeight`, `framesPerSecond` (graphs under "outbound-rtp").
- **bitrate**: `targetBitrate` and the rate derived from `bytesSent`; it should hover below the label value (the encoder only uses what the picture needs, the label is the cap).
- **codec**: `codecId` links to the `codec` entry (`mimeType` video/VP8, video/AV1, video/H264); `encoderImplementation` tells software vs hardware (`libvpx`, `OpenH264`, `ExternalEncoder` / `MediaFoundation` / `VideoToolbox` / VAAPI...).
- **limits**: `qualityLimitationReason` (`cpu` / `bandwidth` / `none`) and `qualityLimitationDurations`.
- Calls client logs (`Settings > Advanced`/ browser console, `com.mattermost.calls`): `p2p: screen sender codec <mime> bitrate (Mbps): N fps: N`.

## Known limits / risks

- 4K60 with software VP8 (libvpx) is very CPU heavy and may trigger `qualityLimitationReason: cpu`. H.264 (hardware encode) in P2P helps if the OS/GPU offers it; on Linux
  Chrome the H.264 encoder is often OpenH264 (software) and VAAPI is usually off by default.
- H.264 availability differs per OS/browser (Chrome and Electron on Windows / macOS: hardware, usually yes; Linux: software OpenH264 or none; Firefox: different profile set).
  If a peer has no H.264, the P2P sender silently stays on AV1/VP8.
- Electron legacy desktop capture: `getUserMedia` with `mandatory` keys may ignore `applyConstraints`; live changes then only change the encoder side (bitrate, fps cap), not the capture size.
  `minFrameRate` is only a hint. Source uses 7680x4320 as an upper bound instead of omitting the keys (see deviations in the PR notes).
- The desktop picker lives in the main window while the share starts in the widget window: they exchange the choice through `localStorage` (same origin). If a desktop app version isolates
  storage between those windows, the widget would start with its own stored value (the legacy `calls-widget-share-screen` path also carries the choice).
- High bitrates through the SFU are untested above the previous 8 Mbps (see Codecs).
- No "don't ask again": the picker appears every time a share starts (default = last choice, one click on Share).
