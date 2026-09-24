// The M4 gate (BUILD "M4 gate", SPEC §10.9, REVIEW B8).
//
//   "cards/test/fuzz.test.ts: 1,000 games per wave (seeds 1–1000) with decks drawn randomly from
//    all implemented cards, played by aiPolicy, never throw, always terminate (hero death or cap),
//    and replay to the same hash. Any card that appears in a failing seed is listed in the failure
//    message."
//
// Four assertions per seed, in this order:
//   1. NO THROW       — playing the game out raises nothing.
//   2. TERMINATION    — the game reaches a real `state.result` (hero death, both heroes dead, or
//                       the R2 turn cap at TURN_CAP_PLAYER_TURNS player-turns), inside a bounded
//                       number of actions. The bound is not a pass condition: hitting it is a
//                       reported failure, so a non-terminating game fails loudly instead of
//                       hanging CI (the policy never concedes or offers a draw, R84, so those
//                       endings cannot occur here).
//   3. REPLAY EQUALITY— folding `(seed, decks, log)` in a fresh `createGame` reproduces the same
//                       state hash, with no rejected actions. This is what makes SPEC §9.3's
//                       "(seed, log) reconstructs any match" true.
//   4. FAILURE DETAIL — every card id in the failing seed's two decks is named in the report,
//                       because a bare seed number is useless against a 100-card pool.
// And at every step, INVARIANTS: `_invariants.ts`'s I1–I4 (summoning sickness and exertion, R171)
// hold on the state each action is chosen in and on the state it produces (stage "invariant").
//
// Determinism (SPEC §9.3, §10.7, CLAUDE.md rule 4): nothing here reads `Math.random` or the clock.
// The deck draw, the game and the policy each come from `createRng` over a seed string derived from
// the seed number, so a reported seed reproduces its game exactly, in this process or any other.
//
// The policy rng is deliberately SEPARATE from the game rng: `reduce` is called without an rng, so
// it builds its own from `(state.seed, state.rngCursor)` exactly as `fold` does. The policy's
// coin flips are therefore outside the state, and the recorded action log is the only thing replay
// needs — which is the property assertion 3 exists to prove.
//
// HOW TO RUN
//   pnpm fuzz                                            the gate: seeds 1–1000, ~100 s
//   pnpm test                                            seeds 1–100, ~6 s (see SWEEP_SEEDS)
//   JACKIOH_FUZZ_FROM=<seed> JACKIOH_FUZZ_SEEDS=1 pnpm fuzz    one seed a report named

import { describe, expect, it } from "vitest";
import type { Action, ActionBody, PlayerId } from "@jackioh/shared";
import {
  DECK_SIZE,
  TURN_CAP_PLAYER_TURNS,
  beginGame,
  createGame,
  createRng,
  fold,
  hashState,
  reduce,
  subsystems,
  type GameState,
} from "@jackioh/engine";
import { CATALOG, registerAll } from "../src/index";
import { createInvariantMonitor } from "./_invariants";

// ---------------------------------------------------------------------------------------------
// Wave size
// ---------------------------------------------------------------------------------------------

/** BUILD M4 gate: seeds 1–1000, one game each. This is the gate and the default. */
export const WAVE_SEEDS = 1000;

/**
 * The wave `pnpm test` runs.
 *
 * `packages/cards/vitest.config.ts` includes `test/**\/*.test.ts`, so this file is swept into a
 * plain `pnpm test` as well as selected by name by `pnpm fuzz` — and the full wave is ~100 s
 * against ~5 s for the other 110 cards files put together. BUILD's own definition of done splits
 * them the same way: `pnpm test` is one line and "Fuzz gate: 1,000 seeds with the full card pool"
 * is another. So the whole-suite sweep runs the first 100 seeds (~6 s) as a smoke wave and
 * `pnpm fuzz` runs all 1,000. The smoke wave is the same games, same pool and same four
 * assertions — the coverage of the CARD POOL is never narrowed, only the number of seeds — and
 * both the test title and the summary line say which wave ran.
 */
export const SWEEP_SEEDS = 100;

