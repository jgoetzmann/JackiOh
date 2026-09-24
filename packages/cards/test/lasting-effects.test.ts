// A permanent's lasting effect lasts while it is on the field (SPEC §5.1, §5.2, R30, R169, R209).
// Found by the polish-4 edge-case hunt, rounds 2 and 4 (docs/polish/4-edge-cases.md, lenses L1, L2
// and L8); every case here failed before its fix.
//
// #79 Twinspell's "the next Spell you play gains Echo +1" is a player modifier, which the engine used
// to end only by consuming it. So a Twinspell that left the field — bounced by radiant #52, destroyed
// by #36 — kept echoing its old controller's next Spell, and one bounced and replayed stacked a
// second rider. And the rider's amount was fixed by the face that installed it, so a Twinspell
// radiant #49 stole and made Radiant still granted +1. Round 4: the rider was installed by a Cry,
// which #79 does not print (R169), so a Twinspell summoned onto the field (§6.2: no Cry) granted
// nothing, and neither did Twinspell's text fused by #85 onto the other player's Field Spell.

import type { GameEvent } from "@jackioh/shared";
import { describe, expect, it } from "vitest";
import { scenario, type Scenario } from "./_harness";

const STOCKPILE = "core-005";
const VANILLA = "core-008";
const MAGIC_JAMMED = "core-036";
const MIND_CONTROL = "core-049";
const SILAS = "core-052";
const TWINSPELL = "core-079";
const MANA_WELL = "core-006";
const HIT_JOB = "core-016";
const CUBE = "core-022";
const UNLICENSED = "core-085";
const LIBRARY = [VANILLA, VANILLA, VANILLA, VANILLA, VANILLA, VANILLA, VANILLA, VANILLA];

function echoRiders(g: Scenario, player: "p1" | "p2"): unknown[] {
  return g.state.players[player].mods.filter((mod) => mod.kind === "echoNextSpell");
}

/** Stockpile heals its hero once per resolution (§8 #5), so its `healed` events count them. */
function stockpileResolutions(events: readonly GameEvent[]): number {
  return events.filter((event) => event.type === "healed").length;
}

describe("R209: Twinspell's grant ends when Twinspell leaves the field", () => {
  it("R209 a Twinspell radiant Silly Silas bounces to its owner's hand takes its grant with it, so the next Spell resolves once (R30, §5.1)", () => {
    const g = scenario({
      p1: {
        hand: [TWINSPELL, { def: SILAS, radiant: true }, STOCKPILE, VANILLA],
        mana: 10,
        library: [...LIBRARY],
      },
      p2: { hand: [VANILLA], field: [{ def: VANILLA, lane: 3 }], library: [...LIBRARY] },
    });
    const twin = g.card(TWINSPELL);
    g.play(TWINSPELL, { zone: 5 });
    expect(echoRiders(g, "p1")).toHaveLength(1);

    // Backrow ring, rotating right from p1's seat: p1's lane 5 would cross to p2's lane 5, so the
    // radiant face bounces Twinspell to its owner's hand costing 0 instead (§8 #52, R14).
    g.play(SILAS, { zone: 1, modes: ["right"] });
    g.expectInZone(twin, "hand");

    // Twinspell is no longer on the field, so "the next Spell you play gains Echo +1" is no longer
    // anybody's: the rider is gone and Stockpile resolves once (draw 2).
    expect(echoRiders(g, "p1")).toEqual([]);
    const before = g.hand("p1").length;
    g.play(STOCKPILE);
    expect(stockpileResolutions(g.lastEvents)).toBe(1);
    expect(g.hand("p1").length).toBe(before - 1 + 2);
  });

  it("R209 a Twinspell bounced by radiant Silly Silas and replayed grants Echo +1 once, not twice (R30, R174)", () => {
    const g = scenario({
      p1: {
        hand: [TWINSPELL, { def: SILAS, radiant: true }, STOCKPILE, VANILLA],
        mana: 10,
        library: [...LIBRARY],
      },
      p2: { hand: [VANILLA], field: [{ def: VANILLA, lane: 3 }], library: [...LIBRARY] },
    });
    const twin = g.card(TWINSPELL);
    g.play(TWINSPELL, { zone: 5 });
    g.play(SILAS, { zone: 1, modes: ["right"] });
    g.expectInZone(twin, "hand");

    // Replayed (costing 0): standing on the field again, it has the one grant this Twinspell now has.
    g.play(twin, { zone: 4 });
    expect(echoRiders(g, "p1")).toHaveLength(1);

    const before = g.hand("p1").length;
    g.play(STOCKPILE);
    // One Twinspell, Echo +1: two resolutions, four cards.
    expect(stockpileResolutions(g.lastEvents)).toBe(2);
    expect(g.hand("p1").length).toBe(before - 1 + 4);
    g.expectInZone(twin, "graveyard");
  });

  it("R209 a Twinspell the opponent destroys with Magic Jammed leaves no grant behind, so the next Spell gains no Echo (R30, §5.1)", () => {
    const g = scenario({
      active: "p2",
      turn: 8,
      p1: { hand: [TWINSPELL, STOCKPILE, VANILLA], mana: 10, library: [...LIBRARY] },
      p2: { hand: [MAGIC_JAMMED, VANILLA], field: [{ def: VANILLA, lane: 3 }], library: [...LIBRARY] },
    });
    const twin = g.card(TWINSPELL);
    g.endTurn();
    expect(g.state.active).toBe("p1");
    g.play(TWINSPELL, { zone: 2 });
    g.endTurn();
    expect(g.state.active).toBe("p2");

    g.play(MAGIC_JAMMED, { targets: [{ pick: "instance", instanceId: twin.id }] });
    g.expectInZone(twin, "graveyard");
    expect(echoRiders(g, "p1")).toEqual([]);

    g.endTurn();
    expect(g.state.active).toBe("p1");
    const before = g.hand("p1").length;
    g.play(STOCKPILE);
    // One resolution of "draw 2" (the Stockpile itself left the hand).
    expect(stockpileResolutions(g.lastEvents)).toBe(1);
    expect(g.hand("p1").length).toBe(before - 1 + 2);
  });
});

