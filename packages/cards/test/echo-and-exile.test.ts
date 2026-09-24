// Echo's repeats, the state check between them, and a Spell that exiles itself (SPEC §4.5, §6.2
// Echo, §10.5 steps 4 to 7, R30, R59, R178). Found by the polish-4 edge-case hunt
// (docs/polish/4-edge-cases.md, lens L7); every case here failed before its fix.
//
//  - §4.5: the state check runs after a Spell's first resolution, before its Echo repeat asks
//    anything, so a unit the first resolution killed is not offered again and a hero it killed ends
//    the game there.
//  - R178: "exile this" is where §10.5 step 7 sends a Spell, so a self-exiling Spell still takes
//    Twinspell's Echo and still resolves its repeat; and the Echo is gained as the Spell is played,
//    so a Spell that moves Twinspell away (#87's board swap) has already taken it.

import type { Selection } from "@jackioh/shared";
import type { CardInstance } from "@jackioh/engine";
import { describe, expect, it } from "vitest";
import { scenario, type Scenario } from "./_harness";

const TWINSPELL = "core-079";
const HIT_JOB = "core-016";
const LUNAR_ECLIPSE = "core-035";
const TRUE_STRIKE = "core-044";
const MROW = "core-086";
const CHAOS = "core-087";
const POINTMASTER = "core-020";
const VANILLA = "core-008";
const SEVEN_SEVEN = "core-025";
const RENO = "core-053";
const LIBRARY = [RENO, RENO, RENO, RENO, RENO, RENO];

const at = (card: CardInstance): Selection[] => [{ pick: "instance", instanceId: card.id }];

function unitAt(g: Scenario, player: "p1" | "p2", lane: number): CardInstance {
  const card = g.unit(player, lane);
  if (card === null) throw new Error(`setup: ${player} should hold a unit in lane ${lane}`);
  return card;
}

function optionIds(g: Scenario): string[] {
  return (g.state.pending?.options ?? []).flatMap((option) =>
    option.selection.pick === "instance" ? [option.selection.instanceId] : [],
  );
}

describe("§4.5: the state check between an Echo's resolutions", () => {
  it("§4.5 an Echo repeat's prompt is asked after the first resolution's deaths, so a destroyed unit is not offered again (R59)", () => {
    // Twinspell gives Hit Job Echo +1. The first resolution destroys the enemy Mrow; by the time the
    // repeat asks its fresh target prompt Mrow has died, and its Death has run.
    const g = scenario({
      p1: { hand: [TWINSPELL, HIT_JOB, RENO], field: [{ def: SEVEN_SEVEN, lane: 2 }], mana: 8, library: [...LIBRARY] },
      p2: { hand: [RENO], field: [{ def: MROW, lane: 1 }, { def: POINTMASTER, lane: 4 }], library: [...LIBRARY] },
    });
    const mrow = unitAt(g, "p2", 1);

    g.play(TWINSPELL);
    g.play(HIT_JOB, { targets: at(mrow) });

    expect(g.state.pending?.kind).toBe("target");
    expect(optionIds(g)).not.toContain(mrow.id);
    g.expectInZone(mrow, "graveyard");
  });

  it("§4.5 a hero at 0 after an Echo's first resolution ends the game before the repeat asks anything (§2.5)", () => {
    const g = scenario({
      p1: { hand: [TWINSPELL, LUNAR_ECLIPSE, RENO], mana: 8, library: [...LIBRARY] },
      p2: { hand: [RENO], health: 3, field: [{ def: VANILLA, lane: 3 }], library: [...LIBRARY] },
    });

    g.play(TWINSPELL);
    g.play(LUNAR_ECLIPSE, { targets: [{ pick: "hero", player: "p2" }] });

    expect(g.state.result).toEqual({ winner: "p1", reason: "hero-death" });
    expect(g.state.pending).toBeNull();
  });
});

describe("R178: a Spell's 'exile this' is its landing, and its Echo is gained as it is played", () => {
  it("R178 a self-exiling Spell takes Twinspell's Echo, resolves twice and lands in exile (§6.2, R30)", () => {
    // True Strike: "Deal 4 damage to a target, ignoring Armor; exile this". With Twinspell it
    // resolves twice — the repeat asks for its target again — and only then goes to exile.
    const g = scenario({
      p1: { hand: [TWINSPELL, TRUE_STRIKE, RENO], mana: 8, library: [...LIBRARY] },
      p2: { hand: [RENO], field: [{ def: SEVEN_SEVEN, lane: 1 }], library: [...LIBRARY] },
    });
    const twin = g.card(TWINSPELL);
    const strike = g.card(TRUE_STRIKE);

    g.play(TWINSPELL);
    g.play(TRUE_STRIKE, { targets: [{ pick: "hero", player: "p2" }] });
    // Still resolving, and still itself, while its repeat asks (R98).
    expect(g.card(strike).zone.z).toBe("resolving");
    g.expectInZone(twin, "graveyard");
    g.answer([{ pick: "hero", player: "p2" }]);

    g.expectHealth("p2", 22);
    g.expectInZone(strike, "exile");
    expect(g.state.counters.exiled).toBe(1);
    expect(g.state.players.p1.mods.filter((mod) => mod.kind === "echoNextSpell")).toEqual([]);
  });

  it("R178 Twinspell is consumed by the next Spell played even when that Spell swaps it away and exiles itself (R30)", () => {
    // Pocket Chaos swaps the boards — Twinspell with them — and exiles itself. The Echo was already
    // gained as it was played, so Twinspell went to the graveyard first and the repeat still comes.
    const g = scenario({
      p1: { hand: [TWINSPELL, CHAOS, RENO], field: [{ def: SEVEN_SEVEN, lane: 2 }], mana: 8, library: [...LIBRARY] },
      p2: { hand: [RENO], field: [{ def: VANILLA, lane: 3 }], library: [...LIBRARY] },
    });
    const twin = g.card(TWINSPELL);
    const chaos = g.card(CHAOS);

    g.play(TWINSPELL);
    g.play(CHAOS, { modes: ["board"] });
    // The repeat's fresh mode prompt (§10.6: an Echo repeat asks again).
    expect(g.state.pending?.kind).toBe("mode");
    while (g.state.pending !== null) {
      const first = g.state.pending.options[0];
      if (first === undefined) break;
      g.answer([first.selection]);
    }

    g.expectInZone(twin, "graveyard");
    g.expectInZone(chaos, "exile");
    expect(g.state.players.p1.mods.filter((mod) => mod.kind === "echoNextSpell")).toHaveLength(0);
    expect(g.state.players.p2.mods.filter((mod) => mod.kind === "echoNextSpell")).toHaveLength(0);
  });
});
