// The harness proves itself (BUILD M4-T3). Card scripts do not exist yet, so every case here leans
// on data-only cards and asserts ENGINE behaviour, never card text:
//
//   core-025 "4-mana 7/7"  Unit, cost 4, 7/7 Armor 7 / radiant 7/7 Indestructible — keywords only
//   core-056 "Jilliax"     Unit, cost 2, 3/2 Rush Taunt Lifesteal Divine Shield — keywords only
//   core-043 "Big Felinor" Unit, cost 3, 3/10 / radiant 6/20 — the radiant stat difference
//   core-010 "Rapid Replenish" Spell, cost 0 — a play that ends in the graveyard
//   core-041 "Sheepish"    Trap, and core-073 "Anti-oneshot Armor" Field Spell — backrow placement
//
// `reduce` still answers `attack`, `answer` and `activatePower` with a placeholder string, so the
// harness routes those three to the engine functions `reduce` will call (`declareAttack`,
// `answerPrompt`, `subsystems.activatePower`) — see `_harness.ts`'s header. The cases below
// therefore exercise real combat and real prompts today and need no change when the wiring lands.
// `activate()` has no case here: Heroic Power (#98) is its only user and that card's own test
// covers it. A prompt CHAIN needs a card script that opens one, which is a card agent's file.
//
// TURN HAZARD: `reduce` auto-ends a turn with nothing meaningful left on it (§2.5), so scenarios
// that cross a turn boundary give both sides something to do. See `_harness.ts`'s header.

import { describe, expect, it } from "vitest";
import { HAND_CAP, MAX_MANA, effectiveCost, type CardInstance } from "@jackioh/engine";
import { DEFAULT_TURN, scenario, type PileName, type Scenario } from "./_harness";

/** A unit each side can always act with, so `reduce` never auto-ends a turn under a test. */
const ANCHOR = { def: "core-056", lane: 5 } as const;

/**
 * A whole §3.2 Stack pile, top-first, which `unit()` cannot give: it answers with the card on top.
 * `state.players[p].units[lane - 1]` is the pile itself (`Pile = CardInstance[]`, §10.1).
 */
const pileAt = (s: Scenario, player: "p1" | "p2", lane: number): CardInstance[] => [
  ...(s.state.players[player].units[lane - 1] ?? []),
];

