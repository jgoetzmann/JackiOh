/**
 * The `ws` adapter: the only file in `src/match` that knows a WebSocket library exists.
 *
 * Everything the protocol guarantees is proven against the in-memory `Socket` (test/fakes/socket.ts),
 * because that is the same interface the actor talks to (src/match/contracts.ts). This file adds
 * two things and no rules:
 *
 *  - `socketFromWs`: a `ws` connection as a `Socket`. Text frames only — every protocol message is
 *    JSON (contracts.ts), so a binary frame is answered with an `error` and dropped.
 *  - `createMatchSocketHandler`: the upgrade. It authenticates the bearer token through
 *    `deps.auth`, resolves the profile, applies §9.4's gate (`assertActive`) and refuses unless
 *    that profile is in the match it asked for (§9.1: the client may only read its own view of a
 *    match it is playing). Only then does the registry get the socket.
 */

import { WebSocketServer, type WebSocket } from "ws";
import { ApiError, assertActive, bearerToken } from "../api/http";
import type { AuthProvider, Logger, Store } from "../api/ports";
import type { Socket, SocketHandlers } from "./contracts";
import { encode, errorMessage } from "./protocol";

/** SPEC §9.2: one WebSocket per player, upgraded on the same listener the API serves. */
export const WS_PATH = "/ws/match";

/**
 * SPEC §11 R148: "4401, 4403 and 4404 are private-use mirrors of the HTTP statuses the REST side
 * returns for the same three refusals, with 1011 for an internal fault, so a client reuses one
 * table." R148 also fixes what the socket may learn: every refusal answers with the same error
 * code and only the close code varies, so a socket learns that it may not have this match and
 * never which check said so (§9.1).
 */
export const WS_CLOSE = {
  unauthorized: 4401,
  forbidden: 4403,
  notFound: 4404,
  internal: 1011,
} as const;

export function socketFromWs(ws: WebSocket): Socket {
  let handlers: SocketHandlers | null = null;

  const socket: Socket = {
    get isOpen() {
      // 1 === WebSocket.OPEN. Compared as a number so this module needs no runtime import of `ws`.
      return ws.readyState === 1;
    },
    send: (text) => {
      ws.send(text);
    },
    close: (code, reason) => {
      ws.close(code ?? 1000, reason ?? "");
    },
    attach: (next) => {
      handlers = next;
    },
  };

  ws.on("message", (data: unknown, isBinary: boolean) => {
    if (isBinary) {
      ws.send(encode(errorMessage("malformed", "text frames only: every message is JSON")));
      return;
    }
    handlers?.message(String(data));
  });
  ws.on("close", () => {
    handlers?.close();
  });
  ws.on("error", () => {
    // A transport error is a disconnect; §9.5's grace is what handles it.
    handlers?.close();
  });

  return socket;
}

/** Enough of Node's `IncomingMessage` to read the token and the match id. */
export type UpgradeRequest = {
  url?: string | undefined;
  headers: Record<string, string | string[] | undefined>;
};

export type MatchSocketDeps = {
  auth: AuthProvider;
  store: Store;
  log: Logger;
  /** The registry, narrowed to the one method the upgrade needs. */
  registry: { attach: (matchId: string, profileId: string, socket: Socket) => Promise<unknown> };
};

/**
 * Browsers cannot set headers on a WebSocket handshake, so the token may arrive as `?token=`; a
 * Node client (the e2e `wsPlayer` task) may use either.
 */
function tokenFrom(request: UpgradeRequest, url: URL): string | null {
  const header = request.headers.authorization;
  if (typeof header === "string") {
    const fromHeader = bearerToken(new Headers({ authorization: header }));
    if (fromHeader !== null) return fromHeader;
  }
  const query = url.searchParams.get("token");
  return query === null || query.length === 0 ? null : query;
}

