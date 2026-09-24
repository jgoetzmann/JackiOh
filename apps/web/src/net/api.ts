// The client's one door onto `apps/server`'s REST surface.
//
// CLAUDE.md rule 7: the client sends intent and renders what comes back. Nothing here decides a
// rule — in particular no L1–L6 message is ever composed in the browser. `packages/validator` is
// "one validator module shared by client and server" (SPEC §9.4) and the server passes its issues
// through untouched, so a `LoadoutIssue.message` shown by the deckbuilder is either the validator's
// own sentence (client-side, as UX) or the server's relay of it (at save, as law). A second copy
// of a message would be a second source of truth.
//
// Every response shape below is the one `apps/server/src/api/*.ts` actually returns; every error
// is `{ error: { code, message, details? } }` from `apps/server/src/api/http.ts`.

import type { CardDefs } from "@jackioh/shared";

import { API_REQUEST_TIMEOUT_SECONDS } from "../../../server/src/config.ts";

const DEFAULT_HTTP_URL = "http://localhost:8787";

/**
 * `VITE_SERVER_HTTP_URL` is the public half of the environment contract
 * (`apps/server/src/env.ts` `PUBLIC_ENV_VARS`). The default is the port `apps/server` listens on,
 * which is what `e2e/support/config.ts` points at.
 */
export function apiBaseUrl(): string {
  const configured: unknown = import.meta.env.VITE_SERVER_HTTP_URL;
  const base = typeof configured === "string" && configured.length > 0 ? configured : DEFAULT_HTTP_URL;
  return base.replace(/\/+$/, "");
}

const DEFAULT_WS_URL = "ws://localhost:8787/ws/match";

/** `WS_PATH` in `apps/server/src/match/wsServer.ts` is `/ws/match`; the default mirrors it. */
export function matchSocketUrl(): string {
  const configured: unknown = import.meta.env.VITE_SERVER_WS_URL;
  return typeof configured === "string" && configured.length > 0 ? configured : DEFAULT_WS_URL;
}

/** `apps/server/src/api/http.ts` `ApiErrorCode`, as the client sees it: an opaque string. */
export type ApiErrorBody = { code: string; message: string; details?: unknown };

/** A refusal from the server, carrying its code and message verbatim. Never reworded here. */
export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, body: ApiErrorBody) {
    super(body.message);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = body.code;
    this.details = body.details;
  }
}

/**
 * The transport failed: no response at all, or none within `API_REQUEST_TIMEOUT_SECONDS`. Distinct
 * from a refusal, which has a code. Its message is a sentence for the player; the browser's own
 * wording ("Failed to fetch", Safari's "Load failed") says nothing to them and is kept aside.
 */
export const API_UNREACHABLE_MESSAGE = "Couldn’t reach JackiOh. Check your connection, then try again.";

export class ApiUnreachableError extends Error {
  /** What the transport said, for a debugger; never shown. */
  readonly transportError: unknown;

  constructor(transportError: unknown) {
    super(API_UNREACHABLE_MESSAGE);
    this.name = "ApiUnreachableError";
    this.transportError = transportError;
  }
}

/** Why a request was abandoned: it had not answered within `API_REQUEST_TIMEOUT_SECONDS`. */
class ApiTimeoutError extends Error {
  constructor() {
    super(`no answer within ${String(API_REQUEST_TIMEOUT_SECONDS)} s`);
    this.name = "ApiTimeoutError";
  }
}

export type RequestOptions = {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  /** The bearer token. Omitted for the two `auth: "none"` routes. */
  token?: string | null;
  body?: unknown;
  signal?: AbortSignal;
};

function errorBodyOf(value: unknown, status: number): ApiErrorBody {
  if (typeof value === "object" && value !== null) {
    const error = (value as { error?: unknown }).error;
    if (typeof error === "object" && error !== null) {
      const code = (error as { code?: unknown }).code;
      const message = (error as { message?: unknown }).message;
      if (typeof code === "string" && typeof message === "string") {
        return { code, message, details: (error as { details?: unknown }).details };
      }
    }
  }
  return { code: "internal", message: `the server answered ${String(status)}` };
}

