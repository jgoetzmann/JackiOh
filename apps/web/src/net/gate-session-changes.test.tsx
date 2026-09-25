// A session that changes under a request (docs/polish/5-sign-in.md, R194, after the second panel).
//
// A renewal is a round trip, and the device can sign out, or sign in as someone else, while it is
// out. A renewal must also hand back the same account it renewed: a refresh token answers with the
// session of whoever owns it, whatever access token came with it. And a page the browser restores
// from its back/forward cache must not keep showing an account that has since signed out. Asserted
// through the real modules over a stubbed `fetch`, with tokens whose payload carries a user id.

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AUTH_SESSION_REFRESH_MARGIN_SECONDS } from "../../../server/src/config.ts";
import { inviteTestid, shellTestid } from "../auth/testids.ts";
import { signOut } from "../routes/account.tsx";
import InviteRoute from "../routes/invite.tsx";
import { ApiRequestError } from "./api.ts";
import { callWithRenewal, renewAfterUnauthorized } from "./gate.ts";
import { paths } from "./navigate.ts";
import { SESSION_STORAGE_KEY, clearSession, readSession } from "./session.ts";

const { App } = await import("../main.tsx");

const URL_ = "https://project.supabase.co";
const KEY = "sb_publishable_test";
const API = "http://localhost:8787";
const SLOW = { timeout: 5_000 } as const;
// The budget for a test as a whole. Most tests below render the whole <App /> and then wait up to
// `SLOW` more than once, so vitest's default of 5 s for the entire test was smaller than the waits
// it holds, and under a loaded CI runner it ran out first.
const SLOW_TEST = { timeout: 30_000 } as const;

function base64url(text: string): string {
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** A token whose payload names a user id; the client reads it, the provider and server verify it. */
function tokenFor(sub: string, tag: string): string {
  return [base64url(JSON.stringify({ alg: "HS256" })), base64url(JSON.stringify({ sub, tag })), "sig"].join(".");
}

function jsonResponse(status: number, body?: unknown): Response {
  const text = body === undefined ? "" : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    headers: new Headers({ "content-type": "application/json" }),
    json: () => (text === "" ? Promise.reject(new SyntaxError("empty")) : Promise.resolve(JSON.parse(text))),
    text: () => Promise.resolve(text),
    clone: () => jsonResponse(status, body),
  } as unknown as Response;
}

function me(status: "pending" | "active", email = "player@example.test") {
  return {
    profile: { id: "profile-1", status, rating: 1000 },
    needsInviteCode: status === "pending",
    emailVerified: true,
    currentMatchId: null,
    email,
  };
}

const UNAUTHORIZED = jsonResponse(401, { error: { code: "unauthorized", message: "sign in first" } });

function store(accessToken: string, refreshToken: string, expiresAt: number): void {
  window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ accessToken, refreshToken, expiresAt }));
}

function tokens(accessToken: string, refreshToken: string) {
  return { access_token: accessToken, refresh_token: refreshToken, expires_in: 3600, token_type: "bearer" };
}

/** A refresh the test answers when it chooses, and every logout's bearer. */
function heldRefresh(): { answer: (body: unknown) => void; logouts: string[]; urls: string[] } {
  let resolve: (response: Response) => void = () => undefined;
  const answered = new Promise<Response>((done) => {
    resolve = done;
  });
  const logouts: string[] = [];
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: unknown, init?: RequestInit) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("grant_type=refresh_token")) return answered;
      if (url.includes("/auth/v1/logout")) {
        logouts.push(new Headers(init?.headers).get("authorization") ?? "");
        return Promise.resolve(jsonResponse(204));
      }
      return Promise.resolve(jsonResponse(404, {}));
    }),
  );
  return { answer: (body) => resolve(jsonResponse(200, body)), logouts, urls };
}

