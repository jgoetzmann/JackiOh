// #81 Radiant Saintess (SPEC §8.4 row 81; R8, R13, R22, R23, R64, R78, R83, R177, R275).
//
// BUILD M4-T4's must-pass row: "Death makes every other unit you control Radiant; Reborn body fires
// Death on its second death; radiant also every card in your hand, hidden from the opponent (R177)".
//   Base:    "Reborn; Death: all your other units become Radiant"
//   Radiant: "Reborn; Death: all your other units and every card in your hand become Radiant"
// (R275's broader scope). Her old Cry, which radiated the board as she landed, is cut (§8's row).
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
import { scenario, type Scenario } from "./_harness";

/** #11 Tempo Timmy: no script, 3/3 base and 6/6 radiant, so its stats report its face. */
const TIMMY = "core-011";
const SAINTESS = "core-081";
/** #44 True Strike: 4 damage to any target, which is exactly a 4/4 Saintess. */
const TRUE_STRIKE = "core-044";
/** #8 Mr. Vanilla: Immutable 3/3 → 7/7 (R23 leaves Make Radiant legal on it). */
const MR_VANILLA = "core-008";
/** #5 Stockpile and #2 Bigot: two more hand cards to watch the radiant Death reach. */
const STOCKPILE = "core-005";
const BIGOT = "core-002";
/** #15 Me and Mr Token: a Unit whose Cry makes fresh base-face Rush Tokens (3 on its radiant face). */
const ME_AND_MR_TOKEN = "core-015";
const RUSH_TOKEN = "core-t-rush";
/** #92 Felinor Fiender, the Stack unit: on top of a pile, the card under it lies dormant (§3.2). */
const FIENDER = "core-092";

/** True Strike on the Saintess in lane 1: her Death runs in the state check that follows. */
function strikeSaintess(s: Scenario): Scenario {
  const saintess = s.unit("p1", 1);
  if (saintess?.defId !== SAINTESS) throw new Error("the Saintess should stand in p1's lane 1");
  return s.play(TRUE_STRIKE, { targets: [{ pick: "instance", instanceId: saintess.id }] });
}

/**
 * R13 on either face: the Saintess in lane 1 and, in lane 2, a §3.2 Stack pile — a Felinor Fiender
 * on top of a dormant Tempo Timmy. True Strike kills her, and her Death reaches the top of the pile
 * and not the card under it: a card dormant under a Stack is not on the field (R13), so it is not
 * one of "your other units".
 */
