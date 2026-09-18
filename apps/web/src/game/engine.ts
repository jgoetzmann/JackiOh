// The one seam between the client and `packages/engine` (CLAUDE.md rule 7, SPEC §10.8).
//
// The client never holds rules. It holds an `EnginePort`: `createGame` / `beginGame` / `reduce`
// to advance the game, `legalActions` to learn what it is allowed to offer, and `viewFor` to get
// the only thing it is allowed to draw. `EngineState` is opaque on purpose — it carries both
// hands and both libraries, so a client that could read a field could leak hidden information.
// Everything the UI needs comes back through `viewFor`.
//
// The real binding lives in `engine.real.ts` and is loaded lazily, so the presentation layer,
// the action builders and the animation table all compile and test with no engine at all.

import type { Action, ActionBody, CardDefs, GameEvent, PlayerId, PlayerView } from "@jackioh/shared";

declare const engineStateBrand: unique symbol;

/**
 * The engine's `GameState`, opaque to the client. It holds hidden information, so the client
 * passes it back to the port and never inspects it. The dev hotseat route puts it on
 * `window.__jackioh.state` for Cypress (BUILD M5-T3) and hashes it, nothing more.
 */
export type EngineState = { readonly [engineStateBrand]: never };

export type ReduceResult = { state: EngineState; events: GameEvent[]; error?: string };

export type CreateGameArgs = {
  seed: string;
  /** Two decks of card ids, in library order; the engine shuffles them with the match rng. */
  decks: [string[], string[]];
  catalog?: CardDefs;
};

export type EnginePort = {
  createGame: (args: CreateGameArgs) => EngineState;
  beginGame: (state: EngineState) => ReduceResult;
  reduce: (state: EngineState, action: Action) => ReduceResult;
  /** Everything this player may legally do right now. The client greys out the rest (M5-T2). */
  legalActions: (state: EngineState, player: PlayerId) => ActionBody[];
  /** The only window the client has onto the game (SPEC §10.8). */
  viewFor: (state: EngineState, player: PlayerId) => PlayerView;
  hashState: (state: EngineState) => string;
  /** The card catalog, for the dev deck picker. Absent until `packages/cards` ships defs. */
  catalog?: () => CardDefs;
};

/** The exports `engine.real.ts` needs from `@jackioh/engine`, for the missing-export report. */
export const REQUIRED_ENGINE_EXPORTS = [
  "createGame",
  "beginGame",
  "reduce",
  "legalActions",
  "viewFor",
  "hashState",
] as const;

export class EngineUnavailableError extends Error {
  readonly missing: readonly string[];

  constructor(missing: readonly string[], cause?: unknown) {
    super(
      missing.length > 0
        ? `@jackioh/engine is missing: ${missing.join(", ")}. The client cannot run a game until the engine exports them.`
        : `@jackioh/engine could not be loaded: ${String(cause)}`,
    );
    this.name = "EngineUnavailableError";
    this.missing = missing;
  }
}

let injected: EnginePort | null = null;
let loading: Promise<EnginePort> | null = null;

/** Tests and Cypress fixtures install a scripted port instead of the real engine. */
export function setEnginePort(port: EnginePort | null): void {
  injected = port;
  loading = null;
}

export function injectedEnginePort(): EnginePort | null {
  return injected;
}

/**
 * The import is dynamic so Vite code-splits the engine and the 109 card scripts out of the first
 * paint — `/login`, `/invite` and `/decks` never need them. It is a plain analyzable
 * `import("./engine.real.ts")`, not the `@vite-ignore` string specifier this used to be: that
 * workaround existed only while `packages/engine/src/index.ts` re-exported modules that did not
 * exist yet, and `tsc -p packages/engine/tsconfig.json` is green now, so the module is in
 * `apps/web/tsconfig.json` and typechecked like everything else.
 */
export function loadEnginePort(): Promise<EnginePort> {
  if (injected !== null) return Promise.resolve(injected);
  if (loading !== null) return loading;
  loading = import("./engine.real.ts")
    .then((mod) => mod.enginePort())
    .catch((cause: unknown) => {
      loading = null;
      if (cause instanceof EngineUnavailableError) throw cause;
      throw new EngineUnavailableError([], cause);
    });
  return loading;
}
