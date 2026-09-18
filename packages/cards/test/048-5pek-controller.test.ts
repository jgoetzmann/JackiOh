// #48 5pek Controller — SPEC §8.2, BUILD M4-T4: "Every unit switches, exertion untouched (R20),
// Spikey Pillow stays ATK; radiant enemy-only mode".
//
// R20 is asserted twice: once as "no unit's `exertion.switched` moved" and once as "a unit that has
// already attacked this turn still flips", which is the thing a switch costing exertion would make
// impossible (§4.1: one exertion per turn, one attack OR one switch).
//
// R81 is asserted as an absence: the radiant choice arrives in the play action's `modes`, so no
// `PendingChoice` is ever opened and `state.pending` stays null.
//
// The props are units with no script beyond printed keywords: #25 4-mana 7/7, #20 Pointmaster,
// #45 Deft Duelist, #11 Tempo Timmy. The exception is #65.1 Spikey Pillow, whose §4.1 ruling is the
// point of its case and whose `StaticFlags.neverDefense` lives in ITS card file.

import { describe, expect, it } from "vitest";
import { scenario } from "./_harness";
import { base, def, radiant } from "../src/scripts/048-5pek-controller";

const CONTROLLER = "core-048";
/** The radiant face in hand, so the modal text is the one that resolves (§5.2). */
const RADIANT_CONTROLLER = { def: CONTROLLER, radiant: true } as const;
const SEVEN_SEVEN = "core-025";
const POINTMASTER = "core-020";
const DUELIST = "core-045";
const TIMMY = "core-011";
const SPIKEY = "core-065-1";

describe("#48 5pek Controller", () => {
  it("base: every unit on both sides switches position, in either direction", () => {
    const g = scenario({
      p1: {
        hand: [CONTROLLER],
        field: [
          { def: SEVEN_SEVEN, lane: 1 },
          { def: POINTMASTER, lane: 2, position: "DEF" },
        ],
      },
      p2: {
        field: [
          { def: DUELIST, lane: 1 },
          { def: TIMMY, lane: 2, position: "DEF" },
        ],
      },
    });
    expect(g.unit("p1", 1)?.position).toBe("ATK");
    expect(g.unit("p1", 2)?.position).toBe("DEF");

    g.play(CONTROLLER);

    expect(g.unit("p1", 1)?.position).toBe("DEF");
    expect(g.unit("p1", 2)?.position).toBe("ATK");
    expect(g.unit("p2", 1)?.position).toBe("DEF");
    expect(g.unit("p2", 2)?.position).toBe("ATK");
    g.expectEvents("cardPlayed", "positionSwitched");
    g.expectMana("p1", 4);
  });

  it("R20 base: the switch spends no exertion — nothing's `switched` flag moves", () => {
    const g = scenario({
      p1: { hand: [CONTROLLER], field: [{ def: SEVEN_SEVEN, lane: 1 }] },
      p2: { field: [{ def: DUELIST, lane: 1 }, { def: TIMMY, lane: 2, position: "DEF" }] },
    });

    g.play(CONTROLLER);

    for (const [player, lane] of [["p1", 1], ["p2", 1], ["p2", 2]] as const) {
      const unit = g.unit(player, lane);
      expect(unit?.exertion.switched, `${player} lane ${lane} spent a switch`).toBe(false);
      expect(unit?.exertion.attacked).toBe(false);
    }
  });

  it("R20 base: a unit that already attacked this turn still switches", () => {
    const g = scenario({
      p1: { hand: [CONTROLLER], field: [{ def: SEVEN_SEVEN, lane: 1 }] },
      p2: { library: [TIMMY] },
    });
    const attacker = g.unit("p1", 1);
    if (attacker === null) throw new Error("setup: p1 should hold the 7/7");

    g.attack(attacker, "hero");
    g.expectHealth("p2", 23);
    expect(g.card(attacker).exertion.attacked).toBe(true);

    g.play(CONTROLLER);

    // §4.1 would refuse this as a player action; R20 says the effect does not care.
    expect(g.card(attacker).position).toBe("DEF");
    expect(g.card(attacker).exertion.switched).toBe(false);
  });

  it("§4.1 base: Spikey Pillow stays in Attack while everything around it flips", () => {
    const g = scenario({
      p1: { hand: [CONTROLLER], field: [{ def: SPIKEY, lane: 1 }, { def: SEVEN_SEVEN, lane: 2 }] },
      p2: { field: [{ def: DUELIST, lane: 1 }] },
    });

    g.play(CONTROLLER);

    // `StaticFlags.neverDefense` (#65.1's own card file) makes `combat.switchPosition` refuse it,
    // and `switchAllPositions` walks on: one unit refusing never stops the rest.
    expect(g.unit("p1", 1)?.position).toBe("ATK");
    expect(g.unit("p1", 1)?.exertion.switched).toBe(false);
    expect(g.unit("p1", 2)?.position).toBe("DEF");
    expect(g.unit("p2", 1)?.position).toBe("DEF");
  });

  it("radiant, mode \"enemy\": only the opponent's units switch (R81, no prompt)", () => {
    const g = scenario({
      p1: { hand: [RADIANT_CONTROLLER], field: [{ def: SEVEN_SEVEN, lane: 1 }] },
      p2: { field: [{ def: DUELIST, lane: 1 }, { def: TIMMY, lane: 2, position: "DEF" }] },
    });

    g.play(CONTROLLER, { modes: ["enemy"] });

    expect(g.unit("p1", 1)?.position).toBe("ATK");
    expect(g.unit("p2", 1)?.position).toBe("DEF");
    expect(g.unit("p2", 2)?.position).toBe("ATK");
    // R81: a declared mode travels with the play, so resolution never paused.
    expect(g.state.pending).toBeNull();
    expect(g.events.some((event) => event.type === "promptOpened")).toBe(false);
  });

  it("radiant, mode \"all\": both sides switch, exactly as the base face does", () => {
    const g = scenario({
      p1: { hand: [RADIANT_CONTROLLER], field: [{ def: SEVEN_SEVEN, lane: 1 }] },
      p2: { field: [{ def: DUELIST, lane: 1 }] },
    });

    g.play(CONTROLLER, { modes: ["all"] });

    expect(g.unit("p1", 1)?.position).toBe("DEF");
    expect(g.unit("p2", 1)?.position).toBe("DEF");
    expect(g.unit("p1", 1)?.exertion.switched).toBe(false);
  });

  it("R20 radiant: the enemy-only switch spends no enemy exertion either", () => {
    const g = scenario({
      p1: { hand: [RADIANT_CONTROLLER], field: [{ def: SEVEN_SEVEN, lane: 1 }] },
      p2: { field: [{ def: DUELIST, lane: 1 }] },
    });

    g.play(CONTROLLER, { modes: ["enemy"] });

    expect(g.unit("p2", 1)?.exertion.switched).toBe(false);
  });

  it("R81: only the radiant face declares a mode, and it declares no targets", () => {
    expect(def.id).toBe(CONTROLLER);
    expect(def.type).toBe("Spell");
    expect(def.cost).toBe(0);
    expect(base.modes).toBeUndefined();
    expect(radiant.modes).toEqual([{ kind: "mode", options: ["enemy", "all"] }]);
    expect(base.targets).toBeUndefined();
    expect(radiant.targets).toBeUndefined();
  });
});
