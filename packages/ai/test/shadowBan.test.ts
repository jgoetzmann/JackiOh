// The AI's shadow ban and the sweep that decides it (SPEC §9.9, R186; docs/polish/3-ai.md B24, B25).
//
// B24: the table itself. Every entry names a real non-token Core card and a reason that starts
// with the sweep flags that put it there; the AI never deals itself a banned card; and enough
// cards stay unbanned to build a 30-card Hard deck. A banned card stays legal for every player.
//
// B25: `sweepFlags` raises each flag exactly at its AI_SWEEP threshold, tested on both sides of
// every bound with synthetic stats, and one real `sweepCard` run on a plain card flags no error.

import { describe, expect, it } from "vitest";
import { AI_DIFFICULTY, DECK_SIZE, createGame, createRng } from "@jackioh/engine";
import {
  AI_DECK,
  AI_SWEEP,
  SHADOW_BAN,
  SHADOW_BAN_IDS,
  buildAiDeck,
  sweepCard,
  sweepFlags,
  sweepVerdict,
  type SweepResult,
  type SweepStats,
} from "../src/index";
import { corePool } from "./_support";

const REASON = /^(error|timeout|neverPlayed|selfHarm)(, (error|timeout|neverPlayed|selfHarm))*: \S/;

// ---------------------------------------------------------------------------------------------
// B24
// ---------------------------------------------------------------------------------------------

