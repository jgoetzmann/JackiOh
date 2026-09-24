// The practice core, for real: B34, B35, B38 and B39 of docs/polish/3-ai.md, and R187 / R188.
//
// Everything here drives the REAL `createPracticeCore` — the engine, the card scripts and the AI
// the worker runs — with a frozen clock (`now: () => 0`, so the wall-clock cap never fires and every
// decision is a pure function of the node budget) and the quality gates' smaller budget, so a whole
// game fits a test. The only door into the true state is `debug`, which a dev core answers; every
// assertion about what the page receives compares a response with `viewFor` / `legalActions` of
// that state, which is CLAUDE.md rule 7 stated as a test.

import { describe, expect, it } from "vitest";

import {
  AI_DIFFICULTY,
  DECK_SIZE,
  createRng,
  fold,
  hashState,
  legalActions,
  reduce,
  registeredCatalog,
  subsystems,
  viewFor,
} from "@jackioh/engine";
import type { GameState, Rng } from "@jackioh/engine";
import type { Difficulty } from "@jackioh/engine/config";
import { AI_GATE_BUDGET, SHADOW_BAN_IDS, aiToAct } from "@jackioh/ai";
import { opponentOf } from "@jackioh/shared";
import type { Action, ActionBody, PlayerId } from "@jackioh/shared";

import { createPracticeCore } from "./core.ts";
import { PRACTICE_PRESETS } from "./decks.ts";
import type { PracticeCore, PracticeCoreEnv } from "./core.ts";
import type {
  PracticeDebug,
  PracticeRequest,
  PracticeRequestBody,
  PracticeResponse,
  PracticeSnapshot,
  PracticeStartConfig,
} from "./protocol.ts";

// ---------------------------------------------------------------------------------------------
// the driver
// ---------------------------------------------------------------------------------------------

const ENV: PracticeCoreEnv = { now: () => 0, dev: true, budget: AI_GATE_BUDGET };

/** Most requests one walk sends before it gives up on the game ending by itself. */
const WALK_CAP = 200;

type Exchange = { request: PracticeRequest; response: PracticeResponse };

type Driver = {
  core: PracticeCore;
  /** Stamps the next id, hands the request to the core and returns its answer. */
  send(body: PracticeRequestBody): PracticeResponse;
  exchanges: Exchange[];
};

function driver(env: PracticeCoreEnv = ENV): Driver {
  const core = createPracticeCore(env);
  const exchanges: Exchange[] = [];
  let id = 0;
  return {
    core,
    exchanges,
    send(body) {
      id += 1;
      const request = { id, ...body } as PracticeRequest;
      const response = core.handle(request);
      // A response answers the request it was given, by id (docs/polish/3-ai.md, protocol.ts).
      expect(response.id, `the answer to request ${String(id)} (${body.type}) carries its id`).toBe(id);
      exchanges.push({ request, response });
      return response;
    },
  };
}

function config(over: Partial<PracticeStartConfig> = {}): PracticeStartConfig {
  return { seed: "core-test", difficulty: "easy", humanSeat: "p2", deck: { kind: "random" }, ...over };
}

function snapshotOf(response: PracticeResponse): PracticeSnapshot {
  if (response.type === "started" || response.type === "snapshot") return response.snapshot;
  throw new Error(`expected a snapshot, got ${JSON.stringify(response).slice(0, 400)}`);
}

function debugOf(d: Driver): PracticeDebug {
  const response = d.send({ type: "debug" });
  if (response.type !== "debug") throw new Error(`expected debug, got ${JSON.stringify(response).slice(0, 400)}`);
  return response.debug;
}

function stateOf(debug: PracticeDebug): GameState {
  return debug.state as GameState;
}

function seatIndex(seat: PlayerId): 0 | 1 {
  return seat === "p1" ? 0 : 1;
}

/** The human's opening mulligan answered by keeping every card (R9: `keep` names the cards kept). */
function keepAll(snapshot: PracticeSnapshot): ActionBody | null {
  const pending = snapshot.view.pending;
  if (pending === null || !pending.forYou || pending.kind !== "mulligan") return null;
  return { type: "mulligan", keep: pending.options.map((option) => option.key) };
}

