// Where the floating coach bubble goes (tutorial/layout.ts): beside its anchor and never over it,
// inside the viewport and below the HUD. On a phone the coach does not float (it is a panel in the
// page, Coach.test.tsx), so nothing here places a bubble on a phone's screen.

import { describe, expect, it } from "vitest";

import { placeBubble, overlapArea, padRect, unionRect, type PlaceInput, type Rect } from "./layout.ts";

const VIEWPORT = { width: 1280, height: 720 };
const BUBBLE = { width: 340, height: 150 };

function input(over: Partial<PlaceInput>): PlaceInput {
  return {
    anchor: null,
    bubble: BUBBLE,
    viewport: VIEWPORT,
    slim: false,
    insetTop: 60,
    gap: 12,
    margin: 8,
    minHeight: 96,
    ...over,
  };
}

function bubbleRect(place: ReturnType<typeof placeBubble>, size = BUBBLE): Rect {
  return {
    left: place.left,
    top: place.top,
    width: size.width,
    height: place.maxHeight === null ? size.height : Math.min(size.height, place.maxHeight),
  };
}

function inside(rect: Rect, viewport: { width: number; height: number }, margin: number, insetTop: number): boolean {
  return (
    rect.left >= margin &&
    rect.top >= insetTop + margin &&
    rect.left + rect.width <= viewport.width - margin &&
    rect.top + rect.height <= viewport.height - margin
  );
}

