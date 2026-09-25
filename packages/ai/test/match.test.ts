// The match harness and the two baselines (docs/polish/3-ai.md B26, B27).
//
// B26: `playMatch` is deterministic, stops with `result: null` at `maxActions`, and every record's
// log folds with its handicaps back to `record.hash` with no errors (R180's replay, through the
// harness the gates use). B27: `randomAction` is §10.7's policy under the same rng, and
// `greedyAction` takes the candidate whose one-ply `evaluate` is best, or ends the turn when
// nothing beats standing still. The greedy oracle here uses the real `evaluate` on states with no
// hidden card and no randomness, so a determinization cannot change any number it compares.

import { describe, expect, it } from "vitest";
import type { Action, ActionBody, PlayerId } from "@jackioh/shared";
import {
  AI_DIFFICULTY,
  createRng,
  defOf,
  fold,
  hashState,
  queryCost,
  reduce,
  subsystems,
  type GameState,
  seatToAct,
} from "@jackioh/engine";
import {
  AI_GATE_BUDGET,
  AI_MULLIGAN,
  actionKey,
  candidateActions,
  evaluate,
  gameConfig,
  greedyAction,
  playMatch,
  randomAction,
  type MatchConfig,
  type MatchRecord,
} from "../src/index";
import { AI, HUMAN, act, dealtGame, isLegal, randomDecks, randomPolicyStates, scenario } from "./_support";

function randomVsRandom(seed: string, extra: Partial<MatchConfig> = {}): MatchConfig {
  return {
    seed,
    decks: randomDecks(seed),
    controllers: { p1: { kind: "random" }, p2: { kind: "random" } },
    ...extra,
  };
}

function expectFolds(config: MatchConfig, record: MatchRecord): void {
  const replayed = fold({
    seed: config.seed,
    decks: config.decks,
    log: record.log,
    ...(config.handicaps === undefined ? {} : { handicaps: config.handicaps }),
  });
  expect(replayed.errors, config.seed).toEqual([]);
  expect(hashState(replayed.state), config.seed).toBe(record.hash);
  expect(replayed.state.result, config.seed).toEqual(record.result);
}

// ---------------------------------------------------------------------------------------------
// B26
// ---------------------------------------------------------------------------------------------

describe("playMatch (B26)", () => {
  it("B26: a random-vs-random match is deterministic, finishes, and folds back to its hash", { timeout: 60_000 }, () => {
    const config = randomVsRandom("match-rr");
    const first = playMatch(config);
    const second = playMatch(config);

    expect(second.log).toEqual(first.log);
    expect(second.hash).toBe(first.hash);
    expect(second.result).toEqual(first.result);
    expect(first.result).not.toBeNull();
    expect(first.rejected).toEqual([]);
    expect(first.thrown).toEqual([]);
    expect(first.log.length).toBeGreaterThan(0);
    expectFolds(config, first);
  });

  it("B26: a record's log does not fold to its hash under another seed", { timeout: 60_000 }, () => {
    const config = randomVsRandom("match-other-seed");
    const record = playMatch(config);
    const replayed = fold({ seed: "match-other-seed-not", decks: config.decks, log: record.log });
    const same = replayed.errors.length === 0 && hashState(replayed.state) === record.hash;
    expect(same).toBe(false);
  });

  it("B26: a handicapped match folds only with its handicaps", { timeout: 60_000 }, () => {
    const seed = "match-rr-medium";
    const config = randomVsRandom(seed, {
      decks: randomDecks(seed, [20, AI_DIFFICULTY.medium.deckSize]),
      handicaps: { p2: AI_DIFFICULTY.medium },
    });
    const record = playMatch(config);
    expect(record.result).not.toBeNull();
    expectFolds(config, record);
    expect(() => fold({ seed, decks: config.decks, log: record.log })).toThrow();
  });

  it("B26: a match cut off at maxActions has no result, and its partial log still folds to its hash", { timeout: 60_000 }, () => {
    const config = randomVsRandom("match-cut", { maxActions: 7 });
    const record = playMatch(config);
    expect(record.result).toBeNull();
    expect(record.log.length).toBeGreaterThan(0);
    expect(record.log.length).toBeLessThanOrEqual(7);
    expectFolds(config, record);
  });

  it("B26: an ai-vs-greedy gate game is deterministic and folds to its hash with nothing rejected", { timeout: 300_000 }, () => {
    const config = gameConfig("ai-vs-greedy", 1, AI_GATE_BUDGET);
    const first = playMatch(config);
    const second = playMatch(config);
    expect(second.log).toEqual(first.log);
    expect(second.hash).toBe(first.hash);
    expect(first.rejected).toEqual([]);
    expect(first.thrown).toEqual([]);
    expect(first.decisions).toBeGreaterThan(0);
    expect(first.nodes).toBeGreaterThan(0);
    expectFolds(config, first);
  });

  it("B26: a match cut off after one action holds exactly that action and no result", () => {
    const config = randomVsRandom("match-cut-one", { maxActions: 1 });
    const record = playMatch(config);
    expect(record.result).toBeNull();
    expect(record.log.length).toBeLessThanOrEqual(1);
    expectFolds(config, record);
  });

  it("B26: afterAction sees every accepted action with the true states either side of it", { timeout: 60_000 }, () => {
    const config = randomVsRandom("match-hooks");
    const seen: { before: GameState; after: GameState; seat: PlayerId; action: ActionBody }[] = [];
    const record = playMatch(config, {
      afterAction: (before, after, seat, action) => seen.push({ before, after, seat, action }),
    });
    expect(seen).toHaveLength(record.log.length);
    seen.forEach((call, at) => {
      const logged = record.log[at];
      expect(call.seat, `action ${at}`).toBe(logged?.playerId);
      expect(call.action.type, `action ${at}`).toBe(logged?.type);
      if (at > 0) expect(hashState(call.before), `action ${at}`).toBe(hashState(seen[at - 1]?.after as GameState));
    });
    expect(hashState(seen.at(-1)?.after as GameState)).toBe(record.hash);
  });

  it("B26: timeDecision wraps the controller calls without changing the match", { timeout: 60_000 }, () => {
    const config = randomVsRandom("match-timing");
    let calls = 0;
    const timed = playMatch(config, {
      timeDecision: (_seat, run) => {
        calls += 1;
        return run();
      },
    });
    expect(calls).toBeGreaterThan(0);
    expect(timed.hash).toBe(playMatch(config).hash);
  });
});

