// The networked match client: one WebSocket, the five frames `apps/server/src/match/protocol.ts`
// defines, and no rules at all.
//
// CLAUDE.md rule 7 / SPEC §9.1: "the client sends intent, never state". So this module does three
// things and nothing else — it opens the socket, it turns a `ActionBody` into an `action` frame
// with a nonce, and it hands whatever the server pushed back to the renderer. It never decides
// whether an action is legal, never computes a view, and never reads a field the server did not
// send.
//
// WHAT IS ON THE WIRE (`apps/server/src/match/protocol.ts`, BUILD M6-T4):
//
//   client -> server   hello {token?, matchId?, roomCode?}
//                      action {nonce, action: ActionBody}      (`playerId` is DISCARDED server-side)
//   server -> client   view {view: PlayerView}
//                      ack {nonce, seq}
//                      error {code, message, nonce?}
//                      prompt {forYou, pendingFor, choiceId?, kind?, deadline}
//                      clock {now, clocks: MatchClocks}
//
// THE HANDSHAKE. `apps/server/src/match/wsServer.ts` `tokenFrom` reads the bearer token from the
// `authorization` header OR from `?token=`, and the match from `?matchId=`. A browser cannot set
// headers on a WebSocket handshake, so both travel in the query string. The `hello` frame is sent
// anyway: the actor treats it as "push me a fresh full view" (§9.5: "Reconnect gets a fresh full
// view, never a log replay") and ignores every field on it, so it is how a reconnected socket asks
// for the state it missed.
//
// NO IMPORT FROM `apps/server`. `MatchClocks` is restated structurally below, the way
// `e2e/support/types.ts` restates the engine's types: the client is a separate deployable and a
// type import across that boundary would be a build-time coupling the topology (§9.2) does not
// have.
//
// THE MISSING FRAME. `apps/web/src/game/actions.ts` derives every clickable element by filtering
// the `legalActions` array (BUILD M5-T2: "The client never computes legality itself; it asks
// `legalActions` and greys out the rest"). The protocol has no frame that carries it: `view`, `ack`,
// `error`, `prompt`, `clock` and that is all. With an empty array `end-turn` renders `disabled` and
// no hand card is clickable, so a networked board can answer prompts (`Prompt.tsx` rebuilds an
// `answer` from `PendingView.options` when no array is supplied) and can do nothing else.
//
// This module does NOT close that hole by computing legality — that is exactly what rule 7 and
// M5-T2 forbid. It accepts the array from EITHER of the two shapes the server may grow, whichever
// arrives first:
//
//   1. a `legal` field riding alongside the view:  {type:"view", view, legal:[...]}
//   2. a frame of its own:                         {type:"legal", legal:[...]}
//
// and reports, in `legalSource`, that neither has ever arrived — which `routes/match.tsx` renders
// as a visible notice rather than as a silently dead board. It is an ASK on the owner of
// `protocol.ts` and `actor.ts`.

import { useEffect, useMemo, useSyncExternalStore } from "react";

import type { ActionBody, PlayerId, PlayerView, PromptKind } from "@jackioh/shared";

import { matchSocketUrl } from "../net/api.ts";

/** BUILD M5-T3: the dev handle exists only outside a production build. */
const DEV_ONLY = import.meta.env.MODE !== "production";

// ---------------------------------------------------------------------------------------------
// The wire, restated structurally (never imported from apps/server)
// ---------------------------------------------------------------------------------------------

/** `apps/server/src/api/ports.ts` `MatchClocks`. One shape, stated twice, by design (see header). */
export type MatchClocks = {
  /** Epoch ms the active player's turn clock expires, or null while it is paused. */
  turnDeadline: number | null;
  /** Epoch ms the open prompt's own clock expires (R79), or null. */
  promptDeadline: number | null;
  /** Per-player disconnect grace deadlines (§9.5). */
  graceDeadline: { p1: number | null; p2: number | null };
  /** Epoch ms the hard ceiling is reached (R79). */
  ceilingAt: number;
};

/** `PromptMessage`, split on `forYou` exactly as §10.6 splits it. */
export type PromptFrame =
  | { forYou: true; pendingFor: PlayerId; choiceId: string; kind: PromptKind; deadline: number | null }
  | { forYou: false; pendingFor: PlayerId; deadline: number | null };

