// #62 Friend of Felinors — SPEC §8.3, BUILD M4-T4 row 62.
//
// Must-pass: "Fills empty zones only; radiant then +2/+2 to every unit you control including the
// new tokens."

import { describe, expect, it } from "vitest";
import type { CardInstance } from "@jackioh/engine";
import type { PlayerId } from "@jackioh/shared";
import { scenario, type Scenario } from "./_harness";

const FRIEND = "core-062"; // Spell, 1
const FELINOR = "core-t-felinor"; // §7's shared Felinor Token, 1/1
const TIMMY = "core-011"; // Unit, 3/3 — the unit already on the board
const LANES = [1, 2, 3, 4, 5] as const;

function unitAt(s: Scenario, player: PlayerId, lane: number): CardInstance {
  const found = s.unit(player, lane);
  if (found === null) throw new Error(`expected a unit in ${player} lane ${lane}, found none`);
  return found;
}

function defsOf(s: Scenario, player: PlayerId): (string | null)[] {
  return LANES.map((lane) => s.unit(player, lane)?.defId ?? null);
}

describe("#62 Friend of Felinors", () => {
  it("R64 fills every empty unit zone left to right and leaves the occupied one alone", () => {
    const s = scenario({ p1: { hand: [FRIEND], field: [TIMMY], mana: 4 } });

    s.play(FRIEND);

    expect(defsOf(s, "p1")).toEqual([TIMMY, FELINOR, FELINOR, FELINOR, FELINOR]);
    s.expectStats(unitAt(s, "p1", 2), { attack: 1, maxHealth: 1 });
    // The pre-existing unit is untouched by the base face.
    s.expectStats(unitAt(s, "p1", 1), { attack: 3, maxHealth: 3 });
  });

  it("fills only your own board", () => {
    const s = scenario({ p1: { hand: [FRIEND], mana: 4 }, p2: { field: [TIMMY] } });

    s.play(FRIEND);

    expect(defsOf(s, "p1")).toEqual([FELINOR, FELINOR, FELINOR, FELINOR, FELINOR]);
    expect(defsOf(s, "p2")).toEqual([TIMMY, null, null, null, null]);
  });

  it("R64 a full board takes no tokens, and the spell still resolves", () => {
    const full = [TIMMY, "core-t-rush", "core-t-sheep", "core-019", "core-020"];
    const s = scenario({ p1: { hand: [FRIEND], field: full, mana: 4 } });

    s.play(FRIEND);

    expect(defsOf(s, "p1")).toEqual(full);
    s.expectInZone(FRIEND, "graveyard");
  });

  it("radiant gives +2/+2 to every unit you control, the new tokens included", () => {
    const s = scenario({ p1: { hand: [{ def: FRIEND, radiant: true }], field: [TIMMY], mana: 4 } });

    s.play(FRIEND);

    // "Then": the buff lands after the fill, so the Felinors it just made are units you control.
    s.expectStats(unitAt(s, "p1", 1), { attack: 5, maxHealth: 5 });
    for (const lane of [2, 3, 4, 5]) {
      expect(unitAt(s, "p1", lane).defId).toBe(FELINOR);
      s.expectStats(unitAt(s, "p1", lane), { attack: 3, maxHealth: 3 });
    }
    s.expectEvents("cardPlayed", "summoned", "buffed");
  });

  it("radiant buffs your units only", () => {
    const s = scenario({
      p1: { hand: [{ def: FRIEND, radiant: true }], mana: 4 },
      p2: { field: [TIMMY] },
    });

    s.play(FRIEND);

    s.expectStats(unitAt(s, "p1", 1), { attack: 3, maxHealth: 3 });
    s.expectStats(unitAt(s, "p2", 1), { attack: 3, maxHealth: 3 });
  });

  it("radiant still buffs your board when it is full and no token can enter", () => {
    const s = scenario({
      p1: { hand: [{ def: FRIEND, radiant: true }], field: [TIMMY, TIMMY, TIMMY, TIMMY, TIMMY], mana: 4 },
    });

    s.play(FRIEND);

    for (const lane of LANES) s.expectStats(unitAt(s, "p1", lane), { attack: 5, maxHealth: 5 });
  });
});
