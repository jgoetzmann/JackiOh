// #85 Unlicensed Experimentation — SPEC §8.4 row 85 ("When the opponent plays a permanent whose
// type matches one you control: Fuse it onto a random permanent of yours of that type" / radiant
// "Onto every such permanent"), BUILD M4-T4 row 85.
//
// Every test puts the trap face-down in p1's backrow lane 3 and makes p2 the active player: a Trap
// answers the OPPONENT's action and resolves to completion before that action continues (§10.3).
//
// The two halves of the card, and the ruling that splits them:
//
//   R99  A condition that must leave the trap ARMED belongs in the trigger's `when`, never in `run`
//        — R61 makes an empty effect list from `run` mean "fired, consumed, did nothing". So the
//        "arming" tests below are the real test of R99: each one is an event this trap must ignore,
//        and after it the trap is still on the field and still face-down.
//   R61  What fires it: the opponent playing or casting a permanent from hand whose type matches
//        one they control. Field Trap counts as Trap; the firing trap is neither matched nor fused
//        onto; an Immutable permanent of yours IS "one you control" (so the trap fires) but is
//        never the Fuse target (R23) — which is the "fires, is consumed, does nothing, and the
//        played permanent stays" case.
//   R17  It fires AFTER the played permanent's Cry, unlike #41 Sheepish, which fires before it.
//   R77/R102  What the Fuse composes: summed stats, united keywords, cost capped at FUSE_COST_CAP
//        4, the target instance kept with its damage and position, the other ingredient ceasing to
//        exist (R86's `{ z: "gone" }`) with no Death trigger and no destroyed counter.
//
// The ingredients are placed by `field`/played from `hand` and chosen so no Cry muddies the board:
//   #11 Tempo Timmy   1, 3/3, Rush + First Strike, no Cry
//   #25 4-mana 7/7    4, 7/7, Armor 7, no Cry
//   #15 Me and Mr Tok 1, 1/1, Cry: summon a Rush Token — the R17 timing probe
//   #8  Mr. Vanilla   1, 3/3, Immutable, no Cry

import { describe, expect, it } from "vitest";
import type { CardInstance } from "@jackioh/engine";
import type { GameEvent } from "@jackioh/shared";
import { scenario, type Scenario } from "./_harness";

const TRAP = "core-085"; // Trap, 1, Legendary
const TIMMY = "core-011"; // Unit, 1 — 3/3 Rush, First Strike
const BIG_UNIT = "core-025"; // Unit, 4 — 7/7 Armor 7
const MR_TOKEN = "core-015"; // Unit, 1 — 1/1, Cry: summon a Rush Token
const MR_VANILLA = "core-008"; // Unit, 1 — 3/3 Immutable
const RUSH_TOKEN = "core-t-rush"; // the unit-token CARD, playable from a hand (§5, #75)
const STOCKPILE = "core-005"; // Spell, 1
const CALL_TO_ARMS = "core-069"; // Spell, 2 — "Recruit 3 Units costing 1 or less"
const MY_PAWN = "core-096"; // Trap, 1
const INTERN = "core-071"; // Field Trap, 1
const MENACE = "core-019";

/** The trap as it sits in play: face-down in lane 3, so lanes 1 and 2 are free for the board. */
function armed(radiant = false): { def: string; radiant?: boolean; lane: number } {
  return { def: TRAP, ...(radiant ? { radiant: true } : {}), lane: 3 };
}

function countOf(s: Scenario, type: GameEvent["type"]): number {
  return s.events.filter((event) => event.type === type).length;
}

/** A trap that declined the event is still there and still hidden (§5.1, R33). */
function expectStillArmed(s: Scenario): void {
  expect(countOf(s, "trapFired")).toBe(0);
  const trap = s.backrow("p1", 3);
  expect(trap).not.toBeNull();
  expect(trap!.defId).toBe(TRAP);
  expect(trap!.faceUp).not.toBe(true);
}

