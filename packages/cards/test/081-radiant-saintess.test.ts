// #81 Radiant Saintess (SPEC §8.4 row 81; R8, R22, R64, R78, R83).
//
// BUILD M4-T4's must-pass row: "Cry makes every unit you control radiant including itself (R22);
// Death does it again; radiant Reborn body fires Death on its second death".
//
// Two fixtures do all the work:
//   - #11 Tempo Timmy (3/3 → 6/6, Rush + First Strike, cost 1) has an EMPTY script, so a stat
//     change on it can only be the radiant face swapping in — it is the observable for "became
//     Radiant" throughout.
//   - #44 True Strike ("deal 4 damage to a target, ignoring Armor") is how a Saintess is killed
//     mid-test without waiting for combat: 4 damage kills a 4/4 body and the 1-health Reborn body.
//
// A Saintess placed by the setup with damage equal to her health dies inside the setup's own state
// check, which is the cheapest way to fire a Death hook: the harness records no events for setup,
// so those cases assert the resulting state rather than the log.

import { keywordsOf } from "@jackioh/engine";
import { describe, expect, it } from "vitest";
import { scenario } from "./_harness";

/** #11 Tempo Timmy: no script, 3/3 base and 6/6 radiant, so its stats report its face. */
const TIMMY = "core-011";
const SAINTESS = "core-081";
/** #44 True Strike: 4 damage to any target, which is exactly a 4/4 Saintess. */
const TRUE_STRIKE = "core-044";
/** #8 Mr. Vanilla: Immutable 3/3 → 7/7 (R23 leaves Make Radiant legal on it). */
const MR_VANILLA = "core-008";

describe("#81 Radiant Saintess — base", () => {
  it("§8 THE CRY IS GONE: playing her radiates nothing, herself included", () => {
    const s = scenario({
      seed: "saintess",
      p1: { hand: [SAINTESS], field: [TIMMY] },
      p2: { field: [TIMMY] },
    }).play(SAINTESS, { zone: 2 });

    // She used to arrive 4/4 with Reborn and turn the board up on the spot for one mana. She now
    // lands as the 2/2 she is printed as, and nothing else moves until she dies.
    expect(s.card(SAINTESS).radiant).toBe(false);
    s.expectStats(SAINTESS, { attack: 2, health: 2, maxHealth: 2 });
    expect(s.unit("p1", 1)?.radiant).toBe(false);
    s.expectEvents("cardPlayed", "summoned");
  });

  /** Reborn is printed on the RADIANT face, which her Cry used to hand her for free. */
  it("§8 played base she has no Reborn, because nothing makes her Radiant any more", () => {
    const s = scenario({ seed: "saintess", p1: { hand: [SAINTESS] } }).play(SAINTESS, { zone: 1 });

    expect(s.card(SAINTESS).radiant).toBe(false);
    expect(keywordsOf(s.state, s.card(SAINTESS))).toEqual([]);
  });

  it("§8 'your units' is yours: the opponent's units are untouched", () => {
    const s = scenario({
      seed: "saintess",
      p1: { hand: [SAINTESS] },
      p2: { field: [TIMMY] },
    }).play(SAINTESS, { zone: 1 });

    const enemy = s.unit("p2", 1);
    expect(enemy?.radiant).toBe(false);
    s.expectStats(enemy ?? SAINTESS, { attack: 3, health: 3, maxHealth: 3 });
  });

  it("§8 'units': a backrow card of yours is not a unit and stays as it is", () => {
    // #73 Anti-oneshot Armor is a Field Spell, so it sits in the backrow and is never radiated.
    const s = scenario({
      seed: "saintess",
      p1: { hand: [SAINTESS], backrow: [{ def: "core-073", lane: 1 }] },
    }).play(SAINTESS, { zone: 1 });

    expect(s.backrow("p1", 1)?.radiant).toBe(false);
  });

  it("R22 the base layer swaps while damage and buffs stay: a damaged unit keeps its damage", () => {
    const s = scenario({
      seed: "saintess",
      // She dies in the setup's state check (§4.5 step 3), which runs her Death.
      p1: { field: [{ def: SAINTESS, damage: 2 }, { def: TIMMY, damage: 1 }] },
    });

    // 3/3 with 1 damage becomes 6/6 with 1 damage — max health up, the damage untouched.
    s.expectStats(s.unit("p1", 2) ?? TIMMY, { attack: 6, health: 5, maxHealth: 6 });
  });

  it("R23 Make Radiant is still allowed on an Immutable unit", () => {
    const s = scenario({
      seed: "saintess",
      p1: { field: [{ def: SAINTESS, damage: 2 }, MR_VANILLA] },
    });

    expect(s.unit("p1", 2)?.radiant).toBe(true);
    s.expectStats(MR_VANILLA, { attack: 7, health: 7, maxHealth: 7 });
  });

  it("§6.3 a unit that is already Radiant is untouched and emits nothing for it", () => {
    const s = scenario({
      seed: "saintess",
      p1: { field: [{ def: SAINTESS, damage: 2 }, { def: TIMMY, radiant: true }] },
    });

    // The only other unit was already Radiant, so her Death has nothing left to set.
    expect(s.lastEvents.filter((event) => event.type === "radiantSet")).toHaveLength(0);
    expect(s.unit("p1", 2)?.radiant).toBe(true);
  });

  it("Death does it again: a Saintess that dies radiates the units still standing", () => {
    // 2/2 with 2 damage dies in the setup's state check, which runs her Death hook (§4.5 step 3).
    const s = scenario({
      seed: "saintess",
      p1: { field: [{ def: SAINTESS, damage: 2 }, TIMMY] },
    });

    expect(s.unit("p1", 2)?.radiant).toBe(true);
    s.expectStats(s.unit("p1", 2) ?? TIMMY, { attack: 6, health: 6, maxHealth: 6 });
    s.expectInZone(SAINTESS, "graveyard");
  });

  it("R78 Death does not include herself: the base body reaches the graveyard non-Radiant", () => {
    // Her Cry never ran (she was placed, not played), so nothing has set her flag. R78 has her
    // leave the field before the Death hook runs, so "your units" no longer includes her.
    const s = scenario({ seed: "saintess", p1: { field: [{ def: SAINTESS, damage: 2 }, TIMMY] } });

    expect(s.pile("p1", "graveyard").map((card) => card.radiant)).toEqual([false]);
  });

  it("§8 played base she dies ONCE: no Cry means no Radiant, and so no Reborn to bring her back", () => {
    // Mana at turn 9 is 4: Saintess 1 + True Strike 1 + Timmy 1 + True Strike 1.
    const s = scenario({
      seed: "saintess",
      p1: { hand: [SAINTESS, TRUE_STRIKE, TIMMY, TRUE_STRIKE] },
    }).play(SAINTESS, { zone: 1 });

    // The 2/2 base face, because nothing radiated her on the way in.
    const saintess = s.card(SAINTESS);
    s.expectStats(saintess, { attack: 2, health: 2, maxHealth: 2 });

    // A fresh unit to watch her Death land on.
    s.play(TIMMY, { zone: 2 });
    expect(s.unit("p1", 2)?.radiant).toBe(false);

    // One death, and it is final: Reborn is printed on the RADIANT face only, and her own Cry
    // used to be the thing that put her on it. Removing the Cry removed the Reborn with it.
    s.play(TRUE_STRIKE, { targets: [{ pick: "instance", instanceId: saintess.id }] });
    s.expectInZone(saintess, "graveyard");
    expect(s.unit("p1", 2)?.radiant, "her Death still radiates the board").toBe(true);
    s.expectStats(s.unit("p1", 2) ?? TIMMY, { attack: 6, health: 6, maxHealth: 6 });
  });

  it.todo(
    "R13 a card dormant under a Stack is not one of your units — blocked on harness support for " +
      "seeding a Stack pile (SideSetup.field has no way to put two cards in one lane)",
  );
});

