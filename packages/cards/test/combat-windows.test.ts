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
//  - R220 (round 6): a declared attack resolves only while it stands as it was declared — a trap in
//    §4.2 step 4's window that destroyed, stole or moved the attacker or its target, or swapped the
//    boards, ends it, and a My Pawn later in the window has nothing to answer. No Core trap but My
//    Pawn answers a declaration, and My Pawn cancels, so the trap in the window is a fixture (a
//    transient def and its script in the registry, as paused-sequences.test.ts builds them).
//  - R176 (round 6): a defender's Lifesteal strike back heals its hero in the same combat, so a
//    Trample swing it outheals is not lethal.

import { describe, expect, it } from "vitest";
import {
  newInstance,
  placeOnField,
  registerScripts,
  registeredScripts,
  type CardInstance,
  type Script,
} from "@jackioh/engine";
import { chooseMode, destroy, steal, swapBoard } from "@jackioh/engine/effects";
import type { CardDef, CardType, GameEvent, PlayerId, Row, Selection } from "@jackioh/shared";
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
const JILLIAX = "core-056";
const WINDOW_LIBRARY = [VANILLA, VANILLA, VANILLA, VANILLA, VANILLA, VANILLA];

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

function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`expected ${what}`);
  return value;
}

/** A fixture card: a transient def in the match state and its script in the registry. */
function fixture(s: Scenario, id: string, type: CardType, script: Script): void {
  const face = { keywords: [], text: id };
  const def: CardDef = {
    id,
    index: id,
    name: id,
    set: "Core",
    type,
    tags: [],
    rarity: "Common",
    token: false,
    cost: 0,
    base: { ...face },
    radiant: { ...face },
  };
  s.state.transientDefs[id] = def;
  registerScripts({ ...registeredScripts(), [id]: { base: script, radiant: script } });
}

/** A face-down trap of `player`'s in a backrow lane (R33). */
function setTrap(s: Scenario, defId: string, player: PlayerId, lane: number): CardInstance {
  const row: Row = "backrow";
  const card = newInstance(s.state, defId, player, { z: "hand", player });
  if (!placeOnField(s.state, card, { player, row, lane })) throw new Error(`could not place ${defId}`);
  card.faceUp = false;
  return card;
}

/** "When a unit is declared as an attacker (not forced): destroy it." */
const VAPORIZE: Script = {
  triggers: [
    {
      id: "edge-r6-vaporize",
      on: ["attackDeclared"],
      when: (ctx) => ctx.event.type === "attackDeclared" && !ctx.event.forced,
      run: (ctx) =>
        ctx.event.type === "attackDeclared"
          ? [destroy({ target: { of: "instance", instanceId: ctx.event.attackerId } })]
          : [],
    },
  ],
};

/** "When a unit is declared as an attack's target (not forced): destroy it." */
const SHATTER: Script = {
  triggers: [
    {
      id: "edge-r6-shatter",
      on: ["attackDeclared"],
      when: (ctx) => ctx.event.type === "attackDeclared" && !ctx.event.forced && !ctx.event.targetId.startsWith("hero-"),
      run: (ctx) =>
        ctx.event.type === "attackDeclared"
          ? [destroy({ target: { of: "instance", instanceId: ctx.event.targetId } })]
          : [],
    },
  ],
};

/** "When a unit is declared as an attacker (not forced): take control of it." */
const TURNCOAT: Script = {
  triggers: [
    {
      id: "edge-r6-turncoat",
      on: ["attackDeclared"],
      when: (ctx) => ctx.event.type === "attackDeclared" && !ctx.event.forced,
      run: (ctx) => (ctx.event.type === "attackDeclared" ? [steal({ instanceId: ctx.event.attackerId })] : []),
    },
  ],
};

/** "When a unit is declared as an attack's target (not forced): take control of it." */
const DEFECTOR: Script = {
  triggers: [
    {
      id: "edge-r6-defector",
      on: ["attackDeclared"],
      when: (ctx) => ctx.event.type === "attackDeclared" && !ctx.event.forced && !ctx.event.targetId.startsWith("hero-"),
      run: (ctx) => (ctx.event.type === "attackDeclared" ? [steal({ instanceId: ctx.event.targetId })] : []),
    },
  ],
};

