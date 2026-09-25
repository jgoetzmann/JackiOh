// Test support, never loaded by the page: a lesson played in full through the REAL practice core
// (the engine, the card scripts and the AI the worker runs), with the coach reading every snapshot
// exactly as the page's coach does (R293).
//
// The human is played by a policy. `"coach"` is the lesson's own line: it answers every tip and
// info step with "Got it", does whatever the showing `act` step `expect`s, and falls back to the
// autopilot below only when the coach asks for nothing. `"random"` is a player who ignores the
// coach, drawing uniformly from the legal actions (never conceding or offering a draw) — the
// robustness case: the coach must neither throw nor stall, whatever the player does.
//
// The core runs with a frozen clock and the gates' budget, as core.test.ts does, so the AI's
// decisions are a pure function of the node budget and a game replays exactly.

import { AI_GATE_BUDGET } from "@jackioh/ai";
import { createRng } from "@jackioh/engine";
import type { Action, ActionBody, PlayerId, PlayerView } from "@jackioh/shared";

import { newEventsSince } from "../game/animations.ts";
import { createPracticeCore, type PracticeCore } from "../practice/core.ts";
import type { PracticeDebug, PracticeRequestBody, PracticeResponse, PracticeSnapshot } from "../practice/protocol.ts";
import {
  COACH_START,
  activeStep,
  coachAck,
  coachDisplay,
  coachObserve,
  type CoachCtx,
  type CoachState,
  type LessonScript,
  type StepOutcome,
} from "./coach.ts";
import { lessonById, type TutorialLesson } from "./lessons.ts";
import { scriptFor } from "./scripts/index.ts";
import { heroTargetId, myMain, mulliganOpen } from "./steps.ts";

/** Most requests one lesson game sends before the harness calls it stuck. */
const LESSON_REQUEST_CAP = 1500;

export type LessonPolicy = "coach" | "random";

export type LessonRun = {
  lesson: TutorialLesson;
  script: LessonScript;
  winner: PlayerId | "draw" | null;
  humanSeat: PlayerId;
  /** The human's own turns started. */
  humanTurns: number;
  /** How each step ended; a step missing here was never retired (the game ended on it). */
  outcomes: Readonly<Record<string, StepOutcome>>;
  /** Steps in the order they were first shown, with the player-turn each showed on. */
  shown: { id: string; turn: number }[];
  /** Tips in the order they showed. */
  tips: string[];
  /** The coach's state at the end. */
  coach: CoachState;
  /** The dev core's debug record: seed, decks, handicaps, log and hash. */
  debug: PracticeDebug;
  /** Every human action the policy sent, and whether the engine refused it. */
  humanActions: { action: ActionBody; refused: string | null; byCoach: boolean }[];
  /** The last view. */
  view: PlayerView;
};

type Options = {
  policy?: LessonPolicy;
  /** Default: the lesson's own. */
  seed?: string;
  /** For `"random"`: the policy's own stream. */
  policySeed?: string;
};

function isPlay(action: ActionBody): action is Extract<ActionBody, { type: "play" }> {
  return action.type === "play";
}

/** A target that belongs to the human: their own unit, or their own hero. */
function hitsOwnSide(view: PlayerView, action: Extract<ActionBody, { type: "play" }>): boolean {
  const own = new Set(view.you.units.filter((unit) => unit !== null).map((unit) => unit.instanceId));
  return (action.targets ?? []).some(
    (target) =>
      (target.pick === "instance" && own.has(target.instanceId)) || (target.pick === "hero" && target.player === view.viewer),
  );
}

/**
 * The autopilot: what a sensible beginner does when the coach asks for nothing. Keep the hand;
 * answer a prompt with its first option; play the dearest card it can (never aiming at its own
 * side), then attack — the hero when it may, else the first target — and end the turn.
 */
export function autopilot(ctx: CoachCtx): ActionBody | null {
  const { view, legal } = ctx;
  if (mulliganOpen(view)) {
    const keepAll = legal.filter((action) => action.type === "mulligan").sort((a, b) =>
      a.type === "mulligan" && b.type === "mulligan" ? b.keep.length - a.keep.length : 0,
    );
    return keepAll[0] ?? null;
  }
  if (view.pending !== null && view.pending.forYou) {
    return legal.find((action) => action.type === "answer") ?? legal.find((action) => action.type === "mulligan") ?? null;
  }
  if (!myMain(ctx)) return null;

  const hand = Array.isArray(view.you.hand) ? view.you.hand : [];
  const costOf = (instanceId: string): number => hand.find((card) => card.instanceId === instanceId)?.cost ?? 0;
  const plays = legal.filter(isPlay).filter((action) => !hitsOwnSide(view, action));
  plays.sort((a, b) => costOf(b.instanceId) - costOf(a.instanceId));
  const play = plays[0];
  if (play !== undefined) return play;

  const hero = heroTargetId(view, "opponent");
  const attacks = legal.filter((action): action is Extract<ActionBody, { type: "attack" }> => action.type === "attack");
  const face = attacks.find((action) => action.targetId === hero);
  if (face !== undefined) return face;
  if (attacks[0] !== undefined) return attacks[0];

  return legal.find((action) => action.type === "endTurn") ?? null;
}

