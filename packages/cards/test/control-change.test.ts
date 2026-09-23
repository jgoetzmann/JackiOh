// R171 and R172 with the real cards (SPEC §4.1, §11; docs/polish/4-edge-cases.md behaviours 1 to 10,
// 14 and 15). Every card that changes control — #36 radiant, #49, #50, #52, #86 and #87 — makes the
// unit it moves enter its new controller's side on that turn: summoning sick exactly as a unit
// summoned that turn is, with Rush and Charge applying as usual, and with a fresh exertion for its
// new controller. A unit that only moves between lanes on its own side has entered nothing.
//
// R172 is the case the brief asked to check: a stolen unit dies as its controller's. Its Death runs
// for that player (#81, radiant #3) and a Reborn body comes back on that player's side, sick.
//
// The engine-fixture proofs of the same rows are `packages/engine/test/control-change.test.ts` and
// `control-change.property.test.ts`; this file is the proof through `scenario()` that the cards
// reach the rule.
//
// Every case that crosses a turn boundary keeps a card in hand or a unit on the board for both
// sides, so R82's automatic turn end never skips a turn (see the harness header).
//
// Props: #25 4-mana 7/7 (no Rush or Charge; Armor 7, so a small attacker bounces off it), #8 Mr.
// Vanilla (a plain 3/3), #20 Pointmaster (a 7/2 that never matters), #56 Jilliax (Rush, Charge
// radiant), #45 Deft Duelist (Charge), #11 Tempo Timmy (Charge radiant), #14 Jlockeed's Weapons
// (an aura granting Rush), #68 Twisted Sorcerer (4 damage to a target), #41 Sheepish (a Trap).

import type { Selection } from "@jackioh/shared";
import { legalActions, type CardInstance } from "@jackioh/engine";
import { describe, expect, it } from "vitest";
import { scenario, type Scenario } from "./_harness";

const MAGIC_JAMMED = "core-036";
const MIND_CONTROL = "core-049";
const KPOP = "core-050";
const SILAS = "core-052";
const MROW = "core-086";
const CHAOS = "core-087";
const SAINTESS = "core-081";
const RIGHT_HOUSE = "core-003";
const SEVEN_SEVEN = "core-025";
const VANILLA = "core-008";
const POINTMASTER = "core-020";
const JILLIAX = "core-056";
const DUELIST = "core-045";
const TIMMY = "core-011";
const WEAPONS = "core-014";
const SORCERER = "core-068";
const SHEEPISH = "core-041";
const LIBRARY = [VANILLA, VANILLA, VANILLA, VANILLA];

const SICK = /summoning sick/;
const RUSH_NOT_HERO = /Rush cannot hit the hero/;
const ALREADY_ACTED = /already acted/;

function unitAt(g: Scenario, player: "p1" | "p2", lane: number): CardInstance {
  const card = g.unit(player, lane);
  if (card === null) throw new Error(`setup: ${player} should hold a unit in lane ${lane}`);
  return card;
}

function backrowAt(g: Scenario, player: "p1" | "p2", lane: number): CardInstance {
  const card = g.backrow(player, lane);
  if (card === null) throw new Error(`setup: ${player} should hold a backrow card in lane ${lane}`);
  return card;
}

const at = (card: CardInstance): Selection[] => [{ pick: "instance", instanceId: card.id }];

/** The attacks `legalActions` offers this unit right now, as target ids. */
function offeredAttacks(g: Scenario, card: CardInstance): string[] {
  const live = g.card(card);
  return legalActions(g.state, live.controller).flatMap((action) =>
    action.type === "attack" && action.attackerId === live.id ? [action.targetId] : [],
  );
}

function offersSwitch(g: Scenario, card: CardInstance): boolean {
  const live = g.card(card);
  return legalActions(g.state, live.controller).some(
    (action) => action.type === "switchPosition" && action.instanceId === live.id,
  );
}

