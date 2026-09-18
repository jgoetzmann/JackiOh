// The real `EnginePort`, and the ONLY file in `apps/server` that imports `@jackioh/engine`.
//
// It is excluded from `apps/server/tsconfig.json` and reached only through the unanalyzed dynamic
// import in `engine.ts`, because `packages/engine/src/index.ts` re-exports `./combat`,
// `./playChoices`, `./prompts`, `./triggers`, `./traps` and `./viewFor`, none of which exist yet
// (M3 in flight). Re-include it — and make the import in `engine.ts` static — the day
// `pnpm exec tsc -p packages/engine/tsconfig.json` is green.
//
// Nothing here decides a rule. It renames engine functions onto the port and projects the public
// bookkeeping the clock needs; the `as` casts only strip the opaque `EngineState` brand that
// keeps the rest of the server from reading hidden information (SPEC §10.8).

import * as engine from "@jackioh/engine";

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