function expectStackSpared(radiantFace: boolean): void {
  const s = scenario({
    seed: "saintess-stack",
    p1: {
      field: [{ def: SAINTESS, radiant: radiantFace }, TIMMY, { def: FIENDER, stack: true }],
      hand: [TRUE_STRIKE, STOCKPILE],
    },
    p2: { hand: [STOCKPILE] },
  });
  const buried = s.card(TIMMY);
  const fiender = s.card(FIENDER);
  expect(s.unit("p1", 2)?.id, "the Fiender is on top of lane 2").toBe(fiender.id);

  strikeSaintess(s);

  expect(s.card(fiender).radiant, "the Fiender on top of the pile").toBe(true);
  // Still buried, still on its base face, and nothing was said about it.
  expect(s.unit("p1", 2)?.id).toBe(fiender.id);
  s.expectInZone(buried, "field");
  expect(s.card(buried).radiant, "the Timmy dormant under it").toBe(false);
  expect(
    s.events.filter((event) => event.type === "radiantSet" && event.instanceId === buried.id),
  ).toHaveLength(0);
}

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

  /**
   * Reborn is printed on BOTH faces. It used to be radiant-only, and her own Cry was what put her
   * on that face — so cutting the Cry would have taken the Reborn with it and nerfed a second
   * thing nobody asked to nerf. The Cry is gone; the body it used to buy is not.
   */
  it("§8 played base she still has Reborn, even though nothing makes her Radiant any more", () => {
    const s = scenario({ seed: "saintess", p1: { hand: [SAINTESS] } }).play(SAINTESS, { zone: 1 });

    expect(s.card(SAINTESS).radiant).toBe(false);
    expect(keywordsOf(s.state, s.card(SAINTESS))).toEqual([{ kind: "Reborn" }]);
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
    // Reborn catches her, so the Death fired from the field rather than the graveyard (R8, R64).
    s.expectInZone(SAINTESS, "field");
    expect(s.card(SAINTESS).rebornSpent).toBe(true);
  });

  it("R78 Death does not include herself: the base body reaches the graveyard non-Radiant", () => {
    // R78 has her leave the field before the Death hook runs, so "your units" never includes her.
    // Reborn returns her, and the body that comes back is still not Radiant.
    const s = scenario({ seed: "saintess", p1: { field: [{ def: SAINTESS, damage: 2 }, TIMMY] } });

    expect(s.card(SAINTESS).radiant).toBe(false);
    expect(s.pile("p1", "graveyard")).toHaveLength(0);
  });

  it("R8/R83 played base she dies TWICE: Reborn catches the first, and Death fires on both", () => {
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

    // Death #1 radiates the board, and Reborn returns her at 1 health (§4.5 step 4, R64).
    s.play(TRUE_STRIKE, { targets: [{ pick: "instance", instanceId: saintess.id }] });
    s.expectInZone(saintess, "field");
    expect(s.card(saintess).rebornSpent).toBe(true);
    expect(s.unit("p1", 2)?.radiant, "her Death radiates the board").toBe(true);
    s.expectStats(s.unit("p1", 2) ?? TIMMY, { attack: 6, health: 6, maxHealth: 6 });

    // Death #2, off the Reborn body — R8: "Death fires on both deaths".
    s.play(TRUE_STRIKE, { targets: [{ pick: "instance", instanceId: saintess.id }] });
    s.expectInZone(saintess, "graveyard");
  });

  it("§8 the base Death reaches the board only: the hand keeps its faces", () => {
    const s = strikeSaintess(
      scenario({
        seed: "saintess-base-hand",
        p1: { field: [SAINTESS, TIMMY], hand: [TRUE_STRIKE, TIMMY, STOCKPILE] },
        p2: { hand: [STOCKPILE] },
      }),
    );

    expect(s.unit("p1", 2)?.radiant, "the other unit").toBe(true);
    expect(s.hand("p1").map((card) => card.radiant)).toEqual([false, false]);
  });

  it("R13 a card dormant under a Stack is not one of your units: Death turns up the top of the pile only", () => {
    expectStackSpared(false);
  });
});

