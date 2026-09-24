// No dead ends in the shell (docs/polish/5-sign-in.md, B40). The gate's error panel offers a retry
// that re-reads `/api/auth/me` without a reload, a way home and a way to sign out. The banned panel
// offers home and sign-out, and the 404 panel offers home.
//
// Asserted through the real modules, as routes/gate.test.tsx does: `App` and `Gated` from
// `main.tsx` (loaded with `await import`, because main.tsx mounts itself outside vitest), a session
// in localStorage, `/api/auth/me` over a stubbed `fetch`, and the URL and storage as the answer.
//
// Every session here is an e2e fixture session with no refresh token, so no renewal (R194) runs
// and the gate's panels are what the server's answer alone decides.
//
// A home exit may be a link (`<a href="/">`) or a button that navigates. Both are a way home, and
// jsdom follows neither a link's default action nor `location.assign`, so `expectLeadsTo` accepts
// either shape and checks where it goes.

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { inviteTestid, landingTestid, shellTestid } from "../auth/testids.ts";
import { paths } from "../net/navigate.ts";
import { E2E_SESSION_STORAGE_KEY, SESSION_STORAGE_KEY } from "../net/session.ts";

const main = await import("../main.tsx");
const { App, Gated } = main;

const SUPABASE_URL = "https://project.supabase.co";
const SUPABASE_KEY = "sb_publishable_test";
const TOKEN = "e2e-token-shell";

/** A lazily loaded route plus a stubbed round trip can outrun the 1 s default under load. */
const SLOW = { timeout: 5_000 } as const;

// ---------------------------------------------------------------------------------------------
// the stubbed server
// ---------------------------------------------------------------------------------------------

type MeAnswer = "active" | "pending" | "banned" | "unauthorized" | "failing" | "unreachable";

/** What `/api/auth/me` answers right now. A test flips it before pressing retry. */
let meAnswer: MeAnswer = "active";
let meCalls = 0;

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

function meBody(status: "pending" | "active" | "banned") {
  return {
    profile: { id: "profile-1", status, rating: 1000 },
    needsInviteCode: status === "pending",
    emailVerified: true,
    currentMatchId: null,
    email: "player@example.test",
  };
}

function meReply(): Promise<Response> {
  switch (meAnswer) {
    case "unreachable":
      return Promise.reject(new TypeError("Failed to fetch"));
    case "failing":
      return Promise.resolve(
        jsonResponse(500, { error: { code: "internal", message: "the server fell over" } }),
      );
    case "unauthorized":
      return Promise.resolve(jsonResponse(401, { error: { code: "unauthorized", message: "sign in first" } }));
    default:
      return Promise.resolve(jsonResponse(200, meBody(meAnswer)));
  }
}

function serve(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: unknown) => {
      const url = typeof input === "string" ? input : String((input as URL).href ?? input);
      if (url.endsWith("/api/auth/me")) {
        meCalls += 1;
        return meReply();
      }
      if (url.endsWith("/api/codes/status")) {
        return Promise.resolve(
          jsonResponse(200, { redemptionEnabled: true, retryAfterMs: 0, attemptsRemaining: 5 }),
        );
      }
      if (url.endsWith("/api/catalog")) return Promise.resolve(jsonResponse(200, { version: "v1", defs: {} }));
      if (url.endsWith("/api/loadout")) {
        return Promise.resolve(jsonResponse(200, { catalogVersion: "v1", loadout: null }));
      }
      if (url.endsWith("/api/collection")) {
        return Promise.resolve(jsonResponse(200, { catalogVersion: "v1", entries: [] }));
      }
      // Sign-out revokes at the provider (B34); it must never reach a real network.
      if (url.startsWith(`${SUPABASE_URL}/auth/v1/`)) return Promise.resolve(jsonResponse(204));
      return Promise.resolve(
        jsonResponse(404, { error: { code: "not_found", message: `no stub for ${url}` } }),
      );
    }),
  );
}

function signedIn(): void {
  window.localStorage.setItem(E2E_SESSION_STORAGE_KEY, JSON.stringify({ accessToken: TOKEN }));
}

function at(path: string): void {
  window.history.replaceState(null, "", path);
}

/** A gated screen that says so when the gate opens. */
function renderGated(): void {
  render(
    <Gated>
      {(account) => <p data-testid="opened">{account.token}</p>}
    </Gated>,
  );
}

/**
 * The exit goes to `path`: either it is a link whose href is that path, or pressing it moves the
 * URL there.
 */
