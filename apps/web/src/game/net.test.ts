// `game/net.ts` driven entirely through a fake WebSocket: every frame
// `apps/server/src/match/protocol.ts` defines, the handshake, the reconnect and the dev-handle shim.
//
// No real socket, no timer and no server. The seams (`socketFactory`, `timers`, `monotonic`) exist
// for exactly this, so the protocol can be asserted the way `apps/server` asserts it against its own
// in-memory socket.

import { describe, expect, it } from "vitest";

import type { ActionBody, PlayerView } from "@jackioh/shared";

import { baseView } from "../test/fixtures.ts";
import {
  createMatchClient,
  parseServerFrame,
  remainingMs,
  socketUrlFor,
  viewDerivedState,
  type MatchClient,
  type SocketLike,
  type Timers,
} from "./net.ts";

// ---------------------------------------------------------------------------------------------
// fakes
// ---------------------------------------------------------------------------------------------

class FakeSocket implements SocketLike {
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string; wasClean: boolean }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  readonly sent: string[] = [];
  closedWith: { code?: number; reason?: string } | null = null;

  constructor(readonly url: string) {}

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.readyState = 3;
    this.closedWith = { ...(code === undefined ? {} : { code }), ...(reason === undefined ? {} : { reason }) };
  }

  // --- test drivers -------------------------------------------------------------------------

  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  deliver(frame: unknown): void {
    this.onmessage?.({ data: typeof frame === "string" ? frame : JSON.stringify(frame) });
  }

  drop(code = 1006, reason = ""): void {
    this.readyState = 3;
    this.onclose?.({ code, reason, wasClean: false });
  }

  /** What the client sent, parsed. */
  frames(): Record<string, unknown>[] {
    return this.sent.map((text) => JSON.parse(text) as Record<string, unknown>);
  }
}

type Harness = {
  client: MatchClient;
  sockets: FakeSocket[];
  socket: () => FakeSocket;
  /** Run every pending backoff callback, in order. */
  runTimers: () => void;
  pending: () => number;
  now: (value: number) => void;
};

function harness(options: { matchId?: string; token?: string } = {}): Harness {
  const sockets: FakeSocket[] = [];
  let scheduled: { id: number; run: () => void }[] = [];
  let nextId = 1;
  let monotonicNow = 0;

  const timers: Timers = {
    setTimeout: (handler) => {
      const id = nextId;
      nextId += 1;
      scheduled.push({ id, run: handler });
      return id;
    },
    clearTimeout: (handle) => {
      scheduled = scheduled.filter((entry) => entry.id !== handle);
    },
  };

  const client = createMatchClient({
    matchId: options.matchId ?? "m-1",
    token: options.token ?? "tok",
    baseUrl: "ws://server.test/ws/match",
    socketFactory: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      return socket;
    },
    timers,
    monotonic: () => monotonicNow,
  });

  return {
    client,
    sockets,
    socket: () => {
      const last = sockets.at(-1);
      if (last === undefined) throw new Error("no socket was opened");
      return last;
    },
    runTimers: () => {
      const due = scheduled;
      scheduled = [];
      for (const entry of due) entry.run();
    },
    pending: () => scheduled.length,
    now: (value) => {
      monotonicNow = value;
    },
  };
}

function connected(options: { matchId?: string; token?: string } = {}): Harness {
  const h = harness(options);
  h.client.connect();
  h.socket().open();
  return h;
}

// ---------------------------------------------------------------------------------------------
// the handshake
// ---------------------------------------------------------------------------------------------

describe("the handshake", () => {
  it("carries the token and the match in the query string, because a browser cannot set headers", () => {
    // `apps/server/src/match/wsServer.ts` `tokenFrom` reads `authorization` OR `?token=`, and the
    // match from `?matchId=`.
    const url = socketUrlFor("ws://server.test/ws/match", "tok en", "m-1");
    expect(url).toContain("token=tok+en");
    expect(url).toContain("matchId=m-1");
  });

  it("appends to a base that already carries a query", () => {
    const url = socketUrlFor("ws://server.test/ws/match?trace=1", "t", "m");
    expect(url).toContain("trace=1");
    expect(url).toContain("token=t");
    expect(url).toContain("matchId=m");
  });

  it("sends `hello` on open: §9.5's 'push me a fresh full view'", () => {
    const h = connected();
    expect(h.socket().frames()).toEqual([{ type: "hello", token: "tok", matchId: "m-1" }]);
    expect(h.client.snapshot().connection).toBe("open");
  });
});

// ---------------------------------------------------------------------------------------------
// the frames
// ---------------------------------------------------------------------------------------------

