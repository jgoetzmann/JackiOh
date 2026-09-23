// #96 My Pawn after it has fired: the window it leaves behind, and where the trap ends up (SPEC §3.2,
// §4.2 step 4, §5.1, §6.3 "Cancel an attack" and Exile, R44, R99, R152). Found by the polish-4
// edge-case hunt, round 2 (docs/polish/4-edge-cases.md, lenses L5 and L7); every case here failed
// before its fix.
//
//  - §4.2 step 4, §6.3: a cancelled attack resolves no combat, so it "would be lethal" to nobody and
//    a second My Pawn stays armed (R99) — the window no longer offers it the declaration, and it
//    reads the trap as the board holds it after the first one's AI turn, not as it was before.
//  - §3.2, §6.3 Exile: a My Pawn its own AI turn exiled stays in exile.
//  - R152, §3.2: its effect is the rest of the turn it took, so it is in the graveyard by the time
//    the next turn starts.
//  - Round 5 (lens L7). R168, §10.10: the AI turn's events reach the view once, after the
//    declaration that handed the turn over, not a second time ahead of it.
//  - Round 7 (lenses "legality-agreement" and "engine invariants"). R117: the AI turn owed behind a
//    play of the AI's that the other player's trap asked about waits for the play, so the play's Cry
//    resolves on that turn. R44, §8 #96: a question of the locked-out player's that opens outside the
//    AI's playout is the AI's to answer. R152: a My Pawn fused onto a My Pawn hands over one turn —
//    its second half finds no turn of the attacker's left to hand over.

import {
  newInstance,
  placeOnField,
  registerScripts,
  registeredScripts,
  viewFor,
  type CardInstance,
  type Script,
} from "@jackioh/engine";
import { chooseMode, destroy } from "@jackioh/engine/effects";
import type { CardDef, CardType, GameEvent, PlayerId, Row } from "@jackioh/shared";
import { describe, expect, it } from "vitest";
import { scenario, type Scenario } from "./_harness";

const STOCKPILE = "core-005";
const SEVEN_SEVEN = "core-025";
const GIGA = "core-029";
const COLLATERAL = "core-034";
const GRAVEDIGGER = "core-037";
const RENO = "core-053";
const SORCERER = "core-068";
const MY_PAWN = "core-096";

function count(s: Scenario, type: GameEvent["type"]): number {
  return s.events.filter((event) => event.type === type).length;
}

function backrowAt(s: Scenario, player: "p1" | "p2", lane: number): CardInstance {
  const card = s.backrow(player, lane);
  if (card === null) throw new Error(`setup: ${player} should hold a backrow card in lane ${lane}`);
  return card;
}

describe("§4.2 step 4: the window after a cancel", () => {
  it("§6.3 a second My Pawn does not fire on an attack the first one already cancelled (§4.2 step 4, R99)", () => {
    const s = scenario({
      seed: "hunt-cw2-two-pawns",
      p1: { field: [SORCERER], library: [GIGA, GIGA, GIGA] },
      p2: {
        health: 5,
        hand: [STOCKPILE],
        backrow: [
          { def: MY_PAWN, lane: 1, faceUp: false },
          { def: MY_PAWN, lane: 2, faceUp: false },
        ],
        library: [GIGA, GIGA],
      },
    });
    const first = backrowAt(s, "p2", 1);
    const second = backrowAt(s, "p2", 2);

    s.attack(SORCERER, "hero");

    const fired = s.events.flatMap((event) => (event.type === "trapFired" ? [event.instanceId] : []));
    expect(fired).toEqual([first.id]);
    s.expectInZone(first, "graveyard");
    expect(s.backrow("p2", 2)?.id).toBe(second.id);
    expect(s.backrow("p2", 2)?.faceUp).toBe(false);
    expect(count(s, "attackCancelled")).toBe(1);
  });

  it("R152 a second My Pawn does not hand the player's next turn to the AI after the first one's turn is over (R44)", () => {
    // p2 has nothing to do on turn 10, so R82 ends it inside the first My Pawn's AI turn and p1's
    // turn 11 begins. That turn is p1's own: nothing may play it for them.
    const s = scenario({
      seed: "hunt-cw2-two-pawns-next",
      p1: { field: [SORCERER], library: [GIGA, GIGA, GIGA] },
      p2: {
        health: 5,
        backrow: [
          { def: MY_PAWN, lane: 1, faceUp: false },
          { def: MY_PAWN, lane: 2, faceUp: false },
        ],
        library: [GIGA, GIGA],
      },
    });

    s.attack(SORCERER, "hero");

    expect(s.state.result).toBeNull();
    expect(s.state.turn).toBe(11);
    expect(s.state.active).toBe("p1");
    expect(s.state.players.p1.aiTurn).toBe(false);
    expect(count(s, "trapFired")).toBe(1);
    expect(s.backrow("p2", 2)?.faceUp).toBe(false);
  });
});