describe("#81 Radiant Saintess — radiant", () => {
  it("'Reborn; same': the radiant face is 4/4 with Reborn, and it radiates nothing on arrival either", () => {
    const s = scenario({ seed: "saintess", p1: { hand: [SAINTESS], field: [TIMMY] } });
    // Stands in for a missing `{ def, radiant }` form on SideSetup.hand (harness request).
    s.card(SAINTESS).radiant = true;
    s.play(SAINTESS, { zone: 2 });

    s.expectStats(SAINTESS, { attack: 4, health: 4, maxHealth: 4 });
    expect(keywordsOf(s.state, s.card(SAINTESS))).toEqual([{ kind: "Reborn" }]);
    // "same" means the same script, and the script is now Death alone — so the ally is untouched
    // until she dies, on this face exactly as on the base one.
    expect(s.unit("p1", 1)?.radiant).toBe(false);
  });

  it("R8/R83 the radiant Reborn body fires Death on its second death", () => {
    const s = scenario({ seed: "saintess", p1: { hand: [SAINTESS, TRUE_STRIKE, TIMMY, TRUE_STRIKE] } });
    s.card(SAINTESS).radiant = true;
    s.play(SAINTESS, { zone: 1 });

    const saintess = s.card(SAINTESS);
    s.play(TRUE_STRIKE, { targets: [{ pick: "instance", instanceId: saintess.id }] });
    // Death #1 fired and Reborn returned her: R78 resets her, so she is back at 1 health.
    s.expectInZone(saintess, "field");
    s.expectStats(saintess, { attack: 4, health: 1, maxHealth: 4 });

    s.play(TIMMY, { zone: 2 });
    expect(s.unit("p1", 2)?.radiant).toBe(false);

    s.play(TRUE_STRIKE, { targets: [{ pick: "instance", instanceId: saintess.id }] });
    s.expectInZone(saintess, "graveyard");
    // The second Death really ran: the unit that entered after the first one is Radiant now.
    expect(s.unit("p1", 2)?.radiant).toBe(true);
  });

  it("R64 the Reborn body comes back to the zone it died in, which nothing else may take", () => {
    const s = scenario({ seed: "saintess", p1: { hand: [SAINTESS, TRUE_STRIKE, TIMMY] } });
    s.card(SAINTESS).radiant = true;
    s.play(SAINTESS, { zone: 3 });

    const saintess = s.card(SAINTESS);
    s.play(TRUE_STRIKE, { targets: [{ pick: "instance", instanceId: saintess.id }] });

    expect(s.unit("p1", 3)?.id).toBe(saintess.id);
  });
});
