// Combo-Index (BUILD M3-T7): SPEC §8 #93, R27, R60, R62 and §4.4 step 8.
//
// The card is a Field Spell with a grade counter on its instance. At the end of its controller's
// turn, "if cards played this turn >= grade, grade +1 and run every step from E up to the new
// grade" (§8 #93), the steps run in order and S is terminal (R27).

import type { CardDef, GameEvent } from "@jackioh/shared";
import { describe, expect, it } from "vitest";
import { registerCatalog, registeredCatalog } from "../src/catalog";
import { effectiveCost } from "../src/mana";
import { applyEffects, castCard, makeContext, type EngineSink } from "../src/resolve";
import type { CardScripts, Effect, Script } from "../src/script";
import { registerScripts, registeredScripts } from "../src/scripts";
import { findInstance, type CardInstance, type GameState } from "../src/state";
import {
  cascadeEffects,
  comboIndexEndOfTurn,
  GRADES,
  gradeName,
  gradeNameOf,
  gradeOf,
  gradeRises,
  gradeStepEffects,
  gradeValue,
  isTerminalGrade,
  playedCardsThisTurn,
  playsThisTurn,
  raiseGrade,
  startGrade,
  stepA,
  stepB,
  stepC,
  stepD,
  stepE,
} from "../src/subsystems/comboIndex";
import { endTurn } from "../src/turn";
import { removeFromAnyZone } from "../src/zones";
import { eventsOfType, inHand, newGame, put, sinkFor, slot } from "./fixtures/harness";

let nextIndex = 930;
function def(name: string, type: CardDef["type"], extra: Partial<CardDef> = {}): CardDef {
  nextIndex += 1;
  return {
    id: `ci-${name}`,
    index: String(nextIndex),
    name,
    set: "Core",
    type,
    tags: [],
    rarity: "Common",
    token: false,
    cost: 2,
    base: { keywords: [], text: name },
    radiant: { keywords: [], text: name },
    ...extra,
  };
}

/** #93 Combo-Index itself: a Field Spell whose end-of-turn hook is the subsystem (§8, R62). */
const comboIndex = def("combo-index", "Field Spell", { cost: 2, rarity: "Legendary" });
/** Anything cheap to play and to hold: a Spell lands in the graveyard, so a copy can still be made. */
const trick = def("trick", "Spell", { cost: 1 });
const otherTrick = def("other-trick", "Spell", { cost: 3 });
const body = def("body", "Unit", {
  cost: 2,
  base: { attack: 2, health: 2, keywords: [], text: "body" },
  radiant: { attack: 4, health: 4, keywords: [], text: "body" },
});

function both(script: Script): CardScripts {
  return { base: script, radiant: script };
}

const SCRIPTS: Record<string, CardScripts> = {
  [comboIndex.id]: both({
    endOfTurn: (ctx) => (ctx.self === null ? [] : comboIndexEndOfTurn(ctx, ctx.self)),
  }),
};

const DEFS = [comboIndex, trick, otherTrick, body];

function game(seed: string): GameState {
  const state = newGame(seed);
  registerCatalog({ ...registeredCatalog(), ...Object.fromEntries(DEFS.map((d) => [d.id, d])) });
  registerScripts({ ...registeredScripts(), ...SCRIPTS });
  state.turn = 4;
  state.active = "p1";
  state.phase = "main";
  return state;
}

/** The card on the field, at the grade the scenario needs. */
function onField(state: GameState, grade?: number): CardInstance {
  const card = put(state, comboIndex.id, slot("p1", "backrow", 1));
  if (grade !== undefined) card.counters.grade = grade;
  return card;
}

/**
 * Play a card for real: R70's cast counts as a play for everything that counts plays, so this is
 * the same `turnLog` bookkeeping §10.5 step 4 writes, not a parallel record.
 */
function play(sink: EngineSink, defId: string, options: { radiant?: boolean } = {}): CardInstance {
  const card = inHand(sink.state, defId, "p1")[0] as CardInstance;
  if (options.radiant === true) card.radiant = true;
  castCard(sink, card);
  return card;
}

function run(sink: EngineSink, self: CardInstance, effects: Effect[]): void {
  const ctx = makeContext(sink, self);
  applyEffects(effects, ctx);
}

function kindsOf(effects: Effect[]): string[] {
  return effects.map((effect) => effect.kind);
}

/**
 * The five steps as the cascade names them. Grade B is the library's own `setRadiantRandom` (R60)
 * and grade A is a `damage` effect that states its Lifesteal (R85), so both carry library kinds.
 */
