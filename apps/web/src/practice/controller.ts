// The practice game as the page drives it: one host, one request in flight, and the pacing loop
// that plays the AI's turn one visible action at a time (SPEC §9.9).
//
// Framework-free, so it tests with fake timers and a scripted host, and the route only subscribes.
// It holds snapshots and never a state (CLAUDE.md rule 7): whatever the host answered last is what
// the page renders.
//
// The pacing loop. After every snapshot whose `aiToAct` is true (and the game is not over),
// `thinking` goes true, the controller waits one gap and then sends one `aiStep`, and repeats. The
// gap is `promptAnswerMs` when the view shows a prompt waiting on the AI — its own opening mulligan
// included, which is open at the same time as the human's (R265), so the AI answers it at once
// rather than after the turn's longer first pause — `firstActionMs` for the AI's first step since
// `view.turn` changed, and `actionGapMs` otherwise. `thinking` goes false as
// soon as a snapshot has `aiToAct === false`. Every request — the human's actions, the AI's steps,
// `debug` — goes through one queue, so at most one is ever in flight, and a human action sent while
// the AI is mid-step waits behind it.
//
// Nothing here ever waits on the human. During the mulligan both seats owe an answer: the AI's step
// goes out on its own gap, and the human's Ready goes out whenever it is pressed — before the AI's
// step, queued behind it, or after it — and neither answer changes the other (R266).
//
// The gap starts when the board has caught up. The board holds each new view back while its
// events animate (BUILD M5-T4), so a timer alone runs the AI ahead of what the player can see:
// measured with animations on, the AI finished its whole first turn while the board was still
// drawing the mulligan, and "AI is thinking…" went out seconds before the board showed its last
// play. The page reports `setBoardBusy(true)` while anything animates; no step is scheduled while
// it is busy, a step already waiting is re-planned, and the gap is timed from the moment it idles.
// A page that never reports keeps the plain timer.
//
// The board is one reason to hold the AI back; a voice line is another (polish task 2 speaks a
// card's play and death lines, which run past the animation). `setHold(reason, held)` is the
// general form: the AI's next step waits while any reason is held, and `setBoardBusy(busy)` is
// `setHold("board", busy)`. The route turns the page's `data-speaking` attribute into
// `setHold("voice", …)` (routes/practice.tsx), so the audio layer needs no handle on this
// controller: it marks an element while a line plays and clears it when the line ends.

import type { ActionBody, CardDefs, PlayerId, PlayerView } from "@jackioh/shared";

import type { PracticePacing } from "./config.ts";
import type { PracticeHost } from "./host.ts";
import type {
  PracticeDebug,
  PracticeRequestBody,
  PracticeResponse,
  PracticeSnapshot,
  PracticeStartConfig,
} from "./protocol.ts";

type PracticePhase = "idle" | "starting" | "playing" | "over" | "failed";

export type PracticeControllerState = {
  phase: PracticePhase;
  config: PracticeStartConfig | null;
  aiSeat: PlayerId | null;
  defs: CardDefs | null;
  snapshot: PracticeSnapshot | null;
  thinking: boolean;
  failure: string | null;
};

export type PracticeTimers = {
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

export type PracticeController = {
  getState(): PracticeControllerState;
  subscribe(fn: () => void): () => void;
  start(config: PracticeStartConfig): Promise<void>;
  /** Queued behind any in-flight request. */
  act(action: ActionBody): void;
  /** Whether the board is still animating a view; the AI's next step waits until it is not. */
  setBoardBusy(busy: boolean): void;
  /**
   * Hold the AI's next step for a named reason ("board", "voice", …) until the same reason is
   * released; a step waits while any reason is held. Holding a reason twice is holding it once.
   */
  setHold(reason: string, held: boolean): void;
  debug(): Promise<PracticeDebug>;
  dispose(): void;
};

type PracticeControllerOptions = { host: PracticeHost; pacing: PracticePacing; timers?: PracticeTimers };

export const PRACTICE_IDLE_STATE: PracticeControllerState = {
  phase: "idle",
  config: null,
  aiSeat: null,
  defs: null,
  snapshot: null,
  thinking: false,
  failure: null,
};

const CLOSED_MESSAGE = "the practice game was closed";

/** Looked up on every call, so `vi.useFakeTimers()` installed after creation still applies. */
const globalTimers: PracticeTimers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => {
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout>);
  },
};

type Job = { body: PracticeRequestBody; done: (response: PracticeResponse) => void };

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function unexpected(response: PracticeResponse): string {
  return response.type === "failed" ? response.message : `the practice worker answered "${response.type}" unexpectedly`;
}

