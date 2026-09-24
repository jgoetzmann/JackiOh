// The shell's gate after the adversarial panel (docs/polish/5-sign-in.md, B40, R193, R194): one gate
// per screen, so a move re-reads the account; a check that runs long offers a way out; the error
// panel speaks plainly and waits out a stated rate limit; and an emailed link that lands on any path
// is scrubbed and handed to `/login`.
//
// Asserted through the real `App` from `main.tsx` (loaded with `await import`, because main.tsx
// mounts itself outside vitest), a session in localStorage and a stubbed `fetch`.

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  API_REQUEST_TIMEOUT_SECONDS,
  CODE_ALPHABET,
  GATE_SLOW_NOTICE_SECONDS,
  INVITE_CODE_GROUP_SIZE,
  INVITE_CODE_LENGTH,
  INVITE_CODE_SEPARATOR,
} from "../../../server/src/config.ts";
import { clearConsumedAuthRedirect } from "../auth/redirect.ts";
import { inviteTestid, landingTestid, loginTestid, shellTestid } from "../auth/testids.ts";
import { API_UNREACHABLE_MESSAGE } from "../net/api.ts";
import { paths } from "../net/navigate.ts";
import { RETURN_TO_STORAGE_KEY, rememberReturnTo, takeReturnTo } from "../net/return-to.ts";
import { SESSION_STORAGE_KEY } from "../net/session.ts";
import { accountTestid } from "./account.tsx";

const { App } = await import("../main.tsx");

const API = "http://localhost:8787";
const SLOW = { timeout: 5_000 } as const;

const LETTERS = CODE_ALPHABET.replace(/[0-9]/g, "");
function grouped(characters: string): string {
  const groups: string[] = [];
  for (let i = 0; i < characters.length; i += INVITE_CODE_GROUP_SIZE) {
    groups.push(characters.slice(i, i + INVITE_CODE_GROUP_SIZE));
  }
  return groups.join(INVITE_CODE_SEPARATOR);
}
const GOOD = grouped(LETTERS.slice(0, INVITE_CODE_LENGTH));

function json(status: number, body?: unknown): Response {
  const text = body === undefined ? "" : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: String(status),
    headers: new Headers({ "content-type": "application/json" }),
    json: () => (text === "" ? Promise.reject(new SyntaxError("empty")) : Promise.resolve(JSON.parse(text))),
    text: () => Promise.resolve(text),
  } as unknown as Response;
}

function me(status: "pending" | "active") {
  return {
    profile: { id: "p1", status, rating: 1000 },
    needsInviteCode: status === "pending",
    emailVerified: true,
    currentMatchId: null,
    email: "player@example.test",
  };
}

/** Answers by URL; "hang" never answers. */
function stubFetch(answer: (url: string) => Response | "hang" | "reject"): string[] {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: unknown) => {
      const url = typeof input === "string" ? input : String(input);
      urls.push(url);
      const reply = answer(url);
      if (reply === "hang") return new Promise<Response>(() => {});
      if (reply === "reject") return Promise.reject(new TypeError("Failed to fetch"));
      return Promise.resolve(reply);
    }),
  );
  return urls;
}

function at(path: string): void {
  window.history.replaceState(null, "", path);
}

async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    for (let tick = 0; tick < 50; tick += 1) await Promise.resolve();
  });
}

beforeEach(() => {
  window.localStorage.clear();
  clearConsumedAuthRedirect();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  clearConsumedAuthRedirect();
});

