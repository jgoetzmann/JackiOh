// #93 Combo-Index and #93.1 Combo-Fodder (SPEC §8 rows 93 / 93.1, §7, §2.2, §10.1, §10.4;
// R4, R11, R27, R50, R60, R62, R63, R81, R85, R86).
//
// BUILD M4-T4 row 93:   "Grade 1 needs 1 play, grade 2 needs 2; cascade E→new grade in order;
//                        E adds a copy (R27); S terminal (R27); radiant adds Combo-Fodder each
//                        start of turn".
// BUILD M4-T4 row 93.1: "2 damage with Lifesteal; no radiant change".
//
// The two are one file because #93.1 is the radiant text's companion: radiant #93 is "Start of
// turn: add a Combo-Fodder to your hand; same", so the token only ever exists because of #93.
//
// THE MODEL (engine/src/subsystems/comboIndex.ts): the grade is STATE, in `instance.counters.grade`
// as 1..6 for E..S (§10.1), so a replay and `viewFor` read the same number. At the end of its
// controller's turn — an ordinary end-of-turn trigger at R62's point — the grade rises by one if
// the cards that player played this turn is at or above the CURRENT grade, and then every step from
// E up to the NEW grade runs, in order (R27). Grade S is terminal: at S nothing rises and no step
// runs, and the S step is "run E–A again".
//
//   E  add a copy of a random card played this turn to your hand   → `addedToHand`
//   D  2 different random hand cards cost 1 less                   → `costChanged` ×2
//   C  the opponent exiles a random hand card                      → `exiled`
//   B  a random hand card becomes Radiant                          → `radiantSet`
//   A  8 damage to the enemy hero with Lifesteal                   → `damage` + `healed`
//
// That one-step-one-event-type mapping is what makes R27's "in order" testable: the cascade's
// event log is the step list, and grade S shows it twice.
//
// HARNESS GAP (reported): `SideSetup` cannot seed `counters`, so `setGrade` below writes the
// counter the way the engine would have. Reaching grade A by playing 1 + 2 + 3 + 4 cards over four
// of the controller's own turns is the same arithmetic with four cascades of side effects in the
// way, so the boundary tests drive the counter naturally (E→D, D→C) and the deep-cascade tests
// seed it.

import { describe, expect, it } from "vitest";
import type { GameEvent } from "@jackioh/shared";
import { scenario, type Scenario } from "./_harness";
import { query } from "../src/query";

const COMBO_INDEX = "core-093";
const COMBO_FODDER = "core-093-1";

/** E..S as 1..6 (§8, `comboIndex.GRADES`). */
const E = 1;
const D = 2;
const C = 3;
const B = 4;
const A = 5;
const S = 6;

/** §8 grade A. */
const GRADE_A_DAMAGE = 8;
/** R4. */
const HAND_CAP = 10;

/** Keyword-only units: no Cry, no trigger, nothing but a body — so a play is only a play. */
const FODDER = ["core-003", "core-008", "core-011", "core-020", "core-045"] as const;
/** Cards that only ever sit in a hand, as material for steps B, C and D. */
const HELD = ["core-005", "core-010", "core-056"] as const;

/**
 * HARNESS GAP (reported): no `SideSetup` key seeds `counters.grade`, and §10.1 makes the counter
 * the whole model, so a test that starts above E has to write it.
 */
function setGrade(s: Scenario, grade: number): Scenario {
  s.card(COMBO_INDEX).counters.grade = grade;
  return s;
}

function gradeOf(s: Scenario): number | undefined {
  return s.card(COMBO_INDEX).counters.grade;
}

function ofType<T extends GameEvent["type"]>(s: Scenario, type: T): Extract<GameEvent, { type: T }>[] {
  return s.events.filter((event): event is Extract<GameEvent, { type: T }> => event.type === type);
}

function damageTo(s: Scenario, targetId: string): number[] {
  return ofType(s, "damage")
    .filter((event) => event.targetId === targetId)
    .map((event) => event.amount);
}

function healedOn(s: Scenario, targetId: string): number[] {
  return ofType(s, "healed")
    .filter((event) => event.targetId === targetId)
    .map((event) => event.amount);
}

function defIds(cards: readonly { defId: string }[]): string[] {
  return cards.map((card) => card.defId);
}

