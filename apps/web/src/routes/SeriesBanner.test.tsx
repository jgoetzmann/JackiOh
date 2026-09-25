// The board's series banner (R336): the score and each side's won decks while a series game is on,
// and once it is over the way on to the next game or the series' result. A match that is not a
// series game shows nothing.

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SERIES_MAX_GAMES, SERIES_WINS_NEEDED } from "../../../server/src/config.ts";
import { getSeriesForMatch, type SeriesView } from "../net/api.ts";
import { SeriesBanner, SeriesContinue, nextStep, seriesBannerTestid, useMatchSeries } from "./SeriesBanner.tsx";

vi.mock("../net/api.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../net/api.ts")>();
  return { ...actual, getSeriesForMatch: vi.fn() };
});

const TOKEN = "token-1";
const MATCH_ID = "m-1";

function series(overrides: Partial<SeriesView> = {}): SeriesView {
  return {
    id: "series-1",
    status: "playing",
    gameNo: 1,
    winsNeeded: SERIES_WINS_NEEDED,
    maxGames: SERIES_MAX_GAMES,
    pickDeadline: null,
    now: 0,
    currentMatchId: MATCH_ID,
    you: {
      seat: "p1",
      wins: 0,
      trioName: "Main trio",
      decks: [
        { slot: 0, name: "Aggro", cards: [], won: false, games: 1 },
        { slot: 1, name: "Control", cards: [], won: false, games: 0 },
        { slot: 2, name: "Ramp", cards: [], won: false, games: 0 },
      ],
      pick: null,
      autoPick: false,
    },
    opponent: {
      wins: 0,
      decks: [
        { slot: 0, won: false },
        { slot: 1, won: false },
        { slot: 2, won: false },
      ],
      picked: false,
    },
    games: [],
    result: null,
    ...overrides,
  };
}

/** The banner and the result panel's way on, as match.tsx mounts them. */
function Harness({ gameOver }: { gameOver: boolean }) {
  const found = useMatchSeries(TOKEN, MATCH_ID, gameOver);
  return (
    <>
      <SeriesBanner series={found} matchId={MATCH_ID} gameOver={gameOver} />
      <div data-testid="panel">
        <SeriesContinue series={found} matchId={MATCH_ID} />
      </div>
    </>
  );
}

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("the series banner", () => {
  it("R336 shows the score and each side's won decks on a series game, and no way on while the game is played", async () => {
    const you = series().you;
    vi.mocked(getSeriesForMatch).mockResolvedValue({
      series: series({
        you: { ...you, wins: 1, decks: you.decks.map((deck) => (deck.slot === 0 ? { ...deck, won: true } : deck)) },
        opponent: { ...series().opponent, wins: 1, decks: [{ slot: 0, won: false }, { slot: 1, won: false }, { slot: 2, won: true }] },
      }),
    });
    render(<Harness gameOver={false} />);

    const banner = await screen.findByTestId(seriesBannerTestid.banner);
    expect(vi.mocked(getSeriesForMatch)).toHaveBeenCalledWith(TOKEN, MATCH_ID);
    expect(banner).toHaveAttribute("data-series-id", "series-1");
    expect(banner).toHaveTextContent("Conquest · You 1 – 1 Opponent");
    expect(screen.getByTestId(seriesBannerTestid.yourDeck(0))).toHaveAttribute("data-won", "true");
    expect(screen.getByTestId(seriesBannerTestid.yourDeck(1))).toHaveAttribute("data-won", "false");
    expect(screen.getByTestId(seriesBannerTestid.opponentDeck(2))).toHaveAttribute("data-won", "true");
    expect(screen.getByLabelText("Your decks: 1 of 3 decks have won")).toBeInTheDocument();
    expect(screen.getByLabelText("Their decks: 1 of 3 decks have won")).toBeInTheDocument();
    expect(screen.queryByTestId(seriesBannerTestid.continue)).toBeNull();
  });

  it("R338 once the game is over, reads the series again and offers Continue to the next game", async () => {
    vi.mocked(getSeriesForMatch).mockResolvedValue({ series: series() });
    const { rerender } = render(<Harness gameOver={false} />);
    await screen.findByTestId(seriesBannerTestid.banner);

    // The game ends; the series has moved to game 2's picks.
    vi.mocked(getSeriesForMatch).mockResolvedValue({
      series: series({ status: "picking", gameNo: 2, currentMatchId: null, you: { ...series().you, wins: 1 } }),
    });
    rerender(<Harness gameOver />);

    await waitFor(() => {
      expect(screen.getByTestId(seriesBannerTestid.continue)).toHaveTextContent("Continue to game 2");
    });
    expect(screen.getByTestId(seriesBannerTestid.continue)).toHaveAttribute("href", "/series/series-1");
    expect(screen.getByTestId(seriesBannerTestid.banner)).toHaveTextContent("You 1 – 0 Opponent");
    // The board's result panel offers the same way on.
    expect(screen.getByTestId(seriesBannerTestid.panelContinue)).toHaveAttribute("href", "/series/series-1");
  });

  it("R332 goes straight to the next game's board when it is already running (both last decks were picked)", () => {
    const running = series({ gameNo: 3, currentMatchId: "m-3" });
    expect(nextStep(running, MATCH_ID)).toEqual({ href: "/match/m-3", label: "Continue to game 3" });
    // Still this game: the series has not moved on yet.
    expect(nextStep(series(), MATCH_ID)).toEqual({ href: "/series/series-1", label: "Back to the series" });
  });

  it("shows the series' result once it is over", async () => {
    vi.mocked(getSeriesForMatch).mockResolvedValue({
      series: series({
        status: "over",
        gameNo: 2,
        currentMatchId: null,
        you: { ...series().you, wins: SERIES_WINS_NEEDED },
        result: { outcome: "win", endReason: "decided", ratingBefore: 1000, ratingAfter: 1016 },
      }),
    });
    render(<Harness gameOver />);

    const result = await screen.findByTestId(seriesBannerTestid.result);
    expect(result).toHaveAttribute("data-outcome", "win");
    expect(result).toHaveTextContent("You won the series");
    expect(screen.getByTestId(seriesBannerTestid.continue)).toHaveAttribute("href", "/series/series-1");
  });

  it("a match that is not a series game shows nothing and asks once", async () => {
    vi.mocked(getSeriesForMatch).mockResolvedValue({ series: null });
    const { rerender } = render(<Harness gameOver={false} />);
    await waitFor(() => {
      expect(vi.mocked(getSeriesForMatch)).toHaveBeenCalledTimes(1);
    });
    rerender(<Harness gameOver />);
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.queryByTestId(seriesBannerTestid.banner)).toBeNull();
    expect(screen.getByTestId("panel")).toBeEmptyDOMElement();
    expect(vi.mocked(getSeriesForMatch)).toHaveBeenCalledTimes(1);
  });
});
