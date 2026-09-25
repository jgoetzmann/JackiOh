// The workshop's pure facts: every verdict is the shared validator's own (R253), handed the decks
// under the names they are saved with; the comparison marks exactly what `trioConflicts` finds
// (R251); and the editor's moves refuse only what a save would refuse or a comparison forbids.
//
// No validator sentence is typed here: each expectation is computed with the validator itself
// (messages.test.ts fails any client source that spells one out).

import { trioConflicts, validateDeck, validateTrio } from "@jackioh/validator";
import { describe, expect, it } from "vitest";

import { DECK_NAME_MAX_LENGTH } from "../../../../server/src/config.ts";
import { DECK_SIZE } from "./deckSize.ts";
import { fixtureCardId, fixtureCatalog, fixtureCollection, legalDecks } from "./fixtures.ts";
import type { DeckItem, TrioItem } from "./sync.ts";
import {
  MAX_COMPARED_DECKS,
  NO_COMPARE,
  addCard,
  clampName,
  comparedDecks,
  deckStatus,
  deckVerdict,
  holdersOf,
  nextName,
  ownershipUnknown,
  removeCard,
  trioSharedCards,
  trioSlots,
  trioVerdict,
  withComparedDeck,
  withoutComparedDeck,
} from "./workshop.ts";

const catalog = fixtureCatalog();
const collection = fixtureCollection();
const NAME = DECK_NAME_MAX_LENGTH;

function deck(id: string, name: string, cards: readonly string[]): DeckItem {
  return { id, name, cards, createdAt: 0, updatedAt: 0 };
}

function trio(id: string, deckIds: TrioItem["deckIds"], name = "Ladder"): TrioItem {
  return { id, name, deckIds, createdAt: 0, updatedAt: 0 };
}

const [ONE = [], TWO = [], THREE = []] = legalDecks();
const aggro = deck("a", "Aggro", ONE);
const control = deck("c", "Control", TWO);
const midrange = deck("m", "Midrange", THREE);

describe("verdicts are the validator's (R253)", () => {
  it("R253 a deck's verdict is validateDeck's, under the name the deck is saved with", () => {
    const short = deck("s", "  Short   stack ", ONE.slice(0, 5));
    expect(deckVerdict(short, catalog, collection, NAME)).toEqual(
      validateDeck({ deck: { name: "Short stack", cards: short.cards }, catalog, collection }),
    );
  });

  it("R253 a trio's verdict is validateTrio's over its filled slots, so an empty slot is L1", () => {
    const decks = [aggro, control, midrange];
    const withGap = trio("t", ["a", null, "m"]);
    const verdict = trioVerdict(withGap, decks, catalog, collection, NAME);
    expect(verdict).toEqual(
      validateTrio({
        decks: [
          { name: "Aggro", cards: aggro.cards },
          { name: "Midrange", cards: midrange.cards },
        ],
        catalog,
        collection,
      }),
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.errors.map((issue) => issue.rule)).toContain("L1");
    expect(trioVerdict(trio("t", ["a", "c", "m"]), decks, catalog, collection, NAME).ok).toBe(true);
  });

  it("R253 with no collection nothing is claimed unowned, and the other rules still speak", () => {
    const empty: Record<string, number> = {};
    const judged = deckVerdict(deck("u", "Unowned", ONE), catalog, null, NAME);
    expect(judged.ok).toBe(true);
    expect(deckVerdict(deck("u", "Unowned", ONE), catalog, empty, NAME).ok).toBe(false);
    const short = deckVerdict(deck("s", "Short", ONE.slice(0, 3)), catalog, null, NAME);
    expect(short.ok ? [] : short.errors.map((issue) => issue.rule)).toEqual(["L2"]);
    expect(ownershipUnknown([["x", "y"], ["x"]])).toEqual({ x: 2, y: 1 });
  });

  it("the chip reads the verdict: Ready, Complete, Incomplete, N not owned, Needs a fix", () => {
    expect(deckStatus(deckVerdict(aggro, catalog, collection, NAME), true)).toEqual({ kind: "ready", label: "Ready" });
    expect(deckStatus(deckVerdict(aggro, catalog, null, NAME), false)).toEqual({ kind: "complete", label: "Complete" });
    expect(deckStatus(deckVerdict(deck("s", "S", ONE.slice(0, 4)), catalog, collection, NAME), true).kind).toBe("incomplete");
    const twoShort: Record<string, number> = { ...collection };
    delete twoShort[ONE[0] ?? ""];
    delete twoShort[ONE[1] ?? ""];
    expect(deckStatus(deckVerdict(aggro, catalog, twoShort, NAME), true)).toEqual({ kind: "unowned", label: "2 not owned" });
    const banned = { ...catalog, banned: [ONE[0] ?? ""] };
    expect(deckStatus(deckVerdict(aggro, banned, collection, NAME), true)).toEqual({ kind: "invalid", label: "Needs a fix" });
  });
});