/**
 * The defIds one player gained by an "add to hand" — never a draw, which emits `drawn` first and
 * then `addedToHand`, so an assertion has to name the player AND ignore the turn's own draw.
 */
function addsFor(s: Scenario, player: "p1" | "p2"): string[] {
  const drawn = new Set(ofType(s, "drawn").map((event) => event.instanceId));
  return ofType(s, "addedToHand")
    .filter((event) => event.player === player && !drawn.has(event.instanceId))
    .map((event) => event.defId);
}

// =============================================================================================
// #93 — the grade counter (§8, §10.1)
// =============================================================================================

describe("#93 Combo-Index — the grade counter", () => {
  it("§8 the Cry writes the grade at E as the card arrives", () => {
    const s = scenario({
      seed: "core-093-start-grade",
      p1: { hand: [COMBO_INDEX, "core-005"] },
      p2: { hand: ["core-005"] },
    });

    s.play(COMBO_INDEX);

    expect(s.backrow("p1", 1)?.defId).toBe(COMBO_INDEX);
    expect(gradeOf(s)).toBe(E);
    expect(ofType(s, "counterChanged")).toEqual([
      { type: "counterChanged", instanceId: s.card(COMBO_INDEX).id, counter: "grade", value: E },
    ]);
    s.expectMana("p1", 2);
  });

  it("§10.1 an instance that never ran the Cry still reads E, so the threshold is 1 play", () => {
    const s = scenario({
      seed: "core-093-default-grade",
      p1: { backrow: [COMBO_INDEX], hand: [...FODDER.slice(0, 1), ...HELD], library: ["core-016"] },
      p2: { hand: ["core-005"], library: ["core-016"] },
    });
    expect(gradeOf(s)).toBeUndefined();

    s.play(FODDER[0]).endTurn();

    expect(gradeOf(s)).toBe(D);
  });

  it("§10.8 the grade is public on the Field Spell, to both players", () => {
    const s = scenario({
      seed: "core-093-view",
      p1: { backrow: [COMBO_INDEX], hand: ["core-005"] },
      p2: { hand: ["core-005"] },
    });
    setGrade(s, C);

    const mine = s.view("p1").you.backrow[0];
    const theirs = s.view("p2").opponent.backrow[0];
    for (const zone of [mine, theirs]) {
      expect(zone).toBeTruthy();
      // §10.8: a Field Spell is public, so both sides read the same grade.
      expect(zone != null && zone.faceDown === false ? zone.counters.grade : null).toBe(C);
    }
  });

  it("R85 #93 prints no Lifesteal keyword — grade A's heal comes from the effect, not the card", () => {
    const s = scenario({
      seed: "core-093-no-lifesteal",
      p1: { backrow: [COMBO_INDEX], hand: ["core-005"] },
      p2: { hand: ["core-005"] },
    });

    expect(s.stats(COMBO_INDEX).keywords.map((keyword) => keyword.kind)).not.toContain("Lifesteal");
  });
});

// =============================================================================================
// #93 — R27's threshold
// =============================================================================================

