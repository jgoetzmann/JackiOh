// Where the floating coach bubble goes, as geometry alone (Coach.tsx measures, this decides).
//
// The one hard rule: the bubble never covers the thing it points at. A step that says "play this
// card" and then sits on the card, or "end your turn" over End turn, would be worse than no coach.
//
//  - Beside the anchor, `gap` away, on the first side it fits whole — above or below first
//    (whichever has the anchor's far side of the screen), then right or left — slid along that
//    side to stay `margin` inside the viewport. A side that also covers an obstacle loses to one
//    that does not. There are two kinds: `keepClear` (the zones and targets a play in progress
//    asks for, which the player is about to tap or drop on) and `avoid`, the soft ones (an open
//    prompt the step is not about, your hand, a unit row). When every side covers one, the side
//    covering the least of `keepClear` wins, then the least of the soft ones: a bubble on your
//    hand beats one on the zone you are asked to drop a card in.
//  - If no side fits (a big anchor on a short screen), it docks at its own width, centred on the
//    anchor, against the top or bottom edge, whichever side of the anchor has more room, and never
//    taller than that room (its text scrolls) unless the room is under `minHeight`: an anchor that
//    leaves less than that on both sides is the one case the bubble may overlap it, by as little
//    as it can, rather than shrink past reading.
//  - No anchor: an info step floats in the middle of the screen (beside an open prompt that sits
//    there), and the slim "waiting" bubble sits in the bottom-right corner.
//
// Nothing is ever placed above `insetTop`, the HUD's lower edge, so Skip step and Exit tutorial
// stay reachable whatever the coach shows.
//
// This is desktops and tablets only. On the board's phone layouts the coach does not float at all:
// it is a panel in the page between the HUD and the board (Coach.tsx, tutorial.css), because a
// phone's board has no room beside anything and a bubble docked to an edge covered the hand and
// End turn.

export type Rect = { left: number; top: number; width: number; height: number };
export type Size = { width: number; height: number };

export type BubbleSide = "below" | "above" | "right" | "left" | "center" | "corner" | "dock-top" | "dock-bottom";

export type BubblePlacement = {
  side: BubbleSide;
  left: number;
  top: number;
  /** The most height it may take without reaching its anchor; null for no limit. */
  maxHeight: number | null;
};

export type PlaceInput = {
  /** The union of the anchor's elements, ring padding included; null when nothing is on screen. */
  anchor: Rect | null;
  bubble: Size;
  viewport: Size;
  /** The slim "waiting" bubble. */
  slim: boolean;
  /** Nothing goes above this (the HUD's lower edge). */
  insetTop: number;
  /** Prefer a side that does not cover these. */
  avoid?: readonly Rect[];
  /**
   * Prefer a side that does not cover these even over one that covers `avoid`: what a play in
   * progress asks the player to tap or drop on.
   */
  keepClear?: readonly Rect[];
  gap: number;
  margin: number;
  minHeight: number;
};

function clamp(value: number, low: number, high: number): number {
  return high < low ? low : Math.min(Math.max(value, low), high);
}

export function overlapArea(a: Rect, b: Rect): number {
  const width = Math.min(a.left + a.width, b.left + b.width) - Math.max(a.left, b.left);
  const height = Math.min(a.top + a.height, b.top + b.height) - Math.max(a.top, b.top);
  return width > 0 && height > 0 ? width * height : 0;
}

/** The smallest rectangle round all of `rects`; null for none. */
export function unionRect(rects: readonly Rect[]): Rect | null {
  if (rects.length === 0) return null;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const rect of rects) {
    left = Math.min(left, rect.left);
    top = Math.min(top, rect.top);
    right = Math.max(right, rect.left + rect.width);
    bottom = Math.max(bottom, rect.top + rect.height);
  }
  return { left, top, width: right - left, height: bottom - top };
}

export function padRect(rect: Rect, pad: number): Rect {
  return { left: rect.left - pad, top: rect.top - pad, width: rect.width + 2 * pad, height: rect.height + 2 * pad };
}

/**
 * Against the top or bottom edge, whichever side of the anchor has more room, at the bubble's own
 * width, centred on the anchor.
 */
