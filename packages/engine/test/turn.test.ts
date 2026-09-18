import type { Action, ActionInput, CardDef, GameEvent } from "@jackioh/shared";
import { describe, expect, it } from "vitest";
import { MAX_MANA } from "../src/config";
import { registerCatalog, registeredCatalog } from "../src/catalog";
import { addModifier, scheduleDelayed } from "../src/modifiers";
import { RESUME_HOOK, openPrompt, resumeSelf } from "../src/prompts";
import { beginGame, legalActions, reduce } from "../src/reduce";
import type { CardScripts, Effect, Script } from "../src/script";
import { registerScripts, registeredScripts } from "../src/scripts";
import { newInstance, type CardInstance, type GameState, type Resume } from "../src/state";
import { END_OF_TURN_WORK } from "../src/turn";
import { canResume, owedWork } from "../src/work";
import { draw as drawCards } from "../src/draw";
import { eventsOfType, newGame, put, setLibrary, sinkFor, slot } from "./fixtures/harness";
import { gravedigger, hinder, manaWell, shredder, xBolt } from "./fixtures/scripts";
import { vanillaDeck } from "./fixtures/catalog";
import { DECK_SIZE } from "../src/config";

let nonce = 0;
function act(state: GameState, body: ActionInput): GameState {
  nonce += 1;
  const result = reduce(state, { ...body, nonce: `t${nonce}` } as Action);
  if (result.error !== undefined) throw new Error(result.error);
  return result.state;
}

/** Past the mulligans, in the main phase of turn 1. */
function playing(seed = "turn", decks?: [string[], string[]]): GameState {
  let state = beginGame(newGame(seed, decks)).state;
  state = act(state, { type: "mulligan", keep: state.players.p1.hand.map((c) => c.id), playerId: "p1" });
  state = act(state, { type: "mulligan", keep: state.players.p2.hand.map((c) => c.id), playerId: "p2" });
  return state;
}

function endTurns(state: GameState, count: number): GameState {
  let next = state;
  for (let i = 0; i < count; i += 1) next = act(next, { type: "endTurn", playerId: next.active });
  return next;
}