describe("#93 Combo-Index — R27 the threshold", () => {
  it("R27 at grade E with NO plays the grade stays put and no step runs", () => {
    const s = scenario({
      seed: "core-093-below-e",
      p1: { backrow: [COMBO_INDEX], hand: [...HELD], library: ["core-016"] },
      p2: { hand: ["core-005"], library: ["core-016"] },
    });
    const before = defIds(s.hand("p1"));

    s.endTurn();

    expect(gradeOf(s)).toBeUndefined();
    expect(ofType(s, "counterChanged")).toEqual([]);
    expect(defIds(s.hand("p1"))).toEqual(before);
    expect(addsFor(s, "p1")).toEqual([]);
  });

  it("R27 grade E needs 1 play: one play raises it to D and runs steps E then D", () => {
    const s = scenario({
      seed: "core-093-e-to-d",
      p1: { backrow: [COMBO_INDEX], hand: [FODDER[1], HELD[0]], library: ["core-016"] },
      p2: { hand: ["core-005"], library: ["core-016"] },
    });
    const played = s.hand("p1")[0];

    s.play(FODDER[1]).endTurn();

    expect(gradeOf(s)).toBe(D);
    // Step E: a copy of the one card played this turn.
    const hand = s.hand("p1");
    expect(defIds(hand).filter((id) => id === FODDER[1])).toHaveLength(1);
    const copy = hand.find((card) => card.defId === FODDER[1]);
    expect(copy?.id).not.toBe(played?.id);
    // Step D: the two cards in hand now each cost 1 less.
    expect(hand.map((card) => card.costMod)).toEqual([-1, -1]);
    s.expectEvents("cardPlayed", "counterChanged", "addedToHand", "costChanged", "costChanged");
  });

  it("R27 grade D needs 2 plays: one play is below the threshold and nothing happens", () => {
    const s = scenario({
      seed: "core-093-below-d",
      p1: { backrow: [COMBO_INDEX], hand: [FODDER[1], HELD[0]], library: ["core-016"] },
      p2: { hand: ["core-005"], library: ["core-016"] },
    });
    setGrade(s, D);

    s.play(FODDER[1]).endTurn();

    expect(gradeOf(s)).toBe(D);
    expect(ofType(s, "counterChanged")).toEqual([]);
    expect(addsFor(s, "p1")).toEqual([]);
    expect(s.hand("p1")).toHaveLength(1);
    expect(s.hand("p1")[0]?.costMod).toBe(0);
  });

  it("R27 grade D at 2 plays rises to C and runs E, D, C in order", () => {
    const s = scenario({
      seed: "core-093-d-to-c",
      p1: {
        backrow: [COMBO_INDEX],
        hand: [FODDER[1], FODDER[2], ...HELD],
        library: ["core-016"],
      },
      p2: { hand: ["core-005", "core-010"], library: ["core-016"] },
    });
    setGrade(s, D);

    s.play(FODDER[1]).play(FODDER[2]).endTurn();

    expect(gradeOf(s)).toBe(C);
    // E added one card to the three that were held.
    const hand = s.hand("p1");
    expect(hand).toHaveLength(4);
    // R27: D picks 2 DIFFERENT cards, so exactly two carry −1 and nobody carries −2.
    expect(hand.filter((card) => card.costMod === -1)).toHaveLength(2);
    expect(hand.every((card) => card.costMod === 0 || card.costMod === -1)).toBe(true);
    // C: the opponent exiled one card out of their own hand.
    expect(s.pile("p2", "exile")).toHaveLength(1);
    s.expectEvents("counterChanged", "addedToHand", "costChanged", "costChanged", "exiled");
  });
});

// =============================================================================================
// #93 — R27's cascade, in order, and grade S
// =============================================================================================

/** A board that is one play short of rising from `grade`, with material for every step. */
function cascade(seed: string, grade: number, plays: number): Scenario {
  const s = scenario({
    seed,
    p1: {
      backrow: [COMBO_INDEX],
      hand: [...FODDER, ...HELD],
      library: ["core-016"],
      mana: 20,
      health: 20,
    },
    p2: { hand: ["core-005", "core-010", "core-056"], library: ["core-016"], health: 30 },
  });
  setGrade(s, grade);
  for (const card of FODDER.slice(0, plays)) s.play(card);
  expect(s.state.players.p1.turnLog.cardsPlayed).toBe(plays);
  return s;
}

