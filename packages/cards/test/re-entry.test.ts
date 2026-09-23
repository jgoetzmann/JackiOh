// Leaving the field, coming back, and what travels with a card between zones (SPEC §3.2, §4.5, R11,
// R13, R47, R57, R64, R76, R78, R83, R174, R175). Found by the polish-4 edge-case hunt
// (docs/polish/4-edge-cases.md, lenses L1, L2 and L8); every case here failed before its fix.
//
//  - R174: #50 Kpop Fanatic's delayed steal fizzles on a target that has left the field since it was
//    chosen, even when the same card is back — bounced and replayed, or returned by Reborn — and on
//    a target dormant under a Stack pile when it fires (R13, R76).
//  - R175: Reborn brings back a unit token, and a Reborn unit that died on top of a Stack pile
//    returns on top of it.
//  - §3.2 and R13: an aura does not reach a card dormant under a Stack pile.
//  - §7, R41, R57: a copy keeps a Radiant Bread Token's Armor X beside its X/X.
//  - §8 #52, R4, R78: a card radiant Silly Silas bounces into a full hand is burned without its
//    "costing 0".
//  - Round 4, lens L2. R77, R175: a Fuse onto a token summoned X/X sums that X/X, not the printed
//    0/0, and the Bread Token's Armor X stands for its own Armor only. R35, §3.2: a Transform
//    replaces a card in a Locked zone, since the Lock refuses summons and a Replace is none.

import type { Selection } from "@jackioh/shared";
import { effectiveCost, type CardInstance } from "@jackioh/engine";
import { describe, expect, it } from "vitest";
import { scenario, type Scenario } from "./_harness";

const RIGHT_HOUSE = "core-003";
const STOCKPILE = "core-005";
const MAGIC_JAMMED = "core-036";
const TRANSMOGULATE = "core-083";
const COMBO_INDEX = "core-093";
const HEROIC_POWER = "core-098";
const VANILLA = "core-008";
const HIT_JOB = "core-016";
const FLOOD = "core-017";
const BREAD_AND_BUTTER = "core-018";
const CUBE = "core-022";
const SEVEN_SEVEN = "core-025";
const AURA = "core-046";
const MIND_CONTROL = "core-049";
const KPOP = "core-050";
const SILAS = "core-052";
const JILLIAX = "core-056";
const SURGERY = "core-063";
const REMINISCE = "core-072";
const SAINTESS = "core-081";
const EXPERIMENTATION = "core-085";
const FIENDER = "core-092";
const RUSH_TOKEN = "core-t-rush";
const FELINOR_TOKEN = "core-t-felinor";
const BREAD = "core-t-bread";
const LIBRARY = [VANILLA, VANILLA, VANILLA, VANILLA, VANILLA, VANILLA];

const at = (card: CardInstance): Selection[] => [{ pick: "instance", instanceId: card.id }];

function unitAt(g: Scenario, player: "p1" | "p2", lane: number): CardInstance {
  const card = g.unit(player, lane);
  if (card === null) throw new Error(`setup: ${player} should hold a unit in lane ${lane}`);
  return card;
}

/** Every card in a unit zone, top first (§3.2). */
function pileOf(g: Scenario, player: "p1" | "p2", lane: number): string[] {
  return (g.state.players[player].units[lane - 1] ?? []).map((card) => card.id);
}

