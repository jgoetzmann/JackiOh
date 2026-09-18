// #65.1 Spikey Pillow — SPEC §8.3, §4.1, §10.4, BUILD M4-T4 row 65.1.
//
// Must-pass: "Cannot switch to DEF; your units −2 attack floored at 0; radiant excludes other
// Pillows."

import { describe, expect, it } from "vitest";
import type { CardInstance } from "@jackioh/engine";
import type { PlayerId, Selection } from "@jackioh/shared";
import { scenario, type Scenario } from "./_harness";

const PILLOW = "core-065-1"; // Unit, Token, 0/2 → 0/4
const TIMMY = "core-011"; // Unit, 3/3
const FELINOR = "core-t-felinor"; // Unit, 1/1 — the floor case
const SURGERY = "core-063"; // #63, +3/+3: the only way to give a Pillow attack to drain
const FRIEND = "core-062"; // #62, fills the board: a unit that arrives after the aura

function unitAt(s: Scenario, player: PlayerId, lane: number): CardInstance {
  const found = s.unit(player, lane);
  if (found === null) throw new Error(`expected a unit in ${player} lane ${lane}, found none`);
  return found;
}

function sel(card: CardInstance): Selection {
  return { pick: "instance", instanceId: card.id };
}

describe("#65.1 Spikey Pillow", () => {
  it("§10.4 your units have −2 attack", () => {
    const s = scenario({ p1: { field: [PILLOW, TIMMY] } });

    s.expectStats(unitAt(s, "p1", 2), { attack: 1, maxHealth: 3 });
  });

  it("§10.4 attack floors at 0 and max health is untouched", () => {
    const s = scenario({ p1: { field: [PILLOW, FELINOR] } });

    // 1 − 2 would be −1; `layers.ts` clamps the total at 0.
    s.expectStats(unitAt(s, "p1", 2), { attack: 0, maxHealth: 1, health: 1 });
    // The Pillow's own 0 attack is likewise floored, not negative.
    s.expectStats(unitAt(s, "p1", 1), { attack: 0, maxHealth: 2, health: 2 });
  });

  it("§10.4 the aura reaches the controller's units only", () => {
    const s = scenario({ p1: { field: [PILLOW] }, p2: { field: [TIMMY] } });

    s.expectStats(unitAt(s, "p2", 1), { attack: 3, maxHealth: 3 });
  });

  it("§10.4 the aura is computed on read, so a unit that arrives later is drained too", () => {
    const s = scenario({ p1: { field: [PILLOW], hand: [FRIEND], mana: 4 } });

    s.play(FRIEND);

    for (const lane of [2, 3, 4, 5]) {
      expect(unitAt(s, "p1", lane).defId).toBe(FELINOR);
      s.expectStats(unitAt(s, "p1", lane), { attack: 0, maxHealth: 1 });
    }
  });

  it("the base aura drains the Pillow itself", () => {
    const s = scenario({ p1: { field: [PILLOW], hand: [SURGERY], mana: 4 } });
    const pillow = unitAt(s, "p1", 1);

    s.play(SURGERY, { targets: [sel(pillow)] });

    // 0/2 buffed to 3/5, then its own "your units" aura takes 2 off.
    s.expectStats(pillow, { attack: 1, maxHealth: 5 });
  });

  it("radiant spares Spikey Pillows, itself included", () => {
    const s = scenario({
      p1: { field: [{ def: PILLOW, radiant: true }], hand: [SURGERY], mana: 4 },
    });
    const pillow = unitAt(s, "p1", 1);

    s.play(SURGERY, { targets: [sel(pillow)] });

    // 0/4 buffed to 3/7; "your non-Spikey-Pillow units" excludes it, so nothing is drained.
    s.expectStats(pillow, { attack: 3, maxHealth: 7 });
  });

  it("radiant excludes another Spikey Pillow", () => {
    const s = scenario({
      p1: {
        field: [{ def: PILLOW, radiant: true }, { def: PILLOW, radiant: true }],
        hand: [SURGERY],
        mana: 4,
      },
    });
    const second = unitAt(s, "p1", 2);

    s.play(SURGERY, { targets: [sel(second)] });

    s.expectStats(second, { attack: 3, maxHealth: 7 });
  });

  it("the base aura does NOT exclude another Spikey Pillow", () => {
    const s = scenario({
      p1: { field: [PILLOW, { def: PILLOW, radiant: true }], hand: [SURGERY], mana: 4 },
    });
    const second = unitAt(s, "p1", 2);

    s.play(SURGERY, { targets: [sel(second)] });

    // Lane 1 is on its base face — "your units" — so the buffed radiant Pillow loses 2.
    s.expectStats(second, { attack: 1, maxHealth: 7 });
  });

  it("radiant still drains your other units", () => {
    const s = scenario({ p1: { field: [{ def: PILLOW, radiant: true }, TIMMY] } });

    s.expectStats(unitAt(s, "p1", 2), { attack: 1, maxHealth: 3 });
  });

  it("§4.1 it can never switch to Defense Position", () => {
    const s = scenario({ p1: { field: [PILLOW, TIMMY] } });
    const pillow = unitAt(s, "p1", 1);

    expect(() => s.switchPosition(pillow)).toThrow(/Defense Position/);
    expect(s.card(pillow).position ?? "ATK").toBe("ATK");

    // The flag is the Pillow's alone: an ordinary unit beside it still switches.
    s.switchPosition(unitAt(s, "p1", 2));
    expect(s.card(unitAt(s, "p1", 2)).position).toBe("DEF");
  });

  it("§4.1 the radiant face cannot switch to Defense either", () => {
    const s = scenario({ p1: { field: [{ def: PILLOW, radiant: true }] } });
    const pillow = unitAt(s, "p1", 1);

    expect(() => s.switchPosition(pillow)).toThrow(/Defense Position/);
    s.expectStats(pillow, { attack: 0, maxHealth: 4 });
  });
});
