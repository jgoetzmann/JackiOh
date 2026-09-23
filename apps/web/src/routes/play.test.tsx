// `/play`'s match watch: the two moments a player ends up paired without being told.
//
// Only one side's HTTP response ever carries the match id, so the other side has to read its own
// `currentMatchId`. That matters while WAITING in the lobby, and again on a RELOAD after being
// paired — the second loses the waiting flag with the page, and was a dead end until the check
// was moved to run on every mount.
//
// And R172's deck picker: which deck the queue and both room calls send.

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DECK_SIZE } from "../game/deckbuilder/deckSize.ts";
import { fixtureCardId } from "../game/deckbuilder/fixtures.ts";
import {
  createRoom,
  enqueue,
  getLoadout,
  getMe,
  joinRoom,
  listDecks,
  type LibraryDeck,
} from "../net/api.ts";
import { navigate } from "../net/navigate.ts";
import PlayRoute from "./play.tsx";

vi.mock("../net/api.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../net/api.ts")>();
  return {
    ...actual,
    getMe: vi.fn(),
    getLoadout: vi.fn(),
    listDecks: vi.fn(),
    enqueue: vi.fn(),
    dequeue: vi.fn(),
    createRoom: vi.fn(),
    joinRoom: vi.fn(),
  };
});
vi.mock("../net/navigate.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../net/navigate.ts")>();
  return { ...actual, navigate: vi.fn() };
});

const TOKEN = "token-1";

function me(currentMatchId: string | null) {
  return {
    profile: { id: "p1", status: "active" as const, rating: 1000 },
    needsInviteCode: false,
    emailVerified: true,
    currentMatchId,
    email: "player1@example.com",
  };
}

/** R171's cap as the fake server reports it; the picker never reads it. */
const ANY_CAP = 2;

function libraryDeck(id: string, size: number): LibraryDeck {
  const cards = Array.from({ length: size }, (_unused, index) => fixtureCardId(index + 1));
  return { id, name: `Deck ${id}`, cards, updatedAt: 0 };
}

function serveLibrary(decks: LibraryDeck[]): void {
  vi.mocked(listDecks).mockResolvedValue({ catalogVersion: "v1", maxDecks: ANY_CAP, decks });
}

function serveLoadout(saved: boolean): void {
  vi.mocked(getLoadout).mockResolvedValue({
    catalogVersion: "v1",
    loadout: saved ? { catalogVersion: "v1", decks: [], updatedAt: 0 } : null,
  });
}

beforeEach(() => {
  serveLibrary([]);
  serveLoadout(true);
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

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

  it("leaves a player who is in no match exactly where they are", async () => {
    vi.mocked(getMe).mockResolvedValue(me(null));
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
  });
});

describe("the deck picker (R172)", () => {
  const short = libraryDeck("short", DECK_SIZE - 1);
  const first = libraryDeck("first", DECK_SIZE);
  const second = libraryDeck("second", DECK_SIZE);

  function picker(): HTMLSelectElement {
    return screen.getByTestId("play-deck") as HTMLSelectElement;
  }

  function option(value: string): HTMLOptionElement | null {
    return picker().querySelector(`option[value="${value}"]`);
  }

  beforeEach(() => {
    vi.mocked(getMe).mockResolvedValue(me(null));
    vi.mocked(enqueue).mockResolvedValue({ status: "queued", population: 1 });
    vi.mocked(createRoom).mockResolvedValue({ code: "ABCDEF", expiresAt: 0 });
    vi.mocked(joinRoom).mockResolvedValue({ matchId: "m-1", code: "ABCDEF", seat: "p2" });
  });

  it("R172 defaults to the first complete library deck, and queues with its id", async () => {
    serveLibrary([short, first, second]);
    render(<PlayRoute token={TOKEN} />);
    await waitFor(() => {
      expect(picker()).toHaveValue("library:first");
    });
    // An incomplete deck is listed with its count, and still selectable: the server decides.
    expect(option("library:short")).toBeEnabled();
    expect(option("library:short")?.textContent).toContain(
      `${String(DECK_SIZE - 1)}/${String(DECK_SIZE)}`,
    );
    expect(option("library:second")).toBeEnabled();

    fireEvent.click(screen.getByTestId("play-queue"));
    await waitFor(() => {
      expect(vi.mocked(enqueue)).toHaveBeenCalledWith(TOKEN, { deckId: first.id });
    });
  });

  it("falls back to loadout deck 1 when the library holds no complete deck", async () => {
    serveLibrary([short]);
    render(<PlayRoute token={TOKEN} />);
    await waitFor(() => {
      expect(option("library:short")).not.toBeNull();
    });
    expect(picker()).toHaveValue("loadout:0");

    fireEvent.click(screen.getByTestId("play-queue"));
    await waitFor(() => {
      expect(vi.mocked(enqueue)).toHaveBeenCalledWith(TOKEN, { deckIndex: 0 });
    });
  });

  it("falls back to loadout deck 1 when both reads fail", async () => {
    vi.mocked(listDecks).mockRejectedValue(new Error("offline"));
    vi.mocked(getLoadout).mockRejectedValue(new Error("offline"));
    render(<PlayRoute token={TOKEN} />);
    await waitFor(() => {
      expect(vi.mocked(getLoadout)).toHaveBeenCalled();
    });
    expect(picker()).toHaveValue("loadout:0");

    fireEvent.click(screen.getByTestId("play-create-room"));
    await waitFor(() => {
      expect(vi.mocked(createRoom)).toHaveBeenCalledWith(TOKEN, { deckIndex: 0 });
    });
  });

  it("lists the loadout's decks only when one is saved", async () => {
    serveLibrary([first]);
    serveLoadout(false);
    render(<PlayRoute token={TOKEN} />);
    await waitFor(() => {
      expect(picker()).toHaveValue("library:first");
    });
    expect(option("loadout:0")).toBeNull();
  });

  it("sends the picked deck to create-room and to join", async () => {
    serveLibrary([first, second]);
    render(<PlayRoute token={TOKEN} />);
    await waitFor(() => {
      expect(picker()).toHaveValue("library:first");
    });

    fireEvent.change(picker(), { target: { value: "loadout:2" } });
    fireEvent.click(screen.getByTestId("play-create-room"));
    await waitFor(() => {
      expect(vi.mocked(createRoom)).toHaveBeenCalledWith(TOKEN, { deckIndex: 2 });
    });

    await waitFor(() => {
      expect(picker()).toBeEnabled();
    });
    fireEvent.change(picker(), { target: { value: "library:second" } });
    fireEvent.change(screen.getByTestId("play-join-code"), { target: { value: "abcdef" } });
    fireEvent.submit(screen.getByTestId("play-join-form"));
    await waitFor(() => {
      expect(vi.mocked(joinRoom)).toHaveBeenCalledWith(TOKEN, "ABCDEF", { deckId: second.id });
    });
  });
});
