// The practice core's fallback for an AI step (docs/polish/3-ai.md §Surface, core contract): "If
// decide returns null or throws, or reduce refuses, the fallback is `endTurn` when legal, else the
// first `legalActions(state, aiSeat)` entry that reduce accepts", and never an action R188 forbids.
//
// The real `decide` never does any of this, so `@jackioh/ai` is mocked with a `decide` that is the
// real one until a test tells it to misbehave. Everything else is the real core: the engine, the
// card scripts, the AI's decks and the debug door into the true state.

import { beforeEach, describe, expect, it, vi } from "vitest";

import { legalActions, type GameState } from "@jackioh/engine";
import { AI_GATE_BUDGET } from "@jackioh/ai";
import type { ActionBody, PlayerId } from "@jackioh/shared";

import { createPracticeCore } from "./core.ts";
import type { PracticeDebug, PracticeRequest, PracticeRequestBody, PracticeResponse, PracticeSnapshot } from "./protocol.ts";

type Mode = "real" | "null" | "throw" | "illegal" | "concede";

const plan = vi.hoisted(() => ({ mode: "real" as Mode, calls: 0 }));

vi.mock("@jackioh/ai", async (importOriginal) => {
  const real = await importOriginal<typeof import("@jackioh/ai")>();
  const scripted = (action: ActionBody): ReturnType<typeof real.decide> => ({
    action,
    reason: "search",
    line: [action],
    stats: { nodes: 0, determinizations: 0, lines: 0, simErrors: 0, stoppedBy: "exhausted", score: 0 },
  });
  return {
    ...real,
    decide: (...args: Parameters<typeof real.decide>): ReturnType<typeof real.decide> => {
      plan.calls += 1;
      switch (plan.mode) {
        case "real":
          return real.decide(...args);
        case "null":
          return null;
        case "throw":
          throw new Error("scripted decide failure");
        case "illegal":
          return scripted({ type: "attack", attackerId: "no-such-unit", targetId: "hero-p2" });
        case "concede":
          return scripted({ type: "concede" });
      }
    },
  };
});

const HUMAN: PlayerId = "p2";
const AI: PlayerId = "p1";

type Driver = { send(body: PracticeRequestBody): PracticeResponse };

function driver(): Driver {
  const core = createPracticeCore({ now: () => 0, dev: true, budget: AI_GATE_BUDGET });
  let id = 0;
  return {
    send(body) {
      id += 1;
      return core.handle({ id, ...body } as PracticeRequest);
    },
  };
}

function snapshotOf(response: PracticeResponse): PracticeSnapshot {
  if (response.type === "started" || response.type === "snapshot") return response.snapshot;
  throw new Error(`expected a snapshot, got ${JSON.stringify(response).slice(0, 400)}`);
}

function debugOf(d: Driver): PracticeDebug {
  const response = d.send({ type: "debug" });
  if (response.type !== "debug") throw new Error(`expected debug, got ${response.type}`);
  return response.debug;
}

function start(d: Driver, seed: string): PracticeSnapshot {
  return snapshotOf(
    d.send({ type: "start", config: { seed, difficulty: "easy", humanSeat: HUMAN, deck: { kind: "random" } } }),
  );
}

/** The last logged action, as the body the AI chose (no seat, no nonce), plus its seat and nonce. */
function lastLogged(d: Driver): { body: ActionBody; playerId: PlayerId; nonce: string } {
  const last = debugOf(d).log.at(-1);
  if (last === undefined) throw new Error("the log is empty");
  const { playerId, nonce, ...body } = last;
  return { body: body as ActionBody, playerId, nonce };
}

/**
 * Plays on (the AI for real, the human keeping its mulligan, taking its prompts' first answers and
 * ending its turns) until the AI stands in its own main phase with no prompt open.
 */
function untilAiMain(d: Driver, from: PracticeSnapshot): PracticeSnapshot {
  let last = from;
  for (let n = 0; n < 100; n += 1) {
    const { view } = last;
    if (view.result !== null) throw new Error("the game ended before the AI's main phase");
    if (last.aiToAct && view.active === AI && view.phase === "main" && view.pending === null) return last;
    if (last.aiToAct) {
      last = snapshotOf(d.send({ type: "aiStep" }));
      continue;
    }
    const pending = view.pending;
    if (pending !== null && pending.forYou) {
      const answer: ActionBody | undefined =
        pending.kind === "mulligan" ? { type: "mulligan", keep: pending.options.map((o) => o.key) } : last.legal[0];
      if (answer === undefined) throw new Error("the human has a prompt and no answer");
      last = snapshotOf(d.send({ type: "act", action: answer }));
      continue;
    }
    last = snapshotOf(d.send({ type: "act", action: { type: "endTurn" } }));
  }
  throw new Error("the AI never reached its main phase");
}

beforeEach(() => {
  plan.mode = "real";
  plan.calls = 0;
});

describe("Surface: the core's fallback when decide gives nothing usable", () => {
  it("at the AI's mulligan, where endTurn is not legal, a null decision falls back to the first legal answer", { timeout: 60_000 }, () => {
    const d = driver();
    const started = start(d, "fallback-mulligan");
    expect(started.aiToAct).toBe(true);
    const before = debugOf(d).state as GameState;
    // R188: the fallback never concedes, offers a draw or accepts one, whatever legalActions lists.
    const legal = legalActions(before, AI).filter(
      (action) =>
        action.type !== "concede" && action.type !== "offerDraw" && !(action.type === "answerDraw" && action.accept),
    );
    expect(legal.some((action) => action.type === "endTurn")).toBe(false);

    plan.mode = "null";
    const after = snapshotOf(d.send({ type: "aiStep" }));
    expect(plan.calls).toBe(1);
    expect(after.error).toBeNull();
    const logged = lastLogged(d);
    expect(logged.playerId).toBe(AI);
    expect(logged.nonce).toBe("a0");
    expect(logged.body).toEqual(legal[0]);
  });

  const cases: { mode: Mode; what: string }[] = [
    { mode: "null", what: "returns null" },
    { mode: "throw", what: "throws" },
    { mode: "illegal", what: "picks an action the engine refuses" },
    { mode: "concede", what: "picks concede, which R188 forbids" },
  ];

  for (const { mode, what } of cases) {
    it(`in the AI's main phase, when decide ${what}, the AI ends its turn instead`, { timeout: 120_000 }, () => {
      const d = driver();
      untilAiMain(d, start(d, `fallback-${mode}`));
      const before = debugOf(d).log.length;

      plan.mode = mode;
      const after = snapshotOf(d.send({ type: "aiStep" }));
      expect(after.error).toBeNull();
      expect(after.view.result).toBeNull();

      const debug = debugOf(d);
      expect(debug.log).toHaveLength(before + 1);
      const logged = lastLogged(d);
      expect(logged.body).toEqual({ type: "endTurn" });
      expect(logged.playerId).toBe(AI);
      expect(logged.nonce).toMatch(/^a\d+$/);
    });
  }
});