describe("B40 one gate per screen", () => {
  it("B40 a successful redemption on /invite says so, and its way on lands on /decks and stays there", async () => {
    window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ accessToken: "tok" }));
    let redeemed = false;
    stubFetch((url) => {
      if (url === `${API}/api/auth/me`) return json(200, me(redeemed ? "active" : "pending"));
      if (url === `${API}/api/codes/status`) {
        return json(200, { redemptionEnabled: true, retryAfterMs: 0, attemptsRemaining: 6 });
      }
      if (url === `${API}/api/codes/redeem`) {
        redeemed = true;
        return json(200, { status: "active", needsInviteCode: false });
      }
      return "hang"; // whatever /decks reads
    });
    at(paths.invite);
    render(<App />);

    fireEvent.change(await screen.findByTestId(inviteTestid.input, undefined, SLOW), { target: { value: GOOD } });
    const submit = screen.getByTestId(inviteTestid.submit);
    await waitFor(() => {
      expect(submit).toBeEnabled();
    }, SLOW);
    fireEvent.click(submit);

    // The screen says the code worked, then the player takes the way on.
    fireEvent.click(await screen.findByTestId(inviteTestid.goToDecks, undefined, SLOW));
    await waitFor(() => {
      expect(window.location.pathname).toBe(paths.decks);
    }, SLOW);
    // The gate on /decks read the account afresh: active, so it does not bounce back.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(window.location.pathname).toBe(paths.decks);
  });

  it("B40 after a sign-out in another tab, the next move to a gated screen is gated again", async () => {
    window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ accessToken: "tok" }));
    stubFetch((url) => {
      if (url === `${API}/api/auth/me`) return json(200, me("active"));
      return "hang";
    });
    at(paths.decks);
    render(<App />);
    await waitFor(() => {
      expect(screen.queryByTestId(shellTestid.loading)).toBeNull();
    }, SLOW);

    // localStorage is shared between tabs: the other tab's sign-out cleared it here too.
    window.localStorage.clear();
    window.history.pushState(null, "", paths.account);
    window.dispatchEvent(new PopStateEvent("popstate"));

    await waitFor(() => {
      expect(window.location.pathname).toBe(paths.login);
    }, SLOW);
  });

  it("B40 a sign-out in another tab sends a screen that is already open to sign-in", async () => {
    window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ accessToken: "tok" }));
    stubFetch((url) => (url === `${API}/api/auth/me` ? json(200, me("active")) : "hang"));
    at(paths.decks);
    render(<App />);
    await waitFor(() => {
      expect(screen.queryByTestId(shellTestid.loading)).toBeNull();
    }, SLOW);

    window.localStorage.removeItem(SESSION_STORAGE_KEY);
    // What the browser fires in THIS tab when another one changes the shared storage.
    window.dispatchEvent(new StorageEvent("storage", { key: SESSION_STORAGE_KEY, newValue: null }));

    await waitFor(() => {
      expect(window.location.pathname).toBe(paths.login);
    }, SLOW);
  });
});

describe("B40 a check that runs long", () => {
  it("B40 'Checking your account…' offers home and sign-out once it has taken a while, and says why", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ accessToken: "tok" }));
    stubFetch(() => "hang");
    at(paths.decks);
    render(<App />);
    await flushMicrotasks();
    // The lazy route has loaded; the gate is waiting on /api/auth/me.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(screen.getByTestId(shellTestid.loading).textContent).toBe("Checking your account…");
    expect(screen.queryByTestId(shellTestid.home)).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(GATE_SLOW_NOTICE_SECONDS * 1000);
    });
    expect(screen.getByTestId(shellTestid.slow)).toBeInTheDocument();
    expect(screen.getByTestId(shellTestid.home)).toHaveAttribute("href", paths.landing);
    expect(screen.getByTestId(shellTestid.signOut)).toBeInTheDocument();
  });

  it("B40 a server that never answers turns into the error panel with its retry", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ accessToken: "tok" }));
    stubFetch(() => "hang");
    at(paths.decks);
    render(<App />);
    await flushMicrotasks();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(API_REQUEST_TIMEOUT_SECONDS * 1000);
    });
    await flushMicrotasks();

    expect(screen.getByTestId(shellTestid.error).textContent).toBe(API_UNREACHABLE_MESSAGE);
    expect(screen.getByTestId(shellTestid.retry)).toBeEnabled();
  });
});

