// `/match/<id>`: the board specs 05 and 06 drive, with the socket faked.
//
// The load-bearing assertion in this file is what a board does with `legalActions`. A view that
// carries none renders `legal={[]}`, `end-turn` is `disabled`, and `waitForMyTurn` in specs 05 and
// 06 waits forever — so the route says so out loud rather than looking merely idle. The two tests
// after it show the board coming alive on either accepted shape: the `legal` field on the `view`
// frame, which is what `apps/server/src/match/actor.ts` sends, and a `legal` frame of its own.
// Nothing here computes legality; that is the engine's (BUILD M5-T2, CLAUDE.md rule 7).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { ActionBody } from "@jackioh/shared";

import { MULLIGAN_CLOCK_MS, SERIES_MAX_GAMES, SERIES_WINS_NEEDED, TURN_CLOCK_MS } from "../../../server/src/config.ts";

import type { SocketLike } from "../game/net.ts";
import { baseView } from "../test/fixtures.ts";
import { formatClock } from "../game/Clock.tsx";
import { TURN_CLOCK_FINAL_MS, TURN_CLOCK_LAST_MS } from "../game/clockConstants.ts";
import MatchRoute, { connectionWords, promptHolderOf, withoutToken } from "./match.tsx";

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

describe("the series banner on a series game (R259)", () => {
  /** A Conquest game's series, as `GET /api/matches/:id/series` answers it. */
  function seriesAnswer(over: boolean): Record<string, unknown> {
    const decks = [0, 1, 2].map((slot) => ({
      slot,
      name: `Deck ${String(slot + 1)}`,
      cards: [],
      won: over && slot === 0,
      games: slot === 0 ? 1 : 0,
    }));
    return {
      series: {
        id: "series-1",
        status: over ? "picking" : "playing",
        gameNo: over ? 2 : 1,
        winsNeeded: SERIES_WINS_NEEDED,
        maxGames: SERIES_MAX_GAMES,
        pickDeadline: null,
        now: 0,
        currentMatchId: over ? null : "m-1",
        ranked: true,
        you: { seat: "p1", wins: over ? 1 : 0, trioName: "Main trio", decks, pick: null, autoPick: false },
        opponent: { wins: 0, decks: decks.map(({ slot }) => ({ slot, won: false })), picked: false },
        games: [],
        result: null,
      },
    };
  }

  it("R259 shows the score, and once the game is over the way on to the next game", async () => {
    let gameOver = false;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        Promise.resolve({
          ok: true,
          status: 200,
          text: () =>
            Promise.resolve(
              JSON.stringify(url.includes("/api/matches/m-1/series") ? seriesAnswer(gameOver) : { version: "v1", defs: {} }),
            ),
        } as unknown as Response),
      ),
    );
    render(<MatchRoute matchId="m-1" token="tok" socketFactory={socketFactory} />);
    attach();

    const banner = await screen.findByTestId("series-banner");
    expect(banner).toHaveTextContent("You 0 – 0 Opponent");
    expect(screen.queryByTestId("series-banner-continue")).toBeNull();

    gameOver = true;
    act(() => {
      live().onmessage?.({
        data: JSON.stringify({
          type: "view",
          view: baseView({ viewer: "p1", active: "p1", result: { winner: "p1", reason: "hero-death" } }),
        }),
      });
    });

    const next = await screen.findByTestId("series-banner-continue");
    expect(next).toHaveTextContent("Continue to game 2");
    expect(next).toHaveAttribute("href", "/series/series-1");
    expect(screen.getByTestId("series-banner")).toHaveTextContent("You 1 – 0 Opponent");
  });

  it("shows no banner on a game that is not in a series", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve(JSON.stringify(url.includes("/series") ? { series: null } : { version: "v1", defs: {} })),
        } as unknown as Response),
      ),
    );
    render(<MatchRoute matchId="m-1" token="tok" socketFactory={socketFactory} />);
    attach();
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.queryByTestId("series-banner")).toBeNull();
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

