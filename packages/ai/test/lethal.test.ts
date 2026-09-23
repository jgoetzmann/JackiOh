// The lethal solver's two walks (lethal.ts, SPEC §9.9): a depth-first walk in move order for
// AI_SEARCH.lethalQuickNodes nodes, then a best-first walk by `readyGap` on the rest of the allowance.
// The board below is one the depth-first walk alone cannot solve in 150 nodes: the lethal starts with
// a Lava Golem that tributes both enemy Taunts, and the cheap targeted spells beside it put hundreds
// of lines ahead of that play in move order. The best-first walk tries the Golem's tributes by what
// they leave the attackers, and finds it.

import { describe, expect, it } from "vitest";
import type { ActionBody, PlayerId } from "@jackioh/shared";
import { createRng, type CardInstance, type GameState } from "@jackioh/engine";
import {
  AI_BUDGET,
  AI_SEARCH,
  createNodeCounter,
  determinize,
  findLethal,
  readyGap,
  redact,
  simulate,
} from "../src/index";
import { AI, HUMAN, everyCard, runPuzzle, scenario, trace } from "./_support";

/**
 * p1 (the AI) on turn 9 with 4 crystals: Pointmaster 7/2, Mr. Vanilla 3/3 and Tempo Timmy 3/3
 * ready on the field, Lava Golem, Lunar Eclipse and KY's Math Equation in hand. p2 stands behind two
 * Taunts, Midrange Menace 9/9 and a Lava Golem 10/5 with Armor 3, at 10 health. The one lethal:
 * Lava Golem tributes both enemy Taunts and one of the 3-attack units, then Pointmaster and the
 * other 3/3 hit the face for 10.
 */
const WIDE = {
  p1: { hand: ["core-055", "core-035", "core-031"], mana: 4, field: ["core-020", "core-008", "core-011"] },
  p2: { field: ["core-019", "core-055"], health: 10 },
};

function wideBoard(): GameState {
  return scenario({ seed: "lethal-wide", active: AI, turn: 9, ...WIDE }).state;
}

/** The one instance of `defId` that `player` controls, in hand or on the field. */
function mine(state: GameState, player: PlayerId, defId: string): CardInstance {
  const found = everyCard(state).filter((card) => card.defId === defId && card.controller === player);
  if (found.length !== 1) throw new Error(`${player} controls ${found.length} ${defId}`);
  return found[0] as CardInstance;
}

function worlds(state: GameState, seed: string, count: number): GameState[] {
  const rng = createRng(seed);
  const pub = redact(state, AI);
  return Array.from({ length: count }, () => determinize(pub, AI, rng));
}

/** Plays `line` on `state` through `simulate`; throws on a refusal. */
function playOut(state: GameState, line: readonly ActionBody[]): GameState {
  const counter = createNodeCounter(line.length * (1 + AI_SEARCH.maxAutoAnswers));
  let current = state;
  for (const action of line) {
    const step = simulate(current, AI, action, counter);
    if (step === null || !step.ok) throw new Error(`the line was refused at ${JSON.stringify(action)}`);
    current = step.state;
  }
  return current;
}

describe("the lethal solver's walks", () => {
  it("readyGap is the enemy hero's health less what the attacks left deal it past its Taunts", () => {
    const state = wideBoard();
    // Menace soaks 9: the three attackers (3, 3, 7) all go into it and nothing reaches the hero.
    expect(readyGap(state, AI)).toBe(10);

    const golem = mine(state, AI, "core-055");
    const menace = mine(state, HUMAN, "core-019");
    const enemyGolem = mine(state, HUMAN, "core-055");
    const vanilla = mine(state, AI, "core-008");
    const cleared = playOut(state, [
      { type: "play", instanceId: golem.id, zone: { row: "units", lane: 4 }, tributes: [vanilla.id, menace.id, enemyGolem.id] },
    ]);
    // No Taunt left, and Pointmaster (7) and Tempo Timmy (3) are still to attack: exactly lethal.
    // The new Golem has not been on the field a turn, so it adds nothing.
    expect(readyGap(cleared, AI)).toBe(0);
  });

  it("finds the Golem's tribute lethal on a wide hand within the allowance, and it wins on every world", { timeout: 60_000 }, () => {
    const dets = worlds(wideBoard(), "lethal-wide", 2);
    const counter = createNodeCounter(AI_BUDGET.nodes);
    const line = findLethal(dets, AI, counter, AI_BUDGET.lethalNodes);
    expect(line).not.toBeNull();
    expect(counter.used).toBeLessThanOrEqual(AI_BUDGET.lethalNodes);

    const first = (line ?? [])[0];
    expect(first?.type).toBe("play");
    const state = wideBoard();
    const enemyTaunts = [mine(state, HUMAN, "core-019").id, mine(state, HUMAN, "core-055").id];
    expect(first?.type === "play" ? first.tributes : []).toEqual(expect.arrayContaining(enemyTaunts));
    for (const det of dets) expect(playOut(det, line ?? []).result?.winner).toBe(AI);
  });

  it("stops after the depth-first walk when that walk searched the whole tree", () => {
    // One attacker into a 20-health hero, a 1-drop in hand: a handful of lines, none lethal.
    const state = scenario({
      seed: "lethal-small",
      active: AI,
      turn: 9,
      p1: { hand: ["core-008"], field: ["core-011"], mana: 3, library: ["core-008", "core-011"] },
      p2: { field: ["core-008"], library: ["core-008", "core-011"], health: 20 },
    }).state;
    const counter = createNodeCounter(AI_BUDGET.nodes);
    expect(findLethal(worlds(state, "lethal-small", 2), AI, counter, AI_BUDGET.lethalNodes)).toBeNull();
    expect(counter.used).toBeGreaterThan(0);
    expect(counter.used).toBeLessThan(AI_SEARCH.lethalQuickNodes);
  });

  it("a whole AI turn on the wide board kills the hero, lethal from the first decision", { timeout: 120_000 }, () => {
    const run = runPuzzle("lethal-wide", WIDE);
    expect(run.end.result?.winner, trace(run.turn)).toBe(AI);
    expect(run.turn.decisions[0]?.reason, trace(run.turn)).toBe("lethal");
  });
});