describe("R174: #50 Kpop Fanatic's delayed steal and a target that left the field", () => {
  it("R174 the steal fizzles on a target now dormant under a Stack pile, and the pile stays whole (R13, R76)", () => {
    const g = scenario({
      p1: { hand: [KPOP, VANILLA], field: [{ def: VANILLA, lane: 1 }], library: [...LIBRARY] },
      p2: { hand: [FIENDER, VANILLA], field: [{ def: SEVEN_SEVEN, lane: 2 }], library: [...LIBRARY] },
    });
    const prey = unitAt(g, "p2", 2);
    g.play(KPOP, { targets: at(prey) });
    g.endTurn();

    // p2 stacks Felinor Fiender onto the prey's zone: the prey is dormant (§3.2, R13).
    g.play(FIENDER, { zone: 2 });
    const fiender = unitAt(g, "p2", 2);
    expect(fiender.defId).toBe(FIENDER);
    g.endTurn();
    expect(g.state.active).toBe("p1");

    // Only the top of a pile is on the field, so there is nothing to take (R13, R76).
    expect(g.card(prey).controller).toBe("p2");
    expect(pileOf(g, "p2", 2)).toEqual([fiender.id, prey.id]);
    expect(g.state.players.p1.units.flat().some((card) => card?.id === prey.id)).toBe(false);
  });

  it("R174 the steal fizzles on a target that was bounced and replayed before it fired (R76, R78)", () => {
    const g = scenario({
      p1: { hand: [KPOP, VANILLA], field: [{ def: VANILLA, lane: 1 }], library: [...LIBRARY] },
      p2: { hand: [FLOOD, SEVEN_SEVEN], field: [{ def: VANILLA, lane: 2 }], library: [...LIBRARY] },
    });
    const prey = unitAt(g, "p2", 2);
    g.play(KPOP, { targets: at(prey) });
    g.endTurn();

    // p2 bounces every unit, the prey included, and plays the prey again.
    g.play(FLOOD);
    g.expectInZone(prey, "hand");
    g.play(prey, { zone: 2 });
    expect(g.unit("p2", 2)?.id).toBe(prey.id);
    g.endTurn();
    expect(g.state.active).toBe("p1");

    // The card on the field now is a new arrival (R78), which R76's steal never chose.
    expect(g.card(prey).controller).toBe("p2");
    expect(g.unit("p2", 2)?.id).toBe(prey.id);
    expect(g.lastEvents.some((event) => event.type === "controlChanged")).toBe(false);
  });

  it("R174 the steal fizzles on a target that died and came back through Reborn (R76, R83)", () => {
    const g = scenario({
      p1: { hand: [KPOP, HIT_JOB, VANILLA], field: [{ def: VANILLA, lane: 1 }], library: [...LIBRARY] },
      p2: { hand: [VANILLA], field: [{ def: RIGHT_HOUSE, lane: 2 }, { def: VANILLA, lane: 4 }], library: [...LIBRARY] },
    });
    const prey = unitAt(g, "p2", 2);
    g.play(KPOP, { targets: at(prey) });
    g.play(HIT_JOB, { targets: at(prey) });
    // It died and its Reborn body is back in its reserved zone, the same instance id (§4.5 step 4).
    expect(g.unit("p2", 2)?.id).toBe(prey.id);
    expect(g.card(prey).rebornSpent).toBe(true);
    expect(g.events.some((event) => event.type === "destroyed" && event.instanceId === prey.id)).toBe(true);

    g.endTurn().endTurn();
    expect(g.state.active).toBe("p1");
    expect(g.card(prey).controller).toBe("p2");
  });

  it("R76 a target that stayed on the field is still stolen, so the fizzles above are the left-the-field cases alone", () => {
    const g = scenario({
      p1: { hand: [KPOP, VANILLA], field: [{ def: VANILLA, lane: 1 }], library: [...LIBRARY] },
      p2: { hand: [VANILLA], field: [{ def: SEVEN_SEVEN, lane: 2 }], library: [...LIBRARY] },
    });
    const prey = unitAt(g, "p2", 2);
    g.play(KPOP, { targets: at(prey) });
    g.endTurn().endTurn();
    expect(g.state.active).toBe("p1");
    expect(g.card(prey).controller).toBe("p1");
  });
});

