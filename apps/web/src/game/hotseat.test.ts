// BUILD M5-T3, tested against a scripted `EnginePort`.
//
// What this file owns is the LOOP — nonces, the log, the seat, the subscription — not the rules,
// so the port below is a fake: a turn counter with a settable pending choice. Every assertion is
// about what the session did with the port, which is the whole contract between the client and the
// engine (CLAUDE.md rule 7). (`packages/engine` compiles now, so the fake is a choice rather than
// the workaround it started as.)
//
// Because the port is a fake, NOTHING here can speak to the engine's determinism. The other half of
// M5-T3's acceptance — the same seed and actions reaching the same final state hash — is folded
// with the real engine in `packages/cards/test/hotseat-replay.test.ts`, and checked against the
// browser in `e2e/cypress/e2e/01-hotseat-full-game.cy.ts`.

import { describe, expect, it } from "vitest";

import type { Action, ActionBody, CardDef, CardDefs, GameEvent, PlayerId, PlayerView } from "@jackioh/shared";

import { DECK_SIZE, byIndex, printedCost, resolveDeck, resolveDecks } from "./decks.ts";
import type { EnginePort, EngineState, ReduceResult } from "./engine.ts";
import { createHotseat } from "./hotseat.ts";
import { baseView, emptySide } from "../test/fixtures.ts";

// ---------------------------------------------------------------------------------------------
// the scripted engine
// ---------------------------------------------------------------------------------------------

/** What the fake keeps. Not an `EngineState`: the session may not read it, so it is cast at the seam. */
type FakeState = { turn: number; active: PlayerId; pendingFor: PlayerId | null };

type FakeEngine = {
  port: EnginePort;
  /** Every port call, in order, for the "createGame then beginGame" assertion. */
  calls: string[];
  createGameArgs: { seed: string; decks: [string[], string[]]; catalog?: CardDefs }[];
  /** Every action handed to `reduce`, accepted or rejected. */
  reduced: Action[];
  /** The player argument of every `viewFor` / `legalActions` call. */
  viewedBy: PlayerId[];
  askedBy: PlayerId[];
  /** Set to make the next `reduce` refuse; cleared once it has. */
  nextError: string | null;
  /** Mutates the state the next accepted `reduce` returns. Consumed once. */
  nextEffect: ((state: FakeState) => void) | null;
  /** Whose prompt `beginGame` leaves open. */
  pendingAfterBegin: PlayerId | null;
  current(): FakeState;
};

const LEGAL: ActionBody[] = [{ type: "endTurn" }, { type: "concede" }];

function makeEngine(options: { pendingAfterBegin?: PlayerId | null; beginError?: string } = {}): FakeEngine {
  const fake: FakeEngine = {
    port: undefined as unknown as EnginePort,
    calls: [],
    createGameArgs: [],
    reduced: [],
    viewedBy: [],
    askedBy: [],
    nextError: null,
    nextEffect: null,
    pendingAfterBegin: options.pendingAfterBegin ?? null,
    current: () => live,
  };

  let live: FakeState = { turn: 0, active: "p1", pendingFor: null };
  const unwrap = (state: EngineState): FakeState => state as unknown as FakeState;
  const wrap = (state: FakeState): EngineState => state as unknown as EngineState;

  fake.port = {
    createGame: (args) => {
      fake.calls.push("createGame");
      fake.createGameArgs.push({
        seed: args.seed,
        decks: args.decks,
        ...(args.catalog === undefined ? {} : { catalog: args.catalog }),
      });
      live = { turn: 0, active: "p1", pendingFor: null };
      return wrap(live);
    },

    beginGame: (state) => {
      fake.calls.push("beginGame");
      const next: FakeState = { ...unwrap(state), turn: 1, pendingFor: fake.pendingAfterBegin };
      live = next;
      const events: GameEvent[] = [{ type: "turnStarted", player: next.active, turn: next.turn }];
      return {
        state: wrap(next),
        events,
        ...(options.beginError === undefined ? {} : { error: options.beginError }),
      } satisfies ReduceResult;
    },

    reduce: (state, action) => {
      fake.calls.push(`reduce:${action.type}`);
      fake.reduced.push(action);
      if (fake.nextError !== null) {
        const error = fake.nextError;
        fake.nextError = null;
        return { state, events: [], error };
      }
      const next: FakeState = { ...unwrap(state), turn: unwrap(state).turn + 1 };
      fake.nextEffect?.(next);
      fake.nextEffect = null;
      live = next;
      return { state: wrap(next), events: [{ type: "turnEnded", player: next.active, turn: next.turn, unspentMana: 0 }] };
    },

    legalActions: (_state, player) => {
      fake.calls.push("legalActions");
      fake.askedBy.push(player);
      return LEGAL;
    },

    // The one honest thing this has to get right: `pending` is expressed RELATIVE TO THE VIEWER,
    // exactly as SPEC §10.8 has it, because that is all the session may look at.
    viewFor: (state, player) => {
      fake.calls.push("viewFor");
      fake.viewedBy.push(player);
      const held = unwrap(state);
      const other: PlayerId = player === "p1" ? "p2" : "p1";
      const view: PlayerView = baseView({
        viewer: player,
        turn: held.turn,
        active: held.active,
        you: emptySide(player),
        opponent: emptySide(other),
        pending:
          held.pendingFor === null
            ? null
            : held.pendingFor === player
              ? { forYou: true, choiceId: "ch1", kind: "target", options: [], min: 1, max: 1, prompt: "Choose" }
              : { forYou: false, pendingFor: held.pendingFor },
      });
      return view;
    },

    hashState: (state) => JSON.stringify(unwrap(state)),
  };

  return fake;
}

