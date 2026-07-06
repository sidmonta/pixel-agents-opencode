/**
 * Server-side layout builder.
 *
 * Adds/removes shared rooms to the right of the existing office layout.
 * Each Opencode session gets one shared room with workstations for its agents.
 */

export interface SessionRoomInfo {
  sessionId: string;
  startCol: number;
  stationCount: number;
  furnitureUids: string[];
}

const WALL = 0;
const VOID = 255;
const FLOOR = 1;
const OFFICE_TOP_ROW = 10;
const OFFICE_BOTTOM_ROW = 20;

/** Add a shared room with N workstations to the right of the layout. */
export function addSessionRoom(
  layout: Record<string, unknown>,
  sessionId: string,
  numStations: number,
): { layout: Record<string, unknown>; roomInfo: SessionRoomInfo } {
  const cols = layout.cols as number;
  const rows = layout.rows as number;
  const tiles = [...(layout.tiles as number[])];
  const furniture = [...((layout.furniture as Array<Record<string, unknown>>) ?? [])];
  const tileColors = layout.tileColors
    ? [...(layout.tileColors as Array<unknown | null>)]
    : undefined;

  const leftWallWidth = 1;
  const stationWidth = 3;
  const totalNewCols = leftWallWidth + numStations * stationWidth;
  const newCols = cols + totalNewCols;

  const newTiles: number[] = [];
  const newTileColors: (unknown | null)[] = [];

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < newCols; col++) {
      if (col < cols) {
        newTiles.push(tiles[row * cols + col]);
        if (tileColors) {
          newTileColors.push(tileColors[row * cols + col]);
        }
      } else {
        const innerCol = col - cols;
        if (innerCol === 0) {
          if (row >= OFFICE_TOP_ROW && row <= OFFICE_BOTTOM_ROW) {
            newTiles.push(WALL);
          } else {
            newTiles.push(VOID);
          }
        } else if (row === OFFICE_TOP_ROW || row === OFFICE_BOTTOM_ROW) {
          newTiles.push(WALL);
        } else if (row > OFFICE_TOP_ROW && row < OFFICE_BOTTOM_ROW) {
          newTiles.push(FLOOR);
        } else {
          newTiles.push(VOID);
        }
        if (tileColors) newTileColors.push(null);
      }
    }
  }

  const furnitureUids: string[] = [];
  for (let i = 0; i < numStations; i++) {
    const baseCol = cols + leftWallWidth + i * stationWidth;

    const deskUid = `oc-${sessionId}-${i}-desk`;
    furniture.push({ uid: deskUid, type: 'DESK_FRONT', col: baseCol, row: 11 });
    furnitureUids.push(deskUid);

    const pcUid = `oc-${sessionId}-${i}-pc`;
    furniture.push({ uid: pcUid, type: 'PC_FRONT_OFF', col: baseCol + 1, row: 11 });
    furnitureUids.push(pcUid);

    const chairUid = `oc-${sessionId}-${i}-chair`;
    furniture.push({ uid: chairUid, type: 'CUSHIONED_CHAIR_FRONT', col: baseCol + 1, row: 13 });
    furnitureUids.push(chairUid);
  }

  const newLayout: Record<string, unknown> = {
    ...layout,
    cols: newCols,
    tiles: newTiles,
    furniture,
    ...(tileColors ? { tileColors: newTileColors } : {}),
  };

  return {
    layout: newLayout,
    roomInfo: { sessionId, startCol: cols, stationCount: numStations, furnitureUids },
  };
}

/** Remove a previously added room from the layout. */
export function removeSessionRoom(
  layout: Record<string, unknown>,
  roomInfo: SessionRoomInfo,
): Record<string, unknown> {
  const furnitureUidsSet = new Set(roomInfo.furnitureUids);
  const furniture = ((layout.furniture as Array<Record<string, unknown>>) ?? []).filter(
    (f) => !furnitureUidsSet.has(f.uid as string),
  );

  const cols = layout.cols as number;
  const rows = layout.rows as number;
  const tiles = [...(layout.tiles as number[])];

  const roomWidth = 1 + roomInfo.stationCount * 3;
  const startCol = roomInfo.startCol;

  for (let row = 0; row < rows; row++) {
    for (let col = startCol; col < startCol + roomWidth && col < cols; col++) {
      const idx = row * cols + col;
      if (idx >= 0 && idx < tiles.length) {
        tiles[idx] = VOID;
      }
    }
  }

  const newTileColors = layout.tileColors
    ? [...(layout.tileColors as Array<unknown | null>)]
    : undefined;
  if (newTileColors) {
    for (let row = 0; row < rows; row++) {
      for (let col = startCol; col < startCol + roomWidth && col < cols; col++) {
        const idx = row * cols + col;
        if (idx >= 0 && idx < newTileColors.length) {
          newTileColors[idx] = null;
        }
      }
    }
  }

  return {
    ...layout,
    tiles,
    furniture,
    ...(newTileColors ? { tileColors: newTileColors } : {}),
  };
}
