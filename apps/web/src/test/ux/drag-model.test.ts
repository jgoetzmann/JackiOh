// Polish task 7, B34 and B35 (docs/polish/7-mobile-ux.md, Surface S9): the pure drag model.
//
// `planDrag` decides what a press on the board may lift, and `resolveDrop` decides what a release
// does with it. Both only narrow the `legalActions` array they are handed, through the same
// `actions.ts` reducer click-click uses, so every expected action below is a body the engine
// listed. Nothing here renders; the DOM half is drag-layer.test.tsx.
//
// The `DragPlan`s that `resolveDrop` is tested with are written out by hand from S9's field
// definitions rather than built by `planDrag`, so a fault in one function is never reported as a
// fault in the other.

import type { ActionBody, PlayerView } from "@jackioh/shared";
import { describe, expect, it } from "vitest";

import { IDLE, onClickTarget, pickInPlay, type Interaction } from "../../game/actions.ts";
import type { ClickTarget } from "../../game/contract.ts";
import { planDrag, resolveDrop, type DragPlan, type DropSpot } from "../../game/drag/model.ts";
import { baseView, card, emptySide, unit } from "../fixtures.ts";

// ---------------------------------------------------------------------------------------------
// The board and what the engine allows on it.
// ---------------------------------------------------------------------------------------------

/**
 * Your hand holds one card of every shape a drag has to handle: a unit with two zones (h1), a card
 * with exactly one zone (z1), a one-candidate spell (s1), a targeted spell (t1), an X spell (x1), a
 * unit whose Cry also takes a target (c1), a spell that targets a card in your own hand (j1) and a
 * card nothing lets you play (n1). Your field: u1 can attack e1 or the hero, u2 can only switch
 * position, u3 can attack e2.
 */
function view(): PlayerView {
  return baseView({
    you: emptySide("p1", {
      hand: [
        card({ instanceId: "h1", defId: "core-008" }),
        card({ instanceId: "z1", defId: "core-073" }),
        card({ instanceId: "s1", defId: "core-005" }),
        card({ instanceId: "t1", defId: "core-013" }),
        card({ instanceId: "x1", defId: "core-043" }),
        card({ instanceId: "c1", defId: "core-068" }),
        card({ instanceId: "j1", defId: "core-028" }),
        card({ instanceId: "n1", defId: "core-019" }),
      ],
      units: [
        unit("p1", { instanceId: "u1" }),
        unit("p1", { instanceId: "u2" }),
        unit("p1", { instanceId: "u3" }),
        null,
        null,
      ],
    }),
    opponent: emptySide("p2", {
      hand: { count: 3 },
      units: [unit("p2", { instanceId: "e1" }), unit("p2", { instanceId: "e2" }), null, null, null],
    }),
  });
}

const H1_LANE4: ActionBody = { type: "play", instanceId: "h1", zone: { row: "units", lane: 4 } };
const H1_LANE5: ActionBody = { type: "play", instanceId: "h1", zone: { row: "units", lane: 5 } };
const Z1_BACKROW2: ActionBody = { type: "play", instanceId: "z1", zone: { row: "backrow", lane: 2 } };
const S1: ActionBody = { type: "play", instanceId: "s1" };
const T1_E1: ActionBody = { type: "play", instanceId: "t1", targets: [{ pick: "instance", instanceId: "e1" }] };
const T1_HERO: ActionBody = { type: "play", instanceId: "t1", targets: [{ pick: "hero", player: "p2" }] };
const X1_1: ActionBody = { type: "play", instanceId: "x1", x: 1 };
const X1_2: ActionBody = { type: "play", instanceId: "x1", x: 2 };
const C1_E1: ActionBody = {
  type: "play",
  instanceId: "c1",
  zone: { row: "units", lane: 4 },
  targets: [{ pick: "instance", instanceId: "e1" }],
};
const C1_HERO: ActionBody = {
  type: "play",
  instanceId: "c1",
  zone: { row: "units", lane: 4 },
  targets: [{ pick: "hero", player: "p2" }],
};
const J1_S1: ActionBody = { type: "play", instanceId: "j1", targets: [{ pick: "instance", instanceId: "s1" }] };
const J1_H1: ActionBody = { type: "play", instanceId: "j1", targets: [{ pick: "instance", instanceId: "h1" }] };
const U1_E1: ActionBody = { type: "attack", attackerId: "u1", targetId: "e1" };
const U1_HERO: ActionBody = { type: "attack", attackerId: "u1", targetId: "hero-p2" };
const U3_E2: ActionBody = { type: "attack", attackerId: "u3", targetId: "e2" };
const U2_SWITCH: ActionBody = { type: "switchPosition", instanceId: "u2" };

