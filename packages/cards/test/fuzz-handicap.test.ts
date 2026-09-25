// The fuzz gate's handicapped wave (SPEC §9.9, R180–R184, R187).
//
// `fuzz.test.ts` plays every seed with this spec's resources on both seats, which is what every
// online match uses. Practice gives the AI's seat a handicap, and the handicap changes the rules a
// game runs through: a 25- or 30-card deck (R184), one more crystal up to a higher cap (R181), an
// extra opening card (R182), and at Hard a second start-of-turn draw with its own cast-on-draw
// chain, hand-cap check and fatigue step (R183). So this wave plays the same random-policy games
// with one seat handicapped, rotating by seed over Medium and Hard and over both seats, and holds
// them to the same three assertions: no throw, a real ending inside the cap, and a log that folds
// back, handicaps included, to the live hash.
//
// It is its own file so that `pnpm fuzz` (`vitest run --project cards fuzz`) picks it up by name,
// and it sizes its wave the way fuzz.test.ts does: the full 1,000 seeds under `pnpm fuzz`, the
// first 100 under `pnpm test`, and `JACKIOH_FUZZ_FROM` / `JACKIOH_FUZZ_SEEDS` to replay a seed.

import { describe, expect, it } from "vitest";
import type { Action, ActionBody, PlayerId } from "@jackioh/shared";
import {
  AI_DIFFICULTY,
  DECK_SIZE,
  TURN_CAP_PLAYER_TURNS,
  beginGame,
  createGame,
  createRng,
  fold,
  hashState,
  reduce,
  subsystems,
  type Handicap,
  seatToAct,
  mulliganOwed,
} from "@jackioh/engine";
import { CATALOG, registerAll } from "../src/index";

/** fuzz.test.ts's gate size and smoke size (its WAVE_SEEDS and SWEEP_SEEDS). */
const WAVE_SEEDS = 1000;
const SWEEP_SEEDS = 100;

function waveSize(): number {
  const raw = process.env["JACKIOH_FUZZ_SEEDS"];
  if (raw !== undefined && raw.trim() !== "") {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed >= 1) return Math.min(parsed, WAVE_SEEDS);
  }
  const script = process.env["npm_lifecycle_event"];
  return script === "test" || script === "test:coverage" ? SWEEP_SEEDS : WAVE_SEEDS;
}

function firstSeed(): number {
  const raw = process.env["JACKIOH_FUZZ_FROM"];
  if (raw === undefined || raw.trim() === "") return 1;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : 1;
}

const MAX_ACTIONS_PER_GAME = TURN_CAP_PLAYER_TURNS * subsystems.AI_PLAYOUT_STEP_CAP;
const TERMINAL_REASONS: readonly string[] = ["hero-death", "both-heroes-dead", "turn-cap"];

/** Every deck-legal card, sorted, as fuzz.test.ts's FUZZ_POOL (its exclusion list is empty). */
const POOL: readonly string[] = Object.entries(CATALOG)
  .filter(([, def]) => def.token !== true && !def.tags.includes("Token"))
  .map(([id]) => id)
  .sort();

/** Which seat is handicapped, and how: seeds rotate over Medium and Hard and over p1 and p2. */
export function handicapForSeed(seed: number): { seat: PlayerId; tier: "medium" | "hard"; handicap: Handicap } {
  const tier = seed % 2 === 1 ? "hard" : "medium";
  const seat: PlayerId = Math.floor(seed / 2) % 2 === 0 ? "p1" : "p2";
  return { seat, tier, handicap: AI_DIFFICULTY[tier] };
}

/** One shuffle of the pool: the handicapped seat takes its deckSize cards, the other seat the next 20. */
function decksForSeed(seed: number, seat: PlayerId, handicap: Handicap): [string[], string[]] {
  const shuffled = createRng(`jackioh-fuzz-handicap-decks-${seed}`).shuffle(POOL);
  const big = shuffled.slice(0, handicap.deckSize);
  const small = shuffled.slice(handicap.deckSize, handicap.deckSize + DECK_SIZE);
  return seat === "p1" ? [big, small] : [small, big];
}

