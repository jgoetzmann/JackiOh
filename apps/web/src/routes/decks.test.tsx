// `/decks`: §9.4's gate, the three reads the workshop opens with, and the writes it is handed.
//
// `game/deckbuilder/DeckWorkshop.test.tsx` covers the workshop itself. This file covers what the
// route adds: a pending account lands on `/invite` (which is what `10-invite-gate.cy.ts` asserts
// from the browser), an active one stays and sees its saved decks by name, a profile that has saved
// nothing opens an empty workshop rather than an error, a collection that cannot be read leaves
// ownership unclaimed, and a save carries the session's token (R256).

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DECK_AUTOSAVE_DEBOUNCE_MS } from "../../../server/src/config.ts";
import { fixtureCatalog, fixtureCollection, legalDecks } from "../game/deckbuilder/fixtures.ts";
import { mirrorKey } from "../game/deckbuilder/sync.ts";
import { decksResponse, savedDeck, savedTrio } from "../game/deckbuilder/testkit.ts";
import { ApiRequestError, getCatalog, getCollection, getDecks, getMe, putDeck } from "../net/api.ts";
import { E2E_SESSION_STORAGE_KEY } from "../net/session.ts";
import DecksRoute from "./decks.tsx";

vi.mock("../net/api.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../net/api.ts")>();
  return {
    ...actual,
    getMe: vi.fn(),
    getDecks: vi.fn(),
    getCatalog: vi.fn(),
    getCollection: vi.fn(),
    putDeck: vi.fn(),
    deleteDeck: vi.fn(),
    putTrio: vi.fn(),
    deleteTrio: vi.fn(),
  };
});

const TOKEN = "e2e-token-p1";
const PROFILE = "profile-p1";
const catalog = fixtureCatalog();
const collection = fixtureCollection();
const [ONE = [], TWO = []] = legalDecks();

function meBody(status: "pending" | "active" | "banned", needsInviteCode: boolean) {
  return {
    profile: { id: PROFILE, status, rating: 1000 },
    needsInviteCode,
    emailVerified: true,
    currentMatchId: null,
    email: "player@example.test",
  };
}

function collectionBody() {
  return {
    catalogVersion: catalog.version,
    entries: Object.entries(collection).map(([cardId, quantity]) => ({ cardId, quantity })),
  };
}

beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem(E2E_SESSION_STORAGE_KEY, JSON.stringify({ accessToken: TOKEN }));
  window.history.replaceState(null, "", "/decks");
  vi.mocked(getMe).mockResolvedValue(meBody("active", false));
  vi.mocked(getCatalog).mockResolvedValue({ version: catalog.version, defs: catalog.cards });
  vi.mocked(getCollection).mockResolvedValue(collectionBody());
  vi.mocked(getDecks).mockResolvedValue(
    decksResponse(
      [savedDeck("d-aggro", "Aggro", ONE, 1, catalog.version), savedDeck("d-tempo", "Tempo", TWO.slice(0, 4), 2, catalog.version)],
      [savedTrio("t-ladder", "Ladder", ["d-aggro", "d-tempo", null], 3)],
      catalog.version,
    ),
  );
  vi.mocked(putDeck).mockImplementation(async (_token, id, input) => ({
    deck: { id, ...input, cards: [...input.cards], createdAt: 0, updatedAt: 0 },
  }));
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function mount(): Promise<void> {
  render(<DecksRoute />);
  await waitFor(() => {
    expect(screen.getByTestId("workshop")).toBeInTheDocument();
  });
}

// ---------------------------------------------------------------------------------------------
// §9.4's gate
// ---------------------------------------------------------------------------------------------


/** Test harness timing, not game or server configuration: how long the account-switch test waits. */
const SWITCH_WAIT_MS = 10_000;
const SWITCH_TEST_TIMEOUT_MS = 30_000;