beforeEach(() => {
  vi.stubEnv("VITE_SUPABASE_URL", URL_);
  vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", KEY);
  window.localStorage.clear();
  window.sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("R194 a renewal the device outlived", () => {
  it("R194 signing out while a renewal is in flight leaves the device signed out, retries nothing, and revokes the renewal", async () => {
    const expired = tokenFor("user-x", "expired");
    const renewed = tokenFor("user-x", "renewed");
    store(expired, "rt-1", Date.now() - 60_000);
    const provider = heldRefresh();
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });

    // A screen's request came back 401, and the renewal is out.
    const renewal = renewAfterUnauthorized(expired);
    // The player signs out meanwhile (the code screen's button, or the gate's slow panel).
    signOut();
    expect(readSession()).toBeNull();
    provider.answer(tokens(renewed, "rt-2"));

    expect(await renewal).toEqual({ kind: "signedOut", expired: false });
    await vi.waitFor(() => {
      expect(assign).toHaveBeenCalledWith(paths.landing);
    });
    // Not written back over the sign-out: the landing page finds a signed-out device.
    expect(readSession()).toBeNull();
    // And the renewed session is revoked, not left live at the provider.
    await vi.waitFor(() => {
      expect(provider.logouts).toContain(`Bearer ${renewed}`);
    });
  });

  it("R194 a request is never retried after a sign-out: callWithRenewal reports it instead", async () => {
    const expired = tokenFor("user-x", "expired");
    store(expired, "rt-1", Date.now() - 60_000);
    const provider = heldRefresh();
    const call = vi.fn((token: string) =>
      token === expired
        ? Promise.reject(new ApiRequestError(401, { code: "unauthorized", message: "sign in first" }))
        : Promise.resolve("sent"),
    );

    const outcome = callWithRenewal(expired, call);
    await vi.waitFor(() => {
      expect(provider.urls.some((url) => url.includes("grant_type=refresh_token"))).toBe(true);
    });
    clearSession();
    provider.answer(tokens(tokenFor("user-x", "renewed"), "rt-2"));

    expect(await outcome).toEqual({ kind: "signedOut", expired: false });
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("R194 an account signed in in another tab while the renewal was out is not overwritten", async () => {
    const xExpired = tokenFor("user-x", "expired");
    const yLive = tokenFor("user-y", "live");
    store(xExpired, "x-rt-1", Date.now() - 60_000);
    const provider = heldRefresh();

    const renewal = renewAfterUnauthorized(xExpired);
    // Another tab signs out of X and signs in as Y.
    store(yLive, "y-rt", Date.now() + 3_600_000);
    provider.answer(tokens(tokenFor("user-x", "renewed"), "x-rt-2"));

    // The device is Y now, and nothing made for X is sent again as Y.
    expect(await renewal).toEqual({ kind: "switched" });
    expect(readSession()?.accessToken).toBe(yLive);
  });

  it("R194 a renewal written by another screen of the same account is used as it is", async () => {
    const xExpired = tokenFor("user-x", "expired");
    const xOther = tokenFor("user-x", "other-screen");
    store(xExpired, "x-rt-1", Date.now() - 60_000);
    const provider = heldRefresh();

    const renewal = renewAfterUnauthorized(xExpired);
    store(xOther, "x-rt-2", Date.now() + 3_600_000);
    provider.answer(tokens(tokenFor("user-x", "mine"), "x-rt-3"));

    expect(await renewal).toEqual({ kind: "renewed", token: xOther });
    expect(readSession()?.accessToken).toBe(xOther);
  });
});

describe("R194 a renewal must hand back the same account", SLOW_TEST, () => {
  it("R194 a stored token naming one user and a refresh token owned by another ends the session", async () => {
    // What a forged confirmation link would have left behind: an access token naming the victim,
    // and the attacker's real refresh token, which renews into the attacker's account.
    const forged = tokenFor("victim-user", "forged");
    const attacker = tokenFor("attacker-user", "attacker");
    store(forged, "attacker-real-refresh-token", Date.now() + 3_600_000);
    const logouts: string[] = [];
    const meTokens: (string | null)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: unknown, init?: RequestInit) => {
        const url = String(input);
        const bearer = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "") ?? null;
        if (url === `${API}/api/auth/me`) {
          meTokens.push(bearer);
          return Promise.resolve(bearer === attacker ? jsonResponse(200, me("pending", "attacker@evil.example")) : UNAUTHORIZED);
        }
        if (url.includes("grant_type=refresh_token")) {
          return Promise.resolve(jsonResponse(200, { ...tokens(attacker, "attacker-rotated"), user: { id: "attacker-user" } }));
        }
        if (url.includes("/auth/v1/logout")) {
          logouts.push(bearer ?? "");
          return Promise.resolve(jsonResponse(204));
        }
        return Promise.resolve(jsonResponse(404, {}));
      }),
    );
    window.history.replaceState(null, "", paths.invite);
    render(<App />);

    await waitFor(() => {
      expect(window.location.pathname).toBe(paths.login);
    }, SLOW);
    expect(window.location.search).toBe("?reason=expired");
    expect(readSession()).toBeNull();
    // The attacker's session was never used to read an account, and it is revoked.
    expect(meTokens).not.toContain(attacker);
    await waitFor(() => {
      expect(logouts).toContain(attacker);
    });
    expect(screen.queryByTestId(inviteTestid.accountEmail)).toBeNull();
  });
});

