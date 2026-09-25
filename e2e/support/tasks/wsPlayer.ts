// `cy.task("wsPlayer", …)`: the second player of a networked match, driven from Node.
//
// BUILD M6 gate and spec 06 require it ("the second player driven by a Node WebSocket client via
// cy.task"). One socket per named player, held across tasks for the length of the spec file.
//
// PROTOCOL. BUILD M6-T4 fixes the message names and `apps/server/src/match/protocol.ts` now fixes
// every shape, so this is read off that file rather than assumed (e2e/README.md A8):
//
//   -> { type: "hello", token?, matchId?, roomCode? }   (the actor ignores every field: it means
//                                                        "push me a fresh full view", §9.5)
//   -> { type: "action", action: { ...ActionBody, nonce } }
//   <- { type: "view", view: PlayerView }               (pushed after every change, SPEC §10.8)
//   <- { type: "ack", nonce, seq }                      (nonce dedupe + the log seq, SPEC §9.3)
//   <- { type: "error", code, message, nonce? }         (`nonce` only when an action failed)
//   <- { type: "prompt", forYou, … }                    (recorded, not interpreted; §10.6)
//   <- { type: "clock", now, clocks }                   (R79 deadlines, §9.5)
//
// TWO THINGS THIS CLIENT DELIBERATELY DOES NOT DO.
//
//  - It never sends `joinRoom`. `protocol.ts` accepts that frame only so a client which speaks it
//    gets `error { code: "unsupported" }` instead of "malformed": joining is
//    `POST /api/rooms/:code/join`, because the atomic single-claim and the loadout re-check are
//    HTTP concerns and a socket is only ever opened onto a match that already exists. Specs 05 and
//    06 claim a room with `cy.request` and open the socket on the match id they get back.
//  - It does not trust its own `playerId`. `parseClientMessage` rebuilds the action body field by
//    field and discards `playerId`; the actor stamps the authenticated seat. `seat` below is only
//    used to fill the field the frozen specs put on the wire, and to label the result.
//
// The socket's query string carries `token` and `matchId` only — the two things
// `apps/server/src/match/wsServer.ts` reads at the upgrade.
//
// If the server team lands other shapes, only this file changes.

import { WebSocket } from "ws";

export type WsMessage = { type: string; [key: string]: unknown };

type Waiter = { match: (message: WsMessage) => boolean; resolve: (message: WsMessage) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

type Client = {
  name: string;
  socket: WebSocket;
  seat: "p1" | "p2";
  messages: WsMessage[];
  lastView: Record<string, unknown> | null;
  waiters: Waiter[];
  nonce: number;
  /** The match this socket was opened onto, for the leave-nothing-behind concede below. */
  matchId: string | null;
};

export type WsPlayerCommand =
  | { action: "connect"; name: string; url?: string; token?: string; matchId?: string; roomCode?: string; seat?: "p1" | "p2" }
  | { action: "send"; name: string; body: Record<string, unknown> }
  | { action: "awaitView"; name: string; where?: ViewPredicate }
  | { action: "view"; name: string }
  | { action: "messages"; name: string }
  | { action: "disconnect"; name: string }
  | { action: "concede"; name: string; url?: string; token: string; matchId: string; seat?: "p1" | "p2" }
  | { action: "reset" };

export type ViewPredicate = {
  active?: string;
  phase?: string;
  promptKind?: string;
  hasResult?: boolean;
  turnAtLeast?: number;
  /** R265, R266: `view.mulligan.opponentReady`; a view outside the mulligan window never matches. */
  mulliganOpponentReady?: boolean;
  /** R269: `view.drawOffer.by`, or `null` for "no offer stands". */
  drawOfferBy?: string | null;
};

export type WsPlayerResult = {
  ok: boolean;
  name?: string;
  seat?: string;
  view?: Record<string, unknown> | null;
  messages?: WsMessage[];
  /** §9.3: the reducer's reason, relayed verbatim — never restated. */
  error?: string;
  /** The `SocketErrorCode` that came with it (`illegal_action`, `rate_limited`, …). */
  code?: string;
  /** §9.3: the append-only log seq an accepted action was written at (`ack.seq`). */
  seq?: number;
};

const TIMEOUT_MS = 15_000;
const clients = new Map<string, Client>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function deliver(client: Client, message: WsMessage): void {
  client.messages.push(message);
  if (message.type === "view" && isRecord(message.view)) client.lastView = message.view;
  for (const waiter of [...client.waiters]) {
    if (!waiter.match(message)) continue;
    clearTimeout(waiter.timer);
    client.waiters = client.waiters.filter((other) => other !== waiter);
    waiter.resolve(message);
  }
}

function waitFor(client: Client, match: (message: WsMessage) => boolean, what: string): Promise<WsMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      client.waiters = client.waiters.filter((waiter) => waiter.timer !== timer);
      const seen = client.messages.map((message) => message.type).join(", ");
      reject(new Error(`wsPlayer(${client.name}): timed out waiting for ${what}; saw [${seen}]`));
    }, TIMEOUT_MS);
    client.waiters.push({ match, resolve, reject, timer });
  });
}