/** The engine's own reason for refusing `body` from `seat` on `state`, or undefined if it accepts. */
function engineRefusal(state: GameState, body: ActionBody, seat: PlayerId): string | undefined {
  return reduce(state, { ...body, playerId: seat, nonce: "test:probe" } as Action).error;
}

/**
 * One step of a practice game: the AI's step when it owes one, else the human by §10.7's random
 * policy on the true state (read through `debug`). Null once nobody has anything to do.
 */
function step(d: Driver, human: PlayerId, rng: Rng, last: PracticeSnapshot): PracticeResponse | null {
  if (last.view.result !== null) return null;
  if (last.aiToAct) return d.send({ type: "aiStep" });
  const body = subsystems.chooseAction(stateOf(debugOf(d)), human, rng);
  if (body === null) return null;
  return d.send({ type: "act", action: body });
}

/**
 * Drive the game until the human stands in its own main phase with no prompt open: the AI by
 * `aiStep`, the human's prompts by keeping the whole mulligan or taking the first legal answer.
 */
function untilHumanMain(d: Driver, human: PlayerId, from: PracticeSnapshot): PracticeSnapshot {
  let last = from;
  for (let n = 0; n < WALK_CAP; n += 1) {
    const { view } = last;
    if (view.result !== null) throw new Error("the game ended before the human reached its main phase");
    if (last.aiToAct) {
      last = snapshotOf(d.send({ type: "aiStep" }));
      continue;
    }
    if (view.pending !== null && view.pending.forYou) {
      const answer = keepAll(last) ?? last.legal[0];
      if (answer === undefined) throw new Error("the human has a prompt and no legal answer");
      last = snapshotOf(d.send({ type: "act", action: answer }));
      expect(last.error, "answering the human's own prompt is accepted").toBeNull();
      continue;
    }
    if (view.active === human && view.phase === "main" && view.pending === null) return last;
    throw new Error(
      `nobody owes an action: ${JSON.stringify({ active: view.active, phase: view.phase, pending: view.pending })}`,
    );
  }
  throw new Error(`the human never reached its main phase in ${String(WALK_CAP)} requests`);
}

/**
 * B34, for one response: the snapshot holds exactly four keys, `view` and `legal` are the human's
 * `viewFor` / `legalActions` of the true state, `aiToAct` is the AI's, and no AI hand or library
 * instance id that the human's own view does not already name appears anywhere in the response.
 */
function expectRule7(d: Driver, response: PracticeResponse, human: PlayerId, ai: PlayerId): void {
  const snapshot = snapshotOf(response);
  expect(Object.keys(snapshot).sort()).toEqual(["aiToAct", "error", "legal", "view"]);

  const state = stateOf(debugOf(d));
  expect(snapshot.view).toEqual(viewFor(state, human));
  expect(snapshot.legal).toEqual(legalActions(state, human));
  expect(snapshot.aiToAct).toBe(aiToAct(state, ai));

  // A card the human watched being played and then bounced back to the AI's hand is public
  // history and legitimately named by the view; every other hidden id must not travel at all.
  const shown = JSON.stringify(viewFor(state, human));
  const sent = JSON.stringify(response);
  const hidden = [...state.players[ai].hand, ...state.players[ai].library].map((card) => JSON.stringify(card.id));
  expect(hidden.length, "the AI holds hidden cards to leak").toBeGreaterThan(0);
  for (const id of hidden) {
    if (shown.includes(id)) continue;
    expect(sent.includes(id), `the AI's hidden card ${id} is in a ${response.type} response`).toBe(false);
  }
}

// ---------------------------------------------------------------------------------------------
// B34: what the main thread receives (rule 7)
// ---------------------------------------------------------------------------------------------

