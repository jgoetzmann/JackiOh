// The vitest half of BUILD M5-T3's acceptance: "the same seed and actions reproduce the same final
// state hash in the browser and in vitest".
//
// The browser half already exists. `e2e/cypress/e2e/01-hotseat-full-game.cy.ts` plays a whole game
// through `/dev/hotseat`, then `cy.task("replayHash")` folds the recorded `(seed, decks, log)` in a
// Node child process and asserts the browser's own `hashState` equals that fold. What did not exist
// was a fold inside `vitest` — `apps/web/src/game/hotseat.test.ts` runs two sessions against a
// SCRIPTED engine whose `reduce` increments a turn counter, so it would pass against an engine with
// no determinism at all. This file is the missing fold: the real `reduce`, the real catalog, the
// real 110 card scripts, and a hash written down.
//
// WHY IT LIVES IN packages/cards. The log names real cards (`core-003`, `core-045`, …) and folding
// it without their scripts registered would fizzle every Cry (`scriptsFor` falls back to
// `EMPTY_SCRIPT`) and reach a different state. Only `@jackioh/cards` owns the catalog and the
// scripts, and `packages/engine` must not depend on it — the dependency runs the other way. So the
// fold belongs on this side of that edge, next to the M4 fuzz gate, which folds the same way.
//
// WHY THE LOG IS COMMITTED HERE. `e2e/artifacts/` is gitignored (`e2e/.gitignore`), and CI's
// `checks` job runs `pnpm test` on a fresh checkout where no browser has ever run — so a test that
// read the artifact directly would find nothing there. Skipping when the file is absent would make
// this another check that measures nothing, and failing when it is absent would make `pnpm test`
// depend on having run Cypress first. The recording is therefore checked in, byte-identical, as
// `test/fixtures/01-hotseat-full-game.json`, and:
//
//   - the fold below ALWAYS runs, against the committed copy, and never skips;
//   - the last test compares the committed copy with `e2e/artifacts/…` WHEN a local Cypress run has
//     left one there, so a recording that drifts is reported instead of silently diverging. Its
//     absence is the normal state (gitignored, never in CI) and is not evidence of drift, so it is
//     the one thing here that is conditional — and it is conditional on a file that only exists
//     when there is something to compare.
//
// WHY A LITERAL HASH. Comparing a fold with a fold in the same process proves nothing: both would
// move together. `EXPECTED_HASH` is written down, so a change in shuffling, in turn order, in any
// card's script, or a lost `registerAll()` moves it and fails here. It is not a magic number: spec
// 01 asserts the browser's own hash equals a fold of this same log, so this value is the browser's
// hash for as long as that spec is green.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { Action } from "@jackioh/shared";
import { fold, hashState } from "@jackioh/engine";

import { CATALOG, registerAll } from "../src/index";

/** The recording, as `e2e/support/tasks/replay.ts` writes it: `{ seed, decks, log }`. */
type Recording = { seed: string; decks: [string[], string[]]; log: Action[] };

const COMMITTED = fileURLToPath(new URL("./fixtures/01-hotseat-full-game.json", import.meta.url));
/** Where Cypress leaves its copy. Gitignored, so it is present only after a local `pnpm test:e2e`. */
const RECORDED = fileURLToPath(new URL("../../../e2e/artifacts/01-hotseat-full-game.json", import.meta.url));

/**
 * The final state hash of the recorded game.
 *
 * Refresh it ONLY together with the recording, and only when the rules deliberately changed: run
 * `pnpm test:e2e` (spec 01 re-records `e2e/artifacts/01-hotseat-full-game.json` and checks the
 * browser against a fold of it), copy that file over the fixture here, and paste the hash this test
 * reports. Editing the number on its own turns the check into a rubber stamp.
 *
 * The one exception is a change to what the state RECORDS about the same game, which leaves the log
 * as it is. The polish-4 hunt made three: the other player's turn log is emptied at each turn start
 * (§6.2's "this turn"), and `lastDamagedBy` names only the hit that took a unit to 0 (R42). A fold of
 * this log before and after the second differs in that field on three instances and nowhere else.
 * The third: the turn log records what each play paid (`costsPaid`, R213), and a hand card's queued
 * trigger no longer takes a number from `nextSeq` (R177). A fold before and after it differs in p1's
 * `costsPaid` and in `nextSeq` and the two frontier ids it numbers, 4 lower, and nowhere else.
 *
 * Round 6 of the hunt moved it twice more, and moved the log's ids with it. `createGame` now numbers
 * each deck's cards in an order of the seed's own (R223), so the log's 40 deck-card ids were relabeled
 * through that mapping and nothing else in the log changed; and the state counts the field's
 * departures (`fieldExits`, R174). A fold of the old log under the old numbering and a fold of the
 * relabeled log, relabeled back, differ in `fieldExits` alone — the same game, action for action.
 *
 * The Coin (R244) re-recorded it, by the procedure above: p2 is dealt The Coin after the mulligan,
 * so spec 01, which plays whatever the client offers, plays it on p2's first turn (nonce n6), and
 * every instance created after setup takes an id one higher. A new game, not a relabeled one: 51
 * actions where there were 50, still won by p1 by hero death.
 */
