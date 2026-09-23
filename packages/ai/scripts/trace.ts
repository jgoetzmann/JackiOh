// Tuning aid: replays game n of a matchup, set up as the gate sets it up but from the tuning series
// (AI_TUNING_SERIES; SERIES=<name> picks another), and prints it turn by turn. Writes no file.
//   pnpm --filter @jackioh/ai exec tsx scripts/trace.ts ai-vs-greedy 3 [gate|full]
// Takes bench.ts's OVERRIDE_<CONFIG> and BAN knobs.

import { registerAll } from "@jackioh/cards";
import { PLAYER_IDS, type ActionBody, type PlayerId } from "@jackioh/shared";
import { activeUnitsOf, findDef, findInstance, unitView, type GameState } from "@jackioh/engine";
import {
  AI_BUDGET,
  AI_EVAL,
  AI_GATE_BUDGET,
  AI_REPLY,
  AI_SEARCH,
  AI_TUNING_SERIES,
  SHADOW_BAN_IDS,
  evaluate,
  gameConfig,
  playMatch,
  type Matchup,
} from "../src/index";

// Tuning overrides, as in bench.ts.
for (const [name, target] of Object.entries({ AI_EVAL, AI_REPLY, AI_SEARCH, AI_GATE_BUDGET, AI_BUDGET })) {
  const raw = process.env[`OVERRIDE_${name}`];
  if (raw !== undefined && raw !== "") Object.assign(target as object, JSON.parse(raw));
}

const banOverride = process.env["BAN"];
if (banOverride !== undefined) {
  const ids = SHADOW_BAN_IDS as string[];
  ids.splice(0, ids.length, ...banOverride.split(",").filter((id) => id !== ""));
}

function nameOf(state: GameState, defId: string): string {
  return findDef(state, defId)?.name ?? defId;
}

function board(state: GameState, p: PlayerId): string {
  const units = activeUnitsOf(state, p).map((u) => {
    const v = unitView(state, u);
    const kw = v.keywords.map((k) => k.kind[0]).join("");
    return `${nameOf(state, u.defId)}${u.radiant ? "*" : ""} ${v.attack}/${v.health}${v.position === "DEF" ? " DEF" : ""}${kw ? " [" + kw + "]" : ""}`;
  });
  const side = state.players[p];
  const back = side.backrow.filter((c) => c !== null).map((c) => nameOf(state, c!.defId));
  return `${p} hp ${side.hero.health} mana ${side.mana.current}/${side.mana.max} hand ${side.hand.length} lib ${side.library.length} | ${units.join(", ")}${back.length ? " || " + back.join(", ") : ""}`;
}

function describe(state: GameState, seat: PlayerId, action: ActionBody): string {
  if (action.type === "play") {
    const card = findInstance(state, action.instanceId);
    const targets = "targets" in action && action.targets ? JSON.stringify(action.targets) : "";
    return `play ${card ? nameOf(state, card.defId) : action.instanceId} ${targets}`;
  }
  if (action.type === "attack") {
    const a = findInstance(state, action.attackerId);
    const t = action.targetId.startsWith("hero") ? action.targetId : findInstance(state, action.targetId);
    const tn = typeof t === "string" ? t : t ? `${nameOf(state, t.defId)}` : action.targetId;
    return `attack ${a ? nameOf(state, a.defId) : action.attackerId} -> ${tn}`;
  }
  if (action.type === "switchPosition") {
    const a = findInstance(state, action.instanceId);
    return `switch ${a ? nameOf(state, a.defId) : ""}`;
  }
  return JSON.stringify(action);
}

function main(): void {
  registerAll();
  const [matchupArg, nArg, budgetArg] = process.argv.slice(2).filter((a) => a !== "--");
  const matchup = (matchupArg ?? "ai-vs-greedy") as Matchup;
  const n = Number(nArg ?? "1");
  const series = process.env["SERIES"] ?? AI_TUNING_SERIES;
  const config = gameConfig(matchup, n, budgetArg === "full" ? AI_BUDGET : AI_GATE_BUDGET, series);
  const subject = n % 2 === 1 ? "p1" : "p2";
  console.log(`subject ${subject}; decks:`);
  for (const p of PLAYER_IDS) console.log(`  ${p}`, config.decks[p === "p1" ? 0 : 1].join(" "));
  let lastTurn = -1;
  const record = playMatch(config, {
    afterAction(before, after, seat, action) {
      if (before.turn !== lastTurn && before.phase === "main") {
        lastTurn = before.turn;
        console.log(`\n== turn ${before.turn} active ${before.active} (eval for subject ${evaluate(before, subject).toFixed(1)})`);
        for (const p of PLAYER_IDS) console.log("   " + board(before, p));
        const hand = before.players[before.active].hand.map((c) => nameOf(before, c.defId)).join(", ");
        console.log(`   hand(${before.active}): ${hand}`);
      }
      const who = seat === subject ? "AI " : "OPP";
      console.log(`  ${who} ${describe(before, seat, action)}`);
      void after;
    },
  });
  console.log("\nresult", JSON.stringify(record.result), "turns", record.turns);
}

main();
