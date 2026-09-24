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
//  - Round 5, lens L2. R174: a later part of one effect list is aimed at the stay the play chose, so
//    a fused card's part fizzles on a card an earlier part took off the field — #68's damage on the
//    meal's Reborn body, #61's copy of a card in a graveyard, #50's steal of a card bounced and
//    replayed. #85 fuses the opponent's played card onto a unit, which is bounced and played again.
//  - Round 6, lens L2. R174, R113: that holds across a prompt too — a crafted Cube + Scarab +
//    Sorcerer's Discover splits the list across actions, and the Sorcerer's part still fizzles on the
//    Reborn body of the unit the Cube's part ate.
//  - Round 7, lens L2. R174: it holds for "this" card as well — a crafted Silas + Gary that its own
//    Silas part bounced to hand is not buffed there by its Gary part.
//  - Round 8, lens L2. R174: a Transform takes the card off the field like any departure, so a
//    second Sheepish is not offered the play the first turned into a Sheep. R102, R212: a card a
//    Fuse kept is on the same stay, so a trigger it queued before the Fuse (Fed Fauci's Plague Token
//    for the Cry that hit it) still resolves under the fused definition's namespaced id.
//  - Round 9, lens "re-entry and stays". R174: #22 reads its meal on the stay the play chose, so a
//    crafted Cube + Cube naming one Reborn unit twice remembers it once; and a card the play's own
//    Stack card buried is not on the field for its Cry (§3.2, R13). §4.5 step 4: the Reborn bodies of
//    one check return together, each at 1 health once all stand. R102, R77: what a card a Fuse kept
//    remembered moves with its texts, so the texts fused onto it read none of it.

import type { Selection } from "@jackioh/shared";
import {
  INGREDIENTS_KEY,
  createRng,
  effectiveCost,
  newInstance,
  subsystems,
  type CardInstance,
  type EngineSink,
} from "@jackioh/engine";
import { describe, expect, it } from "vitest";
import { scenario, type Scenario } from "./_harness";

const RIGHT_HOUSE = "core-003";
const STOCKPILE = "core-005";
const MAGIC_JAMMED = "core-036";
const TRANSMOGULATE = "core-083";
const MANA_WELL = "core-006";
const TIMMY = "core-011";
const POSTDOC = "core-061";
const SORCERER = "core-068";
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
const HINDER = "core-021";
const SHEEPISH = "core-041";
const SHEEP = "core-t-sheep";
const FAUCI = "core-091";
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