describe("§3.2, §5.1: where a fired My Pawn ends up", () => {
  it("§6.3 a My Pawn exiled during its own AI turn stays in exile, it is not pulled into the graveyard (§3.2, §5.1)", () => {
    // On this seed the AI turn My Pawn hands over plays p1's Collateral Damage on the face-up My
    // Pawn itself, which is still in the backrow while its effects run: it goes to p2's exile.
    const s = scenario({
      seed: "hunt-cw2-pawn-exiled-0",
      p1: { field: [SORCERER], hand: [COLLATERAL], library: [GIGA, GIGA, GIGA] },
      p2: {
        health: 5,
        hand: [STOCKPILE],
        backrow: [{ def: MY_PAWN, lane: 1, faceUp: false }],
        library: [GIGA, GIGA, GIGA],
      },
    });
    const pawn = backrowAt(s, "p2", 1);

    s.attack(SORCERER, "hero");

    // The seed's AI does exile it; without that this test proves nothing.
    expect(s.events.some((event) => event.type === "exiled" && event.instanceId === pawn.id)).toBe(true);
    s.expectInZone(pawn, "exile");
    expect(s.events.some((event) => event.type === "enteredGraveyard" && event.instanceId === pawn.id)).toBe(false);
  });

  it("R152 My Pawn is in its owner's graveyard once the AI turn it gave has ended, before the next turn starts (§3.2, §5.1)", () => {
    // My Pawn "fires … then goes to the graveyard" (§5.1), and its effect is the rest of p1's turn,
    // which ends at p1's cleanup (R152). So by p2's start of turn it is in p2's graveyard, and p2's
    // Gravedigger ("Start of turn: add a random card from your GY to your hand") finds it there — it
    // is the only card in that graveyard.
    const g = scenario({
      seed: "pawn-gravedigger",
      p1: { field: [{ def: SEVEN_SEVEN, lane: 1 }], library: [RENO, RENO] },
      p2: {
        health: 5,
        field: [{ def: GRAVEDIGGER, lane: 1 }],
        backrow: [MY_PAWN],
        library: [RENO, RENO, RENO],
      },
    });
    const pawn = backrowAt(g, "p2", 1);

    g.attack(SEVEN_SEVEN, "hero");

    expect(g.state.active).toBe("p2");
    g.expectHealth("p2", 5);
    g.expectInZone(pawn, "hand");
  });
});

describe("§10.8, R168: My Pawn's AI turn reaches the view once, in order", () => {
  it("R168 the view's events after My Pawn's AI turn are that action's events once each, in the order they happened (§10.10, R44)", () => {
    const s = scenario({
      seed: "hunt-cw2-two-pawns",
      p1: { field: [SORCERER], library: [GIGA, GIGA, GIGA] },
      p2: {
        health: 5,
        hand: [STOCKPILE],
        backrow: [{ def: MY_PAWN, lane: 1, faceUp: false }],
        library: [GIGA, GIGA],
      },
    });
    // A lethal attack: My Pawn cancels it and hands the rest of p1's turn to the AI (R44), which
    // ends it, so p2's turn starts inside this one action.
    s.attack(SORCERER, "hero");
    expect(s.lastEvents.filter((event) => event.type === "turnEnded")).toHaveLength(1);

    // The scenario began with no history, so the view's stream is exactly this action's events: the
    // declaration and the cancel first, then the AI's turn end and p2's turn start, each once. The
    // AI's own actions are part of this one (`aiPolicy.adoptState` keeps the enclosing history).
    const seen = viewFor(s.state, "p2").events.map((event) => event.type);
    expect(seen).toEqual(s.lastEvents.map((event) => event.type));
  });
});

