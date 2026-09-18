// A catalog and a collection for the deckbuilder's tests.
//
// Deliberately NOT `packages/cards/catalog.json`: the real catalog belongs to M4 and is still
// moving, and a test that breaks when a designer renames a card tells you nothing about the
// builder. The shape is the real one (`CardDef` from `@jackioh/shared`) and the sizes are the real
// ones (`DECK_SIZE` and `LOADOUT_DECKS` are imported, never spelled), so a loadout built from this
// catalog is legal for exactly the reasons a loadout built from the real one is.

import type { CardDef, CardDefs } from "@jackioh/shared";
import { LOADOUT_DECKS, type CatalogSnapshot, type Collection } from "@jackioh/validator";

import { DECK_SIZE } from "./deckSize.ts";

export const CATALOG_VERSION = "test-catalog-1";

/** Enough distinct cards for a legal loadout, plus one spare to move around. */
export const FIXTURE_CARD_COUNT = DECK_SIZE * LOADOUT_DECKS + 1;

/** SPEC §8 #65.1's shape: a token, which L3 bans from a deck. */
export const TOKEN_ID = "core-065-1";

export function fixtureCardId(index: number): string {
  return `core-${String(index).padStart(3, "0")}`;
}

export function fixtureCardName(index: number): string {
  return `Fixture Card ${String(index).padStart(3, "0")}`;
}

function def(id: string, index: string, name: string, token: boolean): CardDef {
  return {
    id,
    index,
    name,
    set: "Core",
    type: "Unit",
    tags: token ? ["Token"] : ["Human"],
    rarity: "Common",
    token,
    cost: 2,
    base: { attack: 1, health: 1, keywords: [], text: "" },
    radiant: { attack: 2, health: 2, keywords: [], text: "" },
  };
}

export function fixtureDefs(): CardDefs {
  const defs: Record<string, CardDef> = {};
  for (let index = 1; index <= FIXTURE_CARD_COUNT; index += 1) {
    const id = fixtureCardId(index);
    defs[id] = def(id, String(index), fixtureCardName(index), false);
  }
  defs[TOKEN_ID] = def(TOKEN_ID, "65.1", "Spikey Pillow", true);
  return defs;
}

export function fixtureCatalog(): CatalogSnapshot {
  return { version: CATALOG_VERSION, cards: fixtureDefs() };
}

/** R111's launch grant, in miniature: one copy of every non-token card, and no token. */
export function fixtureCollection(): Collection {
  const owned: Record<string, number> = {};
  for (let index = 1; index <= FIXTURE_CARD_COUNT; index += 1) owned[fixtureCardId(index)] = 1;
  return owned;
}

/** Three disjoint decks of `DECK_SIZE`, which is what L1–L6 together ask for. */
export function legalDecks(): string[][] {
  const decks: string[][] = [];
  for (let deck = 0; deck < LOADOUT_DECKS; deck += 1) {
    const cards: string[] = [];
    for (let slot = 0; slot < DECK_SIZE; slot += 1) cards.push(fixtureCardId(deck * DECK_SIZE + slot + 1));
    decks.push(cards);
  }
  return decks;
}

/** The card that is in no deck of `legalDecks()`, for the drag tests. */
export const SPARE_CARD_ID = fixtureCardId(FIXTURE_CARD_COUNT);
