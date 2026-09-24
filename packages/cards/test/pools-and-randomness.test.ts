// Random pools and the draws they take (SPEC §5.1, §10.7, R60, R129). Found by the polish-4
// edge-case hunt, round 4 (docs/polish/4-edge-cases.md, lens "card by card"); every case here failed
// before its fix.
//
//  - §5.1: a random pool never offers the card that generated it, unless the card names the pool
//    itself. #95's "add 3 random cards" named no pool; and a card's own exclusion (§8 #54's "pool
//    excluding #54") holds when a fused card runs that text, whose own definition is a transient id.
//  - R129: an effect that finds nothing to do draws no random numbers — #23 with no non-Radiant hand
//    card, #83 over an Immutable board card, #67 into an occupied lane, #95's Units into a full row.
//  - §10.7: the Zephyrs scorer's "lethal available" needs a Charge unit that can reach the field and
//    then the hero.

import type { GameEvent } from "@jackioh/shared";
import { createRng, subsystems } from "@jackioh/engine";
import { describe, expect, it } from "vitest";
import { cardDef } from "../src/catalog-data";
import { scenario } from "./_harness";

const MANA_WELL = "core-006";
const VANILLA = "core-008";
const BIG_D = "core-001";
const MENACE = "core-019";
const DREAM = "core-023";
const DUELIST = "core-045";
const STRAAZA = "core-054";
const JILLIAX = "core-056";
const OOMEN = "core-067";
const TRANSMOGULATE = "core-083";
const CALL_TO_CHAOS = "core-095";
const ZEPHYRS = "core-097";
const CRAFT = "core-099";

function eventsOf<T extends GameEvent["type"]>(events: readonly GameEvent[], type: T): Extract<GameEvent, { type: T }>[] {
  return events.filter((event): event is Extract<GameEvent, { type: T }> => event.type === type);
}

describe("§5.1: a random pool never offers the card that generated it", () => {
  it("§5.1 Call to Chaos's 'add 3 random cards' never adds a Call to Chaos (§8 #95, §10.7)", () => {
    const SEED = "chaos-pool-probe";
    const added: string[] = [];
    let plays = 0;
    for (let cursor = 0; cursor < 6000 && plays < 150; cursor += 1) {
      const rolled = subsystems.rollChaosEffects(createRng(SEED, cursor), false)[0]?.name;
      if (rolled !== "add") continue;
      plays += 1;
      const s = scenario({ seed: SEED, p1: { hand: [CALL_TO_CHAOS, MENACE], mana: 8 } });
      s.state.rngCursor = cursor;
      s.play(CALL_TO_CHAOS);
      added.push(...eventsOf(s.lastEvents, "addedToHand").map((event) => event.defId));
    }
    expect(plays).toBeGreaterThan(50);
    expect(added.length).toBeGreaterThan(150);
    expect(added).not.toContain(CALL_TO_CHAOS);
  });

  it("§5.1 a crafted card carrying #54 Straaza's text still never adds a Straaza (§8 #54 'pool excluding #54', R102)", () => {
    // Craft a Card at this cursor Discovers #54 Straaza and then #56 Jilliax (a keyword-only body).
    const SEED = "craft-straaza";
    const CRAFT_CURSOR = 28;
    const added: string[] = [];
    for (let cursor = 0; cursor < 200; cursor += 1) {
      const s = scenario({ seed: SEED, p1: { hand: [CRAFT, MENACE], mana: 8 } });
      s.state.rngCursor = CRAFT_CURSOR;
      s.play(CRAFT);
      s.answer(`mode:${STRAAZA}`);
      s.answer(`mode:${JILLIAX}`);
      const crafted = s.hand("p1").find((card) => card.defId.includes(STRAAZA));
      if (crafted === undefined) throw new Error("the crafted Straaza + Jilliax should be in hand");
      s.state.rngCursor = cursor;
      s.play(crafted, { zone: 1 });
      added.push(...eventsOf(s.lastEvents, "addedToHand").map((event) => event.defId));
    }
    expect(added.length).toBe(400);
    expect(added).not.toContain(STRAAZA);
  });
});

