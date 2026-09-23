// A play, and a cast, from §10.5 step 1 to step 8 (SPEC §2.3, §2.4, §4.5, §6.3 Sacrifice and
// Tribute, §10.5, R17, R34, R57, R59, R65, R70, R210). Found by the polish-4 edge-case hunt, round 2
// (docs/polish/4-edge-cases.md, lenses L2 and L7); every case here failed before its fix.
//
//  - R70: a cast is a play, so it runs §10.5's steps — Gifted Program's hook, Quickstriker's and
//    /fullsend's granted Combos, its Echo repeats — and a cast-on-draw cast is whole, and the state
//    check has run (§4.5, R59), before the draw repeats (§2.4).
//  - R17: Unstable Clone Machine fires after the card resolves, and copies the face that resolved
//    even when the card itself has ceased to exist (R34, R57).
//  - R65: X is a play-time choice, so an X-cost Spell back in hand costs 0 again.
//  - R210: the zone a play names is held while its Tribute is paid, and a tributed Reborn unit
//    comes back (§6.1, §6.3 "counts as a death").

import { effectiveCost } from "@jackioh/engine";
import { describe, expect, it } from "vitest";
import { scenario } from "./_harness";

const RIGHT_HOUSE = "core-003";
const STOCKPILE = "core-005";
const VANILLA = "core-008";
const TIMMY = "core-011";
const HINDER = "core-021";
const DIVIDEND = "core-024";
const BLOOD_RIDDEN = "core-027";
const CLONE_MACHINE = "core-033";
const QUICKSTRIKER = "core-038";
const SHEEPISH = "core-041";
const RENO = "core-053";
const GIFTED = "core-064";
const ROCK = "core-066";
const FULLSEND = "core-078";
const TWINSPELL = "core-079";
const LIBRARY = [VANILLA, VANILLA, VANILLA, VANILLA, VANILLA, VANILLA, VANILLA, VANILLA, VANILLA, VANILLA];