describe("harness setup", () => {
  it("places hand, field, backrow, library, graveyard and exile cards in the right zones", () => {
    const s = scenario({
      p1: {
        hand: ["core-025", "core-010"],
        field: [{ def: "core-043", radiant: true }, { def: "core-025", position: "DEF", damage: 3, lane: 4 }],
        backrow: ["core-041", { def: "core-073", faceUp: true, lane: 3 }],
        library: ["core-056", "core-002"],
        graveyard: ["core-005"],
        exile: ["core-016"],
      },
      p2: { field: ["core-056"] },
    });

    expect(s.hand("p1").map((c) => c.defId)).toEqual(["core-025", "core-010"]);
    expect(s.pile("p1", "library").map((c) => c.defId)).toEqual(["core-056", "core-002"]);
    expect(s.pile("p1", "graveyard").map((c) => c.defId)).toEqual(["core-005"]);
    expect(s.pile("p1", "exile").map((c) => c.defId)).toEqual(["core-016"]);

    // §3.2: an entry with no `lane` takes the leftmost zone still free, so the pinned lane 4 stands.
    expect(s.unit("p1", 1)?.defId).toBe("core-043");
    expect(s.unit("p1", 2)).toBeNull();
    expect(s.unit("p1", 4)?.defId).toBe("core-025");
    expect(s.unit("p2", 1)?.defId).toBe("core-056");

    s.expectInZone("core-010", "hand")
      .expectInZone("core-043", "field")
      .expectInZone("core-005", "graveyard")
      .expectInZone("core-016", "exile")
      .expectInZone("core-002", "library");
  });

  it("honours radiant, position, damage and faceUp", () => {
    const s = scenario({
      p1: {
        field: [{ def: "core-043", radiant: true }, { def: "core-025", position: "DEF", damage: 3, lane: 4 }],
        backrow: ["core-041", { def: "core-073", faceUp: true, lane: 3 }],
      },
    });

    // §10.4 layer 1: the radiant face is the printed face once the instance is Radiant.
    expect(s.unit("p1", 1)?.radiant).toBe(true);
    s.expectStats("core-043", { attack: 6, maxHealth: 20, health: 20 });

    const seven = s.unit("p1", 4);
    expect(seven?.position).toBe("DEF");
    expect(seven?.damage).toBe(3);
    // §4.1: Defense Position grants Taunt and Armor +1 on top of the printed Armor 7.
    s.expectStats(seven!, { attack: 7, maxHealth: 7, health: 4 });
    expect(s.stats(seven!).armor).toBe(8);
    expect(s.stats(seven!).keywords.map((k) => k.kind)).toContain("Taunt");
    expect(s.stats(seven!).position).toBe("DEF");

    expect(s.backrow("p1", 1)?.defId).toBe("core-041");
    expect(s.backrow("p1", 1)?.faceUp).toBeUndefined();
    expect(s.backrow("p1", 3)?.defId).toBe("core-073");
    expect(s.backrow("p1", 3)?.faceUp).toBe(true);
    expect(s.backrow("p1", 2)).toBeNull();
  });

  it("library[0] is the next card drawn", () => {
    const s = scenario({ p1: { field: [ANCHOR], library: ["core-056", "core-002"] } });
    s.startTurn();
    expect(s.hand("p1").map((c) => c.defId)).toEqual(["core-056"]);
    expect(s.pile("p1", "library").map((c) => c.defId)).toEqual(["core-002"]);
  });

  it("starts in the main phase with the asked-for active player, turn, mana, health and armor", () => {
    const s = scenario({ turn: 5, active: "p2", p1: { health: 12, armor: 2 }, p2: { mana: 1 } });

    expect(s.state.phase).toBe("main");
    expect(s.state.active).toBe("p2");
    expect(s.state.turn).toBe(5);
    // Turn 5 with p2 active: p2 has started ceil(5/2) = 3 turns, p1 floor(5/2) = 2 (§2.3).
    expect(s.state.players.p2.turnsStarted).toBe(3);
    expect(s.state.players.p1.turnsStarted).toBe(2);
    expect(s.state.players.p2.mana.max).toBe(3);
    expect(s.state.players.p1.mana.max).toBe(2);

    // §2.3: `mana` sets current only, so current may sit below (or above) max.
    s.expectMana("p2", 1).expectMana("p1", 2).expectHealth("p1", 12).expectHealth("p2", 30);
    expect(s.state.players.p1.hero.armor).toBe(2);
  });

  it("defaults to a mid-game board with both sides at MAX_MANA", () => {
    const s = scenario();
    expect(s.state.turn).toBe(DEFAULT_TURN);
    expect(s.state.active).toBe("p1");
    s.expectMana("p1", MAX_MANA).expectMana("p2", MAX_MANA);
    expect(s.state.players.p1.mana.max).toBe(MAX_MANA);
    expect(s.state.players.p2.mana.max).toBe(MAX_MANA);
    // No mulligan, no opening draw, no start-of-turn: setup deals nothing.
    expect(s.hand("p1")).toEqual([]);
    expect(s.events).toEqual([]);
    expect(s.state.rngCursor).toBe(0);
  });

  it("settles the board once, so a unit placed at lethal damage is already dead (§4.5)", () => {
    const s = scenario({ p1: { field: [{ def: "core-043", damage: 10 }, ANCHOR] } });
    expect(s.unit("p1", 1)).toBeNull();
    expect(s.pile("p1", "graveyard").map((c) => c.defId)).toEqual(["core-043"]);
    // The setup's own events are not in the log.
    expect(s.events).toEqual([]);
  });

  it("throws a named error for an unknown card, a duplicate lane, a Spell and a wrong-row card", () => {
    expect(() => scenario({ p1: { hand: ["core-999"] } })).toThrow(/no catalog card matches "core-999"/);
    expect(() =>
      scenario({ p1: { field: [{ def: "core-025", lane: 2 }, { def: "core-056", lane: 2 }] } }),
    ).toThrow(/two cards were given lane 2/);
    // §3.2: a Spell is never on the field.
    expect(() => scenario({ p1: { field: ["core-010"] } })).toThrow(/is a Spell; a Spell is never on the field/);
    // Only an explicit `row` can contradict the def's type, and then it is an error.
    expect(() => scenario({ p1: { backrow: [{ def: "core-025", row: "backrow" }] } })).toThrow(
      /the backrow holds Field Spells and Traps/,
    );
    expect(() => scenario({ p1: { field: [{ def: "core-041", row: "units" }] } })).toThrow(
      /the unit zones hold Units only/,
    );
    // A card filed under the wrong list is simply routed by its type, not refused.
    expect(scenario({ p1: { backrow: ["core-025"] } }).unit("p1", 1)?.defId).toBe("core-025");
    expect(() => scenario({ p1: { field: [{ def: "core-025", lane: 9 }] } })).toThrow(/lanes are 1\.\.5/);
    expect(() => scenario({ p1: { hand: [{ def: "core-025", defId: "core-056" }] } })).toThrow(
      /they are aliases, so give one/,
    );
    expect(() => scenario({ p1: { hand: [{ radiant: true }] } })).toThrow(/needs `def` or `defId`/);
  });

  it("takes `defId` as an alias of `def`, and `radiant` in any zone", () => {
    const s = scenario({
      p1: {
        hand: [{ defId: "core-025", radiant: true }],
        library: [{ defId: "core-043", radiant: true }, "core-002"],
        graveyard: [{ def: "core-005" }],
        field: [{ defId: "core-056", lane: 2 }],
      },
    });
    expect(s.hand("p1")[0]?.defId).toBe("core-025");
    expect(s.hand("p1")[0]?.radiant).toBe(true);
    // #21/#23 want a Radiant card sitting on top of a library.
    expect(s.pile("p1", "library")[0]?.radiant).toBe(true);
    expect(s.pile("p1", "library")[1]?.radiant).toBe(false);
    expect(s.pile("p1", "graveyard")[0]?.defId).toBe("core-005");
    expect(s.unit("p1", 2)?.defId).toBe("core-056");
  });

  it("routes a field entry by its def's type, and `row` overrides it", () => {
    // core-006 Mana Well is a Field Spell: listing it under `field` puts it in the backrow.
    const s = scenario({
      p1: {
        field: [{ defId: "core-006", row: "backrow", lane: 1 }, { defId: "core-025", lane: 1 }],
        backrow: [{ defId: "core-041", lane: 2 }],
      },
    });
    expect(s.backrow("p1", 1)?.defId).toBe("core-006");
    expect(s.backrow("p1", 2)?.defId).toBe("core-041");
    expect(s.unit("p1", 1)?.defId).toBe("core-025");

    // Same board with the row left to the def's type.
    const implied = scenario({ p1: { field: ["core-006", "core-025"] } });
    expect(implied.backrow("p1", 1)?.defId).toBe("core-006");
    expect(implied.unit("p1", 1)?.defId).toBe("core-025");
  });

  it("§3.2 `stack: true` buries the lane's card, with an explicit lane or the entry before it", () => {
    const s = scenario({
      p1: {
        field: [
          "core-043", // lane 1: the leftmost free zone
          { def: "core-025", stack: true }, // no lane of its own: onto the entry before it
          { def: "core-056", lane: 4 },
          { def: "core-025", stack: true, lane: 4 }, // an explicit lane: onto lane 4's card
        ],
      },
    });

    // Two piles, not four zones: a stacked entry takes no lane of its own.
    expect(pileAt(s, "p1", 1).map((c) => c.defId)).toEqual(["core-025", "core-043"]);
    expect(pileAt(s, "p1", 4).map((c) => c.defId)).toEqual(["core-025", "core-056"]);
    expect(s.unit("p1", 2)).toBeNull();
    expect(s.unit("p1", 3)).toBeNull();
    expect(s.unit("p1", 5)).toBeNull();

    // `unit()` answers with the card on top, which is the one that acts (§3.2).
    expect(s.unit("p1", 1)?.defId).toBe("core-025");
    expect(s.unit("p1", 4)?.defId).toBe("core-025");
    // R13: the buried card is still on the field, it is just not the one acting.
    s.expectInZone(pileAt(s, "p1", 1)[1]!, "field");
  });

  it("§3.2 a three-deep pile reads top-first, so the list reads bottom-first", () => {
    const s = scenario({
      p1: {
        field: [
          "core-043", // written first, so it is at the BOTTOM
          { def: "core-025", stack: true },
          { def: "core-056", stack: true }, // written last, so it is on TOP
        ],
      },
    });

    const pile = pileAt(s, "p1", 1);
    expect(pile.map((c) => c.defId)).toEqual(["core-056", "core-025", "core-043"]);
    expect(s.unit("p1", 1)?.defId).toBe("core-056");

    // Instances are created in list order whatever the pile order is, so reading the pile
    // bottom-first gives the ids in the order they were handed out.
    const bottomFirst = [...pile].reverse().map((c) => Number(c.id.slice(1)));
    expect(bottomFirst).toEqual([...bottomFirst].sort((a, b) => a - b));
  });

  it("§3.2 a dormant card keeps the damage and position the setup gave it (R13)", () => {
    const s = scenario({
      p1: {
        field: [
          { def: "core-043", position: "DEF", damage: 4 },
          { def: "core-025", stack: true },
        ],
      },
    });

    const buried = pileAt(s, "p1", 1)[1]!;
    expect(buried.defId).toBe("core-043");
    // Dormant is not "gone": the damage and the position are the ones it will resume with (R13).
    expect(buried.damage).toBe(4);
    expect(buried.position).toBe("DEF");
    expect(s.unit("p1", 1)?.id).not.toBe(buried.id);
    s.expectInZone(buried, "field");
  });

  it("refuses a repeated lane without `stack`, a stack over nothing, and a stack in the backrow", () => {
    // The refusal names the fix: the only legal way to repeat a lane is a §3.2 pile.
    expect(() =>
      scenario({ p1: { field: [{ def: "core-025", lane: 2 }, { def: "core-056", lane: 2 }] } }),
    ).toThrow(/add `stack: true` to entry \[1\]/);

    // `stack: true` on the first entry: there is no card under it, and no lane either.
    expect(() => scenario({ p1: { field: [{ def: "core-025", stack: true }] } })).toThrow(
      /`stack: true` but lane \? holds nothing yet/,
    );
    // Same with a lane that names an empty zone: the card it buries goes EARLIER in the list.
    expect(() =>
      scenario({ p1: { field: [{ def: "core-025", lane: 1 }, { def: "core-056", stack: true, lane: 3 }] } }),
    ).toThrow(/`stack: true` but lane 3 holds nothing yet/);

    // §3.2: the backrow holds one card per zone, so there is no pile to build there.
    expect(() => scenario({ p1: { backrow: ["core-041", { def: "core-073", stack: true }] } })).toThrow(
      /`stack: true` is a unit-zone pile/,
    );
  });

  it("seeds §10.1's instance counters, and leaves them empty when the entry says nothing", () => {
    const s = scenario({
      p1: {
        field: [
          { def: "core-043", counters: { plague: 2 } }, // #91's plague counters
          { def: "core-025", counters: { grade: 3 }, lane: 2 }, // #93's grade
          { def: "core-056", lane: 3 },
        ],
      },
    });

    expect(s.unit("p1", 1)?.counters).toEqual({ plague: 2 });
    expect(s.unit("p1", 2)?.counters).toEqual({ grade: 3 });
    expect(s.unit("p1", 3)?.counters).toEqual({});
  });

  it("R78 seeds costMod and costOverride in all four off-field zones", () => {
    const s = scenario({
      p1: {
        hand: [{ def: "core-025", costMod: -1 }],
        library: [{ def: "core-025", costOverride: 0 }],
        graveyard: [{ def: "core-025", costMod: 2 }],
        exile: [{ def: "core-025", costOverride: 1, costMod: -1 }],
      },
    });
    const at = (zone: PileName): CardInstance => s.pile("p1", zone)[0]!;

    // R65/R66 read the cost at resolution through `effectiveCost`, printed 4 for core-025.
    expect(at("hand").costMod).toBe(-1);
    expect(effectiveCost(s.state, at("hand"))).toBe(3);
    expect(at("library").costOverride).toBe(0);
    expect(effectiveCost(s.state, at("library"))).toBe(0);
    expect(at("graveyard").costMod).toBe(2);
    expect(effectiveCost(s.state, at("graveyard"))).toBe(6);
    // Both layers at once: the override replaces the printed cost and the mod still applies over it.
    expect(at("exile")).toMatchObject({ costMod: -1, costOverride: 1 });
    expect(effectiveCost(s.state, at("exile"))).toBe(0);

    // An entry that says nothing leaves both alone: costMod 0, no override, printed cost.
    const bare = scenario({ p1: { hand: ["core-025"] } });
    const untouched = bare.hand("p1")[0]!;
    expect(untouched.costMod).toBe(0);
    expect(untouched.costOverride).toBeUndefined();
    expect(effectiveCost(bare.state, untouched)).toBe(4);
  });

  it("R33 writes `faceUp` exactly as given, so `false` reads back false and not undefined", () => {
    const s = scenario({
      p1: {
        backrow: [
          { def: "core-041", faceUp: false }, // a Trap, explicitly face-down
          { def: "core-073", faceUp: true, lane: 2 },
          { def: "core-041", lane: 3 }, // nothing said: the flag stays unset
        ],
      },
    });

    expect(s.backrow("p1", 1)?.faceUp).toBe(false);
    expect(s.backrow("p1", 2)?.faceUp).toBe(true);
    expect(s.backrow("p1", 3)?.faceUp).toBeUndefined();
  });

  it("honours statsOverride (§10.4 layer 1, R41)", () => {
    const s = scenario({ p1: { field: [{ defId: "core-043", statsOverride: { attack: 3, health: 3 } }] } });
    s.expectStats("core-043", { attack: 3, maxHealth: 3, health: 3 });
  });

  it("accepts a fixture declared `as const`", () => {
    const fixture = { hand: ["core-025"], field: [{ defId: "core-056", lane: 5 }] } as const;
    const s = scenario({ p1: fixture });
    expect(s.hand("p1")).toHaveLength(1);
    expect(s.unit("p1", 5)?.defId).toBe("core-056");
  });
});

