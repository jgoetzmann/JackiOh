// The M2 gate (BUILD.md), verbatim: "`engine/test/combat.property.test.ts`: 1,000 random combats
// between random keyword combinations never produce negative health, never leave a unit at health
// ≤ 0 on the field unless it is Indestructible with max health above 0 (R69), and never emit a
// `damage` event on an Indestructible target."
//
// R69, verbatim: "An Indestructible unit whose max health falls to 0 or less (Suppressive Aura) is
// collected like any other unit, because no destroy effect is involved: it dies, fires Death, may
// Reborn and counts toward Ceaseless Void's destroyed counter (Hearthstone). An Indestructible unit
// at 0 or less health whose max health is still above 0 (damage taken before it became
// Indestructible) stays." R46 is the other half: a would-destroy on an Indestructible unit switches
// it to Attack Position and takes its Taunt away for the turn.
//
// How the 1,000 cases are built. Each case is a deterministic function of its index: case `i` draws
// from `createRng("m2-combat-<i>")`, so a violation is reproduced by that seed alone and the whole
// run is the same on every machine (§10.7, §9.3). A case picks an attacker and a defender from the
// keyword fixtures of `./fixtures/combat`, adds zero to two granted keywords out of the pool below
// (which is where the *combinations* come from: Divine Shield on a Trampler, Indestructible on a
// Poisonous body, Armor on a First Striker), flips radiant on either side, puts either unit in
// Defense Position, gives either one damage it took earlier or a negative health buff that drags
// its max health to 0 (R69's first sentence, which no Core fixture has an aura for), aims at the
// defender or at the hero, and enters through `declareAttack` when §4.2 allows it or `forceAttack`
// when it does not (R53). Every entry point runs the combat and then the state check of §4.5.
//
// The three invariants are checked as SPEC reads them, and the readings are in the comments at each
// one. Two exceptions are the rules themselves rather than a loosening: R69 leaves an Indestructible
// unit at 0 or less health on the field while its max health is above 0, and §4.5 step 2 stops the
// check the moment a hero dies, so a game that is over may still have a body on the board.

import type { GameEvent, Keyword, PlayerId } from "@jackioh/shared";
import { hasKeyword } from "@jackioh/shared";
import { describe, expect, it } from "vitest";
import {
  canAttack,
  declareAttack,
  forceAttack,
  isActiveOnField,
  type AttackTarget,
} from "../src/combat";
import { HERO_HEALTH, UNIT_ZONES } from "../src/config";
import { unitView } from "../src/layers";
import { createRng, type Rng } from "../src/rng";
import { stateCheck } from "../src/stateCheck";
import type { CardInstance, GameState } from "../src/state";
import { activeUnitsOf, dormantUnitsOf } from "../src/zones";
import {
  armoured,
  bigBody,
  bigDfender,
  charger,
  cleaver,
  deftDuelist,
  firstStriker,
  indestructible,
  lifestealer,
  moths,
  pacifist,
  plain,
  poisonous,
  rusher,
  shielded,
  spikeyPillow,
  stacker,
  taunter,
  trampleLifesteal,
  trampler,
  zeroAttack,
} from "./fixtures/combat";
import { eventsOfType, newGame, put, sinkFor, slot } from "./fixtures/harness";

/** The gate's number. */
const COMBATS = 1000;

/** Every keyword fixture of §6.1, as the bodies a random combat is fought between. */
const BODIES = [
  plain,
  bigBody,
  zeroAttack,
  taunter,
  rusher,
  charger,
  firstStriker,
  shielded,
  armoured,
  indestructible,
  poisonous,
  lifestealer,
  trampler,
  trampleLifesteal,
  cleaver,
  pacifist,
  stacker,
  moths,
  bigDfender,
  deftDuelist,
  spikeyPillow,
];

/**
 * The grants that make the combinations: R21's pool plus the three keywords R21 leaves out but
 * §6.1 defines for a unit in combat (Indestructible, a bigger Armor, "Can't attack").
 */
