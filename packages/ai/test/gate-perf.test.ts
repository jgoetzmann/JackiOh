// Quality gate: a decision at the browser's budget stays under AI_GATE.maxDecisionMs on the machine
// that runs the tests (docs/polish/3-ai.md "Budgets", SPEC §9.9). Budgets count nodes, so what a
// decision does is fixed; only its speed depends on the machine. The states are every decision the
// Easy AI faced in real gate games against the greedy baseline, the opponent's reply included.
//
// `pnpm test` times the decisions of AI_GATE.perfSmokeGames games; `pnpm ai:gate`
// (JACKIOH_AI_GATE=full) times AI_GATE.perfFullGames. Each state is decided AI_GATE.perfRepeats
// times and its fastest run counts, so a test runner sharing the machine with other work does not
// fail the gate on a context switch, while a decision that is slow on its own still does. The node
// budget is exact, and it is asserted too.

import { describe, expect, it } from "vitest";
import type { PlayerId } from "@jackioh/shared";
import { createRng, type GameState } from "@jackioh/engine";
import { AI_BUDGET, AI_GATE, decide, gameConfig, playMatch } from "../src/index";

const FULL = process.env["JACKIOH_AI_GATE"] === "full";
const GAMES = FULL ? AI_GATE.perfFullGames : AI_GATE.perfSmokeGames;
/** Per-game allowance under load (the machine is shared), plus a fixed margin. */
const TIMEOUT = 60_000 + GAMES * 120_000;

type Timed = { game: number; turn: number; ms: number; nodes: number; reason: string };

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

describe(`gate perf: one decision at AI_BUDGET (${FULL ? "full" : "smoke"}: ${GAMES} game(s))`, () => {
  it(`every decision stays within the node budget and under ${AI_GATE.maxDecisionMs} ms`, { timeout: TIMEOUT }, () => {
    const timed: Timed[] = [];
    for (const { game, seat, state } of decisionStates()) {
      let fastest = Number.POSITIVE_INFINITY;
      let nodes = 0;
      let reason = "";
      for (let k = 0; k < AI_GATE.perfRepeats; k += 1) {
        const started = performance.now();
        const decision = decide(state, seat, { rng: createRng(`perf:${game}:${state.turn}`), budget: AI_BUDGET });
        fastest = Math.min(fastest, performance.now() - started);
        nodes = decision?.stats.nodes ?? 0;
        reason = decision?.reason ?? "none";
      }
      timed.push({ game, turn: state.turn, ms: fastest, nodes, reason });
    }

    expect(timed.length).toBeGreaterThan(0);
    for (const entry of timed) expect(entry.nodes, JSON.stringify(entry)).toBeLessThanOrEqual(AI_BUDGET.nodes);
    const slowest = timed.reduce((worst, entry) => (entry.ms > worst.ms ? entry : worst));
    expect(slowest.ms, `slowest decision: ${JSON.stringify(slowest)}`).toBeLessThan(AI_GATE.maxDecisionMs);
  });
});
