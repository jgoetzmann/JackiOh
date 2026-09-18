// The draft model. Nothing here asserts a rule: `validateLoadout` owns those, and this file only
// checks that the draft is handed to it faithfully and that the one UX refusal BUILD M8 asks for
// ("a card dragged into a second deck is refused") really refuses.

import { LOADOUT_DECKS, validateLoadout } from "@jackioh/validator";
import { describe, expect, it } from "vitest";

import { DECK_SIZE } from "./deckSize.ts";
import {
  SPARE_CARD_ID,
  TOKEN_ID,
  fixtureCatalog,
  fixtureCardId,
  fixtureCollection,
  legalDecks,
} from "./fixtures.ts";
import {
  addCard,
  collectionFrom,
  deckHolding,
  draftFrom,
  emptyDraft,
  issuesOf,
  poolFrom,
  removeCard,
  verdict,
} from "./loadout.ts";

describe("the draft", () => {
  it("opens empty with LOADOUT_DECKS decks for a profile that has never saved", () => {
    // §9.4 has no "create the row first" step, so `GET /api/loadout` answers `loadout: null`.
    const draft = draftFrom(null);
    expect(draft).toHaveLength(LOADOUT_DECKS);
    expect(draft.every((deck) => deck.length === 0)).toBe(true);
    expect(emptyDraft()).toEqual(draft);
  });

  it("pads a stored loadout with too few decks instead of hiding L1", () => {
    const decks = legalDecks();
    const draft = draftFrom([decks[0] ?? [], decks[1] ?? []]);
    expect(draft).toHaveLength(LOADOUT_DECKS);
    expect(draft[0]).toEqual(decks[0]);
    expect(draft[2]).toEqual([]);
  });

  it("keeps a stored loadout with too many decks, so the validator can report it", () => {
    const decks = legalDecks();
    const draft = draftFrom([...decks, [SPARE_CARD_ID]]);
    expect(draft).toHaveLength(LOADOUT_DECKS + 1);
  });

  it("does not alias the stored decks", () => {
    const decks = legalDecks();
    const draft = draftFrom(decks);
    const moved = addCard(draft, 1, SPARE_CARD_ID);
    expect(moved.applied).toBe(true);
    expect(decks[0]).toHaveLength(DECK_SIZE);
  });
});

describe("moves", () => {
  it("adds a card the loadout does not hold", () => {
    const move = addCard(draftFrom(legalDecks()), 2, SPARE_CARD_ID);
    expect(move.applied).toBe(true);
    if (!move.applied) return;
    expect(move.draft[1]).toContain(SPARE_CARD_ID);
  });

  it("refuses a card already held by another deck, and names the deck holding it", () => {
    // BUILD M8's row for 09: "a card dragged into a second deck is refused".
    const decks = legalDecks();
    const shared = decks[0]?.[0] ?? "";
    const move = addCard(draftFrom(decks), 3, shared);
    expect(move.applied).toBe(false);
    if (move.applied) return;
    expect(move.heldBy).toBe(1);
    expect(move.draft[2]).not.toContain(shared);
  });

  it("refuses a second copy in the same deck, because MAX_COPIES is 1 wherever it lands", () => {
    const decks = legalDecks();
    const own = decks[0]?.[0] ?? "";
    const move = addCard(draftFrom(decks), 1, own);
    expect(move.applied).toBe(false);
  });

  it("refuses a deck number outside the loadout", () => {
    expect(addCard(emptyDraft(), 0, SPARE_CARD_ID).applied).toBe(false);
    expect(addCard(emptyDraft(), LOADOUT_DECKS + 1, SPARE_CARD_ID).applied).toBe(false);
  });

  it("removes a card, and a card that is not there is a no-op", () => {
    const decks = legalDecks();
    const held = decks[1]?.[3] ?? "";
    const move = removeCard(draftFrom(decks), 2, held);
    expect(move.applied).toBe(true);
    if (!move.applied) return;
    expect(move.draft[1]).not.toContain(held);
    expect(removeCard(move.draft, 2, held).applied).toBe(false);
  });

  it("deckHolding reports the 1-based deck, matching the validator's Deck <n> labels", () => {
    const draft = draftFrom(legalDecks());
    expect(deckHolding(draft, fixtureCardId(1))).toBe(1);
    expect(deckHolding(draft, fixtureCardId(DECK_SIZE + 1))).toBe(2);
    expect(deckHolding(draft, SPARE_CARD_ID)).toBe(null);
  });
});

describe("the pool", () => {
  it("offers what the profile owns, in catalog order, and never a Token (L3)", () => {
    const pool = poolFrom(fixtureCatalog(), fixtureCollection());
    expect(pool).not.toContain(TOKEN_ID);
    expect(pool[0]).toBe(fixtureCardId(1));
    expect(pool[1]).toBe(fixtureCardId(2));
  });

  it("leaves out a card the profile owns none of", () => {
    const collection = { ...fixtureCollection() };
    delete collection[fixtureCardId(3)];
    expect(poolFrom(fixtureCatalog(), collection)).not.toContain(fixtureCardId(3));
  });

  it("falls back to the whole non-token catalog when the collection is unreadable", () => {
    const pool = poolFrom(fixtureCatalog(), null);
    expect(pool).toContain(fixtureCardId(3));
    expect(pool).not.toContain(TOKEN_ID);
  });

  it("collectionFrom projects the ledger's entries to quantities", () => {
    expect(collectionFrom([{ cardId: "core-001", quantity: 1 }])).toEqual({ "core-001": 1 });
  });
});

describe("the verdict is the validator's", () => {
  it("passes the decks through unnamed, so the labels are Deck 1..Deck 3", () => {
    const catalog = fixtureCatalog();
    const collection = fixtureCollection();
    const draft = draftFrom([[], [], []]);
    const errors = issuesOf(draft, catalog, collection);
    expect(errors.some((error) => error.message.includes("Deck 1"))).toBe(true);
    expect(errors.some((error) => error.message.includes("Deck 3"))).toBe(true);
  });

  it("is exactly what validateLoadout returns for the same input", () => {
    const catalog = fixtureCatalog();
    const collection = fixtureCollection();
    const draft = draftFrom(legalDecks());
    expect(verdict(draft, catalog, collection)).toEqual(
      validateLoadout({ decks: draft.map((cards) => ({ cards })), catalog, collection }),
    );
  });

  it("accepts three disjoint decks of DECK_SIZE that the profile owns", () => {
    expect(issuesOf(draftFrom(legalDecks()), fixtureCatalog(), fixtureCollection())).toEqual([]);
  });
});
