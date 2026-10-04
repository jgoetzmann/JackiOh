// A visible rank in a player's words (SPEC §9.12, R612). The hidden rating never reaches the
// client, so these words are all there is: a tier, a division in numerals, pips, or a Jlorious
// position. Shared by the leaderboard, the account screen and the match screen so the three
// cannot disagree about what a rank says.

import type { GrapeTier, PeakBadge, VisibleRank } from "../net/api.ts";

/** Every tier a rank can name, in a player's words. */
export function tierName(tier: VisibleRank["tier"] | GrapeTier): string {
  switch (tier) {
    case "raisin":
      return "Raisin";
    case "rotten":
      return "Rotten Grape";
    case "normal":
      return "Normal Grape";
    case "large":
      return "Large Grape";
    case "golden":
      return "Golden Grape";
    case "mythic":
      return "Mythic Grape";
    case "jlorious":
      return "Jlorious";
  }
}

/** A Grape division (3 at the bottom, 1 at the top) as the numeral the client prints. */
export function divisionNumeral(division: number): string {
  switch (division) {
    case 3:
      return "III";
    case 2:
      return "II";
    case 1:
      return "I";
    default:
      return String(division);
  }
}

/** What a player is shown as: placements, a tier with its division and pips, or a position. */
export function rankWords(rank: VisibleRank): string {
  if (rank.tier === "raisin") return `Raisin · ${String(rank.placementsPlayed)}/${String(rank.placementGames)} placements`;
  if (rank.tier === "jlorious") return `Jlorious #${String(rank.position)}`;
  return `${tierName(rank.tier)} ${divisionNumeral(rank.division)} · ${String(rank.pips)}/${String(rank.pipsPerDivision)} pips`;
}

/** A season's best, as the profile's badge shows it (R607). */
export function badgeWords(badge: PeakBadge): string {
  if (badge.tier === "jlorious") return `Jlorious #${String(badge.position)} · ${badge.seasonId}`;
  return `${tierName(badge.tier)} ${divisionNumeral(badge.division)} · ${badge.seasonId}`;
}
