// The random legal-action policy of SPEC §10.7 (BUILD M3-T7, R44): determinism from the seed, a
// choice that is always one `legalActions` offered, the end-of-turn rule, uniform prompt answers,
// and a playout that always terminates. The endless fixture card lives here rather than in a
// shared fixture, as statecheck.test.ts does (CLAUDE.md, BUILD §0).

import type { ActionBody, CardDef, GameEvent } from "@jackioh/shared";
import { describe, expect, it } from "vitest";
import { registerCatalog, registeredCatalog } from "../src/catalog";
import { AI_END_TURN_PROBABILITY } from "../src/config";
import { chooseMode } from "../src/effects";
import { openPrompt } from "../src/prompts";
import { legalActions } from "../src/reduce";
import type { EngineSink } from "../src/resolve";
import { createRng } from "../src/rng";
import type { CardScripts } from "../src/script";
import { registerScripts, registeredScripts } from "../src/scripts";
import type { GameState, PromptOption, Resume } from "../src/state";
import {
  AI_PLAYOUT_STEP_CAP,
  AI_SKIPPED_ACTIONS,
  chooseAction,
  playOutTurn,
  policyActions,
  type PlayoutResult,
} from "../src/subsystems/aiPolicy";
import { bigBody, plain } from "./fixtures/combat";
import { eventsOfType, inHand, newGame, put, sinkFor, slot } from "./fixtures/harness";

/**
 * A fixture with no Core counterpart: answering its prompt re-opens the same prompt, so the policy
 * is offered an answer and never an `endTurn`. It exists to prove the playout guard, since nothing
 * else in the engine can loop forever.
 */
const endlessQuestion: CardDef = {
  id: "ai-endless-question",
  index: "902",
  name: "Endless Question (fixture)",
  set: "Core",
  type: "Spell",
  tags: [],
  rarity: "Common",
  token: false,
  cost: 0,
  base: { keywords: [], text: "answering it asks again" },
  radiant: { keywords: [], text: "answering it asks again" },
};

const askAgain = (): CardScripts["base"] => ({
  cry: () => [chooseMode({ options: ["again", "and again"], step: "ask" })],
  resume: { ask: () => [chooseMode({ options: ["again", "and again"], step: "ask" })] },
});

const ENDLESS_SCRIPTS: CardScripts = { base: askAgain(), radiant: askAgain() };

/** p1's main phase on turn 4, so nothing placed with `put` is summoning sick (§4.1). */
function board(seed: string): GameState {
  const state = newGame(seed);
  registerCatalog({ ...registeredCatalog(), [endlessQuestion.id]: endlessQuestion });
  registerScripts({ ...registeredScripts(), [endlessQuestion.id]: ENDLESS_SCRIPTS });
  state.turn = 4;
  state.active = "p1";
  state.phase = "main";
  state.players.p1.mana.current = 4;
  state.players.p1.mana.max = 4;
  return state;
}

/** A board with something to do: cards to play, a unit to attack with and a unit to attack. */
function busyBoard(seed: string): GameState {
  const state = board(seed);
  inHand(state, "fx-1", "p1", 2);
  inHand(state, "fx-2", "p1", 2);
  put(state, bigBody.id, slot("p1", "units", 1));
  put(state, plain.id, slot("p2", "units", 1));
  return state;
}

/** A resume nothing can service: answering the prompt then just clears it (§10.6). */
const inertResume: Resume = { defId: "ai-no-script", hook: "resume", step: "none", radiant: false, data: {} };

function modeOptions(options: string[]): PromptOption[] {
  return options.map((option) => ({ key: `mode:${option}`, label: option, selection: { pick: "mode", option } }));
}

function sequence(state: GameState, seed: string, steps = 12): (ActionBody | null)[] {
  const rng = createRng(seed);
  return Array.from({ length: steps }, () => chooseAction(state, "p1", rng));
}

function playout(seed: string): {
  original: GameState;
  sink: EngineSink;
  events: GameEvent[];
  result: PlayoutResult;
} {
  const original = busyBoard(seed);
  const events: GameEvent[] = [];
  const sink = sinkFor(original, events);
  return { original, sink, events, result: playOutTurn(sink, "p1") };
}