function handOf(s: Scenario, player: "p1" | "p2"): CardInstance[] {
  return s.pile(player, "hand");
}

function firstOf(s: Scenario, player: "p1" | "p2", defId: string): CardInstance {
  const card = handOf(s, player).find((held) => held.defId === defId);
  if (card === undefined) throw new Error(`${player} has no ${defId} in hand`);
  return card;
}

function indexOfEvent(s: Scenario, match: (event: GameEvent) => boolean): number {
  return s.events.findIndex(match);
}

describe("#85 Unlicensed Experimentation — R99: the events that leave it armed", () => {
  it("R99 'the opponent plays': its own controller's play never sets it off", () => {
    const s = scenario({
      p1: { backrow: [armed()], field: [TIMMY], hand: [BIG_UNIT, STOCKPILE] },
      p2: { hand: [STOCKPILE, MENACE] },
    });

    s.play(BIG_UNIT, { zone: 2 });

    expectStillArmed(s);
    s.expectInZone(BIG_UNIT, "field");
  });

  it("R99 a Spell is not a permanent, so the opponent casting one leaves it armed", () => {
    const s = scenario({
      active: "p2",
      p1: { backrow: [armed()], field: [TIMMY] },
      p2: { hand: [STOCKPILE, MENACE], library: [MENACE, TIMMY, MENACE] },
    });

    s.play(STOCKPILE);

    expectStillArmed(s);
  });

  it("R99 a permanent whose type matches nothing you control leaves it armed", () => {
    const s = scenario({
      active: "p2",
      p1: { backrow: [armed()] }, // no Unit of p1's anywhere
      p2: { hand: [BIG_UNIT, STOCKPILE] },
    });

    s.play(BIG_UNIT, { zone: 1 });

    expectStillArmed(s);
    s.expectInZone(BIG_UNIT, "field");
  });

  it("R61 the firing trap is never its own match: a Trap play with no other Trap of yours leaves it armed", () => {
    const s = scenario({
      active: "p2",
      p1: { backrow: [armed()] }, // the only Trap p1 controls is #85 itself
      p2: { hand: [MY_PAWN, STOCKPILE] },
    });

    s.play(MY_PAWN, { zone: 1 });

    expectStillArmed(s);
    s.expectInZone(MY_PAWN, "field");
  });

  it("R61 a token card the opponent plays never sets it off", () => {
    const s = scenario({
      active: "p2",
      p1: { backrow: [armed()], field: [TIMMY] },
      p2: { hand: [RUSH_TOKEN, STOCKPILE] },
    });

    s.play(RUSH_TOKEN, { zone: 1 });

    expectStillArmed(s);
  });

  it("R61 Recruit never sets it off: the units arrive by `summoned`, and the Spell is no permanent", () => {
    const s = scenario({
      active: "p2",
      p1: { backrow: [armed()], field: [TIMMY] },
      p2: { hand: [CALL_TO_ARMS, STOCKPILE], library: [TIMMY, MR_VANILLA, TIMMY] },
    });

    s.play(CALL_TO_ARMS);

    // The Recruit really happened — units reached p2's board — and the trap still did not fire.
    expect(countOf(s, "summoned")).toBeGreaterThan(0);
    expectStillArmed(s);
  });
});

