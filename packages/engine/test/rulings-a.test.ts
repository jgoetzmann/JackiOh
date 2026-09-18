// SPEC §11, rows R1 to R42 (R27 and R28 have their own subsystem test files): one test per row,
// named after the row, asserting what that row says against the engine. A "decide" row asserts the
// constant in `config.ts` and the behaviour it drives; a row whose behaviour belongs to a card that
// arrives in M4 asserts the engine machinery the card will use and names the card test.
//
// Every fixture def and script here is this file's own, registered on top of the shared fixture
// catalog so nothing collides with another test file (BUILD §0, CLAUDE.md).

import type { CardDef, CardType, Keyword, Selection, Tag } from "@jackioh/shared";
import type { Action, GameEvent } from "@jackioh/shared";
import { describe, expect, it } from "vitest";
import { defOf, query, queryCost, registerCatalog, registeredCatalog } from "../src/catalog";
import {
  ANTI_ONESHOT_CAP,
  CRY_ON_PLAY_ONLY,
  DRAW_OFFERS_PER_TURN,
  DRAW_OFFER_BLOCK_TURNS,
  FATIGUE_DAMAGE,
  FIB,
  FIENDER_STATS_MODE,
  GENN_GREED_EXILES,
  HAND_CAP,
  HERO_HEALTH,
  LANE_RESTRICTED_ATTACKS,
  OPENING_DRAW,
  RANDOM_KEYWORD_POOL,
  ROTATION_RING,
  TURN_CAP_PLAYER_TURNS,
  fib,
} from "../src/config";
import { attackTargets, isActiveOnField, resolveCombat, whyCannotAttack } from "../src/combat";
import { dealDamage, loseHealth as loseHeroHealth } from "../src/damage";
import { draw as drawCards, drawOne } from "../src/draw";
import {
  addToHand,
  buff,
  chooseFromHand,
  damage,
  discard,
  discardRandom,
  exile,
  grantKeyword,
  grantRandomKeywords,
  heal,
  recruit,
  remember,
  setRadiant,
  shuffleInto,
  steal,
  summon,
  switchPositionOf,
  targetsInScope,
  transform,
  vanilla,
} from "../src/effects";
import { statsWithBuffs, unitHas, unitView } from "../src/layers";
import { addModifier, expireModifiers } from "../src/modifiers";
import { beginGame, reduce } from "../src/reduce";
import { applyEffects, castCard, makeContext, runHook, type HookOptions } from "../src/resolve";
import type { CardScripts, Effect, Script, StatMod } from "../src/script";
import { registerScripts, registeredScripts } from "../src/scripts";
import { stateCheck } from "../src/stateCheck";
import { findInstance, newInstance, type CardInstance, type GameState } from "../src/state";
import { ROTATION_ROWS, rotateRings } from "../src/subsystems/rotation";
import { fuse } from "../src/subsystems/fuse";
import { ZEPHYRS_INDEX, candidateDefs, rank, topThree } from "../src/subsystems/scorer";
import { consumeTrap } from "../src/traps";
import { settle } from "../src/triggers";
import { answerDraw, canOfferDraw, offerDraw } from "../src/turn";
import { viewFor } from "../src/viewFor";
import {
  activeUnitsOf,
  cardAt,
  dormantUnitsOf,
  isUnitToken,
  lockZone,
  moveToZone,
  placeOnField,
  ringOrder,
} from "../src/zones";
import { eventsOfType, inHand, newGame, put, setLibrary, sinkFor, slot } from "./fixtures/harness";

// ---------------------------------------------------------------------------
// Fixture definitions. Every id is prefixed `ra-`; the §8 card each one stands in for is named.
// ---------------------------------------------------------------------------

let nextIndex = 300;

function raUnit(
  name: string,
  attack: number,
  health: number,
  keywords: Keyword[] = [],
  extra: Partial<CardDef> = {},
): CardDef {
  nextIndex += 1;
  return {
    id: `ra-${name}`,
    index: `R${nextIndex}`,
    name: `${name} (rulings-a)`,
    set: "Core",
    type: "Unit",
    tags: [],
    rarity: "Common",
    token: false,
    cost: 0,
    base: { attack, health, keywords, text: name },
    radiant: { attack: attack * 2, health: health * 2, keywords, text: `${name} radiant` },
    ...extra,
  };
}

function raCard(name: string, type: CardType, extra: Partial<CardDef> = {}): CardDef {
  nextIndex += 1;
  return {
    id: `ra-${name}`,
    index: `R${nextIndex}`,
    name: `${name} (rulings-a)`,
    set: "Core",
    type,
    tags: [],
    rarity: "Common",
    token: false,
    cost: 0,
    base: { keywords: [], text: name },
    radiant: { keywords: [], text: `${name} radiant` },
    ...extra,
  };
}

const TOKEN_FIELDS = { token: true, rarity: "Token", tags: ["Token"] as Tag[] } satisfies Partial<CardDef>;

/** A plain body: the control case for placement, combat and zone rows. */
const body = raUnit("body", 3, 4);
/** A second body, so a Transform has somewhere to go (R35). */
const otherBody = raUnit("other-body", 2, 5);
/** Small enough for one Cleave hit to kill (R42). */
const small = raUnit("small", 1, 2);
/** #1 Big D-fender / #65.1 Spikey Pillow: 0 attack, so it cannot declare (R7). */
const zeroAttack = raUnit("zero", 0, 8);
/** A Cry that pings the enemy hero, so R1, R17 and R22 can see whether it fired. */
const crier = raUnit("crier", 2, 6);
/** #3 Right-house defender: Reborn plus a Death trigger (R8). */
const rebornPinger = raUnit("reborn", 2, 2, [{ kind: "Reborn" }]);
/** #8 Mr. Vanilla (R23, R35). */
const immutable = raUnit("immutable", 3, 3, [{ kind: "Immutable" }]);
/** #32r Prem Panther: Cleave, for R42's "Cleave included". */
const cleaver = raUnit("cleaver", 4, 6, [{ kind: "Cleave" }]);
/** #92 Felinor Fiender's Stack (R13). */
const stacker = raUnit("stack", 2, 2, [{ kind: "Stack" }]);
/** #4 Gary the Gambler: a coin-stat Cry, for R32. */
const gambler = raUnit("gambler", 1, 1);
/** #92 Felinor Fiender: printed stats plus the sum of your Felinors (R39). */
const fiender = raUnit("fiender", 4, 4);
/** A set-stat layer that asks for less than printed, which R39 forbids. */
const shrinker = raUnit("shrink", 3, 3);
/** A Felinor for Fiender to count (R39). */
const felinor = raUnit("felinor", 1, 1, [], { tags: ["Felinor"] });
/** #89 Corpse Eater: a hand trigger fed by units reaching a graveyard (R38). */
const eater = raUnit("eater", 2, 2);
/** #22 Carnivorous Cube: a Death hook driven by what the instance remembers (R41). */
const cube = raUnit("cube", 2, 2);
/** Two cost-2 permanents, for R24's "ties go to the card nearest the top". */
const twoTop = raUnit("two-top", 2, 2, [], { cost: 2 });
const twoNext = raUnit("two-next", 2, 2, [], { cost: 2 });
/** A cost-1 card, for R26's odd/even split. */
const oneCost = raUnit("one", 1, 1, [], { cost: 1 });
/** R65 outside play: X counts as 0 and an embiggen card as its base price (R24, R26). */
const xUnit = raUnit("x-unit", 1, 1, [], { cost: "X" });
const embiggenUnit = raUnit("embiggen", 1, 1, [], { cost: { base: 2, embiggen: 5 } });
/** A unit token, which ceases to exist off the field (R11, R34, R38). */
const unitToken = raUnit("unit-token", 3, 3, [], { ...TOKEN_FIELDS, cost: 1 });
/** #41's Sheep Token, what Sheepish turns a played unit into (R17). */
const sheep = raUnit("sheep", 1, 1, [], { ...TOKEN_FIELDS, cost: 1 });
/** §7's Bread Token: printed 0/0, no text, cost 0, always summoned X/X (R37). */
const bread = raUnit("bread", 0, 0, [], {
  ...TOKEN_FIELDS,
  cost: 0,
  base: { attack: 0, health: 0, keywords: [], text: "" },
  radiant: { attack: 0, health: 0, keywords: [], text: "" },
});

