// `/play`: the lobby's modes, choices and refusals (R257, R264), and its watch.
//
// The watch: only one side's HTTP response ever carries the match (or series) id, so the other side
// has to read its own `currentMatchId` / `currentSeriesId`. That matters while WAITING in the lobby,
// and again on a RELOAD after being paired — the second loses the waiting flag with the page, and
// was a dead end until the check was moved to run on every mount.
//
// The modes: the lobby sends intent (`ModeChoice`) and relays what the server said. Its verdict is
// the shared validator's, as UX; a refusal is shown in the server's words.

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DECK_SIZE } from "@jackioh/engine/config";
import type { CardDef, CardDefs } from "@jackioh/shared";
import { validateDeck, validateTrio, type LoadoutResult } from "@jackioh/validator";

import { DECK_NAME_MAX_LENGTH, MAX_SAVED_DECKS, MAX_SAVED_TRIOS } from "../../../server/src/config.ts";
import {
  ApiRequestError,
  createRoom,
  enqueue,
  getCatalog,
  getCollection,
  getDecks,
  getMe,
  getPopulation,
  joinRoom,
  type DecksResponse,
  type EnqueueResponse,
  type QueueMode,
  type SavedDeck,
  type SavedTrio,
} from "../net/api.ts";
import { navigate, paths } from "../net/navigate.ts";
import PlayRoute, { MODE_LABEL, PLAY_CHOICE_KEY, playModeTestid, playTestid } from "./play.tsx";

vi.mock("../net/api.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../net/api.ts")>();
  return {
    ...actual,
    getMe: vi.fn(),
    enqueue: vi.fn(),
    dequeue: vi.fn(),
    createRoom: vi.fn(),
    joinRoom: vi.fn(),
    getDecks: vi.fn(),
    getCatalog: vi.fn(),
    getCollection: vi.fn(),
    getPopulation: vi.fn(),
  };
});
vi.mock("../net/navigate.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../net/navigate.ts")>();
  return { ...actual, navigate: vi.fn() };
});

const TOKEN = "token-1";

function me(currentMatchId: string | null, currentSeriesId: string | null = null) {
  return {
    profile: { id: "p1", status: "active" as const, rating: 1000 },
    needsInviteCode: false,
    emailVerified: true,
    currentMatchId,
    currentSeriesId,
    email: "player1@example.com",
  };
}

// ---------------------------------------------------------------------------------------------
// fixtures: a catalog, a collection that owns one of everything, four decks and two trios
// ---------------------------------------------------------------------------------------------

function cardId(n: number): string {
  return `core-${String(n).padStart(3, "0")}`;
}

/** DECK_SIZE distinct ids from `from`. */
function run(from: number): string[] {
  return Array.from({ length: DECK_SIZE }, (_, i) => cardId(from + i));
}

const ALL_IDS = Array.from({ length: DECK_SIZE * 3 }, (_, i) => cardId(i + 1));

const DEFS: CardDefs = Object.fromEntries(
  ALL_IDS.map((id) => [id, { id, name: `Card ${id}`, token: false, tags: [] } as unknown as CardDef]),
);

function deck(id: string, name: string, cards: string[]): SavedDeck {
  return { id, name, cards, catalogVersion: "v1", createdAt: 0, updatedAt: 0 };
}

const AGGRO = deck("d-aggro", "Aggro", run(1));
const HALF = deck("d-half", "Half Built", run(1).slice(0, 5));
const CONTROL = deck("d-control", "Control", run(1 + DECK_SIZE));
const RAMP = deck("d-ramp", "Ramp", run(1 + 2 * DECK_SIZE));

function trio(id: string, name: string, deckIds: SavedTrio["deckIds"]): SavedTrio {
  return { id, name, deckIds, createdAt: 0, updatedAt: 0 };
}

const MAIN = trio("t-main", "Main trio", [AGGRO.id, CONTROL.id, RAMP.id]);
const LOOSE = trio("t-loose", "Loose trio", [AGGRO.id, HALF.id, null]);