describe("B34 the core answers with the human's view and nothing else", () => {
  it("B34 `started` is { id, type, snapshot, defs, aiSeat } with the AI on the other seat", () => {
    for (const humanSeat of ["p1", "p2"] as const) {
      const d = driver();
      const started = d.send({ type: "start", config: config({ seed: `b34-started-${humanSeat}`, humanSeat }) });
      expect(started.type).toBe("started");
      if (started.type !== "started") return;
      expect(Object.keys(started).sort()).toEqual(["aiSeat", "defs", "id", "snapshot", "type"]);
      expect(started.aiSeat).toBe(opponentOf(humanSeat));
      expect(started.snapshot.view.viewer).toBe(humanSeat);
      expectRule7(d, started, humanSeat, started.aiSeat);

      // The page renders the human's hand from `defs` (CatalogContext), so every card in it is there.
      const hand = started.snapshot.view.you.hand;
      expect(Array.isArray(hand)).toBe(true);
      for (const card of Array.isArray(hand) ? hand : []) {
        expect(started.defs[card.defId], `${card.defId} is in defs`).toBeDefined();
      }
    }
  });

  it("B34 every snapshot of a played-out opening is viewFor/legalActions of the true state and leaks no hidden AI card", { timeout: 120_000 }, () => {
    const human: PlayerId = "p2";
    const d = driver();
    const started = d.send({ type: "start", config: config({ seed: "b34-walk", humanSeat: human }) });
    expectRule7(d, started, human, "p1");

    const rng = createRng("b34-walk:human");
    let last = snapshotOf(started);
    for (let n = 0; n < 60 && last.view.result === null; n += 1) {
      const response = step(d, human, rng, last);
      if (response === null) break;
      expect(response.type).toBe("snapshot");
      expect(Object.keys(response).sort()).toEqual(["id", "snapshot", "type"]);
      expectRule7(d, response, human, "p1");
      last = snapshotOf(response);
    }

    // The walk exercised both sides of the boundary: the AI acted and so did the human.
    const log = debugOf(d).log;
    expect(log.some((action) => action.playerId === "p1")).toBe(true);
    expect(log.some((action) => action.playerId === "p2")).toBe(true);
  });

  it("B34 an aiStep the AI does not owe changes nothing and still answers with a snapshot", () => {
    const human: PlayerId = "p1";
    const d = driver();
    const started = snapshotOf(d.send({ type: "start", config: config({ seed: "b34-idle-step", humanSeat: human }) }));
    // p1 answers the first mulligan (§2.1), so the AI owes nothing yet.
    expect(started.aiToAct).toBe(false);
    const before = debugOf(d);

    const response = d.send({ type: "aiStep" });
    expect(response.type).toBe("snapshot");
    expectRule7(d, response, human, "p2");
    const after = debugOf(d);
    expect(after.hash).toBe(before.hash);
    expect(after.log).toEqual(before.log);
  });

  it("B34 the core never throws: act and aiStep before any start answer `failed`", () => {
    const d = driver();
    const bodies: PracticeRequestBody[] = [{ type: "act", action: { type: "endTurn" } }, { type: "aiStep" }];
    for (const body of bodies) {
      // A throw out of `handle` fails this test by itself; the answer must be a `failed` response.
      const response = d.send(body);
      expect(response.type, `${body.type} before start`).toBe("failed");
      if (response.type === "failed") expect(response.message.length).toBeGreaterThan(0);
    }
  });

  it("B34 a start with a saved deck of the wrong size answers `failed` with the engine's reason, and no game exists", () => {
    const d = driver();
    const response = d.send({
      type: "start",
      config: config({ deck: { kind: "saved", index: 1, cards: ["core-001", "core-002", "core-003"] } }),
    });
    expect(response.type).toBe("failed");
    if (response.type === "failed") expect(response.message.length).toBeGreaterThan(0);
    expect(d.send({ type: "aiStep" }).type).toBe("failed");
  });

  it("B34 a start with a saved deck holding a duplicate answers `failed`", () => {
    // A legal 20-card deck from a random start, with its last card replaced by its first.
    const probe = driver();
    probe.send({ type: "start", config: config({ seed: "b34-dup-source", humanSeat: "p1" }) });
    const legal = debugOf(probe).decks[0];
    const first = legal[0];
    expect(first).toBeDefined();
    const duplicated = [...legal.slice(0, -1), first ?? ""];

    const d = driver();
    const response = d.send({
      type: "start",
      config: config({ humanSeat: "p1", deck: { kind: "saved", index: 1, cards: duplicated } }),
    });
    expect(response.type).toBe("failed");
  });

  it("B34 a start with a saved deck naming a card the catalog does not have answers `failed`", () => {
    const probe = driver();
    probe.send({ type: "start", config: config({ seed: "b34-unknown-source", humanSeat: "p1" }) });
    const unknown = [...debugOf(probe).decks[0].slice(0, -1), "core-999"];

    const d = driver();
    const response = d.send({
      type: "start",
      config: config({ humanSeat: "p1", deck: { kind: "saved", index: 1, cards: unknown } }),
    });
    expect(response.type).toBe("failed");
  });

  it("B34 a start naming no real difficulty answers `failed` instead of throwing", () => {
    const d = driver();
    const response = d.send({ type: "start", config: config({ difficulty: "nightmare" as Difficulty }) });
    expect(response.type).toBe("failed");
  });

  it("B34 an act the engine has never heard of is answered, not thrown, and changes nothing", () => {
    const d = driver();
    d.send({ type: "start", config: config({ seed: "b34-nonsense", humanSeat: "p1" }) });
    const before = debugOf(d);

    const response = d.send({ type: "act", action: { type: "nonsense" } as unknown as ActionBody });
    expect(["snapshot", "failed"]).toContain(response.type);
    if (response.type === "snapshot") expect(response.snapshot.error).toEqual(expect.any(String));
    const after = debugOf(d);
    expect(after.hash).toBe(before.hash);
    expect(after.log).toEqual(before.log);
  });

  it("B34 a saved deck is played exactly as given, and a random or preset human deck is DECK_SIZE distinct cards", () => {
    const source = driver();
    source.send({ type: "start", config: config({ seed: "b34-saved-source", humanSeat: "p1" }) });
    const cards = debugOf(source).decks[0];
    expect(cards).toHaveLength(DECK_SIZE);

    const saved = driver();
    const started = saved.send({
      type: "start",
      config: config({ seed: "b34-saved", humanSeat: "p2", deck: { kind: "saved", index: 1, cards } }),
    });
    expect(started.type).toBe("started");
    expect(debugOf(saved).decks[seatIndex("p2")]).toEqual(cards);

    const preset = driver();
    expect(preset.send({ type: "start", config: config({ seed: "b34-preset", deck: { kind: "preset", id: "humans" } }) }).type).toBe(
      "started",
    );
    const presetDeck = debugOf(preset).decks[seatIndex("p2")];
    expect(presetDeck).toHaveLength(DECK_SIZE);
    expect(new Set(presetDeck).size).toBe(DECK_SIZE);
  });
});

