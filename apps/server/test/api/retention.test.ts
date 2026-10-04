/**
 * The retention purge (`src/api/retention.ts`): which cutoffs it hands the store. What the store
 * then deletes is asserted against both stores in `test/db/contract.ts`, and in Postgres by
 * `test/sql/07_retention_purge.sql`.
 */

import { describe, expect, it } from "vitest";

import type { MatchRow } from "../../src/api/ports";
import { purgeExpired } from "../../src/api/retention";
import { CODE_ATTEMPT_RETENTION_DAYS, MATCH_ACTION_RETENTION_DAYS } from "../../src/config";
import { createTestDeps } from "../fakes/deps";

const DAY_MS = 86_400_000;

function finishedMatch(id: string, finishedAt: number | null): MatchRow {
  return {
    id,
    seed: "seed",
    players: ["p1", "p2"],
    decks: [[], []],
    catalogVersion: "test-1",
    ranked: false,
    status: finishedAt === null ? "live" : "finished",
    createdAt: 0,
    finishedAt,
    clocks: { turnDeadline: null, promptDeadline: null, graceDeadline: { p1: null, p2: null }, ceilingAt: 0 },
  };
}

describe("the retention purge", () => {
  it("asks the store for the cutoffs config.ts names, counted back from now", async () => {
    const deps = createTestDeps();
    const seen: unknown[] = [];
    deps.store.purgeExpired = async (input) => {
      seen.push(input);
      return { codeAttempts: 0, matchActions: 0 };
    };
    const now = deps.timers.now();
    await purgeExpired(deps);
    expect(seen).toEqual([
      {
        codeAttemptsBefore: now - CODE_ATTEMPT_RETENTION_DAYS * DAY_MS,
        matchActionsEndedBefore: now - MATCH_ACTION_RETENTION_DAYS * DAY_MS,
      },
    ]);
  });

  it("deletes old attempts and the logs of long-finished matches, and keeps the rest", async () => {
    const deps = createTestDeps();
    const now = deps.timers.now();
    const at = (days: number): number => now - days * DAY_MS;
    for (const [ipHash, days] of [["old", CODE_ATTEMPT_RETENTION_DAYS + 1], ["recent", CODE_ATTEMPT_RETENTION_DAYS - 1]] as const) {
      await deps.store.codes.logAttempt({ profileId: null, ipHash, result: "rejected", reason: "missing", at: at(days) });
    }
    deps.store.tables.matches.push(
      finishedMatch("m-old", at(MATCH_ACTION_RETENTION_DAYS + 1)),
      finishedMatch("m-recent", at(MATCH_ACTION_RETENTION_DAYS - 1)),
      finishedMatch("m-live", null),
    );
    for (const matchId of ["m-old", "m-recent", "m-live"]) {
      deps.store.tables.matchActions.push({ matchId, seq: 1, action: { type: "endTurn", playerId: "p1", nonce: "n" }, at: 0 });
    }

    expect(await purgeExpired(deps)).toEqual({ codeAttempts: 1, matchActions: 1 });
    expect(deps.store.tables.attempts.map((row) => row.ipHash)).toEqual(["recent"]);
    expect(deps.store.tables.matchActions.map((row) => row.matchId)).toEqual(["m-recent", "m-live"]);
  });
});
