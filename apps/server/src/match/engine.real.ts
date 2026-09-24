// The real `EnginePort`, and the ONLY file in `apps/server` that imports `@jackioh/engine`.
//
// It is typechecked with the rest of `src` — the `apps/server/tsconfig.json` exclusion taken while
// `packages/engine` did not compile is gone, since `tsc -p packages/engine/tsconfig.json` now exits
// 0 (B-18 in reviews/2026-09-18-part-b-gate.md).
//
// It is still reached only through the unanalyzed dynamic import in `engine.ts`, which is what lets
// the server boot, degrade and be tested without the engine in the process; that file's
// `loadEnginePort` doc says why making it static would cost more than it saves.
//
// WHY `registerAll()` IS HERE. `createGame` looks its card definitions up in the engine's
// registered catalog, and `packages/cards` is the one module that owns the catalog and the 110
// scripts (SPEC §10.9, BUILD M4-T2). Without this call `registeredCatalog()` is empty and every
// real match throws on the first card of the first deck — the server tests miss it because they
// inject a fake engine port. It is idempotent by identity comparison in `packages/cards`, so
// calling it on every port build costs nothing. The client does the same in its own composition
// root; neither assembles a catalog of its own, which would be a second source of card data.
//
// Nothing here decides a rule. It renames engine functions onto the port and projects the public
// bookkeeping the clock needs; the `as` casts only strip the opaque `EngineState` brand that
// keeps the rest of the server from reading hidden information (SPEC §10.8).

import * as engine from "@jackioh/engine";
import { registerAll } from "@jackioh/cards";

import { EngineUnavailableError, REQUIRED_ENGINE_EXPORTS } from "./engine.ts";
import type { EnginePort, EngineState, MatchSnapshot } from "./engine.ts";

type RawState = {
  turn: number;
  active: MatchSnapshot["active"];
  phase: MatchSnapshot["phase"];
  pending: { playerId: MatchSnapshot["active"] } | null;
  result: MatchSnapshot["result"];
};

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
    fold: (args: unknown) => { state: unknown; errors: { nonce: string; error: string }[] };
    hashState: (state: unknown) => string;
  };

  return {
    createGame: (args) => api.createGame(args) as EngineState,
    beginGame: (state) => api.beginGame(state) as ReturnType<EnginePort["beginGame"]>,
    reduce: (state, action) => api.reduce(state, action) as ReturnType<EnginePort["reduce"]>,
    legalActions: (state, player) =>
      api.legalActions(state, player) as ReturnType<EnginePort["legalActions"]>,
    viewFor: (state, player) => api.viewFor(state, player) as ReturnType<EnginePort["viewFor"]>,
    fold: (args) => api.fold(args) as ReturnType<EnginePort["fold"]>,
    hashState: (state) => api.hashState(state),
    snapshot: (state) => {
      const raw = state as unknown as RawState;
      return {
        turn: raw.turn,
        active: raw.active,
        pendingFor: raw.pending === null ? null : raw.pending.playerId,
        phase: raw.phase,
        result: raw.result,
      };
    },
  };
}
