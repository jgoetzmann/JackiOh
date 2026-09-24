// The AI's one entry point (SPEC §9.9). The order below is the contract:
//
//   1. aiToAct / redact — the only two reads of the true state (R185).
//   2. an unanswered draw offer is declined at once (R188).
//   3. the mulligan keeps the cheap cards.
//   4. a single candidate is played with no search: listed on a throwaway determinization, since
//      the seat's own legal actions never depend on the hidden cards, so `options.rng` is untouched.
//   5. the exact lethal solver, verified on every determinization.
//   6. the beam on determinization 0; its best lines are scored after the opponent's reply
//      (reply.ts), the best first actions are re-scored the same way on the other determinizations,
//      and the best mean wins.
//   7. a fallback when nothing could be scored.
//
// Only the first action of the chosen line is played; the caller asks again after it, so the AI
// re-plans after every action and a plan that only one sampled world liked never gets past step one.
// `decide` never throws: every internal failure becomes a fallback and is counted in simErrors.

import type { ActionBody, PlayerId } from "@jackioh/shared";
import { createRng, type GameState } from "@jackioh/engine";
import { actionKey, candidateActions } from "./candidates";
import { AI_BUDGET, AI_EVAL, AI_REPLY, AI_SEARCH } from "./config";
import { determinize } from "./determinize";
import { findLethal } from "./lethal";
import { mulliganKeep } from "./mulligan";
import { aiToAct, redact, unansweredDrawOffer } from "./observe";
import { hiddenCardIds, replyScore } from "./reply";
import { beamSearch, scoreLine, type Line } from "./search";
import { createNodeCounter, createSubCounter, type CountingNodeCounter } from "./simulate";
import type { AiOptions, Decision, DecisionReason, SearchStats } from "./types";

function quietStats(): SearchStats {
  return { nodes: 0, determinizations: 0, lines: 0, simErrors: 0, stoppedBy: "exhausted", score: 0 };
}

function immediate(action: ActionBody, reason: DecisionReason): Decision {
  return { action, reason, line: [action], stats: quietStats() };
}

/** Step 7: endTurn when it is a candidate, else the first candidate, else endTurn regardless. */
function fallbackAction(candidates: readonly ActionBody[]): ActionBody {
  const end = candidates.find((action) => action.type === "endTurn");
  return end ?? candidates[0] ?? { type: "endTurn" };
}

/** Lines in order, at most `perAction` for any one first action, `count` in all. */
function shortlistLines(found: readonly Line[], count: number): Line[] {
  const taken = new Map<string, number>();
  const out: Line[] = [];
  for (const line of found) {
    const first = line.actions[0];
    if (first === undefined) continue;
    const key = actionKey(first);
    const already = taken.get(key) ?? 0;
    if (already >= AI_SEARCH.linesPerAction) continue;
    taken.set(key, already + 1);
    out.push(line);
    if (out.length >= count) break;
  }
  return out;
}

/** The best-scoring line for each distinct first action, best first, at most `count` of them. */
function bestPerFirstAction(
  scored: readonly { line: Line; score: number }[],
  count: number,
): { line: Line; score: number }[] {
  const best = new Map<string, { line: Line; score: number }>();
  const order: string[] = [];
  for (const entry of scored) {
    const first = entry.line.actions[0];
    if (first === undefined) continue;
    const key = actionKey(first);
    const held = best.get(key);
    if (held === undefined) {
      best.set(key, entry);
      order.push(key);
    } else if (entry.score > held.score) {
      best.set(key, entry);
    }
  }
  const entries = order.map((key) => best.get(key) as { line: Line; score: number });
  // Stable, so equal scores keep the beam's order.
  return entries.sort((a, b) => b.score - a.score).slice(0, count);
}