/**
 * Whether this process is the whole-suite sweep. Only a positively identified `pnpm test` /
 * `pnpm test:coverage` shortens the wave; every other way in — `pnpm fuzz`, a bare
 * `vitest run --project cards fuzz`, a CI step that calls vitest directly — gets the full 1,000,
 * because the safe default when the caller is unknown is the gate, not the smoke test.
 *
 * (`process.argv` in a vitest worker is just the worker entry point and carries no CLI filter, and
 * no `VITEST_*` variable exposes one; the npm lifecycle variables are the only signal that reaches
 * a forked worker.)
 */
function isWholeSuiteSweep(): boolean {
  const script = process.env["npm_lifecycle_event"];
  return script === "test" || script === "test:coverage";
}

/**
 * How many seeds this run plays (from `firstSeed()`, which is 1 unless a developer moves it).
 * `JACKIOH_FUZZ_SEEDS=25 pnpm fuzz` narrows it by hand while chasing a failure; it can never widen
 * the wave past WAVE_SEEDS, and the summary line always reports which seeds actually ran.
 */
export function waveSize(): number {
  const raw = process.env["JACKIOH_FUZZ_SEEDS"];
  if (raw !== undefined && raw.trim() !== "") {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed >= 1) return Math.min(parsed, WAVE_SEEDS);
  }
  return isWholeSuiteSweep() ? SWEEP_SEEDS : WAVE_SEEDS;
}

/**
 * The first seed of the wave. 1 for the gate; `JACKIOH_FUZZ_FROM=700 JACKIOH_FUZZ_SEEDS=1 pnpm
 * fuzz` replays exactly the seed a report named, without the 699 before it. A seed is its own
 * game whatever wave it sits in, so this changes which games run and nothing about how they run.
 */
export function firstSeed(): number {
  const raw = process.env["JACKIOH_FUZZ_FROM"];
  if (raw === undefined || raw.trim() === "") return 1;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : 1;
}

/**
 * Actions one game may take before it is declared non-terminating. A game is capped at
 * TURN_CAP_PLAYER_TURNS (30) player-turns and a turn is capped at AI_PLAYOUT_STEP_CAP (500)
 * policy steps, so 30 × 500 is the engine's own worst case; this bound sits at that ceiling so it
 * can only ever fire on a genuine loop, never on a long-but-legal game.
 */
const MAX_ACTIONS_PER_GAME = TURN_CAP_PLAYER_TURNS * subsystems.AI_PLAYOUT_STEP_CAP;

/** §2.5 plus R84: the policy never concedes or offers a draw, so only these three can occur. */
const TERMINAL_REASONS: readonly string[] = ["hero-death", "both-heroes-dead", "turn-cap"];

// ---------------------------------------------------------------------------------------------
// The deck pool
// ---------------------------------------------------------------------------------------------

/**
 * Cards deliberately kept OUT of the fuzz deck pool.
 *
 * This list is the only way coverage is ever narrowed, and it must stay empty in a green tree: the
 * BUILD definition of done is "1,000 seeds with the full card pool". Anything parked here is a
 * known-unimplemented or known-broken card that hides every other bug behind its own, and each
 * entry carries the reason and the issue it is waiting on. Emptying it is the fix; adding to it to
 * make the gate green is not.
 */
export const POOL_EXCLUSIONS: readonly { id: string; why: string }[] = [];

const EXCLUDED_IDS: ReadonlySet<string> = new Set(POOL_EXCLUSIONS.map((entry) => entry.id));

/**
 * Every deck-legal card: the whole catalog minus tokens (§2.6 L3, which `validateDeck` enforces)
 * minus `POOL_EXCLUSIONS`. Sorted by catalog id so the pool a seed shuffles is identical on every
 * machine and in every process, whatever order the registry handed the defs over.
 */
export const FUZZ_POOL: readonly string[] = Object.entries(CATALOG)
  .filter(([, def]) => def.token !== true && !def.tags.includes("Token"))
  .map(([id]) => id)
  .filter((id) => !EXCLUDED_IDS.has(id))
  .sort();

const CARD_NAMES: ReadonlyMap<string, string> = new Map(
  Object.entries(CATALOG).map(([id, def]) => [id, `${def.name} (#${def.index})`]),
);

