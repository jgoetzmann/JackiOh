// `main.tsx`: the route table and SPEC §9.4's gate, asserted through the real modules — a session
// in `localStorage`, `GET /api/auth/me` over a stubbed `fetch`, and `window.location.pathname` as
// the answer, because that is what specs 09 and 10 read.
//
// The gate enforces nothing (CLAUDE.md rule 7). The server 403s `account_pending` at every door and
// `wsServer.ts` runs the same check on the upgrade; what is asserted here is only that the browser
// is sent to the screen §9.4 says the account may see.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";

import { E2E_SESSION_STORAGE_KEY } from "../net/session.ts";

// `main.tsx` is the app's entry point and mounts itself, except under vitest — see the guard at the
// foot of that file. This assertion is what makes the guard's condition explicit: if vitest ever
// stops reporting `MODE === "test"`, this fails instead of the suite silently double-mounting.
it("vitest runs in MODE=test, which is what main.tsx's mount guard keys on", () => {
  expect(import.meta.env.MODE).toBe("test");
});

const { App, Gated, redirectFor } = await import("../main.tsx");

// ---------------------------------------------------------------------------------------------
// the stubbed server
// ---------------------------------------------------------------------------------------------

type Status = "pending" | "active" | "banned";

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

function meBody(status: Status) {
  return {
    profile: { id: "profile-1", status, rating: 1000 },
    needsInviteCode: status === "pending",
    emailVerified: true,
  };
}

/** Stub `/api/auth/me` (and the catalog the match route reads) for one account status. */
function serveAs(status: Status | "unauthorized"): void {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: unknown) => {
      const url = String(input);
      if (url.endsWith("/api/auth/me")) {
        if (status === "unauthorized") {
          return Promise.resolve(
            jsonResponse(401, { error: { code: "unauthorized", message: "sign in first" } }),
          );
        }
        return Promise.resolve(jsonResponse(200, meBody(status)));
      }
      if (url.endsWith("/api/catalog")) {
        return Promise.resolve(jsonResponse(200, { version: "v1", defs: {} }));
      }
      // The reads `/decks` makes for itself (another task owns that screen); stubbed so this file
      // asserts the gate rather than a deckbuilder failing to load.
      if (url.endsWith("/api/loadout")) {
        return Promise.resolve(jsonResponse(200, { catalogVersion: "v1", loadout: null }));
      }
      if (url.endsWith("/api/collection")) {
        return Promise.resolve(jsonResponse(200, { catalogVersion: "v1", entries: [] }));
      }
      if (url.endsWith("/api/codes/status")) {
        return Promise.resolve(jsonResponse(200, { redemptionEnabled: true, retryAfterMs: 0 }));
      }
      return Promise.resolve(
        jsonResponse(404, { error: { code: "not_found", message: `no stub for ${url}` } }),
      );
    }),
  );
}

/** The key the M8 specs seed in `cy.visit`'s `onBeforeLoad` (`net/session.ts`). */
function signedIn(token = "e2e-token"): void {
  window.localStorage.setItem(E2E_SESSION_STORAGE_KEY, JSON.stringify({ accessToken: token }));
}

function at(path: string): void {
  window.history.replaceState(null, "", path);
}

function pathname(): string {
  return window.location.pathname;
}