/** Hand the turn over until `player` is the active one (R82 can end a turn with nothing left in it). */
function untilActive(g: Scenario, player: "p1" | "p2"): void {
  if (g.state.active !== player) g.endTurn();
  if (g.state.active !== player) g.endTurn();
  expect(g.state.active).toBe(player);
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

describe("R174: a later part of one Cry meets the stay the play chose", () => {
  it("R174 a fused Cube+Sorcerer's damage aimed at the meal does not land on the meal's Reborn body (R83)", () => {
    const g = scenario({
      p1: { hand: [CUBE, VANILLA], library: [...LIBRARY] },
      p2: {
        hand: [{ def: SILAS, radiant: true }, SAINTESS, VANILLA],
        field: [{ def: SORCERER, lane: 5 }],
        backrow: [{ def: EXPERIMENTATION, lane: 3 }],
        library: [...LIBRARY],
      },
    });
    const sorcerer = unitAt(g, "p2", 5);
    // p1 plays the Cube with nothing to eat (R41); p2's #85 fuses it onto the Sorcerer (R77).
    g.play(CUBE, { zone: 2 });
    const fused = g.card(sorcerer);
    expect(fused.defId).not.toBe(SORCERER);
    g.endTurn();
    // p2's radiant Silas rotates right: the fused unit in lane 5 would cross, so it is bounced to
    // p2's hand costing 0 (§8 #52 radiant, R14).
    g.play(g.hand("p2").find((card) => card.defId === SILAS) as CardInstance, { zone: 3, modes: ["right"] });
    g.expectInZone(fused, "hand");
    g.play(SAINTESS, { zone: 1 });
    const saintess = unitAt(g, "p2", 1);
    // Replayed: the fused Cry runs the Cube's part (eat the Saintess) and then the Sorcerer's
    // (4 damage), both aimed at the Saintess.
    g.play(fused, { zone: 5, targets: [...at(saintess), ...at(saintess)] });
    // The meal died and came back through Reborn (§4.5 step 4), a new arrival (R83): the damage aimed
    // at the stay that died fizzles (R174), so the body stands at 1 health.
    g.expectInZone(saintess, "field");
    expect(g.card(saintess).rebornSpent).toBe(true);
    g.expectStats(saintess, { health: 1 });
  });

  it("R174 a fused Cube+Postdoc summons no copy of the meal its own Cube part sacrificed (R57)", () => {
    const g = scenario({
      p1: { hand: [CUBE, VANILLA], library: [...LIBRARY] },
      p2: {
        hand: [{ def: SILAS, radiant: true }, TIMMY, VANILLA],
        field: [{ def: POSTDOC, lane: 5 }],
        backrow: [{ def: EXPERIMENTATION, lane: 3 }],
        library: [...LIBRARY],
      },
    });
    const postdoc = unitAt(g, "p2", 5);
    g.play(CUBE, { zone: 2 });
    const fused = g.card(postdoc);
    expect(fused.defId).not.toBe(POSTDOC);
    g.endTurn();
    g.play(g.hand("p2").find((card) => card.defId === SILAS) as CardInstance, { zone: 3, modes: ["right"] });
    g.expectInZone(fused, "hand");
    g.play(TIMMY, { zone: 1 });
    const timmy = unitAt(g, "p2", 1);
    const before = g.events.length;
    // The Cube's part eats Timmy, and the Postdoc's part asks for a Vanilla copy of the same Timmy.
    g.play(fused, { zone: 5, targets: [...at(timmy), ...at(timmy)] });
    g.expectInZone(timmy, "graveyard");
    // Timmy's stay on the field ended with the sacrifice: the copy aimed at it fizzles (R174), rather
    // than a copy being made of a card in a graveyard.
    const copies = g.events
      .slice(before)
      .filter((event) => event.type === "summoned" && event.defId === TIMMY);
    expect(copies).toEqual([]);
  });

  it("R174 a fused Silas+Kpop's delayed steal fizzles on a target the Silas part bounced, even once it is replayed (R76, R14)", () => {
    const g = scenario({
      p1: {
        hand: [SILAS, VANILLA, VANILLA, VANILLA],
        backrow: [{ def: MANA_WELL, lane: 1 }, { def: MANA_WELL, lane: 2 }],
        library: [...LIBRARY],
      },
      p2: {
        hand: [MAGIC_JAMMED, FLOOD, VANILLA, VANILLA],
        field: [{ def: KPOP, lane: 3 }],
        backrow: [{ def: EXPERIMENTATION, lane: 3 }],
        library: [...LIBRARY],
      },
    });
    const kpop = unitAt(g, "p2", 3);
    const jammed = g.backrow("p1", 1) as CardInstance;
    const prey = g.backrow("p1", 2) as CardInstance;
    // Turn 9, p1: Silas rotates right (from p1's seat: p1's backrow 1 -> 2, 2 -> 3; p2's Kpop 3 -> 2),
    // then p2's #85 fuses the played Silas onto the Kpop: the fused Cry runs Silas's part first.
    g.play(SILAS, { zone: 3, modes: ["right"] });
    const fused = g.card(kpop);
    expect(fused.defId).not.toBe(KPOP);
    expect(g.backrow("p1", 3)?.id).toBe(prey.id);
    expect(g.backrow("p1", 2)?.id).toBe(jammed.id);
    g.endTurn();
    // Turn 10, p2: Magic Jammed locks p1's backrow lane 2, and Flood returns the fused unit to hand.
    g.play(MAGIC_JAMMED, { targets: at(jammed) });
    g.play(FLOOD);
    g.expectInZone(fused, "hand");
    untilActive(g, "p1");
    untilActive(g, "p2");
    // Turn 12, p2: the fused card again. Silas's part rotates right (from p2's seat p1's backrow
    // 3 -> 2), and lane 2 is Locked, so the prey is bounced to p1's hand (R14); the Kpop part then
    // schedules the steal of the prey, which has already left the field.
    g.play(fused, { zone: 1, modes: ["right"], targets: at(prey) });
    g.expectInZone(prey, "hand");
    // Turn 13, p1 plays the prey again: a new arrival (R78, R83).
    untilActive(g, "p1");
    g.play(prey, { zone: 4 });
    g.expectInZone(prey, "field");
    // Turn 14, p2's start of turn: the steal was aimed at a stay that had already ended (R174, R76).
    untilActive(g, "p2");
    expect(g.card(prey).controller).toBe("p1");
  });
});

const CRAFT_A_CARD = "core-099";
const SCARAB = "core-007";
const RENO = "core-053";

function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`missing: ${what}`);
  return value;
}