function dock(input: PlaceInput, anchor: Rect): BubblePlacement {
  const { viewport, bubble, margin, gap, minHeight } = input;
  const topEdge = input.insetTop + margin;
  const bottomEdge = viewport.height - margin;
  const centreX = anchor.left + anchor.width / 2;
  const left = clamp(centreX - bubble.width / 2, margin, viewport.width - margin - bubble.width);

  const roomAbove = anchor.top - gap - topEdge;
  const roomBelow = bottomEdge - (anchor.top + anchor.height + gap);
  if (roomAbove >= roomBelow) {
    return { side: "dock-top", left, top: topEdge, maxHeight: Math.max(minHeight, roomAbove) };
  }
  const maxHeight = Math.max(minHeight, roomBelow);
  const height = Math.min(bubble.height, maxHeight);
  return { side: "dock-bottom", left, top: bottomEdge - height, maxHeight };
}

type Candidate = { side: BubbleSide; left: number; top: number; fits: boolean };

function candidates(input: PlaceInput, anchor: Rect): Candidate[] {
  const { viewport, bubble, gap, margin } = input;
  const topEdge = input.insetTop + margin;
  const bottomEdge = viewport.height - margin;
  const right = anchor.left + anchor.width;
  const bottom = anchor.top + anchor.height;
  const centreX = anchor.left + anchor.width / 2;
  const centreY = anchor.top + anchor.height / 2;
  const alongX = clamp(centreX - bubble.width / 2, margin, viewport.width - margin - bubble.width);
  const alongY = clamp(centreY - bubble.height / 2, topEdge, bottomEdge - bubble.height);

  const below: Candidate = { side: "below", left: alongX, top: bottom + gap, fits: bottom + gap + bubble.height <= bottomEdge };
  const above: Candidate = {
    side: "above",
    left: alongX,
    top: anchor.top - gap - bubble.height,
    fits: anchor.top - gap - bubble.height >= topEdge,
  };
  const toRight: Candidate = {
    side: "right",
    left: right + gap,
    top: alongY,
    fits: right + gap + bubble.width <= viewport.width - margin && bubble.height <= bottomEdge - topEdge,
  };
  const toLeft: Candidate = {
    side: "left",
    left: anchor.left - gap - bubble.width,
    top: alongY,
    fits: anchor.left - gap - bubble.width >= margin && bubble.height <= bottomEdge - topEdge,
  };

  // Towards the roomier half of the screen first, and the side with more room before the other.
  const vertical = centreY > (topEdge + bottomEdge) / 2 ? [above, below] : [below, above];
  const horizontal = viewport.width - right >= anchor.left ? [toRight, toLeft] : [toLeft, toRight];
  return [...vertical, ...horizontal];
}

export function placeBubble(input: PlaceInput): BubblePlacement {
  const { anchor, bubble, viewport, margin } = input;

  if (anchor === null) {
    if (input.slim) {
      return {
        side: "corner",
        left: Math.max(margin, viewport.width - margin - bubble.width),
        top: Math.max(input.insetTop + margin, viewport.height - margin - bubble.height),
        maxHeight: null,
      };
    }
    const centre: BubblePlacement = {
      side: "center",
      left: Math.max(margin, (viewport.width - bubble.width) / 2),
      top: Math.max(input.insetTop + margin, (viewport.height - bubble.height) / 2),
      maxHeight: null,
    };
    // The middle of the screen is where a prompt opens (the mulligan, a Discover): step beside it.
    const blocked = [...(input.keepClear ?? []), ...(input.avoid ?? [])].find(
      (rect) => overlapArea({ left: centre.left, top: centre.top, ...bubble }, rect) > 0,
    );
    return blocked === undefined ? centre : placeBubble({ ...input, anchor: blocked, avoid: [], keepClear: [] });
  }

  const fitting = candidates(input, anchor).filter((candidate) => candidate.fits);
  if (fitting.length === 0) return dock(input, anchor);
  const covers = (candidate: Candidate, rects: readonly Rect[]): number =>
    rects.reduce(
      (sum, rect) => sum + overlapArea({ left: candidate.left, top: candidate.top, ...bubble }, rect),
      0,
    );
  // The first side that covers no obstacle; when every side covers one, the side that covers the
  // least of `keepClear`, then the least of the soft ones (a bubble below the enemy hero sat on the
  // enemy's whole front row, where one beside it clips only the row's top edge: e2e spec 22).
  let best: Candidate | undefined;
  let leastClear = Infinity;
  let leastSoft = Infinity;
  for (const candidate of fitting) {
    const clear = covers(candidate, input.keepClear ?? []);
    const soft = covers(candidate, input.avoid ?? []);
    if (clear < leastClear || (clear === leastClear && soft < leastSoft)) {
      best = candidate;
      leastClear = clear;
      leastSoft = soft;
    }
    if (clear === 0 && soft === 0) break;
  }
  if (best === undefined) return dock(input, anchor);
  return { side: best.side, left: best.left, top: best.top, maxHeight: null };
}
