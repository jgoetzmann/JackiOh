// R195 (SPEC §10.8, §10.9): the five Core cards with a printed condition light up yellow through
// `conditionActive`, and each test proves the flag agrees with the branch the card's own resolution
// then takes. The flag is read from `s.view(...)` (the viewer's `viewFor`), the branch from the
// scenario's own assertions after a real `s.play(...)` or `s.endTurn()`.
//
//   #10 Rapid Replenish  hand only          3 or more cards played earlier this turn
//   #53 Reno             hand only          your hero below 30 (radiant 60)
//   #68 Twisted Sorcerer hand only          your hero below 10, strict
//   #71 Intern Stimmy    hand and field     your library strictly larger than the opponent's
//   #93 Combo-Index      field only         your turn, cards played reach its grade, not at S
//
// The key is present and `true`, or absent: `glows` below fails on a key that is present with any
// other value.
//
// R196 closes the file: a fusion's hook is its ingredients' hooks or-ed, checked by crafting #53 Reno
// with #68 Twisted Sorcerer (R77's hand path, the one #99 Craft a Card takes) and playing the result.
//
// These are the per-card proofs §10.9 asks of a card with `conditionMet`; each card's own
// `NNN-slug.test.ts` points here (packages/cards/README.md §5), and the last test pins the set of
// cards that declare the hook to R195's list, so a new hook cannot land without a proof.

import { createRng, subsystems, type CardInstance } from "@jackioh/engine";
import type { CardView, PlayerView } from "@jackioh/shared";
import { describe, expect, it } from "vitest";
import { CARDS } from "../src/index";
import { scenario, type Scenario, type ScenarioOptions } from "./_harness";

type Instance = ReturnType<Scenario["card"]>;

function ownHand(view: PlayerView): CardView[] {
  const hand = view.you.hand;
  if (!Array.isArray(hand)) throw new Error("the viewer's own hand must travel in full (§10.8)");
  return hand;
}

function handCard(view: PlayerView, instanceId: string): CardView {
  const found = ownHand(view).find((card) => card.instanceId === instanceId);
  if (found === undefined) throw new Error(`${instanceId} is not in the viewer's hand`);
  return found;
}

/** `true` when the view carries the key (which must then be exactly `true`), `false` when absent. */
function glows(card: object | null | undefined): boolean {
  if (card === null || card === undefined) throw new Error("no card at that place in the view");
  if (!("conditionActive" in card)) return false;
  expect((card as { conditionActive?: unknown }).conditionActive).toBe(true);
  return true;
}

/** Every copy of a def in p1's hand, in hand order. */
function copiesInHand(s: Scenario, defId: string): Instance[] {
  return s.hand("p1").filter((card) => card.defId === defId);
}

function nth<T>(list: readonly T[], index: number): T {
  const value = list[index];
  if (value === undefined) throw new Error(`nothing at index ${index}`);
  return value;
}

/** Does p1's copy of `defId` in hand glow in p1's own view right now? */
function handGlows(s: Scenario, instance: Instance): boolean {
  return glows(handCard(s.view("p1"), instance.id));
}

function countOf(s: Scenario, type: string): number {
  return s.events.filter((event) => event.type === type).length;
}

// =============================================================================================
// #10 Rapid Replenish (hand only): Combo 3
// =============================================================================================