async function expectLeadsTo(element: HTMLElement, path: string): Promise<void> {
  const link = element.closest("a");
  if (link !== null && link.hasAttribute("href")) {
    expect(new URL(link.href, window.location.origin).pathname).toBe(path);
    return;
  }
  fireEvent.click(element);
  await waitFor(() => {
    expect(window.location.pathname).toBe(path);
  }, SLOW);
}

beforeEach(() => {
  vi.stubEnv("VITE_SUPABASE_URL", SUPABASE_URL);
  vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", SUPABASE_KEY);
  window.localStorage.clear();
  meAnswer = "active";
  meCalls = 0;
  serve();
  at("/decks");
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------------
// the gate's error panel
// ---------------------------------------------------------------------------------------------

describe("B40 the gate's error panel", () => {
  it.each([
    ["the server answers 500", "failing"],
    ["the server cannot be reached", "unreachable"],
  ] as const)("B40 when %s, it offers gate-retry, gate-home and gate-sign-out", async (_name, answer) => {
    signedIn();
    meAnswer = answer;
    renderGated();

    expect(await screen.findByTestId(shellTestid.error, undefined, SLOW)).toBeInTheDocument();
    expect(screen.getByTestId(shellTestid.retry)).toBeInTheDocument();
    expect(screen.getByTestId(shellTestid.home)).toBeInTheDocument();
    expect(screen.getByTestId(shellTestid.signOut)).toBeInTheDocument();
    expect(screen.queryByTestId("opened")).toBeNull();
  });

  it("B40 gate-retry re-reads /api/auth/me and opens the gate when it succeeds", async () => {
    signedIn();
    meAnswer = "failing";
    renderGated();
    await screen.findByTestId(shellTestid.error, undefined, SLOW);
    const before = meCalls;

    meAnswer = "active";
    fireEvent.click(screen.getByTestId(shellTestid.retry));

    expect((await screen.findByTestId("opened", undefined, SLOW)).textContent).toBe(TOKEN);
    expect(meCalls).toBeGreaterThan(before);
    expect(screen.queryByTestId(shellTestid.error)).toBeNull();
    // Re-read in place: the URL has not moved and the session is the one it was.
    expect(window.location.pathname).toBe(paths.decks);
    expect(window.localStorage.getItem(E2E_SESSION_STORAGE_KEY)).not.toBeNull();
  });

  it("B40 gate-retry after an unreachable server opens the gate once the server answers", async () => {
    signedIn();
    meAnswer = "unreachable";
    renderGated();
    await screen.findByTestId(shellTestid.error, undefined, SLOW);

    meAnswer = "active";
    fireEvent.click(screen.getByTestId(shellTestid.retry));

    expect(await screen.findByTestId("opened", undefined, SLOW)).toBeInTheDocument();
  });

  it("B40 a retry that fails again keeps the error panel and all three exits", async () => {
    signedIn();
    meAnswer = "failing";
    renderGated();
    await screen.findByTestId(shellTestid.error, undefined, SLOW);
    const before = meCalls;

    fireEvent.click(screen.getByTestId(shellTestid.retry));

    await waitFor(() => {
      expect(meCalls).toBeGreaterThan(before);
    }, SLOW);
    expect(await screen.findByTestId(shellTestid.error, undefined, SLOW)).toBeInTheDocument();
    expect(screen.getByTestId(shellTestid.retry)).toBeInTheDocument();
    expect(screen.getByTestId(shellTestid.home)).toBeInTheDocument();
    expect(screen.getByTestId(shellTestid.signOut)).toBeInTheDocument();
    expect(screen.queryByTestId("opened")).toBeNull();
  });

  it("B40 a retry whose read is refused as unauthorised sends the browser to plain /login", async () => {
    signedIn();
    meAnswer = "failing";
    render(<App />);
    await screen.findByTestId(shellTestid.error, undefined, SLOW);

    meAnswer = "unauthorized";
    fireEvent.click(screen.getByTestId(shellTestid.retry));

    await waitFor(() => {
      expect(window.location.pathname).toBe(paths.login);
    }, SLOW);
    expect(window.location.search).toBe("");
  });

  it("B40 through the route table, a retry that succeeds opens the gated screen at the same URL", async () => {
    signedIn();
    meAnswer = "failing";
    at(paths.invite);
    render(<App />);
    await screen.findByTestId(shellTestid.error, undefined, SLOW);

    meAnswer = "pending";
    fireEvent.click(screen.getByTestId(shellTestid.retry));

    expect(await screen.findByTestId(inviteTestid.input, undefined, SLOW)).toBeInTheDocument();
    expect(screen.queryByTestId(shellTestid.error)).toBeNull();
    expect(window.location.pathname).toBe(paths.invite);
  });

  it("B40 gate-home leads to the landing page", async () => {
    signedIn();
    meAnswer = "failing";
    render(<App />);
    await screen.findByTestId(shellTestid.error, undefined, SLOW);

    await expectLeadsTo(screen.getByTestId(shellTestid.home), paths.landing);
  });

  it("B40 gate-sign-out clears both session keys; the panel alone signs nobody out", async () => {
    signedIn();
    window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ accessToken: TOKEN }));
    meAnswer = "failing";
    renderGated();
    await screen.findByTestId(shellTestid.error, undefined, SLOW);
    expect(window.localStorage.getItem(SESSION_STORAGE_KEY)).not.toBeNull();
    expect(window.localStorage.getItem(E2E_SESSION_STORAGE_KEY)).not.toBeNull();

    fireEvent.click(screen.getByTestId(shellTestid.signOut));

    await waitFor(() => {
      expect(window.localStorage.getItem(SESSION_STORAGE_KEY)).toBeNull();
      expect(window.localStorage.getItem(E2E_SESSION_STORAGE_KEY)).toBeNull();
    }, SLOW);
  });
});