export function createPracticeController(options: PracticeControllerOptions): PracticeController {
  const { host, pacing } = options;
  const timers = options.timers ?? globalTimers;

  let state: PracticeControllerState = PRACTICE_IDLE_STATE;
  const listeners = new Set<() => void>();
  const jobs: Job[] = [];
  let inFlight = false;
  let disposed = false;
  /** Bumped by every `start`, so an answer that belongs to an earlier game is dropped. */
  let generation = 0;

  let timer: unknown = null;
  let timerPending = false;
  /** `view.turn` when the last `aiStep` was sent; null before the first one. */
  let lastStepTurn: number | null = null;
  /** What the page is still showing (the board animating, a voice line): no AI step until it is done. */
  const holds = new Set<string>();

  function set(patch: Partial<PracticeControllerState>): void {
    if (disposed) return;
    state = { ...state, ...patch };
    for (const fn of [...listeners]) fn();
  }

  function clearTimer(): void {
    if (!timerPending) return;
    timers.clearTimeout(timer);
    timer = null;
    timerPending = false;
  }

  // -------------------------------------------------------------------------------------------
  // the queue: one request in flight
  // -------------------------------------------------------------------------------------------

  function send(body: PracticeRequestBody, done: (response: PracticeResponse) => void): void {
    jobs.push({ body, done });
    pump();
  }

  function pump(): void {
    if (disposed || inFlight) return;
    const job = jobs.shift();
    if (job === undefined) {
      scheduleAiStep();
      return;
    }
    inFlight = true;
    let request: Promise<PracticeResponse>;
    try {
      request = host.request(job.body);
    } catch (cause) {
      request = Promise.resolve({ id: -1, type: "failed", message: messageOf(cause) });
    }
    // `pump` runs even when a handler throws (a listener that throws must not stall the queue).
    const finish = (response: PracticeResponse): void => {
      inFlight = false;
      try {
        job.done(response);
      } finally {
        pump();
      }
    };
    request.then(finish, (cause: unknown) => {
      finish({ id: -1, type: "failed", message: messageOf(cause) });
    });
  }

  // -------------------------------------------------------------------------------------------
  // snapshots and the pacing loop
  // -------------------------------------------------------------------------------------------

  function applySnapshot(snapshot: PracticeSnapshot, extra: Partial<PracticeControllerState> = {}): void {
    if (snapshot.view.result !== null) {
      clearTimer();
      set({ ...extra, snapshot, phase: "over", thinking: false });
      return;
    }
    if (!snapshot.aiToAct) {
      clearTimer();
      set({ ...extra, snapshot, phase: "playing", thinking: false });
      return;
    }
    set({ ...extra, snapshot, phase: "playing", thinking: true });
    // The step itself is scheduled by `pump` once the queue is empty, so a human action already
    // queued behind this answer goes first and the gap is measured from the newest snapshot.
  }

  function gapFor(view: PlayerView): number {
    const pending = view.pending;
    if (pending !== null && !pending.forYou && pending.pendingFor === state.aiSeat) return pacing.promptAnswerMs;
    // R265: the AI's mulligan is still open while the human looks at its own.
    if (view.mulligan !== undefined && !view.mulligan.opponentReady) return pacing.promptAnswerMs;
    if (lastStepTurn !== view.turn) return pacing.firstActionMs;
    return pacing.actionGapMs;
  }

  function scheduleAiStep(): void {
    if (disposed || holds.size > 0 || timerPending || inFlight || jobs.length > 0) return;
    const snapshot = state.snapshot;
    if (state.phase !== "playing" || snapshot === null || !snapshot.aiToAct) return;

    const gen = generation;
    const ms = gapFor(snapshot.view);
    timerPending = true;
    timer = timers.setTimeout(() => {
      timer = null;
      timerPending = false;
      if (disposed || gen !== generation) return;
      const latest = state.snapshot;
      if (state.phase !== "playing" || latest === null || !latest.aiToAct) return;
      lastStepTurn = latest.view.turn;
      send({ type: "aiStep" }, (response) => onSnapshotResponse(gen, response));
    }, ms);
  }

  function setHold(reason: string, held: boolean): void {
    if (disposed || held === holds.has(reason)) return;
    if (held) holds.add(reason);
    else holds.delete(reason);
    // A step waiting on its gap is re-planned once nothing is held, from the full gap.
    if (held) clearTimer();
    else scheduleAiStep();
  }

  function onSnapshotResponse(gen: number, response: PracticeResponse): void {
    if (disposed || gen !== generation) return;
    if (response.type === "snapshot") {
      applySnapshot(response.snapshot);
      return;
    }
    clearTimer();
    set({ phase: "failed", thinking: false, failure: unexpected(response) });
  }

  // -------------------------------------------------------------------------------------------
  // the public surface
  // -------------------------------------------------------------------------------------------

  return {
    getState(): PracticeControllerState {
      return state;
    },

    subscribe(fn: () => void): () => void {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },

    start(config: PracticeStartConfig): Promise<void> {
      if (disposed) return Promise.resolve();
      generation += 1;
      const gen = generation;
      clearTimer();
      lastStepTurn = null;
      // Anything still queued belongs to the previous game.
      const dropped = jobs.splice(0);
      for (const job of dropped) job.done({ id: -1, type: "failed", message: CLOSED_MESSAGE });
      set({ ...PRACTICE_IDLE_STATE, phase: "starting", config });

      return new Promise<void>((resolve) => {
        send({ type: "start", config }, (response) => {
          if (!disposed && gen === generation) {
            if (response.type === "started") {
              applySnapshot(response.snapshot, { aiSeat: response.aiSeat, defs: response.defs, failure: null });
            } else {
              set({ phase: "failed", thinking: false, failure: unexpected(response) });
            }
          }
          resolve();
        });
      });
    },

    act(action: ActionBody): void {
      if (disposed) return;
      if (state.phase !== "playing" && state.phase !== "starting") return;
      // A pending AI step is re-planned after this action's snapshot, from the newest view.
      clearTimer();
      const gen = generation;
      send({ type: "act", action }, (response) => onSnapshotResponse(gen, response));
    },

    setBoardBusy(busy: boolean): void {
      setHold("board", busy);
    },

    setHold,

    debug(): Promise<PracticeDebug> {
      return new Promise<PracticeDebug>((resolve, reject) => {
        if (disposed) {
          reject(new Error(CLOSED_MESSAGE));
          return;
        }
        send({ type: "debug" }, (response) => {
          if (response.type === "debug") resolve(response.debug);
          else reject(new Error(unexpected(response)));
        });
      });
    },

    dispose(): void {
      if (disposed) return;
      clearTimer();
      disposed = true;
      const dropped = jobs.splice(0);
      for (const job of dropped) job.done({ id: -1, type: "failed", message: CLOSED_MESSAGE });
      listeners.clear();
      host.dispose();
    },
  };
}