describe("#10 Rapid Replenish lights up at Combo 3 (R195, B5)", () => {
  const LIBRARY = [
    "core-020",
    "core-020",
    "core-020",
    "core-011",
    "core-011",
    "core-011",
    "core-016",
    "core-016",
  ];

  it("R195 B5: after two plays it carries no flag and draws nothing; the copy that then finds three plays glows and draws 3", () => {
    const s = scenario({
      seed: "r195-010-boundary",
      p1: { hand: ["core-011", "core-011", "core-010", "core-010"], mana: 10, library: [...LIBRARY] },
      p2: { field: ["core-020"] },
    });
    const copies = copiesInHand(s, "core-010");
    const first = nth(copies, 0);
    const second = nth(copies, 1);

    expect(handGlows(s, first)).toBe(false);
    s.play("core-011");
    expect(handGlows(s, first)).toBe(false);
    s.play("core-011");
    expect(handGlows(s, first)).toBe(false);
    expect(handGlows(s, second)).toBe(false);

    const library = s.pile("p1", "library").length;
    s.play(first);

    // The flag was off, and the resolution agreed: no draw.
    expect(s.pile("p1", "library")).toHaveLength(library);
    expect(s.hand("p1").map((card) => card.id)).toEqual([second.id]);

    // That copy counted as a play, so the other one now finds three earlier plays.
    expect(handGlows(s, second)).toBe(true);
    s.play(second);

    expect(s.pile("p1", "library")).toHaveLength(library - 3);
    expect(s.hand("p1")).toHaveLength(3);
  });

  it("R195 B5: the radiant face glows on the same count and then draws 6", () => {
    const s = scenario({
      seed: "r195-010-radiant",
      p1: {
        hand: ["core-011", "core-011", "core-011", { def: "core-010", radiant: true }],
        mana: 10,
        library: [...LIBRARY],
      },
      p2: { field: ["core-020"] },
    });
    const spell = nth(copiesInHand(s, "core-010"), 0);
    expect(spell.radiant).toBe(true);

    s.play("core-011");
    s.play("core-011");
    expect(handGlows(s, spell)).toBe(false);
    s.play("core-011");
    expect(handGlows(s, spell)).toBe(true);

    const library = s.pile("p1", "library").length;
    s.play(spell);

    expect(s.pile("p1", "library")).toHaveLength(library - 6);
    expect(s.hand("p1")).toHaveLength(6);
  });

  it("R195 B5: on the opponent's turn it never glows, its controller's three plays over with their turn", () => {
    const s = scenario({
      seed: "r195-010-their-turn",
      p1: { hand: ["core-011", "core-011", "core-011", "core-010"], mana: 10, library: [...LIBRARY] },
      p2: { hand: ["core-005"], library: ["core-016", "core-016", "core-016"] },
    });
    const spell = nth(copiesInHand(s, "core-010"), 0);
    s.play("core-011");
    s.play("core-011");
    s.play("core-011");
    expect(handGlows(s, spell)).toBe(true);

    s.endTurn();

    expect(s.state.active).toBe("p2");
    // "This turn" starts afresh for both players (§6.2, turn.ts's startTurn), so p1's three plays no
    // longer count on p2's turn. That the hand is not even asked outside its own main phase, where a
    // hook would answer true, is R195's rule 3, proved with a test-only hook in conditionActive.test.ts.
    expect(s.state.players.p1.turnLog.cardsPlayed).toBe(0);
    expect(handGlows(s, spell)).toBe(false);
  });

  it("R195 B5: the opponent's view never carries the flag (its hand is a count)", () => {
    const s = scenario({
      seed: "r195-010-opponent-view",
      p1: { hand: ["core-011", "core-011", "core-011", "core-010"], mana: 10, library: [...LIBRARY] },
      p2: { field: ["core-020"] },
    });
    s.play("core-011");
    s.play("core-011");
    s.play("core-011");

    expect(handGlows(s, nth(copiesInHand(s, "core-010"), 0))).toBe(true);
    const theirs = s.view("p2");
    expect(theirs.opponent.hand).toEqual({ count: 1 });
    expect(JSON.stringify(theirs)).not.toContain("conditionActive");
  });
});

// =============================================================================================
// #53 Reno (hand only): your hero below 30, radiant 60
// =============================================================================================