/**
 * A `clock` frame plus the local monotonic reading at the moment it landed.
 *
 * `protocol.ts`: "`now` is the server's clock at send time, so the client computes remaining time
 * as `deadline - now` against its own monotonic delta instead of trusting its wall clock." That
 * delta is what `receivedAt` is for; `remainingMs` below is the only place it is applied.
 */
export type ClockReading = { now: number; clocks: MatchClocks; receivedAt: number };

/**
 * Milliseconds left on an absolute server deadline, or null when there is no deadline.
 *
 * The browser's wall clock is never consulted: the answer is `deadline - now` at the instant the
 * frame was sent, less however long this tab has been running since.
 */
export function remainingMs(
  deadline: number | null | undefined,
  clock: ClockReading | null,
  monotonic: () => number = defaultMonotonic,
): number | null {
  if (deadline === null || deadline === undefined) return null;
  if (clock === null) return null;
  const elapsed = Math.max(0, monotonic() - clock.receivedAt);
  return Math.max(0, deadline - clock.now - elapsed);
}

function defaultMonotonic(): number {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}

// ---------------------------------------------------------------------------------------------
// The socket seam
// ---------------------------------------------------------------------------------------------

/**
 * As much of `WebSocket` as this module uses. A seam, so a test can drive every frame without a
 * server and without a timer — `net.test.ts` is written against it.
 */
export type SocketLike = {
  readonly readyState: number;
  send: (data: string) => void;
  close: (code?: number, reason?: string) => void;
  onopen: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: ((event: { code: number; reason: string; wasClean: boolean }) => void) | null;
  onerror: ((event: unknown) => void) | null;
};

export type SocketFactory = (url: string) => SocketLike;

/** `WebSocket.OPEN`, spelled out so this module needs no DOM constant at runtime. */
const OPEN = 1;

function browserSocket(url: string): SocketLike {
  return new WebSocket(url) as unknown as SocketLike;
}

/**
 * The private-use close codes `apps/server/src/match/wsServer.ts` refuses with. Restated, not
 * imported (see the header). A refusal is final: retrying it would be a reconnect loop against a
 * server that has already said no.
 */
const REFUSAL_CLOSE_CODES: readonly number[] = [4401, 4403, 4404];

/** A short backoff; the last entry repeats. Spec 05 reloads the page, so a resume is a fresh boot. */
const RECONNECT_DELAYS_MS: readonly number[] = [250, 500, 1000, 2000, 5000];

