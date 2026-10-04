/**
 * Seasons (SPEC §9.12, R609): which season a build plays in, and the soft reset that opens one.
 *
 * A season is named by the minor version of the game: every patch of v0.2 (v0.2.0, v0.2.6,
 * v0.2.6-r1) plays in season `v0.2`, and the first patch of v0.3 opens the next. The version is the
 * newest patch in `packages/cards/patches/patches.json` (R375), the one the site footer names.
 *
 * The soft reset pulls every rated player's hidden rating `SEASON_RESET_STRENGTH` of the way toward
 * the mean of those players' ratings and widens each deviation by `SEASON_RESET_DEVIATION_BOOST` in
 * quadrature, capped at a new player's deviation; volatility is kept. The season's ladder starts
 * empty, so everyone is a Raisin again. Bots are not reset: their ratings measure a fixed program,
 * not a player coming back from a break (R610).
 *
 * Pure: `src/api/ranked.ts` reads the players, calls `softReset`, and writes the result and the
 * season row in one transaction; `src/db/season-start.ts` runs the same path against a database
 * (a copy first, `--dry-run`, which reports and rolls back).
 */

import { RATING_DEVIATION_START, SEASON_RESET_DEVIATION_BOOST, SEASON_RESET_STRENGTH } from "../config";
import type { Glicko } from "./glicko2";

/** The leading `v<major>.<minor>` of a patch version. */
const MINOR_VERSION = /^v(\d+)\.(\d+)(?:[.-]|$)/;

/** R609: the season a patch version plays in, `v<major>.<minor>`. Throws on a version it cannot read. */
export function seasonIdOf(patchVersion: string): string {
  const match = MINOR_VERSION.exec(patchVersion);
  if (match === null) throw new Error(`"${patchVersion}" is not a patch version (v<major>.<minor>…)`);
  return `v${String(Number(match[1]))}.${String(Number(match[2]))}`;
}

/** One rated player going into a reset. */
export type ResetPlayer = { profileId: string; glicko: Glicko };

/** One player's reset: the rating before and after. */
export type ResetChange = { profileId: string; before: Glicko; after: Glicko };

/** What a reset did, for the operator who runs it and the log line the server writes. */
export type ResetReport = {
  players: number;
  /** The mean rating the reset pulls toward, which it also leaves unchanged. */
  mean: number;
  /** Population standard deviation of the ratings, before and after. */
  spreadBefore: number;
  spreadAfter: number;
  /** Mean rating deviation, before and after. */
  deviationBefore: number;
  deviationAfter: number;
  /** The lowest and highest rating, before and after. */
  lowestBefore: number;
  highestBefore: number;
  lowestAfter: number;
  highestAfter: number;
};

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function spread(values: readonly number[], centre: number): number {
  return Math.sqrt(mean(values.map((value) => (value - centre) * (value - centre))));
}

/** The reset of one rating, toward `centre`. */
export function resetGlicko(glicko: Glicko, centre: number): Glicko {
  return {
    rating: centre + (glicko.rating - centre) * (1 - SEASON_RESET_STRENGTH),
    deviation: Math.min(
      Math.sqrt(glicko.deviation * glicko.deviation + SEASON_RESET_DEVIATION_BOOST * SEASON_RESET_DEVIATION_BOOST),
      RATING_DEVIATION_START,
    ),
    volatility: glicko.volatility,
  };
}

/**
 * R609: the soft reset of every rated player. Players are taken in profile-id order, so the mean is
 * summed the same way whatever order the store returned them in, and the same players always reset
 * to the same ratings.
 */
export function softReset(players: readonly ResetPlayer[]): { changes: ResetChange[]; report: ResetReport } {
  const ordered = [...players].sort((a, b) => (a.profileId < b.profileId ? -1 : a.profileId > b.profileId ? 1 : 0));
  const before = ordered.map((player) => player.glicko.rating);
  const centre = mean(before);
  const changes = ordered.map((player) => ({
    profileId: player.profileId,
    before: { ...player.glicko },
    after: resetGlicko(player.glicko, centre),
  }));
  const after = changes.map((change) => change.after.rating);
  return {
    changes,
    report: {
      players: ordered.length,
      mean: centre,
      spreadBefore: spread(before, centre),
      spreadAfter: spread(after, mean(after)),
      deviationBefore: mean(changes.map((change) => change.before.deviation)),
      deviationAfter: mean(changes.map((change) => change.after.deviation)),
      lowestBefore: before.length === 0 ? 0 : Math.min(...before),
      highestBefore: before.length === 0 ? 0 : Math.max(...before),
      lowestAfter: after.length === 0 ? 0 : Math.min(...after),
      highestAfter: after.length === 0 ? 0 : Math.max(...after),
    },
  };
}