// ---------------------------------------------------------------------------------------------
// the named practice decks, and the catalog the setup previews them with
// ---------------------------------------------------------------------------------------------

describe("the named practice decks are real decks, and the setup can preview them", () => {
  it("every preset is DECK_SIZE distinct non-token Core cards, none of them on the AI's shadow ban", () => {
    const catalog = registeredCatalog();
    const banned = new Set(SHADOW_BAN_IDS);
    for (const preset of PRACTICE_PRESETS) {
      expect(preset.cards, preset.id).toHaveLength(DECK_SIZE);
      expect(new Set(preset.cards).size, `${preset.id} has no duplicate`).toBe(DECK_SIZE);
      for (const id of preset.cards) {
        const def = catalog[id];
        expect(def, `${preset.id}: ${id} is a catalog card`).toBeDefined();
        expect(def?.set, `${preset.id}: ${id}`).toBe("Core");
        expect(def?.token, `${preset.id}: ${id} is no token`).not.toBe(true);
        expect(banned.has(id), `${preset.id}: ${id} is on the shadow ban (R186)`).toBe(false);
      }
    }
  });

  it("a preset game deals the human exactly that preset's list, and the engine accepts it", () => {
    for (const preset of PRACTICE_PRESETS) {
      const d = driver();
      const started = d.send({ type: "start", config: config({ seed: `preset-${preset.id}`, deck: { kind: "preset", id: preset.id } }) });
      expect(started.type, preset.id).toBe("started");
      expect(debugOf(d).decks[seatIndex("p2")]).toEqual([...preset.cards]);
    }
  });

  it("an unknown preset is refused, and no game starts", () => {
    const d = driver();
    const response = d.send({ type: "start", config: config({ deck: { kind: "preset", id: "starter-a" } }) });
    expect(response.type).toBe("failed");
  });

  it("catalog answers the public card data, the same map a started game carries, and needs no game", () => {
    const d = driver();
    const answered = d.send({ type: "catalog" });
    expect(answered.type).toBe("catalog");
    if (answered.type !== "catalog") return;
    expect(answered.defs).toEqual(registeredCatalog());
    for (const preset of PRACTICE_PRESETS) {
      for (const id of preset.cards) expect(answered.defs[id]?.name, id).toEqual(expect.any(String));
    }
    const started = d.send({ type: "start", config: config({ seed: "catalog-then-game" }) });
    expect(started.type === "started" ? started.defs : null).toEqual(answered.defs);
  });
});