/** "When a unit is declared as an attacker: swap the boards." */
const SWAPPER: Script = {
  triggers: [
    {
      id: "edge-r6-swapper",
      on: ["attackDeclared"],
      when: (ctx) => ctx.event.type === "attackDeclared" && !ctx.event.forced,
      run: () => [swapBoard()],
    },
  ],
};

/**
 * A face-down trap in the §4.2 step-4 window that asks its controller about the opponent's declared
 * attack, and whose answer then does `then` to the attacker — so the window pauses, and step 5 is
 * owed to the answer's action (R113).
 */
function askingWindowTrap(s: Scenario, id: string, then: "steal" | "destroy"): void {
  fixture(s, id, "Trap", {
    triggers: [
      {
        id: `${id}:asks`,
        on: ["attackDeclared"],
        when: (ctx) => ctx.event.type === "attackDeclared" && !ctx.event.forced && ctx.state.active !== ctx.controller,
        run: (ctx) => [
          chooseMode({
            options: ["ok"],
            step: "answered",
            prompt: `${id}: a question`,
            data: { attackerId: ctx.event.type === "attackDeclared" ? ctx.event.attackerId : "" },
          }),
        ],
      },
    ],
    resume: {
      answered: (ctx) => {
        const attackerId = String(ctx.data.attackerId);
        return then === "steal"
          ? [steal({ instanceId: attackerId })]
          : [destroy({ target: { of: "instance", instanceId: attackerId } })];
      },
    },
  });
}