const STEP_KINDS = [
  "comboIndexStepE",
  "comboIndexStepD",
  "comboIndexStepC",
  "setRadiantRandom",
  "damage",
];

describe("Combo-Index (§8 #93, R27, M3-T7)", () => {
  it("§8 #93 keeps the grade in counters.grade, starting at E, and names E,D,C,B,A,S for 1 to 6", () => {
    const state = game("grade-names");
    const events: GameEvent[] = [];
    const sink = sinkFor(state, events);
    const card = onField(state);

    // An instance that has never written the counter is at E (§8 #93 "starts at E").
    expect(card.counters.grade).toBeUndefined();
    expect(gradeOf(card)).toBe(1);
    expect(gradeNameOf(card)).toBe("E");

    expect(GRADES).toEqual(["E", "D", "C", "B", "A", "S"]);
    expect([1, 2, 3, 4, 5, 6].map(gradeName)).toEqual(["E", "D", "C", "B", "A", "S"]);
    expect(GRADES.map(gradeValue)).toEqual([1, 2, 3, 4, 5, 6]);
    expect([1, 2, 3, 4, 5].map(isTerminalGrade)).toEqual([false, false, false, false, false]);
    expect(isTerminalGrade(6)).toBe(true);

    // The counter is plain state, so the client sees it and a replay round-trips it (§10.1).
    run(sink, card, [startGrade()]);
    expect(card.counters.grade).toBe(1);
    expect(eventsOfType(events, "counterChanged")).toEqual([
      { type: "counterChanged", instanceId: card.id, counter: "grade", value: 1 },
    ]);
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);

    run(sink, card, [raiseGrade()]);
    expect(card.counters.grade).toBe(2);
    expect(gradeNameOf(card)).toBe("D");
  });

  it("§8 #93 does nothing at the end of a turn with fewer plays than the grade", () => {
    const state = game("below-threshold");
    const events: GameEvent[] = [];
    const sink = sinkFor(state, events);
    const card = onField(state, gradeValue("C")); // grade 3 needs 3 plays

    play(sink, trick.id);
    play(sink, trick.id);
    expect(playsThisTurn(state, "p1")).toBe(2);

    expect(gradeRises(state, card)).toBe(false);
    const effects = comboIndexEndOfTurn(sink, card);
    expect(effects).toEqual([]);

    run(sink, card, effects);
    expect(card.counters.grade).toBe(3);
    expect(eventsOfType(events, "counterChanged")).toEqual([]);
  });

  it("§8 #93 raises the grade when the plays reach it: grade 1 needs 1 play, grade 2 needs 2", () => {
    const first = game("at-threshold-1");
    const firstSink = sinkFor(first);
    const atE = onField(first); // grade 1
    play(firstSink, trick.id);
    expect(gradeRises(first, atE)).toBe(true);
    run(firstSink, atE, comboIndexEndOfTurn(firstSink, atE));
    expect(atE.counters.grade).toBe(2);

    const second = game("at-threshold-2");
    const secondSink = sinkFor(second);
    const atD = onField(second, gradeValue("D")); // grade 2
    play(secondSink, trick.id);
    // One play is short of 2, so nothing happens; the second play reaches the threshold.
    expect(gradeRises(second, atD)).toBe(false);
    play(secondSink, trick.id);
    expect(playsThisTurn(second, "p1")).toBe(2);
    expect(gradeRises(second, atD)).toBe(true);
    run(secondSink, atD, comboIndexEndOfTurn(secondSink, atD));
    expect(atD.counters.grade).toBe(3);
  });

  it("R27 runs every step from E up to the new grade, in order", () => {
    const state = game("cascade-order");
    const sink = sinkFor(state);
    const card = onField(state, gradeValue("D")); // rises to C
    play(sink, trick.id);
    play(sink, trick.id);

    // The rise first, then E, D and C — never a step above the new grade (R27).
    expect(kindsOf(comboIndexEndOfTurn(sink, card))).toEqual([
      "comboIndexRaiseGrade",
      ...STEP_KINDS.slice(0, 3),
    ]);

    // The cascade of each grade on its own, so "E→new grade in order" is the whole list every time.
    expect(kindsOf(cascadeEffects(gradeValue("E")))).toEqual(STEP_KINDS.slice(0, 1));
    expect(kindsOf(cascadeEffects(gradeValue("B")))).toEqual(STEP_KINDS.slice(0, 4));
    expect(kindsOf(cascadeEffects(gradeValue("A")))).toEqual(STEP_KINDS);
    // S is "run E–A again", so reaching S runs the five steps twice and never itself (R27).
    expect(kindsOf(gradeStepEffects(gradeValue("S")))).toEqual(STEP_KINDS);
    expect(kindsOf(cascadeEffects(gradeValue("S")))).toEqual([...STEP_KINDS, ...STEP_KINDS]);
  });

  it("R27 the E→S cascade runs each step in order once it reaches S", () => {
    const state = game("full-cascade");
    const events: GameEvent[] = [];
    const sink = sinkFor(state, events);
    const card = onField(state, gradeValue("A")); // rises to S
    const hand = inHand(state, trick.id, "p1", 5);
    inHand(state, otherTrick.id, "p2", 3);
    state.players.p1.hero.health = 20;
    for (let i = 0; i < 5; i += 1) play(sink, trick.id);
    const from = events.length;

    run(sink, card, comboIndexEndOfTurn(sink, card));

    expect(card.counters.grade).toBe(6);
    expect(gradeNameOf(card)).toBe("S");
    // Two full rounds of E, D, C, B, A, in order, after the counter moves (R27).
    expect(events.slice(from).map((event) => event.type)).toEqual([
      "counterChanged",
      "addedToHand",
      "costChanged",
      "costChanged",
      "exiled",
      "radiantSet",
      "damage",
      "healed",
      "addedToHand",
      "costChanged",
      "costChanged",
      "exiled",
      "radiantSet",
      "damage",
      "healed",
    ]);

    // Each step landed twice: 2 copies added, 2 enemy cards exiled, 2 cards radiant, 2 x 8 damage.
    expect(state.players.p1.hand).toHaveLength(hand.length + 2);
    expect(state.players.p2.hand).toHaveLength(1);
    expect(state.players.p2.exile).toHaveLength(2);
    expect(state.players.p1.hand.filter((c) => c.radiant)).toHaveLength(2);
    expect(state.players.p2.hero.health).toBe(30 - 16);
    expect(state.players.p1.hero.health).toBe(20 + 16);
  });

  it("R27 grade S is terminal, so the end-of-turn check does nothing at S", () => {
    const state = game("terminal-s");
    const events: GameEvent[] = [];
    const sink = sinkFor(state, events);
    const card = onField(state, gradeValue("S"));
    inHand(state, trick.id, "p1", 3);
    inHand(state, otherTrick.id, "p2", 3);
    for (let i = 0; i < 10; i += 1) play(sink, trick.id);
    const before = JSON.parse(JSON.stringify(state)) as GameState;
    const eventsBefore = events.length;

    expect(playsThisTurn(state, "p1")).toBe(10);
    expect(gradeRises(state, card)).toBe(false);
    const effects = comboIndexEndOfTurn(sink, card);
    expect(effects).toEqual([]);
    run(sink, card, effects);

    // No rise and no step: the state is exactly what it was (R27 "nothing further happens at S").
    expect(card.counters.grade).toBe(6);
    expect(state).toEqual(before);
    expect(events).toHaveLength(eventsBefore);

    // Even asked directly, the counter refuses to pass S.
    run(sink, card, [raiseGrade()]);
    expect(card.counters.grade).toBe(6);
  });

  it("R27 grade E adds a fresh copy of a random card played this turn, radiant flag kept", () => {
    const state = game("step-e");
    const events: GameEvent[] = [];
    const sink = sinkFor(state, events);
    const card = onField(state);
    const played = play(sink, trick.id, { radiant: true });
    expect(playedCardsThisTurn(state, "p1").map((c) => c.id)).toEqual([played.id]);

    run(sink, card, gradeStepEffects(gradeValue("E")));

    const copy = state.players.p1.hand[0] as CardInstance;
    expect(state.players.p1.hand).toHaveLength(1);
    expect(copy.id).not.toBe(played.id); // a fresh instance, not the card itself (R57)
    expect(copy.defId).toBe(trick.id);
    expect(copy.radiant).toBe(true); // R27: the radiant flag is kept
    expect(copy.zone).toEqual({ z: "hand", player: "p1" });
    expect(copy.damage).toBe(0);
    expect(copy.counters).toEqual({});
    // The card it copied is untouched, still in the graveyard where its cast left it.
    expect(state.players.p1.graveyard.map((c) => c.id)).toEqual([played.id]);
    expect(eventsOfType(events, "addedToHand").map((e) => e.instanceId)).toEqual([copy.id]);

    // With nothing played this turn there is nothing to copy and the step does nothing.
    const empty = game("step-e-empty");
    const emptySink = sinkFor(empty);
    const idle = onField(empty);
    run(emptySink, idle, [stepE()]);
    expect(empty.players.p1.hand).toHaveLength(0);
  });

  it("R60 grade D makes 2 different random hand cards cost 1 less", () => {
    const state = game("step-d");
    const sink = sinkFor(state);
    const card = onField(state);
    const hand = inHand(state, trick.id, "p1", 4);

    run(sink, card, [stepD()]);

    const discounted = hand.filter((c) => c.costMod === -1);
    expect(discounted).toHaveLength(2); // R60: N different cards
    expect(new Set(discounted.map((c) => c.id)).size).toBe(2);
    expect(effectiveCost(state, discounted[0] as CardInstance)).toBe((trick.cost as number) - 1);
    expect(hand.filter((c) => c.costMod === 0)).toHaveLength(2);

    // R60: fewer cards than asked for means all of them, and an empty hand means nothing.
    const small = game("step-d-small");
    const smallSink = sinkFor(small);
    const smallCard = onField(small);
    const only = inHand(small, trick.id, "p1", 1)[0] as CardInstance;
    run(smallSink, smallCard, [stepD()]);
    expect(only.costMod).toBe(-1);

    const none = game("step-d-empty");
    const noneSink = sinkFor(none);
    const noneCard = onField(none);
    expect(() => run(noneSink, noneCard, [stepD()])).not.toThrow();
    expect(none.players.p1.hand).toHaveLength(0);
  });

  it("§8 #93 grade C exiles a random card from the opponent's hand", () => {
    const state = game("step-c");
    const events: GameEvent[] = [];
    const sink = sinkFor(state, events);
    const card = onField(state);
    const mine = inHand(state, trick.id, "p1", 2);
    const theirs = inHand(state, otherTrick.id, "p2", 3);
    const exiledBefore = state.counters.exiled;

    run(sink, card, [stepC()]);

    expect(state.players.p2.hand).toHaveLength(2);
    expect(state.players.p2.exile).toHaveLength(1);
    const gone = state.players.p2.exile[0] as CardInstance;
    expect(theirs.map((c) => c.id)).toContain(gone.id);
    expect(gone.zone).toEqual({ z: "exile", player: "p2" });
    expect(state.counters.exiled).toBe(exiledBefore + 1); // R55 counts it
    expect(eventsOfType(events, "exiled").map((e) => e.instanceId)).toEqual([gone.id]);
    // It is the opponent's hand, never the controller's.
    expect(state.players.p1.hand.map((c) => c.id)).toEqual(mine.map((c) => c.id));

    // An empty enemy hand leaves the step with nothing to do.
    const empty = game("step-c-empty");
    const emptySink = sinkFor(empty);
    run(emptySink, onField(empty), [stepC()]);
    expect(empty.players.p2.exile).toHaveLength(0);
  });

  it("R60 grade B picks only among non-Radiant hand cards, and does nothing when none are left", () => {
    const state = game("step-b");
    const sink = sinkFor(state);
    const card = onField(state);
    const hand = inHand(state, trick.id, "p1", 4);
    for (const held of hand.slice(1)) held.radiant = true;
    const target = hand[0] as CardInstance;

    // Only one non-Radiant card is eligible, so the random pick must land on it (R60).
    run(sink, card, [stepB()]);
    expect(target.radiant).toBe(true);
    expect(hand.every((c) => c.radiant)).toBe(true);

    // With every hand card Radiant the pool is empty and nothing changes (R60): no card and no
    // random number (R129). The hidden hand is still cued once, as a pick would cue it (R177).
    const eventsAfter: GameEvent[] = [];
    const secondSink = sinkFor(state, eventsAfter);
    const cursor = secondSink.rng.cursor;
    run(secondSink, card, [stepB()]);
    expect(secondSink.rng.cursor).toBe(cursor);
    expect(eventsAfter.map((event) => event.type)).toEqual(["radiantSet"]);

    // A Radiant card on the field is not in the hand pool either.
    const field = game("step-b-field");
    const fieldSink = sinkFor(field);
    const fieldCard = onField(field);
    const unit = put(field, body.id, slot("p1", "units", 1));
    run(fieldSink, fieldCard, [stepB()]);
    expect(unit.radiant).toBe(false);
  });

  it("§4.4 step 8 grade A deals 8 to the enemy hero with Lifesteal, healing the controller's hero", () => {
    const state = game("step-a");
    const events: GameEvent[] = [];
    const sink = sinkFor(state, events);
    const card = onField(state);
    state.players.p1.hero.health = 12;

    run(sink, card, [stepA()]);

    expect(state.players.p2.hero.health).toBe(22);
    expect(state.players.p1.hero.health).toBe(20); // 12 + the 8 it dealt
    expect(eventsOfType(events, "damage")).toEqual([
      { type: "damage", sourceId: card.id, targetId: "hero-p2", amount: 8, combat: false },
    ]);
    expect(eventsOfType(events, "healed")).toEqual([
      { type: "healed", targetId: "hero-p1", amount: 8 },
    ]);

    // §4.4 step 8 heals by the amount dealt, so Armor cuts the heal with the hit.
    const armored = game("step-a-armor");
    const armoredSink = sinkFor(armored);
    const armoredCard = onField(armored);
    armored.players.p2.hero.armor = 3;
    armored.players.p1.hero.health = 10;
    run(armoredSink, armoredCard, [stepA()]);
    expect(armored.players.p2.hero.health).toBe(25);
    expect(armored.players.p1.hero.health).toBe(15);
  });

  it("§10.7 draws every pick from the seeded rng: one seed repeats, another seed differs", () => {
    function cascade(seed: string): string {
      const state = game(seed);
      const sink = sinkFor(state);
      const card = onField(state, gradeValue("A"));
      inHand(state, trick.id, "p1", 5);
      inHand(state, otherTrick.id, "p2", 4);
      for (const defId of [trick.id, otherTrick.id, trick.id, otherTrick.id, trick.id]) {
        play(sink, defId);
      }
      run(sink, card, comboIndexEndOfTurn(sink, card));

      // Every random pick of the S cascade, in one string: the copies, the discounts, the exiles
      // and the cards that turned Radiant.
      return JSON.stringify({
        hand: state.players.p1.hand.map((c) => `${c.defId}:${c.costMod}:${c.radiant}`),
        exiled: state.players.p2.exile.map((c) => c.defId),
      });
    }

    expect(cascade("combo-seed-a")).toBe(cascade("combo-seed-a"));
    expect(cascade("combo-seed-a")).not.toBe(cascade("combo-seed-b"));
  });

  it("R62 the rise is an ordinary end-of-turn trigger, so ending the turn runs the cascade", () => {
    const state = game("end-of-turn");
    const events: GameEvent[] = [];
    const sink = sinkFor(state, events);
    const card = onField(state);
    inHand(state, trick.id, "p1", 2);
    const played = play(sink, trick.id);

    endTurn(sink);

    expect(card.counters.grade).toBe(2);
    expect(gradeNameOf(card)).toBe("D");
    // E copied the played card and D discounted two hand cards, before the turn ended (§2.2).
    const added = eventsOfType(events, "addedToHand").filter((e) => e.player === "p1");
    expect(added).toHaveLength(1);
    expect(added[0]?.defId).toBe(played.defId);
    expect(state.players.p1.hand.filter((c) => c.costMod === -1)).toHaveLength(2);

    const order = events.map((e) => e.type);
    expect(order.indexOf("counterChanged")).toBeLessThan(order.indexOf("turnEnded"));
    expect(order.indexOf("addedToHand")).toBeLessThan(order.indexOf("turnEnded"));

    // The end of the opponent's turn is not this card's end of turn (§6.2, R62), so the grade sits.
    expect(state.active).toBe("p2");
    endTurn(sink);
    expect(card.counters.grade).toBe(2);
    expect(state.active).toBe("p1");
    expect(playsThisTurn(state, "p1")).toBe(0);
    expect(gradeRises(state, card)).toBe(false);
  });
});

describe("what a pool of cards played this turn holds (R86)", () => {
  it("R86 skips a played card that no longer exists and keeps one that only changed zone", () => {
    const state = game("played-pool");
    const sink = sinkFor(state);
    const card = onField(state);

    const spell = play(sink, trick.id); // a Spell: it resolves into the graveyard
    const unit = play(sink, body.id);
    expect(state.players.p1.turnLog.playedIds).toEqual([spell.id, unit.id]);

    // Both are still findable, so both are in the pool: a card that moved zone is still a card.
    expect(playedCardsThisTurn(state, "p1").map((c) => c.id)).toEqual([spell.id, unit.id]);

    // Make one cease to exist, as a unit token does when it leaves the field (R11): out of every
    // pile, and tagged `gone` rather than claiming a zone it is not in.
    removeFromAnyZone(state, unit);
    unit.zone = { z: "gone", player: "p1" };
    expect(findInstance(state, unit.id)).toBeUndefined();

    expect(playedCardsThisTurn(state, "p1").map((c) => c.id)).toEqual([spell.id]);
    // And the E step picks from what is left rather than fizzling on the missing id.
    run(sink, card, [stepE()]);
    expect(state.players.p1.hand.map((c) => c.defId)).toEqual([trick.id]);
  });
});
