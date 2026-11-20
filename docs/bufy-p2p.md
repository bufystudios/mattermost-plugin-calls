# Peer-to-peer media for 1:1 DM calls (bufy fork)

In a call between two people in a DM, audio/video/screen share can be sent
directly from one participant to the other instead of through the server's SFU.
This lowers latency and keeps the (small) server out of the media path, which
matters most for 60 fps / 8 Mbps screen sharing.

Everything else keeps going through the plugin as before: joining, call state,
websocket events (mute, hand raise, reactions, screen on/off, ...), the SFU
connection itself. P2P is an *additional* `RTCPeerConnection` used only for media.

## Scope and eligibility

P2P is used only when **all** of these hold:

- the plugin setting `EnableP2PDirectCalls` is true (default),
- the channel is a DM (`D`),
- the call has exactly two sessions, from two distinct users (a second session of
  the same user, e.g. desktop + browser, or a third participant disables it),
- no recording, transcription or live captions job is active (they need the media on the server).

Group/public/private channels never use P2P. When any condition stops holding
the clients go back to the SFU; when it holds again they try again (unless P2P
*failed* for that peer, see below).

The client decides from the call state (`webapp/src/p2p_sync.ts`); the server
enforces the same rules when relaying signaling (`server/p2p.go`, `checkP2PRelay`),
so a modified client cannot use the relay for anything else.

## State machine (per client)

```
            eligible                    ICE connected
   sfu ───────────────► p2p-connecting ───────────────► p2p
    ▲                      │                             │
    │ not eligible         │ timeout (5 s) / failed      │ failed / disconnected > 3 s
    │ (bye "ineligible")   ▼ (bye "failed")              ▼ (bye "failed")
    ├───────────────── fallback-sfu ◄─────────────────────┘
    │                       (no retry with this peer)
    └─ not eligible / peer changed, from any state
```

| State | Media is sent over | Notes |
|---|---|---|
| `sfu` | SFU | Default. Also the state after a planned switch back (not eligible anymore). |
| `p2p-connecting` | SFU | The P2P connection is being negotiated. Local tracks are already attached to it. |
| `p2p` | P2P | The SFU peer's senders hold `null` tracks (nothing is sent). Remote P2P tracks are played. |
| `fallback-sfu` | SFU | P2P was abandoned for this peer. It is not attempted again with this peer for the rest of the call. |

Transitions (implemented in `webapp/src/p2p.ts`, `P2PController`):

- `sfu → p2p-connecting`: context becomes eligible and the peer did not already fail.
- `p2p-connecting → p2p`: `RTCPeerConnection.connectionState` is `connected`.
- `p2p-connecting → fallback-sfu`: not connected within 5 s, or `failed`, or the peer sent `bye` (`failed`).
- `p2p → fallback-sfu`: `failed`, `disconnected` for more than 3 s, or the peer sent `bye` (`failed`).
- `* → sfu`: no longer eligible (third session, recording, peer left, ...) or the peer sent `bye` (`ineligible`). Retried automatically when eligible again.

`CallsClient` (`webapp/src/client.ts`) only reacts to the controller's events:

- entering `p2p`: replace the tracks of the SFU senders with `null` (voice, camera, screen, screen audio),
- leaving `p2p`: send over the SFU again whatever is currently enabled (`resumeSFUMedia`: replace the
  track on the existing sender, or add it if it never existed on the SFU, e.g. unmuted for the first time during P2P),
  and point the UI back to the tracks received from the SFU.

While in `p2p`, mute/unmute, camera on/off, device changes and screen share toggles are applied to the P2P
senders (`syncP2PMedia`) and the SFU peer is left alone.

## Roles and negotiation

- The session with the lexicographically **smaller session ID makes the offer**, the other answers. No glare handling needed.
- The P2P connection always has four transceivers, created by the offerer in this order
  (the answerer gets them from the offer): `voice` (audio), `video` (video), `screen` (video), `screen-audio` (audio).
  All `sendrecv`. Tracks are attached/detached with `replaceTrack`, so there is **no renegotiation after the first offer/answer**.
