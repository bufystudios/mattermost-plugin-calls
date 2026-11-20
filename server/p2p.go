// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

package main

import (
	"encoding/json"
	"errors"
	"fmt"

	"github.com/mattermost/mattermost/server/public/model"
)

// Peer-to-peer (P2P) media for 1:1 calls.
//
// The plugin never touches the media of a P2P connection: it only relays the
// WebRTC signaling (SDP offers/answers and ICE candidates) between the two
// sessions of a DM call. See docs/bufy-p2p.md for the full design.

const (
	p2pSignalType = "p2p_signal"

	p2pKindOffer     = "offer"
	p2pKindAnswer    = "answer"
	p2pKindCandidate = "candidate"
	// p2pKindBye tells the other side to tear down P2P and go back to the SFU.
	p2pKindBye = "bye"
)

var errP2PNotAllowed = errors.New("p2p is not allowed for this call")

// p2pSignalIn is what a client sends (zlib compressed) in a p2p_signal message.
type p2pSignalIn struct {
	// To is the (original) session ID of the other peer.
	To   string          `json:"to"`
	Kind string          `json:"kind"`
	Data json.RawMessage `json:"data,omitempty"`
}

// p2pSignalOut is what the other peer receives through the usual signal event.
// Type lets clients tell it apart from the SFU signaling (offer/answer/candidate).
type p2pSignalOut struct {
	Type string          `json:"type"`
	From string          `json:"from"`
	Kind string          `json:"kind"`
	Data json.RawMessage `json:"data,omitempty"`
}

func isValidP2PKind(kind string) bool {
	switch kind {
	case p2pKindOffer, p2pKindAnswer, p2pKindCandidate, p2pKindBye:
		return true
	}
	return false
}

func (c *configuration) p2pDirectCallsEnabled() bool {
	return c != nil && c.EnableP2PDirectCalls != nil && *c.EnableP2PDirectCalls
}

// checkP2PRelay decides whether a P2P signaling message from session `from` to
// session `to` may be relayed. Media has to stay on the SFU (and therefore P2P
// is refused) unless all of the following hold:
//   - the admin setting is enabled,
//   - the channel is a DM,
//   - the call has exactly two sessions, belonging to two distinct (non-bot) users,
//   - no recording, transcription or live captions job is active.
//
// A "bye" (go back to the SFU) is the only message that is not subject to these
// conditions, since those are exactly the reasons to leave P2P: it is relayed as
// long as both sessions are still part of the same call.
func checkP2PRelay(cfg *configuration, chType model.ChannelType, state *callState, botID, from, to, kind string) error {
	if state == nil {
		return fmt.Errorf("%w: no call ongoing", errP2PNotAllowed)
	}
	if from == "" || to == "" || from == to {
		return fmt.Errorf("%w: invalid session IDs", errP2PNotAllowed)
	}

	fromSession := state.sessions[from]
	toSession := state.sessions[to]
	if fromSession == nil || toSession == nil {
		return fmt.Errorf("%w: session is not part of the call", errP2PNotAllowed)
	}

	if kind == p2pKindBye {
		return nil
	}

	if !cfg.p2pDirectCallsEnabled() {
		return fmt.Errorf("%w: disabled", errP2PNotAllowed)
	}
	if chType != model.ChannelTypeDirect {
		return fmt.Errorf("%w: not a DM channel", errP2PNotAllowed)
	}
	if len(state.sessions) != 2 {
		return fmt.Errorf("%w: call has %d sessions", errP2PNotAllowed, len(state.sessions))
	}
	if fromSession.UserID == toSession.UserID {
		return fmt.Errorf("%w: both sessions belong to the same user", errP2PNotAllowed)
	}
	if fromSession.UserID == botID || toSession.UserID == botID {
		return fmt.Errorf("%w: bot session in call", errP2PNotAllowed)
	}
	if state.Recording != nil || state.Transcription != nil || state.LiveCaptions != nil {
		return fmt.Errorf("%w: media is needed on the server", errP2PNotAllowed)
	}

	return nil
}

// handleP2PSignal relays a P2P signaling message to the other session of a DM call.
func (p *Plugin) handleP2PSignal(us *session, msg clientMessage) error {
	var in p2pSignalIn
	if err := json.Unmarshal(msg.Data, &in); err != nil {
		return fmt.Errorf("failed to unmarshal p2p signal: %w", err)
	}
	if !isValidP2PKind(in.Kind) {
		return fmt.Errorf("invalid p2p signal kind %q", in.Kind)
	}

	state, err := p.getCallState(us.channelID, false)
	if err != nil {
		return fmt.Errorf("failed to get call state: %w", err)
	}
	if state != nil && state.Call.ID != us.callID {
		return fmt.Errorf("%w: session does not belong to the ongoing call", errP2PNotAllowed)
	}

	var chType model.ChannelType
	if in.Kind != p2pKindBye {
		channel, appErr := p.API.GetChannel(us.channelID)
		if appErr != nil {
			return fmt.Errorf("failed to get channel: %w", appErr)
		}
		chType = channel.Type
	}

	if err := checkP2PRelay(p.getConfiguration(), chType, state, p.getBotID(), us.originalConnID, in.To, in.Kind); err != nil {
		return err
	}

	data, err := json.Marshal(p2pSignalOut{
		Type: p2pSignalType,
		From: us.originalConnID,
		Kind: in.Kind,
		Data: in.Data,
	})
	if err != nil {
		return fmt.Errorf("failed to marshal p2p signal: %w", err)
	}

	// Prefer targeting the exact websocket connection. If the session is not
	// handled by this node (HA cluster) we broadcast to the user's connections:
	// clients only act on messages carrying their own connection ID.
	broadcast := &WebSocketBroadcast{UserID: state.sessions[in.To].UserID, ReliableClusterSend: true}
	if target := p.getSessionByOriginalID(in.To); target != nil {
		broadcast = &WebSocketBroadcast{ConnectionID: target.connID, ReliableClusterSend: true}
	}

	p.publishWebSocketEvent(wsEventSignal, map[string]interface{}{
		"data":   string(data),
		"connID": in.To,
	}, broadcast)

	return nil
}
