# Discord-style voice UX on the Mattermost Calls plugin — implementation plan

Scope: reshape the EXISTING Calls UI in `/home/umit/code/mattermost-plugin-calls` (fork of upstream v1.12.6). Target: MM 12.1 Team Edition, web + desktop app. Research was read-only (no edits, no builds).

Paths are relative to the repo root unless noted. `W` = `webapp/src`, `S` = `server`.

## 0. Read this first (caveats that change the plan)

1. **Team Edition blocks channel calls by default.** `S/session.go:254` rejects any non-DM call when `licenseChecker.GroupCallsAllowed()` is false. `S/enterprise/license.go:60-62`: allowed only with a Professional+ license **or** env `MM_CALLS_GROUP_CALLS_ALLOWED=true` on the MM server process. The webapp mirrors it: `W/components/channel_header_button.tsx:43` hides the button, `W/selectors.ts:685` reads `GroupCallsAllowed`. Voice rooms (channels) are impossible until this is solved (env var, or patch the checker in our fork). The team must decide this and check that it fits their Mattermost licence terms (Q9). Host controls (mute others) are also Professional-gated (`license.go:56-58`); not needed here.
2. **The webapp types I could read are stale.** `webapp/mattermost-webapp/` is pinned to commit `d2c3710` (`webapp/install_mattermost_webapp.sh`; its `version.go` lists 9.10.0, `channels/package.json` says 9.3.0), but the plugin targets MM 12 (`plugin.json` `min_server_version: 12.0.0`, React 19 fixes in git log). Every sidebar/registry finding below comes from that snapshot. **Phase 0 must re-verify the sidebar DOM and registry in a real 12.1 build** before any sidebar work.
3. **The working tree is mid-change.** The P2P branch has uncommitted edits to `W/client.ts`, `W/index.tsx`, `W/selectors.ts`, `W/types/types.ts`, `S/websocket.go`, `S/client_message.go`, `S/configuration.go`, `plugin.json`, `standalone/src/init.ts`, plus new `S/p2p.go` and `W/p2p.ts`. I read the working-tree versions, so `client.ts` / `index.tsx` line numbers below can shift after that branch lands. I flag every spot where we must touch `client.ts`.
4. **Screen share is hard-limited to ONE stream per call** in three layers (server state, rtcd, client). Multi-stream Go Live is **not** UI-only (see 2.2).
5. **Global PTT is impossible from a plugin.** `@mattermost/desktop-api` (`webapp/node_modules/@mattermost/desktop-api/lib/index.d.ts:83-101`) has no global-shortcut / key-hook API. PTT works only while a Mattermost window has focus, which matters for people who play a game in the foreground (Q5).

---

## 1. Current-state inventory

### 1.1 UI surfaces (what exists, who owns it)