// ---------------------------------------------------------------------------
// Round 7 (lenses "legality-agreement" and "engine invariants"): the AI turn's questions, and a My
// Pawn fused onto a My Pawn.
// ---------------------------------------------------------------------------

const TEMPO_TIMMY = "core-011";
const JEWELOSCO_SCARAB = "core-007";
const MR_VANILLA = "core-008";
const JLOCKEED_SHREDDER = "core-013";
const UNLICENSED_EXPERIMENTATION = "core-085";

/** A fixture card: a transient def in the match state and its script in the registry. */
function fixture(s: Scenario, id: string, type: CardType, script: Script): void {
  const face = type === "Unit" ? { attack: 2, health: 2, keywords: [], text: id } : { keywords: [], text: id };
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
  return card;
}

/** A Trap that fires when its controller's opponent plays a card, asks its controller, then runs `after`. */
function askingTrap(s: Scenario, id: string, after: NonNullable<Script["cry"]> = () => []): void {
  fixture(s, id, "Trap", {
    triggers: [
      {
        id: `${id}-asks`,
        on: ["cardPlayed"],
        when: (ctx) => ctx.event.type === "cardPlayed" && ctx.event.player !== ctx.controller,
        run: () => [chooseMode({ options: ["ok"], step: "asked", prompt: `${id}: asked` })],
      },
    ],
    resume: { asked: after },
  });
}

