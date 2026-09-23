// The shadow-ban sweep (R186, docs/polish/3-ai.md B25): force one card into AI decks, play them
// against the greedy baseline, and flag what went wrong with that card. `scripts/sweep.ts` runs it
// over every non-token Core id at every tier in AI_SWEEP.tiers and prints the flagged rows that
// `shadowBan.ts` is filled from.
//
// Why more than one tier. The ban keeps a card out of the AI's decks at every difficulty, and a
// tier's resources decide what the AI can do with a card: at Easy's four crystals a 6-cost card is
// never affordable at all, so an Easy-only sweep has no evidence either way, and a card the AI
// never played on four crystals may well be played on seven. So each card is swept at the
// cheapest tier (Easy) and the richest (Hard): a flag at either bans it (the reason names the
// tier), and a card that was never once affordable at any tier is reported as unswept rather than
// passed as clean.
//
// Pure like the rest of src/: the clock arrives as `now`, which the script passes
// (`performance.now`) and a test leaves out, so a test's sweep never times out on a slow machine.

import { opponentOf, type PlayerId } from "@jackioh/shared";
import { AI_DIFFICULTY, createRng, effectiveCost, zoneCards, type GameState } from "@jackioh/engine";
import type { Difficulty } from "@jackioh/engine/config";
import { AI_GATE_BUDGET } from "./config";
import { buildAiDeck } from "./deck";
import { evaluate } from "./evaluate";
import { playMatch, type MatchConfig, type MatchHooks } from "./match";
import { SHADOW_BAN_IDS } from "./shadowBan";

export type SweepFlag = "error" | "timeout" | "neverPlayed" | "selfHarm";

export const AI_SWEEP = {
  /** The tiers every card is swept at: the fewest resources and the most (see the header). */
  tiers: ["easy", "hard"] as readonly Difficulty[],
  /** Games per card and tier. Four left the neverPlayed flag at the mercy of one deal. */
  seedsPerCard: 8,
  decisionMs: 2000,
  maxActions: 600,
  minAffordableTurns: 3,
  selfHarmDelta: -40,
  /** selfHarm needs at least this many plays, so one play into a trap does not ban a card. */
  minHarmPlays: 4,
} as const;

export type SweepStats = {
  defId: string;
  games: number;
  drawnGames: number;
  affordableTurns: number;
  plays: number;
  errors: number;
  timeouts: number;
  evalDeltaSum: number;
  evalDeltaCount: number;
};

/**
 * One card at one tier. `unswept` is a card that was never once affordable in hand, so its games
 * say nothing about whether the AI can play it (a report, never a ban flag).
 */
export type SweepResult = SweepStats & { tier: Difficulty; flags: SweepFlag[]; unswept: boolean };

/** A card over every tier it was swept at: the union of the flags, and the ban reason if any. */
export type SweepVerdict = {
  defId: string;
  flags: SweepFlag[];
  /** Never affordable at any tier: no evidence for or against it. */
  unswept: boolean;
  /** The SHADOW_BAN reason, `"<flags>: <tier>: <what it measured>; …"`, or null when unflagged. */
  reason: string | null;
};

/** error: errors > 0; timeout: timeouts > 0; neverPlayed: affordableTurns >= minAffordableTurns && plays === 0;
 *  selfHarm: evalDeltaCount >= minHarmPlays && evalDeltaSum / evalDeltaCount < selfHarmDelta. In that order. */
export function sweepFlags(stats: SweepStats): SweepFlag[] {
  const flags: SweepFlag[] = [];
  if (stats.errors > 0) flags.push("error");
  if (stats.timeouts > 0) flags.push("timeout");
  if (stats.affordableTurns >= AI_SWEEP.minAffordableTurns && stats.plays === 0) flags.push("neverPlayed");
  if (stats.evalDeltaCount >= AI_SWEEP.minHarmPlays && stats.evalDeltaSum / stats.evalDeltaCount < AI_SWEEP.selfHarmDelta) {
    flags.push("selfHarm");
  }
  return flags;
}

/** Game n (1-based) of a card's sweep: the AI sits p1 when n is odd and p2 when even. */
function sweptSeatOf(n: number): PlayerId {
  return n % 2 === 1 ? "p1" : "p2";
}

/** Game n of a card's sweep at a tier: the AI on that tier's handicap, greedy on Easy's (a human's). */
function sweepConfig(defId: string, n: number, tier: Difficulty): { config: MatchConfig; aiSeat: PlayerId } {
  const seed = `sweep:${tier}:${defId}:${n}`;
  const aiSeat = sweptSeatOf(n);
  const greedySeat = opponentOf(aiSeat);
  const handicap = AI_DIFFICULTY[tier];
  const easy = AI_DIFFICULTY.easy;

  // The swept card is forced in even when it is banned today, so a rerun can clear it; every other
  // banned card stays out, so its errors are not charged to this one.
  const aiDeck = buildAiDeck(createRng(`${seed}:deck:${aiSeat}`), handicap.deckSize, {
    include: [defId],
    banned: SHADOW_BAN_IDS.filter((id) => id !== defId),
    manaCap: handicap.manaCap,
  });
  // The greedy seat stands in for a human, whose random deck ignores the AI's ban.
  const greedyDeck = buildAiDeck(createRng(`${seed}:deck:${greedySeat}`), easy.deckSize, {
    banned: [],
    manaCap: easy.manaCap,
  });

  const ai = { kind: "ai", budget: AI_GATE_BUDGET } as const;
  const greedy = { kind: "greedy" } as const;
  return {
    aiSeat,
    config: {
      seed,
      decks: aiSeat === "p1" ? [aiDeck, greedyDeck] : [greedyDeck, aiDeck],
      handicaps: aiSeat === "p1" ? { p1: handicap, p2: easy } : { p1: easy, p2: handicap },
      controllers: aiSeat === "p1" ? { p1: ai, p2: greedy } : { p1: greedy, p2: ai },
      maxActions: AI_SWEEP.maxActions,
    },
  };
}

