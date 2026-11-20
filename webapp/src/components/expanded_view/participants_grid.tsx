// Copyright (c) 2020-present Mattermost, Inc. All Rights Reserved.
// See LICENSE.txt for license information.

import {UserSessionState} from '@mattermost/calls-common/lib/types';
import {UserProfile} from '@mattermost/types/users';
import {IDMappedObjects} from '@mattermost/types/utilities';
import React, {useEffect, useRef, useState} from 'react';
import {useDMCallingState} from 'src/components/use_dm_calling_state';
import styled from 'styled-components';

import {TileSize} from './participant_cell';
import {ParticipantTile} from './participant_tile';
import {ParticipantTileLoading} from './participant_tile_loading';
import {StreamTile} from './stream_tile';

type Props = {
    callID: string,
    callHostID: string,
    currentSessionID?: string,
    currentUserID?: string,
    profiles: IDMappedObjects<UserProfile>,
    sessions: UserSessionState[],
    onParticipantRemove?: (sessionID: string, userID: string) => void,

    // A screen share the viewer has not opened yet. Shown as a LIVE card among the tiles.
    liveStream?: {
        sessionID: string,
        profile?: UserProfile,
        onWatch: () => void,
    },

    // Used by the recorder client.
    profileImages?: Record<string, string>,
};

const STREAM_FOCUS_ID = 'live-stream';

const tileSizesMap: {[size: number]: {width: number, height: number}} = {
    [TileSize.Small]: {
        width: 96,
        height: 164,
    },
    [TileSize.Medium]: {
        width: 128,
        height: 204,
    },
    [TileSize.Large]: {
        width: 160,
        height: 236,
    },
    [TileSize.ExtraLarge]: {
        width: 208,
        height: 292,
    },
};