describe("string references", () => {
  it("resolves a catalog id, a §5 index, a name and an instance id", () => {
    const s = scenario({ p1: { field: [{ def: "core-043", lane: 2 }] } });
    const inst = s.unit("p1", 2);
    expect(s.card("core-043").id).toBe(inst?.id);
    expect(s.card("43").id).toBe(inst?.id);
    expect(s.card("Big Felinor").id).toBe(inst?.id);
    expect(s.card("big felinor").id).toBe(inst?.id);
    expect(s.card(inst!.id).id).toBe(inst?.id);
  });

  it("prefers the active player's copy", () => {
    const s = scenario({ active: "p2", p1: { field: ["core-025"] }, p2: { field: ["core-025"] } });
    expect(s.card("core-025").controller).toBe("p2");
  });

  it("throws a diagnosable error when nothing matches", () => {
    const s = scenario({ p1: { field: ["core-025"] } });
    expect(() => s.card("core-056")).toThrow(/nothing matching "core-056"/);
    expect(() => s.card("core-056")).toThrow(/core-025/); // the error lists what was there instead
    expect(() => s.card("not-a-card")).toThrow(/nothing matching "not-a-card"/);
  });

  it("re-resolves a stale CardInstance by its id across a reduce", () => {
    const s = scenario({ p1: { hand: ["core-025"], field: [ANCHOR] } });
    const stale = s.hand("p1")[0]!;
    s.play(stale); // `reduce` cloned the state, so `stale` is a snapshot of a dead object
    s.expectInZone(stale, "field").expectStats(stale, { attack: 7 });
    expect(s.card(stale).zone.z).toBe("field");
  });
});