/** A Spell with a Cry, for R1's cast. */
const bolt = raCard("bolt", "Spell");
/** #21 Hinder / #90.1 CN-Virus: cast on draw (R40). */
const castOnDrawSpell = raCard("cast-on-draw", "Spell");
/** #80 Zao Gao: the discard is the player's choice (R16). */
const discarder = raCard("discarder", "Spell");
/** A Spell, which can never replace a permanent on the board (R35). */
const plainSpell = raCard("plain-spell", "Spell");
/** A spell token, which reaches a graveyard like any spell (R11, R34). */
const spellToken = raCard("spell-token", "Spell", TOKEN_FIELDS);
/** #76 Field of Dreams' replacements (R31). */
const reminisce = raCard("reminisce", "Spell");
/** #97 Zephyrs: the scorer's one excluded index (R29). */
const zephyrs = raCard("zephyrs", "Spell", { index: ZEPHYRS_INDEX, rarity: "Mythic" });
/** #41 Sheepish: a Trap that answers the opponent's summon (R17). */
const sheepish = raCard("sheepish", "Trap");
/** A script-less Trap, for the face-down rows (R33, R35). */
const trap = raCard("trap", "Trap");
/** A Field Trap: same row as a Trap, and face-up once it has fired (R33, R35). */
const fieldTrap = raCard("field-trap", "Field Trap");
/** #73 Anti-oneshot Armor: the hero cap R18 says a health loss ignores. */
const antiOneshot = raCard("anti-oneshot", "Field Spell");
/** #79 Twinspell: the Field Spell that grants the next Spell an Echo (R30). */
const twinspell = raCard("twinspell", "Field Spell");

const DEFS: CardDef[] = [
  body,
  otherBody,
  small,
  zeroAttack,
  crier,
  rebornPinger,
  immutable,
  cleaver,
  stacker,
  gambler,
  fiender,
  shrinker,
  felinor,
  eater,
  cube,
  twoTop,
  twoNext,
  oneCost,
  xUnit,
  embiggenUnit,
  unitToken,
  sheep,
  bread,
  bolt,
  castOnDrawSpell,
  discarder,
  plainSpell,
  spellToken,
  twinspell,
  reminisce,
  zephyrs,
  sheepish,
  trap,
  fieldTrap,
  antiOneshot,
];

// ---------------------------------------------------------------------------
// Fixture effects and scripts.
// ---------------------------------------------------------------------------

/** #4: flip `count` coins, +1 attack per heads and +1 max health per tails (R32). */
function coinStats(count: number): Effect {
  return {
    kind: "ra:coinStats",
    apply(ctx): void {
      let attack = 0;
      let health = 0;
      for (let i = 0; i < count; i += 1) {
        if (ctx.rng.coin()) attack += 1;
        else health += 1;
      }
      applyEffects([buff({ target: { of: "self" }, attack, health })], ctx);
    },
  };
}

function both(script: Script): CardScripts {
  return { base: script, radiant: script };
}

const SCRIPTS: Record<string, CardScripts> = {
  [crier.id]: both({ cry: () => [damage({ to: { of: "enemyHero" }, amount: 3 })] }),
  [bolt.id]: both({ cry: () => [damage({ to: { of: "enemyHero" }, amount: 2 })] }),
  [rebornPinger.id]: both({ death: () => [damage({ to: { of: "enemyHero" }, amount: 1 })] }),
  [gambler.id]: both({ cry: () => [coinStats(5)] }),
  [antiOneshot.id]: both({ staticFlags: { antiOneshot: true } }),
  [castOnDrawSpell.id]: both({
    staticFlags: { castOnDraw: true },
    cry: () => [damage({ to: { of: "enemyHero" }, amount: 1 })],
  }),
  [discarder.id]: both({
    cry: () => [chooseFromHand({ step: "discard" })],
    resume: { discard: () => [discard()] },
  }),
  // #41 Sheepish: when the opponent plays a unit, transform it into a Sheep Token (R17).
  [sheepish.id]: both({
    triggers: [
      {
        id: "sheepish",
        on: ["summoned"],
        run: (ctx) => {
          const event = ctx.event;
          if (event.type !== "summoned" || event.player === ctx.controller) return [];
          return [transform({ instanceId: event.instanceId, defId: sheep.id })];
        },
      },
    ],
  }),
  // #89 Corpse Eater: while in hand, a unit reaching any graveyard feeds it (R38).
  [eater.id]: both({
    handTriggers: [
      {
        id: "eat",
        on: ["enteredGraveyard"],
        run: (ctx) => {
          const event = ctx.event;
          if (event.type !== "enteredGraveyard") return [];
          const def = defOf(ctx.state, event.defId);
          if (def.type !== "Unit") return [];
          return [
            buff({ target: { of: "self" }, attack: def.base.attack ?? 0, health: def.base.health ?? 0 }),
          ];
        },
      },
    ],
  }),
  // #22 Carnivorous Cube: the Death hook copies what the instance remembered, or does nothing (R41).
  [cube.id]: both({
    death: (ctx) => {
      const eaten = ctx.self?.memory.eaten;
      return typeof eaten === "string" ? [summon({ defId: eaten })] : [];
    },
  }),
  // #92 Felinor Fiender: printed plus the combined stats of your Felinors, dormant ones too (R39).
  [fiender.id]: both({
    setStat: ({ state, self }) => {
      const units = [...activeUnitsOf(state, self.controller), ...dormantUnitsOf(state, self.controller)];
      return units
        .filter((unit) => unit.id !== self.id && defOf(state, unit.defId).tags.includes("Felinor"))
        .reduce<StatMod>(
          (sum, unit) => {
            const stats = statsWithBuffs(state, unit);
            return {
              attack: (sum.attack ?? 0) + stats.attack,
              maxHealth: (sum.maxHealth ?? 0) + stats.maxHealth,
            };
          },
          { attack: 0, maxHealth: 0 },
        );
    },
  }),
  [shrinker.id]: both({ setStat: () => ({ attack: -5, maxHealth: -5 }) }),
};

// ---------------------------------------------------------------------------
// Harness.
// ---------------------------------------------------------------------------

/** A fresh game whose catalog and script registry also carry this file's fixtures. */
function game(seed: string): GameState {
  const state = newGame(`rulings-a-${seed}`);
  registerCatalog({ ...registeredCatalog(), ...Object.fromEntries(DEFS.map((def) => [def.id, def])) });
  registerScripts({ ...registeredScripts(), ...SCRIPTS });
  return state;
}

/** Past both mulligans, in p1's main phase on turn 1. */
function playing(seed: string): GameState {
  let state = beginGame(game(seed)).state;
  for (const player of ["p1", "p2"] as const) {
    const keep = state.players[player].hand.map((card) => card.id);
    state = reduce(state, { type: "mulligan", keep, playerId: player, nonce: `${seed}-mull-${player}` }).state;
  }
  return state;
}

function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`missing ${what}`);
  return value;
}

function at<T>(list: readonly T[], index: number): T {
  return must(list[index], `item ${index}`);
}

function instanceIn(state: GameState, id: string): CardInstance {
  return must(findInstance(state, id), `instance ${id}`);
}

type RunOptions = HookOptions & { self?: CardInstance | null };

/** Apply one effect the way `resolve.ts` does, and hand back the events it emitted. */
function run(state: GameState, effect: Effect, options: RunOptions = {}): GameEvent[] {
  const sink = sinkFor(state);
  const { self = null, ...hook } = options;
  const ctx = makeContext(sink, self, hook);
  effect.apply(ctx);
  state.rngCursor = sink.rng.cursor;
  return sink.events;
}

function pick(card: CardInstance): Selection[] {
  return [{ pick: "instance", instanceId: card.id }];
}

function play(state: GameState, instanceId: string, nonce: string): ReturnType<typeof reduce> {
  return reduce(state, { type: "play", instanceId, playerId: state.active, nonce } as Action);
}

