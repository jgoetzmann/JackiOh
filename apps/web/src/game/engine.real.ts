// The real `EnginePort`, and the ONLY file in `apps/web` that imports `@jackioh/engine`.
//
// It is excluded from `apps/web/tsconfig.json` and reached only through the unanalyzed dynamic
// import in `engine.ts`, because `packages/engine/src/index.ts` re-exports `./combat`,
// `./playChoices`, `./prompts`, `./triggers`, `./traps` and `./viewFor`, none of which exist
// yet (M3 in flight). Re-include it — and make the import in `engine.ts` static — the day
// `pnpm exec tsc -p packages/engine/tsconfig.json` is green.
//
// Nothing here decides a rule. It renames engine functions onto the port and nothing else; the
// `as` casts only strip the opaque `EngineState` brand that keeps the rest of the client from
// reading hidden information (SPEC §10.8).

import * as engine from "@jackioh/engine";

import { EngineUnavailableError, REQUIRED_ENGINE_EXPORTS } from "./engine.ts";
import type { EnginePort, EngineState } from "./engine.ts";

export function enginePort(): EnginePort {
  const mod = engine as unknown as Record<string, unknown>;
  const missing = REQUIRED_ENGINE_EXPORTS.filter((name) => typeof mod[name] !== "function");
  if (missing.length > 0) throw new EngineUnavailableError(missing);

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