describe("#85 Unlicensed Experimentation — base, when it fires", () => {
  it("§8.4 fires on the opponent's matching permanent and fuses it onto yours (R77)", () => {
    const s = scenario({
      active: "p2",
      p1: { backrow: [armed()], field: [{ def: TIMMY, damage: 1, position: "DEF" }] },
      p2: { hand: [BIG_UNIT, STOCKPILE] },
    });
    const trap = s.backrow("p1", 3)!;
    const mine = s.unit("p1", 1)!;
    const played = firstOf(s, "p2", BIG_UNIT);

    s.play(BIG_UNIT, { zone: 1 });

    s.expectEvents("cardPlayed", "trapFired", "fused");
    s.expectInZone(trap, "graveyard");
    // R77: the target instance is kept, with its damage and its position.
    s.expectStats(mine, { attack: 10, maxHealth: 10, health: 9 });
    expect(s.card(mine).id).toBe(mine.id);
    expect(s.card(mine).position).toBe("DEF");
    // R102: the capped sum of the printed costs, min(1 + 4, 4).
    expect(s.state.transientDefs[s.card(mine).defId]?.cost).toBe(4);
    // R102/R86: the consumed ingredient ceases to exist — no graveyard, no Death, no counter.
    s.expectInZone(played, "gone");
    expect(s.pile("p2", "graveyard")).toEqual([]);
    expect(countOf(s, "destroyed")).toBe(0);
    expect(s.state.counters.destroyed).toBe(0);
  });

  it("R77 the fused keywords are the union of the ingredients'", () => {
    const s = scenario({
      active: "p2",
      p1: { backrow: [armed()], field: [TIMMY] },
      p2: { hand: [BIG_UNIT, STOCKPILE] },
    });
    const mine = s.unit("p1", 1)!;

    s.play(BIG_UNIT, { zone: 1 });

    const kinds = s.stats(mine).keywords.map((keyword) => keyword.kind);
    expect(kinds).toEqual(expect.arrayContaining(["Rush", "First Strike", "Armor"]));
    expect(s.stats(mine).armor).toBe(7); // #25's Armor 7 survived the union
  });

  it("§5.1 a Trap is consumed when it fires and goes to its owner's graveyard", () => {
    const s = scenario({
      active: "p2",
      p1: { backrow: [armed()], field: [TIMMY] },
      p2: { hand: [BIG_UNIT, STOCKPILE] },
    });
    const trap = s.backrow("p1", 3)!;

    s.play(BIG_UNIT, { zone: 1 });

    s.expectInZone(trap, "graveyard");
    expect(countOf(s, "trapFired")).toBe(1);
    expect(s.backrow("p1", 3)).toBeNull();
  });

  it("§8.4 'a random permanent of yours': the base face fuses onto exactly one of two matches", () => {
    const s = scenario({
      seed: "core-085-random-one",
      active: "p2",
      p1: { backrow: [armed()], field: [TIMMY, MR_TOKEN] },
      p2: { hand: [BIG_UNIT, STOCKPILE] },
    });

    s.play(BIG_UNIT, { zone: 1 });

    expect(countOf(s, "fused")).toBe(1);
    const timmyGrew = s.stats(s.unit("p1", 1)!).attack === 10;
    const tokenGrew = s.stats(s.unit("p1", 2)!).attack === 8;
    expect([timmyGrew, tokenGrew].filter(Boolean)).toHaveLength(1);
  });

  it("R61 Field Trap counts as Trap, and the result is promoted to Field Trap (R77)", () => {
    const s = scenario({
      active: "p2",
      // My Pawn watches `attackDeclared`, so it is a Trap of p1's that this play cannot wake.
      p1: { backrow: [{ def: MY_PAWN, lane: 1 }, armed()] },
      p2: { hand: [INTERN, STOCKPILE] },
    });
    const pawn = s.backrow("p1", 1)!;
    const played = firstOf(s, "p2", INTERN);

    s.play(INTERN, { zone: 1 });

    s.expectEvents("cardPlayed", "trapFired", "fused");
    expect(s.state.transientDefs[s.card(pawn).defId]?.type).toBe("Field Trap");
    s.expectInZone(played, "gone");
  });

  it("R23/R61 an Immutable permanent of yours fires the trap and receives nothing, and the played card stays", () => {
    const s = scenario({
      active: "p2",
      p1: { backrow: [armed()], field: [MR_VANILLA] },
      p2: { hand: [BIG_UNIT, STOCKPILE] },
    });
    const trap = s.backrow("p1", 3)!;
    const vanilla = s.unit("p1", 1)!;
    const played = firstOf(s, "p2", BIG_UNIT);

    s.play(BIG_UNIT, { zone: 1 });

    // It fired and was consumed — an Immutable permanent still counts as "one you control" (R61).
    s.expectEvents("cardPlayed", "trapFired");
    expect(countOf(s, "trapFired")).toBe(1);
    s.expectInZone(trap, "graveyard");
    // …and did nothing: no fusion, the Immutable body untouched, the played permanent still there.
    expect(countOf(s, "fused")).toBe(0);
    s.expectStats(vanilla, { attack: 3, maxHealth: 3 });
    s.expectInZone(played, "field");
  });

  it("R17 it fires after the played permanent's Cry, so the Cry has already resolved", () => {
    const s = scenario({
      active: "p2",
      p1: { backrow: [armed()], field: [TIMMY] },
      p2: { hand: [MR_TOKEN, STOCKPILE] },
    });

    s.play(MR_TOKEN, { zone: 1 });

    // #15's Cry summons a Rush Token for p2. R17 puts this trap at §10.5 step 7, after that.
    const cry = indexOfEvent(s, (event) => event.type === "summoned" && event.defId === RUSH_TOKEN);
    const fired = indexOfEvent(s, (event) => event.type === "trapFired");
    expect(cry).toBeGreaterThanOrEqual(0);
    expect(fired).toBeGreaterThanOrEqual(0);
    expect(fired).toBeGreaterThan(cry);
  });
});

