/**
 * BUILD M6-T4 acceptance, items 1, 3 and 4 (item 2, crash recovery, is `recovery.test.ts`):
 *
 *  1. "two WebSocket clients complete a scripted game"
 *  3. "an action with a reused nonce returns the original ack"
 *  4. "the opponent's socket never receives the other hand's `defId`s (protocol-level test)"
 *
 * plus the properties SPEC §9 asks for around them: a client cannot act as the other player
 * (§9.1), a malformed frame is answered rather than fatal, the per-match flood limit rejects the
 * overflow (§9.8), and a disconnect starts the grace both clients render (§9.5).
 *
 * Item 4 is made twice. Most of this file runs on the scripted port in `test/fakes/engine.ts`,
 * which can be driven to any situation in one action; the block near the bottom runs the same
 * acceptance item on the **real** engine (`src/match/engine.real.ts`), because a redaction cannot
 * be proved against a `viewFor` the test suite wrote. That block's own header says what only it
 * can see.
 *
 * The clock is a stub here on purpose, and no longer because `src/match/clock.ts` is unfinished —
 * it is finished, has `clock.test.ts` to itself and is driven for real by `recovery.test.ts`. It is
 * a stub because the actor takes `CreateMatchClock` through `ActorDeps` and half the tests below
 * fire an expiry *on demand* (`clock.expire({ kind: "grace", player: "p1" })`), which a real clock
 * only does by advancing time past a deadline. The concurrent mulligan's tests (R265, R268) are the
 * exception: what they prove is a deadline — one for both seats, never re-armed — so they run the
 * real clock on the manual timers (`realClock: true`).
 */

import { describe, expect, it, vi } from "vitest";
import type { ActionBody, PlayerId, PlayerView } from "@jackioh/shared";
import { loadCatalog } from "../../src/api/catalog";
import type { MatchClocks, ResultRow } from "../../src/api/ports";
import { createRecordResult } from "../../src/api/results";
import { eloUpdate, MATCH_ACTIONS_PER_SECOND } from "../../src/config";
import type { MatchActor } from "../../src/match/actor";
import type {
  ActorDeps,
  ClockExpiry,
  ClockView,
  CreateMatchClock,
  MatchClock,
  RecordResultInput,
} from "../../src/match/contracts";
import { createMatchClock } from "../../src/match/clock";
import type { EnginePort } from "../../src/match/engine";
import { enginePort } from "../../src/match/engine.real.ts";
import type { PromptMessage } from "../../src/match/protocol";
import { createMatchRegistry } from "../../src/match/registry";
import { createMatchSocketHandler, socketFromWs, WS_CLOSE } from "../../src/match/wsServer";
import { createFakeEngine, decksTheEngineAccepts, fakeDeck } from "../fakes/engine";
import { createFakeSocket, type FakeSocket } from "../fakes/socket";
import { createTestDeps, TEST_CATALOG_VERSION } from "../fakes/deps";

// ---------------------------------------------------------------------------
// A deterministic stand-in for `src/match/clock.ts` (M7-T1, another agent's file)
// ---------------------------------------------------------------------------

type StubClock = MatchClock & {
  readonly synced: ClockView[];
  readonly grace: Record<PlayerId, boolean>;
  stopped: boolean;
  /** Fires an expiry the way the real clock's timer would (R79). */
  expire: (expiry: ClockExpiry) => void;
};

function stubClocks(): { create: CreateMatchClock; clock: () => StubClock } {
  let made: StubClock | null = null;

  const create: CreateMatchClock = ({ config, startedAt, onExpire }) => {
    const grace: Record<PlayerId, boolean> = { p1: false, p2: false };
    let pendingFor: PlayerId | null = null;
    let mulliganOwed: readonly PlayerId[] = [];
    let over = false;

    const snapshot = (): MatchClocks => ({
      turnDeadline: over ? null : startedAt + config.turnClockSeconds * 1000,
      promptDeadline:
        pendingFor !== null
          ? startedAt + config.promptClockSeconds * 1000
          : mulliganOwed.length > 0
            ? startedAt + config.mulliganClockSeconds * 1000
            : null,
      graceDeadline: {
        p1: grace.p1 ? startedAt + config.disconnectGraceSeconds * 1000 : null,
        p2: grace.p2 ? startedAt + config.disconnectGraceSeconds * 1000 : null,
      },
      ceilingAt: startedAt + config.matchCeilingMinutes * 60_000,
    });

    const clock: StubClock = {
      synced: [],
      grace,
      stopped: false,
      expire: (expiry) => {
        onExpire(expiry);
      },
      sync: (view) => {
        clock.synced.push(view);
        pendingFor = view.pendingFor;
        mulliganOwed = view.mulliganOwed;
        over = view.over;
      },
      startGrace: (player) => {
        grace[player] = true;
      },
      clearGrace: (player) => {
        grace[player] = false;
      },
      snapshot,
      // Fixed, so a view is byte-identical before and after a rebuild.
      remainingFor: () => null,
      stop: () => {
        clock.stopped = true;
      },
    };
    made = clock;
    return clock;
  };

  return {
    create,
    clock: () => {
      if (made === null) throw new Error("no clock was created");
      return made;
    },
  };
}

// ---------------------------------------------------------------------------
// Scaffolding
// ---------------------------------------------------------------------------

function resultWriter(): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: RecordResultInput): Promise<ResultRow> => {
    const winnerSeat =
      input.outcome.winner === "draw"
        ? undefined
        : input.seats.find((seat) => seat.player === input.outcome.winner);
    return {
      matchId: input.matchId,
      players: [input.seats[0].profileId, input.seats[1].profileId],
      winnerProfileId: winnerSeat?.profileId ?? null,
      reason: input.outcome.reason,
      turns: input.turns,
      endedAt: input.at,
      ratingBefore: [1000, 1000],
      ratingAfter: [1000, 1000],
    };
  });
}

const MATCH_ID = "match-1";

type Harness = {
  deps: ReturnType<typeof createTestDeps>;
  actorDeps: ActorDeps;
  registry: ReturnType<typeof createMatchRegistry>;
  actor: MatchActor;
  p1: FakeSocket;
  p2: FakeSocket;
  clocks: ReturnType<typeof stubClocks>;
  recordResult: ReturnType<typeof resultWriter>;
};

async function harness(
  options: {
    p1Deck?: string[];
    p2Deck?: string[];
    attach?: boolean;
    /** The real `EnginePort` for the block at the bottom of this file; the fake otherwise. */
    engine?: EnginePort;
    /** The real `createMatchClock` on the manual timers, for the tests about a deadline itself. */
    realClock?: boolean;
    /**
     * The real results writer (`api/results.ts`) over the in-memory store, with the two profiles
     * seeded at these ratings, for the tests about what an ending records; the stub otherwise.
     */
    ratings?: [number, number];
  } = {},
): Promise<Harness> {
  const deps = createTestDeps();
  const clocks = stubClocks();
  let recordResult = resultWriter();
  if (options.ratings !== undefined) {
    const [first, second] = options.ratings;
    deps.store.seedProfile({ id: "profile-1", rating: first, inMatchId: MATCH_ID });
    deps.store.seedProfile({ id: "profile-2", rating: second, inMatchId: MATCH_ID });
    recordResult = vi.fn(createRecordResult(deps));
  }
  const actorDeps: ActorDeps = {
    store: deps.store,
    timers: deps.timers,
    config: deps.config,
    log: deps.log,
    engine: options.engine ?? createFakeEngine(),
    createClock: options.realClock === true ? createMatchClock : clocks.create,
    recordResult: recordResult as unknown as ActorDeps["recordResult"],
  };

  const registry = createMatchRegistry(actorDeps);
  await registry.start({
    matchId: MATCH_ID,
    seed: "seed-actor",
    catalogVersion: TEST_CATALOG_VERSION,
    seats: [
      { profileId: "profile-1", player: "p1", deck: options.p1Deck ?? fakeDeck(["test-prompt-self"]) },
      {
        profileId: "profile-2",
        player: "p2",
        deck: options.p2Deck ?? fakeDeck(["test-prompt-enemy", "test-lethal"]),
      },
    ],
  });

  const actor = await registry.actorFor(MATCH_ID);
  const p1 = createFakeSocket();
  const p2 = createFakeSocket();
  if (options.attach !== false) {
    actor.attach("p1", p1);
    actor.attach("p2", p2);
    await actor.idle();
  }
  return { deps, actorDeps, registry, actor, p1, p2, clocks, recordResult };
}

async function send(
  actor: MatchActor,
  socket: FakeSocket,
  nonce: string,
  body: ActionBody,
  smuggled: Record<string, unknown> = {},
): Promise<void> {
  socket.receiveJson({ type: "action", action: { ...body, ...smuggled, nonce } });
  await actor.idle();
}

function views(socket: FakeSocket): PlayerView[] {
  return socket.ofType<{ type: "view"; view: PlayerView }>("view").map((frame) => frame.view);
}

function lastView(socket: FakeSocket): PlayerView {
  const view = views(socket).at(-1);
  if (view === undefined) throw new Error("no view frame was sent");
  return view;
}

function hand(view: PlayerView): { instanceId: string; defId: string }[] {
  const cards = view.you.hand;
  return Array.isArray(cards) ? cards.map(({ instanceId, defId }) => ({ instanceId, defId })) : [];
}

