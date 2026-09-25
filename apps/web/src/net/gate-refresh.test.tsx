// Session renewal at the gate (docs/polish/5-sign-in.md, B32, B33, R194), asserted through the real
// modules: a session in localStorage, `/api/auth/me` and the provider's token endpoint over a
// stubbed `fetch`, and the URL and storage as the answer.
//
// A token near its expiry, or one the API answers 401, is renewed once with the refresh token and
// the read retried. A renewal the provider refuses ends the session and says so on /login. A
// renewal that fails for want of a network keeps the session. A session with no refresh token
// (the e2e fixtures) is never renewed.

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AUTH_SESSION_REFRESH_MARGIN_SECONDS } from "../../../server/src/config.ts";
import { clearConsumedAuthRedirect } from "../auth/redirect.ts";
import { loginTestid } from "../auth/testids.ts";
import { AUTH_NOTICES } from "./auth.ts";
import { loginPath, loginReasonOf, paths } from "./navigate.ts";
import { E2E_SESSION_STORAGE_KEY, SESSION_STORAGE_KEY, readSession } from "./session.ts";

const { App, Gated, redirectFor } = await import("../main.tsx");

const URL_ = "https://project.supabase.co";
const KEY = "sb_publishable_test";
const OLD = "access-old";
const NEW = "access-new";
const OLD_REFRESH = "refresh-old";
const NEW_REFRESH = "refresh-new";
const NEW_EXPIRES_AT_S = 2_000_000_000;
const MARGIN_MS = AUTH_SESSION_REFRESH_MARGIN_SECONDS * 1000;

/** A lazily loaded route plus several round trips can outrun the 1 s default under load. */
const SLOW = { timeout: 5_000 } as const;
/** A test that waits `SLOW` more than once needs more than vitest's 5 s default for the whole test. */
const SLOW_TEST = { timeout: 30_000 } as const;

// ---------------------------------------------------------------------------------------------
// the stubbed API and provider
// ---------------------------------------------------------------------------------------------

type Call = { url: string; token: string | null; body: unknown };
type Reply = { status: number; body?: unknown } | "reject" | "hang";

function jsonResponse(status: number, body?: unknown): Response {
  const text = body === undefined ? "" : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    headers: new Headers({ "content-type": "application/json" }),
    json: () =>
      text === "" ? Promise.reject(new SyntaxError("empty body")) : Promise.resolve(JSON.parse(text)),
    text: () => Promise.resolve(text),
    clone: () => jsonResponse(status, body),
  } as unknown as Response;
}

function meBody(status: "pending" | "active") {
  return {
    profile: { id: "profile-1", status, rating: 1000 },
    needsInviteCode: status === "pending",
    emailVerified: true,
    currentMatchId: null,
    email: "player@example.test",
  };
}

const UNAUTHORIZED = { status: 401, body: { error: { code: "unauthorized", message: "sign in first" } } };

const RENEWED = {
  status: 200,
  body: {
    access_token: NEW,
    refresh_token: NEW_REFRESH,
    expires_at: NEW_EXPIRES_AT_S,
    expires_in: 3600,
    token_type: "bearer",
    user: { id: "user-1" },
  },
};

type Server = {
  /** `/api/auth/me`, by the bearer token it carried. */
  me: (token: string | null) => Reply;
  /** `POST /auth/v1/token?grant_type=refresh_token`. */
  refresh: () => Reply;
};

function toReply(reply: Reply): Promise<Response> {
  if (reply === "reject") return Promise.reject(new TypeError("Failed to fetch"));
  if (reply === "hang") return new Promise<Response>(() => {});
  return Promise.resolve(jsonResponse(reply.status, reply.body));
}

function serve(server: Server): { meCalls: Call[]; refreshCalls: Call[] } {
  const meCalls: Call[] = [];
  const refreshCalls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: unknown, init?: RequestInit) => {
      const url = typeof input === "string" ? input : String((input as URL).href ?? input);
      const authorization = new Headers(init?.headers).get("authorization");
      const token = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : null;
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
      if (url.endsWith("/api/auth/me")) {
        meCalls.push({ url, token, body });
        return toReply(server.me(token));
      }
      if (url.startsWith(`${URL_}/auth/v1/token`) && url.includes("grant_type=refresh_token")) {
        refreshCalls.push({ url, token, body });
        return toReply(server.refresh());
      }
      if (url.startsWith(`${URL_}/auth/v1/logout`)) return toReply({ status: 204 });
      return toReply({ status: 404, body: { error: { code: "not_found", message: `no stub for ${url}` } } });
    }),
  );
  return { meCalls, refreshCalls };
}

