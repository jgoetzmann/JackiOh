// The M3 gate's second half (BUILD.md): one `it("R<n> …")` per SPEC §11 row from R43 to R84.
//
// Every fixture in this file is its own — defs prefixed `rb-`, registered on top of the shared
// fixture catalog by `game()` — so it cannot collide with another test file's fixtures (BUILD §0).
// Rows whose behaviour belongs to a card that does not exist until M4 test the engine machinery the
// card will call and name the card test that proves the rest.

import type {
  Action,
  ActionInput,
  CardDef,
  CardType,
  Keyword,
  Tag,
} from "@jackioh/shared";
import { GAME_EVENT_TYPES, PLAYER_IDS, hasKeyword } from "@jackioh/shared";
import { describe, expect, it } from "vitest";
import { defByIndex, defOf, query, queryCost, registerCatalog, registeredCatalog } from "../src/catalog";
import * as engineConfig from "../src/config";
import {
  AI_END_TURN_PROBABILITY,
  CAST_ON_DRAW_CHAIN_CAP,
  FUSE_COST_CAP,
  GENN_GREED_EXILES,
  HAND_CAP,
  HERO_HEALTH,
  LIBRARY_CAP,
  MAX_MANA,
  OPENING_DRAW,
  UNIT_ZONES,
  fib,
} from "../src/config";
import {
  declareAttack,
  forceAttack,
  forceAttacksOn,
  hasExertion,
  switchPosition,
  whyCannotAttack,
} from "../src/combat";
import { dealDamage, healHero } from "../src/damage";
import { addToHand as putInHand, draw as drawCards, drawOne, shuffleIntoLibrary } from "../src/draw";
import {
  addToHand as addToHandEffect,
  chosenOptions,
  damage as damageEffect,
  destroy,
  discoverFromCatalog,
  discoverFromGraveyard,
  exile,
  fillBoard,
  recruit,
  setRadiant,
  setRadiantRandom,
  shuffleCopiesOfSelf,
  steal,
  summon,
  transform,
} from "../src/effects";
import { unitHas, unitView } from "../src/layers";
import { effectiveCost, isXCost, printedCost } from "../src/mana";
import { addModifier, dueDelayed, scheduleDelayed } from "../src/modifiers";
import { openPrompt } from "../src/prompts";
import { beginGame, legalActions, reduce } from "../src/reduce";
import { applyEffects, castCard, makeContext, runHook } from "../src/resolve";
import { createRng } from "../src/rng";
import type { CardScripts, Effect, Script } from "../src/script";
import { registerScripts, registeredScripts, scriptsFor } from "../src/scripts";
import { openingDrawFor } from "../src/setup";
import { stateCheck } from "../src/stateCheck";
import { findInstance, newInstance, type CardInstance, type GameState } from "../src/state";
import { AI_SKIPPED_ACTIONS, chooseAction, fuse, isLethal, policyActions, projectedDamage } from "../src/subsystems";
import { ensurePower, powerCostOf, powerOf, usePower, whyCannotActivate } from "../src/subsystems/heroPower";
import { isTrapType } from "../src/traps";
import { cardsInTriggerOrder } from "../src/triggers";
import { viewFor } from "../src/viewFor";
import {
  activeUnitsOf,
  cardAt,
  isOpen,
  isReserved,
  lockZone,
  moveToZone,
  releaseZone,
  reserveZone,
  slotsOf,
} from "../src/zones";
import { eventsOfType, inHand, newGame, playRandomGame, put, setLibrary, sinkFor, slot } from "./fixtures/harness";

// ---------------------------------------------------------------------------
// Fixture definitions. Ids are `rb-` prefixed and indexes start above every other
// fixture file's, so `defByIndex` and the catalog query stay unambiguous.
// ---------------------------------------------------------------------------

let nextIndex = 1200;

function unitDefOf(
  name: string,
  attack: number,
  health: number,
  keywords: Keyword[] = [],
  overrides: Partial<CardDef> = {},
): CardDef {
  nextIndex += 1;
  return {
    id: `rb-${name}`,
    index: String(nextIndex),
    name: `${name} (rulings-b)`,
    set: "Core",
    type: "Unit",
    tags: [],
    rarity: "Common",
    token: false,
    cost: 0,
    base: { attack, health, keywords, text: name },
    radiant: { attack: attack * 2, health: health * 2, keywords, text: `${name} radiant` },
    ...overrides,
  };
}

function cardDefOf(name: string, type: CardType, overrides: Partial<CardDef> = {}): CardDef {
  nextIndex += 1;
  return {
    id: `rb-${name}`,
    index: String(nextIndex),
    name: `${name} (rulings-b)`,
    set: "Core",
    type,
    tags: [],
    rarity: "Common",
    token: false,
    cost: 0,
    base: { keywords: [], text: name },
    radiant: { keywords: [], text: name },
    ...overrides,
  };
}

const plain = unitDefOf("plain", 3, 3);
const bigBody = unitDefOf("big-body", 5, 5);
const small = unitDefOf("small", 1, 2);
const wardedTaunter = unitDefOf("warded-taunt", 4, 4, [{ kind: "Indestructible" }, { kind: "Taunt" }]);
const wardedPinger = unitDefOf("warded-pinger", 4, 4, [{ kind: "Indestructible" }]);
const rebornUnit = unitDefOf("reborn", 2, 2, [{ kind: "Reborn" }]);
const duelist = unitDefOf("duelist", 4, 3);
const immutable = unitDefOf("immutable", 2, 2, [{ kind: "Immutable" }]);
const trampler = unitDefOf("trampler", 6, 4, [{ kind: "Trample" }]);
const trampleLeech = unitDefOf("trample-leech", 6, 4, [{ kind: "Trample" }, { kind: "Lifesteal" }]);
const cleaver = unitDefOf("cleaver", 3, 6, [{ kind: "Cleave" }]);
const shielded = unitDefOf("shielded", 2, 2, [{ kind: "Divine Shield" }]);
const armoured = unitDefOf("armoured", 1, 6, [{ kind: "Armor", n: 5 }]);
const poisoner = unitDefOf("poisoner", 1, 4, [{ kind: "Poisonous" }]);
const zeroAttack = unitDefOf("zero-attack", 0, 6);
/** §5.2's last bullet: a card with no radiant form still sets the flag (R74). */
const sameFace = unitDefOf("same-face", 2, 2, [], {
  radiant: { attack: 2, health: 2, keywords: [], text: "no radiant form" },
});
const rememberer = unitDefOf("rememberer", 2, 2);
const kpop = unitDefOf("kpop", 2, 2);
const clock = unitDefOf("clock", 1, 1);
const fuseA = unitDefOf("fuse-a", 2, 3, [{ kind: "Taunt" }], { cost: 2, tags: ["Human"] });
const fuseB = unitDefOf("fuse-b", 1, 1, [{ kind: "Rush" }], { cost: 3, tags: ["Felinor"] });
/** §7: a unit token, which ceases to exist off the field (R11, R80). */
const unitToken = unitDefOf("token", 3, 3, [{ kind: "Rush" }], {
  token: true,
  rarity: "Token",
  tags: ["Token"],
  index: "T-rb",
});

const noop = cardDefOf("noop", "Spell");
const pricey = cardDefOf("pricey", "Spell", { cost: 3 });
const giga = cardDefOf("giga", "Spell", { cost: 6 });
const xCard = cardDefOf("x-card", "Spell", { cost: "X" });
const embiggenCard = cardDefOf("embiggen", "Spell", { cost: { base: 2, embiggen: 4 } });
/** R75: a token index of the "N.1" form the §5.3 table normalises (#90.1). */
const dotted = cardDefOf("dotted", "Spell", { index: "51.1" });
const spellToken = cardDefOf("spell-token", "Spell", { token: true, rarity: "Token", tags: ["Token"] });
const caster = cardDefOf("caster", "Spell");
const splitter = cardDefOf("splitter", "Spell");
const allEnemies = cardDefOf("all-enemies", "Spell");
const modeSpell = cardDefOf("mode-spell", "Spell");
const discoverSpell = cardDefOf("discover-spell", "Spell");
const recycler = cardDefOf("recycler", "Field Spell");
const logCardDef = cardDefOf("log", "Field Spell");
const heroic = cardDefOf("heroic", "Field Spell", { cost: "X" });
const windowTrap = cardDefOf("window-trap", "Field Trap");
const breadTrap = cardDefOf("bread-trap", "Field Trap");
const emptyTrap = cardDefOf("empty-trap", "Trap");

const DEFS: CardDef[] = [
  plain,
  bigBody,
  small,
  wardedTaunter,
  wardedPinger,
  rebornUnit,
  duelist,
  immutable,
  trampler,
  trampleLeech,
  cleaver,
  shielded,
  armoured,
  poisoner,
  zeroAttack,
  sameFace,
  rememberer,
  kpop,
  clock,
  fuseA,
  fuseB,
  unitToken,
  noop,
  pricey,
  giga,
  xCard,
  embiggenCard,
  dotted,
  spellToken,
  caster,
  splitter,
  allEnemies,
  modeSpell,
  discoverSpell,
  recycler,
  logCardDef,
  heroic,
  windowTrap,
  breadTrap,
  emptyTrap,
];

// ---------------------------------------------------------------------------
// Fixture effects: the verbs these rows need that no card ships until M4.
// ---------------------------------------------------------------------------

