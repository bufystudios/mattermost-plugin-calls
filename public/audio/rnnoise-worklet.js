// Copyright (c) 2015-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

// Worklet module for the Enhanced level: RNNoise (BSD-3-Clause) through the processor of
// @sapphi-red/web-noise-suppressor (MIT), committed in ./vendor, see README.md.
// The timing wrapper has to come first so it is in place when the vendored module registers its processor.
import './worklet-timing.js';
import './vendor/rnnoise-worklet.js';
