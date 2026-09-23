// A permanent's lasting effect lasts while it is on the field (SPEC §5.1, §5.2, R30, R209). Found by
// the polish-4 edge-case hunt, round 2 (docs/polish/4-edge-cases.md, lenses L1, L2 and L8); every
// case here failed before its fix.
//
// #79 Twinspell's "the next Spell you play gains Echo +1" is a player modifier its Cry installs,
// which the engine used to end only by consuming it. So a Twinspell that left the field — bounced by
// radiant #52, destroyed by #36 — kept echoing its old controller's next Spell, and one bounced and
// replayed stacked a second rider. And the rider's amount was fixed by the face that installed it,
// so a Twinspell radiant #49 stole and made Radiant still granted +1.

import type { GameEvent } from "@jackioh/shared";
import { describe, expect, it } from "vitest";
import { scenario, type Scenario } from "./_harness";

const STOCKPILE = "core-005";
const VANILLA = "core-008";
const MAGIC_JAMMED = "core-036";
const MIND_CONTROL = "core-049";
const SILAS = "core-052";
const TWINSPELL = "core-079";
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

    // Replayed (costing 0): its Cry installs the one grant this Twinspell now has.
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
