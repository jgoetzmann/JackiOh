// #26 Glowy Jelly Bean (SPEC §8.2, BUILD M4-T4 row 26): "Chosen hand card gets radiant flag,
// picked as part of the play rather than a prompt (R81); radiant chooses 2, or the one card
// available".

import { describe, expect, it } from "vitest";
import type { GameState } from "@jackioh/engine";
import { scenario } from "./_harness";
import type { PileSetup } from "./_harness";

/** The ids of p1's Radiant hand cards, which is the whole of what this card does (R74). */
function radiantHand(state: GameState): string[] {
  return state.players.p1.hand.filter((card) => card.radiant).map((card) => card.id);
}

function handIdOf(state: GameState, defId: string): string {
  const card = state.players.p1.hand.find((held) => held.defId === defId);
  if (card === undefined) throw new Error(`no ${defId} in p1's hand`);
  return card.id;
}

/** #26 costs 3 on both faces: R74 leaves the cost alone when a card becomes Radiant (§5.2). */
function glowy(hand: PileSetup[]) {
  return scenario({ p1: { hand, mana: 3 } });
}

describe("#26 Glowy Jelly Bean — base", () => {
  it("R81 flags the hand card the play chose, with no prompt opened", () => {
    const s = glowy(["core-026", "core-005", "core-016"]);
    const chosen = handIdOf(s.state, "core-005");
    const other = handIdOf(s.state, "core-016");

    s.play("core-026", { targets: [{ pick: "instance", instanceId: chosen }] });

    // R81: the pick travelled in the play action, so resolution never paused.
    expect(s.state.pending).toBeNull();
    expect(radiantHand(s.state)).toEqual([chosen]);
    expect(s.card(other).radiant).toBe(false);
    s.expectInZone("core-026", "graveyard").expectEvents("cardPlayed", "radiantSet");
  });

  it("R74 the flag is the whole model, so the card's stats swap while it sits in hand (§5.2)", () => {
    const s = glowy(["core-026", "core-013"]);
    const chosen = handIdOf(s.state, "core-013");

    s.play("core-026", { targets: [{ pick: "instance", instanceId: chosen }] });

    // #13 Jlockeed Shredder-10 is 8/10 → 16/20: no card id changed, only the flag.
    s.expectStats(chosen, { attack: 16, maxHealth: 20 });
    expect(s.card(chosen).defId).toBe("core-013");
    expect(s.card(chosen).zone.z).toBe("hand");
  });

  it("§6.3 leaves a card that is already Radiant alone: nothing in Core un-sets the flag", () => {
    const s = glowy(["core-026", { def: "core-005", radiant: true }]);
    const chosen = handIdOf(s.state, "core-005");

    s.play("core-026", { targets: [{ pick: "instance", instanceId: chosen }] });

    expect(radiantHand(s.state)).toEqual([chosen]);
    // It was already Radiant, so there is no second `radiantSet` for it.
    expect(s.lastEvents.filter((event) => event.type === "radiantSet")).toHaveLength(0);
  });

  it("§8 conventions: an empty hand fizzles the pick and the spell still counts as played", () => {
    const s = glowy(["core-026"]);

    s.play("core-026");

    expect(s.state.pending).toBeNull();
    expect(radiantHand(s.state)).toEqual([]);
    // "The spell still counts as played": the `cardPlayed` event and the game counter, not
    // `turnLog`, which an empty hand's auto-end-of-turn has already cleared by now.
    expect(s.events.filter((event) => event.type === "cardPlayed")).toHaveLength(1);
    expect(s.state.counters.played).toBe(1);
    s.expectInZone("core-026", "graveyard");
  });
});

describe("#26 Glowy Jelly Bean — radiant", () => {
  it("chooses 2, and both cards get the flag from one play (R81)", () => {
    const s = glowy([{ def: "core-026", radiant: true }, "core-005", "core-016", "core-010"]);
    const first = handIdOf(s.state, "core-005");
    const second = handIdOf(s.state, "core-016");
    const untouched = handIdOf(s.state, "core-010");

    s.play("core-026", {
      targets: [
        { pick: "instance", instanceId: first },
        { pick: "instance", instanceId: second },
      ],
    });

    expect(s.state.pending).toBeNull();
    expect(radiantHand(s.state).sort()).toEqual([first, second].sort());
    expect(s.card(untouched).radiant).toBe(false);
  });

  it("R90 takes the one card available when the hand holds only one other", () => {
    const s = glowy([{ def: "core-026", radiant: true }, "core-005"]);
    const only = handIdOf(s.state, "core-005");

    // R90: "a declaration the board cannot satisfy does not refuse the play: the play is legal with
    // the answers that exist and the effect fizzles on resolution". So one selection reaches a
    // declaration that asks for two, and the second `setRadiant` finds nothing.
    s.play("core-026", { targets: [{ pick: "instance", instanceId: only }] });

    expect(radiantHand(s.state)).toEqual([only]);
    s.expectInZone("core-026", "graveyard");
  });
});
