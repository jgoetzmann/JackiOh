// The event registry, the trigger queue and the resolution loop of SPEC §10.3 (BUILD M3-T2).
//
// The §10.3 diagram is the subject: apply → emit → traps fire immediately → queue the other
// triggers in R68's order → state check → repeat. Each acceptance item of BUILD M3-T2 has one
// named test here:
//
//   * R68 — two end-of-turn triggers on one side resolve in lane order;
//   * §10.3 — a trap fires before a queued trigger, because a trap is a response;
//   * R62 — except in the end-of-turn trap window, the one scheduled exception, which comes after
//     the end-of-turn triggers;
//   * R59 — the state check never runs between two hits of one effect;
//   * §10.3 — a trap that prompts its owner during the opponent's turn pauses the loop, and the
//     opponent's action with it, until the prompt is answered;
//   * R1 — `CRY_ON_PLAY_ONLY` makes `summon` never fire Cry while `play` does, and R70's casts
//     (Cast on draw, a Call to Chaos cast) do fire it.
//
// The Echo third of that last acceptance line — "Cast on draw, Echo and Call to Chaos casts do fire
// it" — lives in `echo.test.ts` ("§6.3 Echo 1 re-resolves the played card once"), since the repeat
// queue is that file's whole subject and SPEC puts the repeats in `state.echoQueue`.
//
// Every fixture here is its own: defs are prefixed `tg-` and indexed above 1400, so they cannot
// collide with another test file's catalog (BUILD §0).

import type { Action, ActionInput, CardDef, PlayerId } from "@jackioh/shared";
import { describe, expect, it } from "vitest";
import { registerCatalog, registeredCatalog } from "../src/catalog";
import { CRY_ON_PLAY_ONLY } from "../src/config";
import { draw as drawEffect, summon } from "../src/effects";
import { openPrompt, resumeSelf } from "../src/prompts";
import { beginGame, reduce } from "../src/reduce";
import { applyEffects, castCard, makeContext } from "../src/resolve";
import type { CardScripts, Effect, Script } from "../src/script";
import { registerScripts, registeredScripts, scriptOf } from "../src/scripts";
import { stateCheck } from "../src/stateCheck";
import type { CardInstance, GameState } from "../src/state";
import { fireTrapsFor, isTrapWindowEvent, runTrapWindow } from "../src/traps";
import { cardsInTriggerOrder, settle } from "../src/triggers";
import { doubleEdge } from "./fixtures/scripts";
import { eventsOfType, inHand, newGame, put, setLibrary, sinkFor, slot } from "./fixtures/harness";

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

let nextIndex = 1400;

function def(name: string, type: CardDef["type"], extra: Partial<CardDef> = {}): CardDef {
  nextIndex += 1;
  return {
    id: `tg-${name}`,
    index: String(nextIndex),
    name: `${name} (triggers)`,
    set: "Core",
    type,
    tags: [],
    rarity: "Common",
    token: false,
    cost: 0,
    base: { keywords: [], text: name },
    radiant: { keywords: [], text: name },
    ...extra,
  };
}

function unit(name: string, attack = 2, health = 4, extra: Partial<CardDef> = {}): CardDef {
  return def(name, "Unit", {
    base: { attack, health, keywords: [], text: name },
    radiant: { attack: attack * 2, health: health * 2, keywords: [], text: name },
    ...extra,
  });
}