describe("#93 Combo-Index — R27 the cascade", () => {
  it("R27 rising to A runs E, D, C, B, A in that order", () => {
    const s = cascade("core-093-cascade-a", B, 4);

    s.endTurn();

    expect(gradeOf(s)).toBe(A);
    s.expectEvents(
      "counterChanged",
      "addedToHand", // E
      "costChanged", // D
      "costChanged", // D
      "exiled", // C
      "radiantSet", // B
      "damage", // A
      "healed", // A
    );
    expect(damageTo(s, "hero-p2")).toEqual([GRADE_A_DAMAGE]);
    expect(healedOn(s, "hero-p1")).toEqual([GRADE_A_DAMAGE]);
    s.expectHealth("p2", 30 - GRADE_A_DAMAGE);
    s.expectHealth("p1", 20 + GRADE_A_DAMAGE);
  });

  it("R27 the S step is E–A AGAIN, so rising to S runs all ten steps in order", () => {
    const s = cascade("core-093-cascade-s", A, 5);

    s.endTurn();

    expect(gradeOf(s)).toBe(S);
    s.expectEvents(
      "counterChanged",
      "addedToHand",
      "costChanged",
      "costChanged",
      "exiled",
      "radiantSet",
      "damage",
      "healed",
      // and once more, in the same order
      "addedToHand",
      "costChanged",
      "costChanged",
      "exiled",
      "radiantSet",
      "damage",
      "healed",
    );
    expect(damageTo(s, "hero-p2")).toEqual([GRADE_A_DAMAGE, GRADE_A_DAMAGE]);
    expect(healedOn(s, "hero-p1")).toEqual([GRADE_A_DAMAGE, GRADE_A_DAMAGE]);
    s.expectHealth("p2", 30 - 2 * GRADE_A_DAMAGE);
    s.expectHealth("p1", 20 + 2 * GRADE_A_DAMAGE);
    // Two C steps, so the opponent lost two cards out of hand.
    expect(s.pile("p2", "exile")).toHaveLength(2);
  });

  it("R27 grade S is TERMINAL: nothing rises and no step runs, however many cards were played", () => {
    const s = cascade("core-093-terminal", S, 5);

    s.endTurn();

    expect(gradeOf(s)).toBe(S);
    expect(ofType(s, "counterChanged")).toEqual([]);
    expect(addsFor(s, "p1")).toEqual([]);
    expect(ofType(s, "radiantSet")).toEqual([]);
    expect(damageTo(s, "hero-p2")).toEqual([]);
    s.expectHealth("p2", 30);
    s.expectHealth("p1", 20);
    expect(s.pile("p2", "exile")).toHaveLength(0);
  });

  it("the grade rises at most ONE step per turn end, however far past the threshold the turn went", () => {
    // 5 plays at grade E is five times the threshold and still rises by exactly one.
    const s = cascade("core-093-one-step", E, 5);

    s.endTurn();

    expect(gradeOf(s)).toBe(D);
    // E and D only: no C, so nothing was exiled from the opponent's hand.
    expect(s.pile("p2", "exile")).toHaveLength(0);
    expect(damageTo(s, "hero-p2")).toEqual([]);
  });

  it("§6.2 the end of the OPPONENT's turn does not advance your grade", () => {
    const s = scenario({
      seed: "core-093-enemy-turn",
      active: "p2",
      p1: { backrow: [COMBO_INDEX], hand: [...HELD], library: ["core-016"] },
      p2: { hand: [FODDER[1], "core-005"], library: ["core-016"] },
    });

    s.play(FODDER[1]).endTurn();

    expect(gradeOf(s)).toBeUndefined();
    expect(ofType(s, "counterChanged")).toEqual([]);
    expect(addsFor(s, "p1")).toEqual([]);
    expect(addsFor(s, "p2")).toEqual([]);
  });
});

// =============================================================================================
// #93 — the individual steps
// =============================================================================================

describe("#93 Combo-Index — step E (R27, R86)", () => {
  it("R27 the copy is FRESH and keeps the radiant flag of the card it copies", () => {
    const s = scenario({
      seed: "core-093-step-e-radiant",
      p1: {
        backrow: [COMBO_INDEX],
        hand: [{ def: FODDER[1], radiant: true }, HELD[0]],
        library: ["core-016"],
      },
      p2: { hand: ["core-005"], library: ["core-016"] },
    });
    const played = s.hand("p1")[0];

    s.play(FODDER[1]).endTurn();

    const copy = s.hand("p1").find((card) => card.defId === FODDER[1]);
    expect(copy).toBeDefined();
    expect(copy?.id).not.toBe(played?.id);
    expect(copy?.radiant).toBe(true);
    // Fresh: the original is still on the field, untouched.
    expect(s.unit("p1", 1)?.id).toBe(played?.id);
  });

  it("R86 an instance that has CEASED TO EXIST drops out of the pool instead of fizzling the step", () => {
    const s = scenario({
      seed: "core-093-r86",
      p1: { backrow: [COMBO_INDEX], hand: ["core-t-rush", FODDER[1]] },
      // A 9/9 Taunt, so the 3/3 Rush Token has one legal target and dies on it.
      p2: { field: ["core-019"], hand: ["core-005"], library: ["core-016"] },
    });

    s.play("core-t-rush");
    const token = s.unit("p1", 1);
    expect(token?.defId).toBe("core-t-rush");
    s.play(FODDER[1]).attack(token ?? "core-t-rush", "core-019");

    // R11: a unit token that left the field ceased to exist — it is `gone`, not exiled.
    if (token !== null) s.expectInZone(token, "gone");
    expect(s.state.players.p1.turnLog.playedIds).toHaveLength(2);

    s.endTurn();

    // R86: the pool is the one surviving card, so the step neither fizzles nor copies the token.
    expect(defIds(s.hand("p1"))).toEqual([FODDER[1]]);
    expect(gradeOf(s)).toBe(D);
  });
});

