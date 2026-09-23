// The stages of the turn loop, each settled before the next (SPEC §2.2, §6.2, §10.3, R44, R62, R68,
// R152). Found by the polish-4 edge-case hunt, round 6 (docs/polish/4-edge-cases.md, lens L8);
// every case here failed before its fix.
//
//  - R62, §10.3: a stage that emits events settles before the next one runs, so a trigger answering
//    the end-of-turn trap window resolves in that turn's end, and one answering a start-of-turn
//    delayed effect resolves before the start-of-turn triggers are queued behind it.
//  - R44, R152: the AI turn #96 My Pawn hands over goes on after the other player answers a question
//    one of its actions put to them.
//
// No Core card answers a summon or a change of control, and no Core trap asks its controller
// anything, so the card that makes each case observable is a fixture (a transient def, the way a
// fusion's is held, as paused-sequences.test.ts does); every other card is a real one.

import { describe, expect, it } from "vitest";
import type { CardDef, CardType, PlayerId, Row } from "@jackioh/shared";
import {
  legalActions,
  newInstance,
  placeOnField,
  reduce,
  registerScripts,
  registeredScripts,
  type CardInstance,
  type Script,
} from "@jackioh/engine";
import { chooseMode, damage } from "@jackioh/engine/effects";
import { scenario, type Scenario } from "./_harness";

const VANILLA = "core-008"; // Unit, cost 1, no Cry
const TEMPO_TIMMY = "core-011"; // 3/3 Rush, First Strike
const BREAD_AND_BUTTER = "core-018"; // Field Trap in the end-of-turn window (R62)
const ECHOES = "core-040"; // Start of your turn: damage to the enemy hero = cards in your exile
const KPOP_FANATIC = "core-050"; // Cry: at the start of your next turn, steal the chosen permanent
const RENO = "core-053";
const MASOCHISM_MASK = "core-065"; // Start of turn: a mode prompt
const MY_PAWN = "core-096";
const GARY = "core-004";
const SEVEN_SEVEN = "core-025";

/** The actions a player takes for themselves on their own turn (everything but concede and draws). */
const TURN_ACTIONS = ["play", "attack", "switchPosition", "activatePower", "offerDraw", "endTurn"];

function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`expected ${what}`);
  return value;
}

