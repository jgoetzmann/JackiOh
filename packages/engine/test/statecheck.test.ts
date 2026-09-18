// The state check of SPEC §4.5 (BUILD M2-T5): collect the dying, check the heroes, fire Death
// triggers in R68 order, return Reborn units to their reserved zones, repeat until stable.
// The fixture defs and scripts this file needs live here, registered on top of the shared
// fixture catalog, so no shared fixture has to grow for them (CLAUDE.md, BUILD §0).

import type { CardDef, GameEvent, Keyword, PlayerId } from "@jackioh/shared";
import { PLAYER_IDS } from "@jackioh/shared";
import { describe, expect, it } from "vitest";
import { registerCatalog, registeredCatalog } from "../src/catalog";
import { dealDamage } from "../src/damage";
import { damage, summon } from "../src/effects";
import { unitHas, unitView } from "../src/layers";
import { beginGame, reduce } from "../src/reduce";
import { runHook } from "../src/resolve";
import type { CardScripts, Effect, Script } from "../src/script";
import { registerScripts, registeredScripts } from "../src/scripts";
import { stateCheck, STATE_CHECK_PASS_CAP } from "../src/stateCheck";
import { findInstance, newInstance, type GameState } from "../src/state";
import { activeUnitsOf, cardAt, firstFreeZone, isLocked, lockZone, placeOnField } from "../src/zones";
import { tokenDef } from "./fixtures/catalog";
import { eventsOfType, newGame, put, sinkFor, slot } from "./fixtures/harness";

// ---------------------------------------------------------------------------
// Fixture effects: the three verbs these tests need before M3-T1 ships them.
// ---------------------------------------------------------------------------

/** One effect, one hit per unit on the board: the Big Felinor / Jlockeed Shredder case (R59). */
function smiteEveryUnit(amount: number): Effect {
  return {
    kind: "statecheck:smiteEveryUnit",
    apply(ctx): void {
      for (const player of PLAYER_IDS) {
        for (const unit of activeUnitsOf(ctx.state, player)) {
          dealDamage(ctx, { source: ctx.self, target: { kind: "unit", instance: unit }, amount });
        }
      }
    },
  };
}

/** Summon per R64: the leftmost empty, unlocked, unreserved unit zone, or nothing. */
function summonFirstFree(defId: string): Effect {
  return {
    kind: "statecheck:summonFirstFree",
    apply(ctx): void {
      const zone = firstFreeZone(ctx.state, ctx.controller, "units");
      if (zone === null) return;
      const card = newInstance(ctx.state, defId, ctx.controller, { z: "hand", player: ctx.controller });
      if (!placeOnField(ctx.state, card, zone)) return;
      ctx.events.push({
        type: "summoned",
        player: ctx.controller,
        instanceId: card.id,
        defId,
        row: zone.row,
        lane: zone.lane,
      });
    },
  };
}

/** Lock (§3.2) this controller's unit lane 1, which is where the R47 test parks its Reborn unit. */
function lockOwnFirstLane(): Effect {
  return {
    kind: "statecheck:lockLane1",
    apply(ctx): void {
      const ref = { player: ctx.controller, row: "units" as const, lane: 1 };
      lockZone(ctx.state, ref);
      ctx.events.push({ type: "locked", player: ref.player, row: ref.row, lane: ref.lane });
    },
  };
}

// ---------------------------------------------------------------------------
// Fixture cards.
// ---------------------------------------------------------------------------

let nextIndex = 900;

function unitDefOf(name: string, attack: number, health: number, keywords: Keyword[] = []): CardDef {
  nextIndex += 1;
  return {
    id: `sc-${name}`,
    index: String(nextIndex),
    name: `${name} (state check)`,
    set: "Core",
    type: "Unit",
    tags: [],
    rarity: "Common",
    token: false,
    cost: 0,
    base: { attack, health, keywords, text: name },
    radiant: { attack: attack * 2, health: health * 2, keywords, text: `${name} radiant` },
  };
}

function spellDefOf(name: string): CardDef {
  nextIndex += 1;
  return {
    id: `sc-${name}`,
    index: String(nextIndex),
    name: `${name} (state check)`,
    set: "Core",
    type: "Spell",
    tags: [],
    rarity: "Common",
    token: false,
    cost: 0,
    base: { keywords: [], text: name },
    radiant: { keywords: [], text: name },
  };
}