export type Timers = {
  setTimeout: (handler: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};

const defaultTimers: Timers = {
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

// ---------------------------------------------------------------------------------------------
// Frame parsing: total, never throws, keeps only what the protocol declares
// ---------------------------------------------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isString = (value: unknown): value is string => typeof value === "string";

const isNumberOrNull = (value: unknown): value is number | null =>
  value === null || typeof value === "number";

/**
 * An `ActionBody[]` off the wire.
 *
 * Deliberately shallow: the client does not re-derive what a legal action may contain — that is the
 * engine's business (§9.3) and a stricter check here would be a second, weaker copy of the action
 * union. Anything that is not an object with a string `type` is dropped, because `actions.ts`
 * indexes on `type` and a malformed entry would break the board rather than the rules.
 */
function parseLegal(value: unknown): readonly ActionBody[] | null {
  if (!Array.isArray(value)) return null;
  const out: ActionBody[] = [];
  for (const entry of value) {
    if (isRecord(entry) && isString(entry.type)) out.push(entry as unknown as ActionBody);
  }
  return out;
}

function parseClocks(value: unknown): MatchClocks | null {
  if (!isRecord(value)) return null;
  const grace = value.graceDeadline;
  if (!isRecord(grace)) return null;
  if (!isNumberOrNull(value.turnDeadline) || !isNumberOrNull(value.promptDeadline)) return null;
  if (!isNumberOrNull(grace.p1) || !isNumberOrNull(grace.p2)) return null;
  if (typeof value.ceilingAt !== "number") return null;
  return {
    turnDeadline: value.turnDeadline,
    promptDeadline: value.promptDeadline,
    graceDeadline: { p1: grace.p1, p2: grace.p2 },
    ceilingAt: value.ceilingAt,
  };
}

/** Every server frame this client understands, after parsing. */
export type ServerFrame =
  | { type: "view"; view: PlayerView; legal: readonly ActionBody[] | null }
  | { type: "legal"; legal: readonly ActionBody[] }
  | { type: "ack"; nonce: string; seq: number }
  | { type: "error"; code: string; message: string; nonce?: string }
  | { type: "prompt"; prompt: PromptFrame }
  | { type: "clock"; now: number; clocks: MatchClocks };

/**
 * Parse one text frame. Returns null for anything this client does not understand, which is not an
 * error: the protocol may grow a frame before this file learns it, and an unknown frame must not
 * take the board down.
 */
export function parseServerFrame(text: string): ServerFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !isString(parsed.type)) return null;

  switch (parsed.type) {
    case "view": {
      // §10.8: the payload is one `PlayerView`. It is the server's to shape; the client renders it
      // and does not second-guess its fields, so only its presence is checked here.
      if (!isRecord(parsed.view)) return null;
      return {
        type: "view",
        view: parsed.view as unknown as PlayerView,
        // Shape 1 of the missing-frame ask (see the header): `legal` riding alongside the view.
        legal: parsed.legal === undefined ? null : parseLegal(parsed.legal),
      };
    }
    case "legal": {
      // Shape 2 of the missing-frame ask: a frame of its own.
      const legal = parseLegal(parsed.legal);
      return legal === null ? null : { type: "legal", legal };
    }
    case "ack": {
      if (!isString(parsed.nonce) || typeof parsed.seq !== "number") return null;
      return { type: "ack", nonce: parsed.nonce, seq: parsed.seq };
    }
    case "error": {
      if (!isString(parsed.code) || !isString(parsed.message)) return null;
      return {
        type: "error",
        code: parsed.code,
        message: parsed.message,
        ...(isString(parsed.nonce) ? { nonce: parsed.nonce } : {}),
      };
    }
    case "prompt": {
      const pendingFor = parsed.pendingFor;
      if (pendingFor !== "p1" && pendingFor !== "p2") return null;
      const deadline = isNumberOrNull(parsed.deadline) ? parsed.deadline : null;
      if (parsed.forYou === true) {
        if (!isString(parsed.choiceId) || !isString(parsed.kind)) return null;
        return {
          type: "prompt",
          prompt: {
            forYou: true,
            pendingFor,
            choiceId: parsed.choiceId,
            kind: parsed.kind as PromptKind,
            deadline,
          },
        };
      }
      return { type: "prompt", prompt: { forYou: false, pendingFor, deadline } };
    }
    case "clock": {
      const clocks = parseClocks(parsed.clocks);
      if (clocks === null || typeof parsed.now !== "number") return null;
      return { type: "clock", now: parsed.now, clocks };
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Nonces (SPEC §9.3: "every action carries a client nonce, deduped server-side")
// ---------------------------------------------------------------------------------------------

let nonceCounter = 0;

/** Unique within a tab and across reconnects; well under `MAX_NONCE_LENGTH` (128). */
export function nextNonce(): string {
  nonceCounter += 1;
  const random = Math.random().toString(36).slice(2, 10);
  return `c${Date.now().toString(36)}-${String(nonceCounter)}-${random}`;
}

// ---------------------------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------------------------

export type ConnectionState =
  /** A socket is being opened, or a backoff is waiting to open one. */
  | "connecting"
  /** The socket is open and `hello` has been sent. */
  | "open"
  /** The socket dropped and a reconnect is pending. */
  | "reconnecting"
  /** The server refused this socket (4401/4403/4404); no reconnect will be attempted. */
  | "refused"
  /** `close()` was called. */
  | "closed";

/**
 * Where the `legalActions` array came from. `"none"` is the state the missing frame leaves the
 * board in, and `routes/match.tsx` renders it as a visible notice.
 */
export type LegalSource = "none" | "view" | "frame";

export type MatchSnapshot = {
  connection: ConnectionState;
  /** The last `PlayerView` pushed, or null before the first one. */
  view: PlayerView | null;
  /** Empty until a server sends one; NEVER computed here (rule 7, BUILD M5-T2). */
  legal: readonly ActionBody[];
  legalSource: LegalSource;
  /** The last `error` frame's message, relayed verbatim (§9.3), or null. */
  error: string | null;
  /** The last `error` frame's code, for a caller that wants to branch without parsing prose. */
  errorCode: string | null;
  /** The last `clock` frame with the monotonic reading it landed at. */
  clock: ClockReading | null;
  /** The last `prompt` frame. The board renders `view.pending`; this carries R79's deadline. */
  prompt: PromptFrame | null;
  /** The last `ack`: the nonce the actor accepted and the log seq it wrote it at. */
  ack: { nonce: string; seq: number } | null;
};

export type MatchClient = {
  subscribe: (listener: () => void) => () => void;
  snapshot: () => MatchSnapshot;
  /** Open the socket (idempotent while one is open or pending). */
  connect: () => void;
  /** Send one action. The nonce is minted here; `playerId` is never sent (the actor stamps it). */
  send: (body: ActionBody) => void;
  /** Close for good: no reconnect until `connect()` is called again. */
  close: () => void;
  /** The URL the next socket will open, for a diagnostic panel. */
  url: () => string;
};

export type MatchClientOptions = {
  matchId: string;
  token: string;
  /** Defaults to `matchSocketUrl()` (`apps/web/src/net/api.ts`). */
  baseUrl?: string;
  /** Test seam. Defaults to the browser's `WebSocket`. */
  socketFactory?: SocketFactory;
  /** Test seam. Defaults to `setTimeout` / `clearTimeout`. */
  timers?: Timers;
  /** Test seam for the monotonic reading stamped on every `clock` frame. */
  monotonic?: () => number;
};

const EMPTY_LEGAL: readonly ActionBody[] = [];

const INITIAL: MatchSnapshot = {
  connection: "connecting",
  view: null,
  legal: EMPTY_LEGAL,
  legalSource: "none",
  error: null,
  errorCode: null,
  clock: null,
  prompt: null,
  ack: null,
};

/**
 * `?token=` and `?matchId=` on the handshake, because a browser cannot set an `authorization`
 * header on one (`wsServer.ts` `tokenFrom` reads either).
 */
export function socketUrlFor(baseUrl: string, token: string, matchId: string): string {
  try {
    const url = new URL(baseUrl);
    url.searchParams.set("token", token);
    url.searchParams.set("matchId", matchId);
    return url.toString();
  } catch {
    // A base the URL parser will not take (a relative path in a test, say): fall back to a plain
    // query string rather than failing to connect.
    const separator = baseUrl.includes("?") ? "&" : "?";
    return `${baseUrl}${separator}token=${encodeURIComponent(token)}&matchId=${encodeURIComponent(matchId)}`;
  }
}

export function createMatchClient(options: MatchClientOptions): MatchClient {
  const factory = options.socketFactory ?? browserSocket;
  const timers = options.timers ?? defaultTimers;
  const monotonic = options.monotonic ?? defaultMonotonic;
  const base = options.baseUrl ?? matchSocketUrl();
  const url = socketUrlFor(base, options.token, options.matchId);

  const listeners = new Set<() => void>();
  let snapshot: MatchSnapshot = INITIAL;
  let socket: SocketLike | null = null;
  let retry = 0;
  let pendingRetry: unknown = null;
  /** Set by `close()`; cleared by `connect()`. Keeps a deliberate close from reconnecting. */
  let stopped = false;

  function emit(): void {
    for (const listener of [...listeners]) listener();
  }

  function patch(next: Partial<MatchSnapshot>): void {
    snapshot = { ...snapshot, ...next };
    emit();
  }

  function cancelRetry(): void {
    if (pendingRetry === null) return;
    timers.clearTimeout(pendingRetry);
    pendingRetry = null;
  }

  function scheduleRetry(): void {
    if (stopped || pendingRetry !== null) return;
    const delay = RECONNECT_DELAYS_MS[Math.min(retry, RECONNECT_DELAYS_MS.length - 1)] ?? 5000;
    retry += 1;
    pendingRetry = timers.setTimeout(() => {
      pendingRetry = null;
      open();
    }, delay);
  }

  function handleFrame(frame: ServerFrame): void {
    switch (frame.type) {
      case "view":
        patch({
          view: frame.view,
          // A view that carries no `legal` leaves the previous array alone: the missing-frame ask
          // means most servers send none at all, and dropping it here would blank a board that a
          // separate `legal` frame had just filled.
          ...(frame.legal === null ? {} : { legal: frame.legal, legalSource: "view" as const }),
        });
        return;
      case "legal":
        patch({ legal: frame.legal, legalSource: "frame" });
        return;
      case "ack":
        // The action landed, so whatever refusal was on screen belongs to an older one.
        patch({ ack: { nonce: frame.nonce, seq: frame.seq }, error: null, errorCode: null });
        return;
      case "error":
        // §9.3: the reducer's reason, relayed verbatim. Never reworded, never re-derived.
        patch({ error: frame.message, errorCode: frame.code });
        return;
      case "prompt":
        patch({ prompt: frame.prompt });
        return;
      case "clock":
        patch({ clock: { now: frame.now, clocks: frame.clocks, receivedAt: monotonic() } });
        return;
    }
  }

  function open(): void {
    if (stopped || socket !== null) return;

    let created: SocketLike;
    try {
      created = factory(url);
    } catch (cause) {
      patch({
        connection: "reconnecting",
        error: cause instanceof Error ? cause.message : String(cause),
        errorCode: "transport",
      });
      scheduleRetry();
      return;
    }
    socket = created;
    if (snapshot.connection !== "reconnecting") patch({ connection: "connecting" });

    created.onopen = () => {
      if (socket !== created) return;
      retry = 0;
      patch({ connection: "open" });
      // §9.5: the actor reads `hello` as "push me a fresh full view", which is what a reconnected
      // socket needs and what a first socket gets anyway.
      try {
        created.send(JSON.stringify({ type: "hello", token: options.token, matchId: options.matchId }));
      } catch {
        // The peer went away between `onopen` and here; `onclose` is about to run.
      }
    };

    created.onmessage = (event) => {
      if (socket !== created) return;
      if (typeof event.data !== "string") return; // Text frames only (`socketFromWs`).
      const frame = parseServerFrame(event.data);
      if (frame !== null) handleFrame(frame);
    };

    created.onerror = () => {
      // A transport error is a disconnect; `onclose` follows and owns the decision.
    };

    created.onclose = (event) => {
      if (socket !== created) return;
      socket = null;
      if (stopped) {
        patch({ connection: "closed" });
        return;
      }
      if (REFUSAL_CLOSE_CODES.includes(event.code)) {
        // The upgrade said no (not signed in, not this match, no such match). Retrying would be a
        // loop against a settled answer.
        patch({
          connection: "refused",
          error: event.reason.length > 0 ? event.reason : "the server refused this match socket",
          errorCode: "forbidden",
        });
        return;
      }
      patch({ connection: "reconnecting" });
      scheduleRetry();
    };
  }

  return {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    snapshot: () => snapshot,
    connect: () => {
      stopped = false;
      open();
    },
    send: (body) => {
      const live = socket;
      if (live === null || live.readyState !== OPEN) {
        // Honest refusal rather than a silent drop: the click did not reach the actor, and a
        // queue flushed after a reconnect would replay an intent formed against an older view.
        patch({ error: "not connected to the match", errorCode: "offline" });
        return;
      }
      // `parseClientMessage` takes the nonce on the action or at top level and rebuilds the body
      // field by field, discarding `playerId` — so none is sent. The actor stamps the seat.
      const frame = JSON.stringify({ type: "action", action: { ...body, nonce: nextNonce() } });
      patch({ error: null, errorCode: null });
      try {
        live.send(frame);
      } catch (cause) {
        patch({ error: cause instanceof Error ? cause.message : String(cause), errorCode: "transport" });
      }
    },
    close: () => {
      stopped = true;
      cancelRetry();
      const live = socket;
      socket = null;
      if (live !== null) {
        live.onopen = null;
        live.onmessage = null;
        live.onerror = null;
        live.onclose = null;
        try {
          live.close(1000, "leaving the match");
        } catch {
          // Already gone.
        }
      }
      patch({ connection: "closed" });
    },
    url: () => url,
  };
}

// ---------------------------------------------------------------------------------------------
// The dev handle (BUILD M5-T3, consumed by e2e/support/commands.ts)
// ---------------------------------------------------------------------------------------------

/**
 * THIS IS NOT A `GameState`.
 *
 * `e2e/support/types.ts` declares `window.__jackioh = { state, dispatch, seed, seat }` and cites
 * this file for `seat`: "Present in networked mode (apps/web/src/game/net.ts) when the route is not
 * hotseat." But a networked client HAS no `GameState` and must not have one — SPEC §9.1 lists the
 * library order, the opponent's hand, the face-down traps and the other player's pending options as
 * hidden, and the client only ever receives `viewFor(state, playerId)`. Handing the harness a real
 * state would mean the server had leaked it.
 *
 * So `state` is a SHIM derived from the `PlayerView` on screen: the six fields
 * `GameStateLike` names, and nothing under them that the view did not already contain. Concretely:
 *
 *  - `seed` is EMPTY. The server mints the match seed and never sends it, and it must not: with
 *    the seed and the log a client could reconstruct the library order (§9.3: "(seed, log)
 *    reconstructs any match"). `cy.seedGame` reads `handle.seed`, and `cy.seedGame` is the hotseat
 *    route's command; specs 05 and 06 never read it.
 *  - `players[p]` is that player's `SideView`, not a `PlayerState`. `cy.instanceInHand` and
 *    `cy.instanceAt` read `.id` off it and a `SideView` spells it `instanceId`, so those two
 *    commands do not work against this shim. Specs 05 and 06 do not call them.
 *  - there is no `log` and no `decks` (ASSUMPTION A2): the client is not told the action log, and
 *    only spec 01 — hotseat — needs them.
 *
 * `cy.jackioh()` only asserts the object exists, which is what specs 05 and 06 need it for.
 */
export type ViewDerivedState = {
  seed: string;
  turn: number;
  active: PlayerId;
  phase: PlayerView["phase"];
  result: PlayerView["result"];
  pending: { choiceId?: string; kind?: PromptKind; player?: PlayerId } | null;
  players: Record<PlayerId, unknown>;
};

export function viewDerivedState(view: PlayerView): ViewDerivedState {
  const players: Record<PlayerId, unknown> = { p1: null, p2: null };
  players[view.you.player] = view.you;
  players[view.opponent.player] = view.opponent;

  const pending =
    view.pending === null
      ? null
      : view.pending.forYou
        ? { choiceId: view.pending.choiceId, kind: view.pending.kind, player: view.viewer }
        : { player: view.pending.pendingFor };

  return {
    // See the doc above: a networked client is not given the seed and must not be.
    seed: "",
    turn: view.turn,
    active: view.active,
    phase: view.phase,
    result: view.result,
    pending,
    players,
  };
}

export type NetDevHandle = {
  readonly state: ViewDerivedState | null;
  readonly seed: string;
  readonly seat: PlayerId | null;
  dispatch: (action: ActionBody & { playerId?: PlayerId }) => void;
};

/** `window.__jackioh` is declared by `routes/dev/hotseat.tsx` as its own handle; this is the other. */
type DevWindow = { __jackioh?: unknown };

/**
 * Publish the handle outside production builds. Returns the teardown, so a route can install it in
 * an effect and take it down again without clobbering the hotseat route's.
 */
export function installDevHandle(handle: NetDevHandle): () => void {
  if (!DEV_ONLY || typeof window === "undefined") return () => {};
  const host = window as unknown as DevWindow;
  host.__jackioh = handle;
  return () => {
    if (host.__jackioh === handle) delete host.__jackioh;
  };
}

// ---------------------------------------------------------------------------------------------
// The hook
// ---------------------------------------------------------------------------------------------

export type UseMatchOptions = {
  matchId: string;
  token: string;
  baseUrl?: string;
  socketFactory?: SocketFactory;
  timers?: Timers;
  monotonic?: () => number;
};

export type UseMatchResult = MatchSnapshot & {
  /** Send one action to the actor. */
  send: (body: ActionBody) => void;
  /** The handshake URL, for the diagnostic line on the match route. */
  url: string;
};

/**
 * One socket per (matchId, token), opened on mount and closed on unmount. The snapshot is external
 * mutable state, so it is read through `useSyncExternalStore` rather than mirrored into React state.
 */
export function useMatch(options: UseMatchOptions): UseMatchResult {
  const { matchId, token, baseUrl, socketFactory, timers, monotonic } = options;

  const client = useMemo(
    () =>
      createMatchClient({
        matchId,
        token,
        ...(baseUrl === undefined ? {} : { baseUrl }),
        ...(socketFactory === undefined ? {} : { socketFactory }),
        ...(timers === undefined ? {} : { timers }),
        ...(monotonic === undefined ? {} : { monotonic }),
      }),
    [matchId, token, baseUrl, socketFactory, timers, monotonic],
  );

  useEffect(() => {
    client.connect();
    return () => {
      client.close();
    };
  }, [client]);

  const snapshot = useSyncExternalStore(client.subscribe, client.snapshot, client.snapshot);

  return { ...snapshot, send: client.send, url: client.url() };
}