const DECKS: [string[], string[]] = [["a1", "a2"], ["b1", "b2"]];

function session(fake: FakeEngine, over: { seed?: string; catalog?: CardDefs } = {}) {
  return createHotseat({
    seed: over.seed ?? "42",
    decks: DECKS,
    engine: fake.port,
    ...(over.catalog === undefined ? {} : { catalog: over.catalog }),
  });
}

// ---------------------------------------------------------------------------------------------
// the session
// ---------------------------------------------------------------------------------------------

describe("createHotseat", () => {
  it("calls createGame then beginGame, with the seed and both decks", () => {
    const fake = makeEngine();
    const live = session(fake, { seed: "seed-7" });

    expect(fake.calls.slice(0, 2)).toEqual(["createGame", "beginGame"]);
    expect(fake.createGameArgs).toEqual([{ seed: "seed-7", decks: DECKS }]);
    expect(live.seed).toBe("seed-7");
    expect(live.seat).toBe("p1");
  });

  it("passes the catalog through when it has one, and omits the key when it does not", () => {
    const defs: CardDefs = {};
    expect(session(makeEngine(), { catalog: defs }).seed).toBe("42");
    const withCatalog = makeEngine();
    session(withCatalog, { catalog: defs });
    expect(withCatalog.createGameArgs[0]?.catalog).toBe(defs);
    const without = makeEngine();
    session(without);
    expect("catalog" in (without.createGameArgs[0] ?? {})).toBe(false);
  });

  it("throws when beginGame refuses, so a game that cannot start is not a session", () => {
    const fake = makeEngine({ beginError: "deck too small" });
    expect(() => session(fake)).toThrow(/deck too small/);
  });
});

describe("nonces", () => {
  it("stamps n0, n1, n2 … and the dispatching seat", () => {
    const fake = makeEngine();
    const live = session(fake);
    live.dispatch({ type: "endTurn" });
    live.dispatch({ type: "endTurn" });
    live.dispatch({ type: "concede" });

    expect(fake.reduced.map((action) => action.nonce)).toEqual(["n0", "n1", "n2"]);
    expect(fake.reduced.map((action) => action.playerId)).toEqual(["p1", "p1", "p1"]);
    expect(live.log().map((action) => action.nonce)).toEqual(["n0", "n1", "n2"]);
  });

  it("keeps the body's own fields when it stamps a union member", () => {
    const fake = makeEngine();
    const live = session(fake);
    live.dispatch({ type: "play", instanceId: "c3", zone: { row: "units", lane: 2 }, x: 4 });
    expect(live.log()[0]).toEqual({
      type: "play",
      instanceId: "c3",
      zone: { row: "units", lane: 2 },
      x: 4,
      playerId: "p1",
      nonce: "n0",
    });
  });

  it("takes an override, so nothing else in the client may invent one", () => {
    const fake = makeEngine();
    const live = session(fake);
    const custom = createHotseat({
      seed: "42",
      decks: DECKS,
      engine: makeEngine().port,
      nonce: (n) => `x${n * 2}`,
    });
    live.dispatch({ type: "endTurn" });
    custom.dispatch({ type: "endTurn" });
    expect(live.log()[0]?.nonce).toBe("n0");
    expect(custom.log()[0]?.nonce).toBe("x0");
  });

  // NOT the M5-T3 replay acceptance, and it must not be read as one. The port here is scripted, so
  // all this can show is that the SESSION is a pure function of (seed, the bodies dispatched): same
  // nonces, same log, same call sequence. It would pass against an arbitrarily nondeterministic
  // engine, because the engine is a turn counter.
  //
  // "the same seed and actions reproduce the same final state hash in the browser and in vitest" is
  // proved by two things that use the real engine: `e2e/cypress/e2e/01-hotseat-full-game.cy.ts`
  // (browser hash vs a Node fold of the recorded log) and
  // `packages/cards/test/hotseat-replay.test.ts` (that same recorded log folded in vitest with the
  // real catalog and the 109 card scripts, against a written-down hash).
  it("two sessions with the same seed and the same actions agree on hash() and log()", () => {
    const bodies: ActionBody[] = [
      { type: "endTurn" },
      { type: "play", instanceId: "c1", zone: { row: "backrow", lane: 0 } },
      { type: "attack", attackerId: "u1", targetId: "u2" },
    ];

    const run = (): { hash: string; log: readonly Action[] } => {
      const live = session(makeEngine());
      for (const body of bodies) live.dispatch(body);
      return { hash: live.hash(), log: live.log() };
    };

    const first = run();
    const second = run();
    expect(second.hash).toBe(first.hash);
    expect(second.log).toEqual(first.log);
  });
});