function describeCard(id: string): string {
  return `${id} — ${CARD_NAMES.get(id) ?? "unknown card"}`;
}

/**
 * The seed drives the deck draw (§9.3): one seeded shuffle of the whole pool, the first 20 cards to
 * p1 and the next 20 to p2. One shuffle rather than two draws means the 40 cards are distinct, so
 * `validateDeck`'s "no duplicate card ids" (§2.6 L3) holds by construction for both decks, and a
 * reported seed rebuilds its exact deck pair with no other input.
 */
export function decksForSeed(seed: number): [string[], string[]] {
  const rng = createRng(`jackioh-fuzz-decks-${seed}`);
  const shuffled = rng.shuffle(FUZZ_POOL);
  return [shuffled.slice(0, DECK_SIZE), shuffled.slice(DECK_SIZE, DECK_SIZE * 2)];
}

// ---------------------------------------------------------------------------------------------
// Playing one game with the real policy
// ---------------------------------------------------------------------------------------------

type FailureStage = "play" | "termination" | "replay" | "invariant";

/**
 * An error carrying the stage it happened in, so the report can group by kind as well as by text,
 * plus how far the game had got — a raw throw out of `playGame` leaves no run for the report to
 * read that from.
 */
class FuzzFailure extends Error {
  constructor(
    readonly stage: FailureStage,
    message: string,
    readonly at: { turn: number; actions: number },
  ) {
    super(message);
    this.name = "FuzzFailure";
  }
}

type GameRun = {
  state: GameState;
  log: Action[];
  decks: [string[], string[]];
};

/**
 * One full game played by SPEC §10.7's policy. `subsystems.chooseAction` IS that policy — uniform
 * over `legalActions` minus `AI_SKIPPED_ACTIONS` (R84), ending the turn when nothing else is on
 * offer or with `AI_END_TURN_PROBABILITY`, and answering an open prompt uniformly (R44) — so this
 * drives the shipped machinery rather than a second copy of the rule.
 */
function playGame(seed: number): GameRun {
  const gameSeed = `jackioh-fuzz-${seed}`;
  const decks = decksForSeed(seed);
  registerAll();

  let state = beginGame(createGame({ seed: gameSeed, decks })).state;
  const policy = createRng(`jackioh-fuzz-policy-${seed}`);
  const log: Action[] = [];
  const monitor = createInvariantMonitor(state);

  while (state.result === null) {
    if (log.length >= MAX_ACTIONS_PER_GAME) {
      throw new FuzzFailure(
        "termination",
        `game did not terminate within ${MAX_ACTIONS_PER_GAME} actions ` +
          `(turn ${state.turn}/${TURN_CAP_PLAYER_TURNS}, phase "${state.phase}", ` +
          `pending ${state.pending === null ? "none" : `"${state.pending.kind}"`})`,
        { turn: state.turn, actions: log.length },
      );
    }

    // With a prompt open only its holder may act (§9.3); otherwise it is the active player's turn.
    const player: PlayerId = state.pending?.playerId ?? state.active;
    const chosen: ActionBody | null = subsystems.chooseAction(state, player, policy);
    if (chosen === null) {
      throw new FuzzFailure(
        "termination",
        `no legal action for ${player} while the game is live ` +
          `(turn ${state.turn}, phase "${state.phase}", ` +
          `pending ${state.pending === null ? "none" : `"${state.pending.kind}"`}): ` +
          "R82 auto-ends a turn with nothing left to do, so this is a stall, not an ending",
        { turn: state.turn, actions: log.length },
      );
    }

    const unsound = monitor.before(state, player, chosen);
    if (unsound[0] !== undefined) {
      throw new FuzzFailure("invariant", unsound[0], { turn: state.turn, actions: log.length });
    }

    const action = { ...chosen, playerId: player, nonce: `fuzz-${log.length}` } as Action;
    const result = reduce(state, action);
    if (result.error !== undefined) {
      throw new FuzzFailure(
        "play",
        `legalActions offered "${action.type}" but reduce refused it: ${result.error}`,
        { turn: state.turn, actions: log.length },
      );
    }

    log.push(action);
    state = result.state;

    const broken = monitor.after(result.events, state);
    if (broken[0] !== undefined) {
      throw new FuzzFailure("invariant", broken[0], { turn: state.turn, actions: log.length });
    }
  }

  return { state, log, decks };
}

