// The coach, fed: every snapshot the practice controller receives goes into `coachObserve`, in
// order, and the page subscribes to what it shows (SPEC §9.10, R292).
//
// Framework-free, and created in the same effect as the controller it reads, before the game's
// `start` is sent. That is what guarantees the coach reads EVERY snapshot: the controller keeps only
// its newest one, so a subscriber that arrived a render later could miss the first (the deal) or
// fold two snapshots' events into one. `fresh` is computed the way the board and the lesson harness
// compute it (`newEventsSince` against the previous view the coach read; nothing for the first).
//
// The AI hold lives here too, for the same reason. A step or tip with `holdAi` holds the AI's next
// step (`setHold("coach", …)`) from the moment the snapshot that shows it arrives, synchronously,
// before the controller can schedule that step. The page shows a new display only once the board
// has caught up (Coach.tsx), and while the board animates the controller is held by the board
// anyway, so holding on the newest display holds exactly while the shown one asks for it.
//
// Rule 7: the tracker reads what the page already holds (the view, the legal actions, `aiToAct`)
// and never sends an action.

import type { ActionBody } from "@jackioh/shared";

import { newEventsSince } from "../game/animations.ts";
import type { PracticeController } from "../practice/controller.ts";
import type { PracticeSnapshot } from "../practice/protocol.ts";
import {
  COACH_START,
  activeStep,
  coachAck,
  coachDisplay,
  coachObserve,
  coachSkip,
  type CoachCtx,
  type CoachDisplay,
  type CoachState,
  type LessonScript,
} from "./coach.ts";
import { myMain } from "./steps.ts";
import { coachTargets } from "./targets.ts";

/** What the tracker needs of the controller. */
export type CoachSource = Pick<PracticeController, "getState" | "subscribe" | "setHold">;

/** The controller's hold reason for the coach. */
export const COACH_HOLD = "coach";

export type CoachView = {
  coach: CoachState;
  /** The newest snapshot's context; null before the first snapshot. */
  ctx: CoachCtx | null;
  display: CoachDisplay;
  /** The display's anchor as the board's testids (empty for none). */
  targets: readonly string[];
  /** It is the AI's turn, or the AI owes an answer: what the waiting bubble says. */
  aiBusy: boolean;
  /**
   * The human's own main phase, nothing open: the waiting bubble says whose move it is, and has no
   * Skip step (a step waiting on its moment retires by itself, TUTORIAL_STEP_TURNS_MAX).
   */
  yourMove: boolean;
};

export type CoachTracker = {
  readonly script: LessonScript;
  getState(): CoachView;
  subscribe(fn: () => void): () => void;
  /**
   * "Got it". With `expected` (a `displayKey`), only while that display is still the coach's: a
   * press on a bubble the board has not caught up with yet never answers one the player has not seen.
   */
  ack(expected?: string): void;
  /** "Skip step", guarded the same way. */
  skip(expected?: string): void;
  dispose(): void;
};

const FINISHED: CoachDisplay = { mode: "finished" };

/** One display's identity: its mode and its step or tip id. */
export function displayKey(display: CoachDisplay): string {
  return display.mode === "tip" || display.mode === "step" ? `${display.mode}:${display.id}` : display.mode;
}

function viewOf(coach: CoachState, ctx: CoachCtx | null, script: LessonScript): CoachView {
  if (ctx === null) return { coach, ctx, display: FINISHED, targets: [], aiBusy: false, yourMove: false };
  const display = coachDisplay(script, coach, ctx);
  const anchor = display.mode === "tip" || display.mode === "step" ? display.anchor : null;
  const view = ctx.view;
  return {
    coach,
    ctx,
    display,
    targets: coachTargets(anchor, view),
    aiBusy: ctx.aiToAct || (view.result === null && view.active !== view.viewer),
    yourMove: myMain(ctx),
  };
}

function holdsAi(display: CoachDisplay): boolean {
  return (display.mode === "tip" || display.mode === "step") && display.holdAi;
}

export function createCoachTracker(source: CoachSource, script: LessonScript): CoachTracker {
  let coach: CoachState = COACH_START;
  let ctx: CoachCtx | null = null;
  let lastSnapshot: PracticeSnapshot | null = null;
  let state: CoachView = viewOf(coach, ctx, script);
  let held = false;
  let disposed = false;
  const listeners = new Set<() => void>();

  function hold(next: boolean): void {
    if (next === held) return;
    held = next;
    source.setHold(COACH_HOLD, next);
  }

  function publish(): void {
    state = viewOf(coach, ctx, script);
    hold(!disposed && holdsAi(state.display));
    for (const fn of [...listeners]) fn();
  }

  function observe(): void {
    if (disposed) return;
    const snapshot = source.getState().snapshot;
    if (snapshot === null || snapshot === lastSnapshot) return;
    const previous = lastSnapshot?.view ?? null;
    lastSnapshot = snapshot;
    const defs = source.getState().defs;
    ctx = {
      view: snapshot.view,
      legal: snapshot.legal,
      fresh: previous === null ? [] : newEventsSince(previous.events, snapshot.view.events),
      aiToAct: snapshot.aiToAct,
      // §5.1: the catalog is public; the worker sent it with the game (`started`).
      nameOf: (defId) => snapshot.view.defs?.[defId]?.name ?? defs?.[defId]?.name,
    };
    coach = coachObserve(script, coach, ctx);
    publish();
  }

  const unsubscribe = source.subscribe(observe);
  observe();

  return {
    script,
    getState: () => state,
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    ack(expected) {
      if (disposed || ctx === null) return;
      if (expected !== undefined && expected !== displayKey(state.display)) return;
      const next = coachAck(script, coach, ctx);
      if (next === coach) return;
      coach = next;
      publish();
    },
    skip(expected) {
      if (disposed || ctx === null) return;
      if (expected !== undefined && expected !== displayKey(state.display)) return;
      const next = coachSkip(script, coach, ctx);
      if (next === coach) return;
      coach = next;
      publish();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      hold(false);
      listeners.clear();
    },
  };
}

/**
 * The first of the human's legal actions the showing step `expect`s, or null (no step showing, a
 * tip in front of it, or a step that asks for nothing). Only the dev handle reads it (the e2e spec
 * performs it through the real UI); the page never acts on it.
 */
export function suggestedAction(script: LessonScript, state: CoachView): ActionBody | null {
  const ctx = state.ctx;
  if (ctx === null) return null;
  const step = activeStep(script, state.coach);
  const expect = step?.expect;
  if (expect === undefined) return null;
  return (
    ctx.legal.find((action) => {
      try {
        return expect(action, ctx);
      } catch {
        return false;
      }
    }) ?? null
  );
}

/** A script with nothing to say: a lesson whose script is missing still plays, uncoached. */
export function silentScript(lessonId: string): LessonScript {
  return { lessonId, steps: [], tips: [] };
}