type Outcome = { seed: number; error: string | null; tier: string; seat: PlayerId; reason: string | null };

function playSeed(seed: number): Outcome {
  const { seat, tier, handicap } = handicapForSeed(seed);
  const gameSeed = `jackioh-fuzz-handicap-${seed}`;
  const decks = decksForSeed(seed, seat, handicap);
  const handicaps: Partial<Record<PlayerId, Handicap>> = { [seat]: handicap };
  const fail = (error: string): Outcome => ({ seed, error, tier, seat, reason: null });

  try {
    registerAll();
    let state = beginGame(createGame({ seed: gameSeed, decks, handicaps })).state;
    const policy = createRng(`jackioh-fuzz-handicap-policy-${seed}`);
    // R265: while both mulligans are open either seat may answer first; a stream of its own picks
    // which, so the fuzz plays both orders (the game is the same either way, R265).
    const order = createRng(`jackioh-fuzz-handicap-policy-order-${seed}`);
    const log: Action[] = [];

    while (state.result === null) {
      if (log.length >= MAX_ACTIONS_PER_GAME) return fail(`no ending within ${MAX_ACTIONS_PER_GAME} actions`);
      const player: PlayerId = mulliganOwed(state).length === 2 && order.coin() ? "p2" : seatToAct(state);
      const chosen: ActionBody | null = subsystems.chooseAction(state, player, policy);
      if (chosen === null) return fail(`no legal action for ${player} on turn ${state.turn}`);
      const action = { ...chosen, playerId: player, nonce: `fuzz-${log.length}` } as Action;
      const result = reduce(state, action);
      if (result.error !== undefined) return fail(`legalActions offered "${action.type}" but reduce refused it: ${result.error}`);
      log.push(action);
      state = result.state;
    }

    const ending = state.result;
    if (!TERMINAL_REASONS.includes(ending.reason)) return fail(`ended with reason "${ending.reason}"`);
    if (state.turn > TURN_CAP_PLAYER_TURNS) return fail(`reached turn ${state.turn}, past the cap`);

    // R180, R187: the handicaps are part of what a game replays from.
    const replayed = fold({ seed: gameSeed, decks, log, handicaps });
    if (replayed.errors.length > 0) return fail(`replay rejected ${replayed.errors.length} action(s): ${replayed.errors[0]?.error ?? ""}`);
    if (hashState(replayed.state) !== hashState(state)) return fail("replay hash differs from the live hash");
    if (JSON.stringify(replayed.state.result) !== JSON.stringify(ending)) return fail("replay reached a different ending");

    return { seed, error: null, tier, seat, reason: ending.reason };
  } catch (error) {
    return fail(`threw: ${error instanceof Error ? error.message : String(error)}`);
  }
}

describe("fuzz: handicapped games (R180–R184, R187)", () => {
  const from = firstSeed();
  const size = waveSize();

  it("R183 the rotation covers Medium and Hard on both seats", () => {
    const seen = new Set([1, 2, 3, 4].map((seed) => `${handicapForSeed(seed).tier}:${handicapForSeed(seed).seat}`));
    expect([...seen].sort()).toEqual(["hard:p1", "hard:p2", "medium:p1", "medium:p2"]);
  });

  it(
    `R180 seeds ${from}–${from + size - 1} with one seat on Medium or Hard: no throw, a real ending, and a replay that matches`,
    { timeout: 600_000 },
    () => {
      const outcomes: Outcome[] = [];
      for (let seed = from; seed < from + size; seed += 1) outcomes.push(playSeed(seed));
      const failures = outcomes.filter((outcome) => outcome.error !== null);
      const endings = new Map<string, number>();
      for (const outcome of outcomes) {
        if (outcome.reason !== null) endings.set(outcome.reason, (endings.get(outcome.reason) ?? 0) + 1);
      }
      process.stdout.write(
        `[fuzz-handicap] ${size} seed(s) from ${from}: ${failures.length} failed; endings ${JSON.stringify(Object.fromEntries(endings))}\n`,
      );
      expect(
        failures.map((failure) => `seed ${failure.seed} (${failure.tier} ${failure.seat}): ${failure.error}`),
      ).toEqual([]);
    },
  );
});
