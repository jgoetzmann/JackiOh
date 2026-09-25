// The deck workshop's pure facts (SPEC §9.4, R250–R253): the status chip a deck row wears, the
// verdicts the shared validator gives a deck and a trio, which cards the decks being compared
// hold, the two moves the editor makes on a deck's cards, and the names a new deck or trio starts
// with. The components draw what this module returns and decide nothing themselves.
//
// NO RULE LIVES HERE (CLAUDE.md rule 7). Whether a deck may queue Best-of-1 is `validateDeck`'s;
// whether a trio may queue Conquest is `validateTrio`'s; which cards two decks of a trio share is
// `trioConflicts`'s (R251: a card is its catalog id, so that is the whole comparison). This module
// only hands them the decks under the names they will be saved with, so the validator's sentences
// name the decks the player sees, and it never writes one of those sentences itself.
//
// THE TWO REFUSALS it does make are the builder declining to create a state a save would refuse
// or the player asked to avoid: a second copy of a card (D4, `MAX_COPIES`), a card past
// `DECK_SIZE` (D2), and a card a compared deck already holds (R251's "unavailable, used in
// <deck>"). None is a verdict: a deck that already breaks one (an import, a card added before the
// comparison was switched on) keeps its cards and the verdict says why.

import {
  trioConflicts,
  validateDeck,
  validateTrio,
  type CatalogSnapshot,
  type Collection,
  type LoadoutResult,
} from "@jackioh/validator";

import { DECK_SIZE, MAX_COPIES } from "./deckSize.ts";
import { deckNameForSave, trioNameForSave, type DeckItem, type TrioItem } from "./sync.ts";

// ---------------------------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------------------------

/** Cuts a typed name to `max` characters as D1 counts them: code points, an emoji being one. */
export function clampName(raw: string, max: number): string {
  const points = [...raw];
  return points.length <= max ? raw : points.slice(0, max).join("");
}

/** The name a deck is shown and judged under: the one its next save sends. */
export function deckLabel(deck: DeckItem, nameLength: number): string {
  return deckNameForSave(deck.name, nameLength);
}

export function trioLabel(trio: TrioItem, nameLength: number): string {
  return trioNameForSave(trio.name, nameLength);
}

