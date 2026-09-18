// Shared builders for the loadout tests (SPEC §9.4 L1–L6, BUILD M6-T3).
//
// The catalog is synthetic, but the five cards the §9.4 messages name keep their real ids and
// names, so the message assertions read like the spec. Every size comes from DECK_SIZE and
// LOADOUT_DECKS: nothing here spells 20 or 3.
//
// Each injection below breaks exactly one rule. That is the point of the file: a careless
// mutation trips several rules at once (a second copy of a card is also a copy you may not own),
// so the collection grants 2 of the two ids the L3-copies and L4 injections duplicate, and grants
// the token, the banned card and the uncatalogued id so those injections do not also trip L5.

import { DECK_SIZE } from "../../src/config";
import type { CardDef } from "@jackioh/shared";
import {
  LOADOUT_DECKS,
  type CardId,
  type CatalogSnapshot,
  type Collection,
  type LoadoutDeck,
  type LoadoutInput,
  type LoadoutRule,
} from "../../src/index";

/** The snapshot version the L6 "no such card" message quotes. */
export const CATALOG_VERSION = "2026-09-01";

/** In Deck 1 of the legal loadout, owned twice: the L4 injection puts it in a second deck. */
export const HIT_JOB = "core-012";
/** In Deck 3 of the legal loadout, owned once: the L5 injection zeroes what the profile owns. */
export const ARCHIVIST = "core-030";
/** In Deck 2 of the legal loadout, owned twice: the L3-copies injection duplicates it there. */
export const JELLY_BEAN = "core-051";
/** Catalogued and owned, but Token-tagged, so L3 refuses it in a deck. */
export const SHEEP_TOKEN = "core-051.1";
/** Catalogued and owned, but on the snapshot's banned list, so L6 refuses it. */
export const CEASELESS_VOID = "core-100";
/** Owned, and absent from the snapshot, so L6 refuses it by id alone. */
export const NOT_IN_CATALOG = "core-999";

/** Spares beyond the three decks: a whole deck's worth, so a fourth deck can be a legal one. */
const SPARE_COUNT = DECK_SIZE;
const POOL_SIZE = LOADOUT_DECKS * DECK_SIZE + SPARE_COUNT;

const NAMED: Readonly<Record<string, string>> = {
  [HIT_JOB]: "Hit Job",
  [ARCHIVIST]: "Archivist",
  [JELLY_BEAN]: "Glowy Jelly Bean",
};

function poolId(n: number): CardId {
  return `core-${String(n).padStart(3, "0")}`;
}

function vanillaDef(id: CardId, index: string, name: string): CardDef {
  return {
    id,
    index,
    name,
    set: "Core",
    type: "Unit",
    tags: [],
    rarity: "Common",
    token: false,
    cost: 1,
    base: { attack: 1, health: 1, keywords: [], text: "vanilla" },
    radiant: { attack: 2, health: 2, keywords: [], text: "vanilla" },
  };
}

function tokenDef(): CardDef {
  return {
    ...vanillaDef(SHEEP_TOKEN, "51.1", "Sheep Token"),
    tags: ["Token"],
    rarity: "Token",
    token: true,
  };
}

/** Every deckable id in the catalog: the decks draw from these, the rest are spares. */
export const POOL_IDS: readonly CardId[] = Array.from({ length: POOL_SIZE }, (_, i) => poolId(i + 1));

export function catalog(): CatalogSnapshot {
  const cards: Record<string, CardDef> = {};
  for (const id of POOL_IDS) {
    cards[id] = vanillaDef(id, id.slice("core-".length), NAMED[id] ?? `Fixture Card ${id.slice("core-".length)}`);
  }
  const token = tokenDef();
  cards[token.id] = token;
  cards[CEASELESS_VOID] = vanillaDef(CEASELESS_VOID, "100", "Ceaseless Void");
  return { version: CATALOG_VERSION, cards, banned: [CEASELESS_VOID] };
}

/**
 * One of every deckable card, two of the pair the L3-copies and L4 injections duplicate, and one
 * each of the token, the banned card and the uncatalogued id, so only their own rule fires.
 */
export function collection(): Collection {
  const owned: Record<string, number> = {};
  for (const id of POOL_IDS) owned[id] = 1;
  owned[HIT_JOB] = 2;
  owned[JELLY_BEAN] = 2;
  owned[SHEEP_TOKEN] = 1;
  owned[CEASELESS_VOID] = 1;
  owned[NOT_IN_CATALOG] = 1;
  return owned;
}

// Deck 2 takes the third block of the pool (core-041…), which is the block holding Glowy Jelly
// Bean (core-051), and Deck 3 takes the second: that puts Hit Job in Deck 1, the Jelly Bean in
// Deck 2 and the Archivist in Deck 3, exactly as the §9.4 messages read.
const BLOCK_ORDER: readonly number[] = [0, 2, 1];

/** The legal loadout's decks: LOADOUT_DECKS disjoint blocks of DECK_SIZE distinct owned ids. */
export function legalDecks(): readonly (readonly CardId[])[] {
  return Array.from({ length: LOADOUT_DECKS }, (_, i) => {
    const block = BLOCK_ORDER[i] ?? i;
    return POOL_IDS.slice(block * DECK_SIZE, (block + 1) * DECK_SIZE);
  });
}

/** A loadout that breaks none of L1–L6. */
export function legalLoadout(): LoadoutInput {
  return {
    decks: legalDecks().map((cards) => ({ cards })),
    catalog: catalog(),
    collection: collection(),
  };
}

