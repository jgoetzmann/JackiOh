// `pnpm --filter @jackioh/ai exec tsx scripts/duel.ts <matchup> <from> <to>`: bench.ts with the
// weights set per seat, so that a changed AI can play the AI as it stands, or both can play the same
// deals against a baseline. Games are set up as the gate sets them up, from the tuning series
// (SERIES=<name> picks another). One JSON line per game: whether the subject won, drew or lost, the
// final hash (two runs of a deal are the same game exactly when their hashes match), whether the log
// replays, and the subject's decision count and time. Writes no file. Knobs, all optional:
// SUBJECT_<CONFIG>='{…}' and OPPONENT_<CONFIG>='{…}' merge over AI_SEARCH, AI_EVAL or AI_REPLY
// around that seat's decisions only; SUBJECT_BUDGET and OPPONENT_BUDGET merge over the seat's
// SearchBudget; OPPONENT=ai|greedy|random replaces the opponent's controller; SWAP_DECKS=1 swaps
// the decks, so that a deal played both ways cancels out which deck was the better one.

import { registerAll } from "@jackioh/cards";
import { fold, hashState } from "@jackioh/engine";
import type { PlayerId } from "@jackioh/shared";
import {
  AI_EVAL,
  AI_GATE_BUDGET,
  AI_REPLY,
  AI_SEARCH,
  AI_TUNING_SERIES,
  gameConfig,
  playMatch,
  type Matchup,
  type SearchBudget,
} from "../src/index";

const CONFIGS: Record<string, object> = { AI_SEARCH, AI_EVAL, AI_REPLY };
const SNAPSHOT: Record<string, unknown> = JSON.parse(JSON.stringify(CONFIGS));

function deepAssign(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(source)) {
    const held = target[key];
    if (value !== null && typeof value === "object" && !Array.isArray(value) && held !== null && typeof held === "object") {
      deepAssign(held as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      target[key] = value;
    }
  }
}

function overridesFor(role: "SUBJECT" | "OPPONENT"): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const name of Object.keys(CONFIGS)) {
    const raw = process.env[`${role}_${name}`];
    if (raw !== undefined && raw !== "") out[name] = JSON.parse(raw);
  }
  return out;
}

function applyFor(overrides: Record<string, Record<string, unknown>>): void {
  for (const [name, target] of Object.entries(CONFIGS)) {
    deepAssign(target as Record<string, unknown>, JSON.parse(JSON.stringify(SNAPSHOT[name])));
    const extra = overrides[name];
    if (extra !== undefined) deepAssign(target as Record<string, unknown>, extra);
  }
}

function budgetFor(role: "SUBJECT" | "OPPONENT"): SearchBudget {
  const raw = process.env[`${role}_BUDGET`];
  return raw !== undefined && raw !== "" ? { ...AI_GATE_BUDGET, ...JSON.parse(raw) } : AI_GATE_BUDGET;
}

function main(): void {
  registerAll();
  const [matchupArg, fromArg, toArg] = process.argv.slice(2).filter((arg) => arg !== "--");
  const matchup = (matchupArg ?? "ai-vs-greedy") as Matchup;
  const from = Number(fromArg ?? "1");
  const to = Number(toArg ?? String(from));
  const series = process.env["SERIES"] ?? AI_TUNING_SERIES;
  const subjectOverrides = overridesFor("SUBJECT");
  const opponentOverrides = overridesFor("OPPONENT");

  for (let n = from; n <= to; n += 1) {
    const config = gameConfig(matchup, n, AI_GATE_BUDGET, series);
    const subject: PlayerId = n % 2 === 1 ? "p1" : "p2";
    const other: PlayerId = subject === "p1" ? "p2" : "p1";
    if (process.env["SWAP_DECKS"] === "1") config.decks = [config.decks[1], config.decks[0]];
    const opponentKind = process.env["OPPONENT"];
    if (opponentKind === "greedy" || opponentKind === "random") config.controllers[other] = { kind: opponentKind };
    if (opponentKind === "ai") config.controllers[other] = { kind: "ai", budget: budgetFor("OPPONENT") };
    if (config.controllers[subject].kind === "ai") config.controllers[subject] = { kind: "ai", budget: budgetFor("SUBJECT") };
    if (config.controllers[other].kind === "ai" && opponentKind === undefined) {
      config.controllers[other] = { kind: "ai", budget: budgetFor("OPPONENT") };
    }

    const times: Record<PlayerId, number[]> = { p1: [], p2: [] };
    const record = playMatch(config, {
      timeDecision: (seat, run) => {
        applyFor(seat === subject ? subjectOverrides : opponentOverrides);
        const t0 = performance.now();
        const out = run();
        times[seat].push(performance.now() - t0);
        return out;
      },
    });
    applyFor({});
    const replay = fold({ seed: config.seed, decks: config.decks, log: record.log, handicaps: config.handicaps });
    const replayOk = replay.errors.length === 0 && hashState(replay.state) === record.hash;
    const mine = times[subject];
    const sorted = [...mine].sort((a, b) => a - b);
    process.stdout.write(
      `${JSON.stringify({
        n,
        subject,
        won: record.result !== null && record.result.winner === subject,
        draw: record.result === null || record.result.winner === "draw",
        lost: record.result !== null && record.result.winner === other,
        turns: record.turns,
        hash: record.hash,
        nodes: record.nodes,
        rejected: record.rejected.length,
        thrown: record.thrown.length,
        fallbacks: record.fallbacks,
        replayOk,
        decisions: mine.length,
        msSum: Math.round(mine.reduce((a, b) => a + b, 0)),
        msMax: Math.round(sorted.at(-1) ?? 0),
        msP95: Math.round(sorted[Math.floor(sorted.length * 0.95)] ?? 0),
      })}\n`,
    );
  }
}

main();
