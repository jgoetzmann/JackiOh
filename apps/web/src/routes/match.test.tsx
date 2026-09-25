// `/match/<id>`: the board specs 05 and 06 drive, with the socket faked.
//
// The load-bearing assertion in this file is what a board does with `legalActions`. A view that
// carries none renders `legal={[]}`, `end-turn` is `disabled`, and `waitForMyTurn` in specs 05 and
// 06 waits forever — so the route says so out loud rather than looking merely idle. The two tests
// after it show the board coming alive on either accepted shape: the `legal` field on the `view`
// frame, which is what `apps/server/src/match/actor.ts` sends, and a `legal` frame of its own.
// Nothing here computes legality; that is the engine's (BUILD M5-T2, CLAUDE.md rule 7).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { ActionBody } from "@jackioh/shared";

import { MULLIGAN_CLOCK_MS } from "../../../server/src/config.ts";
import type { SocketLike } from "../game/net.ts";
import { baseView } from "../test/fixtures.ts";
import MatchRoute, { withoutToken } from "./match.tsx";

class FakeSocket implements SocketLike {
  readyState = 0;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string; wasClean: boolean }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  readonly sent: string[] = [];

  constructor(readonly url: string) {}

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = 3;
  }

  frames(): Record<string, unknown>[] {
    return this.sent.map((text) => JSON.parse(text) as Record<string, unknown>);
  }
}

let sockets: FakeSocket[] = [];

function socketFactory(url: string): SocketLike {
  const socket = new FakeSocket(url);
  sockets.push(socket);
  return socket;
}

function live(): FakeSocket {
  const last = sockets.at(-1);
  if (last === undefined) throw new Error("no socket was opened");
  return last;
}

/** Open the socket and push one view, the way the actor does on attach (§9.5). */
function attach(extra: Record<string, unknown> = {}): void {
  act(() => {
    live().readyState = 1;
    live().onopen?.({});
    live().onmessage?.({
      data: JSON.stringify({ type: "view", view: baseView({ viewer: "p1", active: "p1" }), ...extra }),
    });
  });
}

beforeEach(() => {
  sockets = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(JSON.stringify({ version: "v1", defs: {} })),
      } as unknown as Response),
    ),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the networked board", () => {
  it("renders the board from the view alone, and names the frame that is missing", () => {
    render(<MatchRoute matchId="m-1" token="tok" socketFactory={socketFactory} />);
    attach();

    // §10.8's view is enough to draw the board.
    expect(screen.getByTestId("hero-you")).toBeInTheDocument();
    expect(screen.getByTestId("hero-opponent")).toBeInTheDocument();
    expect(screen.getByTestId("zone-you-units-1")).toBeInTheDocument();
    expect(screen.getByTestId("zone-you-backrow-5")).toBeInTheDocument();

    // ...and not enough to click anything, which is the gap the notice names.
    expect(screen.getByTestId("missing-legal-frame")).toBeInTheDocument();
    expect(screen.getByTestId("end-turn")).toBeDisabled();
  });

  it("comes alive on a `legal` frame, and the click goes out as an `action`", () => {
    render(<MatchRoute matchId="m-1" token="tok" socketFactory={socketFactory} />);
    attach();

    const legal: ActionBody[] = [{ type: "endTurn" }];
    act(() => {
      live().onmessage?.({ data: JSON.stringify({ type: "legal", legal }) });
    });

    expect(screen.queryByTestId("missing-legal-frame")).toBeNull();
    const endTurn = screen.getByTestId("end-turn");
    expect(endTurn).not.toBeDisabled();

    fireEvent.click(endTurn);
    const sent = live().frames().at(-1) as { type: string; action: Record<string, unknown> };
    expect(sent.type).toBe("action");
    expect(sent.action.type).toBe("endTurn");
    expect(typeof sent.action.nonce).toBe("string");
  });

  it("takes the same list riding on the `view` frame", () => {
    render(<MatchRoute matchId="m-1" token="tok" socketFactory={socketFactory} />);
    attach({ legal: [{ type: "endTurn" }] });

    expect(screen.queryByTestId("missing-legal-frame")).toBeNull();
    expect(screen.getByTestId("end-turn")).not.toBeDisabled();
  });

  /**
   * R7 of this route's own making: `GET /api/catalog` resolves whenever it resolves, and the board
   * must not be rebuilt when it does.
   *
   * The route used to render `lookup === null ? board : <CatalogContext.Provider>{board}</…>`.
   * That changes the ELEMENT TYPE at that position the moment the catalog lands, so React unmounts
   * the whole board and mounts a new one: every DOM node is replaced. It cost spec 05 a mulligan —
   * `cy.click()` had already resolved a prompt option and reported it "disappeared from the page"
   * — and a real player would lose a half-finished play the same way. Node identity is the
   * assertion, because that is exactly what a remount does not preserve.
   */
  it("does not rebuild the board when the catalog arrives", async () => {
    let resolveCatalog = (): void => {};
    const catalog = new Promise<Response>((resolve) => {
      resolveCatalog = () =>
        resolve({
          ok: true,
          status: 200,
          text: () =>
            Promise.resolve(
              JSON.stringify({
                version: "v1",
                defs: {
                  "core-001": {
                    name: "Big D-fender",
                    type: "Unit",
                    tags: [],
                    base: { text: "", attack: 1, health: 1 },
                    radiant: { text: "", attack: 1, health: 1 },
                  },
                },
              }),
            ),
        } as unknown as Response);
    });
    vi.stubGlobal("fetch", vi.fn(() => catalog));

    render(<MatchRoute matchId="m-1" token="tok" socketFactory={socketFactory} />);
    attach({ legal: [{ type: "endTurn" }] });

    const heroBefore = screen.getByTestId("hero-you");
    const endTurnBefore = screen.getByTestId("end-turn");

    await act(async () => {
      resolveCatalog();
      await catalog;
    });

    expect(screen.getByTestId("hero-you")).toBe(heroBefore);
    expect(screen.getByTestId("end-turn")).toBe(endTurnBefore);
    expect(heroBefore.isConnected).toBe(true);
  });

  it("shows a holding panel until the first view lands", () => {
    render(<MatchRoute matchId="m-1" token="tok" socketFactory={socketFactory} />);
    expect(screen.getByTestId("match-connecting")).toBeInTheDocument();
    expect(screen.queryByTestId("hero-you")).toBeNull();
  });

  it("relays the actor's refusal verbatim (§9.3)", () => {
    render(<MatchRoute matchId="m-1" token="tok" socketFactory={socketFactory} />);
    attach();
    act(() => {
      live().onmessage?.({
        data: JSON.stringify({
          type: "error",
          code: "illegal_action",
          message: "it is not your turn",
          nonce: "n1",
        }),
      });
    });
    expect(screen.getByTestId("action-error")).toHaveTextContent("it is not your turn");
  });

  it("publishes the seat on window.__jackioh, as e2e/support/types.ts expects", () => {
    render(<MatchRoute matchId="m-1" token="tok" socketFactory={socketFactory} />);
    attach();
    const handle = (window as unknown as { __jackioh?: { seat?: string; seed?: string } }).__jackioh;
    expect(handle?.seat).toBe("p1");
    // And no seed: the server never sends one, because (seed, log) is the library order (§9.3).
    expect(handle?.seed).toBe("");
  });
});