describe("the AI policy (M3-T7, §10.7, R44)", () => {
  it("R44 returns the same action sequence for the same state and seed", () => {
    const state = busyBoard("determinism");

    expect(chooseAction(state, "p1", createRng("policy"))).toEqual(chooseAction(state, "p1", createRng("policy")));
    expect(sequence(state, "policy")).toEqual(sequence(state, "policy"));
    // A different seed walks a different sequence, so the seed is really what decides.
    expect(sequence(state, "other-policy")).not.toEqual(sequence(state, "policy"));
  });

  it("R84 only ever returns an action legalActions offered, and never a concede or a draw offer", () => {
    const state = busyBoard("offered");
    const offered = legalActions(state, "p1");

    for (let i = 0; i < 60; i += 1) {
      const chosen = chooseAction(state, "p1", createRng(`seed-${i}`));
      expect(chosen).not.toBeNull();
      expect(offered).toContainEqual(chosen);
      expect(AI_SKIPPED_ACTIONS).not.toContain(chosen?.type);
    }

    // The filter is doing work: `legalActions` does offer those, and `skip: []` is the literal set.
    expect(offered.map((action) => action.type)).toContain("concede");
    expect(offered.map((action) => action.type)).toContain("offerDraw");
    expect(policyActions(state, "p1").map((action) => action.type)).not.toContain("concede");
    expect(policyActions(state, "p1", { skip: [] })).toEqual(offered);
  });

  it("R44 ends the turn when nothing else is on offer, and takes no rng draw to decide it", () => {
    const state = board("only-end-turn"); // empty hand, empty board
    const rng = createRng("unused");

    expect(policyActions(state, "p1")).toEqual([{ type: "endTurn" }]);
    expect(chooseAction(state, "p1", rng)).toEqual({ type: "endTurn" });
    expect(rng.cursor).toBe(0);

    // With other actions available it ends the turn only on the AI_END_TURN_PROBABILITY roll.
    const busy = busyBoard("sometimes-end-turn");
    const ends = Array.from({ length: 200 }, (_, i) => chooseAction(busy, "p1", createRng(`roll-${i}`))).filter(
      (action) => action?.type === "endTurn",
    ).length;
    expect(ends).toBeGreaterThan(0);
    expect(ends).toBeLessThan(200 * AI_END_TURN_PROBABILITY * 3);
  });

  it("R44 answers the open prompt of its own player uniformly, and nothing for the other player", () => {
    const state = board("prompt");
    const sink = sinkFor(state);
    openPrompt(sink, {
      player: "p1",
      kind: "target",
      prompt: "pick one",
      options: modeOptions(["a", "b", "c"]),
      resume: inertResume,
    });

    const picked = new Set<string>();
    for (let i = 0; i < 40; i += 1) {
      const chosen = chooseAction(state, "p1", createRng(`answer-${i}`));
      expect(chosen?.type).toBe("answer");
      if (chosen?.type !== "answer") continue;
      expect(chosen.choiceId).toBe(state.pending?.id);
      const pick = chosen.selection[0];
      if (pick?.pick === "mode") picked.add(pick.option);
    }
    // Uniform over the options, so all three come up across 40 seeds.
    expect([...picked].sort()).toEqual(["a", "b", "c"]);

    // The prompt is not p2's, so p2 has nothing to do (§9.3).
    expect(chooseAction(state, "p2", createRng("p2"))).toBeNull();

    // A playout answers it, and the answer the reducer gets is a legal one.
    const result = playOutTurn(sink, "p1");
    expect(result.error).toBeUndefined();
    expect(result.actions[0]?.type).toBe("answer");
    expect(sink.state.pending).toBeNull();
  });

  it("R44 playOutTurn plays the turn out, ends it, and repeats exactly from the seed", () => {
    const first = playout("playout");
    const second = playout("playout");

    expect(first.result.error).toBeUndefined();
    expect(first.result.stopped).toBe("turnEnded");
    expect(first.result.actions.length).toBeGreaterThan(0);
    expect(first.result.actions.every((action) => action.playerId === "p1")).toBe(true);
    for (const action of first.result.actions) {
      expect(AI_SKIPPED_ACTIONS).not.toContain(action.type);
    }

    // The turn really passed, and the sink's own state object is the one that moved.
    expect(first.sink.state.active).toBe("p2");
    expect(first.sink.state).toBe(first.original);
    expect(eventsOfType(first.events, "turnEnded").map((e) => e.player)).toEqual(["p1"]);

    expect(second.result).toEqual(first.result);
    expect(JSON.stringify(second.sink.state)).toBe(JSON.stringify(first.sink.state));
  });

  it("R44 playOutTurn stops when the open prompt belongs to the other player", () => {
    const state = busyBoard("elsewhere");
    const sink = sinkFor(state);
    openPrompt(sink, {
      player: "p2",
      kind: "target",
      prompt: "not yours",
      options: modeOptions(["x", "y"]),
      resume: inertResume,
    });

    const before = JSON.stringify(state);
    const result = playOutTurn(sink, "p1");

    expect(result.stopped).toBe("promptElsewhere");
    expect(result.actions).toEqual([]);
    expect(JSON.stringify(state)).toBe(before);
  });

  it("R44 playOutTurn stops when the game is over or the turn has already passed", () => {
    const over = busyBoard("game-over");
    over.result = { winner: "p2", reason: "concede" };
    over.phase = "over";
    expect(playOutTurn(sinkFor(over), "p1")).toEqual({ actions: [], stopped: "gameOver" });

    const theirTurn = busyBoard("their-turn");
    theirTurn.active = "p2";
    expect(playOutTurn(sinkFor(theirTurn), "p1")).toEqual({ actions: [], stopped: "turnEnded" });

    // Outside the main phase `legalActions` offers only a concede, which the policy never takes.
    const starting = busyBoard("starting");
    starting.phase = "start";
    expect(playOutTurn(sinkFor(starting), "p1")).toEqual({ actions: [], stopped: "turnEnded" });
  });

  it("R44 playOutTurn stops at the step cap instead of looping forever", () => {
    const state = board("endless");
    inHand(state, endlessQuestion.id, "p1", 1);
    const sink = sinkFor(state);

    const result = playOutTurn(sink, "p1");

    // Every step after the first is an answer to a prompt the last answer re-opened, so the policy
    // is never offered an `endTurn`: only the guard stops it.
    expect(result.actions[0]?.type).toBe("play");
    expect(result.stopped).toBe("stepCap");
    expect(result.actions).toHaveLength(AI_PLAYOUT_STEP_CAP);
    expect(result.error).toBeUndefined();
    expect(sink.state.pending?.kind).toBe("mode");
    expect(sink.state.result).toBeNull();

    // Nonces are unique, so no action was silently deduped into an earlier one's events.
    const nonces = new Set(result.actions.map((action) => action.nonce));
    expect(nonces.size).toBe(result.actions.length);
  });
});