function decksAnswer(decks: SavedDeck[], trios: SavedTrio[]): DecksResponse {
  return {
    catalogVersion: "v1",
    decks,
    trios,
    limits: { decks: MAX_SAVED_DECKS, trios: MAX_SAVED_TRIOS, nameLength: DECK_NAME_MAX_LENGTH },
  };
}

/** Everyone owns one of every card here, as the collection answer below says. */
const OWNED: Record<string, number> = Object.fromEntries(ALL_IDS.map((id) => [id, 1]));

/**
 * The validator's own sentences for a verdict. They are computed, never typed out: the lobby shows
 * `@jackioh/validator`'s words verbatim, and `messages.test.ts` fails any client file that carries a
 * copy of them.
 */
function messagesOf(result: LoadoutResult): string[] {
  return result.ok ? [] : result.errors.map((error) => error.message);
}

function openTicket(mode: QueueMode): EnqueueResponse {
  return { ticketId: "tk-1", status: "open", matchId: null, seriesId: null, population: 1, mode };
}

beforeEach(() => {
  try {
    window.localStorage.clear();
  } catch {
    // nothing to clear
  }
  vi.mocked(getMe).mockResolvedValue(me(null));
  vi.mocked(getDecks).mockResolvedValue(decksAnswer([AGGRO, HALF, CONTROL, RAMP], [MAIN, LOOSE]));
  vi.mocked(getCatalog).mockResolvedValue({ version: "v1", defs: DEFS });
  vi.mocked(getCollection).mockResolvedValue({
    catalogVersion: "v1",
    entries: ALL_IDS.map((id) => ({ cardId: id, quantity: 1 })),
  });
  vi.mocked(getPopulation).mockResolvedValue({ population: 3, byMode: { bo1: 2, bo3: 0, random: 1 } });
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  try {
    window.localStorage.clear();
  } catch {
    // nothing to clear
  }
});

/** Render the lobby and wait for its decks to load. */
async function renderLobby(): Promise<void> {
  render(<PlayRoute token={TOKEN} />);
  await waitFor(() => {
    expect(vi.mocked(getDecks)).toHaveBeenCalled();
  });
  await screen.findByTestId(playTestid.deckSelect);
}

function pickMode(mode: QueueMode): void {
  fireEvent.click(screen.getByTestId(playModeTestid(mode)));
}

// ---------------------------------------------------------------------------------------------
// the watch
// ---------------------------------------------------------------------------------------------

describe("the lobby's match watch", () => {
  /**
   * The reload case. `waiting` is component state, so a refresh clears it; before the check ran on
   * mount, this player sat in the lobby while their opponent was already on the board.
   */
  it("sends an already-paired player to the board on mount, without queueing again", async () => {
    vi.mocked(getMe).mockResolvedValue(me("match-42"));
    render(<PlayRoute token={TOKEN} />);

    await waitFor(() => {
      expect(vi.mocked(navigate)).toHaveBeenCalledWith("/match/match-42");
    });
  });

  it("R259 sends a player between the games of a series to the series screen on mount", async () => {
    vi.mocked(getMe).mockResolvedValue(me(null, "series-7"));
    render(<PlayRoute token={TOKEN} />);

    await waitFor(() => {
      expect(vi.mocked(navigate)).toHaveBeenCalledWith("/series/series-7");
    });
  });

  it("leaves a player who is in no match exactly where they are", async () => {
    render(<PlayRoute token={TOKEN} />);

    await waitFor(() => {
      expect(vi.mocked(getMe)).toHaveBeenCalled();
    });
    expect(vi.mocked(navigate)).not.toHaveBeenCalled();
  });

  /** A lobby that cannot reach the server is still a lobby, not an error screen. */
  it("ignores a failed read rather than surfacing it as a lobby error", async () => {
    vi.mocked(getMe).mockRejectedValue(new Error("network down"));
    render(<PlayRoute token={TOKEN} />);

    await waitFor(() => {
      expect(vi.mocked(getMe)).toHaveBeenCalled();
    });
    expect(vi.mocked(navigate)).not.toHaveBeenCalled();
    expect(screen.queryByTestId(playTestid.error)).toBeNull();
  });
});

