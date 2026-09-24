// The practice route's `data-testid` vocabulary. `e2e/support/testids.ts` carries the same strings
// in its PRACTICE block; keep the two files identical.

import type { Difficulty } from "@jackioh/engine/config";

export const practiceTestid = {
  setup: "practice-setup",
  /** An `<input type="radio">` per difficulty. */
  difficulty: (d: Difficulty): string => `practice-difficulty-${d}`,
  /** A `<select>`; its option values are `deckChoiceValue`'s. */
  deck: "practice-deck",
  /** Under the deck picker: why no saved deck is offered (signed out, none saved, …); absent when some are. */
  deckHint: "practice-deck-hint",
  /** The chosen deck: its name, its identity and, once the catalog is in, its curve and cards. */
  deckPreview: "practice-deck-preview",
  /** In the preview: one bar per cost, `data-cost` and `data-count`. */
  deckCurve: "practice-deck-curve",
  /** In the preview: one row per card of the chosen deck. */
  deckCard: (defId: string): string => `practice-deck-card-${defId}`,
  start: "practice-start",
  loading: "practice-loading",
  error: "practice-error",
  /** Carries data-difficulty, data-human-seat, data-ai-seat and data-thinking="true|false". */
  hud: "practice-hud",
  /** Rendered only while the AI is thinking; role="status", text "AI is thinking…". */
  thinking: "practice-thinking",
  /** Mid-game it opens `leave`; once the game is over, or on the failure screen, it leaves at once. */
  newGame: "practice-new-game",
  /** Out to the main menu: mid-game it opens `leave` first; once the game is over it leaves at once. */
  menu: "practice-menu",
  /** "Leave this game?": the confirmation `newGame` or `menu` opens while a game is in progress. */
  leave: "practice-leave",
  /** In the confirmation: abandon the game and go back to setup. */
  leaveConfirm: "practice-leave-confirm",
  /** In the confirmation: close it and carry on. */
  leaveStay: "practice-leave-stay",
  /** The end-of-game dialog; data-outcome="win|loss|draw". */
  result: "practice-result",
  /** In the result dialog: the same difficulty and deck again, with a fresh seed and seat. */
  playAgain: "practice-play-again",
  /** In the result dialog: back to the setup screen. */
  changeSetup: "practice-change-setup",
  /** In the result dialog: close it and look at the final board. */
  viewBoard: "practice-view-board",
  /** In the HUD while any modifier is live (R169): a chip with the count, `data-count`; it opens `modifiersPanel`. */
  modifiers: "practice-modifiers",
  /** Every live modifier's label in full, grouped You and AI. */
  modifiersPanel: "practice-modifiers-panel",
  /** In the HUD once the game is over: the outcome, which reopens the result dialog. */
  outcome: "practice-outcome",
} as const;