describe("B40 the gate's error panel", () => {
  it("B40 says a transport failure in a plain sentence, not the browser's words", async () => {
    window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ accessToken: "tok" }));
    stubFetch(() => "reject");
    at(paths.invite);
    render(<App />);
    const panel = await screen.findByTestId(shellTestid.error, undefined, SLOW);
    expect(panel.textContent).toBe(API_UNREACHABLE_MESSAGE);
    expect(panel.textContent).not.toMatch(/Failed to fetch|could not be reached:/);
  });

  it("R192 the wait is counted on the clock: a tab asleep past it offers the retry on its next tick", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ accessToken: "tok" }));
    stubFetch((url) =>
      url === `${API}/api/auth/me`
        ? json(429, { error: { code: "rate_limited", message: "slow down", details: { retryAfterMs: 42_000 } } })
        : "hang",
    );
    at(paths.account);
    render(<App />);
    await screen.findByTestId(shellTestid.error, undefined, SLOW);
    expect(screen.getByTestId(shellTestid.retry)).toBeDisabled();

    // A phone freezes a background tab's timers: the clock moves on, one tick arrives on return.
    vi.setSystemTime(Date.now() + 120_000);
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.getByTestId(shellTestid.retry)).toBeEnabled();
  });

  it("R192 counts down a rate limit's stated wait before it offers to try again", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ accessToken: "tok" }));
    let limited = true;
    stubFetch((url) => {
      if (url !== `${API}/api/auth/me`) return "hang";
      return limited
        ? json(429, {
            error: { code: "rate_limited", message: "too many requests; slow down", details: { retryAfterMs: 42_000 } },
          })
        : json(200, me("active"));
    });
    at(paths.account);
    render(<App />);

    const panel = await screen.findByTestId(shellTestid.error, undefined, SLOW);
    expect(panel.textContent).toMatch(/42 s/);
    expect(panel.textContent).not.toContain("too many requests; slow down");
    expect(screen.getByTestId(shellTestid.retry)).toBeDisabled();

    act(() => {
      vi.advanceTimersByTime(42_000);
    });
    const retry = screen.getByTestId(shellTestid.retry);
    expect(retry).toBeEnabled();
    limited = false;
    fireEvent.click(retry);
    await waitFor(() => {
      expect(screen.queryByTestId(shellTestid.error)).toBeNull();
    }, SLOW);
  });
});

describe("R193 an emailed link that lands anywhere but /login", () => {
  function unsignedJwt(payload: Record<string, unknown>): string {
    const part = (value: unknown): string =>
      btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return `${part({ alg: "HS256" })}.${part(payload)}.unsigned`;
  }

  it("R193 is scrubbed from the address bar before anything renders and handed to /login", async () => {
    stubFetch(() => "hang");
    const token = unsignedJwt({ sub: "user-1", email: "invited@example.test" });
    at(`/#access_token=${token}&refresh_token=live-refresh&expires_in=3600&type=invite`);
    render(<App />);

    expect(window.location.href).not.toContain(token);
    expect(window.location.href).not.toContain("live-refresh");
    expect(window.location.pathname).toBe(paths.login);
    // `/login` asks the server whose token it is before the link decides anything; until then
    // nothing is stored and nothing is filled in.
    expect(await screen.findByTestId(loginTestid.checkingLink, undefined, SLOW)).toBeInTheDocument();
    expect(window.localStorage.getItem(SESSION_STORAGE_KEY)).toBeNull();
    expect(screen.getByTestId(loginTestid.email)).toHaveValue("");
  });

  it("R193 a dashboard invite link opens the forgot form, never 'sign in', and fills in nothing", async () => {
    const token = unsignedJwt({ sub: "user-1", email: "invited@example.test" });
    stubFetch((url) =>
      url === `${API}/api/auth/me` ? json(200, { ...me("pending"), email: "invited@example.test" }) : "hang",
    );
    at(`/#access_token=${token}&refresh_token=live-refresh&expires_in=3600&type=invite`);
    render(<App />);

    expect(await screen.findByTestId(loginTestid.invited, undefined, SLOW)).toBeInTheDocument();
    expect(screen.getByTestId(loginTestid.form)).toHaveAttribute("data-mode", "forgot");
    // A link can be anyone's: its address, filled in, would arm the reset guard at one click.
    expect(screen.getByTestId(loginTestid.email)).toHaveValue("");
    expect(screen.queryByTestId(loginTestid.confirmed)).toBeNull();
    expect(window.localStorage.getItem(SESSION_STORAGE_KEY)).toBeNull();
  });

  it("R193 a link on /login itself is scrubbed before the lazily loaded screen has rendered", () => {
    stubFetch(() => "hang");
    const token = unsignedJwt({ sub: "user-1", email: "player@example.test" });
    at(`/login#access_token=${token}&refresh_token=live-refresh&expires_in=3600&type=signup`);
    render(<App />);
    // First render: the chunk is still loading, and the tokens are already gone.
    expect(window.location.href).not.toContain("live-refresh");
    expect(window.location.href).not.toContain(token);
    expect(window.location.pathname).toBe(paths.login);
  });

  it("R193 a link error on another path is scrubbed and shown on /login too", async () => {
    stubFetch(() => "hang");
    at("/decks?error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid");
    render(<App />);
    expect(window.location.href).not.toContain("otp_expired");
    expect(await screen.findByTestId(loginTestid.linkError, undefined, SLOW)).toBeInTheDocument();
  });
});

