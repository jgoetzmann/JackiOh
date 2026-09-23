// `/library`: the gate, the three reads, and what each save does to the route's own list.
//
// The constructor (`game/library/Library.tsx`) has its own tests, so it is mocked here and this
// file asserts on the props the route hands it — the same split as `decks.test.tsx` and
// `Deckbuilder.test.tsx`. Refusals are built from `validateDeck`'s own output, never typed out.

import { validateDeck } from "@jackioh/validator";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DECK_SIZE } from "../game/deckbuilder/deckSize.ts";
import { fixtureCardId, fixtureCatalog, fixtureCollection } from "../game/deckbuilder/fixtures.ts";
import type { LibraryProps } from "../game/library/Library.tsx";
import {
  ApiRequestError,
  createDeck,
  deleteDeck,
  getCatalog,
  getCollection,
  getMe,
  listDecks,
  updateDeck,
  type LibraryDeck,
} from "../net/api.ts";
import { E2E_SESSION_STORAGE_KEY } from "../net/session.ts";
import LibraryRoute from "./library.tsx";

const { LibraryMock } = vi.hoisted(() => ({
  LibraryMock: vi.fn((_props: LibraryProps) => null),
}));
vi.mock("../game/library/Library.tsx", () => ({ default: LibraryMock }));

vi.mock("../net/api.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../net/api.ts")>();
  return {
    ...actual,
    getMe: vi.fn(),
    getCatalog: vi.fn(),
    getCollection: vi.fn(),
    listDecks: vi.fn(),
    createDeck: vi.fn(),
    updateDeck: vi.fn(),
    deleteDeck: vi.fn(),
  };
});

const TOKEN = "e2e-token-p1";
const catalog = fixtureCatalog();
const collection = fixtureCollection();
/** R171's cap as the fake server reports it; the route passes it through untouched. */
const MAX_DECKS = 5;

function deckOf(id: string, size: number): LibraryDeck {
  const cards = Array.from({ length: size }, (_unused, index) => fixtureCardId(index + 1));
  return { id, name: `Deck ${id}`, cards, updatedAt: 0 };
}

const older = deckOf("older", DECK_SIZE);
const newer = deckOf("newer", DECK_SIZE - 1);

