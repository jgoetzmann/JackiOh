// The constructor's pure helpers (BUILD M9-T2). The limits are always the engine's constants or
// an explicit override, never a spelled 20 or 1 (CLAUDE.md rule 9).

import type { CardDef } from "@jackioh/shared";
import type { CatalogSnapshot } from "@jackioh/validator";
import { describe, expect, it } from "vitest";

import { DECK_SIZE, MAX_COPIES } from "../deckbuilder/deckSize.ts";
import { fixtureCardId, fixtureCatalog } from "../deckbuilder/fixtures.ts";
import {
  CARD_ASPECT,
  PAGE_CARD_WIDTH,
  PAGE_GAP,
  PREVIEW_MARGIN,
  addCard,
  barsOf,
  cardWidthFor,
  clampPage,
  costOrder,
  pageCount,
  pageOf,
  pageSizeFor,
  previewPlacement,
  removeCard,
  sameCards,
  sortByCost,
} from "./library.ts";

const limits = { deckSize: DECK_SIZE, maxCopies: MAX_COPIES };
const a = fixtureCardId(1);
const b = fixtureCardId(2);

describe("the draft's moves", () => {
  it("adds a card, and refuses one past maxCopies", () => {
    const one = addCard([], a, limits);
    expect(one).toEqual([a]);
    const copies = Array.from({ length: MAX_COPIES }, () => a);
    expect(addCard(copies, a, limits)).toBeNull();
    expect(addCard(copies, a, { ...limits, maxCopies: MAX_COPIES + 1 })).toEqual([...copies, a]);
  });

  it("refuses a card past deckSize", () => {
    const full = Array.from({ length: DECK_SIZE }, (_unused, index) => fixtureCardId(index + 1));
    expect(addCard(full, fixtureCardId(DECK_SIZE + 1), limits)).toBeNull();
    expect(addCard(full.slice(1), fixtureCardId(DECK_SIZE + 1), limits)).toHaveLength(DECK_SIZE);
  });

  it("removes one copy, and refuses a card that is not there", () => {
    expect(removeCard([a, b, a], a)).toEqual([a, b]);
    expect(removeCard([b], a)).toBeNull();
  });

  it("compares decks without regard to order", () => {
    expect(sameCards([a, b], [b, a])).toBe(true);
    expect(sameCards([a, b], [a])).toBe(false);
    expect(sameCards([a, a], [a, b])).toBe(false);
  });
});

describe("the collection order", () => {
  const base = fixtureCatalog().cards[a] as CardDef;
  const card = (id: string, name: string, cost: CardDef["cost"]): CardDef => ({ ...base, id, name, cost });
  const catalog: CatalogSnapshot = {
    version: "order",
    cards: {
      five: card("five", "Alpha", 5),
      x: card("x", "Zulu", "X"),
      pair: card("pair", "Bravo", { base: 2, embiggen: 4 }),
      twoB: card("twoB", "Charlie", 2),
      one: card("one", "Delta", 1),
    },
  };

  it("puts X at 0 and an embiggen pair at its base", () => {
    expect(costOrder("X")).toBe(0);
    expect(costOrder({ base: 2, embiggen: 4 })).toBe(2);
    expect(costOrder(3)).toBe(3);
  });

  it("sorts by cost, then by name", () => {
    expect(sortByCost(["five", "x", "pair", "twoB", "one"], catalog)).toEqual(["x", "one", "pair", "twoB", "five"]);
  });

  it("gives one bar per card with its count, in that order", () => {
    expect(barsOf(["five", "one", "five"], catalog)).toEqual([
      { cardId: "one", count: 1 },
      { cardId: "five", count: 2 },
    ]);
  });
});

