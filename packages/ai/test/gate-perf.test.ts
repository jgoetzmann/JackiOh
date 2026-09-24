// Quality gate: a decision at the browser's budget stays under AI_GATE.maxDecisionMs as the
// development machine would time it (docs/polish/3-ai.md "Budgets", SPEC §9.9). Budgets count
// nodes, so what a decision does is fixed and the node budget is asserted exactly; only its speed
// depends on the machine. The states are every decision the Easy AI faced in real gate games
// against the greedy baseline, the opponent's reply included.
//
// The clock is read against a yardstick, not on its own: a wall-clock limit failed whenever the
// machine was busy (1,520 ms in a full `pnpm test` at load 26, 5,523 ms beside an e2e run) and
// passed alone. So each run of a decision is timed right after a fixed piece of engine work
// (`AI_GATE.calibrationGames` random-policy games), and the decision's cost is its time over the
// yardstick's, times the yardstick's time on the development machine (`calibrationRefMs`). Load, or
// a slower CI runner, slows both, and the ratio stands. Each state is decided AI_GATE.perfRepeats
// times and its smallest ratio counts, so a burst of load during one run fails nothing, while a
// decision that is slow on its own still does.
//
// `pnpm test` times the decisions of AI_GATE.perfSmokeGames games; `pnpm ai:gate`
// (JACKIOH_AI_GATE=full) times AI_GATE.perfFullGames.
//
// Ordinary games seldom reach the worst case, so two hand-built wide boards are timed as well: five
// units a side and a hand of X-cost and targeted spells beside a Lava Golem, at Hard's seven
// crystals and at Easy's four. There the lethal solver's best-first walk runs to its allowance and
// every candidate list runs to hundreds of entries.

import { describe, expect, it } from "vitest";
import type { PlayerId } from "@jackioh/shared";
import { createRng, type GameState } from "@jackioh/engine";
import { AI_BUDGET, AI_GATE, candidateActions, decide, gameConfig, playMatch } from "../src/index";
import { scenario, type ScenarioOptions } from "./_support";

const FULL = process.env["JACKIOH_AI_GATE"] === "full";
const GAMES = FULL ? AI_GATE.perfFullGames : AI_GATE.perfSmokeGames;
/** Per-game allowance under load (the machine is shared), plus a fixed margin. */
const TIMEOUT = 60_000 + GAMES * 120_000;

type Timing = {
  /** The decision's cost on the development machine: its smallest ratio to the yardstick, in ms. */
  ms: number;
  /** The fastest run as this machine timed it, for the report. */
  rawMs: number;
  nodes: number;
  reason: string;
};
type Timed = Timing & { game: number; turn: number };

/** Every state the AI seat decided in ai-vs-greedy gate games 1..GAMES, played at AI_BUDGET. */
function decisionStates(): { game: number; seat: PlayerId; state: GameState }[] {
  const states: { game: number; seat: PlayerId; state: GameState }[] = [];
  for (let n = 1; n <= GAMES; n += 1) {
    const seat: PlayerId = n % 2 === 1 ? "p1" : "p2";
    playMatch(gameConfig("ai-vs-greedy", n, AI_BUDGET), {
      afterAction(before, _after, actor) {
        if (actor === seat) states.push({ game: n, seat, state: before });
      },
    });
  }
  return states;
}

/** The wide boards: p1 (the AI) to act on turn 9, no lethal on the board, hundreds of candidates. */
const WIDE_HAND = ["core-055", "core-024", "core-074", "core-035", "core-031", "core-044"];
const WIDE_FIELD = ["core-020", "core-008", "core-011", "core-045", "core-030"];
const WIDE_ENEMY = ["core-019", "core-025", "core-037", "core-032", "core-068"];
const WIDE_BOARDS: Record<string, ScenarioOptions> = {
  "wide-hard": { p1: { hand: WIDE_HAND, mana: 7, field: WIDE_FIELD }, p2: { field: WIDE_ENEMY, health: 30 } },
  "wide-easy": { p1: { hand: WIDE_HAND, mana: 4, field: WIDE_FIELD }, p2: { field: WIDE_ENEMY, health: 30 } },
};

/** The yardstick: a fixed piece of engine work, random-policy games played through `reduce`. */
function yardstickMs(): number {
  const started = performance.now();
  for (let n = 1; n <= AI_GATE.calibrationGames; n += 1) {
    const config = gameConfig("ai-vs-random", n, AI_BUDGET);
    playMatch({ ...config, controllers: { p1: { kind: "random" }, p2: { kind: "random" } } });
  }
  return performance.now() - started;
}

/**
 * AI_GATE.perfRepeats runs of one decision, each timed right after the yardstick: the smallest
 * ratio of the two, in the development machine's milliseconds, with the node count.
 */
function timeDecision(state: GameState, seat: PlayerId, rngSeed: string): Timing {
  let ratio = Number.POSITIVE_INFINITY;
  let rawMs = Number.POSITIVE_INFINITY;
  let nodes = 0;
  let reason = "";
  for (let k = 0; k < AI_GATE.perfRepeats; k += 1) {
    const unit = yardstickMs();
    const started = performance.now();
    const decision = decide(state, seat, { rng: createRng(rngSeed), budget: AI_BUDGET });
    const ms = performance.now() - started;
    ratio = Math.min(ratio, ms / unit);
    rawMs = Math.min(rawMs, ms);
    nodes = decision?.stats.nodes ?? 0;
    reason = decision?.reason ?? "none";
  }
  return { ms: ratio * AI_GATE.calibrationRefMs, rawMs, nodes, reason };
}

// The yardstick's first runs pay for compiling the engine; they are no measurement.
yardstickMs();

describe(`gate perf: one decision at AI_BUDGET (${FULL ? "full" : "smoke"}: ${GAMES} game(s))`, () => {
  it(`B42 every decision stays within the node budget and under ${AI_GATE.maxDecisionMs} ms`, { timeout: TIMEOUT }, () => {
    const timed: Timed[] = [];
    for (const { game, seat, state } of decisionStates()) {
      timed.push({ game, turn: state.turn, ...timeDecision(state, seat, `perf:${game}:${state.turn}`) });
    }

    expect(timed.length).toBeGreaterThan(0);
    for (const entry of timed) expect(entry.nodes, JSON.stringify(entry)).toBeLessThanOrEqual(AI_BUDGET.nodes);
    const slowest = timed.reduce((worst, entry) => (entry.ms > worst.ms ? entry : worst));
    expect(slowest.ms, `slowest decision: ${JSON.stringify(slowest)}`).toBeLessThan(AI_GATE.maxDecisionMs);
  });

  for (const [name, setup] of Object.entries(WIDE_BOARDS)) {
    it(`B42 a decision on the ${name} board stays within the node budget and under ${AI_GATE.maxDecisionMs} ms`, { timeout: 60_000 }, () => {
      const state = scenario({ seed: `perf-${name}`, active: "p1", turn: 9, ...setup }).state;
      // Wide enough to be the worst case the header describes: 232 candidates at Easy's four
      // crystals, 343 at Hard's seven. Easy's count was above 250 until task 4's
      // `TargetDecl.forModes` (R90) stopped listing Efficiency Dividend's mana mode once per target
      // it never reads.
      expect(candidateActions(state, "p1").length).toBeGreaterThan(200);
      const timed = timeDecision(state, "p1", `perf:${name}`);
      expect(timed.nodes, JSON.stringify(timed)).toBeLessThanOrEqual(AI_BUDGET.nodes);
      expect(timed.ms, `${name}: ${JSON.stringify(timed)}`).toBeLessThan(AI_GATE.maxDecisionMs);
    });
  }
});