describe("R174: a later part of one effect list meets the stay the play chose, across a prompt too", () => {
  it("R174 a crafted Cube + Scarab + Sorcerer that eats a Radiant Saintess does not hit her Reborn body after the Discover (R113, R83, R102)", () => {
    const g = scenario({
      seed: "r6craft-1057", // radiant Craft a Card's Discovers offer Cube, then Scarab, then Sorcerer
      p1: {
        hand: [{ def: CRAFT_A_CARD, radiant: true }, STOCKPILE],
        mana: 4,
        field: [{ def: SAINTESS, lane: 1 }],
      },
      p2: { hand: [STOCKPILE], field: [{ def: RENO, lane: 1 }] },
    });
    g.play(CRAFT_A_CARD);
    g.answer(CUBE);
    g.answer(SCARAB);
    g.answer(SORCERER);
    const card = must(g.hand("p1").find((held) => held.defId.startsWith("t-")), "the crafted card");
    const saintess = must(g.unit("p1", 1), "Radiant Saintess");
    const at = { pick: "instance" as const, instanceId: saintess.id };

    // The Cube's part eats the Saintess and she is straight back through Reborn, a new arrival
    // (R78, R83); the Scarab's part then asks, which ends the action with the Sorcerer's part owed.
    g.play(card, { zone: 2, targets: [at, at] });
    expect(g.state.pending?.kind).toBe("discover");
    expect(g.unit("p1", 1)?.id).toBe(saintess.id);
    const before = g.events.length;

    // R174: the Sorcerer's 4 damage is aimed at the stay the Cube's part ended, so it fizzles — as it
    // does when nothing asks in between. The answer resuming the list (R113) changes nothing.
    const option = must(g.state.pending?.options[0], "a Discover option");
    g.answer([option.selection]);
    const hits = g.events.slice(before).filter((event) => event.type === "damage" && event.targetId === saintess.id);
    expect({ hits: hits.length, zone: g.card(saintess).zone.z }).toEqual({ hits: 0, zone: "field" });
  });
});

// ---------------------------------------------------------------------------
// Round 7 (lens L2): "this" card is aimed at its stay too.
// ---------------------------------------------------------------------------

const GARY = "core-004";
const GLOWY_JELLY_BEAN = "core-026";

/**
 * §8 #99 Craft a Card's result, made the way the card makes it (R77): the definitions go into
 * `subsystems.fuse` as ingredients that were never cards, and the result is a fresh, non-Radiant
 * hand card costing 0.
 */
function craft(g: Scenario, player: "p1" | "p2", defIds: readonly string[]): CardInstance {
  const sink = { state: g.state, events: [], rng: createRng(g.state.seed, g.state.rngCursor) };
  const ingredients = defIds.map((defId) => newInstance(g.state, defId, player, { z: "gone", player }));
  const made = subsystems.fuse(sink, { ingredients, toHand: player });
  g.state.rngCursor = sink.rng.cursor;
  return must(made, "the crafted card");
}

describe("R174, R78: a later part of a Cry acting on the card itself, once an earlier part took it off the field", () => {
  it("R174 a Radiant crafted Silly Silas + Gary that its own Silas part bounces is not buffed in hand by its Gary part (R78, §8 #52 radiant)", () => {
    const g = scenario({
      p1: { hand: [GLOWY_JELLY_BEAN, STOCKPILE], mana: 4 },
      p2: { hand: [STOCKPILE] },
    });
    const card = craft(g, "p1", [SILAS, GARY]);
    // #26 Glowy Jelly Bean makes the crafted card Radiant, so its Silas part is radiant #52's text.
    g.play(GLOWY_JELLY_BEAN, { targets: at(card) });
    expect(g.card(card).radiant).toBe(true);

    // Played into lane 5 and rotated right: the card itself would cross to p2's side, so radiant
    // Silas bounces it to p1's hand costing 0 (R14). It has left the field, and R78 has reset it.
    g.play(card, { zone: 5, modes: ["right"] });
    g.expectInZone(card, "hand");

    // The Gary part comes next in the same Cry. It is aimed at the card on the field, whose stay has
    // ended (R174: "a fused card's part aimed at a card an earlier part has taken off the field
    // fizzles"), so the coins buff nothing — least of all a card in a hand, which R78 has just made
    // the printed card again.
    expect(g.card(card).buffs).toEqual({ attack: 0, health: 0 });
  });
});

