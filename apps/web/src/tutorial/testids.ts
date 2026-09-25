// The tutorial's `data-testid` vocabulary (SPEC §9.10). `e2e/support/testids.ts` carries the same
// strings in its TUTORIAL block; keep the two files identical. Inside a lesson the board is the
// practice board, so its own testids (game/contract.ts) and practice's (practice/testids.ts: the
// think indicator, the modifiers chip, "Leave this game?") still apply.

export const tutorialTestid = {
  /** The lesson path at the top of `/practice`'s lobby. */
  path: "tutorial-path",
  /** One lesson on the path; `data-status="locked|unlocked|completed"`, `data-next="true"` on the one to play next. */
  lesson: (id: string): string => `tutorial-lesson-${id}`,
  /** A lesson's button: Start, Replay, or Locked (`aria-disabled="true"`, does nothing). */
  lessonStart: (id: string): string => `tutorial-start-${id}`,
  /** In the path's header once a lesson is done and another is open: "Continue: Lesson N". */
  continue: "tutorial-continue",
  /** Once every lesson is done the path folds to its header; this shows or hides the lessons (`aria-expanded`). */
  pathToggle: "tutorial-path-toggle",
  /** The lesson's HUD above the board; `data-lesson`, `data-human-seat`, `data-ai-seat`, `data-thinking`. */
  hud: "tutorial-hud",
  /** In the HUD: "Step k of n". */
  step: "tutorial-step",
  /** In the HUD: the coach's "Skip step". */
  skip: "tutorial-skip",
  /** In the HUD: back to the lessons; mid-game it opens practice's "Leave this game?" first. */
  exit: "tutorial-exit",
  /** In the HUD once the lesson is over: the outcome, which reopens the result dialog. */
  outcome: "tutorial-outcome",
  /**
   * The coach bubble: `data-coach-mode="step|tip|waiting"`, `data-coach-step` (the step or tip id;
   * absent while waiting) and `data-coach-anchor` (the board testids it points at, space-separated).
   */
  coach: "coach",
  /** In the bubble: "Got it", on every tip and info step. */
  coachAck: "coach-ack",
  /** In the bubble: "Skip step", always while the lesson is on. */
  coachSkip: "coach-skip",
  /** The ring round the anchor's elements; `pointer-events: none`; absent when none is on screen. */
  coachRing: "coach-ring",
  /** The end-of-lesson dialog; `data-outcome="win|loss|draw"`, `data-lesson`. */
  result: "tutorial-result",
  /** In the result dialog after a win: start the next lesson. */
  next: "tutorial-next",
  /** In the result dialog after a loss or draw: the same lesson again, same seed. */
  retry: "tutorial-retry",
  /** In the result dialog: back to the lesson path. */
  back: "tutorial-back",
  /** In the result dialog after the last lesson: back to the lobby's practice setup. */
  playPractice: "tutorial-play-practice",
  /** In the result dialog: close it and look at the final board. */
  viewBoard: "tutorial-view-board",
} as const;
