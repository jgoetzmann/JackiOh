// Every number the practice route states (CLAUDE.md rule 9). The rules numbers — the AI seat's
// handicap per difficulty — are the engine's (`AI_DIFFICULTY` in `packages/engine/src/config.ts`,
// SPEC §9.9); these are the browser's own: pacing, the wall-clock cap on one AI decision, and what
// the setup screen remembers between visits.

import type { Difficulty } from "@jackioh/engine/config";

import { FX_LETHAL_LEAD_MAX_MS, FX_RESULT_MS } from "../fx/constants.ts";

/**
 * The gaps the controller leaves before each AI step, so a human can watch the AI play one action
 * at a time (animations and task 2's voice lines need the room; a voice line also holds the AI
 * through `data-speaking`, see PRACTICE_VOICE_HOLD_MAX_MS). `firstActionMs` is the pause
 * before the AI's first step of a turn, `actionGapMs` the pause between its later steps, and
 * `promptAnswerMs` the pause before it answers a prompt that is waiting on it.
 */
export type PracticePacing = {
  firstActionMs: number;
  actionGapMs: number;
  promptAnswerMs: number;
  /**
   * How long the result dialog waits once the game is over, so it opens on the board's own
   * game-over sequence rather than over it (task 1's killing blow and Victory or Defeat, R200).
   * Absent: at once. The route also opens it at once when the effects are off.
   */
  resultDelayMs?: number;
};

/**
 * Each gap is timed from the moment the board has finished animating the AI's last step (the
 * controller waits for `setBoardBusy(false)`), so the animation itself is the first part of the
 * pause and the gap only has to let the player take the result in. The turn's first step waits
 * longest, so "Enemy turn" registers before anything moves.
 */
export const PRACTICE_PACING: PracticePacing = {
  firstActionMs: 800,
  actionGapMs: 550,
  promptAnswerMs: 450,
  // The killing blow replays in at most FX_LETHAL_LEAD_MAX_MS, then the result plays in FX_RESULT_MS.
  resultDelayMs: FX_LETHAL_LEAD_MAX_MS + FX_RESULT_MS,
};

/**
 * The longest one voice line may hold the AI back (routes/practice.tsx `useVoiceHold`): a play or
 * death line runs one to two seconds, and a mark the audio layer forgets to clear must not stop
 * the game.
 */
export const PRACTICE_VOICE_HOLD_MAX_MS = 4000;

/**
 * The longest the opponent's-play showcase may hold the AI back (routes/practice.tsx
 * `useShowcaseHold`): one card is held up for about a second (SHOWCASE_HOLD_MS, divided by the
 * effects speed), and a step that plays several cards queues at most SHOWCASE_QUEUE_MAX of them. A
 * mark that is never cleared must not stop the game.
 */
export const PRACTICE_SHOWCASE_HOLD_MAX_MS = 4000;

/** `prefers-reduced-motion`: nothing is animating, so there is nothing to wait for. */
export const PRACTICE_PACING_REDUCED: PracticePacing = { firstActionMs: 150, actionGapMs: 150, promptAnswerMs: 100 };

/** `?pace=fast`, honoured only when MODE !== "production" (e2e). */
export const PRACTICE_PACING_FAST: PracticePacing = { firstActionMs: 0, actionGapMs: 30, promptAnswerMs: 0 };

/** The wall-clock safety cap on one AI decision, in the worker (`AiOptions.shouldStop`). */
export const PRACTICE_AI_CLOCK_MS = 1500;

/** localStorage: `{ difficulty, deck }`, read and written inside try/catch. */
export const PRACTICE_SETUP_KEY = "jackioh.practice.setup";

export const PRACTICE_DEFAULT_DIFFICULTY: Difficulty = "easy";

/** A fresh practice seed is this many random bytes, printed as hex (8 characters). */
export const PRACTICE_SEED_BYTES = 4;

/** The longest `?seed=` the route accepts; anything longer is dropped as invalid. */
export const PRACTICE_SEED_MAX_LENGTH = 64;

/** The sparks a Victory throws off, and the embers a Defeat sheds, in the result dialog. */
export const PRACTICE_RESULT_PARTICLES = 18;