/**
 * One request. Resolves with the parsed body on 2xx and rejects with `ApiRequestError` otherwise,
 * so a caller never has to remember to check `response.ok`.
 */
export async function apiRequest<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.token !== undefined && options.token !== null && options.token.length > 0) {
    headers.authorization = `Bearer ${options.token}`;
  }
  if (options.body !== undefined) headers["content-type"] = "application/json";

  // A request that never answers (a stalled mobile network, a dead socket) must not leave a screen
  // on "Checking your account…" or a button on "Redeeming…" for ever. The race is against our own
  // timer as well as the abort, so a `fetch` that ignores its signal still gives up.
  const controller = new AbortController();
  const outer = options.signal;
  if (outer !== undefined) {
    if (outer.aborted) controller.abort();
    else outer.addEventListener("abort", () => controller.abort(), { once: true });
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ApiTimeoutError());
    }, API_REQUEST_TIMEOUT_SECONDS * 1000);
  });

  let response: Response;
  let text: string;
  try {
    try {
      response = await Promise.race([
        fetch(`${apiBaseUrl()}${path}`, {
          method: options.method ?? "GET",
          headers,
          ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
          signal: controller.signal,
        }),
        timedOut,
      ]);
    } catch (cause) {
      throw new ApiUnreachableError(cause);
    }
    try {
      text = await Promise.race([response.text(), timedOut]);
    } catch (cause) {
      throw new ApiUnreachableError(cause);
    }
  } finally {
    clearTimeout(timer);
  }

  let parsed: unknown = null;
  if (text.length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }
  if (!response.ok) throw new ApiRequestError(response.status, errorBodyOf(parsed, response.status));
  return parsed as T;
}

// ---------------------------------------------------------------------------------------------
// The endpoints, as the handlers in `apps/server/src/api/**` return them.
// ---------------------------------------------------------------------------------------------

/** `GET /api/auth/me` (`auth: "user"`): the code screen's own read (§9.4). */
export type MeResponse = {
  profile: { id: string; status: "pending" | "active" | "banned"; rating: number };
  needsInviteCode: boolean;
  emailVerified: boolean;
  /** §9.5: the match this profile is in, or null. What `/play` waits on after it queues. */
  currentMatchId: string | null;
  /** The address this account is tied to, so a player can see who they are signed in as. */
  email: string | null;
};

/** `GET /api/profile`: the account screen's read — identity plus the ladder record. */
export type ProfileResponse = {
  id: string;
  email: string | null;
  status: "pending" | "active" | "banned";
  rating: number;
  record: { wins: number; losses: number; draws: number };
  /** 0..1, or null when nothing has been played. Computed server-side so the two cannot differ. */
  winRate: number | null;
};

export function getProfile(token: string): Promise<ProfileResponse> {
  return apiRequest<ProfileResponse>("/api/profile", { token });
}

export function getMe(token: string): Promise<MeResponse> {
  return apiRequest<MeResponse>("/api/auth/me", { token });
}

// Sign-in and sign-up are NOT here. SPEC §9.2 draws the browser's arrow to the auth provider
// separately from its arrow to these API functions, so they live in `net/auth.ts` and go straight
// to the provider. `/api/auth/signin` does exist on the server, but it is BUILD M8's fixture-account
// path: without a publishable key configured there it answers 503 with "This server does not broker
// passwords", which is the normal deployment. A second client helper pointing at it would be a
// sign-in path that silently fails, so there is one and it is `net/auth.ts`.

/**
 * `GET /api/codes/status`: so the code screen can say "paused" instead of guessing, and how many
 * redemptions this account has left in §9.4's window. `attemptsRemaining` is optional because a
 * server from before R192 does not send it; the screen then says nothing about tries rather than
 * inventing a number. It is advisory: the per-IP limit can still refuse first (the 429 covers it).
 */
export type CodeStatusResponse = {
  redemptionEnabled: boolean;
  retryAfterMs: number;
  attemptsRemaining?: number;
  /**
   * With no tries left, how long until this account's oldest counted attempt leaves the window and
   * a try comes back; 0 otherwise (R192). Optional for the same reason as `attemptsRemaining`.
   */
  attemptsRetryAfterMs?: number;
};