describe("B35 a sign-in goes back to the gated screen that sent the player to it", () => {
  const SIGNED_IN = {
    access_token: "a",
    refresh_token: "r",
    expires_at: 2_000_000_000,
    user: { email_confirmed_at: "2026-09-20T00:00:00Z" },
  };

  beforeEach(() => {
    vi.stubEnv("VITE_SUPABASE_URL", "https://project.supabase.co");
    vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test");
    window.sessionStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    window.sessionStorage.clear();
  });

  it("B35 'Play online' while signed out: /play, sign in, and back on /play", async () => {
    stubFetch((url) => {
      if (url.includes("/auth/v1/token")) return json(200, SIGNED_IN);
      if (url === `${API}/api/auth/me`) return json(200, me("active"));
      return "hang";
    });
    at(paths.play);
    render(<App />);
    await screen.findByTestId(loginTestid.form, undefined, SLOW);
    expect(window.location.pathname).toBe(paths.login);

    fireEvent.change(screen.getByTestId(loginTestid.email), { target: { value: "player@example.test" } });
    fireEvent.change(screen.getByTestId(loginTestid.password), { target: { value: "secret-1" } });
    fireEvent.submit(screen.getByTestId(loginTestid.form));
    await waitFor(() => {
      expect(window.location.pathname).toBe(paths.play);
    }, SLOW);
    // Read once: a later sign-in in this tab starts from the default again.
    expect(window.sessionStorage.getItem(RETURN_TO_STORAGE_KEY)).toBeNull();
  });

  it.each([
    ["a URL", "https://evil.example/play"],
    ["a match route, whose id is data", "/match/some-id"],
    ["a path that is not gated", "/reset-password"],
  ] as const)("B35 a destination planted in storage (%s) is never followed: the sign-in lands on /decks", async (_name, planted) => {
    stubFetch((url) => {
      if (url.includes("/auth/v1/token")) return json(200, SIGNED_IN);
      if (url === `${API}/api/auth/me`) return json(200, me("active"));
      return "hang";
    });
    window.sessionStorage.setItem(RETURN_TO_STORAGE_KEY, planted);
    at(paths.login);
    render(<App />);
    await screen.findByTestId(loginTestid.form, undefined, SLOW);
    fireEvent.change(screen.getByTestId(loginTestid.email), { target: { value: "player@example.test" } });
    fireEvent.change(screen.getByTestId(loginTestid.password), { target: { value: "secret-1" } });
    fireEvent.submit(screen.getByTestId(loginTestid.form));
    await waitFor(() => {
      expect(window.location.pathname).not.toBe(paths.login);
    }, SLOW);
    expect(window.location.pathname).toBe(paths.decks);
  });

  it("B35 only fixed gated paths are remembered at all", () => {
    rememberReturnTo("https://evil.example");
    expect(takeReturnTo()).toBeNull();
    rememberReturnTo(paths.invite);
    expect(takeReturnTo()).toBe(paths.invite);
    expect(takeReturnTo()).toBeNull();
  });
});

describe("a pending account's account screen", () => {
  it("shows the address and status from the gate's read, and the way to the code screen", async () => {
    window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ accessToken: "tok" }));
    const urls = stubFetch((url) => {
      if (url === `${API}/api/auth/me`) return json(200, me("pending"));
      // What the server answers a pending account: /api/profile is `auth: "active"`.
      if (url === `${API}/api/profile`) {
        return json(403, { error: { code: "account_pending", message: "redeem an invite code to activate this account" } });
      }
      return "hang";
    });
    at(paths.account);
    render(<App />);

    expect((await screen.findByTestId(accountTestid.email, undefined, SLOW)).textContent).toBe("player@example.test");
    expect(screen.getByTestId(accountTestid.status).textContent).toBe("Waiting for an invite code");
    expect(screen.getByTestId(accountTestid.status)).toHaveAttribute("data-status", "pending");
    expect(screen.queryByTestId(accountTestid.error)).toBeNull();
    expect(screen.queryByTestId(accountTestid.loading)).toBeNull();
    expect(urls).not.toContain(`${API}/api/profile`);
    const redeem = screen.getByTestId(accountTestid.redeem);
    expect(redeem).toHaveAttribute("href", paths.invite);
    fireEvent.click(redeem);
    await waitFor(() => {
      expect(window.location.pathname).toBe(paths.invite);
    });
    expect(await screen.findByTestId(inviteTestid.input, undefined, SLOW)).toBeInTheDocument();
  });
});

