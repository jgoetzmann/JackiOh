// R290: the tutorial's opponent is easier than Easy, by play (SPEC §9.9, R180).
//
// The tutorial deals its AI seat AI_TUTORIAL: a 12-card deck, at most 3 mana crystals and a hero at
// 20. The AI itself is the one every tier plays (same search, evaluation and budget), so the tier is
// only easier if those resources make it lose more, and this file plays games to show that they do.
// The human's stand-in is the greedy baseline (the one gate-greedy.test.ts measures the AI against)
// at a human's resources. It has to beat the AI at AI_TUTORIAL in most games, and on the same seeds
// it has to beat the tutorial AI more often than it beats the AI at Easy (a human's resources
// exactly, R180).
//
// Game n plays seed `${TUTORIAL_TIER.series}:greedy:${n}` at both tiers, so the greedy seat, its
// deck and the game's rng stream are the same at both, and only the AI seat's handicap and deck
// differ. Greedy sits p1 when n is odd. Both seats are dealt by the gates' one rule (gate.ts's
// `gameConfig`), `buildAiDeck(createRng(`${seed}:deck:${seat}`), the seat's deckSize, { manaCap })`,
// with the shadow ban (R186) on both sides. Every game has to be clean and fold back to its hash,
// as the gates' games do (B31).
//
// Measured on this series at AI_GATE_BUDGET, 100 games per tier (seeds 1–100): greedy won 74 against
// AI_TUTORIAL (the AI won 24, 2 were turn-cap draws) and 27 against Easy (the AI won 63, 10 draws).
// Against Easy that is the gates' measured rate again (the AI wins 68% against greedy, SPEC §9.9).
// §10.7's random policy, on `${series}:random:${n}` the same way, won 17 of 100 against AI_TUTORIAL
// and 2 of 100 against Easy. Random is not asserted: a run small enough for `pnpm test` holds too
// few of its wins to tell the tiers apart.

import { describe, expect, it } from "vitest";
import { opponentOf, type PlayerId } from "@jackioh/shared";
import {
  AI_DIFFICULTY,
  AI_TUTORIAL,
  DECK_SIZE,
  HUMAN_HANDICAP,
  createRng,
  fold,
  hashState,
  type Handicap,
} from "@jackioh/engine";
import { AI_GATE_BUDGET, buildAiDeck, playMatch, type MatchConfig, type MatchRecord } from "../src/index";

/**
 * Every number this file states (CLAUDE.md rule 9). The runs are frozen, so they pass or fail the
 * same way every time; the thresholds sit below what was measured so that a change which re-deals
 * every game (as The Coin did, R244) still passes when the tier is as much easier as measured. At the
 * measured rates a re-dealt run fails the first threshold about 3 times in 100 and the second about
 * 4, near the 5 the gates allow (SPEC §9.9).
 */
const TUTORIAL_TIER = {
  /** The frozen seed series; no gate or tuning run plays it. */
  series: "tutorial-tier",
  /** Games 1..tutorialGames against the AI at AI_TUTORIAL. */
  tutorialGames: 13,
  /**
   * Greedy's wins against AI_TUTORIAL the run needs: a majority of its 13. Measured: 11 of these 13
   * (74 of 100 on seeds 1–100, where a re-dealt run of 13 reaches 7 about 97 times in 100).
   */
  greedyWinsVsTutorial: 7,
  /**
   * Games 1..easyGames are played at Easy too, for the comparison on the same seeds. An Easy game
   * costs the AI more than twice the search of a tutorial one (4 crystals give it more to try), so
   * this is kept smaller than tutorialGames.
   */
  easyGames: 8,
  /**
   * How many more of seeds 1..easyGames greedy wins against AI_TUTORIAL than against Easy. Measured:
   * 8 against 3 (74 against 27 on seeds 1–100, where a re-dealt run of 8 keeps AI_TUTORIAL ahead
   * about 96 times in 100).
   */
  greedyMarginOverEasy: 1,
  /** Per-game allowance under load (the machine is shared), plus a fixed margin, as the gates allow. */
  msPerGame: 45_000,
  msFixed: 60_000,
} as const;

type Tier = "tutorial" | "easy";

