// `/series/<id>`: the Best-of-3 series between its games (R259–R262), from the server's projection.
//
// Everything on the screen comes from the `SeriesView` the mocked API answers; the tests show that
// what the view leaves out (the opponent's pick and deck names, R259) never appears, that a pick and
// a forfeit send exactly the player's intent, and that the clock is counted from the server's own
// `now` rather than this device's clock (R260).

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SERIES_MAX_GAMES, SERIES_PICK_SECONDS, SERIES_WINS_NEEDED } from "../../../server/src/config.ts";
import { ApiRequestError, forfeitSeries, getSeries, pickSeriesDeck, type SeriesView } from "../net/api.ts";
import { navigate } from "../net/navigate.ts";
import SeriesRoute, { endReasonWords, seriesTestid } from "./series.tsx";

vi.mock("../net/api.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../net/api.ts")>();
  return { ...actual, getSeries: vi.fn(), pickSeriesDeck: vi.fn(), forfeitSeries: vi.fn() };
});
vi.mock("../net/navigate.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../net/navigate.ts")>();
  return { ...actual, navigate: vi.fn() };
});

const TOKEN = "token-1";
const SERIES_ID = "series-1";
/** The server's clock: nowhere near this device's, on purpose (R260). */
const SERVER_NOW = 1_000_000;
const MS_PER_SECOND = 1000;

const THEIR_SECRET_NAMES = ["Their Aggro", "Their Control", "Their Ramp"];

function view(overrides: Partial<SeriesView> = {}): SeriesView {
  return {
    id: SERIES_ID,
    status: "picking",
    gameNo: 1,
    winsNeeded: SERIES_WINS_NEEDED,
    maxGames: SERIES_MAX_GAMES,
    pickDeadline: SERVER_NOW + SERIES_PICK_SECONDS * MS_PER_SECOND,
    now: SERVER_NOW,
    currentMatchId: null,
    you: {
      seat: "p1",
      wins: 0,
      trioName: "Main trio",
      decks: [
        { slot: 0, name: "Aggro", cards: ["core-001"], played: false },
        { slot: 1, name: "Control", cards: ["core-002"], played: false },
        { slot: 2, name: "Ramp", cards: ["core-003"], played: false },
      ],
      pick: null,
    },
    opponent: {
      wins: 0,
      decks: [
        { slot: 0, played: false },
        { slot: 1, played: false },
        { slot: 2, played: false },
      ],
      picked: false,
    },
    games: [],
    result: null,
    ...overrides,
  };
}

/** Game 2's pick phase: you won game 1 with Aggro against their deck 2. */
function game2(overrides: Partial<SeriesView> = {}): SeriesView {
  const base = view();
  return view({
    gameNo: 2,
    you: {
      ...base.you,
      wins: 1,
      decks: base.you.decks.map((deck) => (deck.slot === 0 ? { ...deck, played: true } : deck)),
    },
    opponent: {
      ...base.opponent,
      decks: base.opponent.decks.map((deck) => (deck.slot === 1 ? { ...deck, played: true } : deck)),
    },
    games: [
      {
        gameNo: 1,
        matchId: "m-1",
        yourSlot: 0,
        opponentSlot: 1,
        youWentFirst: true,
        result: "win",
        reason: "hero-death",
      },
    ],
    ...overrides,
  });
}