describe("play", () => {
  it("spends mana, emits cardPlayed and summoned, and puts the unit in the leftmost free zone (R64)", () => {
    const s = scenario({ p1: { hand: ["core-025"], field: [ANCHOR] } });
    s.play("core-025");
    s.expectMana("p1", 0).expectEvents("cardPlayed", "summoned").expectInZone("core-025", "field");
    expect(s.unit("p1", 1)?.defId).toBe("core-025");
    expect(s.state.players.p1.turnLog.cardsPlayed).toBe(1);
  });

  it("takes a 1-based lane through `zone`", () => {
    const s = scenario({ p1: { hand: ["core-025"], field: [ANCHOR] } });
    s.play("core-025", { zone: 3 });
    expect(s.unit("p1", 3)?.defId).toBe("core-025");
    expect(s.unit("p1", 1)).toBeNull();
  });

  it("sends a Spell to the graveyard (§10.5 step 7)", () => {
    const s = scenario({ p1: { hand: ["core-010"], field: [ANCHOR] } });
    s.play("core-010");
    s.expectInZone("core-010", "graveyard").expectEvents("cardPlayed", "enteredGraveyard");
    expect(s.unit("p1", 1)).toBeNull();
  });

  it("throws the engine's own refusal", () => {
    const poor = scenario({ p1: { hand: ["core-025"], mana: 3, field: [ANCHOR] } });
    expect(() => poor.play("core-025")).toThrow(/more than your mana/);
    // The refusal leaves the state alone: the card is still in hand and the mana unspent.
    poor.expectInZone("core-025", "hand").expectMana("p1", 3);

    // "Uncastable at 4 mana" (M4-T4): a 6-cost card with MAX_MANA available.
    const giga = scenario({ p1: { hand: ["core-029"], field: [ANCHOR] } });
    expect(() => giga.play("core-029")).toThrow(/costs 6, more than your mana/);

    const full = scenario({
      p1: { hand: ["core-025"], field: ["core-056", "core-056", "core-056", "core-056", "core-056"] },
    });
    expect(() => full.play("core-025")).toThrow(/no free units zone/);

    const taken = scenario({ p1: { hand: ["core-025"], field: [ANCHOR] } });
    expect(() => taken.play("core-025", { zone: 5 })).toThrow(/not open/);

    const wrong = scenario({ p1: { hand: ["core-010"], field: [ANCHOR] } });
    expect(() => wrong.play("core-010", { zone: 1 })).toThrow(/a Spell takes no zone/);

    const absent = scenario({ p1: { hand: ["core-025"], field: [ANCHOR] } });
    expect(() => absent.play("core-056")).toThrow(/nothing matching "core-056" is in a hand/);
  });

  it("refuses a play on the other player's turn", () => {
    const s = scenario({ p1: { field: [ANCHOR] }, p2: { hand: ["core-025"], field: [ANCHOR] } });
    expect(() => s.play("core-025")).toThrow(/not your turn/);
  });
});