const TIER_HANDICAP: Record<Tier, Handicap> = { tutorial: AI_TUTORIAL, easy: AI_DIFFICULTY.easy };
const TIER_GAMES: Record<Tier, number> = { tutorial: TUTORIAL_TIER.tutorialGames, easy: TUTORIAL_TIER.easyGames };

const TIMEOUT =
  TUTORIAL_TIER.msFixed + (TUTORIAL_TIER.tutorialGames + TUTORIAL_TIER.easyGames) * TUTORIAL_TIER.msPerGame;

/** Game n (1-based): the greedy seat, standing in for the human, sits p1 when n is odd. */
function humanSeatOf(n: number): PlayerId {
  return n % 2 === 1 ? "p1" : "p2";
}

/** Game n of the greedy baseline against the AI at `tier`. */
function tierGame(tier: Tier, n: number): MatchConfig {
  const seed = `${TUTORIAL_TIER.series}:greedy:${String(n)}`;
  const humanSeat = humanSeatOf(n);
  const aiSeat = opponentOf(humanSeat);
  const aiHandicap = TIER_HANDICAP[tier];

  const deckFor = (seat: PlayerId, handicap: Handicap): string[] =>
    buildAiDeck(createRng(`${seed}:deck:${seat}`), handicap.deckSize, { manaCap: handicap.manaCap });
  const humanDeck = deckFor(humanSeat, HUMAN_HANDICAP);
  const aiDeck = deckFor(aiSeat, aiHandicap);

  return {
    seed,
    decks: humanSeat === "p1" ? [humanDeck, aiDeck] : [aiDeck, humanDeck],
    // The greedy seat plays with no handicap (R180); at Easy the AI seat stores none either.
    handicaps: { [aiSeat]: aiHandicap },
    controllers:
      humanSeat === "p1"
        ? { p1: { kind: "greedy" }, p2: { kind: "ai", budget: AI_GATE_BUDGET } }
        : { p1: { kind: "ai", budget: AI_GATE_BUDGET }, p2: { kind: "greedy" } },
  };
}

type TierGame = {
  n: number;
  config: MatchConfig;
  record: MatchRecord;
  humanWon: boolean;
  replayHash: string;
  replayErrors: number;
};

const played: Partial<Record<Tier, TierGame[]>> = {};

/** Plays games 1..TIER_GAMES[tier] at `tier`, once per file, each folded back from its log. */
function run(tier: Tier): TierGame[] {
  const cached = played[tier];
  if (cached !== undefined) return cached;
  const games: TierGame[] = [];
  for (let n = 1; n <= TIER_GAMES[tier]; n += 1) {
    const config = tierGame(tier, n);
    const record = playMatch(config);
    const replayed = fold({ seed: config.seed, decks: config.decks, log: record.log, handicaps: config.handicaps });
    games.push({
      n,
      config,
      record,
      humanWon: record.result !== null && record.result.winner === humanSeatOf(n),
      replayHash: hashState(replayed.state),
      replayErrors: replayed.errors.length,
    });
  }
  played[tier] = games;
  return games;
}

/** Greedy's wins among games 1..upTo. */
function winsOf(games: readonly TierGame[], upTo: number = games.length): number {
  return games.filter((game) => game.n <= upTo && game.humanWon).length;
}

function notWon(games: readonly TierGame[]): string {
  return games
    .filter((game) => !game.humanWon)
    .map((game) => `${game.config.seed} (greedy ${humanSeatOf(game.n)}, ${JSON.stringify(game.record.result)})`)
    .join(", ");
}