describe("#53 Reno lights up below its floor (R195, B6)", () => {
  it("R195 B6: below 30 it glows in hand, and its Cry then sets the hero to 30", () => {
    for (const health of [29, 12, 1]) {
      const s = scenario({ seed: `r195-053-low-${health}`, p1: { hand: ["core-053"], health } });

      expect(handGlows(s, s.card("core-053")), `hero at ${health}`).toBe(true);
      s.play("core-053").expectHealth("p1", 30);
    }
  });

  it("R195 B6: at 30 or above it does not glow, and its Cry heals nothing", () => {
    for (const health of [30, 35]) {
      const s = scenario({ seed: `r195-053-high-${health}`, p1: { hand: ["core-053"], health } });

      expect(handGlows(s, s.card("core-053")), `hero at ${health}`).toBe(false);
      s.play("core-053").expectHealth("p1", health);
      expect(s.lastEvents.filter((event) => event.type === "healed")).toHaveLength(0);
    }
  });

  it("R195 B6: the radiant face glows below 60 and raises the hero to 60", () => {
    for (const health of [59, 35, 12]) {
      const s = scenario({
        seed: `r195-053-radiant-low-${health}`,
        p1: { hand: [{ def: "core-053", radiant: true }], health },
      });

      expect(handGlows(s, s.card("core-053")), `hero at ${health}`).toBe(true);
      s.play("core-053").expectHealth("p1", 60);
    }
  });

  it("R195 B6: the radiant face at 60 or above does not glow, and heals nothing", () => {
    for (const health of [60, 70]) {
      const s = scenario({
        seed: `r195-053-radiant-high-${health}`,
        p1: { hand: [{ def: "core-053", radiant: true }], health },
      });

      expect(handGlows(s, s.card("core-053")), `hero at ${health}`).toBe(false);
      s.play("core-053").expectHealth("p1", health);
      expect(s.lastEvents.filter((event) => event.type === "healed")).toHaveLength(0);
    }
  });

  it("R195 B6: a low opponent does not light it: 'your hero' is the controller's", () => {
    const s = scenario({ seed: "r195-053-their-hero", p1: { hand: ["core-053"], health: 30 }, p2: { health: 5 } });

    expect(handGlows(s, s.card("core-053"))).toBe(false);
    s.play("core-053").expectHealth("p1", 30).expectHealth("p2", 5);
  });

  it("R195 B6: a Reno on the field never carries the flag, even with its controller's hero low", () => {
    for (const active of ["p1", "p2"] as const) {
      const s = scenario({
        seed: `r195-053-field-${active}`,
        active,
        p1: { field: ["core-053", { def: "core-053", radiant: true }], health: 12, hand: ["core-005"] },
        p2: { hand: ["core-005"] },
      });
      const view = s.view("p1");

      expect(view.you.units[0]).toMatchObject({ defId: "core-053" });
      expect(glows(view.you.units[0]), `base on ${active}'s turn`).toBe(false);
      expect(glows(view.you.units[1]), `radiant on ${active}'s turn`).toBe(false);
    }
  });
});

// =============================================================================================
// #68 Twisted Sorcerer (hand only): your hero below 10
// =============================================================================================