/** A 1/1 whose Death trigger pings the enemy hero, so the `damage` events give the firing order. */
const pinger = unitDefOf("pinger", 1, 1);
/** Reborn plus a Death trigger that summons: one card for R8, R64 and R47's zone logic. */
const rebornSummoner = unitDefOf("reborn-summoner", 2, 2, [{ kind: "Reborn" }]);
/** Reborn with a Cry, which §4.5 step 4 says must not fire on the way back. */
const rebornCrier = unitDefOf("reborn-crier", 2, 2, [{ kind: "Reborn" }]);
/** Reborn with no hooks at all, for the Locked-zone fizzle (R47). */
const rebornPlain = unitDefOf("reborn-plain", 2, 2, [{ kind: "Reborn" }]);
/** Its Death trigger Locks its controller's lane 1 while the state check is still running. */
const locker = unitDefOf("locker", 1, 1);
/** #55r / #66: Indestructible with printed Taunt, for R46's "loses Taunt until end of turn". */
const wardedTaunter = unitDefOf("indestructible-taunt", 4, 4, [{ kind: "Indestructible" }, { kind: "Taunt" }]);
/** Indestructible with a Death trigger, so R69 can show Death firing on a max-health death. */
const wardedPinger = unitDefOf("indestructible-pinger", 4, 4, [{ kind: "Indestructible" }]);
/** #46 Suppressive Aura, trimmed: enemy units get -4 max health (§10.4 layer 5). */
const suppressor = unitDefOf("suppressor", 1, 5);
/** What a Death trigger summons; a plain unit, so R11's token test stays about the token. */
const spawn = unitDefOf("spawn", 1, 1);
/** #12 Big Felinor, trimmed: one effect, nine damage to every unit on the board. */
const massSmite = spellDefOf("mass-smite");

/** A backrow Field Spell, for §4.5 step 1's "and backrow cards marked destroyed". */
const fieldSpell: CardDef = { ...spellDefOf("field-spell"), type: "Field Spell" };
/** #98: an Indestructible Field Spell, which R46 says simply stays when marked. */
const wardedFieldSpell: CardDef = {
  ...spellDefOf("warded-field-spell"),
  type: "Field Spell",
  base: { keywords: [{ kind: "Indestructible" }], text: "indestructible field spell" },
  radiant: { keywords: [{ kind: "Indestructible" }], text: "indestructible field spell" },
};
/** #22 Carnivorous Cube, trimmed: its Death trigger reads what it remembered while on the field. */
const rememberer = unitDefOf("rememberer", 2, 2);
/** A unit that replaces itself on death, so the state check can never come to rest (§4.5 step 5). */
const endless = unitDefOf("endless", 1, 1);

const rushToken = tokenDef("rush");

const DEFS: CardDef[] = [
  pinger,
  rebornSummoner,
  rebornCrier,
  rebornPlain,
  locker,
  wardedTaunter,
  wardedPinger,
  suppressor,
  spawn,
  massSmite,
  fieldSpell,
  wardedFieldSpell,
  rememberer,
];

function both(script: Script): CardScripts {
  return { base: script, radiant: script };
}

const pingEnemyHero: Script = { death: () => [damage({ to: { of: "enemyHero" }, amount: 1 })] };

const SCRIPTS: Record<string, CardScripts> = {
  [pinger.id]: both(pingEnemyHero),
  [wardedPinger.id]: both(pingEnemyHero),
  [rebornSummoner.id]: both({ death: () => [summonFirstFree(spawn.id)] }),
  [rebornCrier.id]: both({ cry: () => [damage({ to: { of: "enemyHero" }, amount: 5 })] }),
  [locker.id]: both({ death: () => [lockOwnFirstLane()] }),
  [suppressor.id]: both({
    aura: ({ self }) => [{ applies: (u) => u.controller !== self.controller, mod: { maxHealth: -4 } }],
  }),
  [massSmite.id]: both({ cry: () => [smiteEveryUnit(9)] }),
  // R78: the Death hook reads the meal this card remembered before it left the field.
  [rememberer.id]: both({
    death: (ctx) => {
      const eaten = ctx.self?.memory.eaten;
      return typeof eaten === "string" ? [summonFirstFree(eaten)] : [];
    },
  }),
};