/** Assertion 2: the game ended the way §2.5 says a policy game can end, inside the R2 cap. */
function checkTermination(run: GameRun): void {
  const at = { turn: run.state.turn, actions: run.log.length };
  const result = run.state.result;
  if (result === null) {
    throw new FuzzFailure("termination", "the game loop exited with no result", at);
  }
  if (!TERMINAL_REASONS.includes(result.reason)) {
    throw new FuzzFailure(
      "termination",
      `ended with reason "${result.reason}"; the policy never concedes or offers a draw (R84), ` +
        `so §2.5 leaves only ${TERMINAL_REASONS.join(", ")}`,
      at,
    );
  }
  if (run.state.turn > TURN_CAP_PLAYER_TURNS) {
    throw new FuzzFailure(
      "termination",
      `reached turn ${run.state.turn}, past the R2 cap of ${TURN_CAP_PLAYER_TURNS} player-turns`,
      at,
    );
  }
  if (run.state.phase !== "over") {
    throw new FuzzFailure(
      "termination",
      `finished in phase "${run.state.phase}" rather than "over"`,
      at,
    );
  }
}

/** Assertion 3: `(seed, log)` is the truth (§9.3). Fold from scratch and compare the hash. */
function checkReplay(seed: number, run: GameRun): void {
  const at = { turn: run.state.turn, actions: run.log.length };
  registerAll();
  const replayed = fold({ seed: `jackioh-fuzz-${seed}`, decks: run.decks, log: run.log });

  if (replayed.errors.length > 0) {
    const first = replayed.errors[0];
    throw new FuzzFailure(
      "replay",
      `replaying the log rejected ${replayed.errors.length} action(s); first at nonce ` +
        `"${first?.nonce}": ${first?.error}`,
      at,
    );
  }

  const live = hashState(run.state);
  const again = hashState(replayed.state);
  if (live !== again) {
    throw new FuzzFailure(
      "replay",
      `replay hash ${again} != live hash ${live} after ${run.log.length} actions ` +
        "— folding (seed, log) did not reproduce the match (§9.3)",
      at,
    );
  }

  const liveResult = JSON.stringify(run.state.result);
  const replayedResult = JSON.stringify(replayed.state.result);
  if (liveResult !== replayedResult) {
    throw new FuzzFailure("replay", `replay ended ${replayedResult}, live ended ${liveResult}`, at);
  }
}

// ---------------------------------------------------------------------------------------------
// Failure collection and the grouped report
// ---------------------------------------------------------------------------------------------

type Failure = {
  seed: number;
  stage: FailureStage;
  signature: string;
  message: string;
  cards: string[];
  turn: number;
  actions: number;
};

/**
 * A stable shape for one bug: the message with the parts that vary between seeds blanked out
 * (instance ids, card ids, hashes, quoted text and bare numbers). 400 seeds tripping over one
 * missing effect collapse to a single group instead of 400 lines of noise. SPEC and ruling
 * references survive the blanking, because "§9.3" and "R81" are the most identifying part of an
 * engine error message.
 */
function signatureOf(stage: FailureStage, message: string): string {
  const shape = message
    .replace(/"[^"]*"/g, '"…"')
    .replace(/\bcore-[0-9a-z.-]+\b/g, "<card>")
    .replace(/\bc\d+\b/g, "<inst>")
    .replace(/\b[0-9a-f]{8}\b/g, "<hash>")
    // One pass: a §x.y or Rn reference is kept whole, any other run of digits becomes N.
    .replace(/§\d+(?:\.\d+)*|\bR\d+\b|\d+/g, (match) => (/^\d+$/.test(match) ? "N" : match))
    .trim();
  return `[${stage}] ${shape}`;
}