describe("R70: a cast-on-draw card is cast through §10.5's steps, and is whole before the draw repeats", () => {
  it("R70 a cast-on-draw Spell's Echo repeat resolves before the draw repeats (§2.4, §10.5 step 6)", () => {
    // p1 has Twinspell's grant up. At p1's start of turn the draw takes #27 Blood Ridden Glowy Jelly
    // Bean, which casts itself (R70: a cast Spell takes Twinspell's Echo). Its first resolution finds
    // no card in p1's hand to make Radiant; its Echo repeat, which is part of the same cast
    // (§10.5 step 6), finds none either. Only then does the draw repeat (§2.4) and put Mr. Vanilla in
    // the hand — so Mr. Vanilla must still be non-Radiant.
    const g = scenario({
      p1: {
        hand: [TWINSPELL],
        field: [{ def: VANILLA, lane: 1 }],
        library: [BLOOD_RIDDEN, VANILLA, VANILLA],
      },
      p2: { field: [{ def: VANILLA, lane: 1 }], library: [VANILLA, VANILLA] },
    });

    g.play(TWINSPELL);
    g.endTurn(); // p1 → p2
    g.endTurn(); // p2 → p1: the start-of-turn draw casts Blood Ridden

    expect(g.state.active).toBe("p1");
    // Both resolutions ran: 5 health each (R18), and the grant was spent (R30).
    g.expectHealth("p1", 20);
    g.expectInZone(BLOOD_RIDDEN, "graveyard");
    const drawnAfter = g.hand("p1").filter((card) => card.defId === VANILLA);
    expect(drawnAfter).toHaveLength(1);
    expect(drawnAfter[0]?.radiant).toBe(false);

    // The cast is whole before the draw repeats: its cardResolved precedes the next drawn card.
    const resolvedAt = g.events.findIndex(
      (event) => event.type === "cardResolved" && event.defId === BLOOD_RIDDEN,
    );
    const nextDrawAt = g.events.findIndex(
      (event) => event.type === "drawn" && event.player === "p1" && event.defId === VANILLA,
    );
    expect(resolvedAt).toBeGreaterThanOrEqual(0);
    expect(nextDrawAt).toBeGreaterThan(resolvedAt);
  });

  it("R59 the state check runs after each cast-on-draw cast, so a hero at 0 ends the game before the draw repeats (§4.5, §2.4)", () => {
    // §4.5: the check runs after "one cast-on-draw cast". p1 is at 5 and the start-of-turn draw casts
    // Blood Ridden Glowy Jelly Bean ("you lose 5 health"): p1's hero is at 0 when that cast resolves,
    // so the game ends there, and the draw never repeats into the Mr. Vanilla beneath it.
    const g = scenario({
      active: "p2",
      turn: 8,
      p1: { health: 5, field: [{ def: VANILLA, lane: 1 }], library: [BLOOD_RIDDEN, VANILLA, VANILLA] },
      p2: { field: [{ def: VANILLA, lane: 1 }], library: [VANILLA, VANILLA] },
    });

    g.endTurn(); // p2 → p1: the draw casts Blood Ridden

    expect(g.state.result?.winner).toBe("p2");
    expect(g.hand("p1").filter((card) => card.defId === VANILLA)).toHaveLength(0);
    expect(g.pile("p1", "library")).toHaveLength(2);
  });

  it("R70 Quickstriker's X is the count before each cast of a cast-on-draw chain, not after the chain (§8 #38)", () => {
    // p1 has Quickstriker. At p1's start of turn the draw casts Hinder, the draw repeats and casts a
    // second Hinder, and the draw repeats again into Mr. Vanilla (§2.4, R58). Each cast is a play
    // (R70), and §8 #38's X is "cards you played earlier this turn" — `turnLog.cardsPlayed` before
    // THIS card: 0 for the first Hinder, 1 for the second. So p2's hero takes 1 in all, not 1 + 1.
    const g = scenario({
      active: "p2",
      turn: 8,
      p1: { backrow: [QUICKSTRIKER], field: [{ def: VANILLA, lane: 1 }], library: [HINDER, HINDER, VANILLA] },
      p2: { field: [{ def: VANILLA, lane: 1 }], library: [RENO, RENO] },
    });

    g.endTurn(); // p2 → p1: the draw chain casts both Hinders

    expect(g.state.active).toBe("p1");
    expect(g.state.players.p1.turnLog.cardsPlayed).toBe(2);
    g.expectHealth("p2", 29);
  });

  it("R70 Gifted Program makes a cast-on-draw card Radiant as it is cast (§10.5 step 3)", () => {
    // R70 names Gifted Program among the rules a cast counts for, with cost paid 0: "The first card
    // costing 1 or less you play each turn becomes Radiant as it is played" (§8 #64). p1's start-of-
    // turn draw casts Hinder, the first card p1 plays this turn, for 0 — so it resolves Radiant
    // ("2 lower") and stays Radiant in the graveyard (R78).
    const g = scenario({
      active: "p2",
      turn: 8,
      p1: { backrow: [GIFTED], field: [{ def: VANILLA, lane: 1 }], library: [HINDER, VANILLA] },
      p2: { field: [{ def: VANILLA, lane: 1 }], library: [RENO, RENO] },
    });

    g.endTurn(); // p2 → p1: the draw casts Hinder

    expect(g.state.active).toBe("p1");
    const hinder = g.card(HINDER);
    g.expectInZone(hinder, "graveyard");
    expect(hinder.radiant).toBe(true);
  });

  it("R70 /fullsend's granted \"Combo: draw 1\" also fires for a cast-on-draw card (§10.5 step 5)", () => {
    // p1 plays /fullsend (this turn "your cards gain 'Combo: draw 1'"), then Mr. Vanilla: 1 card
    // played earlier, so Mr. Vanilla's granted Combo draws — Hinder, which casts itself. The cast is
    // a play for every rule that counts or reacts to plays, Combo named first (R70), with 2 cards
    // played earlier this turn, so Hinder's granted Combo draws 1 (a Reno); then the cast-on-draw
    // draw repeats (§2.4) and brings a second Reno.
    const g = scenario({
      p1: { hand: [FULLSEND, VANILLA], library: [HINDER, RENO, RENO, RENO, RENO] },
      p2: { field: [{ def: VANILLA, lane: 1 }], library: [RENO, RENO] },
    });

    g.play(FULLSEND);
    g.play(VANILLA);

    expect(g.state.players.p1.turnLog.cardsPlayed).toBe(3);
    g.expectInZone(HINDER, "graveyard");
    expect(g.hand("p1").filter((card) => card.defId === RENO)).toHaveLength(2);
    expect(g.pile("p1", "library")).toHaveLength(2);
  });
});