describe("R194 a page restored from the back/forward cache", SLOW_TEST, () => {
  it("R194 reads the account again, so a device signed out meanwhile is sent to sign in", async () => {
    window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ accessToken: "fixture-token" }));
    vi.stubGlobal(
      "fetch",
      vi.fn((input: unknown) => {
        const url = String(input);
        if (url === `${API}/api/auth/me`) return Promise.resolve(jsonResponse(200, me("pending")));
        if (url === `${API}/api/codes/status`) {
          return Promise.resolve(jsonResponse(200, { redemptionEnabled: true, retryAfterMs: 0, attemptsRemaining: 6 }));
        }
        return Promise.resolve(jsonResponse(404, {}));
      }),
    );
    window.history.replaceState(null, "", paths.invite);
    render(<App />);
    await screen.findByTestId(inviteTestid.accountEmail, undefined, SLOW);

    // Signed out, then the browser's Back button restores this very page from its cache: frozen,
    // it heard no storage event.
    clearSession();
    act(() => {
      window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted: true }));
    });

    await waitFor(() => {
      expect(window.location.pathname).toBe(paths.login);
    }, SLOW);
    expect(screen.queryByTestId(inviteTestid.submit)).toBeNull();
  });
});

describe("R194 the code screen's own status read", SLOW_TEST, () => {
  it("R194 a status read the API refuses as unauthorised is renewed and retried, and 'No tries left' is shown", async () => {
    const old = tokenFor("user-p", "old");
    const renewed = tokenFor("user-p", "new");
    store(old, "rt-1", Date.now() + 3_600_000);
    const refreshes: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: unknown, init?: RequestInit) => {
        const url = String(input);
        const bearer = new Headers(init?.headers).get("authorization");
        if (url === `${API}/api/auth/me`) return Promise.resolve(jsonResponse(200, me("pending")));
        if (url === `${API}/api/codes/status`) {
          return Promise.resolve(
            bearer === `Bearer ${renewed}`
              ? jsonResponse(200, { redemptionEnabled: true, retryAfterMs: 0, attemptsRemaining: 0, attemptsRetryAfterMs: 600_000 })
              : UNAUTHORIZED,
          );
        }
        if (url.includes("grant_type=refresh_token")) {
          refreshes.push(url);
          return Promise.resolve(jsonResponse(200, tokens(renewed, "rt-2")));
        }
        return Promise.resolve(jsonResponse(404, {}));
      }),
    );
    render(<InviteRoute />);

    const attempts = await screen.findByTestId(inviteTestid.attempts, undefined, SLOW);
    expect(attempts).toHaveAttribute("data-remaining", "0");
    expect(refreshes).toHaveLength(1);
    expect(screen.getByTestId(inviteTestid.submit)).toBeDisabled();
  });
});

