// #100 Ceaseless Void — SPEC §8.5, §6.3 (Cost, Exile), §10.4, §10.5, R11, R55, R65, R70.
//
// BUILD M4-T4 row 100: "Cost = 100 − (drawn + played + destroyed + exiled by both players),
// floor 0 (R55); Cry exiles every other permanent; radiant Charge". R275 doubles the radiant face's
// stats: it is a 20/20 with Charge.
//
// The cost half is complete and is tested THROUGH the cost pipeline — `printedCost`,
// `effectiveCost` and the play validator's own refusal — never by reading the hook's return value
// or the catalog's 100 back to itself.
//
// The Cry is `exileAll({ side: "any", rows: ["units", "backrow"], excludeSelf: true })`, the
// board-wide exile the effects barrel exports.

import { describe, expect, it } from "vitest";
import type { GameEvent, PlayerId } from "@jackioh/shared";
import { effectiveCost, printedCost } from "@jackioh/engine";
import type { CardInstance } from "@jackioh/engine";
import { cardDef } from "../src/catalog-data";
import { base as voidBase, radiant as voidRadiant } from "../src/scripts/100-ceaseless-void";
import { scenario, type Scenario, type SideSetup } from "./_harness";

const VOID = "core-100"; // Unit, 100, Mythic, 10/10 → 20/20 plus Charge
const PRINTED = 100;

/** #11 Tempo Timmy, a 1-cost 3/3 Unit. #58 Rush Token Farm, a 2-cost Field Spell with no triggers
 *  on a play. A radiant #25 is an Indestructible 7/7, and #98 an Indestructible Field Spell. */
const TIMMY = "core-011";
const FARM = "core-058";
const ROCKY = "core-025";
const HEROIC = "core-098";
const RUSH_TOKEN = "core-t-rush";
/** #53 Reno, a 3-cost Unit: the spare card that keeps §2.5's auto-end off the assertions. */
const SPARE = "core-053";
/** #36 Magic Jammed destroys a chosen backrow card; #72 Reminisce exiles itself on resolving. */
const JAMMED = "core-036";
const REMINISCE = "core-072";
/** #21 Hinder casts itself on the draw (R40, R70), so it counts as a play nobody played. */
const HINDER = "core-021";

type Counters = { drawn: number; played: number; destroyed: number; exiled: number };

function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`expected ${what}`);
  return value;
}

function eventsOf<T extends GameEvent["type"]>(s: Scenario, type: T): Extract<GameEvent, { type: T }>[] {
  return s.events.filter((event): event is Extract<GameEvent, { type: T }> => event.type === type);
}

function unitsOf(s: Scenario, player: PlayerId): CardInstance[] {
  return [1, 2, 3, 4, 5].flatMap((lane) => {
    const found = s.unit(player, lane);
    return found === null ? [] : [found];
  });
}

function backrowOf(s: Scenario, player: PlayerId): CardInstance[] {
  return [1, 2, 3, 4, 5].flatMap((lane) => {
    const found = s.backrow(player, lane);
    return found === null ? [] : [found];
  });
}

function totalOf(counters: Counters): number {
  return counters.drawn + counters.played + counters.destroyed + counters.exiled;
}

/**
 * R55's four counters are game-level numbers the engine increments (`draw`, `resolve.countAsPlayed`,
 * the state check, `move.exile`). Writing them is writing exactly what those paths write, which is
 * how a test reaches a game that has seen 97 cards without playing one.
 */
function setCounters(s: Scenario, counters: Partial<Counters>): Counters {
  s.state.counters = { ...s.state.counters, ...counters };
  return s.state.counters;
}

function voidScenario(opts: { radiantFace?: boolean; p1?: SideSetup; p2?: SideSetup } = {}): Scenario {
  return scenario({
    seed: "void",
    p1: {
      mana: 4,
      ...(opts.p1 ?? {}),
      hand: [{ def: VOID, radiant: opts.radiantFace === true }, SPARE, ...(opts.p1?.hand ?? [])],
    },
    ...(opts.p2 === undefined ? {} : { p2: opts.p2 }),
  });
}

