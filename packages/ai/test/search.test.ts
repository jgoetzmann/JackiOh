// Candidate moves and the search's contract (docs/polish/3-ai.md B14, B15).
//
// B14: `candidateActions` is `legalActions` minus the four action types the AI never searches
// (R84's concede, offerDraw and answerDraw, and the mulligan), with plays that differ only in their
// lane collapsed to the lowest and the highest, and endTurn last whenever it is legal.
//
// B15: `decide` is a pure function of (state, seat, rng seed, budget): the same inputs give a
// deep-equal Decision, it never spends more nodes than the budget, its action is always legal, and
// a wall clock that says stop at the first poll still yields a legal action instead of a throw.

import { describe, expect, it } from "vitest";
import type { ActionBody } from "@jackioh/shared";
import { createRng, hashState, legalActions, mulliganPromptFor, type GameState } from "@jackioh/engine";
import {
  AI_BUDGET,
  AI_GATE_BUDGET,
  actionKey,
  candidateActions,
  createNodeCounter,
  decide,
  type SearchBudget,
} from "../src/index";
import { AI, act, dealtGame, isLegal, scenario } from "./_support";

const SKIPPED: readonly string[] = ["concede", "offerDraw", "answerDraw", "mulligan"];

/** A mid-game p1 turn with plays in several lanes, a targeted spell, attacks and hidden p2 cards. */
function midGame(): GameState {
  return scenario({
    seed: "search-mid",
    p1: { hand: ["core-008", "core-035"], field: ["core-011"], library: ["core-020", "core-053"] },
    p2: {
      hand: ["core-005", "core-016"],
      field: ["core-008"],
      backrow: [{ def: "core-041", faceUp: false }],
      library: ["core-019", "core-047"],
      health: 20,
    },
  }).state;
}

/** A play with its zone removed: the "otherwise identical" key B14 groups by. */
function withoutZone(action: ActionBody): string {
  if (action.type !== "play") return actionKey(action);
  const { zone: _zone, ...rest } = action;
  return actionKey(rest);
}

function laneOf(action: ActionBody): number | null {
  return action.type === "play" && action.zone !== undefined ? action.zone.lane : null;
}

// ---------------------------------------------------------------------------------------------
// B14
// ---------------------------------------------------------------------------------------------