describe("the shadow ban (B24)", () => {
  it("R186 B24: every entry is a real non-token Core card with a reason that starts with its sweep flags", () => {
    const pool = new Set(corePool());
    for (const [defId, reason] of Object.entries(SHADOW_BAN)) {
      expect(pool.has(defId), `${defId} is not a non-token Core card`).toBe(true);
      expect(reason, defId).toMatch(REASON);
    }
  });

  it("R186 B24: SHADOW_BAN_IDS is exactly the table's keys, sorted", () => {
    expect([...SHADOW_BAN_IDS]).toEqual(Object.keys(SHADOW_BAN).sort());
    expect(new Set(SHADOW_BAN_IDS).size).toBe(SHADOW_BAN_IDS.length);
  });

  it("R186 B24: the unbanned pool holds at least AI_DECK.minPool cards, enough for a Hard deck", () => {
    const unbanned = corePool().filter((id) => !SHADOW_BAN_IDS.includes(id));
    expect(unbanned.length).toBeGreaterThanOrEqual(AI_DECK.minPool);
    expect(unbanned.length).toBeGreaterThanOrEqual(AI_DIFFICULTY.hard.deckSize);
  });

  it("R186 B24: buildAiDeck never deals a banned card, over 200 seeds at every tier's size and cap", { timeout: 60_000 }, () => {
    const banned = new Set(SHADOW_BAN_IDS);
    for (const difficulty of ["easy", "medium", "hard"] as const) {
      const h = AI_DIFFICULTY[difficulty];
      for (let n = 1; n <= 200; n += 1) {
        const deck = buildAiDeck(createRng(`shadow-ban:${difficulty}:${n}`), h.deckSize, { manaCap: h.manaCap });
        for (const id of deck) expect(banned.has(id), `${difficulty} seed ${n}: ${id}`).toBe(false);
      }
    }
  });

  it("R186 B24: a banned card stays legal for a human's deck", () => {
    const others = corePool().filter((id) => !SHADOW_BAN_IDS.includes(id));
    const deck = [...SHADOW_BAN_IDS.slice(0, DECK_SIZE), ...others].slice(0, DECK_SIZE);
    const opponent = buildAiDeck(createRng("shadow-ban-legal"), DECK_SIZE);
    expect(new Set(deck).size).toBe(DECK_SIZE);
    expect(() => createGame({ seed: "shadow-ban-legal", decks: [deck, opponent] })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------------------------
// B25
// ---------------------------------------------------------------------------------------------

function stats(overrides: Partial<SweepStats> = {}): SweepStats {
  return {
    defId: "core-011",
    games: AI_SWEEP.seedsPerCard,
    drawnGames: AI_SWEEP.seedsPerCard,
    affordableTurns: 0,
    plays: 0,
    errors: 0,
    timeouts: 0,
    evalDeltaSum: 0,
    evalDeltaCount: 0,
    ...overrides,
  };
}

describe("sweepFlags (B25)", () => {
  it("B25: clean stats raise no flag", () => {
    expect(sweepFlags(stats())).toEqual([]);
    expect(sweepFlags(stats({ affordableTurns: 10, plays: 3, evalDeltaSum: 30, evalDeltaCount: 3 }))).toEqual([]);
  });

  it("B25: error is raised by the first error and not before", () => {
    expect(sweepFlags(stats({ errors: 0 }))).not.toContain("error");
    expect(sweepFlags(stats({ errors: 1 }))).toEqual(["error"]);
  });

  it("B25: timeout is raised by the first timeout and not before", () => {
    expect(sweepFlags(stats({ timeouts: 0 }))).not.toContain("timeout");
    expect(sweepFlags(stats({ timeouts: 1 }))).toEqual(["timeout"]);
  });

  it("B25: neverPlayed needs minAffordableTurns affordable turns and no play", () => {
    const at = AI_SWEEP.minAffordableTurns;
    expect(sweepFlags(stats({ affordableTurns: at, plays: 0 }))).toEqual(["neverPlayed"]);
    expect(sweepFlags(stats({ affordableTurns: at - 1, plays: 0 }))).toEqual([]);
    expect(sweepFlags(stats({ affordableTurns: at, plays: 1, evalDeltaSum: 0, evalDeltaCount: 1 }))).toEqual([]);
  });

  it("B25: selfHarm needs a mean evaluation delta strictly below selfHarmDelta over at least minHarmPlays plays", () => {
    const bound = AI_SWEEP.selfHarmDelta;
    const plays = AI_SWEEP.minHarmPlays;
    const base = { affordableTurns: 5, plays };
    expect(sweepFlags(stats({ ...base, evalDeltaSum: bound * plays, evalDeltaCount: plays }))).toEqual([]);
    expect(sweepFlags(stats({ ...base, evalDeltaSum: (bound - 1) * plays, evalDeltaCount: plays }))).toEqual(["selfHarm"]);
    // One play fewer than minHarmPlays is not enough, however bad the plays were.
    const fewer = plays - 1;
    expect(sweepFlags(stats({ ...base, plays: fewer, evalDeltaSum: (bound - 100) * fewer, evalDeltaCount: fewer }))).toEqual([]);
    expect(sweepFlags(stats({ ...base, evalDeltaSum: bound * 10, evalDeltaCount: 0 }))).toEqual([]);
  });

  it("B25: several flags come out in the order error, timeout, neverPlayed, selfHarm", () => {
    const all = stats({
      errors: 2,
      timeouts: 1,
      affordableTurns: AI_SWEEP.minAffordableTurns,
      plays: 0,
      evalDeltaSum: (AI_SWEEP.selfHarmDelta - 10) * AI_SWEEP.minHarmPlays,
      evalDeltaCount: AI_SWEEP.minHarmPlays,
    });
    expect(sweepFlags(all)).toEqual(["error", "timeout", "neverPlayed", "selfHarm"]);
  });

  it("B25: sweepCard on Tempo Timmy over 2 seeds plays 2 games and flags no error", { timeout: 300_000 }, () => {
    const result = sweepCard("core-011", { seeds: 2 });
    expect(result.defId).toBe("core-011");
    expect(result.games).toBe(2);
    expect(result.flags).not.toContain("error");
    expect(result.errors).toBe(0);
    expect(result.drawnGames).toBeLessThanOrEqual(result.games);
    const { flags, ...rest } = result;
    expect(sweepFlags(rest)).toEqual(flags);
  });
});

// ---------------------------------------------------------------------------------------------
// every tier: a ban holds at every difficulty, so a card is judged at the fewest resources and
// the most, and a card no tier could afford is reported rather than passed
// ---------------------------------------------------------------------------------------------

function result(overrides: Partial<SweepResult> = {}): SweepResult {
  const base = stats(overrides);
  return { ...base, tier: "easy", flags: sweepFlags(base), unswept: base.affordableTurns === 0, ...overrides };
}

describe("the sweep judges a card at every tier (R186)", () => {
  it("R186 AI_SWEEP sweeps at Easy and at Hard", () => {
    expect([...AI_SWEEP.tiers]).toEqual(["easy", "hard"]);
  });

  it("R186 a flag at any tier bans the card, and the reason names every tier that flagged it", () => {
    const at = AI_SWEEP.minAffordableTurns;
    const easy = result({ defId: "core-078", tier: "easy", affordableTurns: at + 2, plays: 0 });
    const hard = result({ defId: "core-078", tier: "hard", affordableTurns: at + 5, plays: 0 });
    const verdict = sweepVerdict([easy, hard]);
    expect(verdict.flags).toEqual(["neverPlayed"]);
    expect(verdict.unswept).toBe(false);
    expect(verdict.reason).toMatch(REASON);
    expect(verdict.reason).toContain(`easy: affordable in hand on ${String(at + 2)} turns, never played`);
    expect(verdict.reason).toContain(`hard: affordable in hand on ${String(at + 5)} turns, never played`);

    const onlyHard = sweepVerdict([
      result({ defId: "core-078", tier: "easy", affordableTurns: 6, plays: 2, evalDeltaSum: 4, evalDeltaCount: 2 }),
      result({ defId: "core-078", tier: "hard", errors: 1, affordableTurns: 4, plays: 1, evalDeltaCount: 1 }),
    ]);
    expect(onlyHard.flags).toEqual(["error"]);
    expect(onlyHard.reason).toMatch(/^error: hard: 1 engine or search error/);
    expect(onlyHard.reason).not.toContain("easy:");
  });

  it("R186 a card clean at every tier has no reason; one never affordable anywhere is unswept, not clean", () => {
    const clean = sweepVerdict([
      result({ tier: "easy", affordableTurns: 5, plays: 3, evalDeltaSum: 9, evalDeltaCount: 3 }),
      result({ tier: "hard", affordableTurns: 7, plays: 4, evalDeltaSum: 8, evalDeltaCount: 4 }),
    ]);
    expect(clean).toMatchObject({ flags: [], unswept: false, reason: null });

    const neverAffordable = sweepVerdict([result({ tier: "easy" }), result({ tier: "hard" })]);
    expect(neverAffordable).toMatchObject({ flags: [], unswept: true, reason: null });

    const affordableOnlyAtHard = sweepVerdict([
      result({ tier: "easy" }),
      result({ tier: "hard", affordableTurns: 4, plays: 2, evalDeltaCount: 2 }),
    ]);
    expect(affordableOnlyAtHard.unswept).toBe(false);
  });

  it(
    "R186 GIGA Glowy Jelly Bean (6 mana) is unswept at Easy's four crystals and judged at Hard's seven",
    { timeout: 300_000 },
    () => {
      const easy = sweepCard("core-029", { seeds: 2, tier: "easy" });
      expect(easy.tier).toBe("easy");
      expect(easy.affordableTurns).toBe(0);
      expect(easy.unswept).toBe(true);
      expect(easy.flags).toEqual([]);

      const hard = sweepCard("core-029", { seeds: 2, tier: "hard" });
      expect(hard.tier).toBe("hard");
      expect(hard.errors).toBe(0);
      expect(hard.affordableTurns).toBeGreaterThan(0);
      expect(hard.unswept).toBe(false);
    },
  );
});