const GRANTS: Keyword[] = [
  { kind: "Taunt" },
  { kind: "Rush" },
  { kind: "Charge" },
  { kind: "First Strike" },
  { kind: "Poisonous" },
  { kind: "Lifesteal" },
  { kind: "Reborn" },
  { kind: "Divine Shield" },
  { kind: "Trample" },
  { kind: "Cleave" },
  { kind: "Armor", n: 1 },
  { kind: "Armor", n: 3 },
  { kind: "Indestructible" },
  { kind: "Can't attack" },
];

type Violation = { seed: string; invariant: string; detail: string };

type Tally = {
  combats: number;
  damageEvents: number;
  deaths: number;
  heroTargets: number;
  forced: number;
  radiantSides: number;
  /** R69's second sentence: left on the field at 0 or less health, max health above 0. */
  r69Survivors: number;
  /** R69's first sentence: collected because its max health fell to 0 or less. */
  r69Collected: number;
  gamesOver: number;
};

function caseSeed(index: number): string {
  return `m2-combat-${index}`;
}

function grantsFor(rng: Rng): Keyword[] {
  const count = rng.int(3); // 0, 1 or 2
  const picked: Keyword[] = [];
  for (let i = 0; i < count; i += 1) {
    const keyword = rng.pick(GRANTS);
    if (keyword !== undefined) picked.push(keyword);
  }
  return picked;
}

/** Every unit the board holds, the cards dormant under a Stack included (§3.2). */
function unitsOnField(state: GameState, player: PlayerId): CardInstance[] {
  return [...activeUnitsOf(state, player), ...dormantUnitsOf(state, player)];
}

/** Dress one unit up: radiant face, granted keywords, position, earlier damage, R69's max health. */
function dress(state: GameState, unit: CardInstance, rng: Rng): void {
  for (const keyword of grantsFor(rng)) unit.grantedKeywords.push(keyword);
  if (rng.chance(0.25)) unit.position = "DEF";
  if (rng.chance(0.2)) unit.summonedTurn = state.turn;

  const view = unitView(state, unit);
  if (rng.chance(0.1)) {
    // R69's first sentence: max health dragged to 0 or less, with no destroy effect involved.
    unit.buffs.health -= view.maxHealth;
  } else if (rng.chance(0.5) && view.maxHealth > 1) {
    // "Damage taken before it became Indestructible": a body that is already hurt. The range runs
    // past max health on purpose, so R69's second sentence — an Indestructible unit at 0 or less
    // health whose max health is still above 0, which stays on the field — is reached: it cannot
    // be reached any other way, since §4.4 step 4 stops an Indestructible unit taking damage at
    // all. A unit that is not Indestructible and lands there is simply collected by §4.5.
    unit.damage = rng.int(view.maxHealth + 3);
  }
}

