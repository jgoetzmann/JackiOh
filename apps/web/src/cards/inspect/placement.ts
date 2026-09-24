// Where the hover preview goes (B27). Pure: the caller measures the anchor and the viewport.

import { PREVIEW_GAP_PX, PREVIEW_MARGIN_PX } from "./constants.ts";

export type Rect = { left: number; top: number; width: number; height: number };
type PreviewSide = "right" | "left" | "above" | "below";

/**
 * Which side the preview tries first. "beside" is B27's order (right, left, above, below), for a
 * card with neighbours all round, such as a minion on the board or a tile in the deck list.
 * "above" tries above first, then the same order: a card in a row (the hand, the resolving strip)
 * has its neighbours left and right, and a preview beside it would cover the next card the pointer
 * is on its way to, so it rises over the card instead, as Hearthstone lifts a hand card.
 */
export type PreviewPrefer = "beside" | "above";

const ORDER: Readonly<Record<PreviewPrefer, readonly PreviewSide[]>> = {
  beside: ["right", "left", "above", "below"],
  above: ["above", "right", "left", "below"],
};

/** Keeps `start .. start + size` at least PREVIEW_MARGIN_PX inside `0 .. extent`, top/left first. */
function clamp(start: number, size: number, extent: number): number {
  const max = extent - size - PREVIEW_MARGIN_PX;
  return Math.max(PREVIEW_MARGIN_PX, Math.min(start, max));
}

/**
 * The first side of the anchor the preview fits on, in the order `prefer` names (B27's right,
 * left, above, below by default), and the preview's top-left corner there. Beside the anchor the
 * preview is centred on it vertically, above or below it is centred horizontally, and the cross
 * axis is clamped into the viewport. When no side fits, it goes below, clamped.
 */
export function placePreview(
  anchor: Rect,
  viewport: { width: number; height: number },
  size: { width: number; height: number },
  prefer: PreviewPrefer = "beside",
): { left: number; top: number; side: PreviewSide } {
  const centredTop = clamp(anchor.top + anchor.height / 2 - size.height / 2, size.height, viewport.height);
  const centredLeft = clamp(anchor.left + anchor.width / 2 - size.width / 2, size.width, viewport.width);

  const right = anchor.left + anchor.width + PREVIEW_GAP_PX;
  const left = anchor.left - PREVIEW_GAP_PX - size.width;
  const above = anchor.top - PREVIEW_GAP_PX - size.height;
  const below = anchor.top + anchor.height + PREVIEW_GAP_PX;

  for (const side of ORDER[prefer]) {
    if (side === "right" && right + size.width <= viewport.width - PREVIEW_MARGIN_PX) {
      return { left: right, top: centredTop, side };
    }
    if (side === "left" && left >= PREVIEW_MARGIN_PX) {
      return { left, top: centredTop, side };
    }
    if (side === "above" && above >= PREVIEW_MARGIN_PX) {
      return { left: centredLeft, top: above, side };
    }
    if (side === "below" && below + size.height <= viewport.height - PREVIEW_MARGIN_PX) {
      return { left: centredLeft, top: below, side };
    }
  }

  return { left: centredLeft, top: clamp(below, size.height, viewport.height), side: "below" };
}
