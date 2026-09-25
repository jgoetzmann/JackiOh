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

import type { CardDefs, GameOverReason } from "@jackioh/shared";

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
  /**
   * R259: the Best-of-3 series this profile is in (not over), or null. Set between games too, when
   * `currentMatchId` is null, so `/play` can send a paired player to the series screen to pick.
   * Optional because a server from before R259 does not send it.
   */
  currentSeriesId?: string | null;
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

// ---------------------------------------------------------------------------------------------
// Saved decks and trios (SPEC §9.4, R250–R256). Ids are minted HERE, by the client
// (`crypto.randomUUID()`), so every save is an idempotent `PUT` that can be retried after a dropped
// connection without making a second deck (R256).
// ---------------------------------------------------------------------------------------------

export type SavedDeck = {
  id: string;
  name: string;
  cards: string[];
  catalogVersion: string;
  createdAt: number;
  updatedAt: number;
};

export type TrioSlots = [string | null, string | null, string | null];

export type SavedTrio = {
  id: string;
  name: string;
  deckIds: TrioSlots;
  createdAt: number;
  updatedAt: number;
};

/** `GET /api/decks`: the profile's decks and trios, oldest first, and the caps they live under. */
export type DecksResponse = {
  catalogVersion: string;
  decks: SavedDeck[];
  trios: SavedTrio[];
  limits: { decks: number; trios: number; nameLength: number };
};

export function getDecks(token: string): Promise<DecksResponse> {
  return apiRequest<DecksResponse>("/api/decks", { token });
}

export type DeckInput = { name: string; cards: readonly string[]; catalogVersion: string };

/**
 * `PUT /api/decks/:id`: creates the deck when the id is new, else replaces its name and cards.
 * Refusals: 400 `bad_request` (a D1–D4 draft rule, the issues in `details`), 409 `conflict` with
 * `details.limit` when the profile already has `limits.decks` decks, 409 `update_required` for a
 * stale catalog, 404 when the id is another profile's.
 */
export function putDeck(token: string, id: string, input: DeckInput): Promise<{ deck: SavedDeck }> {
  return apiRequest<{ deck: SavedDeck }>(`/api/decks/${encodeURIComponent(id)}`, {
    method: "PUT",
    token,
    body: input,
  });
}

/** `DELETE /api/decks/:id`: idempotent; `deleted: false` when there was nothing to delete. */
export function deleteDeck(token: string, id: string): Promise<{ deleted: boolean }> {
  return apiRequest<{ deleted: boolean }>(`/api/decks/${encodeURIComponent(id)}`, {
    method: "DELETE",
    token,
  });
}

export type TrioInput = { name: string; deckIds: TrioSlots };

/**
 * `PUT /api/trios/:id`: as `putDeck`. A slot naming a deck the server does not have yet is a 409
 * `conflict` with `details.unknownDeck`, which a client syncing an offline draft answers by saving
 * the deck first.
 */
export function putTrio(token: string, id: string, input: TrioInput): Promise<{ trio: SavedTrio }> {
  return apiRequest<{ trio: SavedTrio }>(`/api/trios/${encodeURIComponent(id)}`, {
    method: "PUT",
    token,
    body: input,
  });
}

export function deleteTrio(token: string, id: string): Promise<{ deleted: boolean }> {
  return apiRequest<{ deleted: boolean }>(`/api/trios/${encodeURIComponent(id)}`, {
    method: "DELETE",
    token,
  });
}

// ---------------------------------------------------------------------------------------------
// Tutorial progress on the account (SPEC §9.10, R320). The device's copy is the one the page
// renders (`tutorial/progress.ts`); `tutorial/accountSync.ts` is the only caller of these two.
// ---------------------------------------------------------------------------------------------

/** `TutorialProgressView` in `apps/server/src/api/tutorial.ts`. */
export type TutorialAccountProgress = {
  /** Lesson ids, each once, in code-point order; an id this client does not know may be among them. */
  completed: string[];
  /** The newest Hide/Show choice the account has seen (epoch ms), or null. */
  hiddenChoice: { hidden: boolean; at: number } | null;
};

/** `GET /api/tutorial` (`active`): the account's copy, empty before its first write. */
export async function getTutorialProgress(token: string): Promise<TutorialAccountProgress> {
  return (await apiRequest<{ progress: TutorialAccountProgress }>("/api/tutorial", { token })).progress;
}

/**
 * `PUT /api/tutorial` (`active`): merges this device's progress into the account's and answers with
 * the result — the union of the lessons and the newer choice (R320). It never removes anything, so
 * sending the same progress twice is harmless.
 */
export async function putTutorialProgress(
  token: string,
  progress: TutorialAccountProgress,
): Promise<TutorialAccountProgress> {
  return (
    await apiRequest<{ progress: TutorialAccountProgress }>("/api/tutorial", {
      method: "PUT",
      token,
      body: { completed: progress.completed, hiddenChoice: progress.hiddenChoice },
    })
  ).progress;
}

// ---------------------------------------------------------------------------------------------
// Queue modes (SPEC §9.5, R257–R258, R264)
// ---------------------------------------------------------------------------------------------

export type QueueMode = "bo1" | "bo3" | "random";

/** What a queue ticket or a room is made with: a deck, a trio, or nothing at all. */
export type ModeChoice =
  | { mode: "bo1"; deckId: string }
  | { mode: "bo3"; trioId: string }
  | { mode: "random" };

