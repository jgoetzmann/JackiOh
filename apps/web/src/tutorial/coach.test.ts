// The coach machine (tutorial/coach.ts), on hand-built views: R292.
//
// The coach reads the human's view, their legal actions and whether the AI owes a move, and nothing
// else (CLAUDE.md rule 7). Its guarantees are about never stranding a player: a step activates only
// when its moment comes, completes when the view shows it done (even if it was done early), retires
// silently when it can no longer happen, can always be skipped, expires after
// TUTORIAL_STEP_TURNS_MAX of the player's own turns, and the coach finishes when the game ends.

import { describe, expect, it } from "vitest";

import type { ActionBody, GameEvent, PlayerView } from "@jackioh/shared";

import { baseView, card, emptySide, pendingFor, resetIds, unit } from "../test/fixtures.ts";
import {
  COACH_START,
  activeStep,
  coachAck,
  coachDisplay,
  coachObserve,
  coachSkip,
  type CoachCtx,
  type LessonScript,
} from "./coach.ts";
import { TUTORIAL_STEP_TURNS_MAX } from "./config.ts";
import { attackWith, endTurn, info, keepHand, playCard, tip } from "./steps.ts";
import { coachTargets } from "./targets.ts";

const VANILLA = "core-008";
const SHREDDER = "core-013";

function ctx(view: PlayerView, legal: ActionBody[] = [], fresh: GameEvent[] = [], aiToAct = false): CoachCtx {
  return { view, legal, fresh, aiToAct };
}

/** p1's main phase on `turn`, holding `hand`. */
function myTurn(turn: number, hand = [card({ instanceId: "h1", defId: VANILLA, cost: 1 })], over: Partial<PlayerView> = {}): PlayerView {
  return baseView({ turn, active: "p1", you: emptySide("p1", { hand }), ...over });
}

/** p2's turn, the human still holding Mr. Vanilla unless `over` says otherwise. */
function aiTurnView(turn: number, over: Partial<PlayerView> = {}): PlayerView {
  return baseView({ turn, active: "p2", you: emptySide("p1", { hand: [card({ instanceId: "h1", defId: VANILLA, cost: 1 })] }), ...over });
}

const PLAY_VANILLA: ActionBody = { type: "play", instanceId: "h1", zone: { row: "units", lane: 1 } };