describe("withoutToken", () => {
  /**
   * `net.ts` puts the access token in the socket URL's query, and the connecting status line
   * renders that URL. Printing it raw put a live bearer token on screen and in the DOM.
   */
  it("strips the access token from the socket URL it displays", () => {
    const withToken =
      "wss://jackioh-server.onrender.com/ws/match?token=eyJhbGciOiJFUzI1NiJ9.SECRET.sig&matchId=abc";
    const shown = withoutToken(withToken);
    expect(shown).not.toContain("SECRET");
    expect(shown).not.toContain("token=");
    expect(shown).toContain("wss://jackioh-server.onrender.com/ws/match");
  });

  it("returns an unparseable value unchanged rather than throwing", () => {
    expect(withoutToken("not a url")).toBe("not a url");
  });
});

describe("R268 the mulligan clock on the match bar", () => {
  it("shows the one mulligan countdown on both sides, to the seat still choosing and to the one that is ready", () => {
    for (const mulligan of [
      { youReady: false, opponentReady: false },
      { youReady: true, opponentReady: false, kept: [] },
    ]) {
      render(<MatchRoute matchId="m-1" token="tok" socketFactory={socketFactory} />);
      const view = baseView({ viewer: "p1", active: "p1", turn: 0, phase: "mulligan", clockMs: 30_000, mulligan });
      act(() => {
        live().onopen?.({});
        live().onmessage?.({ data: JSON.stringify({ type: "view", view }) });
      });
      for (const id of ["clock-you", "clock-opponent"]) {
        const line = screen.getByTestId(id);
        expect(line, id).toHaveAttribute("data-kind", "mulligan");
        expect(line, id).toHaveAttribute("data-total-ms", String(MULLIGAN_CLOCK_MS));
        expect(line, id).toHaveTextContent("30s");
      }
      cleanup();
      sockets = [];
    }
  });

  it("counts the mulligan window down between clock frames, off the frame's own deadline", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "performance", "Date"] });
    try {
      render(<MatchRoute matchId="m-1" token="tok" socketFactory={socketFactory} />);
      const now = 1_000_000;
      const view = baseView({ viewer: "p2", active: "p1", turn: 0, phase: "mulligan", clockMs: MULLIGAN_CLOCK_MS, mulligan: { youReady: true, opponentReady: false, kept: [] } });
      act(() => {
        live().onopen?.({});
        live().onmessage?.({ data: JSON.stringify({ type: "view", view }) });
        live().onmessage?.({
          data: JSON.stringify({
            type: "clock",
            now,
            clocks: { turnDeadline: null, promptDeadline: now + MULLIGAN_CLOCK_MS, graceDeadline: { p1: null, p2: null }, ceilingAt: now + 3_600_000 },
          }),
        });
      });
      expect(screen.getByTestId("clock-you")).toHaveTextContent(`${String(MULLIGAN_CLOCK_MS / 1000)}s`);
      act(() => {
        vi.advanceTimersByTime(10_000);
      });
      for (const id of ["clock-you", "clock-opponent"]) {
        expect(screen.getByTestId(id), id).toHaveTextContent(`${String(MULLIGAN_CLOCK_MS / 1000 - 10)}s`);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("once the window closes, the clock is the active player's turn clock again", () => {
    render(<MatchRoute matchId="m-1" token="tok" socketFactory={socketFactory} />);
    act(() => {
      live().onopen?.({});
      live().onmessage?.({ data: JSON.stringify({ type: "view", view: baseView({ viewer: "p1", active: "p2", clockMs: 60_000 }) }) });
    });
    expect(screen.getByTestId("clock-you")).toHaveTextContent("—");
    expect(screen.getByTestId("clock-opponent")).toHaveTextContent("60s");
    expect(screen.getByTestId("clock-opponent")).not.toHaveAttribute("data-kind", "mulligan");
  });
});
