// Who killed a unit, what My Pawn projects, and the AI turn My Pawn hands over (SPEC §4.2 step 4,
// §4.3, §5.1, §10.3, R42, R44, R89, R152, R176). Found by the polish-4 edge-case hunt
// (docs/polish/4-edge-cases.md, lenses L5 and L7); every case here failed before its fix.
//
//  - R42, R89: a destroy effect is no damage instance, so an earlier non-lethal hit is not the kill.
//  - R176: My Pawn's lethal projection follows the combat — an attacker a First Strike defender
//    kills first lands nothing, and Trample excess from the attack's Cleave hits counts.
//  - §5.1: My Pawn fires once, even while its own AI turn is still being played out.
//  - R44, R152: the AI plays out the rest of the turn My Pawn took, not the player's next turn.
//  - §10.3: the AI turn's events are dispatched once, not again by the enclosing action.

import { describe, expect, it } from "vitest";
import type { CardInstance } from "@jackioh/engine";
import type { GameEvent, Selection } from "@jackioh/shared";
import { scenario, type Scenario } from "./_harness";

const TIMMY = "core-011";
const RIGHT_HOUSE = "core-003";
const SCARAB = "core-007";
const GARY = "core-004";
const BIG_D = "core-001";
const STOCKPILE = "core-005";
const VANILLA = "core-008";
const HIT_JOB = "core-016";
const MENACE = "core-019";
const POINTMASTER = "core-020";
const SEVEN_SEVEN = "core-025";
const GIGA = "core-029";
const PANTHER = "core-032";
const CLONE_MACHINE = "core-033";
const DUELIST = "core-045";
const RENO = "core-053";
const SORCERER = "core-068";
const MY_PAWN = "core-096";

function count(s: Scenario, type: GameEvent["type"]): number {
  return s.events.filter((event) => event.type === type).length;
}

function aim(card: CardInstance): Selection[] {
  return [{ pick: "instance", instanceId: card.id }];
}

describe("R42 and R89: the unit whose damage instance was lethal", () => {
  it("R42 a unit Prem Panther damaged earlier and a Hit Job later destroyed was not destroyed by the Panther", () => {
    const s = scenario({
      seed: "hunt-cw-panther-stale",
      p1: { field: [PANTHER], hand: [HIT_JOB, STOCKPILE], library: [TIMMY, TIMMY, TIMMY] },
      p2: { field: [BIG_D] },
    });
    const dfender = s.card(BIG_D);

    // 5 damage on a 0/8: it survives, and it deals nothing back.
    s.attack(PANTHER, dfender);
    s.expectStats(dfender, { health: 3 });
    const handBefore = s.hand("p1").length;

    // Hit Job destroys it: no damage instance at all, so no killer and no draw.
    s.play(HIT_JOB, { targets: aim(dfender) });

    s.expectInZone(dfender, "graveyard");
    const destroyed = s.lastEvents.find((event) => event.type === "destroyed" && event.instanceId === dfender.id);
    expect(destroyed).toMatchObject({ killerId: null });
    expect(s.hand("p1")).toHaveLength(handBefore - 1);
  });
});

describe("R176: My Pawn's projection follows the combat", () => {
  it("R176 an attacker a First Strike defender kills first never lands its Trample hit, so it is not lethal (§4.3, R93)", () => {
    // p1's Twisted Sorcerer (5/5) with Trample swings at p2's Pointmaster (7/2, First Strike) with
    // p2 at 3. Pointmaster strikes first for 7 and the Sorcerer deals nothing.
    const s = scenario({
      seed: "hunt-cw-pawn-first-strike",
      p1: { field: [SORCERER], hand: [STOCKPILE], library: [TIMMY, TIMMY] },
      p2: { health: 3, field: [POINTMASTER], backrow: [{ def: MY_PAWN, faceUp: false }], library: [GIGA, GIGA] },
    });
    s.card(SORCERER).grantedKeywords = [{ kind: "Trample" }];
    const sorcerer = s.card(SORCERER);
    const pointmaster = s.card(POINTMASTER);

    s.attack(sorcerer, pointmaster);

    expect(s.events.filter((event) => event.type === "attackCancelled")).toHaveLength(0);
    s.expectInZone(sorcerer, "graveyard");
    s.expectStats(pointmaster, { health: 2 });
    s.expectHealth("p2", 3);
    s.expectInZone(MY_PAWN, "field");
  });

  it("R176 Trample excess from the attack's Cleave hits counts toward lethal (R63, §4.4 step 10)", () => {
    // p1's radiant Prem Panther (10 attack, Cleave) with Trample attacks p2's Right-house defender
    // (Taunt, Divine Shield) between two 1/1s. The shield stops the hit on the defender, but Cleave
    // hits each 1/1 for 10 and Trample sends 9 + 9 = 18 to p2's hero at 18: My Pawn cancels it.
    const s = scenario({
      seed: "hunt-cw-pawn-cleave",
      p1: { field: [{ def: PANTHER, radiant: true }], hand: [STOCKPILE], library: [TIMMY, TIMMY] },
      p2: {
        health: 18,
        field: [SCARAB, RIGHT_HOUSE, GARY],
        backrow: [{ def: MY_PAWN, faceUp: false }],
        hand: [STOCKPILE],
        library: [GIGA, GIGA],
      },
    });
    const panther = s.card(PANTHER);
    panther.grantedKeywords = [{ kind: "Trample" }];

    s.attack(panther, RIGHT_HOUSE);

    expect(s.events.filter((event) => event.type === "attackCancelled" && event.attackerId === panther.id)).toHaveLength(1);
    expect(s.state.result).toBeNull();
  });

  it("R176 one hit short of lethal through Cleave is not lethal, so the attack goes through", () => {
    // The same board with p2 at 19: 18 through Trample is not enough, so My Pawn stays armed.
    const s = scenario({
      seed: "hunt-cw-pawn-cleave",
      p1: { field: [{ def: PANTHER, radiant: true }], hand: [STOCKPILE], library: [TIMMY, TIMMY] },
      p2: {
        health: 19,
        field: [SCARAB, RIGHT_HOUSE, GARY],
        backrow: [{ def: MY_PAWN, faceUp: false }],
        hand: [STOCKPILE],
        library: [GIGA, GIGA],
      },
    });
    const panther = s.card(PANTHER);
    panther.grantedKeywords = [{ kind: "Trample" }];

    s.attack(panther, RIGHT_HOUSE);

    expect(count(s, "attackCancelled")).toBe(0);
    s.expectHealth("p2", 1);
    s.expectInZone(MY_PAWN, "field");
  });
});