describe("attack", () => {
  it("hits the enemy hero through `hero-${player}`", () => {
    const s = scenario({ p1: { field: ["core-056"] }, p2: { health: 20 } });
    s.attack("core-056", "hero");
    // Jilliax is 3/2 with Lifesteal, so §4.4 step 8 heals p1 by the 3 it dealt.
    s.expectHealth("p2", 17).expectHealth("p1", 33).expectEvents("attackDeclared", "damage", "healed");
  });

  it("resolves a unit exchange and spends the exertion (§4.1, §4.3)", () => {
    const s = scenario({ p1: { field: ["core-025"] }, p2: { field: ["core-056"] } });
    s.attack("core-025", s.unit("p2", 1)!);
    // Divine Shield eats the 7 (§4.4 step 1); the strike-back of 3 is stopped by Armor 7 (step 2).
    s.expectEvents("attackDeclared", "divineShieldLost").expectStats("core-025", { health: 7 });
    s.expectStats(s.unit("p2", 1)!, { health: 2 });
    expect(() => s.attack("core-025", s.unit("p2", 1)!)).toThrow(/already acted/);
  });

  it("enforces Taunt (§4.2 step 3)", () => {
    const s = scenario({ p1: { field: ["core-025"] }, p2: { field: ["core-056"] } });
    expect(() => s.attack("core-025", "hero")).toThrow(/Taunt/);
  });
});