| Surface | What it is today | Owner |
|---|---|---|
| **Channel header button** | Phone button "Start call" / "Join call", registered through `registry.registerCallButtonAction` (`W/index.tsx:500`). Hidden when calls are explicitly disabled (`selectors.ts:591`) or group calls not allowed (`channel_header_button.tsx:43`). Click → `joinCall` (`index.tsx:503-505`, logic `437-478`). | `W/components/channel_header_button.tsx`, `channel_header_dropdown_button/` |
| **Channel header menu** | "Enable/Disable calls in this channel" item via `registerChannelHeaderMenuAction` (`index.tsx:903-904`), only if user has permission (`selectors.ts:594`). This writes `calls_channels.enabled`. | `W/components/channel_header_menu_button/` |
| **Sidebar / channel list** | Only a tiny phone icon on the right of the row while a call is active + tooltip "A, B are on the call". Uses `registerSidebarChannelLinkLabelComponent` (`index.tsx:360`). No avatars, no speaking/muted/LIVE state. | `W/components/channel_link_label/component.tsx:19-72`, `index.ts:17-24` |
| **Call widget (in-call)** | Floating widget in the webapp, or a separate global window in the desktop app (`props.global`, `call_widget/component.tsx:451`, `appRegion: 'drag'` at `2416`). Shows speaker avatar + status text + timer (`2504-2520`), mute, share, participants list, leave, expand/pop-out. Rendered through `registerGlobalComponent`/standalone widget bundle. | `W/components/call_widget/component.tsx` (2953 lines), `participants_list.tsx`, `participant.tsx` |
| **Expanded view / popout** | Route `/expanded` (`registerNeedsTeamRoute`, `index.tsx:367`) and a `window.open` popout (`call_widget/component.tsx:2086-2125`, window opened at `2112`). Has speaker/grid toggle (`expanded_view/component.tsx:147`, `590`, label `1313-1314`), screen player with media-chrome fullscreen button (`1076-1143`, fullscreen at `1123`), participant RHS list, controls bar (mute `1450`, video `1476`, screen `1503`, record `1534`). | `W/components/expanded_view/component.tsx` (2047 lines) |
| **Participant grid** | Avatar tiles with 4 auto-sized tile sizes (`participants_grid.tsx:21-38`, sizing `61-120`), mute badge, hand, reaction, host badge. Speaking = green glow ring `borderGlowWidth={3}` (`participant_cell.tsx:126`, colour `rgba(61,184,135,.56)` in `avatar/avatar.tsx:33`). | `expanded_view/participants_grid.tsx`, `participant_tile.tsx`, `participant_cell.tsx` |
| **"Call started" post** | Custom post `custom_calls` (`registerPostTypeComponent`, `index.tsx:363`): avatars, "Call started", Join button, ended state. Created on server at first join (`S/websocket.go:825`). | `W/components/custom_post_types/post_type_event.tsx:85,237,348` |
| **Channel toast** | "Join call" toast over the channel view (`registerChannelToastComponent`, `index.tsx:362`). | `W/components/channel_call_toast.tsx:31-56` |
| **Ringing / incoming call UI** | Bottom-left stack of incoming call cards (`incoming_calls/call_container.tsx:17-51`, registered global `index.tsx:370`), ringtone, desktop notification suppression (`W/desktop_notifications.ts:28-37`). **Only DM and GM** (`W/actions.ts:365`), only if server `EnableRinging` (`selectors.ts:560`; server push also gated `S/push_notifications.go:40,75`). Triggered on `call_start` (`websocket_handlers.ts:169-177`). | `W/components/incoming_calls/*`, `W/actions.ts:357-400` |
| **Settings / prefs** | Per-user Calls section in MM user settings (`registerUserSettings`, `index.tsx:372-386`): "Audio devices settings", "Screen sharing settings". All client prefs live in `localStorage` (`W/constants.ts:124-132`), not server prefs. Admin console: System Console custom settings (`index.tsx:516-585`). | `W/components/user_settings/*`, `W/components/admin_console_settings/*` |
| **Keyboard shortcuts** | `W/shortcuts.ts`: global `Ctrl/⌘+Alt+S` join (19-21, handled `index.tsx:1171-1180`), widget scope (mute `Ctrl+Shift+Space`, hand, reaction, share, participants, leave), popout scope = widget + `space`=PTT + `Ctrl+Alt+R` record (`shortcuts.ts:29-33`). | `W/shortcuts.ts` |

### 1.2 Per-feature inventory: exists vs missing

**Feature 1 — persistent voice channels**

| Item | State | Evidence |
|---|---|---|
| Join a channel call without ringing | **Exists.** Ringing is DM/GM-only on the client (`actions.ts:365`). Public/private channel calls never ring. | |
| Rooms listed in channel list | **Missing.** No notion of a voice room. | |
| Who is inside, visible in sidebar | **Partial.** `user_joined`/`user_left` are broadcast to the *channel* (`S/websocket.go:959-962`, `S/session.go:436-439`) so every channel member's store has the participant list; `profilesInCallInChannel` exists (`W/selectors.ts:154-156`). UI only renders an icon (`channel_link_label/component.tsx`). | |
| Muted / speaking / LIVE state for non-participants | **Missing at the protocol level.** `user_muted/unmuted` (`S/websocket.go:370-375`), `user_screen_on/off` (`:240-245`), `user_video_on/off` (`:465-469`), `user_voice_on/off` (`S/rtcd.go:651-657`, `S/websocket.go:678-694`) are all broadcast only to `UserIDs` of call sessions. Non-members of the call never see them. Initial snapshot (`/channels`, `S/api.go:158-245`, `state.go:214-250`) includes `unmuted`, `raised_hand`, `video`, `screen_sharing_session_id`, but then goes stale. | |
| Call lifecycle | Call row is created at first join and **ended when the last session leaves** (`S/session.go:461-520`). A room does not need a running call to be "always on": it only needs to be joinable. Keeping an empty call alive is NOT recommended (rtcd group state, jobs, DB active-call rows). | |
| "Enabled" gating | `userCanStartOrJoin` (`S/session.go:244-275`): channel `enabled=true` OR `DefaultEnabled` else only sysadmins start (Test mode). Voice rooms should set `calls_channels.enabled=true`. | |
| Per-channel metadata slot | **Exists but unused.** `calls_channels.props jsonb` (`S/db/migrations/postgres/000001_create_calls_channels.up.sql`), `public.CallsChannel.Props` (`S/public/calls_channel.go:11-15`), accepted by `POST /{channel_id}` (`S/api.go:490-557`, event `channel_enable_voice` at `:553`). **But** neither `GET /channels` (`api.go:158-245`) nor the ws event returns `props` → small server change. No migration needed. | |
| Spam from rooms | `createCallStartedPost` creates a post + thread each time the room goes non-empty (`S/websocket.go:825`), `followThread` on join (`index.tsx:426`, `websocket_handlers.ts:169-173`), "ended" post update (`S/session.go:~478`). Must be suppressed for voice rooms. | |