/** R51 "all enemies": every enemy unit plus the enemy hero, one damage instance each. */
function rbDamageAllEnemies(amount: number): Effect {
  return {
    kind: "rb:damageAllEnemies",
    apply(ctx): void {
      const enemy = ctx.controller === "p1" ? "p2" : "p1";
      for (const unit of activeUnitsOf(ctx.state, enemy)) {
        dealDamage(ctx, { source: ctx.self, target: { kind: "unit", instance: unit }, amount });
      }
      dealDamage(ctx, { source: ctx.self, target: { kind: "hero", player: enemy }, amount });
    },
  };
}

/** One effect, many hits: R59's "never between the hits of one effect". */
function rbDamageEnemyUnits(amount: number): Effect {
  return {
    kind: "rb:damageEnemyUnits",
    apply(ctx): void {
      const enemy = ctx.controller === "p1" ? "p2" : "p1";
      for (const unit of activeUnitsOf(ctx.state, enemy)) {
        dealDamage(ctx, { source: ctx.self, target: { kind: "unit", instance: unit }, amount });
      }
    },
  };
}

/** #39 Recycling Initiative's engine half (R71): every other card played this turn, copied. */
function rbCopyOthersPlayedThisTurn(): Effect {
  return {
    kind: "rb:copyOthersPlayed",
    apply(ctx): void {
      const side = ctx.state.players[ctx.controller];
      for (const id of [...side.turnLog.playedIds]) {
        if (id === ctx.self?.id) continue;
        const played = findInstance(ctx.state, id);
        if (played === undefined) continue;
        const copy = newInstance(ctx.state, played.defId, ctx.controller, { z: "hand", player: ctx.controller });
        putInHand(ctx, copy);
      }
    },
  };
}

/** R62's ordering log, kept on the card in p1's backrow lane 5 so it survives a `reduce` clone. */
function rbNote(name: string): Effect {
  return {
    kind: "rb:note",
    apply(ctx): void {
      const log = ctx.state.players.p1.backrow[4];
      if (log === null || log === undefined) return;
      const steps = Array.isArray(log.memory.steps) ? (log.memory.steps as string[]) : [];
      log.memory.steps = [...steps, name];
    },
  };
}

function rbSteps(state: GameState): string[] {
  const log = state.players.p1.backrow[4];
  return Array.isArray(log?.memory.steps) ? (log.memory.steps as string[]) : [];
}

// ---------------------------------------------------------------------------
// Fixture scripts.
// ---------------------------------------------------------------------------

function both(script: Script): CardScripts {
  return { base: script, radiant: script };
}

const pingEnemyHero = (amount: number): Script => ({
  cry: () => [damageEffect({ to: { of: "enemyHero" }, amount })],
});

const SCRIPTS: Record<string, CardScripts> = {
  [duelist.id]: both({ staticFlags: { deftDuelist: true } }),
  [caster.id]: both({ staticFlags: { castOnDraw: true } }),
  [splitter.id]: both({ cry: () => [rbDamageEnemyUnits(9)] }),
  [allEnemies.id]: both({ cry: () => [rbDamageAllEnemies(2)] }),
  [pricey.id]: both(pingEnemyHero(1)),
  [fuseA.id]: both(pingEnemyHero(1)),
  [fuseB.id]: both(pingEnemyHero(2)),
  // R43: the card's cost is the power's X, reported by the card's own `cost` script.
  [heroic.id]: both({ cost: ({ instance }) => powerCostOf(instance) }),
  [recycler.id]: both({ endOfTurn: () => [rbCopyOthersPlayedThisTurn()] }),
  [clock.id]: both({
    startOfTurn: (ctx) => [rbNote(`start:lib${ctx.state.players.p1.library.length}`)],
    endOfTurn: () => [rbNote("end")],
    delayed: () => [rbNote("delayed")],
  }),
  [windowTrap.id]: both({
    triggers: [{ id: "turn-end", on: ["turnEnded"], run: (ctx) => [rbNote(`trap:${ctx.controller}`)] }],
  }),
  // #18 Bread and Butter's engine half (R52): the token goes to the trap's controller.
  [breadTrap.id]: both({
    triggers: [
      {
        id: "turn-end",
        on: ["turnEnded"],
        run: ({ event }) =>
          event.type === "turnEnded" && event.unspentMana > 0 ? [summon({ defId: unitToken.id })] : [],
      },
    ],
  }),
  // R61: a trap with no legal target still fires, is consumed and does nothing.
  [emptyTrap.id]: both({ triggers: [{ id: "no-target", on: ["cardPlayed"], run: () => [] }] }),
  // #50 Kpop Fanatic's engine half (R76): a delayed steal naming its target as data.
  [kpop.id]: both({
    delayed: (ctx) => {
      const target = ctx.data.target;
      return typeof target === "string" ? [steal({ instanceId: target })] : [];
    },
  }),
  // R78: the Death hook reads what the card remembered just before it left the field.
  [rememberer.id]: both({
    death: (ctx) =>
      typeof ctx.self?.memory.note === "string" ? [damageEffect({ to: { of: "enemyHero" }, amount: 4 })] : [],
  }),
  [wardedPinger.id]: both({ death: () => [damageEffect({ to: { of: "enemyHero" }, amount: 1 })] }),
  // R81: the choices a card declares travel in the `play` action, never as a prompt.
  [modeSpell.id]: both({
    targets: [{ kind: "target", min: 1, max: 1 }],
    modes: [{ kind: "direction", options: ["left", "right"] }],
    cry: (ctx) => [damageEffect({ to: { of: "chosen" }, amount: ctx.modes[0] === "left" ? 1 : 5 })],
  }),
  // R81: a choice made during resolution opens a PendingChoice instead.
  [discoverSpell.id]: both({
    cry: () => [discoverFromCatalog({ step: "pick", query: { type: "Unit" } })],
    resume: {
      pick: (ctx) => {
        const defId = chosenOptions(ctx)[0];
        return defId === undefined ? [] : [addToHandEffect({ defId })];
      },
    },
  }),
};

// ---------------------------------------------------------------------------
// Harness.
// ---------------------------------------------------------------------------

/** A fresh game whose catalog and script registry also carry this file's fixtures. */
function game(seed: string): GameState {
  const state = newGame(seed);
  registerCatalog({ ...registeredCatalog(), ...Object.fromEntries(DEFS.map((def) => [def.id, def])) });
  registerScripts({ ...registeredScripts(), ...SCRIPTS });
  return state;
}

let nonce = 0;

function actResult(state: GameState, body: ActionInput): ReturnType<typeof reduce> {
  nonce += 1;
  return reduce(state, { ...body, nonce: `rb${nonce}` } as Action);
}

function act(state: GameState, body: ActionInput): GameState {
  const result = actResult(state, body);
  if (result.error !== undefined) throw new Error(result.error);
  return result.state;
}

/** Past the mulligans, in the main phase of turn 1. */
function playing(seed: string): GameState {
  let state = beginGame(game(seed)).state;
  state = act(state, { type: "mulligan", keep: state.players.p1.hand.map((c) => c.id), playerId: "p1" });
  state = act(state, { type: "mulligan", keep: state.players.p2.hand.map((c) => c.id), playerId: "p2" });
  return state;
}

function only<T>(items: readonly T[]): T {
  const first = items[0];
  if (first === undefined) throw new Error("expected at least one item");
  return first;
}

function handCard(state: GameState, defId: string, player: "p1" | "p2" = "p1"): CardInstance {
  return only(inHand(state, defId, player));
}

/** R79: the server owns these, in apps/server/src/config.ts (BUILD §2, M7). */
const SERVER_CONSTANTS = [
  "TURN_CLOCK_SECONDS",
  "PROMPT_CLOCK_SECONDS",
  "DISCONNECT_GRACE_SECONDS",
  "MATCH_CEILING_MINUTES",
  "ROOM_CODE_LENGTH",
  "ELO_K",
  "ELO_START",
];