describe("R174: a transformed card has left the field", () => {
  it("R174 a second Sheepish is not offered the play the first one already turned into a Sheep (R17, R61)", () => {
    const g = scenario({
      seed: "edge-r8-sheepish",
      p1: { hand: [TIMMY, HINDER], mana: 10 },
      p2: {
        backrow: [
          { def: SHEEPISH, lane: 1 },
          { def: SHEEPISH, lane: 2 },
        ],
      },
    });
    const first = g.backrow("p2", 1);
    const second = g.backrow("p2", 2);
    if (first === null || second === null) throw new Error("setup: two Sheepish");

    g.play(TIMMY, { zone: 1 });

    // The first Sheepish turned the played unit into a Sheep, which is no longer the card played.
    expect(unitAt(g, "p1", 1).defId).toBe(SHEEP);
    g.expectInZone(first, "graveyard");
    // A trap answering the play behind one that took the card off the field is not offered it, so
    // the second Sheepish stays armed and face-down rather than firing for nothing.
    expect(g.lastEvents.filter((event) => event.type === "trapFired")).toHaveLength(1);
    expect(g.backrow("p2", 2)?.id).toBe(second.id);
  });
});

describe("R102, R212: a card a Fuse kept is the same card on the same stay", () => {
  it("R102 Fed Fauci hit by Twisted Sorcerer's Cry and then fused with the Sorcerer by Unlicensed Experimentation still gains its Plague Token (R77, R212)", () => {
    const g = scenario({
      seed: "edge-r8-fauci-fuse",
      p1: { hand: [SORCERER, HINDER], mana: 10 },
      p2: { field: [{ def: FAUCI, lane: 1 }], backrow: [{ def: EXPERIMENTATION, lane: 1 }] },
    });
    const fauci = unitAt(g, "p2", 1);

    g.play(SORCERER, { zone: 1, targets: at(fauci) });

    // The Sorcerer's Cry hit Fauci for 4, and the trap fused the Sorcerer onto Fauci (R77: the
    // instance is kept, on the same stay, carrying both texts — Fauci's trigger included, R102).
    expect(g.events.some((event) => event.type === "damage" && event.targetId === fauci.id)).toBe(true);
    expect(g.events.some((event) => event.type === "fused" && event.resultInstanceId === fauci.id)).toBe(true);
    const kept = g.card(fauci);
    expect(kept.zone.z).toBe("field");
    expect(kept.damage).toBe(4);
    // "Whenever this takes damage, +1 Plague Token": the hit happened to this card on this stay
    // (R212), and the Fuse neither moved it nor dropped Fauci's text, so the token lands.
    expect(kept.counters.plague ?? 0).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Round 9: meals, Reborn bodies and buried picks (R174, R102, §4.5 step 4, §3.2)
// ---------------------------------------------------------------------------

const MR_VANILLA = "core-008";
const MIDRANGE_MENACE = "core-019";
const MROW = "core-086";
const NETHER = "core-088";
const UNLICENSED = "core-085";



/** Craft a Card's and #85's fusions are built directly, as `fused-hooks.test.ts` does (R77). */
function sinkFor(s: Scenario): EngineSink {
  return { state: s.state, events: [], rng: createRng(s.state.seed, s.state.rngCursor) };
}

describe("R174, R41: a Cube's meal is read on the stay the play chose", () => {
  it("R174 a crafted Cube + Cube that names the same Reborn unit twice eats it once and remembers it once, so its Death copies it twice, not four times (R41, R83)", () => {
    const s = scenario({
      seed: "r9-cube-cube-reborn",
      p1: {
        mana: 10,
        hand: [CUBE, CUBE, HIT_JOB, RENO],
        // A Right-house defender: Reborn and no Death of its own. (A Radiant Saintess's Death would
        // make the crafted Cube Radiant, and a Radiant Cube fills the board whatever it remembers.)
        field: [{ def: RIGHT_HOUSE, lane: 1 }],
        library: [...LIBRARY],
      },
      p2: { hand: [STOCKPILE], field: [MIDRANGE_MENACE], library: [...LIBRARY] },
    });
    const cubes = s.hand("p1").filter((card) => card.defId === CUBE);
    const crafted = must(subsystems.fuse(sinkFor(s), { ingredients: cubes, toHand: "p1" }), "the crafted card");
    const defender = must(s.unit("p1", 1), "p1's Right-house defender");

    // The defender is p1's only other permanent, so each Cube's declaration takes it: this is the
    // one play legalActions offers for the crafted card (R81, R90).
    const picks: Selection[] = [
      { pick: "instance", instanceId: defender.id },
      { pick: "instance", instanceId: defender.id },
    ];
    s.play(crafted, { zone: 3, targets: picks });

    // The first Cube's part ate it and Reborn brought it straight back (§4.5 step 4). The second
    // part's sacrifice fizzles on the body (R174): it died once.
    expect(s.card(defender).zone.z).toBe("field");
    expect(s.events.filter((event) => event.type === "destroyed" && event.instanceId === defender.id)).toHaveLength(1);
    expect(s.card(crafted).radiant).toBe(false);

    // R41: "nothing eaten → Death does nothing", so only the first Cube's Death summons copies.
    s.play(HIT_JOB, { targets: [{ pick: "instance", instanceId: crafted.id }] });
    const defenders = [1, 2, 3, 4, 5].map((lane) => s.unit("p1", lane)?.defId).filter((id) => id === RIGHT_HOUSE);
    // Its Reborn body plus the first Cube's 2 copies; the second Cube remembered nothing.
    expect(defenders).toHaveLength(3);
  });
});

describe("§4.5 step 4, R89: the Reborn bodies of one check return together", () => {
  /**
   * p1 plays a Felinor Fiender crafted with a Radiant Saintess (7/9, Stack, Reborn, and the Fiender's
   * layer 2) and a "Miss" Mrow crafted with a Saintess (3/3 Felinor, Reborn) into the two lanes
   * given, then destroys both with Twisting Nether. Both die in one state check and both come back
   * through Reborn. Returns the Fiender body's health afterwards.
   */
  function fienderAfterReborn(fienderLane: number, mrowLane: number): number {
    const s = scenario({
      seed: "r9-reborn-order",
      p1: {
        mana: 10,
        hand: [SAINTESS, FIENDER, SAINTESS, MROW, NETHER, RENO],
        library: [...LIBRARY],
      },
      p2: { hand: [STOCKPILE], library: [...LIBRARY] },
    });
    const hand = s.hand("p1");
    const saints = hand.filter((card) => card.defId === SAINTESS);
    const fienderIn = must(hand.find((card) => card.defId === FIENDER), "Felinor Fiender in hand");
    const mrowIn = must(hand.find((card) => card.defId === MROW), "Mrow in hand");
    const rebornFiender = must(
      subsystems.fuse(sinkFor(s), { ingredients: [fienderIn, must(saints[0], "a Saintess")], toHand: "p1" }),
      "Fiender + Saintess",
    );
    const rebornMrow = must(
      subsystems.fuse(sinkFor(s), { ingredients: [mrowIn, must(saints[1], "a Saintess")], toHand: "p1" }),
      "Mrow + Saintess",
    );
    s.play(rebornFiender, { zone: fienderLane });
    s.play(rebornMrow, { zone: mrowLane });
    // Layer 2: printed 7/9 plus the crafted Mrow's 3/3 (R116).
    expect(s.stats(rebornFiender).maxHealth).toBe(9 + 3);

    s.play(NETHER);
    s.expectInZone(rebornFiender, "field").expectInZone(rebornMrow, "field");
    expect(s.stats(rebornFiender).maxHealth).toBe(9 + 3);
    return s.stats(rebornFiender).health;
  }

  it("§4.5 a Felinor Fiender and the Felinor feeding it that come back through Reborn in one check leave the Fiender at the same health whichever lane is first (R89, R116)", () => {
    // Mrow first: the Fiender's body is read with Mrow back, 12 max health and 1 left. Fiender first:
    // it is read with Mrow still in the graveyard, 9 max and 1 left, and Mrow's return then lifts it
    // to 4. §4.5 step 4 returns every collected Reborn unit in one step, at 1 health.
    expect(fienderAfterReborn(1, 2)).toBe(fienderAfterReborn(2, 1));
  });
});

describe("§3.2, R13, R174: a card the play's own Stack buried is not on the field for its Cry", () => {
  /**
   * p1 crafts a Felinor Fiender (Stack) with `partner`, whose Cry chooses one of p1's units, and
   * plays it onto lane 1, where Mr. Vanilla stands, choosing Mr. Vanilla. Step 4 puts the crafted
   * card on top of the pile, so by step 5 Mr. Vanilla is dormant under it.
   */
  function buryOwnPick(partner: string, seed: string): { s: Scenario; crafted: CardInstance; vanilla: CardInstance } {
    const s = scenario({
      seed,
      p1: { mana: 10, hand: [FIENDER, partner, RENO], field: [{ def: MR_VANILLA, lane: 1 }], library: [...LIBRARY] },
      p2: { hand: [STOCKPILE], library: [...LIBRARY] },
    });
    const hand = s.hand("p1");
    const fiender = must(hand.find((card) => card.defId === FIENDER), "Felinor Fiender in hand");
    const other = must(hand.find((card) => card.defId === partner), "the partner in hand");
    const crafted = must(subsystems.fuse(sinkFor(s), { ingredients: [fiender, other], toHand: "p1" }), "the crafted card");
    const vanilla = must(s.unit("p1", 1), "Mr. Vanilla");
    s.play(crafted, { zone: 1, targets: [{ pick: "instance", instanceId: vanilla.id }] });
    return { s, crafted, vanilla };
  }

  it("R174 a crafted Fiender + Prejudiced Postdoc played onto its chosen Human copies nothing once that Human is buried (§3.2, R13)", () => {
    const { s, crafted, vanilla } = buryOwnPick(POSTDOC, "r9-buried-postdoc");
    // Step 4 buried Mr. Vanilla under the crafted card: it is dormant, not on the field (R13).
    expect(s.unit("p1", 1)?.id).toBe(crafted.id);
    s.expectInZone(vanilla, "field");
    // "Choose a Human unit on the field; summon a Vanilla copy": the chosen unit is no longer on the
    // field, so the copy fizzles, as #68's damage does on a buried pick. The engine summons one.
    expect([2, 3, 4, 5].map((lane) => s.unit("p1", lane)?.defId ?? null)).toEqual([null, null, null, null]);
  });

  it("R174 a crafted Fiender + Carnivorous Cube played onto its chosen meal does not eat the card buried beneath it (§3.2, R13, R41)", () => {
    const { s, crafted, vanilla } = buryOwnPick(CUBE, "r9-buried-cube");
    expect(s.unit("p1", 1)?.id).toBe(crafted.id);
    // The meal is dormant under the crafted card when the Cry resolves, so there is nothing on the
    // field to tribute and the Cry fizzles (R41). The engine sacrifices it out of the pile.
    s.expectInZone(vanilla, "field");
    expect(s.events.some((event) => event.type === "destroyed" && event.instanceId === vanilla.id)).toBe(false);
  });
});

describe("R102, R77, R41: a card #85 keeps reads its meals with its own text", () => {
  /** p1's unit row as def ids, lane 1 to 5. */
  function unitRow(s: Scenario): (string | null)[] {
    return [1, 2, 3, 4, 5].map((lane) => s.unit("p1", lane)?.defId ?? null);
  }
  function count(row: readonly (string | null)[], defId: string): number {
    return row.filter((id) => id === defId).length;
  }

  it("R102 a Cube that ate once and had a played Cube fused onto it copies its one meal twice, not four times (R77, R41)", () => {
    const s = scenario({
      seed: "r9-cube-kept-meal",
      p1: {
        mana: 10,
        hand: [CUBE, RENO, HIT_JOB],
        field: [{ def: TIMMY, lane: 1 }],
        backrow: [UNLICENSED],
        library: [...LIBRARY],
      },
      p2: { hand: [CUBE, STOCKPILE], backrow: [MANA_WELL], library: [...LIBRARY] },
    });
    s.play(CUBE, { targets: [{ pick: "instance", instanceId: must(s.unit("p1", 1), "Tempo Timmy").id }] });
    const kept = must(s.unit("p1", 2), "p1's Cube");

    // p2's Cube eats p2's Mana Well; after its Cry, #85 fuses it onto p1's Cube, the only unit p1 has
    // (R61). The kept instance is p1's Cube, and its memory is the Timmy it ate (R77).
    s.endTurn();
    s.play(CUBE, { targets: [{ pick: "instance", instanceId: must(s.backrow("p2", 1), "Mana Well").id }] });
    expect(s.card(kept).defId).toMatch(/core-022\+core-022/);

    s.endTurn();
    s.play(HIT_JOB, { targets: [{ pick: "instance", instanceId: kept.id }] });

    // The kept Cube's text copies its meal twice ("each Death copies its own", R102). The played
    // Cube's text ate a Mana Well on another instance, never a Timmy. The engine hands the kept
    // card's one meal to both texts and summons four Timmies.
    expect(count(unitRow(s), TIMMY)).toBe(2);
  });

  it("R77 a Fuse moves what the kept card's own text remembered to the place that text now runs at, and leaves the rest of its memory as it was (R102)", () => {
    const s = scenario({
      seed: "r11-r77-kept-memory",
      p1: {
        mana: 10,
        hand: [CUBE, RENO],
        field: [{ def: TIMMY, lane: 1 }],
        backrow: [UNLICENSED],
        library: [...LIBRARY],
      },
      p2: { hand: [CUBE, STOCKPILE], backrow: [MANA_WELL], library: [...LIBRARY] },
    });
    // p1's Cube eats Tempo Timmy: its text remembers the meal through `remember`, under "eaten".
    s.play(CUBE, { targets: [{ pick: "instance", instanceId: must(s.unit("p1", 1), "Tempo Timmy").id }] });
    const kept = must(s.unit("p1", 2), "p1's Cube");
    const before = structuredClone(s.card(kept).memory);
    expect(before).toHaveProperty("eaten");

    // p2's Cube, after its Cry, is fused onto p1's Cube by #85 (R61): the kept instance's texts are
    // one ingredient of the new fusion now, and the meal goes with them to that ingredient's path.
    s.endTurn();
    s.play(CUBE, { targets: [{ pick: "instance", instanceId: must(s.backrow("p2", 1), "Mana Well").id }] });
    const after = s.card(kept).memory;
    expect(s.card(kept).defId).toMatch(/core-022\+core-022/);
    expect(after).not.toHaveProperty("eaten");
    const moved = Object.keys(after).filter((key) => key.startsWith("eaten@"));
    expect(moved).toHaveLength(1);
    expect(after[moved[0] ?? ""]).toEqual(before.eaten);
    // Every other entry is as it was; the only one the Fuse may add is the ingredients' prices.
    const { eaten: _meal, ...restBefore } = before;
    const { [moved[0] ?? ""]: _movedMeal, [INGREDIENTS_KEY]: _prices, ...restAfter } = after;
    expect(restAfter).toEqual(restBefore);
  });

  it("R102 a crafted Cube + Cube that #85 fuses a played Cube onto still copies both of its own meals (R77)", () => {
    const s = scenario({
      seed: "r9-crafted-cube-kept",
      p1: {
        mana: 10,
        hand: [CUBE, CUBE, RENO, HIT_JOB],
        field: [{ def: TIMMY, lane: 1 }, { def: MR_VANILLA, lane: 2 }],
        backrow: [UNLICENSED],
        library: [...LIBRARY],
      },
      p2: { hand: [CUBE, STOCKPILE], backrow: [MANA_WELL], library: [...LIBRARY] },
    });
    const cubes = s.hand("p1").filter((card) => card.defId === CUBE);
    const crafted = must(subsystems.fuse(sinkFor(s), { ingredients: cubes, toHand: "p1" }), "Cube + Cube");
    s.play(crafted, {
      zone: 3,
      targets: [
        { pick: "instance", instanceId: must(s.unit("p1", 1), "Tempo Timmy").id },
        { pick: "instance", instanceId: must(s.unit("p1", 2), "Mr. Vanilla").id },
      ],
    });
    // R102: each Cube remembered its own meal.
    expect(unitRow(s)).toEqual([null, null, crafted.defId, null, null]);

    s.endTurn();
    s.play(CUBE, { targets: [{ pick: "instance", instanceId: must(s.backrow("p2", 1), "Mana Well").id }] });
    s.endTurn();
    s.play(HIT_JOB, { targets: [{ pick: "instance", instanceId: crafted.id }] });

    // The kept card "still reads what it remembered before" (R102): its two Cubes copy a Timmy twice
    // and a Mr. Vanilla twice. The engine reads its first meal off the played Cube's text and
    // nothing off its own, so only two Timmies arrive.
    const row = unitRow(s);
    expect(count(row, TIMMY)).toBe(2);
    expect(count(row, MR_VANILLA)).toBe(2);
  });
});