describe("#68 Twisted Sorcerer lights up below 10 (R195, B7)", () => {
  const SORCERER = "core-068"; // Unit 5/5 → 10/10.
  const SPONGE = "core-019"; // Midrange Menace 9/9 → 18/18, no Armor.
  /** A free Spell that keeps the turn open (§2.5's auto-end); never played. */
  const ANCHOR = "core-010";

  function board(opts: ScenarioOptions = {}): Scenario {
    const p1 = opts.p1 ?? {};
    return scenario({ ...opts, p1: { ...p1, hand: [...(p1.hand ?? []), ANCHOR] } });
  }

  function atSponge(s: Scenario): { pick: "instance"; instanceId: string }[] {
    const unit = s.unit("p2", 1);
    if (unit === null) throw new Error("no sponge in p2's lane 1");
    return [{ pick: "instance", instanceId: unit.id }];
  }

  function sorcerer(s: Scenario): Instance {
    return nth(copiesInHand(s, SORCERER), 0);
  }

  it("R195 B7: below 10 it glows in hand, and its Cry then deals 8", () => {
    const s = board({ seed: "r195-068-low", p1: { hand: [SORCERER], health: 9 }, p2: { field: [SPONGE] } });

    expect(handGlows(s, sorcerer(s))).toBe(true);
    s.play(SORCERER, { targets: atSponge(s) });
    s.expectStats(SPONGE, { health: 1, maxHealth: 9 });
  });

  it("R195 B7: at exactly 10 it does not glow, and its Cry deals 4", () => {
    const s = board({ seed: "r195-068-ten", p1: { hand: [SORCERER], health: 10 }, p2: { field: [SPONGE] } });

    expect(handGlows(s, sorcerer(s))).toBe(false);
    s.play(SORCERER, { targets: atSponge(s) });
    s.expectStats(SPONGE, { health: 5, maxHealth: 9 });
  });

  it("R195 B7: the radiant face glows below 10 and deals 16", () => {
    const s = board({
      seed: "r195-068-radiant-low",
      p1: { hand: [{ def: SORCERER, radiant: true }], health: 9 },
      p2: { field: [{ def: SPONGE, radiant: true }] },
    });

    expect(handGlows(s, sorcerer(s))).toBe(true);
    s.play(SORCERER, { targets: atSponge(s) });
    s.expectStats(SPONGE, { health: 2, maxHealth: 18 });
  });

  it("R195 B7: the radiant face at exactly 10 does not glow, and deals 8", () => {
    const s = board({
      seed: "r195-068-radiant-ten",
      p1: { hand: [{ def: SORCERER, radiant: true }], health: 10 },
      p2: { field: [SPONGE] },
    });

    expect(handGlows(s, sorcerer(s))).toBe(false);
    s.play(SORCERER, { targets: atSponge(s) });
    s.expectStats(SPONGE, { health: 1, maxHealth: 9 });
  });

  it("R195 B7: a low opponent does not light it, and the Cry deals 4", () => {
    const s = board({ seed: "r195-068-their-hero", p1: { hand: [SORCERER], health: 30 }, p2: { field: [SPONGE], health: 3 } });

    expect(handGlows(s, sorcerer(s))).toBe(false);
    s.play(SORCERER, { targets: atSponge(s) });
    s.expectStats(SPONGE, { health: 5, maxHealth: 9 });
  });

  it("R195 B7: a Twisted Sorcerer on the field never carries the flag", () => {
    const s = board({ seed: "r195-068-field", p1: { field: [SORCERER], health: 3 } });

    expect(glows(s.view("p1").you.units[0])).toBe(false);
  });
});

// =============================================================================================
// #71 Intern Stimmy (hand and field): your library strictly larger
// =============================================================================================

