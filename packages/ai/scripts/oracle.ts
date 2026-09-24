// `pnpm --filter @jackioh/ai exec tsx scripts/oracle.ts <matchup> <from> <to> [fromTurn]`: a
// diagnostic for the games the AI does not win. It plays games `from..to` set up as the gate sets
// them up, from the tuning series (SERIES=<name> picks another). For every game the subject did not
// win, it runs the lethal solver on the TRUE state at each of the subject's turn starts from
// `fromTurn` on (default 19): an oracle that sees every hidden card and every coin flip, which
// `decide` never may (R185), so it can tell "a kill was there and the AI missed it" from "there was
// no kill to find". One JSON line per non-win: the result, whether the subject's hero was ever
// ahead on health at one of its turn starts (`everAhead`), and per turn start the two heroes'
// health, whether a lethal was found, the nodes spent and whether the search hit its cap. Writes no
// file.
//
// What it cannot see, so what "no kill" means:
// - The search is depth-first alone (AI_SEARCH.lethalQuickNodes is raised to the cap), and it
//   stops at ORACLE_NODES nodes (default 20,000). A turn start marked `capped` was not searched to
//   the end: no kill was found there, but one may exist.
// - Its moves are the lethal solver's: `candidateActions` (a play's zone variants collapsed to the
//   outer lanes) less position switches and endTurn, lines at most AI_SEARCH.lethalMaxDepth long,
//   positions deduplicated by `searchSignature`, and the opponent's prompts answered with their
//   first legal answer.
// - Only turn starts from `fromTurn` on are searched, and only in games the subject did not win.

import { registerAll } from "@jackioh/cards";
import type { GameState } from "@jackioh/engine";
import type { PlayerId } from "@jackioh/shared";
import { AI_GATE_BUDGET, AI_SEARCH, AI_TUNING_SERIES, createNodeCounter, findLethal, gameConfig, playMatch, type Matchup } from "../src/index";

function main(): void {
  registerAll();
  const [matchupArg, fromArg, toArg, fromTurnArg] = process.argv.slice(2).filter((arg) => arg !== "--");
  const matchup = (matchupArg ?? "ai-vs-random") as Matchup;
  const from = Number(fromArg ?? "1");
  const to = Number(toArg ?? String(from));
  const fromTurn = Number(fromTurnArg ?? "19");
  const series = process.env["SERIES"] ?? AI_TUNING_SERIES;
  const cap = Number(process.env["ORACLE_NODES"] ?? "20000");
  (AI_SEARCH as { lethalQuickNodes: number }).lethalQuickNodes = cap;

  for (let n = from; n <= to; n += 1) {
    const config = gameConfig(matchup, n, AI_GATE_BUDGET, series);
    const subject: PlayerId = n % 2 === 1 ? "p1" : "p2";
    const other: PlayerId = subject === "p1" ? "p2" : "p1";
    const starts: GameState[] = [];
    let everAhead = false;
    let last = -1;
    const record = playMatch(config, {
      afterAction(before, _after, seat) {
        const turnStart = before.turn !== last && before.active === subject && before.phase === "main" && before.pending === null;
        if (seat !== subject || !turnStart) return;
        last = before.turn;
        if (before.players[subject].hero.health > before.players[other].hero.health) everAhead = true;
        if (before.turn >= fromTurn) starts.push(before);
      },
    });
    if (record.result !== null && record.result.winner === subject) continue;

    const rows = starts.map((state) => {
      const counter = createNodeCounter(cap);
      const line = findLethal([state], subject, counter, cap);
      return {
        turn: state.turn,
        us: state.players[subject].hero.health,
        them: state.players[other].hero.health,
        lethal: line !== null,
        nodes: counter.used,
        capped: line === null && counter.used >= cap,
      };
    });
    process.stdout.write(`${JSON.stringify({ n, result: record.result, turns: record.turns, everAhead, rows })}\n`);
  }
}

main();