describe("#93 Combo-Index — step C", () => {
  it("the card exiled is the OPPONENT's, out of their hand, and yours is untouched", () => {
    const s = scenario({
      seed: "core-093-step-c",
      p1: {
        backrow: [COMBO_INDEX],
        hand: [FODDER[1], FODDER[2], ...HELD],
        library: ["core-016"],
        mana: 20,
      },
      p2: { hand: ["core-005", "core-010"], library: ["core-016"] },
    });
    setGrade(s, D);
    const enemyHand = s.hand("p2").map((card) => card.id);

    s.play(FODDER[1]).play(FODDER[2]).endTurn();

    const exiled = s.pile("p2", "exile");
    expect(exiled).toHaveLength(1);
    expect(enemyHand).toContain(exiled[0]?.id);
    expect(s.pile("p1", "exile")).toHaveLength(0);
  });

  it("an empty enemy hand fizzles the step and the rest of the cascade still runs", () => {
    const s = scenario({
      seed: "core-093-step-c-empty",
      p1: {
        backrow: [COMBO_INDEX],
        hand: [FODDER[1], FODDER[2], ...HELD],
        library: ["core-016"],
        mana: 20,
      },
      // A unit on the board keeps p2's own turn meaningful (§2.5) with no card in hand.
      p2: { field: ["core-019"], hand: [], library: [] },
    });
    setGrade(s, D);

    s.play(FODDER[1]).play(FODDER[2]).endTurn();

    expect(ofType(s, "exiled")).toEqual([]);
    expect(gradeOf(s)).toBe(C);
    expect(addsFor(s, "p1")).toHaveLength(1);
  });
});

describe("#93 Combo-Index — step B (R60)", () => {
  it("R60 exactly one non-Radiant hand card becomes Radiant", () => {
    const s = cascade("core-093-step-b", C, 3);

    s.endTurn();

    expect(gradeOf(s)).toBe(B);
    const set = ofType(s, "radiantSet");
    expect(set).toHaveLength(1);
    expect(s.hand("p1").filter((card) => card.radiant)).toHaveLength(1);
    expect(s.hand("p1").some((card) => card.id === set[0]?.instanceId)).toBe(true);
  });

  it("R60 with every hand card already Radiant the step does nothing", () => {
    const s = scenario({
      seed: "core-093-step-b-all-radiant",
      p1: {
        backrow: [COMBO_INDEX],
        hand: [
          { def: FODDER[1], radiant: true },
          { def: FODDER[2], radiant: true },
          { def: FODDER[3], radiant: true },
          { def: HELD[0], radiant: true },
        ],
        library: ["core-016"],
        mana: 20,
      },
      p2: { hand: ["core-005", "core-010"], library: ["core-016"] },
    });
    setGrade(s, C);

    s.play(FODDER[1]).play(FODDER[2]).play(FODDER[3]).endTurn();

    expect(gradeOf(s)).toBe(B);
    // Step E copied a Radiant card (R27), so nothing non-Radiant is left for step B to pick, and
    // nothing changes. R177: the pick is still cued once, on a hand card that was Radiant already.
    expect(s.hand("p1").every((card) => card.radiant)).toBe(true);
    const cues = ofType(s, "radiantSet");
    expect(cues).toHaveLength(1);
    expect(s.hand("p1").some((card) => card.id === cues[0]?.instanceId)).toBe(true);
  });
});

