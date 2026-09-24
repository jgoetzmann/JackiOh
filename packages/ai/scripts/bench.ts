// `pnpm --filter @jackioh/ai exec tsx scripts/bench.ts <matchup> <from> <to> [gate|full]`: plays games
// `from..to` of one matchup, set up exactly as the gate sets them up but from the tuning series
// (AI_TUNING_SERIES, never the gate's own AI_GATE.seedSeries), and prints one JSON line per game
// (seed, won, result, turns, decisions, nodes, whether the log replays, ms, the slowest decision),
// then a summary line. A tuning aid: run several ranges in parallel shells to measure a matchup
// quickly. It writes no file. Knobs, all optional: SERIES=<name> plays another series,
// OVERRIDE_<CONFIG>='{…}' merges weights over a config, BAN=id,id replaces the shadow ban,
// OTHER_UNBANNED=1 deals the subject's opponent a deck with no ban, SUBJECT/OPPONENT=greedy|random|ai
// swap a seat's controller, SWAP_DECKS=1 swaps the decks and PLAYED=1 adds the cards each seat played.

import { registerAll } from "@jackioh/cards";
import { AI_DIFFICULTY, createRng, fold, hashState } from "@jackioh/engine";
import {
  AI_BUDGET,
  AI_TUNING_SERIES,
  buildAiDeck,
  AI_EVAL,
  AI_GATE_BUDGET,
  AI_MULLIGAN,
  AI_REPLY,
  AI_SEARCH,
  SHADOW_BAN_IDS,
  gameConfig,
  playMatch,
  type Matchup,
} from "../src/index";

// Tuning overrides, JSON merged over the named config at startup (bench only).
for (const [name, target] of Object.entries({ AI_EVAL, AI_REPLY, AI_SEARCH, AI_GATE_BUDGET, AI_BUDGET, AI_MULLIGAN })) {
  const raw = process.env[`OVERRIDE_${name}`];
  if (raw !== undefined && raw !== "") Object.assign(target as object, JSON.parse(raw));
}

// BAN=id,id,... replaces the shadow ban for this run (bench only).
const banOverride = process.env["BAN"];
if (banOverride !== undefined) {
  const ids = SHADOW_BAN_IDS as string[];
  ids.splice(0, ids.length, ...banOverride.split(",").filter((id) => id !== ""));
}

function main(): void {
  registerAll();
  const [matchupArg, fromArg, toArg, budgetArg] = process.argv.slice(2).filter((arg) => arg !== "--");
  const matchup = (matchupArg ?? "ai-vs-greedy") as Matchup;
  const from = Number(fromArg ?? "1");
  const to = Number(toArg ?? String(from));
  const budget = budgetArg === "full" ? AI_BUDGET : AI_GATE_BUDGET;
  const series = process.env["SERIES"] ?? AI_TUNING_SERIES;

  let wins = 0;
  let draws = 0;
  let games = 0;
  let totalMs = 0;
  let maxDecisionMs = 0;
  for (let n = from; n <= to; n += 1) {
    const config = gameConfig(matchup, n, budget, series);
    const subject = n % 2 === 1 ? "p1" : "p2";
    if (process.env["OTHER_UNBANNED"] === "1") {
      const otherSeat = subject === "p1" ? "p2" : "p1";
      const easy = AI_DIFFICULTY.easy;
      const unbanned = buildAiDeck(createRng(`${config.seed}:deck:${otherSeat}`), easy.deckSize, {
        banned: [],
        manaCap: easy.manaCap,
      });
      config.decks[otherSeat === "p1" ? 0 : 1] = unbanned;
    }
    // SUBJECT=greedy|random|ai swaps the subject's controller (the decks and seats stay the gate's).
    if (process.env["SWAP_DECKS"] === "1") config.decks = [config.decks[1], config.decks[0]];
    const subjectKind = process.env["SUBJECT"];
    if (subjectKind === "greedy" || subjectKind === "random") config.controllers[subject] = { kind: subjectKind };
    const opponentKind = process.env["OPPONENT"];
    const other = subject === "p1" ? "p2" : "p1";
    if (opponentKind === "greedy" || opponentKind === "random") config.controllers[other] = { kind: opponentKind };
    if (opponentKind === "ai") config.controllers[other] = { kind: "ai", budget };
    let slowest = 0;
    const started = performance.now();
    const record = playMatch(config, {
      timeDecision: (seat, run) => {
        const t0 = performance.now();
        const out = run();
        const ms = performance.now() - t0;
        if (seat === subject && ms > slowest) slowest = ms;
        return out;
      },
    });
    const ms = performance.now() - started;
    const replay = fold({ seed: config.seed, decks: config.decks, log: record.log, handicaps: config.handicaps });
    const replayOk = replay.errors.length === 0 && hashState(replay.state) === record.hash;
    const finalState = replay.state;
    const hp = { us: finalState.players[subject].hero.health, them: finalState.players[other].hero.health };
    const won = record.result !== null && record.result.winner === subject;
    const drawn = record.result !== null && record.result.winner === "draw";
    games += 1;
    if (won) wins += 1;
    if (drawn) draws += 1;
    totalMs += ms;
    maxDecisionMs = Math.max(maxDecisionMs, slowest);
    process.stdout.write(
      `${JSON.stringify({
        n,
        seed: config.seed,
        subject,
        won,
        result: record.result,
        turns: record.turns,
        hp,
        decisions: record.decisions,
        nodes: record.nodes,
        rejected: record.rejected.length,
        thrown: record.thrown.length,
        fallbacks: record.fallbacks,
        replayOk,
        ...(process.env["PLAYED"] === "1" ? { played: record.played, subjectPlayed: record.played[subject] } : {}),
        ms: Math.round(ms),
        slowestMs: Math.round(slowest),
      })}\n`,
    );
  }
  process.stdout.write(
    `${JSON.stringify({ summary: true, matchup, from, to, games, wins, draws, ms: Math.round(totalMs), maxDecisionMs: Math.round(maxDecisionMs) })}\n`,
  );
}

main();