/** A fixture card: a transient def in the match state and its script in the registry. */
function fixture(s: Scenario, id: string, type: CardType, script: Script, stats = { attack: 2, health: 2 }): void {
  const face = type === "Unit" ? { ...stats, keywords: [], text: id } : { keywords: [], text: id };
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

function placeFixture(s: Scenario, defId: string, player: PlayerId, row: Row, lane: number): CardInstance {
  const card = newInstance(s.state, defId, player, { z: "hand", player });
  if (!placeOnField(s.state, card, { player, row, lane })) throw new Error(`could not place ${defId}`);
  if (row === "units") card.position = "ATK";
  return card;
}

describe("R62, §10.3: a stage of the turn loop settles its events before the next stage", () => {
  it("R62 a trigger answering the end-of-turn trap window resolves in that turn's end, before the next turn starts (§10.3, R216)", () => {
    // p1 ends the turn with 1 mana unspent: p1's Bread and Butter summons a Bread Token for p1 in
    // the window, and p1's fixture unit answers that summon with 1 damage to p2's hero, which is at
    // 1. p2's Echoes of the Forgotten would deal p1 (at 2) 3 at the start of p2's turn.
    const s = scenario({
      p1: {
        hand: [RENO],
        backrow: [{ def: BREAD_AND_BUTTER, faceUp: false }],
        mana: 1,
        health: 2,
        library: [RENO, RENO],
      },
      p2: { hand: [RENO], backrow: [ECHOES], exile: [RENO, RENO, RENO], health: 1, library: [RENO, RENO] },
    });
    fixture(s, "edge-r6-juggler", "Unit", {
      triggers: [
        {
          id: "edge-r6-juggle",
          on: ["summoned"],
          run: (ctx) =>
            ctx.event.type === "summoned" && ctx.event.player === ctx.controller
              ? [damage({ to: { of: "enemyHero" }, amount: 1 })]
              : [],
        },
      ],
    });
    placeFixture(s, "edge-r6-juggler", "p1", "units", 3);

    s.endTurn();

    // §10.3: the window's firing is an effect like any other, so the trigger its summon wakes
    // resolves before R62 moves on to the delayed effects, cleanup and the turn cap; p2 is at 0 in
    // that check and loses (§4.5 step 2) at the end of p1's turn. p2's turn never starts, so
    // Echoes never fires (R216).
    expect(s.events.some((event) => event.type === "trapFired")).toBe(true);
    expect(s.state.result?.winner).toBe("p1");
    expect(s.events.some((event) => event.type === "turnStarted" && event.player === "p2")).toBe(false);
  });

  it("R62 a trigger answering a start-of-turn delayed effect resolves before the start-of-turn triggers (R68, §6.2)", () => {
    // p1's Kpop Fanatic steals p2's Tempo Timmy at the start of p1's next turn. p1's fixture unit
    // answers the change of control with 1 damage to p2's hero, which is at 1. p1's Masochism Mask
    // (backrow) asks p1 something at the start of the turn.
    const s = scenario({
      p1: { hand: [KPOP_FANATIC, RENO], backrow: [MASOCHISM_MASK], library: [RENO, RENO] },
      p2: { field: [TEMPO_TIMMY], hand: [RENO], health: 1, library: [RENO, RENO] },
    });
    fixture(s, "edge-r6-bounty", "Unit", {
      triggers: [
        {
          id: "edge-r6-bounty",
          on: ["controlChanged"],
          run: (ctx) =>
            ctx.event.type === "controlChanged" && ctx.event.controller === ctx.controller
              ? [damage({ to: { of: "enemyHero" }, amount: 1 })]
              : [],
        },
      ],
    });
    placeFixture(s, "edge-r6-bounty", "p1", "units", 4);
    const timmy = must(s.unit("p2", 1), "p2's Tempo Timmy");
    s.play(KPOP_FANATIC, { targets: [{ pick: "instance", instanceId: timmy.id }] });

    s.startTurn();

    // §6.2 and R62: the delayed effects first, then the trigger queue. The steal's trigger is queued
    // by the steal, before the start-of-turn stage begins, and by R68 a unit's trigger comes before a
    // backrow card's anyway: p2 is at 0 in the check after it and loses before the Mask asks.
    expect(s.events.some((event) => event.type === "controlChanged" && event.instanceId === timmy.id)).toBe(true);
    expect(s.state.result?.winner).toBe("p1");
    expect(s.state.pending).toBeNull();
  });
});

describe("R44, R152: My Pawn's AI plays the rest of the turn", () => {
  it("R44 the AI turn goes on after the other player answers a prompt one of its actions opened (§10.3, §8 #96, R152)", () => {
    // p1's 3/3 Timmy swings at p2's hero at 3: lethal, so p2's My Pawn cancels it and hands the
    // rest of p1's turn to the AI (R44). p2's fixture trap asks p2 something when p1 plays a card.
    const s = scenario({
      p1: { field: [TEMPO_TIMMY], hand: [VANILLA, VANILLA, VANILLA], mana: 4 },
      p2: { health: 3, backrow: [{ def: MY_PAWN, faceUp: false }], hand: [RENO], library: [RENO, RENO] },
    });
    fixture(s, "edge-r6-asker", "Trap", {
      triggers: [
        {
          id: "edge-r6-asks",
          on: ["cardPlayed"],
          when: (ctx) => ctx.event.type === "cardPlayed" && ctx.event.player !== ctx.controller,
          run: () => [chooseMode({ options: ["ok"], step: "asked", prompt: "edge-r6: asked" })],
        },
      ],
      resume: { asked: () => [] },
    });
    placeFixture(s, "edge-r6-asker", "p2", "backrow", 2);
    const turn = s.state.turn;

    s.attack(TEMPO_TIMMY, "hero");
    // The AI took p1's turn and played a card, and p2's trap is asking p2 about it.
    expect(s.state.players.p1.aiTurn).toBe(true);
    expect(s.lastEvents.some((event) => event.type === "cardPlayed" && event.player === "p1")).toBe(true);
    expect(s.state.pending?.prompt).toBe("edge-r6: asked");

    s.answer("ok");

    // §10.3: the trap resolves to completion, its prompt included, and then the action it
    // interrupted continues — here the AI turn (§8 #96: "an AI plays the rest of their turn"). The
    // AI goes on until it ends p1's turn, which is where R152 ends the lockout; p1's own client is
    // never handed the turn back.
    expect(s.state.turn).toBeGreaterThan(turn);
    expect(s.state.players.p1.aiTurn).toBe(false);
  });
});

describe("R44, R152: a locked-out player is never handed back the turn My Pawn gave the AI", () => {
  it("R44 once the other player answers a prompt the AI turn ran into, the rest of the turn is still the AI's (§8 #96, R152)", () => {
    // The seed only fixes which of p1's actions the AI draws: here it attacks the fixture unit with
    // one of its 1/1s early in the playout, with plays and switches still left to take.
    const s = scenario({
      seed: "edge-r6-pawn-1",
      p1: {
        field: [SEVEN_SEVEN, KPOP_FANATIC, GARY],
        hand: [VANILLA, VANILLA],
        library: [RENO, RENO, RENO],
      },
      p2: {
        health: 5,
        backrow: [{ def: MY_PAWN, faceUp: false }],
        hand: [RENO],
        library: [RENO, RENO, RENO],
      },
    });
    // p2's 1/1 whose Death asks its controller something.
    fixture(
      s,
      "edge-r6-asking-death",
      "Unit",
      { death: () => [chooseMode({ options: ["keep", "drop"], step: "picked" })], resume: { picked: () => [] } },
      { attack: 1, health: 1 },
    );
    placeFixture(s, "edge-r6-asking-death", "p2", "units", 3);

    // A lethal swing: My Pawn cancels it, and the AI plays out the rest of p1's turn (R44).
    s.attack("4-mana 7/7", "hero");
    expect(s.state.players.p1.aiTurn).toBe(true);
    // The AI killed the fixture unit, whose Death asks p2: the AI turn waits on p2's answer.
    expect(s.state.pending?.playerId).toBe("p2");

    s.answer("keep");

    // R44: "it plays out the turn while the opponent is locked out", and R152 ends the lockout only
    // at the cleanup of that turn. So p1 is never offered, and never allowed, an action of its own
    // on this turn: the AI finishes it, whatever p2 was asked on the way.
    const offered = legalActions(s.state, "p1").filter((action) => TURN_ACTIONS.includes(action.type));
    expect(offered, `p1 is locked out on turn ${s.state.turn}, yet offered its own turn`).toEqual([]);
    const own = reduce(s.state, { type: "endTurn", playerId: "p1", nonce: "edge-r6-locked-out" });
    expect(own.error, "reduce accepted an action from the locked-out player").toBeDefined();
  });
});