/** The first `packages/` frame of a stack: where a raw engine or card-script throw came from. */
function originOf(error: Error): string {
  const frame = (error.stack ?? "")
    .split("\n")
    .slice(1)
    .map((line) => line.trim())
    .find((line) => line.includes("/packages/") && !line.includes("/test/fuzz.test.ts"));
  if (frame === undefined) return "";
  const at = frame.replace(/^at\s+/, "").replace(/.*?(packages\/[^\s)]+).*/, "$1");
  return ` [at ${at}]`;
}

function countBy(values: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return counts;
}

/**
 * The failure message BUILD asks for: every card id in a failing seed's decks, grouped so one bug
 * reads as one entry. Per group it prints the seeds, the cards present in EVERY failing seed of the
 * group (the narrowest suspects), the most frequent cards, and the full 40-card deck pair of the
 * first seed, which is the one a reader reproduces with.
 */
function report(failures: readonly Failure[], ran: number, elapsedMs: number): string {
  const groups = new Map<string, Failure[]>();
  for (const failure of failures) {
    const bucket = groups.get(failure.signature);
    if (bucket === undefined) groups.set(failure.signature, [failure]);
    else bucket.push(failure);
  }
  const ordered = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);

  const lines: string[] = [];
  lines.push(
    `M4 fuzz gate: ${failures.length} of ${ran} seeds failed ` +
      `(${ordered.length} distinct failure signature(s), ${Math.round(elapsedMs / 1000)}s).`,
  );
  lines.push(`Pool: ${FUZZ_POOL.length} deck-legal cards, ${POOL_EXCLUSIONS.length} excluded.`);
  lines.push("");

  ordered.forEach(([signature, bucket], index) => {
    const seeds = bucket.map((failure) => failure.seed);
    const first = bucket[0] as Failure;
    const counts = countBy(bucket.flatMap((failure) => failure.cards));
    const always = [...counts.entries()]
      .filter(([, n]) => n === bucket.length)
      .map(([id]) => id)
      .sort();
    const frequent = [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, 10);

    lines.push(`--- signature ${index + 1}/${ordered.length} — ${bucket.length} seed(s) ---`);
    lines.push(`  ${signature}`);
    lines.push(`  example: seed ${first.seed} (turn ${first.turn}, ${first.actions} actions)`);
    lines.push(`  message: ${first.message}`);
    lines.push(`  seeds: ${seeds.slice(0, 40).join(", ")}${seeds.length > 40 ? `, … (${seeds.length} total)` : ""}`);
    if (bucket.length > 1) {
      lines.push(
        always.length > 0
          ? `  in EVERY failing seed of this group (${always.length}): ${always.map(describeCard).join("; ")}`
          : "  in EVERY failing seed of this group: none — the cause is shared, not a single card",
      );
      lines.push(
        `  most frequent: ${frequent.map(([id, n]) => `${id}×${n}`).join(", ")}`,
      );
    }
    lines.push(`  seed ${first.seed} p1 deck: ${(first.cards.slice(0, DECK_SIZE)).join(", ")}`);
    lines.push(`  seed ${first.seed} p2 deck: ${(first.cards.slice(DECK_SIZE)).join(", ")}`);
    lines.push("");
  });

  const allCards = [...new Set(failures.flatMap((failure) => failure.cards))].sort();
  lines.push(`Cards appearing in at least one failing seed (${allCards.length}):`);
  lines.push(`  ${allCards.join(", ")}`);
  lines.push("");
  lines.push("Reproduce one seed with: JACKIOH_FUZZ_FROM=<seed> JACKIOH_FUZZ_SEEDS=1 pnpm fuzz");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------------------------

