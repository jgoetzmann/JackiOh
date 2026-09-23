// A prompt opened by a cast-on-draw card, inside §2.4's two draw loops (SPEC §2.4, §9.3, §10.6;
// R3, R4, R58, R70, R113, R117, R122).
//
// §2.4's "Cast on draw" fires a whole play from inside a draw, and a play can ask: #7 Jewelosco
// Scarab's Discover off the top of the library, or anything Call to Chaos reaches. `castCard` stops
// when its Cry pauses, but the two loops around it did not — `completeDraw` drew the next card and
// could cast that one too, and `draw`'s "draw N" walked on to draw N+1 — all while the prompt sat
// unanswered. Cards drawn past the pause are drawn into a game state the player has not finished
// deciding, and R58's cap could be evaded by a chain that restarted at zero after the answer.
//
// What is pinned here, by observable behaviour and not by reading the implementation:
//
//   * §9.3, R113 and R117 — a cast that asks stops the chain where it stands, and the rest of the
//     chain is *owed* to `state.work` at the moment of the pause: nothing further is drawn, the
//     library keeps the cards the chain has not reached, and the answer draws exactly those, once
//     each. The same for the whole draws a "draw N" has not made.
//   * §9.3 and §10.1 — the paused game survives `JSON.parse(JSON.stringify(state))` and resumes
//     identically from the round-tripped copy.
//   * R58 — the owed chain carries its counter, so a resumed chain continues from the count it had.
//     A chain resumed at zero would cast past the cap, which is what the cap test here would show.
//   * R4 and R3 — the hand cap still burns the overflow and the empty library still deals fatigue on
//     the far side of a pause, and the draw the chain paused on is counted once, not twice.
//   * R70 and R122 — the paused cast itself still lands: §10.5 steps 6 and 7 run on the answer, in
//     R113's order, *before* the draw that was owed behind them.
//
// The control cases are the other half: with nothing asking, the same chain and the same "draw N"
// run to the end inside the one call and `state.work` never holds anything, so a green run here is
// not green by vacuity.
//
// Fixtures are this file's own: defs are prefixed `dr-` and indexed from 2700, so they cannot
// collide with another test file's catalog (BUILD §0).

import type { Action, ActionInput, CardDef, GameEvent } from "@jackioh/shared";
import { describe, expect, it } from "vitest";
import { registerCatalog, registeredCatalog } from "../src/catalog";
import { CAST_ON_DRAW_CHAIN_CAP, HAND_CAP, HERO_HEALTH } from "../src/config";
import {
  DRAW_CHAIN_WORK,
  DRAW_COUNT_WORK,
  draw,
  drawOne,
  owedDrawChainOf,
  owedDrawCountOf,
} from "../src/draw";
import { openPrompt, resumeSelf } from "../src/prompts";
import { beginGame, reduce } from "../src/reduce";
import { PLAY_WORK_KIND } from "../src/playSteps";
import type { CardScripts, Effect, Script } from "../src/script";
import { registerScripts, registeredScripts } from "../src/scripts";
import { newInstance, type CardInstance, type GameState } from "../src/state";
import { owedWork } from "../src/work";
import { eventsOfType, newGame, put, setLibrary, sinkFor, slot } from "./fixtures/harness";

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

let nextIndex = 2700;

function def(name: string, type: CardDef["type"], extra: Partial<CardDef> = {}): CardDef {
  nextIndex += 1;
  const face =
    type === "Unit"
      ? { attack: 1, health: 1, keywords: [], text: name }
      : { keywords: [], text: name };
  return {
    id: `dr-${name}`,
    index: String(nextIndex),
    name: `${name} (draw pause)`,
    set: "Core",
    type,
    tags: [],
    rarity: "Common",
    token: false,
    cost: 0,
    base: { ...face },
    radiant: { ...face },
    ...extra,
  };
}

/** The note sink: a Field Spell parked in p1's backrow lane 5, whose memory records the order. */
const logCard = def("log", "Field Spell");
/** §2.4: a cast-on-draw Spell whose Cry asks its controller something — #7's shape through a draw. */
const askOnDraw = def("ask-on-draw", "Spell");
/** The same, cast on draw, with nothing to ask: the rest of a chain, and the control. */
const quietOnDraw = def("quiet-on-draw", "Spell");
/** An ordinary card: drawn to hand, and the end of any chain that reaches it (R58). */
const plain = def("plain", "Spell");

const DEFS = [logCard, askOnDraw, quietOnDraw, plain];

// ---------------------------------------------------------------------------
// The note log: what ran, in the order it ran.
// ---------------------------------------------------------------------------

