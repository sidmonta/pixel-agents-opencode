/**
 * Server-side layout builder.
 *
 * Clones `layout-base.json` for each extra session and places each clone in a
 * simple left-to-right, top-to-bottom grid.
 */

export interface SessionRoomInfo {
  sessionId: string;
  baseCols: number;
  baseRows: number;
  colOffset: number;
  rowOffset: number;
  furnitureUids: string[];
}

interface PlacedFurniture {
  uid?: string;
  col?: number;
  row?: number;
  [key: string]: unknown;
}

interface LayoutShape {
  cols: number;
  rows: number;
  tiles: number[];
  furniture?: PlacedFurniture[];
  tileColors?: Array<unknown | null>;
  [key: string]: unknown;
}

const VOID_TILE = 255;

function asLayout(layout: Record<string, unknown>): LayoutShape {
  return layout as LayoutShape;
}

function getCloneOffset(baseLayout: LayoutShape, existingRoomCount: number) {
  const cloneNumber = existingRoomCount + 1;
  const gridWidth = Math.max(1, Math.ceil(Math.sqrt(cloneNumber + 1)));
  const slotIndex = cloneNumber;
  const slotCol = slotIndex % gridWidth;
  const slotRow = Math.floor(slotIndex / gridWidth);
  return {
    colOffset: slotCol * baseLayout.cols,
    rowOffset: slotRow * baseLayout.rows,
  };
}

function expandLayout(layout: LayoutShape, cols: number, rows: number): LayoutShape {
  if (layout.cols >= cols && layout.rows >= rows) {
    return {
      ...layout,
      tiles: [...layout.tiles],
      furniture: [...(layout.furniture ?? [])],
      ...(layout.tileColors ? { tileColors: [...layout.tileColors] } : {}),
    };
  }

  const nextCols = Math.max(layout.cols, cols);
  const nextRows = Math.max(layout.rows, rows);
  const nextTiles = new Array<number>(nextCols * nextRows).fill(VOID_TILE);
  const nextTileColors = layout.tileColors
    ? new Array<unknown | null>(nextCols * nextRows).fill(null)
    : undefined;

  for (let row = 0; row < layout.rows; row++) {
    for (let col = 0; col < layout.cols; col++) {
      const prevIndex = row * layout.cols + col;
      const nextIndex = row * nextCols + col;
      nextTiles[nextIndex] = layout.tiles[prevIndex] ?? VOID_TILE;
      if (nextTileColors) {
        nextTileColors[nextIndex] = layout.tileColors?.[prevIndex] ?? null;
      }
    }
  }

  return {
    ...layout,
    cols: nextCols,
    rows: nextRows,
    tiles: nextTiles,
    furniture: [...(layout.furniture ?? [])],
    ...(nextTileColors ? { tileColors: nextTileColors } : {}),
  };
}

export function addSessionRoom(
  layout: Record<string, unknown>,
  sessionId: string,
  baseLayoutRecord: Record<string, unknown>,
  existingRoomCount: number,
): { layout: Record<string, unknown>; roomInfo: SessionRoomInfo } {
  const current = asLayout(layout);
  const base = asLayout(baseLayoutRecord);
  const { colOffset, rowOffset } = getCloneOffset(base, existingRoomCount);
  const expanded = expandLayout(current, colOffset + base.cols, rowOffset + base.rows);

  for (let row = 0; row < base.rows; row++) {
    for (let col = 0; col < base.cols; col++) {
      const sourceIndex = row * base.cols + col;
      const targetIndex = (row + rowOffset) * expanded.cols + (col + colOffset);
      expanded.tiles[targetIndex] = base.tiles[sourceIndex] ?? VOID_TILE;
      if (expanded.tileColors) {
        expanded.tileColors[targetIndex] = base.tileColors?.[sourceIndex] ?? null;
      }
    }
  }

  const furnitureUids: string[] = [];
  for (const item of base.furniture ?? []) {
    const clonedUid = typeof item.uid === 'string' ? `session-${sessionId}-${item.uid}` : undefined;
    if (clonedUid) {
      furnitureUids.push(clonedUid);
    }
    expanded.furniture ??= [];
    expanded.furniture.push({
      ...item,
      ...(clonedUid ? { uid: clonedUid } : {}),
      ...(typeof item.col === 'number' ? { col: item.col + colOffset } : {}),
      ...(typeof item.row === 'number' ? { row: item.row + rowOffset } : {}),
    });
  }

  return {
    layout: expanded,
    roomInfo: {
      sessionId,
      baseCols: base.cols,
      baseRows: base.rows,
      colOffset,
      rowOffset,
      furnitureUids,
    },
  };
}

export function removeSessionRoom(
  layout: Record<string, unknown>,
  roomInfo: SessionRoomInfo,
): Record<string, unknown> {
  const current = asLayout(layout);
  const furnitureUids = new Set(roomInfo.furnitureUids);
  const tiles = [...current.tiles];
  const tileColors = current.tileColors ? [...current.tileColors] : undefined;

  for (let row = roomInfo.rowOffset; row < roomInfo.rowOffset + roomInfo.baseRows; row++) {
    for (let col = roomInfo.colOffset; col < roomInfo.colOffset + roomInfo.baseCols; col++) {
      if (row >= current.rows || col >= current.cols) {
        continue;
      }
      const index = row * current.cols + col;
      tiles[index] = VOID_TILE;
      if (tileColors) {
        tileColors[index] = null;
      }
    }
  }

  return {
    ...current,
    tiles,
    furniture: (current.furniture ?? []).filter((item) => !furnitureUids.has(item.uid ?? '')),
    ...(tileColors ? { tileColors } : {}),
  };
}
