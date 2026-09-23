// The loadout rules L1–L6 (SPEC §9.4), one test per rule with its exact message (BUILD M6-T3).
//
// Two things beyond "the rule fires" are under test here. First the message, because §9.4 says a
// failure "names the deck and the card" and `apps/web` shows that same sentence in the
// deckbuilder (BUILD e2e `09-deckbuilder.cy.ts`), so the string is part of the contract. Second
// that one violation reports one rule: each injection in the fixtures breaks a single rule while
// leaving the other five satisfiable, and a validator that let a duplicate card also read as
// "you do not own this" would bury the real reason in the builder's error list.
//
// `LoadoutError.deck` is the 1-based deck number the message shows; it is absent on the
// loadout-wide rules (L1, L4, L5), whose messages name no single deck.

import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { DECK_SIZE, MAX_COPIES } from "../src/config";
import {
  LOADOUT_DECKS,
  validateDeck,
  validateLoadout,
  type CardId,
  type LoadoutError,
  type LoadoutInput,
  type LoadoutResult,
  type LoadoutRule,
} from "../src/index";
import {
  ARCHIVIST,
  CATALOG_VERSION,
  CEASELESS_VOID,
  HIT_JOB,
  INJECTIONS,
  JELLY_BEAN,
  NOT_IN_CATALOG,
  POOL_IDS,
  addDeck,
  addSpareCard,
  bannedCard,
  catalog,
  collection,
  crossDeck,
  dropCard,
  dropDeck,
  duplicateInDeck,
  insertToken,
  legalLoadout,
  unknownCard,
  unownCard,
} from "./fixtures/loadouts";

/** A fixed seed and run count: the property tests must fail the same way twice. */
const SEED = 20260917;
const NUM_RUNS = 200;

function errorsOf(result: LoadoutResult): readonly LoadoutError[] {
  if (result.ok) throw new Error("expected validateLoadout to reject this loadout");
  return result.errors;
}

/** The distinct rules a result reports, sorted, for the no-cascade assertions. */
function rulesOf(result: LoadoutResult): LoadoutRule[] {
  return [...new Set(errorsOf(result).map((error) => error.rule))].sort();
}

/** The one error a single-rule injection is expected to produce. */
function soleError(result: LoadoutResult): LoadoutError {
  const errors = errorsOf(result);
  const [first, ...rest] = errors;
  if (first === undefined || rest.length > 0) {
    throw new Error(`expected exactly one error, got ${errors.length}: ${errors.map((e) => e.message).join(" | ")}`);
  }
  return first;
}