describe("R175: Reborn's return for a unit token and onto a Stack pile", () => {
  it("R175 a Rush Token given Reborn comes back through Reborn, reset and sick (§6.1's pool, R21, R83)", () => {
    // On this seed Plastic Surgery's random keyword is Reborn: §6.1's pool keeps Reborn for tokens.
    const g = scenario({
      seed: "re-entry-reborn-token-4",
      p1: { hand: [SURGERY, HIT_JOB], field: [{ def: RUSH_TOKEN, lane: 1 }], library: [...LIBRARY] },
      p2: { hand: [HIT_JOB], library: [...LIBRARY] },
    });
    const token = g.card(RUSH_TOKEN);
    g.play(SURGERY, { targets: at(token) });
    expect(g.stats(token).keywords.map((k) => k.kind)).toContain("Reborn");

    g.play(HIT_JOB, { targets: at(token) });

    // §4.5 step 4: back in its zone at 1 health, without Reborn and without Surgery's buff (R78).
    g.expectInZone(token, "field");
    expect(g.unit("p1", 1)?.id).toBe(token.id);
    g.expectStats(token, { health: 1 });
    expect(g.stats(token).keywords.map((k) => k.kind)).not.toContain("Reborn");
    expect(g.card(token).summonedTurn).toBe(g.state.turn);
    // It never reached a graveyard (R11).
    expect(g.pile("p1", "graveyard").some((card) => card.id === token.id)).toBe(false);
  });

  it("R175 a Reborn unit that died on top of a Stack pile returns on top of it (R47, R64)", () => {
    // p1 holds Felinor Fiender (Stack) on a Felinor Token and an armed #85. p2 plays Right-house
    // defender, #85 fuses it onto the Fiender (R77: the Fiender instance survives with Reborn and
    // Stack), and p2 destroys the fused card with Hit Job.
    const g = scenario({
      active: "p2",
      turn: 10,
      p1: {
        field: [{ def: FELINOR_TOKEN, lane: 1 }, { def: FIENDER, stack: true }],
        backrow: [{ def: EXPERIMENTATION, lane: 1 }],
        hand: [VANILLA],
        library: [...LIBRARY],
      },
      p2: { hand: [RIGHT_HOUSE, HIT_JOB], library: [...LIBRARY] },
    });
    const fiender = g.card(FIENDER);
    const token = g.card(FELINOR_TOKEN);

    g.play(RIGHT_HOUSE);
    const fused = g.card(fiender);
    expect(fused.defId).not.toBe(FIENDER);
    expect(g.stats(fused).keywords.map((k) => k.kind)).toEqual(expect.arrayContaining(["Reborn", "Stack"]));
    expect(pileOf(g, "p1", 1)).toEqual([fiender.id, token.id]);

    g.play(HIT_JOB, { targets: at(fused) });

    // The zone was reserved and never Locked, so the body returns — on top, the token dormant again.
    g.expectInZone(fiender, "field");
    expect(pileOf(g, "p1", 1)).toEqual([fiender.id, token.id]);
    expect(g.card(fiender).rebornSpent).toBe(true);
  });
});

describe("§3.2 and R13: a card dormant under a Stack pile", () => {
  it("R13 an aura does not reach a dormant card, so Suppressive Aura cannot kill it under the pile", () => {
    const g = scenario({
      p1: {
        hand: [AURA, HIT_JOB],
        field: [{ def: VANILLA, lane: 1 }, { def: FIENDER, stack: true }],
        library: [...LIBRARY],
      },
      p2: { hand: [HIT_JOB], library: [...LIBRARY] },
    });
    const dormant = g.card(VANILLA);
    const fiender = g.card(FIENDER);
    expect(pileOf(g, "p1", 1)).toEqual([fiender.id, dormant.id]);

    // Paid 4: "all units −5/−5". Mr. Vanilla is 3/3 and dormant; Felinor Fiender 5/7 is on top.
    g.play(AURA, { embiggen: true });

    g.expectInZone(dormant, "field");
    expect(pileOf(g, "p1", 1)).toEqual([fiender.id, dormant.id]);
    // The dormant card keeps its own stats; the top of the pile takes the aura.
    g.expectStats(dormant, { attack: 3, health: 3 });
  });
});

