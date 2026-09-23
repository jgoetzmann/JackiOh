// `/decks`: §9.4's gate, the three reads the screen opens with, and the relay of a 422's issues.
//
// `Deckbuilder.test.tsx` covers the editor itself. This file covers what the route adds: a pending
// account lands on `/invite` (which is what `10-invite-gate.cy.ts` asserts from the browser), an
// active one stays and sees its saved decks by name (which is what `09-deckbuilder.cy.ts`'s last
// `it` asserts), a profile that has never saved opens empty rather than in an error, the
// server's `details` reach the screen unchanged, and R171's library is offered for import when
// `GET /api/decks` answers and quietly absent when it does not.

import { validateLoadout, type LoadoutError } from "@jackioh/validator";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  SPARE_CARD_ID,
  fixtureCatalog,
  fixtureCollection,
  legalDecks,
} from "../game/deckbuilder/fixtures.ts";
import {
  ApiRequestError,
  getCatalog,
  getCollection,
  getLoadout,
  getMe,
  listDecks,
  putLoadout,
} from "../net/api.ts";
import { E2E_SESSION_STORAGE_KEY } from "../net/session.ts";
import DecksRoute, { loadoutIssuesFrom, saveOutcomeFrom } from "./decks.tsx";

vi.mock("../net/api.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../net/api.ts")>();
  return {
    ...actual,
    getMe: vi.fn(),
    getLoadout: vi.fn(),
    getCatalog: vi.fn(),
    getCollection: vi.fn(),
    listDecks: vi.fn(),
    putLoadout: vi.fn(),
  };
});

const TOKEN = "e2e-token-p1";
/** A one-card library deck: short of DECK_SIZE is fine for R171, and the import copies it as is. */
const SPARE_DECK = [SPARE_CARD_ID];
/** R171's cap as the fake server reports it. This screen never reads it, so any value will do. */
const ANY_CAP = 2;
const catalog = fixtureCatalog();
const collection = fixtureCollection();

function meBody(status: "pending" | "active" | "banned", needsInviteCode: boolean) {
  return {
    profile: { id: "p", status, rating: 1000 },
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
  vi.mocked(getLoadout).mockResolvedValue({
    catalogVersion: catalog.version,
    loadout: { catalogVersion: catalog.version, decks: legalDecks(), updatedAt: 0 },
  });
  vi.mocked(listDecks).mockResolvedValue({
    catalogVersion: catalog.version,
    maxDecks: ANY_CAP,
    decks: [],
  });
  vi.mocked(putLoadout).mockReset();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function mount(): Promise<void> {
  render(<DecksRoute />);
  await waitFor(() => {
    expect(screen.getByTestId("deckbuilder")).toBeInTheDocument();
  });
}

// ---------------------------------------------------------------------------------------------
// §9.4's gate
// ---------------------------------------------------------------------------------------------

describe("the gate (§9.4)", () => {
  it("sends a pending account to the code screen", async () => {
    // `10-invite-gate.cy.ts`: visiting the deckbuilder while pending lands on `/invite`.
    vi.mocked(getMe).mockResolvedValue(meBody("pending", true));
    render(<DecksRoute />);
    await waitFor(() => {
      expect(window.location.pathname).toBe("/invite");
    });
    expect(getLoadout, "and the gated reads are never attempted").not.toHaveBeenCalled();
  });

  it("sends an account with no session to the sign-in screen", async () => {
    window.localStorage.clear();
    render(<DecksRoute />);
    await waitFor(() => {
      expect(window.location.pathname).toBe("/login");
    });
  });

  it("keeps an active account on the deckbuilder", async () => {
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
      expect(screen.getByTestId("deckbuilder-error")).toHaveTextContent(
        "the server could not be reached",
      );
    });
  });
});

// ---------------------------------------------------------------------------------------------
// the reads
// ---------------------------------------------------------------------------------------------

describe("what the screen opens with", () => {
  it("renders the saved loadout's cards by name", async () => {
    const decks = legalDecks();
    await mount();
    for (const deck of [1, 2, 3]) {
      const cardId = decks[deck - 1]?.[0] ?? "";
      expect(screen.getByTestId(`deck-card-${String(deck)}-${cardId}`)).toHaveTextContent(
        catalog.cards[cardId]?.name ?? "",
      );
    }
  });

  it("opens empty for a profile that has never saved, and not in an error", async () => {
    vi.mocked(getLoadout).mockResolvedValue({ catalogVersion: catalog.version, loadout: null });
    await mount();
    expect(screen.getByTestId("deck-count-1")).toHaveAttribute("data-count", "0");
    expect(screen.queryByTestId("deckbuilder-error")).toBeNull();
  });

  it("still opens when the collection cannot be read, with no client verdict", async () => {
    vi.mocked(getCollection).mockRejectedValue(new ApiRequestError(403, { code: "account_pending", message: "no" }));
    vi.mocked(getLoadout).mockResolvedValue({ catalogVersion: catalog.version, loadout: null });
    await mount();
    // L5 needs quantities; without them nothing is claimed, and the server is still law.
    expect(screen.getByTestId("loadout-errors")).toHaveAttribute("data-count", "0");
  });

  it("shows the reason when the loadout or the catalog cannot be read", async () => {
    vi.mocked(getCatalog).mockRejectedValue(new Error("catalog unavailable"));
    render(<DecksRoute />);
    await waitFor(() => {
      expect(screen.getByTestId("deckbuilder-error")).toHaveTextContent("catalog unavailable");
    });
  });
});