function matchesView(view: Record<string, unknown>, where: ViewPredicate): boolean {
  if (where.active !== undefined && view.active !== where.active) return false;
  if (where.phase !== undefined && view.phase !== where.phase) return false;
  if (where.hasResult !== undefined && (view.result !== null && view.result !== undefined) !== where.hasResult) return false;
  if (where.turnAtLeast !== undefined && !(typeof view.turn === "number" && view.turn >= where.turnAtLeast)) return false;
  if (where.mulliganOpponentReady !== undefined) {
    const mulligan = isRecord(view.mulligan) ? view.mulligan : null;
    if (mulligan === null || mulligan.opponentReady !== where.mulliganOpponentReady) return false;
  }
  if (where.drawOfferBy !== undefined) {
    const by = isRecord(view.drawOffer) && typeof view.drawOffer.by === "string" ? view.drawOffer.by : null;
    if (by !== where.drawOfferBy) return false;
  }
  if (where.promptKind !== undefined) {
    // §10.6, §10.8: `PendingView` is split on `forYou`, and the player who does NOT hold the
    // prompt gets `{ forYou: false, pendingFor }` — no kind, no options. So a `promptKind`
    // predicate is satisfied only by a prompt this client itself has to answer.
    const pending = isRecord(view.pending) ? view.pending : null;
    if (pending === null || pending.forYou !== true || pending.kind !== where.promptKind) return false;
  }
  return true;
}

function client(name: string): Client {
  const found = clients.get(name);
  if (found === undefined) throw new Error(`wsPlayer: no client named "${name}"; connect first`);
  return found;
}

async function connect(command: Extract<WsPlayerCommand, { action: "connect" }>): Promise<WsPlayerResult> {
  const existing = clients.get(command.name);
  if (existing !== undefined) existing.socket.close();

  // `WS_PATH` in apps/server/src/match/wsServer.ts. A handshake off this path is left alone by
  // `attachWebSocketServer`, so a wrong path never reaches the upgrade at all.
  const base = command.url ?? "ws://localhost:8787/ws/match";
  const url = new URL(base);
  // `tokenFrom` reads `?token=` (a browser cannot set a handshake header) and the upgrade reads
  // `?matchId=`. Nothing else in the query string is looked at, so nothing else is put there.
  if (command.token !== undefined) url.searchParams.set("token", command.token);
  if (command.matchId !== undefined) url.searchParams.set("matchId", command.matchId);

  const socket = new WebSocket(url.toString());
  const record: Client = {
    name: command.name,
    socket,
    seat: command.seat ?? "p2",
    messages: [],
    lastView: null,
    waiters: [],
    nonce: 0,
    matchId: command.matchId ?? null,
  };
  clients.set(command.name, record);

  socket.on("message", (data) => {
    const text = typeof data === "string" ? data : data.toString();
    try {
      const parsed: unknown = JSON.parse(text);
      deliver(record, isRecord(parsed) && typeof parsed.type === "string" ? (parsed as WsMessage) : { type: "unknown", raw: text });
    } catch {
      deliver(record, { type: "unparsed", raw: text });
    }
  });

  // A refusal closes the socket (`WS_CLOSE` 4401/4403/4404 in wsServer.ts mirror the HTTP
  // statuses), and so does the actor's `stop()`. Waking every waiter here turns what would be a
  // 15-second timeout into the close code that caused it.
  socket.on("close", (code: number, reason: Buffer) => {
    const why = reason.length > 0 ? `: ${reason.toString()}` : "";
    for (const waiter of record.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error(`wsPlayer(${command.name}): the socket closed (${String(code)}${why})`));
    }
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`wsPlayer(${command.name}): no open on ${url.toString()}`)), TIMEOUT_MS);
    socket.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error instanceof Error ? error : new Error(String(error)));
    });
  });

  const hello: WsMessage = { type: "hello" };
  if (command.token !== undefined) hello.token = command.token;
  if (command.matchId !== undefined) hello.matchId = command.matchId;
  if (command.roomCode !== undefined) hello.roomCode = command.roomCode;
  socket.send(JSON.stringify(hello));

  // `attach` already pushes a view and a clock, and `hello` asks for another (§9.5: "Reconnect
  // gets a fresh full view, never a log replay"), so the first view may well pre-date the hello.
  // Either way it is the full view this seat is entitled to.
  //
  // A refused upgrade answers `error { code: "forbidden" }` and closes, so that is matched too:
  // failing with the server's own words beats timing out for 15 s on a view that cannot come.
  const first = await waitFor(
    record,
    (message) => message.type === "view" || message.type === "error",
    "the first view push",
  );
  if (first.type === "error") {
    return { ok: false, name: command.name, ...errorOf(first) };
  }
  return { ok: true, name: command.name, seat: record.seat, view: isRecord(first.view) ? first.view : null };
}