// --- injections ------------------------------------------------------------
// Each one takes any legal loadout — the fixture's or a generated one — and breaks one rule.

function withDecks(input: LoadoutInput, decks: readonly LoadoutDeck[]): LoadoutInput {
  return { ...input, decks };
}

function mapDeck(
  input: LoadoutInput,
  index: number,
  f: (cards: readonly CardId[]) => readonly CardId[],
): LoadoutInput {
  return withDecks(
    input,
    input.decks.map((deck, i) => (i === index ? { ...deck, cards: f(deck.cards) } : deck)),
  );
}

/** Swaps `replacement` in for the first card that is not already `replacement`. */
function substitute(cards: readonly CardId[], replacement: CardId): readonly CardId[] {
  const at = cards.findIndex((id) => id !== replacement);
  return cards.map((id, i) => (i === at ? replacement : id));
}

function deckHolding(input: LoadoutInput, cardId: CardId): number {
  const index = input.decks.findIndex((deck) => deck.cards.includes(cardId));
  if (index < 0) throw new Error(`fixture error: no deck holds ${cardId}`);
  return index;
}

/** Owned, catalogued, deckable ids no deck of this loadout uses. */
function unusedIds(input: LoadoutInput): CardId[] {
  const used = new Set(input.decks.flatMap((deck) => [...deck.cards]));
  return POOL_IDS.filter((id) => !used.has(id));
}

/** L1: one deck short. Dropping a deck cannot break another rule — its cards simply go unused. */
export function dropDeck(input: LoadoutInput): LoadoutInput {
  return withDecks(input, input.decks.slice(0, -1));
}

/** L1: one deck too many, and a legal one, so only the deck count is wrong. */
export function addDeck(input: LoadoutInput): LoadoutInput {
  const spares = unusedIds(input).slice(0, DECK_SIZE);
  if (spares.length < DECK_SIZE) throw new Error("fixture error: not enough spares for one more deck");
  return withDecks(input, [...input.decks, { cards: spares }]);
}

/** L2: one card short. Removing a card cannot break another rule. */
export function dropCard(input: LoadoutInput): LoadoutInput {
  return mapDeck(input, 0, (cards) => cards.slice(1));
}

/**
 * L2: one card too many. Appending an id already in the loadout would break L3, L4 and L5 too,
 * so this appends a spare the profile owns and no deck uses.
 */
export function addSpareCard(input: LoadoutInput): LoadoutInput {
  const spare = unusedIds(input)[0];
  if (spare === undefined) throw new Error("fixture error: the loadout uses every pool card");
  return mapDeck(input, 0, (cards) => [...cards, spare]);
}

/** L3: a second copy of the Jelly Bean in its own deck. The profile owns 2, so L5 stays quiet. */
export function duplicateInDeck(input: LoadoutInput): LoadoutInput {
  return mapDeck(input, deckHolding(input, JELLY_BEAN), (cards) => substitute(cards, JELLY_BEAN));
}

/** L3: a Token card in the last deck. It is catalogued and owned, so only the token rule fires. */
export function insertToken(input: LoadoutInput): LoadoutInput {
  return mapDeck(input, input.decks.length - 1, (cards) => substitute(cards, SHEEP_TOKEN));
}

/**
 * L4: Hit Job in a second deck while it stays in its first. That is 2 copies across the loadout,
 * which is why the profile owns 2 of it.
 */
export function crossDeck(input: LoadoutInput): LoadoutInput {
  const home = deckHolding(input, HIT_JOB);
  const other = (home + 1) % input.decks.length;
  return mapDeck(input, other, (cards) => substitute(cards, HIT_JOB));
}

/** L5: the profile no longer owns the Archivist its loadout uses. */
export function unownCard(input: LoadoutInput): LoadoutInput {
  deckHolding(input, ARCHIVIST); // fixture guard: the card must be in play for L5 to fire
  return { ...input, collection: { ...input.collection, [ARCHIVIST]: 0 } };
}

/** L6: an id this snapshot does not know. The profile "owns" it, so L5 stays quiet. */
export function unknownCard(input: LoadoutInput): LoadoutInput {
  return mapDeck(input, 0, (cards) => substitute(cards, NOT_IN_CATALOG));
}

/** L6: a banned card. Catalogued and owned, so only the ban fires. */
export function bannedCard(input: LoadoutInput): LoadoutInput {
  return mapDeck(input, 0, (cards) => substitute(cards, CEASELESS_VOID));
}

export type Injection = {
  rule: LoadoutRule;
  label: string;
  apply: (input: LoadoutInput) => LoadoutInput;
};

/** Every single-rule injection, for the no-cascade table and the property test. */
export const INJECTIONS: readonly Injection[] = [
  { rule: "L1", label: "a missing deck", apply: dropDeck },
  { rule: "L1", label: "a fourth deck", apply: addDeck },
  { rule: "L2", label: "a deck one card short", apply: dropCard },
  { rule: "L2", label: "a deck one card over", apply: addSpareCard },
  { rule: "L3", label: "a second copy in one deck", apply: duplicateInDeck },
  { rule: "L3", label: "a Token card in a deck", apply: insertToken },
  { rule: "L4", label: "a card in two decks", apply: crossDeck },
  { rule: "L5", label: "a card the profile does not own", apply: unownCard },
  { rule: "L6", label: "a card missing from the catalog", apply: unknownCard },
  { rule: "L6", label: "a banned card", apply: bannedCard },
];