function held(s: Scenario): CardInstance {
  return must(s.hand("p1").find((card) => card.defId === VOID), "the Void in hand");
}

// ---------------------------------------------------------------------------
// The card.
// ---------------------------------------------------------------------------

describe("#100 Ceaseless Void — the card", () => {
  it("§8.5 is a Mythic 10/10 → 20/20 Unit printed at 100, with Charge only on the radiant face", () => {
    const def = cardDef(VOID);
    expect(def.type).toBe("Unit");
    expect(def.cost).toBe(PRINTED);
    expect(def.rarity).toBe("Mythic");
    expect([def.base.attack, def.base.health]).toEqual([10, 10]);
    // R275: a Radiant Unit's attack and health are each at least double its base face's.
    expect([def.radiant.attack, def.radiant.health]).toEqual([20, 20]);
    // §8 Conventions: "Plus X" adds keyword X and restates no clause.
    expect(def.base.keywords.map((keyword) => keyword.kind)).not.toContain("Charge");
    expect(def.radiant.keywords.map((keyword) => keyword.kind)).toEqual(["Charge"]);
  });

  it("§10.9 one script serves both faces: the cost hook and the Cry, and nothing else", () => {
    // "Plus Charge" and the 20/20 are printed on the radiant face and so §10.4 layer 1, not a line
    // of script, which is why the two faces are the same object and both of the row's clauses are
    // kept.
    expect(voidRadiant).toBe(voidBase);
    expect(Object.keys(voidBase).sort()).toEqual(["cost", "cry"]);
  });

  it("§10.4 R275 the base face reads 10/10 and the radiant face 20/20 through the layers", () => {
    const s = scenario({
      p1: { field: [VOID], hand: [SPARE] },
      p2: { field: [{ def: VOID, radiant: true }] },
    });
    s.expectStats(must(s.unit("p1", 1), "the base Void"), { attack: 10, health: 10, maxHealth: 10 });
    s.expectStats(must(s.unit("p2", 1), "the radiant Void"), {
      attack: 20,
      health: 20,
      maxHealth: 20,
    });
  });
});

// ---------------------------------------------------------------------------
// The cost (R55, R65). Tested through the pipeline and the play validator.
// ---------------------------------------------------------------------------

