// #7 Jewelosco Scarab — SPEC §8.1 row 7, BUILD M4-T4 must-pass: "Discover offers 3 distinct 2-cost
// non-token cards, never #7; radiant 3-cost pick costs 2".
//
// This is the one prompting card in #1-20, so every test here answers the prompt and asserts what
// follows: the pick lands in hand, the prompt closes, and the game carries on (§10.6's re-entrant
// reducer, R81). The offered options are read out of `viewFor` rather than out of `state.pending`,
// because §10.8 is what a player actually sees and only the chooser sees the options.

import { describe, expect, it } from "vitest";
import { cardDef } from "../src/catalog-data";
import { scenario, type Scenario } from "./_harness";

/** The open Discover prompt as its owner sees it (§10.8). */
function discover(s: Scenario) {
  const pending = s.view("p1").pending;
  if (pending === null) throw new Error("no prompt is open for p1");
  if (!pending.forYou) throw new Error(`the open prompt belongs to ${pending.pendingFor}`);
  return pending;
}

/** §10.8: a viewer's own hand is full cards, the opponent's a count — narrow to the cards. */
function handView(s: Scenario) {
  const hand = s.view("p1").you.hand;
  if (!Array.isArray(hand)) throw new Error("p1's own hand should be full cards (§10.8)");
  return hand;
}

/** The def ids a Discover put on offer, in the order they were offered. */
function offered(s: Scenario): string[] {
  return discover(s).options.map((option) => {
    if (option.defId === undefined) throw new Error(`option ${option.key} carries no def id`);
    return option.defId;
  });
}

describe("#7 Jewelosco Scarab (§8.1 row 7)", () => {
  it("base Cry offers 3 distinct 2-cost non-token cards, and never #7 itself (§5.1)", () => {
    const s = scenario({
      seed: "core-007-offer",
      p1: { hand: ["core-007"], mana: 4, library: ["core-020"] },
      p2: { field: ["core-020"] },
    });

    s.play("core-007");

    const prompt = discover(s);
    expect(prompt.kind).toBe("discover");
    expect(prompt.min).toBe(1);
    expect(prompt.max).toBe(1);

    const ids = offered(s);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) {
      const def = cardDef(id);
      expect(def.cost).toBe(2);
      expect(def.token).toBe(false);
      expect(def.tags).not.toContain("Token");
      // §5.1: a random pool never offers the card that generated it. `discoverFromCatalog` adds
      // that exclusion itself from the running instance, so the card file does not repeat it.
      expect(def.index).not.toBe("7");
      expect(def.id).not.toBe("core-007");
    }

    // The unit is on the field while its Cry is still resolving (§10.5 step 4 before step 5).
    s.expectStats("core-007", { attack: 1, health: 1, maxHealth: 1 });
  });

  it("R81 the answer puts the chosen card in hand and the sequence resumes", () => {
    const s = scenario({
      seed: "core-007-answer",
      p1: { hand: ["core-007", "core-011"], mana: 4, library: ["core-020"] },
      p2: { field: ["core-020"] },
    });

    s.play("core-007");
    const chosen = offered(s)[1] as string;
    s.answer(chosen);

    // The prompt is closed and the picked definition is a new card in the chooser's hand.
    expect(s.view("p1").pending).toBeNull();
    const added = s.hand("p1").filter((card) => card.defId === chosen);
    expect(added).toHaveLength(1);
    s.expectInZone(added[0] as (typeof added)[number], "hand");
    s.expectEvents("cardPlayed", "promptOpened", "promptAnswered", "addedToHand");

    // Base takes no discount: the card is in hand at its printed 2 (R65).
    const picked = added[0] as (typeof added)[number];
    expect(handView(s).find((card) => card.instanceId === picked.id)?.cost).toBe(2);

    // The turn carries on after the answer: the rest of the hand is still playable.
    s.play("core-011");
    s.expectStats("core-011", { attack: 3, health: 3 });
  });

  it("an empty pool would fizzle, and the answer only ever adds one card", () => {
    const s = scenario({
      seed: "core-007-single",
      p1: { hand: ["core-007"], mana: 4, library: ["core-020"] },
    });

    s.play("core-007");
    const ids = offered(s);
    s.answer(ids[0] as string);

    // Exactly one card entered the hand: the one that was picked, not the three on offer.
    expect(s.hand("p1")).toHaveLength(1);
    expect((s.hand("p1")[0] as { defId: string }).defId).toBe(ids[0]);
  });

  it("radiant Cry Discovers a 3-cost card and it costs 2 (§8.1, R65)", () => {
    const s = scenario({
      seed: "core-007-radiant",
      // #26 Glowy Jelly Bean makes a chosen hand card Radiant, which is the only way to hold a
      // Radiant card in hand: `SideSetup.hand` takes def ids only (see the report's harness gap).
      p1: { hand: ["core-026", "core-007"], mana: 8, library: ["core-020"] },
      p2: { field: ["core-020"] },
    });
    const scarab = s.card("core-007");

    s.play("core-026", { targets: [{ pick: "instance", instanceId: scarab.id }] });
    s.play(scarab);

    // The radiant face is a 2/2 (printed, §10.4 layer 1).
    s.expectStats(scarab, { attack: 2, health: 2, maxHealth: 2 });

    const ids = offered(s);
    expect(ids).toHaveLength(3);
    for (const id of ids) {
      const def = cardDef(id);
      expect(def.cost).toBe(3);
      expect(def.token).toBe(false);
      expect(def.index).not.toBe("7");
    }

    const chosen = ids[0] as string;
    s.answer(chosen);

    const added = s.hand("p1").find((card) => card.defId === chosen);
    expect(added).toBeDefined();
    const inHand = handView(s).find((card) => card.instanceId === added?.id);
    // "It costs 1 less": a permanent −1 costMod on the chosen card, so 3 reads as 2 (R65, R78).
    expect(inHand?.cost).toBe(2);
  });
});