// ---------------------------------------------------------------------------------------------
// B27
// ---------------------------------------------------------------------------------------------

/** p1 to act, nothing hidden anywhere and no card with a random effect. */
function openBoard(
  p1: NonNullable<Parameters<typeof scenario>[0]>["p1"],
  p2: NonNullable<Parameters<typeof scenario>[0]>["p2"],
): GameState {
  return scenario({ seed: "match-greedy", p1, p2 }).state;
}

/** One-ply values of every non-endTurn candidate on the true state, by actionKey. */
function onePly(state: GameState): Map<string, number> {
  const values = new Map<string, number>();
  candidateActions(state, AI).forEach((action, at) => {
    if (action.type === "endTurn") return;
    const result = reduce(state, { ...action, playerId: AI, nonce: `greedy-oracle-${at}` } as Action);
    if (result.error !== undefined) throw new Error(`${action.type} refused: ${result.error}`);
    values.set(actionKey(action), evaluate(result.state, AI));
  });
  return values;
}

function expectGreedy(state: GameState, label: string): ActionBody {
  const chosen = greedyAction(state, AI, createRng(`match-greedy:${label}`));
  if (chosen === null) throw new Error(`${label}: greedyAction returned null`);
  expect(isLegal(state, AI, chosen), label).toBe(true);

  const values = onePly(state);
  const standing = evaluate(state, AI);
  const best = Math.max(...values.values());
  if (values.size === 0 || best <= standing) {
    expect(chosen, label).toEqual({ type: "endTurn" });
  } else {
    expect(chosen.type, label).not.toBe("endTurn");
    expect(values.get(actionKey(chosen)), `${label}: ${JSON.stringify(chosen)}`).toBe(best);
  }
  return chosen;
}

