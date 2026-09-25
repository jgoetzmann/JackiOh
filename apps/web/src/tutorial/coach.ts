// The tutorial's coach: which step of a lesson's script is showing, and what it points at
// (SPEC §9.10, R292).
//
// Pure and framework-free, so a test can drive it exactly as the page does. It reads what the page
// already holds — the human's `PlayerView`, the human's `legalActions` and whether the AI owes an
// action — and nothing else, so it can say no more than the board shows (CLAUDE.md rule 7). It
// never decides what is legal: a step that asks for an action points at it and waits, and the
// engine accepts or refuses whatever the player does, exactly as in any other game.
//
// A lesson's script is two lists (`LessonScript`):
//
//  - `steps`, in order. The coach works through them one at a time. A step first waits until its
//    `when` holds (default: at once), then shows — it is *active* from then on, and `since` holds the
//    view it activated on. An `info` step is completed by "Got it" (`coachAck`), or by its own
//    `done` if it has one. An `act` step is completed by its `done`, checked on every view,
//    including the one it activates on, so a player who has already done what it asks is never
//    asked. `moot` retires a step that no longer makes sense (the card it names has died, the turn
//    it was about has ended) without a word.
//  - `tips`, reactive. A tip shows once, the first time its `when` holds on a view — the AI's Taunt
//    unit arriving, a trap springing — and goes when the player presses "Got it" or "Skip". While a
//    tip is up, the current step waits behind it, but its `done` is still checked, so nothing the
//    player does meanwhile is lost.
//
// Nothing can strand the player. "Skip step" (`coachSkip`) always moves on, and a step that has
// been current through `TUTORIAL_STEP_TURNS_MAX` of the player's own turn starts expires by itself
// (a `final` step, the lesson's last, never expires: it ends with the game). When the game is over
// the coach is finished, whatever step it was on.

import type { ActionBody, GameEvent, PlayerView, Row } from "@jackioh/shared";

import type { Side } from "../game/contract.ts";
import { TUTORIAL_STEP_TURNS_MAX } from "./config.ts";

/** Everything the coach reads, all of it already the page's. */
export type CoachCtx = {
  /** viewFor(state, human): the newest snapshot's view. */
  view: PlayerView;
  /** legalActions(state, human). */
  legal: readonly ActionBody[];
  /** The events that arrived with this view: new since the previous view the coach read. */
  fresh: readonly GameEvent[];
  /** Whether the AI owes an action (the snapshot's `aiToAct`). */
  aiToAct: boolean;
};

/**
 * What a step points at, in the board's own vocabulary. `coachTargets` turns it into the
 * `data-testid`s the board already renders (game/contract.ts), so the coach mark never needs a
 * hook into the board.
 */
export type CoachAnchor =
  /** The human's hand card of this definition (a deck holds each card once, §2.6). */
  | { kind: "handCard"; defId: string }
  /** The human's whole hand. */
  | { kind: "hand" }
  /** A unit of this definition on that side of the field. */
  | { kind: "unit"; side: Side; defId: string }
  /** That side's five unit zones. */
  | { kind: "units"; side: Side }
  /** That side's five backrow zones, or one of them. */
  | { kind: "backrow"; side: Side; lane?: number }
  /** One zone. */
  | { kind: "zone"; side: Side; row: Row; lane: number }
  | { kind: "hero"; side: Side }
  /** The human's mana crystals. */
  | { kind: "mana" }
  | { kind: "endTurn" }
  /** The open prompt or picker (the mulligan, a Discover, a target picker). */
  | { kind: "prompt" }
  | { kind: "library"; side: Side }
  | { kind: "graveyard"; side: Side };

type Text = string | ((ctx: CoachCtx) => string);
type AnchorOf = CoachAnchor | null | ((ctx: CoachCtx) => CoachAnchor | null);