describe("R129: an effect that finds nothing to do draws no random numbers", () => {
  it("R129 Reoccurring Dream with no hand card left to make Radiant draws no randomness (R60)", () => {
    for (const radiant of [false, true]) {
      const s = scenario({
        p1: { hand: [{ def: DREAM, radiant }], field: [VANILLA], library: [VANILLA] },
        p2: { hand: [VANILLA], library: [VANILLA] },
      });
      const before = s.state.rngCursor;
      s.play(DREAM);
      // Nothing is left in the hand, so "a random card in your hand becomes Radiant" finds nothing.
      expect(s.hand("p1")).toHaveLength(0);
      expect(s.state.rngCursor).toBe(before);
    }
  });

  it("R129 Transmogulate draws no randomness for an Immutable board card it leaves standing (R35, R23)", () => {
    const s = scenario({ p1: { hand: [TRANSMOGULATE], field: [VANILLA], mana: 4 } });
    const vanilla = s.unit("p1", 1);
    const before = s.state.rngCursor;
    s.play(TRANSMOGULATE);
    // Mr. Vanilla is Immutable (R23, R35) and the library, graveyard and exile are empty: nothing is
    // replaced, so the effect found nothing to do.
    expect(s.unit("p1", 1)?.id).toBe(vanilla?.id);
    expect(s.state.rngCursor).toBe(before);
  });

  it("R129 Zoomerbin Oomen whose lane's backrow zone is occupied draws no randomness for the Trap it cannot summon (R47)", () => {
    for (const radiant of [false, true]) {
      const s = scenario({
        p1: { hand: [{ def: OOMEN, radiant }, VANILLA], backrow: [{ def: MANA_WELL, lane: 2 }], mana: 4 },
      });
      const before = s.state.rngCursor;
      s.play(OOMEN, { zone: 2 });
      // §8 #67: "zone occupied or Locked → fizzles", so the Cry found nothing to do.
      expect(s.backrow("p1", 2)?.defId).toBe(MANA_WELL);
      expect(eventsOf(s.lastEvents, "summoned").filter((event) => event.row === "backrow")).toHaveLength(0);
      expect(s.state.rngCursor).toBe(before);
    }
  });

  it("R129 Call to Chaos's 'summon 3 random 3-cost Units' into a full unit row draws no randomness past the roll (R64)", () => {
    const SEED = "chaos-full-row";
    let cursor = 0;
    while (subsystems.rollChaosEffects(createRng(SEED, cursor), false)[0]?.name !== "units") cursor += 1;
    const s = scenario({
      seed: SEED,
      p1: { hand: [CALL_TO_CHAOS, MENACE], field: [VANILLA, VANILLA, VANILLA, VANILLA, VANILLA], mana: 8 },
    });
    s.state.rngCursor = cursor;
    s.play(CALL_TO_CHAOS);
    // The roll is the one draw the card makes; every summon then fails on the full row (§3.2).
    expect(eventsOf(s.lastEvents, "summoned").filter((event) => event.defId !== CALL_TO_CHAOS)).toHaveLength(0);
    expect(s.state.rngCursor).toBe(cursor + 1);
  });
});

describe("§10.7: the Zephyrs scorer's 'lethal available'", () => {
  it("§10.7 Zephyrs does not score a Charge unit as lethal when an enemy Taunt stands in its way, or when it has no zone to enter (§4.2 step 3, §3.2, R29)", () => {
    // p2's hero is at 3 behind #19 Midrange Menace (9/9 Taunt). #45 Deft Duelist (4/3 Charge, cost
    // 2) would be lethal on an open board, but §4.2 step 3 makes it attack the Menace.
    const s = scenario({
      p1: { hand: [ZEPHYRS], mana: 4 },
      p2: { field: [MENACE], health: 3 },
    });
    expect(subsystems.scoreDef(s.state, "p1", cardDef(DUELIST)).priority).not.toBe("lethal");

    // The same card on an open board but with no free unit zone to play it into (§3.2) is no
    // lethal either: it cannot reach the field this turn at all.
    const full = scenario({
      p1: { hand: [ZEPHYRS], field: [BIG_D, BIG_D, BIG_D, BIG_D, BIG_D], mana: 4 },
      p2: { health: 3 },
    });
    expect(subsystems.scoreDef(full.state, "p1", cardDef(DUELIST)).priority).not.toBe("lethal");

    // And on an open board with room it is lethal, which is what the priority is for.
    const open = scenario({ p1: { hand: [ZEPHYRS], mana: 4 }, p2: { health: 3 } });
    expect(subsystems.scoreDef(open.state, "p1", cardDef(DUELIST)).priority).toBe("lethal");
  });
});