describe("a rejected dispatch", () => {
  it("returns the error, keeps the old state, and logs nothing", () => {
    const fake = makeEngine();
    const live = session(fake);
    live.dispatch({ type: "endTurn" });
    const before = live.hash();

    fake.nextError = "it is not your turn";
    const result = live.dispatch({ type: "attack", attackerId: "u1", targetId: "u2" });

    expect(result.error).toBe("it is not your turn");
    expect(live.hash()).toBe(before);
    expect(live.log().map((action) => action.type)).toEqual(["endTurn"]);
  });

  it("does not consume the nonce: the engine only remembers nonces it accepted", () => {
    const fake = makeEngine();
    const live = session(fake);

    fake.nextError = "a prompt is open: answer it first";
    live.dispatch({ type: "endTurn" });
    live.dispatch({ type: "endTurn" });

    // The rejected action reached `reduce` as n0 and was never remembered there, so the accepted
    // action reuses n0. The log's nonces stay contiguous with the log, which is what lets
    // `replay.fold(seed, log)` in vitest reproduce the browser's hash (BUILD M5-T3 acceptance).
    expect(fake.reduced.map((action) => action.nonce)).toEqual(["n0", "n0"]);
    expect(live.log().map((action) => action.nonce)).toEqual(["n0"]);
  });

  it("does not notify subscribers", () => {
    const fake = makeEngine();
    const live = session(fake);
    let seen = 0;
    live.subscribe(() => {
      seen += 1;
    });
    fake.nextError = "no";
    live.dispatch({ type: "endTurn" });
    expect(seen).toBe(0);
  });
});

describe("seat switching", () => {
  it("follows a prompt that belongs to the other player", () => {
    const fake = makeEngine();
    const live = session(fake);
    expect(live.seat).toBe("p1");

    fake.nextEffect = (state) => {
      state.pendingFor = "p2";
    };
    live.dispatch({ type: "play", instanceId: "c1" });

    expect(live.seat).toBe("p2");
    expect(live.view().pending).toEqual({
      forYou: true,
      choiceId: "ch1",
      kind: "target",
      options: [],
      min: 1,
      max: 1,
      prompt: "Choose",
    });
  });

  it("stays put for a prompt that belongs to the seat holding the device", () => {
    const fake = makeEngine();
    const live = session(fake);
    fake.nextEffect = (state) => {
      state.pendingFor = "p1";
    };
    live.dispatch({ type: "play", instanceId: "c1" });
    expect(live.seat).toBe("p1");
  });

  it("does NOT follow a change of active player: only the button hands the device over", () => {
    const fake = makeEngine();
    const live = session(fake);
    fake.nextEffect = (state) => {
      state.active = "p2";
    };
    live.dispatch({ type: "endTurn" });

    expect(live.seat).toBe("p1");
    expect(live.view().active).toBe("p2");

    live.setSeat("p2");
    expect(live.seat).toBe("p2");
  });

  it("follows the opening prompt before the first render", () => {
    const live = session(makeEngine({ pendingAfterBegin: "p2" }));
    expect(live.seat).toBe("p2");
  });

  it("notifies on a manual switch and ignores a switch to the seat already holding it", () => {
    const live = session(makeEngine());
    let seen = 0;
    live.subscribe(() => {
      seen += 1;
    });
    live.setSeat("p1");
    expect(seen).toBe(0);
    live.setSeat("p2");
    expect(seen).toBe(1);
  });
});