export function ParticipantsGrid({
    callID,
    callHostID,
    currentSessionID,
    currentUserID,
    profiles,
    sessions,
    onParticipantRemove,
    liveStream,
    profileImages,
}: Props) {
    const {isDM, isDMCalling, dmCalleeID, dmCallee} = useDMCallingState();

    // The ringing placeholder and the stream card occupy a tile, so sizing has to account for them
    const tileCount = sessions.length + (isDMCalling ? 1 : 0) + (liveStream ? 1 : 0);

    // Clicking a tile enlarges it (session id, or STREAM_FOCUS_ID for the stream card). The
    // recorder view is a static picture, it has no focus.
    const focusEnabled = !profileImages;
    const [focusedID, setFocusedID] = useState<string | null>(null);
    const toggleFocus = (id: string) => setFocusedID((cur) => (cur === id ? null : id));
    const focusExists = focusedID !== null && (focusedID === STREAM_FOCUS_ID ? Boolean(liveStream) : sessions.some((s) => s.session_id === focusedID));
    const focused = focusEnabled && focusExists ? focusedID : null;

    useEffect(() => {
        if (!focused) {
            // eslint-disable-next-line no-undefined
            return undefined;
        }
        const onKey = (ev: KeyboardEvent) => {
            if (ev.key === 'Escape') {
                setFocusedID(null);
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [focused]);

    const ref = useRef<HTMLDivElement>(null);

    const [tileSize, setTileSize] = useState(TileSize.Small);
    const [paddingV, setPaddingV] = useState(0);
    const [paddingH, setPaddingH] = useState(0);

    // This is needed to force a re-render on element resize and recalculate the dynamic sizes.
    const [resize, setResize] = useState(false);

    const computeSizes = () => {
        const res = {
            tileSize: TileSize.Small,
            paddingV: 0,
            paddingH: 0,
        };

        if (!ref.current) {
            return res;
        }

        const width = ref.current.clientWidth;
        const height = ref.current.clientHeight;

        const hMargin = Math.min(0.12 * width, 150);
        const vMargin = 0.12 * height;

        res.paddingV = Math.floor(vMargin);
        res.paddingH = Math.floor(hMargin);

        const availableWidth = width - (2 * hMargin);
        const availableHeight = height - (2 * vMargin);

        const tileSpacing = 8;

        for (const size of [TileSize.ExtraLarge, TileSize.Large, TileSize.Medium, TileSize.Small]) {
            const tileWidthWithSpacing = tileSizesMap[size].width + tileSpacing; // Include horizontal spacing
            const tileHeightWithSpacing = tileSizesMap[size].height + tileSpacing; // Include vertical spacing

            // Calculate how many tiles can fit in a single row and the number of required rows
            const tilesPerRow = Math.floor((availableWidth + tileSpacing) / tileWidthWithSpacing); // Adjust for effective width with spacing

            // Calculate rows needed based on tiles per row
            const requiredRows = Math.ceil(tileCount / tilesPerRow);

            // Calculate the total height required including the spacing between rows
            const totalHeightNeeded = (requiredRows * tileHeightWithSpacing) - tileSpacing; // Adjust for last row not needing spacing

            // Check if the current tile size fits within the available height
            if (totalHeightNeeded <= availableHeight) {
                // If size fits we can return
                res.tileSize = size;
                break;
            }
        }

        // If no size fits perfectly, return the smallest size
        return res;
    };

    useEffect(() => {
        if (!ref.current) {
            // eslint-disable-next-line no-undefined
            return undefined;
        }
        const resizeObserver = new ResizeObserver(() => {
            // Trigger re-render on element resize
            setResize((val) => !val);
        });
        resizeObserver.observe(ref.current);

        // Clean up
        return () => resizeObserver.disconnect();
    }, []);

    useEffect(() => {
        const res = computeSizes();
        setTileSize(res.tileSize);
        setPaddingH(res.paddingH);
        setPaddingV(res.paddingV);
    }, [tileCount, resize]);

    const renderTile = (session: UserSessionState, size: TileSize) => (
        <ParticipantTile
            key={session.session_id}
            session={session}
            profiles={profiles}
            tileSize={size}
            profileImages={profileImages}
            currentSessionID={currentSessionID}
            currentUserID={currentUserID}
            callHostID={callHostID}
            callID={callID}
            showHostBadge={!isDM}
            onParticipantRemove={onParticipantRemove}
            isSharingScreen={liveStream?.sessionID === session.session_id}
            focused={focused === session.session_id}
            onFocusToggle={focusEnabled ? toggleFocus : undefined}
        />
    );

    const renderStreamTile = (size: TileSize) => liveStream && (
        <StreamTile
            key={STREAM_FOCUS_ID}
            profile={liveStream.profile}
            tileSize={size}
            focused={focused === STREAM_FOCUS_ID}
            onFocusToggle={focusEnabled ? () => toggleFocus(STREAM_FOCUS_ID) : undefined}
            onWatch={liveStream.onWatch}
        />
    );

    if (focused) {
        const focusedSession = sessions.find((s) => s.session_id === focused);
        const others = sessions.filter((s) => s.session_id !== focused);

        return (
            <ParticipantsGridContainer
                ref={ref}
                $paddingV={0}
                $paddingH={0}
            >
                <FocusedLayout
                    id='calls-expanded-view-participants-grid'
                    data-testid='calls-expanded-view-focused-layout'
                >
                    <FocusedStage>
                        {focusedSession ? renderTile(focusedSession, TileSize.Focused) : renderStreamTile(TileSize.Focused)}
                    </FocusedStage>
                    <Filmstrip>
                        {focusedSession && renderStreamTile(TileSize.Small)}
                        {others.map((session) => renderTile(session, TileSize.Small))}
                    </Filmstrip>
                </FocusedLayout>
            </ParticipantsGridContainer>
        );
    }

    return (
        <ParticipantsGridContainer
            ref={ref}
            $paddingV={paddingV}
            $paddingH={paddingH}
        >
            <ParticipantsList
                id='calls-expanded-view-participants-grid'
            >
                {sessions.map((session) => renderTile(session, tileSize))}

                {renderStreamTile(tileSize)}

                {/* While a DM call is still ringing the grid shows a placeholder
                tile for the callee, next to the caller's own. */}
                {isDMCalling && (
                    <ParticipantTileLoading
                        userID={dmCalleeID}
                        profile={dmCallee}
                        tileSize={tileSize}
                    />
                )}
            </ParticipantsList>
        </ParticipantsGridContainer>
    );
}

const FocusedLayout = styled.div`
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  padding: 12px;
`;

const FocusedStage = styled.ul`
  display: flex;
  flex: 1;
  align-items: center;
  justify-content: center;
  margin: 0;
  padding: 0;
  min-height: 0;
`;

const Filmstrip = styled.ul`
  display: flex;
  justify-content: center;
  gap: 8px;
  margin: 0;
  padding: 0;
  overflow-x: auto;
`;

const ParticipantsList = styled.ul`
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  justify-content: center;
  margin: auto;
  padding: 0;
`;

const ParticipantsGridContainer = styled.div<{$paddingH: number, $paddingV: number}>`
  display: flex;
  flex: 1;
  overflow: auto;
  background: rgba(var(--button-color-rgb), 0.08);
  border-radius: 8px;
  margin: 0 12px;
  padding: ${({$paddingV}) => $paddingV}px ${({$paddingH}) => $paddingH}px;
`;