describe("the code screen reads the account once", SLOW_TEST, () => {
  it("inside the app it uses the gate's read, so a slow second read cannot leave Redeem dead", async () => {
    window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ accessToken: "tok" }));
    let meCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: unknown) => {
        const url = String(input);
        if (url === `${API}/api/auth/me`) {
          meCalls += 1;
          // The gate's read answers; any further read would hang on a stalled network.
          return meCalls === 1 ? Promise.resolve(jsonResponse(200, me("pending"))) : new Promise<Response>(() => {});
        }
        if (url === `${API}/api/codes/status`) {
          return Promise.resolve(jsonResponse(200, { redemptionEnabled: true, retryAfterMs: 0, attemptsRemaining: 6 }));
        }
        return new Promise<Response>(() => {});
      }),
    );
    window.history.replaceState(null, "", paths.invite);
    render(<App />);

    expect(await screen.findByTestId(inviteTestid.accountEmail, undefined, SLOW)).toHaveTextContent(
      "player@example.test",
    );
    expect(await screen.findByTestId(inviteTestid.attempts, undefined, SLOW)).toHaveAttribute("data-remaining", "6");
    expect(meCalls).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
// A re-read in the background keeps the open screen (the third panel round)
// ---------------------------------------------------------------------------------------------

/** A token of one provider session: `session_id` is what tells a renewal from a new sign-in. */
function sessionToken(sub: string, sessionId: string, tag: string): string {
  return [
    base64url(JSON.stringify({ alg: "HS256" })),
    base64url(JSON.stringify({ sub, session_id: sessionId, tag })),
    "sig",
  ].join(".");
}

/** What another tab's write to the session key looks like from here. */
function otherTabWrote(): void {
  window.dispatchEvent(new StorageEvent("storage", { key: SESSION_STORAGE_KEY }));
}

/** One socket opened; `drop` ends it the way a network blip does (not a close this side asked for). */
type FakeSocket = { url: string; closed: boolean; drop: () => void };