describe("candidateActions (B14)", () => {
  it("B14: actionKey is canonical: key order does not matter, and different actions differ", () => {
    expect(actionKey({ type: "attack", attackerId: "c1", targetId: "hero-p2" })).toBe(
      actionKey({ targetId: "hero-p2", attackerId: "c1", type: "attack" } as ActionBody),
    );
    expect(actionKey({ type: "attack", attackerId: "c1", targetId: "hero-p2" })).not.toBe(
      actionKey({ type: "attack", attackerId: "c1", targetId: "c9" }),
    );
    expect(actionKey({ type: "play", instanceId: "c1", zone: { row: "units", lane: 2 } })).not.toBe(
      actionKey({ type: "play", instanceId: "c1", zone: { row: "units", lane: 3 } }),
    );
  });

  it("B14: is legalActions minus concede, offerDraw, answerDraw and mulligan, zones collapsed, endTurn last", () => {
    const state = midGame();
    const legal = legalActions(state, AI);
    const candidates = candidateActions(state, AI);
    const legalKeys = new Set(legal.map(actionKey));

    // Nothing that is not legal, and none of the four skipped types.
    for (const action of candidates) {
      expect(legalKeys.has(actionKey(action)), JSON.stringify(action)).toBe(true);
      expect(SKIPPED).not.toContain(action.type);
    }
    // No duplicates.
    expect(new Set(candidates.map(actionKey)).size).toBe(candidates.length);

    // Every legal non-play action of a kept type is a candidate.
    const candidateKeys = new Set(candidates.map(actionKey));
    for (const action of legal) {
      if (action.type === "play" || SKIPPED.includes(action.type)) continue;
      expect(candidateKeys.has(actionKey(action)), JSON.stringify(action)).toBe(true);
    }

    // Plays: per otherwise-identical play, exactly the lowest and the highest lane legal offers.
    const groups = new Map<string, ActionBody[]>();
    for (const action of legal) {
      if (action.type !== "play") continue;
      const key = withoutZone(action);
      groups.set(key, [...(groups.get(key) ?? []), action]);
    }
    expect([...groups.values()].some((group) => group.length > 2), "some play is offered in 3+ lanes").toBe(true);
    for (const [key, group] of groups) {
      const offered = candidates.filter((action) => action.type === "play" && withoutZone(action) === key);
      const lanes = group.map(laneOf).filter((lane): lane is number => lane !== null);
      if (lanes.length === 0) {
        expect(offered.map(actionKey), key).toEqual(group.map(actionKey));
        continue;
      }
      const expected = [...new Set([Math.min(...lanes), Math.max(...lanes)])].sort((x, y) => x - y);
      expect(offered.map(laneOf).sort((x, y) => (x ?? 0) - (y ?? 0)), key).toEqual(expected);
    }

    // endTurn is last, once.
    expect(candidates.filter((action) => action.type === "endTurn")).toHaveLength(1);
    expect(candidates.at(-1)).toEqual({ type: "endTurn" });
  });

  it("B14: a play with one free lane keeps that lane, and one with two free lanes keeps both", () => {
    const one = scenario({
      seed: "search-one-lane",
      p1: { hand: ["core-008"], field: ["core-011", "core-020", "core-019", "core-025"] },
      p2: { hand: ["core-005"] },
    }).state;
    const oneLanes = candidateActions(one, AI).filter((action) => action.type === "play").map(laneOf);
    expect(oneLanes).toEqual([5]);

    const two = scenario({
      seed: "search-two-lanes",
      p1: { hand: ["core-008"], field: ["core-011", "core-020", "core-019"] },
      p2: { hand: ["core-005"] },
    }).state;
    const twoLanes = candidateActions(two, AI)
      .filter((action) => action.type === "play")
      .map(laneOf)
      .sort((x, y) => (x ?? 0) - (y ?? 0));
    expect(twoLanes).toEqual([4, 5]);
  });

  it("B14: an attack on the enemy hero leads, plays come before position switches, and endTurn trails", () => {
    const state = midGame();
    const candidates = candidateActions(state, AI);
    const first = candidates[0];
    expect(first?.type).toBe("attack");
    expect(first?.type === "attack" ? first.targetId : null).toBe("hero-p2");

    const lastPlay = Math.max(...candidates.flatMap((action, at) => (action.type === "play" ? [at] : [])));
    const firstSwitch = candidates.findIndex((action) => action.type === "switchPosition");
    if (firstSwitch >= 0) expect(firstSwitch).toBeGreaterThan(lastPlay);
    expect(candidates.findIndex((action) => action.type === "endTurn")).toBe(candidates.length - 1);
  });

  it("B14: a seat answering its own prompt gets exactly the prompt's answers and no endTurn", () => {
    const s = scenario({
      seed: "search-prompt",
      p1: { hand: ["core-072"], graveyard: ["core-044", "core-008", "core-005"], library: ["core-011"] },
      p2: { hand: ["core-005"] },
    });
    s.play("core-072");
    const state = s.state;
    expect(state.pending?.playerId).toBe(AI);

    const candidates = candidateActions(state, AI);
    // R211 offers concede beside the prompt's answers, and the AI never takes it (R84, R188).
    const answers = legalActions(state, AI).filter((action) => action.type !== "concede");
    expect(candidates.map(actionKey).sort()).toEqual(answers.map(actionKey).sort());
    expect(candidates.every((action) => action.type === "answer")).toBe(true);
    expect(candidates).toHaveLength(3);
  });

  it("B14: during the mulligan there is no candidate, since the mulligan is not searched", () => {
    const state = dealtGame("search-mulligan");
    expect(mulliganPromptFor(state, AI)?.kind).toBe("mulligan");
    expect(legalActions(state, AI).length).toBeGreaterThan(0);
    expect(candidateActions(state, AI)).toEqual([]);
  });

  it("B14: a seat facing an opponent's draw offer on the opponent's turn has no candidate", () => {
    const s = scenario({ seed: "search-offer", active: "p2", turn: 10, p1: { hand: ["core-008"] }, p2: { hand: ["core-011"] } });
    const offered = act(s.state, "p2", { type: "offerDraw" });
    expect(legalActions(offered, AI).some((action) => action.type === "answerDraw")).toBe(true);
    expect(candidateActions(offered, AI)).toEqual([]);
  });

  it("B14: a finished game has no candidate for either seat", () => {
    const s = scenario({ seed: "search-over", p1: { field: ["core-011"], hand: ["core-008"] }, p2: { health: 3, hand: ["core-005"] } });
    s.attack("core-011", "hero");
    expect(s.state.result).not.toBeNull();
    expect(candidateActions(s.state, AI)).toEqual([]);
    expect(candidateActions(s.state, "p2")).toEqual([]);
  });

  it("B14: on the opponent's turn with nothing to answer there is no candidate", () => {
    const state = scenario({ seed: "search-idle", active: "p2", turn: 10, p1: { hand: ["core-008"] } }).state;
    expect(candidateActions(state, AI)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// B15
// ---------------------------------------------------------------------------------------------

describe("decide's determinism and budget (B15)", () => {
  for (const [name, budget] of [
    ["AI_GATE_BUDGET", AI_GATE_BUDGET],
    ["AI_BUDGET", AI_BUDGET],
  ] as const) {
    it(`B15: at ${name} the same state, seat, rng seed and budget give a deep-equal, legal, in-budget decision`, { timeout: 120_000 }, () => {
      const state = midGame();
      const before = hashState(state);
      const first = decide(state, AI, { rng: createRng("search-b15"), budget });
      const second = decide(state, AI, { rng: createRng("search-b15"), budget });

      expect(first).not.toBeNull();
      expect(second).toEqual(first);
      const decision = first as NonNullable<typeof first>;
      expect(decision.stats.nodes).toBeLessThanOrEqual(budget.nodes);
      expect(decision.stats.nodes).toBeGreaterThan(0);
      expect(isLegal(state, AI, decision.action)).toBe(true);
      expect(decision.line.length).toBeGreaterThan(0);
      expect(actionKey(decision.line[0] as ActionBody)).toBe(actionKey(decision.action));
      // decide read the state and changed nothing.
      expect(hashState(state)).toBe(before);
    });
  }

  it("B15: omitting the budget is AI_BUDGET", { timeout: 120_000 }, () => {
    const state = midGame();
    const implicit = decide(state, AI, { rng: createRng("search-default") });
    const explicit = decide(state, AI, { rng: createRng("search-default"), budget: AI_BUDGET });
    expect(implicit).toEqual(explicit);
  });

  it("B15: a clock that says stop at the first poll still gives a legal action, stopped by the clock, with no node spent", () => {
    const state = midGame();
    let polls = 0;
    const decision = decide(state, AI, {
      rng: createRng("search-clock"),
      budget: AI_GATE_BUDGET,
      shouldStop: () => {
        polls += 1;
        return true;
      },
    });
    expect(decision).not.toBeNull();
    expect(polls).toBeGreaterThan(0);
    expect(decision?.stats.stoppedBy).toBe("clock");
    expect(decision?.stats.nodes).toBe(0);
    expect(isLegal(state, AI, (decision as NonNullable<typeof decision>).action)).toBe(true);
  });

  it("B15: a clock that stops after N polls caps the nodes at N", { timeout: 60_000 }, () => {
    const state = midGame();
    const limit = 25;
    let polls = 0;
    const decision = decide(state, AI, {
      rng: createRng("search-clock-n"),
      budget: AI_BUDGET,
      shouldStop: () => {
        polls += 1;
        return polls > limit;
      },
    });
    expect(decision?.stats.stoppedBy).toBe("clock");
    expect(decision?.stats.nodes).toBeLessThanOrEqual(limit);
    expect(isLegal(state, AI, (decision as NonNullable<typeof decision>).action)).toBe(true);
  });

  it("B15: a budget of zero nodes falls back to endTurn, stopped by the budget", () => {
    const state = midGame();
    const empty: SearchBudget = { ...AI_GATE_BUDGET, nodes: 0, lethalNodes: 0 };
    const decision = decide(state, AI, { rng: createRng("search-empty"), budget: empty });
    expect(decision?.reason).toBe("fallback");
    expect(decision?.action).toEqual({ type: "endTurn" });
    expect(decision?.stats.nodes).toBe(0);
    expect(decision?.stats.stoppedBy).toBe("budget");
  });

  it("B15: the smallest search (one world, a beam of one, one step deep) still gives a legal, in-budget decision", () => {
    const state = midGame();
    const tiny: SearchBudget = {
      nodes: 12,
      lethalNodes: 2,
      determinizations: 1,
      beamWidth: 1,
      rootBranching: 1,
      branching: 1,
      maxDepth: 1,
      finalists: 1,
    };
    const decision = decide(state, AI, { rng: createRng("search-tiny"), budget: tiny });
    expect(decision).not.toBeNull();
    expect(decision?.stats.nodes).toBeLessThanOrEqual(tiny.nodes);
    expect(isLegal(state, AI, (decision as NonNullable<typeof decision>).action)).toBe(true);
  });

  it("B15: with no lethal budget the solver finds nothing, yet a lethal board still gets a legal decision", { timeout: 60_000 }, () => {
    const state = scenario({ seed: "search-no-lethal", p1: { field: ["core-011", "core-008"] }, p2: { health: 6 } }).state;
    const budget: SearchBudget = { ...AI_GATE_BUDGET, lethalNodes: 0 };
    const decision = decide(state, AI, { rng: createRng("search-no-lethal"), budget });
    expect(decision?.reason).not.toBe("lethal");
    expect(decision?.stats.nodes).toBeLessThanOrEqual(budget.nodes);
    expect(isLegal(state, AI, (decision as NonNullable<typeof decision>).action)).toBe(true);
  });

  it("B15: decide never throws on a state whose hidden cards it cannot know, across many rng seeds", { timeout: 120_000 }, () => {
    const state = midGame();
    for (let k = 0; k < 6; k += 1) {
      const decision = decide(state, AI, { rng: createRng(`search-many:${k}`), budget: AI_GATE_BUDGET });
      expect(decision, `seed ${k}`).not.toBeNull();
      expect(isLegal(state, AI, (decision as NonNullable<typeof decision>).action), `seed ${k}`).toBe(true);
      expect(decision?.stats.nodes, `seed ${k}`).toBeLessThanOrEqual(AI_GATE_BUDGET.nodes);
    }
  });

  it("B15: the node counter grants exactly its limit, then reports the budget", () => {
    const counter = createNodeCounter(3);
    expect([counter.take(), counter.take(), counter.take()]).toEqual([true, true, true]);
    expect(counter.take()).toBe(false);
    expect(counter.used).toBe(3);
    expect(counter.limit).toBe(3);
    expect(counter.stoppedBy).toBe("budget");

    const none = createNodeCounter(0);
    expect(none.take()).toBe(false);
    expect(none.used).toBe(0);
  });

  it("B15: the node counter polls the clock before each node and reports it", () => {
    let polls = 0;
    const counter = createNodeCounter(10, () => {
      polls += 1;
      return polls > 2;
    });
    expect(counter.take()).toBe(true);
    expect(counter.take()).toBe(true);
    expect(counter.take()).toBe(false);
    expect(counter.used).toBe(2);
    expect(counter.stoppedBy).toBe("clock");
  });
});