describe("R439 the turn clock's last 30 seconds on the match bar", () => {
  /** A `clock` frame whose turn clock has `ms` left at the server's `now`. */
  function clockFrame(now: number, ms: number | null): string {
    return JSON.stringify({
      type: "clock",
      now,
      clocks: {
        turnDeadline: ms === null ? null : now + ms,
        promptDeadline: null,
        graceDeadline: { p1: null, p2: null },
        ceilingAt: now + 3_600_000,
      },
    });
  }

  function clockRoot(): Element | null {
    return document.querySelector(".match-bar .clock");
  }

  it("R439 counts the turn clock down between the server's frames and turns urgent at 30 seconds", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "performance", "Date"] });
    try {
      render(<MatchRoute matchId="m-1" token="tok" socketFactory={socketFactory} />);
      const now = 1_000_000;
      act(() => {
        live().onopen?.({});
        live().onmessage?.({ data: JSON.stringify({ type: "view", view: baseView({ viewer: "p1", active: "p1", turn: 3 }) }) });
        live().onmessage?.({ data: clockFrame(now, TURN_CLOCK_FINAL_MS + 5_000) });
      });
      expect(screen.getByTestId("clock-you")).toHaveAttribute("data-kind", "turn");
      expect(clockRoot()).toHaveAttribute("data-clock-urgency", "none");

      act(() => {
        vi.advanceTimersByTime(5_000);
      });
      expect(clockRoot()).toHaveAttribute("data-clock-urgency", "final");
      expect(clockRoot()).toHaveAttribute("data-clock-side", "you");
      expect(screen.getByTestId("clock-you")).toHaveTextContent(formatClock(TURN_CLOCK_FINAL_MS));
      expect(screen.getByTestId("turn-clock-fuse")).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("R439 a view on the next turn never reads the last turn's deadline, even before its own frame lands", () => {
    render(<MatchRoute matchId="m-1" token="tok" socketFactory={socketFactory} />);
    const now = 1_000_000;
    act(() => {
      live().onopen?.({});
      // The opponent's turn, with 5 seconds left on it.
      live().onmessage?.({ data: JSON.stringify({ type: "view", view: baseView({ viewer: "p1", active: "p2", turn: 3 }) }) });
      live().onmessage?.({ data: clockFrame(now, TURN_CLOCK_LAST_MS / 2) });
    });
    expect(clockRoot()).toHaveAttribute("data-clock-side", "opponent");
    expect(clockRoot()).toHaveAttribute("data-clock-urgency", "last10");

    // The viewer's turn begins: its view first, the server's fresh frame just after (actor.ts).
    act(() => {
      live().onmessage?.({
        data: JSON.stringify({ type: "view", view: baseView({ viewer: "p1", active: "p1", turn: 4, clockMs: TURN_CLOCK_MS }) }),
      });
    });
    expect(clockRoot(), "the old turn's 5 seconds are not the new turn's").toHaveAttribute("data-clock-urgency", "none");
    expect(screen.getByTestId("clock-you")).toHaveTextContent(formatClock(TURN_CLOCK_MS));

    act(() => {
      live().onmessage?.({ data: clockFrame(now + 1_000, TURN_CLOCK_MS) });
    });
    expect(clockRoot()).toHaveAttribute("data-clock-urgency", "none");
    expect(screen.getByTestId("clock-you")).toHaveAttribute("data-kind", "turn");
  });

  it("R439 a finished game runs no clock and warns nobody", () => {
    render(<MatchRoute matchId="m-1" token="tok" socketFactory={socketFactory} />);
    act(() => {
      live().onopen?.({});
      live().onmessage?.({
        data: JSON.stringify({
          type: "view",
          view: baseView({ viewer: "p1", active: "p1", phase: "over", result: { winner: "p2", reason: "hero-death" } }),
        }),
      });
      live().onmessage?.({ data: clockFrame(1_000_000, TURN_CLOCK_LAST_MS) });
    });
    expect(clockRoot()).toHaveAttribute("data-clock-urgency", "none");
    expect(screen.queryByTestId("turn-clock-fuse")).toBeNull();
  });

  it("R79 names the prompt's holder from the view", () => {
    expect(promptHolderOf(null, "p1")).toBeNull();
    expect(promptHolderOf({ forYou: false, pendingFor: "p2" }, "p1")).toBe("p2");
    expect(
      promptHolderOf({ forYou: true, choiceId: "c", kind: "discover", options: [], min: 1, max: 1, prompt: "" }, "p2"),
    ).toBe("p2");
  });
});

/** `WS_CLOSE.forbidden` in apps/server/src/match/wsServer.ts (R148): a refusal, never retried. */
const FORBIDDEN_CLOSE = 4403;