// ---------------------------------------------------------------------------------------------
// R171: the library, offered for import
// ---------------------------------------------------------------------------------------------

describe("the library read", () => {
  const libraryDeck = { id: "deck-1", name: "Aggro", cards: SPARE_DECK, updatedAt: 0 };

  it("offers the account's library decks on every slot", async () => {
    vi.mocked(listDecks).mockResolvedValue({
      catalogVersion: catalog.version,
      maxDecks: ANY_CAP,
      decks: [libraryDeck],
    });
    await mount();
    expect(listDecks).toHaveBeenCalledWith(TOKEN);
    for (const deck of [1, 2, 3]) {
      const picker = screen.getByTestId(`deck-import-${String(deck)}`);
      expect(picker.querySelector(`option[value="${libraryDeck.id}"]`)).not.toBeNull();
    }

    fireEvent.change(screen.getByTestId("deck-import-2"), { target: { value: libraryDeck.id } });
    expect(screen.getByTestId(`deck-card-2-${SPARE_CARD_ID}`)).toBeInTheDocument();
  });

  it("hides the picker, and still opens the builder, when the read fails", async () => {
    vi.mocked(listDecks).mockRejectedValue(new Error("library unavailable"));
    await mount();
    expect(screen.queryByTestId("deck-import-1")).toBeNull();
    expect(screen.queryByTestId("deckbuilder-error")).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// the save, and §9.4's "the server's verdict is law"
// ---------------------------------------------------------------------------------------------

describe("saving", () => {
  it("stamps the catalog version the loadout read returned", async () => {
    vi.mocked(putLoadout).mockResolvedValue({ catalogVersion: catalog.version, loadout: null });
    await mount();
    fireEvent.click(screen.getByTestId("loadout-save"));
    await waitFor(() => {
      expect(putLoadout).toHaveBeenCalledWith(TOKEN, catalog.version, legalDecks());
    });
    expect(screen.getByTestId("loadout-saved")).toBeInTheDocument();
  });

  it("renders a 422's details verbatim, under the rules the server named", async () => {
    const decks = legalDecks();
    const result = validateLoadout({
      decks: [{ cards: decks[0] ?? [] }, { cards: decks[1] ?? [] }],
      catalog,
      collection,
    });
    const issues: readonly LoadoutError[] = result.ok ? [] : result.errors;
    expect(issues.length).toBeGreaterThan(0);

    vi.mocked(putLoadout).mockRejectedValue(
      new ApiRequestError(422, {
        code: "loadout_invalid",
        message: issues[0]?.message ?? "",
        details: issues,
      }),
    );

    await mount();
    fireEvent.click(screen.getByTestId("loadout-save"));
    await waitFor(() => {
      expect(screen.getByTestId("loadout-error-L1")).toBeInTheDocument();
    });
    expect(screen.getByTestId("loadout-error-L1").textContent).toBe(
      issues.find((issue) => issue.rule === "L1")?.message,
    );
  });

  it("shows any other refusal as the server's own sentence", async () => {
    vi.mocked(putLoadout).mockRejectedValue(
      new ApiRequestError(409, { code: "catalog_stale", message: "update required" }),
    );
    await mount();
    fireEvent.click(screen.getByTestId("loadout-save"));
    await waitFor(() => {
      expect(screen.getByTestId("loadout-save-error")).toHaveTextContent("update required");
    });
  });

  it("sends the edited draft, not the one it opened with", async () => {
    vi.mocked(putLoadout).mockResolvedValue({ catalogVersion: catalog.version, loadout: null });
    await mount();
    fireEvent.click(screen.getByTestId(`card-pool-${SPARE_CARD_ID}`));
    fireEvent.click(screen.getByTestId("loadout-save"));
    await waitFor(() => {
      expect(putLoadout).toHaveBeenCalled();
    });
    const sent = vi.mocked(putLoadout).mock.calls[0]?.[2] as string[][];
    expect(sent[0]).toContain(SPARE_CARD_ID);
  });
});

// ---------------------------------------------------------------------------------------------
// the two pure translations, in isolation
// ---------------------------------------------------------------------------------------------

describe("reading the server's refusal", () => {
  it("keeps every field the validator set, and invents none", () => {
    const details = [{ rule: "L4", message: "whatever the validator said", cardId: "core-001" }];
    expect(loadoutIssuesFrom(details)).toEqual([
      { rule: "L4", message: "whatever the validator said", cardId: "core-001" },
    ]);
  });

  it("claims no issue at all when the payload is not §9.4's shape", () => {
    // Better to show the error's own message than to half-read a list of sentences.
    expect(loadoutIssuesFrom(undefined)).toEqual([]);
    expect(loadoutIssuesFrom([])).toEqual([]);
    expect(loadoutIssuesFrom([{ rule: "L9", message: "x" }])).toEqual([]);
    expect(loadoutIssuesFrom([{ rule: "L1" }])).toEqual([]);
    expect(loadoutIssuesFrom("nope")).toEqual([]);
  });

  it("only reads details for a loadout_invalid", () => {
    const outcome = saveOutcomeFrom(
      new ApiRequestError(403, {
        code: "account_pending",
        message: "gate",
        details: [{ rule: "L1", message: "not a rule failure" }],
      }),
    );
    expect(outcome).toEqual({ ok: false, message: "gate", issues: [] });
  });

  it("passes a non-API failure's own message through", () => {
    expect(saveOutcomeFrom(new Error("offline"))).toEqual({
      ok: false,
      message: "offline",
      issues: [],
    });
  });
});