beforeEach(() => {
  vi.mocked(getCatalog).mockResolvedValue({ version: catalog.version, defs: catalog.cards });
  vi.mocked(getCollection).mockResolvedValue({
    catalogVersion: catalog.version,
    entries: Object.entries(collection).map(([cardId, quantity]) => ({ cardId, quantity })),
  });
  vi.mocked(listDecks).mockResolvedValue({
    catalogVersion: catalog.version,
    maxDecks: MAX_DECKS,
    decks: [newer, older],
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** The props of the constructor's most recent render. */
function props(): LibraryProps {
  const last = LibraryMock.mock.lastCall?.[0];
  if (last === undefined) throw new Error("the constructor has not rendered");
  return last;
}

async function mount(): Promise<void> {
  render(<LibraryRoute token={TOKEN} />);
  await waitFor(() => {
    expect(LibraryMock).toHaveBeenCalled();
  });
}

// ---------------------------------------------------------------------------------------------
// the reads
// ---------------------------------------------------------------------------------------------

describe("what the constructor opens with", () => {
  it("holds a loading panel until the reads land", async () => {
    render(<LibraryRoute token={TOKEN} />);
    expect(screen.getByTestId("library-loading")).toBeInTheDocument();
    await waitFor(() => {
      expect(LibraryMock).toHaveBeenCalled();
    });
    expect(screen.queryByTestId("library-loading")).toBeNull();
  });

  it("hands down the catalog, the collection, the decks and the cap", async () => {
    await mount();
    expect(listDecks).toHaveBeenCalledWith(TOKEN);
    expect(getCollection).toHaveBeenCalledWith(TOKEN);
    const given = props();
    expect(given.catalog).toEqual(catalog);
    expect(given.collection).toEqual(collection);
    expect(given.decks).toEqual([newer, older]);
    expect(given.maxDecks).toBe(MAX_DECKS);
  });

  it("still opens when the collection cannot be read, with no collection", async () => {
    vi.mocked(getCollection).mockRejectedValue(new Error("collection unavailable"));
    await mount();
    expect(props().collection).toBeNull();
  });

  it("shows the reason when the library or the catalog cannot be read", async () => {
    vi.mocked(listDecks).mockRejectedValue(
      new ApiRequestError(403, { code: "account_pending", message: "redeem an invite code first" }),
    );
    render(<LibraryRoute token={TOKEN} />);
    await waitFor(() => {
      expect(screen.getByTestId("library-error")).toHaveTextContent("redeem an invite code first");
    });
    expect(LibraryMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------
// the writes
// ---------------------------------------------------------------------------------------------

describe("saving", () => {
  const draft = { name: "Fresh", cards: [fixtureCardId(1)] };

  it("creates a deck stamped with the list's catalog version, and puts it at the top", async () => {
    const stored = { ...deckOf("fresh", 1), name: draft.name };
    vi.mocked(createDeck).mockResolvedValue({ deck: stored });
    await mount();

    let outcome: Awaited<ReturnType<LibraryProps["create"]>> | undefined;
    await act(async () => {
      outcome = await props().create(draft);
    });
    expect(createDeck).toHaveBeenCalledWith(TOKEN, catalog.version, draft);
    expect(outcome).toEqual({ ok: true, deck: stored });
    expect(props().decks).toEqual([stored, newer, older]);
  });

  it("replaces an edited deck in place", async () => {
    const edited = { ...older, name: "Renamed" };
    vi.mocked(updateDeck).mockResolvedValue({ deck: edited });
    await mount();

    await act(async () => {
      await props().save(older.id, { name: edited.name, cards: edited.cards });
    });
    expect(updateDeck).toHaveBeenCalledWith(TOKEN, catalog.version, older.id, {
      name: edited.name,
      cards: edited.cards,
    });
    expect(props().decks).toEqual([newer, edited]);
  });

  it("drops a deleted deck from the list", async () => {
    vi.mocked(deleteDeck).mockResolvedValue({ ok: true });
    await mount();

    let outcome: Awaited<ReturnType<LibraryProps["remove"]>> | undefined;
    await act(async () => {
      outcome = await props().remove(newer.id);
    });
    expect(deleteDeck).toHaveBeenCalledWith(TOKEN, newer.id);
    expect(outcome).toEqual({ ok: true });
    expect(props().decks).toEqual([older]);
  });

  it("relays a 422's validator issues verbatim and leaves the list alone", async () => {
    // Two copies of one card: L3, from the validator itself.
    const illegal = { name: "Twice", cards: [fixtureCardId(1), fixtureCardId(1)] };
    const result = validateDeck({
      deck: { name: illegal.name, cards: illegal.cards },
      catalog,
      collection,
      allowIncomplete: true,
    });
    const issues = result.ok ? [] : result.errors;
    expect(issues.length, "the scenario really is illegal").toBeGreaterThan(0);
    vi.mocked(createDeck).mockRejectedValue(
      new ApiRequestError(422, {
        code: "loadout_invalid",
        message: issues[0]?.message ?? "",
        details: issues,
      }),
    );
    await mount();

    let outcome: Awaited<ReturnType<LibraryProps["create"]>> | undefined;
    await act(async () => {
      outcome = await props().create(illegal);
    });
    expect(outcome).toEqual({ ok: false, message: issues[0]?.message, issues });
    expect(props().decks).toEqual([newer, older]);
  });

  it("shows any other refusal as the server's own sentence", async () => {
    vi.mocked(updateDeck).mockRejectedValue(
      new ApiRequestError(409, { code: "catalog_stale", message: "update required" }),
    );
    await mount();

    let outcome: Awaited<ReturnType<LibraryProps["save"]>> | undefined;
    await act(async () => {
      outcome = await props().save(older.id, draft);
    });
    expect(outcome).toEqual({ ok: false, message: "update required", issues: [] });
    expect(props().decks).toEqual([newer, older]);
  });
});

// ---------------------------------------------------------------------------------------------
// §9.4's gate, through main.tsx's route table
// ---------------------------------------------------------------------------------------------

// After the mocks: `main.tsx` pulls in the route modules, which must see the mocked API.
const { App } = await import("../main.tsx");

describe("the gate (§9.4)", () => {
  function meBody(status: "pending" | "active") {
    return {
      profile: { id: "p", status, rating: 1000 },
      needsInviteCode: status === "pending",
      emailVerified: true,
      currentMatchId: null,
      email: "player@example.test",
    };
  }

  beforeEach(() => {
    window.localStorage.clear();
    window.localStorage.setItem(E2E_SESSION_STORAGE_KEY, JSON.stringify({ accessToken: TOKEN }));
    window.history.replaceState(null, "", "/library");
  });

  it("sends a pending account to the code screen, without reading the library", async () => {
    vi.mocked(getMe).mockResolvedValue(meBody("pending"));
    render(<App />);
    await waitFor(() => {
      expect(window.location.pathname).toBe("/invite");
    });
    expect(listDecks).not.toHaveBeenCalled();
  });

  it("opens the library for an active account, with its token", async () => {
    vi.mocked(getMe).mockResolvedValue(meBody("active"));
    render(<App />);
    await waitFor(() => {
      expect(LibraryMock).toHaveBeenCalled();
    });
    expect(window.location.pathname).toBe("/library");
    expect(listDecks).toHaveBeenCalledWith(TOKEN);
  });
});