describe("server frames", () => {
  it("a `view` frame becomes the rendered view", () => {
    const h = connected();
    const view = baseView({ turn: 7 });
    h.socket().deliver({ type: "view", view });
    expect(h.client.snapshot().view?.turn).toBe(7);
  });

  it("with no legal list anywhere, the board stays empty and says so", () => {
    // The hard blocker: `protocol.ts` has no frame carrying `legalActions`. The client does NOT
    // compute it (rule 7, BUILD M5-T2) — it reports the gap.
    const h = connected();
    h.socket().deliver({ type: "view", view: baseView() });
    expect(h.client.snapshot().legal).toEqual([]);
    expect(h.client.snapshot().legalSource).toBe("none");
  });

  it("accepts a `legal` field riding alongside the view", () => {
    const h = connected();
    const legal: ActionBody[] = [{ type: "endTurn" }];
    h.socket().deliver({ type: "view", view: baseView(), legal });
    expect(h.client.snapshot().legal).toEqual(legal);
    expect(h.client.snapshot().legalSource).toBe("view");
  });

  it("accepts a separate `legal` frame", () => {
    const h = connected();
    h.socket().deliver({ type: "legal", legal: [{ type: "offerDraw" }] });
    expect(h.client.snapshot().legal).toEqual([{ type: "offerDraw" }]);
    expect(h.client.snapshot().legalSource).toBe("frame");
  });

  it("a view without a legal field does not blank a list a `legal` frame just set", () => {
    const h = connected();
    h.socket().deliver({ type: "legal", legal: [{ type: "endTurn" }] });
    h.socket().deliver({ type: "view", view: baseView() });
    expect(h.client.snapshot().legal).toEqual([{ type: "endTurn" }]);
  });

  it("relays an `error` verbatim (§9.3: the reducer's reason, never reworded)", () => {
    const h = connected();
    h.socket().deliver({
      type: "error",
      code: "illegal_action",
      message: "that zone is Locked",
      nonce: "n1",
    });
    expect(h.client.snapshot().error).toBe("that zone is Locked");
    expect(h.client.snapshot().errorCode).toBe("illegal_action");
  });

  it("an `ack` clears the refusal on screen and reports the log seq", () => {
    const h = connected();
    h.socket().deliver({ type: "error", code: "illegal_action", message: "no" });
    h.socket().deliver({ type: "ack", nonce: "n1", seq: 12 });
    expect(h.client.snapshot().error).toBeNull();
    expect(h.client.snapshot().ack).toEqual({ nonce: "n1", seq: 12 });
  });

  it("splits `prompt` on forYou, exactly as §10.6 splits it", () => {
    const h = connected();
    h.socket().deliver({ type: "prompt", forYou: false, pendingFor: "p2", deadline: 99 });
    expect(h.client.snapshot().prompt).toEqual({ forYou: false, pendingFor: "p2", deadline: 99 });

    h.socket().deliver({
      type: "prompt",
      forYou: true,
      pendingFor: "p1",
      choiceId: "c1",
      kind: "mode",
      deadline: null,
    });
    expect(h.client.snapshot().prompt).toEqual({
      forYou: true,
      pendingFor: "p1",
      choiceId: "c1",
      kind: "mode",
      deadline: null,
    });
  });

  it("keeps a `clock` frame with the monotonic reading it landed at", () => {
    const h = connected();
    h.now(1_000);
    h.socket().deliver({
      type: "clock",
      now: 50_000,
      clocks: {
        turnDeadline: 125_000,
        promptDeadline: null,
        graceDeadline: { p1: null, p2: null },
        ceilingAt: 3_650_000,
      },
    });
    const clock = h.client.snapshot().clock;
    expect(clock?.clocks.turnDeadline).toBe(125_000);
    expect(clock?.receivedAt).toBe(1_000);
  });

  it("ignores a frame it does not understand rather than taking the board down", () => {
    const h = connected();
    h.socket().deliver({ type: "somethingNew", payload: 1 });
    h.socket().deliver("not json at all");
    h.socket().deliver({ type: "view", view: baseView({ turn: 4 }) });
    expect(h.client.snapshot().view?.turn).toBe(4);
  });
});

describe("parseServerFrame", () => {
  it("refuses a malformed frame of a type it does know", () => {
    expect(parseServerFrame(JSON.stringify({ type: "ack", nonce: 1, seq: 2 }))).toBeNull();
    expect(parseServerFrame(JSON.stringify({ type: "view" }))).toBeNull();
    expect(parseServerFrame(JSON.stringify({ type: "clock", now: 1 }))).toBeNull();
    expect(parseServerFrame("[]")).toBeNull();
  });
});

