// Where the coach bubble goes (tutorial/layout.ts): beside its anchor and never over it, inside the
// viewport, below the HUD, and docked to the far edge on a phone.

import { describe, expect, it } from "vitest";

import { placeBubble, overlapArea, padRect, unionRect, type PlaceInput, type Rect } from "./layout.ts";

const VIEWPORT = { width: 1280, height: 720 };
const PHONE = { width: 390, height: 844 };
const BUBBLE = { width: 340, height: 150 };

function input(over: Partial<PlaceInput>): PlaceInput {
  return {
    anchor: null,
    bubble: BUBBLE,
    viewport: VIEWPORT,
    docked: false,
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
    width: place.width ?? size.width,
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

  it("docks full width on a phone, on the side of the anchor with more room, never over it", () => {
    const hand: Rect = { left: 6, top: 700, width: 378, height: 138 };
    const top = placeBubble(input({ docked: true, viewport: PHONE, anchor: hand }));
    expect(top.side).toBe("dock-top");
    expect(top.left).toBe(8);
    expect(top.width).toBe(390 - 16);
    expect(top.top).toBe(60 + 8);
    expect(overlapArea(bubbleRect(top), hand)).toBe(0);

    const enemy: Rect = { left: 6, top: 64, width: 250, height: 70 };
    const bottom = placeBubble(input({ docked: true, viewport: PHONE, anchor: enemy }));
    expect(bottom.side).toBe("dock-bottom");
    expect(bottom.top + BUBBLE.height).toBe(844 - 8);
    expect(overlapArea(bubbleRect(bottom), enemy)).toBe(0);

    // Squeezed: the bubble takes the room there is, and scrolls inside it.
    const big: Rect = { left: 0, top: 130, width: 390, height: 600 };
    const squeezed = placeBubble(input({ docked: true, viewport: PHONE, anchor: big }));
    expect(squeezed.maxHeight).toBe(Math.max(96, 844 - 8 - (130 + 600 + 12)));
    expect(overlapArea(bubbleRect(squeezed), big)).toBe(0);
  });

  it("on a wide screen with no room round the anchor, it docks at its own width and still clears it", () => {
    const short = { width: 1280, height: 580 };
    const prompt: Rect = { left: 200, top: 130, width: 880, height: 330 };
    const place = placeBubble(input({ viewport: short, anchor: prompt, bubble: { width: 340, height: 120 } }));
    expect(place.side).toBe("dock-bottom");
    expect(place.width).toBeNull();
    expect(place.left).toBe(640 - 170);
    expect(overlapArea(bubbleRect(place, { width: 340, height: 120 }), prompt)).toBe(0);
  });

  it("docks to the top, under the HUD, with nothing to point at on a phone", () => {
    const place = placeBubble(input({ docked: true, viewport: PHONE }));
    expect(place.side).toBe("dock-top");
    expect(place.top).toBe(68);
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
