/**
 * `src/db/season-start.ts` — R609's season-open admin script — driven against the in-memory
 * store, where `--dry-run`'s rollback is the observable half: the report must describe the reset
 * exactly while the store holds none of its writes.
 */
import { describe, expect, it } from "vitest";

import { SEASON_RESET_STRENGTH } from "../../src/config";
import { parseSeasonStartArgs, startSeason } from "../../src/db/season-start";
import { rateRankedGame, type RankedGameInput } from "../../src/api/ranked";
import { seasonIdOf } from "../../src/ranked/season";
import { createTestDeps, type TestDeps } from "../fakes/deps";

const A = "profile-a";
const B = "profile-b";
const player = (profileId: string) => ({ kind: "player", profileId }) as const;

/** One rated game between the two profiles: what `ratedPlayers` (and so the reset) reads. */
async function rate(deps: TestDeps, at = 1) {
  const input: RankedGameInput = {
    id: `m-${String(at)}`,
    kind: "match",
    catalogVersion: "test-1",
    sides: [player(A), player(B)],
    winnerSide: 0,
    reason: "hero-death",
    at,
  };
  return deps.store.tx((t) => rateRankedGame(t, deps, input));
}

/** Two rated players and their season — the state a mid-version bump finds. */
async function ratedPair(deps: TestDeps) {
  deps.store.seedProfile({ id: A, rating: 1200, ratingDeviation: 100 });
  deps.store.seedProfile({ id: B, rating: 800, ratingDeviation: 100 });
  await rate(deps);
}

describe("season-start args", () => {
  it("takes only --dry-run", () => {
    expect(parseSeasonStartArgs([])).toEqual({ dryRun: false });
    expect(parseSeasonStartArgs(["--dry-run"])).toEqual({ dryRun: true });
    expect(parseSeasonStartArgs(["--dry-run", "--dry-run"])).toEqual({ dryRun: true });
    expect(() => parseSeasonStartArgs(["--apply"])).toThrow(/--apply/);
    expect(() => parseSeasonStartArgs(["v0.2"])).toThrow(/v0\.2/);
  });
});

describe("R609 startSeason", () => {
  it("opens the build's season for real when --dry-run is absent", async () => {
    const deps = createTestDeps();
    await ratedPair(deps);

    const opened = await startSeason(
      deps.store,
      { patchVersion: "v0.2.0", timers: deps.timers, log: deps.log },
      { dryRun: false },
    );
    expect(opened).toMatchObject({ season: { id: "v0.2" }, opened: true, reset: { players: 2 } });
    expect((await deps.store.ranked.seasons()).map((season) => season.id)).toEqual(["v0.1", "v0.2"]);

    // And it is idempotent: the season the server boot would open is already there.
    const again = await startSeason(
      deps.store,
      { patchVersion: "v0.2.0", timers: deps.timers, log: deps.log },
      { dryRun: false },
    );
    expect(again).toMatchObject({ opened: false, reset: null });
  });

  it("--dry-run reports the reset and rolls every write back", async () => {
    const deps = createTestDeps();
    await ratedPair(deps);
    const [a, b] = [await deps.store.profiles.getById(A), await deps.store.profiles.getById(B)];
    if (a === null || b === null) throw new Error("premise: both profiles exist");
    const mean = (a.rating + b.rating) / 2;

    const opened = await startSeason(
      deps.store,
      { patchVersion: "v0.2.0", timers: deps.timers, log: deps.log },
      { dryRun: true },
    );

    // The report is the real reset's: two players, pulled toward their mean by the strength.
    expect(opened).toMatchObject({ season: { id: "v0.2" }, opened: true });
    expect(opened.reset?.players).toBe(2);
    expect(opened.reset?.mean).toBeCloseTo(mean, 9);
    expect(opened.reset?.highestAfter).toBeCloseTo(mean + (a.rating - mean) * (1 - SEASON_RESET_STRENGTH), 9);

    // …and nothing it described survives: no season row, untouched ratings.
    expect((await deps.store.ranked.seasons()).map((season) => season.id)).toEqual(["v0.1"]);
    expect(await deps.store.profiles.getById(A)).toMatchObject({ rating: a.rating, ratingDeviation: a.ratingDeviation });
    expect(await deps.store.profiles.getById(B)).toMatchObject({ rating: b.rating, ratingDeviation: b.ratingDeviation });

    // A real run right after does exactly what the dry run reported.
    const applied = await startSeason(
      deps.store,
      { patchVersion: "v0.2.0", timers: deps.timers, log: deps.log },
      { dryRun: false },
    );
    expect(applied).toMatchObject({ opened: true, reset: { players: 2 } });
    expect((await deps.store.profiles.getById(A))?.rating).toBeCloseTo(
      mean + (a.rating - mean) * (1 - SEASON_RESET_STRENGTH),
      9,
    );
  });

  it("--dry-run on an already-open season reports it as unopened and writes nothing", async () => {
    const deps = createTestDeps();
    await ratedPair(deps);
    const opened = await startSeason(
      deps.store,
      { patchVersion: deps.patchVersion, timers: deps.timers, log: deps.log },
      { dryRun: true },
    );
    expect(opened).toMatchObject({ season: { id: seasonIdOf(deps.patchVersion) }, opened: false, reset: null });
    expect((await deps.store.ranked.seasons()).map((season) => season.id)).toEqual(["v0.1"]);
  });
});