describe("R17: Unstable Clone Machine copies the card after it resolves", () => {
  it("R17 Unstable Clone Machine shuffles its copies in after the played Spell resolves, not before (§10.5 step 7)", () => {
    // p1 has Unstable Clone Machine and an empty library, and plays Stockpile ("Draw 2; heal your
    // hero 2"). R17 and §10.5 step 7: the Clone Machine fires after the card resolves. So Stockpile's
    // two draws find the library empty (fatigue 1 then 2, §2.4), it heals 2, and only then do the 3
    // copies go into the library — none of them can be drawn by the Stockpile that made them.
    const g = scenario({
      p1: { hand: [STOCKPILE], backrow: [CLONE_MACHINE], library: [] },
      p2: { field: [{ def: VANILLA, lane: 1 }], library: [RENO] },
    });

    g.play(STOCKPILE);

    expect(g.hand("p1")).toHaveLength(0);
    expect(g.pile("p1", "library").map((card) => card.defId)).toEqual([STOCKPILE, STOCKPILE, STOCKPILE]);
    expect(g.state.players.p1.fatigueCount).toBe(2);
    g.expectHealth("p1", 30 - 1 - 2 + 2);
  });

  it("R57 Unstable Clone Machine copies a Radiant Tempo Timmy that Sheepish turned into a Sheep as Radiant (R34)", () => {
    const g = scenario({
      p1: {
        hand: [{ def: TIMMY, radiant: true }, VANILLA],
        backrow: [{ def: CLONE_MACHINE, lane: 1 }],
        library: [...LIBRARY],
      },
      p2: { hand: [VANILLA], backrow: [{ def: SHEEPISH, lane: 1 }], library: [...LIBRARY] },
    });
    const timmy = g.card(TIMMY);
    g.play(TIMMY, { zone: 1 });
    // Sheepish answered the play first: the Timmy is gone and a Sheep Token stands in its zone.
    expect(g.events.some((e) => e.type === "transformed" && e.instanceId === timmy.id)).toBe(true);

    const copies = g.pile("p1", "library").filter((card) => card.defId === TIMMY);
    expect(copies).toHaveLength(3);
    // "Copies of it": the card played was Radiant, so its copies are (R34, R57).
    expect(copies.map((card) => card.radiant)).toEqual([true, true, true]);
  });
});

describe("R65: X is chosen for one play", () => {
  it("R65 Efficiency Dividend returned at end of turn does not keep the X it was played for (§2.3)", () => {
    const g = scenario({
      p1: { hand: [DIVIDEND, VANILLA], library: [...LIBRARY] },
      p2: { hand: [VANILLA], library: [...LIBRARY] },
    });
    const dividend = g.card(DIVIDEND);
    g.play(DIVIDEND, { x: 3, modes: ["damage"], targets: [{ pick: "hero", player: "p2" }] });
    g.endTurn();
    g.expectInZone(dividend, "hand");
    // R65: "Outside play (library, hand, GY …) an X-cost card's [printed cost] is 0".
    expect(effectiveCost(g.state, g.card(dividend))).toBe(0);
    const hand = g.view("p1").you.hand;
    const inView = Array.isArray(hand) ? hand.find((c) => c.instanceId === dividend.id) : undefined;
    expect(inView?.cost).toBe(0);
  });
});

describe("R210: the Tribute a play pays", () => {
  it("R210 a Right-house defender tributed to The Rock returns through Reborn, since a sacrifice is a death (§6.1, §6.3)", () => {
    const g = scenario({
      p1: { hand: [ROCK, VANILLA], field: [{ def: RIGHT_HOUSE, lane: 1 }], library: [...LIBRARY] },
      p2: { hand: [VANILLA], library: [...LIBRARY] },
    });
    const guard = g.card(RIGHT_HOUSE);
    g.play(ROCK, { zone: 2, tributes: [guard.id] });

    // §6.3 Sacrifice "counts as a death"; §6.1 Reborn: "first death: return at 1 health".
    g.expectInZone(guard, "field");
    expect(g.unit("p1", 1)?.id).toBe(guard.id);
    expect(g.card(guard).rebornSpent).toBe(true);
    expect(g.card(guard).summonedTurn).toBe(g.state.turn);
  });

  it("R210 The Rock tributing a radiant Right-house defender still lands in the zone it named", () => {
    const g = scenario({
      p1: {
        hand: [ROCK, VANILLA],
        field: [{ def: RIGHT_HOUSE, radiant: true, lane: 2 }],
        library: [...LIBRARY],
      },
      p2: { hand: [VANILLA], library: [...LIBRARY] },
    });
    const guard = g.card(RIGHT_HOUSE);
    const rock = g.card(ROCK);
    // Step 1 accepts lane 1; step 2's tribute fires the radiant Death, which summons a base
    // Right-house defender per R64 — and lane 1 is held for The Rock, so the summon takes lane 3.
    g.play(ROCK, { zone: 1, tributes: [guard.id] });

    // §3.2 / §10.5 step 4: the played card is on the field where the player put it, never in no
    // zone at all, and the Death's base Right-house defender is on the field beside it.
    g.expectInZone(rock, "field");
    expect(g.unit("p1", 1)?.id).toBe(rock.id);
    const units = g.state.players.p1.units.flatMap((pile) => pile ?? []);
    expect(units.some((card) => card.defId === RIGHT_HOUSE && card.id !== guard.id)).toBe(true);
  });
});