export function createMatchSocketHandler(
  deps: MatchSocketDeps,
): (ws: WebSocket, request: UpgradeRequest) => Promise<void> {
  return async (ws, request) => {
    const socket = socketFromWs(ws);

    const refuse = (code: number, message: string): void => {
      try {
        // One protocol code for every refusal: a socket learns that it may not have this match,
        // never which of the checks said so.
        socket.send(encode(errorMessage("forbidden", message)));
      } catch {
        // The peer may already be gone; the close below is what matters.
      }
      socket.close(code, message);
    };

    try {
      const url = new URL(request.url ?? "/", "http://match.invalid");
      const token = tokenFrom(request, url);
      if (token === null) {
        refuse(WS_CLOSE.unauthorized, "sign in first");
        return;
      }

      const user = await deps.auth.verifyAccessToken(token);
      if (user === null) {
        refuse(WS_CLOSE.unauthorized, "sign in first");
        return;
      }

      const profile = await deps.store.profiles.getByUserId(user.userId);
      if (profile === null) {
        refuse(WS_CLOSE.unauthorized, "sign in first");
        return;
      }

      // §9.4's gate, from the same function the HTTP router uses.
      assertActive(profile);

      const asked = url.searchParams.get("matchId");
      const matchId = asked ?? profile.inMatchId;
      if (matchId === null) {
        refuse(WS_CLOSE.notFound, "you are not in a match");
        return;
      }
      // §9.1: a socket is only ever opened onto a match this profile is playing.
      if (profile.inMatchId !== matchId) {
        refuse(WS_CLOSE.forbidden, "you are not in that match");
        return;
      }

      await deps.registry.attach(matchId, profile.id, socket);
    } catch (error: unknown) {
      if (error instanceof ApiError) {
        refuse(error.status === 404 ? WS_CLOSE.notFound : WS_CLOSE.forbidden, error.message);
        return;
      }
      deps.log.alert("ws.upgrade.threw", {
        message: error instanceof Error ? error.message : String(error),
      });
      refuse(WS_CLOSE.internal, "something went wrong");
    }
  };
}

/** Enough of Node's `http.Server` to take over an upgrade, so this file needs no `node:http` type. */
type UpgradableServer = {
  on: (event: "upgrade", listener: (request: UpgradeRequest, socket: Duplexish, head: Buffer) => void) => unknown;
};

/** The raw TCP socket an upgrade hands over; only the refusal path touches it. */
type Duplexish = { write: (chunk: string) => unknown; destroy: () => unknown };

export type AttachedSockets = { close: () => Promise<void> };

export type AttachOptions = {
  path?: string;
  /**
   * §9.8: a browser attaches credentials to a cross-origin WebSocket handshake automatically, so an
   * unchecked upgrade is a CSRF surface. An empty or absent list allows any origin, which is what a
   * Node client (the e2e `wsPlayer` task) sends — it has no `Origin` at all.
   */
  allowedOrigins?: readonly string[];
};

/**
 * Wire the upgrade onto the listener the API already serves (§9.2). `ws` runs in `noServer` mode so
 * this owns the routing decision: a handshake off `path` is left alone rather than refused, because
 * another handler may want it, while a disallowed origin is refused before any token is read.
 *
 * The returned `close` shuts every live socket, so `start()`'s own `close` really does release the
 * port — a test that started a server and did not get its sockets closed would hang the run.
 */
export function attachWebSocketServer(
  server: UpgradableServer,
  deps: { auth: AuthProvider; store: Store; log: Logger },
  registry: MatchSocketDeps["registry"],
  options: AttachOptions = {},
): AttachedSockets {
  const path = options.path ?? WS_PATH;
  const allowed = options.allowedOrigins ?? [];
  const wss = new WebSocketServer({ noServer: true });
  const handle = createMatchSocketHandler({ ...deps, registry });

  function originAllowed(request: UpgradeRequest): boolean {
    if (allowed.length === 0) return true;
    const origin = request.headers.origin;
    // No Origin header at all is a non-browser client, which the CSRF concern does not reach.
    if (typeof origin !== "string" || origin.length === 0) return true;
    return allowed.includes(origin);
  }

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://match.invalid");
    // Not our path: leave the handshake for another handler rather than destroying it.
    if (url.pathname !== path) return;

    if (!originAllowed(request)) {
      deps.log.warn("ws.upgrade.origin_refused", { origin: String(request.headers.origin) });
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request as never, socket as never, head, (ws: WebSocket) => {
      void handle(ws, request);
    });
  });

  return {
    close: async () => {
      for (const client of wss.clients) client.close(1001, "server closing");
      await new Promise<void>((resolve) => {
        wss.close(() => {
          resolve();
        });
      });
    },
  };
}