describe("§7, R41, R57: what a copy keeps", () => {
  it("R57 Carnivorous Cube's copies of a Radiant Bread Token keep its Armor X beside its X/X (§7, R41)", () => {
    const g = scenario({
      p1: {
        field: [{ def: SAINTESS, lane: 2 }],
        backrow: [{ def: BREAD_AND_BUTTER, lane: 1 }],
        hand: [CUBE, VANILLA],
        library: [...LIBRARY],
        mana: 3,
      },
      p2: { hand: [HIT_JOB, JILLIAX, HIT_JOB], library: [...LIBRARY] },
    });
    const saintess = g.card(SAINTESS);

    // p1 ends its turn with 3 unspent: Bread and Butter summons a 3/3 Bread Token, Armor X of 3.
    g.endTurn();
    const bread = unitAt(g, "p1", 1);
    expect(bread.defId).toBe(BREAD);
    g.expectStats(bread, { attack: 3, health: 3 });

    // p2 kills the Saintess: her Death makes every other p1 unit Radiant, so the Bread is Armor 3.
    g.play(HIT_JOB, { targets: at(saintess) });
    g.play(JILLIAX);
    expect(g.card(bread).radiant).toBe(true);
    expect(g.stats(bread).armor).toBe(3);
    g.endTurn();

    // p1 eats it with Carnivorous Cube, and p2 kills the Cube on its next turn.
    expect(g.state.active).toBe("p1");
    g.play(CUBE, { targets: at(bread) });
    const cube = g.card(CUBE);
    g.endTurn();
    g.play(HIT_JOB, { targets: at(cube) });

    const copies = g.state.players.p1.units
      .flatMap((pile) => pile ?? [])
      .filter((card) => card.defId === BREAD && card.radiant && card.statsOverride?.attack === 3);
    expect(copies).toHaveLength(2);
    for (const copy of copies) {
      g.expectStats(copy, { attack: 3, health: 3 });
      expect(g.stats(copy).armor).toBe(3);
    }
  });
});

describe("§8 #52, R4, R78: a rider on a card that never reached the hand", () => {
  it("R4 a card radiant Silly Silas bounces into a full hand is burned without its 'costing 0' (R78)", () => {
    const fillers = Array.from({ length: 9 }, () => VANILLA);
    const g = scenario({
      p1: {
        hand: [MIND_CONTROL, { def: SILAS, radiant: true }, HIT_JOB],
        mana: 10,
        library: [...LIBRARY],
      },
      p2: {
        hand: [REMINISCE, ...fillers],
        field: [{ def: SEVEN_SEVEN, lane: 1 }],
        library: [...LIBRARY],
      },
    });
    const seven = g.card(SEVEN_SEVEN);
    expect(g.state.players.p2.hand).toHaveLength(10);

    // p1 steals the 7/7 into its own lane 1 (R15). Rotating left, p1's lane 1 would move to p2's
    // lane 1 — to the opponent — so radiant Silas bounces it to its OWNER's hand "costing 0"
    // (R12), but that hand is full, so it is burned instead (§2.4, R4).
    g.play(MIND_CONTROL, { targets: at(seven) });
    expect(g.unit("p1", 1)?.id).toBe(seven.id);
    g.play(SILAS, { zone: 3, modes: ["left"] });
    g.expectInZone(seven, "graveyard");
    expect(g.card(seven).costOverride).toBeUndefined();

    // p2 Reminisces it back: "it costs 1 less", so the printed 4 becomes 3.
    g.endTurn();
    expect(g.state.active).toBe("p2");
    g.play(REMINISCE);
    g.answer(seven.id);
    g.expectInZone(seven, "hand");
    expect(effectiveCost(g.state, g.card(seven))).toBe(3);
    expect(g.card(seven).costOverride).toBeUndefined();
  });
});