**Feature 2 — Go Live / stream watching**

| Item | State | Evidence |
|---|---|---|
| Share screen | **Exists**, one sharer per call. | |
| LIVE badge | **Missing.** Widget shows a small screen icon next to the sharer (`call_widget/participant.tsx:124`); the grid hard-codes `isSharingScreen={false}` (`expanded_view/participant_tile.tsx:76`) so the grid shows nothing. | |
| Opt-in watch | **Missing.** The player renders automatically whenever someone shares (`expanded_view/component.tsx:1410`; widget panel `call_widget/component.tsx:1067`). Stream bytes are forwarded by the SFU to every session regardless of UI (`rtcd call.go:92-122`). UI-only opt-in = hide the player; real opt-in (no bandwidth) needs rtcd work. | |
| **Multiple simultaneous streams** | **Hard limit at 3 layers:** (a) plugin server `ScreenSharingSessionID string` (`S/state.go:99,230`, `S/public/call.go:68`); `screen_on` fails if non-empty (`S/websocket.go:182-185`), `screen_off` checks equality (`:193-196`), cleanup `S/session.go:304`, `S/host_controls.go:157`. (b) rtcd v1.2.6 (`go.mod:24`): single `call.screenSession` (`service/rtc/call.go:20,69-85`), `clearScreenState` (`:92-122`), per-session single `screenTrackSender` (`session.go:81,426,472,515`), simulcast `getScreenSession()` (`simulcast.go:154-160`), screenStreamID taken from the one screen session (`sfu.go:424-426`). (c) client: one `remoteScreenTrack`/`remoteScreenStream` event (`W/client.ts` `onRemoteStream`, ~818-865) and one `screenStream` state in widget/popout (`call_widget/component.tsx:518-532`), `calls-common` type `CallState.screen_sharing_session_id: string` (`node_modules/@mattermost/calls-common/lib/types/types.d.ts`). | |
| Fullscreen / popout | **Exists.** Fullscreen via media-chrome button (`expanded_view/component.tsx:166,1123`), popout via `window.open` (`call_widget/component.tsx:2112`). Missing: per-stream fullscreen/popout when more than one stream. | |

**Feature 3 — grid + speaking indicators**

| Item | State | Evidence |
|---|---|---|
| Speaking state source | **Server-side VAD in rtcd**: `InitVAD` (`rtcd service/rtc/session.go:~581-605`) → `VoiceOn/OffMessage` → plugin ws `user_voice_on/off` (`S/rtcd.go:636-657`, `S/websocket.go:678-694`) → reducer sets `voice` flag (`W/reducers.ts:260-325`, `websocket_handlers.ts:295-315`). Works for any SFU call; participants only (see above). | |
| Grid | **Exists** for audio participants (`participants_grid.tsx`); speaking ring exists (`participant_cell.tsx:126`). | |
| Video tiles in the grid | **Missing for >2 people.** UI assumes DM: `expanded_view/component.tsx:924,970` ("assuming this only renders in a DM"), single `otherVideoStream` state (`:142`, `:710`, `:747`), single `remoteVideoStream` event. Server does not restrict video to DMs (`S/websocket.go:382-470`, per-session `videoStreamID` in rtcd `sfu.go:559`); config gate is global `EnableVideo` (`S/configuration.go:145`). | |
| Enlarge / focus a card | **Missing.** Only the speaker/grid toggle (`component.tsx:590`) and the screen-share player. | |
| Speaking ring elsewhere | Widget shows one "active speaker" avatar (`call_widget/active_speaker.ts:8-17`); participant rows in the widget/RHS have no ring. | |

**Feature 4 — PTT + per-user volume + noise suppression**