/** A WebSocket that records each one opened and whether it was closed. */
function fakeSockets(): FakeSocket[] {
  const sockets: FakeSocket[] = [];
  class FakeWebSocket {
    readyState = 0;
    onopen: ((event: unknown) => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onclose: ((event: { code: number; reason: string; wasClean: boolean }) => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    private readonly record: FakeSocket;
    constructor(url: string) {
      this.record = {
        url,
        closed: false,
        drop: () => {
          this.readyState = 3;
          this.onclose?.({ code: 1006, reason: "", wasClean: false });
        },
      };
      sockets.push(this.record);
    }
    send(): void {}
    close(): void {
      this.record.closed = true;
      this.readyState = 3;
    }
  }
  vi.stubGlobal("WebSocket", FakeWebSocket);
  return sockets;
}

function activeMe(currentMatchId: string | null = "m-1") {
  return { ...me("active"), currentMatchId };
}

describe("R194 a re-read in the background keeps the open screen", SLOW_TEST, () => {
  it("R194 another tab's renewal of the same session does not close and reopen an in-progress match socket", async () => {
    const first = sessionToken("user-x", "session-1", "first");
    const renewed = sessionToken("user-x", "session-1", "renewed");
    store(first, "rt-1", Date.now() + 3_600_000);
    const sockets = fakeSockets();
    vi.stubGlobal(
      "fetch",
      vi.fn((input: unknown) =>
        Promise.resolve(String(input) === `${API}/api/auth/me` ? jsonResponse(200, activeMe()) : jsonResponse(404, {})),
      ),
    );
    window.history.replaceState(null, "", paths.match("m-1"));
    render(<App />);
    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    }, SLOW);

    // Another tab renewed the (still good) session and wrote it.
    store(renewed, "rt-2", Date.now() + 3_600_000);
    await act(async () => {
      otherTabWrote();
      await new Promise((resolve) => setTimeout(resolve, 100));
    });

    expect(sockets.map((socket) => ({ first: socket.url.includes(first), closed: socket.closed }))).toEqual([
      { first: true, closed: false },
    ]);
  });

  it("R194 the gate's own renewal during a match keeps the socket open, and the next reconnect carries the new token", async () => {
    const first = sessionToken("user-x", "session-1", "first");
    const renewed = sessionToken("user-x", "session-1", "renewed");
    // Due for renewal a moment after the match screen opens.
    store(first, "rt-1", Date.now() + AUTH_SESSION_REFRESH_MARGIN_SECONDS * 1000 + 400);
    const sockets = fakeSockets();
    const refreshes: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: unknown) => {
        const url = String(input);
        if (url.includes("grant_type=refresh_token")) {
          refreshes.push(url);
          return Promise.resolve(jsonResponse(200, tokens(renewed, "rt-2")));
        }
        return Promise.resolve(url === `${API}/api/auth/me` ? jsonResponse(200, activeMe()) : jsonResponse(404, {}));
      }),
    );
    window.history.replaceState(null, "", paths.match("m-1"));
    render(<App />);
    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    }, SLOW);

    // The gate renews and hands the new token down.
    await waitFor(() => {
      expect(readSession()?.accessToken).toBe(renewed);
    }, SLOW);
    expect(refreshes).toHaveLength(1);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    // The socket that was up stays up: the opponent sees no disconnect.
    expect(sockets.map((socket) => ({ first: socket.url.includes(first), closed: socket.closed }))).toEqual([
      { first: true, closed: false },
    ]);

    // A later drop reconnects with the renewed token, not the one that is about to expire.
    act(() => {
      sockets[0]?.drop();
    });
    await waitFor(() => {
      expect(sockets).toHaveLength(2);
    }, SLOW);
    expect(sockets[1]?.url.includes(renewed)).toBe(true);
  });

  it("R194 a NEW session of the same account (a sign-in elsewhere revoked this one) is handed down", async () => {
    const first = sessionToken("user-x", "session-1", "first");
    const next = sessionToken("user-x", "session-2", "signed-in-again");
    store(first, "rt-1", Date.now() + 3_600_000);
    const sockets = fakeSockets();
    vi.stubGlobal(
      "fetch",
      vi.fn((input: unknown) =>
        Promise.resolve(String(input) === `${API}/api/auth/me` ? jsonResponse(200, activeMe()) : jsonResponse(404, {})),
      ),
    );
    window.history.replaceState(null, "", paths.match("m-1"));
    render(<App />);
    await waitFor(() => {
      expect(sockets).toHaveLength(1);
    }, SLOW);

    store(next, "rt-9", Date.now() + 3_600_000);
    act(() => {
      otherTabWrote();
    });

    await waitFor(() => {
      expect(sockets.at(-1)?.url.includes(next)).toBe(true);
    }, SLOW);
  });

  it("R194 a re-read that fails after another tab's write leaves the code screen, and the typed code, in place", async () => {
    const first = sessionToken("user-x", "session-1", "first");
    store(first, "rt-1", Date.now() + 3_600_000);
    let meCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: unknown) => {
        const url = String(input);
        if (url === `${API}/api/auth/me`) {
          meCalls += 1;
          // The first read works; the re-read after another tab's write hits a blip.
          return Promise.resolve(
            meCalls === 1
              ? jsonResponse(200, me("pending"))
              : jsonResponse(502, { error: { code: "internal", message: "bad gateway" } }),
          );
        }
        if (url === `${API}/api/codes/status`) {
          return Promise.resolve(jsonResponse(200, { redemptionEnabled: true, retryAfterMs: 0, attemptsRemaining: 6 }));
        }
        return Promise.resolve(jsonResponse(404, {}));
      }),
    );
    window.history.replaceState(null, "", paths.invite);
    render(<App />);
    const field = await screen.findByTestId(inviteTestid.input, undefined, SLOW);
    act(() => {
      field.focus();
    });
    fireEvent.change(field, { target: { value: "ABCDEFGHJKMN" } });
    expect(screen.getByTestId(inviteTestid.input)).toHaveValue("ABCD-EFGH-JKMN");

    store(sessionToken("user-x", "session-1", "renewed"), "rt-2", Date.now() + 3_600_000);
    await act(async () => {
      otherTabWrote();
      await new Promise((resolve) => setTimeout(resolve, 100));
    });

    expect(meCalls).toBe(2);
    expect(screen.queryByTestId(shellTestid.error)).toBeNull();
    expect(screen.getByTestId(inviteTestid.input)).toHaveValue("ABCD-EFGH-JKMN");
  });

  it("R194 a re-read that fails after the device moved to ANOTHER account does not keep the old account's screen", async () => {
    store(sessionToken("user-x", "session-1", "first"), "rt-1", Date.now() + 3_600_000);
    let meCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((input: unknown) => {
        const url = String(input);
        if (url === `${API}/api/auth/me`) {
          meCalls += 1;
          return Promise.resolve(
            meCalls === 1
              ? jsonResponse(200, me("pending"))
              : jsonResponse(502, { error: { code: "internal", message: "bad gateway" } }),
          );
        }
        if (url === `${API}/api/codes/status`) {
          return Promise.resolve(jsonResponse(200, { redemptionEnabled: true, retryAfterMs: 0, attemptsRemaining: 6 }));
        }
        return Promise.resolve(jsonResponse(404, {}));
      }),
    );
    window.history.replaceState(null, "", paths.invite);
    render(<App />);
    await screen.findByTestId(inviteTestid.input, undefined, SLOW);

    // Another tab signed in as someone else.
    store(sessionToken("user-y", "session-9", "someone-else"), "rt-9", Date.now() + 3_600_000);
    act(() => {
      otherTabWrote();
    });

    expect(await screen.findByTestId(shellTestid.error, undefined, SLOW)).toBeInTheDocument();
    expect(screen.queryByTestId(inviteTestid.input)).toBeNull();
  });
});