describe("the gate (§9.4)", () => {
  it("sends a pending account to the code screen", async () => {
    // `10-invite-gate.cy.ts`: visiting the deckbuilder while pending lands on `/invite`.
    vi.mocked(getMe).mockResolvedValue(meBody("pending", true));
    render(<DecksRoute />);
    await waitFor(() => {
      expect(window.location.pathname).toBe("/invite");
    });
    expect(getDecks, "and the gated reads are never attempted").not.toHaveBeenCalled();
  });

  it("sends an account with no session to the sign-in screen", async () => {
    window.localStorage.clear();
    render(<DecksRoute />);
    await waitFor(() => {
      expect(window.location.pathname).toBe("/login");
    });
  });

  it("keeps an active account on the workshop", async () => {
    await mount();
    expect(window.location.pathname).toBe("/decks");
  });

  it("does not send a banned account to the code screen", async () => {
    // Redemption is the pending → active transition; a banned account has no code to redeem.
    vi.mocked(getMe).mockResolvedValue(meBody("banned", false));
    render(<DecksRoute />);
    await waitFor(() => {
      expect(screen.getByTestId("deckbuilder-error")).toBeInTheDocument();
    });
    expect(window.location.pathname).toBe("/decks");
  });

  it("shows the reason when /api/auth/me cannot be read at all", async () => {
    vi.mocked(getMe).mockRejectedValue(new Error("the server could not be reached"));
    render(<DecksRoute />);
    await waitFor(() => {
      expect(screen.getByTestId("deckbuilder-error")).toHaveTextContent("the server could not be reached");
    });
  });
});

// ---------------------------------------------------------------------------------------------
// The reads
// ---------------------------------------------------------------------------------------------

describe("what the screen opens with", () => {
  it("R250 lists the saved decks and trios by name, with the session's token on the read", async () => {
    await mount();
    expect(getDecks).toHaveBeenCalledWith(TOKEN);
    expect(screen.getByTestId("deck-row-d-aggro")).toHaveTextContent("Aggro");
    expect(screen.getByTestId("deck-row-d-aggro")).toHaveAttribute("data-status", "ready");
    expect(screen.getByTestId("deck-row-d-tempo")).toHaveTextContent("Tempo");
    expect(screen.getByTestId("trio-row-t-ladder")).toHaveTextContent("Ladder");
    expect(screen.getByTestId("sync-status")).toHaveAttribute("data-state", "saved");
  });

  it("opens an empty workshop, and not an error, for a profile that has saved nothing", async () => {
    vi.mocked(getDecks).mockResolvedValue(decksResponse([], [], catalog.version));
    await mount();
    expect(screen.getByTestId("workshop-empty")).toBeInTheDocument();
    expect(screen.getByTestId("deck-new")).toBeEnabled();
    expect(screen.queryByTestId("deckbuilder-error")).toBeNull();
  });

  it("still opens when the collection cannot be read, claiming nothing about ownership", async () => {
    vi.mocked(getCollection).mockRejectedValue(new ApiRequestError(403, { code: "account_pending", message: "no" }));
    await mount();
    // L5 needs quantities; without them a full deck is "Complete", never "Ready" on a guess.
    expect(screen.getByTestId("deck-row-d-aggro")).toHaveAttribute("data-status", "complete");
  });

  it("shows the reason when the decks or the catalog cannot be read", async () => {
    vi.mocked(getCatalog).mockRejectedValue(new Error("catalog unavailable"));
    render(<DecksRoute />);
    await waitFor(() => {
      expect(screen.getByTestId("deckbuilder-error")).toHaveTextContent("catalog unavailable");
    });
  });
});

// ---------------------------------------------------------------------------------------------
// The writes (R256)
// ---------------------------------------------------------------------------------------------

