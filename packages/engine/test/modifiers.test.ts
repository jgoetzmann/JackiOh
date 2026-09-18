// Player modifiers and delayed effects (BUILD M3-T5, SPEC §2.2, §10.1, R48, R62, R68).
//
// Two halves. The modifiers half proves each of the three expiries `ModifierExpiry` offers —
// `thisTurn`, `nextTurnOf(player)` and `used` — at its boundary, with R48's timing (a next-turn
// modifier does nothing on the turn it was made) in a test of its own. The delayed half proves
// they resolve at their R62 point in creation order, that Kpop Fanatic's steal fires after its
// unit has died (§8 #50, R76), and that Efficiency Dividend's mana is a `mana.nextTurnMod` rather
// than a delayed effect at all (§8 #24).
//
// The expiry boundaries call `expireModifiers` directly, so one state object carries a whole test
// and the modifier ids stay comparable; `reduce` clones, so the tests that need a real turn
// boundary re-find their cards in the state that comes back.

import type { Action, ActionInput, CardDef } from "@jackioh/shared";
import { describe, expect, it } from "vitest";
import { registerCatalog, registeredCatalog } from "../src/catalog";
import { damage, draw, steal, nextTurnMana } from "../src/effects";
import { effectiveCost, modifierIsLive } from "../src/mana";
import {
  addModifier,
  consumeModifier,
  dropDelayed,
  dueDelayed,
  expireModifiers,
  removeModifier,
  scheduleDelayed,
} from "../src/modifiers";
import { beginGame, reduce } from "../src/reduce";
import { applyEffects, makeContext } from "../src/resolve";
import type { CardScripts, Script } from "../src/script";
import { registerScripts, registeredScripts } from "../src/scripts";
import { newInstance, type CardInstance, type GameState, type PlayerModifier, type Resume } from "../src/state";
import { stateCheck } from "../src/stateCheck";
import { indestructible, plain, trampler } from "./fixtures/combat";
import { eventsOfType, inHand, newGame, put, sinkFor, slot } from "./fixtures/harness";

// ---------------------------------------------------------------------------
// Local defs. Indices start above 1300 so they never collide with a fixture catalog or with
// another test file's local defs.
// ---------------------------------------------------------------------------

let nextIndex = 1300;
function def(overrides: Partial<CardDef> & Pick<CardDef, "id" | "name">): CardDef {
  nextIndex += 1;
  return {
    index: String(nextIndex),
    set: "Core",
    type: "Unit",
    tags: [],
    rarity: "Common",
    token: false,
    cost: 1,
    base: { keywords: [], text: "" },
    radiant: { keywords: [], text: "" },
    ...overrides,
  };
}

/**
 * A body whose `activate` hook deals `data.amount` to the enemy hero. Two delayed effects on one
 * instance then differ only in their captured data, so the order of their `damage` events is the
 * order they resolved in (R68).
 */
const delayedBolt = def({
  id: "md-delayed-bolt",
  name: "Delayed Bolt (modifiers fixture)",
  base: { attack: 1, health: 9, keywords: [], text: "delayed: deal data.amount to the enemy hero" },
  radiant: { attack: 2, health: 18, keywords: [], text: "same" },
});

/** §8 #50 Kpop Fanatic, 1/1 → 2/2 Divine Shield: the delayed steal is its `activate` hook. */
const kpopFanatic = def({
  id: "md-kpop-fanatic",
  name: "Kpop Fanatic (modifiers fixture)",
  rarity: "Epic",
  cost: 1,
  base: {
    attack: 1,
    health: 1,
    keywords: [],
    text: "Cry: choose an enemy permanent; at the start of your next turn, steal it",
  },
  radiant: { attack: 2, health: 2, keywords: [{ kind: "Divine Shield" }], text: "Divine Shield; same" },
});

/** An end-of-turn trigger whose event (`drawn`) is nothing a delayed effect here also emits. */
const endOfTurnDrawer = def({
  id: "md-end-drawer",
  name: "End-of-turn Drawer (modifiers fixture)",
  cost: 2,
  base: { attack: 1, health: 9, keywords: [], text: "End of turn: draw a card" },
  radiant: { attack: 2, health: 18, keywords: [], text: "same" },
});