describe("remainingMs", () => {
  it("counts down against the monotonic delta, not the browser's wall clock", () => {
    const clock = {
      now: 10_000,
      receivedAt: 500,
      clocks: {
        turnDeadline: 85_000,
        promptDeadline: null,
        graceDeadline: { p1: null, p2: null },
        ceilingAt: 0,
      },
    };
    // 75 s were left when the frame was sent; 2 s of local time have passed since.
    expect(remainingMs(85_000, clock, () => 2_500)).toBe(73_000);
    expect(remainingMs(null, clock, () => 2_500)).toBeNull();
    // Never negative: an expired deadline reads as zero, not as a countdown running backwards.
    expect(remainingMs(85_000, clock, () => 500_000)).toBe(0);
  });

  it("is null before any clock frame has arrived", () => {
    expect(remainingMs(1, null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// sending
// ---------------------------------------------------------------------------------------------

describe("actions", () => {
  it("sends `{type:'action', action:{...body, nonce}}` and never a playerId", () => {
    const h = connected();
    h.client.send({ type: "play", instanceId: "c1", zone: { row: "backrow", lane: 1 } });

    const frame = h.socket().frames().at(-1) as { type: string; action: Record<string, unknown> };
    expect(frame.type).toBe("action");
    expect(frame.action.type).toBe("play");
    expect(frame.action.instanceId).toBe("c1");
    expect(frame.action.zone).toEqual({ row: "backrow", lane: 1 });
    expect(typeof frame.action.nonce).toBe("string");
    expect(frame.action).not.toHaveProperty("playerId");
  });

  it("mints a fresh nonce per action (§9.3: deduped server-side)", () => {
    const h = connected();
    h.client.send({ type: "endTurn" });
    h.client.send({ type: "endTurn" });
    const [first, second] = h
      .socket()
      .frames()
      .slice(-2)
      .map((frame) => (frame.action as { nonce: string }).nonce);
    expect(first).not.toEqual(second);
    expect(String(first).length).toBeLessThanOrEqual(128);
  });

  it("refuses out loud when the socket is not open, rather than dropping the click", () => {
    const h = harness();
    h.client.connect();
    h.client.send({ type: "endTurn" });
    expect(h.socket().sent).toEqual([]);
    expect(h.client.snapshot().error).toBe("not connected to the match");
  });
});

// ---------------------------------------------------------------------------------------------
// the socket's life
// ---------------------------------------------------------------------------------------------

describe("reconnect", () => {
  it("reopens after an unexpected close, with a backoff", () => {
    const h = connected();
    h.socket().drop(1006);
    expect(h.client.snapshot().connection).toBe("reconnecting");
    expect(h.pending()).toBe(1);

    h.runTimers();
    expect(h.sockets).toHaveLength(2);
    h.socket().open();
    expect(h.client.snapshot().connection).toBe("open");
    // A reconnected socket asks for a fresh full view (§9.5), never a log replay.
    expect(h.socket().frames()).toEqual([{ type: "hello", token: "tok", matchId: "m-1" }]);
  });

  it("does not retry a refusal: 4401/4403/4404 are settled answers", () => {
    for (const code of [4401, 4403, 4404]) {
      const h = connected();
      h.socket().drop(code, "you are not in that match");
      expect(h.client.snapshot().connection).toBe("refused");
      expect(h.client.snapshot().error).toBe("you are not in that match");
      expect(h.pending()).toBe(0);
    }
  });

  it("close() stops the reconnect and the socket", () => {
    const h = connected();
    h.client.close();
    expect(h.socket().closedWith?.code).toBe(1000);
    expect(h.client.snapshot().connection).toBe("closed");
    expect(h.pending()).toBe(0);
  });

  it("a view that arrives after close() is ignored", () => {
    const h = connected();
    const stale = h.socket();
    h.client.close();
    stale.deliver({ type: "view", view: baseView({ turn: 9 }) });
    expect(h.client.snapshot().view).toBeNull();
  });

  it("notifies subscribers on every change", () => {
    const h = connected();
    let notified = 0;
    const stop = h.client.subscribe(() => {
      notified += 1;
    });
    h.socket().deliver({ type: "view", view: baseView() });
    expect(notified).toBe(1);
    stop();
    h.socket().deliver({ type: "view", view: baseView({ turn: 5 }) });
    expect(notified).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
// the dev-handle shim
// ---------------------------------------------------------------------------------------------

describe("viewDerivedState", () => {
  const view: PlayerView = baseView({
    viewer: "p1",
    turn: 6,
    active: "p2",
    phase: "main",
    pending: { forYou: false, pendingFor: "p2" },
  });

  it("is a view-derived shim, and carries no seed", () => {
    // The server mints the seed and never sends it: (seed, log) reconstructs the library order
    // (§9.1, §9.3), which is hidden from the client by design.
    const state = viewDerivedState(view);
    expect(state.seed).toBe("");
    expect(state.turn).toBe(6);
    expect(state.active).toBe("p2");
    expect(state.phase).toBe("main");
    expect(state.result).toBeNull();
  });

  it("keys the two sides by the player they belong to", () => {
    const state = viewDerivedState(view);
    expect(state.players.p1).toBe(view.you);
    expect(state.players.p2).toBe(view.opponent);
  });

  it("reports an open prompt the way GameStateLike expects it", () => {
    expect(viewDerivedState(view).pending).toEqual({ player: "p2" });
    const mine = baseView({
      pending: {
        forYou: true,
        choiceId: "c9",
        kind: "mode",
        options: [],
        min: 1,
        max: 1,
        prompt: "Choose one",
      },
    });
    expect(viewDerivedState(mine).pending).toEqual({ choiceId: "c9", kind: "mode", player: "p1" });
  });
});