describe("fuzz (M4 gate)", () => {
  it("draws both decks from the seed alone", () => {
    expect(FUZZ_POOL.length).toBeGreaterThanOrEqual(DECK_SIZE * 2);
    for (const seed of [1, 500, 1000]) {
      const [p1, p2] = decksForSeed(seed);
      expect(decksForSeed(seed), `seed ${seed} must redraw identically`).toEqual([p1, p2]);
      expect(p1).toHaveLength(DECK_SIZE);
      expect(p2).toHaveLength(DECK_SIZE);
      // §2.6 L3: no duplicate ids inside a deck, and one shuffle keeps the pair disjoint too.
      expect(new Set([...p1, ...p2]).size).toBe(DECK_SIZE * 2);
      for (const id of [...p1, ...p2]) expect(FUZZ_POOL).toContain(id);
    }
    // Different seeds must give different decks, or the "random decks" of the gate are a fiction.
    expect(decksForSeed(1)).not.toEqual(decksForSeed(2));
  });

  it(
    `plays ${waveSize()} seeded games to a result and replays each to the same hash` +
      (waveSize() < WAVE_SEEDS ? ` (short wave — the ${WAVE_SEEDS}-seed gate is \`pnpm fuzz\`)` : ""),
    { timeout: 30 * 60_000 },
    () => {
      const ran = waveSize();
      const failures: Failure[] = [];
      const reasons = new Map<string, number>();
      let actionsTotal = 0;
      let actionsMax = 0;
      let turnMax = 0;
      const startedAt = performance.now();

      const from = firstSeed();
      for (let seed = from; seed < from + ran; seed += 1) {
        let run: GameRun | null = null;
        try {
          // 1. never throw
          run = playGame(seed);
          // 2. always terminate, by hero death or the R2 cap
          checkTermination(run);
          // 3. (seed, log) folds to the same hash
          checkReplay(seed, run);

          const reason = run.state.result?.reason ?? "none";
          reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
          actionsTotal += run.log.length;
          actionsMax = Math.max(actionsMax, run.log.length);
          turnMax = Math.max(turnMax, run.state.turn);
        } catch (error) {
          // 4. name every card in this seed's decks
          const stage = error instanceof FuzzFailure ? error.stage : "play";
          const message =
            error instanceof FuzzFailure
              ? error.message
              : error instanceof Error
                // A raw throw out of the engine or a card script: the message alone rarely says
                // which file it came from, so carry the first frame of the stack into the report.
                ? `${error.name}: ${error.message}${originOf(error)}`
                : String(error);
          const decks = decksForSeed(seed);
          failures.push({
            seed,
            stage,
            signature: signatureOf(stage, message),
            message,
            cards: [...decks[0], ...decks[1]],
            turn: error instanceof FuzzFailure ? error.at.turn : (run?.state.turn ?? -1),
            actions: error instanceof FuzzFailure ? error.at.actions : (run?.log.length ?? -1),
          });
        }
      }

      const elapsedMs = performance.now() - startedAt;
      const passed = ran - failures.length;
      const byStage = countBy(failures.map((failure) => failure.stage));
      // REVIEW B8 asks the fuzz run to REPORT its numbers — seeds, throws, hash mismatches, games
      // over the cap — and not merely to pass. Written to stdout rather than through `console.log`
      // because vitest's default reporter (what `pnpm fuzz` uses) swallows console output from a
      // passing test, and a green gate with no numbers is not evidence.
      process.stdout.write(
        `[M4 fuzz] ${ran === WAVE_SEEDS ? "FULL GATE" : `SHORT WAVE (the gate is ${WAVE_SEEDS} seeds: pnpm fuzz)`}\n` +
          `  seeds ${from}..${from + ran - 1}: ${passed} passed, ${failures.length} failed\n` +
          `  ${byStage.get("play") ?? 0} throw(s), ${byStage.get("termination") ?? 0} over the ` +
          `${MAX_ACTIONS_PER_GAME}-action bound or stalled, ${byStage.get("replay") ?? 0} replay mismatch(es), ` +
          `${byStage.get("invariant") ?? 0} invariant violation(s)\n` +
          `  endings: ${[...reasons.entries()].map(([r, n]) => `${r}=${n}`).join(" ") || "none"}\n` +
          `  ${passed > 0 ? Math.round(actionsTotal / passed) : 0} actions/game on average, ` +
          `${actionsMax} at most; longest game ended on turn ${turnMax} of ${TURN_CAP_PLAYER_TURNS}\n` +
          `  pool: ${FUZZ_POOL.length} deck-legal cards, ${POOL_EXCLUSIONS.length} excluded; ` +
          `${Math.round(elapsedMs / 1000)}s\n`,
      );

      expect(failures.length, failures.length === 0 ? "" : report(failures, ran, elapsedMs)).toBe(0);
    },
  );
});
