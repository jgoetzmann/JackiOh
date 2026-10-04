/**
 * The hidden rating (SPEC §9.12, R603): Glicko-2, as Mark Glickman's "Example of the Glicko-2
 * system" (2013) writes it, step for step. Every number is `src/config.ts`'s.
 *
 * One rated game is one rating period: each side is updated against the other's rating from before
 * the game, so the two updates do not depend on which is computed first. A draw scores 0.5 for both,
 * a concede and a disconnect are losses (§2.5's endings decide who won; this file only reads the
 * score).
 *
 * Pure and deterministic: the same inputs give the same output on every machine, because the only
 * operations are IEEE-754 arithmetic, `Math.exp`, `Math.log` and `Math.sqrt`, and the volatility
 * iteration runs a fixed rule to a fixed tolerance. `test/ranked/glicko2.test.ts` checks it against
 * Glickman's worked example and against reference values computed independently at 50 digits.
 *
 * Glicko-2's update depends only on rating differences, so the scale's centre (Glickman's 1500) is
 * any fixed number; this file uses `RATING_START`, and an Elo rating carries over as it is (R603).
 */

import {
  GLICKO_CONVERGENCE,
  GLICKO_MAX_ITERATIONS,
  GLICKO_SCALE,
  GLICKO_TAU,
  RATING_DEVIATION_START,
  RATING_START,
  RATING_VOLATILITY_START,
} from "../config";

/** One side's hidden rating: Glicko-2's r, RD and σ, on the displayed scale. */
export type Glicko = { rating: number; deviation: number; volatility: number };

/** A game's score for the side it is read from: a win, a draw or a loss. */
export type Score = 0 | 0.5 | 1;

/** One game of a rating period: the opponent's rating before it, and the score against them. */
export type RatedOpponent = { opponent: Glicko; score: Score };

/** The rating a profile starts with (R603). */
export const START_GLICKO: Glicko = Object.freeze({
  rating: RATING_START,
  deviation: RATING_DEVIATION_START,
  volatility: RATING_VOLATILITY_START,
});

/** Step 3's g(φ): how much an opponent's own uncertainty discounts a game against them. */
function g(phi: number): number {
  return 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI));
}

/** Step 3's E(μ, μj, φj): the expected score against an opponent. */
function expected(mu: number, muJ: number, phiJ: number): number {
  return 1 / (1 + Math.exp(-g(phiJ) * (mu - muJ)));
}

/**
 * Step 5: the new volatility, by the Illinois algorithm exactly as Glickman's §5 sets it out,
 * including the bracket's starting points.
 */
function nextVolatility(sigma: number, phi: number, v: number, delta: number, tau: number): number {
  const a = Math.log(sigma * sigma);
  const phi2 = phi * phi;
  const f = (x: number): number => {
    const ex = Math.exp(x);
    const denominator = phi2 + v + ex;
    return (ex * (delta * delta - phi2 - v - ex)) / (2 * denominator * denominator) - (x - a) / (tau * tau);
  };

  let A = a;
  let B: number;
  if (delta * delta > phi2 + v) {
    B = Math.log(delta * delta - phi2 - v);
  } else {
    let k = 1;
    while (f(a - k * tau) < 0 && k < GLICKO_MAX_ITERATIONS) k += 1;
    B = a - k * tau;
  }

  let fA = f(A);
  let fB = f(B);
  for (let step = 0; Math.abs(B - A) > GLICKO_CONVERGENCE && step < GLICKO_MAX_ITERATIONS; step += 1) {
    const C = A + ((A - B) * fA) / (fB - fA);
    const fC = f(C);
    if (fC * fB <= 0) {
      A = B;
      fA = fB;
    } else {
      fA = fA / 2;
    }
    B = C;
    fB = fC;
  }
  return Math.exp(A / 2);
}

/**
 * Glickman's steps 2–8 for one player over one rating period. A period with no games only widens
 * the deviation (step 6 alone); the server never rates one, but the formula is defined there too.
 */
export function glicko2Period(player: Glicko, games: readonly RatedOpponent[], tau: number = GLICKO_TAU): Glicko {
  // Step 2: onto the Glicko-2 scale.
  const mu = (player.rating - RATING_START) / GLICKO_SCALE;
  const phi = player.deviation / GLICKO_SCALE;
  const sigma = player.volatility;

  if (games.length === 0) {
    return { rating: player.rating, deviation: Math.sqrt(phi * phi + sigma * sigma) * GLICKO_SCALE, volatility: sigma };
  }

  // Steps 3 and 4: the estimated variance v and the improvement Δ.
  let vInverse = 0;
  let improvement = 0;
  for (const { opponent, score } of games) {
    const muJ = (opponent.rating - RATING_START) / GLICKO_SCALE;
    const phiJ = opponent.deviation / GLICKO_SCALE;
    const e = expected(mu, muJ, phiJ);
    const gJ = g(phiJ);
    vInverse += gJ * gJ * e * (1 - e);
    improvement += gJ * (score - e);
  }
  const v = 1 / vInverse;
  const delta = v * improvement;

  // Steps 5 to 7: the new volatility, then the deviation and rating it allows.
  const sigmaNext = nextVolatility(sigma, phi, v, delta, tau);
  const phiStar = Math.sqrt(phi * phi + sigmaNext * sigmaNext);
  const phiNext = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);
  const muNext = mu + phiNext * phiNext * improvement;

  // Step 8: back onto the displayed scale.
  return {
    rating: muNext * GLICKO_SCALE + RATING_START,
    deviation: phiNext * GLICKO_SCALE,
    volatility: sigmaNext,
  };
}

/**
 * R603: one rated game between `a` and `b`, `scoreA` being a's score (b's is `1 - scoreA`). Each side
 * is rated against the other's rating from before the game.
 */
export function rateGame(a: Glicko, b: Glicko, scoreA: Score): { a: Glicko; b: Glicko } {
  const scoreB = (1 - scoreA) as Score;
  return {
    a: glicko2Period(a, [{ opponent: b, score: scoreA }]),
    b: glicko2Period(b, [{ opponent: a, score: scoreB }]),
  };
}
