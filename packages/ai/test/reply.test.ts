// The opponent's reply (reply.ts, docs/polish/3-ai.md "The opponent's reply", SPEC §9.9): after a
// line hands the opponent the turn, the opponent swings by a fixed trading rule and ends its turn,
// every step a real `reduce` that costs one node, and the line is scored at the seat's next decision.
//
// Every board here is a `scenario()` with the AI as p1 on turn 9. The AI ends its turn through the
// reducer, which hands p2 its turn 10; `simulateReply` then plays p2's reply.

import { describe, expect, it } from "vitest";
import type { GameState } from "@jackioh/engine";
import type { ScenarioOptions } from "./_support";
import {
  AI_EVAL,
  createNodeCounter,
  evaluate,
  hiddenCardIds,
  lineStatus,
  replyScore,
  simulateReply,
  staticScore,
} from "../src/index";
import { AI, HUMAN, act, inGraveyard, onField, scenario } from "./_support";

const TURN = 9;
const LIBRARY = ["core-008", "core-011", "core-008", "core-011"] as const;

/** p1's turn 9 with vanilla libraries on both sides, ended through the reducer: p2's turn 10. */
function handedOver(setup: ScenarioOptions): GameState {
  const s = scenario({
    seed: "reply",
    active: AI,
    turn: TURN,
    ...setup,
    p1: { library: [...LIBRARY], ...setup.p1 },
    p2: { library: [...LIBRARY], ...setup.p2 },
  });
  const ended = act(s.state, AI, { type: "endTurn" });
  expect(ended.active).toBe(HUMAN);
  expect(ended.turn).toBe(TURN + 1);
  return ended;
}

describe("simulateReply", () => {
  it("swings an unblocked unit at the open face, ends the turn, and stops at the seat's next main phase", () => {
    const state = handedOver({ p2: { field: ["core-008"] } });
    const counter = createNodeCounter(20);
    const after = simulateReply(state, AI, counter);
    expect(after).not.toBeNull();
    const reply = after as GameState;
    expect(reply.result).toBeNull();
    expect(reply.active).toBe(AI);
    expect(reply.turn).toBe(TURN + 2);
    expect(reply.phase).toBe("main");
    expect(reply.pending).toBeNull();
    // Mr. Vanilla's 3 to the face; the attack and the endTurn are one node each.
    expect(reply.players[AI].hero.health).toBe(27);
    expect(counter.used).toBe(2);
  });

  it("takes lethal when the face is in reach", () => {
    const state = handedOver({ p1: { health: 3 }, p2: { field: ["core-008"] } });
    const reply = simulateReply(state, AI, createNodeCounter(20)) as GameState;
    expect(reply.result?.winner).toBe(HUMAN);
  });

  it("does not throw a unit into a Defense-Position wall it cannot hurt, and ends its turn instead", () => {
    // The 7/7 in Defense Position has Taunt and 8 Armor: Mr. Vanilla's 3 does nothing and it dies.
    const state = handedOver({
      p1: { field: [{ def: "core-025", position: "DEF" }] },
      p2: { field: ["core-008"] },
    });
    const counter = createNodeCounter(20);
    const reply = simulateReply(state, AI, counter) as GameState;
    expect(onField(reply, HUMAN, "core-008")).toBe(true);
    expect(reply.players[AI].hero.health).toBe(30);
    expect(reply.active).toBe(AI);
    expect(counter.used).toBe(1);
  });

  it("trades into a unit worth more than the face damage it gives up", () => {
    // Midrange Menace survives Pointmaster's First Strike 7 and kills it: an 11-point unit for free
    // beats 9 to the face.
    const state = handedOver({ p1: { field: ["core-020"] }, p2: { field: ["core-019"] } });
    const reply = simulateReply(state, AI, createNodeCounter(20)) as GameState;
    expect(inGraveyard(reply, AI, "core-020")).toBe(true);
    expect(reply.players[AI].hero.health).toBe(30);
  });

  it("stops at the seat's own start-of-turn prompt, which is where its next decision begins", () => {
    // Masochism Mask asks p1 at the start of each of its turns.
    const state = handedOver({ p1: { backrow: ["core-065"] } });
    const reply = simulateReply(state, AI, createNodeCounter(20)) as GameState;
    expect(reply.active).toBe(AI);
    expect(reply.turn).toBe(TURN + 2);
    expect(reply.pending?.playerId).toBe(AI);
  });

  it("replays the units the seat's own Flood bounced into the opponent's hand, and nothing it held unseen", () => {
    const s = scenario({
      seed: "reply-flood",
      active: AI,
      turn: TURN,
      p1: { hand: ["core-017"], mana: 3, library: [...LIBRARY] },
      p2: { field: ["core-019"], hand: ["core-008"], library: [...LIBRARY] },
    });
    // The seat's view when the decision began: p2's hand and library are what it cannot see.
    const hidden = hiddenCardIds(s.state, AI);
    const menace = s.unit(HUMAN, 1)?.id ?? "";
    expect(hidden.has(menace)).toBe(false);

    // Flood bounces Midrange Menace. p1 has nothing left to do, so R82 ends its turn on the spot and
    // p2 is into its turn 10, having drawn.
    const ended = act(s.state, AI, { type: "play", instanceId: s.hand(AI)[0]?.id ?? "" });
    expect(ended.active).toBe(HUMAN);
    expect(ended.turn).toBe(TURN + 1);
    expect(ended.players[HUMAN].hand.map((card) => card.id)).toContain(menace);

    const reply = simulateReply(ended, AI, createNodeCounter(40), hidden) as GameState;
    // Midrange Menace came back; the Mr. Vanilla p2 held from the start stayed in its hand.
    expect(onField(reply, HUMAN, "core-019")).toBe(true);
    expect(onField(reply, HUMAN, "core-008")).toBe(false);

    // Without that history every card in p2's hand is unseen, and the reply plays none of them.
    const blind = simulateReply(ended, AI, createNodeCounter(40)) as GameState;
    expect(onField(blind, HUMAN, "core-019")).toBe(false);
    expect(onField(blind, HUMAN, "core-008")).toBe(false);
  });

  it("returns null without a node to spend", () => {
    const state = handedOver({ p2: { field: ["core-008"] } });
    expect(simulateReply(state, AI, createNodeCounter(0))).toBeNull();
  });
});