describe("#81 Radiant Saintess — radiant", () => {
  it("the radiant face is 4/4 with Reborn, and it radiates nothing on arrival either", () => {
    const s = scenario({
      seed: "saintess",
      p1: { hand: [{ def: SAINTESS, radiant: true }, TIMMY], field: [TIMMY] },
    });
    s.play(SAINTESS, { zone: 2 });

    s.expectStats(SAINTESS, { attack: 4, health: 4, maxHealth: 4 });
    expect(keywordsOf(s.state, s.card(SAINTESS))).toEqual([{ kind: "Reborn" }]);
    // Her script is Death alone, so neither the ally nor the hand moves until she dies.
    expect(s.unit("p1", 1)?.radiant).toBe(false);
    expect(s.hand("p1").map((card) => card.radiant)).toEqual([false]);
  });

  it("R275 Death: every other unit AND every card in your hand become Radiant", () => {
    const s = strikeSaintess(
      scenario({
        seed: "saintess-radiant-hand",
        p1: {
          field: [{ def: SAINTESS, radiant: true }, TIMMY],
          hand: [TRUE_STRIKE, TIMMY, STOCKPILE, BIGOT],
        },
        p2: { field: [TIMMY], hand: [STOCKPILE, BIGOT] },
      }),
    );

    // The board, as on the base face.
    expect(s.unit("p1", 2)?.radiant).toBe(true);
    s.expectStats(s.unit("p1", 2) ?? TIMMY, { attack: 6, health: 6, maxHealth: 6 });
    // Every card left in the hand (True Strike was resolving, so it is not one of them).
    expect(s.hand("p1").map((card) => card.defId)).toEqual([TIMMY, STOCKPILE, BIGOT]);
    expect(s.hand("p1").every((card) => card.radiant)).toBe(true);
    // A Radiant hand card reads its radiant face: Timmy is a 6/6 in hand now.
    const handTimmy = s.hand("p1").find((card) => card.defId === TIMMY);
    s.expectStats(handTimmy ?? TIMMY, { attack: 6, maxHealth: 6 });
    // "your": the opponent's board and hand are untouched.
    expect(s.unit("p2", 1)?.radiant).toBe(false);
    expect(s.hand("p2").some((card) => card.radiant)).toBe(false);
    // R78: she is not one of "your other units"; Reborn brings the Radiant body back.
    s.expectInZone(SAINTESS, "field");
    expect(s.card(SAINTESS).radiant).toBe(true);
  });

  it("R13 on the radiant face too, a card dormant under a Stack is not one of your units", () => {
    expectStackSpared(true);
  });

  it("R275 an empty hand leaves the Death to the board alone", () => {
    const s = strikeSaintess(
      scenario({
        seed: "saintess-radiant-empty-hand",
        p1: { field: [{ def: SAINTESS, radiant: true }, TIMMY], hand: [TRUE_STRIKE] },
        p2: { hand: [STOCKPILE] },
      }),
    );

    expect(s.hand("p1")).toHaveLength(0);
    expect(s.unit("p1", 2)?.radiant).toBe(true);
  });

  it("R177 the opponent's view does not learn which of her owner's hand cards were base-face", () => {
    // Two games that differ only in the face p1's hand Timmy had while p2 could not read it. After
    // her Death both hands are wholly Radiant; a cue only for the cards that changed would count,
    // for p2, how many were Radiant before.
    const game = (timmyRadiant: boolean): Scenario =>
      strikeSaintess(
        scenario({
          seed: "saintess-r177",
          p1: {
            field: [{ def: SAINTESS, radiant: true }],
            hand: [TRUE_STRIKE, { def: TIMMY, radiant: timmyRadiant }, STOCKPILE],
            library: [BIGOT],
          },
          p2: { hand: [STOCKPILE], library: [BIGOT] },
        }),
      );
    const wasBase = game(false);
    const wasRadiant = game(true);

    for (const s of [wasBase, wasRadiant]) {
      expect(s.hand("p1").every((card) => card.radiant)).toBe(true);
      // One cue per hand card in both games, named or not changed (R177).
      const cues = s.view("p2").events.filter((event) => event.type === "radiantSet");
      expect(cues).toHaveLength(2);
    }
    expect(wasRadiant.view("p2").events.map((event) => event.type)).toEqual(
      wasBase.view("p2").events.map((event) => event.type),
    );
    expect(wasRadiant.view("p2")).toEqual(wasBase.view("p2"));
  });

  it("R8/R83 the radiant Reborn body fires Death on its second death", () => {
    // #15 Me and Mr Token is in hand at Death #1, so it turns Radiant there ("Cry: summon 3 Rush
    // Tokens"); the tokens its Cry then makes are fresh, base-face units that were nowhere at Death
    // #1, so only Death #2 can turn them up. Mana at turn 9 is 4: 1 + 1 + 1 + 1.
    const s = scenario({
      seed: "saintess",
      p1: { hand: [{ def: SAINTESS, radiant: true }, TRUE_STRIKE, ME_AND_MR_TOKEN, TRUE_STRIKE] },
    });
    s.play(SAINTESS, { zone: 1 });

    const saintess = s.card(SAINTESS);
    s.play(TRUE_STRIKE, { targets: [{ pick: "instance", instanceId: saintess.id }] });
    // Death #1 fired and Reborn returned her: R78 resets her, so she is back at 1 health.
    s.expectInZone(saintess, "field");
    s.expectStats(saintess, { attack: 4, health: 1, maxHealth: 4 });
    // Death #1 reached the hand.
    expect(s.card(ME_AND_MR_TOKEN).radiant).toBe(true);

    s.play(ME_AND_MR_TOKEN, { zone: 2 });
    const tokens = [3, 4, 5].map((lane) => s.unit("p1", lane));
    expect(tokens.map((token) => token?.defId)).toEqual([RUSH_TOKEN, RUSH_TOKEN, RUSH_TOKEN]);
    expect(tokens.map((token) => token?.radiant)).toEqual([false, false, false]);

    s.play(TRUE_STRIKE, { targets: [{ pick: "instance", instanceId: saintess.id }] });
    s.expectInZone(saintess, "graveyard");
    // The second Death really ran: the tokens that entered after the first one are Radiant now.
    expect([3, 4, 5].map((lane) => s.unit("p1", lane)?.radiant)).toEqual([true, true, true]);
  });

  it("R64 the Reborn body comes back to the zone it died in, which nothing else may take", () => {
    const s = scenario({
      seed: "saintess",
      p1: { hand: [{ def: SAINTESS, radiant: true }, TRUE_STRIKE, TIMMY] },
    });
    s.play(SAINTESS, { zone: 3 });

    const saintess = s.card(SAINTESS);
    s.play(TRUE_STRIKE, { targets: [{ pick: "instance", instanceId: saintess.id }] });

    expect(s.unit("p1", 3)?.id).toBe(saintess.id);
  });
});