| Item | State | Evidence |
|---|---|---|
| PTT | **Partial.** Hard-coded `space` in the **popout/expanded view only** (`shortcuts.ts:30`; keydown `expanded_view/component.tsx:392-437`, keyup `374-390`, blur `366-372`, mute-toggle guard `~471`, tooltip "Or hold space bar" `1259`). Needs the popout focused and no input focused (`isActiveElementInteractable`). Not in the widget (`widgetMappings` has no PTT), not configurable, no setting, no persistence, no on-screen indicator besides the mute state. | |
| Per-user volume | **Missing.** Remote audio is attached as hidden `<audio>` elements per track with no link to the sender (`call_widget/component.tsx:414-443`). The mapping is recoverable: SFU track ids are `voice_<sessionID>_<rand>` and stream id = sender session id (rtcd `utils.go:34-36`, `sfu.go` out tracks `NewTrackLocalStaticRTP(..., us.cfg.SessionID)`) → verify in a spike. | |
| Noise suppression | **Hard-coded ON** (`W/client.ts:134-136`: AGC, echo cancel, NS all `true`); no toggle. | |
| Settings UI to extend | `user_settings/audio_devices_settings_section.tsx`, in-call `expanded_view/call_settings.tsx` (579 lines), widget device menu. | |

---

## 2. Per-feature plan

Effort: S < 1 day, M 1-3 days, L > 3 days. "client.ts" marks a P2P-branch conflict zone.

### 2.1 Persistent voice channels (rooms in the sidebar)

**UX.** Voice rooms look like channels in the sidebar with a speaker icon. Under the name, 18-20px avatars of everyone inside (max ~5, then "+N"), small mic-off badge on muted users, a `LIVE` pill on anyone sharing. Clicking the row opens the room (its text chat) and joins audio immediately, no ring, no "call started" post. Leaving = widget leave button or joining another room (existing switch modal `showSwitchCallModal`, `index.tsx:431`). The widget already survives channel switches, so browsing other channels while connected works like Discord.

**Modelling the room (recommended).** `calls_channels.props["voice_room"]="true"` (+ `enabled=true`). Set through the existing `POST /plugins/com.mattermost.calls/{channel_id}` (permission: channel/team admin, `S/api.go:444-488`); expose a header-menu toggle ("Make this a voice room") next to the existing enable toggle and a slash command `/call voice-room on|off`. Return `props` in `GET /channels` and in the `channel_enable_voice` ws event. Alternatives in Q1.

**Required changes**

| Layer | Change | Files | Effort |
|---|---|---|---|
| server | Return `props` in `handleGetAllCallChannelStates` + ws payload; preserve other props on POST (today it overwrites `Props`, `api.go:530-537`); skip `createCallStartedPost`/thread/DM-timer for voice rooms (`websocket.go:825`), skip "ended" post update (`session.go:~478`); broadcast `user_muted/unmuted`, `user_screen_on/off`, `user_video_on/off` to the channel (not only participants) so the sidebar stays current for non-participants (`websocket.go:240-245`, `370-375`, `465-469`; mind `UserIDs` loop in `publishWebSocketEvent`, `:121-160`). Speaking (`voice_on/off`) stays participants-only (Q7). Slash command in `S/slash_command.go`. | `S/api.go`, `S/websocket.go`, `S/session.go`, `S/slash_command.go`, `S/public/calls_channel.go` | M |
| protocol | New ws field `props` on `channel_enable_voice`; no new events. Client type `channelState` gets `props`. | `W/types/types.ts`, `W/reducers.ts` (channel state reducer ~`index.tsx:940-945` dispatch) | S |
| webapp | `registerSidebarChannelLinkLabelComponent` component renders occupants (see layout options below). Selector `isVoiceRoom(channelId)`. Root component `VoiceRoomAutoJoin` modelled on `JoinCallWatcher` (`W/components/join_call_watcher.tsx:19-70`, registered `index.tsx:1104-1112`): when current channel changes (not on first load, to avoid joining on reload) to a voice room and not already in a call → `joinCall` (goes through test-mode/limit gating, `index.tsx:437-478`). Hide `ChannelCallToast` and the call-started post type rendering for voice rooms; suppress `followThread`. Header button text "Join voice". | `W/components/channel_link_label/*`, new `W/components/voice_room_auto_join.tsx`, `W/index.tsx`, `W/selectors.ts`, `W/components/channel_call_toast.tsx`, `channel_header_button.tsx` | M |

