// The search's building blocks, each against its contract in docs/polish/3-ai.md §Surface: `lineStatus`
// and `terminalScore` (simulate.ts), `scoreLine` and `beamSearch` (search.ts), `findLethal`
// (lethal.ts), decide's "search" and "prompt" reasons and its planned line, `playAiTurn`'s loop and
// nonces, and sweepCard's clock. The numbered behaviours reach these only through `decide` and the
// puzzles; here each one is held to its own sentence in the design, so a change that keeps the
// puzzles green but breaks a contract still fails.

import { describe, expect, it } from "vitest";
import type { ActionBody } from "@jackioh/shared";
import { createRng, type GameState } from "@jackioh/engine";
import {
  AI_EVAL,
  AI_GATE_BUDGET,
  AI_SWEEP,
  actionKey,
  aiToAct,
  beamSearch,
  candidateActions,
  createNodeCounter,
  decide,
  determinize,
  evaluate,
  findLethal,
  lineStatus,
  playAiTurn,
  redact,
  scoreLine,
  simulate,
  sweepCard,
  terminalScore,
} from "../src/index";
import { AI, HUMAN, act, isLegal, scenario } from "./_support";

const TURN = 9;

/**
 * p1's main phase on turn 9: one attacker, a 1-drop in hand (so an attack alone does not leave the
 * turn with nothing to do, which R82 would end on the spot), 3 unspent crystals, vanilla libraries,
 * and p2 far from dead.
 */
function quietTurn(): GameState {
  return scenario({
    seed: "surface-quiet",
    active: AI,
    turn: TURN,
    p1: { hand: ["core-008"], field: ["core-011"], mana: 3, library: ["core-008", "core-011"] },
    p2: { field: ["core-008"], library: ["core-008", "core-011"], health: 20 },
  }).state;
}

/** P1's board: two attackers, an empty enemy board and 6 enemy health. */
function lethalBoard(): GameState {
  return scenario({
    seed: "surface-lethal",
    active: AI,
    turn: TURN,
    p1: { field: ["core-011", "core-008"] },
    p2: { health: 6 },
  }).state;
}

function worlds(state: GameState, seed: string, count: number): GameState[] {
  const rng = createRng(seed);
  const pub = redact(state, AI);
  return Array.from({ length: count }, () => determinize(pub, AI, rng));
}

function heroAttack(state: GameState): ActionBody {
  const attack = candidateActions(state, AI).find(
    (action) => action.type === "attack" && action.targetId === `hero-${HUMAN}`,
  );
  if (attack === undefined) throw new Error("no attack on the enemy hero");
  return attack;
}

/**
 * The p1 turn ended through the reducer, as terminalScore's own endTurn step plays it (p2's cards
 * are vanilla, so there is no prompt of p2's for simulate to auto-answer). `act` stamps a nonce of
 * its own: two `simulate` calls on fresh counters would both use `sim:1`, and reduce would treat the
 * second as a repeat of the first.
 */
function endedTurn(state: GameState): GameState {
  return act(state, AI, { type: "endTurn" });
}

function passedValue(ended: GameState): number {
  return evaluate(ended, AI) - AI_EVAL.unspentMana * (ended.players[AI].turnLog.unspentAtEnd ?? 0);
}

const BOGUS: ActionBody = { type: "attack", attackerId: "no-such-unit", targetId: `hero-${HUMAN}` };

// ---------------------------------------------------------------------------------------------
// simulate.ts
// ---------------------------------------------------------------------------------------------

describe("Surface: lineStatus", () => {
  it("is open in the seat's own turn, passed once the turn moved on, yielded on the other seat's turn and over at a result", () => {
    const state = quietTurn();
    expect(state.pending).toBeNull();
    expect(lineStatus(state, AI, TURN)).toBe("open");
    expect(lineStatus(state, AI, TURN - 2)).toBe("passed");
    expect(lineStatus(state, HUMAN, TURN)).toBe("yielded");
    const over = act(state, AI, { type: "concede" });
    expect(lineStatus(over, AI, TURN)).toBe("over");
    expect(lineStatus(over, HUMAN, TURN)).toBe("over");
  });
});