describe("#100 Ceaseless Void — the cost (R55, R65)", () => {
  it("§8.5 on a fresh game it costs its printed 100 and no play can afford it", () => {
    const s = voidScenario();
    expect(s.state.counters).toEqual({ drawn: 0, played: 0, destroyed: 0, exiled: 0 });
    // The hook is consulted ahead of the printed cost, and on a fresh game they agree.
    expect(printedCost(s.state, held(s))).toBe(PRINTED);
    expect(effectiveCost(s.state, held(s))).toBe(PRINTED);
    expect(() => s.play(VOID)).toThrow(/Ceaseless Void costs 100, more than your mana/);
  });

  it("R55 each of the four counters takes 1 off, on either player's behalf", () => {
    const s = voidScenario();
    for (const key of ["drawn", "played", "destroyed", "exiled"] as const) {
      setCounters(s, { drawn: 0, played: 0, destroyed: 0, exiled: 0, [key]: 1 });
      expect(effectiveCost(s.state, held(s))).toBe(PRINTED - 1);
    }
    // They add up: four counters at 25 is 100 spent.
    setCounters(s, { drawn: 25, played: 25, destroyed: 25, exiled: 25 });
    expect(effectiveCost(s.state, held(s))).toBe(0);
  });

  it("§8.5 floors at 0: a long game never gives it a negative cost", () => {
    const s = voidScenario();
    setCounters(s, { drawn: 200, played: 50, destroyed: 10, exiled: 10 });
    expect(printedCost(s.state, held(s))).toBe(0);
    expect(effectiveCost(s.state, held(s))).toBe(0);
  });

  it("§8.5 'cost recomputed on read': nothing is stored on the instance", () => {
    const s = voidScenario();
    const card = held(s);
    expect(card.costOverride).toBeUndefined();

    setCounters(s, { drawn: 10 });
    expect(effectiveCost(s.state, held(s))).toBe(90);
    setCounters(s, { drawn: 40 });
    expect(effectiveCost(s.state, held(s))).toBe(60);
    setCounters(s, { drawn: 0 });
    expect(effectiveCost(s.state, held(s))).toBe(PRINTED);
    expect(held(s).costOverride).toBeUndefined();
    expect(held(s).costMod).toBe(0);
  });

  it("R65 the hook is the START of the calculation: costMod and discounts still apply after it", () => {
    const s = voidScenario();
    setCounters(s, { drawn: 96 });
    expect(printedCost(s.state, held(s))).toBe(4);
    // `costMod` is what `setCostMod` writes, and R65 adds it to the printed cost — which for this
    // card is the hook's number, not the catalog's 100.
    held(s).costMod = -2;
    expect(effectiveCost(s.state, held(s))).toBe(2);
    held(s).costMod = 0;
    expect(effectiveCost(s.state, held(s))).toBe(4);
  });

  it("R55 the counters are the engine's: real draws, plays, destructions and exiles move them", () => {
    const s = scenario({
      seed: "void-real",
      p1: {
        hand: [VOID, JAMMED, REMINISCE, SPARE],
        library: [SPARE, SPARE],
        graveyard: [TIMMY],
        mana: 8,
      },
      p2: { backrow: [FARM] },
    });
    expect(effectiveCost(s.state, held(s))).toBe(PRINTED);

    // A draw.
    s.startTurn();
    const afterDraw = effectiveCost(s.state, held(s));
    expect(s.state.counters.drawn).toBeGreaterThanOrEqual(1);
    expect(afterDraw).toBe(PRINTED - totalOf(s.state.counters));

    // A play that destroys: #36 Magic Jammed on p2's Field Spell.
    s.play(JAMMED, {
      targets: [{ pick: "instance", instanceId: must(s.backrow("p2", 1), "p2's #58").id }],
    });
    expect(s.state.counters.played).toBeGreaterThanOrEqual(1);
    expect(s.state.counters.destroyed).toBeGreaterThanOrEqual(1);

    // A play that exiles: #72 Reminisce exiles itself once its Discover is answered.
    s.play(REMINISCE);
    s.answer(must(s.state.pending?.options[0], "a graveyard card").key);
    expect(s.state.counters.exiled).toBeGreaterThanOrEqual(1);

    const total = totalOf(s.state.counters);
    expect(total).toBeGreaterThanOrEqual(4);
    expect(effectiveCost(s.state, held(s))).toBe(PRINTED - total);
  });

  it("R70 a cast counts as a play, so a card nobody played still makes the Void cheaper", () => {
    // #21 Hinder casts itself on the draw. R70: "counts as a play for every rule that counts or
    // reacts to plays … (Ceaseless Void)".
    const s = scenario({
      seed: "void-cast",
      p1: { hand: [VOID, SPARE], library: [HINDER, SPARE, SPARE], mana: 4 },
      p2: { hand: [SPARE] },
    });
    s.startTurn();

    expect(s.events.some((event) => event.type === "cardPlayed" && event.defId === HINDER)).toBe(true);
    expect(s.state.counters.played).toBeGreaterThanOrEqual(1);
    // …and no `play` action was ever sent: the counter moved on a cast alone.
    expect(effectiveCost(s.state, held(s))).toBe(PRINTED - totalOf(s.state.counters));
  });

  it("§10.5 playing it never makes itself cheaper: the cost is paid before the play is counted", () => {
    const s = voidScenario({ p1: { field: [TIMMY], mana: 4 } });
    setCounters(s, { drawn: 97 });
    expect(effectiveCost(s.state, held(s))).toBe(3);

    s.play(VOID);
    // Step 2 pays, step 4 increments the play counter, so 3 was paid rather than 2.
    expect(eventsOf(s, "cardPlayed")[0]?.costPaid).toBe(3);
    s.expectMana("p1", 1);
    expect(s.state.counters.played).toBe(1);
  });

  it("§8.5 once the game has spent 100 cards it is free, and it lands as a 10/10", () => {
    const s = voidScenario({ p1: { mana: 0 } });
    setCounters(s, { drawn: 60, played: 20, destroyed: 10, exiled: 10 });
    expect(effectiveCost(s.state, held(s))).toBe(0);

    s.play(VOID);
    const landed = must(s.unit("p1", 1), "the Void on the field");
    expect(landed.defId).toBe(VOID);
    s.expectStats(landed, { attack: 10, health: 10, maxHealth: 10 });
    expect(eventsOf(s, "cardPlayed")[0]?.costPaid).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The Cry (§8.5, §6.3 Exile, R11). FAILING: `exileAll` is not re-exported by effects/index.ts.
// ---------------------------------------------------------------------------

describe("#100 Ceaseless Void — the Cry exiles every other permanent", () => {
  /** A board with a permanent of every interesting kind on both sides, and #100 in p1's hand. */
  function boardScenario(opts: { radiantFace?: boolean } = {}): Scenario {
    const s = voidScenario({
      ...opts,
      p1: { field: [TIMMY, RUSH_TOKEN], backrow: [FARM], mana: 4 },
      p2: { field: [{ def: ROCKY, radiant: true }], backrow: [HEROIC] },
    });
    setCounters(s, { drawn: 100 }); // free, so the play itself is never the thing under test
    return s;
  }

  it("§8.5 exiles both rows on both sides and leaves itself standing", () => {
    const s = boardScenario();
    const others = [
      ...unitsOf(s, "p1"),
      ...backrowOf(s, "p1"),
      ...unitsOf(s, "p2"),
      ...backrowOf(s, "p2"),
    ];
    expect(others).toHaveLength(5);

    s.play(VOID);

    // "all OTHER permanents": the Void is the only card left standing, wherever it landed (R64).
    expect(unitsOf(s, "p1").map((unit) => unit.defId)).toEqual([VOID]);
    expect(backrowOf(s, "p1")).toEqual([]);
    expect(unitsOf(s, "p2")).toEqual([]);
    expect(backrowOf(s, "p2")).toEqual([]);
    expect(eventsOf(s, "exiled")).toHaveLength(5);
  });

  it("§6.1 Indestructible does not stop an exile, a unit or a Field Spell", () => {
    const s = boardScenario();
    const rocky = must(s.unit("p2", 1), "the radiant #25");
    const heroic = must(s.backrow("p2", 1), "the #98 Heroic Power");
    expect(s.stats(rocky).keywords.map((keyword) => keyword.kind)).toContain("Indestructible");
    expect(s.stats(heroic).keywords.map((keyword) => keyword.kind)).toContain("Indestructible");

    s.play(VOID);
    s.expectInZone(rocky, "exile");
    s.expectInZone(heroic, "exile");
  });

  it("§6.3 an exile takes no Death trigger and counts nothing as destroyed", () => {
    const s = boardScenario();
    const before = s.state.counters.destroyed;

    s.play(VOID);
    expect(eventsOf(s, "destroyed")).toHaveLength(0);
    expect(eventsOf(s, "enteredGraveyard")).toHaveLength(0);
    expect(s.state.counters.destroyed).toBe(before);
    expect(s.pile("p1", "graveyard")).toEqual([]);
    expect(s.pile("p2", "graveyard")).toEqual([]);
  });

  it("R11 a unit token ceases to exist instead of reaching the exile pile, and is not counted", () => {
    const s = boardScenario();
    const token = must(
      unitsOf(s, "p1").find((unit) => unit.defId === RUSH_TOKEN),
      "the Rush Token on the field",
    );
    const timmy = must(unitsOf(s, "p1").find((unit) => unit.defId === TIMMY), "the #11");
    const exiledBefore = s.state.counters.exiled;

    s.play(VOID);
    s.expectInZone(token, "gone");
    s.expectInZone(timmy, "exile");
    expect(s.pile("p1", "exile").some((card) => card.defId === RUSH_TOKEN)).toBe(false);
    // R55 counts a card that REACHES the pile, so the four real cards count and the token does not.
    expect(s.state.counters.exiled).toBe(exiledBefore + 4);
  });

  it("§3.1 it reaches the field and only the field: hands, libraries and graveyards are untouched", () => {
    const s = voidScenario({
      p1: { field: [TIMMY], library: [SPARE, SPARE], graveyard: [SPARE], mana: 4 },
      p2: { hand: [SPARE, SPARE], library: [SPARE], graveyard: [SPARE] },
    });
    setCounters(s, { drawn: 100 });

    s.play(VOID);
    expect(s.pile("p1", "library")).toHaveLength(2);
    expect(s.pile("p1", "graveyard")).toHaveLength(1);
    expect(s.hand("p2")).toHaveLength(2);
    expect(s.pile("p2", "library")).toHaveLength(1);
    expect(s.pile("p2", "graveyard")).toHaveLength(1);
    // p1's own hand still holds the spare; only the board was cleared.
    expect(s.hand("p1").map((card) => card.defId)).toEqual([SPARE]);
  });

  it("§8 Conventions the radiant face keeps the Cry: 'Plus Charge' restates no clause", () => {
    const s = boardScenario({ radiantFace: true });
    s.play(VOID);
    expect(unitsOf(s, "p1").map((unit) => unit.defId)).toEqual([VOID]);
    expect(unitsOf(s, "p2")).toEqual([]);
    expect(eventsOf(s, "exiled")).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// The radiant face: "Plus Charge" (§6.1).
// ---------------------------------------------------------------------------

describe("#100 Ceaseless Void — radiant 'Plus Charge'", () => {
  /** The mana is 4 rather than 0 so the spare in hand stays affordable: a side with nothing it can
   *  do auto-ends its turn (§2.5) and the fatigue of the turns that follow would land on the heroes
   *  this test measures. That it costs 0 here is asserted by `costPaid`. */
  function playFreely(radiantFace: boolean): Scenario {
    const s = voidScenario({ radiantFace, p1: { mana: 4 } });
    setCounters(s, { drawn: 100 });
    s.play(VOID);
    expect(eventsOf(s, "cardPlayed")[0]?.costPaid).toBe(0);
    return s;
  }

  it("§6.1 Charge: the radiant face may attack the enemy hero the turn it is played, for 20", () => {
    const s = playFreely(true);
    const card = must(s.unit("p1", 1), "the radiant Void");
    expect(s.stats(card).keywords.map((keyword) => keyword.kind)).toContain("Charge");
    s.expectStats(card, { attack: 20, health: 20, maxHealth: 20 });

    s.attack(card, "hero");
    s.expectHealth("p2", 10); // 30 − 20
  });

  it("§4.1 the base face is summoning sick, so it may attack nothing on its own turn", () => {
    const s = playFreely(false);
    const card = must(s.unit("p1", 1), "the base Void");
    expect(s.stats(card).keywords.map((keyword) => keyword.kind)).not.toContain("Charge");
    expect(() => s.attack(card, "hero")).toThrow();
    s.expectHealth("p2", 30);
  });

  it("§8 Conventions the radiant face keeps the cost clause too", () => {
    const s = voidScenario({ radiantFace: true });
    expect(effectiveCost(s.state, held(s))).toBe(PRINTED);
    setCounters(s, { drawn: 30, played: 30, destroyed: 20, exiled: 15 });
    expect(effectiveCost(s.state, held(s))).toBe(5);
  });
});