describe(`R290 the tutorial tier by play (${String(TUTORIAL_TIER.tutorialGames)} games at AI_TUTORIAL, ${String(TUTORIAL_TIER.easyGames)} at Easy)`, () => {
  it("R290 tierGame seats greedy at a human's resources against the AI at AI_TUTORIAL or Easy, on the same seed, seats alternating", () => {
    expect(TUTORIAL_TIER.easyGames).toBeLessThanOrEqual(TUTORIAL_TIER.tutorialGames);
    for (const n of [1, 2, 3]) {
      const humanSeat = humanSeatOf(n);
      const aiSeat = opponentOf(humanSeat);
      const at = (seat: PlayerId): number => (seat === "p1" ? 0 : 1);
      const tutorial = tierGame("tutorial", n);
      const easy = tierGame("easy", n);

      expect(tutorial.seed).toBe(`${TUTORIAL_TIER.series}:greedy:${String(n)}`);
      expect(easy.seed).toBe(tutorial.seed);
      for (const config of [tutorial, easy]) {
        expect(config.controllers[humanSeat]).toEqual({ kind: "greedy" });
        expect(config.controllers[aiSeat]).toEqual({ kind: "ai", budget: AI_GATE_BUDGET });
        expect(config.handicaps?.[humanSeat] ?? HUMAN_HANDICAP).toEqual(HUMAN_HANDICAP);
        expect(config.decks[at(humanSeat)]).toHaveLength(DECK_SIZE);
      }
      // The greedy seat's deck is the same at both tiers; only the AI seat's differs.
      expect(easy.decks[at(humanSeat)]).toEqual(tutorial.decks[at(humanSeat)]);

      expect(tutorial.handicaps?.[aiSeat]).toEqual(AI_TUTORIAL);
      expect(tutorial.decks[at(aiSeat)]).toHaveLength(AI_TUTORIAL.deckSize);
      expect(tutorial.decks[at(aiSeat)]).toEqual(
        buildAiDeck(createRng(`${tutorial.seed}:deck:${aiSeat}`), AI_TUTORIAL.deckSize, { manaCap: AI_TUTORIAL.manaCap }),
      );
      expect(easy.handicaps?.[aiSeat] ?? HUMAN_HANDICAP).toEqual(AI_DIFFICULTY.easy);
      expect(easy.decks[at(aiSeat)]).toHaveLength(DECK_SIZE);
    }
  });

  it(
    `R290 the greedy baseline at a human's resources beats the AI at AI_TUTORIAL in at least ${String(TUTORIAL_TIER.greedyWinsVsTutorial)} of ${String(TUTORIAL_TIER.tutorialGames)} games`,
    { timeout: TIMEOUT },
    () => {
      const games = run("tutorial");
      expect(games).toHaveLength(TUTORIAL_TIER.tutorialGames);
      const wins = winsOf(games);
      // Written to stdout, as the gates write theirs: a passing test's console output is swallowed.
      process.stdout.write(
        `[R290 tutorial tier] greedy won ${String(wins)} of ${String(games.length)} against AI_TUTORIAL; ${String(TUTORIAL_TIER.greedyWinsVsTutorial)} needed\n`,
      );
      expect(wins, `not won: ${notWon(games)}`).toBeGreaterThanOrEqual(TUTORIAL_TIER.greedyWinsVsTutorial);
    },
  );

  it(
    `R290 on seeds 1–${String(TUTORIAL_TIER.easyGames)} the same greedy wins more games against AI_TUTORIAL than against Easy, by at least ${String(TUTORIAL_TIER.greedyMarginOverEasy)}`,
    { timeout: TIMEOUT },
    () => {
      const easyGames = run("easy");
      expect(easyGames).toHaveLength(TUTORIAL_TIER.easyGames);
      const tutorial = winsOf(run("tutorial"), TUTORIAL_TIER.easyGames);
      const easy = winsOf(easyGames);
      process.stdout.write(
        `[R290 tutorial tier] on seeds 1-${String(TUTORIAL_TIER.easyGames)} greedy won ${String(tutorial)} against AI_TUTORIAL and ${String(easy)} against Easy\n`,
      );
      expect(tutorial - easy, `AI_TUTORIAL ${String(tutorial)}, Easy ${String(easy)}; Easy not won: ${notWon(easyGames)}`).toBeGreaterThanOrEqual(
        TUTORIAL_TIER.greedyMarginOverEasy,
      );
    },
  );

  it("R290 every game at either tier is clean: nothing rejected or thrown, no fallback, a result, and a replay that matches", { timeout: TIMEOUT }, () => {
    for (const tier of ["tutorial", "easy"] as const) {
      const games = run(tier);
      expect(games, tier).toHaveLength(TIER_GAMES[tier]);
      for (const game of games) {
        const label = `${tier} ${game.config.seed}`;
        expect(game.record.rejected, label).toEqual([]);
        expect(game.record.thrown, label).toEqual([]);
        expect(game.record.fallbacks, label).toBe(0);
        expect(game.record.result, label).not.toBeNull();
        expect(game.replayErrors, label).toBe(0);
        expect(game.replayHash, label).toBe(game.record.hash);
      }
    }
  });
});