export type CoachStep = {
  /** Unique within its lesson; tests and the page's `data-coach-step` name it. */
  id: string;
  /** A few words: the bubble's heading. */
  title: string;
  /** One or two short sentences of plain language. */
  text: Text;
  anchor?: AnchorOf;
  /** `info`: "Got it" completes it. `act`: its `done` completes it. */
  kind: "info" | "act";
  /** It may show only while this holds. Default: always. Checked until the step activates. */
  when?: (ctx: CoachCtx) => boolean;
  /** Complete. `since` is the view the step activated on. Required for `act` steps. */
  done?: (ctx: CoachCtx, since: PlayerView) => boolean;
  /** No longer makes sense: retired without a word. `since` is null while the step still waits. */
  moot?: (ctx: CoachCtx, since: PlayerView | null) => boolean;
  /**
   * What the step asks the player to do, as a test over the human's legal actions. The page never
   * reads it to decide anything; the lesson tests follow it to prove the lesson can be won by doing
   * what the coach says (R293), and the page may point at the card it names.
   */
  expect?: (action: ActionBody, ctx: CoachCtx) => boolean;
  /** Hold the AI's next step while this step shows, so the player can read it first. */
  holdAi?: boolean;
  /** The lesson's last step: it never expires, it ends with the game. */
  final?: boolean;
};

export type CoachTip = {
  id: string;
  title: string;
  text: Text;
  anchor?: AnchorOf;
  /** Shown once, on the first view where this holds. */
  when: (ctx: CoachCtx) => boolean;
  /** Hold the AI's next step while the tip shows. */
  holdAi?: boolean;
};

export type LessonScript = {
  lessonId: string;
  steps: readonly CoachStep[];
  tips: readonly CoachTip[];
};

export type StepOutcome = "done" | "skipped" | "moot" | "expired";

export type CoachState = {
  /** The current step's index; `steps.length` once the script is through. */
  index: number;
  /** The view the current step activated on; null while it waits for its `when`. */
  since: PlayerView | null;
  /** The player's own turn starts seen while the current step has been current. */
  turnsOnStep: number;
  /** How each step before `index` ended. */
  outcomes: Readonly<Record<string, StepOutcome>>;
  /** Tips already shown (or dismissed), in order. */
  tipsSeen: readonly string[];
  /** Tips triggered and waiting to show, the first one showing. */
  tipQueue: readonly string[];
  /** The last view's `turn`, to count the player's own turn starts. */
  lastTurn: number | null;
  /** The game is over, or the script is through. */
  finished: boolean;
};

export const COACH_START: CoachState = {
  index: 0,
  since: null,
  turnsOnStep: 0,
  outcomes: {},
  tipsSeen: [],
  tipQueue: [],
  lastTurn: null,
  finished: false,
};

export function textOf(text: Text, ctx: CoachCtx): string {
  return typeof text === "function" ? text(ctx) : text;
}

export function anchorOf(anchor: AnchorOf | undefined, ctx: CoachCtx): CoachAnchor | null {
  if (anchor === undefined || anchor === null) return null;
  return typeof anchor === "function" ? anchor(ctx) : anchor;
}

/** A predicate that throws is a lesson bug; the coach reads it as "no" rather than stopping the game. */
function safely(test: () => boolean): boolean {
  try {
    return test();
  } catch {
    return false;
  }
}

function retire(state: CoachState, step: CoachStep, outcome: StepOutcome): CoachState {
  return {
    ...state,
    index: state.index + 1,
    since: null,
    turnsOnStep: 0,
    outcomes: { ...state.outcomes, [step.id]: outcome },
  };
}

/**
 * Walk the steps from `state.index` on the newest view: retire what is moot or already done,
 * activate what may show, stop at the first step that waits or is showing.
 */
function settleSteps(script: LessonScript, start: CoachState, ctx: CoachCtx): CoachState {
  let state = start;
  // Each pass either stops or retires one step, so this ends within steps.length passes.
  for (;;) {
    const step = script.steps[state.index];
    if (step === undefined) return { ...state, finished: true, since: null };

    const since = state.since;
    if (step.moot !== undefined && safely(() => step.moot?.(ctx, since) === true)) {
      state = retire(state, step, "moot");
      continue;
    }

    if (since === null) {
      if (step.when !== undefined && !safely(() => step.when?.(ctx) === true)) return state;
      state = { ...state, since: ctx.view };
    }

    const activeSince = state.since ?? ctx.view;
    if (step.done !== undefined && safely(() => step.done?.(ctx, activeSince) === true)) {
      state = retire(state, step, "done");
      continue;
    }
    return state;
  }
}

/** The player's own turn has just started on this view. */
function ownTurnStarted(state: CoachState, view: PlayerView): boolean {
  return state.lastTurn !== null && view.turn !== state.lastTurn && view.active === view.viewer;
}

/**
 * Read one new snapshot. Call it for every snapshot the page receives, in order (the first one
 * included), with the events that arrived with it.
 */
