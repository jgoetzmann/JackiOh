// #35 Lunar Eclipse — SPEC §8.2 row 35, BUILD M4-T4 must-pass row 35:
// "3 damage; next spell this turn −1; a unit play does not consume it; expires at cleanup;
//  radiant 6 / −2".
//
// RED UNTIL ONE VERB LANDS: the script imports `addPlayerModifier({ player, mod })`, which #64,
// #77, #78 and #79 import too and which `effects/index.ts` does not export yet, so this whole file
// fails to load until it is added. The discount also needs `reduce`'s play case to consume a
// `oncePerTurn` `costDiscount` once it applies; the script file's header has both notes.
//
// The second spell is #16 Hit Job, a 2-cost Spell: at full price p1 would be left with 1 mana, with
// the discount 2 (and 3 with the radiant −2).

import { describe, expect, it } from "vitest";
import { scenario } from "./_harness";
import type { CardInstance } from "@jackioh/engine";

function must(card: CardInstance | null, what: string): CardInstance {
  if (card === null) throw new Error(`the scenario has no ${what}`);
  return card;
}

const AT_ENEMY_HERO = [{ pick: "hero", player: "p2" } as const];

/** p1 holds the eclipse, a 2-cost spell and a 1-cost unit; both sides keep a unit on the board. */
function board(): ReturnType<typeof scenario> {
  return scenario({
    seed: "lunar",
    p1: { hand: ["35", "16", "15"], field: ["43"], library: ["15", "15", "15"] },
    p2: { field: ["15"], library: ["15", "15", "15"] },
  });
}

describe("#35 Lunar Eclipse — base", () => {
  it("deals 3 damage to the target through the §4.4 pipeline", () => {
    const s = board();
    s.play("35", { targets: AT_ENEMY_HERO });
    s.expectHealth("p2", 27);
    s.expectEvents("cardPlayed", "damage");
  });

  it("deals its 3 damage to a unit target as well", () => {
    const s = board();
    const prey = must(s.unit("p2", 1), "p2 lane 1");
    s.play("35", { targets: [{ pick: "instance", instanceId: prey.id }] });
    // A 1/1 dies to 3.
    s.expectInZone(prey, "graveyard");
  });

  it("the next Spell this turn costs 1 less", () => {
    const s = board();
    s.expectMana("p1", 4);

    s.play("35", { targets: AT_ENEMY_HERO });
    s.expectMana("p1", 3);

    s.play("16", { targets: [{ pick: "instance", instanceId: must(s.unit("p2", 1), "p2 lane 1").id }] });
    // Hit Job's printed 2, less 1.
    s.expectMana("p1", 2);
  });

  it("a unit play does not consume the discount", () => {
    const s = board();
    s.play("35", { targets: AT_ENEMY_HERO });
    s.expectMana("p1", 3);

    // #15 is a Unit, so `onlyType: "Spell"` leaves it at its printed 1 and the discount stands.
    s.play("15");
    s.expectMana("p1", 2);

    s.play("16", { targets: [{ pick: "instance", instanceId: must(s.unit("p2", 1), "p2 lane 1").id }] });
    s.expectMana("p1", 1);
  });

  it("only the NEXT Spell is cheaper, not every Spell this turn", () => {
    const s = scenario({
      seed: "lunar-one-spell",
      p1: { hand: ["35", "16", "16"], field: ["43"], library: ["15", "15", "15"], mana: 6 },
      p2: { field: ["15", "15"], library: ["15", "15", "15"] },
    });

    s.play("35", { targets: AT_ENEMY_HERO });
    s.expectMana("p1", 5);
    s.play("16", { targets: [{ pick: "instance", instanceId: must(s.unit("p2", 1), "p2 lane 1").id }] });
    s.expectMana("p1", 4);
    // The discount was consumed by the first Spell, so this one pays its printed 2.
    s.play("16", { targets: [{ pick: "instance", instanceId: must(s.unit("p2", 2), "p2 lane 2").id }] });
    s.expectMana("p1", 2);
  });

  it("the discount expires at cleanup", () => {
    const s = board();
    s.play("35", { targets: AT_ENEMY_HERO });
    expect(s.state.players.p1.mods).toHaveLength(1);

    s.endTurn();

    // §2.2: cleanup expires every "this turn" effect, the Lunar Eclipse discount by name.
    expect(s.state.players.p1.mods).toHaveLength(0);
  });

  it("a Spell on a later turn pays full price", () => {
    const s = board();
    s.play("35", { targets: AT_ENEMY_HERO });

    s.endTurn();
    s.endTurn();
    expect(s.state.active).toBe("p1");

    const mana = s.state.players.p1.mana.current;
    s.play("16", { targets: [{ pick: "instance", instanceId: must(s.unit("p2", 1), "p2 lane 1").id }] });
    s.expectMana("p1", mana - 2);
  });
});

describe("#35 Lunar Eclipse — radiant", () => {
  it("radiant deals 6 damage", () => {
    const s = board();
    s.card("35").radiant = true;
    s.play("35", { targets: AT_ENEMY_HERO });
    s.expectHealth("p2", 24);
  });

  it("radiant makes the next Spell this turn cost 2 less", () => {
    const s = board();
    s.card("35").radiant = true;

    s.play("35", { targets: AT_ENEMY_HERO });
    s.expectMana("p1", 3);

    s.play("16", { targets: [{ pick: "instance", instanceId: must(s.unit("p2", 1), "p2 lane 1").id }] });
    // Hit Job's printed 2, less 2, floored at 0 (R65).
    s.expectMana("p1", 3);
  });

  it("the radiant discount expires at cleanup too", () => {
    const s = board();
    s.card("35").radiant = true;
    s.play("35", { targets: AT_ENEMY_HERO });
    expect(s.state.players.p1.mods).toHaveLength(1);

    s.endTurn();

    expect(s.state.players.p1.mods).toHaveLength(0);
  });
});
