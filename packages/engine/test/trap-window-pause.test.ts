// A prompt opened inside the end-of-turn trap window (SPEC §2.2, §9.3, §10.3, §10.6; R62, R100,
// R113).
//
// The window of §2.2 delivers one `turnEnded` event to every armed trap on both sides, in R68's
// order. It is therefore a sequence that can span a prompt, and the governing rule of this engine
// is that such a sequence must be resumable through `state.work`: never an effect list, a closure
// or a remaining-traps array held across the pause, only the step's name and its captured data as
// plain JSON (§9.3, R113). `traps.runTrapWindow` parks the event plus the ids of the traps that
// have not seen it as a `TRAP_WINDOW_WORK` item, and `triggers.settle`'s drain finishes the window
// once the answer arrives.
//
// The three things pinned here:
//
//   * R113 — a trap that prompts stops the window and the rest of it is *owed*, not dropped. The
//     answer fires the traps that had not seen the event, in the window's own order, and a
//     `JSON.parse(JSON.stringify(state))` of the paused game resumes identically.
//   * R100 and R33 — the resumed window offers the event only to the traps still owed it, so the
//     Field Trap that prompted, which stays on the field after firing, does not fire a second time.
//   * R62 — the window finishes before the end-of-turn delayed effects and before cleanup, whether
//     or not a prompt interrupted it.
//
// Fixtures are this file's own: defs are prefixed `tw-` and indexed from 2200, so they cannot
// collide with another test file's catalog (BUILD §0).

import type { Action, ActionInput, CardDef, GameEvent, PlayerId } from "@jackioh/shared";
import { describe, expect, it } from "vitest";
import { registerCatalog, registeredCatalog } from "../src/catalog";
import { scheduleDelayed } from "../src/modifiers";
import { closePrompt, openPrompt, resumeAt, resumeSelf } from "../src/prompts";
import { beginGame, reduce } from "../src/reduce";
import type { CardScripts, Effect, Script } from "../src/script";
import { registerScripts, registeredScripts } from "../src/scripts";
import type { CardInstance, GameState } from "../src/state";
import { TRAP_WINDOW_WORK, owedWindowOf, runTrapWindow } from "../src/traps";
import { settle } from "../src/triggers";
import { owedWork } from "../src/work";
import { cardAt } from "../src/zones";
import { eventsOfType, newGame, put, sinkFor, slot } from "./fixtures/harness";

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

let nextIndex = 2200;