describe("turn loop and mana (M1-T6)", () => {
  it("refreshes 1 mana on turn 1, 4 by the fourth turn and stays at 4", () => {
    let state = playing();
    expect(state.players.p1.mana).toMatchObject({ current: 1, max: 1 });

    state = endTurns(state, 6); // p1's fourth turn
    expect(state.active).toBe("p1");
    expect(state.players.p1.turnsStarted).toBe(4);
    expect(state.players.p1.mana.max).toBe(MAX_MANA);

    state = endTurns(state, 12); // p1's tenth turn
    expect(state.players.p1.turnsStarted).toBe(10);
    expect(state.players.p1.mana.max).toBe(MAX_MANA);
  });

  it("Mana Well adds temporary mana above the refresh (#6)", () => {
    let state = playing("mana-well");
    put(state, manaWell.id, slot("p1", "backrow", 1));
    state = endTurns(state, 6);
    expect(state.players.p1.mana.max).toBe(4);
    expect(state.players.p1.mana.current).toBe(5);
  });

  it("Hinder's modifier lowers the next refresh and mana never goes below 0", () => {
    let state = playing("hinder-mana");
    state = endTurns(state, 1); // p2's first turn
    state.players.p2.mana.nextTurnMod = -1;
    state = endTurns(state, 2); // back to p2, now their second turn
    expect(state.players.p2.turnsStarted).toBe(2);
    expect(state.players.p2.mana.max).toBe(1);

    state.players.p2.mana.nextTurnMod = -5;
    state = endTurns(state, 2);
    expect(state.players.p2.mana.max).toBe(0);
    expect(state.players.p2.mana.current).toBe(0);
  });

  it("clears a this-turn modifier at cleanup and keeps a pending Echo (R30)", () => {
    let state = playing("mods");
    const sink = sinkFor(state);
    addModifier(sink, "p1", { kind: "costDiscount", amount: 1, expiry: { until: "thisTurn", turn: state.turn } });
    addModifier(sink, "p1", { kind: "echoNextSpell", amount: 1, expiry: { until: "used" } });
    expect(state.players.p1.mods).toHaveLength(2);

    state = endTurns(state, 1);
    expect(state.players.p1.mods.map((m) => m.kind)).toEqual(["echoNextSpell"]);
  });

  it("fires start-of-turn triggers before the draw (#37 Gravedigger)", () => {
    let state = playing("gravedigger");
    put(state, gravedigger.id, slot("p1", "units", 1));
    const buried = newInstance(state, "fx-9", "p1", { z: "graveyard", player: "p1" });
    state.players.p1.graveyard.push(buried);
    state.players.p1.hand = [];

    state = endTurns(state, 2); // p1's next turn: trigger, then draw
    const hand = state.players.p1.hand.map((c) => c.id);
    expect(hand[0]).toBe(buried.id);
    expect(hand).toHaveLength(2);
    expect(state.players.p1.graveyard.some((c) => c.id === buried.id)).toBe(false);
  });

  it("refuses an X above current mana and allows X = 0", () => {
    const deck = [xBolt.id, ...vanillaDeck(DECK_SIZE - 1, 1)];
    let state = playing("x-cost", [deck, vanillaDeck(DECK_SIZE, 21)]);
    const bolt = newInstance(state, xBolt.id, "p1", { z: "hand", player: "p1" });
    state.players.p1.hand.push(bolt);

    const tooBig = reduce(state, { type: "play", instanceId: bolt.id, x: 5, playerId: "p1", nonce: "x-big" });
    expect(tooBig.error).toMatch(/X is above your current mana/);

    const zero = reduce(state, { type: "play", instanceId: bolt.id, x: 0, playerId: "p1", nonce: "x-zero" });
    expect(zero.error).toBeUndefined();
    expect(zero.state.players.p2.hero.health).toBe(30);
    expect(eventsOfType(zero.events, "cardPlayed")[0]?.costPaid).toBe(0);

    state = playing("x-cost-2", [deck, vanillaDeck(DECK_SIZE, 21)]);
    const bolt2 = newInstance(state, xBolt.id, "p1", { z: "hand", player: "p1" });
    state.players.p1.hand.push(bolt2);
    const one = reduce(state, { type: "play", instanceId: bolt2.id, x: 1, playerId: "p1", nonce: "x-one" });
    expect(one.error).toBeUndefined();
    expect(one.state.players.p2.hero.health).toBe(29);
    expect(one.state.players.p1.mana.current).toBe(0);
  });

  it("R62 runs a turn in order: refresh, start triggers, draw, then end of turn", () => {
    let state = playing("r62");
    put(state, gravedigger.id, slot("p1", "units", 1));
    const buried = newInstance(state, "fx-9", "p1", { z: "graveyard", player: "p1" });
    state.players.p1.graveyard.push(buried);

    state = act(state, { type: "endTurn", playerId: "p1" });
    nonce += 1;
    const result = reduce(state, { type: "endTurn", playerId: "p2", nonce: `r62-${nonce}` });
    const order = result.events
      .map((e) => e.type)
      .filter((type) =>
        ["turnEnded", "turnStarted", "manaChanged", "addedToHand", "drawn"].includes(type),
      );

    // p2's turn ends, then p1's begins: mana, the start-of-turn trigger, then the draw.
    expect(order[0]).toBe("turnEnded");
    expect(order[1]).toBe("turnStarted");
    expect(order[2]).toBe("manaChanged");
    expect(order.indexOf("addedToHand")).toBeLessThan(order.indexOf("drawn"));
  });

  it("R48 keeps a next-turn modifier through its own turn and drops it after the next one", () => {
    let state = playing("next-turn-expiry");
    const sink = sinkFor(state);
    addModifier(sink, "p1", {
      kind: "costDiscount",
      amount: 1,
      onlyCurrentCost: 4,
      expiry: { until: "nextTurnOf", player: "p1", fromTurn: state.turn },
    });

    state = endTurns(state, 1); // p1's turn ended: it must survive cleanup
    expect(state.players.p1.mods).toHaveLength(1);

    state = endTurns(state, 2); // p1's next turn came and went
    expect(state.players.p1.mods).toHaveLength(0);
  });

  it("fires a start-of-turn trigger on its controller's turn only (§6.2)", () => {
    let state = playing("own-turn-only");
    put(state, gravedigger.id, slot("p1", "units", 1));
    const buried = newInstance(state, "fx-9", "p1", { z: "graveyard", player: "p1" });
    state.players.p1.graveyard.push(buried);

    state = act(state, { type: "endTurn", playerId: "p1" }); // p2's turn starts
    expect(state.players.p1.graveyard.map((c) => c.id)).toEqual([buried.id]);

    state = act(state, { type: "endTurn", playerId: "p2" }); // now p1's turn
    expect(state.players.p1.graveyard).toHaveLength(0);
  });

  it("R68 resolves two end-of-turn triggers on one side in lane order", () => {
    const state = playing("r68");
    const first = put(state, shredder.id, slot("p1", "units", 1));
    const second = put(state, shredder.id, slot("p1", "units", 3));

    nonce += 1;
    const result = reduce(state, { type: "endTurn", playerId: "p1", nonce: `r68-${nonce}` });
    const sources = eventsOfType(result.events, "damage").map((e) => e.sourceId);

    expect(sources[0]).toBe(first.id);
    expect(sources[sources.length - 1]).toBe(second.id);
    expect(new Set(sources)).toEqual(new Set([first.id, second.id]));
  });

  it("R70 a cast counts as a play and pays nothing", () => {
    const state = playing("r70");
    const before = state.players.p1.turnLog.cardsPlayed;
    setLibrary(state, "p1", [hinder.id, "fx-2"]);
    const events: GameEvent[] = [];
    drawCards(sinkFor(state, events), "p1", 1);

    expect(state.players.p1.turnLog.cardsPlayed).toBe(before + 1);
    expect(state.players.p1.turnLog.playedIds).toHaveLength(before + 1);
    expect(state.counters.played).toBe(1);
    const played = eventsOfType(events, "cardPlayed");
    expect(played).toHaveLength(1);
    expect(played[0]?.costPaid).toBe(0);
  });

  it("resets exertion at the controller's next turn (§4.1)", () => {
    let state = playing("exertion");
    const unit = put(state, "fx-1", slot("p1", "units", 1));
    state = act(state, { type: "switchPosition", instanceId: unit.id, playerId: "p1" });
    expect(state.players.p1.units[0]?.[0]?.exertion.switched).toBe(true);
    expect(legalActions(state, "p1").some((a) => a.type === "switchPosition")).toBe(false);

    state = endTurns(state, 2);
    expect(state.players.p1.units[0]?.[0]?.exertion.switched).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The end of a turn as a resumable sequence, and the two shapes a delayed continuation takes
// (§2.2, §9.3, §10.6; R62, R113, R117, R122, R126, R127).
//
// Fixtures are this file's own: defs are prefixed `tn-` and indexed from 2400, so they cannot
// collide with another test file's catalog (BUILD §0).
// ---------------------------------------------------------------------------

let nextIndex = 2400;

function fixtureDef(name: string, type: CardDef["type"]): CardDef {
  nextIndex += 1;
  return {
    id: `tn-${name}`,
    index: String(nextIndex),
    name: `${name} (turn)`,
    set: "Core",
    type,
    tags: [],
    rarity: "Common",
    token: false,
    cost: 0,
    base: { keywords: [], text: name },
    radiant: { keywords: [], text: name },
  };
}

/** The note sink: a Field Spell in p1's backrow lane 5 whose memory records the order things ran. */
const logCard = fixtureDef("log", "Field Spell");
/** R126: its continuation sits in the `resume` step table, the shape `runHook` could not reach. */
const tableCard = fixtureDef("table", "Field Spell");
/** R127: its continuation is a `delayed` hook and it records whether it got a `ctx.self`. */
const selfCard = fixtureDef("self", "Field Spell");
/** A delayed effect that asks its controller something, so the end of turn pauses inside it. */
const askCard = fixtureDef("ask", "Field Spell");
/** An end-of-turn *trigger* that asks, so the end of turn pauses before the `turnEnded` event. */
const askHookCard = fixtureDef("askhook", "Field Spell");
/** The end-of-turn trigger behind it in R68's backrow order, which the pause must not skip. */
const secondHookCard = fixtureDef("secondhook", "Field Spell");

const TURN_DEFS = [logCard, tableCard, selfCard, askCard, askHookCard, secondHookCard];

const NOTE_LANE = 5;
/** The step the two table-shaped continuations below name (§10.6: script id + step + data). */
const STEP = "bolt";

function logOf(state: GameState): CardInstance | null {
  return state.players.p1.backrow[NOTE_LANE - 1] ?? null;
}

function note(name: string): Effect {
  return {
    kind: "tn:note",
    apply(ctx): void {
      const log = logOf(ctx.state);
      if (log === null) return;
      const steps = Array.isArray(log.memory.steps) ? (log.memory.steps as string[]) : [];
      log.memory.steps = [...steps, name];
    },
  };
}

function notes(state: GameState): string[] {
  const log = logOf(state);
  return Array.isArray(log?.memory.steps) ? (log.memory.steps as string[]) : [];
}

/** §10.6: a prompt for the delayed effect's own controller, with one answer, so answering is trivial. */
function askController(): Effect {
  return {
    kind: "tn:ask",
    apply(ctx): void {
      openPrompt(ctx, {
        player: ctx.controller,
        kind: "target",
        prompt: "the delayed effect asks its owner",
        options: [{ key: "none", label: "nothing", selection: { pick: "none" } }],
        resume: resumeSelf(ctx, "asked"),
      });
    },
  };
}

function both(script: Script): CardScripts {
  return { base: script, radiant: script };
}

const TURN_SCRIPTS: Record<string, CardScripts> = {
  [tableCard.id]: both({ resume: { [STEP]: (ctx) => [note(`table:${String(ctx.data.amount)}`)] } }),
  [selfCard.id]: both({ delayed: (ctx) => [note(ctx.self === null ? "noSelf" : "self")] }),
  [askCard.id]: both({
    delayed: () => [note("ask1"), askController()],
    resume: { asked: () => [note("answered")] },
  }),
  [askHookCard.id]: both({
    endOfTurn: () => [note("trigger1"), askController()],
    resume: { asked: () => [note("answered")] },
  }),
  [secondHookCard.id]: both({ endOfTurn: () => [note("trigger2")] }),
};

/** Past the mulligans, in p1's main phase, with the note log parked in p1's backrow lane 5. */
function turnGame(seed: string): GameState {
  const fresh = newGame(seed);
  registerCatalog({ ...registeredCatalog(), ...Object.fromEntries(TURN_DEFS.map((d) => [d.id, d])) });
  registerScripts({ ...registeredScripts(), ...TURN_SCRIPTS });
  let state = beginGame(fresh).state;
  state = act(state, { type: "mulligan", keep: state.players.p1.hand.map((c) => c.id), playerId: "p1" });
  state = act(state, { type: "mulligan", keep: state.players.p2.hand.map((c) => c.id), playerId: "p2" });
  put(state, logCard.id, slot("p1", "backrow", NOTE_LANE));
  return state;
}

/** Schedule one end-of-turn delayed effect for p1, the way `effects/delay.ts` stores one. */
function delayAtEndOfP1(state: GameState, resume: Resume): string {
  return scheduleDelayed(sinkFor(state), "p1", { phase: "end", player: "p1" }, resume).id;
}

function actResult(state: GameState, body: ActionInput): ReturnType<typeof reduce> {
  nonce += 1;
  return reduce(state, { ...body, nonce: `t${nonce}` } as Action);
}

function answerResult(state: GameState): ReturnType<typeof reduce> {
  const pending = state.pending;
  if (pending === null) throw new Error("expected a prompt to be open");
  return actResult(state, {
    type: "answer",
    choiceId: pending.id,
    selection: [{ pick: "none" }],
    playerId: pending.playerId,
  });
}

function answerOpenPrompt(state: GameState): GameState {
  const result = answerResult(state);
  if (result.error !== undefined) throw new Error(result.error);
  return result.state;
}

function only<T>(items: readonly T[]): T {
  const first = items[0];
  if (first === undefined) throw new Error("expected at least one item");
  return first;
}

describe("delayed continuations and the end of turn (§2.2, §10.6, R62, R113, R117, R126, R127)", () => {
  it("R126 re-enters a delayed continuation that lives in the resume step table, not only a delayed hook", () => {
    const state = turnGame("r126-step-table");
    const scheduler = put(state, tableCard.id, slot("p1", "backrow", 1));
    // The shape `resolve.runHook` could not read: `hook` is the step table, `step` picks the entry.
    // It used to fetch `script.resume` — an object — and call it, which threw.
    delayAtEndOfP1(state, {
      defId: tableCard.id,
      hook: RESUME_HOOK,
      step: STEP,
      radiant: false,
      instanceId: scheduler.id,
      data: { amount: 4 },
    });

    const ended = act(state, { type: "endTurn", playerId: "p1" });

    expect(notes(ended)).toEqual(["table:4"]);
    // R62/§10.1: the entry is dropped once it has resolved, so it never fires twice.
    expect(ended.delayed).toEqual([]);
    // R117: nothing was owed, because nothing paused — the remainder is only parked at a pause.
    expect(ended.work).toEqual([]);
  });

  it("R127 resolves a delayed continuation whose instance is gone, with ctx.self null", () => {
    const state = turnGame("r127-no-instance");
    // Two entries R76 and §10.6 allow and the old reader dropped in silence: one that never had an
    // instance to name, and one whose instance has ceased to exist (#39 exiles itself, #50 dies).
    delayAtEndOfP1(state, {
      defId: selfCard.id,
      hook: "delayed",
      step: "",
      radiant: false,
      data: {},
    });
    delayAtEndOfP1(state, {
      defId: selfCard.id,
      hook: "delayed",
      step: "",
      radiant: false,
      instanceId: "tn-instance-that-never-was",
      data: {},
    });

    const ended = act(state, { type: "endTurn", playerId: "p1" });

    // Both resolved, both with `ctx.self === null`, and R113's "never dropped in silence" holds.
    expect(notes(ended)).toEqual(["noSelf", "noSelf"]);
    expect(ended.delayed).toEqual([]);
  });

  it("R113 parks the rest of the end of turn when a delayed effect prompts, and R122's answer finishes it", () => {
    const state = turnGame("r113-end-of-turn-remainder");
    const asking = put(state, askCard.id, slot("p1", "backrow", 1));
    const scheduler = put(state, tableCard.id, slot("p1", "backrow", 2));
    delayAtEndOfP1(state, {
      defId: askCard.id,
      hook: "delayed",
      step: "",
      radiant: false,
      instanceId: asking.id,
      data: {},
    });
    // R68's creation order: this one is due at the same point and waits for the first to finish.
    const second = delayAtEndOfP1(state, {
      defId: tableCard.id,
      hook: RESUME_HOOK,
      step: STEP,
      radiant: false,
      instanceId: scheduler.id,
      data: { amount: 2 },
    });

    const paused = act(state, { type: "endTurn", playerId: "p1" });

    expect(paused.pending?.playerId).toBe("p1");
    expect(notes(paused)).toEqual(["ask1"]);
    // Nothing R62 puts after the pause has happened: the next entry is still due, cleanup has not
    // closed p1's turn log, and p2's turn has not started under the open prompt.
    expect(paused.delayed.map((effect) => effect.id)).toEqual([second]);
    expect(paused.players.p1.turnLog.unspentAtEnd).toBeUndefined();
    expect(paused.active).toBe("p1");

    // R113: the rest of the end of turn is *owed*, as plain JSON, and `work.ts` knows the hook —
    // the handler is registered at module scope by `turn.ts`, not by this test.
    const parked = only(owedWork(paused, END_OF_TURN_WORK));
    expect(JSON.parse(JSON.stringify(parked))).toEqual(parked);
    expect(canResume(parked.resume)).toBe(true);

    // §10.1: the paused game survives a round trip and resumes from the round-tripped copy.
    const round = JSON.parse(JSON.stringify(paused)) as GameState;
    const answered = answerOpenPrompt(round);

    // R122: the action that answered finishes what the prompt interrupted — the answered step, the
    // delayed entry behind it, then cleanup and the next turn.
    expect(notes(answered)).toEqual(["ask1", "answered", "table:2"]);
    expect(answered.delayed).toEqual([]);
    expect(answered.players.p1.turnLog.unspentAtEnd).toBeDefined();
    expect(answered.work).toEqual([]);
    expect(answered.pending).toBeNull();
    expect(answered.active).toBe("p2");
  });

  it("R62 finishes the end-of-turn triggers before the turnEnded event when one of them prompts", () => {
    const state = turnGame("r62-trigger-pause");
    put(state, askHookCard.id, slot("p1", "backrow", 1));
    put(state, secondHookCard.id, slot("p1", "backrow", 2));
    const scheduler = put(state, tableCard.id, slot("p1", "backrow", 3));
    delayAtEndOfP1(state, {
      defId: tableCard.id,
      hook: RESUME_HOOK,
      step: STEP,
      radiant: false,
      instanceId: scheduler.id,
      data: { amount: 2 },
    });

    const ended = actResult(state, { type: "endTurn", playerId: "p1" });
    expect(ended.error).toBeUndefined();
    const paused = ended.state;

    // The first trigger asked, so nothing R62 puts after the trigger queue has run — the
    // `turnEnded` event of the window included, which #18 Bread and Butter reads (R100).
    expect(notes(paused)).toEqual(["trigger1"]);
    expect(eventsOfType(ended.events, "turnEnded")).toEqual([]);
    expect(paused.players.p1.turnLog.unspentAtEnd).toBeUndefined();
    expect(paused.active).toBe("p1");
    expect(owedWork(paused, END_OF_TURN_WORK)).toHaveLength(1);

    const resumed = answerResult(paused);
    expect(resumed.error).toBeUndefined();

    // R62's whole order across the pause: the queued triggers first, then the window's event, then
    // the delayed effects, then cleanup and the next turn — and the event is emitted exactly once.
    expect(notes(resumed.state)).toEqual(["trigger1", "answered", "trigger2", "table:2"]);
    expect(eventsOfType(resumed.events, "turnEnded").map((event) => event.player)).toEqual(["p1"]);
    expect(resumed.state.players.p1.turnLog.unspentAtEnd).toBeDefined();
    expect(resumed.state.delayed).toEqual([]);
    expect(resumed.state.work).toEqual([]);
    expect(resumed.state.active).toBe("p2");
  });
});