// ---------------------------------------------------------------------------------------------
// B35: refusals and the log
// ---------------------------------------------------------------------------------------------

describe("B35 a human action is either refused with the engine's reason or logged as h<n>", () => {
  it("B35 an action during the other seat's mulligan is refused with the engine's reason; hash and log are unchanged", () => {
    const d = driver();
    const started = snapshotOf(d.send({ type: "start", config: config({ seed: "b35-refused", humanSeat: "p2" }) }));
    expect(started.error).toBeNull();
    const before = debugOf(d);

    const action: ActionBody = { type: "endTurn" };
    const reason = engineRefusal(stateOf(before), action, "p2");
    expect(reason, "the engine refuses an endTurn while a prompt is open").toEqual(expect.any(String));

    const refused = snapshotOf(d.send({ type: "act", action }));
    expect(refused.error).toBe(reason);
    const after = debugOf(d);
    expect(after.hash).toBe(before.hash);
    expect(after.log).toEqual(before.log);
  });

  it("B35 answering the AI's mulligan for it is refused with the engine's reason", () => {
    const d = driver();
    const started = snapshotOf(d.send({ type: "start", config: config({ seed: "b35-not-yours", humanSeat: "p2" }) }));
    // p1 — the AI — holds the first mulligan (§2.1); the human sees it only as pending elsewhere.
    expect(started.view.pending).toEqual({ forYou: false, pendingFor: "p1" });
    const before = debugOf(d);

    const action: ActionBody = { type: "mulligan", keep: [] };
    const reason = engineRefusal(stateOf(before), action, "p2");
    expect(reason).toEqual(expect.any(String));

    expect(snapshotOf(d.send({ type: "act", action })).error).toBe(reason);
    const after = debugOf(d);
    expect(after.hash).toBe(before.hash);
    expect(after.log).toEqual(before.log);
  });

  it("B35 after two refusals in a row the error is the second one's reason, and the log never moved", () => {
    const d = driver();
    d.send({ type: "start", config: config({ seed: "b35-twice", humanSeat: "p2" }) });
    const before = debugOf(d);

    const first: ActionBody = { type: "endTurn" };
    const second: ActionBody = { type: "mulligan", keep: [] };
    const firstReason = engineRefusal(stateOf(before), first, "p2");
    const secondReason = engineRefusal(stateOf(before), second, "p2");
    expect(firstReason).toEqual(expect.any(String));
    expect(secondReason).toEqual(expect.any(String));
    expect(secondReason, "two different refusals, so the test can tell them apart").not.toBe(firstReason);

    expect(snapshotOf(d.send({ type: "act", action: first })).error).toBe(firstReason);
    expect(snapshotOf(d.send({ type: "act", action: second })).error).toBe(secondReason);
    const after = debugOf(d);
    expect(after.log).toEqual(before.log);
    expect(after.hash).toBe(before.hash);
  });

  it("B35 an answer with no prompt open is refused with the engine's reason", { timeout: 60_000 }, () => {
    const human: PlayerId = "p1";
    const d = driver();
    untilHumanMain(d, human, snapshotOf(d.send({ type: "start", config: config({ seed: "b35-no-prompt", humanSeat: human }) })));
    const before = debugOf(d);

    const action: ActionBody = { type: "answer", choiceId: "stale-choice", selection: [{ pick: "none" }] };
    const reason = engineRefusal(stateOf(before), action, human);
    expect(reason).toEqual(expect.any(String));

    expect(snapshotOf(d.send({ type: "act", action })).error).toBe(reason);
    expect(debugOf(d).hash).toBe(before.hash);
  });

  it("B35 a play of a card the human does not hold is refused with the engine's reason in its main phase", { timeout: 60_000 }, () => {
    const human: PlayerId = "p1";
    const d = driver();
    const main = untilHumanMain(d, human, snapshotOf(d.send({ type: "start", config: config({ seed: "b35-no-card", humanSeat: human }) })));
    expect(main.error).toBeNull();
    const before = debugOf(d);

    const action: ActionBody = { type: "play", instanceId: "no-such-card" };
    const reason = engineRefusal(stateOf(before), action, human);
    expect(reason).toEqual(expect.any(String));

    expect(snapshotOf(d.send({ type: "act", action })).error).toBe(reason);
    const after = debugOf(d);
    expect(after.hash).toBe(before.hash);
    expect(after.log).toEqual(before.log);
  });

  it("B35 once the human has conceded, a further action is refused with the engine's reason", () => {
    const human: PlayerId = "p2";
    const d = driver();
    d.send({ type: "start", config: config({ seed: "b35-over", humanSeat: human }) });

    const conceded = snapshotOf(d.send({ type: "act", action: { type: "concede" } }));
    expect(conceded.error).toBeNull();
    expect(conceded.view.result).toEqual(expect.objectContaining({ winner: "p1" }));
    const before = debugOf(d);
    expect(before.log.at(-1)).toEqual(expect.objectContaining({ type: "concede", playerId: human }));

    const action: ActionBody = { type: "endTurn" };
    const reason = engineRefusal(stateOf(before), action, human);
    expect(reason).toEqual(expect.any(String));
    const refused = snapshotOf(d.send({ type: "act", action }));
    expect(refused.error).toBe(reason);
    expect(debugOf(d).hash).toBe(before.hash);
  });

  it("B35 an accepted action appends exactly one h<n> action for the human's seat and clears the error", () => {
    const human: PlayerId = "p1";
    const d = driver();
    const started = snapshotOf(d.send({ type: "start", config: config({ seed: "b35-accepted", humanSeat: human }) }));

    // First a refusal, so there is an error to clear: p1 must answer its mulligan before anything.
    expect(snapshotOf(d.send({ type: "act", action: { type: "endTurn" } })).error).toEqual(expect.any(String));
    const before = debugOf(d);

    const keep = keepAll(started);
    expect(keep, "p1 holds the first mulligan (§2.1)").not.toBeNull();
    if (keep === null) return;
    const accepted = snapshotOf(d.send({ type: "act", action: keep }));
    expect(accepted.error).toBeNull();

    const after = debugOf(d);
    expect(after.log).toHaveLength(before.log.length + 1);
    const logged = after.log.at(-1);
    expect(logged).toEqual({ ...keep, playerId: human, nonce: expect.stringMatching(/^h\d+$/) });
    expect(after.hash).not.toBe(before.hash);
  });

  it("B35 a refusal spends no nonce: refused-then-accepted logs exactly what accepted alone logs", () => {
    const run = (withRefusal: boolean): PracticeDebug => {
      const d = driver();
      const started = snapshotOf(d.send({ type: "start", config: config({ seed: "b35-counter", humanSeat: "p1" }) }));
      if (withRefusal) {
        expect(snapshotOf(d.send({ type: "act", action: { type: "attack", attackerId: "x", targetId: "y" } })).error).toEqual(
          expect.any(String),
        );
      }
      const keep = keepAll(started);
      if (keep === null) throw new Error("p1 holds the first mulligan");
      expect(snapshotOf(d.send({ type: "act", action: keep })).error).toBeNull();
      return debugOf(d);
    };

    const plain = run(false);
    const refusedFirst = run(true);
    expect(refusedFirst.log).toEqual(plain.log);
    expect(refusedFirst.hash).toBe(plain.hash);
  });
});