describe("view() and legal()", () => {
  it("always ask for the seat holding the device, never a hardcoded p1", () => {
    const fake = makeEngine();
    const live = session(fake);
    fake.viewedBy.length = 0;
    fake.askedBy.length = 0;

    live.view();
    live.legal();
    live.setSeat("p2");
    live.view();
    live.legal();

    expect(fake.viewedBy).toEqual(["p1", "p2"]);
    expect(fake.askedBy).toEqual(["p1", "p2"]);
  });

  it("returns the port's own legality list unchanged", () => {
    const live = session(makeEngine());
    expect(live.legal()).toBe(LEGAL);
  });

  it("views the seat it switched to after a prompt", () => {
    const fake = makeEngine();
    const live = session(fake);
    fake.nextEffect = (state) => {
      state.pendingFor = "p2";
    };
    live.dispatch({ type: "endTurn" });
    fake.viewedBy.length = 0;
    expect(live.view().viewer).toBe("p2");
    expect(fake.viewedBy).toEqual(["p2"]);
  });
});

describe("subscribe", () => {
  it("fires on a successful dispatch and stops after unsubscribing", () => {
    const fake = makeEngine();
    const live = session(fake);
    let seen = 0;
    const off = live.subscribe(() => {
      seen += 1;
    });

    live.dispatch({ type: "endTurn" });
    expect(seen).toBe(1);
    live.dispatch({ type: "endTurn" });
    expect(seen).toBe(2);

    off();
    live.dispatch({ type: "endTurn" });
    expect(seen).toBe(2);
  });

  it("survives a subscriber that unsubscribes itself while being notified", () => {
    const live = session(makeEngine());
    let seen = 0;
    const off = live.subscribe(() => {
      seen += 1;
      off();
    });
    live.dispatch({ type: "endTurn" });
    live.dispatch({ type: "endTurn" });
    expect(seen).toBe(1);
  });
});

describe("state()", () => {
  it("hands the opaque state back for the dev handle and the hash", () => {
    const fake = makeEngine();
    const live = session(fake);
    live.dispatch({ type: "endTurn" });
    expect(live.state()).toBe(fake.current() as unknown as EngineState);
    expect(live.hash()).toBe(JSON.stringify(fake.current()));
  });
});

// ---------------------------------------------------------------------------------------------
// decks
// ---------------------------------------------------------------------------------------------

function def(index: number, over: Partial<CardDef> = {}): CardDef {
  return {
    id: `core-${String(index).padStart(3, "0")}`,
    index: String(index),
    name: `Card ${index}`,
    set: "Core",
    type: "Unit",
    tags: [],
    rarity: "Common",
    token: false,
    cost: index % 7,
    base: { attack: 1, health: 1, keywords: [], text: "" },
    radiant: { attack: 2, health: 2, keywords: [], text: "" },
    ...over,
  };
}

function synthetic(): CardDefs {
  const defs: CardDef[] = [];
  for (let i = 1; i <= 25; i += 1) defs.push(def(i));
  // Tokens, both ways `validateDeck` spots one (§2.6 L3).
  defs.push(def(26, { id: "t-rush", index: "T-rush", token: true, rarity: "Token" }));
  defs.push(def(27, { id: "core-051-1", index: "51.1", tags: ["Token"] }));
  return Object.fromEntries(defs.map((d) => [d.id, d]));
}