beforeEach(() => {
  window.localStorage.clear();
  at("/");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------------
// redirectFor: the whole decision, with no DOM in the way
// ---------------------------------------------------------------------------------------------

describe("redirectFor", () => {
  it("sends an account with no session to /login", () => {
    expect(redirectFor({ kind: "anonymous" }, false)).toBe("/login");
    expect(redirectFor({ kind: "anonymous" }, true)).toBe("/login");
  });

  it("sends a pending account to the code screen (§9.4)", () => {
    const pending = { kind: "ready", token: "t", me: meBody("pending") } as const;
    expect(redirectFor(pending, false)).toBe("/invite");
  });

  it("leaves a pending account on /invite: that is the one screen §9.4 allows it", () => {
    const pending = { kind: "ready", token: "t", me: meBody("pending") } as const;
    expect(redirectFor(pending, true)).toBeNull();
  });

  it("leaves an active account alone", () => {
    const active = { kind: "ready", token: "t", me: meBody("active") } as const;
    expect(redirectFor(active, false)).toBeNull();
    expect(redirectFor(active, true)).toBeNull();
  });

  it("holds a loading account where it is: a redirect on an unanswered /api/auth/me would flap", () => {
    expect(redirectFor({ kind: "loading" }, false)).toBeNull();
    expect(redirectFor({ kind: "error", message: "offline" }, false)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// the three redirect outcomes, through the real route table
// ---------------------------------------------------------------------------------------------

describe("the gate, as specs 09 and 10 read it", () => {
  it("anonymous: /decks sends the browser to /login", async () => {
    serveAs("active"); // Never reached: there is no session to send.
    at("/decks");
    render(<App />);
    await waitFor(() => {
      expect(pathname()).toBe("/login");
    });
  });

  it("a token the server no longer accepts is the same as having none", async () => {
    signedIn("stale");
    serveAs("unauthorized");
    at("/play");
    render(<App />);
    await waitFor(() => {
      expect(pathname()).toBe("/login");
    });
  });

  it("spec 10: a pending account visiting /decks lands on /invite", async () => {
    signedIn();
    serveAs("pending");
    at("/decks");
    render(<App />);
    await waitFor(() => {
      expect(pathname()).toBe("/invite");
    });
    // And the code screen is what renders there (the placeholder owned by another task).
    expect(await screen.findByRole("heading", { name: /invite code/i })).toBeInTheDocument();
  });

  it("spec 10: /invite is reachable by a pending account and stays put", async () => {
    signedIn();
    serveAs("pending");
    at("/invite");
    render(<App />);
    expect(await screen.findByRole("heading", { name: /invite code/i })).toBeInTheDocument();
    expect(pathname()).toBe("/invite");
  });

  it("spec 09 and 10: an active account stays on /decks, neither on /login nor on /invite", async () => {
    signedIn();
    serveAs("active");
    at("/decks");
    render(<App />);
    expect(await screen.findByRole("heading", { name: /decks/i })).toBeInTheDocument();
    expect(pathname()).toBe("/decks");
    expect(pathname()).not.toBe("/login");
    expect(pathname()).not.toBe("/invite");
  });

  it("an active account may also open /invite", async () => {
    signedIn();
    serveAs("active");
    at("/invite");
    render(<App />);
    expect(await screen.findByRole("heading", { name: /invite code/i })).toBeInTheDocument();
    expect(pathname()).toBe("/invite");
  });

  it("holds the screen while /api/auth/me is in flight, instead of guessing", () => {
    signedIn();
    serveAs("active");
    at("/decks");
    render(
      <Gated>
        {() => (
          <p>the gate opened</p>
        )}
      </Gated>,
    );
    expect(screen.getByTestId("gate-loading")).toBeInTheDocument();
    expect(pathname()).toBe("/decks");
  });
});

// ---------------------------------------------------------------------------------------------
// routes that need no gate
// ---------------------------------------------------------------------------------------------

describe("the route table", () => {
  it("/login is ungated: it is the door the gate sends people to", async () => {
    at("/login");
    render(<App />);
    expect(await screen.findByTestId("login-submit")).toBeInTheDocument();
    expect(pathname()).toBe("/login");
  });

  it("an unknown path is a 404 panel, not a redirect", async () => {
    at("/nope");
    render(<App />);
    expect(await screen.findByText(/no route for/i)).toBeInTheDocument();
    expect(pathname()).toBe("/nope");
  });
});

// ---------------------------------------------------------------------------------------------
// /match/<id>
// ---------------------------------------------------------------------------------------------

describe("/match/<id>", () => {
  /** The match route opens a real `WebSocket`; jsdom has one and nothing to connect it to. */
  class StubSocket {
    static opened: string[] = [];
    readyState = 0;
    onopen: ((event: unknown) => void) | null = null;
    onmessage: ((event: { data: unknown }) => void) | null = null;
    onclose: ((event: { code: number; reason: string; wasClean: boolean }) => void) | null = null;
    onerror: ((event: unknown) => void) | null = null;
    constructor(url: string) {
      StubSocket.opened.push(url);
    }
    send(): void {}
    close(): void {}
  }

  beforeEach(() => {
    StubSocket.opened = [];
    vi.stubGlobal("WebSocket", StubSocket);
  });

  it("routes the id out of the path and opens a socket for it", async () => {
    signedIn("tok-1");
    serveAs("active");
    at("/match/m-42");
    render(<App />);

    expect(await screen.findByTestId("match-connecting")).toBeInTheDocument();
    expect(pathname()).toBe("/match/m-42");
    await waitFor(() => {
      expect(StubSocket.opened.length).toBeGreaterThan(0);
    });
    // `wsServer.ts` `tokenFrom` reads `?token=`, and the match from `?matchId=`: a browser cannot
    // put either on a handshake header.
    const url = StubSocket.opened[0] ?? "";
    expect(url).toContain("token=tok-1");
    expect(url).toContain("matchId=m-42");
  });

  it("a pending account cannot reach a match either (§9.4: 'no ... queue or match')", async () => {
    signedIn();
    serveAs("pending");
    at("/match/m-42");
    render(<App />);
    await waitFor(() => {
      expect(pathname()).toBe("/invite");
    });
    expect(StubSocket.opened).toEqual([]);
  });
});