/** A printed 5 for R48: a costMod brings it down to 4, which is where Curvature reads it. */
const costFive = def({
  id: "md-cost-five",
  name: "Cost Five (modifiers fixture)",
  cost: 5,
  base: { attack: 5, health: 5, keywords: [], text: "5/5" },
  radiant: { attack: 10, health: 10, keywords: [], text: "10/10" },
});

/** A 2-mana Spell, for Lunar Eclipse's Spell-only discount. */
const cheapSpell = def({
  id: "md-cheap-spell",
  name: "Cheap Spell (modifiers fixture)",
  type: "Spell",
  cost: 2,
});

function both(script: Script): CardScripts {
  return { base: script, radiant: script };
}

const MOD_DEFS: CardDef[] = [delayedBolt, kpopFanatic, endOfTurnDrawer, costFive, cheapSpell];

const MOD_SCRIPTS: Record<string, CardScripts> = {
  [delayedBolt.id]: both({
    activate: (ctx) => [damage({ to: { of: "enemyHero" }, amount: Number(ctx.data.amount ?? 0) })],
  }),
  [kpopFanatic.id]: both({
    activate: (ctx) => [steal({ instanceId: String(ctx.data.target ?? "") })],
  }),
  [endOfTurnDrawer.id]: both({ endOfTurn: () => [draw({ count: 1 })] }),
};

let nonce = 0;
function act(state: GameState, body: ActionInput): GameState {
  nonce += 1;
  const result = reduce(state, { ...body, nonce: `md${nonce}` } as Action);
  if (result.error !== undefined) throw new Error(result.error);
  return result.state;
}

function endTurn(state: GameState): ReturnType<typeof reduce> {
  nonce += 1;
  const result = reduce(state, { type: "endTurn", playerId: state.active, nonce: `md${nonce}` } as Action);
  if (result.error !== undefined) throw new Error(result.error);
  return result;
}

function endTurns(state: GameState, count: number): GameState {
  let next = state;
  for (let i = 0; i < count; i += 1) next = endTurn(next).state;
  return next;
}

/** Past the mulligans, in p1's main phase of turn 1, with the local defs folded in. */
function playing(seed: string): GameState {
  const fresh = newGame(seed);
  registerCatalog({ ...registeredCatalog(), ...Object.fromEntries(MOD_DEFS.map((d) => [d.id, d])) });
  registerScripts({ ...registeredScripts(), ...MOD_SCRIPTS });
  let state = beginGame(fresh).state;
  state = act(state, { type: "mulligan", keep: state.players.p1.hand.map((c) => c.id), playerId: "p1" });
  state = act(state, { type: "mulligan", keep: state.players.p2.hand.map((c) => c.id), playerId: "p2" });
  return state;
}

function handCard(state: GameState, id: string): CardInstance {
  const card = state.players.p1.hand.find((c) => c.id === id);
  if (card === undefined) throw new Error(`no ${id} in p1's hand`);
  return card;
}

function modOf(state: GameState, id: string): PlayerModifier {
  const mod = state.players.p1.mods.find((m) => m.id === id);
  if (mod === undefined) throw new Error(`no modifier ${id} on p1`);
  return mod;
}

/** One card in hand, as a value rather than a possibly-undefined index (`noUncheckedIndexedAccess`). */
function one(cards: CardInstance[]): CardInstance {
  const card = cards[0];
  if (card === undefined) throw new Error("expected a card");
  return card;
}

/** The serializable continuation a delayed effect carries (§10.1, §10.6). */
function resume(defId: string, instanceId: string, data: Record<string, unknown>): Resume {
  return { defId, hook: "activate", step: "start", radiant: false, instanceId, data };
}