describe("#71 Intern Stimmy lights up while its controller's library is larger (R195, B8)", () => {
  it("R195 B8: in the backrow it glows at 3 cards to 1, the opponent still sees a face-down card, and it fires at the turn's end", () => {
    const s = scenario({
      seed: "r195-071-ahead",
      p1: { backrow: ["core-071"], library: ["core-001", "core-003", "core-005"], hand: ["core-005"] },
      p2: { library: ["core-005"], hand: ["core-005"] },
    });

    expect(glows(s.view("p1").you.backrow[0])).toBe(true);
    expect(s.view("p2").opponent.backrow[0]).toEqual({ faceDown: true });

    s.endTurn();

    expect(countOf(s, "trapFired")).toBe(1);
    expect(s.unit("p1", 1)?.defId).toBe("core-003");
    // Fired, so public now (R33), and still never flagged on the opponent's side.
    const theirs = s.view("p2").opponent.backrow[0];
    expect(theirs).toMatchObject({ faceDown: false, defId: "core-071" });
    expect(glows(theirs)).toBe(false);
  });

  it("R195 B8: with equal libraries it does not glow, and the trap does not fire", () => {
    const s = scenario({
      seed: "r195-071-equal",
      p1: { backrow: ["core-071"], library: ["core-001", "core-003"], hand: ["core-005"] },
      p2: { library: ["core-005", "core-023"], hand: ["core-005"] },
    });

    expect(glows(s.view("p1").you.backrow[0])).toBe(false);
    s.endTurn();
    expect(countOf(s, "trapFired")).toBe(0);
    expect(s.unit("p1", 1)).toBeNull();
  });

  it("R195 B8: with a smaller library it does not glow, and the trap does not fire", () => {
    const s = scenario({
      seed: "r195-071-behind",
      p1: { backrow: ["core-071"], library: ["core-003"], hand: ["core-005"] },
      p2: { library: ["core-005", "core-023", "core-035"], hand: ["core-005"] },
    });

    expect(glows(s.view("p1").you.backrow[0])).toBe(false);
    s.endTurn();
    expect(countOf(s, "trapFired")).toBe(0);
  });

  it("R195 B8: on the opponent's turn the backrow copy still glows for its controller, and fires at that turn's end", () => {
    const s = scenario({
      seed: "r195-071-their-turn",
      active: "p2",
      p1: { backrow: ["core-071"], library: ["core-001", "core-003", "core-005"], hand: ["core-005"] },
      p2: { library: ["core-005", "core-023"], hand: ["core-005"] },
    });

    expect(glows(s.view("p1").you.backrow[0])).toBe(true);
    expect(s.view("p2").opponent.backrow[0]).toEqual({ faceDown: true });

    s.endTurn();

    expect(countOf(s, "trapFired")).toBe(1);
    expect(s.unit("p1", 1)?.defId).toBe("core-003");
  });

  it("R195 B8: the radiant face glows on the same condition and recruits up to cost 2", () => {
    const s = scenario({
      seed: "r195-071-radiant",
      p1: {
        backrow: [{ def: "core-071", radiant: true }],
        library: ["core-001", "core-003", "core-005"],
        hand: ["core-005"],
      },
      p2: { library: ["core-005"], hand: ["core-005"] },
    });

    expect(glows(s.view("p1").you.backrow[0])).toBe(true);
    s.endTurn();
    expect(countOf(s, "trapFired")).toBe(1);
    expect(s.unit("p1", 1)?.defId).toBe("core-001");
  });

  it("R195 B8: in hand it glows while the library is larger, and keeps glowing once played to the backrow", () => {
    const s = scenario({
      seed: "r195-071-hand-ahead",
      p1: { hand: ["core-071", "core-005"], library: ["core-001", "core-003", "core-005"] },
      p2: { library: ["core-005"], hand: ["core-005"] },
    });
    const trap = s.card("core-071");

    expect(handGlows(s, trap)).toBe(true);
    s.play(trap);

    // R227: set face-down, the card took a fresh id; it is the same Intern Stimmy.
    expect(s.backrow("p1", 1)?.defId).toBe("core-071");
    expect(glows(s.view("p1").you.backrow[0])).toBe(true);
    expect(s.view("p2").opponent.backrow[0]).toEqual({ faceDown: true });
  });

  it("R195 B8: in hand with equal libraries it does not glow", () => {
    const s = scenario({
      seed: "r195-071-hand-equal",
      p1: { hand: ["core-071", "core-005"], library: ["core-001", "core-003"] },
      p2: { library: ["core-005", "core-023"], hand: ["core-005"] },
    });

    expect(handGlows(s, s.card("core-071"))).toBe(false);
  });
});

// =============================================================================================
// #93 Combo-Index (field only): your turn, cards played reach the grade, not at S
// =============================================================================================