/** The note sink: a Field Spell parked in p1's backrow lane 5, whose memory records the order. */
const logCard = def("log", "Field Spell");
/** #13's shape: an end-of-turn hook that says which lane it fired from (R68). */
const closer = unit("closer");
/** An ordinary queued trigger answering a summon: not a trap, so it waits its turn (§10.3). */
const watcher = def("watcher", "Field Spell");
/** #41's shape: a Trap answering the same summon. A response, so it goes first (§10.3). */
const snapTrap = def("snap-trap", "Trap");
/** #18's shape: a Field Trap that answers the turn end, so it belongs to R62's window. */
const windowTrap = def("window-trap", "Field Trap");
/** A Trap whose answer is a prompt for its own controller (§10.3's "prompts for the trap's owner"). */
const askTrap = def("ask-trap", "Trap");
/** A Cry on a Unit, so `summon` and `play` can be compared on one card (R1). */
const crier = unit("crier");
/** #21's shape: a Spell that casts itself on draw and whose script notes that it ran (R70). */
const drawCaster = def("draw-caster", "Spell");
/** A Spell a Call to Chaos cast resolves for free (R70). */
const chaosSpell = def("chaos-spell", "Spell");

const DEFS = [
  logCard,
  closer,
  watcher,
  snapTrap,
  windowTrap,
  askTrap,
  crier,
  drawCaster,
  chaosSpell,
];

// ---------------------------------------------------------------------------
// The note log: what fired, in the order it fired.
// ---------------------------------------------------------------------------

const NOTE_LANE = 5;

function logOf(state: GameState): CardInstance | null {
  return state.players.p1.backrow[NOTE_LANE - 1] ?? null;
}