describe("player modifiers and their three expiries (§2.2, §10.1)", () => {
  it("§2.2 a thisTurn modifier is live through its own turn and gone at that turn's cleanup", () => {
    const state = playing("this-turn");
    const four = one(inHand(state, indestructible.id, "p1"));
    const sink = sinkFor(state);

    const mod = addModifier(sink, "p1", {
      kind: "costDiscount",
      amount: 1,
      expiry: { until: "thisTurn", turn: state.turn },
    });
    expect(effectiveCost(state, four)).toBe(3);
    expect(modifierIsLive(state, mod)).toBe(true);

    // A stamp naming another turn is not this turn's business: cleanup leaves it alone.
    const later = addModifier(sink, "p1", {
      kind: "costDiscount",
      amount: 1,
      expiry: { until: "thisTurn", turn: state.turn + 1 },
    });
    expireModifiers(sink, "p1");
    expect(state.players.p1.mods.map((m) => m.id)).toEqual([later.id]);
    expect(effectiveCost(state, four)).toBe(3);

    // And on the turn it names, it goes.
    state.turn += 1;
    expireModifiers(sink, "p1");
    expect(state.players.p1.mods).toEqual([]);
    expect(effectiveCost(state, four)).toBe(4);
    expect(eventsOfType(sink.events, "modifierChanged").map((e) => e.added)).toEqual([
      true,
      true,
      false,
      false,
    ]);
  });

  it("R48 a nextTurnOf modifier does nothing on the turn it was made and applies on that player's next turn", () => {
    let state = playing("curvature-timing");
    const four = one(inHand(state, indestructible.id, "p1"));

    // #77 Professor Curvature's Cry: "during your next turn, cards whose cost is 4 cost 1 less".
    const mod = addModifier(sinkFor(state), "p1", {
      kind: "costDiscount",
      amount: 1,
      onlyCurrentCost: 4,
      expiry: { until: "nextTurnOf", player: "p1", fromTurn: state.turn },
    });

    // Inert on the turn it was made: the card still costs its printed 4 (R48).
    expect(state.turn).toBe(1);
    expect(modifierIsLive(state, mod)).toBe(false);
    expect(effectiveCost(state, four)).toBe(4);

    // Live once p1's next turn has begun.
    state = endTurns(state, 2);
    expect(state.turn).toBe(3);
    expect(state.active).toBe("p1");
    expect(modifierIsLive(state, modOf(state, mod.id))).toBe(true);
    expect(effectiveCost(state, handCard(state, four.id))).toBe(3);
  });

  it("R48 a nextTurnOf modifier is not live during the opponent's turn in between", () => {
    let state = playing("curvature-between");
    const four = one(inHand(state, indestructible.id, "p1"));
    const mod = addModifier(sinkFor(state), "p1", {
      kind: "costDiscount",
      amount: 1,
      onlyCurrentCost: 4,
      expiry: { until: "nextTurnOf", player: "p1", fromTurn: state.turn },
    });

    state = endTurns(state, 1);
    expect(state.active).toBe("p2");
    expect(state.turn).toBe(2);

    // DISCREPANCY: src/mana.ts does A; SPEC §8 #77 and R48 say B.
    //   A: `modifierIsLive` is `state.turn > mod.expiry.fromTurn`, which is already true on the
    //      opponent's intervening turn, so p1's discount reads live on turns 2 and 3 alike —
    //      `expireModifiers` only ends it at the cleanup of p1's own next turn.
    //   B: #77's text is "during your next turn", and BUILD M3-T5's acceptance is "applies only on
    //      the next turn"; turn 2 is p2's turn, not p1's next turn, so the modifier owes nothing
    //      there. It is observable through §10.8's `viewFor`, which shows p1 their hand's costs
    //      while the opponent is playing.
    expect(modifierIsLive(state, modOf(state, mod.id))).toBe(false);
    expect(effectiveCost(state, handCard(state, four.id))).toBe(4);
  });

  it("R48 Professor Curvature reads the cost as it currently stands, not the printed one", () => {
    const state = playing("curvature-current");
    const sink = sinkFor(state);
    // `fromTurn` one turn back, so the modifier is already live (R48 is the test above).
    addModifier(sink, "p1", {
      kind: "costDiscount",
      amount: 1,
      onlyCurrentCost: 4,
      expiry: { until: "nextTurnOf", player: "p1", fromTurn: state.turn - 1 },
    });

    // A printed 4 is discounted, and so is a printed 5 that a costMod has brought down to 4.
    const four = one(inHand(state, indestructible.id, "p1"));
    const fiveModded = one(inHand(state, costFive.id, "p1"));
    const fivePlain = one(inHand(state, costFive.id, "p1"));
    const three = one(inHand(state, trampler.id, "p1"));
    fiveModded.costMod = -1;
    expect(effectiveCost(state, four)).toBe(3);
    expect(effectiveCost(state, fiveModded)).toBe(3);
    // Neither a printed 5 nor a printed 3 currently stands at 4.
    expect(effectiveCost(state, fivePlain)).toBe(5);
    expect(effectiveCost(state, three)).toBe(3);

    // R65's order: other discounts first, then Curvature against the result. A second −1 moves
    // every card's current cost, so which card Curvature reaches moves with it.
    addModifier(sink, "p1", {
      kind: "costDiscount",
      amount: 1,
      expiry: { until: "thisTurn", turn: state.turn },
    });
    // 4 − 1 = 3, no longer 4: Curvature stops applying, and the card still pays 3.
    expect(effectiveCost(state, four)).toBe(3);
    // 5 − 1 = 4: Curvature now applies to the card it did not touch a moment ago.
    expect(effectiveCost(state, fivePlain)).toBe(3);
    // 5 − 1 (costMod) − 1 = 3: past 4 in the other direction, so Curvature is out again.
    expect(effectiveCost(state, fiveModded)).toBe(3);
    expect(effectiveCost(state, three)).toBe(2);
  });

  it("R48 a nextTurnOf modifier expires at the cleanup of that player's next turn, and not at the other player's", () => {
    const state = playing("next-turn-expiry");
    const sink = sinkFor(state);
    const mod = addModifier(sink, "p1", {
      kind: "costDiscount",
      amount: 1,
      onlyCurrentCost: 4,
      expiry: { until: "nextTurnOf", player: "p1", fromTurn: state.turn },
    });

    // The cleanup of the turn it was made keeps it: its own turn has not happened yet (R48).
    expireModifiers(sink, "p1");
    expect(state.players.p1.mods.map((m) => m.id)).toEqual([mod.id]);

    // The opponent's cleanup never ends a modifier keyed to p1's turn.
    state.turn += 1;
    expireModifiers(sink, "p2");
    expect(state.players.p1.mods.map((m) => m.id)).toEqual([mod.id]);

    // p1's next turn: live during it, and gone at its cleanup.
    state.turn += 1;
    expect(modifierIsLive(state, modOf(state, mod.id))).toBe(true);
    expireModifiers(sink, "p1");
    expect(state.players.p1.mods).toEqual([]);
    expect(eventsOfType(sink.events, "modifierChanged").filter((e) => !e.added)).toHaveLength(1);
  });

  it("R30 an untilUsed modifier survives cleanup and goes only when it is consumed", () => {
    const state = playing("until-used");
    const sink = sinkFor(state);
    const echo = addModifier(sink, "p1", { kind: "echoNextSpell", amount: 1, expiry: { until: "used" } });

    // §2.2 cleanup expires "this turn" effects; R30's pending Echo is not turn-scoped, so no
    // number of cleanups on either side reaches it.
    expireModifiers(sink, "p1");
    state.turn += 2;
    expireModifiers(sink, "p1");
    expireModifiers(sink, "p2");
    expect(state.players.p1.mods.map((m) => m.id)).toEqual([echo.id]);

    // It goes the moment it applies.
    consumeModifier(sink, "p1", echo.id);
    expect(state.players.p1.mods).toEqual([]);
    expect(eventsOfType(sink.events, "modifierChanged").at(-1)).toMatchObject({
      modifierId: echo.id,
      added: false,
    });

    // Consuming it twice is not a second event: nothing was there to remove.
    removeModifier(sink, "p1", echo.id);
    expect(eventsOfType(sink.events, "modifierChanged").filter((e) => !e.added)).toHaveLength(1);
  });

  it("#35 Lunar Eclipse's discount applies to the next spell only and expires at cleanup", () => {
    const state = playing("lunar-eclipse");
    const spells = inHand(state, cheapSpell.id, "p1", 2);
    const first = one(spells);
    const second = spells[1];
    expect(second).toBeDefined();
    if (second === undefined) return;
    const unit = one(inHand(state, trampler.id, "p1"));
    const sink = sinkFor(state);

    const discount = addModifier(sink, "p1", {
      kind: "costDiscount",
      amount: 1,
      onlyType: "Spell",
      expiry: { until: "thisTurn", turn: state.turn },
    });

    // "The next Spell you play this turn costs 1 less": a Unit pays full (§8 #35).
    expect(effectiveCost(state, first)).toBe(1);
    expect(effectiveCost(state, unit)).toBe(3);

    // Consumed on use, so the Spell after it pays full: the next Spell *only*.
    consumeModifier(sink, "p1", discount.id);
    expect(effectiveCost(state, second)).toBe(2);

    // Unused, it expires at cleanup instead (§2.2 names it there by name).
    addModifier(sink, "p1", {
      kind: "costDiscount",
      amount: 1,
      onlyType: "Spell",
      expiry: { until: "thisTurn", turn: state.turn },
    });
    expect(effectiveCost(state, second)).toBe(1);
    expireModifiers(sink, "p1");
    expect(state.players.p1.mods).toEqual([]);
    expect(effectiveCost(state, second)).toBe(2);
  });
});