**Sidebar layout options (no clean slot exists).**
Findings from the pinned snapshot (re-verify in 12.1, Phase 0):
- The only per-channel plugin slot is `SidebarChannelLinkLabel` (`mattermost-webapp/webapp/channels/src/plugins/registry.ts:1081`, marked **INTERNAL: subject to change without notice**). It renders **inside** the row's `<Link>` (`components/sidebar/sidebar_channel/sidebar_channel_link/sidebar_channel_link.tsx:247-258, 293`), inside `.SidebarChannelLinkLabel_wrapper`, which is `display:flex; overflow:hidden`.
- The row `li.SidebarChannel` is fixed `height: 32px; overflow: hidden` (`sass/layout/_sidebar-left.scss:1037-1041`).
- `registerLeftSidebarHeaderComponent` (`registry.ts:111`, public API, "fixed to the top of the left sidebar") renders in `.sidebar--left__icons` above the list (`components/sidebar/sidebar.tsx:262-264`). No slot between/below channels, no category slot.

| Option | How | Risk |
|---|---|---|
| **A. Inline stack (safe default)** | Label slot renders mini-avatars + dots on the right of the 32px row. Only supported API. Not "under the name". | Low. Cosmetic change only if MM changes the slot. |
| **B. Stacked under name (recommended, flagged)** | Same label component; plugin injects a `<style>`: `li.SidebarChannel:has(.calls-voice-occupants){height:auto}`, `a.SidebarLink:has(.calls-voice-occupants){flex-wrap:wrap;height:auto}`, wrapper wraps, occupants `flex-basis:100%`. No DOM portal. Needs Chromium `:has` (Electron ≥ 21; MM desktop is newer). Loses the li height transition for those rows; react-beautiful-dnd re-measures on drag start. | Medium: depends on MM class names (`SidebarChannel`, `SidebarLink`, `SidebarChannelLinkLabel_wrapper`) + an INTERNAL slot. Failure mode = falls back to option A look. Keep behind a plugin setting so we can turn it off after an MM upgrade. |
| **C. Own "Voice" panel** | `registerLeftSidebarHeaderComponent` renders a "Voice channels" block above the list with full layout control. Rooms are also real channels, so they appear **twice** (native list + panel) unless we hide the native row via CSS keyed on `#sidebarItem_<name>` or move rooms to a custom sidebar category. | Medium: duplicate entries, loses unread badges/drag/mute of native rows if hidden. Public API, so upgrade-stable. |

Recommendation: A in the first PR (ships everywhere), B as an opt-in enhancement on top, C only if B breaks in real 12.1.

**Risks.** INTERNAL slot name; stale 9.x types; extra ws volume if mute/screen go channel-wide (fine for a small team); the room's text chat is just the channel; unread counts unchanged; reload must not auto-join.
**Effort total: M-L** (server M, webapp M, spike S).

### 2.2 Go Live / stream watching

**UX.** `LIVE` pill (red) next to the sharer's avatar in sidebar, widget participant list, grid card, popout list. A stream card in the grid shows a thumbnail-less placeholder ("X is live — Watch"); click = start watching; viewing state is local. Per-stream actions: fullscreen, popout window, "stop watching". Streamer sees "You're live — N watching" (viewer count needs a new signal, skip in v1).

**Split**
- **2.2a — LIVE badge + click-to-watch for the existing single stream: webapp-only, M.** Replace the auto-rendering screen player (`expanded_view/component.tsx:1410`, widget panel `call_widget/component.tsx:1067`) with a "Watch" gate keyed on local state `watchingSessionIDs`; pass real `isSharingScreen` in `participant_tile.tsx:76`; badge component shared by widget (`participant.tsx:124`), grid (`participant_cell.tsx:212`), sidebar label (needs the channel-wide screen broadcast from 2.1). Caveat: the track keeps arriving over the SFU even when not watched; this is UI opt-in, not bandwidth opt-in. Auto-watch your own share, auto-watch when the sharer is the only other participant (DM) to avoid a regression there.
- **2.2b — real multi-stream (server + rtcd + protocol + client): L.**
  - rtcd (needs a fork, plugin pulls `github.com/mattermost/rtcd v1.2.6` from `go.mod:24`; the embedded rtcd is what runs on Team Edition since external rtcd is licence-gated, `license.go:RTCDAllowed`): `call.screenSession` → `map[sessionID]*session`; per-session `screenTrackSender` → map keyed by source; `clearScreenState` per source; simulcast path (`simulcast.go:154-260`) per source; streamID lookup (`sfu.go:424`). 19 references to `getScreenSession`/`screenStreamID`.
  - plugin server: `ScreenSharingSessionID string` → `[]string` stored in call Props JSON (no migration, `S/state.go:99`, `public/call.go:68`), `screen_on` no longer rejects when someone else is sharing (`websocket.go:182-185`), cleanup in `session.go:304`, `host_controls.go:157`; keep sending legacy `screen_sharing_session_id` (first sharer) for old clients plus new `screen_sharing_session_ids`.
  - protocol (`@mattermost/calls-common`, pinned by git hash in `webapp/package.json:24`): extend `CallState`, reducer shape `screenSharingID` (`W/reducers.ts`) to a list; confirm how `rtc_peer` reports track type/owner (not readable in `lib/*.d.ts`; spike). We will need to carry a patched calls-common (fork + hash bump).
  - client (`client.ts`, **P2P conflict zone**): `remoteScreenTrack` → `Map<sessionID, MediaStreamTrack>`; `remoteScreenStream` event gets `{sessionID, stream}`; local share unchanged except no longer exclusive. Recorder/transcriber bots (`S/bot_api.go`) assume one screen; check.
  - UI: a screen "card" per sharer in the grid, each with watch/fullscreen/popout.