describe("resolveDeck", () => {
  it("errors on an empty catalog and never invents a card id", () => {
    const result = resolveDeck("first20", {});
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toMatch(/catalog is empty/);
      expect(result.error).toMatch(/packages\/cards/);
    }
  });

  it("errors on an unknown deck id and names the ones it has", () => {
    const result = resolveDeck("aggro-please", synthetic());
    expect("error" in result).toBe(true);
    if ("error" in result) {
      expect(result.error).toMatch(/unknown deck "aggro-please"/);
      expect(result.error).toMatch(/first20/);
      expect(result.error).toMatch(/cheap20/);
    }
  });

  it("errors when the catalog cannot fill a deck", () => {
    const small = Object.fromEntries([def(1), def(2)].map((d) => [d.id, d]));
    const result = resolveDeck("first20", small);
    expect("error" in result).toBe(true);
    if ("error" in result) expect(result.error).toMatch(/offers 2/);
  });

  it("first20 returns 20 distinct non-Token ids in index order", () => {
    const catalog = synthetic();
    const result = resolveDeck("first20", catalog);
    expect("deck" in result).toBe(true);
    if (!("deck" in result)) return;

    const { deck } = result;
    expect(deck).toHaveLength(DECK_SIZE);
    expect(new Set(deck).size).toBe(DECK_SIZE);
    for (const id of deck) {
      const found = catalog[id];
      expect(found, `${id} is in the catalog`).toBeDefined();
      expect(found?.token).toBe(false);
      expect(found?.tags).not.toContain("Token");
    }
    expect(deck[0]).toBe("core-001");
    expect(deck[19]).toBe("core-020");
  });

  it("cheap20 takes the lowest printed costs, ties broken by index", () => {
    const result = resolveDeck("cheap20", synthetic());
    expect("deck" in result).toBe(true);
    if (!("deck" in result)) return;
    const catalog = synthetic();
    const costs = result.deck.map((id) => printedCost(catalog[id]?.cost ?? 0));
    expect(result.deck).toHaveLength(DECK_SIZE);
    expect([...costs].sort((a, b) => a - b)).toEqual(costs);
    expect(Math.max(...costs)).toBeLessThanOrEqual(6);
  });

  it("is deterministic: the same catalog resolves the same list every time", () => {
    const catalog = synthetic();
    expect(resolveDeck("first20", catalog)).toEqual(resolveDeck("first20", catalog));
    expect(resolveDeck("cheap20", catalog)).toEqual(resolveDeck("cheap20", catalog));
  });

  it("prefers an injected E2E deck and still checks it against the catalog", () => {
    const catalog = synthetic();
    const cards = Object.keys(catalog).filter((id) => !id.startsWith("t-") && id !== "core-051-1").slice(0, 20);
    const good = resolveDeck("spec01", catalog, { spec01: cards });
    expect(good).toEqual({ deck: cards });

    const short = resolveDeck("spec01", catalog, { spec01: cards.slice(0, 19) });
    expect("error" in short && /exactly 20/.test(short.error)).toBe(true);

    const dupe = resolveDeck("spec01", catalog, { spec01: [...cards.slice(0, 19), cards[0] as string] });
    expect("error" in dupe && /repeats a card id/.test(dupe.error)).toBe(true);

    const token = resolveDeck("spec01", catalog, { spec01: [...cards.slice(0, 19), "t-rush"] });
    expect("error" in token && /Token card/.test(token.error)).toBe(true);

    const unknown = resolveDeck("spec01", catalog, { spec01: [...cards.slice(0, 19), "core-999"] });
    expect("error" in unknown && /not in the catalog/.test(unknown.error)).toBe(true);
  });
});

describe("resolveDecks", () => {
  it("resolves both seats in order", () => {
    const catalog = synthetic();
    const result = resolveDecks("first20", "cheap20", catalog);
    expect("decks" in result).toBe(true);
    if (!("decks" in result)) return;
    expect(result.decks[0]).toEqual((resolveDeck("first20", catalog) as { deck: string[] }).deck);
    expect(result.decks[1]).toEqual((resolveDeck("cheap20", catalog) as { deck: string[] }).deck);
  });

  it("reports the first side that failed", () => {
    const catalog = synthetic();
    expect(resolveDecks("nope", "first20", catalog)).toEqual({
      error: expect.stringMatching(/unknown deck "nope"/) as unknown as string,
    });
    expect(resolveDecks("first20", "nope", catalog)).toEqual({
      error: expect.stringMatching(/unknown deck "nope"/) as unknown as string,
    });
  });
});

describe("printedCost and byIndex", () => {
  it("reads costs out of play per R65: X is 0, an embiggen card is its base price", () => {
    expect(printedCost(3)).toBe(3);
    expect(printedCost("X")).toBe(0);
    expect(printedCost({ base: 2, embiggen: 5 })).toBe(2);
  });

  it("orders numeric indices numerically and keeps a total order for the rest", () => {
    expect(byIndex(def(2), def(10))).toBeLessThan(0);
    expect(byIndex(def(10), def(2))).toBeGreaterThan(0);
    expect(byIndex(def(2), def(2))).toBe(0);
    // A non-numeric index sorts after every numeric one, and two of them still order.
    const rush = def(1, { id: "t-rush", index: "T-rush" });
    const sheep = def(1, { id: "t-sheep", index: "T-sheep" });
    expect(byIndex(def(100), rush)).toBeLessThan(0);
    expect(byIndex(rush, sheep)).toBeLessThan(0);
    expect(byIndex(sheep, rush)).toBeGreaterThan(0);
  });
});