describe("#93 Combo-Index — step A (R85, R63)", () => {
  it("R85 the 8 damage heals your hero by what landed, without #93 gaining Lifesteal", () => {
    const s = cascade("core-093-step-a", B, 4);

    s.endTurn();

    expect(damageTo(s, "hero-p2")).toEqual([GRADE_A_DAMAGE]);
    expect(healedOn(s, "hero-p1")).toEqual([GRADE_A_DAMAGE]);
    s.expectHealth("p1", 20 + GRADE_A_DAMAGE);
    expect(s.stats(COMBO_INDEX).keywords.map((keyword) => keyword.kind)).not.toContain("Lifesteal");
  });

  it("R85 Armor reduces the hit, and the heal follows the reduced amount", () => {
    const s = scenario({
      seed: "core-093-step-a-armor",
      p1: { backrow: [COMBO_INDEX], hand: [...FODDER, ...HELD], library: ["core-016"], mana: 20, health: 20 },
      p2: { hand: ["core-005", "core-010"], library: ["core-016"], health: 30, armor: 3 },
    });
    setGrade(s, B);
    for (const card of FODDER.slice(0, 4)) s.play(card);

    s.endTurn();

    // 8 − 3 armor = 5 dealt, so 5 healed.
    expect(damageTo(s, "hero-p2")).toEqual([5]);
    expect(healedOn(s, "hero-p1")).toEqual([5]);
    s.expectHealth("p2", 25);
    s.expectHealth("p1", 25);
  });

  it("R63 a hit reduced to 0 by Armor heals nothing at all, and the cascade still ran", () => {
    const s = scenario({
      seed: "core-093-step-a-zero",
      p1: { backrow: [COMBO_INDEX], hand: [...FODDER, ...HELD], library: ["core-016"], mana: 20, health: 20 },
      p2: { hand: ["core-005", "core-010"], library: ["core-016"], health: 30, armor: 8 },
    });
    setGrade(s, B);
    for (const card of FODDER.slice(0, 4)) s.play(card);

    s.endTurn();

    // R63: no damage event, so no §4.4 step 8 and no heal.
    expect(damageTo(s, "hero-p2")).toEqual([]);
    expect(healedOn(s, "hero-p1")).toEqual([]);
    s.expectHealth("p2", 30);
    s.expectHealth("p1", 20);
    // The four steps before A still happened.
    expect(gradeOf(s)).toBe(A);
    expect(ofType(s, "radiantSet")).toHaveLength(1);
  });

  it("R85 the Anti-oneshot cap clamps the hit, and the heal follows the clamp (§4.4 step 3)", () => {
    const s = scenario({
      seed: "core-093-step-a-cap",
      p1: { backrow: [COMBO_INDEX], hand: [...FODDER, ...HELD], library: ["core-016"], mana: 20, health: 20 },
      // #73 Anti-oneshot Armor, placed rather than played, so its Cry never fires (R1).
      p2: { backrow: ["core-073"], hand: ["core-005", "core-010"], library: ["core-016"], health: 30 },
    });
    setGrade(s, B);
    for (const card of FODDER.slice(0, 4)) s.play(card);

    s.endTurn();

    expect(damageTo(s, "hero-p2")).toEqual([5]);
    expect(healedOn(s, "hero-p1")).toEqual([5]);
    s.expectHealth("p2", 25);
    s.expectHealth("p1", 25);
  });
});

// =============================================================================================
// #93 — radiant
// =============================================================================================

