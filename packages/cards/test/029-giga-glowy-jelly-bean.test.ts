// #29 GIGA Glowy Jelly Bean (SPEC §8.2, BUILD M4-T4 row 29): "Uncastable at 4 mana, castable at 6
// after gains; whole hand radiant; radiant also permanents".

import { describe, expect, it } from "vitest";
import type { CardInstance, GameState } from "@jackioh/engine";
import { MAX_MANA, newInstance } from "@jackioh/engine";
import { scenario } from "./_harness";

/** Your permanents as §6.3 means them: units (top of each pile only, R13) and backrow. */
function permanentsOf(state: GameState): CardInstance[] {
  const side = state.players.p1;
  return [
    ...side.units.flatMap((pile) => (pile === null ? [] : [pile[0] as CardInstance])),
    ...side.backrow.flatMap((card) => (card === null ? [] : [card])),
  ];
}

function giga(mana: number, radiant = false) {
  return scenario({
    p1: {
      hand: [{ def: "core-029", radiant }, "core-005", "core-016", "core-010"],
      field: [{ def: "core-013", damage: 2 }, "core-025"],
      backrow: ["core-006"],
      library: ["core-043"],
      mana,
    },
    p2: { hand: ["core-005"], field: ["core-025"], library: ["core-010"] },
  });
}

function otherHandIds(state: GameState): string[] {
  return state.players.p1.hand.filter((card) => card.defId !== "core-029").map((card) => card.id);
}

describe("#29 GIGA Glowy Jelly Bean — base", () => {
  it("costs 6, so a mana refresh alone can never cast it (MAX_MANA is 4)", () => {
    expect(MAX_MANA).toBe(4);
    const s = giga(4);

    expect(() => s.play("core-029")).toThrow(/6/);
    // Nothing happened: no card played, no flag set.
    expect(s.state.players.p1.hand.map((card) => card.radiant)).not.toContain(true);
    expect(s.state.players.p1.turnLog.cardsPlayed).toBe(0);
  });

  it("is castable at 6 once mana gains take current above max (§2.3)", () => {
    const s = giga(6);

    s.play("core-029");

    s.expectInZone("core-029", "graveyard").expectMana("p1", 0);
    expect(s.state.players.p1.turnLog.cardsPlayed).toBe(1);
  });

  it("flags every card in your hand, and nothing in any other zone", () => {
    const s = giga(6);
    const handIds = otherHandIds(s.state);
    const permanentIds = permanentsOf(s.state).map((card) => card.id);

    s.play("core-029");

    expect(s.state.players.p1.hand.map((card) => card.id).sort()).toEqual([...handIds].sort());
    for (const id of handIds) expect(s.card(id).radiant).toBe(true);
    // The base cell is the hand only: permanents, library and the opponent are untouched.
    for (const id of permanentIds) expect(s.card(id).radiant).toBe(false);
    for (const card of s.state.players.p1.library) expect(card.radiant).toBe(false);
    for (const card of s.state.players.p2.hand) expect(card.radiant).toBe(false);
  });

  it("§10.5 never flags itself: the card is in the resolving zone while its script runs", () => {
    const s = giga(6);
    const selfId = s.state.players.p1.hand.find((card) => card.defId === "core-029")?.id ?? "";

    s.play("core-029");

    expect(s.card(selfId).radiant).toBe(false);
  });
});

describe("#29 GIGA Glowy Jelly Bean — radiant", () => {
  it("flags your hand and all your permanents, units and backrow alike", () => {
    const s = giga(6, true);
    const handIds = otherHandIds(s.state);
    const permanentIds = permanentsOf(s.state).map((card) => card.id);
    expect(permanentIds).toHaveLength(3); // two units plus a Field Spell in the backrow

    s.play("core-029");

    for (const id of [...handIds, ...permanentIds]) expect(s.card(id).radiant).toBe(true);
    // "Your" is the controller (R12), so nothing of the opponent's converts.
    for (const card of s.state.players.p2.hand) expect(card.radiant).toBe(false);
    expect(s.unit("p2", 1)?.radiant).toBe(false);
    // The library is in neither cell.
    for (const card of s.state.players.p1.library) expect(card.radiant).toBe(false);
  });

  it("R22 a permanent swaps its base stats in place, keeping the damage it has taken", () => {
    const s = giga(6, true);
    const unitId = s.unit("p1", 1)?.id ?? "";
    s.expectStats(unitId, { attack: 8, maxHealth: 10, health: 8 });

    s.play("core-029");

    // #13 Jlockeed Shredder-10 is 8/10 → 16/20; the 2 damage stays, so health is 18 and no Cry
    // re-fires, because setting a flag is not an entry to the field.
    s.expectStats(unitId, { attack: 16, maxHealth: 20, health: 18 });
    expect(s.lastEvents.filter((event) => event.type === "summoned")).toHaveLength(0);
  });

  it("R13 leaves a card under a Stack pile alone: it is not on the field", () => {
    const s = giga(6, true);
    const pile = s.state.players.p1.units[0];
    expect(pile).toBeTruthy();
    if (pile === null || pile === undefined) return;
    const dormantId = pile[0]?.id ?? "";
    const top = newInstance(s.state, "core-025", "p1", {
      z: "field",
      player: "p1",
      row: "units",
      lane: 1,
    });
    pile.unshift(top);

    s.play("core-029");

    expect(s.card(top.id).radiant).toBe(true);
    expect(s.card(dormantId).radiant).toBe(false);
  });
});