describe("R220: §4.2 step 5 resolves the attack only as it was declared", () => {
  it("R220 an attacker a trap in the window destroyed does not attack with the Reborn body that came back (R174, R83)", () => {
    const s = scenario({
      seed: "edge-r6-vaporize-reborn",
      p1: { field: [{ def: SORCERER, lane: 1 }], hand: [STOCKPILE], library: [...WINDOW_LIBRARY] },
      p2: { health: 20, hand: [STOCKPILE], library: [...WINDOW_LIBRARY] },
    });
    fixture(s, "edge-r6-vaporize", "Trap", VAPORIZE);
    setTrap(s, "edge-r6-vaporize", "p2", 1);
    const sorcerer = must(s.unit("p1", 1), "p1's Twisted Sorcerer");
    s.card(sorcerer).grantedKeywords.push({ kind: "Reborn" });

    s.attack(sorcerer, "hero");

    // The trap destroyed the declared attacker and Reborn put a new arrival in its zone (R83).
    expect(s.events.some((event) => event.type === "destroyed" && event.instanceId === sorcerer.id)).toBe(true);
    const body = must(s.unit("p1", 1), "the Reborn body");
    expect(body.id).toBe(sorcerer.id);
    // The attack was the stay that died; the body declared nothing and deals nothing.
    s.expectHealth("p2", 20);
    expect(count(s, "damage")).toBe(0);
  });

  it("R220 an attack whose target a trap in the window destroyed does not land on the target's Reborn body (R174, R83)", () => {
    const s = scenario({
      seed: "edge-r6-shatter-reborn",
      p1: { field: [{ def: SORCERER, lane: 1 }], hand: [STOCKPILE], library: [...WINDOW_LIBRARY] },
      p2: { field: [{ def: RIGHT_HOUSE, lane: 2 }], hand: [STOCKPILE], library: [...WINDOW_LIBRARY] },
    });
    fixture(s, "edge-r6-shatter", "Trap", SHATTER);
    setTrap(s, "edge-r6-shatter", "p1", 1);
    const sorcerer = must(s.unit("p1", 1), "p1's Twisted Sorcerer");
    const defender = must(s.unit("p2", 2), "p2's Right-house defender");

    s.attack(sorcerer, defender);

    expect(s.events.some((event) => event.type === "destroyed" && event.instanceId === defender.id)).toBe(true);
    const body = must(s.unit("p2", 2), "the Reborn body");
    expect(body.id).toBe(defender.id);
    // The body is a new arrival with a fresh Divine Shield; the attack that named the old stay is
    // over, so nothing strikes it and it strikes nothing back.
    expect(count(s, "divineShieldLost")).toBe(0);
    expect(s.card(sorcerer).damage).toBe(0);
    expect(s.stats(body).keywords.map((k) => k.kind)).toContain("Divine Shield");
  });

  it("R220 an attacker a trap in the window stole does not go on to hit its new controller's hero (§4.2 step 2, R173, R171)", () => {
    const s = scenario({
      seed: "edge-r6-turncoat",
      p1: { field: [{ def: SORCERER, lane: 1 }], hand: [STOCKPILE], library: [...WINDOW_LIBRARY] },
      p2: { health: 20, hand: [STOCKPILE], library: [...WINDOW_LIBRARY] },
    });
    fixture(s, "edge-r6-turncoat", "Trap", TURNCOAT);
    setTrap(s, "edge-r6-turncoat", "p2", 1);
    const sorcerer = must(s.unit("p1", 1), "p1's Twisted Sorcerer");

    s.attack(sorcerer, "hero");

    expect(s.card(sorcerer).controller).toBe("p2");
    // p2's own unit does not attack p2's hero: an attack is made on an enemy (§4.2 step 2).
    s.expectHealth("p2", 20);
  });

  it("R220 an attack whose target a trap in the window moved to the attacker's side does not hit it (§4.2 step 2, R173, R171)", () => {
    const s = scenario({
      seed: "edge-r6-defector",
      p1: { field: [{ def: SORCERER, lane: 1 }], hand: [STOCKPILE], library: [...WINDOW_LIBRARY] },
      p2: { field: [{ def: VANILLA, lane: 3 }], hand: [STOCKPILE], library: [...WINDOW_LIBRARY] },
    });
    fixture(s, "edge-r6-defector", "Trap", DEFECTOR);
    setTrap(s, "edge-r6-defector", "p1", 1);
    const sorcerer = must(s.unit("p1", 1), "p1's Twisted Sorcerer");
    const vanilla = must(s.unit("p2", 3), "p2's Mr. Vanilla");

    s.attack(sorcerer, vanilla);

    expect(s.events).toContainEqual(expect.objectContaining({ type: "controlChanged", instanceId: vanilla.id, controller: "p1" }));
    // Both are p1's now: no friendly combat, so neither strikes the other.
    expect(s.events.filter((event) => event.type === "damage")).toEqual([]);
    s.expectInZone(vanilla, "field");
    expect(s.card(vanilla).controller).toBe("p1");
    expect(s.card(sorcerer).damage).toBe(0);
  });

  it("R220 a board swap in the window leaves the declaring player's attacker on the other side: no combat (R73, R171)", () => {
    const s = scenario({
      seed: "edge-r6-swapper",
      p1: { field: [{ def: SORCERER, lane: 1 }], hand: [STOCKPILE], library: [...WINDOW_LIBRARY] },
      p2: { field: [{ def: VANILLA, lane: 3 }], hand: [STOCKPILE], library: [...WINDOW_LIBRARY] },
    });
    fixture(s, "edge-r6-swapper", "Trap", SWAPPER);
    setTrap(s, "edge-r6-swapper", "p2", 5);
    const sorcerer = must(s.unit("p1", 1), "p1's Twisted Sorcerer");
    const vanilla = must(s.unit("p2", 3), "p2's Mr. Vanilla");

    s.attack(sorcerer, vanilla);

    expect(s.events).toContainEqual(expect.objectContaining({ type: "controlChanged", instanceId: sorcerer.id, controller: "p2" }));
    expect(s.events).toContainEqual(expect.objectContaining({ type: "controlChanged", instanceId: vanilla.id, controller: "p1" }));
    // p1 declared with a unit it no longer controls: that attack is over, and neither unit strikes.
    expect(s.events.filter((event) => event.type === "damage")).toEqual([]);
    s.expectInZone(vanilla, "field");
  });

  it("R220 an attacker the window's trap stole after a question never strikes its new controller's hero (R113, R173)", () => {
    const s = scenario({
      p1: { field: [TIMMY], hand: [RENO] },
      p2: { hand: [RENO] },
    });
    askingWindowTrap(s, "edge-r6-l7-window-steal", "steal");
    setTrap(s, "edge-r6-l7-window-steal", "p2", 1);
    const timmy = must(s.unit("p1", 1), "p1's Tempo Timmy");

    s.attack(timmy, "hero");
    expect(must(s.state.pending, "the window trap's question").playerId).toBe("p2");
    s.answer("ok");

    // The window's trap took Timmy: it is p2's now, and the attack p1 declared at p2's hero would be
    // p2's own unit hitting p2's own hero. Every attack is made on an enemy (§4.2 step 2, R173).
    expect(s.card(timmy).controller).toBe("p2");
    s.expectHealth("p2", 30);
  });

  it("R220 an attacker the window's trap killed after a question does not attack with its Reborn body (R174, R83, R113)", () => {
    const s = scenario({
      p1: { field: [RIGHT_HOUSE], hand: [RENO] },
      p2: { hand: [RENO] },
    });
    askingWindowTrap(s, "edge-r6-l7-window-kill", "destroy");
    setTrap(s, "edge-r6-l7-window-kill", "p2", 1);
    const defender = must(s.unit("p1", 1), "p1's Right-house defender");

    s.attack(defender, "hero");
    s.answer("ok");

    // The declared attacker died in the window and came back through Reborn: a new arrival, sick
    // this turn (R83), and not the stay that declared the attack (R174). Nothing hits p2's hero.
    expect(s.card(defender).rebornSpent).toBe(true);
    s.expectHealth("p2", 30);
  });

  it("R220 My Pawn does not fire on a declaration whose attacker an earlier trap in the window destroyed (R44, R99)", () => {
    // p2's fixture trap in lane 1 destroys p1's attacking Twisted Sorcerer before My Pawn in lane 2
    // is offered the declaration (R68). The attacker is in its graveyard: no attack is left to be
    // lethal, so My Pawn stays armed and p1 keeps its turn.
    const s = scenario({
      seed: "edge-r6-vaporize-pawn",
      p1: { field: [{ def: SORCERER, lane: 1 }], hand: [STOCKPILE], library: [GIGA, GIGA, GIGA] },
      p2: {
        health: 5,
        hand: [STOCKPILE],
        backrow: [{ def: MY_PAWN, lane: 2, faceUp: false }],
        library: [GIGA, GIGA],
      },
    });
    fixture(s, "edge-r6-vaporize", "Trap", VAPORIZE);
    setTrap(s, "edge-r6-vaporize", "p2", 1);
    const sorcerer = must(s.unit("p1", 1), "p1's Twisted Sorcerer");

    s.attack(sorcerer, "hero");

    s.expectInZone(sorcerer, "graveyard");
    const pawnFired = s.events.some((event) => event.type === "trapFired" && event.defId === MY_PAWN);
    expect(pawnFired).toBe(false);
    expect(s.state.players.p1.aiTurn).toBe(false);
    expect(s.backrow("p2", 2)?.defId).toBe(MY_PAWN);
    expect(s.backrow("p2", 2)?.faceUp).toBe(false);
  });
});