const NOTE_LANE = 5;

function logOf(state: GameState): CardInstance | null {
  return state.players.p1.backrow[NOTE_LANE - 1] ?? null;
}

function write(state: GameState, entry: string): void {
  const log = logOf(state);
  if (log === null) return;
  const steps = Array.isArray(log.memory.steps) ? (log.memory.steps as string[]) : [];
  log.memory.steps = [...steps, entry];
}

function notes(state: GameState): string[] {
  const log = logOf(state);
  return Array.isArray(log?.memory.steps) ? (log.memory.steps as string[]) : [];
}

function note(entry: string): Effect {
  return {
    kind: "dr:note",
    apply(ctx): void {
      write(ctx.state, entry);
    },
  };
}

/** §10.6: a prompt for the card's own controller, with one answer, so answering is trivial. */
function askController(): Effect {
  return {
    kind: "dr:ask",
    apply(ctx): void {
      openPrompt(ctx, {
        player: ctx.controller,
        kind: "target",
        prompt: "the cast-on-draw card asks its owner",
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
  [askOnDraw.id]: both({
    staticFlags: { castOnDraw: true },
    cry: () => [note("ask"), askController(), note("ask:tail")],
    resume: { asked: () => [note("answered")] },
  }),
  [quietOnDraw.id]: both({ staticFlags: { castOnDraw: true }, cry: () => [note("quiet")] }),
  [plain.id]: both({}),
};

// ---------------------------------------------------------------------------
// Harness.
// ---------------------------------------------------------------------------

function game(seed: string): GameState {
  const state = newGame(seed);
  registerCatalog({ ...registeredCatalog(), ...Object.fromEntries(DEFS.map((d) => [d.id, d])) });
  registerScripts({ ...registeredScripts(), ...SCRIPTS });
  return state;
}

let nonce = 0;

function actResult(state: GameState, body: ActionInput): ReturnType<typeof reduce> {
  nonce += 1;
  return reduce(state, { ...body, nonce: `dr${nonce}` } as Action);
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
  // The turn's own draw and the opening hands are behind us; every count below starts here.
  state.players.p1.hand = [];
  state.counters.drawn = 0;
  return state;
}

function only<T>(items: readonly T[]): T {
  const first = items[0];
  if (first === undefined) throw new Error("expected exactly one item");
  return first;
}

/** Answer the one open prompt, whoever it belongs to. */
function answer(state: GameState): ReturnType<typeof reduce> {
  const pending = state.pending;
  if (pending === null) throw new Error("expected a prompt to be open");
  const result = actResult(state, {
    type: "answer",
    choiceId: pending.id,
    selection: [{ pick: "none" }],
    playerId: pending.playerId,
  });
  if (result.error !== undefined) throw new Error(result.error);
  return result;
}

const roundTrip = (state: GameState): GameState =>
  JSON.parse(JSON.stringify(state)) as GameState;

/**
 * The `drawn` events of one player. `state.counters.drawn` is both players' (R55), and an `answer`
 * that leaves p1 with no legal action auto-ends the turn, so p2's own start-of-turn draw lands in
 * the same action — which says nothing about the draw under test.
 */
const drawnBy = (events: readonly GameEvent[], player: "p1" | "p2"): string[] =>
  eventsOfType(events, "drawn")
    .filter((e) => e.player === player)
    .map((e) => e.defId);

const handOf = (state: GameState): string[] => state.players.p1.hand.map((c) => c.defId);
const libraryOf = (state: GameState): string[] => state.players.p1.library.map((c) => c.defId);

// ---------------------------------------------------------------------------

describe("a prompt inside §2.4's cast-on-draw chain (R58, R113, R117, R122)", () => {
  it("R158 draws nothing more while a cast-on-draw prompt is open, and owes the rest of the chain", () => {
    const state = playing("draw-chain-owe");
    setLibrary(state, "p1", [quietOnDraw.id, askOnDraw.id, quietOnDraw.id, plain.id]);

    const events: GameEvent[] = [];
    drawOne(sinkFor(state, events), "p1");

    // The chain cast the first card, drew the asker, cast it — and stopped at its question.
    expect(notes(state)).toEqual(["quiet", "ask"]);
    expect(state.pending?.playerId).toBe("p1");

    // THE BUG: the chain used to draw on from here. Exactly two cards have left the library, the
    // two the chain has already cast, and neither of the cards behind them has been drawn.
    expect(state.counters.drawn).toBe(2);
    expect(drawnBy(events, "p1")).toEqual([quietOnDraw.id, askOnDraw.id]);
    expect(libraryOf(state)).toEqual([quietOnDraw.id, plain.id]);
    expect(handOf(state)).toEqual([]);

    // R113 and R117: the remainder is owed — one more draw, continuing the chain at the count it
    // had. §9.3: plain data, so no closure and no captured library is held across the prompt.
    const parked = only(owedWork(state, DRAW_CHAIN_WORK));
    expect(owedDrawChainOf(parked.resume)).toEqual({ player: "p1", chain: 2 });
    expect(JSON.parse(JSON.stringify(parked))).toEqual(parked);
    // R113's order, innermost first: the effects of the Cry after the one that asked, then the
    // cast's own tail (§10.5 steps 6 and 7), and only last the draw the chain still owes.
    expect(state.work.map((item) => item.resume.hook)).toEqual([
      "cry",
      PLAY_WORK_KIND,
      DRAW_CHAIN_WORK,
    ]);

    // §10.1: the paused game survives a round trip and resumes from the round-tripped copy.
    const round = roundTrip(state);
    expect(owedDrawChainOf(only(owedWork(round, DRAW_CHAIN_WORK)).resume)).toEqual({
      player: "p1",
      chain: 2,
    });

    const done = answer(round);
    // R113: the rest of the Cry, then the cast's tail, and only then the draw that was owed.
    expect(notes(done.state)).toEqual(["quiet", "ask", "answered", "ask:tail", "quiet"]);
    // The two cards still in the library were drawn, once each: the third was cast on draw, the
    // fourth ended the chain in hand. Nothing was drawn twice and nothing was skipped.
    expect(done.state.counters.drawn).toBe(4);
    expect(drawnBy(done.events, "p1")).toEqual([quietOnDraw.id, plain.id]);
    expect(libraryOf(done.state)).toEqual([]);
    expect(handOf(done.state)).toEqual([plain.id]);
    expect(done.state.pending).toBeNull();
    expect(done.state.work).toEqual([]);
    // R70: each of the three cast cards counted as a play exactly once, across the pause.
    expect(done.state.counters.played).toBe(3);
  });

  it("R58 resumes a chain at the count it had, so the cap cannot be evaded by pausing", () => {
    const state = playing("draw-chain-cap");
    // Two casts short of the cap: the asker, then one more cast, then one the cap must refuse.
    setLibrary(state, "p1", [askOnDraw.id, quietOnDraw.id, quietOnDraw.id, plain.id]);

    drawOne(sinkFor(state), "p1", CAST_ON_DRAW_CHAIN_CAP - 2);

    expect(state.pending).not.toBeNull();
    // The owed count is the one the chain would have passed on, not zero.
    expect(owedDrawChainOf(only(owedWork(state, DRAW_CHAIN_WORK)).resume)?.chain).toBe(
      CAST_ON_DRAW_CHAIN_CAP - 1,
    );

    const done = answer(roundTrip(state)).state;
    // One more cast fits under the cap; the next cast-on-draw card is at the cap, so it goes to the
    // hand uncast and ends the chain (R58). A chain resumed at 0 would have cast it and the `plain`
    // behind it would be the card in hand instead.
    expect(notes(done)).toEqual(["ask", "answered", "ask:tail", "quiet"]);
    expect(handOf(done)).toEqual([quietOnDraw.id]);
    expect(libraryOf(done)).toEqual([plain.id]);
    expect(done.work).toEqual([]);
  });

  it("R4 burns the card a resumed chain draws into a full hand, counting that draw once", () => {
    const state = playing("draw-chain-hand-cap");
    for (let i = 0; i < HAND_CAP; i += 1) {
      state.players.p1.hand.push(newInstance(state, plain.id, "p1", { z: "hand", player: "p1" }));
    }
    setLibrary(state, "p1", [askOnDraw.id, plain.id]);

    drawOne(sinkFor(state), "p1");
    // R58: a cast-on-draw card is cast even with a full hand, and nothing has burned yet.
    expect(state.counters.drawn).toBe(1);
    expect(state.players.p1.graveyard.map((c) => c.defId)).toEqual([]);

    const done = answer(roundTrip(state));
    // The owed draw happened once: counted once, burned once, and the hand is still at the cap.
    expect(done.state.counters.drawn).toBe(2);
    expect(eventsOfType(done.events, "burned")).toHaveLength(1);
    expect(done.state.players.p1.hand).toHaveLength(HAND_CAP);
    // The asker resolved to the graveyard (§10.5 step 7) and the burned card joined it.
    expect(done.state.players.p1.graveyard.map((c) => c.defId)).toEqual([askOnDraw.id, plain.id]);
    expect(done.state.work).toEqual([]);
  });

  it("R3 still takes fatigue when the owed draw finds the library empty", () => {
    const state = playing("draw-chain-fatigue");
    setLibrary(state, "p1", [askOnDraw.id]);

    drawOne(sinkFor(state), "p1");
    // The pause happens before the empty-library draw, so no fatigue has been taken yet.
    expect(state.players.p1.fatigueCount).toBe(0);
    expect(state.players.p1.hero.health).toBe(HERO_HEALTH);

    const done = answer(roundTrip(state));
    // The owed draw found nothing and dealt R3's first point of fatigue, exactly once.
    expect(done.state.players.p1.fatigueCount).toBe(1);
    expect(done.state.players.p1.hero.health).toBe(HERO_HEALTH - 1);
    expect(eventsOfType(done.events, "damage").map((e) => e.amount)).toEqual([1]);
    // No card was drawn by the owed draw — there was none to draw — so nothing reached p1's hand.
    expect(drawnBy(done.events, "p1")).toEqual([]);
    expect(handOf(done.state)).toEqual([]);
    expect(done.state.work).toEqual([]);
  });

  it("runs a whole chain in one call when nothing asks, owing nothing at all", () => {
    const state = playing("draw-chain-control");
    setLibrary(state, "p1", [quietOnDraw.id, quietOnDraw.id, plain.id]);

    const events: GameEvent[] = [];
    drawOne(sinkFor(state, events), "p1");

    // Both casts and the card that ended the chain, inside the one call.
    expect(notes(state)).toEqual(["quiet", "quiet"]);
    expect(state.counters.drawn).toBe(3);
    expect(handOf(state)).toEqual([plain.id]);
    expect(libraryOf(state)).toEqual([]);
    expect(eventsOfType(events, "cardPlayed")).toHaveLength(2);
    expect(state.pending).toBeNull();
    // Nothing was parked: the machinery only engages at a pause (R117), so this is not the pause
    // path passing by accident.
    expect(state.work).toEqual([]);
  });
});

describe("a prompt inside §2.4's 'draw N' loop (R58, R113, R117, R122)", () => {
  it("R113 stops a 'draw N' at the draw that asked and owes the draws it has not made", () => {
    const state = playing("draw-count-owe");
    setLibrary(state, "p1", [askOnDraw.id, plain.id, plain.id]);

    const events: GameEvent[] = [];
    draw(sinkFor(state, events), "p1", 3);

    // Only the first draw happened: the two behind it are the answering action's (§2.4, R122).
    expect(state.counters.drawn).toBe(1);
    expect(drawnBy(events, "p1")).toEqual([askOnDraw.id]);
    expect(libraryOf(state)).toEqual([plain.id, plain.id]);
    expect(handOf(state)).toEqual([]);

    // R113: the interrupted chain is owed ahead of the whole draws that are still to come, and the
    // cast's own tail ahead of both. §9.3: all plain data.
    expect(state.work.map((item) => item.resume.hook)).toEqual([
      "cry",
      PLAY_WORK_KIND,
      DRAW_CHAIN_WORK,
      DRAW_COUNT_WORK,
    ]);
    const parked = only(owedWork(state, DRAW_COUNT_WORK));
    expect(owedDrawCountOf(parked.resume)).toEqual({ player: "p1", count: 2 });
    expect(JSON.parse(JSON.stringify(parked))).toEqual(parked);

    const done = answer(roundTrip(state));
    // The chain's own owed draw first, then the two whole draws: three draws in all, once each.
    expect(done.state.counters.drawn).toBe(3);
    expect(drawnBy(done.events, "p1")).toEqual([plain.id, plain.id]);
    expect(handOf(done.state)).toEqual([plain.id, plain.id]);
    expect(libraryOf(done.state)).toEqual([]);
    expect(done.state.pending).toBeNull();
    expect(done.state.work).toEqual([]);
  });

  it("draws the whole of a 'draw N' in one call when nothing asks, owing nothing at all", () => {
    const state = playing("draw-count-control");
    setLibrary(state, "p1", [quietOnDraw.id, plain.id, plain.id, plain.id]);

    const events: GameEvent[] = [];
    const outcomes = draw(sinkFor(state, events), "p1", 3);

    // Draw 1 cast the top card and chained into the next; draws 2 and 3 took a card each.
    expect(outcomes).toEqual(["cast", "drawn", "drawn"]);
    expect(state.counters.drawn).toBe(4);
    expect(handOf(state)).toEqual([plain.id, plain.id, plain.id]);
    expect(libraryOf(state)).toEqual([]);
    expect(state.pending).toBeNull();
    expect(state.work).toEqual([]);
  });
});