describe("#85 Unlicensed Experimentation — radiant", () => {
  it("R77 'Onto every such permanent': one fusion at a time, each target keeping its own instance", () => {
    const s = scenario({
      active: "p2",
      p1: { backrow: [armed(true)], field: [TIMMY, MR_TOKEN] },
      p2: { hand: [BIG_UNIT, STOCKPILE] },
    });
    const first = s.unit("p1", 1)!;
    const second = s.unit("p1", 2)!;
    const played = firstOf(s, "p2", BIG_UNIT);

    s.play(BIG_UNIT, { zone: 1 });

    expect(countOf(s, "trapFired")).toBe(1);
    expect(countOf(s, "fused")).toBe(2);
    s.expectStats(first, { attack: 10, maxHealth: 10 }); // 3/3 + 7/7
    s.expectStats(second, { attack: 8, maxHealth: 8 }); // 1/1 + 7/7
    expect(s.card(first).id).toBe(first.id);
    expect(s.card(second).id).toBe(second.id);
    s.expectInZone(played, "gone");
  });

  it("§8 Conventions: the radiant cell restates only the targets, so a single match still works", () => {
    const s = scenario({
      active: "p2",
      p1: { backrow: [armed(true)], field: [TIMMY] },
      p2: { hand: [BIG_UNIT, STOCKPILE] },
    });
    const mine = s.unit("p1", 1)!;

    s.play(BIG_UNIT, { zone: 1 });

    expect(countOf(s, "fused")).toBe(1);
    s.expectStats(mine, { attack: 10, maxHealth: 10 });
  });

  it("R99 the radiant face declines the same events: its controller's own play leaves it armed", () => {
    const s = scenario({
      p1: { backrow: [armed(true)], field: [TIMMY], hand: [BIG_UNIT, STOCKPILE] },
      p2: { hand: [STOCKPILE, MENACE] },
    });

    s.play(BIG_UNIT, { zone: 2 });

    expectStillArmed(s);
  });

  it("R23 the radiant face skips an Immutable permanent and fuses onto the rest", () => {
    const s = scenario({
      active: "p2",
      p1: { backrow: [armed(true)], field: [MR_VANILLA, TIMMY] },
      p2: { hand: [BIG_UNIT, STOCKPILE] },
    });
    const vanilla = s.unit("p1", 1)!;
    const timmy = s.unit("p1", 2)!;

    s.play(BIG_UNIT, { zone: 1 });

    expect(countOf(s, "fused")).toBe(1);
    s.expectStats(vanilla, { attack: 3, maxHealth: 3 });
    s.expectStats(timmy, { attack: 10, maxHealth: 10 });
  });
});