describe("R194 the token an open screen holds is kept fresh", SLOW_TEST, () => {
  it("R194 the gate renews before the token expires, so /play's match watch finds the match it was paired into", async () => {
    const old = sessionToken("user-p", "session-1", "old");
    const renewed = sessionToken("user-p", "session-1", "new");
    // The token the gate hands /play expires a moment after the renewal margin begins.
    store(old, "rt-1", Date.now() + AUTH_SESSION_REFRESH_MARGIN_SECONDS * 1000 + 300);
    const refreshes: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: unknown, init?: RequestInit) => {
        const url = String(input);
        const bearer = new Headers(init?.headers).get("authorization");
        if (url.includes("grant_type=refresh_token")) {
          refreshes.push(url);
          return Promise.resolve(jsonResponse(200, tokens(renewed, "rt-2")));
        }
        if (url === `${API}/api/auth/me`) {
          // Paired while waiting: only a read made with the renewed token is after the pairing.
          return Promise.resolve(jsonResponse(200, activeMe(bearer === `Bearer ${renewed}` ? "m-9" : null)));
        }
        return Promise.resolve(jsonResponse(404, {}));
      }),
    );
    window.history.replaceState(null, "", paths.play);
    render(<App />);

    await waitFor(() => {
      expect(window.location.pathname).toBe(paths.match("m-9"));
    }, SLOW);
    expect(refreshes).toHaveLength(1);
    expect(readSession()?.accessToken).toBe(renewed);
  });

  it("R194 a tab that slept past the renewal point renews the moment it is shown again", async () => {
    const old = sessionToken("user-p", "session-1", "old");
    const renewed = sessionToken("user-p", "session-1", "new");
    const start = Date.now();
    store(old, "rt-1", start + 3_600_000);
    const refreshes: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: unknown) => {
        const url = String(input);
        if (url.includes("grant_type=refresh_token")) {
          refreshes.push(url);
          return Promise.resolve(jsonResponse(200, tokens(renewed, "rt-2")));
        }
        if (url === `${API}/api/auth/me`) return Promise.resolve(jsonResponse(200, activeMe(null)));
        return Promise.resolve(jsonResponse(404, {}));
      }),
    );
    window.history.replaceState(null, "", paths.play);
    render(<App />);
    await screen.findByTestId("play-queue", undefined, SLOW);
    expect(refreshes).toHaveLength(0);

    // The phone slept (its timers frozen) and is unlocked just before the token runs out.
    vi.spyOn(Date, "now").mockReturnValue(start + 3_600_000 - 1_000);
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });

    await waitFor(() => {
      expect(refreshes).toHaveLength(1);
    }, SLOW);
    await waitFor(() => {
      expect(readSession()?.accessToken).toBe(renewed);
    }, SLOW);
  });
});