const LEGAL: readonly ActionBody[] = [
  H1_LANE4,
  H1_LANE5,
  Z1_BACKROW2,
  S1,
  T1_E1,
  T1_HERO,
  X1_1,
  X1_2,
  C1_E1,
  C1_HERO,
  J1_S1,
  J1_H1,
  U1_E1,
  U1_HERO,
  U3_E2,
  U2_SWITCH,
  { type: "endTurn" },
  { type: "offerDraw" },
  { type: "concede" },
];

// ---------------------------------------------------------------------------------------------
// Click targets, drop spots and interactions.
// ---------------------------------------------------------------------------------------------

const hand = (instanceId: string): ClickTarget => ({ on: "hand", instanceId });
const yourUnit = (instanceId: string, lane: number): ClickTarget => ({ on: "unit", instanceId, side: "you", lane });
const enemyUnit = (instanceId: string, lane: number): ClickTarget => ({
  on: "unit",
  instanceId,
  side: "opponent",
  lane,
});
const yourZone = (row: "units" | "backrow", lane: number): ClickTarget => ({ on: "zone", side: "you", row, lane });
const ENEMY_HERO: ClickTarget = { on: "hero", side: "opponent" };

const at = (target: ClickTarget, testid: string): DropSpot => ({ at: "target", target, testid });
const BOARD: DropSpot = { at: "board" };
const OUTSIDE: DropSpot = { at: "outside" };

/** What a lift holds per S9: every candidate for the card, nothing picked, nothing settled. */
function lifting(instanceId: string, candidates: ActionBody[]): Extract<Interaction, { stage: "playing" }> {
  return { stage: "playing", instanceId, candidates, picked: {} };
}

function attackingWith(attackerId: string, candidates: ActionBody[]): Extract<Interaction, { stage: "attacking" }> {
  return { stage: "attacking", attackerId, candidates };
}

/** The interaction click-click leaves behind after a click on a hand card or a unit. */
function clicked(target: ClickTarget, from: Interaction = IDLE): Interaction {
  return onClickTarget(view(), LEGAL, from, target).interaction;
}

function plan(fields: Omit<DragPlan, "dropTestids"> & { dropTestids: readonly string[] }): DragPlan {
  return { ...fields, dropTestids: new Set(fields.dropTestids) };
}

function sorted(set: ReadonlySet<string>): string[] {
  return [...set].sort();
}

/** A lift or a drop that changes nothing: back to idle, with no action. */
function expectIdle(result: { interaction: Interaction; action?: ActionBody }): void {
  expect(result.interaction).toEqual({ stage: "idle" });
  expect(result.action).toBeUndefined();
}

// ---------------------------------------------------------------------------------------------
// B34: planDrag
// ---------------------------------------------------------------------------------------------

