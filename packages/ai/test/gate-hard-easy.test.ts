// Quality gate: the same AI with Hard's handicap against itself on Easy (docs/polish/3-ai.md B30, B31).
//
// R180: the tiers differ in resources alone, so the only thing separating the two seats here is
// the handicap. The Hard seat (the subject) must win at least AI_GATE.minWinRate["hard-vs-easy"]
// of its games, seats alternating, both AIs at AI_GATE_BUDGET. `pnpm test` plays the smoke size
// (AI_GATE.smokeSeeds); `pnpm ai:gate` sets JACKIOH_AI_GATE=full and plays
// AI_GATE.fullSeeds["hard-vs-easy"]. The test passes iff wins >= ceil(minWinRate × n), and a
// failure names the losing seeds, which replay exactly through `gameConfig("hard-vs-easy", n)`.
// Every game also has to be clean (B31): nothing rejected, nothing thrown, no fallback, a real
// result, and a log that folds back to the live hash.

import { describe, expect, it } from "vitest";
import { AI_DIFFICULTY, HUMAN_HANDICAP, createRng, type Handicap } from "@jackioh/engine";
import {
  AI_GATE,
  AI_GATE_BUDGET,
  buildAiDeck,
  gameConfig,
  runGate,
  type GateReport,
  type Matchup,
} from "../src/index";

const MATCHUP: Matchup = "hard-vs-easy";
const FULL = process.env["JACKIOH_AI_GATE"] === "full";
const GAMES = FULL ? AI_GATE.fullSeeds[MATCHUP] : AI_GATE.smokeSeeds;
const NEEDED = Math.ceil(AI_GATE.minWinRate[MATCHUP] * GAMES);
/** Per-game allowance under load (the machine is shared), plus a fixed margin. */
const TIMEOUT = 60_000 + GAMES * 45_000;

let cached: GateReport | undefined;
function report(): GateReport {
  cached ??= runGate(MATCHUP, GAMES, AI_GATE_BUDGET);
  return cached;
}

function losingSeeds(gate: GateReport): string {
  return gate.games
    .filter((game) => !game.won)
    .map((game) => `${game.seed} (${game.subjectSeat}, ${JSON.stringify(game.record.result)})`)
    .join(", ");
}

describe(`gate ${MATCHUP} (${FULL ? "full" : "smoke"}: ${GAMES} games)`, () => {
  it("R180 B30: gameConfig seats Hard's handicap against Easy's, the same AI and budget on both, alternating seats", () => {
    for (const n of [1, 2, 3]) {
      const config = gameConfig(MATCHUP, n, AI_GATE_BUDGET);
      const seed = `${AI_GATE.seedSeries}:${MATCHUP}:${n}`;
      const subject = n % 2 === 1 ? "p1" : "p2";
      const other = subject === "p1" ? "p2" : "p1";
      const hard: Handicap = AI_DIFFICULTY.hard;
      const easy: Handicap = AI_DIFFICULTY.easy;

      expect(config.seed).toBe(seed);
      expect(config.controllers[subject]).toEqual({ kind: "ai", budget: AI_GATE_BUDGET });
      expect(config.controllers[other]).toEqual({ kind: "ai", budget: AI_GATE_BUDGET });
      expect(config.handicaps?.[subject] ?? HUMAN_HANDICAP).toEqual(hard);
      expect(config.handicaps?.[other] ?? HUMAN_HANDICAP).toEqual(easy);

      const at = (seat: "p1" | "p2"): number => (seat === "p1" ? 0 : 1);
      expect(config.decks[at(subject)]).toHaveLength(hard.deckSize);
      expect(config.decks[at(other)]).toHaveLength(easy.deckSize);
      expect(config.decks[at(subject)]).toEqual(
        buildAiDeck(createRng(`${seed}:deck:${subject}`), hard.deckSize, { manaCap: hard.manaCap }),
      );
      expect(config.decks[at(other)]).toEqual(
        buildAiDeck(createRng(`${seed}:deck:${other}`), easy.deckSize, { manaCap: easy.manaCap }),
      );
    }
  });

  it(`B30: the Hard AI wins at least ${NEEDED} of ${GAMES} games against itself on Easy`, { timeout: TIMEOUT }, () => {
    const gate = report();
    expect(gate.matchup).toBe(MATCHUP);
    expect(gate.games).toHaveLength(GAMES);
    gate.games.forEach((game, at) => {
      expect(game.seed).toBe(`${AI_GATE.seedSeries}:${MATCHUP}:${at + 1}`);
      expect(game.subjectSeat).toBe(at % 2 === 0 ? "p1" : "p2");
      expect(game.won).toBe(game.record.result?.winner === game.subjectSeat);
    });
    expect(gate.wins).toBe(gate.games.filter((game) => game.won).length);
    expect(gate.rate).toBeCloseTo(gate.wins / GAMES, 10);
    expect(gate.wins, `losing seeds: ${losingSeeds(gate)}`).toBeGreaterThanOrEqual(NEEDED);
  });

  it("B31: every game is clean: nothing rejected or thrown, no fallback, a result, and a replay that matches", { timeout: TIMEOUT }, () => {
    const gate = report();
    expect(gate.games).toHaveLength(GAMES);
    for (const game of gate.games) {
      const label = `${game.seed} (${game.subjectSeat})`;
      expect(game.record.rejected, label).toEqual([]);
      expect(game.record.thrown, label).toEqual([]);
      expect(game.record.fallbacks, label).toBe(0);
      expect(game.record.result, label).not.toBeNull();
      expect(game.replayErrors, label).toBe(0);
      expect(game.replayHash, label).toBe(game.record.hash);
    }
  });
});