// ---------------------------------------------------------------------------------------------
// B38: a practice game replays exactly (R187)
// ---------------------------------------------------------------------------------------------

const SEAT_BY_DIFFICULTY: Record<Difficulty, PlayerId> = { easy: "p2", medium: "p1", hard: "p2" };

describe("R187 B38 a practice game folds from (seed, decks, handicaps, log) to its own hash", () => {
  for (const difficulty of ["easy", "medium", "hard"] as const) {
    it(`R187 B38 a ${difficulty} game, human by the random policy and AI by decide, folds from debug() to debug().hash`, { timeout: 180_000 }, () => {
      const human = SEAT_BY_DIFFICULTY[difficulty];
      const ai = opponentOf(human);
      const seed = `r187-${difficulty}`;
      const d = driver();
      let last = snapshotOf(d.send({ type: "start", config: config({ seed, difficulty, humanSeat: human }) }));

      const rng = createRng(`${seed}:human`);
      for (let n = 0; n < WALK_CAP && last.view.result === null; n += 1) {
        const response = step(d, human, rng, last);
        if (response === null) break;
        last = snapshotOf(response);
        const request = d.exchanges.at(-1)?.request;
        if (request?.type === "act") expect(last.error, `the random policy's ${request.action.type} is legal`).toBeNull();
      }

      const debug = debugOf(d);
      expect(debug.seed).toBe(seed);
      expect(debug.difficulty).toBe(difficulty);
      expect(debug.humanSeat).toBe(human);
      expect(debug.handicaps[ai]).toEqual(AI_DIFFICULTY[difficulty]);
      expect(debug.decks[seatIndex(ai)]).toHaveLength(AI_DIFFICULTY[difficulty].deckSize);
      expect(debug.decks[seatIndex(human)]).toHaveLength(DECK_SIZE);

      // Both seats played, and every nonce says whose it was and is spent once.
      const aiActions = debug.log.filter((action) => action.playerId === ai);
      const humanActions = debug.log.filter((action) => action.playerId === human);
      expect(aiActions.length).toBeGreaterThan(0);
      expect(humanActions.length).toBeGreaterThan(0);
      for (const action of aiActions) expect(action.nonce).toMatch(/^a\d+$/);
      for (const action of humanActions) expect(action.nonce).toMatch(/^h\d+$/);
      expect(new Set(debug.log.map((action) => action.nonce)).size).toBe(debug.log.length);

      expect(hashState(stateOf(debug))).toBe(debug.hash);
      const replayed = fold({ seed: debug.seed, decks: debug.decks, log: debug.log, handicaps: debug.handicaps });
      expect(replayed.errors).toEqual([]);
      expect(hashState(replayed.state)).toBe(debug.hash);
    });
  }

  it("B38 the handicaps are part of the replay: a Hard game folded without them throws on its 30-card deck", { timeout: 60_000 }, () => {
    const human: PlayerId = "p1";
    const d = driver();
    const started = snapshotOf(
      d.send({ type: "start", config: config({ seed: "b38-no-handicaps", difficulty: "hard", humanSeat: human }) }),
    );
    const keep = keepAll(started);
    if (keep === null) throw new Error("p1 holds the first mulligan");
    let last = snapshotOf(d.send({ type: "act", action: keep }));
    for (let n = 0; n < 4 && last.aiToAct; n += 1) last = snapshotOf(d.send({ type: "aiStep" }));

    const debug = debugOf(d);
    expect(debug.decks[seatIndex("p2")]).toHaveLength(AI_DIFFICULTY.hard.deckSize);
    expect(() => fold({ seed: debug.seed, decks: debug.decks, log: debug.log })).toThrow();
    expect(hashState(fold({ seed: debug.seed, decks: debug.decks, log: debug.log, handicaps: debug.handicaps }).state)).toBe(
      debug.hash,
    );
  });

  it("B38 two cores fed the same requests answer them identically", { timeout: 120_000 }, () => {
    const play = (): PracticeResponse[] => {
      const d = driver();
      let last = snapshotOf(d.send({ type: "start", config: config({ seed: "b38-twice", difficulty: "medium", humanSeat: "p1" }) }));
      const rng = createRng("b38-twice:human");
      for (let n = 0; n < 60 && last.view.result === null; n += 1) {
        const response = step(d, "p1", rng, last);
        if (response === null) break;
        last = snapshotOf(response);
      }
      return d.exchanges.map((exchange) => exchange.response);
    };

    const first = play();
    const second = play();
    expect(second).toEqual(first);
  });

  it("B38 `debug` answers `failed` when the core is not a dev core, and the game goes on", () => {
    const d = driver({ ...ENV, dev: false });
    expect(d.send({ type: "start", config: config({ seed: "b38-no-debug", humanSeat: "p1" }) }).type).toBe("started");

    const response = d.send({ type: "debug" });
    expect(response.type).toBe("failed");
    if (response.type === "failed") expect(response.message.length).toBeGreaterThan(0);
    expect(JSON.stringify(response)).not.toContain('"library"');

    // Refusing the dev channel is not refusing the game.
    expect(d.send({ type: "act", action: { type: "concede" } }).type).toBe("snapshot");
  });
});

