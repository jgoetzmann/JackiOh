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
 * The clock is a stub here on purpose: `src/match/clock.ts` is M7-T1 and another agent's file, so
 * the actor takes `CreateMatchClock` through `ActorDeps` and this file supplies a deterministic
 * one. The day the real clock lands it drops straight in.
 */

import { describe, expect, it, vi } from "vitest";
import type { ActionBody, PlayerId, PlayerView } from "@jackioh/shared";
import type { MatchClocks, ResultRow } from "../../src/api/ports";
import { MATCH_ACTIONS_PER_SECOND } from "../../src/config";
import type { MatchActor } from "../../src/match/actor";
import type {
  ActorDeps,
  ClockExpiry,
  ClockView,
  CreateMatchClock,
  MatchClock,
  RecordResultInput,
} from "../../src/match/contracts";
import { createMatchRegistry } from "../../src/match/registry";
import { createMatchSocketHandler, socketFromWs, WS_CLOSE } from "../../src/match/wsServer";
import { createFakeEngine, fakeDeck } from "../fakes/engine";
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
    let over = false;

    const snapshot = (): MatchClocks => ({
      turnDeadline: over ? null : startedAt + config.turnClockSeconds * 1000,
      promptDeadline: pendingFor === null ? null : startedAt + config.promptClockSeconds * 1000,
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
  options: { p1Deck?: string[]; p2Deck?: string[]; attach?: boolean } = {},
): Promise<Harness> {
  const deps = createTestDeps();
  const clocks = stubClocks();
  const recordResult = resultWriter();
  const actorDeps: ActorDeps = {
    store: deps.store,
    timers: deps.timers,
    config: deps.config,
    log: deps.log,
    engine: createFakeEngine(),
    createClock: clocks.create,
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
    // Keys that only exist on a `GameState`, never on a `PlayerView` (§10.1 vs §10.8).
    const forbiddenKeys = new Set([
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

    for (const [socket, secrets] of [
      [p2, p1Hand],
      [p1, p2Hand],
    ] as const) {
      for (const frame of socket.sent) {
        walk(JSON.parse(frame), (key, value) => {
          if (forbiddenKeys.has(key)) stateShaped.push(`${key} in ${frame.slice(0, 40)}`);
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

  it("rejects the overflow of the per-match action rate limit", async () => {
    const { actor, p1, deps } = await harness();
    p1.clear();

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

  it("dispatches every clock expiry as a logged server action (R79)", async () => {
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
    expect(row?.action).toMatchObject({ type: "disconnectExpired", player: "p1" });
    expect(actor.snapshot().result).toEqual({ winner: "p2", reason: "disconnect" });
    expect(recordResult).toHaveBeenCalledTimes(1);
    expect(clock.stopped).toBe(true);
    expect(lastView(p1).result).not.toBeNull();
    expect(lastView(p2).result).not.toBeNull();

    // Seqs stayed gapless across client and server actions alike (§9.3).
    expect(deps.store.tables.matchActions.map((entry) => entry.seq)).toEqual([1, 2, 3, 4]);
  });

  it("ends the match in a draw when the ceiling expires (R79)", async () => {
    const { actor, clocks, deps, recordResult } = await harness();
    clocks.clock().expire({ kind: "ceiling" });
    await actor.idle();

    expect(deps.store.tables.matchActions.at(-1)?.action).toMatchObject({ type: "ceilingReached" });
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

  it("refuses a socket that is not in the match it asked for", async () => {
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
