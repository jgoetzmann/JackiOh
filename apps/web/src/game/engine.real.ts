// The real `EnginePort`, and the only file on the page's side of `apps/web` that imports
// `@jackioh/engine` or `@jackioh/cards`. `engine.ts` reaches it through one code-split dynamic
// import. The one other engine entry is practice's: `src/practice/core.ts` imports the engine, the
// cards and `@jackioh/ai`, and it is loaded only by the practice Web Worker
// (`src/practice/practice.worker.ts`, its own bundle) and by the in-thread host jsdom tests use
// (SPEC §9.9, R187). The page never imports it.
//
// Nothing here decides a rule. It registers the catalog, then renames engine functions onto the
// port; the `as` casts only strip the opaque `EngineState` brand that keeps the rest of the client
// from reading hidden information (SPEC §10.8).
//
// WHY `registerAll()` IS HERE. `createGame` looks its card definitions up in the engine's
// registered catalog, and `packages/cards` is the one module that owns the catalog and the 109
// scripts (SPEC §10.9, BUILD M4-T2). The client must not assemble a catalog of its own — that
// would be a second source of card data — so it calls the registry's own entry point and asks the
// engine for the result through `EnginePort.catalog`. It is idempotent by identity comparison in
// `packages/cards/src/index.ts`, so calling it on every port build costs nothing.

import * as engine from "@jackioh/engine";
import { registerAll } from "@jackioh/cards";

import { EngineUnavailableError, REQUIRED_ENGINE_EXPORTS } from "./engine.ts";
import type { EnginePort, EngineState } from "./engine.ts";

export function enginePort(): EnginePort {
  const mod = engine as unknown as Record<string, unknown>;
  const missing = REQUIRED_ENGINE_EXPORTS.filter((name) => typeof mod[name] !== "function");
  if (missing.length > 0) throw new EngineUnavailableError(missing);

  registerAll();

  const api = engine as unknown as {
    createGame: (args: { seed: string; decks: [string[], string[]]; catalog?: unknown }) => unknown;
    beginGame: (state: unknown) => { state: unknown; events: unknown[]; error?: string };
    reduce: (state: unknown, action: unknown) => { state: unknown; events: unknown[]; error?: string };
    legalActions: (state: unknown, player: unknown) => unknown[];
    viewFor: (state: unknown, player: unknown) => unknown;
    hashState: (state: unknown) => string;
    registeredCatalog?: () => unknown;
  };

  return {
    createGame: (args) => api.createGame(args) as EngineState,
    beginGame: (state) => api.beginGame(state) as ReturnType<EnginePort["beginGame"]>,
    reduce: (state, action) => api.reduce(state, action) as ReturnType<EnginePort["reduce"]>,
    legalActions: (state, player) => api.legalActions(state, player) as ReturnType<EnginePort["legalActions"]>,
    viewFor: (state, player) => api.viewFor(state, player) as ReturnType<EnginePort["viewFor"]>,
    hashState: (state) => api.hashState(state),
    catalog:
      typeof api.registeredCatalog === "function"
        ? () => api.registeredCatalog!() as ReturnType<NonNullable<EnginePort["catalog"]>>
        : undefined,
  };
}
