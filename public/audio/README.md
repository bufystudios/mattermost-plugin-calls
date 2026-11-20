# Audio host: noise suppression levels (bufy fork)

Served by Mattermost at `/plugins/com.mattermost.calls/public/audio/…` (everything in `public/` is). The Calls webapp
(`webapp/src/noise/host.ts`) loads `host.html` into a hidden same-origin iframe and calls `window.callsAudioHost.open(level, micTrack)`.
The cleaned track comes back as a plain `MediaStreamTrack`, which the client puts on its voice senders (SFU and P2P).

Why an iframe: Mattermost 12.1 sends `Content-Security-Policy: script-src 'self'`, which forbids `WebAssembly.compile()` and loading
an `AudioWorklet` from a blob in the main page. This document is a plugin file served with no policy of its own, so the WebAssembly
and the worklets run here. See `docs/bufy-noise-desktop.md`.

Ported from our Voice Rooms plugin (same files, only the global was renamed from `voiceRoomsAudioHost` to `callsAudioHost`).

| File | Origin | Licence |
|---|---|---|
| `vendor/rnnoise-worklet.js`, `vendor/rnnoise.wasm`, `vendor/rnnoise_simd.wasm` | `@sapphi-red/web-noise-suppressor` 0.4.1 (bundles `@shiguredo/rnnoise-wasm`, a WebAssembly build of RNNoise) | package MIT (`vendor/LICENSE-web-noise-suppressor`); shiguredo build Apache-2.0; RNNoise (Xiph.Org, Jean-Marc Valin) BSD-3-Clause |
| `dfn/df.js`, `dfn/df_bg.wasm` | DeepFilterNet `libDF` (upstream `wasm` feature) at commit `7b14b89`, self-built with `wasm-bindgen` 0.2.92 | MIT OR Apache-2.0 (`dfn/LICENSE-MIT`, `dfn/LICENSE-APACHE`) |
| `dfn/DeepFilterNet3_onnx.tar.gz` | the model of the same upstream commit | MIT OR Apache-2.0 (code and model weights) |
| `host.html`, `host.js`, `worklet-timing.js`, `rnnoise-worklet.js`, `dfn-worklet.js` | written by us | this repository's licence |

Nothing here talks to the network except fetching the model files that sit next to `host.html`.