describe("R44, §8 #96: the AI answers every question of the turn it plays", () => {
  it("R117 a card the AI played resolves its Cry on that turn after the other player's trap asked about the play (R44, §10.5, R113)", () => {
    // p1's Tempo Timmy swings for lethal, so p2's My Pawn cancels it and hands the rest of p1's turn
    // to the AI (R44). The AI plays Jewelosco Scarab, and p2's trap asks p2 about that play at
    // §10.5 step 4, before the Scarab's Cry (Discover a 2-cost card).
    const s = scenario({
      seed: "edge-r7-lock-0",
      p1: { field: [TEMPO_TIMMY], hand: [JEWELOSCO_SCARAB], library: [RENO, RENO], mana: 1 },
      p2: { health: 3, backrow: [{ def: MY_PAWN, faceUp: false }], hand: [RENO], library: [RENO, RENO] },
    });
    askingTrap(s, "edge-r7-asker");
    placeFixture(s, "edge-r7-asker", "p2", "backrow", 2);
    const turn = s.state.turn;

    s.attack(TEMPO_TIMMY, "hero");
    expect(s.state.players.p1.aiTurn).toBe(true);
    expect(s.state.pending?.prompt, "p2's trap asks about the AI's Scarab").toBe("edge-r7-asker: asked");
    expect(s.state.turn).toBe(turn);

    s.answer("ok");

    // §10.3: the trap resolves to completion, and then the play it interrupted goes on to step 5
    // (§10.5) before anything owed behind it: the rest of the AI turn is the enclosing sequence,
    // and waits for the play (R113, R117). So the Scarab's Discover opens on the turn the Scarab
    // was played, before that turn ends.
    const events = s.lastEvents;
    const discover = events.findIndex((event) => event.type === "promptOpened" && event.player === "p1");
    const ended = events.findIndex((event) => event.type === "turnEnded");
    expect(discover, "the Scarab's Discover opens once p2 has answered").toBeGreaterThanOrEqual(0);
    expect(ended === -1 || discover < ended, "the Scarab's Cry resolves before p1's turn ends").toBe(true);
    // And p1 is never left holding a question of its own turn while it is p2's turn.
    expect(s.state.pending?.playerId === "p1" && s.state.active === "p2").toBe(false);
  });

  it("R44 a question of the locked-out player's that opens during the AI turn is the AI's to answer (§8 #96, R152, §10.7)", () => {
    // p1 has a unit whose Death asks its controller. p2's trap asks p2 about the AI's play and then
    // destroys that unit, so p1's question opens during p1's AI turn, inside p2's answer.
    const s = scenario({
      seed: "edge-r7-lock-b",
      p1: { field: [TEMPO_TIMMY], hand: [MR_VANILLA], library: [RENO, RENO], mana: 1 },
      p2: { health: 3, backrow: [{ def: MY_PAWN, faceUp: false }], hand: [RENO], library: [RENO, RENO] },
    });
    fixture(s, "edge-r7-last-word", "Unit", {
      death: () => [chooseMode({ options: ["ok"], step: "said", prompt: "edge-r7: a last word" })],
      resume: { said: () => [] },
    });
    const dying = placeFixture(s, "edge-r7-last-word", "p1", "units", 5);
    askingTrap(s, "edge-r7-killer", () => [destroy({ target: { of: "instance", instanceId: dying.id } })]);
    placeFixture(s, "edge-r7-killer", "p2", "backrow", 2);

    s.attack(TEMPO_TIMMY, "hero");
    expect(s.state.players.p1.aiTurn).toBe(true);
    expect(s.state.pending?.prompt, "p2's trap asks about the AI's Mr. Vanilla").toBe("edge-r7-killer: asked");

    s.answer("ok");
    s.expectInZone(dying, "graveyard");

    // §8 #96: "an AI plays the rest of their turn with random legal actions", and §10.7 and R44 have
    // it answer prompts from `legalActions` like any other action, while p1 is locked out until the
    // end of the turn. So a question p1's card asks during that turn is the AI's to answer; it is
    // never left open for the locked-out player, whose client does not act while `aiTurn` is set.
    const held = s.state.pending;
    const lockedOutHoldsIt = held !== null && held.playerId === "p1" && s.state.players.p1.aiTurn;
    expect(lockedOutHoldsIt, `p1 is locked out but holds "${held?.prompt ?? ""}"`).toBe(false);
  });
});

describe("R152: the AI turn's lockout ends with the turn it was set for", () => {
  it("R152 a My Pawn fused onto a My Pawn by #85 leaves no lockout on the player whose turn its first half already played out (R44, R102)", () => {
    const s = scenario({
      seed: "r7-double-pawn",
      active: "p2",
      turn: 10,
      // p1 keeps a unit, so its own turn does not end by itself (R82) and the test can look at it.
      p1: {
        health: 5,
        field: [MR_VANILLA],
        backrow: [
          { def: MY_PAWN, faceUp: false },
          { def: UNLICENSED_EXPERIMENTATION, faceUp: false },
        ],
      },
      p2: { hand: [MY_PAWN], field: [JLOCKEED_SHREDDER], mana: 4 },
    });

    // p2 sets its own My Pawn; p1's #85 answers the played Trap by fusing it onto p1's My Pawn (R61).
    s.play(MY_PAWN);
    expect(s.backrow("p1", 1)?.defId).toMatch(/core-096\+core-096$/);

    // p2 swings 8 at p1's 5: the fused trap fires, cancels the attack and hands p2's turn to the AI.
    s.attack(JLOCKEED_SHREDDER, "hero");
    expect(s.lastEvents.some((event) => event.type === "attackCancelled")).toBe(true);
    expect(s.state.active).toBe("p1");
    expect(s.state.pending).toBeNull();
    // R152: the lockout ended at the cleanup of the turn My Pawn took. The fused trap's second My
    // Pawn half ran only after that turn was over and set the lockout again on p2, for p1's turn —
    // a turn no My Pawn handed to the AI.
    expect(s.state.players.p2.aiTurn).toBe(false);
    expect(s.state.players.p1.aiTurn).toBe(false);
  });
});