/**
 * §9.3: "`reduce` refuses illegal actions itself and returns the reason", and `protocol.ts` relays
 * that reason verbatim. An `ErrorMessage` is `{ type, code, message, nonce? }` — there is no
 * `error` field on it — so the reason is `message` and nothing here rewords it.
 */
function errorOf(message: WsMessage): { error: string; code?: string } {
  const code = typeof message.code === "string" ? message.code : undefined;
  const text = typeof message.message === "string" ? message.message : "";
  return {
    error: text.length > 0 ? text : (code ?? "the server refused it without saying why"),
    ...(code === undefined ? {} : { code }),
  };
}

async function send(command: Extract<WsPlayerCommand, { action: "send" }>): Promise<WsPlayerResult> {
  const record = client(command.name);
  record.nonce += 1;
  const nonce = `${command.name}-${record.nonce}`;
  // `playerId` is discarded by `parseClientMessage`; the actor stamps the authenticated seat. It
  // rides along because the frozen specs put it on the body, not because the server reads it.
  const action = { playerId: record.seat, ...command.body, nonce };
  record.socket.send(JSON.stringify({ type: "action", action }));
  const reply = await waitFor(
    record,
    (message) =>
      (message.type === "ack" && message.nonce === nonce) ||
      // Every refusal that belongs to an action carries that action's nonce (`applyAction`,
      // `rate_limited`, `match_over`). A `malformed` frame error carries none, and is the reply to
      // the frame just sent, so it counts too — but an error stamped with someone else's nonce
      // never does.
      (message.type === "error" && (message.nonce === undefined || message.nonce === nonce)),
    `an ack for ${String(command.body.type)} (${nonce})`,
  );
  if (reply.type === "error") {
    return { ok: false, name: command.name, ...errorOf(reply), view: record.lastView };
  }
  return {
    ok: true,
    name: command.name,
    view: record.lastView,
    ...(typeof reply.seq === "number" ? { seq: reply.seq } : {}),
  };
}

async function awaitView(command: Extract<WsPlayerCommand, { action: "awaitView" }>): Promise<WsPlayerResult> {
  const record = client(command.name);
  const where = command.where ?? {};
  if (record.lastView !== null && matchesView(record.lastView, where)) {
    return { ok: true, name: command.name, view: record.lastView };
  }
  const message = await waitFor(
    record,
    (msg) => msg.type === "view" && isRecord(msg.view) && matchesView(msg.view, where),
    `a view matching ${JSON.stringify(where)}`,
  );
  return { ok: true, name: command.name, view: isRecord(message.view) ? message.view : null };
}