describe("delayed effects (§10.1, R62, R68)", () => {
  it("§10.1 dueDelayed hands back only the effects due for that phase and player, in creation order", () => {
    const state = playing("due-delayed");
    const bolt = put(state, delayedBolt.id, slot("p1", "units", 1));
    const sink = sinkFor(state);

    const startA = scheduleDelayed(sink, "p1", { phase: "start", player: "p1" }, resume(delayedBolt.id, bolt.id, {}));
    const endB = scheduleDelayed(sink, "p1", { phase: "end", player: "p1" }, resume(delayedBolt.id, bolt.id, {}));
    const startC = scheduleDelayed(sink, "p2", { phase: "start", player: "p2" }, resume(delayedBolt.id, bolt.id, {}));
    const startD = scheduleDelayed(sink, "p1", { phase: "start", player: "p1" }, resume(delayedBolt.id, bolt.id, {}));

    // R68 is "the order they were created", not the order the array happens to hold them in.
    expect(startA.seq).toBeLessThan(startD.seq);
    state.delayed.reverse();

    expect(dueDelayed(state, "start", "p1").map((e) => e.id)).toEqual([startA.id, startD.id]);
    expect(dueDelayed(state, "end", "p1").map((e) => e.id)).toEqual([endB.id]);
    expect(dueDelayed(state, "start", "p2").map((e) => e.id)).toEqual([startC.id]);
    expect(dueDelayed(state, "end", "p2")).toEqual([]);

    dropDelayed(state, startA.id);
    expect(dueDelayed(state, "start", "p1").map((e) => e.id)).toEqual([startD.id]);
  });

  it("R62 start-of-turn delayed effects resolve before the start-of-turn triggers and the draw, in creation order", () => {
    let state = playing("delayed-start");
    const bolt = put(state, delayedBolt.id, slot("p1", "units", 1));
    const sink = sinkFor(state);
    scheduleDelayed(sink, "p1", { phase: "start", player: "p1" }, resume(delayedBolt.id, bolt.id, { amount: 1 }));
    scheduleDelayed(sink, "p1", { phase: "start", player: "p1" }, resume(delayedBolt.id, bolt.id, { amount: 4 }));
    state.delayed.reverse();

    state = endTurns(state, 1);
    const toP1 = endTurn(state);
    state = toP1.state;
    expect(state.turn).toBe(3);
    expect(state.active).toBe("p1");

    // Creation order, whatever order `state.delayed` held them in (R68).
    expect(eventsOfType(toP1.events, "damage").map((e) => e.amount)).toEqual([1, 4]);
    expect(state.players.p2.hero.health).toBe(25);

    // R62: "Refresh → start-of-turn delayed effects → start-of-turn triggers → draw".
    const types = toP1.events.map((e) => e.type);
    const firstDamage = types.indexOf("damage");
    expect(types.indexOf("turnStarted")).toBeLessThan(firstDamage);
    expect(types.indexOf("drawn")).toBeGreaterThan(types.lastIndexOf("damage"));

    // Each one resolves once: the queue is drained, not re-read.
    expect(state.delayed).toEqual([]);
  });

  it("R62 end-of-turn delayed effects resolve after the end-of-turn triggers and before cleanup, in creation order", () => {
    const state = playing("delayed-end");
    put(state, endOfTurnDrawer.id, slot("p1", "units", 1));
    const bolt = put(state, delayedBolt.id, slot("p1", "units", 2));
    const sink = sinkFor(state);
    scheduleDelayed(sink, "p1", { phase: "end", player: "p1" }, resume(delayedBolt.id, bolt.id, { amount: 2 }));
    scheduleDelayed(sink, "p1", { phase: "end", player: "p1" }, resume(delayedBolt.id, bolt.id, { amount: 5 }));
    state.delayed.reverse();

    const ended = endTurn(state);
    expect(eventsOfType(ended.events, "damage").map((e) => e.amount)).toEqual([2, 5]);
    expect(ended.state.players.p2.hero.health).toBe(23);

    // R62: "end-of-turn triggers → the end-of-turn trap window → end-of-turn delayed effects →
    // cleanup". `turnEnded` is no longer the cleanup marker: `turn.ts` emits it *before* the trap
    // window, because a trap in that window reads the event (#18 Bread and Butter answers
    // `event.unspentMana`, which only exists while the turn log is still open). So the window's
    // own boundary is read off `turnEnded` and cleanup's off `turnStarted`, the first event the
    // next turn pushes after cleanup has run.
    const types = ended.events.map((e) => e.type);
    const firstDamage = types.indexOf("damage");
    expect(types.indexOf("drawn")).toBeLessThan(firstDamage);
    expect(types.indexOf("turnEnded")).toBeLessThan(firstDamage);
    expect(types.indexOf("turnStarted")).toBeGreaterThan(types.lastIndexOf("damage"));
    expect(ended.state.delayed).toEqual([]);
  });

  it("§8 #50 Kpop Fanatic's steal fires at the next start of turn after the unit has died (R76)", () => {
    let state = playing("kpop-fanatic");
    const kpop = put(state, kpopFanatic.id, slot("p1", "units", 1));
    const prize = put(state, plain.id, slot("p2", "units", 1));

    // The Cry's half: a delayed effect keyed to the chosen instance, due at p1's next turn start.
    const sink = sinkFor(state);
    scheduleDelayed(
      sink,
      "p1",
      { phase: "start", player: "p1" },
      resume(kpopFanatic.id, kpop.id, { target: prize.id }),
    );

    // Kpop Fanatic dies well before its own effect is due.
    kpop.damage = 5;
    stateCheck(sink);
    expect(state.players.p1.units[0]).toBeNull();
    expect(state.players.p1.graveyard.map((c) => c.id)).toContain(kpop.id);

    // R76: it fires at p1's next start of turn all the same.
    state = endTurns(state, 2);
    expect(state.turn).toBe(3);
    const stolen = state.players.p1.units[0]?.[0];
    expect(stolen?.id).toBe(prize.id);
    // R12: control moved and ownership did not.
    expect(stolen?.controller).toBe("p1");
    expect(stolen?.owner).toBe("p2");
    expect(state.players.p2.units[0]).toBeNull();
    expect(state.delayed).toEqual([]);
  });

  it("§8 #24 Efficiency Dividend's mana is a mana.nextTurnMod, not a delayed effect", () => {
    let state = playing("efficiency-dividend");
    const sink = sinkFor(state);
    const ctx = makeContext(sink, null, { controller: "p1" });

    // "gain floor(X/2) mana next turn" with X = 5 (§8 #24).
    applyEffects([nextTurnMana({ amount: 2 })], ctx);

    // The shape: a number on the player's mana. Nothing was queued and no modifier was created.
    expect(state.players.p1.mana.nextTurnMod).toBe(2);
    expect(state.delayed).toEqual([]);
    expect(dueDelayed(state, "start", "p1")).toEqual([]);
    expect(dueDelayed(state, "end", "p1")).toEqual([]);
    expect(state.players.p1.mods).toEqual([]);

    // §2.3: the refresh reads it once, into that turn's max, and clears it.
    state = endTurns(state, 2);
    expect(state.players.p1.turnsStarted).toBe(2);
    expect(state.players.p1.mana).toMatchObject({ max: 4, current: 4, nextTurnMod: 0 });

    // And it is one-shot: the turn after is the ordinary refresh again.
    state = endTurns(state, 2);
    expect(state.players.p1.turnsStarted).toBe(3);
    expect(state.players.p1.mana).toMatchObject({ max: 3, current: 3, nextTurnMod: 0 });
  });

  it("§10.1 a delayed effect whose instance has ceased to exist is dropped rather than throwing", () => {
    let state = playing("delayed-missing");
    const sink = sinkFor(state);
    const ghost = newInstance(state, delayedBolt.id, "p1", { z: "gone", player: "p1" });
    scheduleDelayed(sink, "p1", { phase: "start", player: "p1" }, resume(delayedBolt.id, ghost.id, { amount: 3 }));

    state = endTurns(state, 2);
    expect(state.turn).toBe(3);
    expect(state.players.p2.hero.health).toBe(30);
    expect(state.delayed).toEqual([]);
  });
});