describe("B34 planDrag lifts what a play or an attack names", () => {
  it("B34 a hand card with two zones gives a play plan holding both candidates, unsettled, dropped only on its zones", () => {
    const got = planDrag(view(), LEGAL, IDLE, hand("h1"));

    expect(got).not.toBeNull();
    if (got === null) return;
    expect(got.kind).toBe("play");
    expect(got.source).toEqual({ on: "hand", instanceId: "h1" });
    expect(got.sourceTestid).toBe("hand-card-h1");
    expect(got.lifted).toEqual(lifting("h1", [H1_LANE4, H1_LANE5]));
    expect(sorted(got.dropTestids)).toEqual(["zone-you-units-4", "zone-you-units-5"]);
    // Two zones are still open, so a drop has to name one of them.
    expect(got.freeDrop).toBe(false);
    // Some candidate has a zone: a card ghost, not an arrow.
    expect(got.arrow).toBe(false);
  });

  it("B34 lifting a one-candidate spell sends nothing: the lift stays in the playing stage and may drop anywhere on the board", () => {
    const got = planDrag(view(), LEGAL, IDLE, hand("s1"));

    expect(got).not.toBeNull();
    if (got === null) return;
    expect(got.kind).toBe("play");
    // Not `{ interaction: IDLE, action }`: click-click would have sent this spell on the first
    // click, but a lift must not.
    expect(got.lifted).toEqual(lifting("s1", [S1]));
    expect(got.dropTestids.size).toBe(0);
    expect(got.freeDrop).toBe(true);
    expect(got.arrow).toBe(false);
  });

  it("B34 a card with exactly one zone lifts unsettled, glows its zone, and may drop anywhere on the board", () => {
    const got = planDrag(view(), LEGAL, IDLE, hand("z1"));

    expect(got).not.toBeNull();
    if (got === null) return;
    expect(got.lifted).toEqual(lifting("z1", [Z1_BACKROW2]));
    expect(sorted(got.dropTestids)).toEqual(["zone-you-backrow-2"]);
    // outstandingNeed(lifted) is null: nothing is left to choose.
    expect(got.freeDrop).toBe(true);
    expect(got.arrow).toBe(false);
  });

  it("B34 a targeted spell with no zone draws the arrow and drops only on its targets", () => {
    const got = planDrag(view(), LEGAL, IDLE, hand("t1"));

    expect(got).not.toBeNull();
    if (got === null) return;
    expect(got.kind).toBe("play");
    expect(got.lifted).toEqual(lifting("t1", [T1_E1, T1_HERO]));
    expect(sorted(got.dropTestids)).toEqual(["card-e1", "hero-opponent"]);
    expect(got.freeDrop).toBe(false);
    expect(got.arrow).toBe(true);
  });

  it("B34 a unit whose Cry also takes a target keeps the card ghost, because a candidate has a zone", () => {
    const got = planDrag(view(), LEGAL, IDLE, hand("c1"));

    expect(got).not.toBeNull();
    if (got === null) return;
    expect(got.lifted).toEqual(lifting("c1", [C1_E1, C1_HERO]));
    expect(sorted(got.dropTestids)).toEqual(["card-e1", "hero-opponent", "zone-you-units-4"]);
    expect(got.freeDrop).toBe(false);
    expect(got.arrow).toBe(false);
  });

  it("B34 an X spell with nothing on the board to point at may drop anywhere on the board", () => {
    const got = planDrag(view(), LEGAL, IDLE, hand("x1"));

    expect(got).not.toBeNull();
    if (got === null) return;
    expect(got.lifted).toEqual(lifting("x1", [X1_1, X1_2]));
    expect(got.dropTestids.size).toBe(0);
    expect(got.freeDrop).toBe(true);
    expect(got.arrow).toBe(false);
  });

  it("B34 a unit an attack names gives an attack plan with the arrow, dropped only on that attacker's targets", () => {
    const source = yourUnit("u1", 1);
    const got = planDrag(view(), LEGAL, IDLE, source);

    expect(got).not.toBeNull();
    if (got === null) return;
    expect(got.kind).toBe("attack");
    expect(got.source).toEqual(source);
    expect(got.sourceTestid).toBe("card-u1");
    expect(got.lifted).toEqual(attackingWith("u1", [U1_E1, U1_HERO]));
    expect(sorted(got.dropTestids)).toEqual(["card-e1", "hero-opponent"]);
    expect(got.arrow).toBe(true);
    expect(got.freeDrop).toBe(false);
  });

  it("B34 a hand card still gives a play plan while an attack is being declared", () => {
    const got = planDrag(view(), LEGAL, clicked(yourUnit("u1", 1)), hand("h1"));

    expect(got).not.toBeNull();
    expect(got?.kind).toBe("play");
    expect(got?.lifted).toEqual(lifting("h1", [H1_LANE4, H1_LANE5]));
  });

  it("B34 a hand card still gives a fresh play plan while another card is being played", () => {
    const inFlight = clicked(hand("t1"));
    expect(inFlight.stage).toBe("playing");

    const got = planDrag(view(), LEGAL, inFlight, hand("h1"));

    expect(got).not.toBeNull();
    expect(got?.kind).toBe("play");
    expect(got?.lifted).toEqual(lifting("h1", [H1_LANE4, H1_LANE5]));
  });

  it("B34 re-lifting the card already in flight gives a fresh lift with nothing picked", () => {
    // c1 narrowed to its zone by a click, still waiting on its Cry target.
    const narrowed = clicked(yourZone("units", 4), clicked(hand("c1")));
    expect(narrowed.stage).toBe("playing");

    const got = planDrag(view(), LEGAL, narrowed, hand("c1"));

    expect(got).not.toBeNull();
    expect(got?.lifted).toEqual(lifting("c1", [C1_E1, C1_HERO]));
  });

  it("B34 another attacker gives its own attack plan while an attack is being declared", () => {
    const got = planDrag(view(), LEGAL, clicked(yourUnit("u1", 1)), yourUnit("u3", 3));

    expect(got).not.toBeNull();
    if (got === null) return;
    expect(got.kind).toBe("attack");
    expect(got.lifted).toEqual(attackingWith("u3", [U3_E2]));
    expect(sorted(got.dropTestids)).toEqual(["card-e2"]);
  });

  // --- null: nothing to lift -------------------------------------------------------------------

  it("B34 a hand card no play names gives null", () => {
    expect(planDrag(view(), LEGAL, IDLE, hand("n1"))).toBeNull();
  });

  it("B34 with nothing legal, a hand card gives null", () => {
    expect(planDrag(view(), [], IDLE, hand("h1"))).toBeNull();
  });

  it("B34 a card declared as a target of the play in flight gives null, so its press stays a click", () => {
    // j1 targets a card in your own hand (R81): s1 or h1. Both have plays of their own.
    const inFlight = clicked(hand("j1"));
    expect(inFlight.stage).toBe("playing");

    expect(planDrag(view(), LEGAL, inFlight, hand("s1"))).toBeNull();
    expect(planDrag(view(), LEGAL, inFlight, hand("h1"))).toBeNull();
    // A card that is not one of j1's targets can still be lifted instead.
    expect(planDrag(view(), LEGAL, inFlight, hand("z1"))).not.toBeNull();
  });

  it("B34 an attacker gives null while a card is being played", () => {
    const inFlight = clicked(hand("h1"));
    expect(inFlight.stage).toBe("playing");

    expect(planDrag(view(), LEGAL, inFlight, yourUnit("u1", 1))).toBeNull();
  });

  it("B34 a unit whose only action is switchPosition gives null", () => {
    expect(planDrag(view(), LEGAL, IDLE, yourUnit("u2", 2))).toBeNull();
  });

  it("B34 an enemy unit gives null even if an attack were to name it", () => {
    const legal: ActionBody[] = [...LEGAL, { type: "attack", attackerId: "e1", targetId: "u1" }];

    expect(planDrag(view(), legal, IDLE, enemyUnit("e1", 1))).toBeNull();
  });

  it.each<[string, ClickTarget]>([
    ["a backrow card", { on: "backrow", instanceId: "b1", side: "you", lane: 1 }],
    ["your hero", { on: "hero", side: "you" }],
    ["the enemy hero", ENEMY_HERO],
    ["an empty zone", yourZone("units", 4)],
    ["a switch button", { on: "switch", instanceId: "u2" }],
  ])("B34 %s is never a drag source", (_label, source) => {
    expect(planDrag(view(), LEGAL, IDLE, source)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// B35: resolveDrop
// ---------------------------------------------------------------------------------------------

const PLAN_H1 = plan({
  kind: "play",
  source: { on: "hand", instanceId: "h1" },
  sourceTestid: "hand-card-h1",
  lifted: lifting("h1", [H1_LANE4, H1_LANE5]),
  dropTestids: ["zone-you-units-4", "zone-you-units-5"],
  freeDrop: false,
  arrow: false,
});

const PLAN_Z1 = plan({
  kind: "play",
  source: { on: "hand", instanceId: "z1" },
  sourceTestid: "hand-card-z1",
  lifted: lifting("z1", [Z1_BACKROW2]),
  dropTestids: ["zone-you-backrow-2"],
  freeDrop: true,
  arrow: false,
});

const PLAN_S1 = plan({
  kind: "play",
  source: { on: "hand", instanceId: "s1" },
  sourceTestid: "hand-card-s1",
  lifted: lifting("s1", [S1]),
  dropTestids: [],
  freeDrop: true,
  arrow: false,
});

const PLAN_T1 = plan({
  kind: "play",
  source: { on: "hand", instanceId: "t1" },
  sourceTestid: "hand-card-t1",
  lifted: lifting("t1", [T1_E1, T1_HERO]),
  dropTestids: ["card-e1", "hero-opponent"],
  freeDrop: false,
  arrow: true,
});

const PLAN_X1 = plan({
  kind: "play",
  source: { on: "hand", instanceId: "x1" },
  sourceTestid: "hand-card-x1",
  lifted: lifting("x1", [X1_1, X1_2]),
  dropTestids: [],
  freeDrop: true,
  arrow: false,
});

const PLAN_C1 = plan({
  kind: "play",
  source: { on: "hand", instanceId: "c1" },
  sourceTestid: "hand-card-c1",
  lifted: lifting("c1", [C1_E1, C1_HERO]),
  dropTestids: ["zone-you-units-4", "card-e1", "hero-opponent"],
  freeDrop: false,
  arrow: false,
});

const PLAN_U1 = plan({
  kind: "attack",
  source: { on: "unit", instanceId: "u1", side: "you", lane: 1 },
  sourceTestid: "card-u1",
  lifted: attackingWith("u1", [U1_E1, U1_HERO]),
  dropTestids: ["card-e1", "hero-opponent"],
  freeDrop: false,
  arrow: true,
});

describe("B35 resolveDrop acts only on a drop the plan allows", () => {
  it("B35 a drop on a glowing zone returns what a click on that zone returns: the play into it", () => {
    const spot = at(yourZone("units", 5), "zone-you-units-5");

    const got = resolveDrop(view(), LEGAL, PLAN_H1, spot);

    expect(got).toEqual(onClickTarget(view(), LEGAL, PLAN_H1.lifted, yourZone("units", 5)));
    expect(got.interaction).toEqual({ stage: "idle" });
    expect(got.action).toEqual(H1_LANE5);
  });

  it("B35 an attacker dropped on the glowing enemy hero sends the attack on the hero", () => {
    const got = resolveDrop(view(), LEGAL, PLAN_U1, at(ENEMY_HERO, "hero-opponent"));

    expect(got).toEqual(onClickTarget(view(), LEGAL, PLAN_U1.lifted, ENEMY_HERO));
    expect(got.interaction).toEqual({ stage: "idle" });
    expect(got.action).toEqual(U1_HERO);
  });

  it("B35 an attacker dropped on a glowing enemy unit sends the attack on that unit", () => {
    const got = resolveDrop(view(), LEGAL, PLAN_U1, at(enemyUnit("e1", 1), "card-e1"));

    expect(got.interaction).toEqual({ stage: "idle" });
    expect(got.action).toEqual(U1_E1);
  });

  it("B35 a targeted spell dropped on one of its targets is played at it", () => {
    const got = resolveDrop(view(), LEGAL, PLAN_T1, at(enemyUnit("e1", 1), "card-e1"));

    expect(got).toEqual(onClickTarget(view(), LEGAL, PLAN_T1.lifted, enemyUnit("e1", 1)));
    expect(got.interaction).toEqual({ stage: "idle" });
    expect(got.action).toEqual(T1_E1);
  });

  it("B35 a drop that narrows the play without finishing it returns the narrowed interaction and sends nothing", () => {
    const got = resolveDrop(view(), LEGAL, PLAN_C1, at(yourZone("units", 4), "zone-you-units-4"));

    expect(got).toEqual(onClickTarget(view(), LEGAL, PLAN_C1.lifted, yourZone("units", 4)));
    expect(got.action).toBeUndefined();
    expect(got.interaction.stage).toBe("playing");
    if (got.interaction.stage !== "playing") return;
    expect(got.interaction.instanceId).toBe("c1");
    expect(got.interaction.picked.zone).toEqual({ row: "units", lane: 4 });
  });

  it("B35 a board drop with freeDrop plays a one-candidate spell, as pickInPlay(lifted, {}) does", () => {
    const got = resolveDrop(view(), LEGAL, PLAN_S1, BOARD);

    expect(got).toEqual(pickInPlay(PLAN_S1.lifted, {}));
    expect(got.interaction).toEqual({ stage: "idle" });
    expect(got.action).toEqual(S1);
  });

  it("B35 a board drop with freeDrop plays a one-zone card into its only zone", () => {
    const got = resolveDrop(view(), LEGAL, PLAN_Z1, BOARD);

    expect(got.interaction).toEqual({ stage: "idle" });
    expect(got.action).toEqual(Z1_BACKROW2);
  });

  it("B35 a board drop with freeDrop that still needs a picker returns the play in flight and sends nothing yet", () => {
    const got = resolveDrop(view(), LEGAL, PLAN_X1, BOARD);

    expect(got).toEqual(pickInPlay(PLAN_X1.lifted, {}));
    expect(got.action).toBeUndefined();
    expect(got.interaction.stage).toBe("playing");
    if (got.interaction.stage !== "playing") return;
    expect(got.interaction.instanceId).toBe("x1");
  });

  // --- anything else: idle, nothing sent -------------------------------------------------------

  it("B35 a drop spot in the set whose click changes nothing returns idle and sends nothing", () => {
    // The testid is in the drop set but the target it reports matches no candidate, so
    // onClickTarget hands back plan.lifted itself with no action.
    const got = resolveDrop(view(), LEGAL, PLAN_U1, at({ on: "hero", side: "you" }, "hero-opponent"));

    expectIdle(got);
  });

  it("B35 a target outside the drop set returns idle and sends nothing, even where a click there would act", () => {
    // A click on s1 while t1 is in flight would pick s1 up and, with one candidate, play it.
    expect(onClickTarget(view(), LEGAL, PLAN_T1.lifted, hand("s1")).action).toEqual(S1);

    const got = resolveDrop(view(), LEGAL, PLAN_T1, at(hand("s1"), "hand-card-s1"));

    expectIdle(got);
  });

  it("B35 an attacker dropped on a unit that is not its target returns idle", () => {
    expectIdle(resolveDrop(view(), LEGAL, PLAN_U1, at(enemyUnit("e2", 2), "card-e2")));
    expectIdle(resolveDrop(view(), LEGAL, PLAN_U1, at(yourUnit("u3", 3), "card-u3")));
  });

  it("B35 dropping a card back on itself returns idle and sends nothing", () => {
    expectIdle(resolveDrop(view(), LEGAL, PLAN_H1, at(hand("h1"), "hand-card-h1")));
    expectIdle(resolveDrop(view(), LEGAL, PLAN_U1, at(yourUnit("u1", 1), "card-u1")));
  });

  it("B35 a board drop without freeDrop cancels a card with two open zones", () => {
    expectIdle(resolveDrop(view(), LEGAL, PLAN_H1, BOARD));
  });

  it("B35 a board drop cancels a targeted spell", () => {
    expectIdle(resolveDrop(view(), LEGAL, PLAN_T1, BOARD));
  });

  it("B35 a board drop cancels an attack", () => {
    expectIdle(resolveDrop(view(), LEGAL, PLAN_U1, BOARD));
  });

  it("B35 an outside drop cancels even a card that may drop anywhere on the board", () => {
    expectIdle(resolveDrop(view(), LEGAL, PLAN_S1, OUTSIDE));
    expectIdle(resolveDrop(view(), LEGAL, PLAN_Z1, OUTSIDE));
  });

  it("B35 an outside drop cancels an attack and a play with open zones", () => {
    expectIdle(resolveDrop(view(), LEGAL, PLAN_U1, OUTSIDE));
    expectIdle(resolveDrop(view(), LEGAL, PLAN_H1, OUTSIDE));
  });
});