/** `Deck 1`, `Deck 2`, …: the first `<prefix> <n>` no existing name uses. */
export function nextName(prefix: string, taken: readonly string[]): string {
  const used = new Set(taken.map((name) => name.trim().toLowerCase()));
  for (let number = 1; ; number += 1) {
    const candidate = `${prefix} ${String(number)}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
}

// ---------------------------------------------------------------------------------------------
// Verdicts (R253), and the status chip
// ---------------------------------------------------------------------------------------------

/**
 * The collection to judge with when `GET /api/collection` could not be read: every card owned
 * exactly as often as the decks use it. L5 then never fires, so nothing is claimed to be unowned
 * (or owned) on a guess, and every other rule still speaks. The server checks L5 at queue anyway.
 */
export function ownershipUnknown(cardLists: readonly (readonly string[])[]): Collection {
  const counts: Record<string, number> = {};
  for (const cards of cardLists) for (const cardId of cards) counts[cardId] = (counts[cardId] ?? 0) + 1;
  return counts;
}

/** R253's Best-of-1 verdict on a deck, under the name it is saved with. */
export function deckVerdict(
  deck: DeckItem,
  catalog: CatalogSnapshot,
  collection: Collection | null,
  nameLength: number,
): LoadoutResult {
  return validateDeck({
    deck: { name: deckLabel(deck, nameLength), cards: deck.cards },
    catalog,
    collection: collection ?? ownershipUnknown([deck.cards]),
  });
}

export type DeckStatusKind = "ready" | "complete" | "incomplete" | "unowned" | "invalid";
export type DeckStatus = { kind: DeckStatusKind; label: string };

/**
 * The deck row's chip, read off the verdict: "Ready" (it may queue), "Incomplete" (L2, the count
 * beside it says how far), "N not owned" (L5 only), or "Needs a fix" (anything else, which the
 * editor's verdict spells out). With no collection a legal deck is "Complete", not "Ready": its
 * ownership was not checked.
 */
export function deckStatus(verdict: LoadoutResult, collectionKnown: boolean): DeckStatus {
  if (verdict.ok) return collectionKnown ? { kind: "ready", label: "Ready" } : { kind: "complete", label: "Complete" };
  const rules = verdict.errors.map((issue) => issue.rule);
  if (rules.includes("L2")) return { kind: "incomplete", label: "Incomplete" };
  const unowned = rules.filter((rule) => rule === "L5").length;
  if (unowned > 0 && unowned === rules.length) return { kind: "unowned", label: `${String(unowned)} not owned` };
  return { kind: "invalid", label: "Needs a fix" };
}

/** A trio's three slots as decks, an empty slot (or one naming a deck that is gone) as null. */
export function trioSlots(trio: TrioItem, decks: readonly DeckItem[]): readonly (DeckItem | null)[] {
  return trio.deckIds.map((id) => (id === null ? null : (decks.find((deck) => deck.id === id) ?? null)));
}

/**
 * R253's Conquest verdict: `validateTrio` over the filled slots only, so an empty slot is L1's
 * "this one has 2" in the validator's own words, and every sentence names the decks as saved.
 */
export function trioVerdict(
  trio: TrioItem,
  decks: readonly DeckItem[],
  catalog: CatalogSnapshot,
  collection: Collection | null,
  nameLength: number,
): LoadoutResult {
  const filled = trioSlots(trio, decks).filter((deck): deck is DeckItem => deck !== null);
  return validateTrio({
    decks: filled.map((deck) => ({ name: deckLabel(deck, nameLength), cards: deck.cards })),
    catalog,
    collection: collection ?? ownershipUnknown(filled.map((deck) => deck.cards)),
  });
}

/**
 * For each slot (0-based, in trio order): card id → the names of the OTHER slots' decks that hold
 * it too. `trioConflicts` decides what is shared; this only says it from each deck's side, which
 * is what the side-by-side compare marks ("Also in <deck>").
 */
export function trioSharedCards(
  slots: readonly (DeckItem | null)[],
  nameLength: number,
): readonly ReadonlyMap<string, readonly string[]>[] {
  const conflicts = trioConflicts(slots.map((deck) => ({ cards: deck?.cards ?? [] })));
  return slots.map((_deck, slot) => {
    const shared = new Map<string, string[]>();
    for (const conflict of conflicts) {
      if (!conflict.decks.includes(slot)) continue;
      const others = conflict.decks
        .filter((index) => index !== slot)
        .map((index) => {
          const other = slots[index];
          return other === null || other === undefined ? "" : deckLabel(other, nameLength);
        });
      shared.set(conflict.cardId, others);
    }
    return shared;
  });
}

// ---------------------------------------------------------------------------------------------
// Comparing a deck with others (R251)
// ---------------------------------------------------------------------------------------------

/** At most this many decks are compared at once: with the open one, a trio's worth. */
export const MAX_COMPARED_DECKS = 2;

export type Compare =
  | { kind: "none" }
  /** A trio the open deck is in: its other decks. */
  | { kind: "trio"; trioId: string }
  | { kind: "decks"; deckIds: readonly string[] };

export const NO_COMPARE: Compare = { kind: "none" };

/** The trios that hold `deckId` in a slot. */
export function triosHolding(deckId: string, trios: readonly TrioItem[]): readonly TrioItem[] {
  return trios.filter((trio) => trio.deckIds.includes(deckId));
}

/** The decks a comparison names, other than the open deck, in the order it names them. */
export function comparedDecks(
  compare: Compare,
  openDeckId: string,
  decks: readonly DeckItem[],
  trios: readonly TrioItem[],
): readonly DeckItem[] {
  let ids: readonly string[] = [];
  if (compare.kind === "trio") {
    const slots: readonly (string | null)[] = trios.find((trio) => trio.id === compare.trioId)?.deckIds ?? [];
    ids = slots.filter((id): id is string => id !== null);
  } else if (compare.kind === "decks") {
    ids = compare.deckIds;
  }
  const seen = new Set<string>();
  const found: DeckItem[] = [];
  for (const id of ids) {
    if (id === openDeckId || seen.has(id)) continue;
    seen.add(id);
    const deck = decks.find((candidate) => candidate.id === id);
    if (deck !== undefined) found.push(deck);
  }
  return found;
}

/** Picking deck `deckId` from the compare control: added, the oldest dropped past the limit. */
export function withComparedDeck(compare: Compare, deckId: string): Compare {
  const current = compare.kind === "decks" ? compare.deckIds.filter((id) => id !== deckId) : [];
  const next = [...current, deckId];
  return { kind: "decks", deckIds: next.slice(Math.max(0, next.length - MAX_COMPARED_DECKS)) };
}

/** Dropping one deck from a comparison; a trio comparison becomes its remaining deck(s). */
export function withoutComparedDeck(compare: Compare, remaining: readonly DeckItem[], deckId: string): Compare {
  const kept = remaining.map((deck) => deck.id).filter((id) => id !== deckId);
  if (compare.kind === "none" || kept.length === 0) return NO_COMPARE;
  return { kind: "decks", deckIds: kept };
}

export type Holder = { deckId: string; name: string };

/** Card id → the first compared deck that holds it. */
export function holdersOf(compared: readonly DeckItem[], nameLength: number): ReadonlyMap<string, Holder> {
  const holders = new Map<string, Holder>();
  for (const deck of compared) {
    const holder: Holder = { deckId: deck.id, name: deckLabel(deck, nameLength) };
    for (const cardId of deck.cards) if (!holders.has(cardId)) holders.set(cardId, holder);
  }
  return holders;
}

// ---------------------------------------------------------------------------------------------
// The editor's moves
// ---------------------------------------------------------------------------------------------

export type AddResult =
  | { ok: true; cards: readonly string[] }
  /** The deck already holds `MAX_COPIES` of it. */
  | { ok: false; reason: "here" }
  /** A compared deck holds it (R251). */
  | { ok: false; reason: "held"; holder: Holder }
  /** The deck already holds `DECK_SIZE` cards. */
  | { ok: false; reason: "full" };

export function addCard(cards: readonly string[], cardId: string, holders: ReadonlyMap<string, Holder>): AddResult {
  if (cards.filter((held) => held === cardId).length >= MAX_COPIES) return { ok: false, reason: "here" };
  const holder = holders.get(cardId);
  if (holder !== undefined) return { ok: false, reason: "held", holder };
  if (cards.length >= DECK_SIZE) return { ok: false, reason: "full" };
  return { ok: true, cards: [...cards, cardId] };
}

/** One copy out; null when the deck does not hold the card. */
export function removeCard(cards: readonly string[], cardId: string): readonly string[] | null {
  const at = cards.indexOf(cardId);
  if (at < 0) return null;
  return [...cards.slice(0, at), ...cards.slice(at + 1)];
}