describe("#93 Combo-Index lights up when its grade will rise (R195, B9)", () => {
  const COMBO_INDEX = "core-093";
  /** Keyword-only units: a play is only a play. */
  const FODDER = ["core-003", "core-008", "core-011"] as const;
  /** Cards that sit in hand as material for the cascade's steps. */
  const HELD = ["core-005", "core-010", "core-056"] as const;

  function grade(s: Scenario): number {
    return s.card(COMBO_INDEX).counters.grade ?? 1;
  }

  function indexGlows(s: Scenario): boolean {
    return glows(s.view("p1").you.backrow[0]);
  }

  function board(seed: string, entry: string | { def: string; counters?: { grade?: number }; radiant?: boolean }): Scenario {
    return scenario({
      seed,
      p1: { backrow: [entry], hand: [...FODDER, ...HELD], library: ["core-016", "core-016"], mana: 10 },
      p2: { hand: ["core-005"], library: ["core-016", "core-016"] },
    });
  }

  it("R195 B9: at E it glows once a card has been played this turn, and the grade then rises to D", () => {
    const s = board("r195-093-e", COMBO_INDEX);

    expect(indexGlows(s)).toBe(false);
    s.play(FODDER[0]);
    expect(indexGlows(s)).toBe(true);
    // A Field Spell is public, but the flag is still the controller's alone.
    expect(glows(s.view("p2").opponent.backrow[0])).toBe(false);

    s.endTurn();
    expect(grade(s)).toBe(2);
  });

  it("R195 B9: below its grade it does not glow, and the grade does not rise", () => {
    const s = board("r195-093-d-short", { def: COMBO_INDEX, counters: { grade: 2 } });

    s.play(FODDER[0]);
    expect(indexGlows(s)).toBe(false);

    s.endTurn();
    expect(grade(s)).toBe(2);
  });

  it("R195 B9: reaching its grade lights it, and the grade then rises", () => {
    const s = board("r195-093-d-reached", { def: COMBO_INDEX, counters: { grade: 2 } });

    s.play(FODDER[0]);
    expect(indexGlows(s)).toBe(false);
    s.play(FODDER[1]);
    expect(indexGlows(s)).toBe(true);

    s.endTurn();
    expect(grade(s)).toBe(3);
  });

  it("R195 B9: at S it never glows, however many cards were played, and the grade stays S", () => {
    const s = board("r195-093-s", { def: COMBO_INDEX, counters: { grade: 6 } });

    s.play(FODDER[0]);
    s.play(FODDER[1]);
    s.play(FODDER[2]);
    expect(indexGlows(s)).toBe(false);

    s.endTurn();
    expect(grade(s)).toBe(6);
  });

  it("R195 B9: on the opponent's turn it never glows, its controller's plays over with their turn", () => {
    const s = board("r195-093-their-turn", COMBO_INDEX);

    s.play(FODDER[0]);
    s.play(FODDER[1]);
    expect(indexGlows(s)).toBe(true);

    s.endTurn();

    expect(s.state.active).toBe("p2");
    expect(grade(s)).toBe(2);
    // "This turn" starts afresh for both players (§6.2, turn.ts's startTurn), so p1's two plays no
    // longer count on p2's turn, and the hook's `yourTurn` would keep it dark even if they did.
    expect(s.state.players.p1.turnLog.cardsPlayed).toBe(0);
    expect(indexGlows(s)).toBe(false);
  });

  it("R195 B9: the radiant face glows on the same condition", () => {
    const s = board("r195-093-radiant", { def: COMBO_INDEX, radiant: true });

    expect(indexGlows(s)).toBe(false);
    s.play(FODDER[0]);
    expect(indexGlows(s)).toBe(true);
  });

  it("R195 B9: in hand it never glows, even once the cards played would reach its grade", () => {
    const s = scenario({
      seed: "r195-093-hand",
      p1: { hand: [COMBO_INDEX, ...FODDER, ...HELD], library: ["core-016"], mana: 10 },
      p2: { hand: ["core-005"], library: ["core-016"] },
    });
    const index = s.card(COMBO_INDEX);

    s.play(FODDER[0]);
    s.play(FODDER[1]);
    s.play(FODDER[2]);

    expect(handGlows(s, index)).toBe(false);
  });
});