describe("R77, R175: a Fuse onto a token summoned X/X", () => {
  it("R77 Unlicensed Experimentation fusing a 7/7 onto a 3/3 Bread Token makes a 10/10, not a 3/3 (R175, §7)", () => {
    const g = scenario({
      active: "p2",
      turn: 10,
      p1: {
        field: [{ def: BREAD, lane: 1, statsOverride: { attack: 3, health: 3 } }],
        backrow: [{ def: EXPERIMENTATION, lane: 1 }],
        hand: [STOCKPILE],
        library: [...LIBRARY],
      },
      p2: { hand: [SEVEN_SEVEN, STOCKPILE], library: [...LIBRARY] },
    });
    const bread = unitAt(g, "p1", 1);
    g.expectStats(bread, { attack: 3, maxHealth: 3 });

    g.play(SEVEN_SEVEN, { zone: 1 });

    // R77 keeps the Bread Token's instance, and sums the two faces: its X/X and the 7/7.
    const fused = g.card(bread);
    expect(fused.defId).not.toBe(BREAD);
    expect(g.unit("p2", 1)).toBeNull();
    g.expectStats(fused, { attack: 10, maxHealth: 10 });
  });

  it("R77 a 7/7's Armor 7 fused onto Bread and Butter's Bread Token stays Armor 7, not the token's X (§7)", () => {
    const g = scenario({
      p1: {
        hand: [STOCKPILE],
        backrow: [{ def: BREAD_AND_BUTTER, lane: 1 }, { def: EXPERIMENTATION, lane: 2 }],
        library: [...LIBRARY],
      },
      p2: { hand: [SEVEN_SEVEN, STOCKPILE], library: [...LIBRARY] },
    });

    // p1 ends the turn with 4 unspent: a 4/4 Bread Token, whose radiant "Armor X" is carried as 4.
    g.endTurn();
    const bread = unitAt(g, "p1", 1);
    expect(bread.defId).toBe(BREAD);
    g.expectStats(bread, { attack: 4, maxHealth: 4 });
    expect(g.stats(bread).armor).toBe(0);

    g.play(SEVEN_SEVEN, { zone: 1 });

    // R77 unions the keywords: the base Bread Token prints none, the 7/7 prints Armor 7. The
    // token's X belongs to the Bread Token's own radiant Armor, not to every Armor on the face.
    const fused = g.card(bread);
    expect(fused.defId).not.toBe(BREAD);
    expect(g.stats(fused).keywords).toContainEqual({ kind: "Armor", n: 7 });
    expect(g.stats(fused).armor).toBe(7);
  });
});

describe("R35, §3.2: a Transform replaces the occupant of a Locked zone", () => {
  it("R35 Transmogulate replaces a Heroic Power that Magic Jammed could not destroy, although its zone is Locked (§3.2, R46)", () => {
    const g = scenario({
      p1: {
        hand: [MAGIC_JAMMED, TRANSMOGULATE, STOCKPILE],
        backrow: [{ def: HEROIC_POWER, lane: 1 }],
        library: [...LIBRARY],
      },
      p2: { hand: [STOCKPILE], library: [...LIBRARY] },
    });
    const power = g.card(HEROIC_POWER);

    // Indestructible: the Field Spell simply stays (R46), in a zone that is now Locked.
    g.play(MAGIC_JAMMED, { targets: at(power) });
    expect(g.backrow("p1", 1)?.id).toBe(power.id);
    expect(g.state.players.p1.locks.backrow[0]).toBe(true);

    // R35: every board card but an Immutable one is replaced in place; the lock only stops summons
    // and "the current occupant is unaffected" (§3.2). The one Legendary Field Spell is #93.
    g.play(TRANSMOGULATE);
    expect(g.backrow("p1", 1)?.defId).toBe(COMBO_INDEX);
    g.expectInZone(power, "gone");
  });
});
