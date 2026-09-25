// `/series/<id>`: the Conquest series between its games (R330–R338, R262), from the server's
// projection.
//
// Everything on the screen comes from the `SeriesView` the mocked API answers; the tests show that
// what the view leaves out (the opponent's pick and deck names, R336) never appears, that a pick
// (chosen, then locked in, R331) and a forfeit send exactly the player's intent, that both sides'
// won decks are shown locked (R330), and that the clock is counted from the server's own `now`
// rather than this device's clock (R333).

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
/** The server's clock: nowhere near this device's, on purpose (R333). */
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
        { slot: 0, name: "Aggro", cards: ["core-001"], won: false, games: 0 },
        { slot: 1, name: "Control", cards: ["core-002"], won: false, games: 0 },
        { slot: 2, name: "Ramp", cards: ["core-003"], won: false, games: 0 },
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

/** Game 2's pick phase: you won game 1 with Aggro against their deck 2, which may play again. */
function game2(overrides: Partial<SeriesView> = {}): SeriesView {
  const base = view();
  return view({
    gameNo: 2,
    you: {
      ...base.you,
      wins: 1,
      decks: base.you.decks.map((deck) => (deck.slot === 0 ? { ...deck, won: true, games: 1 } : deck)),
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
  it("R336 shows the score, your decks by name with the won one locked, and of the opponent only won decks and whether they picked", async () => {
    vi.mocked(getSeries).mockResolvedValue(
      game2({ opponent: { ...game2().opponent, wins: 1, decks: [{ slot: 0, won: false }, { slot: 1, won: false }, { slot: 2, won: true }] } }),
    );
    await renderSeries();

    expect(vi.mocked(getSeries)).toHaveBeenCalledWith(TOKEN, SERIES_ID);
    const score = screen.getByTestId(seriesTestid.score);
    expect(score).toHaveAttribute("data-you", "1");
    expect(score).toHaveAttribute("data-opponent", "1");
    expect(score).toHaveTextContent("You 1 – 1 Opponent");
    expect(score).toHaveTextContent(`Win with all ${String(SERIES_WINS_NEEDED)} decks`);
    expect(score).toHaveTextContent(`game 2 of at most ${String(SERIES_MAX_GAMES)}`);

    // Your decks: the one that won is locked, in the standings and in the picker.
    expect(screen.getByTestId(seriesTestid.deck(0))).toHaveAttribute("data-won", "true");
    expect(screen.getByTestId(seriesTestid.deck(0))).toHaveTextContent("won · locked");
    expect(screen.getByTestId(seriesTestid.deck(1))).toHaveAttribute("data-won", "false");
    expect(screen.getByTestId(seriesTestid.pick(0))).toBeDisabled();
    expect(screen.getByTestId(seriesTestid.pick(1))).toBeEnabled();
    expect(screen.getByTestId(seriesTestid.pick(2))).toBeEnabled();

    // The opponent: which decks have won, and whether they have picked. Never a name or a pick.
    expect(screen.getByTestId(seriesTestid.opponentDeck(2))).toHaveAttribute("data-won", "true");
    expect(screen.getByTestId(seriesTestid.opponentDeck(1))).toHaveAttribute("data-won", "false");
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

  it("R331 says when the opponent has picked, and still not what", async () => {
    vi.mocked(getSeries).mockResolvedValue(view({ opponent: { ...view().opponent, picked: true } }));
    await renderSeries();

    const status = screen.getByTestId(seriesTestid.opponentStatus);
    expect(status).toHaveAttribute("data-picked", "true");
    expect(status).toHaveTextContent("Opponent has picked");
  });

  it("R331 a deck is chosen, then locked in: only the lock-in sends it, and then the panel waits, sealed", async () => {
    vi.mocked(pickSeriesDeck).mockImplementation((_token, _id, slot) =>
      Promise.resolve(view({ you: { ...view().you, pick: slot } })),
    );
    await renderSeries();

    const picker = screen.getByTestId(seriesTestid.picker);
    expect(picker).toHaveAttribute("data-state", "choosing");
    expect(screen.getByTestId(seriesTestid.lockIn)).toBeDisabled();

    // Choosing is local: nothing is sent, and a second choice replaces the first.
    fireEvent.click(screen.getByTestId(seriesTestid.pick(2)));
    fireEvent.click(screen.getByTestId(seriesTestid.pick(1)));
    expect(screen.getByTestId(seriesTestid.pick(1))).toBeChecked();
    expect(screen.getByTestId(seriesTestid.pick(2))).not.toBeChecked();
    expect(vi.mocked(pickSeriesDeck)).not.toHaveBeenCalled();
    expect(screen.getByTestId(seriesTestid.lockIn)).toHaveTextContent("Lock in Control");

    fireEvent.click(screen.getByTestId(seriesTestid.lockIn));
    await waitFor(() => {
      expect(screen.getByTestId(seriesTestid.picker)).toHaveAttribute("data-state", "waiting");
    });
    expect(vi.mocked(pickSeriesDeck)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(pickSeriesDeck)).toHaveBeenCalledWith(TOKEN, SERIES_ID, 1);
    expect(screen.getByTestId(seriesTestid.picker)).toHaveTextContent("Waiting for your opponent…");
    expect(screen.getByTestId(seriesTestid.picker)).toHaveTextContent("You’re playing Control in game 1.");
    expect(screen.getByTestId(seriesTestid.deck(1))).toHaveAttribute("data-picked", "true");
    // Sealed: no deck can be chosen any more.
    expect(screen.queryByTestId(seriesTestid.pick(2))).toBeNull();
    expect(screen.queryByTestId(seriesTestid.lockIn)).toBeNull();
  });

  it("R332 a last deck picked for the player is said so, and the panel only waits", async () => {
    const base = view();
    vi.mocked(getSeries).mockResolvedValue(
      view({
        gameNo: 3,
        you: {
          ...base.you,
          wins: 2,
          pick: 2,
          autoPick: true,
          decks: base.you.decks.map((deck) => (deck.slot === 2 ? deck : { ...deck, won: true, games: 1 })),
        },
      }),
    );
    await renderSeries();

    const picker = screen.getByTestId(seriesTestid.picker);
    expect(picker).toHaveAttribute("data-state", "waiting");
    expect(picker).toHaveAttribute("data-auto", "true");
    expect(picker).toHaveTextContent("Ramp is your last deck that hasn’t won, so it was picked for you for game 3.");
    expect(screen.queryByTestId(seriesTestid.lockIn)).toBeNull();
  });

  it("a refused pick is shown in the server's words", async () => {
    vi.mocked(pickSeriesDeck).mockRejectedValue(
      new ApiRequestError(409, { code: "conflict", message: "The pick clock has run out for this game." }),
    );
    await renderSeries();
    fireEvent.click(screen.getByTestId(seriesTestid.pick(0)));
    fireEvent.click(screen.getByTestId(seriesTestid.lockIn));

    expect(await screen.findByTestId(seriesTestid.error)).toHaveTextContent("The pick clock has run out for this game.");
  });

  it("R333 the pick clock counts down from the server's deadline, on the server's clock", async () => {
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

  it("R338 a game that starts while the player is here opens once, by itself", async () => {
    vi.mocked(pickSeriesDeck).mockResolvedValue(
      view({ status: "playing", pickDeadline: null, currentMatchId: "m-1", you: { ...view().you, pick: 0 } }),
    );
    await renderSeries();
    expect(vi.mocked(navigate)).not.toHaveBeenCalled();

    // The second pick starts the game at once, and the answer says so.
    fireEvent.click(screen.getByTestId(seriesTestid.pick(0)));
    fireEvent.click(screen.getByTestId(seriesTestid.lockIn));
    const open = await screen.findByTestId(seriesTestid.openMatch);
    expect(open).toHaveAttribute("href", "/match/m-1");
    expect(open).toHaveTextContent("Open game 1");
    await waitFor(() => {
      expect(vi.mocked(navigate)).toHaveBeenCalledWith("/match/m-1");
    });
    expect(vi.mocked(navigate)).toHaveBeenCalledTimes(1);
  });

  it("R338 a player who comes back here during a game is offered it, not sent away", async () => {
    vi.mocked(getSeries).mockResolvedValue(view({ status: "playing", pickDeadline: null, currentMatchId: "m-1" }));
    await renderSeries();

    expect(screen.getByTestId(seriesTestid.openMatch)).toHaveAttribute("href", "/match/m-1");
    expect(vi.mocked(navigate)).not.toHaveBeenCalled();
  });

  it("R334 a series is forfeited only between games, and only after a confirm", async () => {
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
    expect(result).toHaveTextContent(`You won a game with each of your ${String(SERIES_WINS_NEEDED)} decks.`);
    expect(result).toHaveTextContent("Rating 1000 → 1016");
    expect(screen.getByTestId(seriesTestid.backToPlay)).toHaveAttribute("href", "/play");
    expect(screen.queryByTestId(seriesTestid.pick(1))).toBeNull();
    expect(screen.queryByTestId(seriesTestid.clock)).toBeNull();
  });

  it("R333 an abandoned series says so and is unrated", async () => {
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