describe("pages", () => {
  it("slices, counts and clamps", () => {
    const items = Array.from({ length: 10 }, (_unused, index) => index);
    expect(pageOf(items, 1, 4)).toEqual([4, 5, 6, 7]);
    expect(pageOf(items, 2, 4)).toEqual([8, 9]);
    expect(pageCount(10, 4)).toBe(3);
    expect(pageCount(0, 4)).toBe(1);
    expect(clampPage(5, 3)).toBe(2);
    expect(clampPage(-1, 3)).toBe(0);
  });

  it("fits whole cards, and never fewer than one", () => {
    const width = cardWidthFor(0);
    expect(width).toBe(PAGE_CARD_WIDTH.min);
    expect(cardWidthFor(100_000)).toBe(PAGE_CARD_WIDTH.max);
    const exact = pageSizeFor(3 * width + 2 * PAGE_GAP, 2 * (width / CARD_ASPECT) + PAGE_GAP, width);
    expect(exact).toEqual({ cols: 3, rows: 2 });
    expect(pageSizeFor(0, 0, width)).toEqual({ cols: 1, rows: 1 });
  });

  // The grid box library.css leaves at a given viewport, as measured in headless Chrome: 16px side
  // gutters and a 16px gap beside the pane at clamp(260px, 22vw, 340px); the book's 12px sides,
  // 1px border, two 44px arrows and 10px gaps; vertically 10px padding twice, a 26px header, an
  // 8px gap, and the book's 12px top and 24px bottom (the page indicator sits in it) plus border.
  function gridAt(viewportWidth: number, viewportHeight: number): { width: number; height: number } {
    const pane = Math.min(340, Math.max(260, viewportWidth * 0.22));
    const book = viewportWidth - 2 * 16 - 16 - pane;
    return { width: book - 2 * 13 - 2 * 44 - 2 * 10, height: viewportHeight - 2 * 10 - 26 - 8 - (12 + 24 + 2) };
  }

  it("lays out 5×3 at 1440×900 and 6×3 at 1920×1080", () => {
    const at1440 = gridAt(1440, 900);
    expect(pageSizeFor(at1440.width, at1440.height, cardWidthFor(1440))).toEqual({ cols: 5, rows: 3 });
    const at1920 = gridAt(1920, 1080);
    expect(pageSizeFor(at1920.width, at1920.height, cardWidthFor(1920))).toEqual({ cols: 6, rows: 3 });
    // A 1440×900 browser window leaves a ~790px viewport under its tabs: still three rows.
    const window1440 = gridAt(1440, 790);
    expect(pageSizeFor(window1440.width, window1440.height, cardWidthFor(1440))).toEqual({ cols: 5, rows: 3 });
    // A 1920×1080 window (~970px) drops to two rows of the larger cards, and never below one.
    const window1920 = gridAt(1920, 970);
    expect(pageSizeFor(window1920.width, window1920.height, cardWidthFor(1920))).toEqual({ cols: 6, rows: 2 });
  });
});

describe("the hover preview's placement", () => {
  const viewport = { width: 1440, height: 900 };

  it("sits left of the decklist, level with the bar", () => {
    const placed = previewPlacement({ bar: { top: 400, height: 34 }, listLeft: 1100, width: 240, viewport });
    expect(placed.left).toBe(1100 - 240 - PREVIEW_MARGIN);
    expect(placed.top + (240 / CARD_ASPECT) / 2).toBeCloseTo(417);
  });

  it("stays inside the viewport at the top, the bottom and the left", () => {
    const height = 240 / CARD_ASPECT;
    expect(previewPlacement({ bar: { top: 0, height: 34 }, listLeft: 1100, width: 240, viewport }).top).toBe(
      PREVIEW_MARGIN,
    );
    expect(previewPlacement({ bar: { top: 890, height: 34 }, listLeft: 1100, width: 240, viewport }).top).toBe(
      viewport.height - height - PREVIEW_MARGIN,
    );
    expect(previewPlacement({ bar: { top: 400, height: 34 }, listLeft: 20, width: 240, viewport }).left).toBe(
      PREVIEW_MARGIN,
    );
  });
});