describe("R209: Twinspell's grant follows its current face", () => {
  it("R209 a Twinspell stolen by radiant Snom Bunny Mind Control grants Echo +2 to the thief's next Spell (§5.2, §8 #49, #79)", () => {
    const g = scenario({
      active: "p2",
      turn: 8,
      p1: {
        hand: [{ def: MIND_CONTROL, radiant: true }, STOCKPILE, VANILLA],
        mana: 10,
        library: [...LIBRARY, ...LIBRARY],
      },
      p2: { hand: [TWINSPELL, VANILLA], field: [{ def: VANILLA, lane: 3 }], library: [...LIBRARY] },
    });
    const twin = g.card(TWINSPELL);
    g.play(TWINSPELL, { zone: 2 });
    g.endTurn();
    expect(g.state.active).toBe("p1");

    // "Steal target enemy permanent; it also becomes Radiant". Twinspell is p1's now, and Radiant
    // on the field, where §5.2 has its text be the radiant one from then on: "Echo +2".
    g.play(MIND_CONTROL, { targets: [{ pick: "instance", instanceId: twin.id }] });
    expect(g.card(twin).controller).toBe("p1");
    expect(g.card(twin).radiant).toBe(true);
    // R169's badge says so too.
    expect(g.view("p1").you.modifiers.map((mod) => mod.label)).toContain("Next Spell gains Echo +2");

    // Stockpile (draw 2, heal 2) resolves 1 + 2 = 3 times: six cards for the one played.
    const before = g.hand("p1").length;
    g.play(STOCKPILE);
    expect(stockpileResolutions(g.lastEvents)).toBe(3);
    expect(g.hand("p1").length).toBe(before - 1 + 6);
    g.expectInZone(twin, "graveyard");
  });
});

describe("R209: Twinspell's grant is the permanent's, however it came to stand on the field", () => {
  it("R209 Twinspells summoned by #22's Death grant their Echo like played ones, so the next Spell resolves three times (§6.2, R41, R169)", () => {
    const g = scenario({
      p1: { hand: [TWINSPELL, CUBE, HIT_JOB, STOCKPILE, VANILLA], mana: 10, library: [...LIBRARY] },
      p2: { hand: [VANILLA], field: [{ def: VANILLA, lane: 3 }], library: [...LIBRARY] },
    });
    g.play(TWINSPELL, { zone: 1 });
    const eaten = g.backrow("p1", 1);
    if (eaten === null) throw new Error("setup: p1's Twinspell");
    g.play(CUBE, { zone: 1, targets: [{ pick: "instance", instanceId: eaten.id }] });
    const cube = g.unit("p1", 1);
    if (cube === null) throw new Error("setup: p1's Cube");
    g.expectInZone(eaten, "graveyard");

    // Hit Job kills the Cube, whose Death summons two copies of the Twinspell it ate into p1's
    // backrow (R41, R64). A summon fires no Cry (§6.2).
    g.play(HIT_JOB, { targets: [{ pick: "instance", instanceId: cube.id }] });
    expect([g.backrow("p1", 1)?.defId, g.backrow("p1", 2)?.defId]).toEqual([TWINSPELL, TWINSPELL]);
    expect(echoRiders(g, "p1")).toHaveLength(2);

    // Each Twinspell standing on p1's side says "the next Spell you play gains Echo +1", and that
    // text is no Cry: Stockpile gains Echo +2 and resolves three times.
    g.play(STOCKPILE);
    expect(stockpileResolutions(g.lastEvents)).toBe(3);
  });

  it("R209 Twinspell fused by #85 onto the trap controller's Field Spell grants its Echo to that controller (R77, §8 Conventions)", () => {
    const g = scenario({
      active: "p2",
      p1: {
        backrow: [{ def: UNLICENSED, lane: 3 }, { def: MANA_WELL, lane: 1 }],
        hand: [STOCKPILE, VANILLA],
        library: [...LIBRARY],
      },
      p2: { hand: [TWINSPELL, VANILLA], mana: 10, library: [...LIBRARY] },
    });
    const well = g.backrow("p1", 1);
    if (well === null) throw new Error("setup: p1's Mana Well");

    // p2 plays Twinspell; after its arrival (R61) p1's #85 fuses it onto p1's Mana Well, which keeps
    // its instance on p1's side and now carries Twinspell's text as well (R77).
    g.play(TWINSPELL, { zone: 2 });
    expect(g.card(well).zone).toMatchObject({ z: "field", player: "p1" });
    expect(g.card(well).defId).not.toBe(MANA_WELL);
    expect(echoRiders(g, "p2")).toEqual([]);

    // "The next Spell you play gains Echo +1" now stands on p1's side, and "you" is its controller
    // (§8 Conventions): p1's next Spell, Stockpile, resolves twice.
    g.endTurn();
    expect(g.state.active).toBe("p1");
    g.play(STOCKPILE);
    expect(stockpileResolutions(g.lastEvents)).toBe(2);
  });
});
