// Saved decks, saved trios and the Best-of-1 deck check (SPEC §9.4, R250–R253).
//
// A saved deck or trio is a draft: the save checks only its structure (D1–D4, T1–T3), and the
// legality rules run when it is queued — L2, L3, L5 and L6 for a Best-of-1 deck, L1–L6 for a trio.
// The limits a caller passes (`nameMaxLength`) come from its own config in the apps; the tests pass
// a value of their own so this package states no server number.

import { describe, expect, it } from "vitest";
import { DECK_SIZE, MAX_COPIES } from "../src/config";
import {
  TRIO_DECKS,
  checkDeckDraft,
  checkTrioDraft,
  normalizeName,
  trioConflicts,
  validateDeck,
  validateTrio,
  validateLoadout,
  type LoadoutResult,
} from "../src/index";
import {
  ARCHIVIST,
  CEASELESS_VOID,
  HIT_JOB,
  NOT_IN_CATALOG,
  POOL_IDS,
  SHEEP_TOKEN,
  catalog,
  collection,
  legalDecks,
} from "./fixtures/loadouts";

const NAME_MAX = 12;
const snapshot = catalog();
const isDeckable = (cardId: string): boolean => {
  const def = snapshot.cards[cardId];
  return def !== undefined && !def.token && !def.tags.includes("Token");
};

function draft(cards: readonly string[], name = "Aggro") {
  return checkDeckDraft({ name, cards, isDeckable, nameMaxLength: NAME_MAX });
}

function rules(result: LoadoutResult): string[] {
  return result.ok ? [] : [...new Set(result.errors.map((error) => error.rule))].sort();
}

describe("R250 — a saved deck is a draft: D1–D4 are all a save checks", () => {
  it("R250 saves an empty, a partial and a full deck alike", () => {
    expect(draft([])).toEqual([]);
    expect(draft(POOL_IDS.slice(0, 7))).toEqual([]);
    expect(draft(POOL_IDS.slice(0, DECK_SIZE))).toEqual([]);
  });

  it("R250 saves cards the player does not own, and banned cards: those are judged at queue", () => {
    expect(draft([ARCHIVIST, CEASELESS_VOID])).toEqual([]);
  });

  it("R250 D1 wants a name of 1 to the limit's characters, trimmed, with no control characters", () => {
    expect(draft([], "   ").map((issue) => issue.rule)).toEqual(["D1"]);
    expect(draft([], "x".repeat(NAME_MAX + 1)).map((issue) => issue.rule)).toEqual(["D1"]);
    expect(draft([], `  ${"x".repeat(NAME_MAX)}  `)).toEqual([]);
    expect(draft([], "bad\u0007name").map((issue) => issue.rule)).toEqual(["D1"]);
    // Code points, not UTF-16 units: an emoji is one character to a player.
    expect(draft([], "🃏".repeat(NAME_MAX))).toEqual([]);
  });

  it("R250 D2 refuses more than DECK_SIZE cards", () => {
    const issues = draft(POOL_IDS.slice(0, DECK_SIZE + 1));
    expect(issues.map((issue) => issue.rule)).toEqual(["D2"]);
    expect(issues[0]?.message).toBe(
      `A deck holds at most ${DECK_SIZE} cards; this one has ${DECK_SIZE + 1}.`,
    );
  });

  it("R250 D3 refuses an id outside the catalog and a Token", () => {
    expect(draft([NOT_IN_CATALOG]).map((issue) => [issue.rule, issue.cardId])).toEqual([
      ["D3", NOT_IN_CATALOG],
    ]);
    expect(draft([SHEEP_TOKEN]).map((issue) => [issue.rule, issue.cardId])).toEqual([
      ["D3", SHEEP_TOKEN],
    ]);
  });

  it("R250 D4 refuses more than MAX_COPIES of a card", () => {
    const cards = Array.from({ length: MAX_COPIES + 1 }, () => HIT_JOB);
    expect(draft(cards).map((issue) => [issue.rule, issue.cardId])).toEqual([["D4", HIT_JOB]]);
  });

  it("R250 normalizes a name the way it is stored: trimmed, inner whitespace one space", () => {
    expect(normalizeName("  My   first\tdeck ")).toBe("My first deck");
  });
});