function holdsCard(state: GameState, seat: PlayerId, defId: string): boolean {
  return zoneCards(state, seat, "hand").some((card) => card.defId === defId);
}

/**
 * `seeds` games (default seedsPerCard) of an AI on `tier`'s handicap (default Easy) whose deck
 * includes `defId` (include) against greedy on Easy's, at AI_GATE_BUDGET. Counts draws of the card, turns it sat in hand affordable
 * (effectiveCost <= mana at the AI's turn start), plays (true-state evaluate delta for the playing
 * seat, before → after), errors (throws, rejected or "fallback" AI actions) and timeouts (a
 * decision whose `now()` duration > decisionMs, or maxActions hit).
 */
export function sweepCard(
  defId: string,
  options: { seeds?: number; now?: () => number; tier?: Difficulty } = {},
): SweepResult {
  const seeds = options.seeds ?? AI_SWEEP.seedsPerCard;
  const now = options.now;
  const tier = options.tier ?? "easy";

  const stats: SweepStats = {
    defId,
    games: 0,
    drawnGames: 0,
    affordableTurns: 0,
    plays: 0,
    errors: 0,
    timeouts: 0,
    evalDeltaSum: 0,
    evalDeltaCount: 0,
  };

  for (let n = 1; n <= seeds; n += 1) {
    stats.games += 1;

    let drawn = false;
    // The last AI turn whose start was already counted, so a turn is counted once however many
    // actions it holds.
    let countedTurn: number | null = null;

    let setup: { config: MatchConfig; aiSeat: PlayerId };
    try {
      setup = sweepConfig(defId, n, tier);
    } catch {
      // The card cannot even be dealt (not a Core card, or the pool is too small): an error.
      stats.errors += 1;
      continue;
    }
    const { config, aiSeat } = setup;

    const hooks: MatchHooks = {
      afterAction(before, after, seat, action) {
        if (!drawn && (holdsCard(before, aiSeat, defId) || holdsCard(after, aiSeat, defId))) drawn = true;

        // The AI's turn start: the first main-phase state of a new AI turn.
        if (after.result === null && after.active === aiSeat && after.phase === "main" && after.turn !== countedTurn) {
          countedTurn = after.turn;
          const mana = after.players[aiSeat].mana.current;
          const affordable = zoneCards(after, aiSeat, "hand").some(
            (card) => card.defId === defId && effectiveCost(after, card) <= mana,
          );
          if (affordable) stats.affordableTurns += 1;
        }

        if (seat === aiSeat && action.type === "play") {
          const card = zoneCards(before, aiSeat, "hand").find((instance) => instance.id === action.instanceId);
          if (card !== undefined && card.defId === defId) {
            stats.plays += 1;
            stats.evalDeltaSum += evaluate(after, aiSeat) - evaluate(before, aiSeat);
            stats.evalDeltaCount += 1;
          }
        }
      },
    };
    if (now !== undefined) {
      hooks.timeDecision = <T>(seat: PlayerId, run: () => T): T => {
        const started = now();
        const result = run();
        if (seat === aiSeat && now() - started > AI_SWEEP.decisionMs) stats.timeouts += 1;
        return result;
      };
    }

    try {
      const record = playMatch(config, hooks);
      stats.errors += record.thrown.length + record.rejected.length + record.fallbacks;
      // A game still running at maxActions is a timeout; one a throw ended is already an error.
      if (record.result === null && record.thrown.length === 0) stats.timeouts += 1;
    } catch {
      stats.errors += 1;
    }

    if (drawn) stats.drawnGames += 1;
  }

  return { ...stats, tier, flags: sweepFlags(stats), unswept: stats.affordableTurns === 0 };
}

const FLAG_ORDER: readonly SweepFlag[] = ["error", "timeout", "neverPlayed", "selfHarm"];

/** What one flag measured at one tier, for the ban reason. */
function flagDetail(result: SweepResult, flag: SweepFlag): string {
  switch (flag) {
    case "error":
      return `${String(result.errors)} engine or search error(s) over ${String(result.games)} games`;
    case "timeout":
      return `${String(result.timeouts)} decision(s) over ${String(AI_SWEEP.decisionMs)} ms or game(s) past ${String(AI_SWEEP.maxActions)} actions`;
    case "neverPlayed":
      return `affordable in hand on ${String(result.affordableTurns)} turns, never played`;
    case "selfHarm":
      return `mean evaluate change ${(result.evalDeltaSum / Math.max(1, result.evalDeltaCount)).toFixed(1)} over ${String(result.evalDeltaCount)} play(s)`;
  }
}

/**
 * One card's verdict over its tiers (R186): banned when any tier flagged it, with every flagging
 * tier named in the reason; unswept when no tier ever saw it affordable.
 */
export function sweepVerdict(results: readonly SweepResult[]): SweepVerdict {
  const defId = results[0]?.defId ?? "";
  const flags = FLAG_ORDER.filter((flag) => results.some((result) => result.flags.includes(flag)));
  const unswept = results.length > 0 && results.every((result) => result.unswept);
  if (flags.length === 0) return { defId, flags, unswept, reason: null };
  const details = results
    .filter((result) => result.flags.length > 0)
    .map((result) => `${result.tier}: ${result.flags.map((flag) => flagDetail(result, flag)).join(", ")}`);
  return { defId, flags, unswept, reason: `${flags.join(", ")}: ${details.join("; ")}` };
}