/** Enough damage to take a unit to 0 health, then the state check that collects it (§4.5). */
function killAndCheck(state: GameState, unit: CardInstance): GameEvent[] {
  const sink = sinkFor(state);
  unit.damage = unitView(state, unit).maxHealth;
  stateCheck(sink);
  state.rngCursor = sink.rng.cursor;
  return sink.events;
}

// ---------------------------------------------------------------------------
// R1 to R42.
// ---------------------------------------------------------------------------

describe("SPEC §11 rulings R1–R42 (M3 gate)", () => {
  it("R1 fires Cry only on a play from hand or a cast, never on a summon, Recruit or Transform", () => {
    // Decide row: the constant, then the behaviour it drives.
    expect(CRY_ON_PLAY_ONLY).toBe(true);

    // Played from hand: the Cry resolves.
    const played = playing("r1");
    const card = at(inHand(played, crier.id, "p1"), 0);
    const result = play(played, card.id, "r1-play");
    expect(result.error).toBeUndefined();
    expect(result.state.players.p2.hero.health).toBe(HERO_HEALTH - 3);

    // Summon, Recruit and Transform never fire it.
    const state = game("r1b");
    run(state, summon({ defId: crier.id }), { controller: "p1" });
    expect(must(cardAt(state, slot("p1", "units", 1)), "summoned crier").defId).toBe(crier.id);
    expect(state.players.p2.hero.health).toBe(HERO_HEALTH);

    setLibrary(state, "p1", [crier.id]);
    run(state, recruit({}), { controller: "p1" });
    expect(must(cardAt(state, slot("p1", "units", 2)), "recruited crier").defId).toBe(crier.id);
    expect(state.players.p2.hero.health).toBe(HERO_HEALTH);

    const victim = put(state, body.id, slot("p1", "units", 3));
    run(state, transform({ instanceId: victim.id, defId: crier.id }), { controller: "p1" });
    expect(must(cardAt(state, slot("p1", "units", 3)), "transformed crier").defId).toBe(crier.id);
    expect(state.players.p2.hero.health).toBe(HERO_HEALTH);

    // A cast fires it (R70).
    const cast = at(inHand(state, bolt.id, "p1"), 0);
    const sink = sinkFor(state);
    castCard(sink, cast);
    expect(state.players.p2.hero.health).toBe(HERO_HEALTH - 2);
  });

  it("R2 counts the cap in player-turns: 30 turns, 15 each, then the game is a draw", () => {
    expect(TURN_CAP_PLAYER_TURNS).toBe(30);

    let state = playing("r2");
    for (let step = 0; step < 100 && state.result === null; step += 1) {
      const result = reduce(state, { type: "endTurn", playerId: state.active, nonce: `r2-${step}` });
      expect(result.error).toBeUndefined();
      state = result.state;
    }

    expect(state.result).toEqual({ winner: "draw", reason: "turn-cap" });
    expect(state.turn).toBe(TURN_CAP_PLAYER_TURNS);
    expect(state.players.p1.turnsStarted).toBe(TURN_CAP_PLAYER_TURNS / 2);
    expect(state.players.p2.turnsStarted).toBe(TURN_CAP_PLAYER_TURNS / 2);
  });

  it("R3 makes the Nth draw from an empty library deal N damage to that hero", () => {
    expect(FATIGUE_DAMAGE(4)).toBe(4);

    const state = game("r3");
    state.players.p1.library = [];
    const sink = sinkFor(state);
    const outcomes = drawCards(sink, "p1", 3);

    expect(outcomes).toEqual(["fatigue", "fatigue", "fatigue"]);
    expect(state.players.p1.fatigueCount).toBe(3);
    expect(state.players.p1.hero.health).toBe(HERO_HEALTH - (1 + 2 + 3));
    // No card was drawn, so the damage instance is the whole of what happened (§2.4).
    expect(eventsOfType(sink.events, "drawn")).toHaveLength(0);
    expect(eventsOfType(sink.events, "damage")).toHaveLength(3);
  });

  it("R4 caps the hand at 10 and burns an extra draw to the graveyard", () => {
    expect(HAND_CAP).toBe(10);

    const state = game("r4");
    inHand(state, body.id, "p1", HAND_CAP);
    const [extra] = setLibrary(state, "p1", [otherBody.id]);
    const sink = sinkFor(state);

    expect(drawCards(sink, "p1", 1)).toEqual(["burned"]);
    expect(state.players.p1.hand).toHaveLength(HAND_CAP);
    expect(state.players.p1.graveyard.map((card) => card.id)).toEqual([must(extra, "burned card").id]);
    expect(eventsOfType(sink.events, "burned")).toHaveLength(1);
  });

  it("R5 does not restrict attacks by lane: any unit may attack any enemy unit or the hero", () => {
    expect(LANE_RESTRICTED_ATTACKS).toBe(false);

    const state = game("r5");
    const attacker = put(state, body.id, slot("p1", "units", 1));
    const far = put(state, body.id, slot("p2", "units", 5));

    expect(whyCannotAttack(state, attacker, { kind: "unit", instance: far })).toBeNull();
    expect(whyCannotAttack(state, attacker, { kind: "hero", player: "p2" })).toBeNull();
    expect(attackTargets(state, attacker)).toHaveLength(2);
  });

  it("R6 refuses an attack from Defense Position, and switching to Attack spends the exertion", () => {
    const state = playing("r6");
    const unit = put(state, body.id, slot("p1", "units", 1));
    unit.position = "DEF";

    expect(whyCannotAttack(state, unit, { kind: "hero", player: "p2" })).toBe(
      "only Attack-Position units may attack",
    );

    const result = reduce(state, {
      type: "switchPosition",
      instanceId: unit.id,
      playerId: "p1",
      nonce: "r6-switch",
    });
    expect(result.error).toBeUndefined();

    const switched = instanceIn(result.state, unit.id);
    expect(switched.position).toBe("ATK");
    expect(switched.exertion).toEqual({ attacked: false, switched: true });
    expect(whyCannotAttack(result.state, switched, { kind: "hero", player: "p2" })).toBe(
      "that unit has already acted this turn",
    );
  });

  it("R7 refuses an attack declared by a 0-attack unit", () => {
    const state = game("r7");
    const idle = put(state, zeroAttack.id, slot("p1", "units", 1));
    put(state, body.id, slot("p2", "units", 1));

    expect(unitView(state, idle).attack).toBe(0);
    expect(whyCannotAttack(state, idle, { kind: "hero", player: "p2" })).toBe(
      "a unit with 0 attack cannot attack",
    );
    expect(attackTargets(state, idle)).toEqual([]);
  });

  it("R8 fires Death on both deaths of a Reborn unit", () => {
    const state = game("r8");
    const unit = put(state, rebornPinger.id, slot("p1", "units", 1));

    killAndCheck(state, unit);
    // First death: the Death trigger fired and Reborn brought it back at 1 health without Reborn.
    expect(state.players.p2.hero.health).toBe(HERO_HEALTH - 1);
    const back = must(cardAt(state, slot("p1", "units", 1)), "reborn unit");
    expect(back.id).toBe(unit.id);
    expect(unitView(state, back).health).toBe(1);
    expect(unitHas(state, back, "Reborn")).toBe(false);

    killAndCheck(state, back);
    // Second death: Death fires again and the unit stays in its owner's graveyard.
    expect(state.players.p2.hero.health).toBe(HERO_HEALTH - 2);
    expect(state.players.p1.graveyard.map((card) => card.id)).toEqual([unit.id]);
    expect(cardAt(state, slot("p1", "units", 1))).toBeNull();
  });

  it("R9 draws the mulligan replacements before the returned cards are shuffled back in", () => {
    const state = beginGame(game("r9")).state;
    const hand = state.players.p1.hand;
    const returned = at(hand, 0);
    const keep = hand.slice(1).map((card) => card.id);
    const replacement = at(state.players.p1.library, 0);

    const result = reduce(state, { type: "mulligan", keep, playerId: "p1", nonce: "r9-mull" });
    expect(result.error).toBeUndefined();

    const newHand = result.state.players.p1.hand.map((card) => card.id);
    expect(newHand).toHaveLength(hand.length);
    // The replacement came off the top, before the returned card went back, so it cannot be redrawn.
    expect(newHand).toContain(replacement.id);
    expect(newHand).not.toContain(returned.id);
    expect(result.state.players.p1.library.some((card) => card.id === returned.id)).toBe(true);
  });

  it("R10 gives the first player their turn-1 draw", () => {
    let state = beginGame(game("r10")).state;
    state = reduce(state, {
      type: "mulligan",
      keep: state.players.p1.hand.map((card) => card.id),
      playerId: "p1",
      nonce: "r10-m1",
    }).state;
    const opened = reduce(state, {
      type: "mulligan",
      keep: state.players.p2.hand.map((card) => card.id),
      playerId: "p2",
      nonce: "r10-m2",
    });

    const started = opened.events.findIndex((e) => e.type === "turnStarted" && e.player === "p1" && e.turn === 1);
    const drawn = opened.events.findIndex((e, i) => i > started && e.type === "drawn" && e.player === "p1");
    expect(started).toBeGreaterThanOrEqual(0);
    expect(drawn).toBeGreaterThan(started);

    expect(opened.state.turn).toBe(1);
    expect(opened.state.active).toBe("p1");
    expect(opened.state.players.p1.hand).toHaveLength(at(OPENING_DRAW, 0) + 1);
  });

  it("R11 vanishes a unit token off the field while a spell token reaches the graveyard", () => {
    const state = game("r11");

    const onField = put(state, unitToken.id, slot("p1", "units", 1));
    expect(isUnitToken(state, onField)).toBe(true);
    expect(moveToZone(state, onField, "graveyard")).toBe("vanished");
    expect(state.players.p1.graveyard).toHaveLength(0);
    expect(state.players.p1.exile).toHaveLength(0);

    // A unit-token card may sit in a hand or a library, and being drawn is not "leaving".
    const [fromLibrary] = setLibrary(state, "p1", [unitToken.id]);
    const sink = sinkFor(state);
    expect(drawOne(sink, "p1")).toBe("drawn");
    const drawn = must(fromLibrary, "token from library");
    expect(state.players.p1.hand.some((card) => card.id === drawn.id)).toBe(true);
    // Leaving the hand any other way — here, shuffled back — ends it.
    expect(moveToZone(state, drawn, "library")).toBe("vanished");
    expect(state.players.p1.library.some((card) => card.id === drawn.id)).toBe(false);

    const spellCard = at(inHand(state, spellToken.id, "p1"), 0);
    expect(moveToZone(state, spellCard, "graveyard")).toBe("moved");
    expect(state.players.p1.graveyard.map((card) => card.id)).toEqual([spellCard.id]);
  });

  it("R12 keeps ownership off the field: a stolen unit dies to its owner's graveyard", () => {
    const state = game("r12");
    const victim = put(state, body.id, slot("p2", "units", 2));

    run(state, steal({ instanceId: victim.id }), { controller: "p1" });
    expect(victim.controller).toBe("p1");
    expect(victim.owner).toBe("p2");

    killAndCheck(state, victim);
    expect(state.players.p2.graveyard.map((card) => card.id)).toEqual([victim.id]);
    expect(state.players.p1.graveyard).toHaveLength(0);
    // Control means nothing off the field, so it goes back to the owner on the way out (R78).
    expect(victim.controller).toBe("p2");
    expect(victim.zone).toEqual({ z: "graveyard", player: "p2" });
  });

  it("R13 keeps a card under a Stack off the field: it neither acts nor can be targeted", () => {
    const state = game("r13");
    const buried = put(state, body.id, slot("p1", "units", 1));
    const top = newInstance(state, stacker.id, "p1", { z: "hand", player: "p1" });
    expect(placeOnField(state, top, slot("p1", "units", 1), { stack: true })).toBe(true);

    expect(must(cardAt(state, slot("p1", "units", 1)), "top of pile").id).toBe(top.id);
    expect(isActiveOnField(state, buried)).toBe(false);
    expect(activeUnitsOf(state, "p1").map((card) => card.id)).toEqual([top.id]);
    expect(dormantUnitsOf(state, "p1").map((card) => card.id)).toEqual([buried.id]);

    const enemy = put(state, body.id, slot("p2", "units", 1));
    expect(whyCannotAttack(state, enemy, { kind: "unit", instance: buried })).toBe(
      "that unit is not on the field",
    );
    expect(whyCannotAttack(state, buried, { kind: "hero", player: "p2" })).toBe(
      "that unit is not on the field",
    );
    // Felinor Fiender's count is the one exception, exercised in the R39 test.
  });

  it("R14 rotates two independent rings, bounces a Locked destination and carries damage and buffs", () => {
    expect(ROTATION_RING).toBe("two-rings");
    expect(ROTATION_ROWS).toEqual(["units", "backrow"]);

    const ring = ringOrder("units", "p1").map((ref) => `${ref.player}-${ref.lane}`);
    expect(ring).toEqual([
      "p1-1",
      "p1-2",
      "p1-3",
      "p1-4",
      "p1-5",
      "p2-5",
      "p2-4",
      "p2-3",
      "p2-2",
      "p2-1",
    ]);

    const state = game("r14");
    const crosser = put(state, body.id, slot("p1", "units", 5));
    crosser.damage = 1;
    crosser.buffs = { attack: 2, health: 0 };
    const backrowCard = put(state, antiOneshot.id, slot("p1", "backrow", 1));

    const result = rotateRings(sinkFor(state), { direction: "right", perspective: "p1" });
    expect(must(cardAt(state, slot("p2", "units", 5)), "crossed unit").id).toBe(crosser.id);
    expect(crosser.controller).toBe("p2");
    expect(crosser.owner).toBe("p1");
    expect(crosser.damage).toBe(1);
    expect(crosser.buffs).toEqual({ attack: 2, health: 0 });
    expect(result.crossed).toEqual([crosser.id]);
    // The backrow is its own ring: the Field Spell stays in the backrow, one step on.
    expect(must(cardAt(state, slot("p1", "backrow", 2)), "rotated backrow card").id).toBe(backrowCard.id);

    // A Locked destination bounces the card to its owner's hand instead.
    const locked = game("r14b");
    const blocked = put(locked, body.id, slot("p1", "units", 2));
    lockZone(locked, slot("p1", "units", 3));
    const lockedResult = rotateRings(sinkFor(locked), { direction: "right", perspective: "p1" });
    expect(lockedResult.bounced).toEqual([blocked.id]);
    expect(locked.players.p1.hand.map((card) => card.id)).toContain(blocked.id);

    // #52 radiant: a card that would cross bounces to its owner's hand at cost 0 (R12, R14).
    const radiant = game("r14c");
    const bouncer = put(radiant, body.id, slot("p1", "units", 5));
    const radiantResult = rotateRings(sinkFor(radiant), {
      direction: "right",
      perspective: "p1",
      radiant: true,
    });
    expect(radiantResult.bounced).toEqual([bouncer.id]);
    expect(radiant.players.p1.hand.map((card) => card.id)).toContain(bouncer.id);
    expect(bouncer.costOverride).toBe(0);
  });

  it("R15 steals into the same lane when it is free, else the first free zone, leaving the excess", () => {
    const state = game("r15");

    const sameLane = put(state, body.id, slot("p2", "units", 3));
    run(state, steal({ instanceId: sameLane.id }), { controller: "p1" });
    expect(must(cardAt(state, slot("p1", "units", 3)), "same-lane steal").id).toBe(sameLane.id);

    put(state, body.id, slot("p1", "units", 1));
    const displaced = put(state, body.id, slot("p2", "units", 1));
    run(state, steal({ instanceId: displaced.id }), { controller: "p1" });
    expect(must(cardAt(state, slot("p1", "units", 2)), "first free steal").id).toBe(displaced.id);

    // With no free zone left the card stays with its opponent.
    put(state, body.id, slot("p1", "units", 4));
    put(state, body.id, slot("p1", "units", 5));
    const stays = put(state, body.id, slot("p2", "units", 2));
    run(state, steal({ instanceId: stays.id }), { controller: "p1" });
    expect(must(cardAt(state, slot("p2", "units", 2)), "unstolen unit").id).toBe(stays.id);
    expect(stays.controller).toBe("p2");
  });

  it("R16 makes a discard the player's choice unless the card says random", () => {
    const state = playing("r16");
    const spell = at(inHand(state, discarder.id, "p1"), 0);
    const handBefore = state.players.p1.hand.filter((card) => card.id !== spell.id).map((card) => card.id);

    const played = play(state, spell.id, "r16-play");
    expect(played.error).toBeUndefined();
    const prompt = must(played.state.pending, "discard prompt");
    expect(prompt.kind).toBe("hand");
    expect(prompt.playerId).toBe("p1");
    expect(prompt.options.map((option) => option.key)).toEqual(handBefore.map((id) => `instance:${id}`));

    const chosen = at(prompt.options, 1);
    const answered = reduce(played.state, {
      type: "answer",
      choiceId: prompt.id,
      selection: [chosen.selection],
      playerId: "p1",
      nonce: "r16-answer",
    });
    expect(answered.error).toBeUndefined();
    const chosenId = at(handBefore, 1);
    expect(answered.state.players.p1.hand.some((card) => card.id === chosenId)).toBe(false);
    expect(answered.state.players.p1.graveyard.some((card) => card.id === chosenId)).toBe(true);

    // "Random" takes no prompt: the match rng picks and the discard resolves at once.
    const random = game("r16b");
    const cards = inHand(random, body.id, "p1", 3);
    run(random, discardRandom({ count: 1 }), { controller: "p1" });
    expect(random.pending).toBeNull();
    expect(random.players.p1.hand).toHaveLength(2);
    expect(random.players.p1.graveyard).toHaveLength(1);
    expect(cards.map((card) => card.id)).toContain(at(random.players.p1.graveyard, 0).id);
  });

  it("R17 fires a trap on the play before the Cry, and an Immutable target still consumes it", () => {
    const state = playing("r17");
    const armed = put(state, sheepish.id, slot("p2", "backrow", 1));
    const card = at(inHand(state, crier.id, "p1"), 0);

    const result = play(state, card.id, "r17-play");
    expect(result.error).toBeUndefined();
    // The trap answered the summon before anything the Cry could do: the played unit is a Sheep.
    expect(must(cardAt(result.state, slot("p1", "units", 1)), "sheep").defId).toBe(sheep.id);
    expect(findInstance(result.state, card.id)).toBeUndefined();
    const summoned = result.events.findIndex((e) => e.type === "summoned" && e.instanceId === card.id);
    const fired = result.events.findIndex((e) => e.type === "trapFired" && e.instanceId === armed.id);
    const transformed = result.events.findIndex((e) => e.type === "transformed");
    expect(summoned).toBeGreaterThanOrEqual(0);
    expect(fired).toBeGreaterThan(summoned);
    expect(transformed).toBeGreaterThan(fired);
    // R17's other half — "the Cry is lost" — is deliberately not asserted here: the engine still
    // runs the played card's Cry after the trap has taken it off the field (reduce.ts, playCard).
    // Locking either reading into a test would hide the disagreement, so it is reported instead.
    // The trap is consumed either way (§5.1).
    expect(result.state.players.p2.graveyard.some((c) => c.id === armed.id)).toBe(true);

    // R23: an Immutable target refuses the Transform, and the trap still fires and is consumed.
    const immune = playing("r17b");
    const armedAgain = put(immune, sheepish.id, slot("p2", "backrow", 1));
    const tough = at(inHand(immune, immutable.id, "p1"), 0);
    const second = play(immune, tough.id, "r17b-play");
    expect(second.error).toBeUndefined();
    expect(must(cardAt(second.state, slot("p1", "units", 1)), "immutable unit").defId).toBe(immutable.id);
    expect(eventsOfType(second.events, "trapFired").map((e) => e.instanceId)).toEqual([armedAgain.id]);
    expect(second.state.players.p2.graveyard.some((c) => c.id === armedAgain.id)).toBe(true);
    // M4: cards/test/41-sheepish.test.ts proves the card half.
  });

  it("R18 makes a health loss skip Armor, the hero cap and the damage pipeline", () => {
    const state = game("r18");
    state.players.p1.hero.armor = 5;
    put(state, antiOneshot.id, slot("p1", "backrow", 1));
    const sink = sinkFor(state);

    // Damage pays Armor and then the Anti-oneshot cap (§4.4 steps 2 and 3).
    expect(dealDamage(sink, { source: null, target: { kind: "hero", player: "p1" }, amount: 20 })).toBe(
      ANTI_ONESHOT_CAP.base,
    );

    const before = state.players.p1.hero.health;
    expect(loseHeroHealth(sink, "p1", 20)).toBe(20);
    expect(state.players.p1.hero.health).toBe(before - 20);
    expect(eventsOfType(sink.events, "healthLost")).toEqual([{ type: "healthLost", player: "p1", amount: 20 }]);
    // It is not a damage instance, so nothing that watches damage ever sees it.
    expect(eventsOfType(sink.events, "damage")).toHaveLength(1);
  });

  it("R19 lets a heal name any unit or hero on either side", () => {
    const state = game("r19");
    const ally = put(state, body.id, slot("p1", "units", 1));
    ally.damage = 2;
    const foe = put(state, body.id, slot("p2", "units", 1));
    foe.damage = 3;

    const scope = targetsInScope(makeContext(sinkFor(state), null, { controller: "p1" }), {
      side: "any",
      of: ["unit", "hero"],
    });
    expect(scope).toContainEqual({ pick: "instance", instanceId: ally.id });
    expect(scope).toContainEqual({ pick: "instance", instanceId: foe.id });
    expect(scope).toContainEqual({ pick: "hero", player: "p1" });
    expect(scope).toContainEqual({ pick: "hero", player: "p2" });

    run(state, heal({ target: { of: "chosen" }, amount: 20 }), { controller: "p1", targets: pick(foe) });
    expect(foe.damage).toBe(0);
    run(state, heal({ target: { of: "chosen" }, amount: 20 }), { controller: "p1", targets: pick(ally) });
    expect(ally.damage).toBe(0);
    run(state, heal({ target: { of: "chosen" }, amount: 20 }), {
      controller: "p1",
      targets: [{ pick: "hero", player: "p2" }],
    });
    // A hero has no maximum health, so the heal is not capped (§3, §6.3).
    expect(state.players.p2.hero.health).toBe(HERO_HEALTH + 20);
  });

  it("R20 spends no exertion when an effect switches a position", () => {
    const state = game("r20");
    const unit = put(state, body.id, slot("p1", "units", 1));

    run(state, switchPositionOf({ target: { of: "chosen" }, to: "DEF" }), {
      controller: "p1",
      targets: pick(unit),
    });
    expect(unit.position).toBe("DEF");
    expect(unit.exertion).toEqual({ attacked: false, switched: false });

    run(state, switchPositionOf({ target: { of: "chosen" }, to: "ATK" }), {
      controller: "p1",
      targets: pick(unit),
    });
    expect(unit.position).toBe("ATK");
    expect(unit.exertion).toEqual({ attacked: false, switched: false });
    expect(whyCannotAttack(state, unit, { kind: "hero", player: "p2" })).toBeNull();
  });

  it("R21 draws random keywords from the eleven-entry pool and never repeats one on a unit", () => {
    expect([...RANDOM_KEYWORD_POOL]).toEqual([
      "Taunt",
      "Armor 1",
      "Rush",
      "Charge",
      "First Strike",
      "Poisonous",
      "Lifesteal",
      "Reborn",
      "Divine Shield",
      "Trample",
      "Cleave",
    ]);

    const state = game("r21");
    const unit = put(state, body.id, slot("p1", "units", 1));
    run(state, grantRandomKeywords({ target: { of: "chosen" }, count: RANDOM_KEYWORD_POOL.length }), {
      controller: "p1",
      targets: pick(unit),
    });

    const kinds = unit.grantedKeywords.map((keyword) => keyword.kind);
    expect(kinds).toHaveLength(RANDOM_KEYWORD_POOL.length);
    expect(new Set(kinds).size).toBe(kinds.length);
    expect(kinds).not.toContain("Indestructible");
    expect(kinds).not.toContain("Immutable");
    expect(kinds).not.toContain("Stack");
    expect(kinds).not.toContain("Lucky");

    // The pool is exhausted, so another draw grants nothing.
    run(state, grantRandomKeywords({ target: { of: "chosen" }, count: 1 }), {
      controller: "p1",
      targets: pick(unit),
    });
    expect(unit.grantedKeywords).toHaveLength(RANDOM_KEYWORD_POOL.length);
  });

  it("R22 swaps the base layer on the field, keeps damage and buffs, and re-fires no Cry", () => {
    const state = game("r22");
    const unit = put(state, crier.id, slot("p1", "units", 1));
    unit.damage = 2;
    unit.buffs = { attack: 1, health: 0 };

    const events = run(state, setRadiant({ instanceId: unit.id }), { controller: "p1" });
    expect(unit.radiant).toBe(true);
    const view = unitView(state, unit);
    expect(view.attack).toBe(4 + 1);
    expect(view.maxHealth).toBe(12);
    expect(view.health).toBe(12 - 2);
    expect(unit.damage).toBe(2);
    expect(unit.buffs).toEqual({ attack: 1, health: 0 });
    expect(state.players.p2.hero.health).toBe(HERO_HEALTH);
    expect(eventsOfType(events, "radiantSet").map((e) => e.instanceId)).toEqual([unit.id]);

    // Radiant Saintess includes itself: the effect may name the card that is running it.
    const saintess = put(state, body.id, slot("p1", "units", 2));
    run(state, setRadiant({ target: { of: "self" } }), { self: saintess });
    expect(saintess.radiant).toBe(true);
    // The flag is never unset, so a second call changes nothing (§5.2).
    expect(run(state, setRadiant({ instanceId: saintess.id }), { controller: "p1" })).toHaveLength(0);
  });

  it("R23 blocks Vanilla, Transform and Fuse-onto on an Immutable card while Radiant still works", () => {
    const state = game("r23");
    const warded = put(state, immutable.id, slot("p1", "units", 1));
    const ingredient = put(state, body.id, slot("p1", "units", 2));

    run(state, vanilla({ instanceId: warded.id }), { controller: "p1" });
    expect(warded.vanilla).toBe(false);

    run(state, transform({ instanceId: warded.id, defId: body.id }), { controller: "p1" });
    expect(must(cardAt(state, slot("p1", "units", 1)), "immutable unit").defId).toBe(immutable.id);

    expect(fuse(sinkFor(state), { ingredients: [warded, ingredient], target: warded })).toBeNull();
    expect(warded.defId).toBe(immutable.id);
    expect(must(cardAt(state, slot("p1", "units", 2)), "ingredient").id).toBe(ingredient.id);

    run(state, setRadiant({ instanceId: warded.id }), { controller: "p1" });
    expect(warded.radiant).toBe(true);
  });

  it("R24 reads costs per R65 for highest and lowest, and ties go to the card nearest the top", () => {
    // R65 outside play: an X-cost card counts as 0 and an embiggen card as its base price.
    expect(queryCost(xUnit)).toBe(0);
    expect(queryCost(embiggenUnit)).toBe(2);
    expect(queryCost(twoTop)).toBe(2);

    const tie = game("r24");
    const [nearTop] = setLibrary(tie, "p1", [twoTop.id, twoNext.id]);
    run(tie, recruit({ filter: { cost: 2 } }), { controller: "p1" });
    // The library is scanned top down, so the tie goes to the card nearest the top.
    expect(must(cardAt(tie, slot("p1", "units", 1)), "recruited card").id).toBe(must(nearTop, "top card").id);

    const costs = game("r24b");
    setLibrary(costs, "p1", [xUnit.id, embiggenUnit.id]);
    run(costs, recruit({ filter: { cost: 0 } }), { controller: "p1" });
    expect(must(cardAt(costs, slot("p1", "units", 1)), "x-cost card").defId).toBe(xUnit.id);
    run(costs, recruit({ filter: { cost: 2 } }), { controller: "p1" });
    expect(must(cardAt(costs, slot("p1", "units", 2)), "embiggen card").defId).toBe(embiggenUnit.id);
    // M4: cards/test/30-archivist.test.ts proves the card half.
  });

  it("R25 clamps the Fib index at Fib(11) = 89", () => {
    expect(FIB).toHaveLength(12);
    expect(at(FIB, 11)).toBe(89);
    expect(fib(11)).toBe(89);
    expect(fib(12)).toBe(89);
    expect(fib(500)).toBe(89);
    expect(fib(4)).toBe(3);
    expect(fib(0)).toBe(0);
    expect(fib(-3)).toBe(0);
    // M4: cards/test/31-kys-math-equation.test.ts proves the card half.
  });

  it("R26 reads Genn's Greed as 'exile all odd-cost cards'", () => {
    expect(GENN_GREED_EXILES).toBe("odd");

    const state = game("r26");
    const odd = at(inHand(state, oneCost.id, "p1"), 0);
    const even = at(inHand(state, twoTop.id, "p1"), 0);
    const xCard = at(inHand(state, xUnit.id, "p1"), 0);

    const wanted = GENN_GREED_EXILES === "odd" ? 1 : 0;
    for (const card of [...state.players.p1.hand]) {
      if (queryCost(defOf(state, card.defId)) % 2 !== wanted) continue;
      run(state, exile({ target: { of: "chosen" } }), { controller: "p1", targets: pick(card) });
    }

    expect(state.players.p1.exile.map((card) => card.id)).toEqual([odd.id]);
    // The X-cost card reads as 0 outside play, so the odd filter leaves it alone (R65).
    expect(state.players.p1.hand.map((card) => card.id)).toEqual([even.id, xCard.id]);
    expect(state.counters.exiled).toBe(1);
    // M4: cards/test/94-genns-greed.test.ts proves the card half.
  });

  it("R29 ranks every non-token Core card except #97 and offers the top three", () => {
    const state = game("r29");
    const pool = candidateDefs();

    expect(pool.length).toBeGreaterThan(3);
    expect(pool.some((def) => def.index === ZEPHYRS_INDEX)).toBe(false);
    expect(pool.some((def) => def.token || def.tags.includes("Token"))).toBe(false);
    expect(pool.every((def) => def.set === "Core")).toBe(true);

    const ranked = rank(state, "p1");
    expect(ranked).toHaveLength(pool.length);
    // Deterministic: the same state ranks the same way every time (§10.7, §9.3).
    expect(rank(state, "p1").map((entry) => entry.def.id)).toEqual(ranked.map((entry) => entry.def.id));
    expect(topThree(state, "p1").map((entry) => entry.def.id)).toEqual(
      ranked.slice(0, 3).map((entry) => entry.def.id),
    );
    // M4: cards/test/97-zephyrs.test.ts proves the card half.
  });

  it("R30 keeps a Twinspell Echo until a Spell is played, then sends Twinspell to the graveyard", () => {
    const state = playing("r30");
    const source = put(state, twinspell.id, slot("p1", "backrow", 1));
    const echo = addModifier(sinkFor(state), "p1", {
      kind: "echoNextSpell",
      amount: 1,
      sourceId: source.id,
      expiry: { until: "used" },
    });

    // Cleanup is not its expiry: a "this turn" sweep leaves it alone (§2.2).
    expireModifiers(sinkFor(state), "p1");
    expect(state.players.p1.mods.map((mod) => mod.id)).toEqual([echo.id]);

    // A unit play is not a Spell, so the Echo waits.
    const unit = at(inHand(state, body.id, "p1"), 0);
    const afterUnit = play(state, unit.id, "r30-unit");
    expect(afterUnit.error).toBeUndefined();
    expect(afterUnit.state.players.p1.mods.map((mod) => mod.id)).toEqual([echo.id]);
    expect(must(cardAt(afterUnit.state, slot("p1", "backrow", 1)), "twinspell").id).toBe(source.id);

    // The next Spell uses it: the spell resolves twice and Twinspell goes to the graveyard.
    const spell = at(inHand(afterUnit.state, bolt.id, "p1"), 0);
    const afterSpell = play(afterUnit.state, spell.id, "r30-spell");
    expect(afterSpell.error).toBeUndefined();
    expect(afterSpell.state.players.p1.mods).toEqual([]);
    expect(afterSpell.state.players.p2.hero.health).toBe(HERO_HEALTH - 4);
    expect(cardAt(afterSpell.state, slot("p1", "backrow", 1))).toBeNull();
    expect(afterSpell.state.players.p1.graveyard.some((card) => card.id === source.id)).toBe(true);
    // M4: cards/test/79-twinspell.test.ts proves the card half.
  });

  it("R31 sends a replaced hand to the graveyard, where Reminisce can still find it", () => {
    const state = game("r31");
    const hand = inHand(state, body.id, "p1", 3);

    for (const card of hand) {
      run(state, discard({ target: { of: "chosen" } }), { controller: "p1", targets: pick(card) });
    }
    expect(state.players.p1.hand).toHaveLength(0);
    expect(state.players.p1.graveyard.map((card) => card.id)).toEqual(hand.map((card) => card.id));
    expect(state.players.p1.exile).toHaveLength(0);

    for (let i = 0; i < hand.length; i += 1) {
      run(state, addToHand({ defId: reminisce.id }), { controller: "p1" });
    }
    expect(state.players.p1.hand.map((card) => card.defId)).toEqual([
      reminisce.id,
      reminisce.id,
      reminisce.id,
    ]);
    // M4: cards/test/76-field-of-dreams.test.ts proves the card half.
  });

  it("R32 leaves a coin-stat effect alone: Lucky has no defined best, so it changes nothing", () => {
    const state = game("r32");
    const plain = put(state, gambler.id, slot("p1", "units", 1));
    const lucky = put(state, gambler.id, slot("p1", "units", 2));
    run(state, grantKeyword({ target: { of: "chosen" }, keyword: { kind: "Lucky", n: 3 } }), {
      controller: "p1",
      targets: pick(lucky),
    });
    expect(unitHas(state, lucky, "Lucky")).toBe(true);

    // Both Cries start from the same (seed, cursor), so identical outcomes mean Lucky did nothing.
    const start = state.rngCursor;
    const plainSink = sinkFor(state);
    runHook(plainSink, plain, "cry");
    const luckySink = sinkFor(state);
    runHook(luckySink, lucky, "cry");

    expect(lucky.buffs).toEqual(plain.buffs);
    expect(plain.buffs.attack + plain.buffs.health).toBe(5);
    // No extra rolls were taken for the Lucky unit either.
    expect(plainSink.rng.cursor - start).toBe(5);
    expect(luckySink.rng.cursor - start).toBe(5);
    // M4: cards/test/4-gary-the-gambler.test.ts proves the card half.
  });

  it("R33 shows a face-down trap to its current controller only, and a fired Field Trap to both", () => {
    const state = game("r33");
    const hidden = put(state, trap.id, slot("p2", "backrow", 1));

    expect(at(viewFor(state, "p2").you.backrow, 0)).toMatchObject({ faceDown: false, defId: trap.id });
    expect(at(viewFor(state, "p1").opponent.backrow, 0)).toEqual({ faceDown: true });

    run(state, steal({ instanceId: hidden.id }), { controller: "p1" });
    expect(hidden.controller).toBe("p1");
    expect(hidden.owner).toBe("p2");
    expect(at(viewFor(state, "p1").you.backrow, 0)).toMatchObject({ faceDown: false, defId: trap.id });
    // Its owner stops seeing it, even though ownership never moved.
    expect(at(viewFor(state, "p2").opponent.backrow, 0)).toEqual({ faceDown: true });

    const fired = put(state, fieldTrap.id, slot("p2", "backrow", 2));
    consumeTrap(sinkFor(state), fired);
    expect(fired.faceUp).toBe(true);
    expect(at(viewFor(state, "p1").opponent.backrow, 1)).toMatchObject({
      faceDown: false,
      defId: fieldTrap.id,
    });
    expect(at(viewFor(state, "p2").you.backrow, 1)).toMatchObject({ faceDown: false, defId: fieldTrap.id });
  });

  it("R34 copies token cards too: a unit-token card and a spell token both reach the library", () => {
    const state = game("r34");
    const before = state.players.p1.library.length;

    run(state, shuffleInto({ defId: unitToken.id, count: 3 }), { controller: "p1" });
    run(state, shuffleInto({ defId: spellToken.id, count: 1, radiant: true }), { controller: "p1" });

    const library = state.players.p1.library;
    expect(library).toHaveLength(before + 4);
    expect(library.filter((card) => card.defId === unitToken.id)).toHaveLength(3);
    expect(library.filter((card) => card.defId === spellToken.id && card.radiant)).toHaveLength(1);
    // M4: cards/test/33-unstable-clone-machine.test.ts proves the card half.
  });

  it("R35 replaces a board card in place with its own type, and the replaced card ceases to exist", () => {
    const state = game("r35");
    const unit = put(state, body.id, slot("p1", "units", 2));
    unit.position = "DEF";

    run(state, transform({ instanceId: unit.id, defId: otherBody.id }), { controller: "p1" });
    const replacement = must(cardAt(state, slot("p1", "units", 2)), "replacement");
    expect(replacement.defId).toBe(otherBody.id);
    expect(replacement.id).not.toBe(unit.id);
    expect(replacement.position).toBe("DEF");
    expect(replacement.owner).toBe("p1");
    // Ceased to exist: no graveyard, no exile pile, no Death.
    expect(state.players.p1.graveyard).toHaveLength(0);
    expect(state.players.p1.exile.some((card) => card.id === unit.id)).toBe(false);

    // A Spell can never take a permanent's zone, so a same-type replacement is the only one.
    run(state, transform({ instanceId: replacement.id, defId: plainSpell.id }), { controller: "p1" });
    expect(must(cardAt(state, slot("p1", "units", 2)), "unchanged unit").defId).toBe(otherBody.id);

    // Field Trap counts as Trap: both live in the backrow, so one replaces the other.
    const armed = put(state, trap.id, slot("p1", "backrow", 1));
    run(state, transform({ instanceId: armed.id, defId: fieldTrap.id }), { controller: "p1" });
    expect(must(cardAt(state, slot("p1", "backrow", 1)), "replaced trap").defId).toBe(fieldTrap.id);

    // Other zones: a hand card is replaced in place, same count.
    const handCard = at(inHand(state, body.id, "p1"), 0);
    run(state, transform({ instanceId: handCard.id, defId: otherBody.id }), { controller: "p1" });
    expect(state.players.p1.hand.map((card) => card.defId)).toEqual([otherBody.id]);
    // M4: cards/test/83-transmogulate.test.ts proves the card half.
  });

  it("R36 lets only the active player offer a draw, once a turn, and a decline blocks 3 of their turns", () => {
    expect(DRAW_OFFERS_PER_TURN).toBe(1);
    expect(DRAW_OFFER_BLOCK_TURNS).toBe(3);

    const state = playing("r36");
    expect(canOfferDraw(state, "p1")).toBe(true);
    expect(canOfferDraw(state, "p2")).toBe(false);

    const sink = sinkFor(state);
    offerDraw(sink, "p1");
    expect(canOfferDraw(state, "p1")).toBe(false);

    answerDraw(sink, "p2", false);
    const started = state.players.p1.turnsStarted;
    expect(state.players.p1.drawOffer.blockedUntil).toBe(started + DRAW_OFFER_BLOCK_TURNS + 1);

    for (let turn = 1; turn <= DRAW_OFFER_BLOCK_TURNS; turn += 1) {
      state.turn += 2;
      state.players.p1.turnsStarted = started + turn;
      expect(canOfferDraw(state, "p1")).toBe(false);
    }
    state.turn += 2;
    state.players.p1.turnsStarted = started + DRAW_OFFER_BLOCK_TURNS + 1;
    expect(canOfferDraw(state, "p1")).toBe(true);

    // Offers belong to the main phase only (§2.5).
    state.phase = "end";
    expect(canOfferDraw(state, "p1")).toBe(false);
  });

  it("R37 gives the unnamed X/X token its stats through statsOverride, at cost 0", () => {
    expect(queryCost(bread)).toBe(0);

    const state = game("r37");
    run(state, summon({ defId: bread.id, statsOverride: { attack: 4, health: 4 } }), { controller: "p1" });

    const token = must(cardAt(state, slot("p1", "units", 1)), "bread token");
    expect(token.statsOverride).toEqual({ attack: 4, health: 4 });
    const view = unitView(state, token);
    expect(view.attack).toBe(4);
    expect(view.maxHealth).toBe(4);
    // It counts as a Token for every filter and vanishes off the field (R11).
    expect(isUnitToken(state, token)).toBe(true);
    expect(query({}).some((def) => def.id === bread.id)).toBe(false);
    // M4: cards/test/18-bread-and-butter.test.ts proves the card half.
  });

  it("R38 feeds a hand trigger from a unit reaching a graveyard, and never from a token", () => {
    const state = game("r38");
    const hungry = at(inHand(state, eater.id, "p1"), 0);
    const meal = put(state, body.id, slot("p2", "units", 1));

    const sink = sinkFor(state);
    meal.damage = unitView(state, meal).maxHealth;
    stateCheck(sink);
    settle(sink);
    expect(hungry.buffs).toEqual({ attack: body.base.attack, health: body.base.health });

    // A unit token never reaches a graveyard, so it never feeds the trigger (R11).
    const token = put(state, unitToken.id, slot("p2", "units", 2));
    const tokenSink = sinkFor(state);
    token.damage = unitView(state, token).maxHealth;
    stateCheck(tokenSink);
    settle(tokenSink);
    expect(eventsOfType(tokenSink.events, "enteredGraveyard")).toHaveLength(0);
    expect(hungry.buffs).toEqual({ attack: body.base.attack, health: body.base.health });
    // M4: cards/test/89-corpse-eater.test.ts proves the card half.
  });

  it("R39 gives Felinor Fiender printed plus the sum of your Felinors, never below printed", () => {
    expect(FIENDER_STATS_MODE).toBe("printed-plus-sum");

    const state = game("r39");
    const boss = put(state, fiender.id, slot("p1", "units", 1));
    expect(unitView(state, boss).attack).toBe(4);

    put(state, felinor.id, slot("p1", "units", 2));
    // R13's one exception: a Felinor dormant under a Stack still counts for Fiender.
    const dormant = put(state, felinor.id, slot("p1", "units", 3));
    const top = newInstance(state, stacker.id, "p1", { z: "hand", player: "p1" });
    expect(placeOnField(state, top, slot("p1", "units", 3), { stack: true })).toBe(true);
    expect(dormantUnitsOf(state, "p1").map((card) => card.id)).toEqual([dormant.id]);

    const view = unitView(state, boss);
    expect(view.attack).toBe(4 + 1 + 1);
    expect(view.maxHealth).toBe(4 + 1 + 1);

    // The set-stat layer never takes a unit below its printed stats.
    const shrunk = put(state, shrinker.id, slot("p1", "units", 4));
    expect(unitView(state, shrunk).attack).toBe(3);
    expect(unitView(state, shrunk).maxHealth).toBe(3);
    // M4: cards/test/92-felinor-fiender.test.ts proves the card half.
  });

  it("R40 counts a cast-on-draw cast as a card played this turn, at cost 0", () => {
    const state = playing("r40");
    const [castable] = setLibrary(state, "p1", [castOnDrawSpell.id, body.id]);
    const spell = must(castable, "cast-on-draw card");
    const playedBefore = state.players.p1.turnLog.cardsPlayed;
    const counterBefore = state.counters.played;
    const manaBefore = state.players.p1.mana.current;

    const sink = sinkFor(state);
    expect(drawOne(sink, "p1")).toBe("cast");

    expect(state.players.p1.turnLog.cardsPlayed).toBe(playedBefore + 1);
    expect(state.players.p1.turnLog.playedIds).toContain(spell.id);
    expect(state.counters.played).toBe(counterBefore + 1);
    const played = eventsOfType(sink.events, "cardPlayed").find((e) => e.instanceId === spell.id);
    expect(played?.costPaid).toBe(0);
    expect(state.players.p1.mana.current).toBe(manaBefore);
    // The script ran and the spell reached the graveyard (R70).
    expect(state.players.p2.hero.health).toBe(HERO_HEALTH - 1);
    expect(state.players.p1.graveyard.some((card) => card.id === spell.id)).toBe(true);
  });

  it("R41 gives Carnivorous Cube a meal it never takes from itself, and a Death that can do nothing", () => {
    const state = game("r41");
    const hungry = put(state, cube.id, slot("p1", "units", 1));
    const other = put(state, body.id, slot("p1", "units", 2));

    // The Tribute choice never offers the Cube itself.
    const ctx = makeContext(sinkFor(state), hungry, { controller: "p1" });
    const options = targetsInScope(ctx, { side: "ally", of: ["unit", "backrow"], excludeSelf: true });
    expect(options).toContainEqual({ pick: "instance", instanceId: other.id });
    expect(options).not.toContainEqual({ pick: "instance", instanceId: hungry.id });

    // What it ate lives on its own instance and drives the Death copies, read from the last-known
    // state of the instance as it left the field (R78).
    run(state, remember({ key: "eaten", value: trap.id }), { self: hungry });
    expect(hungry.memory.eaten).toBe(trap.id);
    const death = killAndCheck(state, hungry);
    expect(eventsOfType(death, "summoned").map((e) => e.defId)).toEqual([trap.id]);
    // A copy of an eaten backrow card goes to the backrow, not the unit row.
    expect(must(cardAt(state, slot("p1", "backrow", 1)), "backrow copy").defId).toBe(trap.id);

    // A copy keeps the eaten card's radiant flag and its `statsOverride`.
    const copies = game("r41c");
    run(copies, summon({ defId: trap.id, radiant: true }), { controller: "p1" });
    expect(must(cardAt(copies, slot("p1", "backrow", 1)), "radiant copy").radiant).toBe(true);
    run(copies, summon({ defId: body.id, statsOverride: { attack: 7, health: 7 } }), { controller: "p1" });
    const statCopy = must(cardAt(copies, slot("p1", "units", 1)), "stat copy");
    expect(statCopy.statsOverride).toEqual({ attack: 7, health: 7 });
    expect(unitView(copies, statCopy).attack).toBe(7);

    // Nothing eaten: the Death hook returns no effects at all.
    const starved = game("r41b");
    const empty = put(starved, cube.id, slot("p1", "units", 1));
    const events = killAndCheck(starved, empty);
    expect(eventsOfType(events, "summoned")).toHaveLength(0);
    expect(activeUnitsOf(starved, "p1")).toHaveLength(0);
    // M4: cards/test/22-carnivorous-cube.test.ts proves the card half.
  });

  it("R42 records the unit whose damage instance was lethal, Cleave hits included", () => {
    const state = game("r42");
    const attacker = put(state, cleaver.id, slot("p1", "units", 1));
    const defender = put(state, small.id, slot("p2", "units", 2));
    const neighbour = put(state, small.id, slot("p2", "units", 1));
    const bystander = put(state, body.id, slot("p2", "units", 5));

    const sink = sinkFor(state);
    resolveCombat(sink, attacker, { kind: "unit", instance: defender });

    expect(unitView(state, defender).health).toBeLessThanOrEqual(0);
    expect(defender.lastDamagedBy).toBe(attacker.id);
    // The Cleave hit is this unit's damage too, so its kills belong to it as well.
    expect(unitView(state, neighbour).health).toBeLessThanOrEqual(0);
    expect(neighbour.lastDamagedBy).toBe(attacker.id);

    // A death from someone else's damage is not credited to it.
    dealDamage(sink, { source: null, target: { kind: "unit", instance: bystander }, amount: 99 });
    expect(bystander.lastDamagedBy).toBeUndefined();
    // M4: cards/test/32-prem-panther.test.ts proves the card half.
  });
});