describe("§5.1, R44, R152: My Pawn and the AI turn it hands over", () => {
  it("§5.1 My Pawn fires once: it cannot fire again on an attack its own AI turn declares", () => {
    // My Pawn cancels p1's lethal Sorcerer and hands p1's turn to the AI. p1's Deft Duelist, which
    // has already switched, can still attack the hero for 4, which is lethal at 4 — and a Trap that
    // has fired is spent (§5.1), so nothing cancels it.
    const s = scenario({
      seed: "hunt-cw-pawn-twice-a",
      p1: { field: [SORCERER, DUELIST], library: [GIGA, GIGA] },
      p2: { health: 4, backrow: [{ def: MY_PAWN, faceUp: false }], library: [GIGA, GIGA] },
    });
    s.card(DUELIST).exertion.switched = true;

    s.attack(SORCERER, "hero");

    expect(count(s, "trapFired")).toBe(1);
    // The Duelist's swing ends the game inside the AI turn, and nothing happens after that (R216):
    // the trap that fired once is not consumed afterwards, so it is still in the backrow, face-up.
    expect(s.state.result).toEqual({ winner: "p1", reason: "hero-death" });
    const toGraveyard = s.events.filter((event) => event.type === "enteredGraveyard" && event.defId === MY_PAWN);
    expect(toGraveyard).toHaveLength(0);
    expect(s.backrow("p2", 1)).toMatchObject({ defId: MY_PAWN, faceUp: true });
  });

  it("R152 the AI plays out only the rest of the turn My Pawn took, not the player's next turn (R44, R82)", () => {
    // My Pawn cancels p1's lethal swing on turn 9 and the AI ends p1's turn. p2 has nothing it can
    // do, so R82 auto-ends turn 10 inside that same reduction and p1's turn 11 begins — p1's own.
    const s = scenario({
      seed: "hunt-cw-pawn-next-turn",
      p1: { field: [SORCERER], library: [GIGA, GIGA, GIGA] },
      p2: { health: 5, backrow: [{ def: MY_PAWN, faceUp: false }], library: [GIGA, GIGA] },
    });
    const sorcerer = s.card(SORCERER);

    s.attack(sorcerer, "hero");

    expect(s.state.result).toBeNull();
    expect(s.state.turn).toBe(11);
    expect(s.state.active).toBe("p1");
    expect(s.state.players.p1.aiTurn).toBe(false);
    expect(s.card(sorcerer).exertion).toEqual({ attacked: false, switched: false });
  });

  it("§10.3 an event the AI turn emitted is dispatched once: Prem Panther draws 2 per kill, not 4 (R42)", () => {
    // On this seed the AI sends p1's Prem Panther into p2's 1/1 Scarab and kills it.
    const s = scenario({
      seed: "hunt-cw-redispatch-d",
      p1: { field: [MENACE, PANTHER], library: [GIGA, GIGA, GIGA, GIGA, GIGA, GIGA] },
      p2: {
        health: 9,
        field: [SCARAB],
        backrow: [{ def: MY_PAWN, faceUp: false }],
        hand: [STOCKPILE],
        library: [GIGA, GIGA],
      },
    });
    const panther = s.card(PANTHER);

    s.attack(MENACE, "hero");

    const kills = s.events.filter((event) => event.type === "destroyed" && event.killerId === panther.id).length;
    const draws = s.events.filter((event) => event.type === "drawn" && event.player === "p1").length;
    // The seed's AI does make the kill; without it this test proves nothing.
    expect(kills).toBe(1);
    expect(draws).toBe(2);
    expect(s.hand("p1")).toHaveLength(2);
  });

  it("§10.3 an AI turn's play reaches Unstable Clone Machine once: three copies, not six (§8 #33)", () => {
    // p1 swings lethal; p2's My Pawn cancels and the AI plays out p1's turn, playing its one hand
    // card, Mr. Vanilla, with p1's Unstable Clone Machine out.
    const s = scenario({
      seed: "pawn-dispatch",
      p1: {
        hand: [VANILLA],
        field: [{ def: POINTMASTER, lane: 1 }],
        backrow: [{ def: CLONE_MACHINE, lane: 1 }],
        library: [RENO, RENO, RENO, RENO, RENO, RENO],
      },
      p2: {
        hand: [RENO, RENO],
        health: 5,
        backrow: [{ def: MY_PAWN, lane: 2 }],
        field: [{ def: SEVEN_SEVEN, lane: 3 }],
        library: [RENO, RENO, RENO, RENO, RENO, RENO],
      },
    });

    s.attack(POINTMASTER, "hero");

    expect(s.events.filter((event) => event.type === "cardPlayed" && event.defId === VANILLA)).toHaveLength(1);
    s.expectHealth("p2", 5);
    expect(s.pile("p1", "library").filter((card) => card.defId === VANILLA)).toHaveLength(3);
  });
});