describe("#93 Combo-Index — radiant", () => {
  it("§8 start of turn: a Combo-Fodder is added to your hand", () => {
    const s = scenario({
      seed: "core-093-radiant-start",
      p1: { backrow: [{ def: COMBO_INDEX, radiant: true }], hand: [], library: ["core-016"] },
      p2: { hand: ["core-005"] },
    });

    s.startTurn();

    expect(defIds(s.hand("p1"))).toContain(COMBO_FODDER);
    expect(addsFor(s, "p1")).toEqual([COMBO_FODDER]);
    // §2.2/R62: the start-of-turn trigger fires BEFORE the draw, so the drawn card is also there.
    expect(defIds(s.hand("p1"))).toContain("core-016");
  });

  it("the base face adds nothing at the start of turn", () => {
    const s = scenario({
      seed: "core-093-base-start",
      p1: { backrow: [COMBO_INDEX], hand: [], library: ["core-016"] },
      p2: { hand: ["core-005"] },
    });

    s.startTurn();

    expect(defIds(s.hand("p1"))).not.toContain(COMBO_FODDER);
  });

  it("it fires every turn, so two start-of-turns give two Combo-Fodders", () => {
    const s = scenario({
      seed: "core-093-radiant-repeat",
      p1: { backrow: [{ def: COMBO_INDEX, radiant: true }], hand: [], library: ["core-016", "core-010"] },
      p2: { hand: ["core-005"] },
    });

    s.startTurn().startTurn();

    expect(defIds(s.hand("p1")).filter((id) => id === COMBO_FODDER)).toHaveLength(2);
  });

  it("R4 a full hand burns the Combo-Fodder to the graveyard", () => {
    const s = scenario({
      seed: "core-093-radiant-hand-cap",
      p1: {
        backrow: [{ def: COMBO_INDEX, radiant: true }],
        hand: Array.from({ length: HAND_CAP }, () => "core-005"),
        library: ["core-016"],
      },
      p2: { hand: ["core-005"] },
    });

    s.startTurn();

    expect(s.hand("p1")).toHaveLength(HAND_CAP);
    const burned = ofType(s, "burned").map((event) => event.defId);
    expect(burned).toContain(COMBO_FODDER);
    expect(defIds(s.pile("p1", "graveyard"))).toContain(COMBO_FODDER);
  });

  it('"same": the radiant face keeps the whole base cascade', () => {
    const s = scenario({
      seed: "core-093-radiant-same",
      p1: {
        backrow: [{ def: COMBO_INDEX, radiant: true }],
        hand: [FODDER[1], HELD[0]],
        library: ["core-016"],
      },
      p2: { hand: ["core-005"], library: ["core-016"] },
    });

    s.play(FODDER[1]).endTurn();

    expect(gradeOf(s)).toBe(D);
    expect(addsFor(s, "p1")).toEqual([FODDER[1]]);
    expect(ofType(s, "costChanged")).toHaveLength(2);
  });

  it('"same": the radiant face is still terminal at S', () => {
    const s = scenario({
      seed: "core-093-radiant-terminal",
      p1: {
        backrow: [{ def: COMBO_INDEX, radiant: true }],
        hand: [FODDER[1], HELD[0]],
        library: ["core-016"],
      },
      p2: { hand: ["core-005"], library: ["core-016"], health: 30 },
    });
    setGrade(s, S);

    s.play(FODDER[1]).endTurn();

    expect(gradeOf(s)).toBe(S);
    expect(damageTo(s, "hero-p2")).toEqual([]);
  });
});

// =============================================================================================
// #93.1 Combo-Fodder
// =============================================================================================