// ---------------------------------------------------------------------------------------------
// B39: the AI declines a draw at once (R188)
// ---------------------------------------------------------------------------------------------

describe("B39 a draw offer is declined by the AI's next step", () => {
  it("R188 B39 the human's offerDraw makes aiToAct true, and the next aiStep answers answerDraw { accept: false }", { timeout: 120_000 }, () => {
    const human: PlayerId = "p1";
    const ai: PlayerId = "p2";
    const d = driver();
    let main = untilHumanMain(d, human, snapshotOf(d.send({ type: "start", config: config({ seed: "r188-offer", humanSeat: human }) })));

    // The first of the human's main phases that offers a draw (R36 blocks nothing yet).
    for (let turns = 0; !main.legal.some((action) => action.type === "offerDraw"); turns += 1) {
      if (turns > 10) throw new Error("offerDraw was never legal for the human");
      main = untilHumanMain(d, human, snapshotOf(d.send({ type: "act", action: { type: "endTurn" } })));
    }
    expect(main.aiToAct).toBe(false);

    const offered = snapshotOf(d.send({ type: "act", action: { type: "offerDraw" } }));
    expect(offered.error).toBeNull();
    expect(offered.aiToAct, "an unanswered offer is the AI's to answer").toBe(true);
    expect(offered.view.active).toBe(human);

    const answered = snapshotOf(d.send({ type: "aiStep" }));
    expect(answered.view.events.at(-1)).toEqual(expect.objectContaining({ type: "drawAnswered", accept: false }));
    expect(answered.view.result).toBeNull();
    expect(answered.aiToAct, "the AI answers once and does not loop").toBe(false);

    const logged = debugOf(d).log.at(-1);
    expect(logged).toEqual({ type: "answerDraw", accept: false, playerId: ai, nonce: expect.stringMatching(/^a\d+$/) });
  });

  it("R188 B39 with no offer on the table the AI owes nothing in the human's main phase, and an aiStep changes nothing", { timeout: 60_000 }, () => {
    const human: PlayerId = "p1";
    const d = driver();
    const main = untilHumanMain(d, human, snapshotOf(d.send({ type: "start", config: config({ seed: "r188-no-offer", humanSeat: human }) })));
    expect(main.aiToAct).toBe(false);
    const before = debugOf(d);

    const stepped = snapshotOf(d.send({ type: "aiStep" }));
    expect(stepped.aiToAct).toBe(false);
    const after = debugOf(d);
    expect(after.hash).toBe(before.hash);
    expect(after.log).toEqual(before.log);
    expect(after.log.some((action) => action.type === "answerDraw")).toBe(false);
  });
});