/**
 * Leave no live match behind when a spec file ends.
 *
 * A profile with `inMatchId` set is refused by `POST /api/rooms`, `POST /api/rooms/:code/join` and
 * `POST /api/queue` alike — all three answer `409 already_in_match`
 * (`apps/server/src/match/rooms.ts`, `apps/server/src/api/queue.ts`). Spec 05 ends with its match
 * still running, on purpose: the point of that spec is that the prompt rebuilt after the reload is
 * live state, so it answers the prompt and stops. Spec 06 is next in the alphabetical order Cypress
 * runs, and its first server call is `POST /api/rooms` as the same account — so without this the
 * suite passes spec by spec and fails as a suite, which is the shape the M8 gate is run in.
 *
 * §2.5 already gives a player a way out of a match, so nothing new is invented here: this sends the
 * `concede` the protocol already carries, and §9.5's "every ending records a result and clears both
 * players' in-match state" does the rest for BOTH seats. It is best-effort by design — a match that
 * is already over answers `match_over` and a closed socket answers nothing, and neither is a
 * failure worth taking a spec file down for.
 */
async function concedeIfLive(record: Client): Promise<void> {
  if (record.matchId === null) return;
  if (record.socket.readyState !== WebSocket.OPEN) return;
  // `result` is non-null once the match has ended (§10.8), so there is nothing to concede. A view
  // that never arrived is not evidence of an ended match, so that case still concedes: the cost of
  // a redundant concede is one `match_over` error nobody reads.
  const view = record.lastView;
  if (view !== null && view.result !== null && view.result !== undefined) return;
  try {
    await send({ action: "send", name: record.name, body: { type: "concede" } });
  } catch {
    // The socket went away, the actor had already stopped, or the match was over after all.
  }
}

/**
 * Open a socket onto a match as `token`, concede it and close again, in ONE task.
 *
 * This is how a spec (or `cy.freeAccount`) takes a seat out of a match that seat's own BROWSER is
 * also attached to. The actor keeps one socket per seat and closes the older one when a second
 * attaches (`attach` in apps/server/src/match/actor.ts), and the browser reconnects after
 * `RECONNECT_DELAYS_MS[0]` (apps/web/src/game/net.ts), which would take the seat straight back.
 * Doing connect and concede as two Cypress commands leaves a Cypress round trip inside that window;
 * doing both here leaves only the socket's own. The ack of a concede is sent after the actor has
 * recorded the result (`applyAction` awaits `afterChange`), so once this answers the profile is out
 * of the match and a series has moved on. A match already over answers `match_over`, which is
 * reported rather than thrown.
 */
async function concede(command: Extract<WsPlayerCommand, { action: "concede" }>): Promise<WsPlayerResult> {
  try {
    const opened = await connect({
      action: "connect",
      name: command.name,
      token: command.token,
      matchId: command.matchId,
      ...(command.url === undefined ? {} : { url: command.url }),
      ...(command.seat === undefined ? {} : { seat: command.seat }),
    });
    if (!opened.ok) return opened;
    const view = opened.view ?? null;
    if (view !== null && view.result !== null && view.result !== undefined) {
      return { ok: true, name: command.name, view };
    }
    return await send({ action: "send", name: command.name, body: { type: "concede" } });
  } finally {
    const record = clients.get(command.name);
    if (record !== undefined) {
      record.socket.close();
      clients.delete(command.name);
    }
  }
}

export async function wsPlayer(command: WsPlayerCommand): Promise<WsPlayerResult> {
  try {
    switch (command.action) {
      case "connect":
        return await connect(command);
      case "send":
        return await send(command);
      case "awaitView":
        return await awaitView(command);
      case "view":
        return { ok: true, name: command.name, view: client(command.name).lastView };
      case "messages":
        return { ok: true, name: command.name, messages: client(command.name).messages };
      case "disconnect": {
        const record = client(command.name);
        // A deliberate disconnect is what spec 05 uses to model a dropped player, so it must NOT
        // concede: the grace countdown is the thing under test. Only `reset` cleans up.
        record.socket.close();
        clients.delete(command.name);
        return { ok: true, name: command.name };
      }
      case "concede":
        return await concede(command);
      case "reset": {
        for (const record of clients.values()) await concedeIfLive(record);
        for (const record of clients.values()) record.socket.close();
        clients.clear();
        return { ok: true };
      }
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
