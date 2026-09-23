// `pnpm ai:sweep` (R186): the run that decides the AI's shadow ban.
//
// For every non-token Core card and every tier in AI_SWEEP.tiers, `sweepCard` forces the card into
// AI decks on that tier's handicap against the greedy baseline (AI_SWEEP.seedsPerCard games each,
// at AI_GATE_BUDGET) and flags errors, slow decisions, a card that sat affordable in hand and was
// never played, and plays that lowered the AI's own evaluation. `sweepVerdict` joins a card's tiers:
// a flag at any tier bans it, and a card never once affordable at any tier is listed as unswept.
// This prints the flagged rows, the unswept cards, then the ready-made SHADOW_BAN entries and the
// header line for packages/ai/src/shadowBan.ts. It always exits 0: the ban is copied in by hand
// from this output, never edited to taste.
//
//   pnpm ai:sweep                          every non-token Core card, every tier
//   pnpm ai:sweep core-011 core-020        only these ids
//   pnpm ai:sweep --json core-011 …        one JSON SweepResult per line instead of the report
//                                          (run slices of the id list in parallel this way)
//   pnpm ai:sweep --report a.jsonl b.jsonl the report from those lines
//
// Node tooling, so it may read the clock (`performance.now` for decision timing), read files and
// write to the console; src/ stays pure and receives the clock as `now`.

import { readFileSync } from "node:fs";
import { CATALOG, registerAll } from "@jackioh/cards";
import { query } from "@jackioh/engine";
import {
  AI_GATE_BUDGET,
  AI_SWEEP,
  sweepCard,
  sweepVerdict,
  type SweepResult,
  type SweepVerdict,
} from "../src/index";

/** The mean evaluate change per play, and each card's seconds, printed to this many decimals. */
const DELTA_DECIMALS = 1;

const MS_PER_SECOND = 1000;

function nameOf(defId: string): string {
  return CATALOG[defId]?.name ?? defId;
}

function meanDelta(result: SweepResult): string {
  if (result.evalDeltaCount === 0) return "n/a";
  return (result.evalDeltaSum / result.evalDeltaCount).toFixed(DELTA_DECIMALS);
}

function row(result: SweepResult): string {
  const cells = [
    result.defId,
    nameOf(result.defId),
    result.tier,
    result.flags.join(", "),
    `${result.drawnGames}/${result.games}`,
    String(result.affordableTurns),
    String(result.plays),
    String(result.errors),
    String(result.timeouts),
    meanDelta(result),
  ].map((cell) => ` ${cell.replace(/\|/g, "\\|")} `);
  return `|${cells.join("|")}|`;
}

function sweepIds(ids: readonly string[], log: (line: string) => void): SweepResult[] {
  const results: SweepResult[] = [];
  ids.forEach((id, index) => {
    for (const tier of AI_SWEEP.tiers) {
      const cardStarted = performance.now();
      const result = sweepCard(id, { now: () => performance.now(), tier });
      const seconds = ((performance.now() - cardStarted) / MS_PER_SECOND).toFixed(DELTA_DECIMALS);
      log(
        `[ai:sweep] ${index + 1}/${ids.length} ${id} ${nameOf(id)} @${tier}: ` +
          `${result.flags.length > 0 ? result.flags.join(", ") : result.unswept ? "unswept" : "clean"} (${seconds}s)`,
      );
      results.push(result);
    }
  });
  return results;
}

function report(results: readonly SweepResult[], cards: number, elapsed: number | null): string {
  const byCard = new Map<string, SweepResult[]>();
  for (const result of results) byCard.set(result.defId, [...(byCard.get(result.defId) ?? []), result]);
  const verdicts: SweepVerdict[] = [...byCard.values()].map((list) => sweepVerdict(list));
  const banned = verdicts.filter((verdict) => verdict.reason !== null).sort((a, b) => (a.defId < b.defId ? -1 : 1));
  const unswept = verdicts.filter((verdict) => verdict.unswept).sort((a, b) => (a.defId < b.defId ? -1 : 1));

  // The run's date for shadowBan.ts's header. Intl formats "today" without a Date expression, which
  // this package's lint bans everywhere, tooling included.
  const date = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC" }).format();
  const budget = JSON.stringify(AI_GATE_BUDGET);
  const tiers = AI_SWEEP.tiers.join(" and ");

  const out: string[] = [];
  out.push("# AI shadow-ban sweep");
  out.push("");
  out.push(
    `Run ${date} (UTC): ${cards} card(s) at ${tiers}, ${AI_SWEEP.seedsPerCard} seeds each ` +
      `(\`sweep:<tier>:<id>:1..${AI_SWEEP.seedsPerCard}\`), budget AI_GATE_BUDGET ${budget}, ` +
      `${banned.length} flagged, ${unswept.length} unswept${elapsed === null ? "" : `, ${elapsed}s`}.`,
  );
  out.push("");
  const flaggedRows = results.filter((result) => result.flags.length > 0);
  if (flaggedRows.length === 0) {
    out.push("No card was flagged at any tier.");
  } else {
    out.push("| id | name | tier | flags | drawn/games | affordable turns | plays | errors | timeouts | mean eval delta |");
    out.push("|---|---|---|---|---|---|---|---|---|---|");
    for (const result of flaggedRows) out.push(row(result));
  }
  out.push("");
  out.push("## Unswept (never affordable at any tier: no evidence either way)");
  out.push("");
  out.push(unswept.length === 0 ? "None." : unswept.map((verdict) => `- ${verdict.defId} ${nameOf(verdict.defId)}`).join("\n"));
  out.push("");
  out.push("## For packages/ai/src/shadowBan.ts");
  out.push("");
  out.push("Header line:");
  out.push("");
  out.push(
    `// Sweep of record: ${date} (UTC), \`pnpm ai:sweep\` over ${cards} non-token Core cards at ${tiers}, ` +
      `${AI_SWEEP.seedsPerCard} seeds per card and tier (\`sweep:<tier>:<id>:<n>\`), budget AI_GATE_BUDGET ${budget}.`,
  );
  out.push("");
  out.push("Entries:");
  out.push("");
  out.push("```ts");
  for (const verdict of banned) out.push(`  ${JSON.stringify(verdict.defId)}: ${JSON.stringify(verdict.reason)},`);
  out.push("```");
  return `${out.join("\n")}\n`;
}

function main(): void {
  registerAll();

  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  if (args[0] === "--report") {
    const results = args
      .slice(1)
      .flatMap((file) => readFileSync(file, "utf8").split("\n"))
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as SweepResult);
    const cards = new Set(results.map((result) => result.defId)).size;
    process.stdout.write(report(results, cards, null));
    return;
  }

  const json = args[0] === "--json";
  const requested = json ? args.slice(1) : args;
  const pool = query({ set: "Core" }).map((def) => def.id);
  const unknown = requested.filter((id) => !pool.includes(id));
  if (unknown.length > 0) {
    process.stderr.write(`[ai:sweep] not non-token Core ids, skipped: ${unknown.join(", ")}\n`);
  }
  const ids = requested.length > 0 ? pool.filter((id) => requested.includes(id)) : pool;

  const started = performance.now();
  const results = sweepIds(ids, (line) => process.stderr.write(`${line}\n`));
  const elapsed = Math.round((performance.now() - started) / MS_PER_SECOND);

  if (json) {
    for (const result of results) process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  process.stdout.write(report(results, ids.length, elapsed));
}

main();