**Risks.** rtcd fork = permanent upstream drift (every plugin upgrade re-bases a media-server patch); simulcast + AV1 paths multiply testing; bandwidth of N streams x N viewers on the single-box SFU (opt-in at SFU level should accompany 2.2b, extra L); desktop screen picker (`desktopAPI.onScreenShared`, `call_widget/component.tsx:~470`) must allow a second share while one is active.
**Effort: 2.2a M, 2.2b L (+ L for SFU-level subscription).**

### 2.3 Grid view + speaking indicators

**UX.** Expanded view = grid of cards (avatar, name, mic state, green speaking ring; camera cards show video; screen cards as above). Click a card to enlarge it (focus layout: big card + filmstrip). Speaking ring also on sidebar avatars **for people in the same call** and on widget participant rows.

| Layer | Change | Files | Effort |
|---|---|---|---|
| webapp only | Speaking ring component reused: sidebar occupants (only when current user is in that call, because `voice_on/off` is participants-only), widget `participant.tsx` rows, RHS list `call_participant_rhs.tsx`. | `W/components/call_widget/participant.tsx`, `expanded_view/call_participant_rhs.tsx`, new shared `speaking_ring` | S |
| webapp only | Focus/enlarge: `focusedCardID` state in expanded view; layout switch in `participants_grid.tsx` (new `FocusedLayout`). Existing `viewState` ('grid'|'speaker') stays. | `expanded_view/component.tsx`, `participants_grid.tsx` | M |
| webapp + client.ts | Camera cards for N participants: replace single `otherVideoStream` (`component.tsx:142,710,747`) with `Map<sessionID, MediaStream>` fed by `remoteVideoStream` events carrying a session id (derive from stream id; **client.ts touch**, `onRemoteStream`); remove the DM-only assumption (`component.tsx:924,970`); gate on `EnableVideo`; widget keeps showing one remote video. Verify non-DM video is not blocked in rtcd/UI buttons. | `W/client.ts` (small), `expanded_view/component.tsx`, `participant_tile.tsx`/`participant_cell.tsx`, `W/types` | M-L |
| server/protocol | none expected (video per session already in rtcd/server); `user_video_on/off` to channel only needed for sidebar. | | - |

**Risks.** Large rendering diffs inside the 2047-line expanded view (merge conflicts with upstream and with P2P branch work on DM video); layout perf with many `<video>`; recorder client (`W/components/expanded_view/*` is also reused by the recorder via `profileImages` prop) must keep rendering.
**Effort: M (no video), L (with video grid).**

### 2.4 PTT + per-user volume + noise suppression

**UX.** Settings → Calls → "Voice input": `Voice activity` | `Push to talk` (key capture field, release delay 0-500 ms, optional beep), `Noise suppression` toggle. In-call: a small "PTT" pill on the widget and popout mic button; holding the key lights it. Per-user volume: right-click or hover "⋯" on a participant row/card → slider 0-200 % + "Mute for me"; stored locally per user id.

