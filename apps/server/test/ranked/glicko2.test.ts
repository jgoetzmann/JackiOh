/**
 * The hidden rating's maths (SPEC §9.12, R603): Glicko-2 against reference values.
 *
 * Two sources. Glickman's own worked example ("Example of the Glicko-2 system", 2013, §"Example"),
 * at the precision the paper prints, which it rounds at every step; and the values below marked
 * REFERENCE, computed independently of this code by a transcription of the paper's steps into
 * Python's `decimal` module at 50 significant digits (ε = 1e-40), which is where draws are proved,
 * since the paper's example has none. Those match this module to 1e-6 in rating and deviation and
 * 1e-8 in volatility, the slack being only its own ε of `GLICKO_CONVERGENCE`.
 */

import { describe, expect, it } from "vitest";

import { RATING_DEVIATION_START, RATING_START, RATING_VOLATILITY_START } from "../../src/config";
import { glicko2Period, rateGame, START_GLICKO, type Glicko } from "../../src/ranked/glicko2";

const glicko = (rating: number, deviation: number, volatility = 0.06): Glicko => ({ rating, deviation, volatility });

/** Asserts a computed rating against a 50-digit reference. */
function expectReference(actual: Glicko, reference: { rating: number; deviation: number; volatility: number }): void {
  expect(Math.abs(actual.rating - reference.rating)).toBeLessThan(1e-6);
  expect(Math.abs(actual.deviation - reference.deviation)).toBeLessThan(1e-6);
  expect(Math.abs(actual.volatility - reference.volatility)).toBeLessThan(1e-8);
}

describe("R603 Glicko-2 matches Glickman's worked example", () => {
  it("R603 rates 1500/200/0.06 after beating 1400/30 and losing to 1550/100 and 1700/300 as the paper does", () => {
    const after = glicko2Period(glicko(1500, 200), [
      { opponent: glicko(1400, 30), score: 1 },
      { opponent: glicko(1550, 100), score: 0 },
      { opponent: glicko(1700, 300), score: 0 },
    ]);
    // The paper's printed results: r' = 1464.06, RD' = 151.52, σ' = 0.05999 (each rounded from
    // rounded intermediates, so compared at the paper's own last digit).
    expect(Math.abs(after.rating - 1464.06)).toBeLessThan(0.01);
    expect(Math.abs(after.deviation - 151.52)).toBeLessThan(0.01);
    expect(Math.abs(after.volatility - 0.05999)).toBeLessThan(0.00001);
    // REFERENCE, unrounded.
    expectReference(after, { rating: 1464.050670819481, deviation: 151.516521926373, volatility: 0.05999598440084 });
  });

  it("R603 the update depends only on rating differences, so the scale's centre is any number", () => {
    // RATING_START is R79's 1000, not Glickman's 1500: the same example moved by 500 moves by 500.
    const games = (shift: number) => [
      { opponent: glicko(1400 + shift, 30), score: 1 as const },
      { opponent: glicko(1550 + shift, 100), score: 0 as const },
      { opponent: glicko(1700 + shift, 300), score: 0 as const },
    ];
    const at1500 = glicko2Period(glicko(1500, 200), games(0));
    const at1000 = glicko2Period(glicko(1000, 200), games(-500));
    expect(at1000.rating + 500).toBeCloseTo(at1500.rating, 9);
    expect(at1000.deviation).toBeCloseTo(at1500.deviation, 9);
    expect(at1000.volatility).toBeCloseTo(at1500.volatility, 12);
  });
});

describe("R603 draws count as half a win", () => {
  it("R603 the paper's player drawing all three games (REFERENCE)", () => {
    const after = glicko2Period(glicko(1500, 200), [
      { opponent: glicko(1400, 30), score: 0.5 },
      { opponent: glicko(1550, 100), score: 0.5 },
      { opponent: glicko(1700, 300), score: 0.5 },
    ]);
    expectReference(after, { rating: 1509.107200047628, deviation: 151.516520727744, volatility: 0.05999567822515 });
  });

  it("R603 a draw between two new players moves neither rating and narrows both deviations (REFERENCE)", () => {
    const { a, b } = rateGame(START_GLICKO, START_GLICKO, 0.5);
    for (const side of [a, b]) {
      expect(side.rating).toBe(RATING_START);
      expectReference({ ...side, rating: 1500 }, { rating: 1500, deviation: 290.318959913803, volatility: 0.05999896145086 });
    }
  });

  it("R603 a draw pulls an underdog up and a favourite down (REFERENCE)", () => {
    const { a: under, b: over } = rateGame(glicko(1400, 80), glicko(1600, 120), 0.5);
    expectReference(under, { rating: 1408.306768783764, deviation: 79.272855907714, volatility: 0.05999850515082 });
    expectReference(over, { rating: 1581.089049161912, deviation: 115.693290645246, volatility: 0.05999851743814 });
  });
});

describe("R603 one rated game is one rating period", () => {
  it("R603 a win and a loss between new players are mirror images (REFERENCE)", () => {
    const { a: winner, b: loser } = rateGame(START_GLICKO, START_GLICKO, 1);
    expectReference(
      { ...winner, rating: winner.rating + 500 },
      { rating: 1662.310895033019, deviation: 290.318962017920, volatility: 0.0599996753731 },
    );
    expectReference(
      { ...loser, rating: loser.rating + 500 },
      { rating: 1337.689104966981, deviation: 290.318962017920, volatility: 0.0599996753731 },
    );
  });

  it("R603 an upset moves both sides by their own deviations, each from the other's rating before (REFERENCE)", () => {
    const { a: underdog, b: favourite } = rateGame(glicko(1350, 60), glicko(1720, 45), 1);
    expectReference(underdog, { rating: 1368.629463000698, deviation: 60.547858911524, volatility: 0.06000902052519 });
    expectReference(favourite, { rating: 1709.330958947476, deviation: 46.03837643654, volatility: 0.06000892422778 });
  });

  it("R603 a result far from the expected one takes the other branch of the volatility bracket (REFERENCE)", () => {
    // Δ² > φ² + v here, so step 5 starts B at ln(Δ² − φ² − v) rather than stepping down from a.
    const after = glicko2Period(glicko(1500, 50), [{ opponent: glicko(2400, 30), score: 1 }]);
    expectReference(after, { rating: 1514.856410184712, deviation: 51.062871777297, volatility: 0.06001314423775 });
  });

  it("R603 is deterministic and independent of which side is computed first", () => {
    const a = glicko(1123.4, 77.7, 0.061);
    const b = glicko(1088.8, 140.2, 0.059);
    const first = rateGame(a, b, 0);
    const swapped = rateGame(b, a, 1);
    expect(first.a).toEqual(swapped.b);
    expect(first.b).toEqual(swapped.a);
    expect(rateGame(a, b, 0)).toEqual(first);
  });

  it("R603 a new profile starts at R79's 1000 with Glickman's starting deviation and volatility", () => {
    expect(START_GLICKO).toEqual({
      rating: RATING_START,
      deviation: RATING_DEVIATION_START,
      volatility: RATING_VOLATILITY_START,
    });
    expect([RATING_START, RATING_DEVIATION_START, RATING_VOLATILITY_START]).toEqual([1000, 350, 0.06]);
  });
});