describe("the baselines (B27)", () => {
  it("B27: greedyAction takes the candidate with the best one-ply evaluate on a busy board", () => {
    const state = openBoard(
      { hand: ["core-008", "core-020"], field: ["core-011"] },
      { field: ["core-008"] },
    );
    const chosen = expectGreedy(state, "busy");
    expect(chosen.type).not.toBe("endTurn");
  });

  it("B27: greedyAction takes a winning attack", () => {
    const state = openBoard({ field: ["core-011"] }, { health: 3 });
    const chosen = expectGreedy(state, "winning");
    expect(chosen.type).toBe("attack");
    expect(reduce(state, { ...chosen, playerId: AI, nonce: "greedy-win" } as Action).state.result?.winner).toBe(AI);
  });

  it("B27: greedyAction ends the turn when no candidate beats standing still", () => {
    // Mr. Vanilla facing Midrange Menace's 9/9 Taunt: attacking only loses the Vanilla.
    const state = openBoard({ field: ["core-008"] }, { field: ["core-019"] });
    expectGreedy(state, "stand-still");
  });

  it("B27: greedyAction with only endTurn available ends the turn", () => {
    const state = openBoard({}, { field: ["core-008"] });
    expect(greedyAction(state, AI, createRng("match-greedy-only"))).toEqual({ type: "endTurn" });
  });

  it("B27: greedyAction keeps the cheap cards at the mulligan and declines a draw offer", () => {
    const dealt = dealtGame("match-greedy-mulligan");
    const mulligan = greedyAction(dealt, "p1", createRng("match-greedy-mulligan"));
    expect(mulligan?.type).toBe("mulligan");
    const keep = dealt.players.p1.hand
      .filter((card) => queryCost(defOf(dealt, card.defId)) <= AI_MULLIGAN.keepMaxCost)
      .map((card) => card.id)
      .sort();
    expect(mulligan?.type === "mulligan" ? [...mulligan.keep].sort() : null).toEqual(keep);

    const humansTurn = scenario({
      seed: "match-greedy-offer",
      active: HUMAN,
      turn: 10,
      p1: { hand: ["core-008"] },
      p2: { hand: ["core-011"], field: ["core-008"] },
    }).state;
    const offered = act(humansTurn, HUMAN, { type: "offerDraw" });
    expect(greedyAction(offered, AI, createRng("match-greedy-offer"))).toEqual({ type: "answerDraw", accept: false });
  });

  it("B27: greedyAction returns null when the seat owes nothing", () => {
    const humansTurn = scenario({ seed: "match-greedy-null", active: HUMAN, turn: 10, p2: { hand: ["core-011"] } }).state;
    expect(greedyAction(humansTurn, AI, createRng("match-greedy-null"))).toBeNull();
  });

  it("B27: randomAction returns null for a seat that owes nothing", () => {
    const humansTurn = scenario({ seed: "match-random-null", active: HUMAN, turn: 10, p2: { hand: ["core-011"] } }).state;
    expect(randomAction(humansTurn, AI, createRng("match-random-null"))).toBeNull();
    const dealt = dealtGame("match-random-null-mulligan");
    expect(randomAction(dealt, "p2", createRng("match-random-null-mulligan"))).toBeNull();
  });

  it("B27: greedyAction is always legal and never concedes, offers or accepts a draw, across real states", { timeout: 120_000 }, () => {
    const states = randomPolicyStates("match-greedy-real", 7, 500).filter((state) => state.result === null);
    expect(states.length).toBeGreaterThan(5);
    states.forEach((state, at) => {
      const seat = seatToAct(state);
      const chosen = greedyAction(state, seat, createRng(`match-greedy-real:${at}`));
      expect(chosen, `state ${at}`).not.toBeNull();
      const action = chosen as ActionBody;
      expect(isLegal(state, seat, action), `state ${at}: ${JSON.stringify(action)}`).toBe(true);
      expect(["concede", "offerDraw"]).not.toContain(action.type);
      if (action.type === "answerDraw") expect(action.accept).toBe(false);
    });
  });

  it("B27: randomAction is subsystems.chooseAction under the same rng, from both seats, across real states", () => {
    const states = [
      openBoard({ hand: ["core-008", "core-020"], field: ["core-011"] }, { field: ["core-008"] }),
      dealtGame("match-random-dealt"),
      ...randomPolicyStates("match-random-real", 19, 400),
    ];
    states.forEach((state, at) => {
      for (const seat of ["p1", "p2"] as const) {
        const ours = createRng(`match-random:${at}:${seat}`);
        const theirs = createRng(`match-random:${at}:${seat}`);
        expect(randomAction(state, seat, ours), `state ${at} ${seat}`).toEqual(subsystems.chooseAction(state, seat, theirs));
        expect(ours.cursor, `state ${at} ${seat}`).toBe(theirs.cursor);
      }
    });
  });
});