const EXPECTED_HASH = "0349d08f";

/** What the recorded game ends in — a second anchor, so the hash is not the only witness. */
const EXPECTED_RESULT = { winner: "p1", reason: "hero-death" } as const;
const EXPECTED_ACTIONS = 51;

function read(path: string): Recording {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  const record = parsed as Partial<Recording>;
  if (typeof record.seed !== "string" || !Array.isArray(record.decks) || !Array.isArray(record.log)) {
    throw new Error(`${path} is not a recorded hotseat game: expected { seed, decks, log }`);
  }
  return record as Recording;
}

const recording = read(COMMITTED);

describe("the recorded hotseat game replays in vitest (BUILD M5-T3)", () => {
  it("folds the browser's own (seed, decks, log) to the recorded final state hash", () => {
    // The catalog and the 110 scripts, exactly as `apps/web/src/game/engine.real.ts` registers them
    // before the browser's first `reduce`. Without them the Crys fizzle and the hash moves.
    registerAll();

    const replayed = fold({ seed: recording.seed, decks: recording.decks, log: recording.log });

    // Every recorded action is legal against a fold from scratch. A rejection would mean the log
    // and the engine have parted company, and the hash below would be a hash of a shorter game.
    expect(replayed.errors).toEqual([]);
    expect(hashState(replayed.state)).toBe(EXPECTED_HASH);

    // Anchors that say what that hash IS, so a future diff reads as a rules change and not as an
    // unexplained number: the game is over, p1 won by hero death, and p2's hero is dead.
    expect(replayed.state.result).toEqual(EXPECTED_RESULT);
    expect(replayed.state.phase).toBe("over");
    expect(replayed.state.players.p2.hero.health).toBeLessThanOrEqual(0);
    expect(replayed.state.players.p1.hero.health).toBeGreaterThan(0);
  });

  it("is a fold of the whole log: one action fewer is a different hash", () => {
    // The point of this one is that the assertion above cannot pass by accident. If `fold` ignored
    // the log, or the hash ignored the state, these two would agree.
    registerAll();
    const short = fold({
      seed: recording.seed,
      decks: recording.decks,
      log: recording.log.slice(0, -1),
    });

    expect(hashState(short.state)).not.toBe(EXPECTED_HASH);
    expect(short.state.result).toBeNull();
  });

  it("is a fold of that seed: another seed is a different hash", () => {
    registerAll();
    const other = fold({ seed: `${recording.seed}-not`, decks: recording.decks, log: recording.log });
    expect(hashState(other.state)).not.toBe(EXPECTED_HASH);
  });

  it("is deterministic: folding twice in a row gives the same hash", () => {
    registerAll();
    const first = fold({ seed: recording.seed, decks: recording.decks, log: recording.log });
    const second = fold({ seed: recording.seed, decks: recording.decks, log: recording.log });
    expect(hashState(second.state)).toBe(hashState(first.state));
  });

  it("carries a real recording: 51 stamped actions over two deck-legal libraries", () => {
    expect(recording.seed).toBe("01-hotseat");
    expect(recording.log).toHaveLength(EXPECTED_ACTIONS);
    for (const action of recording.log) {
      expect(typeof action.nonce, `every action carries a nonce: ${JSON.stringify(action)}`).toBe("string");
      expect(["p1", "p2"]).toContain(action.playerId);
    }
    for (const deck of recording.decks) {
      expect(deck).toHaveLength(20);
      expect(new Set(deck).size).toBe(20);
      for (const id of deck) expect(CATALOG[id], `${id} is a catalog card`).toBeDefined();
    }
  });

  it("matches the last browser recording, when a local Cypress run has left one", () => {
    let recorded: string;
    try {
      recorded = readFileSync(RECORDED, "utf8");
    } catch {
      // `e2e/artifacts/` is gitignored: on CI and on a checkout where Cypress has not run, there is
      // nothing to compare. The fold above has already run against the committed copy, so nothing
      // is being skipped here except a comparison with a file that does not exist.
      return;
    }

    expect(
      JSON.parse(recorded),
      "e2e/artifacts/01-hotseat-full-game.json no longer matches " +
        "packages/cards/test/fixtures/01-hotseat-full-game.json. Spec 01 recorded a different game, " +
        "so the fixture here is stale: copy the artifact over it and update EXPECTED_HASH with the " +
        "value this file reports.",
    ).toEqual(JSON.parse(readFileSync(COMMITTED, "utf8")));
  });
});