describe("the landing page's corner while a sleeping server wakes", () => {
  it.each([
    ["a stored session", true, landingTestid.account],
    ["no session", false, landingTestid.signIn],
  ] as const)("with %s, offers its link after GATE_SLOW_NOTICE_SECONDS without waiting for /api/auth/me", async (_name, stored, link) => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    if (stored) {
      window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ accessToken: "tok", refreshToken: "r", expiresAt: 4_000_000_000_000 }));
    }
    stubFetch(() => "hang");
    at(paths.landing);
    render(<App />);
    await screen.findByTestId(landingTestid.root, undefined, SLOW);
    if (stored) {
      // A beat first, rather than flashing a link at an account that is still being read.
      expect(screen.queryByTestId(landingTestid.account)).toBeNull();
      expect(screen.queryByTestId(landingTestid.signIn)).toBeNull();
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(GATE_SLOW_NOTICE_SECONDS * 1000);
    });
    expect(screen.getByTestId(link)).toBeInTheDocument();
  });
});

describe("the code screen when the device moves to another account", () => {
  function tokenFor(sub: string): string {
    const part = (value: unknown): string =>
      btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return `${part({ alg: "HS256" })}.${part({ sub })}.sig`;
  }

  it("after another tab signs B in over A, /invite starts again for B: none of A's rate limit, refusal or code", async () => {
    const a = tokenFor("user-a");
    const b = tokenFor("user-b");
    window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ accessToken: a }));
    vi.stubGlobal(
      "fetch",
      vi.fn((input: unknown, init?: RequestInit) => {
        const url = String(input);
        const isA = (new Headers(init?.headers).get("authorization") ?? "") === `Bearer ${a}`;
        const account = (id: string, email: string) => ({ ...me("pending"), profile: { id, status: "pending", rating: 1000 }, email });
        if (url === `${API}/api/auth/me`) {
          return Promise.resolve(json(200, isA ? account("a", "a@example.test") : account("b", "b@example.test")));
        }
        if (url === `${API}/api/codes/status`) {
          return Promise.resolve(json(200, { redemptionEnabled: true, retryAfterMs: 0, attemptsRemaining: isA ? 1 : 6 }));
        }
        if (url === `${API}/api/codes/redeem`) {
          return Promise.resolve(
            json(429, { error: { code: "rate_limited", message: "Too many tries.", details: { retryAfterMs: 3_600_000 } } }),
          );
        }
        return new Promise<Response>(() => {});
      }),
    );
    at(paths.invite);
    render(<App />);
    const field = await screen.findByTestId(inviteTestid.input, undefined, SLOW);
    fireEvent.change(field, { target: { value: GOOD } });
    await waitFor(() => {
      expect(screen.getByTestId(inviteTestid.submit)).toBeEnabled();
    });
    fireEvent.click(screen.getByTestId(inviteTestid.submit));
    await screen.findByTestId(inviteTestid.rateLimited);

    // Another tab signs B in over A: one storage event here.
    await act(async () => {
      window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ accessToken: b }));
      window.dispatchEvent(new StorageEvent("storage", { key: SESSION_STORAGE_KEY }));
    });
    await waitFor(() => {
      expect(screen.getByTestId(inviteTestid.accountEmail)).toHaveTextContent("b@example.test");
    });
    expect(screen.queryByTestId(inviteTestid.rateLimited)).toBeNull();
    expect(screen.queryByTestId(inviteTestid.error)).toBeNull();
    expect(screen.getByTestId(inviteTestid.input)).toHaveValue("");
    await waitFor(() => {
      expect(screen.getByTestId(inviteTestid.attempts)).toHaveAttribute("data-remaining", "6");
    });
    fireEvent.change(screen.getByTestId(inviteTestid.input), { target: { value: GOOD } });
    expect(screen.getByTestId(inviteTestid.submit)).toBeEnabled();
  });
});