describe("startTurn and endTurn", () => {
  it("startTurn re-starts the ACTIVE player's turn: turn +1, mana refresh, triggers, one draw", () => {
    const s = scenario({ p1: { field: [ANCHOR], library: ["core-002"], mana: 1 } });
    s.startTurn();

    expect(s.state.active).toBe("p1");
    expect(s.state.turn).toBe(DEFAULT_TURN + 1);
    expect(s.state.phase).toBe("main");
    expect(s.state.players.p1.turnsStarted).toBe(6);
    s.expectMana("p1", MAX_MANA);
    expect(s.hand("p1").map((c) => c.defId)).toEqual(["core-002"]);
    s.expectEvents("turnStarted", "manaChanged", "drawn", "addedToHand");
  });

  it("endTurn hands the turn to the opponent, and two endTurns come back around", () => {
    const s = scenario({
      p1: { field: [ANCHOR], hand: ["core-010"] },
      p2: { field: [ANCHOR], hand: ["core-010"] },
    });
    s.endTurn();
    expect(s.state.active).toBe("p2");
    expect(s.state.turn).toBe(DEFAULT_TURN + 1);
    s.expectEvents("turnEnded", "turnStarted");

    s.endTurn();
    expect(s.state.active).toBe("p1");
    expect(s.state.turn).toBe(DEFAULT_TURN + 2);
  });

  it("exertion resets at the controller's own turn start (§4.1)", () => {
    const s = scenario({ p1: { field: ["core-056"] }, p2: { health: 20 } });
    s.attack("core-056", "hero");
    expect(() => s.attack("core-056", "hero")).toThrow(/already acted/);
    s.startTurn();
    s.attack("core-056", "hero");
    s.expectHealth("p2", 14);
  });
});

