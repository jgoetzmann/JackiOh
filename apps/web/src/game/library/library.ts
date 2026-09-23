// The deck library constructor's pure half (BUILD M9-T2): the draft's two moves, the cost-then-name
// order the pages and the decklist share, and the page arithmetic.
//
// NO RULE LIVES HERE, for the reason `game/deckbuilder/loadout.ts` gives: the deck rules are
// `@jackioh/validator`'s (CLAUDE.md rule 7, SPEC §9.4). What `addCard` decides is a UX refusal — a
// card past `deckSize` or past `maxCopies` is simply not added, so the builder never creates the
// state L2/L3 forbid — and nothing is worded. A deck that arrives illegal from elsewhere (saved
// before a catalog change, say) is shown as it is, and the validator's own sentences say why.

import type { CardCost } from "@jackioh/shared";
import type { CatalogSnapshot } from "@jackioh/validator";

/** The two deck-shape numbers the builder was launched with (the validator's `DeckRules`, filled). */
export type DeckLimits = { deckSize: number; maxCopies: number };

export function copiesIn(cards: readonly string[], cardId: string): number {
  return cards.filter((id) => id === cardId).length;
}

/** One more copy of `cardId`, or null when that would pass `deckSize` or `maxCopies`. */
export function addCard(cards: readonly string[], cardId: string, limits: DeckLimits): readonly string[] | null {
  if (cards.length >= limits.deckSize || copiesIn(cards, cardId) >= limits.maxCopies) return null;
  return [...cards, cardId];
}

/** One copy fewer, or null when there is none to take. */
export function removeCard(cards: readonly string[], cardId: string): readonly string[] | null {
  const at = cards.lastIndexOf(cardId);
  return at < 0 ? null : cards.toSpliced(at, 1);
}

/** Same cards, any order: whether Back would drop anything. */
export function sameCards(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n");
}

/** §5's three cost shapes on one axis: `X` sorts as 0, an embiggen pair by its base. */
export function costOrder(cost: CardCost | undefined): number {
  if (cost === undefined) return Number.POSITIVE_INFINITY;
  if (typeof cost === "number") return cost;
  if (cost === "X") return 0;
  return cost.base;
}

/** Hearthstone's collection order: cost, then name, then id so the order is total. */
export function sortByCost(ids: readonly string[], catalog: CatalogSnapshot): string[] {
  return [...ids].sort((a, b) => {
    const left = catalog.cards[a];
    const right = catalog.cards[b];
    return (
      costOrder(left?.cost) - costOrder(right?.cost) ||
      (left?.name ?? a).localeCompare(right?.name ?? b) ||
      a.localeCompare(b)
    );
  });
}

/** One decklist bar per distinct card, in collection order. */
export function barsOf(cards: readonly string[], catalog: CatalogSnapshot): { cardId: string; count: number }[] {
  return sortByCost([...new Set(cards)], catalog).map((cardId) => ({ cardId, count: copiesIn(cards, cardId) }));
}

// --- pages ---------------------------------------------------------------------------------------

/** A card's width over its height. `CardFace` sets it inline, so CSS never restates it. */
export const CARD_ASPECT = 0.72;

/**
 * A page card's width tracks the viewport, `clamp(150px, 11vw, 210px)`: about 5×3 cards at a
 * 1440×900 window and 6×3 at 1920×1080. JS computes it and hands it to CSS as `--lib-card-w`, so
 * the grid and the page-size arithmetic cannot disagree.
 */
export const PAGE_CARD_WIDTH = { min: 150, max: 210, viewportShare: 0.11 } as const;

/** The grid gap, handed to CSS as `--lib-gap` for the same reason. */
export const PAGE_GAP = 12;

export type PageSize = { cols: number; rows: number };

/** jsdom has no `ResizeObserver`; a browser replaces this with the measured size at once. */
export const FALLBACK_PAGE_SIZE: PageSize = { cols: 4, rows: 2 };

export function cardWidthFor(viewportWidth: number): number {
  const { min, max, viewportShare } = PAGE_CARD_WIDTH;
  return Math.min(max, Math.max(min, viewportWidth * viewportShare));
}

/** As many whole cards as fit the measured grid, and never fewer than one. */
export function pageSizeFor(width: number, height: number, cardWidth: number, gap = PAGE_GAP): PageSize {
  const cardHeight = cardWidth / CARD_ASPECT;
  return {
    cols: Math.max(1, Math.floor((width + gap) / (cardWidth + gap))),
    rows: Math.max(1, Math.floor((height + gap) / (cardHeight + gap))),
  };
}

export function pageCount(total: number, perPage: number): number {
  return Math.max(1, Math.ceil(total / Math.max(1, perPage)));
}

/** 0-based, kept inside `[0, pages)` when the page count shrinks (a resize, a smaller pool). */
export function clampPage(page: number, pages: number): number {
  return Math.min(Math.max(0, page), Math.max(1, pages) - 1);
}

export function pageOf<T>(items: readonly T[], page: number, perPage: number): T[] {
  return items.slice(page * perPage, (page + 1) * perPage);
}

// --- the hover preview ---------------------------------------------------------------------------

/** How far the preview keeps from the decklist and from the viewport's edges. */
export const PREVIEW_MARGIN = 12;

/**
 * Where the hovered bar's card goes: left of the decklist, level with the bar, and inside the
 * viewport however close to an edge the bar is.
 */
export function previewPlacement(input: {
  bar: { top: number; height: number };
  listLeft: number;
  width: number;
  viewport: { width: number; height: number };
}): { top: number; left: number; width: number } {
  const { bar, listLeft, viewport } = input;
  const width = Math.min(input.width, viewport.width - 2 * PREVIEW_MARGIN);
  const height = width / CARD_ASPECT;
  const top = Math.min(bar.top + bar.height / 2 - height / 2, viewport.height - height - PREVIEW_MARGIN);
  const left = Math.min(listLeft - width - PREVIEW_MARGIN, viewport.width - width - PREVIEW_MARGIN);
  return { top: Math.max(PREVIEW_MARGIN, top), left: Math.max(PREVIEW_MARGIN, left), width };
}