describe("SPEC §11 rulings R43–R84 (M3 gate)", () => {
  it("R43 stores Heroic Power's power on the instance, costs its X, uses it once a turn and recruits a permanent", () => {
    const state = game("r43");
    const card = put(state, heroic.id, slot("p1", "backrow", 1));
    const sink = sinkFor(state);

    // The power lives on the instance, and one that arrives without a power rolls as it arrives.
    expect(card.memory.power).toBeUndefined();
    const rolled = ensurePower(sink, card);
    expect(rolled).not.toBeNull();
    expect(card.memory.power).toBe(rolled?.name);
    expect(ensurePower(sink, card)?.name).toBe(rolled?.name);

    // The cost is always the power's X, never a number the player chose.
    card.memory.power = "recruit";
    expect(powerOf(card)?.x).toBe(3);
    expect(powerCostOf(card)).toBe(3);
    expect(effectiveCost(state, card)).toBe(3);

    // "Recruit a card" recruits a permanent: the Spell on top of the library is skipped.
    setLibrary(state, "p1", [noop.id, plain.id]);
    applyEffects([usePower({ instanceId: card.id })], makeContext(sink, card, { controller: "p1" }));
    expect(activeUnitsOf(state, "p1").map((u) => u.defId)).toEqual([plain.id]);
    expect(state.players.p1.library.map((c) => c.defId)).toEqual([noop.id]);

    // And that activation is the turn's use.
    expect(card.memory.usedTurn).toBe(state.turn);
    expect(whyCannotActivate(state, "p1", card.id)).toBe("that power has already been used this turn");
  });

  it("R44 projects lethal after Armor, the cap and Trample excess, and the policy draws from legalActions", () => {
    const state = game("r44");
    const attacker = put(state, plain.id, slot("p1", "units", 1)); // 3/3
    state.players.p2.hero.health = 3;
    expect(projectedDamage(state, attacker, { kind: "hero", player: "p2" })).toBe(3);
    expect(isLethal(state, attacker, { kind: "hero", player: "p2" })).toBe(true);

    state.players.p2.hero.health = 4;
    expect(isLethal(state, attacker, { kind: "hero", player: "p2" })).toBe(false);

    // Trample excess from an attack on a unit counts toward the projection.
    const tramp = put(state, trampler.id, slot("p1", "units", 2)); // 6/4 Trample
    const blocker = put(state, small.id, slot("p2", "units", 1)); // 1/2
    expect(projectedDamage(state, tramp, { kind: "unit", instance: blocker })).toBe(4);
    expect(isLethal(state, tramp, { kind: "unit", instance: blocker })).toBe(true);

    // The policy: uniform over `legalActions`, ending the turn on the AI_END_TURN_PROBABILITY roll.
    const live = playing("r44-policy");
    const chosen = chooseAction(live, "p1", createRng("r44"));
    expect(legalActions(live, "p1")).toContainEqual(chosen);
    expect(AI_END_TURN_PROBABILITY).toBe(0.1);

    // The cancellation itself is My Pawn's, and rides the `attackCancelled` event (§10.3).
    // M4: cards/test/96-my-pawn.test.ts proves the card half.
    expect(GAME_EVENT_TYPES).toContain("attackCancelled");
  });

  it("R45 keeps players as a map, so the seats and 'each opposing hero' are read from it, not hard-coded", () => {
    const state = game("r45");
    expect(Object.keys(state.players).sort()).toEqual([...PLAYER_IDS].sort());

    // The opening draw is a table indexed by seat (§2.1), not two constants.
    expect(PLAYER_IDS.map((player) => openingDrawFor(player))).toEqual([...OPENING_DRAW]);

    // "Each opposing hero" is derived from the acting player, so p2 acting reaches p1.
    const sink = sinkFor(state);
    applyEffects(
      [damageEffect({ to: { of: "enemyHero" }, amount: 3 })],
      makeContext(sink, null, { controller: "p2" }),
    );
    expect(state.players.p1.hero.health).toBe(HERO_HEALTH - 3);
    expect(state.players.p2.hero.health).toBe(HERO_HEALTH);

    // The hero check iterates the map, so every seat is read in one pass (§4.5 step 2).
    for (const player of PLAYER_IDS) state.players[player].hero.health = 0;
    stateCheck(sink);
    expect(state.result).toEqual({ winner: "draw", reason: "both-heroes-dead" });
  });

  it("R46 turns a would-destroy Indestructible unit to Attack Position without Taunt, and leaves a Field Spell alone", () => {
    const state = game("r46");
    const warded = put(state, wardedTaunter.id, slot("p1", "units", 1));
    warded.position = "DEF";
    warded.markedDestroyed = true;
    const field = put(state, logCardDef.id, slot("p1", "backrow", 1));
    field.markedDestroyed = true;
    // A Field Spell is Indestructible only if its face says so; #98's does (§8).
    registerCatalog({
      ...registeredCatalog(),
      [logCardDef.id]: {
        ...logCardDef,
        base: { keywords: [{ kind: "Indestructible" }], text: "warded field spell" },
        radiant: { keywords: [{ kind: "Indestructible" }], text: "warded field spell" },
      },
    });

    const sink = sinkFor(state);
    stateCheck(sink);

    expect(cardAt(state, slot("p1", "units", 1))?.id).toBe(warded.id);
    expect(warded.markedDestroyed).toBe(false);
    expect(warded.position).toBe("ATK");
    expect(warded.tauntSuppressedTurn).toBe(state.turn);
    expect(hasKeyword(unitView(state, warded).keywords, "Taunt")).toBe(false);

    // The Indestructible Field Spell simply stays and the mark is dropped.
    expect(cardAt(state, slot("p1", "backrow", 1))?.id).toBe(field.id);
    expect(field.markedDestroyed).toBe(false);
  });

  it("R47 fizzles a lane-targeted summon into an occupied or Locked zone, and holds a Reborn unit's zone", () => {
    const state = game("r47");
    const sink = sinkFor(state);
    const ctx = makeContext(sink, null, { controller: "p1" });

    put(state, plain.id, slot("p1", "units", 2));
    lockZone(state, slot("p1", "units", 3));

    applyEffects([summon({ defId: small.id, lane: 2 })], ctx); // occupied
    applyEffects([summon({ defId: small.id, lane: 3 })], ctx); // Locked
    expect(activeUnitsOf(state, "p1").map((u) => u.defId)).toEqual([plain.id]);

    applyEffects([summon({ defId: small.id, lane: 4 })], ctx);
    expect(cardAt(state, slot("p1", "units", 4))?.defId).toBe(small.id);

    // A zone reserved for a dying Reborn unit counts as occupied for everything else (R64).
    reserveZone(state, slot("p1", "units", 1));
    expect(isOpen(state, slot("p1", "units", 1))).toBe(false);
    applyEffects([summon({ defId: small.id, lane: 1 })], ctx);
    expect(cardAt(state, slot("p1", "units", 1))).toBeNull();
    releaseZone(state, slot("p1", "units", 1));

    // With the zone free, the Reborn unit comes back to it.
    const rb = put(state, rebornUnit.id, slot("p1", "units", 5));
    rb.damage = 99;
    stateCheck(sink);
    expect(cardAt(state, slot("p1", "units", 5))?.id).toBe(rb.id);
  });

  it("R48 applies Professor Curvature to a card whose cost is 4 once the other modifiers have landed", () => {
    const state = game("r48");
    const sink = sinkFor(state);
    addModifier(sink, "p1", { kind: "costDiscount", amount: 2, expiry: { until: "never" } });
    addModifier(sink, "p1", {
      kind: "costDiscount",
      amount: 1,
      onlyCurrentCost: 4,
      expiry: { until: "never" },
    });

    // 6 − 2 = 4, which is then Curvature's target: 3.
    const six = handCard(state, giga.id);
    expect(effectiveCost(state, six)).toBe(3);

    // 3 − 2 = 1 never reaches 4, so Curvature does nothing.
    const three = handCard(state, pricey.id);
    expect(effectiveCost(state, three)).toBe(1);

    // The embiggen price is read at play time too: 4 chosen, 2 not.
    const emb = handCard(state, embiggenCard.id);
    expect(effectiveCost(state, emb)).toBe(0); // 2 − 2
    emb.embiggened = true;
    expect(effectiveCost(state, emb)).toBe(2); // 4 − 2 = 2, which is not 4, so no Curvature
  });

  it("R49 gives Deft Duelist two exertions, one attack and one switch, where a plain unit has one", () => {
    const state = playing("r49");
    const duel = put(state, duelist.id, slot("p1", "units", 1));
    const victim = put(state, small.id, slot("p2", "units", 1));
    const sink = sinkFor(state);

    expect(declareAttack(sink, duel, { kind: "unit", instance: victim }).error).toBeUndefined();
    expect(duel.exertion.attacked).toBe(true);
    expect(hasExertion(duel, "switch")).toBe(true);
    expect(switchPosition(sink, duel).error).toBeUndefined();
    expect(duel.position).toBe("DEF");

    const ordinary = put(state, plain.id, slot("p1", "units", 2));
    expect(declareAttack(sink, ordinary, { kind: "hero", player: "p2" }).error).toBeUndefined();
    expect(hasExertion(ordinary, "switch")).toBe(false);
    expect(switchPosition(sink, ordinary).error).toBe("that unit has already acted this turn");
  });

  it("R50 discovers from the actual graveyard, so a spell token sitting there is eligible", () => {
    const state = game("r50");
    const token = newInstance(state, spellToken.id, "p1", { z: "graveyard", player: "p1" });
    state.players.p1.graveyard.push(token);

    const sink = sinkFor(state);
    applyEffects([discoverFromGraveyard({ step: "pick" })], makeContext(sink, null, { controller: "p1" }));

    expect(state.pending?.kind).toBe("discover");
    expect(state.pending?.options.map((option) => option.selection)).toContainEqual({
      pick: "instance",
      instanceId: token.id,
    });
    // M4: cards/test/72-reminisce.test.ts proves the card half.
  });

  it("R51 gives 'all enemies' one damage instance to every enemy unit and one to the enemy hero", () => {
    const state = game("r51");
    const first = put(state, bigBody.id, slot("p2", "units", 1));
    const second = put(state, bigBody.id, slot("p2", "units", 3));
    const sink = sinkFor(state);

    const spell = newInstance(state, allEnemies.id, "p1", { z: "resolving", player: "p1" });
    runHook(sink, spell, "cry");

    const hits = eventsOfType(sink.events, "damage");
    expect(hits.map((event) => event.targetId)).toEqual([first.id, second.id, "hero-p2"]);
    expect(hits.every((event) => event.amount === 2)).toBe(true);
    expect(state.players.p1.hero.health).toBe(HERO_HEALTH);
  });

  it("R52 gives the end-of-turn token to the trap's controller, whoever ended the turn with mana", () => {
    let state = playing("r52");
    put(state, breadTrap.id, slot("p2", "backrow", 1)); // the trap belongs to p2
    state.players.p1.mana.current = 2; // p1 is the one ending with unspent mana

    state = act(state, { type: "endTurn", playerId: "p1" });

    expect(activeUnitsOf(state, "p2").map((u) => u.defId)).toEqual([unitToken.id]);
    expect(activeUnitsOf(state, "p1")).toEqual([]);
    // M4: cards/test/18-bread-and-butter.test.ts proves the card half.
  });

  it("R53 forces an attack past the validator, spends no exertion, and stops once the target is gone", () => {
    const state = playing("r53");
    const attacker = put(state, bigBody.id, slot("p1", "units", 1)); // 5/5
    attacker.position = "DEF";
    attacker.summonedTurn = state.turn; // and summoning sick
    const target = put(state, plain.id, slot("p2", "units", 1)); // 3/3

    expect(whyCannotAttack(state, attacker, { kind: "unit", instance: target })).not.toBeNull();

    const sink = sinkFor(state);
    forceAttack(sink, attacker, { kind: "unit", instance: target });

    expect(eventsOfType(sink.events, "destroyed").map((e) => e.instanceId)).toEqual([target.id]);
    // The target still struck back, through the Armor 1 that Defense Position grants (§4.1).
    expect(attacker.damage).toBe(2);
    expect(attacker.exertion).toEqual({ attacked: false, switched: false });

    // Each forced attack is its own combat and its own state check, so the next one is skipped.
    const second = put(state, plain.id, slot("p1", "units", 2));
    const third = put(state, plain.id, slot("p1", "units", 3));
    const victim = put(state, small.id, slot("p2", "units", 2)); // 1/2
    forceAttacksOn(sink, [second, third], { kind: "unit", instance: victim });

    expect(victim.zone.z).not.toBe("field");
    expect(second.damage).toBe(1);
    expect(third.damage).toBe(0);
  });

  it("R54 never offers a token index or the generating card's own index in a random pool", () => {
    const state = game("r54");
    // §5.1: tokens are out unless the query asks for the Token tag.
    expect(query({ set: "Core" }).some((def) => def.token || def.tags.includes("Token"))).toBe(false);
    expect(query({ tags: ["Token"] }).length).toBeGreaterThan(0);

    // And a pool never offers the card that generated it: KY's Trial rerolls its own index.
    const self = put(state, plain.id, slot("p1", "units", 1));
    const sink = sinkFor(state);
    applyEffects(
      [discoverFromCatalog({ step: "pick", query: { type: "Unit" } })],
      makeContext(sink, self, { controller: "p1" }),
    );

    const options = state.pending?.options ?? [];
    expect(options).toHaveLength(3);
    expect(
      options.some((o) => o.selection.pick === "mode" && o.selection.option === plain.id),
    ).toBe(false);
    // M4: cards/test/82-kys-trial.test.ts proves the 1–100 index roll.
  });

  it("R55 counts both players' draws, plays, destructions and exiles from the start of the game", () => {
    const state = game("r55");
    expect(state.counters).toEqual({ drawn: 0, played: 0, destroyed: 0, exiled: 0 });

    const sink = sinkFor(state);
    setLibrary(state, "p2", [plain.id, small.id]);
    drawCards(sink, "p2", 1);
    expect(state.counters.drawn).toBe(1);

    const spell = newInstance(state, noop.id, "p1", { z: "hand", player: "p1" });
    state.players.p1.hand.push(spell);
    castCard(sink, spell);
    expect(state.counters.played).toBe(1);

    const doomed = put(state, plain.id, slot("p2", "units", 1));
    applyEffects(
      [destroy({ target: { of: "chosen" } })],
      makeContext(sink, null, { controller: "p1", targets: [{ pick: "instance", instanceId: doomed.id }] }),
    );
    stateCheck(sink);
    expect(state.counters.destroyed).toBe(1);

    const banished = put(state, small.id, slot("p2", "units", 2));
    applyEffects(
      [exile({ target: { of: "chosen" } })],
      makeContext(sink, null, { controller: "p1", targets: [{ pick: "instance", instanceId: banished.id }] }),
    );
    expect(state.counters.exiled).toBe(1);
    // M4: cards/test/100-ceaseless-void.test.ts proves the card half.
  });

  it("R56 reports the cost actually paid after modifiers, which is what a cost threshold reads", () => {
    const state = playing("r56");
    state.players.p1.hand = [];
    const card = handCard(state, pricey.id); // printed 3
    card.costMod = -2;
    expect(effectiveCost(state, card)).toBe(1);

    const result = actResult(state, { type: "play", instanceId: card.id, playerId: "p1" });
    expect(result.error).toBeUndefined();
    expect(only(eventsOfType(result.events, "cardPlayed")).costPaid).toBe(1);
    expect(result.state.players.p1.mana.current).toBe(0);
  });

  it("R57 makes a shuffled-in copy a fresh instance carrying the radiant flag, and a field copy keep statsOverride", () => {
    const state = game("r57");
    state.players.p1.library = [];

    const self = put(state, plain.id, slot("p1", "units", 1), { radiant: true });
    self.buffs = { attack: 1, health: 1 };
    self.damage = 2;
    self.counters.plague = 3;
    self.grantedKeywords = [{ kind: "Taunt" }];
    self.exertion = { attacked: true, switched: false };

    const sink = sinkFor(state);
    const ctx = makeContext(sink, self, { controller: "p1" });
    applyEffects([shuffleCopiesOfSelf({ count: 1 })], ctx);

    const copy = only(state.players.p1.library);
    expect(copy.defId).toBe(plain.id);
    expect(copy.radiant).toBe(true);
    expect(copy.buffs).toEqual({ attack: 0, health: 0 });
    expect(copy.damage).toBe(0);
    expect(copy.counters).toEqual({});
    expect(copy.grantedKeywords).toEqual([]);
    expect(copy.exertion).toEqual({ attacked: false, switched: false });

    // A copy that arrives on the field keeps the radiant flag and the §7 stats override, reset.
    applyEffects([summon({ defId: plain.id, radiant: true, statsOverride: { attack: 5, health: 5 } })], ctx);
    const onField = cardAt(state, slot("p1", "units", 2));
    expect(onField?.radiant).toBe(true);
    expect(onField?.statsOverride).toEqual({ attack: 5, health: 5 });
    expect(onField?.damage).toBe(0);
    expect(onField?.exertion).toEqual({ attacked: false, switched: false });
    // M4: cards/test/12-prejudiced-postdoc.test.ts and cards/test/33-unstable-clone-machine.test.ts
    // prove the card halves.
  });

  it("R58 casts at most CAST_ON_DRAW_CHAIN_CAP cards in one draw, casts on a full hand, and draws N times for 'draw N'", () => {
    const state = game("r58");
    const sink = sinkFor(state);
    state.players.p1.hand = [];
    setLibrary(state, "p1", Array.from({ length: CAST_ON_DRAW_CHAIN_CAP + 5 }, () => caster.id));

    drawOne(sink, "p1", 0);
    expect(eventsOfType(sink.events, "cardPlayed")).toHaveLength(CAST_ON_DRAW_CHAIN_CAP);
    expect(state.players.p1.hand).toHaveLength(1); // the next one ends the chain, uncast
    expect(state.players.p1.library).toHaveLength(4);

    // A cast-on-draw card is cast even with a full hand, since it never enters the hand.
    const full = game("r58-full");
    const fullSink = sinkFor(full);
    full.players.p1.hand = [];
    inHand(full, noop.id, "p1", HAND_CAP);
    setLibrary(full, "p1", [caster.id]);
    drawOne(fullSink, "p1", 0);
    expect(eventsOfType(fullSink.events, "cardPlayed")).toHaveLength(1);
    expect(full.players.p1.hand).toHaveLength(HAND_CAP);

    // "Draw N" is N separate draws.
    const many = game("r58-n");
    const manySink = sinkFor(many);
    many.players.p1.hand = [];
    setLibrary(many, "p1", [plain.id, small.id, noop.id]);
    drawCards(manySink, "p1", 3);
    expect(eventsOfType(manySink.events, "drawn")).toHaveLength(3);
  });

  it("R59 runs the state check after a whole effect, never between its hits, and calls two dead heroes a draw", () => {
    const state = game("r59");
    const sink = sinkFor(state);
    const first = put(state, small.id, slot("p2", "units", 1));
    const second = put(state, small.id, slot("p2", "units", 2));

    const spell = newInstance(state, splitter.id, "p1", { z: "resolving", player: "p1" });
    runHook(sink, spell, "cry");

    expect(unitView(state, first).health).toBeLessThanOrEqual(0);
    expect(unitView(state, second).health).toBeLessThanOrEqual(0);
    expect(eventsOfType(sink.events, "destroyed")).toHaveLength(0);

    stateCheck(sink);
    expect(eventsOfType(sink.events, "destroyed")).toHaveLength(2);

    for (const player of PLAYER_IDS) state.players[player].hero.health = 0;
    stateCheck(sink);
    expect(state.result).toEqual({ winner: "draw", reason: "both-heroes-dead" });
  });

  it("R60 picks different cards among the non-Radiant ones, all of them when fewer exist, and none when none are left", () => {
    const state = game("r60");
    state.players.p1.hand = [];
    const cards = inHand(state, noop.id, "p1", 3);
    for (const card of cards) card.radiant = true;

    const sink = sinkFor(state);
    const ctx = makeContext(sink, null, { controller: "p1" });
    applyEffects([setRadiantRandom({ zones: "hand", count: 2 })], ctx);
    expect(eventsOfType(sink.events, "radiantSet")).toHaveLength(0);

    const [first, second] = cards;
    if (first === undefined || second === undefined) throw new Error("fixture");
    first.radiant = false;
    second.radiant = false;

    applyEffects([setRadiantRandom({ zones: "hand", count: 5 })], ctx);
    const set = eventsOfType(sink.events, "radiantSet");
    expect(set).toHaveLength(2);
    expect(new Set(set.map((event) => event.instanceId)).size).toBe(2);

    // Discover options are always different.
    applyEffects([discoverFromCatalog({ step: "pick", query: { type: "Unit" } })], ctx);
    const keys = state.pending?.options.map((option) => option.key) ?? [];
    expect(keys).toHaveLength(3);
    expect(new Set(keys).size).toBe(3);
  });

  it("R61 emits cardPlayed only for a play or a cast, refuses an Immutable Fuse target, and consumes a trap that does nothing", () => {
    const state = playing("r61");
    const sink = sinkFor(state);
    const ctx = makeContext(sink, null, { controller: "p1" });

    // Summon, Recruit and Transform never set a "plays a permanent" trap off.
    applyEffects([summon({ defId: plain.id })], ctx);
    setLibrary(state, "p1", [small.id]);
    applyEffects([recruit({})], ctx);
    const summoned = cardAt(state, slot("p1", "units", 1));
    expect(summoned).not.toBeNull();
    applyEffects([transform({ instanceId: summoned?.id ?? "", defId: bigBody.id })], ctx);
    expect(eventsOfType(sink.events, "summoned").length).toBeGreaterThan(0);
    expect(eventsOfType(sink.events, "cardPlayed")).toHaveLength(0);

    // A Field Trap counts as a Trap.
    const trap = put(state, emptyTrap.id, slot("p1", "backrow", 1));
    const fieldTrap = put(state, windowTrap.id, slot("p1", "backrow", 2));
    expect(isTrapType(state, trap)).toBe(true);
    expect(isTrapType(state, fieldTrap)).toBe(true);

    // An Immutable permanent is never chosen as the Fuse target (R23).
    const warded = put(state, immutable.id, slot("p2", "units", 1));
    const food = put(state, plain.id, slot("p2", "units", 2));
    expect(fuse(sink, { ingredients: [warded, food], target: warded })).toBeNull();

    // With no legal target the trap fires, is consumed and does nothing; the permanent stays.
    let live = playing("r61-trap");
    put(live, emptyTrap.id, slot("p2", "backrow", 1));
    live.players.p1.hand = [];
    const unit = handCard(live, plain.id);
    const result = actResult(live, {
      type: "play",
      instanceId: unit.id,
      playerId: "p1",
      zone: { row: "units", lane: 1 },
    });
    expect(result.error).toBeUndefined();
    live = result.state;
    expect(eventsOfType(result.events, "trapFired")).toHaveLength(1);
    expect(live.players.p2.graveyard.some((c) => c.defId === emptyTrap.id)).toBe(true);
    expect(cardAt(live, slot("p1", "units", 1))?.defId).toBe(plain.id);
    // M4: cards/test/85-unlicensed-experimentation.test.ts proves the card half.
  });

  it("R62 ends a turn as triggers, then the trap window on both sides, then delayed effects, then cleanup", () => {
    let state = playing("r62");
    put(state, logCardDef.id, slot("p1", "backrow", 5));
    const clockCard = put(state, clock.id, slot("p1", "units", 1));
    put(state, windowTrap.id, slot("p1", "backrow", 1));
    put(state, windowTrap.id, slot("p2", "backrow", 1));

    const sink = sinkFor(state);
    scheduleDelayed(sink, "p1", { phase: "end", player: "p1" }, {
      defId: clock.id,
      hook: "delayed",
      step: "",
      radiant: false,
      instanceId: clockCard.id,
      data: {},
    });
    addModifier(sink, "p1", {
      kind: "costDiscount",
      amount: 1,
      expiry: { until: "thisTurn", turn: state.turn },
    });

    state = act(state, { type: "endTurn", playerId: "p1" });
    expect(rbSteps(state)).toEqual(["end", "trap:p1", "trap:p2", "delayed"]);
    expect(state.players.p1.mods).toHaveLength(0); // cleanup came after all of it

    // And the start half: refresh, start-of-turn triggers, then the draw.
    const libraryBefore = state.players.p1.library.length;
    state = act(state, { type: "endTurn", playerId: "p2" });
    expect(rbSteps(state)).toEqual([
      "end",
      "trap:p1",
      "trap:p2",
      "delayed",
      "trap:p2",
      "trap:p1",
      `start:lib${libraryBefore}`,
    ]);
    expect(state.players.p1.library).toHaveLength(libraryBefore - 1);
  });

  it("R63 tramples only the excess, cleaves past a stopped hit, ignores zero hits and lifesteals the total once", () => {
    const state = game("r63");
    const sink = sinkFor(state);

    // Trample: up to the unit's health lands on it, the rest on its controller's hero.
    const tramp = put(state, trampler.id, slot("p1", "units", 1)); // 6/4 Trample
    const blocker = put(state, small.id, slot("p2", "units", 1)); // 1/2
    dealDamage(sink, { source: tramp, target: { kind: "unit", instance: blocker }, amount: 6 });
    expect(blocker.damage).toBe(2);
    expect(state.players.p2.hero.health).toBe(HERO_HEALTH - 4);

    // A hit of 0 before step 1 is not a damage instance, so Divine Shield stays.
    const shield = put(state, shielded.id, slot("p2", "units", 2));
    expect(dealDamage(sink, { source: null, target: { kind: "unit", instance: shield }, amount: 0 })).toBe(0);
    expect(shield.divineShieldSpent).toBeUndefined();

    // A hit reduced to 0 by Armor emits no event and triggers nothing.
    const armour = put(state, armoured.id, slot("p2", "units", 3)); // Armor 5
    const before = sink.events.length;
    expect(dealDamage(sink, { source: null, target: { kind: "unit", instance: armour }, amount: 2 })).toBe(0);
    expect(sink.events).toHaveLength(before);

    // Cleave belongs to the attack, so it lands even when the hit on the defender was stopped.
    const cleaveGame = game("r63-cleave");
    const cleaveSink = sinkFor(cleaveGame);
    const cleaverUnit = put(cleaveGame, cleaver.id, slot("p1", "units", 1)); // 3/6 Cleave
    const defender = put(cleaveGame, shielded.id, slot("p2", "units", 2));
    const left = put(cleaveGame, plain.id, slot("p2", "units", 1));
    const right = put(cleaveGame, plain.id, slot("p2", "units", 3));
    forceAttack(cleaveSink, cleaverUnit, { kind: "unit", instance: defender });
    expect(defender.divineShieldSpent).toBe(true);
    expect(
      eventsOfType(cleaveSink.events, "damage")
        .filter((event) => event.targetId === left.id || event.targetId === right.id)
        .map((event) => event.amount),
    ).toEqual([3, 3]);

    // A zero-attack unit striking back is not a damage instance either.
    const zeroGame = game("r63-zero");
    const zeroSink = sinkFor(zeroGame);
    const striker = put(zeroGame, shielded.id, slot("p1", "units", 1));
    const dummy = put(zeroGame, zeroAttack.id, slot("p2", "units", 1));
    forceAttack(zeroSink, striker, { kind: "unit", instance: dummy });
    expect(striker.divineShieldSpent).toBeUndefined();
    expect(dummy.damage).toBe(2);

    // Lifesteal heals the total of a Trample hit once, not the unit's share twice.
    const leechGame = game("r63-lifesteal");
    const leechSink = sinkFor(leechGame);
    const leech = put(leechGame, trampleLeech.id, slot("p1", "units", 1));
    const chump = put(leechGame, small.id, slot("p2", "units", 1));
    dealDamage(leechSink, { source: leech, target: { kind: "unit", instance: chump }, amount: 6 });
    expect(leechGame.players.p1.hero.health).toBe(HERO_HEALTH + 6);

    // Poisonous only affects units.
    const poisonGame = game("r63-poison");
    const poisonSink = sinkFor(poisonGame);
    const poison = put(poisonGame, poisoner.id, slot("p1", "units", 1));
    const victim = put(poisonGame, bigBody.id, slot("p2", "units", 1));
    dealDamage(poisonSink, { source: poison, target: { kind: "unit", instance: victim }, amount: 1 });
    expect(victim.markedDestroyed).toBe(true);
    dealDamage(poisonSink, { source: poison, target: { kind: "hero", player: "p2" }, amount: 1 });
    expect(poisonGame.players.p2.hero.health).toBe(HERO_HEALTH - 1);
    expect(poisonGame.result).toBeNull();
  });

  it("R64 summons into the leftmost open zone, fills the board left to right, and reserves a Reborn unit's zone", () => {
    const state = game("r64");
    const sink = sinkFor(state);
    const ctx = makeContext(sink, null, { controller: "p1" });

    put(state, plain.id, slot("p1", "units", 1));
    lockZone(state, slot("p1", "units", 2));
    applyEffects([summon({ defId: small.id })], ctx);
    expect(cardAt(state, slot("p1", "units", 3))?.defId).toBe(small.id);

    applyEffects([fillBoard({ defId: unitToken.id })], ctx);
    expect(slotsOf("p1", "units").map((ref) => cardAt(state, ref)?.defId ?? null)).toEqual([
      plain.id,
      null,
      small.id,
      unitToken.id,
      unitToken.id,
    ]);

    const rb = put(state, rebornUnit.id, slot("p2", "units", 3));
    rb.damage = 99;
    stateCheck(sink);
    expect(cardAt(state, slot("p2", "units", 3))?.id).toBe(rb.id);
    expect(unitView(state, rb).health).toBe(1);
    expect(isReserved(state, slot("p2", "units", 3))).toBe(false);
  });

  it("R65 reads costOverride, then costMod, then the player's discounts, then Curvature, floored at 0", () => {
    const state = game("r65");
    const sink = sinkFor(state);
    const card = handCard(state, giga.id); // printed 6

    expect(effectiveCost(state, card)).toBe(6);
    card.costMod = -1;
    expect(effectiveCost(state, card)).toBe(5);
    card.costOverride = 5;
    expect(effectiveCost(state, card)).toBe(4);

    addModifier(sink, "p1", { kind: "costDiscount", amount: 1, onlyCurrentCost: 4, expiry: { until: "never" } });
    expect(effectiveCost(state, card)).toBe(3);
    addModifier(sink, "p1", { kind: "costDiscount", amount: 9, expiry: { until: "never" } });
    expect(effectiveCost(state, card)).toBe(0);

    // An X-cost card costs exactly X, ignores modifiers, and an override makes it free.
    const x = handCard(state, xCard.id);
    x.x = 3;
    x.costMod = -2;
    expect(effectiveCost(state, x)).toBe(3);
    x.costOverride = 4;
    expect(effectiveCost(state, x)).toBe(0);

    // Outside play an X card reads 0 and an embiggen card its base price.
    expect(queryCost(defOf(state, xCard.id))).toBe(0);
    expect(queryCost(defOf(state, embiggenCard.id))).toBe(2);
    const emb = handCard(state, embiggenCard.id);
    expect(printedCost(state, emb)).toBe(2);
    emb.embiggened = true;
    expect(printedCost(state, emb)).toBe(4);
  });

  it("R66 reads Genn's Greed costs per R65 at resolution and exempts X-cost cards from both halves", () => {
    expect(GENN_GREED_EXILES).toBe("odd");

    const state = game("r66");
    const card = handCard(state, pricey.id); // printed 3
    card.costMod = -1;
    expect(effectiveCost(state, card)).toBe(2); // the 2-cost draw reads the modified cost

    const x = handCard(state, xCard.id);
    expect(isXCost(state, x)).toBe(true);
    expect(effectiveCost(state, x)).toBe(0);
    expect(queryCost(defOf(state, xCard.id))).toBe(0); // neither odd nor 2: exempt from both
    // M4: cards/test/94-genns-greed.test.ts proves the card half.
  });

  it("R67 takes KY's Math Equation's Fib index from printed cost plus costMod plus 1, ignoring discounts", () => {
    const state = game("r67");
    const sink = sinkFor(state);
    const card = handCard(state, pricey.id); // printed 3
    card.costMod = 1;
    addModifier(sink, "p1", { kind: "costDiscount", amount: 2, expiry: { until: "never" } });

    expect(effectiveCost(state, card)).toBe(2); // what the player would pay
    expect(printedCost(state, card)).toBe(3); // and what R67 reads instead

    const index = printedCost(state, card) + card.costMod + 1;
    expect(index).toBe(5);
    expect(fib(index)).toBe(5);
    expect(fib(index + 1)).toBe(8); // radiant adds 2 instead of 1
    // M4: cards/test/31-kys-math-equation.test.ts proves the card half.
  });

  it("R68 orders triggers active side first, units by lane, then backrow, hand and graveyard, delayed by creation", () => {
    const state = game("r68");
    state.active = "p2";

    const theirs = put(state, plain.id, slot("p2", "units", 1));
    const lane2 = put(state, plain.id, slot("p1", "units", 2));
    const lane1 = put(state, small.id, slot("p1", "units", 1));
    const backrow = put(state, logCardDef.id, slot("p1", "backrow", 3));
    const inHandCard = handCard(state, noop.id);
    const buried = newInstance(state, noop.id, "p1", { z: "graveyard", player: "p1" });
    state.players.p1.graveyard.push(buried);

    expect(cardsInTriggerOrder(state).map((holder) => holder.card.id)).toEqual([
      theirs.id,
      lane1.id,
      lane2.id,
      backrow.id,
      inHandCard.id,
      buried.id,
    ]);

    const sink = sinkFor(state);
    const stub = { defId: clock.id, hook: "delayed", step: "", radiant: false, data: {} };
    const first = scheduleDelayed(sink, "p1", { phase: "start", player: "p1" }, { ...stub });
    const second = scheduleDelayed(sink, "p1", { phase: "start", player: "p1" }, { ...stub });
    state.delayed.reverse(); // the order in the array is not the order they resolve in
    expect(dueDelayed(state, "start", "p1").map((effect) => effect.id)).toEqual([first.id, second.id]);
  });

  it("R69 collects an Indestructible unit whose max health falls to 0, and leaves one merely at 0 health", () => {
    const state = game("r69");
    const sink = sinkFor(state);
    const warded = put(state, wardedPinger.id, slot("p1", "units", 1)); // 4/4 Indestructible

    warded.damage = 10; // 0 or less health, but max health is still 4
    stateCheck(sink);
    expect(cardAt(state, slot("p1", "units", 1))?.id).toBe(warded.id);
    expect(state.players.p2.hero.health).toBe(HERO_HEALTH);

    const destroyedBefore = state.counters.destroyed;
    warded.buffs.health = -4; // max health falls to 0: no destroy effect is involved, so it dies
    stateCheck(sink);
    expect(cardAt(state, slot("p1", "units", 1))).toBeNull();
    expect(state.counters.destroyed).toBe(destroyedBefore + 1);
    expect(state.players.p2.hero.health).toBe(HERO_HEALTH - 1); // its Death fired
  });

  it("R70 makes a cast free, counts it as a play, fires the card's Cry and sends a Spell to the graveyard", () => {
    const state = playing("r70");
    const sink = sinkFor(state);
    addModifier(sink, "p1", { kind: "costDiscount", amount: 2, expiry: { until: "never" } });

    const spell = newInstance(state, pricey.id, "p1", { z: "hand", player: "p1" }); // printed 3
    state.players.p1.hand.push(spell);
    const manaBefore = state.players.p1.mana.current;

    castCard(sink, spell);

    const played = only(eventsOfType(sink.events, "cardPlayed"));
    expect(played.costPaid).toBe(0); // free, and no discount was consumed to get there
    expect(state.players.p1.mana.current).toBe(manaBefore);
    expect(state.players.p1.turnLog.playedIds).toContain(spell.id);
    expect(state.counters.played).toBe(1);
    expect(state.players.p2.hero.health).toBe(HERO_HEALTH - 1); // the Cry resolved
    expect(state.players.p1.graveyard.some((card) => card.id === spell.id)).toBe(true);
    // M4: cards/test/79-twinspell.test.ts proves that a cast Spell still uses Echo.
  });

  it("R71 copies every other card played this turn at end of turn, including the ones played after it", () => {
    let state = playing("r71");
    state.players.p1.hand = [];
    put(state, plain.id, slot("p1", "units", 1)); // keeps the turn from auto-ending (R82)

    const recyclerCard = handCard(state, recycler.id);
    const later = handCard(state, noop.id);

    state = act(state, {
      type: "play",
      instanceId: recyclerCard.id,
      playerId: "p1",
      zone: { row: "backrow", lane: 1 },
    });
    state = act(state, { type: "play", instanceId: later.id, playerId: "p1" });
    state = act(state, { type: "endTurn", playerId: "p1" });

    // The card played after it is copied; the recycler never copies itself.
    expect(state.players.p1.hand.map((card) => card.defId)).toEqual([noop.id]);
    // M4: cards/test/39-recycling-initiative.test.ts proves the card half.
  });

  it("R72 keeps exile piles with their owners and lets a hero climb above the 30 that missing health counts from", () => {
    const state = game("r72");
    const sink = sinkFor(state);
    expect(HERO_HEALTH).toBe(30);

    const mine = put(state, plain.id, slot("p1", "units", 1));
    const theirs = put(state, plain.id, slot("p2", "units", 1));

    applyEffects(
      [exile({ target: { of: "chosen" } })],
      makeContext(sink, null, { controller: "p1", targets: [{ pick: "instance", instanceId: theirs.id }] }),
    );
    applyEffects(
      [exile({ target: { of: "chosen" } })],
      makeContext(sink, null, { controller: "p1", targets: [{ pick: "instance", instanceId: mine.id }] }),
    );

    // "Cards in exile" is your own pile: each card went to its owner's (R12).
    expect(state.players.p1.exile.map((card) => card.id)).toEqual([mine.id]);
    expect(state.players.p2.exile.map((card) => card.id)).toEqual([theirs.id]);

    // A hero has no maximum, so missing health has to count from HERO_HEALTH, not from current.
    healHero(sink, "p1", 10);
    expect(state.players.p1.hero.health).toBe(HERO_HEALTH + 10);
    expect(Math.max(0, HERO_HEALTH - state.players.p1.hero.health)).toBe(0);
    // M4: cards/test/40-echoes-of-the-forgotten.test.ts and cards/test/70-spiteful-stab.test.ts
    // prove the card halves.
  });

  it("R73 gives Pocket Chaos its three swaps: armor apart from health, locks with the zone, a trap read by its controller, and owner-routed libraries", () => {
    const state = game("r73");

    // The three swaps each have their own event (§10.3).
    expect(GAME_EVENT_TYPES).toContain("swapped");
    const swaps = [
      { type: "swapped", what: "health" } as const,
      { type: "swapped", what: "board" } as const,
      { type: "swapped", what: "library" } as const,
    ];
    expect(eventsOfType(swaps, "swapped").map((event) => event.what)).toEqual(["health", "board", "library"]);

    // Health and armor are separate fields, so swapping the health values leaves armor alone.
    expect(Object.keys(state.players.p1.hero)).toEqual(["health", "armor"]);

    // Locks stay with their zones, not with the card that occupied them (§3.2).
    const occupant = put(state, plain.id, slot("p1", "units", 1));
    lockZone(state, slot("p1", "units", 1));
    moveToZone(state, occupant, "graveyard");
    expect(cardAt(state, slot("p1", "units", 1))).toBeNull();
    expect(isOpen(state, slot("p1", "units", 1))).toBe(false);

    // A face-down trap is readable by its controller only, so control is what a swap moves (R33).
    const trap = put(state, emptyTrap.id, slot("p1", "backrow", 1));
    expect(viewFor(state, "p2").opponent.backrow[0]).toEqual({ faceDown: true });
    trap.controller = "p2";
    expect(viewFor(state, "p2").opponent.backrow[0]).toMatchObject({ faceDown: false, defId: emptyTrap.id });
    expect(viewFor(state, "p1").you.backrow[0]).toEqual({ faceDown: true });

    // The library swap is R12's one exception: a card follows its owner off the field.
    const card = only(state.players.p1.library);
    state.players.p1.library = [];
    card.owner = "p2";
    moveToZone(state, card, "graveyard");
    expect(state.players.p2.graveyard.map((c) => c.id)).toEqual([card.id]);
    expect(state.players.p1.graveyard.some((c) => c.id === card.id)).toBe(false);

    // Fatigue counters belong to the player, so swapped libraries leave them behind.
    state.players.p1.fatigueCount = 4;
    const p1Library = state.players.p1.library;
    state.players.p1.library = state.players.p2.library;
    state.players.p2.library = p1Library;
    expect(state.players.p1.fatigueCount).toBe(4);
    expect(state.players.p2.fatigueCount).toBe(0);
    // M4: cards/test/87-pocket-chaos.test.ts proves the card half.
  });

  it("R74 models Radiant as a flag that never unsets, swaps the layer in place, and rides copies and formless cards", () => {
    const state = game("r74");
    const sink = sinkFor(state);
    const ctx = makeContext(sink, null, { controller: "p1" });

    // In hand: the flag is the whole model, and setting it twice changes nothing.
    const held = handCard(state, plain.id);
    applyEffects([setRadiant({ instanceId: held.id })], ctx);
    expect(held.radiant).toBe(true);
    expect(eventsOfType(sink.events, "radiantSet")).toHaveLength(1);
    applyEffects([setRadiant({ instanceId: held.id })], ctx);
    expect(eventsOfType(sink.events, "radiantSet")).toHaveLength(1);

    // On the field: the base-stat layer swaps at once, damage and buffs stay, no Cry re-fires.
    const unit = put(state, fuseA.id, slot("p1", "units", 1)); // 2/3, and its Cry pings the hero
    unit.damage = 1;
    unit.buffs = { attack: 1, health: 0 };
    expect(unitView(state, unit).attack).toBe(3);
    applyEffects([setRadiant({ instanceId: unit.id })], ctx);
    expect(unitView(state, unit).attack).toBe(5); // 4 printed radiant + 1 buff
    expect(unit.damage).toBe(1);
    expect(state.players.p2.hero.health).toBe(HERO_HEALTH);

    // A card an effect generates "Radiant" is Radiant.
    applyEffects([addToHandEffect({ defId: plain.id, radiant: true })], ctx);
    const generated = state.players.p1.hand.find((card) => card.id !== held.id);
    expect(generated?.radiant).toBe(true);

    // A card with no radiant form is unchanged, but the flag still sets.
    const formless = put(state, sameFace.id, slot("p1", "units", 2));
    applyEffects([setRadiant({ instanceId: formless.id })], ctx);
    expect(formless.radiant).toBe(true);
    expect(unitView(state, formless).attack).toBe(2);
  });

  it("R75 keeps the §5.3 corrections in the catalog shape: a set and type on every def, the Felinor tag, N.1 indexes and cost 6", () => {
    const state = game("r75");
    const catalog = registeredCatalog();
    const types: CardType[] = ["Unit", "Spell", "Field Spell", "Trap", "Field Trap"];

    // Every def carries the set and the type the source left out.
    expect(Object.values(catalog).every((def) => typeof def.set === "string" && def.set.length > 0)).toBe(true);
    expect(Object.values(catalog).every((def) => types.includes(def.type))).toBe(true);
    expect(defOf(state, sameFace.id).type).toBe("Unit");

    // The tribe tag is Felinor, not "Felinors".
    const felinor: Tag = "Felinor";
    expect(defOf(state, fuseB.id).tags).toContain(felinor);

    // A token index of the "N.1" form addresses a card (#90.1 CN-Virus).
    expect(defByIndex("51.1")?.id).toBe(dotted.id);

    // #29 keeps cost 6 even though MAX_MANA is 4: castable only after a mana gain.
    expect(MAX_MANA).toBe(4);
    const live = playing("r75-giga");
    live.players.p1.hand = [];
    const six = handCard(live, giga.id);
    expect(effectiveCost(live, six)).toBe(6);
    expect(legalActions(live, "p1").some((a) => a.type === "play" && a.instanceId === six.id)).toBe(false);
    live.players.p1.mana.current = 6;
    expect(legalActions(live, "p1").some((a) => a.type === "play" && a.instanceId === six.id)).toBe(true);
  });

  it("R76 fires the delayed steal at your next start of turn even though the unit died, and fizzles on a card already yours", () => {
    let state = playing("r76");
    const fanatic = put(state, kpop.id, slot("p1", "units", 1));
    const prize = put(state, plain.id, slot("p2", "units", 1));

    const sink = sinkFor(state);
    scheduleDelayed(sink, "p1", { phase: "start", player: "p1" }, {
      defId: kpop.id,
      hook: "delayed",
      step: "",
      radiant: false,
      instanceId: fanatic.id,
      data: { target: prize.id },
    });

    fanatic.damage = 99;
    stateCheck(sink);
    expect(cardAt(state, slot("p1", "units", 1))).toBeNull();

    state = act(state, { type: "endTurn", playerId: "p1" });
    state = act(state, { type: "endTurn", playerId: "p2" });
    expect(cardAt(state, slot("p1", "units", 1))?.defId).toBe(plain.id);

    // It fizzles when the target is already under your control.
    let own = playing("r76-own");
    const holder = put(own, kpop.id, slot("p1", "units", 1));
    const mine = put(own, plain.id, slot("p1", "units", 2));
    scheduleDelayed(sinkFor(own), "p1", { phase: "start", player: "p1" }, {
      defId: kpop.id,
      hook: "delayed",
      step: "",
      radiant: false,
      instanceId: holder.id,
      data: { target: mine.id },
    });
    own = act(own, { type: "endTurn", playerId: "p1" });
    const back = actResult(own, { type: "endTurn", playerId: "p2" });
    expect(back.error).toBeUndefined();
    expect(eventsOfType(back.events, "controlChanged")).toHaveLength(0);
    // M4: cards/test/50-kpop-fanatic.test.ts proves the card half.
  });

  it("R77 fuses the base forms, keeps the target's instance, sums buffs, and crafts a free non-Radiant hand card", () => {
    const state = game("r77");
    const sink = sinkFor(state);
    const target = put(state, fuseA.id, slot("p1", "units", 1)); // 2/3 Taunt, cost 2, Human
    const food = put(state, fuseB.id, slot("p1", "units", 2)); // 1/1 Rush, cost 3, Felinor
    target.damage = 1;
    target.buffs = { attack: 1, health: 0 };
    target.grantedKeywords = [{ kind: "Lifesteal" }];
    food.buffs = { attack: 0, health: 2 };

    const result = fuse(sink, { ingredients: [target, food], target });
    expect(result?.id).toBe(target.id);

    const def = defOf(state, target.defId);
    expect(def.base.attack).toBe(3);
    expect(def.base.health).toBe(4);
    expect(def.radiant.attack).toBe(6);
    expect(def.cost).toBe(FUSE_COST_CAP); // min(2 + 3, 4)
    expect(def.type).toBe("Unit");
    expect([...def.tags].sort()).toEqual(["Felinor", "Human"]);
    expect(def.base.keywords.map((k) => k.kind).sort()).toEqual(["Rush", "Taunt"]);

    // The kept instance keeps everything; the other ingredient ceases to exist.
    expect(target.damage).toBe(1);
    expect(target.buffs).toEqual({ attack: 1, health: 2 });
    expect(target.grantedKeywords.map((k) => k.kind)).toEqual(["Lifesteal"]);
    expect(cardAt(state, slot("p1", "units", 2))).toBeNull();
    expect(state.players.p1.graveyard).toEqual([]);
    expect(state.counters.destroyed).toBe(0);

    // The scripts are concatenated, so both Cry lists run.
    runHook(sink, target, "cry");
    expect(state.players.p2.hero.health).toBe(HERO_HEALTH - 3);

    // Craft a Card: no target on the field, a fresh non-Radiant hand card at cost 0.
    const a = handCard(state, fuseA.id);
    const b = handCard(state, fuseB.id);
    const crafted = fuse(sink, { ingredients: [a, b], toHand: "p1" });
    expect(crafted).not.toBeNull();
    expect(crafted?.radiant).toBe(false);
    expect(crafted?.costOverride).toBe(0);
    expect(crafted === null ? -1 : effectiveCost(state, crafted)).toBe(0);
  });

  it("R78 resets an instance as it leaves the field while costMod, costOverride and radiant persist", () => {
    const state = game("r78");
    const sink = sinkFor(state);
    const unit = put(state, plain.id, slot("p1", "units", 1), { radiant: true });
    unit.damage = 2;
    unit.buffs = { attack: 1, health: 1 };
    unit.grantedKeywords = [{ kind: "Taunt" }];
    unit.vanilla = true;
    unit.counters.plague = 2;
    unit.memory.note = "eaten";
    unit.exertion = { attacked: true, switched: true };
    unit.position = "DEF";
    unit.summonedTurn = 7;
    unit.statsOverride = { attack: 9, health: 9 };
    unit.tauntSuppressedTurn = 3;
    unit.controller = "p2";
    unit.costMod = -1;
    unit.costOverride = 2;

    moveToZone(state, unit, "hand");

    expect(unit).toMatchObject({
      damage: 0,
      buffs: { attack: 0, health: 0 },
      grantedKeywords: [],
      vanilla: false,
      counters: {},
      memory: {},
      exertion: { attacked: false, switched: false },
      controller: "p1",
      radiant: true,
      costMod: -1,
      costOverride: 2,
    });
    expect(unit.position).toBeUndefined();
    expect(unit.summonedTurn).toBeUndefined();
    expect(unit.statsOverride).toBeUndefined();
    expect(unit.tauntSuppressedTurn).toBeUndefined();

    // A Death trigger reads the card as it was just before it left.
    const dying = put(state, rememberer.id, slot("p1", "units", 2));
    dying.memory.note = "remembered";
    dying.damage = 99;
    stateCheck(sink);
    expect(state.players.p2.hero.health).toBe(HERO_HEALTH - 4);

    // A Reborn unit returns reset, at 1 health, without Reborn.
    const rb = put(state, rebornUnit.id, slot("p2", "units", 1));
    rb.buffs = { attack: 3, health: 0 };
    rb.damage = 99;
    stateCheck(sink);
    expect(unitView(state, rb).health).toBe(1);
    expect(unitHas(state, rb, "Reborn")).toBe(false);
    expect(rb.buffs).toEqual({ attack: 0, health: 0 });
  });

  it("R79 answers only the timed-out player's prompt, loses on a disconnect, draws at the ceiling, and leaves the clocks to the server", () => {
    // A prompt held by the non-active player: their own clock answers it and the turn stays open.
    const prompted = playing("r79-prompt");
    openPrompt(sinkFor(prompted), {
      player: "p2",
      kind: "mode",
      prompt: "pick one",
      options: [{ key: "mode:a", label: "a", selection: { pick: "mode", option: "a" } }],
      resume: { defId: "", hook: "resume", step: "none", radiant: false, data: {} },
    });
    const turn = prompted.turn;
    const answered = actResult(prompted, { type: "timeout", playerId: "p2" });
    expect(answered.error).toBeUndefined();
    expect(answered.state.pending).toBeNull();
    expect(answered.state.active).toBe("p1");
    expect(answered.state.turn).toBe(turn);

    // The active player's clock ends the turn instead.
    const clean = playing("r79-clean");
    const timedOut = actResult(clean, { type: "timeout", playerId: "p1" });
    expect(timedOut.error).toBeUndefined();
    expect(timedOut.state.active).toBe("p2");

    // A disconnect is a loss; the hard ceiling is a draw.
    expect(actResult(clean, { type: "disconnectExpired", player: "p1", playerId: "p1" }).state.result).toEqual({
      winner: "p2",
      reason: "disconnect",
    });
    expect(actResult(clean, { type: "ceilingReached", playerId: "p1" }).state.result).toEqual({
      winner: "draw",
      reason: "match-ceiling",
    });

    // The engine carries the clock the server runs, and none of R79's numbers.
    expect(viewFor(clean, "p1", 75_000).clockMs).toBe(75_000);
    expect(viewFor(clean, "p1").clockMs).toBeNull();
    expect(Object.keys(engineConfig).filter((key) => SERVER_CONSTANTS.includes(key))).toEqual([]);
    // M6/M7: apps/server/src/config.ts carries the clock, grace, ceiling, room-code and Elo values.
  });

  it("R80 caps a library at LIBRARY_CAP: a new card is never created and an existing one lands in the graveyard", () => {
    const state = game("r80");
    const sink = sinkFor(state);
    state.players.p1.library = Array.from({ length: LIBRARY_CAP }, () =>
      newInstance(state, plain.id, "p1", { z: "library", player: "p1" }),
    );

    const fresh = newInstance(state, plain.id, "p1", { z: "resolving", player: "p1" });
    expect(shuffleIntoLibrary(sink, fresh, false)).toBe("dropped");
    expect(state.players.p1.library).toHaveLength(LIBRARY_CAP);
    expect(eventsOfType(sink.events, "shuffledIn")).toHaveLength(0);

    const existing = put(state, plain.id, slot("p1", "units", 1));
    expect(shuffleIntoLibrary(sink, existing, true)).toBe("dropped");
    expect(state.players.p1.graveyard.map((card) => card.id)).toEqual([existing.id]);

    // A unit-token card ceases to exist instead of reaching a graveyard (R11).
    const token = put(state, unitToken.id, slot("p1", "units", 2));
    expect(shuffleIntoLibrary(sink, token, true)).toBe("dropped");
    expect(state.players.p1.graveyard.map((card) => card.id)).toEqual([existing.id]);
    expect(state.players.p1.exile.some((card) => card.id === token.id)).toBe(false);
  });

  it("R81 carries zone, X, targets and modes in the play action, and opens a PendingChoice only during resolution", () => {
    const state = playing("r81");
    state.players.p1.hand = [];
    const unit = handCard(state, plain.id);
    const x = handCard(state, xCard.id);

    const plays = legalActions(state, "p1").filter((action) => action.type === "play");
    expect(plays.filter((a) => a.type === "play" && a.instanceId === unit.id)).toHaveLength(UNIT_ZONES);
    expect(plays.flatMap((a) => (a.type === "play" && a.instanceId === x.id ? [a.x] : []))).toEqual([0, 1]);

    // A declared target travels in `targets` and a declared direction in `modes`: nothing pauses.
    const enemy = put(state, bigBody.id, slot("p2", "units", 1));
    const spell = handCard(state, modeSpell.id);
    const resolved = actResult(state, {
      type: "play",
      instanceId: spell.id,
      playerId: "p1",
      targets: [{ pick: "instance", instanceId: enemy.id }],
      modes: ["left"],
    });
    expect(resolved.error).toBeUndefined();
    expect(resolved.state.pending).toBeNull();
    expect(eventsOfType(resolved.events, "damage").map((event) => event.amount)).toEqual([1]);
    expect(scriptsFor(modeSpell.id).base.targets).toEqual([{ kind: "target", min: 1, max: 1 }]);
    expect(scriptsFor(modeSpell.id).base.modes).toEqual([{ kind: "direction", options: ["left", "right"] }]);

    // A choice made during resolution opens a PendingChoice instead.
    const discover = handCard(state, discoverSpell.id);
    const paused = actResult(state, { type: "play", instanceId: discover.id, playerId: "p1" });
    expect(paused.error).toBeUndefined();
    expect(paused.state.pending?.kind).toBe("discover");
  });

  it("R82 ends the turn by itself when only ending, conceding and offering a draw are left", () => {
    const state = playing("r82");
    state.players.p1.hand = [];
    const card = handCard(state, noop.id);
    expect(legalActions(state, "p1").map((action) => action.type)).toContain("offerDraw");

    const result = actResult(state, { type: "play", instanceId: card.id, playerId: "p1" });
    expect(result.error).toBeUndefined();
    // The draw offer was still on the table and did not hold the turn open (R36).
    expect(eventsOfType(result.events, "turnAutoEnded")).toHaveLength(1);
    expect(result.state.active).toBe("p2");
  });

  it("R83 brings a Reborn unit back summoning sick, so it cannot attack twice, but it may still switch", () => {
    const state = playing("r83");
    const rb = put(state, rebornUnit.id, slot("p1", "units", 1)); // 2/2 Reborn
    const wall = put(state, bigBody.id, slot("p2", "units", 1)); // 5/5

    const sink = sinkFor(state);
    expect(declareAttack(sink, rb, { kind: "unit", instance: wall }).error).toBeUndefined();

    // It died in that combat and came back in its reserved zone, at 1 health.
    expect(cardAt(state, slot("p1", "units", 1))?.id).toBe(rb.id);
    expect(unitView(state, rb).health).toBe(1);
    expect(unitHas(state, rb, "Reborn")).toBe(false);

    // It entered the field again this turn, so it is sick and cannot take a second attack.
    expect(rb.summonedTurn).toBe(state.turn);
    expect(whyCannotAttack(state, rb, { kind: "unit", instance: wall })).toBe("that unit is summoning sick");

    // R78 cleared its exertion, so it may switch position, as any unit summoned this turn may.
    expect(hasExertion(rb, "switch")).toBe(true);
    expect(switchPosition(sink, rb).error).toBeUndefined();
    expect(rb.position).toBe("DEF");
  });

  it("R84 keeps concede, offerDraw and answerDraw out of the policy, so a random game ends by death or the cap", () => {
    const state = playing("r84");
    expect([...AI_SKIPPED_ACTIONS]).toEqual(["concede", "offerDraw", "answerDraw"]);

    const offered = legalActions(state, "p1").map((action) => action.type);
    expect(offered).toContain("concede");
    expect(offered).toContain("offerDraw");
    const policy = policyActions(state, "p1").map((action) => action.type);
    for (const skipped of AI_SKIPPED_ACTIONS) expect(policy).not.toContain(skipped);
    expect(policyActions(state, "p1", { skip: [] }).map((action) => action.type)).toEqual(offered);

    // The random-game harness filters the same set, so a fuzz game never resigns itself.
    const finished = playRandomGame("rb-r84").state;
    expect(["hero-death", "both-heroes-dead", "turn-cap"]).toContain(finished.result?.reason);
  });
});