// =============================================================================================
// R196: a fusion glows when any ingredient's condition holds
// =============================================================================================

describe("R196 a crafted #53 Reno + #68 Twisted Sorcerer glows when either printed condition holds", () => {
  const RENO = "core-053";
  const SORCERER = "core-068";
  const SPONGE = "core-019"; // Midrange Menace 9/9, no Armor.
  /** A free Spell that keeps the turn open (§2.5's auto-end); never played. */
  const ANCHOR = "core-010";

  /** Fuse p1's Reno and Sorcerer into p1's hand through R77's hand path, as #99 Craft a Card does. */
  function crafted(seed: string, health: number): { s: Scenario; fused: CardInstance } {
    const s = scenario({ seed, p1: { hand: [RENO, SORCERER, ANCHOR], health, mana: 10 }, p2: { field: [SPONGE] } });
    const sink = { state: s.state, events: [], rng: createRng(s.state.seed, s.state.rngCursor) };
    const fused = subsystems.fuse(sink, { ingredients: [s.card(RENO), s.card(SORCERER)], toHand: "p1" });
    if (fused === null) throw new Error("the fusion did not happen");
    return { s, fused };
  }

  function playAtSponge(s: Scenario, fused: CardInstance): void {
    const sponge = s.unit("p2", 1);
    if (sponge === null) throw new Error("no sponge in p2's lane 1");
    s.play(fused, { targets: [{ pick: "instance", instanceId: sponge.id }] });
  }

  it("R196 with the hero at 5 both conditions hold: it glows, heals to 30, and the Sorcerer half then reads 30 and deals 4", () => {
    const { s, fused } = crafted("r196-both", 5);

    expect(handGlows(s, fused)).toBe(true);
    playAtSponge(s, fused);
    // R102: each ingredient's list is built as the fused Cry reaches it, so the Sorcerer's
    // "8 if your hero is below 10" reads the hero Reno has just set to 30.
    s.expectHealth("p1", 30).expectStats(SPONGE, { health: 5, maxHealth: 9 });
  });

  it("R196 with the hero at 20 only Reno's holds: it still glows, heals to 30, and the Sorcerer half deals 4", () => {
    const { s, fused } = crafted("r196-reno-only", 20);

    expect(handGlows(s, fused)).toBe(true);
    playAtSponge(s, fused);
    s.expectHealth("p1", 30).expectStats(SPONGE, { health: 5, maxHealth: 9 });
  });

  it("R196 with the hero at 30 neither holds: no glow, no heal, and 4 damage", () => {
    const { s, fused } = crafted("r196-neither", 30);

    expect(handGlows(s, fused)).toBe(false);
    playAtSponge(s, fused);
    s.expectHealth("p1", 30).expectStats(SPONGE, { health: 5, maxHealth: 9 });
    expect(s.lastEvents.filter((event) => event.type === "healed")).toHaveLength(0);
  });
});

// =============================================================================================
// The set of cards that declare the hook is R195's list
// =============================================================================================

describe("R195 the cards that declare conditionMet", () => {
  it("R195 are exactly #10, #53, #68, #71 and #93, on both faces, so a new hook cannot land untested", () => {
    const hooked = Object.entries(CARDS)
      .filter(([, card]) => card.base.conditionMet !== undefined || card.radiant.conditionMet !== undefined)
      .map(([id]) => id)
      .sort();
    expect(hooked).toEqual(["core-010", "core-053", "core-068", "core-071", "core-093"]);

    for (const id of hooked) {
      const card = CARDS[id];
      expect(card?.base.conditionMet, `${id} base`).toBeTypeOf("function");
      expect(card?.radiant.conditionMet, `${id} radiant`).toBeTypeOf("function");
    }
  });
});