function runOneCombat(index: number, tally: Tally): Violation[] {
  const seed = caseSeed(index);
  const rng = createRng(seed);
  const state = newGame(seed);
  state.turn = 4;
  state.active = "p1";
  state.phase = "main";

  const attackerDef = rng.pick(BODIES) ?? plain;
  const defenderDef = rng.pick(BODIES) ?? plain;
  const attackerRadiant = rng.chance(0.4);
  const defenderRadiant = rng.chance(0.4);
  if (attackerRadiant) tally.radiantSides += 1;
  if (defenderRadiant) tally.radiantSides += 1;

  // Lane 3 on each side, so a Cleave has a neighbour on either hand (§4.4 step 10, §3.1).
  const attacker = put(state, attackerDef.id, slot("p1", "units", 3), { radiant: attackerRadiant });
  const defender = put(state, defenderDef.id, slot("p2", "units", 3), { radiant: defenderRadiant });
  dress(state, attacker, rng);
  dress(state, defender, rng);

  for (const lane of [2, 4]) {
    if (!rng.chance(0.5)) continue;
    const neighbourDef = rng.pick(BODIES) ?? plain;
    const neighbour = put(state, neighbourDef.id, slot("p2", "units", lane), { radiant: rng.chance(0.3) });
    dress(state, neighbour, rng);
  }
  if (rng.chance(0.3)) {
    const allyDef = rng.pick(BODIES) ?? plain;
    dress(state, put(state, allyDef.id, slot("p1", "units", 2), { radiant: rng.chance(0.3) }), rng);
  }

  state.players.p1.hero.health = 1 + rng.int(HERO_HEALTH);
  state.players.p2.hero.health = 1 + rng.int(HERO_HEALTH);
  state.players.p1.hero.armor = rng.int(3);
  state.players.p2.hero.armor = rng.int(3);

  const atHero = rng.chance(0.25);
  const target: AttackTarget = atHero ? { kind: "hero", player: "p2" } : { kind: "unit", instance: defender };
  if (atHero) tally.heroTargets += 1;

  // Every unit that is Indestructible as the combat starts: nothing here grants or removes the
  // keyword mid-combat, so this is the set §4.4 step 4 will be asked about on every hit.
  const indestructibleIds = new Set(
    (["p1", "p2"] as PlayerId[]).flatMap((player) =>
      unitsOnField(state, player)
        .filter((unit) => hasKeyword(unitView(state, unit).keywords, "Indestructible"))
        .map((unit) => unit.id),
    ),
  );

  const events: GameEvent[] = [];
  const sink = sinkFor(state, events);
  const declared = rng.chance(0.5) && canAttack(state, attacker, target);
  if (declared) declareAttack(sink, attacker, target);
  else {
    forceAttack(sink, attacker, target);
    tally.forced += 1;
  }
  // The gate's "and the state check": idempotent, so running it again must find nothing to do.
  stateCheck(sink);

  tally.combats += 1;
  tally.damageEvents += eventsOfType(events, "damage").length;
  tally.deaths += eventsOfType(events, "destroyed").length;
  if (state.result !== null) tally.gamesOver += 1;

  const out: Violation[] = [];
  const fail = (invariant: string, detail: string): void => {
    out.push({ seed, invariant, detail });
  };
  const describeUnit = (unit: CardInstance): string => {
    const view = unitView(state, unit);
    return `${unit.defId}${unit.radiant ? "(r)" : ""} ${unit.id} health ${view.health}/${view.maxHealth} damage ${unit.damage} keywords [${view.keywords.map((k) => k.kind).join(",")}]`;
  };

  // ---- Invariant 1: "never produce negative health". -----------------------
  // A hero's health below 0 is how a hero dies (§4.5 step 2), so the invariant is that no *live*
  // game holds one; and no instance anywhere carries negative damage, which is the counter every
  // health on the board is computed from (§10.4 layer 6).
  for (const player of ["p1", "p2"] as PlayerId[]) {
    const side = state.players[player];
    if (state.result === null && side.hero.health <= 0) {
      fail("negative health", `${player}'s hero is at ${side.hero.health} with the game still running`);
    }
    const everywhere = [
      ...unitsOnField(state, player),
      ...side.hand,
      ...side.library,
      ...side.graveyard,
      ...side.exile,
    ];
    for (const card of everywhere) {
      if (card.damage < 0) fail("negative health", `${card.defId} ${card.id} carries damage ${card.damage}`);
    }
    // A unit left on the field below 0 health is R69's exception and nothing else.
    for (const unit of unitsOnField(state, player)) {
      const view = unitView(state, unit);
      if (view.health >= 0) continue;
      const exempt = hasKeyword(view.keywords, "Indestructible") && view.maxHealth > 0;
      if (!exempt && state.result === null) {
        fail("negative health", `${player} lane unit below 0 health: ${describeUnit(unit)}`);
      }
    }
  }

  // ---- Invariant 2: no unit at health ≤ 0 on the field, R69's exception aside. ----
  for (const player of ["p1", "p2"] as PlayerId[]) {
    for (const unit of unitsOnField(state, player)) {
      const view = unitView(state, unit);
      if (view.health > 0) continue;
      const indestructible = hasKeyword(view.keywords, "Indestructible");
      if (indestructible && view.maxHealth > 0) {
        tally.r69Survivors += 1;
        continue;
      }
      // §4.5 step 2: the check stops at the hero check, so a finished game may keep a body.
      if (state.result !== null) continue;
      fail("dead unit left on the field", `${player}: ${describeUnit(unit)}`);
    }
  }
  for (const destroyed of eventsOfType(events, "destroyed")) {
    const buried = (["p1", "p2"] as PlayerId[])
      .flatMap((player) => state.players[player].graveyard)
      .find((card) => card.id === destroyed.instanceId);
    if (buried !== undefined && indestructibleIds.has(destroyed.instanceId)) tally.r69Collected += 1;
  }

  // ---- Invariant 3: no `damage` event on an Indestructible target (§4.4 step 4). ----
  for (const hit of eventsOfType(events, "damage")) {
    if (indestructibleIds.has(hit.targetId)) {
      fail("damage on an Indestructible target", `${hit.amount} to ${hit.targetId} from ${hit.sourceId ?? "nothing"}`);
    }
    // R63's zero rule: a hit reduced to 0 emits nothing at all, so no event carries 0 or less.
    if (hit.amount <= 0) {
      fail("damage event with a non-positive amount", `${hit.amount} to ${hit.targetId}`);
    }
  }

  // The attacker and the defender are either on the field or in a pile: never in both, never lost.
  for (const unit of [attacker, defender]) {
    const onField = isActiveOnField(state, unit);
    const inPile = (["p1", "p2"] as PlayerId[]).some((player) => {
      const side = state.players[player];
      return [...side.graveyard, ...side.hand, ...side.exile].some((card) => card.id === unit.id);
    });
    if (onField && inPile) fail("instance in two zones", `${describeUnit(unit)}`);
  }

  return out;
}