function firstInHand(socket: FakeSocket): string {
  const card = hand(lastView(socket))[0];
  if (card === undefined) throw new Error("the hand is empty");
  return card.instanceId;
}

function openChoice(socket: FakeSocket): string {
  const pending = lastView(socket).pending;
  if (pending === null || !pending.forYou) throw new Error("no prompt is open for this player");
  return pending.choiceId;
}

// `ofType` yields whole frames, discriminator included, so both of these name it: every server
// message is a member of `ServerMessage`'s tagged union (protocol.ts) and an `ack` is no exception.
function errors(socket: FakeSocket): { type: "error"; code: string; message: string; nonce?: string }[] {
  return socket.ofType<{ type: "error"; code: string; message: string; nonce?: string }>("error");
}

function acks(socket: FakeSocket): { type: "ack"; nonce: string; seq: number }[] {
  return socket.ofType<{ type: "ack"; nonce: string; seq: number }>("ack");
}

/**
 * Keys that only exist on a `GameState`, never on a `PlayerView` (§10.1 vs §10.8). A frame naming
 * one of them is a state that escaped, whatever its values happen to be.
 */
const STATE_ONLY_KEYS = new Set([
  "library",
  "libraries",
  "hands",
  "decks",
  "seed",
  "rngCursor",
  "triggerQueue",
  "echoQueue",
  "applied",
  "pendingChoice",
  "state",
]);

/** Every value that appears anywhere in a frame, with its key path, for the leak scan. */
function walk(value: unknown, visit: (key: string, value: unknown) => void, key = "$"): void {
  visit(key, value);
  if (Array.isArray(value)) {
    for (const entry of value) walk(entry, visit, key);
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [childKey, child] of Object.entries(value)) walk(child, visit, childKey);
  }
}

// ---------------------------------------------------------------------------
// M6-T4 acceptance 1
// ---------------------------------------------------------------------------