describe("answer", () => {
  it("throws when no prompt is open, naming the phase and the turn", () => {
    const s = scenario({ p1: { field: [ANCHOR] } });
    expect(() => s.answer("anything")).toThrow(/no prompt is open/);
    expect(() => s.answer([{ pick: "none" }])).toThrow(/no prompt is open/);
  });

  // A real prompt chain (`s.play(x).answer("a").answer("b")`) needs `packages/engine/src/prompts.ts`
  // and a card script that opens a prompt; `reduce`'s `answer` case still says "prompts arrive with
  // M3". `answer` reads `state.pending` fresh on every call, so a chain works the moment it lands.
});

describe("assertion helpers fail loudly", () => {
  it("expectInZone", () => {
    const s = scenario({ p1: { hand: ["core-025"], field: [ANCHOR] } });
    s.expectInZone("core-025", "hand");
    expect(() => s.expectInZone("core-025", "graveyard")).toThrow(/should be in graveyard but is in hand/);
  });

  it('expectInZone("gone") for a card that ceased to exist (R11)', () => {
    // A unit token in a hand is legal (#75, R11); playing it and letting it leave the field is what
    // makes it vanish, which needs card scripts. Until then: a live card is not "gone".
    const s = scenario({ p1: { field: ["core-025", ANCHOR] } });
    const unit = s.unit("p1", 1)!;
    expect(() => s.expectInZone(unit, "gone")).toThrow(/should be in gone but is in field/);
  });

  it("expectStats", () => {
    const s = scenario({ p1: { field: ["core-025"] } });
    s.expectStats("core-025", { attack: 7, health: 7, maxHealth: 7 });
    expect(() => s.expectStats("core-025", { attack: 6 })).toThrow(/attack should be 6 but is 7/);
  });

  it("expectEvents", () => {
    const s = scenario({ p1: { hand: ["core-025"], field: [ANCHOR] } });
    s.play("core-025");
    s.expectEvents("cardPlayed", "summoned");
    // A subsequence, not contiguous: manaChanged sits between them in the log.
    s.expectEvents("manaChanged", "summoned");
    expect(() => s.expectEvents("summoned", "cardPlayed")).toThrow(/not a subsequence/);
    expect(() => s.expectEvents("gameOver")).toThrow(/not a subsequence/);
  });

  it("expectHealth and expectMana", () => {
    const s = scenario({ p1: { health: 11, mana: 2 } });
    s.expectHealth("p1", 11).expectMana("p1", 2);
    expect(() => s.expectHealth("p1", 30)).toThrow(/should be at 30 but is at 11/);
    expect(() => s.expectMana("p1", 4)).toThrow(/should have 4 mana but has 2/);
  });

  it("unit, backrow, hand and pile", () => {
    const s = scenario({ p1: { hand: ["core-010"], field: [{ def: "core-025", lane: 2 }], backrow: ["core-041"] } });
    expect(s.unit("p1", 2)?.defId).toBe("core-025");
    expect(s.unit("p1", 1)).toBeNull();
    expect(s.unit("p2", 2)).toBeNull();
    expect(s.backrow("p1", 1)?.defId).toBe("core-041");
    expect(s.hand("p1").map((c) => c.defId)).toEqual(["core-010"]);
    expect(s.hand("p2")).toEqual([]);
    expect(s.pile("p1", "hand").map((c) => c.defId)).toEqual(["core-010"]);
    expect(() => s.unit("p1", 6)).toThrow(/lanes are 1\.\.5/);
    expect(() => s.backrow("p1", 0)).toThrow(/lanes are 1\.\.5/);
  });

  it("every step returns the same mutable scenario, and state and events follow it", () => {
    const s = scenario({ p1: { hand: ["core-025"], field: [ANCHOR] } });
    const before = s.state;
    expect(s.play("core-025")).toBe(s);
    expect(s.expectMana("p1", 0)).toBe(s);
    // `reduce` clones, so the live state is a new object and the getter tracks it.
    expect(s.state).not.toBe(before);
    expect(s.lastEvents.length).toBeGreaterThan(0);
    expect(s.events).toEqual(s.lastEvents); // one step so far
    expect(s.hand("p1")).toEqual([]);
    expect(HAND_CAP).toBeGreaterThan(0);
  });
});