describe("#93.1 Combo-Fodder — base", () => {
  it("§8 costs 0 and deals 2 damage to a chosen unit, healing you 2 (Lifesteal)", () => {
    const s = scenario({
      seed: "core-093-1-unit",
      p1: { hand: [COMBO_FODDER, "core-005"], health: 20 },
      p2: { field: ["core-019"], hand: ["core-005"] },
    });
    const menace = s.unit("p2", 1);

    s.play(COMBO_FODDER, { targets: [{ pick: "instance", instanceId: menace?.id ?? "" }] });

    s.expectMana("p1", 4);
    expect(damageTo(s, menace?.id ?? "")).toEqual([2]);
    s.expectHealth("p1", 22);
  });

  it("R81 'a target' reaches the enemy hero, picked with the play and never by a prompt", () => {
    const s = scenario({
      seed: "core-093-1-hero",
      p1: { hand: [COMBO_FODDER, "core-005"], health: 20 },
      p2: { hand: ["core-005"] },
    });

    s.play(COMBO_FODDER, { targets: [{ pick: "hero", player: "p2" }] });

    expect(s.state.pending).toBeNull();
    s.expectHealth("p2", 28);
    s.expectHealth("p1", 22);
    expect(healedOn(s, "hero-p1")).toEqual([2]);
  });

  it("R81 'a target' is unnarrowed, so your own unit is a legal pick too", () => {
    const s = scenario({
      seed: "core-093-1-friendly",
      p1: { field: ["core-019"], hand: [COMBO_FODDER, "core-005"], health: 20 },
      p2: { hand: ["core-005"] },
    });
    const mine = s.unit("p1", 1);

    s.play(COMBO_FODDER, { targets: [{ pick: "instance", instanceId: mine?.id ?? "" }] });

    expect(damageTo(s, mine?.id ?? "")).toEqual([2]);
    // Lifesteal heals the controller whatever it hit.
    s.expectHealth("p1", 22);
  });

  it("R90 it declares one target and refuses a play that names none", () => {
    const s = scenario({
      seed: "core-093-1-no-target",
      p1: { hand: [COMBO_FODDER, "core-005"] },
      p2: { field: ["core-019"], hand: ["core-005"] },
    });

    expect(() => s.play(COMBO_FODDER)).toThrow(/target/);
  });

  it("R63 Armor to 0 means no damage event and no heal", () => {
    const s = scenario({
      seed: "core-093-1-armor",
      p1: { hand: [COMBO_FODDER, "core-005"], health: 20 },
      p2: { hand: ["core-005"], armor: 2 },
    });

    s.play(COMBO_FODDER, { targets: [{ pick: "hero", player: "p2" }] });

    expect(damageTo(s, "hero-p2")).toEqual([]);
    expect(healedOn(s, "hero-p1")).toEqual([]);
    s.expectHealth("p2", 30);
    s.expectHealth("p1", 20);
  });

  it("R11 the spell token reaches the graveyard, so R50 can Discover it back", () => {
    const s = scenario({
      seed: "core-093-1-graveyard",
      p1: { hand: [COMBO_FODDER, "core-005"] },
      p2: { hand: ["core-005"] },
    });
    const fodder = s.hand("p1")[0];

    s.play(COMBO_FODDER, { targets: [{ pick: "hero", player: "p2" }] });

    if (fodder !== undefined) s.expectInZone(fodder, "graveyard");
    expect(defIds(s.pile("p1", "graveyard"))).toContain(COMBO_FODDER);
  });

  it("R70/§8 Conventions it counts as a card played, which is what feeds #93's own threshold", () => {
    const s = scenario({
      seed: "core-093-1-counts",
      p1: { backrow: [COMBO_INDEX], hand: [COMBO_FODDER, "core-005"], library: ["core-016"] },
      p2: { hand: ["core-005"], library: ["core-016"] },
    });

    s.play(COMBO_FODDER, { targets: [{ pick: "hero", player: "p2" }] });

    expect(s.state.players.p1.turnLog.cardsPlayed).toBe(1);

    s.endTurn();

    expect(gradeOf(s)).toBe(D);
  });
});

describe("#93.1 Combo-Fodder — radiant", () => {
  it("§8 lists no radiant form, so the radiant face deals the same 2 with Lifesteal", () => {
    const s = scenario({
      seed: "core-093-1-radiant",
      p1: { hand: [{ def: COMBO_FODDER, radiant: true }, "core-005"], health: 20 },
      p2: { hand: ["core-005"] },
    });
    expect(s.hand("p1")[0]?.radiant).toBe(true);

    s.play(COMBO_FODDER, { targets: [{ pick: "hero", player: "p2" }] });

    s.expectHealth("p2", 28);
    s.expectHealth("p1", 22);
    s.expectMana("p1", 4);
  });

  it("§5.2 the flag still sets, so a counting effect sees a Radiant card", () => {
    const s = scenario({
      seed: "core-093-1-radiant-flag",
      p1: { hand: [{ def: COMBO_FODDER, radiant: true }, "core-005"] },
      p2: { hand: ["core-005"] },
    });

    expect(s.hand("p1").filter((card) => card.radiant)).toHaveLength(1);
  });
});

describe("#93.1 Combo-Fodder — §5.1 pools", () => {
  it("§5.1 no random pool offers the token", () => {
    expect(query({}).map((card) => card.id)).not.toContain(COMBO_FODDER);
    expect(query({ type: "Spell", cost: 0 }).map((card) => card.id)).not.toContain(COMBO_FODDER);
    expect(query({ tags: ["Token"] }).map((card) => card.id)).toContain(COMBO_FODDER);
  });

  it("R35 #93 itself is in the Legendary pool #83 Transmogulate draws from", () => {
    expect(query({ rarity: "Legendary" }).map((card) => card.id)).toContain(COMBO_INDEX);
    expect(query({ rarity: "Legendary" }).map((card) => card.id)).not.toContain(COMBO_FODDER);
  });
});