// ---------------------------------------------------------------------------------------------
// the banned panel
// ---------------------------------------------------------------------------------------------

describe("B40 the banned panel", () => {
  it("B40 offers gate-home and gate-sign-out, and never opens the gate", async () => {
    signedIn();
    meAnswer = "banned";
    renderGated();

    expect(await screen.findByTestId(shellTestid.home, undefined, SLOW)).toBeInTheDocument();
    expect(screen.getByTestId(shellTestid.signOut)).toBeInTheDocument();
    expect(screen.queryByTestId("opened")).toBeNull();
  });

  it("B40 gate-home on the banned panel leads to the landing page", async () => {
    signedIn();
    meAnswer = "banned";
    render(<App />);

    await expectLeadsTo(await screen.findByTestId(shellTestid.home, undefined, SLOW), paths.landing);
  });

  it("B40 gate-sign-out on the banned panel clears both session keys", async () => {
    signedIn();
    window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ accessToken: TOKEN }));
    meAnswer = "banned";
    renderGated();

    fireEvent.click(await screen.findByTestId(shellTestid.signOut, undefined, SLOW));

    await waitFor(() => {
      expect(window.localStorage.getItem(SESSION_STORAGE_KEY)).toBeNull();
      expect(window.localStorage.getItem(E2E_SESSION_STORAGE_KEY)).toBeNull();
    }, SLOW);
  });
});

// ---------------------------------------------------------------------------------------------
// the 404 panel
// ---------------------------------------------------------------------------------------------

describe("B40 the 404 panel", () => {
  it.each(["/nope", "/decks/extra", "/login/again"])(
    "B40 %s renders not-found in a player's words, and offers not-found-home",
    async (path) => {
      at(path);
      render(<App />);

      const panel = await screen.findByTestId(shellTestid.notFound, undefined, SLOW);
      expect(panel.textContent).toMatch(/That page doesn.t exist\./);
      expect(panel.textContent).not.toMatch(/no route for/i);
      expect(panel.querySelector("code")?.textContent).toBe(path);
      expect(screen.getByTestId(shellTestid.notFoundHome)).toBeInTheDocument();
      expect(window.location.pathname).toBe(path);
    },
  );

  it("B40 not-found-home leads to the landing page", async () => {
    at("/nope");
    render(<App />);

    const home = await screen.findByTestId(shellTestid.notFoundHome, undefined, SLOW);
    await expectLeadsTo(home, paths.landing);
  });

  it("B40 following not-found-home through the route table shows the landing page", async () => {
    at("/nope");
    render(<App />);

    const home = await screen.findByTestId(shellTestid.notFoundHome, undefined, SLOW);
    const link = home.closest("a");
    // A link is followed by the browser, which jsdom does not do; do what the browser would.
    if (link !== null && link.hasAttribute("href")) at(new URL(link.href).pathname);
    fireEvent.click(home);
    if (link !== null && link.hasAttribute("href")) window.dispatchEvent(new PopStateEvent("popstate"));

    expect(await screen.findByTestId(landingTestid.root, undefined, SLOW)).toBeInTheDocument();
    expect(screen.queryByTestId(shellTestid.notFound)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// the ids
// ---------------------------------------------------------------------------------------------

describe("B40 test ids", () => {
  it("B40 main.tsx re-exports shellTestid exactly as auth/testids.ts defines it", () => {
    expect(main.shellTestid).toEqual(shellTestid);
  });
});
