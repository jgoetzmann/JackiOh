// BUILD M8's row for `09-deckbuilder.cy.ts`: "each of L1–L6 shows its message; a card dragged into
// a second deck is refused; save succeeds when legal".
//
// EVERY EXPECTED SENTENCE IN THIS FILE IS COMPUTED BY `validateLoadout`, never typed out. A test
// that spelled the message would be a third copy of it — the exact drift SPEC §9.4's "one
// validator module shared by client and server" exists to prevent — and it would pass just as
// happily against a client that had its own wording. `messages.test.ts` closes the other half by
// proving no source file under `src/` contains one of these sentences.

import {
  validateLoadout,
  type CatalogSnapshot,
  type Collection,
  type LoadoutError,
  type LoadoutRule,
} from "@jackioh/validator";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import Deckbuilder from "./Deckbuilder.tsx";
import { DECK_SIZE } from "./deckSize.ts";
import {
  SPARE_CARD_ID,
  TOKEN_ID,
  fixtureCardId,
  fixtureCardName,
  fixtureCatalog,
  fixtureCollection,
  legalDecks,
} from "./fixtures.ts";

afterEach(cleanup);

const catalog: CatalogSnapshot = fixtureCatalog();
const collection: Collection = fixtureCollection();

/** An id no catalog version knows, for L6. */
const NOT_A_CARD = "core-999";

function issuesFor(decks: readonly (readonly string[])[]): readonly LoadoutError[] {
  const result = validateLoadout({ decks: decks.map((cards) => ({ cards })), catalog, collection });
  return result.ok ? [] : result.errors;
}

/** The validator's own sentences for one rule, in its own order. */
function expected(decks: readonly (readonly string[])[], rule: LoadoutRule): string[] {
  return issuesFor(decks)
    .filter((issue) => issue.rule === rule)
    .map((issue) => issue.message);
}

function shown(rule: LoadoutRule): string[] {
  return screen
    .queryAllByTestId(`loadout-error-${rule}`)
    .map((node) => node.textContent ?? "");
}

function mount(decks: readonly (readonly string[])[] | null, save = vi.fn().mockResolvedValue({ ok: true })) {
  render(<Deckbuilder catalog={catalog} collection={collection} initialDecks={decks} save={save} />);
  return save;
}

/** Drives the HTML5 gesture `cy.dragCardToDeck` will drive: dragstart on the card, drop on a deck. */
function drag(cardId: string, deck: number): void {
  fireEvent.dragStart(screen.getByTestId(`card-pool-${cardId}`));
  const target = screen.getByTestId(`deck-drop-${String(deck)}`);
  fireEvent.dragOver(target);
  fireEvent.drop(target);
}

// ---------------------------------------------------------------------------------------------
// What `09-deckbuilder.cy.ts`'s last `it` actually asserts.
// ---------------------------------------------------------------------------------------------

