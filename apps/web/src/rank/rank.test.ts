import { describe, expect, it } from "vitest";

import { badgeWords, divisionNumeral, rankWords, tierName } from "./rank.ts";

describe("rank words", () => {
  it("names every tier in a player's words", () => {
    expect(tierName("raisin")).toBe("Raisin");
    expect(tierName("rotten")).toBe("Rotten Grape");
    expect(tierName("normal")).toBe("Normal Grape");
    expect(tierName("large")).toBe("Large Grape");
    expect(tierName("golden")).toBe("Golden Grape");
    expect(tierName("mythic")).toBe("Mythic Grape");
    expect(tierName("jlorious")).toBe("Jlorious");
  });

  it("prints divisions as numerals, III at the bottom", () => {
    expect(divisionNumeral(3)).toBe("III");
    expect(divisionNumeral(2)).toBe("II");
    expect(divisionNumeral(1)).toBe("I");
  });

  it("says placements, a division with pips, or a Jlorious position", () => {
    expect(rankWords({ tier: "raisin", placementsPlayed: 2, placementGames: 5 })).toBe("Raisin · 2/5 placements");
    expect(
      rankWords({ tier: "normal", division: 3, pips: 1, pipsPerDivision: 3, floor: "rotten" }),
    ).toBe("Normal Grape III · 1/3 pips");
    expect(rankWords({ tier: "jlorious", position: 12 })).toBe("Jlorious #12");
  });

  it("says a season's badge with its season", () => {
    expect(badgeWords({ seasonId: "v0.2", tier: "jlorious", position: 4 })).toBe("Jlorious #4 · v0.2");
    expect(badgeWords({ seasonId: "v0.2", tier: "golden", division: 1 })).toBe("Golden Grape I · v0.2");
  });
});