describe("replyScore", () => {
  it("scores a passed line at the seat's next decision, where it swings first, less its unspent crystals", () => {
    const s = scenario({
      seed: "reply-score",
      active: AI,
      turn: TURN,
      p1: { mana: 2, library: [...LIBRARY] },
      p2: { field: ["core-008"], library: [...LIBRARY] },
    });
    const ended = act(s.state, AI, { type: "endTurn" });
    expect(lineStatus(ended, AI, TURN)).toBe("passed");
    expect(ended.players[AI].turnLog.unspentAtEnd).toBe(2);

    const after = simulateReply(ended, AI, createNodeCounter(20)) as GameState;
    const counter = createNodeCounter(20);
    const score = replyScore(ended, AI, TURN, counter);
    expect(score).toBe(evaluate(after, AI, "seat") - AI_EVAL.unspentMana * 2);
    expect(counter.used).toBe(2);
    // The state it was scored at carries the reply's 3 damage.
    expect(after.players[AI].hero.health).toBe(27);
  });

  it("keeps the static score of a line that ended the game, with no node spent", () => {
    const s = scenario({ seed: "reply-over", active: AI, turn: TURN, p1: { field: ["core-008"] }, p2: { health: 3 } });
    const won = act(s.state, AI, { type: "attack", attackerId: s.unit(AI, 1)?.id ?? "", targetId: `hero-${HUMAN}` });
    expect(won.result?.winner).toBe(AI);
    const counter = createNodeCounter(20);
    expect(replyScore(won, AI, TURN, counter)).toBe(staticScore(won, AI, TURN));
    expect(counter.used).toBe(0);
  });

  it("is null when the counter runs out during the reply", () => {
    const state = handedOver({ p2: { field: ["core-008"] } });
    expect(replyScore(state, AI, TURN, createNodeCounter(1))).toBeNull();
  });
});