/** `me` accepts only the renewed token; the old one is refused as unauthorised. */
function acceptsOnlyNew(token: string | null): Reply {
  return token === NEW ? { status: 200, body: meBody("active") } : UNAUTHORIZED;
}

function store(session: { accessToken: string; refreshToken?: string | null; expiresAt?: number | null }): void {
  window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
}

function at(path: string): void {
  window.history.replaceState(null, "", path);
}

/** A gated screen that prints the token it was opened with. */
function renderGated(): void {
  render(
    <Gated>
      {(account) => <p data-testid="opened">{account.token}</p>}
    </Gated>,
  );
}

beforeEach(() => {
  vi.stubEnv("VITE_SUPABASE_URL", URL_);
  vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", KEY);
  window.localStorage.clear();
  clearConsumedAuthRedirect();
  at("/decks");
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------------
// B32: renew once, retry once
// ---------------------------------------------------------------------------------------------

describe("R194 B32 renewal", () => {
  it("R194 a 401 from /api/auth/me renews once and retries with the new token", async () => {
    store({ accessToken: OLD, refreshToken: OLD_REFRESH, expiresAt: Date.now() + 60 * MARGIN_MS });
    const { meCalls, refreshCalls } = serve({ me: acceptsOnlyNew, refresh: () => RENEWED });
    renderGated();

    expect((await screen.findByTestId("opened", undefined, SLOW)).textContent).toBe(NEW);
    expect(refreshCalls).toHaveLength(1);
    expect(refreshCalls[0]?.body).toEqual({ refresh_token: OLD_REFRESH });
    expect(meCalls[0]?.token).toBe(OLD);
    expect(meCalls.at(-1)?.token).toBe(NEW);
    // `expires_in` from now, on this device's clock (R194), not the provider's `expires_at`.
    expect(readSession()).toMatchObject({ accessToken: NEW, refreshToken: NEW_REFRESH });
    expect(readSession()?.expiresAt).toBeGreaterThan(Date.now() + 3500 * 1000);
  });

  it("R194 a session inside the margin is renewed, and the read carries the new token", async () => {
    store({ accessToken: OLD, refreshToken: OLD_REFRESH, expiresAt: Date.now() + MARGIN_MS - 5_000 });
    const { meCalls, refreshCalls } = serve({
      me: (token) => (token === null ? UNAUTHORIZED : { status: 200, body: meBody("active") }),
      refresh: () => RENEWED,
    });
    renderGated();

    expect((await screen.findByTestId("opened", undefined, SLOW)).textContent).toBe(NEW);
    expect(refreshCalls).toHaveLength(1);
    expect(meCalls.at(-1)?.token).toBe(NEW);
    expect(readSession()?.accessToken).toBe(NEW);
  });

  it("R194 a session already past its expiry is renewed", async () => {
    store({ accessToken: OLD, refreshToken: OLD_REFRESH, expiresAt: Date.now() - 60_000 });
    const { refreshCalls } = serve({ me: acceptsOnlyNew, refresh: () => RENEWED });
    renderGated();
    expect((await screen.findByTestId("opened", undefined, SLOW)).textContent).toBe(NEW);
    expect(refreshCalls).toHaveLength(1);
  });

  it("R194 a session well outside the margin is not renewed", async () => {
    store({ accessToken: OLD, refreshToken: OLD_REFRESH, expiresAt: Date.now() + MARGIN_MS + 10 * 60_000 });
    const { refreshCalls } = serve({
      me: () => ({ status: 200, body: meBody("active") }),
      refresh: () => RENEWED,
    });
    renderGated();
    expect((await screen.findByTestId("opened", undefined, SLOW)).textContent).toBe(OLD);
    expect(refreshCalls).toHaveLength(0);
    expect(readSession()?.accessToken).toBe(OLD);
  });

  it("R194 a renewal timer that comes due before the clock says it should still renews, a moment later", SLOW_TEST, async () => {
    // Node measures a timer from the event loop's cached clock, which a long task (a render) leaves
    // behind `Date.now()`, so under load the renewal timer can come due a little before the time it
    // was set for. It used to return there and renew nothing until the page was next woken: a
    // renewal that never came, which is what "the gate's own renewal during a match" (in
    // gate-session-changes.test.tsx) ran into when it timed out on CI.
    const lead = 300;
    store({ accessToken: OLD, refreshToken: OLD_REFRESH, expiresAt: Date.now() + MARGIN_MS + lead });
    const { refreshCalls } = serve({
      me: () => ({ status: 200, body: meBody("active") }),
      refresh: () => RENEWED,
    });
    const realSetTimeout = window.setTimeout.bind(window);
    const realNow = Date.now.bind(Date);
    let early = false;
    vi.spyOn(window, "setTimeout").mockImplementation(((handler: TimerHandler, ms?: number, ...args: unknown[]) => {
      // The renewal timer is the one set for at most `lead` ms; it runs with the clock 80 ms behind.
      if (!early && typeof handler === "function" && typeof ms === "number" && ms > 0 && ms <= lead) {
        early = true;
        return realSetTimeout(() => {
          const now = vi.spyOn(Date, "now").mockImplementation(() => realNow() - 80);
          try {
            (handler as () => void)();
          } finally {
            now.mockRestore();
          }
        }, ms);
      }
      return realSetTimeout(handler, ms, ...args);
    }) as typeof window.setTimeout);
    renderGated();

    expect((await screen.findByTestId("opened", undefined, SLOW)).textContent).toBe(OLD);
    await waitFor(() => {
      expect(refreshCalls).toHaveLength(1);
    }, SLOW);
    expect(early).toBe(true);
    await waitFor(() => {
      expect(readSession()?.accessToken).toBe(NEW);
    }, SLOW);
  });

  it("R194 renews once only: a renewed token that is also refused is not renewed again", async () => {
    store({ accessToken: OLD, refreshToken: OLD_REFRESH, expiresAt: Date.now() + 60 * MARGIN_MS });
    const { meCalls, refreshCalls } = serve({ me: () => UNAUTHORIZED, refresh: () => RENEWED });
    renderGated();

    await waitFor(() => {
      expect(meCalls.some((call) => call.token === NEW)).toBe(true);
    }, SLOW);
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
    expect(refreshCalls).toHaveLength(1);
    expect(meCalls.filter((call) => call.token === NEW)).toHaveLength(1);
    expect(screen.queryByTestId("opened")).toBeNull();
  });

  it("R194 two gated screens renewing at once send one refresh request", async () => {
    store({ accessToken: OLD, refreshToken: OLD_REFRESH, expiresAt: Date.now() + 60 * MARGIN_MS });
    const releases: (() => void)[] = [];
    const { refreshCalls } = serve({ me: acceptsOnlyNew, refresh: () => "hang" });
    // Hold the provider's answer until both screens have asked.
    vi.stubGlobal(
      "fetch",
      vi.fn((input: unknown, init?: RequestInit) => {
        const url = typeof input === "string" ? input : String((input as URL).href ?? input);
        const authorization = new Headers(init?.headers).get("authorization");
        const token = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : null;
        if (url.endsWith("/api/auth/me")) return toReply(acceptsOnlyNew(token));
        if (url.includes("grant_type=refresh_token")) {
          refreshCalls.push({ url, token, body: undefined });
          return new Promise<Response>((resolve) => {
            releases.push(() => {
              resolve(jsonResponse(RENEWED.status, RENEWED.body));
            });
          });
        }
        return toReply({ status: 404, body: {} });
      }),
    );

    render(
      <>
        <Gated>{(account) => <p data-testid="opened-a">{account.token}</p>}</Gated>
        <Gated>{(account) => <p data-testid="opened-b">{account.token}</p>}</Gated>
      </>,
    );

    await waitFor(() => {
      expect(refreshCalls.length).toBeGreaterThan(0);
    }, SLOW);
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
    for (const release of releases) release();

    expect((await screen.findByTestId("opened-a", undefined, SLOW)).textContent).toBe(NEW);
    expect((await screen.findByTestId("opened-b", undefined, SLOW)).textContent).toBe(NEW);
    expect(refreshCalls).toHaveLength(1);
  });

  it.each([
    ["the provider cannot be reached", "reject" as Reply],
    ["the provider fails", { status: 503, body: {} } as Reply],
  ] as const)("R194 when %s, the gate shows its error and keeps the session", async (_name, reply) => {
    store({ accessToken: OLD, refreshToken: OLD_REFRESH, expiresAt: Date.now() + 60 * MARGIN_MS });
    serve({ me: acceptsOnlyNew, refresh: () => reply });
    renderGated();

    expect(await screen.findByTestId("gate-error", undefined, SLOW)).toBeInTheDocument();
    expect(screen.queryByTestId("opened")).toBeNull();
    expect(readSession()?.accessToken).toBe(OLD);
    expect(readSession()?.refreshToken).toBe(OLD_REFRESH);
    expect(window.location.pathname).toBe(paths.decks);
  });
});

// ---------------------------------------------------------------------------------------------
// B33: a refused renewal ends the session, and /login says so
// ---------------------------------------------------------------------------------------------

describe("R194 B33 a refused renewal", () => {
  it.each([
    ["invalid_grant", { status: 400, body: { error: "invalid_grant", error_description: "Invalid Refresh Token" } }],
    ["refresh_token_already_used", { status: 400, body: { error_code: "refresh_token_already_used" } }],
    ["a 401", { status: 401, body: {} }],
  ] as const)(
    "R194 %s clears the session and lands on /login?reason=expired with the notice",
    async (_name, reply) => {
      store({ accessToken: OLD, refreshToken: OLD_REFRESH, expiresAt: Date.now() + 60 * MARGIN_MS });
      const { refreshCalls } = serve({ me: acceptsOnlyNew, refresh: () => reply });
      render(<App />);

      await waitFor(() => {
        expect(window.location.pathname).toBe(paths.login);
      }, SLOW);
      expect(window.location.search).toBe("?reason=expired");
      expect(refreshCalls).toHaveLength(1);
      expect(readSession()).toBeNull();
      expect(window.localStorage.getItem(SESSION_STORAGE_KEY)).toBeNull();

      const notice = await screen.findByTestId(loginTestid.sessionExpired, undefined, SLOW);
      expect(notice.textContent).toContain(AUTH_NOTICES.sessionExpired);
    },
  );

  it("R194 a session with no refresh token is never renewed: a 401 goes to plain /login", async () => {
    window.localStorage.setItem(E2E_SESSION_STORAGE_KEY, JSON.stringify({ accessToken: "e2e-stale" }));
    const { refreshCalls } = serve({ me: () => UNAUTHORIZED, refresh: () => RENEWED });
    render(<App />);

    await waitFor(() => {
      expect(window.location.pathname).toBe(paths.login);
    }, SLOW);
    expect(window.location.search).toBe("");
    expect(refreshCalls).toHaveLength(0);
    await screen.findByTestId(loginTestid.submit, undefined, SLOW);
    expect(screen.queryByTestId(loginTestid.sessionExpired)).toBeNull();
  });

  it("R194 a fixture session near a nominal expiry is still never renewed", async () => {
    window.localStorage.setItem(
      E2E_SESSION_STORAGE_KEY,
      JSON.stringify({ accessToken: "e2e-token", refreshToken: null, expiresAt: Date.now() - 1_000 }),
    );
    const { refreshCalls } = serve({ me: () => ({ status: 200, body: meBody("active") }), refresh: () => RENEWED });
    renderGated();
    expect((await screen.findByTestId("opened", undefined, SLOW)).textContent).toBe("e2e-token");
    expect(refreshCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------
// B33: the redirect target, with no DOM in the way
// ---------------------------------------------------------------------------------------------

describe("R194 B33 where an ended session is sent", () => {
  it("R194 redirectFor sends an expired account to /login?reason=expired and a plain one to /login", () => {
    expect(redirectFor({ kind: "anonymous", reason: "expired" }, false)).toBe(loginPath({ reason: "expired" }));
    expect(redirectFor({ kind: "anonymous", reason: "expired" }, true)).toBe(loginPath({ reason: "expired" }));
    expect(redirectFor({ kind: "anonymous" }, false)).toBe(paths.login);
  });

  it("B33 loginPath puts only the reason or the mode in the query", () => {
    expect(loginPath()).toBe("/login");
    expect(loginPath({})).toBe("/login");
    expect(loginPath({ reason: "expired" })).toBe("/login?reason=expired");
    expect(loginPath({ mode: "forgot" })).toBe("/login?mode=forgot");
  });

  it("B33 loginReasonOf reads exactly expired, and nothing else", () => {
    expect(loginReasonOf("?reason=expired")).toBe("expired");
    expect(loginReasonOf("?reason=Expired")).toBeNull();
    expect(loginReasonOf("?reason=expired2")).toBeNull();
    expect(loginReasonOf("?reason=")).toBeNull();
    expect(loginReasonOf("")).toBeNull();
  });
});