describe("loadout rules L1–L6 (§9.4, M6-T3)", () => {
  it("accepts a legal loadout", () => {
    expect(validateLoadout(legalLoadout())).toEqual({ ok: true });
  });

  it("L1 rejects a loadout that does not hold exactly three decks", () => {
    const error = soleError(validateLoadout(dropDeck(legalLoadout())));
    expect(error.rule).toBe("L1");
    expect(error.message).toBe(`A loadout needs exactly ${LOADOUT_DECKS} decks; this one has ${LOADOUT_DECKS - 1}.`);
    expect(error.deck).toBeUndefined();
    expect(error.cardId).toBeUndefined();
  });

  it("L1 rejects a loadout with a fourth deck, however legal that deck is", () => {
    const error = soleError(validateLoadout(addDeck(legalLoadout())));
    expect(error.rule).toBe("L1");
    expect(error.message).toBe(`A loadout needs exactly ${LOADOUT_DECKS} decks; this one has ${LOADOUT_DECKS + 1}.`);
    expect(error.deck).toBeUndefined();
  });

  it("L2 rejects a deck that is one card short", () => {
    const error = soleError(validateLoadout(dropCard(legalLoadout())));
    expect(error.rule).toBe("L2");
    expect(error.message).toBe(`Deck 1 has ${DECK_SIZE - 1} cards; every deck needs exactly ${DECK_SIZE}.`);
    expect(error.deck).toBe(1);
    expect(error.cardId).toBeUndefined();
  });

  it("L2 rejects a deck that is one card over", () => {
    const error = soleError(validateLoadout(addSpareCard(legalLoadout())));
    expect(error.rule).toBe("L2");
    expect(error.message).toBe(`Deck 1 has ${DECK_SIZE + 1} cards; every deck needs exactly ${DECK_SIZE}.`);
    expect(error.deck).toBe(1);
  });

  it("L2 counts one card as \"1 card\": the builder reaches that by deleting", () => {
    const legal = legalLoadout();
    const [first, ...rest] = legal.decks;
    if (first === undefined) throw new Error("fixture error: the legal loadout has no decks");
    const trimmed: LoadoutInput = { ...legal, decks: [{ ...first, cards: first.cards.slice(0, 1) }, ...rest] };

    const error = soleError(validateLoadout(trimmed));
    expect(error.rule).toBe("L2");
    expect(error.message).toBe(`Deck 1 has 1 card; every deck needs exactly ${DECK_SIZE}.`);
  });

  it("L2 names a deck by its builder label when it has one", () => {
    const legal = legalLoadout();
    const [first, ...rest] = legal.decks;
    if (first === undefined) throw new Error("fixture error: the legal loadout has no decks");
    const named: LoadoutInput = { ...legal, decks: [{ ...first, name: "Aggro" }, ...rest] };

    const error = soleError(validateLoadout(dropCard(named)));
    expect(error.message).toBe(`Aggro has ${DECK_SIZE - 1} cards; every deck needs exactly ${DECK_SIZE}.`);
  });

  it("L3 rejects a second copy of a card in one deck", () => {
    const error = soleError(validateLoadout(duplicateInDeck(legalLoadout())));
    expect(error.rule).toBe("L3");
    expect(error.message).toBe(
      `Deck 2 has ${MAX_COPIES + 1} copies of "Glowy Jelly Bean" (core-051);` +
        ` at most ${MAX_COPIES} copy of a card is allowed per deck.`,
    );
    expect(error.deck).toBe(2);
    expect(error.cardId).toBe(JELLY_BEAN);
  });

  it("L3 rejects a Token card in a deck", () => {
    const error = soleError(validateLoadout(insertToken(legalLoadout())));
    expect(error.rule).toBe("L3");
    expect(error.message).toBe(
      `Deck ${LOADOUT_DECKS} cannot contain "Sheep Token" (core-051.1): Token cards are never deckable.`,
    );
    expect(error.deck).toBe(LOADOUT_DECKS);
    expect(error.cardId).toBe("core-051.1");
  });

  it("L4 rejects a card that is in two decks of the loadout", () => {
    const error = soleError(validateLoadout(crossDeck(legalLoadout())));
    expect(error.rule).toBe("L4");
    expect(error.message).toBe(
      `"Hit Job" (core-012) appears in Deck 1 and Deck 2; a card may be in only one deck of a loadout.`,
    );
    expect(error.deck).toBeUndefined(); // the message names both decks; the field names one
    expect(error.cardId).toBe(HIT_JOB);
  });

  it("L5 rejects a card the profile does not own", () => {
    const error = soleError(validateLoadout(unownCard(legalLoadout())));
    expect(error.rule).toBe("L5");
    expect(error.message).toBe(`Your loadout uses 1 copy of "Archivist" (core-030) but you own 0.`);
    expect(error.deck).toBeUndefined(); // L5 counts across the loadout, not per deck
    expect(error.cardId).toBe(ARCHIVIST);
  });

  it("L6 rejects a card that is not in the catalog snapshot", () => {
    const error = soleError(validateLoadout(unknownCard(legalLoadout())));
    expect(error.rule).toBe("L6");
    expect(error.message).toBe(`Deck 1 cannot contain "core-999": no such card in catalog version ${CATALOG_VERSION}.`);
    expect(error.deck).toBe(1);
    expect(error.cardId).toBe(NOT_IN_CATALOG);
  });

  it("L6 rejects a banned card", () => {
    const error = soleError(validateLoadout(bannedCard(legalLoadout())));
    expect(error.rule).toBe("L6");
    expect(error.message).toBe(`Deck 1 cannot contain "Ceaseless Void" (core-100): that card is banned.`);
    expect(error.deck).toBe(1);
    expect(error.cardId).toBe(CEASELESS_VOID);
  });

  it("reports every broken rule at once, so the builder can show them together", () => {
    // Two independent faults in Deck 1: it is a card short, and the card at its head is not in
    // the snapshot. §9.4's validator is the deckbuilder's, so it collects rather than short-circuits.
    expect(rulesOf(validateLoadout(unknownCard(dropCard(legalLoadout()))))).toEqual(["L2", "L6"]);
  });

  it("L5 counts copies across the loadout, which with MAX_COPIES = 1 means L3 or L4 fires with it", () => {
    // The plural L5 message needs two copies of one card, and with MAX_COPIES = 1 a second copy
    // is either in the same deck (L3) or in another deck (L4). So this is the one message that
    // cannot be produced on its own; the copies still have to be counted and named correctly.
    const legal = legalLoadout();
    const decks = legal.decks.map((deck) =>
      deck.cards.includes(ARCHIVIST)
        ? { ...deck, cards: deck.cards.map((id, i) => (i === 0 ? ARCHIVIST : id)) }
        : deck,
    );
    const result = validateLoadout({ ...legal, decks });

    expect(rulesOf(result)).toEqual(["L3", "L5"]);
    expect(errorsOf(result).filter((error) => error.rule === "L5").map((error) => error.message)).toEqual([
      `Your loadout uses ${MAX_COPIES + 1} copies of "Archivist" (core-030) but you own 1.`,
    ]);
  });
});

