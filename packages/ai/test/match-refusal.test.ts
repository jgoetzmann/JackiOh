// What `playMatch` does when a controller misbehaves (docs/polish/3-ai.md §Surface, match.ts): "A
// refused action is recorded in `rejected` and replaced by endTurn (or the first legal answer); a
// throw is recorded and ends the match", and a controller that returns nothing is counted in
// `fallbacks` and replaced by the random policy. No real controller does any of this (the gates
// insist on zero of each), so this file scripts the baselines: `randomAction` or `greedyAction`
// misbehaves once, at the first main phase the scripted seat owns, and is the real one otherwise.

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActionBody } from "@jackioh/shared";
import { opponentOf } from "@jackioh/shared";
import { fold, hashState, type GameState } from "@jackioh/engine";
import { playMatch, type MatchConfig, type MatchRecord } from "../src/index";
import { randomDecks } from "./_support";

type Misbehaviour = "none" | "refuse" | "throw" | "null";

const plan = vi.hoisted(() => ({
  mode: "none" as Misbehaviour,
  /** The state the scripted controller misbehaved on, once it has. */
  firedOn: null as unknown,
}));

vi.mock("../src/baselines", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/baselines")>();
  const due = (state: GameState, seat: string): boolean =>
    plan.firedOn === null && state.phase === "main" && state.pending === null && state.active === seat;
  return {
    ...real,
    randomAction: (...args: Parameters<typeof real.randomAction>) => {
      const [state, seat] = args;
      const action = real.randomAction(...args);
      if ((plan.mode === "refuse" || plan.mode === "throw") && due(state, seat)) {
        plan.firedOn = state;
        if (plan.mode === "throw") throw new Error("scripted controller failure");
        const bogus: ActionBody = { type: "attack", attackerId: "no-such-unit", targetId: `hero-${opponentOf(seat)}` };
        return bogus;
      }
      return action;
    },
    greedyAction: (...args: Parameters<typeof real.greedyAction>) => {
      const [state, seat] = args;
      if (plan.mode === "null" && due(state, seat)) {
        plan.firedOn = state;
        return null;
      }
      return real.greedyAction(...args);
    },
  };
});

beforeEach(() => {
  plan.mode = "none";
  plan.firedOn = null;
});

function config(seed: string, p1: "random" | "greedy"): MatchConfig {
  return {
    seed,
    decks: randomDecks(seed),
    controllers: { p1: { kind: p1 }, p2: { kind: "random" } },
  };
}

function expectFolds(cfg: MatchConfig, record: MatchRecord): void {
  const replayed = fold({ seed: cfg.seed, decks: cfg.decks, log: record.log });
  expect(replayed.errors).toEqual([]);
  expect(hashState(replayed.state)).toBe(record.hash);
}

describe("Surface: playMatch when a controller misbehaves", () => {
  it("a refused action is recorded in `rejected` and replaced by endTurn, and the match plays on and replays", { timeout: 60_000 }, () => {
    plan.mode = "refuse";
    const cfg = config("refusal-endturn", "random");
    let replacement: ActionBody | null = null;
    const record = playMatch(cfg, {
      afterAction(before, _after, seat, action) {
        if (before === plan.firedOn && seat === "p1") replacement = action;
      },
    });

    expect(plan.firedOn).not.toBeNull();
    expect(record.rejected).toHaveLength(1);
    expect(record.rejected[0]).toEqual({
      seat: "p1",
      action: { type: "attack", attackerId: "no-such-unit", targetId: "hero-p2" },
      error: expect.any(String),
    });
    expect(replacement).toEqual({ type: "endTurn" });
    expect(record.thrown).toEqual([]);
    expect(record.result).not.toBeNull();
    expectFolds(cfg, record);
  });

  it("a controller that throws is recorded in `thrown` and ends the match with no result", { timeout: 60_000 }, () => {
    plan.mode = "throw";
    const cfg = config("refusal-throw", "random");
    const record = playMatch(cfg);

    expect(record.thrown).toHaveLength(1);
    expect(record.thrown[0]?.seat).toBe("p1");
    expect(record.thrown[0]?.message).toContain("scripted controller failure");
    expect(record.result).toBeNull();
    expect(record.rejected).toEqual([]);
    // The log stops at the throw, and what it holds still replays to the record's hash.
    expectFolds(cfg, record);
  });

  it("a controller that returns nothing counts one fallback and the random policy moves for it", { timeout: 60_000 }, () => {
    plan.mode = "null";
    const cfg = config("refusal-null", "greedy");
    const record = playMatch(cfg);

    expect(plan.firedOn).not.toBeNull();
    expect(record.fallbacks).toBe(1);
    expect(record.rejected).toEqual([]);
    expect(record.thrown).toEqual([]);
    expect(record.result).not.toBeNull();
    expectFolds(cfg, record);
  });
});
