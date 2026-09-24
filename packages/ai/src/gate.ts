// The quality gates (docs/polish/3-ai.md B28–B31, SPEC §9.9): three matchups, each a run of seeded
// games in which the subject (the AI, or the Hard AI) alternates seats, every game folded back from
// its log to prove it replays. The gate files in test/ turn a report into a pass or a fail; this
// module plays and measures, and says how many wins a run of a given size needs (`gateNeeded`), so
// a tuner can rerun one losing seed with `gameConfig(matchup, n)`.

import { opponentOf, type PlayerId } from "@jackioh/shared";
import { AI_DIFFICULTY, createRng, fold, hashState, type Handicap } from "@jackioh/engine";
import { AI_GATE_BUDGET } from "./config";
import { buildAiDeck } from "./deck";
import { playMatch, type MatchConfig, type MatchRecord, type SeatController } from "./match";
import type { SearchBudget } from "./types";

export type Matchup = "ai-vs-random" | "ai-vs-greedy" | "hard-vs-easy";

export const AI_GATE = {
  /**
   * The frozen seed series: game n of a matchup is `${seedSeries}:${matchup}:${n}`. No tuning run
   * plays it. The first series, `gate`, was also the strength pass's tuning set (its seeds 1–300
   * of ai-vs-greedy held the gate's own 50), so its result said as much about the tuning as about
   * the AI. Tuning plays `AI_TUNING_SERIES` instead (`scripts/bench.ts`), and this one is read only
   * by the gate.
   */
  seedSeries: "gate:v2",
  /**
   * What `pnpm test` runs per matchup (seeds 1..20), under the same rule as the full run
   * (`gateNeeded`: 17, 10 and 16 wins). At four games no count could tell a working AI from a broken
   * one.
   */
  smokeSeeds: 20,
  /** What `pnpm ai:gate` (JACKIOH_AI_GATE=full) runs. */
  fullSeeds: { "ai-vs-random": 100, "ai-vs-greedy": 50, "hard-vs-easy": 50 },
  /**
   * The brief's floors (docs/polish/reference.md, "Quality gates"): the share of its games the
   * subject is to win. Only wins count, in every gate; a draw at the turn cap is reported beside them.
   */
  briefRate: { "ai-vs-random": 0.95, "ai-vs-greedy": 0.7, "hard-vs-easy": 0.8 },
  /**
   * The subject's win rate as it ships, measured on tuning deals that no run had tuned on and no
   * gate plays (`tune` 3001–4000 for the Easy matchups, 3001–3300 for Hard against Easy): 945, 680
   * and 274 wins. Against greedy it is short of the brief. A new measurement of the same kind may
   * raise it; lowering it lowers every count below and needs the user's sign-off (SPEC §9.9).
   */
  measuredRate: { "ai-vs-random": 0.945, "ai-vs-greedy": 0.68, "hard-vs-easy": 0.913 },
  /**
   * The most often one gate run may fail an AI exactly as strong as `measuredRate` from the luck of
   * its deals alone. `gateNeeded` sets each count from it. Proposed in SPEC §9.9, pending the user's
   * acceptance.
   */
  falseAlarm: 0.05,
  /** SPEC §9.9: the most one decision at AI_BUDGET may take on the development machine. */
  maxDecisionMs: 1500,
  /** ai-vs-greedy games whose AI decisions the timing gate replays: `pnpm test`, then `pnpm ai:gate`. */
  perfSmokeGames: 1,
  perfFullGames: 6,
  /** Runs per decision; the fastest counts, so a context switch on a shared machine is not a failure. */
  perfRepeats: 3,
  /**
   * The timing gate's yardstick: random-policy games 1..calibrationGames of ai-vs-random, played
   * through `reduce`, a fixed piece of engine work timed beside every decision. A decision is judged
   * by its time over the yardstick's, so a slower or busier machine slows both and fails nothing.
   */
  calibrationGames: 2,
  /** The yardstick's time on the development machine, alone (the median of 25 runs, 2026-09-23). */
  calibrationRefMs: 72,
} as const satisfies {
  seedSeries: string;
  smokeSeeds: number;
  fullSeeds: Record<Matchup, number>;
  briefRate: Record<Matchup, number>;
  measuredRate: Record<Matchup, number>;
  falseAlarm: number;
  maxDecisionMs: number;
  perfSmokeGames: number;
  perfFullGames: number;
  perfRepeats: number;
  calibrationGames: number;
  calibrationRefMs: number;
};

/** The series tuning runs play (`scripts/bench.ts`'s default), so no tuned seed is a gate seed. */
export const AI_TUNING_SERIES = "tune";

type GateGame = {
  seed: string;
  subjectSeat: PlayerId;
  record: MatchRecord;
  won: boolean;
  replayHash: string;
  replayErrors: number;
};

/**
 * `wins` is what a gate holds against `gateNeeded`, and `rate` is wins / games. `turnCapDraws` is
 * reported beside them and counts for nothing.
 */
export type GateReport = { matchup: Matchup; games: GateGame[]; wins: number; turnCapDraws: number; rate: number };