describe("the deck rules as overridable limits", () => {
  it("reads deckSize and maxCopies from `rules` when given, and config otherwise", () => {
    const legal = legalLoadout();
    const bigger = DECK_SIZE + 1;
    // Deck 1 is DECK_SIZE long, so a deckSize one larger makes it one card short under the override.
    const errors = errorsOf(validateLoadout({ ...legal, rules: { deckSize: bigger } }));
    expect(errors.find((error) => error.deck === 1)?.message).toBe(
      `Deck 1 has ${DECK_SIZE} cards; every deck needs exactly ${bigger}.`,
    );
    // A second copy of Jelly Bean (owned twice) is legal once two copies are allowed per deck.
    expect(rulesOf(validateLoadout(duplicateInDeck(legal)))).toEqual(["L3"]);
    expect(validateLoadout({ ...duplicateInDeck(legal), rules: { maxCopies: MAX_COPIES + 1 } })).toEqual({ ok: true });
  });
});

describe("a single library deck (R171)", () => {
  const input = legalLoadout();
  const first = input.decks[0];
  if (first === undefined) throw new Error("fixture error: the legal loadout has no decks");
  const deckInput = (cards: readonly CardId[], allowIncomplete?: boolean) => ({
    deck: { name: "Aggro", cards },
    catalog: input.catalog,
    collection: input.collection,
    ...(allowIncomplete === undefined ? {} : { allowIncomplete }),
  });

  it("R171 accepts a full legal deck, and never reports L1 for a deck that is not a loadout", () => {
    expect(validateDeck(deckInput(first.cards))).toEqual({ ok: true });
  });

  it("R171 saves an incomplete deck when asked, and still refuses one over the size", () => {
    const short = first.cards.slice(0, 5);
    expect(validateDeck(deckInput(short, true))).toEqual({ ok: true });
    // Strict (the path a match takes, R172): L2, named by the deck's own label.
    expect(errorsOf(validateDeck(deckInput(short))).map((error) => error.message)).toEqual([
      `Aggro has 5 cards; every deck needs exactly ${DECK_SIZE}.`,
    ]);
    const spare = input.decks[1]?.cards[0];
    if (spare === undefined) throw new Error("fixture error: deck 2 is empty");
    expect(rulesOf(validateDeck(deckInput([...first.cards, spare], true)))).toEqual(["L2"]);
  });

  it("R171 keeps L3, L5 and L6 on an incomplete deck", () => {
    const short = first.cards.slice(0, 3);
    const unowned = { ...deckInput([...short, ARCHIVIST], true), collection: { ...input.collection, [ARCHIVIST]: 0 } };
    expect(rulesOf(validateDeck(unowned))).toEqual(["L5"]);
    expect(rulesOf(validateDeck(deckInput([...short, short[0] ?? ""], true)))).toContain("L3");
    expect(rulesOf(validateDeck(deckInput([...short, NOT_IN_CATALOG], true)))).toEqual(["L6"]);
    expect(rulesOf(validateDeck(deckInput([...short, "core-051.1"], true)))).toEqual(["L3"]);
  });

  it("R171 never reports L4: a card may sit in any number of library decks", () => {
    // The same cards in two library decks are two separate checks; neither knows of the other.
    expect(validateDeck(deckInput(first.cards))).toEqual({ ok: true });
    expect(validateDeck(deckInput(first.cards))).toEqual({ ok: true });
  });
});