/** A fresh game whose catalog and script registry also carry this file's fixtures. */
function game(seed: string): GameState {
  const state = newGame(seed);
  registerCatalog({ ...registeredCatalog(), ...Object.fromEntries(DEFS.map((def) => [def.id, def])) });
  registerScripts({ ...registeredScripts(), ...SCRIPTS });
  return state;
}

/** Enough damage to put a unit at 0 health, read through the layers (§10.4). */
function lethalDamage(state: GameState, id: string): void {
  const unit = findInstance(state, id);
  if (unit === undefined) throw new Error(`no instance ${id}`);
  unit.damage = unitView(state, unit).maxHealth;
}

const heroPings = (events: readonly GameEvent[]): (string | null)[] =>
  eventsOfType(events, "damage")
    .filter((event) => event.targetId.startsWith("hero-"))
    .map((event) => event.sourceId);

describe("the state check (M2-T5)", () => {
  it("R68: one effect kills six units in one check and fires six Death triggers, active side first, then lane order", () => {
    // Placed out of lane order on purpose: R68 orders by lane, not by creation.
    const placements = [
      { player: "p1" as const, lane: 3 },
      { player: "p1" as const, lane: 1 },
      { player: "p1" as const, lane: 5 },
      { player: "p2" as const, lane: 4 },
      { player: "p2" as const, lane: 5 },
      { player: "p2" as const, lane: 2 },
    ];

    for (const active of PLAYER_IDS) {
      const state = game(`six-deaths-${active}`);
      state.turn = 4;
      state.active = active;

      const placed = placements.map((at) => ({
        ...at,
        id: put(state, pinger.id, slot(at.player, "units", at.lane)).id,
      }));
      const sides: PlayerId[] = active === "p1" ? ["p1", "p2"] : ["p2", "p1"];
      const expected = sides.flatMap((player) =>
        placed
          .filter((entry) => entry.player === player)
          .sort((a, b) => a.lane - b.lane)
          .map((entry) => entry.id),
      );

      const events: GameEvent[] = [];
      const sink = sinkFor(state, events);
      const spell = newInstance(state, massSmite.id, "p1", { z: "resolving", player: "p1" });

      runHook(sink, spell, "cry");
      // §4.5: the whole effect lands first; nothing has died yet.
      expect(eventsOfType(events, "destroyed")).toHaveLength(0);

      stateCheck(sink);

      expect(eventsOfType(events, "destroyed")).toHaveLength(6);
      expect(state.counters.destroyed).toBe(6);
      expect(heroPings(events)).toEqual(expected);
      expect(activeUnitsOf(state, "p1")).toHaveLength(0);
      expect(activeUnitsOf(state, "p2")).toHaveLength(0);
      expect(state.players.p1.graveyard).toHaveLength(3);
      expect(state.players.p2.graveyard).toHaveLength(3);
    }
  });

  it("R8, R64: a Reborn unit reserves its zone, a Death-trigger summon lands elsewhere, and Death fires on both deaths", () => {
    const state = game("reborn-reserved");
    state.turn = 2;
    state.active = "p1";
    const reborner = put(state, rebornSummoner.id, slot("p1", "units", 1));
    lethalDamage(state, reborner.id);

    const events: GameEvent[] = [];
    stateCheck(sinkFor(state, events));

    // Its own Death trigger summoned while lane 1 was reserved, so the spawn took lane 2 (R64).
    expect(cardAt(state, slot("p1", "units", 2))?.defId).toBe(spawn.id);
    // And the unit itself came back to its own zone at 1 health without Reborn.
    expect(cardAt(state, slot("p1", "units", 1))?.id).toBe(reborner.id);
    expect(unitView(state, reborner)).toMatchObject({ maxHealth: 2, health: 1 });
    expect(unitHas(state, reborner, "Reborn")).toBe(false);
    expect(reborner.rebornSpent).toBe(true);
    expect(state.reserved).toHaveLength(0);
    expect(state.players.p1.graveyard).toHaveLength(0);
    // A Reborn unit only passes through the graveyard, so it reports no stay there (§4.5 step 4).
    expect(eventsOfType(events, "enteredGraveyard")).toHaveLength(0);
    expect(eventsOfType(events, "destroyed").map((e) => e.instanceId)).toEqual([reborner.id]);

    // R8: the second death fires Death again, and this time the unit stays dead.
    const again: GameEvent[] = [];
    reborner.damage += 1;
    stateCheck(sinkFor(state, again));

    expect(eventsOfType(again, "destroyed").map((e) => e.instanceId)).toEqual([reborner.id]);
    expect(state.counters.destroyed).toBe(2);
    // Nothing reserved the zone this time, so the second spawn took the leftmost free lane 1.
    expect(cardAt(state, slot("p1", "units", 1))?.defId).toBe(spawn.id);
    expect(state.players.p1.graveyard.map((card) => card.id)).toEqual([reborner.id]);
    expect(eventsOfType(again, "enteredGraveyard").map((e) => e.instanceId)).toEqual([reborner.id]);
  });

  it("R47: Reborn into a zone that was Locked meanwhile fails silently", () => {
    const state = game("reborn-locked");
    state.turn = 2;
    state.active = "p1";
    const reborner = put(state, rebornPlain.id, slot("p1", "units", 1));
    const lane2 = put(state, locker.id, slot("p1", "units", 2));
    lethalDamage(state, reborner.id);
    lethalDamage(state, lane2.id);

    const events: GameEvent[] = [];
    stateCheck(sinkFor(state, events));

    // The locker's Death trigger fired after the Reborn unit was collected, so the zone it had
    // reserved is Locked by the time step 4 tries to put it back.
    expect(isLocked(state, slot("p1", "units", 1))).toBe(true);
    expect(cardAt(state, slot("p1", "units", 1))).toBeNull();
    expect(state.players.p1.graveyard.map((card) => card.id)).toContain(reborner.id);
    expect(state.reserved).toHaveLength(0);
    expect(eventsOfType(events, "summoned")).toHaveLength(0);
    expect(eventsOfType(events, "destroyed")).toHaveLength(2);
  });

  it("R46: an Indestructible unit destroyed by an effect is in Attack Position with no Taunt until end of turn", () => {
    const state = game("indestructible-mark");
    state.turn = 3;
    state.active = "p1";
    const warded = put(state, wardedTaunter.id, slot("p1", "units", 1));
    warded.position = "DEF";
    expect(unitHas(state, warded, "Taunt")).toBe(true);

    warded.markedDestroyed = true;
    const events: GameEvent[] = [];
    stateCheck(sinkFor(state, events));

    expect(cardAt(state, slot("p1", "units", 1))?.id).toBe(warded.id);
    expect(warded.markedDestroyed).not.toBe(true);
    expect(unitView(state, warded).position).toBe("ATK");
    expect(unitHas(state, warded, "Taunt")).toBe(false);
    expect(warded.tauntSuppressedTurn).toBe(3);
    expect(eventsOfType(events, "positionSwitched")).toEqual([
      { type: "positionSwitched", instanceId: warded.id, position: "ATK" },
    ]);
    expect(eventsOfType(events, "destroyed")).toHaveLength(0);
    expect(state.counters.destroyed).toBe(0);
    expect(state.players.p1.graveyard).toHaveLength(0);

    // "Until end of turn": on the next turn the printed Taunt is back.
    state.turn = 4;
    expect(unitHas(state, warded, "Taunt")).toBe(true);
  });

  it("R69: an Indestructible unit at 0 max health dies and counts as destroyed, one at 0 health with max health above 0 stays", () => {
    const state = game("indestructible-max-health");
    state.turn = 2;
    state.active = "p1";
    // Suppressive Aura on p2's side: p1's units get -4 max health.
    put(state, suppressor.id, slot("p2", "units", 5));
    const dying = put(state, wardedPinger.id, slot("p1", "units", 1));
    const survivor = put(state, wardedPinger.id, slot("p2", "units", 1));
    // Damage taken before it became Indestructible: health is negative, max health is not.
    survivor.damage = 10;

    expect(unitView(state, dying).maxHealth).toBe(0);
    expect(unitView(state, survivor)).toMatchObject({ maxHealth: 4, health: -6 });

    const events: GameEvent[] = [];
    stateCheck(sinkFor(state, events));

    expect(eventsOfType(events, "destroyed").map((e) => e.instanceId)).toEqual([dying.id]);
    expect(state.counters.destroyed).toBe(1);
    expect(state.players.p1.graveyard.map((card) => card.id)).toEqual([dying.id]);
    // No destroy effect was involved, so Death fires like any other death.
    expect(heroPings(events)).toEqual([dying.id]);
    expect(eventsOfType(events, "damage").map((e) => e.targetId)).toEqual(["hero-p2"]);

    expect(cardAt(state, slot("p2", "units", 1))?.id).toBe(survivor.id);
    expect(unitView(state, survivor).health).toBe(-6);
  });

  it("R59: the check runs after a whole effect, not between its hits", () => {
    let state = game("r59-whole-effect");
    const begun = beginGame(state);
    state = begun.state;
    for (const player of PLAYER_IDS) {
      const answered = reduce(state, {
        type: "mulligan",
        keep: state.players[player].hand.map((card) => card.id),
        playerId: player,
        nonce: `m-${player}`,
      });
      expect(answered.error).toBeUndefined();
      state = answered.state;
    }

    const first = put(state, pinger.id, slot("p2", "units", 1));
    const second = put(state, pinger.id, slot("p2", "units", 2));
    const spell = newInstance(state, massSmite.id, "p1", { z: "hand", player: "p1" });
    state.players.p1.hand.push(spell);

    const result = reduce(state, { type: "play", instanceId: spell.id, playerId: "p1", nonce: "r59" });
    expect(result.error).toBeUndefined();

    const types = result.events.map((event) => event.type);
    const hits = result.events.flatMap((event, index) =>
      event.type === "damage" && event.sourceId === spell.id ? [index] : [],
    );
    const firstDestroyed = types.indexOf("destroyed");

    // Both hits of the one effect land before anything is collected.
    expect(hits).toHaveLength(2);
    expect(firstDestroyed).toBeGreaterThan(Math.max(...hits));
    // And both Death triggers fire after the collection, not between the hits.
    const pings = result.events.flatMap((event, index) =>
      event.type === "damage" && event.targetId === "hero-p1" ? [index] : [],
    );
    expect(pings).toHaveLength(2);
    expect(Math.min(...pings)).toBeGreaterThan(firstDestroyed);
    expect(eventsOfType(result.events, "destroyed").map((e) => e.instanceId)).toEqual([first.id, second.id]);
    expect(findInstance(result.state, first.id)?.zone.z).toBe("graveyard");
    expect(findInstance(result.state, second.id)?.zone.z).toBe("graveyard");
  });

  it("R78: a Reborn unit returns reset, at 1 health without Reborn, and its Cry does not fire", () => {
    const state = game("reborn-cry");
    state.turn = 2;
    state.active = "p1";
    const crier = put(state, rebornCrier.id, slot("p1", "units", 1));
    crier.buffs = { attack: 3, health: 3 };
    crier.grantedKeywords = [{ kind: "Taunt" }];
    crier.position = "DEF";
    lethalDamage(state, crier.id);
    const enemyHero = state.players.p2.hero.health;

    const events: GameEvent[] = [];
    stateCheck(sinkFor(state, events));

    expect(cardAt(state, slot("p1", "units", 1))?.id).toBe(crier.id);
    expect(unitView(state, crier)).toMatchObject({ attack: 2, maxHealth: 2, health: 1 });
    expect(unitHas(state, crier, "Reborn")).toBe(false);
    expect(unitHas(state, crier, "Taunt")).toBe(false);
    expect(crier.buffs).toEqual({ attack: 0, health: 0 });
    expect(crier.position).toBe("ATK");
    // The Cry would have hit the enemy hero for 5; a Reborn return never fires it (R1, §4.5).
    expect(state.players.p2.hero.health).toBe(enemyHero);
    expect(eventsOfType(events, "damage")).toHaveLength(0);
    expect(eventsOfType(events, "summoned").map((e) => e.instanceId)).toEqual([crier.id]);
  });

  it("R11: a destroyed unit token vanishes instead of entering a graveyard", () => {
    const state = game("token-vanishes");
    state.turn = 2;
    state.active = "p1";
    const token = put(state, rushToken.id, slot("p1", "units", 1));
    lethalDamage(state, token.id);

    const events: GameEvent[] = [];
    stateCheck(sinkFor(state, events));

    expect(cardAt(state, slot("p1", "units", 1))).toBeNull();
    expect(eventsOfType(events, "destroyed").map((e) => e.instanceId)).toEqual([token.id]);
    expect(state.counters.destroyed).toBe(1);
    expect(state.players.p1.graveyard).toHaveLength(0);
    expect(state.players.p1.exile).toHaveLength(0);
    expect(eventsOfType(events, "enteredGraveyard")).toHaveLength(0);
    expect(findInstance(state, token.id)).toBeUndefined();
  });

  it("R59: both heroes at 0 in one check is a draw, one hero at 0 is a loss", () => {
    const drawn = game("both-heroes");
    drawn.turn = 5;
    drawn.players.p1.hero.health = 0;
    drawn.players.p2.hero.health = -3;
    const drawEvents: GameEvent[] = [];
    stateCheck(sinkFor(drawn, drawEvents));

    expect(drawn.result).toEqual({ winner: "draw", reason: "both-heroes-dead" });
    expect(drawn.phase).toBe("over");
    expect(eventsOfType(drawEvents, "gameOver")).toEqual([
      { type: "gameOver", winner: "draw", reason: "both-heroes-dead" },
    ]);

    const lost = game("one-hero");
    lost.turn = 5;
    lost.players.p2.hero.health = 0;
    const lossEvents: GameEvent[] = [];
    stateCheck(sinkFor(lost, lossEvents));

    expect(lost.result).toEqual({ winner: "p1", reason: "hero-death" });
    expect(lost.phase).toBe("over");
    expect(eventsOfType(lossEvents, "gameOver")).toEqual([
      { type: "gameOver", winner: "p1", reason: "hero-death" },
    ]);
  });
  it("§4.5 step 1 collects a backrow card an effect marked destroyed", () => {
    const state = game("backrow-destroy");
    const card = put(state, fieldSpell.id, slot("p1", "backrow", 2));
    card.markedDestroyed = true;

    const events: GameEvent[] = [];
    stateCheck(sinkFor(state, events));

    expect(cardAt(state, slot("p1", "backrow", 2))).toBeNull();
    expect(state.players.p1.graveyard.map((c) => c.id)).toEqual([card.id]);
    expect(eventsOfType(events, "destroyed").map((e) => e.instanceId)).toEqual([card.id]);
    expect(eventsOfType(events, "enteredGraveyard").map((e) => e.instanceId)).toEqual([card.id]);
    expect(state.counters.destroyed).toBe(1);
  });

  it("R46 leaves an Indestructible Field Spell where it is and drops the mark", () => {
    const state = game("backrow-indestructible");
    const card = put(state, wardedFieldSpell.id, slot("p1", "backrow", 1));
    card.markedDestroyed = true;

    const events: GameEvent[] = [];
    stateCheck(sinkFor(state, events));

    expect(cardAt(state, slot("p1", "backrow", 1))?.id).toBe(card.id);
    expect(card.markedDestroyed).toBe(false);
    expect(eventsOfType(events, "destroyed")).toEqual([]);
    expect(eventsOfType(events, "positionSwitched")).toEqual([]); // a Field Spell has no position
    expect(state.counters.destroyed).toBe(0);
  });

  it("R78 a Death trigger reads what the unit remembered before it left the field", () => {
    const state = game("death-last-known");
    const eater = put(state, rememberer.id, slot("p1", "units", 2));
    eater.memory.eaten = spawn.id;
    eater.markedDestroyed = true;

    const events: GameEvent[] = [];
    stateCheck(sinkFor(state, events));

    // R78 wipes the instance's memory on the way out, so the hook must read the snapshot.
    expect(eater.memory).toEqual({});
    expect(state.players.p1.graveyard.map((c) => c.id)).toEqual([eater.id]);
    const summoned = eventsOfType(events, "summoned");
    expect(summoned).toHaveLength(1);
    expect(summoned[0]?.defId).toBe(spawn.id);
    expect(cardAt(state, slot("p1", "units", 1))?.defId).toBe(spawn.id);
  });

  it("R47 says so in the event stream when a Reborn return fizzles into a Locked zone", () => {
    const state = game("reborn-fizzle-event");
    const unit = put(state, rebornPlain.id, slot("p1", "units", 1));
    const lockerUnit = put(state, locker.id, slot("p1", "units", 3));
    unit.markedDestroyed = true;
    lockerUnit.markedDestroyed = true;

    const events: GameEvent[] = [];
    stateCheck(sinkFor(state, events));

    expect(isLocked(state, slot("p1", "units", 1))).toBe(true);
    expect(cardAt(state, slot("p1", "units", 1))).toBeNull();
    expect(state.players.p1.graveyard.map((c) => c.id)).toContain(unit.id);
    // The card really is in the graveyard, so the stream has to report it (§10.3).
    expect(eventsOfType(events, "enteredGraveyard").map((e) => e.instanceId)).toContain(unit.id);
    expect(eventsOfType(events, "summoned")).toEqual([]);
  });
});