describe("the lobby's way to practice", () => {
  /** /practice needs no account; the lobby links it so a player can find it without typing the URL. */
  it("links to /practice", async () => {
    const { getByTestId } = render(<PlayRoute token={TOKEN} />);

    expect(getByTestId(playTestid.practice)).toHaveAttribute("href", paths.practice);
    expect(paths.practice).toBe("/practice");
    await waitFor(() => {
      expect(vi.mocked(getMe)).toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------------------------
// modes and choices (R257)
// ---------------------------------------------------------------------------------------------

describe("the lobby's modes", () => {
  it("R257 the mode picker offers Best of 1, Best of 3 and All Random, each with its own choice", async () => {
    await renderLobby();

    for (const mode of ["bo1", "bo3", "random"] as const) {
      expect(screen.getByTestId(playModeTestid(mode))).toHaveAttribute("type", "radio");
    }
    // Best of 1 is the default: a deck, listed by name, the first complete one chosen.
    expect(screen.getByTestId(playModeTestid("bo1"))).toBeChecked();
    const deckSelect = screen.getByTestId(playTestid.deckSelect) as HTMLSelectElement;
    expect(Array.from(deckSelect.options).map((option) => option.textContent)).toEqual([
      "Aggro",
      "Half Built",
      "Control",
      "Ramp",
    ]);
    expect(deckSelect.value).toBe(AGGRO.id);
    expect(screen.queryByTestId(playTestid.trioSelect)).toBeNull();

    pickMode("bo3");
    expect(screen.getByTestId(playModeTestid("bo3"))).toBeChecked();
    expect(screen.queryByTestId(playTestid.deckSelect)).toBeNull();
    const trioSelect = screen.getByTestId(playTestid.trioSelect) as HTMLSelectElement;
    expect(Array.from(trioSelect.options).map((option) => option.textContent)).toEqual(["Main trio", "Loose trio"]);

    pickMode("random");
    expect(screen.queryByTestId(playTestid.deckSelect)).toBeNull();
    expect(screen.queryByTestId(playTestid.trioSelect)).toBeNull();
    expect(screen.getByText(/No deck needed/)).toBeInTheDocument();
  });

  it("R257 Find a match sends each mode's choice: a deck, a trio, or nothing at all", async () => {
    vi.mocked(enqueue).mockImplementation((_token, choice) => Promise.resolve(openTicket(choice.mode)));
    await renderLobby();

    fireEvent.change(screen.getByTestId(playTestid.deckSelect), { target: { value: CONTROL.id } });
    fireEvent.click(screen.getByTestId(playTestid.queue));
    await waitFor(() => {
      expect(vi.mocked(enqueue)).toHaveBeenLastCalledWith(TOKEN, { mode: "bo1", deckId: CONTROL.id });
    });
    await screen.findByText(/In the Best of 1 queue/);

    pickMode("bo3");
    fireEvent.change(screen.getByTestId(playTestid.trioSelect), { target: { value: LOOSE.id } });
    fireEvent.click(screen.getByTestId(playTestid.queue));
    await waitFor(() => {
      expect(vi.mocked(enqueue)).toHaveBeenLastCalledWith(TOKEN, { mode: "bo3", trioId: LOOSE.id });
    });
    await screen.findByText(new RegExp(`In the ${MODE_LABEL.bo3} queue`));

    pickMode("random");
    fireEvent.click(screen.getByTestId(playTestid.queue));
    await waitFor(() => {
      expect(vi.mocked(enqueue)).toHaveBeenLastCalledWith(TOKEN, { mode: "random" });
    });
    await screen.findByText(/In the All Random queue/);
  });

  it("remembers the last mode, deck and trio on this device", async () => {
    window.localStorage.setItem(PLAY_CHOICE_KEY, JSON.stringify({ mode: "bo3", deckId: RAMP.id, trioId: LOOSE.id }));
    render(<PlayRoute token={TOKEN} />);

    const trioSelect = (await screen.findByTestId(playTestid.trioSelect)) as HTMLSelectElement;
    expect(screen.getByTestId(playModeTestid("bo3"))).toBeChecked();
    expect(trioSelect.value).toBe(LOOSE.id);
    pickMode("bo1");
    expect((screen.getByTestId(playTestid.deckSelect) as HTMLSelectElement).value).toBe(RAMP.id);

    await waitFor(() => {
      expect(JSON.parse(window.localStorage.getItem(PLAY_CHOICE_KEY) ?? "{}")).toMatchObject({ mode: "bo1" });
    });
  });

  it("R253 the verdict is the shared validator's, as UX: Ready, or its messages, and the buttons stay live", async () => {
    await renderLobby();
    await waitFor(() => {
      expect(screen.getByTestId(playTestid.verdict)).toHaveAttribute("data-ready", "true");
    });
    expect(screen.getByTestId(playTestid.verdict)).toHaveTextContent("Ready");

    fireEvent.change(screen.getByTestId(playTestid.deckSelect), { target: { value: HALF.id } });
    const verdict = screen.getByTestId(playTestid.verdict);
    expect(verdict).toHaveAttribute("data-ready", "false");
    const halfIssues = messagesOf(
      validateDeck({ deck: { name: HALF.name, cards: HALF.cards }, catalog: { version: "v1", cards: DEFS }, collection: OWNED }),
    );
    expect(halfIssues.length).toBeGreaterThan(0);
    for (const message of halfIssues) expect(verdict).toHaveTextContent(message);
    // UX only: the server decides.
    expect(screen.getByTestId(playTestid.queue)).not.toBeDisabled();

    pickMode("bo3");
    fireEvent.change(screen.getByTestId(playTestid.trioSelect), { target: { value: LOOSE.id } });
    const looseIssues = messagesOf(
      validateTrio({
        decks: [AGGRO, HALF].map((saved) => ({ name: saved.name, cards: saved.cards })),
        catalog: { version: "v1", cards: DEFS },
        collection: OWNED,
      }),
    );
    expect(looseIssues.length).toBeGreaterThan(0);
    expect(screen.getByTestId(playTestid.verdict)).toHaveTextContent(looseIssues[0] ?? "");
  });

  it("a player with no decks is sent to /decks, and has nothing to queue a Best of 1 with", async () => {
    vi.mocked(getDecks).mockResolvedValue(decksAnswer([], []));
    render(<PlayRoute token={TOKEN} />);

    const link = await screen.findByTestId(playTestid.decksLink);
    expect(link).toHaveAttribute("href", "/decks");
    expect(screen.getByTestId(playTestid.queue)).toBeDisabled();

    // All Random needs no deck at all.
    pickMode("random");
    expect(screen.getByTestId(playTestid.queue)).not.toBeDisabled();
  });

  it("shows the queue's population per mode", async () => {
    await renderLobby();
    const population = await screen.findByTestId(playTestid.population);
    expect(population).toHaveAttribute("data-bo1", "2");
    expect(population).toHaveAttribute("data-bo3", "0");
    expect(population).toHaveAttribute("data-random", "1");
  });
});

// ---------------------------------------------------------------------------------------------
// answers and refusals
// ---------------------------------------------------------------------------------------------

describe("the lobby's answers", () => {
  it("R253 a 422 loadout_invalid shows the server's messages verbatim", async () => {
    // Whatever the server says is shown as it said it, so these need not be the validator's words.
    const issues = [
      { rule: "L2", message: "Server sentence one about Half Built.", deck: 1 },
      { rule: "L5", message: "Server sentence two about Half Built.", deck: 1 },
    ];
    vi.mocked(enqueue).mockRejectedValue(
      new ApiRequestError(422, { code: "loadout_invalid", message: issues[0]?.message ?? "", details: issues }),
    );
    await renderLobby();
    fireEvent.click(screen.getByTestId(playTestid.queue));

    const error = await screen.findByTestId(playTestid.error);
    for (const issue of issues) expect(error).toHaveTextContent(issue.message);
  });

  it("any other refusal is the server's message, and a series still running is linked", async () => {
    vi.mocked(enqueue).mockRejectedValue(
      new ApiRequestError(409, {
        code: "already_in_match",
        message: "Finish your Conquest series first.",
        details: { seriesId: "series-9" },
      }),
    );
    await renderLobby();
    fireEvent.click(screen.getByTestId(playTestid.queue));

    const error = await screen.findByTestId(playTestid.error);
    expect(error).toHaveTextContent("Finish your Conquest series first.");
    expect(screen.getByTestId(playTestid.seriesLink)).toHaveAttribute("href", "/series/series-9");
  });

  it("R259 an enqueue that pairs into a series goes to the series screen", async () => {
    vi.mocked(enqueue).mockResolvedValue({
      ...openTicket("bo3"),
      status: "matched",
      seriesId: "series-1",
    });
    await renderLobby();
    pickMode("bo3");
    fireEvent.click(screen.getByTestId(playTestid.queue));

    await waitFor(() => {
      expect(vi.mocked(navigate)).toHaveBeenCalledWith("/series/series-1");
    });
  });

  it("a join that makes a series goes to the series screen; one that makes a match, to the board", async () => {
    vi.mocked(joinRoom).mockResolvedValueOnce({ matchId: null, seriesId: "series-2", code: "ABCD", seat: "p2", mode: "bo3" });
    await renderLobby();
    pickMode("bo3");
    fireEvent.change(screen.getByTestId(playTestid.joinInput), { target: { value: "abcd" } });
    fireEvent.submit(screen.getByTestId(playTestid.joinForm));

    await waitFor(() => {
      expect(vi.mocked(navigate)).toHaveBeenCalledWith("/series/series-2");
    });
    expect(vi.mocked(joinRoom)).toHaveBeenCalledWith(TOKEN, "ABCD", { mode: "bo3", trioId: MAIN.id });

    vi.mocked(joinRoom).mockResolvedValueOnce({ matchId: "match-3", seriesId: null, code: "ABCD", seat: "p2", mode: "random" });
    pickMode("random");
    fireEvent.submit(screen.getByTestId(playTestid.joinForm));
    await waitFor(() => {
      expect(vi.mocked(navigate)).toHaveBeenCalledWith("/match/match-3");
    });
  });

  it("R264 a join refused for another mode switches to the room's mode and says what to pick", async () => {
    vi.mocked(joinRoom).mockRejectedValue(
      new ApiRequestError(409, {
        code: "conflict",
        message: "This room plays Conquest: pick one of your trios.",
        details: { mode: "bo3" },
      }),
    );
    await renderLobby();
    fireEvent.change(screen.getByTestId(playTestid.joinInput), { target: { value: "wxyz" } });
    fireEvent.submit(screen.getByTestId(playTestid.joinForm));

    const error = await screen.findByTestId(playTestid.error);
    expect(error).toHaveTextContent(`This room plays ${MODE_LABEL.bo3}: pick a trio and join again.`);
    expect(screen.getByTestId(playModeTestid("bo3"))).toBeChecked();
    expect(screen.getByTestId(playTestid.trioSelect)).toBeInTheDocument();
    // The code is kept, so joining again is one press.
    expect(screen.getByTestId(playTestid.joinInput)).toHaveValue("wxyz");
  });

  it("R264 Create a room sends the choice and shows the code with the room's mode", async () => {
    vi.mocked(createRoom).mockResolvedValue({ code: "QRST", expiresAt: 0, mode: "random" });
    await renderLobby();
    pickMode("random");
    fireEvent.click(screen.getByTestId(playTestid.createRoom));

    expect(await screen.findByTestId(playTestid.roomCode)).toHaveTextContent("QRST");
    expect(vi.mocked(createRoom)).toHaveBeenCalledWith(TOKEN, { mode: "random" });
    const roomMode = screen.getByTestId(playTestid.roomMode);
    expect(roomMode).toHaveAttribute("data-mode", "random");
    expect(roomMode).toHaveTextContent("All Random");
  });
});
