// Replay: (seed, decks, action log) rebuilds a match exactly, and a state hash makes two folds
// comparable (SPEC §9.2, §9.3). A practice game adds its handicaps to that tuple (§9.9, R180, R187):
// they are setup, not actions, so the fold hands them to `createGame` exactly as the live game did.

import type { Action, CardDefs, PlayerId } from "@jackioh/shared";
import type { Handicap } from "./config";
import { beginGame, reduce } from "./reduce";
import { createGame, type GameState } from "./state";

/** Canonical JSON: keys sorted, so two equal states always produce the same text. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`);
  return `{${entries.join(",")}}`;
}

/** FNV-1a over the canonical state, minus the nonce log, which is bookkeeping. */
export function hashState(state: GameState): string {
  const { applied: _applied, ...rest } = state;
  const text = canonical(rest);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export type ReplayInput = {
  seed: string;
  decks: [string[], string[]];
  log: readonly Action[];
  catalog?: CardDefs;
  /** R180, R187: the same handicaps the live createGame had. */
  handicaps?: Partial<Record<PlayerId, Handicap>>;
};

export type ReplayResult = { state: GameState; errors: { nonce: string; error: string }[] };

/**
 * Fold a recorded log from scratch. Errors are collected, not thrown: a log may hold rejects. The
 * setup is not: `createGame` throws on a deck its seat's handicap does not allow, so a handicapped
 * game folded without its handicaps fails loudly instead of replaying a different game (R180).
 */
export function fold(input: ReplayInput): ReplayResult {
  const start = createGame({
    seed: input.seed,
    decks: input.decks,
    ...(input.catalog === undefined ? {} : { catalog: input.catalog }),
    ...(input.handicaps === undefined ? {} : { handicaps: input.handicaps }),
  });
  let state = beginGame(start).state;
  const errors: { nonce: string; error: string }[] = [];

  for (const action of input.log) {
    const result = reduce(state, action);
    if (result.error !== undefined) {
      errors.push({ nonce: action.nonce, error: result.error });
      continue;
    }
    state = result.state;
  }

  return { state, errors };
}