describe("what a death reports (R89, M3)", () => {
  it("R89 reports the dying card's owner, its last stats and the unit that killed it", () => {
    const state = game("death-report");
    state.active = "p1";
    const killer = put(state, pinger.id, slot("p1", "units", 1));
    const victim = put(state, spawn.id, slot("p2", "units", 1)); // printed 1/1
    victim.buffs = { attack: 3, health: 4 }; // a 4/5 body when it dies
    victim.grantedKeywords = [{ kind: "Taunt" }];

    const view = unitView(state, victim);
    expect(view).toMatchObject({ attack: 4, maxHealth: 5 });

    const events: GameEvent[] = [];
    const sink = sinkFor(state, events);
    dealDamage(sink, { source: killer, target: { kind: "unit", instance: victim }, amount: 5 });
    stateCheck(sink);

    expect(eventsOfType(events, "destroyed")).toEqual([
      {
        type: "destroyed",
        instanceId: victim.id,
        defId: spawn.id,
        owner: "p2",
        // R89: the stats the layers computed at the moment it died, not the printed 1/1.
        attack: 4,
        maxHealth: 5,
        killerId: killer.id,
      },
    ]);

    // R78 has wiped the instance by now, which is why the event has to carry it.
    expect(victim.buffs).toEqual({ attack: 0, health: 0 });
    expect(victim.lastDamagedBy).toBeUndefined();
  });

  it("R89 reports no killer when nothing dealt the lethal damage", () => {
    const state = game("death-report-no-killer");
    state.active = "p1";
    const victim = put(state, spawn.id, slot("p1", "units", 1));
    victim.markedDestroyed = true; // destroyed by an effect, not by a unit's damage

    const events: GameEvent[] = [];
    stateCheck(sinkFor(state, events));

    expect(eventsOfType(events, "destroyed")).toEqual([
      {
        type: "destroyed",
        instanceId: victim.id,
        defId: spawn.id,
        owner: "p1",
        attack: 1,
        maxHealth: 1,
        killerId: null,
      },
    ]);
  });
});

describe("the pass cap (§4.5 step 5)", () => {
  it("throws when a board cannot settle, rather than returning a half-checked one", () => {
    const state = game("never-settles");
    state.active = "p1";

    // A unit whose Death summons another of the same kind, each arriving already dead: §4.5 step 5
    // would repeat for ever, so the cap is what stops it — loudly (STATE_CHECK_PASS_CAP).
    registerCatalog({ ...registeredCatalog(), [endless.id]: endless });
    registerScripts({
      ...registeredScripts(),
      [endless.id]: {
        base: { death: () => [summon({ defId: endless.id, statsOverride: { attack: 0, health: 0 } })] },
        radiant: { death: () => [summon({ defId: endless.id, statsOverride: { attack: 0, health: 0 } })] },
      },
    });

    const doomed = put(state, endless.id, slot("p1", "units", 1));
    doomed.statsOverride = { attack: 0, health: 0 };

    expect(() => stateCheck(sinkFor(state))).toThrow(/did not settle in 100 passes/);
    expect(STATE_CHECK_PASS_CAP).toBe(100);
  });
});