function note(name: string): Effect {
  return {
    kind: "tg:note",
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

function laneOf(card: CardInstance | null): number {
  return card !== null && card.zone.z === "field" ? card.zone.lane : 0;
}

/** §10.6: a prompt for the card's own controller, with one answer, so answering is trivial. */
function askController(): Effect {
  return {
    kind: "tg:ask",
    apply(ctx): void {
      openPrompt(ctx, {
        player: ctx.controller,
        kind: "target",
        prompt: "the trap asks its owner",
        options: [{ key: "none", label: "nothing", selection: { pick: "none" } }],
        resume: resumeSelf(ctx, "asked"),
      });
    },
  };
}

function both(script: Script): CardScripts {
  return { base: script, radiant: script };
}

const SCRIPTS: Record<string, CardScripts> = {
  [closer.id]: both({ endOfTurn: (ctx) => [note(`end:lane${laneOf(ctx.self)}`)] }),
  [watcher.id]: both({
    triggers: [{ id: "watch-summon", on: ["summoned"], run: () => [note("trigger")] }],
  }),
  [snapTrap.id]: both({
    triggers: [{ id: "snap-summon", on: ["summoned"], run: () => [note("trap")] }],
  }),
  [windowTrap.id]: both({
    triggers: [{ id: "turn-end", on: ["turnEnded"], run: (ctx) => [note(`window:${ctx.controller}`)] }],
  }),
  [askTrap.id]: both({
    triggers: [{ id: "ask-summon", on: ["summoned"], run: () => [askController()] }],
    resume: { asked: () => [note("answered")] },
  }),
  [crier.id]: both({ cry: () => [note("cry")] }),
  [drawCaster.id]: both({ staticFlags: { castOnDraw: true }, cry: () => [note("cry:onDraw")] }),
  [chaosSpell.id]: both({ cry: () => [note("cry:cast")] }),
};

// ---------------------------------------------------------------------------
// Harness.
// ---------------------------------------------------------------------------

/** A fresh game whose catalog and script registry also carry this file's fixtures. */
function game(seed: string): GameState {
  const state = newGame(seed);
  registerCatalog({ ...registeredCatalog(), ...Object.fromEntries(DEFS.map((d) => [d.id, d])) });
  registerScripts({ ...registeredScripts(), ...SCRIPTS });
  return state;
}

let nonce = 0;

function actResult(state: GameState, body: ActionInput): ReturnType<typeof reduce> {
  nonce += 1;
  return reduce(state, { ...body, nonce: `tg${nonce}` } as Action);
}

function act(state: GameState, body: ActionInput): GameState {
  const result = actResult(state, body);
  if (result.error !== undefined) throw new Error(result.error);
  return result.state;
}

/** Past the mulligans, in p1's main phase, with the note log parked in p1's backrow lane 5. */
function playing(seed: string): GameState {
  let state = beginGame(game(seed)).state;
  state = act(state, { type: "mulligan", keep: state.players.p1.hand.map((c) => c.id), playerId: "p1" });
  state = act(state, { type: "mulligan", keep: state.players.p2.hand.map((c) => c.id), playerId: "p2" });
  put(state, logCard.id, slot("p1", "backrow", NOTE_LANE));
  return state;
}

function only<T>(items: readonly T[]): T {
  const first = items[0];
  if (first === undefined) throw new Error("expected at least one item");
  return first;
}

function handCard(state: GameState, defId: string, player: PlayerId = "p1"): CardInstance {
  return only(inHand(state, defId, player));
}

// ---------------------------------------------------------------------------

describe("events, triggers and the §10.3 resolution loop (M3-T2)", () => {
  it("R68 two end-of-turn triggers on one side resolve in lane order, not in creation order", () => {
    const state = playing("r68-lane-order");
    // Created lane 3 first, so the instance order and the lane order disagree.
    const later = put(state, closer.id, slot("p1", "units", 3));
    const earlier = put(state, closer.id, slot("p1", "units", 1));
    expect(Number(later.id.slice(1))).toBeLessThan(Number(earlier.id.slice(1)));

    // The registry itself reads lane 1 before lane 3 (R68's within-a-side order).
    const order = cardsInTriggerOrder(state)
      .map((holder) => holder.card.id)
      .filter((id) => id === earlier.id || id === later.id);
    expect(order).toEqual([earlier.id, later.id]);

    const ended = act(state, { type: "endTurn", playerId: "p1" });
    expect(notes(ended)).toEqual(["end:lane1", "end:lane3"]);
  });

  it("§10.3 fires a trap before a queued trigger, because a trap is a response", () => {
    const state = playing("trap-before-trigger");
    // Lane order alone would run the Field Spell first: it is the trap's response status that wins.
    put(state, watcher.id, slot("p1", "backrow", 1));
    put(state, snapTrap.id, slot("p1", "backrow", 2));
    expect(
      cardsInTriggerOrder(state)
        .map((holder) => holder.card.defId)
        .filter((id) => id === watcher.id || id === snapTrap.id),
    ).toEqual([watcher.id, snapTrap.id]);

    const sink = sinkFor(state);
    const ctx = makeContext(sink, null, { controller: "p1" });
    applyEffects([summon({ defId: crier.id })], ctx);
    expect(eventsOfType(sink.events, "summoned")).toHaveLength(1);

    settle(sink);
    expect(notes(state)).toEqual(["trap", "trigger"]);
    // §5.1: the Trap is spent and public; the Field Spell that answered is untouched.
    expect(state.players.p1.graveyard.some((card) => card.defId === snapTrap.id)).toBe(true);
    expect(eventsOfType(sink.events, "trapFired").map((e) => e.defId)).toEqual([snapTrap.id]);
    expect(state.triggerQueue).toEqual([]);
  });

  it("R62 holds the end-of-turn trap window back to its scheduled point, after the end-of-turn triggers", () => {
    const state = playing("r62-window");
    put(state, closer.id, slot("p1", "units", 1));
    put(state, windowTrap.id, slot("p1", "backrow", 1));
    put(state, windowTrap.id, slot("p2", "backrow", 1));

    // `turnEnded` is the one event the immediate dispatch withholds: the window owns it (R62).
    const turnEnded = { type: "turnEnded" as const, player: "p1" as const, turn: state.turn, unspentMana: 0 };
    expect(isTrapWindowEvent(turnEnded)).toBe(true);
    const immediate = sinkFor(state);
    expect(fireTrapsFor(immediate, turnEnded).fired).toEqual([]);
    expect(notes(state)).toEqual([]);

    // At its scheduled point it fires on both sides, the ending player's traps first (R68).
    const scheduled = sinkFor(state);
    expect(runTrapWindow(scheduled, turnEnded).fired).toHaveLength(2);
    expect(notes(state)).toEqual(["window:p1", "window:p2"]);

    // And in the turn loop the window comes after the end-of-turn triggers, never before them.
    const live = playing("r62-window-live");
    put(live, closer.id, slot("p1", "units", 1));
    put(live, windowTrap.id, slot("p1", "backrow", 1));
    put(live, windowTrap.id, slot("p2", "backrow", 1));
    const ended = act(live, { type: "endTurn", playerId: "p1" });
    expect(notes(ended)).toEqual(["end:lane1", "window:p1", "window:p2"]);
  });

  it("R59 runs no state check between the hits of one effect, so one effect can leave both heroes at 0", () => {
    const state = playing("r59-double-edge");
    // #fx-999 Double Edge: 30 to the enemy hero, then draw 1 — and p1's library is empty, so the
    // draw is a fatigue hit on p1's own hero (§2.4, R3). One effect list, two lethal hits.
    state.players.p1.library = [];
    state.players.p1.fatigueCount = 0;
    state.players.p1.hero.health = 1;
    const card = handCard(state, doubleEdge.id);

    // The contrast first: a check taken between the two hits would have ended it as a p1 win.
    const split = sinkFor(state);
    const splitCtx = makeContext(split, card, { controller: "p1" });
    const effects = scriptOf(card).cry?.(splitCtx) ?? [];
    expect(effects).toHaveLength(2);
    applyEffects(effects.slice(0, 1), splitCtx);
    stateCheck(split);
    expect(split.state.result).toEqual({ winner: "p1", reason: "hero-death" });

    // The whole effect, then one check: both heroes are at 0 in that check, which is a draw (R59).
    const whole = playing("r59-double-edge-whole");
    whole.players.p1.library = [];
    whole.players.p1.fatigueCount = 0;
    whole.players.p1.hero.health = 1;
    const played = actResult(whole, {
      type: "play",
      instanceId: handCard(whole, doubleEdge.id).id,
      playerId: "p1",
    });
    expect(played.error).toBeUndefined();
    expect(played.state.players.p1.hero.health).toBeLessThanOrEqual(0);
    expect(played.state.players.p2.hero.health).toBeLessThanOrEqual(0);
    expect(played.state.result).toEqual({ winner: "draw", reason: "both-heroes-dead" });
  });

  it("§10.3 pauses the loop where it stands when a trap prompts its owner, keeping the queue behind it", () => {
    const state = playing("trap-prompt-pause");
    expect(state.active).toBe("p1");
    const waiting = put(state, watcher.id, slot("p1", "backrow", 1));
    put(state, askTrap.id, slot("p2", "backrow", 1));

    const sink = sinkFor(state);
    const ctx = makeContext(sink, null, { controller: "p1" });
    applyEffects([summon({ defId: crier.id })], ctx);
    settle(sink);

    // The prompt belongs to the trap's owner, who is not the active player (§10.3, §10.6).
    expect(state.pending?.playerId).toBe("p2");
    expect(state.active).toBe("p1");
    // And the trigger the trap jumped ahead of is still owed, in state, not on the sink (§9.3).
    expect(state.triggerQueue.map((entry) => entry.instanceId)).toEqual([waiting.id]);
    expect(notes(state)).toEqual([]);
    // §10.1 keeps the paused loop JSON, so it survives a round trip.
    const round = JSON.parse(JSON.stringify(state)) as GameState;
    expect(round.pending?.playerId).toBe("p2");
    expect(round.triggerQueue).toHaveLength(1);
  });

  it("R118 pauses the opponent's action until the trap's prompt is answered, without eating the Cry (§10.3)", () => {
    const state = playing("trap-prompt-blocks-action");
    put(state, askTrap.id, slot("p2", "backrow", 1));
    const played = actResult(state, {
      type: "play",
      instanceId: handCard(state, crier.id).id,
      playerId: "p1",
      zone: { row: "units", lane: 1 },
    });
    expect(played.error).toBeUndefined();

    // p1's play emitted the summon, so p2's trap holds the game before p1 can act again — and it
    // holds it inside §10.5, between step 4's `summoned` and step 5's Cry, because a trap is a
    // response and answers the play event first (§10.3, R17).
    const paused = played.state;
    expect(paused.pending?.playerId).toBe("p2");
    expect(notes(paused)).toEqual([]);
    expect(
      actResult(paused, { type: "endTurn", playerId: "p1" }).error,
    ).toMatch(/a prompt is open/);
    expect(actResult(paused, { type: "play", instanceId: handCard(paused, crier.id).id, playerId: "p1" }).error)
      .toMatch(/a prompt is open/);

    // Once p2 answers, p1's turn carries on: the trap's continuation ran, then the interrupted play
    // resumed at the step after the one that paused, so the Cry fires — once, after the trap, and
    // never dropped (§10.5 step 5, R1, R113's "a work item that cannot be resumed is a lost
    // sequence"). Nothing is pending and nothing is still owed.
    const answered = act(paused, {
      type: "answer",
      choiceId: paused.pending?.id ?? "",
      selection: [{ pick: "none" }],
      playerId: "p2",
    });
    expect(answered.pending).toBeNull();
    expect(notes(answered)).toEqual(["answered", "cry"]);
    expect(answered.work).toEqual([]);
    expect(actResult(answered, { type: "endTurn", playerId: "p1" }).error).toBeUndefined();
  });

  it("R1 CRY_ON_PLAY_ONLY makes summon never fire Cry, while playing the same card from hand does", () => {
    expect(CRY_ON_PLAY_ONLY).toBe(true);

    const state = playing("r1-summon-vs-play");
    const sink = sinkFor(state);
    const ctx = makeContext(sink, null, { controller: "p1" });
    applyEffects([summon({ defId: crier.id })], ctx);
    expect(eventsOfType(sink.events, "summoned")).toHaveLength(1);
    // A summon is not a play: no `cardPlayed`, no Cry (§6.3 Summon, R1).
    expect(eventsOfType(sink.events, "cardPlayed")).toHaveLength(0);
    expect(notes(state)).toEqual([]);
    settle(sink);
    expect(notes(state)).toEqual([]);

    const played = actResult(state, {
      type: "play",
      instanceId: handCard(state, crier.id).id,
      playerId: "p1",
      zone: { row: "units", lane: 2 },
    });
    expect(played.error).toBeUndefined();
    expect(eventsOfType(played.events, "cardPlayed")).toHaveLength(1);
    expect(notes(played.state)).toEqual(["cry"]);
  });

  it("R70 fires the Cry for a cast too: a Cast on draw and a Call to Chaos cast both count as plays", () => {
    const state = playing("r70-casts");
    const sink = sinkFor(state);

    // Cast on draw: the card never enters the hand and its script runs at once (§2.4, R70).
    setLibrary(state, "p1", [drawCaster.id]);
    const before = state.counters.played;
    applyEffects([drawEffect({ count: 1 })], makeContext(sink, null, { controller: "p1" }));
    expect(notes(state)).toEqual(["cry:onDraw"]);
    expect(state.counters.played).toBe(before + 1);
    expect(state.players.p1.hand.some((card) => card.defId === drawCaster.id)).toBe(false);
    expect(eventsOfType(sink.events, "cardPlayed").map((e) => e.costPaid)).toEqual([0]);

    // A Call to Chaos cast: free, counts as a play, fires the script (R70).
    const chaos = handCard(state, chaosSpell.id);
    castCard(sink, chaos);
    expect(notes(state)).toEqual(["cry:onDraw", "cry:cast"]);
    expect(state.counters.played).toBe(before + 2);
    expect(eventsOfType(sink.events, "cardPlayed").map((e) => e.costPaid)).toEqual([0, 0]);
    expect(state.players.p1.graveyard.some((card) => card.id === chaos.id)).toBe(true);
  });
});
