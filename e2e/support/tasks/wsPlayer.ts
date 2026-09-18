// `cy.task("wsPlayer", …)`: the second player of a networked match, driven from Node.
//
// BUILD M6 gate and spec 06 require it ("the second player driven by a Node WebSocket client via
// cy.task"). One socket per named player, held across tasks for the length of the spec file.
//
// PROTOCOL (ASSUMPTION A8). BUILD M6-T4 fixes only the message names in
// `apps/server/src/match/protocol.ts`: hello, view, action, ack, error, prompt, clock. This client
// therefore speaks:
//
//   -> { type: "hello", token, matchId?, roomCode? }
//   -> { type: "joinRoom", token, roomCode }
//   -> { type: "action", action: { ...ActionBody, playerId, nonce } }
//   <- { type: "view", view: PlayerView }      (pushed after every change, SPEC §10.8)
//   <- { type: "ack", nonce }                  (nonce dedupe, SPEC §9.3)
//   <- { type: "error", error }
//   <- { type: "prompt" | "clock", … }         (recorded, not interpreted)
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
};

export type WsPlayerCommand =
  | { action: "connect"; name: string; url?: string; token?: string; matchId?: string; roomCode?: string; seat?: "p1" | "p2" }
  | { action: "joinRoom"; name: string; roomCode: string; token?: string }
  | { action: "send"; name: string; body: Record<string, unknown> }
  | { action: "awaitView"; name: string; where?: ViewPredicate }
  | { action: "view"; name: string }
  | { action: "messages"; name: string }
  | { action: "disconnect"; name: string }
  | { action: "reset" };

export type ViewPredicate = {
  active?: string;
  phase?: string;
  promptKind?: string;
  hasResult?: boolean;
  turnAtLeast?: number;
};

export type WsPlayerResult = {
  ok: boolean;
  name?: string;
  seat?: string;
  view?: Record<string, unknown> | null;
  messages?: WsMessage[];
  error?: string;
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
  if (where.promptKind !== undefined) {
    const pending = isRecord(view.pending) ? view.pending : null;
    if (pending === null || pending.kind !== where.promptKind) return false;
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

  const base = command.url ?? "ws://localhost:8787/match";
  const url = new URL(base);
  if (command.token !== undefined) url.searchParams.set("token", command.token);
  if (command.matchId !== undefined) url.searchParams.set("matchId", command.matchId);
  if (command.roomCode !== undefined) url.searchParams.set("code", command.roomCode);

  const socket = new WebSocket(url.toString());
  const record: Client = {
    name: command.name,
    socket,
    seat: command.seat ?? "p2",
    messages: [],
    lastView: null,
    waiters: [],
    nonce: 0,
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

  // The actor answers `hello` with the first `viewFor` push (SPEC §9.6 reconnect: "a fresh full
  // view, never a log replay").
  const first = await waitFor(record, (message) => message.type === "view", "the first view push");
  return { ok: true, name: command.name, seat: record.seat, view: isRecord(first.view) ? first.view : null };
}

async function joinRoom(command: Extract<WsPlayerCommand, { action: "joinRoom" }>): Promise<WsPlayerResult> {
  const record = client(command.name);
  const message: WsMessage = { type: "joinRoom", roomCode: command.roomCode };
  if (command.token !== undefined) message.token = command.token;
  record.socket.send(JSON.stringify(message));
  const view = await waitFor(record, (msg) => msg.type === "view", `a view after joinRoom ${command.roomCode}`);
  return { ok: true, name: command.name, view: isRecord(view.view) ? view.view : null };
}

async function send(command: Extract<WsPlayerCommand, { action: "send" }>): Promise<WsPlayerResult> {
  const record = client(command.name);
  record.nonce += 1;
  const nonce = `${command.name}-${record.nonce}`;
  const action = { playerId: record.seat, ...command.body, nonce };
  record.socket.send(JSON.stringify({ type: "action", action }));
  const reply = await waitFor(
    record,
    (message) => (message.type === "ack" && message.nonce === nonce) || message.type === "error",
    `an ack for ${String(command.body.type)} (${nonce})`,
  );
  if (reply.type === "error") {
    return { ok: false, name: command.name, error: String(reply.error ?? "server error"), view: record.lastView };
  }
  return { ok: true, name: command.name, view: record.lastView };
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

export async function wsPlayer(command: WsPlayerCommand): Promise<WsPlayerResult> {
  try {
    switch (command.action) {
      case "connect":
        return await connect(command);
      case "joinRoom":
        return await joinRoom(command);
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
        record.socket.close();
        clients.delete(command.name);
        return { ok: true, name: command.name };
      }
      case "reset": {
        for (const record of clients.values()) record.socket.close();
        clients.clear();
        return { ok: true };
      }
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