describe("R292 the coach", () => {
  it("R292 activates a step only when its moment comes, and points at the element it names", () => {
    resetIds();
    const script: LessonScript = {
      lessonId: "t",
      steps: [playCard({ id: "play", title: "Play it", text: "Play Mr. Vanilla.", defId: VANILLA })],
      tips: [],
    };
    // The AI's turn: nothing to show yet, but the coach says it is waiting.
    let state = coachObserve(script, COACH_START, ctx(aiTurnView(2), [], [], true));
    expect(coachDisplay(script, state, ctx(aiTurnView(2), [], [], true))).toEqual({
      mode: "waiting",
      stepNumber: 1,
      stepCount: 1,
      aiToAct: true,
    });

    // The human's main phase with the play legal: the step shows, anchored at the hand card.
    const view = myTurn(3);
    const context = ctx(view, [PLAY_VANILLA, { type: "endTurn" }]);
    state = coachObserve(script, state, context);
    const display = coachDisplay(script, state, context);
    expect(display.mode).toBe("step");
    if (display.mode !== "step") return;
    expect(display.title).toBe("Play it");
    expect(display.ack).toBe(false);
    expect(coachTargets(display.anchor, view)).toEqual(["hand-card-h1"]);
    expect(activeStep(script, state)?.id).toBe("play");
  });

  it("R292 waits while the engine offers no such action, since legality is the engine's", () => {
    const script: LessonScript = {
      lessonId: "t",
      steps: [playCard({ id: "play", title: "Play it", text: "Play Mr. Vanilla.", defId: VANILLA })],
      tips: [],
    };
    // In hand but not offered (say, unaffordable): the coach never decides it is playable itself.
    const state = coachObserve(script, COACH_START, ctx(myTurn(3), [{ type: "endTurn" }]));
    expect(state.since).toBeNull();
    expect(coachDisplay(script, state, ctx(myTurn(3), [{ type: "endTurn" }])).mode).toBe("waiting");
  });

  it("R292 completes a step when the view shows it done, including one done before it showed", () => {
    const script: LessonScript = {
      lessonId: "t",
      steps: [
        info({ id: "hello", title: "Hello", text: "Welcome." }),
        playCard({ id: "play", title: "Play it", text: "Play Mr. Vanilla.", defId: VANILLA }),
        endTurn({ id: "end", title: "End turn", text: "End your turn." }),
      ],
      tips: [],
    };
    const legal = [PLAY_VANILLA, { type: "endTurn" } as ActionBody];
    let state = coachObserve(script, COACH_START, ctx(myTurn(3), legal));
    expect(activeStep(script, state)?.id).toBe("hello");

    // The player plays the card while the welcome is still up: the play step is already done when
    // the welcome goes, and the coach moves straight to "End turn".
    const played = myTurn(3, []);
    state = coachObserve(script, state, ctx(played, [{ type: "endTurn" }]));
    state = coachAck(script, state, ctx(played, [{ type: "endTurn" }]));
    expect(state.outcomes).toEqual({ hello: "done", play: "moot" });
    expect(activeStep(script, state)?.id).toBe("end");

    // End turn is done once the turn has passed.
    state = coachObserve(script, state, ctx(aiTurnView(4), [], [], true));
    expect(state.outcomes["end"]).toBe("done");
    expect(state.finished).toBe(true);
  });

  it("R292 completes an attack step on the attack the engine reports, and retires it when its turn ends without one", () => {
    const attacker = unit("p1", { instanceId: "u1", defId: SHREDDER });
    const board = (units: PlayerView["you"]["units"]): PlayerView =>
      myTurn(5, [], { you: emptySide("p1", { units, hand: [] }) });
    const attack: ActionBody = { type: "attack", attackerId: "u1", targetId: "hero-p2" };
    const script: LessonScript = {
      lessonId: "t",
      steps: [attackWith({ id: "hit", title: "Attack", text: "Hit the hero.", attacker: SHREDDER, target: "hero" })],
      tips: [],
    };
    const view = board([attacker, null, null, null, null]);
    let state = coachObserve(script, COACH_START, ctx(view, [attack]));
    const display = coachDisplay(script, state, ctx(view, [attack]));
    expect(display.mode === "step" ? coachTargets(display.anchor, view) : null).toEqual(["hero-opponent"]);
    expect(script.steps[0]?.expect?.(attack, ctx(view, [attack]))).toBe(true);

    const declared: GameEvent = { type: "attackDeclared", attackerId: "u1", targetId: "hero-p2", forced: false };
    const after = coachObserve(script, state, ctx(board([{ ...attacker, canAct: false }, null, null, null, null]), [], [declared]));
    expect(after.outcomes["hit"]).toBe("done");

    // The same step, but the player ends the turn instead, the unit still standing: it goes without a word.
    const unused = aiTurnView(6, { you: emptySide("p1", { units: [attacker, null, null, null, null], hand: [] }) });
    state = coachObserve(script, state, ctx(unused, [], [], true));
    expect(state.outcomes["hit"]).toBe("moot");
  });

  it("R292 counts an attack that also ends the turn by itself as done, and follows the very instance that showed", () => {
    const tokenA = unit("p1", { instanceId: "t1", defId: "core-t-rush" });
    const tokenB = unit("p1", { instanceId: "t2", defId: "core-t-rush" });
    const board = (units: PlayerView["you"]["units"], over: Partial<PlayerView> = {}): PlayerView =>
      myTurn(5, [], { you: emptySide("p1", { units, hand: [] }), ...over });
    const attack: ActionBody = { type: "attack", attackerId: "t1", targetId: "hero-p2" };
    const script: LessonScript = {
      lessonId: "t",
      steps: [attackWith({ id: "hit", title: "Attack", text: "Hit the hero.", attacker: "core-t-rush", target: "hero" })],
      tips: [],
    };
    const view = board([tokenA, tokenB, null, null, null]);
    const shown = coachObserve(script, COACH_START, ctx(view, [attack]));
    expect(activeStep(script, shown)?.id).toBe("hit");

    // The first token attacks and dies; its twin is still on the field, and the step is still done.
    const traded = board([null, tokenB, null, null, null]);
    const declared: GameEvent = { type: "attackDeclared", attackerId: "t1", targetId: "hero-p2", forced: false };
    expect(coachObserve(script, shown, ctx(traded, [], [declared])).outcomes["hit"]).toBe("done");

    // The attack left nothing to do and the turn ended by itself (R82) in the same action: done, not moot.
    const autoEnded = aiTurnView(6, { you: emptySide("p1", { units: [tokenA, tokenB, null, null, null], hand: [] }) });
    expect(coachObserve(script, shown, ctx(autoEnded, [], [declared], true)).outcomes["hit"]).toBe("done");
  });

  it("R292 retires an End turn step whose turn ended by itself before it showed", () => {
    const script: LessonScript = {
      lessonId: "t",
      steps: [
        info({ id: "read", title: "Read", text: "Read this first." }),
        endTurn({ id: "end", title: "End turn", text: "End your turn." }),
        info({ id: "next", title: "Next", text: "Next." }),
      ],
      tips: [],
    };
    let state = coachObserve(script, COACH_START, ctx(myTurn(3), [{ type: "endTurn" }]));
    // The turn passes (it ended by itself) while the player is still reading the info step.
    state = coachObserve(script, state, ctx(aiTurnView(4), [], [], true));
    state = coachAck(script, state, ctx(aiTurnView(4), [], [], true));
    // "End turn" belonged to turn 3; it is not asked on turn 5.
    state = coachObserve(script, state, ctx(myTurn(5), [{ type: "endTurn" }]));
    expect(state.outcomes["end"]).toBe("moot");
    expect(activeStep(script, state)?.id).toBe("next");
  });

  it("R292 retires a step whose card is gone before it ever showed", () => {
    const script: LessonScript = {
      lessonId: "t",
      steps: [
        playCard({ id: "play", title: "Play it", text: "Play Mr. Vanilla.", defId: VANILLA }),
        info({ id: "next", title: "Next", text: "Next." }),
      ],
      tips: [],
    };
    const state = coachObserve(script, COACH_START, ctx(myTurn(3, []), [{ type: "endTurn" }]));
    expect(state.outcomes).toEqual({ play: "moot" });
    expect(activeStep(script, state)?.id).toBe("next");
  });

  it("R292 always lets the player skip, shown or waiting", () => {
    const script: LessonScript = {
      lessonId: "t",
      steps: [
        playCard({ id: "play", title: "Play it", text: "Play Mr. Vanilla.", defId: VANILLA }),
        info({ id: "next", title: "Next", text: "Next." }),
      ],
      tips: [],
    };
    // Waiting (the AI's turn): Skip still moves on.
    const waiting = coachObserve(script, COACH_START, ctx(aiTurnView(2), [], [], true));
    const skipped = coachSkip(script, waiting, ctx(aiTurnView(2), [], [], true));
    expect(skipped.outcomes).toEqual({ play: "skipped" });
    expect(activeStep(script, skipped)?.id).toBe("next");
    // Skipping the last step finishes the script.
    const done = coachSkip(script, skipped, ctx(aiTurnView(2), [], [], true));
    expect(done.finished).toBe(true);
    expect(coachDisplay(script, done, ctx(aiTurnView(2))).mode).toBe("finished");
  });

  it(`R292 expires a step still current after ${String(TUTORIAL_STEP_TURNS_MAX)} of the player's own turns, but never the final one`, () => {
    const never = (): boolean => false;
    const script: LessonScript = {
      lessonId: "t",
      steps: [
        info({ id: "stuck", title: "Stuck", text: "Waits for something that never comes.", when: never }),
        info({ id: "win", title: "Win", text: "Win the game.", final: true, when: never }),
      ],
      tips: [],
    };
    let state = COACH_START;
    let turn = 1;
    const cycle = (): void => {
      state = coachObserve(script, state, ctx(myTurn(turn)));
      turn += 1;
      state = coachObserve(script, state, ctx(aiTurnView(turn), [], [], true));
      turn += 1;
    };
    for (let i = 0; i < TUTORIAL_STEP_TURNS_MAX + 1; i += 1) cycle();
    state = coachObserve(script, state, ctx(myTurn(turn)));
    expect(state.outcomes["stuck"]).toBe("expired");
    expect(activeStep(script, state)).toBeNull();
    expect(state.index).toBe(1);

    // The final step waits for the game's end however long it takes.
    for (let i = 0; i < TUTORIAL_STEP_TURNS_MAX * 3; i += 1) cycle();
    expect(state.index).toBe(1);
    expect(state.finished).toBe(false);
  });

  it("R292 finishes when the game ends, whatever step it was on", () => {
    const script: LessonScript = {
      lessonId: "t",
      steps: [
        info({ id: "a", title: "A", text: "A." }),
        info({ id: "b", title: "B", text: "B." }),
      ],
      tips: [tip({ id: "t", title: "T", text: "T.", when: () => true })],
    };
    const over = myTurn(9, [], { result: { winner: "p1", reason: "hero-death" } });
    const state = coachObserve(script, coachObserve(script, COACH_START, ctx(myTurn(3))), ctx(over));
    expect(state.finished).toBe(true);
    expect(state.tipQueue).toEqual([]);
    expect(coachDisplay(script, state, ctx(over))).toEqual({ mode: "finished" });
    // Nothing moves a finished coach.
    expect(coachAck(script, state, ctx(over))).toBe(state);
    expect(coachSkip(script, state, ctx(over))).toBe(state);
    expect(coachObserve(script, state, ctx(myTurn(3)))).toBe(state);
  });

  it("R292 shows a tip once, ahead of the step, while the step's done is still watched", () => {
    const coin: GameEvent = { type: "cardPlayed", player: "p2", instanceId: "x", defId: "core-t-coin", costPaid: 0 };
    const script: LessonScript = {
      lessonId: "t",
      steps: [
        playCard({ id: "play", title: "Play it", text: "Play Mr. Vanilla.", defId: VANILLA }),
        endTurn({ id: "end", title: "End turn", text: "End your turn." }),
      ],
      tips: [
        tip({
          id: "coin",
          title: "The Coin",
          text: "The AI played The Coin.",
          holdAi: true,
          anchor: { kind: "hero", side: "opponent" },
          when: (c) => c.fresh.some((event) => event.type === "cardPlayed" && event.defId === "core-t-coin"),
        }),
      ],
    };
    const legal = [PLAY_VANILLA, { type: "endTurn" } as ActionBody];
    let state = coachObserve(script, COACH_START, ctx(myTurn(3), legal, [coin]));
    const shown = coachDisplay(script, state, ctx(myTurn(3), legal, [coin]));
    expect(shown.mode).toBe("tip");
    expect(shown.mode === "tip" && shown.holdAi && shown.ack).toBe(true);
    // No step is "active" for the tests while a tip is up.
    expect(activeStep(script, state)).toBeNull();

    // The player plays the card before reading the tip: the step still completes behind it.
    state = coachObserve(script, state, ctx(myTurn(3, []), [{ type: "endTurn" }], [coin]));
    expect(state.outcomes["play"]).toBe("done");
    expect(state.tipQueue).toEqual(["coin"]);

    // "Got it" drops the tip, and the same event never raises it again.
    state = coachAck(script, state, ctx(myTurn(3, []), [{ type: "endTurn" }]));
    expect(state.tipsSeen).toEqual(["coin"]);
    state = coachObserve(script, state, ctx(myTurn(3, []), [{ type: "endTurn" }], [coin]));
    expect(state.tipQueue).toEqual([]);
    expect(activeStep(script, state)?.id).toBe("end");
  });

  it("R292 reads a lesson predicate that throws as 'no' rather than stopping the game", () => {
    const script: LessonScript = {
      lessonId: "t",
      steps: [
        info({
          id: "broken",
          title: "Broken",
          text: "A buggy step.",
          when: () => {
            throw new Error("bug");
          },
        }),
      ],
      tips: [],
    };
    expect(() => coachObserve(script, COACH_START, ctx(myTurn(3)))).not.toThrow();
  });

  it("R292 keeps the mulligan step to the view's own prompt, answered with the engine's own mulligan action", () => {
    const hand = [card({ instanceId: "h1", defId: VANILLA }), card({ instanceId: "h2", defId: SHREDDER })];
    const mulligan = baseView({
      turn: 0,
      phase: "mulligan",
      you: emptySide("p1", { hand }),
      pending: pendingFor("mulligan", [
        { key: "h1", label: VANILLA, instanceId: "h1", defId: VANILLA },
        { key: "h2", label: SHREDDER, instanceId: "h2", defId: SHREDDER },
      ]),
    });
    const keepAll: ActionBody = { type: "mulligan", keep: ["h1", "h2"] };
    const keepOne: ActionBody = { type: "mulligan", keep: ["h1"] };
    const script: LessonScript = {
      lessonId: "t",
      steps: [keepHand({ id: "keep", title: "Keep", text: "Keep your hand." })],
      tips: [],
    };
    let state = coachObserve(script, COACH_START, ctx(mulligan, [keepAll, keepOne]));
    const step = activeStep(script, state);
    expect(step?.id).toBe("keep");
    expect(step?.expect?.(keepAll, ctx(mulligan))).toBe(true);
    expect(step?.expect?.(keepOne, ctx(mulligan))).toBe(false);
    const display = coachDisplay(script, state, ctx(mulligan));
    expect(display.mode === "step" ? coachTargets(display.anchor, mulligan) : null).toEqual(["prompt-modal"]);

    state = coachObserve(script, state, ctx(baseView({ turn: 0, phase: "mulligan", pending: { forYou: false, pendingFor: "p2" } })));
    expect(state.outcomes["keep"]).toBe("done");
  });
});