describe("Surface: terminalScore", () => {
  it("an open line in the seat's main phase ends its turn and pays for the crystals it left", () => {
    const state = quietTurn();
    const ended = endedTurn(state);
    expect(ended.players[AI].turnLog.unspentAtEnd).toBe(3);

    const counter = createNodeCounter(10);
    expect(terminalScore(state, AI, TURN, counter)).toBe(passedValue(ended));
    expect(counter.used).toBeGreaterThan(0);
  });

  it("a passed line is the evaluation less the unspent crystals, with no node spent", () => {
    const ended = endedTurn(quietTurn());
    expect(lineStatus(ended, AI, TURN)).toBe("passed");
    const counter = createNodeCounter(10);
    expect(terminalScore(ended, AI, TURN, counter)).toBe(passedValue(ended));
    expect(passedValue(ended)).toBeLessThan(evaluate(ended, AI));
    expect(counter.used).toBe(0);
  });

  it("a yielded or finished line is the plain evaluation, with no node spent", () => {
    const state = quietTurn();
    const counter = createNodeCounter(10);
    expect(terminalScore(state, HUMAN, TURN, counter)).toBe(evaluate(state, HUMAN));
    const over = act(state, AI, { type: "concede" });
    expect(terminalScore(over, AI, TURN, counter)).toBe(evaluate(over, AI));
    expect(evaluate(over, AI)).toBe(-AI_EVAL.win + over.turn);
    expect(counter.used).toBe(0);
  });

  it("an open line with no node left for its endTurn is scored where it stands", () => {
    const state = quietTurn();
    expect(terminalScore(state, AI, TURN, createNodeCounter(0))).toBe(evaluate(state, AI));
  });
});

// ---------------------------------------------------------------------------------------------
// search.ts
// ---------------------------------------------------------------------------------------------

describe("Surface: scoreLine", () => {
  it("a line whose first action is not a candidate is cut there and scored by terminalScore", () => {
    const state = quietTurn();
    expect(isLegal(state, AI, BOGUS)).toBe(false);
    expect(scoreLine(state, AI, [BOGUS], createNodeCounter(20))).toBe(
      terminalScore(state, AI, TURN, createNodeCounter(20)),
    );
  });

  it("a legal line is played, its turn ended, and the end scored; anything after a non-candidate is dropped", () => {
    const state = quietTurn();
    const attack = heroAttack(state);
    const step = simulate(state, AI, attack, createNodeCounter(20));
    if (step === null || !step.ok) throw new Error("the attack was refused");
    const expected = passedValue(endedTurn(step.state));

    expect(scoreLine(state, AI, [attack], createNodeCounter(20))).toBe(expected);
    expect(scoreLine(state, AI, [attack, BOGUS, { type: "endTurn" }], createNodeCounter(20))).toBe(expected);
  });

  it("is null when the counter runs out before the line is scored", () => {
    const state = quietTurn();
    const attack = heroAttack(state);
    expect(scoreLine(state, AI, [attack], createNodeCounter(0))).toBeNull();
    expect(scoreLine(state, AI, [attack], createNodeCounter(1))).toBeNull();
  });
});