| Part | Required change | Layer | Files | Effort |
|---|---|---|---|---|
| PTT key config | Move PTT out of hard-coded `popoutMappings`; read key from prefs (`localStorage`, new key in `constants.ts`); capture UI in user settings; use `ev.code`; allow modifier-only keys. | webapp | `W/shortcuts.ts:29-33`, `W/constants.ts`, new `user_settings/voice_input_settings_section.tsx` (+ register in `index.tsx:372-386`) | M |
| PTT in the widget too | Hoist the keydown/keyup/blur logic out of `expanded_view/component.tsx:366-437` into a shared hook/helper used by `call_widget/component.tsx:350,502` and the popout. Keep upstream behaviour when PTT mode is off. **Mode switch**: when PTT enabled, force-mute at join and ignore the mute toggle (existing guard `~471`). | webapp (calls `callsClient.mute/unmute`, public API, no client.ts edit) | `W/components/call_widget/component.tsx`, `expanded_view/component.tsx`, new `W/ptt.ts` | M |
| PTT out of focus | **Not possible from plugin** (no global key API, Electron `globalShortcut` has no key-up). Needs MM desktop change or a separate tool. Q5. | desktop | - | - |
| Per-user volume | Need sender mapping for each remote voice track. Add `callsClient.getRemoteVoiceSessions()` or tag audio elements with `data-session-id` derived from stream id when the `remoteVoiceStream` event fires (**small client.ts touch**: emit `{stream, sessionID}`; P2P tracks carry the peer id already). Volume store `calls_user_volumes` in localStorage; apply to `<audio>.volume`. Values above 100 % need a WebAudio `GainNode` (HTMLMediaElement.volume caps at 1.0) → use WebAudio from the start. Screen-share audio is also routed through voice streams (`client.ts` ~833-836): keep it at 100 % or give the sharer's volume apply to both. | webapp (+ client.ts hook) | `call_widget/component.tsx:414-443`, `call_widget/participant.tsx`, `expanded_view/call_participant_rhs.tsx`, `participant_cell.tsx`, new `W/user_volume.ts` | M |
| Noise suppression toggle | Constraint is hard-coded (`client.ts:134-136`). Add pref and `track.applyConstraints({noiseSuppression})` on the live mic track (no re-negotiation), re-apply on device change. Optional later: RNNoise via WASM (L) for better-than-browser suppression. | webapp + client.ts (small) | `W/client.ts:134`, `user_settings/audio_devices_settings_section.tsx`, `expanded_view/call_settings.tsx` | S |

**Risks.** Desktop app: window focus loss during a game kills PTT; Linux Desktop treats Alt-sequences as menu (already special-cased `expanded_view/component.tsx:~386`); WebAudio autoplay policies; the same `callsClient` is shared between main window and popout (`window.opener`), PTT must be wired once per focused window; apply NS changes to the right track when P2P is active.
**Effort: M-L total** (PTT M, volume M, NS S).

---

## 3. Dependencies and recommended build order

Dependency graph:
- Everything channel-based needs **Phase 0** (group calls on Team Edition + 12.1 slot verification).
- **Track↔session mapping** in `client.ts` is shared by per-user volume, multi-video grid and multi-screen: do it once, early, as a tiny PR coordinated with the P2P branch owner.
- LIVE badge in the sidebar and mute state for non-participants need the **channel-wide broadcast** from the voice-room server PR.
- Multi-stream depends on LIVE/watch UI (2.2a) and on the rtcd fork; do it last.
- Video grid depends on the track mapping and on the focus layout.

Phases (each shippable alone):

| # | Phase | Contents | Layers | Effort |
|---|---|---|---|---|
| 0 | Prereqs + spike | Decide Q9, enable group calls; run Calls on real MM 12.1 and inspect sidebar DOM/registry (label slot, `:has` support, class names); check `track.id`/stream-id ↔ session id; check non-DM video in UI. | ops + notes | S |
| 1 | Voice input quality | Noise suppression toggle; configurable PTT (settings + widget + popout); track↔session mapping hook; per-user volume. | webapp (+ tiny client.ts) | M-L |
| 2 | Speaking/LIVE polish | Shared speaking ring on widget/RHS rows; LIVE badge (grid + widget); real `isSharingScreen` in grid; click-to-watch gate for the existing single stream; focus/enlarge a card. | webapp | M |
| 3 | Voice rooms v1 | `voice_room` prop (server + `props` in API/ws), slash/header toggle, no-post/no-toast/no-thread for rooms, auto-join root component, sidebar option A (inline avatars + muted/LIVE via channel-wide broadcast). | server + webapp | M-L |
| 4 | Sidebar polish | Stacked layout option B behind a setting, optional "Voice" category helper; DM ringing decision applied. | webapp | S-M |
| 5 | Video grid | Per-session video streams, camera cards for N participants (non-DM). | webapp + client.ts | M-L |
| 6 | Multi-stream Go Live | rtcd fork + server screen set + calls-common patch + client map + multi card UI; optional SFU-level subscribe so unwatched streams cost nothing. | rtcd + server + protocol + client | L (+L) |