function def(name: string, type: CardDef["type"], extra: Partial<CardDef> = {}): CardDef {
  nextIndex += 1;
  return {
    id: `tw-${name}`,
    index: String(nextIndex),
    name: `${name} (trap window)`,
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

/** The note sink: a Field Spell parked in p1's backrow lane 5, whose memory records the order. */
const logCard = def("log", "Field Spell");
/** #18's shape, but it asks first: a Field Trap on `turnEnded` that prompts its own controller. */
const askTrap = def("ask", "Field Trap");
/** The trap behind it in R68's order, on the ending player's own side. */
const secondTrap = def("second", "Field Trap");
/** And the opponent's, which R62 puts last in the window. */
const thirdTrap = def("third", "Field Trap");
/** A card holding an end-of-turn delayed effect, which R62 puts after the whole window. */
const delayedCard = def("delayed", "Field Spell");

const DEFS = [logCard, askTrap, secondTrap, thirdTrap, delayedCard];

// ---------------------------------------------------------------------------
// The note log: what fired, in the order it fired.
// ---------------------------------------------------------------------------

const NOTE_LANE = 5;

function logOf(state: GameState): CardInstance | null {
  return state.players.p1.backrow[NOTE_LANE - 1] ?? null;
}

function note(name: string): Effect {
  return {
    kind: "tw:note",
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

/** §10.6: a prompt for the trap's own controller, with one answer, so answering is trivial. */
function askController(): Effect {
  return {
    kind: "tw:ask",
    apply(ctx): void {
      openPrompt(ctx, {
        player: ctx.controller,
        kind: "target",
        prompt: "the window's trap asks its owner",
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
  [askTrap.id]: both({
    triggers: [{ id: "tw-ask-end", on: ["turnEnded"], run: () => [note("window1"), askController()] }],
    resume: { asked: () => [note("answered")] },
  }),
  [secondTrap.id]: both({
    triggers: [{ id: "tw-second-end", on: ["turnEnded"], run: () => [note("window2")] }],
  }),
  [thirdTrap.id]: both({
    triggers: [{ id: "tw-third-end", on: ["turnEnded"], run: () => [note("window3")] }],
  }),
  [delayedCard.id]: both({ delayed: () => [note("delayed")] }),
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
  return reduce(state, { ...body, nonce: `tw${nonce}` } as Action);
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

/** Answer the one open prompt, whoever it belongs to. */
function answer(state: GameState): ReturnType<typeof reduce> {
  const pending = state.pending;
  if (pending === null) throw new Error("expected a prompt to be open");
  return actResult(state, {
    type: "answer",
    choiceId: pending.id,
    selection: [{ pick: "none" }],
    playerId: pending.playerId,
  });
}

function turnEndedIn(state: GameState, player: PlayerId): GameEvent {
  return { type: "turnEnded", player, turn: state.turn, unspentMana: state.players[player].mana.current };
}

// ---------------------------------------------------------------------------

describe("a prompt inside the end-of-turn trap window (§2.2, R62, R100, R113)", () => {
  it("R113 owes the rest of the window when a trap prompts, and the answer fires the traps it had not reached", () => {
    const state = playing("window-owes-remainder");
    const asking = put(state, askTrap.id, slot("p1", "backrow", 1));
    const second = put(state, secondTrap.id, slot("p1", "backrow", 2));
    const third = put(state, thirdTrap.id, slot("p2", "backrow", 1));

    const ended = actResult(state, { type: "endTurn", playerId: "p1" });
    expect(ended.error).toBeUndefined();
    const paused = ended.state;

    // The first trap of the window fired and is waiting on its own controller (§10.6, R52).
    expect(paused.pending?.playerId).toBe("p1");
    expect(notes(paused)).toEqual(["window1"]);
    expect(eventsOfType(ended.events, "trapFired").map((event) => event.instanceId)).toEqual([
      asking.id,
    ]);

    // R113: the window parked what it still owes — the event, and the traps that have not seen it,
    // in the window's order. This is the whole fix: without it the rest of the window is lost.
    const parked = only(owedWork(paused, TRAP_WINDOW_WORK));
    const owed = owedWindowOf(parked.resume);
    expect(owed?.event.type).toBe("turnEnded");
    expect(owed?.owed).toEqual([second.id, third.id]);
    // Plain data, so no effect list, closure or live trap array is held across the prompt (§9.3).
    expect(JSON.parse(JSON.stringify(parked))).toEqual(parked);

    // §10.1: the paused game survives a round trip and resumes from the round-tripped copy.
    const round = JSON.parse(JSON.stringify(paused)) as GameState;
    expect(owedWindowOf(only(owedWork(round, TRAP_WINDOW_WORK)).resume)?.owed).toEqual([
      second.id,
      third.id,
    ]);

    const resumed = answer(round);
    expect(resumed.error).toBeUndefined();
    const answered = resumed.state;

    // The traps the pause stopped the window from reaching fire on the answer, in R62's order:
    // the ending player's side first, then the opponent's.
    expect(notes(answered)).toEqual(["window1", "answered", "window2", "window3"]);
    expect(eventsOfType(resumed.events, "trapFired").map((event) => event.instanceId)).toEqual([
      second.id,
      third.id,
    ]);
    // Nothing is owed any more, and no prompt is left open.
    expect(answered.pending).toBeNull();
    expect(owedWork(answered, TRAP_WINDOW_WORK)).toEqual([]);
    expect(answered.work).toEqual([]);
    // R100 and R33: the Field Trap that prompted is still on the field, face up, and fired once.
    expect(cardAt(answered, slot("p1", "backrow", 1))?.id).toBe(asking.id);
    expect(cardAt(answered, slot("p1", "backrow", 1))?.faceUp).toBe(true);
  });

  it("R100 re-offers the event to nobody who has already seen it, so one turn end is one firing", () => {
    const state = playing("window-no-refire");
    const asking = put(state, askTrap.id, slot("p1", "backrow", 1));
    const second = put(state, secondTrap.id, slot("p1", "backrow", 2));

    const paused = actResult(state, { type: "endTurn", playerId: "p1" }).state;
    expect(paused.pending).not.toBeNull();
    // The trap that fired is a Field Trap: it is still on the field, so re-offering it the event
    // is a real risk and the owed list is what rules it out (§5.1, R33).
    expect(cardAt(paused, slot("p1", "backrow", 1))?.id).toBe(asking.id);
    expect(owedWindowOf(only(owedWork(paused, TRAP_WINDOW_WORK)).resume)?.owed).toEqual([second.id]);

    const answered = answer(paused);
    expect(notes(answered.state)).toEqual(["window1", "answered", "window2"]);
    expect(eventsOfType(answered.events, "trapFired").map((event) => event.instanceId)).toEqual([
      second.id,
    ]);
  });

  it("R113 owes the whole window when a prompt is already open at its scheduled point", () => {
    const state = playing("window-already-paused");
    const first = put(state, secondTrap.id, slot("p1", "backrow", 1));
    const second = put(state, thirdTrap.id, slot("p2", "backrow", 1));

    // A prompt an end-of-turn trigger left open: the window has delivered its event to nobody.
    const sink = sinkFor(state);
    openPrompt(sink, {
      player: "p1",
      kind: "target",
      prompt: "something earlier is still asking",
      options: [{ key: "none", label: "nothing", selection: { pick: "none" } }],
      resume: resumeAt({ defId: logCard.id, step: "noop" }),
    });

    const ended = turnEndedIn(state, "p1");
    expect(runTrapWindow(sink, ended)).toEqual({ fired: [], paused: true });
    expect(notes(state)).toEqual([]);
    // Every matched trap is owed the event: a bare `if (pending !== null) return;` would drop them.
    expect(owedWindowOf(only(owedWork(state, TRAP_WINDOW_WORK)).resume)?.owed).toEqual([
      first.id,
      second.id,
    ]);

    // And once the prompt is gone the drain delivers it, in the window's order.
    closePrompt(sink);
    settle(sink);
    expect(notes(state)).toEqual(["window2", "window3"]);
    expect(state.work).toEqual([]);
  });

  // NOTE — this one fails today, and the half that is missing is not the window's.
  //
  // It is the joint acceptance criterion for §2.2's end of turn: `traps.runTrapWindow` now owes its
  // remainder (the three tests above), but `turn.ts`'s `endTurn` does not notice that the window
  // paused. It calls `runTrapWindow` and walks straight on to `runDelayed`, `cleanup` and the next
  // `startTurn` with the prompt still open, so the delayed effect below resolves *inside* the
  // unfinished window and cleanup closes the turn log before the window's last traps have fired —
  // R62's order, broken on the pause path.
  //
  // The fix is the same shape as the window's and belongs to `turn.ts`: park the steps after the
  // window as a work item of its own when `state.pending !== null`. Parked at `state.workCursor` it
  // lands behind the window's remainder, so the drain finishes the window first and R62's order
  // survives the pause. `traps.ts` cannot do it — `runDelayed` and `cleanup` are `turn.ts`'s alone.
  it("R62 finishes the window before the end-of-turn delayed effects and before cleanup", () => {
    const state = playing("window-before-delayed");
    put(state, askTrap.id, slot("p1", "backrow", 1));
    put(state, secondTrap.id, slot("p1", "backrow", 2));
    const scheduler = put(state, delayedCard.id, slot("p1", "backrow", 3));

    // §2.2's order for the end of a turn: triggers, window, delayed effects, cleanup (R62).
    const scheduled = scheduleDelayed(
      sinkFor(state),
      "p1",
      { phase: "end", player: "p1" },
      {
        defId: delayedCard.id,
        hook: "delayed",
        step: "",
        radiant: false,
        instanceId: scheduler.id,
        data: {},
      },
    );

    const paused = actResult(state, { type: "endTurn", playerId: "p1" }).state;
    expect(paused.pending?.playerId).toBe("p1");

    // The window is unfinished, so nothing R62 puts after it has happened: the delayed effect is
    // still due and cleanup has not closed p1's turn log.
    expect(notes(paused)).toEqual(["window1"]);
    expect(paused.delayed.map((effect) => effect.id)).toEqual([scheduled.id]);
    expect(paused.players.p1.turnLog.unspentAtEnd).toBeUndefined();

    // The answer finishes the window first, and only then the rest of R62's order runs.
    const answered = answer(paused).state;
    expect(notes(answered)).toEqual(["window1", "answered", "window2", "delayed"]);
    expect(answered.delayed).toEqual([]);
    expect(answered.players.p1.turnLog.unspentAtEnd).toBeDefined();
    expect(answered.work).toEqual([]);
  });
});