/** R171's bookkeeping: entered on this turn, with a fresh exertion. */
function expectEnteredNow(g: Scenario, card: CardInstance): void {
  const live = g.card(card);
  expect(live.summonedTurn, `${live.id} (${live.defId}) summonedTurn`).toBe(g.state.turn);
  expect(live.exertion, `${live.id} (${live.defId}) exertion`).toEqual({ attacked: false, switched: false });
}

const heroHealth = (g: Scenario, player: "p1" | "p2"): number => g.state.players[player].hero.health;

describe("R171 with the cards that change control", () => {
  it("R171 #49: a stolen unit with neither Rush nor Charge cannot attack that turn, and attacks on the thief's next turn", () => {
    const g = scenario({
      p1: { hand: [MIND_CONTROL, VANILLA], library: [...LIBRARY] },
      p2: {
        hand: [VANILLA],
        field: [{ def: SEVEN_SEVEN, lane: 3 }, { def: VANILLA, lane: 5 }],
        library: [...LIBRARY],
      },
    });
    const prey = unitAt(g, "p2", 3);
    const bystander = unitAt(g, "p2", 5);

    g.play(MIND_CONTROL, { targets: at(prey) });

    expect(g.card(prey).controller).toBe("p1");
    expectEnteredNow(g, prey);
    expect(() => g.attack(prey, "hero")).toThrow(SICK);
    expect(() => g.attack(prey, bystander)).toThrow(SICK);
    expect(offeredAttacks(g, prey)).toEqual([]);

    g.endTurn().endTurn();
    expect(g.state.active).toBe("p1");
    expect(offeredAttacks(g, prey)).toContain("hero-p2");
    const before = heroHealth(g, "p2");
    g.attack(prey, "hero");
    g.expectHealth("p2", before - 7);
  });

  it("R171 #36 radiant: a stolen backrow card takes the turn and a fresh exertion like any other card", () => {
    const g = scenario({
      p1: { hand: [{ def: MAGIC_JAMMED, radiant: true }], field: [{ def: VANILLA, lane: 1 }] },
      p2: { backrow: [{ def: SHEEPISH, lane: 3 }], field: [{ def: VANILLA, lane: 1 }] },
    });
    const trap = backrowAt(g, "p2", 3);

    g.play(MAGIC_JAMMED, { targets: at(trap) });

    // The Lock lands on p2's lane 3, the original zone, so R15 puts the trap in p1's lane 3.
    expect(g.backrow("p1", 3)?.id).toBe(trap.id);
    expect(g.card(trap).controller).toBe("p1");
    expectEnteredNow(g, trap);
  });

  it("R171 #56 base: a stolen Rush unit may attack an enemy unit that turn but not the hero", () => {
    const g = scenario({
      p1: { hand: [MIND_CONTROL, VANILLA] },
      p2: { field: [{ def: JILLIAX, lane: 2 }, { def: VANILLA, lane: 4 }] },
    });
    const jilliax = unitAt(g, "p2", 2);
    const vanilla = unitAt(g, "p2", 4);

    g.play(MIND_CONTROL, { targets: at(jilliax) });

    expectEnteredNow(g, jilliax);
    expect(() => g.attack(jilliax, "hero")).toThrow(RUSH_NOT_HERO);
    expect(offeredAttacks(g, jilliax)).toEqual([vanilla.id]);
    g.attack(jilliax, vanilla);
    g.expectInZone(vanilla, "graveyard");
  });

  it("R171 #45: a stolen Charge unit that attacked for its owner the turn before may attack the hero at once", () => {
    const g = scenario({
      active: "p2",
      turn: 8,
      p1: { hand: [MIND_CONTROL, VANILLA], field: [{ def: VANILLA, lane: 5 }], library: [...LIBRARY] },
      p2: { hand: [VANILLA], field: [{ def: DUELIST, lane: 1 }], library: [...LIBRARY] },
    });
    const duelist = unitAt(g, "p2", 1);
    g.attack(duelist, "hero");
    g.endTurn();
    expect(g.state.active).toBe("p1");
    // Exertion resets at its controller's own turn start, so it is still spent on p1's turn.
    expect(g.card(duelist).exertion.attacked).toBe(true);

    g.play(MIND_CONTROL, { targets: at(duelist) });

    expectEnteredNow(g, duelist);
    expect(offeredAttacks(g, duelist)).toContain("hero-p2");
    const before = heroHealth(g, "p2");
    g.attack(duelist, "hero");
    g.expectHealth("p2", before - 4);
  });

  it("R171 #49: a stolen unit that switched position for its owner may switch again on the turn it is stolen", () => {
    const g = scenario({
      active: "p2",
      turn: 8,
      p1: { hand: [MIND_CONTROL, VANILLA], field: [{ def: POINTMASTER, lane: 5 }], library: [...LIBRARY] },
      p2: { hand: [VANILLA], field: [{ def: VANILLA, lane: 3 }, { def: POINTMASTER, lane: 5 }], library: [...LIBRARY] },
    });
    const switcher = unitAt(g, "p2", 3);
    g.switchPosition(switcher);
    expect(g.card(switcher).position).toBe("DEF");
    g.endTurn();
    expect(g.card(switcher).exertion.switched).toBe(true);

    g.play(MIND_CONTROL, { targets: at(switcher) });

    expectEnteredNow(g, switcher);
    expect(offersSwitch(g, switcher)).toBe(true);
    g.switchPosition(switcher);
    expect(g.card(switcher).position).toBe("ATK");
    // Still sick: the switch was its exertion, and it could not have attacked anyway.
    expect(() => g.attack(switcher, "hero")).toThrow(ALREADY_ACTED);
  });

  it("R171 #50: Kpop Fanatic's delayed steal leaves the unit sick for that whole turn, and it attacks on the next", () => {
    const g = scenario({
      p1: { hand: [KPOP, VANILLA], library: [...LIBRARY] },
      p2: {
        hand: [VANILLA],
        field: [{ def: SEVEN_SEVEN, lane: 2 }, { def: VANILLA, lane: 5 }],
        library: [...LIBRARY],
      },
    });
    const prey = unitAt(g, "p2", 2);
    g.play(KPOP, { targets: at(prey) });

    g.endTurn().endTurn();

    // The steal ran at p1's start of turn, after the exertion reset: the headline bug.
    expect(g.state.active).toBe("p1");
    expect(g.card(prey).controller).toBe("p1");
    expectEnteredNow(g, prey);
    expect(() => g.attack(prey, "hero")).toThrow(SICK);
    expect(offeredAttacks(g, prey)).toEqual([]);

    g.endTurn().endTurn();

    expect(g.state.active).toBe("p1");
    const before = heroHealth(g, "p2");
    g.attack(prey, "hero");
    g.expectHealth("p2", before - 7);
  });

  it("R171 #86: Mrow dying on its controller's own turn steals units that are sick that turn", () => {
    const g = scenario({
      p1: { hand: [VANILLA], field: [{ def: MROW, radiant: true, lane: 1 }] },
      p2: { hand: [VANILLA], field: [{ def: SEVEN_SEVEN, lane: 3 }, { def: VANILLA, lane: 4 }] },
    });
    const mrow = unitAt(g, "p1", 1);
    const sevenSeven = unitAt(g, "p2", 3);
    const vanilla = unitAt(g, "p2", 4);

    // Radiant Mrow "can attack": 2 into Armor 7 is nothing, and 7 back kills it.
    g.attack(mrow, sevenSeven);

    g.expectInZone(mrow, "graveyard");
    for (const stolen of [sevenSeven, vanilla]) {
      expect(g.card(stolen).controller).toBe("p1");
      expectEnteredNow(g, stolen);
      expect(() => g.attack(stolen, "hero")).toThrow(SICK);
      expect(offeredAttacks(g, stolen)).toEqual([]);
    }
  });

  it("R171 #86: Mrow dying on the opponent's turn steals units that attack freely on the thief's next turn", () => {
    const g = scenario({
      active: "p2",
      turn: 8,
      p1: { hand: [VANILLA], field: [{ def: MROW, lane: 1 }], library: [...LIBRARY] },
      p2: {
        hand: [VANILLA],
        field: [{ def: SEVEN_SEVEN, lane: 3 }, { def: VANILLA, lane: 4 }],
        library: [...LIBRARY],
      },
    });
    const mrow = unitAt(g, "p1", 1);
    const sevenSeven = unitAt(g, "p2", 3);
    const vanilla = unitAt(g, "p2", 4);

    g.attack(sevenSeven, mrow);

    g.expectInZone(mrow, "graveyard");
    expect(g.card(sevenSeven).controller).toBe("p1");
    expect(g.card(vanilla).controller).toBe("p1");
    // The attacker's spent exertion stayed with p2: for p1 it is fresh (R171).
    expectEnteredNow(g, sevenSeven);

    g.endTurn();
    expect(g.state.active).toBe("p1");
    const before = heroHealth(g, "p2");
    g.attack(sevenSeven, "hero");
    g.attack(vanilla, "hero");
    g.expectHealth("p2", before - 10);
  });

  it("R171 #87: every card the board swap moves enters its new side; the caster's are sick, the opponent's are not", () => {
    const g = scenario({
      p1: { hand: [CHAOS, VANILLA], field: [{ def: VANILLA, lane: 1 }], library: [...LIBRARY] },
      p2: {
        hand: [VANILLA],
        field: [{ def: DUELIST, lane: 2 }, { def: SEVEN_SEVEN, lane: 3 }],
        backrow: [{ def: SHEEPISH, lane: 4 }],
        library: [...LIBRARY],
      },
    });
    const mine = unitAt(g, "p1", 1);
    const duelist = unitAt(g, "p2", 2);
    const sevenSeven = unitAt(g, "p2", 3);
    const trap = backrowAt(g, "p2", 4);

    g.play(CHAOS, { modes: ["board"] });

    for (const card of [mine, duelist, sevenSeven, trap]) expectEnteredNow(g, card);
    expect(g.card(trap).controller).toBe("p1");
    // The caster's new units: Charge still charges, anything else waits.
    expect(() => g.attack(sevenSeven, "hero")).toThrow(SICK);
    expect(offeredAttacks(g, sevenSeven)).toEqual([]);
    const before = heroHealth(g, "p2");
    g.attack(duelist, "hero");
    g.expectHealth("p2", before - 4);

    // The opponent's new unit entered on p1's turn, so it is ready on p2's.
    g.endTurn();
    expect(g.state.active).toBe("p2");
    expect(g.card(mine).controller).toBe("p2");
    const mineBefore = heroHealth(g, "p1");
    g.attack(mine, "hero");
    g.expectHealth("p1", mineBefore - 3);
  });

  it("R171 #52: cards that cross the centre line enter their new side; cards moving along their own side keep their readiness", () => {
    const g = scenario({
      p1: {
        hand: [SILAS, VANILLA],
        field: [
          { def: VANILLA, lane: 2 },
          { def: POINTMASTER, lane: 3 },
          { def: VANILLA, lane: 5 },
        ],
      },
      p2: { field: [{ def: SEVEN_SEVEN, lane: 1 }, { def: VANILLA, lane: 4 }] },
    });
    const spent = unitAt(g, "p1", 2);
    const ready = unitAt(g, "p1", 3);
    const outbound = unitAt(g, "p1", 5);
    const inbound = unitAt(g, "p2", 1);
    g.attack(spent, "hero");

    // Right from p1's seat: p1 lane n → n+1, p1 lane 5 → p2 lane 5, p2 lane 1 → p1 lane 1.
    g.play(SILAS, { zone: 1, modes: ["right"] });

    expect(g.card(inbound).controller).toBe("p1");
    expect(g.card(outbound).controller).toBe("p2");
    expectEnteredNow(g, inbound);
    expectEnteredNow(g, outbound);
    expect(() => g.attack(inbound, "hero")).toThrow(SICK);

    // Along its own side: the spent unit is still spent, the ready one still ready.
    expect(g.card(spent).summonedTurn).toBeUndefined();
    expect(() => g.attack(spent, "hero")).toThrow(ALREADY_ACTED);
    expect(g.card(ready).summonedTurn).toBeUndefined();
    const before = heroHealth(g, "p2");
    g.attack(ready, "hero");
    g.expectHealth("p2", before - 7);
  });

  it("R171 #52 radiant: nothing crosses, so nothing is marked", () => {
    const g = scenario({
      p1: {
        hand: [{ def: SILAS, radiant: true }, VANILLA],
        field: [{ def: POINTMASTER, lane: 3 }, { def: VANILLA, lane: 5 }],
      },
      p2: { field: [{ def: SEVEN_SEVEN, lane: 1 }, { def: VANILLA, lane: 4 }] },
    });
    const ready = unitAt(g, "p1", 3);

    g.play(SILAS, { zone: 1, modes: ["right"] });

    expect(g.lastEvents.filter((event) => event.type === "controlChanged")).toEqual([]);
    expect(g.card(ready).summonedTurn).toBeUndefined();
    expect(offeredAttacks(g, ready)).toContain("hero-p2");
  });

  it("R171 #14: a stolen unit gets Rush from the thief's aura at once, which lets it attack units only", () => {
    const g = scenario({
      p1: { hand: [MIND_CONTROL, VANILLA], backrow: [{ def: WEAPONS, lane: 1 }] },
      p2: { field: [{ def: SEVEN_SEVEN, lane: 3 }, { def: VANILLA, lane: 5 }] },
    });
    const prey = unitAt(g, "p2", 3);
    const vanilla = unitAt(g, "p2", 5);

    g.play(MIND_CONTROL, { targets: at(prey) });

    expect(g.stats(prey).keywords.map((k) => k.kind)).toContain("Rush");
    expect(() => g.attack(prey, "hero")).toThrow(RUSH_NOT_HERO);
    expect(offeredAttacks(g, prey)).toEqual([vanilla.id]);
    g.attack(prey, vanilla);
    g.expectInZone(vanilla, "graveyard");
  });

  it("R171 #49 radiant: making a stolen #56 Radiant gives it Charge, so it may attack the hero at once", () => {
    const g = scenario({
      p1: { hand: [{ def: MIND_CONTROL, radiant: true }, VANILLA] },
      p2: { field: [{ def: JILLIAX, lane: 2 }, { def: VANILLA, lane: 4 }] },
    });
    const jilliax = unitAt(g, "p2", 2);

    g.play(MIND_CONTROL, { targets: at(jilliax) });

    expect(g.card(jilliax).radiant).toBe(true);
    expectEnteredNow(g, jilliax);
    expect(offeredAttacks(g, jilliax)).toContain("hero-p2");
    const before = heroHealth(g, "p2");
    g.attack(jilliax, "hero");
    g.expectHealth("p2", before - 6);
  });

  it("R171 #52 twice: a ready unit that crosses away and back in one turn is sick again", () => {
    const g = scenario({
      p1: { hand: [SILAS, SILAS], mana: 10, field: [{ def: SEVEN_SEVEN, lane: 5 }] },
      p2: { field: [{ def: VANILLA, lane: 3 }] },
    });
    const traveller = unitAt(g, "p1", 5);
    expect(offeredAttacks(g, traveller)).toContain("hero-p2");

    g.play(SILAS, { zone: 1, modes: ["right"] });
    expect(g.card(traveller).controller).toBe("p2");
    g.play(SILAS, { zone: 1, modes: ["left"] });

    expect(g.unit("p1", 5)?.id).toBe(traveller.id);
    expectEnteredNow(g, traveller);
    expect(() => g.attack(traveller, "hero")).toThrow(SICK);
  });

  it("R171 #52 twice: a Charge unit that attacked and made the round trip may attack once more", () => {
    const g = scenario({
      p1: { hand: [SILAS, SILAS], mana: 10, field: [{ def: TIMMY, radiant: true, lane: 5 }] },
      p2: { field: [{ def: VANILLA, lane: 3 }] },
    });
    const timmy = unitAt(g, "p1", 5);
    const before = heroHealth(g, "p2");
    g.attack(timmy, "hero");

    g.play(SILAS, { zone: 1, modes: ["right"] });
    g.play(SILAS, { zone: 1, modes: ["left"] });

    expectEnteredNow(g, timmy);
    g.attack(timmy, "hero");
    g.expectHealth("p2", before - 12);
  });
});

