// #28 Knockoff Temu Glowy Jelly Bean (SPEC §8.2, BUILD M4-T4 row 28): "2 different non-Radiant
// cards across library+hand+field (R60); a field unit swaps base stats in place keeping damage
// (R22); radiant 5".

import { describe, expect, it } from "vitest";
import type { CardInstance, GameState } from "@jackioh/engine";
import { newInstance } from "@jackioh/engine";
import { scenario } from "./_harness";
import type { FieldSetup, PileSetup } from "./_harness";

const SEED = "core-028";

/** Exactly the union #28 draws from: hand, library and field — never the graveyard. */
function poolCards(state: GameState): CardInstance[] {
  const side = state.players.p1;
  return [
    ...side.hand,
    ...side.library,
    ...side.units.flatMap((pile) => (pile === null ? [] : [pile[0] as CardInstance])),
    ...side.backrow.flatMap((card) => (card === null ? [] : [card])),
  ];
}

function radiantInPool(state: GameState): string[] {
  return poolCards(state)
    .filter((card) => card.radiant)
    .map((card) => card.id);
}

function knockoff(side: { hand: PileSetup[]; library?: PileSetup[]; field?: FieldSetup[] }) {
  return scenario({ seed: SEED, p1: { ...side, mana: 2 } });
}

describe("#28 Knockoff Temu Glowy Jelly Bean — base", () => {
  it("R60 flags 2 different non-Radiant cards drawn from library, hand and field as one pool", () => {
    const s = knockoff({
      hand: ["core-028", "core-005", "core-016"],
      library: ["core-010", "core-013"],
      field: ["core-025"],
    });

    s.play("core-028");

    const flagged = radiantInPool(s.state);
    expect(flagged).toHaveLength(2);
    expect(new Set(flagged).size).toBe(2);
    expect(s.state.pending).toBeNull();
    s.expectInZone("core-028", "graveyard");
  });

  it("R60 draws once over the union, so the same seed flags the same two cards (§9.3)", () => {
    const build = () =>
      knockoff({
        hand: ["core-028", "core-005", "core-016"],
        library: ["core-010", "core-013"],
        field: ["core-025"],
      }).play("core-028");

    expect(radiantInPool(build().state)).toEqual(radiantInPool(build().state));
  });

  it("R22 a field unit swaps its base stats in place and keeps the damage it has taken", () => {
    // The pool holds exactly one card — the unit on the field: #28 itself is in the `resolving`
    // zone while its script runs and the library is empty, so the pick is not a coin flip.
    const s = knockoff({ hand: ["core-028"], library: [], field: [{ def: "core-013", damage: 2 }] });
    const unitId = s.unit("p1", 1)?.id ?? "";
    s.expectStats(unitId, { attack: 8, maxHealth: 10, health: 8 });

    s.play("core-028");

    // #13 Jlockeed Shredder-10 is 8/10 → 16/20. R22: the base layer swaps, the 2 damage stays (so
    // health is 18, not a fresh 20), and setting a flag is no entry to the field, so no Cry re-fires.
    expect(s.card(unitId).radiant).toBe(true);
    s.expectStats(unitId, { attack: 16, maxHealth: 20, health: 18 });
    expect(s.card(unitId).damage).toBe(2);
    expect(s.lastEvents.filter((event) => event.type === "summoned")).toHaveLength(0);
  });

  it("R13 never picks a card under a Stack pile, which is not on the field", () => {
    const s = knockoff({ hand: ["core-028"], library: [], field: ["core-025"] });
    const pile = s.state.players.p1.units[0];
    expect(pile).toBeTruthy();
    if (pile === null || pile === undefined) return;
    const dormantId = pile[0]?.id ?? "";
    // §3.2: a Stack card enters an occupied unit zone and becomes the top of the pile; the card
    // beneath it is dormant, and R13 keeps a dormant card off the field and out of every pool.
    const top = newInstance(s.state, "core-025", "p1", {
      z: "field",
      player: "p1",
      row: "units",
      lane: 1,
    });
    pile.unshift(top);

    s.play("core-028");

    expect(s.card(top.id).radiant).toBe(true);
    expect(s.card(dormantId).radiant).toBe(false);
  });

  it("R60 does nothing at all when every card in the union is already Radiant", () => {
    const s = knockoff({
      hand: ["core-028", { def: "core-005", radiant: true }],
      library: [{ def: "core-010", radiant: true }],
      field: [{ def: "core-025", radiant: true }],
    });
    const stays = poolCards(s.state)
      .filter((card) => card.defId !== "core-028")
      .map((card) => card.id)
      .sort();

    s.play("core-028");

    expect(radiantInPool(s.state).sort()).toEqual(stays);
    // Nothing changed. R177: the picks R60 could not make are cued on the hidden cards of the union
    // (the hand's, then the library's), never on the public 7/7, so the other seat's stream does not
    // count how many hidden cards were Radiant already.
    const cued = s.lastEvents.flatMap((event) => (event.type === "radiantSet" ? [event.instanceId] : []));
    const hidden = [...s.state.players.p1.hand, ...s.state.players.p1.library].map((card) => card.id);
    expect(cued.length).toBeGreaterThan(0);
    for (const id of cued) expect(hidden).toContain(id);
  });
});

describe("#28 Knockoff Temu Glowy Jelly Bean — radiant", () => {
  it("flags 5 different cards across the same three zones", () => {
    const s = knockoff({
      hand: [{ def: "core-028", radiant: true }, "core-005", "core-016", "core-010"],
      library: ["core-013", "core-043", "core-047"],
      field: ["core-025"],
    });

    s.play("core-028");

    const flagged = radiantInPool(s.state);
    expect(flagged).toHaveLength(5);
    expect(new Set(flagged).size).toBe(5);
  });

  it("R60 takes all of them when the union holds fewer than 5 non-Radiant cards", () => {
    const s = knockoff({
      hand: [{ def: "core-028", radiant: true }, "core-005"],
      library: ["core-013"],
      field: ["core-025"],
    });

    s.play("core-028");

    // Three cards are left in the union once #28 has gone to the graveyard, and all three convert.
    expect(radiantInPool(s.state)).toHaveLength(3);
  });
});