- The offer carries a `tracks` map `{mid: type}` so the receiver knows what each remote track is
  (the SFU path gets this from its media map).
- ICE servers are the ones the plugin already gives the client (`ICEServersConfigs`, including TURN credentials).
  There is no extra TURN server: with a symmetric NAT on both sides P2P times out and the call stays on the SFU.
- Screen share uses the same quality settings as the SFU path: contentHint `motion`, `maintain-framerate`,
  60 fps, VP8 8 Mbps; AV1 6 Mbps if `EnableAV1` is on and AV1 was negotiated (codec preferences put AV1 first
  when enabled, then VP8). Camera uses the usual 1 Mbps / 30 fps.

## Signaling

Client → server: websocket action `custom_com.mattermost.calls_p2p_signal`, binary (msgpack) with
`data` = zlib-compressed JSON (same packing as `sdp`, since offers can exceed the 4 KB message limit):

```json
{"to": "<peer session id>", "kind": "offer | answer | candidate | bye", "data": { ... }}
```

| kind | data |
|---|---|
| `offer` | `{"sdp": <RTCSessionDescription>, "tracks": {"<mid>": "voice\|video\|screen\|screen-audio"}}` |
| `answer` | `{"sdp": <RTCSessionDescription>}` |
| `candidate` | `RTCIceCandidateInit` |
| `bye` | `{"reason": "ineligible" \| "failed"}`: go back to the SFU. `failed` also means "do not retry with me". |

Server → peer: a regular `signal` event targeted at the peer's connection, with `data` =

```json
{"type": "p2p_signal", "from": "<sender session id>", "kind": "...", "data": { ... }}
```

(`type: "p2p_signal"` distinguishes it from the SFU's `offer`/`answer`/`candidate`.)

Server rules (`handleP2PSignal`): the sender must be in an ongoing call, the target must be in the same call, and
(except for `bye`) `checkP2PRelay` must pass: setting enabled, DM channel, exactly two sessions, two distinct
non-bot users, no active recording/transcription/live-captions job. Otherwise the message is dropped
(debug log). `bye` is relayed whenever both sessions are in the same call, since "conditions stopped
holding" is exactly why it is sent. The server never inspects or stores SDP/candidates.

Robustness: signals that arrive before the receiver considers the call eligible (its call state can be
slightly behind) are queued for up to 10 s. A peer that does not support P2P (older client, mobile)
simply never answers and the offerer falls back after 5 s.

## Fallback rules

- Not connected within **5 s** of `p2p-connecting` → fallback.
- `failed` at any time → fallback. `disconnected` for more than **3 s** while in `p2p` → fallback.
- The side that falls back sends `bye(failed)` so the other side follows immediately, and logs
  `p2p: falling back to sfu: <reason>` (client logs, also included in the call debug logs).
- After a fallback P2P is not attempted again with that peer for the rest of the call.
- Becoming ineligible (recording starts, a third session joins, ...) is not a failure: both sides go back
  to the SFU and try again when eligible again.
- With `EnableP2PDirectCalls=false` the client never creates the P2P controller and behaves exactly like before.

## Known limitations

- **Speaking indicator**: it is computed by the SFU from the audio it receives, so while in `p2p` the other
  person's "speaking" highlight does not light up (mute state, raised hand, reactions are unaffected).
- Client stats/MOS monitoring only look at the SFU connection.
- Privacy: the two participants learn each other's IP address (stated in the setting's help text).
- No simulcast/dynamic quality adaptation beyond the browser's own congestion control.

## Settings

`EnableP2PDirectCalls` (bool, default `true`) in `plugin.json`, `server/configuration.go` (client config) and
the admin console (`webapp/src/components/admin_console_settings/enable_p2p_direct_calls.tsx`).