describe("R172 a stolen unit dies as its controller's", () => {
  it("R172 #81: a stolen Saintess dies for the thief, radiating the thief's units, and is reborn on the thief's side, sick", () => {
    const g = scenario({
      p1: { hand: [MIND_CONTROL, SORCERER], mana: 10, field: [{ def: POINTMASTER, lane: 5 }] },
      p2: { hand: [VANILLA], field: [{ def: SAINTESS, lane: 2 }, { def: POINTMASTER, lane: 4 }] },
    });
    const saintess = unitAt(g, "p2", 2);
    const mine = unitAt(g, "p1", 5);
    const theirs = unitAt(g, "p2", 4);

    g.play(MIND_CONTROL, { targets: at(saintess) });
    g.play(SORCERER, { targets: at(saintess) });

    const died = g.events.filter((event) => event.type === "destroyed" && event.instanceId === saintess.id);
    expect(died).toHaveLength(1);
    expect(died[0]).toMatchObject({ owner: "p2" });
    // Death: "all your other units become Radiant" — "your" is the thief.
    expect(g.card(mine).radiant).toBe(true);
    expect(g.card(theirs).radiant).toBe(false);
    // Reborn: back in the zone it reserved, on the side it died on, still owned by p2.
    expect(g.unit("p1", 2)?.id).toBe(saintess.id);
    expect(g.card(saintess).controller).toBe("p1");
    expect(g.card(saintess).owner).toBe("p2");
    expect(g.card(saintess).summonedTurn).toBe(g.state.turn);
    expect(() => g.attack(saintess, "hero")).toThrow(SICK);
  });

  it("R172 radiant #3: a stolen Right-house defender's Death summons its base copy on the thief's side", () => {
    const g = scenario({
      p1: { hand: [MIND_CONTROL, VANILLA], field: [{ def: POINTMASTER, lane: 5 }], library: [...LIBRARY] },
      p2: {
        hand: [VANILLA],
        field: [
          { def: RIGHT_HOUSE, radiant: true, lane: 2 },
          { def: VANILLA, lane: 4 },
          { def: VANILLA, lane: 5 },
        ],
        library: [...LIBRARY],
      },
    });
    const defender = unitAt(g, "p2", 2);
    const first = unitAt(g, "p2", 4);
    const second = unitAt(g, "p2", 5);
    g.play(MIND_CONTROL, { targets: at(defender) });
    g.endTurn();

    // p2 breaks the shield, then kills it: it dies as p1's.
    g.attack(first, defender);
    g.attack(second, defender);

    const copy = g.unit("p1", 1);
    expect(copy?.defId).toBe(RIGHT_HOUSE);
    expect(copy?.radiant).toBe(false);
    expect(copy?.controller).toBe("p1");
    expect(g.unit("p1", 2)?.id).toBe(defender.id);
    expect(g.card(defender).controller).toBe("p1");
    expect(g.card(defender).owner).toBe("p2");
    for (let lane = 1; lane <= 3; lane += 1) expect(g.unit("p2", lane)).toBeNull();
  });
});