/** The AI's one entry point. null when !aiToAct(state, seat). Never throws. */
export function decide(state: GameState, seat: PlayerId, options: AiOptions): Decision | null {
  try {
    if (!aiToAct(state, seat)) return null;
  } catch {
    return null;
  }

  const budget = options.budget ?? AI_BUDGET;
  let candidates: ActionBody[] = [];
  let counter: CountingNodeCounter | null = null;
  let determinizations = 0;
  let lines = 0;
  let thrown = 0;

  const stats = (score: number, stoppedBy?: SearchStats["stoppedBy"]): SearchStats => ({
    nodes: counter === null ? 0 : counter.used,
    determinizations,
    lines,
    simErrors: (counter === null ? 0 : counter.simErrors) + thrown,
    stoppedBy: stoppedBy ?? (counter === null ? "exhausted" : counter.stoppedBy),
    score,
  });

  try {
    // 1. Everything below reads the redacted copy.
    const pub = redact(state, seat);

    // 2. R188.
    if (unansweredDrawOffer(pub, seat)) return immediate({ type: "answerDraw", accept: false }, "draw-offer");

    // 3. The mulligan.
    if (pub.pending !== null && pub.pending.kind === "mulligan" && pub.pending.playerId === seat) {
      return immediate({ type: "mulligan", keep: mulliganKeep(pub, seat) }, "mulligan");
    }

    // 4. Forced: a throwaway world lists the candidates without touching options.rng.
    const probe = determinize(pub, seat, createRng(AI_SEARCH.probeSeed));
    candidates = candidateActions(probe, seat);
    const only = candidates[0];
    if (candidates.length === 1 && only !== undefined) return immediate(only, "forced");

    // The only draws decide ever takes from options.rng.
    const k = Math.max(1, budget.determinizations);
    const dets: GameState[] = [];
    for (let i = 0; i < k; i += 1) dets.push(determinize(pub, seat, options.rng));
    determinizations = k;
    counter = createNodeCounter(budget.nodes, options.shouldStop);

    // 5. Lethal, verified on every determinization.
    const lethal = findLethal(dets, seat, counter, budget.lethalNodes);
    const firstLethal = lethal?.[0];
    if (lethal !== null && firstLethal !== undefined) {
      return { action: firstLethal, reason: "lethal", line: lethal, stats: stats(AI_EVAL.win - pub.turn) };
    }

    // 6. The beam on determinization 0, keeping enough nodes back to score the finalists after the
    // opponent's reply on every determinization.
    const det0 = dets[0] as GameState;
    const rootTurn = det0.turn;
    const remaining = Math.max(0, budget.nodes - counter.used);
    const finalistCount = Math.max(1, budget.finalists);
    const perFinalist =
      AI_SEARCH.linesPerAction * AI_REPLY.reserveSteps + (k - 1) * (budget.maxDepth + 1 + AI_REPLY.reserveSteps);
    const reserve = Math.min(Math.floor(remaining / 2), finalistCount * perFinalist);
    const beamCounter = createSubCounter(counter, remaining - reserve);
    const found = beamSearch(det0, seat, beamCounter, budget);
    lines = found.length;

    if (found.length === 0) {
      const action = fallbackAction(candidates);
      return {
        action,
        reason: "fallback",
        line: [action],
        stats: stats(0, counter.stoppedBy !== "exhausted" ? counter.stoppedBy : beamCounter.stoppedBy),
      };
    }

    // Only a line's first action is ever played. The best lines (at most AI_SEARCH.linesPerAction
    // for any one first action) are scored after the opponent's reply on determinization 0; each
    // first action keeps its best line; the best `finalists` first actions are scored again on every
    // other determinization, and the best mean wins.
    const shortlist = shortlistLines(found, finalistCount * AI_SEARCH.linesPerAction);
    const hidden0 = hiddenCardIds(det0, seat);
    const replied: { line: Line; score: number }[] = [];
    for (const line of shortlist) {
      const score = replyScore(line.end, seat, rootTurn, counter, hidden0);
      if (score === null) break;
      replied.push({ line, score });
    }
    const finalists = bestPerFirstAction(
      replied.length > 0 ? replied : found.map((line) => ({ line, score: line.score })),
      finalistCount,
    );

    const totals = finalists.map((entry) => entry.score);
    let scoredOn = 1;
    for (let i = 1; i < dets.length; i += 1) {
      const world = dets[i] as GameState;
      const hidden = hiddenCardIds(world, seat);
      const row: number[] = [];
      for (const entry of finalists) {
        const score = scoreLine(world, seat, entry.line.actions, counter, replied.length > 0, hidden);
        if (score === null) break;
        row.push(score);
      }
      // A world the counter could not finish is left out for every finalist alike.
      if (row.length < finalists.length) break;
      row.forEach((score, index) => {
        totals[index] = (totals[index] ?? 0) + score;
      });
      scoredOn += 1;
    }

    let bestIndex = 0;
    let bestMean = (totals[0] ?? 0) / scoredOn;
    for (let index = 1; index < finalists.length; index += 1) {
      const mean = (totals[index] ?? 0) / scoredOn;
      if (mean > bestMean) {
        bestMean = mean;
        bestIndex = index;
      }
    }

    const chosen = finalists[bestIndex]?.line;
    const action = chosen?.actions[0];
    if (chosen === undefined || action === undefined) {
      const fallback = fallbackAction(candidates);
      return { action: fallback, reason: "fallback", line: [fallback], stats: stats(0) };
    }
    const stoppedBy = counter.stoppedBy !== "exhausted" ? counter.stoppedBy : beamCounter.stoppedBy;
    const reason: DecisionReason = pub.pending !== null && pub.pending.playerId === seat ? "prompt" : "search";
    return { action, reason, line: chosen.actions, stats: stats(bestMean, stoppedBy) };
  } catch {
    thrown += 1;
    const action = fallbackAction(candidates);
    return { action, reason: "fallback", line: [action], stats: stats(0) };
  }
}