export function coachObserve(script: LessonScript, current: CoachState, ctx: CoachCtx): CoachState {
  if (current.finished) return current;
  if (ctx.view.result !== null) {
    return { ...current, finished: true, since: null, tipQueue: [], lastTurn: ctx.view.turn };
  }

  let state: CoachState = current;

  // Expiry: a step current through too many of the player's own turns goes by itself.
  if (ownTurnStarted(state, ctx.view)) {
    const turns = state.turnsOnStep + 1;
    const step = script.steps[state.index];
    if (step !== undefined && step.final !== true && turns > TUTORIAL_STEP_TURNS_MAX) {
      state = retire(state, step, "expired");
    } else {
      state = { ...state, turnsOnStep: turns };
    }
  }
  state = { ...state, lastTurn: ctx.view.turn };

  // Tips: each shows once, queued in script order behind any already waiting.
  const queued = new Set([...state.tipsSeen, ...state.tipQueue]);
  const triggered = script.tips.filter((tip) => !queued.has(tip.id) && safely(() => tip.when(ctx)));
  if (triggered.length > 0) state = { ...state, tipQueue: [...state.tipQueue, ...triggered.map((tip) => tip.id)] };

  return settleSteps(script, state, ctx);
}

function dropTip(state: CoachState): CoachState {
  const [shown, ...rest] = state.tipQueue;
  if (shown === undefined) return state;
  return { ...state, tipQueue: rest, tipsSeen: [...state.tipsSeen, shown] };
}

/** "Got it": the tip showing goes, else the showing `info` step is done. */
export function coachAck(script: LessonScript, state: CoachState, ctx: CoachCtx): CoachState {
  if (state.finished) return state;
  if (state.tipQueue.length > 0) return dropTip(state);
  const step = script.steps[state.index];
  if (step === undefined || state.since === null || step.kind !== "info") return state;
  return settleSteps(script, retire(state, step, "done"), ctx);
}

/** "Skip step": the tip showing goes, else the current step, shown or waiting. */
export function coachSkip(script: LessonScript, state: CoachState, ctx: CoachCtx): CoachState {
  if (state.finished) return state;
  if (state.tipQueue.length > 0) return dropTip(state);
  const step = script.steps[state.index];
  if (step === undefined) return state;
  return settleSteps(script, retire(state, step, "skipped"), ctx);
}

export type CoachDisplay =
  | { mode: "finished" }
  /** Nothing to show yet: the current step waits for its `when` (the AI's turn, say). */
  | { mode: "waiting"; stepNumber: number; stepCount: number; aiToAct: boolean }
  | {
      mode: "tip" | "step";
      id: string;
      title: string;
      text: string;
      anchor: CoachAnchor | null;
      /** A "Got it" button: every tip, and an `info` step. */
      ack: boolean;
      holdAi: boolean;
      stepNumber: number;
      stepCount: number;
    };

/** What the coach shows on this view. */
export function coachDisplay(script: LessonScript, state: CoachState, ctx: CoachCtx): CoachDisplay {
  if (state.finished || ctx.view.result !== null) return { mode: "finished" };
  const stepCount = script.steps.length;
  const stepNumber = Math.min(state.index + 1, stepCount);

  const tipId = state.tipQueue[0];
  const tip = tipId === undefined ? undefined : script.tips.find((candidate) => candidate.id === tipId);
  if (tip !== undefined) {
    return {
      mode: "tip",
      id: tip.id,
      title: tip.title,
      text: textOf(tip.text, ctx),
      anchor: anchorOf(tip.anchor, ctx),
      ack: true,
      holdAi: tip.holdAi === true,
      stepNumber,
      stepCount,
    };
  }

  const step = script.steps[state.index];
  if (step === undefined) return { mode: "finished" };
  if (state.since === null) return { mode: "waiting", stepNumber, stepCount, aiToAct: ctx.aiToAct };
  return {
    mode: "step",
    id: step.id,
    title: step.title,
    text: textOf(step.text, ctx),
    anchor: anchorOf(step.anchor, ctx),
    ack: step.kind === "info",
    holdAi: step.holdAi === true,
    stepNumber,
    stepCount,
  };
}

/** The step the coach is on, when it is showing (for the tests that follow the coach). */
export function activeStep(script: LessonScript, state: CoachState): CoachStep | null {
  if (state.finished || state.since === null || state.tipQueue.length > 0) return null;
  return script.steps[state.index] ?? null;
}
