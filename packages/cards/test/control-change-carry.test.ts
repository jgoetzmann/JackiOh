// What a card's "you" follows once it changes sides (SPEC §6.2, §8 Conventions: "'Your' means the
// controller", R30, R171). Found by the polish-4 edge-case hunt (docs/polish/4-edge-cases.md, lens
// L1); every case here failed before its fix.
//
//  - #79 Twinspell's "the next Spell you play gains Echo +1" is a modifier the permanent installed,
//    and it moves with the permanent to its new controller.
//  - §6.2: a start-of-turn hook fires on its controller's own turn start. One queued for that
//    controller does not fire for the player who took the card while the queue was running.

import type { Selection } from "@jackioh/shared";
import type { CardInstance } from "@jackioh/engine";
import { describe, expect, it } from "vitest";
import { scenario, type Scenario } from "./_harness";

const STOCKPILE = "core-005";
const VANILLA = "core-008";
const MOTHS = "core-009";
const POINTMASTER = "core-020";
const SEVEN_SEVEN = "core-025";
const GRAVEDIGGER = "core-037";
const KPOP = "core-050";
const TWINSPELL = "core-079";
const MROW = "core-086";
const LIBRARY = [VANILLA, VANILLA, VANILLA, VANILLA, VANILLA, VANILLA, VANILLA, VANILLA];

const at = (card: CardInstance): Selection[] => [{ pick: "instance", instanceId: card.id }];

function unitAt(g: Scenario, player: "p1" | "p2", lane: number): CardInstance {
  const card = g.unit(player, lane);
  if (card === null) throw new Error(`setup: ${player} should hold a unit in lane ${lane}`);
  return card;
}

function backrowAt(g: Scenario, player: "p1" | "p2", lane: number): CardInstance {
  const card = g.backrow(player, lane);
  if (card === null) throw new Error(`setup: ${player} should hold a backrow card in lane ${lane}`);
  return card;
}

describe("R30: a stolen Twinspell's grant is its new controller's", () => {
  it("R30 a stolen Twinspell grants its Echo to the thief's next Spell and goes to its owner's graveyard (§8 #79, R12, R171)", () => {
    const g = scenario({
      p1: { hand: [TWINSPELL, VANILLA], field: [{ def: VANILLA, lane: 1 }], library: [...LIBRARY] },
      p2: { hand: [KPOP, STOCKPILE, VANILLA], field: [{ def: VANILLA, lane: 1 }], library: [...LIBRARY] },
    });
    g.play(TWINSPELL, { zone: 3 });
    const twinspell = backrowAt(g, "p1", 3);
    g.endTurn();

    // p2 takes it with Kpop Fanatic, so no Spell of p2's is in flight when control changes.
    g.play(KPOP, { targets: at(twinspell) });
    g.endTurn();
    expect(g.state.active).toBe("p1");
    g.endTurn();
    // The steal fired at the start of p2's turn, and the modifier went with the card; both seats
    // were told, since `modifierChanged` names the seat (R169).
    expect(g.state.active).toBe("p2");
    expect(g.card(twinspell).controller).toBe("p2");
    expect(g.state.players.p1.mods.filter((mod) => mod.kind === "echoNextSpell")).toEqual([]);
    expect(g.state.players.p2.mods.filter((mod) => mod.kind === "echoNextSpell")).toHaveLength(1);
    expect(g.lastEvents.filter((event) => event.type === "modifierChanged").map((event) => [event.player, event.added])).toEqual([
      ["p1", false],
      ["p2", true],
    ]);

    // p2's Stockpile resolves twice (draw 2, twice), and Twinspell goes to its owner's graveyard.
    const before = g.hand("p2").length;
    g.play(STOCKPILE);
    expect(g.hand("p2").length).toBe(before - 1 + 4);
    g.expectInZone(twinspell, "graveyard");
    expect(g.state.players.p2.mods.filter((mod) => mod.kind === "echoNextSpell")).toEqual([]);
  });
});

describe("§6.2: a start-of-turn hook belongs to its controller's turn", () => {
  it("§6.2 a Gravedigger stolen part-way through its controller's start-of-turn queue does not fire for the thief (R62, R153)", () => {
    const g = scenario({
      p1: {
        hand: [VANILLA],
        field: [{ def: MOTHS, lane: 1 }, { def: GRAVEDIGGER, lane: 2 }],
        graveyard: [POINTMASTER],
        library: [...LIBRARY],
      },
      p2: { hand: [VANILLA], field: [{ def: MROW, lane: 1 }], graveyard: [SEVEN_SEVEN], library: [...LIBRARY] },
    });
    const digger = unitAt(g, "p1", 2);
    const mrow = unitAt(g, "p2", 1);
    const p2Hand = g.hand("p2").length;

    // p1's start of turn queues Moths (lane 1), then Gravedigger (lane 2). Moths compels Mrow, which
    // dies to the strike back; its Death steals every p1 unit for p2, Gravedigger included.
    g.startTurn();
    g.expectInZone(mrow, "graveyard");
    expect(g.card(digger).controller).toBe("p2");

    // Gravedigger is p2's now and this is p1's turn start: its queued hook fizzles.
    expect(g.hand("p2").length).toBe(p2Hand);
    expect(g.pile("p2", "graveyard").map((card) => card.defId)).toContain(SEVEN_SEVEN);
  });
});