describe("M2 gate: 1,000 random combats (BUILD M2, §4.3, §4.4, §4.5)", () => {
  it("M2 gate 1,000 random combats never leave negative health, never leave a dead unit on the field (R69), and never damage an Indestructible target", () => {
    const tally: Tally = {
      combats: 0,
      damageEvents: 0,
      deaths: 0,
      heroTargets: 0,
      forced: 0,
      radiantSides: 0,
      r69Survivors: 0,
      r69Collected: 0,
      gamesOver: 0,
    };

    const violations: Violation[] = [];
    for (let index = 0; index < COMBATS; index += 1) {
      violations.push(...runOneCombat(index, tally));
      // A failure names the seed that reproduces the case on its own; stop at a handful so the
      // report is readable rather than a wall of the same bug.
      if (violations.length >= 5) break;
    }

    expect(
      violations.map((entry) => `${entry.seed} [${entry.invariant}] ${entry.detail}`),
      "M2 gate invariant violations, each reproducible from its seed",
    ).toEqual([]);
    expect(tally.combats).toBe(COMBATS);
  });

  it("M2 gate the 1,000 cases actually exercise the rules they are meant to (non-vacuity)", () => {
    const tally: Tally = {
      combats: 0,
      damageEvents: 0,
      deaths: 0,
      heroTargets: 0,
      forced: 0,
      radiantSides: 0,
      r69Survivors: 0,
      r69Collected: 0,
      gamesOver: 0,
    };
    for (let index = 0; index < COMBATS; index += 1) runOneCombat(index, tally);

    // Damage landed, units died, heroes were attacked, both entry points of §4.2 were used, and
    // radiant faces were fought with.
    expect(tally.damageEvents).toBeGreaterThan(COMBATS);
    expect(tally.deaths).toBeGreaterThan(COMBATS / 4);
    expect(tally.heroTargets).toBeGreaterThan(COMBATS / 8);
    expect(tally.forced).toBeGreaterThan(COMBATS / 8);
    expect(tally.forced).toBeLessThan(COMBATS);
    expect(tally.radiantSides).toBeGreaterThan(COMBATS / 4);

    // And both halves of R69 happened, so invariant 2's exception is not a dead branch.
    expect(tally.r69Survivors).toBeGreaterThan(0);
    expect(tally.r69Collected).toBeGreaterThan(0);
  });
});