describe("comparing (R251)", () => {
  it("R251 the compared decks' cards are held by the first deck naming them", () => {
    const shared = deck("x", "Overlap", [ONE[0] ?? "", TWO[0] ?? ""]);
    const holders = holdersOf([control, shared], NAME);
    expect(holders.get(TWO[0] ?? "")).toEqual({ deckId: "c", name: "Control" });
    expect(holders.get(ONE[0] ?? "")).toEqual({ deckId: "x", name: "Overlap" });
    expect(holders.has(THREE[0] ?? "")).toBe(false);
  });

  it("R251 a trio comparison is the trio's other decks; a deck comparison keeps at most two", () => {
    const decks = [aggro, control, midrange];
    const trios = [trio("t", ["a", "c", null])];
    expect(comparedDecks({ kind: "trio", trioId: "t" }, "a", decks, trios).map((d) => d.id)).toEqual(["c"]);
    expect(comparedDecks(NO_COMPARE, "a", decks, trios)).toEqual([]);

    let compare = withComparedDeck(NO_COMPARE, "c");
    compare = withComparedDeck(compare, "m");
    compare = withComparedDeck(compare, "a");
    expect(compare).toEqual({ kind: "decks", deckIds: ["m", "a"] });
    expect(MAX_COMPARED_DECKS).toBe(2);
    // The open deck never compares with itself.
    expect(comparedDecks(compare, "a", decks, trios).map((d) => d.id)).toEqual(["m"]);
    expect(withoutComparedDeck(compare, [midrange], "m")).toEqual(NO_COMPARE);
  });

  it("R251 a trio's shared cards are trioConflicts', said from each deck's side", () => {
    const clash = ONE[0] ?? "";
    const withClash = deck("c", "Control", [clash, ...TWO.slice(1)]);
    const slots = trioSlots(trio("t", ["a", "c", null]), [aggro, withClash]);
    expect(slots.map((slot) => slot?.id ?? null)).toEqual(["a", "c", null]);
    const shared = trioSharedCards(slots, NAME);
    expect(trioConflicts(slots.map((slot) => ({ cards: slot?.cards ?? [] }))).map((c) => c.cardId)).toEqual([clash]);
    expect(shared[0]?.get(clash)).toEqual(["Control"]);
    expect(shared[1]?.get(clash)).toEqual(["Aggro"]);
    expect(shared[2]?.size).toBe(0);
    expect(shared[0]?.has(ONE[1] ?? "")).toBe(false);
  });
});

describe("the editor's moves", () => {
  it("adds a card nothing holds", () => {
    const move = addCard([], fixtureCardId(1), new Map());
    expect(move).toEqual({ ok: true, cards: [fixtureCardId(1)] });
  });

  it("refuses a second copy, a card a compared deck holds, and a card past DECK_SIZE", () => {
    expect(addCard([fixtureCardId(1)], fixtureCardId(1), new Map())).toEqual({ ok: false, reason: "here" });
    const holder = { deckId: "c", name: "Control" };
    expect(addCard([], fixtureCardId(2), new Map([[fixtureCardId(2), holder]]))).toEqual({ ok: false, reason: "held", holder });
    expect(addCard(ONE, fixtureCardId(DECK_SIZE * 3 + 1), new Map())).toEqual({ ok: false, reason: "full" });
  });

  it("removes one copy, and removing what is not there is null", () => {
    expect(removeCard([fixtureCardId(1), fixtureCardId(2)], fixtureCardId(1))).toEqual([fixtureCardId(2)]);
    expect(removeCard([fixtureCardId(2)], fixtureCardId(1))).toBeNull();
  });
});

describe("names", () => {
  it("a new deck takes the first free number", () => {
    expect(nextName("Deck", [])).toBe("Deck 1");
    expect(nextName("Deck", ["Deck 1", "deck 2", "Aggro"])).toBe("Deck 3");
  });

  it("a typed name is cut at the limit in characters, an emoji counting as one", () => {
    expect([...clampName("🂡".repeat(NAME + 3), NAME)]).toHaveLength(NAME);
    expect(clampName("Aggro", NAME)).toBe("Aggro");
  });
});