describe("Surface: beamSearch", () => {
  it("returns complete lines best first, each starting with a candidate, within the counter and maxDepth", { timeout: 60_000 }, () => {
    const state = quietTurn();
    const [det] = worlds(state, "surface-beam", 1);
    if (det === undefined) throw new Error("no determinization");
    const counter = createNodeCounter(AI_GATE_BUDGET.nodes);
    const lines = beamSearch(det, AI, counter, AI_GATE_BUDGET);

    expect(lines.length).toBeGreaterThan(0);
    expect(counter.used).toBeLessThanOrEqual(AI_GATE_BUDGET.nodes);
    const firsts = new Set(candidateActions(det, AI).map(actionKey));
    for (const [index, line] of lines.entries()) {
      expect(line.actions.length).toBeGreaterThan(0);
      expect(line.actions.length).toBeLessThanOrEqual(AI_GATE_BUDGET.maxDepth);
      expect(firsts.has(actionKey(line.actions[0] as ActionBody))).toBe(true);
      const previous = lines[index - 1];
      if (previous !== undefined) expect(line.score).toBeLessThanOrEqual(previous.score);
    }
    // endTurn is expanded at the root on top of the branching, so ending at once is always a line.
    expect(lines.some((line) => line.actions.length === 1 && line.actions[0]?.type === "endTurn")).toBe(true);
  });

  it("with no node to spend there is no line", () => {
    const [det] = worlds(quietTurn(), "surface-beam-empty", 1);
    if (det === undefined) throw new Error("no determinization");
    expect(beamSearch(det, AI, createNodeCounter(0), AI_GATE_BUDGET)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// lethal.ts
// ---------------------------------------------------------------------------------------------

describe("Surface: findLethal", () => {
  it("finds a line that kills the enemy hero on every determinization, within its node limit", { timeout: 60_000 }, () => {
    const dets = worlds(lethalBoard(), "surface-lethal", 2);
    const counter = createNodeCounter(AI_GATE_BUDGET.nodes);
    const line = findLethal(dets, AI, counter, AI_GATE_BUDGET.lethalNodes);
    expect(line).not.toBeNull();
    expect(counter.used).toBeLessThanOrEqual(AI_GATE_BUDGET.lethalNodes);

    for (const det of dets) {
      let state = det;
      // One counter for the whole replay, so every step gets a nonce of its own.
      const replay = createNodeCounter(20);
      for (const action of line ?? []) {
        const step = simulate(state, AI, action, replay);
        if (step === null || !step.ok) throw new Error(`the lethal line was refused at ${action.type}`);
        state = step.state;
      }
      expect(state.result?.winner).toBe(AI);
    }
  });

  it("with a limit of 0 it spends nothing and finds nothing", () => {
    const dets = worlds(lethalBoard(), "surface-lethal-zero", 2);
    const counter = createNodeCounter(AI_GATE_BUDGET.nodes);
    expect(findLethal(dets, AI, counter, 0)).toBeNull();
    expect(counter.used).toBe(0);
  });

  it("finds nothing on a board with no lethal, and stays within its limit", { timeout: 60_000 }, () => {
    const dets = worlds(quietTurn(), "surface-no-lethal", 2);
    const counter = createNodeCounter(AI_GATE_BUDGET.nodes);
    expect(findLethal(dets, AI, counter, AI_GATE_BUDGET.lethalNodes)).toBeNull();
    expect(counter.used).toBeLessThanOrEqual(AI_GATE_BUDGET.lethalNodes);
  });
});

// ---------------------------------------------------------------------------------------------
// decide.ts: the searched reasons
// ---------------------------------------------------------------------------------------------

describe("Surface: decide's searched decisions", () => {
  it('a searched main-phase decision has reason "search" and plays the first action of its planned line', { timeout: 60_000 }, () => {
    const state = quietTurn();
    const decision = decide(state, AI, { rng: createRng("surface-search"), budget: AI_GATE_BUDGET });
    if (decision === null) throw new Error("decide returned null in the AI's main phase");
    expect(decision.reason).toBe("search");
    expect(decision.line[0]).toEqual(decision.action);
    expect(decision.stats.lines).toBeGreaterThan(0);
    expect(decision.stats.determinizations).toBe(AI_GATE_BUDGET.determinizations);
    expect(isLegal(state, AI, decision.action)).toBe(true);
  });

  it('a searched answer to the seat\'s own prompt has reason "prompt"', { timeout: 60_000 }, () => {
    const s = scenario({
      seed: "surface-prompt",
      p1: { hand: ["core-072"], graveyard: ["core-008", "core-044", "core-005"], library: ["core-011"] },
      p2: { hand: ["core-005"], field: ["core-008"] },
    });
    s.play("core-072");
    const decision = decide(s.state, AI, { rng: createRng("surface-prompt"), budget: AI_GATE_BUDGET });
    expect(decision?.reason).toBe("prompt");
    expect(decision?.action.type).toBe("answer");
    expect(decision?.line[0]).toEqual(decision?.action);
  });
});

// ---------------------------------------------------------------------------------------------
// match.ts: one AI turn
// ---------------------------------------------------------------------------------------------

describe("Surface: playAiTurn", () => {
  it("plays decide's actions with nonces t0, t1, … until the AI owes nothing", { timeout: 60_000 }, () => {
    const start = scenario({
      seed: "surface-turn",
      active: AI,
      turn: TURN,
      p1: { hand: ["core-025", "core-011"], mana: 4, library: ["core-008", "core-011"] },
      p2: { library: ["core-008", "core-011"] },
    }).state;
    const turn = playAiTurn(start, AI, { rng: createRng("surface-turn"), budget: AI_GATE_BUDGET });

    expect(turn.actions.length).toBeGreaterThan(1);
    expect(turn.actions.length).toBe(turn.decisions.length);
    turn.actions.forEach((action, n) => {
      expect(action.nonce).toBe(`t${String(n)}`);
      expect(action.playerId).toBe(AI);
      const { playerId: _playerId, nonce: _nonce, ...body } = action;
      expect(body).toEqual(turn.decisions[n]?.action);
    });
    expect(aiToAct(turn.state, AI)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// sweep.ts: the clock
// ---------------------------------------------------------------------------------------------

describe("Surface: sweepCard's clock", () => {
  it("a decision the clock times at more than decisionMs raises the timeout flag", { timeout: 300_000 }, () => {
    let t = 0;
    const slow = (): number => {
      t += AI_SWEEP.decisionMs + 1;
      return t;
    };
    const result = sweepCard("core-011", { seeds: 1, now: slow });
    expect(result.games).toBe(1);
    expect(result.timeouts).toBeGreaterThan(0);
    expect(result.flags).toContain("timeout");
  });
});