Phases 1, 2 are independent of 3 and can run in parallel branches; 3 → 4 sequential; 5 and 6 only after 2.

## 4. Open questions for the team

Q1. **How does a channel become a voice room?**
 a) `calls_channels.props.voice_room` flag set via header menu + `/call voice-room` (needs a small server change) **(recommended)**
 b) Name convention, e.g. channels starting with `voice-` (zero server work, easy to mis-create, rename = silent change)
 c) Plugin setting in System Console with a list of channel IDs (admin-only, no per-channel UI)
 d) Everything in a sidebar category called "Voice" (per-user, fragile)

Q2. **Sidebar layout?**
 a) Inline avatar stack on the right of the normal row (supported API, safest)
 b) Stacked under the channel name via CSS `:has` override on the label slot **(recommended as opt-in on top of a, with a fallback to a)**
 c) Own "Voice channels" panel above the channel list (public API, duplicates rooms)

Q3. **What does a click on a voice room do?**
 a) Open the room's text chat and auto-join audio (only on channel switch, not on reload) **(recommended)**
 b) Join audio without navigating (needs a DOM click interceptor on the sidebar row; fragile)
 c) Open chat only, join with a button in the header

Q4. **Should voice rooms leave "call started" posts and threads?**
 a) No posts/threads/toasts for voice rooms **(recommended)**
 b) Keep one post per session start (noisy for always-on rooms)
 c) One post per day, edited with participants

Q5. **PTT scope and default key (desktop window focus limit)?**
 a) User-configurable key, default off; works while a Mattermost window is focused; document the limit **(recommended)**
 b) Same, plus default `Space` in popout (current upstream behaviour) and nothing in the widget
 c) Ask MM desktop for a global key hook / build a small native helper (large, separate project)
 d) Drop PTT, rely on VAD + mute shortcut

Q6. **DM ringing?**
 a) Keep ringing in DMs/GMs only, rooms never ring (upstream behaviour, `EnableRinging=true`) **(recommended)**
 b) Turn ringing off completely; DMs behave like quiet voice rooms
 c) Ring only in DMs, and only when the callee is online/not DND

Q7. **What should non-participants see in the sidebar?**
 a) Who is inside + muted + LIVE; no speaking ring (speaking only for people in the call) **(recommended)**
 b) Everything including speaking (needs channel-wide `voice_on/off`, many events)
 c) Only who is inside

Q8. **Go Live rollout?**
 a) Ship LIVE badge + click-to-watch on the single stream first, multi-stream later **(recommended)**
 b) Go straight to multi-stream (needs the rtcd fork before any UI value ships)
 c) Stay with one stream permanently, add "request to share" queue instead

Q9. **Team Edition group-call gate?**
 a) Set `MM_CALLS_GROUP_CALLS_ALLOWED=true` on the MM server (no code, upstream-supported env) **(recommended, after the team confirms this fits their Mattermost licence terms)**
 b) Patch `GroupCallsAllowed()` in our fork (code drift, same licence question)
 c) Buy a Professional licence

Q10. **Max participants / video for rooms?**
 a) Leave `MaxCallParticipants` unlimited, keep video optional (`EnableVideo=true`) **(recommended)**
 b) Cap rooms at ~8-10 to protect the single embedded SFU
 c) Audio + screen only, no camera in rooms

## 5. Team decisions (2026-11-20)

- **Q9 / voice rooms:** do NOT unlock channel calls in Calls (licensed feature; the gate lives in Source Available `server/enterprise`). Persistent voice rooms will be a separate plugin on our own open-source media server (LiveKit or similar). Calls stays for DM calls. Phases 3, 4 and channel-wide parts of 5/6 are dropped from the Calls fork.
- **Q5 / PTT:** user-configurable key, default off, works in widget and popout while a Mattermost window has focus; the focus limit is stated in the setting.
- **Q8 / Go Live:** LIVE badge + click-to-watch on the existing single stream first; multi-stream later.
- Defaults accepted for the rest: Q6 a (ring in DMs), Q10 a.
- P2P + 60fps build 1.12.8-bufy.p2p.1 deployed to bufy server 2026-11-20.
- Speaking ring must also work in P2P mode (server VAD sees no audio there): compute it locally from audio levels.
