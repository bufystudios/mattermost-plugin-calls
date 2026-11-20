// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

package main

import (
	"testing"

	"github.com/mattermost/mattermost-plugin-calls/server/public"

	"github.com/mattermost/mattermost/server/public/model"

	"github.com/stretchr/testify/require"
)

func TestCheckP2PRelay(t *testing.T) {
	const botID = "botID"

	enabled := &configuration{ClientConfig: ClientConfig{EnableP2PDirectCalls: model.NewPointer(true)}}
	disabled := &configuration{ClientConfig: ClientConfig{EnableP2PDirectCalls: model.NewPointer(false)}}

	dmState := func() *callState {
		return &callState{
			sessions: map[string]*public.CallSession{
				"sessA": {ID: "sessA", UserID: "userA"},
				"sessB": {ID: "sessB", UserID: "userB"},
			},
		}
	}

	t.Run("DM call with two distinct users is allowed", func(t *testing.T) {
		for _, kind := range []string{p2pKindOffer, p2pKindAnswer, p2pKindCandidate, p2pKindBye} {
			require.NoError(t, checkP2PRelay(enabled, model.ChannelTypeDirect, dmState(), botID, "sessA", "sessB", kind), kind)
			require.NoError(t, checkP2PRelay(enabled, model.ChannelTypeDirect, dmState(), botID, "sessB", "sessA", kind), kind)
		}
	})

	t.Run("no ongoing call", func(t *testing.T) {
		err := checkP2PRelay(enabled, model.ChannelTypeDirect, nil, botID, "sessA", "sessB", p2pKindOffer)
		require.ErrorIs(t, err, errP2PNotAllowed)
	})

	t.Run("disabled by config", func(t *testing.T) {
		for _, cfg := range []*configuration{disabled, {}, nil} {
			err := checkP2PRelay(cfg, model.ChannelTypeDirect, dmState(), botID, "sessA", "sessB", p2pKindOffer)
			require.ErrorIs(t, err, errP2PNotAllowed)
		}
	})

	t.Run("non DM channels", func(t *testing.T) {
		for _, ct := range []model.ChannelType{model.ChannelTypeGroup, model.ChannelTypeOpen, model.ChannelTypePrivate} {
			err := checkP2PRelay(enabled, ct, dmState(), botID, "sessA", "sessB", p2pKindOffer)
			require.ErrorIs(t, err, errP2PNotAllowed, string(ct))
		}
	})

	t.Run("more than two sessions", func(t *testing.T) {
		state := dmState()
		state.sessions["sessC"] = &public.CallSession{ID: "sessC", UserID: "userA"}
		for _, kind := range []string{p2pKindOffer, p2pKindAnswer, p2pKindCandidate} {
			err := checkP2PRelay(enabled, model.ChannelTypeDirect, state, botID, "sessA", "sessB", kind)
			require.ErrorIs(t, err, errP2PNotAllowed, kind)
		}
	})

	t.Run("both sessions of the same user", func(t *testing.T) {
		state := dmState()
		state.sessions["sessB"].UserID = "userA"
		err := checkP2PRelay(enabled, model.ChannelTypeDirect, state, botID, "sessA", "sessB", p2pKindOffer)
		require.ErrorIs(t, err, errP2PNotAllowed)
	})

	t.Run("bot session", func(t *testing.T) {
		state := dmState()
		state.sessions["sessB"].UserID = botID
		err := checkP2PRelay(enabled, model.ChannelTypeDirect, state, botID, "sessA", "sessB", p2pKindOffer)
		require.ErrorIs(t, err, errP2PNotAllowed)
	})

	t.Run("active jobs need media on the server", func(t *testing.T) {
		for name, mutate := range map[string]func(*callState){
			"recording":     func(s *callState) { s.Recording = &public.CallJob{} },
			"transcription": func(s *callState) { s.Transcription = &public.CallJob{} },
			"live captions": func(s *callState) { s.LiveCaptions = &public.CallJob{} },
		} {
			state := dmState()
			mutate(state)
			err := checkP2PRelay(enabled, model.ChannelTypeDirect, state, botID, "sessA", "sessB", p2pKindOffer)
			require.ErrorIs(t, err, errP2PNotAllowed, name)
		}
	})

	t.Run("sessions must be part of the call", func(t *testing.T) {
		for _, ids := range [][2]string{{"sessA", "sessX"}, {"sessX", "sessB"}, {"sessA", "sessA"}, {"", "sessB"}, {"sessA", ""}} {
			err := checkP2PRelay(enabled, model.ChannelTypeDirect, dmState(), botID, ids[0], ids[1], p2pKindOffer)
			require.ErrorIs(t, err, errP2PNotAllowed, "%v", ids)
		}
	})

	t.Run("bye is relayed whenever both sessions are in the call", func(t *testing.T) {
		// These are exactly the cases in which clients leave P2P, so the
		// notification must still go through.
		state := dmState()
		state.sessions["sessC"] = &public.CallSession{ID: "sessC", UserID: "userC"}
		state.Recording = &public.CallJob{}
		require.NoError(t, checkP2PRelay(disabled, model.ChannelTypeGroup, state, botID, "sessA", "sessB", p2pKindBye))

		// ...but never across calls.
		err := checkP2PRelay(enabled, model.ChannelTypeDirect, state, botID, "sessA", "sessX", p2pKindBye)
		require.ErrorIs(t, err, errP2PNotAllowed)
	})
}

func TestIsValidP2PKind(t *testing.T) {
	for _, kind := range []string{"offer", "answer", "candidate", "bye"} {
		require.True(t, isValidP2PKind(kind), kind)
	}
	for _, kind := range []string{"", "sdp", "Offer", "ice"} {
		require.False(t, isValidP2PKind(kind), kind)
	}
}

func TestP2PDirectCallsDefault(t *testing.T) {
	var cfg configuration
	cfg.SetDefaults()
	require.True(t, cfg.p2pDirectCallsEnabled())

	cfg.EnableP2PDirectCalls = model.NewPointer(false)
	cfg.SetDefaults()
	require.False(t, cfg.p2pDirectCallsEnabled())

	clone := cfg.Clone()
	require.NotNil(t, clone.EnableP2PDirectCalls)
	require.False(t, *clone.EnableP2PDirectCalls)
}