describe("determinism", () => {
  const steps = (seed: string) => {
    const s = scenario({
      seed,
      p1: { field: [{ def: "core-056", lane: 5 }], hand: ["core-025"], library: ["core-002"] },
      p2: { field: ["core-056"], hand: ["core-010"] },
    });
    s.play("core-025")
      .attack(s.unit("p1", 5)!, s.unit("p2", 1)!)
      .startTurn();
    return s;
  };

  it("the same seed and the same steps give identical event logs and identical rngCursor", () => {
    const a = steps("seed-alpha");
    const b = steps("seed-alpha");
    expect(JSON.stringify(a.events)).toBe(JSON.stringify(b.events));
    expect(a.state.rngCursor).toBe(b.state.rngCursor);
    expect(JSON.stringify(a.state)).toBe(JSON.stringify(b.state));
  });

  it("the rng cursor is threaded, and nothing reachable consumes rng yet", () => {
    // Nothing in these steps draws from the rng: setup does not shuffle, `draw` and `combat` never
    // call it, and no card script exists to. So the cursor is still 0 and the threading
    // (`state.rngCursor = sink.rng.cursor` after a direct call, `reduce`'s own write after an
    // action) is currently a no-op — which is exactly why a cross-seed DIFFERENCE cannot be shown
    // here. When the first rng-consuming card script lands, turn this into a same-seed/other-seed
    // comparison of the logs.
    const a = steps("seed-alpha");
    const b = steps("seed-beta");
    expect(a.state.rngCursor).toBe(0);
    expect(b.state.rngCursor).toBe(0);
    expect(JSON.stringify(a.events)).toBe(JSON.stringify(b.events));
  });
});

describe("view", () => {
  it("reports the viewer, the turn and the phase", () => {
    const s = scenario({ turn: 5, active: "p2", p1: { field: ["core-025"] } });
    const view = s.view("p1");
    expect(view.viewer).toBe("p1");
    expect(view.you.player).toBe("p1");
    expect(view.opponent.player).toBe("p2");
    expect(view.turn).toBe(5);
    expect(view.active).toBe("p2");
    expect(view.phase).toBe("main");
    expect(s.view().viewer).toBe("p2"); // defaults to the active player
  });

  it("never leaks the other side's hand (§10.8)", () => {
    const s = scenario({ p1: { hand: ["core-025"] }, p2: { hand: ["core-043", "core-010"] } });
    const view = s.view("p1");
    expect(Array.isArray(view.you.hand)).toBe(true);
    expect(Array.isArray(view.opponent.hand)).toBe(false);
    expect(JSON.stringify(view.opponent.hand)).not.toContain("core-043");
    expect(JSON.stringify(view.opponent)).not.toContain("core-010");
    expect(view.opponent.hand).toEqual({ count: 2 });
  });
});