describe("M6-T4 the match actor", () => {
  it("two WebSocket clients complete a scripted game", async () => {
    const { actor, p1, p2, deps, recordResult } = await harness();

    // Both clients get a full view the moment they attach (§9.5, §10.8).
    expect(views(p1)).toHaveLength(1);
    expect(views(p2)).toHaveLength(1);
    expect(lastView(p1).viewer).toBe("p1");
    expect(lastView(p2).viewer).toBe("p2");

    // p1 plays a card that opens a prompt for itself, answers it, and ends the turn.
    await send(actor, p1, "n1", { type: "play", instanceId: firstInHand(p1) });
    expect(lastView(p1).pending).toMatchObject({ forYou: true });
    expect(lastView(p2).pending).toMatchObject({ forYou: false, pendingFor: "p1" });
    await send(actor, p1, "n2", {
      type: "answer",
      choiceId: openChoice(p1),
      selection: [{ pick: "none" }],
    });
    await send(actor, p1, "n3", { type: "endTurn" });
    expect(lastView(p2).active).toBe("p2");

    // p2 plays a card that opens a prompt for p1 (a trap firing on your turn, R79), p1 answers,
    // and p2 then plays lethal.
    await send(actor, p2, "n4", { type: "play", instanceId: firstInHand(p2) });
    expect(lastView(p1).pending).toMatchObject({ forYou: true });
    await send(actor, p1, "n5", {
      type: "answer",
      choiceId: openChoice(p1),
      selection: [{ pick: "none" }],
    });
    await send(actor, p2, "n6", { type: "play", instanceId: firstInHand(p2) });

    // Both sockets see the game through to its result.
    expect(lastView(p1).result).toEqual({ winner: "p2", reason: "hero-death" });
    expect(lastView(p2).result).toEqual({ winner: "p2", reason: "hero-death" });

    // §9.3: one append-only row per accepted action, gapless.
    const log = deps.store.tables.matchActions.filter((row) => row.matchId === MATCH_ID);
    expect(log.map((row) => row.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(log.map((row) => row.action.nonce)).toEqual(["n1", "n2", "n3", "n4", "n5", "n6"]);
    expect(acks(p1).map((ack) => ack.seq)).toEqual([1, 2, 3, 5]);
    expect(acks(p2).map((ack) => ack.seq)).toEqual([4, 6]);

    // §9.5: every ending records exactly one result.
    expect(recordResult).toHaveBeenCalledTimes(1);
    expect(recordResult.mock.calls[0]?.[0]).toMatchObject({
      matchId: MATCH_ID,
      outcome: { winner: "p2", reason: "hero-death" },
    });
    expect(deps.store.tables.matches[0]?.status).toBe("finished");
  });

  // -------------------------------------------------------------------------
  // M6-T4 acceptance 3
  // -------------------------------------------------------------------------

  it("an action with a reused nonce returns the original ack", async () => {
    const { actor, p1, deps } = await harness();
    // Read the hand off the attach view *before* clearing the buffer the counts below are taken
    // from: `clear()` drops the frames already sent, `firstInHand` needs one of them.
    const body: ActionBody = { type: "play", instanceId: firstInHand(p1) };
    p1.clear();

    await send(actor, p1, "same-nonce", body);
    const firstAck = acks(p1).at(-1);
    const viewsAfterFirst = views(p1).length;
    expect(firstAck).toEqual({ type: "ack", nonce: "same-nonce", seq: 1 });

    await send(actor, p1, "same-nonce", body);

    // The identical ack came back...
    expect(acks(p1)).toEqual([firstAck, firstAck]);
    // ...and nothing else happened: no second log row and no second view push.
    expect(deps.store.tables.matchActions).toHaveLength(1);
    expect(views(p1)).toHaveLength(viewsAfterFirst);
    expect(errors(p1)).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // M6-T4 acceptance 4
  // -------------------------------------------------------------------------

  it("the opponent's socket never receives the other hand's defIds", async () => {
    // `fakeDeck()` fills both decks with the same filler ids, which would make the scan below
    // pass for the wrong reason, so the two decks here are disjoint by construction.
    const p1Deck = Array.from({ length: 20 }, (_, i) => `p1-secret-${String(i)}`);
    const p2Deck = Array.from({ length: 20 }, (_, i) => `p2-secret-${String(i)}`);
    const { actor, p1, p2 } = await harness({ p1Deck, p2Deck });

    const p1Hand = new Set(hand(lastView(p1)).map((card) => card.defId));
    const p2Hand = new Set(hand(lastView(p2)).map((card) => card.defId));
    expect(p1Hand.size).toBeGreaterThan(0);
    expect(p2Hand.size).toBeGreaterThan(0);

    // Drive the match without playing anything, so every card in both hands stays hidden (a card
    // that has been played is public in the graveyard, §10.8).
    p1.clear();
    p2.clear();
    await send(actor, p1, "t1", { type: "endTurn" });
    await send(actor, p2, "t2", { type: "endTurn" });
    await send(actor, p1, "t3", { type: "offerDraw" });
    p1.receiveJson({ type: "hello" });
    await actor.idle();

    const leaked: string[] = [];
    const stateShaped: string[] = [];

    for (const [socket, secrets] of [
      [p2, p1Hand],
      [p1, p2Hand],
    ] as const) {
      for (const frame of socket.sent) {
        walk(JSON.parse(frame), (key, value) => {
          if (STATE_ONLY_KEYS.has(key)) stateShaped.push(`${key} in ${frame.slice(0, 40)}`);
          if (typeof value === "string" && secrets.has(value)) leaked.push(value);
        });
      }
    }

    expect(leaked).toEqual([]);
    expect(stateShaped).toEqual([]);
    // What the opponent does get is a count (§10.8).
    expect(lastView(p2).opponent.hand).toEqual({ count: p1Hand.size });
    expect(lastView(p1).opponent.hand).toEqual({ count: p2Hand.size });
    expect(lastView(p2).opponent.libraryCount).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // §9.1: the seat is the server's
  // -------------------------------------------------------------------------

  it("a client cannot submit an action as the other player", async () => {
    const { actor, p1, p2, deps } = await harness();

    // p1 puts p2's seat on the wire and asks to play one of p1's own cards.
    await send(
      actor,
      p1,
      "spoof",
      { type: "play", instanceId: firstInHand(p1) },
      { playerId: "p2" },
    );

    const row = deps.store.tables.matchActions.at(-1);
    expect(row?.action.playerId).toBe("p1");
    expect(actor.snapshot().active).toBe("p1");

    // And the other seat cannot act out of turn: the reducer's own refusal is relayed (§9.3).
    await send(actor, p2, "out-of-turn", { type: "endTurn" });
    expect(errors(p2).at(-1)).toEqual({
      type: "error",
      code: "illegal_action",
      message: "it is not your turn",
      nonce: "out-of-turn",
    });
    expect(deps.store.tables.matchActions).toHaveLength(1);
  });

  it("refuses a server-only action sent by a client (R79)", async () => {
    const { actor, p1, deps } = await harness();
    p1.receiveJson({ type: "action", action: { type: "ceilingReached", nonce: "cheat" } });
    await actor.idle();

    expect(errors(p1).at(-1)?.code).toBe("malformed");
    expect(errors(p1).at(-1)?.message).toContain("server-only");
    expect(deps.store.tables.matchActions).toEqual([]);
    expect(actor.snapshot().result).toBeNull();
  });

  it("answers a malformed frame and stays alive", async () => {
    const { actor, p1 } = await harness();

    p1.receive("this is not JSON");
    p1.receiveJson({ type: "action", action: { type: "play" } });
    p1.receiveJson({ type: "nonsense" });
    await actor.idle();

    expect(errors(p1).map((error) => error.code)).toEqual(["malformed", "malformed", "malformed"]);

    // The actor still works.
    await send(actor, p1, "after-garbage", { type: "endTurn" });
    expect(acks(p1).at(-1)).toEqual({ type: "ack", nonce: "after-garbage", seq: 1 });
  });

  // -------------------------------------------------------------------------
  // §9.8: per-match flood limit
  // -------------------------------------------------------------------------

  it("R137 rejects the overflow of a seat's action budget without touching the opponent's", async () => {
    const { actor, p1, p2, deps } = await harness();
    p1.clear();
    p2.clear();

    for (let i = 0; i <= MATCH_ACTIONS_PER_SECOND; i += 1) {
      await send(actor, p1, `flood-${String(i)}`, { type: "offerDraw" });
    }

    const overflow = errors(p1);
    expect(overflow).toHaveLength(1);
    expect(overflow[0]).toMatchObject({
      code: "rate_limited",
      nonce: `flood-${String(MATCH_ACTIONS_PER_SECOND)}`,
    });
    expect(deps.store.tables.matchActions).toHaveLength(MATCH_ACTIONS_PER_SECOND);
    // §9.8: reject the overflow, do not drop the socket.
    expect(p1.isOpen).toBe(true);

    // R137: one shared per-match counter would refuse the *victim* here, which is the abuse the
    // ruling is about. Each seat holds its own window, so the opponent's click still lands while
    // p1 is over budget — and the match's aggregate ceiling is twice R109's number, not once.
    await send(actor, p2, "opponent-click", { type: "offerDraw" });
    expect(errors(p2)).toEqual([]);
    expect(acks(p2).at(-1)?.nonce).toBe("opponent-click");

    // A second later the budget is back.
    deps.timers.advance(1000);
    await send(actor, p1, "after-window", { type: "offerDraw" });
    expect(acks(p1).at(-1)?.nonce).toBe("after-window");
  });

  // -------------------------------------------------------------------------
  // §9.5: disconnect grace, and the clock as the actor drives it
  // -------------------------------------------------------------------------

  it("starts the grace countdown on a drop and clears it on reconnect", async () => {
    const { actor, p1, p2, deps, clocks } = await harness();
    const clock = clocks.clock();

    p1.drop();
    await actor.idle();

    expect(clock.grace.p1).toBe(true);
    // §9.5: "the grace countdown is stored on the match so both clients show it".
    const stored = deps.store.tables.matches[0]?.clocks.graceDeadline;
    expect(stored?.p1).not.toBeNull();
    const shown = p2.ofType<{ clocks: MatchClocks }>("clock").at(-1);
    expect(shown?.clocks.graceDeadline.p1).toEqual(stored?.p1);

    // Reconnect: a fresh full view, never a log replay.
    const revived = createFakeSocket();
    actor.attach("p1", revived);
    await actor.idle();

    expect(clock.grace.p1).toBe(false);
    expect(views(revived)).toHaveLength(1);
    expect(lastView(revived).viewer).toBe("p1");
    expect(deps.store.tables.matches[0]?.clocks.graceDeadline.p1).toBeNull();
  });

  it("dispatches every clock expiry as a logged server action (R79), each stamped per R146", async () => {
    const { actor, p1, p2, deps, clocks, recordResult } = await harness();
    const clock = clocks.clock();

    // A turn expiry ends the active player's turn.
    clock.expire({ kind: "turn", player: "p1" });
    await actor.idle();
    let row = deps.store.tables.matchActions.at(-1);
    expect(row?.action).toMatchObject({ type: "timeout", playerId: "p1" });
    expect(actor.snapshot().active).toBe("p2");

    // A prompt expiry answers only that prompt (the holder is the non-active player here).
    await send(actor, p2, "prompt-enemy", { type: "play", instanceId: firstInHand(p2) });
    expect(actor.snapshot().pendingFor).toBe("p1");
    clock.expire({ kind: "prompt", player: "p1" });
    await actor.idle();
    row = deps.store.tables.matchActions.at(-1);
    expect(row?.action).toMatchObject({ type: "timeout", playerId: "p1" });
    expect(actor.snapshot().pendingFor).toBeNull();
    // R79: the non-active player's prompt clock does not end the active player's turn.
    expect(actor.snapshot().active).toBe("p2");

    // Grace expiry is a loss for the disconnected player.
    clock.expire({ kind: "grace", player: "p1" });
    await actor.idle();
    row = deps.store.tables.matchActions.at(-1);
    // R146: p2 is the active player by now, and the loss is still p1's — the result is stamped
    // with the seat it belongs to, never with whoever happened to be active.
    expect(actor.snapshot().active).toBe("p2");
    expect(row?.action).toMatchObject({ type: "disconnectExpired", player: "p1" });
    expect(actor.snapshot().result).toEqual({ winner: "p2", reason: "disconnect" });
    expect(recordResult).toHaveBeenCalledTimes(1);
    expect(clock.stopped).toBe(true);
    expect(lastView(p1).result).not.toBeNull();
    expect(lastView(p2).result).not.toBeNull();

    // Seqs stayed gapless across client and server actions alike (§9.3).
    expect(deps.store.tables.matchActions.map((entry) => entry.seq)).toEqual([1, 2, 3, 4]);
  });

  it("ends the match in a draw when the ceiling expires (R79), stamped with the active seat (R146)", async () => {
    const { actor, clocks, deps, recordResult } = await harness();
    const active = actor.snapshot().active;
    clocks.clock().expire({ kind: "ceiling" });
    await actor.idle();

    // R146: the ceiling belongs to neither player, so it is stamped with the active seat as a
    // convention — the log never has to guess whose action this was when it is folded back.
    expect(deps.store.tables.matchActions.at(-1)?.action).toMatchObject({
      type: "ceilingReached",
      playerId: active,
    });
    expect(actor.snapshot().result).toEqual({ winner: "draw", reason: "match-ceiling" });
    expect(recordResult).toHaveBeenCalledTimes(1);
  });

  it("answers an action after the result with match_over, not a log row", async () => {
    const { actor, p1, p2, deps } = await harness();
    clocksOver: {
      await send(actor, p1, "concede", { type: "concede" });
      break clocksOver;
    }
    const rows = deps.store.tables.matchActions.length;
    await send(actor, p2, "too-late", { type: "endTurn" });
    expect(errors(p2).at(-1)).toMatchObject({ code: "match_over", nonce: "too-late" });
    expect(deps.store.tables.matchActions).toHaveLength(rows);
  });

  it("tells a socket that room joins are an HTTP call", async () => {
    const { actor, p1 } = await harness();
    p1.receiveJson({ type: "joinRoom", roomCode: "ABCDEF" });
    await actor.idle();
    expect(errors(p1).at(-1)).toMatchObject({ code: "unsupported" });
  });
});

// ---------------------------------------------------------------------------
// BUILD M5-T2 / §10.2: the array the client greys the board out with
// ---------------------------------------------------------------------------

/**
 * "The client never computes legality itself; it asks `legalActions` and greys out the rest"
 * (BUILD M5-T2), and §10.2 makes `legalActions(state, playerId)` "what both the client UI and the
 * My Pawn AI consume". The socket is the client's only source for it, so it travels on the `view`
 * frame (`protocol.ts` `ViewMessage` says why there and not in a frame of its own).
 *
 * The property under test is not "an array arrives" but **whose** array arrives. `legalActions`
 * enumerates one `play` per card in the player's hand, so the other seat's array would hand over
 * every instance id in the opponent's hand — §9.1 lists that first under "Hidden".
 */
describe("the legal-action array on the view frame (BUILD M5-T2, §10.2)", () => {
  function legalOf(socket: FakeSocket): ActionBody[] {
    const frame = socket.ofType<{ type: "view"; legal: ActionBody[] }>("view").at(-1);
    if (frame === undefined) throw new Error("no view frame was sent");
    return frame.legal;
  }

  it("gives each seat its own array and never the other seat's", async () => {
    const { p1, p2 } = await harness();

    // The fake engine's `legalActions` is the real one's shape: one `play` per hand card for the
    // active player, plus `endTurn` and `concede`; `[{ type: "concede" }]` for the other seat.
    const p1Hand = hand(lastView(p1)).map((card) => card.instanceId);
    const p2Hand = hand(lastView(p2)).map((card) => card.instanceId);
    expect(p1Hand.length).toBeGreaterThan(0);
    expect(p2Hand.length).toBeGreaterThan(0);

    const mine = legalOf(p1);
    expect(mine.filter((action) => action.type === "play").map((action) => action.instanceId)).toEqual(
      p1Hand,
    );
    expect(mine.map((action) => action.type)).toContain("endTurn");

    // p2 is not the active player, so its own array is the one the engine gives p2 — and it names
    // none of p1's cards. This is the assertion that would fail if `pushView` ever passed the
    // wrong player to `legalActions`.
    expect(legalOf(p2)).toEqual([{ type: "concede" }]);
    const p2Sees = JSON.stringify(legalOf(p2));
    for (const instanceId of p1Hand) expect(p2Sees).not.toContain(instanceId);
  });

  it("re-derives the array after every action, for both seats", async () => {
    const { actor, p1, p2 } = await harness();

    expect(legalOf(p1).map((action) => action.type)).toContain("endTurn");
    expect(legalOf(p2)).toEqual([{ type: "concede" }]);

    await send(actor, p1, "hand-over", { type: "endTurn" });

    // The turn moved, so the two arrays swapped — neither client had to work that out.
    expect(legalOf(p1)).toEqual([{ type: "concede" }]);
    expect(legalOf(p2).map((action) => action.type)).toContain("endTurn");
  });

  it("an open prompt leaves the seat that does not hold it with nothing to do (§10.6)", async () => {
    const { actor, p1, p2 } = await harness();

    // `test-prompt-self` opens a prompt for the player who played it.
    await send(actor, p1, "prompt", { type: "play", instanceId: firstInHand(p1) });

    const choiceId = openChoice(p1);
    expect(legalOf(p1)).toEqual([{ type: "answer", choiceId, selection: [{ pick: "none" }] }]);
    // §10.6: the opponent "sees only that a prompt is open". Not even the choiceId reaches it —
    // an empty array is the whole of what p2 may do.
    expect(legalOf(p2)).toEqual([]);
    expect(JSON.stringify(legalOf(p2))).not.toContain(choiceId);
  });

  it("§9.5: a reconnecting socket gets the array with its fresh view", async () => {
    const { actor, p1 } = await harness();
    const before = legalOf(p1);

    p1.drop();
    await actor.idle();

    const revived = createFakeSocket();
    actor.attach("p1", revived);
    await actor.idle();

    // The attach pushed one view, and it carries the array: a board rebuilt after a reload is
    // interactive without waiting for the next action to happen (spec 05 reloads mid-prompt).
    expect(views(revived)).toHaveLength(1);
    expect(legalOf(revived)).toEqual(before);

    // `hello` means "push me a fresh full view" (§9.5), and that view is no different.
    revived.receiveJson({ type: "hello" });
    await actor.idle();
    expect(views(revived)).toHaveLength(2);
    expect(legalOf(revived)).toEqual(before);
  });

  it("is empty once the match has a result", async () => {
    const { actor, p1, p2 } = await harness();
    await send(actor, p1, "gg", { type: "concede" });
    expect(lastView(p1).result).not.toBeNull();
    expect(legalOf(p1)).toEqual([]);
    expect(legalOf(p2)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// M6-T4 acceptance 4 again, with the REAL engine under the actor
// ---------------------------------------------------------------------------

/**
 * The same acceptance item, against `packages/engine`'s own `viewFor`.
 *
 * Everything above runs on `test/fakes/engine.ts`, whose `viewFor` is written by this test suite —
 * so it proves that the actor and the protocol add no leak *on top of* a redaction, and cannot
 * prove the redaction. That is fine for the clock, the log and the flood limit, which is what the
 * fake is for, but CLAUDE.md rule 7 ("the client ... never sees hidden information") is the one
 * property where the component under test and the component asserted must not be the same file.
 *
 * So this block builds the real port (`src/match/engine.real.ts`, itself covered by
 * `engine.real.test.ts`), deals two decks of real §8 card ids through `registry.start`, and runs the
 * leak scan over the bytes the sockets actually received. Three things only exist here:
 *
 *  - the hands are dealt by `beginGame`'s real opening draw, not by a scripted `splice`;
 *  - `PlayerView.events` is a real redacted stream (R97), where the fake always sends `[]` — the
 *    `drawn` event for every card in the opponent's opening hand carries that card's `defId` in the
 *    state, and R97's `HIDDEN_ID` is the only reason it does not reach the other socket;
 *  - the open prompts are two real mulligans, open at once (R265), whose options name each chooser's
 *    own hand card by card (`setup.ts` `mulliganPrompt`), so R81's "only the viewer's own prompt
 *    carries its options" is carrying real ids rather than the fake's single `{ key: "none" }`.
 */

describe("M6-T4 acceptance 4 with the real engine (§10.8, CLAUDE.md rule 7)", () => {
  /** The real port, the real §8 catalog and two disjoint decks of real ids. */
  async function realEngine(): Promise<{
    engine: EnginePort;
    pool: string[];
    decks: [string[], string[]];
  }> {
    const catalog = await loadCatalog();
    const pool = catalog.cardIds.filter((cardId) => !catalog.isToken(cardId));
    const engine = enginePort();
    return { engine, pool, decks: decksTheEngineAccepts(engine, pool, "seed-actor").decks };
  }

  /** Keeps the whole hand, which is what makes the scan below sound: nothing leaves a hand. */
  function keepEverything(socket: FakeSocket): ActionBody {
    const cards = hand(lastView(socket));
    expect(cards.length).toBeGreaterThan(0);
    return { type: "mulligan", keep: cards.map((card) => card.instanceId) };
  }

  it("the opponent's socket never receives the other hand's defIds, through the real viewFor", async () => {
    const { engine, pool, decks } = await realEngine();
    const [p1Deck, p2Deck] = decks;

    // PREMISE: the two decks are real §8 ids and share none, so a defId found on the wrong socket
    // can only have come from the other player's deck.
    expect(p1Deck[0]).toBe(pool[0]);
    expect(p1Deck.filter((cardId) => p2Deck.includes(cardId))).toEqual([]);

    const { actor, p1, p2 } = await harness({ engine, p1Deck, p2Deck });

    // §2.1, R265: the game opens on both mulligans at once. Both keep everything, so every card
    // dealt is still in the hand it was dealt to when the scan runs — a card returned to the library
    // would be one the scan could not reason about, and a card played would be public (§10.8). p2
    // answers first, so the scan also covers the frames sent while p2's answer was sealed (R266).
    expect(lastView(p1).pending).toMatchObject({ forYou: true, kind: "mulligan" });
    expect(lastView(p2).pending).toMatchObject({ forYou: true, kind: "mulligan" });
    await send(actor, p2, "mull-2", keepEverything(p2));
    expect(lastView(p1).pending).toMatchObject({ forYou: true, kind: "mulligan" });
    expect(lastView(p2).pending).toEqual({ forYou: false, pendingFor: "p1" });
    await send(actor, p1, "mull-1", keepEverything(p1));

    // Out of setup and into the first real turn (§2.1, R10: p1 draws), then a reconnect-style full
    // view push, so the scan covers a view built after play has started as well as the attach ones.
    expect(actor.snapshot().phase).toBe("main");
    await send(actor, p1, "t1", { type: "endTurn" });
    p2.receiveJson({ type: "hello" });
    await actor.idle();

    const p1Hand = new Set(hand(lastView(p1)).map((card) => card.defId));
    const p2Hand = new Set(hand(lastView(p2)).map((card) => card.defId));
    // PREMISE: both hands really hold real cards. Empty sets would make every scan below vacuous.
    expect(p1Hand.size).toBeGreaterThan(0);
    expect(p2Hand.size).toBeGreaterThan(0);
    // Every one is a deck card, but for The Coin setup deals p2, who goes second (§2.1, R244), which
    // is as much a secret of p2's hand as any deck card in it.
    for (const defId of [...p1Hand, ...p2Hand]) expect([...pool, "core-t-coin"]).toContain(defId);
    expect(p2Hand.has("core-t-coin")).toBe(true);
    expect(p1Hand.has("core-t-coin")).toBe(false);

    // PREMISE: the frames really carry the events the fake never produced, so the R97 half of the
    // scan is exercising something.
    expect(lastView(p1).events.length).toBeGreaterThan(0);

    const leaked: string[] = [];
    const stateShaped: string[] = [];
    for (const [socket, secrets] of [
      [p2, p1Hand],
      [p1, p2Hand],
    ] as const) {
      for (const frame of socket.sent) {
        walk(JSON.parse(frame), (key, value) => {
          if (STATE_ONLY_KEYS.has(key)) stateShaped.push(`${key} in ${frame.slice(0, 40)}`);
          if (typeof value === "string" && secrets.has(value)) leaked.push(value);
        });
      }
    }

    expect(leaked).toEqual([]);
    expect(stateShaped).toEqual([]);

    // What the opponent does get is a count (§10.8), and the count is right.
    expect(lastView(p2).opponent.hand).toEqual({ count: p1Hand.size });
    expect(lastView(p1).opponent.hand).toEqual({ count: p2Hand.size });
    expect(lastView(p2).opponent.libraryCount).toBeGreaterThan(0);
    // §9.1: a library is a count for both players — the viewer's own included.
    expect(lastView(p2).you.libraryCount).toBeGreaterThan(0);
  });

  it("R81, R265: each seat's real mulligan prompt reaches only that seat, with both open at once", async () => {
    // The fake's prompt carries one `{ key: "none" }` option, so this is the assertion the fake
    // could not make: the real mulligan prompt names every card in the chooser's hand by instance
    // id and by `defId` (`setup.ts` `mulliganPrompt`, `viewFor.ts` `optionView`). R265 opens both
    // at once, so each seat is at the same time the holder of one prompt and the other's opponent.
    const { engine, decks } = await realEngine();
    const { p1, p2 } = await harness({ engine, p1Deck: decks[0], p2Deck: decks[1] });

    for (const [holder, opponent] of [
      [p1, p2],
      [p2, p1],
    ] as const) {
      const pending = lastView(holder).pending;
      if (pending === null || !pending.forYou) throw new Error("a seat holds no prompt");
      // PREMISE: the options really do name the cards, so the negative below is about redaction
      // and not about an empty option list.
      expect(pending.kind).toBe("mulligan");
      expect(pending.options.length).toBeGreaterThan(0);
      expect(pending.options.map((option) => option.defId)).toEqual(
        hand(lastView(holder)).map((card) => card.defId),
      );

      // §10.6, R81: the other seat is shown its own prompt, never this one — not the choiceId, not
      // an option, not a card.
      const theirs = lastView(opponent).pending;
      expect(theirs).toMatchObject({ forYou: true, kind: "mulligan" });
      if (theirs !== null && theirs.forYou) expect(theirs.choiceId).not.toBe(pending.choiceId);

      // Whole values, never substrings: real instance ids are `c<n>`, so `c2` is a prefix of the
      // other seat's own `c21` and a substring search would report a leak that is not one.
      const secrets = new Set<string>([pending.choiceId]);
      for (const option of pending.options) {
        secrets.add(option.key);
        if (option.instanceId !== undefined) secrets.add(option.instanceId);
        if (option.defId !== undefined) secrets.add(option.defId);
      }
      const seen: string[] = [];
      for (const frame of opponent.sent) {
        walk(JSON.parse(frame), (_key, value) => {
          if (typeof value === "string" && secrets.has(value)) seen.push(value);
        });
      }
      expect(seen).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// The concurrent mulligan through the actor (R265, R266, R268)
// ---------------------------------------------------------------------------

/**
 * Both seats' mulligans are open at once (R265) and live outside `pending`, so they are the one time
 * two seats owe an answer together. What the actor adds to the engine here is its own: the prompt
 * frames each seat is sent, the one mulligan clock (R268) and the timeouts its expiry becomes. The
 * rules — what an answer may keep, that it is sealed, what a timeout keeps — are the engine's, and
 * `packages/engine` proves them.
 *
 * These run the real engine and the real clock: the fields under test are the real `viewFor`'s
 * (`pending`, `mulligan`), and the claims about the deadline are the clock's own.
 */
describe("the concurrent mulligan through the actor (R265, R266, R268)", () => {
  async function realDecks(): Promise<{ engine: EnginePort; decks: [string[], string[]] }> {
    const catalog = await loadCatalog();
    const pool = catalog.cardIds.filter((cardId) => !catalog.isToken(cardId));
    const engine = enginePort();
    return { engine, decks: decksTheEngineAccepts(engine, pool, "seed-actor").decks };
  }

  async function mulliganMatch(): Promise<Harness & { mulliganMs: number; turnMs: number }> {
    const { engine, decks } = await realDecks();
    const h = await harness({ engine, p1Deck: decks[0], p2Deck: decks[1], realClock: true });
    return {
      ...h,
      mulliganMs: h.deps.config.mulliganClockSeconds * 1000,
      turnMs: h.deps.config.turnClockSeconds * 1000,
    };
  }

  function prompts(socket: FakeSocket): PromptMessage[] {
    return socket.ofType<PromptMessage>("prompt");
  }

  function legalOf(socket: FakeSocket): ActionBody[] {
    const frame = socket.ofType<{ type: "view"; legal: ActionBody[] }>("view").at(-1);
    if (frame === undefined) throw new Error("no view frame was sent");
    return frame.legal;
  }

  function ids(socket: FakeSocket): string[] {
    return hand(lastView(socket)).map((card) => card.instanceId);
  }

  function choiceOf(socket: FakeSocket): string {
    const pending = lastView(socket).pending;
    if (pending === null || !pending.forYou || pending.kind !== "mulligan") {
      throw new Error("this seat owes no mulligan");
    }
    return pending.choiceId;
  }

  it("R265 the actor accepts mulligans from both seats in either order, and each push fits each seat", async () => {
    for (const first of ["p2", "p1"] as const) {
      const second: PlayerId = first === "p1" ? "p2" : "p1";
      const { actor, p1, p2, deps, mulliganMs, turnMs } = await mulliganMatch();
      const socket = { p1, p2 };
      const deadline = actor.clocks().promptDeadline;

      // Both prompts are open from the start, each seat holding its own, with its own answers and
      // concede on its legal array (R211) — and one clock between them (R268).
      for (const seat of ["p1", "p2"] as const) {
        expect(lastView(socket[seat]).pending).toMatchObject({ forYou: true, kind: "mulligan" });
        expect(lastView(socket[seat]).mulligan).toEqual({ youReady: false, opponentReady: false });
        expect(lastView(socket[seat]).clockMs).toBe(mulliganMs);
        const legal = legalOf(socket[seat]);
        expect(legal.some((action) => action.type === "mulligan")).toBe(true);
        expect(legal).toContainEqual({ type: "concede" });
        for (const action of legal) {
          if (action.type === "mulligan") for (const id of action.keep) expect(ids(socket[seat])).toContain(id);
        }
      }
      expect(actor.snapshot()).toMatchObject({ phase: "mulligan", turn: 0, pendingFor: null });
      expect(actor.snapshot().mulliganOwed).toEqual(["p1", "p2"]);

      // The first answer, which returns two cards, is sealed: it is in, and nothing moves (R266).
      const firstHand = ids(socket[first]);
      const firstKeep = firstHand.slice(2);
      const secondChoice = choiceOf(socket[second]);
      p1.clear();
      p2.clear();
      await send(actor, socket[first], `mull-${first}`, { type: "mulligan", keep: firstKeep });

      expect(lastView(socket[first]).pending).toEqual({ forYou: false, pendingFor: second });
      expect(lastView(socket[first]).mulligan).toEqual({ youReady: true, opponentReady: false, kept: firstKeep });
      expect(ids(socket[first])).toEqual(firstHand);
      expect(legalOf(socket[first])).toEqual([{ type: "concede" }]);
      expect(lastView(socket[second]).pending).toMatchObject({ forYou: true, choiceId: secondChoice });
      // That the other seat is ready is all the second seat is told: no `kept` of anyone's.
      expect(lastView(socket[second]).mulligan).toEqual({ youReady: false, opponentReady: true });
      expect(actor.snapshot().mulliganOwed).toEqual([second]);

      // Each seat's prompt frame is the one that fits it, and both carry the one deadline, unmoved.
      expect(prompts(socket[first])).toEqual([
        { type: "prompt", forYou: false, pendingFor: second, deadline },
      ]);
      expect(prompts(socket[second])).toEqual([
        { type: "prompt", forYou: true, pendingFor: second, choiceId: secondChoice, kind: "mulligan", deadline },
      ]);
      expect(actor.clocks().promptDeadline).toBe(deadline);

      // The second answer resolves both, in seat order, and the game begins (R265, §2.1). With
      // these decks p1 has nothing to do on turn 1, so §2.5 ends it by itself inside the same action
      // and the first turn at rest is p2's — which is why the seats below are read, not assumed.
      await send(actor, socket[second], `mull-${second}`, { type: "mulligan", keep: ids(socket[second]) });
      const active = actor.snapshot().active;
      for (const seat of ["p1", "p2"] as const) {
        const view = lastView(socket[seat]);
        expect(view).toMatchObject({ phase: "main", active, pending: null });
        expect(view.turn).toBeGreaterThanOrEqual(1);
        expect(view.mulligan).toBeUndefined();
      }
      expect(actor.snapshot().mulliganOwed).toEqual([]);
      // The first seat's two returned cards were replaced: same count, two new ids.
      expect(ids(socket[first]).filter((id) => !firstKeep.includes(id)).length).toBeGreaterThanOrEqual(2);

      // One row per answer, in the order they came, stamped with the seat that sent it (§9.1, §9.3).
      const log = deps.store.tables.matchActions.map((row) => row.action);
      expect(log.map((action) => [action.type, action.playerId])).toEqual([
        ["mulligan", first],
        ["mulligan", second],
      ]);
      // The mulligan clock is gone, and the active seat's turn clock runs from full.
      expect(actor.clocks().promptDeadline).toBeNull();
      expect(actor.clocks().turnDeadline).toBe(deps.timers.now() + turnMs);
      expect(lastView(socket[active]).clockMs).toBe(turnMs);
      expect(lastView(socket[active === "p1" ? "p2" : "p1"]).clockMs).toBeNull();
      await actor.stop();
    }
  });

  it("R266 a sealed answer never reaches the other seat: its view changes by the ready flag alone", async () => {
    const { actor, p1, p2 } = await mulliganMatch();
    const before = lastView(p1);
    const p2Hand = hand(lastView(p2));
    const p2Keep = p2Hand.slice(0, 2).map((card) => card.instanceId);
    expect(p2Hand.length).toBeGreaterThan(2);

    await send(actor, p2, "sealed", { type: "mulligan", keep: p2Keep });

    // Everything p1 is shown is what it was shown before, but that p2 is ready (and the public
    // `promptAnswered` that says so). No part of the view depends on what p2 kept.
    const after = lastView(p1);
    const strip = (view: PlayerView): Partial<PlayerView> => {
      const { mulligan: _mulligan, events: _events, ...rest } = view;
      return rest;
    };
    expect(strip(after)).toEqual(strip(before));
    expect(after.mulligan).toEqual({ youReady: false, opponentReady: true });
    expect(after.events.at(-1)).toMatchObject({ type: "promptAnswered", player: "p2" });

    // And no frame p1's socket ever received names one of p2's cards, by instance or by definition.
    const secrets = new Set<string>(p2Hand.flatMap((card) => [card.instanceId, card.defId]));
    const leaked: string[] = [];
    for (const frame of p1.sent) {
      walk(JSON.parse(frame), (_key, value) => {
        if (typeof value === "string" && secrets.has(value)) leaked.push(value);
      });
    }
    expect(leaked).toEqual([]);
  });

  it("R268 the mulligan clock is one deadline for both seats, not re-armed when one answers, and times out the seat left", async () => {
    const { actor, p1, p2, deps, mulliganMs, turnMs } = await mulliganMatch();
    const armedAt = deps.timers.now();
    const deadline = actor.clocks().promptDeadline;

    // One deadline, stored on the match so both clients render it (§9.5), and no turn clock under it.
    expect(deadline).toBe(armedAt + mulliganMs);
    expect(actor.clocks().turnDeadline).toBeNull();
    expect(deps.store.tables.matches[0]?.clocks.promptDeadline).toBe(deadline);

    // p1 answers 10 s in. Both seats are still on the same deadline, the one that answered included.
    deps.timers.advance(10_000);
    await send(actor, p1, "p1-first", { type: "mulligan", keep: ids(p1) });
    expect(actor.clocks().promptDeadline).toBe(deadline);
    expect(p1.ofType<{ clocks: MatchClocks }>("clock").at(-1)?.clocks.promptDeadline).toBe(deadline);
    expect(p2.ofType<{ clocks: MatchClocks }>("clock").at(-1)?.clocks.promptDeadline).toBe(deadline);
    expect(lastView(p1).clockMs).toBe(mulliganMs - 10_000);
    expect(lastView(p2).clockMs).toBe(mulliganMs - 10_000);

    const offered = ((): string[] => {
      const pending = lastView(p2).pending;
      if (pending === null || !pending.forYou) throw new Error("p2 owes no mulligan");
      return pending.options.map((option) => option.key);
    })();

    // Nothing happens a millisecond early; at the deadline p2, the one seat still owing, times out.
    deps.timers.advance(mulliganMs - 10_000 - 1);
    await actor.idle();
    expect(deps.store.tables.matchActions).toHaveLength(1);
    deps.timers.advance(1);
    await actor.idle();

    const log = deps.store.tables.matchActions.map((row) => row.action);
    expect(log).toHaveLength(2);
    expect(log[1]).toMatchObject({ type: "timeout", playerId: "p2", nonce: "srv-mulligan-2" });
    // R268: a timed-out mulligan keeps the whole hand — every card p2 was offered is still there.
    for (const id of offered) expect(ids(p2)).toContain(id);
    expect(actor.snapshot()).toMatchObject({ phase: "main", mulliganOwed: [], result: null });

    // And the mulligan clock hands over to the ordinary turn clock, from full.
    expect(actor.clocks().promptDeadline).toBeNull();
    expect(actor.clocks().turnDeadline).toBe(deps.timers.now() + turnMs);
    expect(lastView(actor.snapshot().active === "p1" ? p1 : p2).clockMs).toBe(turnMs);
  });

  it("R270 a client may not send a nonce the server mints, so it cannot swallow the clock's own timeout", async () => {
    const { actor, p1, p2, deps, mulliganMs } = await mulliganMatch();
    // p1 answers with the very nonce the mulligan expiry would mint for p2's timeout (seq 2).
    await send(actor, p1, "srv-mulligan-2", { type: "mulligan", keep: ids(p1) });
    expect(errors(p1).at(-1)).toMatchObject({ code: "malformed" });
    expect(errors(p1).at(-1)?.message).toMatch(/R270/);
    expect(deps.store.tables.matchActions).toHaveLength(0);
    expect(actor.snapshot().mulliganOwed).toEqual(["p1", "p2"]);

    // Under any other nonce the answer stands, and the expiry still times out the seat left.
    await send(actor, p1, "p1-ready", { type: "mulligan", keep: ids(p1) });
    expect(actor.snapshot().mulliganOwed).toEqual(["p2"]);
    deps.timers.advance(mulliganMs);
    await actor.idle();
    const log = deps.store.tables.matchActions.map((row) => row.action);
    expect(log.at(-1)).toMatchObject({ type: "timeout", playerId: "p2", nonce: "srv-mulligan-2" });
    expect(actor.snapshot()).toMatchObject({ mulliganOwed: [], result: null });
    expect(errors(p2)).toEqual([]);
  });

  it("R268 when neither seat answers, the expiry times out both, in seat order, each its own row", async () => {
    const { actor, p1, p2, deps, mulliganMs, turnMs } = await mulliganMatch();
    const hands = { p1: ids(p1), p2: ids(p2) };

    deps.timers.advance(mulliganMs);
    await actor.idle();

    const log = deps.store.tables.matchActions.map((row) => row.action);
    expect(log).toEqual([
      expect.objectContaining({ type: "timeout", playerId: "p1", nonce: "srv-mulligan-1" }),
      expect.objectContaining({ type: "timeout", playerId: "p2", nonce: "srv-mulligan-2" }),
    ]);
    expect(deps.store.tables.matchActions.map((row) => row.seq)).toEqual([1, 2]);
    // Both kept everything (R268); what else is in each hand is turn 1's draw (R10) and The Coin (R244).
    for (const id of hands.p1) expect(ids(p1)).toContain(id);
    for (const id of hands.p2) expect(ids(p2)).toContain(id);
    expect(actor.snapshot()).toMatchObject({ phase: "main", mulliganOwed: [], result: null });
    expect(actor.clocks().turnDeadline).toBe(deps.timers.now() + turnMs);
  });

  it("R268 the turn clock that follows the mulligan clock is p1's, on turn 1, from full", async () => {
    // The scripted port never ends a turn by itself, so turn 1 is at rest when the window closes and
    // the hand-over can be read exactly: the real clock, the actor's two timeouts, then p1's turn.
    const { actor, p1, p2, deps } = await harness({ engine: createFakeEngine({ mulligan: true }), realClock: true });
    const mulliganMs = deps.config.mulliganClockSeconds * 1000;
    const turnMs = deps.config.turnClockSeconds * 1000;
    expect(lastView(p1).clockMs).toBe(mulliganMs);
    expect(lastView(p2).clockMs).toBe(mulliganMs);

    deps.timers.advance(mulliganMs);
    await actor.idle();

    expect(deps.store.tables.matchActions.map((row) => [row.action.type, row.action.playerId])).toEqual([
      ["timeout", "p1"],
      ["timeout", "p2"],
    ]);
    expect(actor.snapshot()).toMatchObject({ phase: "main", turn: 1, active: "p1", mulliganOwed: [] });
    expect(actor.clocks()).toMatchObject({ promptDeadline: null, turnDeadline: deps.timers.now() + turnMs });
    expect(lastView(p1).clockMs).toBe(turnMs);
    expect(lastView(p2).clockMs).toBeNull();

    // And it is an ordinary turn clock: it runs out in `turnClockSeconds` and ends p1's turn.
    deps.timers.advance(turnMs);
    await actor.idle();
    expect(deps.store.tables.matchActions.at(-1)?.action).toMatchObject({ type: "timeout", playerId: "p1" });
    expect(actor.snapshot()).toMatchObject({ turn: 2, active: "p2" });
  });

  it("R268 an expiry reads who still owes when it runs, so a seat that answered gets no timeout", async () => {
    // The scripted port models the concurrent mulligan too (`createFakeEngine({ mulligan: true })`),
    // and the stub clock fires an expiry on demand — including one that arrives after both answered.
    const { actor, p1, p2, deps, clocks } = await harness({ engine: createFakeEngine({ mulligan: true }) });
    const clock = clocks.clock();
    // The actor hands the clock the window, both seats owing, before anyone acts.
    expect(clock.synced[0]?.mulliganOwed).toEqual(["p1", "p2"]);
    expect(clock.synced[0]?.pendingFor).toBeNull();

    await send(actor, p2, "p2-first", { type: "mulligan", keep: [] });
    expect(clock.synced.at(-1)?.mulliganOwed).toEqual(["p1"]);
    clock.expire({ kind: "mulligan" });
    await actor.idle();
    expect(deps.store.tables.matchActions.map((row) => [row.action.type, row.action.playerId])).toEqual([
      ["mulligan", "p2"],
      ["timeout", "p1"],
    ]);
    expect(clock.synced.at(-1)?.mulliganOwed).toEqual([]);
    expect(actor.snapshot()).toMatchObject({ phase: "main", turn: 1 });

    // A late alarm, once both are in, is owed by nobody and writes nothing.
    clock.expire({ kind: "mulligan" });
    await actor.idle();
    expect(deps.store.tables.matchActions).toHaveLength(2);
    expect(errors(p1)).toEqual([]);
    expect(errors(p2)).toEqual([]);
  });

  it("R265 refuses anything but a mulligan or a way out while the mulligans are open, relaying the engine", async () => {
    const { actor, p1, p2, deps } = await mulliganMatch();

    await send(actor, p1, "too-soon", { type: "endTurn" });
    expect(errors(p1).at(-1)).toMatchObject({ code: "illegal_action", nonce: "too-soon" });
    // A seat cannot answer twice: its answer is sealed, not open to revision (R266).
    await send(actor, p2, "once", { type: "mulligan", keep: [] });
    await send(actor, p2, "twice", { type: "mulligan", keep: [] });
    expect(errors(p2).at(-1)).toMatchObject({ code: "illegal_action", nonce: "twice" });
    expect(deps.store.tables.matchActions.map((row) => row.action.nonce)).toEqual(["once"]);
  });

  it("R265 a seat may concede during the mulligan, and the loss is recorded exactly once (§9.5)", async () => {
    const { engine, decks } = await realDecks();
    const { actor, p1, p2, deps, recordResult } = await harness({
      engine,
      p1Deck: decks[0],
      p2Deck: decks[1],
      realClock: true,
      ratings: [1000, 1000],
    });

    await send(actor, p1, "p1-ready", { type: "mulligan", keep: [] });
    await send(actor, p2, "gg", { type: "concede" });
    expect(lastView(p1).result).toEqual({ winner: "p1", reason: "concede" });
    expect(lastView(p2).result).toEqual({ winner: "p1", reason: "concede" });

    // Once, however many more times anyone asks.
    await send(actor, p2, "gg-again", { type: "concede" });
    await send(actor, p1, "gg-too", { type: "concede" });
    expect(errors(p2).at(-1)).toMatchObject({ code: "match_over", nonce: "gg-again" });
    expect(errors(p1).at(-1)).toMatchObject({ code: "match_over", nonce: "gg-too" });
    expect(recordResult).toHaveBeenCalledTimes(1);

    const won = eloUpdate(1000, 1000, 1);
    expect(deps.store.tables.results).toEqual([
      expect.objectContaining({
        matchId: MATCH_ID,
        winnerProfileId: "profile-1",
        reason: "concede",
        ratingBefore: [1000, 1000],
        ratingAfter: [won.a, won.b],
      }),
    ]);
    expect(deps.store.tables.matches[0]?.status).toBe("finished");
    // No clock is left to fire into a finished match.
    expect(deps.timers.pending).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Draw offers and concede through the actor (R36, R269, §9.5)
// ---------------------------------------------------------------------------

/**
 * A draw offer is an engine rule end to end (R36): who may offer (the active player, in the main
 * phase), how often (`DRAW_OFFERS_PER_TURN`), how long a decline blocks (`DRAW_OFFER_BLOCK_TURNS`)
 * and how long an unanswered offer stands (R269) are all `packages/engine`'s, because hotseat and
 * practice play them with no server at all. The actor only relays: an offer is an action like any
 * other, its refusal is the reducer's sentence, and an accepted draw is one more ending for the
 * results writer. So these run the real engine — the fake's `offerDraw` is unconditional — and the
 * real results writer over the in-memory store, so "rated 0.5 each" is the real Elo move.
 */
describe("draw offers and concede through the actor (R36, R269, §9.5)", () => {
  type DrawHarness = Harness & {
    /** The seat at rest in its main phase once the mulligans are done, who may offer (R36). */
    offerer: FakeSocket;
    /** The other seat, who answers. */
    answerer: FakeSocket;
    offererSeat: PlayerId;
  };

  async function drawMatch(ratings?: [number, number]): Promise<DrawHarness> {
    const catalog = await loadCatalog();
    const pool = catalog.cardIds.filter((cardId) => !catalog.isToken(cardId));
    const engine = enginePort();
    const { decks } = decksTheEngineAccepts(engine, pool, "seed-actor");
    const h = await harness({ engine, p1Deck: decks[0], p2Deck: decks[1], ...(ratings ? { ratings } : {}) });
    // Past both mulligans (R265), keeping everything, into p1's first main phase.
    for (const [player, socket] of [
      ["p1", h.p1],
      ["p2", h.p2],
    ] as const) {
      await send(h.actor, socket, `mull-${player}`, {
        type: "mulligan",
        keep: hand(lastView(socket)).map((card) => card.instanceId),
      });
    }
    // With these decks p1 has nothing to do on turn 1, so §2.5 ends it by itself and the first turn
    // at rest is p2's. Whose it is does not matter to R36, so it is read rather than assumed.
    const snapshot = h.actor.snapshot();
    expect(snapshot).toMatchObject({ phase: "main", pendingFor: null, result: null });
    const offererSeat = snapshot.active;
    return {
      ...h,
      offererSeat,
      offerer: offererSeat === "p1" ? h.p1 : h.p2,
      answerer: offererSeat === "p1" ? h.p2 : h.p1,
    };
  }

  function legalTypes(socket: FakeSocket): string[] {
    const frame = socket.ofType<{ type: "view"; legal: ActionBody[] }>("view").at(-1);
    if (frame === undefined) throw new Error("no view frame was sent");
    return frame.legal.map((action) => action.type);
  }

  /** Ends the turn of whoever is active, and says so if the engine refused. */
  async function endTurn(h: Harness, nonce: string): Promise<void> {
    const active = h.actor.snapshot().active;
    const socket = active === "p1" ? h.p1 : h.p2;
    await send(h.actor, socket, nonce, { type: "endTurn" });
    expect(errors(socket).filter((error) => error.nonce === nonce)).toEqual([]);
    expect(h.actor.snapshot().pendingFor).toBeNull();
  }

  /** Ends turns until the offerer's next turn is at rest (a turn with nothing to do ends itself). */
  async function toOfferersNextTurn(h: DrawHarness): Promise<void> {
    const from = h.actor.snapshot().turn;
    for (let step = 0; step < 4; step += 1) {
      await endTurn(h, `to-next-${String(step)}`);
      const now = h.actor.snapshot();
      if (now.active === h.offererSeat && now.turn > from) return;
    }
    throw new Error("the offerer's next turn never came to rest");
  }

  it("R269 a standing offer is on both seats' views, and accepting it ends the match as a draw rated 0.5 each", async () => {
    const ratings: [number, number] = [1200, 1000];
    const h = await drawMatch(ratings);
    const { actor, offerer, answerer, offererSeat, deps, recordResult } = h;

    // R36: only the active player may offer, so only the offerer's array carries it.
    expect(legalTypes(offerer)).toContain("offerDraw");
    expect(legalTypes(answerer)).not.toContain("offerDraw");
    expect(lastView(offerer).drawOffer).toBeUndefined();

    await send(actor, offerer, "offer", { type: "offerDraw" });
    // R269: public to both seats, so the offerer can see it is waiting and the other seat can answer.
    expect(lastView(offerer).drawOffer).toEqual({ by: offererSeat });
    expect(lastView(answerer).drawOffer).toEqual({ by: offererSeat });
    expect(legalTypes(answerer)).toContain("answerDraw");

    await send(actor, answerer, "accept", { type: "answerDraw", accept: true });
    expect(lastView(offerer).result).toEqual({ winner: "draw", reason: "draw-accepted" });
    expect(lastView(answerer).result).toEqual({ winner: "draw", reason: "draw-accepted" });
    expect(lastView(offerer).drawOffer).toBeUndefined();

    // §9.5: one result, through the writer every ending goes through, rated as a draw — 0.5 each,
    // which from unequal ratings is a real move toward each other (R79's Elo).
    expect(recordResult).toHaveBeenCalledTimes(1);
    expect(recordResult.mock.calls[0]?.[0]).toMatchObject({
      matchId: MATCH_ID,
      outcome: { winner: "draw", reason: "draw-accepted" },
    });
    const drawn = eloUpdate(ratings[0], ratings[1], 0.5);
    expect(drawn.a).toBeLessThan(ratings[0]);
    expect(drawn.b).toBeGreaterThan(ratings[1]);
    expect(deps.store.tables.results).toEqual([
      expect.objectContaining({
        winnerProfileId: null,
        reason: "draw-accepted",
        ratingBefore: ratings,
        ratingAfter: [drawn.a, drawn.b],
      }),
    ]);
    const profiles = await deps.store.profiles.getMany(["profile-1", "profile-2"]);
    expect(profiles.map((profile) => [profile.rating, profile.inMatchId])).toEqual([
      [drawn.a, null],
      [drawn.b, null],
    ]);
    expect(deps.store.tables.matches[0]?.status).toBe("finished");
  });

  it("R36 a declined offer leaves the match live and blocks the offerer, by the engine's rule and in its words", async () => {
    const h = await drawMatch();
    const { actor, offerer, answerer, deps, recordResult } = h;

    await send(actor, offerer, "offer", { type: "offerDraw" });
    await send(actor, answerer, "decline", { type: "answerDraw", accept: false });
    expect(actor.snapshot().result).toBeNull();
    expect(lastView(offerer).drawOffer).toBeUndefined();
    expect(lastView(answerer).drawOffer).toBeUndefined();
    expect(legalTypes(answerer)).not.toContain("answerDraw");

    // The offerer can no longer offer: not on its array, and refused by the reducer if sent anyway,
    // with the reducer's own sentence relayed and no row written (§9.3, §9.8).
    expect(legalTypes(offerer)).not.toContain("offerDraw");
    const rows = deps.store.tables.matchActions.length;
    await send(actor, offerer, "again", { type: "offerDraw" });
    expect(errors(offerer).at(-1)).toEqual({
      type: "error",
      code: "illegal_action",
      message: "you cannot offer a draw right now",
      nonce: "again",
    });
    expect(deps.store.tables.matchActions).toHaveLength(rows);

    // R36's block outlasts the turn: the offerer's next turn still offers no draw.
    await toOfferersNextTurn(h);
    expect(legalTypes(offerer)).not.toContain("offerDraw");
    expect(recordResult).not.toHaveBeenCalled();
  });

  it("R269 an unanswered offer lapses when its offerer's turn ends, and blocks nothing", async () => {
    const h = await drawMatch();
    const { actor, offerer, answerer, offererSeat } = h;

    await send(actor, offerer, "offer", { type: "offerDraw" });
    expect(lastView(answerer).drawOffer).toEqual({ by: offererSeat });

    await endTurn(h, "end-1");
    // Gone from both views and from the array of the seat that could have answered it.
    expect(lastView(offerer).drawOffer).toBeUndefined();
    expect(lastView(answerer).drawOffer).toBeUndefined();
    expect(legalTypes(answerer)).not.toContain("answerDraw");
    await send(actor, answerer, "late", { type: "answerDraw", accept: true });
    expect(errors(answerer).at(-1)).toMatchObject({
      code: "illegal_action",
      message: "there is no draw offer to answer",
      nonce: "late",
    });
    expect(actor.snapshot().result).toBeNull();

    // A lapse is not a decline (R269): the offerer may offer again on its next turn.
    await toOfferersNextTurn(h);
    expect(legalTypes(offerer)).toContain("offerDraw");
  });

  it("§9.5 concede records the loss once, and rates it as one", async () => {
    const h = await drawMatch([1000, 1000]);
    const { actor, p1, p2, deps, recordResult } = h;

    // Conceded by p1, whoever's turn it is (concede is open to both seats at all times, §2.5).
    await send(actor, p1, "resign", { type: "concede" });
    expect(lastView(p2).result).toEqual({ winner: "p2", reason: "concede" });
    await send(actor, p1, "resign-again", { type: "concede" });
    expect(errors(p1).at(-1)).toMatchObject({ code: "match_over", nonce: "resign-again" });

    expect(recordResult).toHaveBeenCalledTimes(1);
    const lost = eloUpdate(1000, 1000, 0);
    expect(deps.store.tables.results).toEqual([
      expect.objectContaining({
        winnerProfileId: "profile-2",
        reason: "concede",
        ratingAfter: [lost.a, lost.b],
      }),
    ]);
  });
});

// ---------------------------------------------------------------------------
// The `ws` adapter (smoke only: every protocol guarantee above is proven on the same `Socket`)
// ---------------------------------------------------------------------------

type FakeWs = {
  readyState: number;
  sent: string[];
  closes: { code?: number; reason?: string }[];
  emit: (event: string, ...args: unknown[]) => void;
};

function fakeWs(): FakeWs {
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>();
  const ws: FakeWs & {
    send: (text: string) => void;
    close: (code?: number, reason?: string) => void;
    on: (event: string, listener: (...args: unknown[]) => void) => unknown;
  } = {
    readyState: 1,
    sent: [],
    closes: [],
    send: (text) => {
      ws.sent.push(text);
    },
    close: (code, reason) => {
      ws.closes.push({ code, reason });
      ws.readyState = 3;
      for (const listener of listeners.get("close") ?? []) listener();
    },
    on: (event, listener) => {
      listeners.set(event, [...(listeners.get(event) ?? []), listener]);
      return ws;
    },
    emit: (event, ...args) => {
      for (const listener of listeners.get(event) ?? []) listener(...args);
    },
  };
  return ws;
}

describe("the automatic turn end is each player's to turn off (R82, R345)", () => {
  async function realMatch(): Promise<Harness> {
    const catalog = await loadCatalog();
    const pool = catalog.cardIds.filter((cardId) => !catalog.isToken(cardId));
    const engine = enginePort();
    const { decks } = decksTheEngineAccepts(engine, pool, "seed-actor");
    return harness({ engine, p1Deck: decks[0], p2Deck: decks[1] });
  }

  async function keepHands(h: Harness): Promise<void> {
    for (const [player, socket] of [
      ["p1", h.p1],
      ["p2", h.p2],
    ] as const) {
      await send(h.actor, socket, `mull-${player}`, {
        type: "mulligan",
        keep: hand(lastView(socket)).map((card) => card.instanceId),
      });
    }
  }

  it("R345 a seat that turned it off during the mulligan keeps a turn it has nothing to do on, and only its own view says so", async () => {
    // With these decks p1 has nothing to do on turn 1, so R82 would end that turn by itself (the
    // draw-offer harness above leans on exactly that).
    const h = await realMatch();
    await send(h.actor, h.p1, "auto-off", { type: "setAutoEndTurn", enabled: false });
    expect(errors(h.p1)).toEqual([]);
    await keepHands(h);

    expect(h.actor.snapshot()).toMatchObject({ phase: "main", active: "p1", pendingFor: null, result: null });
    expect(lastView(h.p1).autoEndTurn).toBe(false);
    expect(lastView(h.p2)).not.toHaveProperty("autoEndTurn");

    await send(h.actor, h.p1, "end", { type: "endTurn" });
    expect(h.actor.snapshot().active).toBe("p2");
  });

  it("R345 without it, the same turn 1 ends by itself, and a malformed preference is answered, not applied", async () => {
    const h = await realMatch();
    await send(h.actor, h.p1, "bad", { type: "setAutoEndTurn", enabled: "no" } as unknown as ActionBody);
    expect(errors(h.p1).at(-1)?.code).toBe("malformed");
    await keepHands(h);
    expect(h.actor.snapshot()).toMatchObject({ phase: "main", active: "p2" });
    expect(lastView(h.p1)).not.toHaveProperty("autoEndTurn");
  });
});

describe("the ws adapter", () => {
  it("turns a ws connection into the actor's Socket, text frames only", () => {
    const ws = fakeWs();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the structural shape above is what `socketFromWs` uses
    const socket = socketFromWs(ws as any);
    const seen: string[] = [];
    let closed = false;
    socket.attach({
      message: (text) => seen.push(text),
      close: () => {
        closed = true;
      },
    });

    expect(socket.isOpen).toBe(true);
    socket.send(`{"type":"view"}`);
    expect(ws.sent).toEqual([`{"type":"view"}`]);

    ws.emit("message", Buffer.from(`{"type":"hello"}`), false);
    expect(seen).toEqual([`{"type":"hello"}`]);

    ws.emit("message", Buffer.from([1, 2, 3]), true);
    expect(seen).toHaveLength(1);
    expect(ws.sent.at(-1)).toContain("text frames only");

    ws.emit("close");
    expect(closed).toBe(true);
  });

  it("R148 refuses a socket that is not in the match it asked for, mirroring the HTTP status", async () => {
    const deps = createTestDeps();
    const token = deps.auth.addUser({ userId: "user-1", email: "a@example.test" });
    deps.store.seedProfile({ id: "profile-1", userId: "user-1", status: "active", inMatchId: "other" });
    const attach = vi.fn(async () => "p1");
    const handler = createMatchSocketHandler({
      auth: deps.auth,
      store: deps.store,
      log: deps.log,
      registry: { attach },
    });

    const refused = fakeWs();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- as above
    await handler(refused as any, { url: `/match?token=${token}&matchId=match-1`, headers: {} });
    expect(refused.closes.at(-1)?.code).toBe(WS_CLOSE.forbidden);
    expect(attach).not.toHaveBeenCalled();

    const anonymous = fakeWs();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- as above
    await handler(anonymous as any, { url: "/match", headers: {} });
    expect(anonymous.closes.at(-1)?.code).toBe(WS_CLOSE.unauthorized);

    // R148: 4401 and 4403 are the private-use mirrors of 401 and 403, and only the close code
    // varies — §9.1: a socket learns that it may not have this match, never which check said so.
    expect(WS_CLOSE.unauthorized).toBe(4401);
    expect(WS_CLOSE.forbidden).toBe(4403);
    for (const ws of [refused, anonymous]) {
      expect(ws.sent.at(-1)).toContain('"code":"forbidden"');
    }

    const accepted = fakeWs();
    deps.store.tables.profiles[0] = {
      ...(deps.store.tables.profiles[0] ?? {
        id: "profile-1",
        userId: "user-1",
        email: "a@example.test",
        status: "active" as const,
        rating: 1000,
        createdAt: 0,
      }),
      inMatchId: "match-1",
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- as above
    await handler(accepted as any, { url: `/match?matchId=match-1`, headers: { authorization: `Bearer ${token}` } });
    expect(attach).toHaveBeenCalledTimes(1);
    expect(attach.mock.calls[0]?.slice(0, 2)).toEqual(["match-1", "profile-1"]);
  });

  it("gives a pending account no socket (§9.4)", async () => {
    const deps = createTestDeps();
    const token = deps.auth.addUser({ userId: "user-2", email: "b@example.test" });
    deps.store.seedProfile({ id: "profile-2", userId: "user-2", status: "pending", inMatchId: "match-1" });
    const attach = vi.fn(async () => "p1");
    const handler = createMatchSocketHandler({
      auth: deps.auth,
      store: deps.store,
      log: deps.log,
      registry: { attach },
    });

    const ws = fakeWs();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- as above
    await handler(ws as any, { url: `/match?token=${token}&matchId=match-1`, headers: {} });
    expect(ws.closes.at(-1)?.code).toBe(WS_CLOSE.forbidden);
    expect(attach).not.toHaveBeenCalled();
  });
});