beforeEach(() => {
  vi.mocked(getSeries).mockResolvedValue(view());
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

/** Let the effects a render scheduled (the auto-open among them) run. */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

async function renderSeries(): Promise<void> {
  render(<SeriesRoute seriesId={SERIES_ID} token={TOKEN} />);
  await screen.findByTestId(seriesTestid.score);
  await settle();
}

describe("the series screen", () => {
  it("R259 shows the score and your decks by name, and of the opponent only whether they picked", async () => {
    vi.mocked(getSeries).mockResolvedValue(game2());
    await renderSeries();

    expect(vi.mocked(getSeries)).toHaveBeenCalledWith(TOKEN, SERIES_ID);
    const score = screen.getByTestId(seriesTestid.score);
    expect(score).toHaveAttribute("data-you", "1");
    expect(score).toHaveAttribute("data-opponent", "0");
    expect(score).toHaveTextContent("You 1 – 0 Opponent");
    expect(score).toHaveTextContent(`First to ${String(SERIES_WINS_NEEDED)} wins`);

    // Your decks: the played one greyed and not pickable, the others pickable.
    expect(screen.getByTestId(seriesTestid.deck(0))).toHaveAttribute("data-played", "true");
    expect(screen.queryByTestId(seriesTestid.pick(0))).toBeNull();
    expect(screen.getByTestId(seriesTestid.pick(1))).toHaveTextContent("Pick");
    expect(screen.getByTestId(seriesTestid.pick(2))).toHaveTextContent("Pick");

    // The opponent: which slots are played, and whether they have picked. Never a name or a pick.
    expect(screen.getByTestId(seriesTestid.opponentDeck(1))).toHaveAttribute("data-played", "true");
    const status = screen.getByTestId(seriesTestid.opponentStatus);
    expect(status).toHaveAttribute("data-picked", "false");
    expect(status).toHaveTextContent("Opponent is choosing…");
    for (const name of THEIR_SECRET_NAMES) expect(screen.queryByText(new RegExp(name))).toBeNull();

    // The history, from your side.
    const game = screen.getByTestId(seriesTestid.game(1));
    expect(game).toHaveAttribute("data-result", "win");
    expect(game).toHaveTextContent("Game 1: Aggro vs their deck 2");
    expect(game).toHaveTextContent("you went first");
  });

  it("R259 says when the opponent has picked, and still not what", async () => {
    vi.mocked(getSeries).mockResolvedValue(view({ opponent: { ...view().opponent, picked: true } }));
    await renderSeries();

    const status = screen.getByTestId(seriesTestid.opponentStatus);
    expect(status).toHaveAttribute("data-picked", "true");
    expect(status).toHaveTextContent("Opponent has picked.");
  });

  it("R259 Pick sends the slot; the pick is highlighted and can be changed until the opponent picks", async () => {
    vi.mocked(pickSeriesDeck).mockImplementation((_token, _id, slot) =>
      Promise.resolve(view({ you: { ...view().you, pick: slot } })),
    );
    await renderSeries();

    fireEvent.click(screen.getByTestId(seriesTestid.pick(1)));
    await waitFor(() => {
      expect(screen.getByTestId(seriesTestid.deck(1))).toHaveAttribute("data-picked", "true");
    });
    expect(vi.mocked(pickSeriesDeck)).toHaveBeenCalledWith(TOKEN, SERIES_ID, 1);
    expect(screen.getByTestId(seriesTestid.pick(1))).toBeDisabled();
    expect(screen.getByText(/You picked Control\. You can change it until your opponent picks\./)).toBeInTheDocument();

    fireEvent.click(screen.getByTestId(seriesTestid.pick(2)));
    await waitFor(() => {
      expect(screen.getByTestId(seriesTestid.deck(2))).toHaveAttribute("data-picked", "true");
    });
    expect(vi.mocked(pickSeriesDeck)).toHaveBeenLastCalledWith(TOKEN, SERIES_ID, 2);
    expect(screen.getByTestId(seriesTestid.deck(1))).toHaveAttribute("data-picked", "false");
  });

  it("a refused pick is shown in the server's words", async () => {
    vi.mocked(pickSeriesDeck).mockRejectedValue(
      new ApiRequestError(409, { code: "conflict", message: "The picks for this game are closed." }),
    );
    await renderSeries();
    fireEvent.click(screen.getByTestId(seriesTestid.pick(0)));

    expect(await screen.findByTestId(seriesTestid.error)).toHaveTextContent("The picks for this game are closed.");
  });

  it("R260 the pick clock counts down from the server's deadline, on the server's clock", async () => {
    const deviceNow = 5_000_000_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(deviceNow);
    await renderSeries();

    // The deadline is SERIES_PICK_SECONDS after the server's `now`, whatever this device's clock says.
    const shown = screen.getByTestId(seriesTestid.clock);
    expect(shown).toHaveAttribute("data-seconds", String(SERIES_PICK_SECONDS));
    expect(shown).toHaveTextContent(`${String(SERIES_PICK_SECONDS)} s`);

    const elapsed = 10;
    clock.mockReturnValue(deviceNow + elapsed * MS_PER_SECOND);
    act(() => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(screen.getByTestId(seriesTestid.clock)).toHaveAttribute(
      "data-seconds",
      String(SERIES_PICK_SECONDS - elapsed),
    );
  });

  it("R259 a game that starts while the player is here opens once, by itself", async () => {
    vi.mocked(pickSeriesDeck).mockResolvedValue(
      view({ status: "playing", pickDeadline: null, currentMatchId: "m-1", you: { ...view().you, pick: 0 } }),
    );
    await renderSeries();
    expect(vi.mocked(navigate)).not.toHaveBeenCalled();

    // The second pick starts the game at once, and the answer says so.
    fireEvent.click(screen.getByTestId(seriesTestid.pick(0)));
    const open = await screen.findByTestId(seriesTestid.openMatch);
    expect(open).toHaveAttribute("href", "/match/m-1");
    expect(open).toHaveTextContent("Open game 1");
    await waitFor(() => {
      expect(vi.mocked(navigate)).toHaveBeenCalledWith("/match/m-1");
    });
    expect(vi.mocked(navigate)).toHaveBeenCalledTimes(1);
  });

  it("R259 a player who comes back here during a game is offered it, not sent away", async () => {
    vi.mocked(getSeries).mockResolvedValue(view({ status: "playing", pickDeadline: null, currentMatchId: "m-1" }));
    await renderSeries();

    expect(screen.getByTestId(seriesTestid.openMatch)).toHaveAttribute("href", "/match/m-1");
    expect(vi.mocked(navigate)).not.toHaveBeenCalled();
  });

  it("R261 a series is forfeited only between games, and only after a confirm", async () => {
    vi.mocked(forfeitSeries).mockResolvedValue(
      view({
        status: "over",
        pickDeadline: null,
        opponent: { ...view().opponent, wins: 0 },
        result: { outcome: "loss", endReason: "forfeit", ratingBefore: 1000, ratingAfter: 984 },
      }),
    );
    await renderSeries();

    fireEvent.click(screen.getByTestId(seriesTestid.forfeit));
    expect(screen.getByTestId(seriesTestid.forfeitConfirm)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId(seriesTestid.forfeitCancel));
    expect(screen.queryByTestId(seriesTestid.forfeitConfirm)).toBeNull();
    expect(vi.mocked(forfeitSeries)).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId(seriesTestid.forfeit));
    fireEvent.click(screen.getByTestId(seriesTestid.forfeitConfirm));
    const result = await screen.findByTestId(seriesTestid.result);
    expect(vi.mocked(forfeitSeries)).toHaveBeenCalledWith(TOKEN, SERIES_ID);
    expect(result).toHaveAttribute("data-outcome", "loss");
    expect(result).toHaveTextContent("You forfeited the series.");
    expect(screen.queryByTestId(seriesTestid.forfeit)).toBeNull();
    cleanup();

    // During a game there is no forfeit: the game is conceded on the board.
    vi.mocked(getSeries).mockResolvedValue(view({ status: "playing", pickDeadline: null, currentMatchId: "m-1" }));
    await renderSeries();
    expect(screen.queryByTestId(seriesTestid.forfeit)).toBeNull();
    expect(screen.getByText(/concede it on the board/)).toBeInTheDocument();
  });

  it("R262 a finished series shows the result, why it ended and the rating before and after", async () => {
    vi.mocked(getSeries).mockResolvedValue(
      game2({
        status: "over",
        pickDeadline: null,
        you: { ...game2().you, wins: SERIES_WINS_NEEDED },
        result: { outcome: "win", endReason: "decided", ratingBefore: 1000, ratingAfter: 1016 },
      }),
    );
    await renderSeries();

    const result = screen.getByTestId(seriesTestid.result);
    expect(result).toHaveAttribute("data-outcome", "win");
    expect(result).toHaveTextContent("You won the series");
    expect(result).toHaveTextContent(`You reached ${String(SERIES_WINS_NEEDED)} game wins first.`);
    expect(result).toHaveTextContent("Rating 1000 → 1016");
    expect(screen.getByTestId(seriesTestid.backToPlay)).toHaveAttribute("href", "/play");
    expect(screen.queryByTestId(seriesTestid.pick(1))).toBeNull();
    expect(screen.queryByTestId(seriesTestid.clock)).toBeNull();
  });

  it("R260 an abandoned series says so and is unrated", async () => {
    vi.mocked(getSeries).mockResolvedValue(
      view({
        status: "over",
        pickDeadline: null,
        result: { outcome: "abandoned", endReason: "abandoned", ratingBefore: null, ratingAfter: null },
      }),
    );
    await renderSeries();

    const result = screen.getByTestId(seriesTestid.result);
    expect(result).toHaveAttribute("data-outcome", "abandoned");
    expect(result).toHaveTextContent("Unrated");
  });

  it("every way a series ends has words", () => {
    const winsNeeded = SERIES_WINS_NEEDED;
    const maxGames = SERIES_MAX_GAMES;
    for (const outcome of ["win", "loss", "draw", "abandoned"] as const) {
      for (const endReason of ["decided", "exhausted", "forfeit", "abandoned"] as const) {
        const words = endReasonWords({ outcome, endReason, ratingBefore: null, ratingAfter: null }, winsNeeded, maxGames);
        expect(words.length).toBeGreaterThan(0);
      }
    }
  });

  it("a series that cannot be read says why, in the server's words", async () => {
    vi.mocked(getSeries).mockRejectedValue(new ApiRequestError(404, { code: "not_found", message: "No such series." }));
    render(<SeriesRoute seriesId={SERIES_ID} token={TOKEN} />);

    expect(await screen.findByTestId(seriesTestid.error)).toHaveTextContent("No such series.");
  });
});
