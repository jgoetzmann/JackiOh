// Polish 6, slice C: where the hover preview goes (docs/polish/6-cards.md, B27).
//
// `placePreview(anchor, viewport, size)` picks the first side the preview fits on, in the order
// right, left, above, below, and clamps `left` and `top` so the box stays PREVIEW_MARGIN_PX inside
// the viewport. The spec fixes that order and the clamp. It does not fix the exact offset from the
// anchor on the chosen side, or the vertical alignment beside it, so every case here is chosen with
// room to spare either way, and the geometry asserted is only what a side means: a preview on the
// right starts at or after the anchor's right edge, one above ends at or before its top, and so on.

import { describe, expect, it } from "vitest";

import { PREVIEW_MARGIN_PX } from "./constants.ts";
import { placePreview, type Rect } from "./index.ts";

type Size = { width: number; height: number };
type Side = "right" | "left" | "above" | "below";

const DESKTOP: Size = { width: 1280, height: 720 };
const PHONE: Size = { width: 390, height: 844 };

/** Roughly the hover card: PREVIEW_HEIGHT_PX tall at 5:7. */
const PREVIEW: Size = { width: 272, height: 380 };
const SMALL: Size = { width: 200, height: 200 };

function rightOf(anchor: Rect): number {
  return anchor.left + anchor.width;
}

function bottomOf(anchor: Rect): number {
  return anchor.top + anchor.height;
}

/** The clamp: the whole box stays PREVIEW_MARGIN_PX inside the viewport. */
function expectInside(placed: { left: number; top: number }, size: Size, viewport: Size): void {
  expect(placed.left, "left edge").toBeGreaterThanOrEqual(PREVIEW_MARGIN_PX);
  expect(placed.top, "top edge").toBeGreaterThanOrEqual(PREVIEW_MARGIN_PX);
  expect(placed.left + size.width, "right edge").toBeLessThanOrEqual(viewport.width - PREVIEW_MARGIN_PX);
  expect(placed.top + size.height, "bottom edge").toBeLessThanOrEqual(viewport.height - PREVIEW_MARGIN_PX);
}

/** What the chosen side means geometrically: the preview does not cover the anchor from that side. */
function expectOnSide(placed: { left: number; top: number }, side: Side, anchor: Rect, size: Size): void {
  if (side === "right") expect(placed.left).toBeGreaterThanOrEqual(rightOf(anchor));
  if (side === "left") expect(placed.left + size.width).toBeLessThanOrEqual(anchor.left);
  if (side === "above") expect(placed.top + size.height).toBeLessThanOrEqual(anchor.top);
  if (side === "below") expect(placed.top).toBeGreaterThanOrEqual(bottomOf(anchor));
}

type Case = {
  name: string;
  anchor: Rect;
  viewport: Size;
  size: Size;
  side: Side;
};

const CASES: Case[] = [
  {
    name: "B27 goes right when there is room on the right",
    anchor: { left: 100, top: 200, width: 100, height: 140 },
    viewport: DESKTOP,
    size: PREVIEW,
    side: "right",
  },
  {
    name: "B27 prefers right over left when both have room",
    anchor: { left: 600, top: 200, width: 100, height: 140 },
    viewport: DESKTOP,
    size: PREVIEW,
    side: "right",
  },
  {
    name: "B27 falls back to left when the right edge is too close, even though above also fits",
    anchor: { left: 1150, top: 500, width: 100, height: 140 },
    viewport: DESKTOP,
    size: PREVIEW,
    side: "left",
  },
  {
    name: "B27 falls back to above when neither side has room, even though below also fits",
    anchor: { left: 20, top: 300, width: 350, height: 100 },
    viewport: PHONE,
    size: SMALL,
    side: "above",
  },
  {
    name: "B27 falls back to below when neither side nor above has room",
    anchor: { left: 20, top: 40, width: 350, height: 100 },
    viewport: PHONE,
    size: SMALL,
    side: "below",
  },
];

