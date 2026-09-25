// The practice worker's wire protocol (SPEC §9.9, R187).
//
// The worker stands where §9.1 puts the server: it holds the one `GameState`, runs `reduce` for
// both seats and the AI for its own, and answers the page with what the human may see. So the
// shapes below are everything the main thread ever learns about a practice game (CLAUDE.md rule 7):
// `viewFor(state, human)`, the human's `legalActions`, whether the AI owes an action, and the
// engine's refusal of the human's last action. `PracticeDebug` is the one exception, and the core
// answers it only in a non-production build, for the e2e replay check.

import type { Action, ActionBody, CardDefs, DistributiveOmit, PlayerId, PlayerView } from "@jackioh/shared";
import type { Difficulty, Handicap } from "@jackioh/engine/config";

export type PracticeDeckChoice =
  | { kind: "random" }
  | { kind: "preset"; id: string }
  /** `index` is the 1-based deck number the setup's `saved:<n>` value names. */
  | { kind: "saved"; index: number; cards: string[] };

export type PracticeStartConfig = {
  seed: string;
  difficulty: Difficulty;
  humanSeat: PlayerId;
  deck: PracticeDeckChoice;
  /**
   * SPEC §9.10, R291: a tutorial lesson, by id (`tutorial/lessons.ts`). When set, the lesson's own
   * two decks and the tutorial handicap (`AI_TUTORIAL`, R290) replace `deck`, the AI's dealt deck
   * and `difficulty`'s handicap. The seed and the seat are still this config's: the tutorial passes
   * the lesson's own, and a test may pass others.
   */
  lesson?: string;
};

/** Rule 7: everything the main thread ever gets about the game. */
export type PracticeSnapshot = {
  /** viewFor(state, humanSeat) */
  view: PlayerView;
  /** legalActions(state, humanSeat) */
  legal: ActionBody[];
  /** aiToAct(state, aiSeat) */
  aiToAct: boolean;
  /** The engine's refusal of the last human action. */
  error: string | null;
};

/** Dev builds only (MODE !== "production"); the one message that carries the raw state. */
export type PracticeDebug = {
  seed: string;
  decks: [string[], string[]];
  handicaps: Partial<Record<PlayerId, Handicap>>;
  log: Action[];
  state: unknown;
  hash: string;
  difficulty: Difficulty;
  humanSeat: PlayerId;
  /** The tutorial lesson this game is, when it is one (§9.10). */
  lesson?: string;
};

export type PracticeRequest =
  | { id: number; type: "start"; config: PracticeStartConfig }
  | { id: number; type: "act"; action: ActionBody }
  | { id: number; type: "aiStep" }
  /** The public card data, for the setup screen's deck preview; needs no game. */
  | { id: number; type: "catalog" }
  | { id: number; type: "debug" };

export type PracticeResponse =
  | { id: number; type: "started"; snapshot: PracticeSnapshot; defs: CardDefs; aiSeat: PlayerId }
  | { id: number; type: "snapshot"; snapshot: PracticeSnapshot }
  | { id: number; type: "catalog"; defs: CardDefs }
  | { id: number; type: "debug"; debug: PracticeDebug }
  | { id: number; type: "failed"; message: string };

export type PracticeRequestBody = DistributiveOmit<PracticeRequest, "id">;