// des-4, des-10, str-1: what a player reads around the online board. The ids, the socket URL and
// the protocol detail stay out of a production build; the console keeps the detail.
describe("the match screen in a player's words", () => {
  it("says each connection state in words", () => {
    expect(connectionWords("open")).toBe("Connected");
    expect(connectionWords("connecting")).toBe("Connecting…");
    expect(connectionWords("reconnecting")).toBe("Reconnecting…");
    expect(connectionWords("refused")).toBe("This match isn’t available");
    expect(connectionWords("closed")).toBe("Disconnected");
  });

  it("waits in the tavern panel, which says the server may be waking up", () => {
    render(<MatchRoute matchId="m-1" token="tok" socketFactory={socketFactory} />);
    const panel = screen.getByTestId("match-connecting");
    expect(panel).toHaveClass("tavern");
    expect(panel).toHaveTextContent("Joining the match…");
    const status = screen.getByTestId("match-status");
    expect(status).toHaveTextContent("Connecting…");
    expect(status).toHaveAttribute("data-connection", "connecting");
  });

  it("says a refused match isn't available, and keeps the server's reason for the console", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      render(<MatchRoute matchId="m-1" token="tok" socketFactory={socketFactory} />);
      act(() => {
        live().onclose?.({ code: FORBIDDEN_CLOSE, reason: "not a participant in this match", wasClean: true });
      });
      expect(screen.getByTestId("match-refused")).toHaveTextContent("This match isn’t available.");
      expect(screen.getByTestId("match-connecting").textContent).not.toMatch(/not a participant|socket/);
      expect(logged.mock.calls.flat().join(" ")).toMatch(/not a participant in this match/);
    } finally {
      logged.mockRestore();
    }
  });

  it("names the connection on the board's bar in words", () => {
    render(<MatchRoute matchId="m-1" token="tok" socketFactory={socketFactory} />);
    attach({ legal: [{ type: "endTurn" }] });
    const status = screen.getByTestId("match-status");
    expect(status).toHaveTextContent("Connected");
    expect(status).toHaveAttribute("data-connection", "open");
  });

  it("says a read-only board in a player's words, with no build plan or repo path in it", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      render(<MatchRoute matchId="m-1" token="tok" socketFactory={socketFactory} />);
      attach();
      const notice = screen.getByTestId("missing-legal-frame");
      expect(notice.textContent).not.toMatch(/BUILD M|SPEC §|apps\/|legalActions/);
      expect(notice).toHaveTextContent("Reload the page to rejoin the match.");
      expect(logged.mock.calls.flat().join(" ")).toMatch(/legalActions/);
    } finally {
      logged.mockRestore();
    }
  });

  it("puts Your turn in the tab while it is the player's turn", () => {
    render(<MatchRoute matchId="m-1" token="tok" socketFactory={socketFactory} />);
    attach({ legal: [{ type: "endTurn" }] });
    expect(document.title).toBe("Your turn · JackiOh");
    act(() => {
      live().onmessage?.({
        data: JSON.stringify({ type: "view", view: baseView({ viewer: "p1", active: "p2" }), legal: [] }),
      });
    });
    expect(document.title).toBe("Match · JackiOh");
  });
});

describe("the match screen's ranks (R604, R612)", () => {
  const ranksBody = {
    ranked: true,
    seats: {
      p1: { tag: "ABC123", rank: { tier: "normal", division: 3, pips: 1, pipsPerDivision: 3, floor: "rotten" }, you: true },
      p2: { tag: "XYZ999", rank: { tier: "raisin", placementsPlayed: 2, placementGames: 5 }, you: false },
    },
  };

  function stubFetch(ranks: unknown): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn((url: string) =>
      Promise.resolve({
        ok: true,
        status: 200,
        text: () =>
          Promise.resolve(
            JSON.stringify(String(url).includes("/ranks") ? ranks : { version: "v1", defs: {} }),
          ),
      } as unknown as Response),
    );
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  it("names both seats' ranks and whether the game moves them", async () => {
    stubFetch(ranksBody);
    render(<MatchRoute matchId="m-1" token="tok" socketFactory={socketFactory} />);
    attach({ legal: [{ type: "endTurn" }] });

    const banner = await screen.findByTestId("match-ranks");
    expect(banner).toHaveTextContent("Ranked match");
    expect(banner).toHaveTextContent("ABC123 (you) Normal Grape III");
    expect(banner).toHaveTextContent("XYZ999 Raisin");
  });

  it("says an unranked match moves nothing, and stays silent when the read is not a ranks body", async () => {
    stubFetch({ ...ranksBody, ranked: false });
    render(<MatchRoute matchId="m-1" token="tok" socketFactory={socketFactory} />);
    attach({ legal: [{ type: "endTurn" }] });

    expect(await screen.findByTestId("match-ranks")).toHaveTextContent("Unranked match");

    cleanup();
    const fetchMock = stubFetch({ version: "v1", defs: {} });
    render(<MatchRoute matchId="m-2" token="tok" socketFactory={socketFactory} />);
    attach({ legal: [{ type: "endTurn" }] });
    await screen.findByTestId("hero-you");
    // The ranks read has answered by now, and its body was not a ranks body: no banner, no crash.
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining("/ranks"), expect.anything());
    });
    await act(async () => {});
    expect(screen.queryByTestId("match-ranks")).toBeNull();
  });
});

describe("a socket refused mid-game", () => {
  it("tells the player in words, not with the server's reason", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      render(<MatchRoute matchId="m-1" token="tok" socketFactory={socketFactory} />);
      attach({ legal: [{ type: "endTurn" }] });
      act(() => {
        live().onclose?.({ code: FORBIDDEN_CLOSE, reason: "", wasClean: true });
      });
      expect(document.body.textContent).not.toMatch(/refused this match socket/);
      expect(screen.getByTestId("match-status")).toHaveAttribute("data-connection", "refused");
      expect(document.body.textContent).toMatch(/This match isn’t available/);
    } finally {
      logged.mockRestore();
    }
  });
});