/**
 * R192: how long a `rate_limited` refusal says to wait, from its `details.retryAfterMs`. Null for
 * any other error, and for a rate limit that did not say (a finite, non-negative number or
 * nothing). Never read from any other code: R145's `invalid_code` carries no details on purpose.
 */
export function retryAfterMsOf(error: unknown): number | null {
  if (!(error instanceof ApiRequestError) || error.code !== "rate_limited") return null;
  const details = error.details;
  if (typeof details !== "object" || details === null) return null;
  const retryAfterMs = (details as { retryAfterMs?: unknown }).retryAfterMs;
  if (typeof retryAfterMs !== "number" || !Number.isFinite(retryAfterMs) || retryAfterMs < 0) return null;
  return retryAfterMs;
}

export function getCodeStatus(token: string): Promise<CodeStatusResponse> {
  return apiRequest<CodeStatusResponse>("/api/codes/status", { token });
}

/** `POST /api/codes/redeem`: flips pending to active (§9.4). */
export type RedeemResponse = { status: "active"; needsInviteCode: false };

export function redeemCode(token: string, code: string): Promise<RedeemResponse> {
  return apiRequest<RedeemResponse>("/api/codes/redeem", { method: "POST", token, body: { code } });
}

export type CollectionEntry = { cardId: string; quantity: number };
export type CollectionResponse = { catalogVersion: string; entries: CollectionEntry[] };

export function getCollection(token: string): Promise<CollectionResponse> {
  return apiRequest<CollectionResponse>("/api/collection", { token });
}

export type StoredLoadout = { catalogVersion: string; decks: string[][]; updatedAt: number };
export type LoadoutResponse = { catalogVersion: string; loadout: StoredLoadout | null };

export function getLoadout(token: string): Promise<LoadoutResponse> {
  return apiRequest<LoadoutResponse>("/api/loadout", { token });
}

export function putLoadout(
  token: string,
  catalogVersion: string,
  decks: readonly (readonly string[])[],
): Promise<LoadoutResponse> {
  return apiRequest<LoadoutResponse>("/api/loadout", {
    method: "PUT",
    token,
    body: { catalogVersion, decks },
  });
}

/**
 * `GET /api/catalog`: card data for a screen that has no game running.
 *
 * NOT IN SPEC, and no R-row yet. §9.4 calls the catalog "static, versioned, shipped with the
 * client", but the deckbuilder needs names and costs before any engine is loaded and the client
 * has no catalog of its own to ship yet, so the server serves the one it already holds. The
 * proposed §11 row is written out once, on the server half, above `createCatalogRoutes` in
 * `apps/server/src/api/catalog.ts`; this is the caller, not a second statement of the rule.
 */
// It returns the whole `CardDefs` record and not a projection, because `@jackioh/validator`'s
// `CatalogSnapshot.cards` is a `CardDefs` — the deckbuilder's client-side verdict (§9.4: "the
// client's verdict is UX while the server's is law") runs the same module the server runs, and a
// trimmed-down card would mean a second, weaker copy of the catalog.
export type CatalogResponse = { version: string; defs: CardDefs };

export function getCatalog(): Promise<CatalogResponse> {
  return apiRequest<CatalogResponse>("/api/catalog");
}

/** `POST /api/rooms` / `POST /api/rooms/:code/join` (§9.5). */
export type CreateRoomResponse = { code: string; expiresAt: number; deckIndex: number };
export type JoinRoomResponse = { matchId: string; code: string; seat: "p1" | "p2" };

export function createRoom(token: string, deckIndex: number): Promise<CreateRoomResponse> {
  return apiRequest<CreateRoomResponse>("/api/rooms", { method: "POST", token, body: { deckIndex } });
}

export function joinRoom(token: string, code: string, deckIndex: number): Promise<JoinRoomResponse> {
  return apiRequest<JoinRoomResponse>(`/api/rooms/${encodeURIComponent(code)}/join`, {
    method: "POST",
    token,
    body: { deckIndex },
  });
}

export function enqueue(token: string, deckIndex: number): Promise<unknown> {
  return apiRequest<unknown>("/api/queue", { method: "POST", token, body: { deckIndex } });
}

export function dequeue(token: string): Promise<unknown> {
  return apiRequest<unknown>("/api/queue", { method: "DELETE", token });
}