describe("placePreview: the side (B27)", () => {
  for (const c of CASES) {
    it(c.name, () => {
      const placed = placePreview(c.anchor, c.viewport, c.size);
      expect(placed.side).toBe(c.side);
      expectOnSide(placed, c.side, c.anchor, c.size);
      expectInside(placed, c.size, c.viewport);
    });
  }

  it("B27 still answers below when the preview fits nowhere", () => {
    // An anchor as big as the phone: no side, and neither above nor below, has any room at all.
    const anchor: Rect = { left: 0, top: 0, width: PHONE.width, height: PHONE.height };
    expect(placePreview(anchor, PHONE, SMALL).side).toBe("below");
  });

  it("B27 returns finite numbers for left and top", () => {
    const placed = placePreview({ left: 1150, top: 500, width: 100, height: 140 }, DESKTOP, PREVIEW);
    expect(Number.isFinite(placed.left)).toBe(true);
    expect(Number.isFinite(placed.top)).toBe(true);
  });
});

describe("placePreview: the clamp (B27)", () => {
  it("B27 clamps top so a right-hand preview beside a card at the bottom stays inside", () => {
    const anchor: Rect = { left: 100, top: 650, width: 100, height: 60 };
    const placed = placePreview(anchor, DESKTOP, PREVIEW);
    expect(placed.side).toBe("right");
    expectOnSide(placed, "right", anchor, PREVIEW);
    expectInside(placed, PREVIEW, DESKTOP);
  });

  it("B27 clamps top so a right-hand preview beside a card at the very top stays inside", () => {
    const anchor: Rect = { left: 100, top: 0, width: 100, height: 60 };
    const placed = placePreview(anchor, DESKTOP, PREVIEW);
    expect(placed.side).toBe("right");
    expect(placed.top).toBeGreaterThanOrEqual(PREVIEW_MARGIN_PX);
    expectInside(placed, PREVIEW, DESKTOP);
  });

  it("B27 clamps left so a preview above a card hugging the right edge stays inside", () => {
    const anchor: Rect = { left: 180, top: 500, width: 205, height: 110 };
    const placed = placePreview(anchor, PHONE, SMALL);
    expect(placed.side).toBe("above");
    expectOnSide(placed, "above", anchor, SMALL);
    expectInside(placed, SMALL, PHONE);
  });

  it("B27 clamps left so a preview above a card hugging the left edge stays inside", () => {
    const size: Size = { width: 250, height: 200 };
    const anchor: Rect = { left: 0, top: 500, width: 150, height: 110 };
    const placed = placePreview(anchor, PHONE, size);
    expect(placed.side).toBe("above");
    expectOnSide(placed, "above", anchor, size);
    expectInside(placed, size, PHONE);
  });

  it("B27 clamps left so a preview below a card at the top-right corner stays inside", () => {
    const anchor: Rect = { left: 190, top: 10, width: 195, height: 100 };
    const placed = placePreview(anchor, PHONE, SMALL);
    expect(placed.side).toBe("below");
    expectOnSide(placed, "below", anchor, SMALL);
    expectInside(placed, SMALL, PHONE);
  });

  it("B27 keeps a left-hand preview inside when its card sits low on the screen", () => {
    const anchor: Rect = { left: 1150, top: 600, width: 100, height: 110 };
    const placed = placePreview(anchor, DESKTOP, PREVIEW);
    expect(placed.side).toBe("left");
    expectOnSide(placed, "left", anchor, PREVIEW);
    expectInside(placed, PREVIEW, DESKTOP);
  });
});

// A card in a row (the hand, the resolving strip) asks for "above" first: beside it the preview
// would cover the next card along, which is where the pointer is going.
describe("placePreview: a card in a row prefers above", () => {
  it("rises over a hand card at the bottom of a desktop screen instead of covering its neighbour", () => {
    const anchor: Rect = { left: 92, top: 477, width: 55, height: 76 };
    const placed = placePreview(anchor, DESKTOP, PREVIEW, "above");
    expect(placed.side).toBe("above");
    expectOnSide(placed, "above", anchor, PREVIEW);
    expectInside(placed, PREVIEW, DESKTOP);
  });

  it("falls back to B27's order, right first, when there is no room above", () => {
    const anchor: Rect = { left: 100, top: 40, width: 55, height: 76 };
    const placed = placePreview(anchor, DESKTOP, PREVIEW, "above");
    expect(placed.side).toBe("right");
    expectOnSide(placed, "right", anchor, PREVIEW);
    expectInside(placed, PREVIEW, DESKTOP);
  });

  it("keeps B27's order when nothing is asked for", () => {
    const anchor: Rect = { left: 92, top: 477, width: 55, height: 76 };
    expect(placePreview(anchor, DESKTOP, PREVIEW).side).toBe("right");
    expect(placePreview(anchor, DESKTOP, PREVIEW, "beside").side).toBe("right");
  });
});