describe("saving", () => {
  it("R256 a new deck is PUT under a client-minted id with the token, the name and the catalog version", async () => {
    await mount();
    fireEvent.click(screen.getByTestId("deck-new"));
    await waitFor(
      () => {
        expect(putDeck).toHaveBeenCalled();
      },
      { timeout: DECK_AUTOSAVE_DEBOUNCE_MS * 4 },
    );
    const [token, id, input] = vi.mocked(putDeck).mock.calls[0] ?? [];
    expect(token).toBe(TOKEN);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(input).toEqual({ name: "Deck 1", cards: [], catalogVersion: catalog.version });
    await waitFor(() => {
      expect(screen.getByTestId("sync-status")).toHaveAttribute("data-state", "saved");
    });
  });

  it("R256 an edit is mirrored to this profile's local copy at once", async () => {
    await mount();
    fireEvent.click(screen.getByTestId("deck-row-d-tempo"));
    fireEvent.change(screen.getByTestId("deck-name-input"), { target: { value: "Tempo v2" } });
    expect(window.localStorage.getItem(mirrorKey(PROFILE))).toContain("Tempo v2");
  });
});

// ---------------------------------------------------------------------------------------------
// Another account on this device (R256)
// ---------------------------------------------------------------------------------------------

describe("when another account signs in under an open workshop", () => {
  const OTHER_TOKEN = "e2e-token-p2";
  const OTHER_PROFILE = "profile-p2";

  it("R256 never sends one profile's unsaved work with the next profile's token, and keeps it on this device", async () => {
    vi.mocked(getMe).mockImplementation(async (token) => ({
      ...meBody("active", false),
      profile: { id: token === OTHER_TOKEN ? OTHER_PROFILE : PROFILE, status: "active", rating: 1000 },
    }));
    await mount();
    // An edit the debounce has not sent yet: this profile's, and only this profile's.
    fireEvent.click(screen.getByTestId("deck-new"));
    const mirrored = window.localStorage.getItem(mirrorKey(PROFILE)) ?? "";
    expect(mirrored).toContain("Deck 1");

    // Another tab signs in as someone else (the gate hears it through `storage`, R194's path).
    vi.mocked(getDecks).mockResolvedValue(decksResponse([], [], catalog.version));
    window.localStorage.setItem(E2E_SESSION_STORAGE_KEY, JSON.stringify({ accessToken: OTHER_TOKEN }));
    window.dispatchEvent(new StorageEvent("storage", { key: E2E_SESSION_STORAGE_KEY }));
    // Generous waits: this test runs on the real clock, and under a loaded `pnpm test` the gate's
    // re-read and the new workshop's mount can take longer than waitFor's one-second default.
    await waitFor(
      () => {
        expect(getDecks).toHaveBeenCalledWith(OTHER_TOKEN);
      },
      { timeout: SWITCH_WAIT_MS },
    );
    await waitFor(
      () => {
        expect(screen.getByTestId("workshop-empty")).toBeInTheDocument();
      },
      { timeout: SWITCH_WAIT_MS },
    );
    // Give the old workshop's last flush and any debounce every chance to go out.
    await new Promise((resolve) => setTimeout(resolve, DECK_AUTOSAVE_DEBOUNCE_MS * 2));

    const sentAsOther = vi.mocked(putDeck).mock.calls.filter(([token]) => token === OTHER_TOKEN);
    expect(sentAsOther, "the first profile's new deck must not be created in the second's account").toEqual([]);
    // Not lost either: it waits in the first profile's own mirror for that profile's next visit —
    // unless the debounce ran out before the switch landed (a loaded run on the real clock takes
    // longer than `DECK_AUTOSAVE_DEBOUNCE_MS` to re-read the gate), and then it was saved, with the
    // first profile's own token, which is just as right.
    const kept = window.localStorage.getItem(mirrorKey(PROFILE)) ?? "";
    expect(kept).toContain("Deck 1");
    const savedAsFirst = vi.mocked(putDeck).mock.calls.some(([token, , input]) => token === TOKEN && input.name === "Deck 1");
    if (!savedAsFirst) expect(kept).toContain('"dirty":true');
  }, SWITCH_TEST_TIMEOUT_MS);
});
