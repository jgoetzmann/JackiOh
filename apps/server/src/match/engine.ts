/**
 * The one seam between the server and `packages/engine` (SPEC §9.3, CLAUDE.md rule 7).
 *
 * The engine is pure and server-agnostic: it never reads a clock, opens a socket or touches
 * Postgres. This port is how the actor reaches it — `createGame` / `beginGame` / `reduce` to
 * advance the match, `legalActions` for the AI policy and the client's greying-out, `viewFor` for
 * the only thing a socket is allowed to carry (§10.8), and `fold` to rebuild a crashed actor from
 * `(seed, decks, log)` (§9.5).
 *
 * `EngineState` is opaque: it holds both hands and both libraries, so nothing outside this port
 * inspects it. Everything the rest of the server needs about the state comes back through
 * `viewFor` (per player) or `snapshot` (public bookkeeping the clock and the results writer need).
 *
 * The real binding lives in `engine.real.ts`, loaded lazily, mirroring `apps/web/src/game`.
 */

import type {
  Action,
  ActionBody,
  CardDefs,
  GameEvent,
  GameOverReason,
  PlayerId,
  PlayerView,
} from "@jackioh/shared";

declare const engineStateBrand: unique symbol;

export type EngineState = { readonly [engineStateBrand]: never };

export type ReduceResult = { state: EngineState; events: GameEvent[]; error?: string };

export type CreateGameArgs = {
  seed: string;
  /** Two decks of card ids in library order; the engine shuffles them with the match rng. */
  decks: [string[], string[]];
  catalog?: CardDefs;
};

export type FoldArgs = {
  seed: string;
  decks: [string[], string[]];
  log: readonly Action[];
  catalog?: CardDefs;
};

/**
 * The public bookkeeping the clock (`match/clock.ts`) and the results writer (`api/results.ts`)
 * need. Nothing here is hidden information: both clients already see all of it.
 */
export type MatchSnapshot = {
  /** Player-turn counter (§2.5). */
  turn: number;
  active: PlayerId;
  /** Who owes the open prompt an answer, or null (§10.6). */
  pendingFor: PlayerId | null;
  phase: "setup" | "mulligan" | "start" | "main" | "end" | "over";
  result: { winner: PlayerId | "draw"; reason: GameOverReason } | null;
};

export type EnginePort = {
  createGame: (args: CreateGameArgs) => EngineState;
  beginGame: (state: EngineState) => ReduceResult;
  reduce: (state: EngineState, action: Action) => ReduceResult;
  legalActions: (state: EngineState, player: PlayerId) => ActionBody[];
  /** SPEC §10.8: the only window a player gets onto the match. */
  viewFor: (state: EngineState, player: PlayerId) => PlayerView;
  /** §9.5: a crashed actor rebuilds its state by folding `(seed, log)`. */
  fold: (args: FoldArgs) => { state: EngineState; errors: { nonce: string; error: string }[] };
  hashState: (state: EngineState) => string;
  snapshot: (state: EngineState) => MatchSnapshot;
  /**
   * SPEC §11 R258: an All Random deck of card ids in library order, from the game's own weighted
   * random deck-builder with nothing banned, seeded so the same seed deals the same deck in any
   * process. The composition root binds `ServerDeps.dealRandomDeck` to it; it lives on this port
   * because the deck-builder needs the registered catalog, and this port is the one path to it.
   */
  dealRandomDeck: (seed: string) => string[];
};

/** The exports `engine.real.ts` needs from `@jackioh/engine`, for the missing-export report. */
export const REQUIRED_ENGINE_EXPORTS = [
  "createGame",
  "beginGame",
  "reduce",
  "legalActions",
  "viewFor",
  "fold",
  "hashState",
  "createRng",
] as const;

export class EngineUnavailableError extends Error {
  readonly missing: readonly string[];

  constructor(missing: readonly string[], cause?: unknown) {
    super(
      missing.length > 0
        ? `@jackioh/engine is missing: ${missing.join(", ")}. No match can run until the engine exports them.`
        : `@jackioh/engine could not be loaded: ${String(cause)}`,
    );
    this.name = "EngineUnavailableError";
    this.missing = missing;
  }
}

let injected: EnginePort | null = null;
let loading: Promise<EnginePort> | null = null;

/** Tests install a scripted port instead of the real engine. */
export function setEnginePort(port: EnginePort | null): void {
  injected = port;
  loading = null;
}

export function injectedEnginePort(): EnginePort | null {
  return injected;
}

/**
 * `engine.real.ts` used to be excluded from `apps/server/tsconfig.json` as well, because
 * `packages/engine` did not compile. It does now (`tsc -p packages/engine/tsconfig.json` exits 0)
 * and the exclusion is gone, so the file is typechecked with the rest of `src`.
 *
 * The **import stays dynamic**, and the specifier stays in a variable so no bundler follows it.
 * Two things depend on that, both of which a static import would take away:
 *
 *  - `EngineUnavailableError`'s "could not be loaded" branch below. A static import fails while
 *    *this* module is being evaluated, which every module in `src/match` and every server test
 *    pulls in — so an engine that cannot load would become an unattributed module-graph failure
 *    instead of one named error saying which exports are missing.
 *  - `setEnginePort`. A test (or a degraded runtime) that installs its own port never reaches the
 *    real engine at all: `injected !== null` short-circuits before the import. Statically, every
 *    process that touches this file would load `@jackioh/engine` and, through `engine.real.ts`,
 *    `packages/cards`' 110 card scripts, whether or not a match is ever played.
 *
 * So the day to make this static is the day the server stops wanting to run without an engine,
 * which is not a typecheck question.
 */
export function loadEnginePort(): Promise<EnginePort> {
  if (injected !== null) return Promise.resolve(injected);
  if (loading !== null) return loading;
  const specifier = "./engine.real.ts";
  loading = import(specifier)
    .then((mod: { enginePort?: () => EnginePort }) => {
      if (typeof mod.enginePort !== "function") throw new EngineUnavailableError(["enginePort"]);
      return mod.enginePort();
    })
    .catch((cause: unknown) => {
      loading = null;
      if (cause instanceof EngineUnavailableError) throw cause;
      throw new EngineUnavailableError([], cause);
    });
  return loading;
}