/** P(X ≥ k) for X ~ Binomial(n, p), summed exactly over the distribution of n trials. */
export function binomialTail(n: number, p: number, k: number): number {
  let dist = [1];
  for (let trial = 0; trial < n; trial += 1) {
    const next = new Array<number>(dist.length + 1).fill(0);
    dist.forEach((q, wins) => {
      next[wins] = (next[wins] ?? 0) + q * (1 - p);
      next[wins + 1] = (next[wins + 1] ?? 0) + q * p;
    });
    dist = next;
  }
  return dist.slice(Math.max(0, k)).reduce((sum, q) => sum + q, 0);
}

/**
 * The wins a run of `games` games of `matchup` needs: the brief's share of them, or fewer where an
 * AI exactly as strong as `AI_GATE.measuredRate` would fall short of that more often than
 * `AI_GATE.falseAlarm` allows. That is the largest k with P(Binomial(games, measuredRate) ≥ k) ≥
 * 1 − falseAlarm, capped at ceil(briefRate × games) (SPEC §9.9).
 */
export function gateNeeded(matchup: Matchup, games: number): number {
  const measured = AI_GATE.measuredRate[matchup];
  let k = 0;
  while (k < games && binomialTail(games, measured, k + 1) >= 1 - AI_GATE.falseAlarm) k += 1;
  return Math.min(k, Math.ceil(AI_GATE.briefRate[matchup] * games));
}

/** Game n (1-based): the subject sits p1 when n is odd and p2 when n is even. */
function subjectSeatOf(n: number): PlayerId {
  return n % 2 === 1 ? "p1" : "p2";
}

/** The seat the subject plays against, per matchup. */
function opponentController(matchup: Matchup, budget: SearchBudget): SeatController {
  if (matchup === "ai-vs-random") return { kind: "random" };
  if (matchup === "ai-vs-greedy") return { kind: "greedy" };
  return { kind: "ai", budget };
}

/**
 * Game n (1-based) of a matchup: seed `${series}:${matchup}:${n}` (series AI_GATE.seedSeries unless
 * a tuner passes another); the subject (the AI, or the Hard AI) sits p1 when n is odd and p2 when
 * even. Every seat's deck is built by one rule, `buildAiDeck(createRng(`${seed}:deck:${seat}`), its
 * handicap's deckSize, { manaCap })`, the shadow ban (R186) included: the gates measure play, so
 * neither side is dealt cards the other side's rule keeps out. Handicaps: ai-vs-* use Easy for both
 * seats; hard-vs-easy gives the subject AI_DIFFICULTY.hard and the other AI_DIFFICULTY.easy.
 */
export function gameConfig(
  matchup: Matchup,
  n: number,
  budget: SearchBudget = AI_GATE_BUDGET,
  series: string = AI_GATE.seedSeries,
): MatchConfig {
  const seed = `${series}:${matchup}:${n}`;
  const subjectSeat = subjectSeatOf(n);
  const otherSeat = opponentOf(subjectSeat);

  const subjectHandicap = matchup === "hard-vs-easy" ? AI_DIFFICULTY.hard : AI_DIFFICULTY.easy;
  const otherHandicap = AI_DIFFICULTY.easy;

  const deckFor = (seat: PlayerId, handicap: Handicap): string[] =>
    buildAiDeck(createRng(`${seed}:deck:${seat}`), handicap.deckSize, { manaCap: handicap.manaCap });
  const subjectDeck = deckFor(subjectSeat, subjectHandicap);
  const otherDeck = deckFor(otherSeat, otherHandicap);

  const subjectController: SeatController = { kind: "ai", budget };
  const controllers =
    subjectSeat === "p1"
      ? { p1: subjectController, p2: opponentController(matchup, budget) }
      : { p1: opponentController(matchup, budget), p2: subjectController };

  return {
    seed,
    decks: subjectSeat === "p1" ? [subjectDeck, otherDeck] : [otherDeck, subjectDeck],
    handicaps:
      subjectSeat === "p1"
        ? { p1: subjectHandicap, p2: otherHandicap }
        : { p1: otherHandicap, p2: subjectHandicap },
    controllers,
  };
}

/** Plays games 1..seeds; each is folded with its handicaps to fill replayHash/replayErrors. */
export function runGate(matchup: Matchup, seeds: number, budget: SearchBudget = AI_GATE_BUDGET): GateReport {
  const games: GateGame[] = [];
  for (let n = 1; n <= seeds; n += 1) {
    const config = gameConfig(matchup, n, budget, AI_GATE.seedSeries);
    const subjectSeat = subjectSeatOf(n);
    const record = playMatch(config);

    const replayed = fold({ seed: config.seed, decks: config.decks, log: record.log, handicaps: config.handicaps });

    const result = record.result;
    games.push({
      seed: config.seed,
      subjectSeat,
      record,
      won: result !== null && result.winner === subjectSeat,
      replayHash: hashState(replayed.state),
      replayErrors: replayed.errors.length,
    });
  }

  const wins = games.filter((game) => game.won).length;
  const turnCapDraws = games.filter(
    (game) => game.record.result?.winner === "draw" && game.record.result.reason === "turn-cap",
  ).length;
  return { matchup, games, wins, turnCapDraws, rate: seeds > 0 ? wins / seeds : 0 };
}