describe("the report is bounded by the rules' own sizes (R173)", () => {
  const junk = (n: number, prefix: string): CardId[] => Array.from({ length: n }, (_, i) => `${prefix}-${String(i)}`);

  it("R173 reports an over-size deck by L2 alone, however many bad ids it carries", () => {
    const result = validateDeck({ deck: { cards: junk(DECK_SIZE * 50, "junk") }, catalog: catalog(), collection: collection() });
    expect(errorsOf(result).map((error) => error.rule)).toEqual(["L2"]);
  });

  it("R173 reports a loadout of too many decks by L1 alone", () => {
    const decks = Array.from({ length: LOADOUT_DECKS * 20 }, (_, i) => ({ cards: junk(DECK_SIZE, `d${String(i)}`) }));
    expect(errorsOf(validateLoadout({ decks, catalog: catalog(), collection: collection() })).map((e) => e.rule)).toEqual([
      "L1",
    ]);
  });

  it("R173 still judges a short deck card by card, which is what a builder needs", () => {
    const result = validateDeck({ deck: { cards: [NOT_IN_CATALOG] }, catalog: catalog(), collection: collection() });
    expect(rulesOf(result)).toEqual(["L2", "L6"]);
  });
});

describe("card ids are data, not property names", () => {
  it("reports an id named after an Object.prototype member as L6, never throwing", () => {
    for (const cardId of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      const result = validateDeck({ deck: { cards: [cardId] }, catalog: catalog(), collection: collection(), allowIncomplete: true });
      expect(rulesOf(result)).toEqual(["L5", "L6"]);
    }
  });
});

describe("one violation reports one rule (§9.4)", () => {
  it.each(INJECTIONS)("$rule and nothing else for $label", ({ rule, apply }) => {
    expect(rulesOf(validateLoadout(apply(legalLoadout())))).toEqual([rule]);
  });
});

// --- properties over random loadouts (BUILD §"Property: random loadouts") --------------------

const REQUIRED: readonly CardId[] = [HIT_JOB, JELLY_BEAN, ARCHIVIST];
const OPTIONAL: CardId[] = POOL_IDS.filter((id) => !REQUIRED.includes(id));
const DECK_CARDS = LOADOUT_DECKS * DECK_SIZE;

/**
 * A legal loadout with a random split: which owned ids land in which deck, in which order, under
 * which names. The three cards the injections work on are always dealt somewhere, so every
 * injection applies to every generated loadout.
 */
const legalLoadoutArb: fc.Arbitrary<LoadoutInput> = fc
  .tuple(
    fc
      .shuffledSubarray(OPTIONAL, {
        minLength: DECK_CARDS - REQUIRED.length,
        maxLength: DECK_CARDS - REQUIRED.length,
      })
      .chain((rest) => {
        const dealt = [...REQUIRED, ...rest];
        return fc.shuffledSubarray(dealt, { minLength: dealt.length, maxLength: dealt.length });
      }),
    fc.array(fc.option(fc.string({ minLength: 1, maxLength: 12 }), { nil: undefined }), {
      minLength: LOADOUT_DECKS,
      maxLength: LOADOUT_DECKS,
    }),
  )
  .map(([ids, names]) => ({
    decks: Array.from({ length: LOADOUT_DECKS }, (_, i) => {
      const cards = ids.slice(i * DECK_SIZE, (i + 1) * DECK_SIZE);
      const name = names[i];
      return name === undefined ? { cards } : { name, cards };
    }),
    catalog: catalog(),
    collection: collection(),
  }));

describe("properties over random loadouts", () => {
  it("accepts every legal loadout, whatever the split, order or names", () => {
    fc.assert(
      fc.property(legalLoadoutArb, (input) => {
        expect(validateLoadout(input)).toEqual({ ok: true });
      }),
      { seed: SEED, numRuns: NUM_RUNS },
    );
  });

  it("reports exactly the one rule a single injection breaks", () => {
    fc.assert(
      fc.property(legalLoadoutArb, fc.constantFrom(...INJECTIONS), (input, injection) => {
        expect(rulesOf(validateLoadout(injection.apply(input)))).toEqual([injection.rule]);
      }),
      { seed: SEED, numRuns: NUM_RUNS },
    );
  });
});