/** `POST /api/queue`. `matchId` for a paired Best-of-1 or All Random game, `seriesId` for Best-of-3. */
export type EnqueueResponse = {
  ticketId: string;
  status: "open" | "matched" | "cancelled";
  matchId: string | null;
  seriesId: string | null;
  population: number;
  mode: QueueMode;
};

export function enqueue(token: string, choice: ModeChoice): Promise<EnqueueResponse> {
  return apiRequest<EnqueueResponse>("/api/queue", { method: "POST", token, body: choice });
}

export function dequeue(token: string): Promise<{ cancelled: boolean; ticketId?: string }> {
  return apiRequest<{ cancelled: boolean; ticketId?: string }>("/api/queue", { method: "DELETE", token });
}

/** `GET /api/queue/population`: the total, and per mode (R257). */
export type PopulationResponse = { population: number; byMode?: Record<QueueMode, number> };

export function getPopulation(token: string): Promise<PopulationResponse> {
  return apiRequest<PopulationResponse>("/api/queue/population", { token });
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

/** `POST /api/rooms` / `POST /api/rooms/:code/join` (§9.5, R264). */
export type CreateRoomResponse = { code: string; expiresAt: number; mode: QueueMode };

/**
 * A join answers with the match (Best-of-1, All Random) or the series (Best-of-3) it made. A joiner
 * whose choice is in another mode than the room's is refused with 409 `conflict` and
 * `details.mode`, the room's mode, so the lobby can ask for the right deck or trio.
 */
export type JoinRoomResponse = {
  matchId: string | null;
  seriesId: string | null;
  code: string;
  seat: "p1" | "p2";
  mode: QueueMode;
};

export function createRoom(token: string, choice: ModeChoice): Promise<CreateRoomResponse> {
  return apiRequest<CreateRoomResponse>("/api/rooms", { method: "POST", token, body: choice });
}

export function joinRoom(token: string, code: string, choice: ModeChoice): Promise<JoinRoomResponse> {
  return apiRequest<JoinRoomResponse>(`/api/rooms/${encodeURIComponent(code)}/join`, {
    method: "POST",
    token,
    body: choice,
  });
}

/** The room's mode from a mode-mismatch refusal (R264), or null for any other error. */
export function roomModeOf(error: unknown): QueueMode | null {
  if (!(error instanceof ApiRequestError) || error.code !== "conflict") return null;
  const details = error.details;
  if (typeof details !== "object" || details === null) return null;
  const mode = (details as { mode?: unknown }).mode;
  return mode === "bo1" || mode === "bo3" || mode === "random" ? mode : null;
}

// ---------------------------------------------------------------------------------------------
// The Best-of-3 series (SPEC §9.5, R259–R263). The server's projection for the caller: the other
// side's pick is never in it before both have picked, and the other side's deck names never are.
// ---------------------------------------------------------------------------------------------

export type SeriesEnd = "decided" | "exhausted" | "forfeit" | "abandoned";

export type SeriesView = {
  id: string;
  status: "picking" | "playing" | "over";
  /** The game being picked for or played, or the last one played once the series is over. */
  gameNo: number;
  winsNeeded: number;
  maxGames: number;
  /** Epoch ms the pick clock runs out (R260), or null outside the pick phase. */
  pickDeadline: number | null;
  /** The server's clock when it answered, so a countdown does not depend on this device's. */
  now: number;
  /** The match to open while `status` is `playing`. */
  currentMatchId: string | null;
  you: {
    seat: "p1" | "p2";
    wins: number;
    trioName: string;
    decks: { slot: number; name: string; cards: string[]; played: boolean }[];
    /** Your pick for the next game, or null. */
    pick: number | null;
  };
  opponent: {
    wins: number;
    /** Only which slots have been played: names and cards stay hidden (R259). */
    decks: { slot: number; played: boolean }[];
    /** Whether they have picked; never what. */
    picked: boolean;
  };
  games: {
    gameNo: number;
    matchId: string;
    yourSlot: number;
    opponentSlot: number;
    youWentFirst: boolean;
    result: "win" | "loss" | "draw" | null;
    reason: GameOverReason | null;
  }[];
  /** Null until the series is over. */
  result: {
    outcome: "win" | "loss" | "draw" | "abandoned";
    endReason: SeriesEnd;
    ratingBefore: number | null;
    ratingAfter: number | null;
  } | null;
};

export function getSeries(token: string, seriesId: string): Promise<SeriesView> {
  return apiRequest<SeriesView>(`/api/series/${encodeURIComponent(seriesId)}`, { token });
}

/** `GET /api/matches/:id/series`: the series a match belongs to, for the board's series banner. */
export function getSeriesForMatch(token: string, matchId: string): Promise<{ series: SeriesView | null }> {
  return apiRequest<{ series: SeriesView | null }>(`/api/matches/${encodeURIComponent(matchId)}/series`, { token });
}

/** `POST /api/series/:id/pick` with a trio slot (0-based). Answers with the new projection. */
export function pickSeriesDeck(token: string, seriesId: string, slot: number): Promise<SeriesView> {
  return apiRequest<SeriesView>(`/api/series/${encodeURIComponent(seriesId)}/pick`, {
    method: "POST",
    token,
    body: { slot },
  });
}

/** `POST /api/series/:id/forfeit`: between games only (R261). */
export function forfeitSeries(token: string, seriesId: string): Promise<SeriesView> {
  return apiRequest<SeriesView>(`/api/series/${encodeURIComponent(seriesId)}/forfeit`, {
    method: "POST",
    token,
  });
}