/** A player who ignores the coach: uniform over the legal actions, never conceding or offering a draw. */
function randomPolicy(ctx: CoachCtx, pick: (n: number) => number): ActionBody | null {
  const choices = ctx.legal.filter((action) => action.type !== "concede" && action.type !== "offerDraw" && action.type !== "answerDraw");
  if (choices.length === 0) return null;
  return choices[pick(choices.length)] ?? null;
}

function send(core: PracticeCore, counter: { n: number }, body: PracticeRequestBody): PracticeResponse {
  counter.n += 1;
  return core.handle({ ...body, id: counter.n } as Parameters<PracticeCore["handle"]>[0]);
}

function snapshotOf(response: PracticeResponse): PracticeSnapshot {
  if (response.type === "started" || response.type === "snapshot") return response.snapshot;
  throw new Error(`the practice core answered ${response.type}: ${response.type === "failed" ? response.message : ""}`);
}

/** Play one lesson to the end under a policy, the coach reading every snapshot. */
export function playLesson(lessonId: string, options: Options = {}): LessonRun {
  const lesson = lessonById(lessonId);
  const script = scriptFor(lessonId);
  if (lesson === undefined || script === undefined) throw new Error(`no lesson "${lessonId}"`);
  const policy = options.policy ?? "coach";
  const rng = createRng(options.policySeed ?? `${lessonId}:policy`);

  const core = createPracticeCore({ now: () => 0, dev: true, budget: AI_GATE_BUDGET });
  const counter = { n: 0 };
  let snapshot = snapshotOf(
    send(core, counter, {
      type: "start",
      config: {
        seed: options.seed ?? lesson.seed,
        difficulty: "easy",
        humanSeat: lesson.humanSeat,
        deck: { kind: "random" },
        lesson: lesson.id,
      },
    }),
  );

  let coach: CoachState = COACH_START;
  let previous: PlayerView | null = null;
  const shown: { id: string; turn: number }[] = [];
  const tips: string[] = [];
  const humanActions: LessonRun["humanActions"] = [];
  let humanTurns = 0;
  let lastTurn = -1;

  const ctxOf = (snap: PracticeSnapshot): CoachCtx => ({
    view: snap.view,
    legal: snap.legal,
    fresh: previous === null ? [] : newEventsSince(previous.events, snap.view.events),
    aiToAct: snap.aiToAct,
  });

  for (;;) {
    if (counter.n > LESSON_REQUEST_CAP) throw new Error(`lesson "${lessonId}" did not end within ${LESSON_REQUEST_CAP} requests`);
    const ctx = ctxOf(snapshot);
    previous = snapshot.view;
    coach = coachObserve(script, coach, ctx);
    if (snapshot.view.turn !== lastTurn) {
      lastTurn = snapshot.view.turn;
      if (snapshot.view.active === snapshot.view.viewer && snapshot.view.phase === "main") humanTurns += 1;
    }

    // Read every tip and info step the way a player presses "Got it".
    let display = coachDisplay(script, coach, ctx);
    while (display.mode === "tip" || (display.mode === "step" && display.ack)) {
      const id = display.id;
      if (display.mode === "tip") tips.push(id);
      else if (!shown.some((entry) => entry.id === id)) shown.push({ id, turn: snapshot.view.turn });
      coach = coachAck(script, coach, ctx);
      display = coachDisplay(script, coach, ctx);
    }
    if (display.mode === "step") {
      const id = display.id;
      if (!shown.some((entry) => entry.id === id)) shown.push({ id, turn: snapshot.view.turn });
    }

    if (snapshot.view.result !== null) break;

    if (snapshot.aiToAct) {
      snapshot = snapshotOf(send(core, counter, { type: "aiStep" }));
      continue;
    }

    let action: ActionBody | null = null;
    let byCoach = false;
    if (policy === "coach") {
      const step = activeStep(script, coach);
      if (step?.kind === "act" && step.expect !== undefined) {
        const expected = step.expect;
        action = snapshot.legal.find((candidate) => expected(candidate, ctx)) ?? null;
        byCoach = action !== null;
      }
      action ??= autopilot(ctx);
    } else {
      action = randomPolicy(ctx, (n) => rng.int(n));
    }
    if (action === null) {
      // Nothing the human can do and the AI owes nothing: the engine is waiting on no one.
      throw new Error(`lesson "${lessonId}" stalled on turn ${String(snapshot.view.turn)}: no human action and no AI step`);
    }
    const next = snapshotOf(send(core, counter, { type: "act", action }));
    humanActions.push({ action, refused: next.error, byCoach });
    snapshot = next;
  }

  const debugResponse = send(core, counter, { type: "debug" });
  if (debugResponse.type !== "debug") throw new Error("the dev core refused debug");
  return {
    lesson,
    script,
    winner: snapshot.view.result?.winner ?? null,
    humanSeat: lesson.humanSeat,
    humanTurns,
    outcomes: coach.outcomes,
    shown,
    tips,
    coach,
    debug: debugResponse.debug,
    humanActions,
    view: snapshot.view,
  };
}

/** The human actions a run sent, as the log's actions (for a replay check). */
export function humanLog(run: LessonRun): Action[] {
  return run.debug.log.filter((action) => action.playerId === run.humanSeat);
}