describe("R251 — a card is its catalog id, across a trio", () => {
  it("R251 finds every card two decks hold, with the decks that hold it, in trio order", () => {
    const [a = [], b = [], c = []] = legalDecks();
    const shared = a[0] ?? "";
    const decks = [{ cards: a }, { cards: [...b.slice(1), shared] }, { cards: [...c.slice(1), shared] }];
    expect(trioConflicts(decks)).toEqual([{ cardId: shared, decks: [0, 1, 2] }]);
    expect(trioConflicts(legalDecks().map((cards) => ({ cards })))).toEqual([]);
  });

  it("R251 reads the conflict L4 reports: the same fact, worded once by L4", () => {
    const [a = [], b = [], c = []] = legalDecks();
    const shared = a[0] ?? "";
    const decks = [{ cards: a }, { cards: [...b.slice(1), shared] }, { cards: c }];
    const result = validateTrio({ decks, catalog: snapshot, collection: { ...collection(), [shared]: 2 } });
    expect(rules(result)).toEqual(["L4"]);
    expect(trioConflicts(decks).map((conflict) => conflict.cardId)).toEqual([shared]);
  });
});

describe("R252 — a saved trio is three slots naming three different decks, any of them empty", () => {
  const trio = (deckIds: readonly (string | null)[], name = "Ladder") =>
    checkTrioDraft({ name, deckIds, nameMaxLength: NAME_MAX }).map((issue) => issue.rule);

  it("R252 saves a trio with empty slots", () => {
    expect(trio([null, null, null])).toEqual([]);
    expect(trio(["a", null, "c"])).toEqual([]);
    expect(TRIO_DECKS).toBe(3);
  });

  it("R252 T1 names, T2 counts the slots, T3 refuses one deck twice", () => {
    expect(trio(["a", "b", "c"], "")).toEqual(["T1"]);
    expect(trio(["a", "b"])).toEqual(["T2"]);
    expect(trio(["a", "a", null])).toEqual(["T3"]);
  });
});

describe("R253 — what may be queued: a Best-of-1 deck passes L2, L3, L5 and L6", () => {
  const [deck = []] = legalDecks();

  it("R253 passes a legal deck and names it in every refusal", () => {
    expect(validateDeck({ deck: { name: "Aggro", cards: deck }, catalog: snapshot, collection: collection() })).toEqual({
      ok: true,
    });
    const short = validateDeck({ deck: { name: "Aggro", cards: deck.slice(1) }, catalog: snapshot, collection: collection() });
    expect(short.ok ? [] : short.errors).toEqual([
      {
        rule: "L2",
        message: `Aggro has ${DECK_SIZE - 1} cards; every deck needs exactly ${DECK_SIZE}.`,
        deck: 1,
      },
    ]);
  });

  it("R253 words L5 for the deck, not a trio, and never raises L1 or L4", () => {
    const unowned = validateDeck({
      deck: { name: "Aggro", cards: deck },
      catalog: snapshot,
      collection: { ...collection(), [deck[0] ?? ""]: 0 },
    });
    expect(unowned.ok ? [] : unowned.errors.map((error) => [error.rule, error.message, error.deck])).toEqual([
      ["L5", `Aggro uses 1 copy of "Fixture Card 001" (core-001) but you own 0.`, 1],
    ]);
    const withToken = validateDeck({
      deck: { name: "Aggro", cards: [...deck.slice(1), SHEEP_TOKEN] },
      catalog: snapshot,
      collection: collection(),
    });
    expect(rules(withToken)).toEqual(["L3"]);
  });

  it("R253 checks a trio with L1–L6: a trio is §9.4's loadout", () => {
    expect(validateTrio).toBe(validateLoadout);
    const two = legalDecks().slice(0, 2).map((cards) => ({ cards }));
    expect(rules(validateTrio({ decks: two, catalog: snapshot, collection: collection() }))).toEqual(["L1"]);
  });
});