describe("the saved loadout opens on screen", () => {
  it("shows a card from each of the three saved decks, by name", () => {
    const decks = legalDecks();
    mount(decks);

    // Spec 09's shape: one card from deck 1, one from deck 2, one from deck 3, found by name.
    for (const deck of [1, 2, 3]) {
      const cardId = decks[deck - 1]?.[0] ?? "";
      expect(screen.getAllByText(catalog.cards[cardId]?.name ?? "").length).toBeGreaterThan(0);
      expect(screen.getByTestId(`deck-card-${String(deck)}-${cardId}`)).toBeInTheDocument();
      expect(screen.getByTestId(`deck-${String(deck)}-card-${cardId}`)).toBeInTheDocument();
    }
  });

  it("opens empty, and without an error, for a profile that has never saved", () => {
    mount(null);
    expect(screen.getByTestId("deck-tab-1")).toBeInTheDocument();
    expect(screen.getByTestId("deck-count-1")).toHaveAttribute("data-count", "0");
    // Empty is illegal (L2), but it is the validator saying so, not a screen-level failure.
    expect(shown("L2")).toEqual(expected([[], [], []], "L2"));
    expect(screen.queryByTestId("loadout-save-error")).toBeNull();
  });

  it("renders every card in the pool with its catalog name", () => {
    mount(legalDecks());
    expect(screen.getByTestId(`card-pool-${fixtureCardId(1)}`)).toHaveTextContent(fixtureCardName(1));
    // L3 bans Tokens from a deck, so the pool never offers one.
    expect(screen.queryByTestId(`card-pool-${TOKEN_ID}`)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// L1–L6, each asserted against the sentence `validateLoadout` produced for the same draft.
// ---------------------------------------------------------------------------------------------

describe("each of L1–L6 shows the validator's own message", () => {
  it("L2 — a deck of the wrong size", () => {
    const decks = legalDecks();
    const short = [(decks[0] ?? []).slice(0, DECK_SIZE - 1), decks[1] ?? [], decks[2] ?? []];
    mount(short);

    const want = expected(short, "L2");
    expect(want, "the scenario really breaks L2").toHaveLength(1);
    expect(shown("L2")).toEqual(want);
  });

  it("L3 — two copies of a card in one deck (and L5 rides along)", () => {
    const decks = legalDecks();
    const duplicated = [...(decks[0] ?? [])];
    duplicated[duplicated.length - 1] = duplicated[0] ?? "";
    const draft = [duplicated, decks[1] ?? [], decks[2] ?? []];
    mount(draft);

    const wantL3 = expected(draft, "L3");
    const wantL5 = expected(draft, "L5");
    expect(wantL3).toHaveLength(1);
    expect(wantL5, "R111 owns one copy, so two copies is also one more than is owned").toHaveLength(1);
    expect(shown("L3")).toEqual(wantL3);
    expect(shown("L5")).toEqual(wantL5);
  });

  it("L3 — a Token in a deck (and L5's you-own-0 branch with it)", () => {
    const decks = legalDecks();
    const withToken = [...(decks[0] ?? [])];
    withToken[withToken.length - 1] = TOKEN_ID;
    const draft = [withToken, decks[1] ?? [], decks[2] ?? []];
    mount(draft);

    const wantL3 = expected(draft, "L3");
    const wantL5 = expected(draft, "L5");
    expect(wantL3).toHaveLength(1);
    expect(wantL5).toHaveLength(1);
    expect(shown("L3")).toEqual(wantL3);
    expect(shown("L5")).toEqual(wantL5);
  });

  it("L4 — the same card in two decks", () => {
    const decks = legalDecks();
    const shared = decks[0]?.[0] ?? "";
    const third = [...(decks[2] ?? [])];
    third[third.length - 1] = shared;
    const draft = [decks[0] ?? [], decks[1] ?? [], third];
    mount(draft);

    const want = expected(draft, "L4");
    expect(want).toHaveLength(1);
    expect(shown("L4")).toEqual(want);
    // The message names both decks, and the marker carries the card the validator named.
    expect(screen.getByTestId("loadout-error-L4")).toHaveAttribute("data-card", shared);
  });

  it("L6 — a card that is in no catalog version", () => {
    const decks = legalDecks();
    const unknown = [...(decks[0] ?? [])];
    unknown[unknown.length - 1] = NOT_A_CARD;
    const draft = [unknown, decks[1] ?? [], decks[2] ?? []];
    mount(draft);

    const want = expected(draft, "L6");
    expect(want).toHaveLength(1);
    expect(want[0], "the version in the sentence is this catalog's").toContain(catalog.version);
    expect(shown("L6")).toEqual(want);
  });

  it("L1 — a loadout with the wrong number of decks", () => {
    // A builder always shows three tabs, so the only way to hold a fourth deck is to be handed
    // one. `draftFrom` keeps it rather than dropping it, precisely so L1 is visible.
    const decks = legalDecks();
    const draft = [...decks, [SPARE_CARD_ID]];
    mount(draft);

    const want = expected(draft, "L1");
    expect(want).toHaveLength(1);
    expect(shown("L1")).toEqual(want);
    expect(screen.getByTestId("deck-tab-4")).toBeInTheDocument();
  });

  it("every marker carries its rule and its source, and nothing wraps the sentence", () => {
    const decks = legalDecks();
    const draft = [(decks[0] ?? []).slice(0, 1), decks[1] ?? [], decks[2] ?? []];
    mount(draft);

    const node = screen.getByTestId("loadout-error-L2");
    expect(node).toHaveAttribute("data-rule", "L2");
    expect(node).toHaveAttribute("data-source", "client");
    // Verbatim: the rule code lives in an attribute, never in the text.
    expect(node.textContent).toBe(expected(draft, "L2")[0]);
    expect(node.textContent).not.toContain("L2");
  });

  it("says nothing at all about a legal loadout", () => {
    mount(legalDecks());
    expect(screen.getByTestId("loadout-errors")).toHaveAttribute("data-count", "0");
  });

  it("skips the client verdict entirely when the collection could not be read", () => {
    // L5 needs quantities. Without them the screen does not guess: the server is still law.
    render(
      <Deckbuilder
        catalog={catalog}
        collection={null}
        initialDecks={[[], [], []]}
        save={vi.fn().mockResolvedValue({ ok: true })}
      />,
    );
    expect(screen.getByTestId("loadout-errors")).toHaveAttribute("data-count", "0");
  });
});

// ---------------------------------------------------------------------------------------------
// "a card dragged into a second deck is refused"
// ---------------------------------------------------------------------------------------------

describe("dragging a card", () => {
  it("drops a card the loadout does not hold into the deck it was dropped on", () => {
    mount(legalDecks());
    drag(SPARE_CARD_ID, 2);
    expect(screen.getByTestId(`deck-card-2-${SPARE_CARD_ID}`)).toBeInTheDocument();
  });

  it("refuses a card already in another deck, and marks it data-legal=false", () => {
    const decks = legalDecks();
    const shared = decks[0]?.[0] ?? "";
    mount(decks);

    const poolCard = screen.getByTestId(`card-pool-${shared}`);
    expect(poolCard).toHaveAttribute("data-legal", "false");
    expect(poolCard).toHaveAttribute("data-in-deck", "1");

    drag(shared, 3);
    expect(screen.queryByTestId(`deck-card-3-${shared}`)).toBeNull();
    expect(screen.getByTestId(`card-pool-${shared}`)).toHaveAttribute("data-refused", "true");
    // Nothing was worded: L4 is not claimed, because the state L4 forbids was never created.
    expect(shown("L4")).toEqual([]);
  });

  it("marks a card the loadout does not hold data-legal=true", () => {
    mount(legalDecks());
    expect(screen.getByTestId(`card-pool-${SPARE_CARD_ID}`)).toHaveAttribute("data-legal", "true");
  });

  it("accepts a drop on the deck's tab as well as on its list", () => {
    mount(legalDecks());
    fireEvent.dragStart(screen.getByTestId(`card-pool-${SPARE_CARD_ID}`));
    fireEvent.drop(screen.getByTestId("deck-tab-3"));
    expect(screen.getByTestId(`deck-card-3-${SPARE_CARD_ID}`)).toBeInTheDocument();
  });

  it("falls back to a click, which lands the card in the open deck", () => {
    mount(legalDecks());
    fireEvent.click(screen.getByTestId("deck-tab-2"));
    fireEvent.click(screen.getByTestId(`card-pool-${SPARE_CARD_ID}`));
    expect(screen.getByTestId(`deck-card-2-${SPARE_CARD_ID}`)).toBeInTheDocument();
  });

  it("takes a card back out of a deck when it is clicked there", () => {
    const decks = legalDecks();
    const held = decks[0]?.[0] ?? "";
    mount(decks);
    fireEvent.click(screen.getByTestId(`deck-card-1-${held}`));
    expect(screen.queryByTestId(`deck-card-1-${held}`)).toBeNull();
    expect(screen.getByTestId(`card-pool-${held}`)).toHaveAttribute("data-legal", "true");
  });
});

// ---------------------------------------------------------------------------------------------
// "save succeeds when legal", and §9.4's "the server's verdict is law".
// ---------------------------------------------------------------------------------------------

describe("saving", () => {
  it("sends all three decks in one call (§9.4: no per-deck save) and reports success", async () => {
    const decks = legalDecks();
    const save = mount(decks);

    fireEvent.click(screen.getByTestId("loadout-save"));
    await waitFor(() => {
      expect(screen.getByTestId("loadout-saved")).toBeInTheDocument();
    });
    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]?.[0]).toEqual(decks);
  });

  it("renders the server's issues verbatim, and marks them as the server's", async () => {
    // A 422 the server built by running the same validator: the sentences must arrive unchanged.
    const decks = legalDecks();
    const illegal = [decks[0] ?? [], decks[1] ?? []];
    const serverIssues = issuesFor(illegal);
    expect(serverIssues.length).toBeGreaterThan(0);

    mount(
      decks,
      vi.fn().mockResolvedValue({
        ok: false,
        message: serverIssues[0]?.message ?? "",
        issues: serverIssues,
      }),
    );

    fireEvent.click(screen.getByTestId("loadout-save"));
    await waitFor(() => {
      expect(screen.getByTestId("loadout-errors")).toHaveAttribute(
        "data-count",
        String(serverIssues.length),
      );
    });
    expect(shown("L1")).toEqual(serverIssues.filter((i) => i.rule === "L1").map((i) => i.message));
    expect(screen.getByTestId("loadout-error-L1")).toHaveAttribute("data-source", "server");
    // The issues replaced the error's own message; it is not shown twice.
    expect(screen.queryByTestId("loadout-save-error")).toBeNull();
  });

  it("shows a refusal that is not a rule failure as the server wrote it", async () => {
    const message = "update required";
    mount(legalDecks(), vi.fn().mockResolvedValue({ ok: false, message, issues: [] }));

    fireEvent.click(screen.getByTestId("loadout-save"));
    await waitFor(() => {
      expect(screen.getByTestId("loadout-save-error")).toHaveTextContent(message);
    });
  });

  it("retires the server's verdict as soon as the draft changes", async () => {
    const decks = legalDecks();
    const serverIssues = issuesFor([decks[0] ?? [], decks[1] ?? []]);
    mount(
      decks,
      vi.fn().mockResolvedValue({ ok: false, message: serverIssues[0]?.message ?? "", issues: serverIssues }),
    );

    fireEvent.click(screen.getByTestId("loadout-save"));
    await waitFor(() => {
      expect(screen.getByTestId("loadout-error-L1")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId(`card-pool-${SPARE_CARD_ID}`));
    await waitFor(() => {
      expect(screen.queryByTestId("loadout-error-L1")).toBeNull();
    });
    expect(screen.queryByTestId("loadout-saved")).toBeNull();
  });
});