describe("the coach bubble's placement", () => {
  it("never covers an anchor anywhere on a desktop screen, and stays inside the viewport under the HUD", () => {
    const anchors: Rect[] = [];
    for (let left = 0; left <= 1200; left += 150) {
      for (let top = 70; top <= 640; top += 95) anchors.push({ left, top, width: 80, height: 70 });
    }
    // The whole hand along the bottom, End turn in the sidebar, a prompt in the middle.
    anchors.push({ left: 200, top: 590, width: 700, height: 125 });
    anchors.push({ left: 1030, top: 330, width: 240, height: 60 });
    anchors.push({ left: 360, top: 200, width: 560, height: 320 });
    for (const anchor of anchors) {
      const place = placeBubble(input({ anchor }));
      const rect = bubbleRect(place);
      expect(overlapArea(rect, anchor), JSON.stringify({ anchor, place })).toBe(0);
      expect(inside(rect, VIEWPORT, 8, 60), JSON.stringify({ anchor, place })).toBe(true);
    }
  });

  it("goes above an anchor low on the screen (your hand) and below one high up (the enemy hero)", () => {
    expect(placeBubble(input({ anchor: { left: 400, top: 600, width: 400, height: 110 } })).side).toBe("above");
    expect(placeBubble(input({ anchor: { left: 400, top: 80, width: 120, height: 80 } })).side).toBe("below");
  });

  it("goes beside an anchor that leaves no room above or below", () => {
    const tall: Rect = { left: 100, top: 70, width: 300, height: 640 };
    const place = placeBubble(input({ anchor: tall }));
    expect(place.side).toBe("right");
    expect(overlapArea(bubbleRect(place), tall)).toBe(0);
  });

  it("prefers a side that keeps an open prompt clear", () => {
    const anchor: Rect = { left: 560, top: 300, width: 160, height: 60 };
    const prompt: Rect = { left: 300, top: 380, width: 680, height: 330 };
    const place = placeBubble(input({ anchor, avoid: [prompt] }));
    expect(overlapArea(bubbleRect(place), prompt)).toBe(0);
    expect(overlapArea(bubbleRect(place), anchor)).toBe(0);
  });

  it("when every side covers a soft obstacle, takes the side that covers the least of it", () => {
    // The enemy hero at the top, its front row of units just below: under the hero the bubble would
    // sit on the row, beside it it only clips the row's top edge.
    const hero: Rect = { left: 580, top: 80, width: 120, height: 50 };
    const row: Rect = { left: 100, top: 200, width: 900, height: 100 };
    const place = placeBubble(input({ anchor: hero, avoid: [row] }));
    expect(place.side).toBe("right");
    const below = { left: 470, top: 142, width: BUBBLE.width, height: BUBBLE.height };
    expect(overlapArea(bubbleRect(place), row)).toBeLessThan(overlapArea(below, row));
    expect(overlapArea(bubbleRect(place), hero)).toBe(0);
  });

  it("keeps clear of what a play in progress asks for before anything soft: over your hand rather than the lane to drop in", () => {
    // Lesson 1's "Play a unit" on a desktop: the card picked up from the hand, your five unit
    // lanes glowing above it, the rest of the hand beside it.
    const card: Rect = { left: 339, top: 580, width: 92, height: 124 };
    const hand: Rect = { left: 20, top: 580, width: 976, height: 130 };
    const lanes: Rect[] = [0, 1, 2, 3, 4].map((index) => ({ left: 24 + 194 * index, top: 330, width: 190, height: 90 }));
    const soft = placeBubble(input({ anchor: card, avoid: [hand, ...lanes] }));
    // With the lanes only soft, the side covering the least wins: above the card, on lanes 1-2.
    expect(soft.side).toBe("above");
    expect(lanes.some((lane) => overlapArea(bubbleRect(soft), lane) > 0)).toBe(true);

    const clear = placeBubble(input({ anchor: card, avoid: [hand], keepClear: lanes }));
    for (const lane of lanes) expect(overlapArea(bubbleRect(clear), lane), JSON.stringify(clear)).toBe(0);
    expect(overlapArea(bubbleRect(clear), card)).toBe(0);
    expect(inside(bubbleRect(clear), VIEWPORT, 8, 60)).toBe(true);
  });

  it("with no side clear of what a play asks for, covers the least of it", () => {
    const anchor: Rect = { left: 560, top: 300, width: 160, height: 60 };
    // Everything round the anchor is asked for, the left side least.
    const around: Rect[] = [
      { left: 0, top: 60, width: 1280, height: 230 },
      { left: 0, top: 370, width: 1280, height: 350 },
      { left: 730, top: 290, width: 550, height: 80 },
      { left: 400, top: 290, width: 150, height: 20 },
    ];
    const place = placeBubble(input({ anchor, bubble: { width: 340, height: 60 }, keepClear: around, avoid: [] }));
    expect(place.side).toBe("left");
  });

  it("with no anchor, an info step floats in the middle and the waiting bubble in the corner", () => {
    const centre = placeBubble(input({}));
    expect(centre.side).toBe("center");
    expect(centre.left).toBe((1280 - 340) / 2);
    const slim = { width: 260, height: 44 };
    const corner = placeBubble(input({ slim: true, bubble: slim }));
    expect(corner.side).toBe("corner");
    expect(corner.left + slim.width).toBe(1280 - 8);
    expect(corner.top + slim.height).toBe(720 - 8);
  });

  it("with no anchor and a prompt open in the middle, an info step steps beside the prompt", () => {
    const prompt: Rect = { left: 400, top: 158, width: 480, height: 318 };
    const place = placeBubble(input({ avoid: [prompt] }));
    expect(place.side).not.toBe("center");
    expect(overlapArea(bubbleRect(place), prompt)).toBe(0);
    expect(inside(bubbleRect(place), VIEWPORT, 8, 60)).toBe(true);
  });

  it("with no room round the anchor, it docks at its own width, centred on it, on the side with more room", () => {
    const short = { width: 1280, height: 580 };
    const bubble = { width: 340, height: 120 };
    // More room below the prompt than above it: against the bottom edge, as tall as the room.
    const prompt: Rect = { left: 200, top: 130, width: 880, height: 330 };
    const low = placeBubble(input({ viewport: short, anchor: prompt, bubble }));
    expect(low.side).toBe("dock-bottom");
    expect(low.left).toBe(640 - 170);
    expect(low.maxHeight).toBe(580 - 8 - (130 + 330 + 12));
    expect(low.top + (low.maxHeight ?? 0)).toBe(580 - 8);
    expect(overlapArea(bubbleRect(low, bubble), prompt)).toBe(0);

    // More room above it: under the HUD, never taller than the room (its text scrolls).
    const sunk: Rect = { left: 100, top: 180, width: 1080, height: 360 };
    const high = placeBubble(input({ viewport: short, anchor: sunk, bubble }));
    expect(high.side).toBe("dock-top");
    expect(high.left).toBe(640 - 170);
    expect(high.top).toBe(60 + 8);
    expect(high.maxHeight).toBe(Math.max(96, 180 - 12 - 68));
    expect(overlapArea(bubbleRect(high, bubble), sunk)).toBe(0);
  });

  it("unions and pads the anchor's rectangles", () => {
    expect(unionRect([])).toBeNull();
    expect(
      unionRect([
        { left: 10, top: 20, width: 30, height: 40 },
        { left: 100, top: 5, width: 10, height: 10 },
      ]),
    ).toEqual({ left: 10, top: 5, width: 100, height: 55 });
    expect(padRect({ left: 10, top: 10, width: 20, height: 20 }, 6)).toEqual({ left: 4, top: 4, width: 32, height: 32 });
  });
});