describe("R69 and R46: the exception invariant 2 carves out", () => {
  it("R69 leaves an Indestructible unit at 0 or less health on the field while its max health is above 0", () => {
    const state = newGame("r69-stays");
    state.turn = 4;
    const unit = put(state, indestructible.id, slot("p1", "units", 1)); // 4/4 Indestructible
    // "Damage taken before it became Indestructible": 6 on a 4-health body.
    unit.damage = 6;

    const view = unitView(state, unit);
    expect(view.health).toBe(-2);
    expect(view.maxHealth).toBe(4);

    stateCheck(sinkFor(state));
    expect(activeUnitsOf(state, "p1").map((card) => card.id)).toEqual([unit.id]);
    expect(state.players.p1.graveyard).toEqual([]);
    expect(state.counters.destroyed).toBe(0);
  });

  it("R69 collects an Indestructible unit whose max health falls to 0 or less, like any other unit", () => {
    const state = newGame("r69-collected");
    state.turn = 4;
    const unit = put(state, indestructible.id, slot("p1", "units", 1)); // 4/4 Indestructible
    // Suppressive Aura's effect, as a layer-4 buff: max health to 0, with no destroy involved.
    unit.buffs.health = -4;
    expect(unitView(state, unit).maxHealth).toBe(0);

    const events: GameEvent[] = [];
    stateCheck(sinkFor(state, events));

    expect(activeUnitsOf(state, "p1")).toEqual([]);
    expect(state.players.p1.graveyard.map((card) => card.id)).toEqual([unit.id]);
    expect(eventsOfType(events, "destroyed").map((event) => event.instanceId)).toEqual([unit.id]);
    // "Counts toward Ceaseless Void's destroyed counter" (R69, R55).
    expect(state.counters.destroyed).toBe(1);
  });

  it("R46 a would-destroy on an Indestructible unit switches it to Attack Position and takes its Taunt for the turn", () => {
    const state = newGame("r46");
    state.turn = 4;
    const unit = put(state, indestructible.id, slot("p1", "units", 1));
    unit.grantedKeywords.push({ kind: "Taunt" });
    unit.position = "DEF";
    unit.markedDestroyed = true;

    const events: GameEvent[] = [];
    stateCheck(sinkFor(state, events));

    expect(activeUnitsOf(state, "p1").map((card) => card.id)).toEqual([unit.id]);
    expect(unit.markedDestroyed).toBe(false);
    expect(unit.position).toBe("ATK");
    expect(unit.tauntSuppressedTurn).toBe(state.turn);
    expect(unitView(state, unit).keywords.some((keyword) => keyword.kind === "Taunt")).toBe(false);
    expect(eventsOfType(events, "positionSwitched")).toEqual([
      { type: "positionSwitched", instanceId: unit.id, position: "ATK" },
    ]);

    // Only for that turn: next turn the granted Taunt is back (R46, §10.4).
    state.turn += 1;
    expect(unitView(state, unit).keywords.some((keyword) => keyword.kind === "Taunt")).toBe(true);
  });

  it("§4.4 step 4 an Indestructible defender takes no damage and emits no damage event", () => {
    const state = newGame("indestructible-no-damage");
    state.turn = 4;
    state.active = "p1";
    state.phase = "main";
    const attacker = put(state, bigBody.id, slot("p1", "units", 1)); // 5/10
    const defender = put(state, indestructible.id, slot("p2", "units", 1)); // 4/4 Indestructible

    const events: GameEvent[] = [];
    declareAttack(sinkFor(state, events), attacker, { kind: "unit", instance: defender });

    const hits = eventsOfType(events, "damage");
    expect(hits.map((hit) => hit.targetId)).toEqual([attacker.id]); // only the strike back landed
    expect(defender.damage).toBe(0);
    expect(attacker.damage).toBe(4);
    expect(UNIT_ZONES).toBe(5);
  });
});