describe("R176: the hero My Pawn projects is the one the combat leaves", () => {
  it("R176 a Trample swing the defender's Lifesteal strike back outheals in the same combat is not lethal (§4.3, §4.4 step 8)", () => {
    // p1's 5/5 Twisted Sorcerer with Trample attacks p2's Jilliax (3/2, Lifesteal, Taunt; its Divine
    // Shield spent) with p2 at 3. Trample sends 3 through, and Jilliax's strike back heals p2 for 3
    // in the same combat, so the check after it finds p2 at 3: the attack would not be lethal.
    const s = scenario({
      seed: "edge-r6-pawn-lifesteal",
      p1: { field: [{ def: SORCERER, lane: 1 }], hand: [STOCKPILE], library: [GIGA, GIGA, GIGA] },
      p2: {
        health: 3,
        field: [{ def: JILLIAX, lane: 1 }],
        backrow: [{ def: MY_PAWN, lane: 2, faceUp: false }],
        hand: [STOCKPILE],
        library: [GIGA, GIGA],
      },
    });
    const sorcerer = must(s.unit("p1", 1), "p1's Twisted Sorcerer");
    const jilliax = must(s.unit("p2", 1), "p2's Jilliax");
    s.card(sorcerer).grantedKeywords.push({ kind: "Trample" });
    s.card(jilliax).divineShieldSpent = true;

    s.attack(sorcerer, jilliax);

    expect(count(s, "attackCancelled")).toBe(0);
    expect(s.state.result).toBeNull();
    s.expectHealth("p2", 3);
    s.expectInZone(jilliax, "graveyard");
  });
});
