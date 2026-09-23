// BUILD M9-T2's acceptance: paging, both add paths and both remove paths, the size cap, the hover
// preview, the inspector, and every validator sentence rendered verbatim.
//
// As in `Deckbuilder.test.tsx`, EVERY EXPECTED SENTENCE IS COMPUTED BY `validateDeck`, never typed,
// and the limits are `DECK_SIZE` / `MAX_COPIES` or an explicit override, never a spelled number.

import { validateDeck, type CatalogSnapshot, type LoadoutError } from "@jackioh/validator";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DECK_SIZE, MAX_COPIES } from "../deckbuilder/deckSize.ts";
import {
  FIXTURE_CARD_COUNT,
  TOKEN_ID,
  fixtureCardId,
  fixtureCardName,
  fixtureCatalog,
  fixtureCollection,
} from "../deckbuilder/fixtures.ts";
import { setReducedMotion } from "../../test/setup.ts";
import Library, { type LibraryDeck, type LibraryProps, type LibrarySaveOutcome } from "./Library.tsx";
import { FALLBACK_PAGE_SIZE } from "./library.ts";
import {
  DECKLIST,
  DECK_BACK,
  DECK_CARD_COUNT,
  DECK_DISCARD_CONFIRM,
  DECK_ERRORS,
  DECK_NAME_INPUT,
  DECK_SAVE,
  DECK_SAVED,
  DECK_SAVE_ERROR,
  HOVER_PREVIEW,
  INSPECTOR,
  INSPECTOR_CARD,
  INSPECTOR_CLOSE,
  INSPECTOR_FLIP,
  INSPECTOR_TOGGLE,
  LIBRARY_DECKS,
  LIBRARY_DECK_TOTAL,
  LIBRARY_INCOMPLETE,
  LIBRARY_NEW_DECK,
  LIBRARY_PAGES,
  PAGE_INDICATOR,
  PAGE_NEXT,
  PAGE_PREV,
  deckBarId,
  deckErrorId,
  libraryDeckDeleteConfirmId,
  libraryDeckDeleteId,
  libraryDeckId,
  pageCardId,
} from "./testids.ts";

afterEach(() => {
  cleanup();
  setReducedMotion(false);
  vi.unstubAllGlobals();
});

const catalog: CatalogSnapshot = fixtureCatalog();
const collection = fixtureCollection();
const PER_PAGE = FALLBACK_PAGE_SIZE.cols * FALLBACK_PAGE_SIZE.rows;
/** Every fixture card costs the same, so the pool's cost-then-name order is id order. */
const PAGES = Math.ceil(FIXTURE_CARD_COUNT / PER_PAGE);

function deck(id: string, count: number, from = 1): LibraryDeck {
  return { id, name: `Deck ${id}`, cards: Array.from({ length: count }, (_unused, index) => fixtureCardId(from + index)) };
}

function mount(overrides: Partial<LibraryProps> = {}) {
  const props: LibraryProps = {
    catalog,
    collection,
    decks: [],
    maxDecks: 3,
    create: vi.fn().mockImplementation((draft: { name: string; cards: readonly string[] }) =>
      Promise.resolve({ ok: true, deck: { id: "new-1", name: draft.name, cards: [...draft.cards] } }),
    ),
    save: vi.fn().mockImplementation((deckId: string, draft: { name: string; cards: readonly string[] }) =>
      Promise.resolve({ ok: true, deck: { id: deckId, name: draft.name, cards: [...draft.cards] } }),
    ),
    remove: vi.fn().mockResolvedValue({ ok: true }),
    ...overrides,
  };
  render(<Library {...props} />);
  return props;
}

function indicator(): HTMLElement {
  return screen.getByTestId(PAGE_INDICATOR);
}

function count(): string | null {
  return screen.getByTestId(DECK_CARD_COUNT).getAttribute("data-count");
}

function newDeck(): void {
  fireEvent.click(screen.getByTestId(LIBRARY_NEW_DECK));
}

function rightClick(testId: string): boolean {
  return fireEvent.contextMenu(screen.getByTestId(testId));
}

function issuesFor(cards: readonly string[], name: string, rules = {}): readonly LoadoutError[] {
  const result = validateDeck({ deck: { name, cards }, catalog, collection, rules, allowIncomplete: true });
  return result.ok ? [] : result.errors;
}

/** A save that lands only when the test says so. */
function inFlight() {
  let land: (outcome: LibrarySaveOutcome) => void = () => undefined;
  const promise = new Promise<LibrarySaveOutcome>((resolve) => {
    land = resolve;
  });
  return {
    promise,
    async land(outcome: LibrarySaveOutcome): Promise<void> {
      await act(async () => {
        land(outcome);
        await promise;
      });
    },
  };
}

/** A controllable ResizeObserver, since jsdom has none. */
function stubResizeObserver() {
  const observers: { callback: ResizeObserverCallback; disconnected: boolean }[] = [];
  class FakeResizeObserver {
    private readonly entry: { callback: ResizeObserverCallback; disconnected: boolean };
    constructor(callback: ResizeObserverCallback) {
      this.entry = { callback, disconnected: false };
      observers.push(this.entry);
    }
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {
      this.entry.disconnected = true;
    }
  }
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  return {
    observers,
    resize(width: number, height: number): void {
      act(() => {
        for (const { callback } of observers) {
          callback([{ contentRect: { width, height } } as ResizeObserverEntry], {} as ResizeObserver);
        }
      });
    },
  };
}

// ---------------------------------------------------------------------------------------------

describe("the pages", () => {
  it("pages with the arrows, which disable at the ends", () => {
    mount();
    expect(indicator()).toHaveAttribute("data-page", "1");
    expect(indicator()).toHaveAttribute("data-pages", String(PAGES));
    expect(indicator()).toHaveAttribute("data-cols", String(FALLBACK_PAGE_SIZE.cols));
    expect(indicator()).toHaveAttribute("data-rows", String(FALLBACK_PAGE_SIZE.rows));
    expect(screen.getByTestId(PAGE_PREV)).toBeDisabled();
    expect(screen.getByTestId(pageCardId(fixtureCardId(1)))).toHaveTextContent(fixtureCardName(1));
    expect(screen.queryByTestId(pageCardId(fixtureCardId(PER_PAGE + 1)))).toBeNull();

    fireEvent.click(screen.getByTestId(PAGE_NEXT));
    expect(indicator()).toHaveAttribute("data-page", "2");
    expect(screen.getByTestId(pageCardId(fixtureCardId(PER_PAGE + 1)))).toBeInTheDocument();
    expect(screen.getByTestId(PAGE_PREV)).toBeEnabled();

    for (let turn = 2; turn < PAGES; turn += 1) fireEvent.click(screen.getByTestId(PAGE_NEXT));
    expect(indicator()).toHaveAttribute("data-page", String(PAGES));
    expect(screen.getByTestId(PAGE_NEXT)).toBeDisabled();
    // L3 bans tokens from a deck, so the pages never offer one.
    expect(screen.queryByTestId(pageCardId(TOKEN_ID))).toBeNull();
  });

  it("turns with the arrow keys, but not while the deck name is being typed", () => {
    mount();
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(indicator()).toHaveAttribute("data-page", "2");
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(indicator()).toHaveAttribute("data-page", "1");

    newDeck();
    fireEvent.keyDown(screen.getByTestId(DECK_NAME_INPUT), { key: "ArrowRight" });
    expect(indicator()).toHaveAttribute("data-page", "1");
  });

  it("sizes the page from the measured grid, and clamps the page when the count shrinks", () => {
    const observer = stubResizeObserver();
    mount();
    // One card per page: every card is its own page.
    observer.resize(1, 1);
    expect(indicator()).toHaveAttribute("data-pages", String(FIXTURE_CARD_COUNT));
    for (let turn = 1; turn < FIXTURE_CARD_COUNT; turn += 1) fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(indicator()).toHaveAttribute("data-page", String(FIXTURE_CARD_COUNT));

    // A grid big enough for everything: one page, and the open page follows it down.
    observer.resize(100_000, 100_000);
    expect(indicator()).toHaveAttribute("data-pages", "1");
    expect(indicator()).toHaveAttribute("data-page", "1");
    expect(screen.getByTestId(PAGE_NEXT)).toBeDisabled();
  });

  it("stops observing the grid when it unmounts", () => {
    const observer = stubResizeObserver();
    mount();
    cleanup();
    expect(observer.observers.length).toBeGreaterThan(0);
    expect(observer.observers.every((entry) => entry.disconnected)).toBe(true);
  });
});

describe("building a deck", () => {
  const first = fixtureCardId(1);
  const second = fixtureCardId(2);

  it("adds a card on right-click, and keeps the browser menu off the card only", () => {
    mount();
    newDeck();
    expect(rightClick(pageCardId(first)), "the card's context menu is suppressed").toBe(false);
    expect(screen.getByTestId(deckBarId(first))).toHaveTextContent(fixtureCardName(1));
    expect(count()).toBe("1");
    expect(fireEvent.contextMenu(screen.getByTestId(LIBRARY_PAGES)), "the page around it is not").toBe(true);
  });

  it("removes a card on right-clicking its bar", () => {
    mount();
    newDeck();
    rightClick(pageCardId(first));
    expect(rightClick(deckBarId(first))).toBe(false);
    expect(screen.queryByTestId(deckBarId(first))).toBeNull();
    expect(count()).toBe("0");
  });

  it("adds a card dragged onto the decklist", () => {
    mount();
    newDeck();
    fireEvent.dragStart(screen.getByTestId(pageCardId(first)));
    fireEvent.dragOver(screen.getByTestId(DECKLIST));
    fireEvent.drop(screen.getByTestId(DECKLIST));
    expect(screen.getByTestId(deckBarId(first))).toBeInTheDocument();
  });

  it("removes a bar dragged onto the pages, and nothing else moves the other way", () => {
    mount();
    newDeck();
    rightClick(pageCardId(first));

    // A page card dropped back on the pages removes nothing; a bar dropped on the list adds nothing.
    fireEvent.dragStart(screen.getByTestId(pageCardId(second)));
    fireEvent.drop(screen.getByTestId(LIBRARY_PAGES));
    fireEvent.dragStart(screen.getByTestId(deckBarId(first)));
    fireEvent.drop(screen.getByTestId(DECKLIST));
    expect(count()).toBe("1");

    fireEvent.dragStart(screen.getByTestId(deckBarId(first)));
    fireEvent.dragOver(screen.getByTestId(LIBRARY_PAGES));
    fireEvent.drop(screen.getByTestId(LIBRARY_PAGES));
    expect(screen.queryByTestId(deckBarId(first))).toBeNull();
  });

  it("adds only a card the pages offer, whatever text is dropped from elsewhere", () => {
    mount();
    newDeck();
    for (const text of ["hello world", "constructor", TOKEN_ID, first]) {
      const carried: Record<string, string> = { "text/plain": text };
      fireEvent.drop(screen.getByTestId(DECKLIST), { dataTransfer: { getData: (mime: string) => carried[mime] ?? "" } });
    }
    expect(count()).toBe("1");
    expect(screen.getByTestId(deckBarId(first))).toBeInTheDocument();
  });

  it("dims a card at maxCopies, marks it In deck, and refuses another copy", () => {
    mount();
    newDeck();
    for (let copy = 0; copy < MAX_COPIES; copy += 1) rightClick(pageCardId(first));
    const card = screen.getByTestId(pageCardId(first));
    expect(card).toHaveAttribute("data-in-deck", "true");
    expect(card).toHaveTextContent("In deck");
    rightClick(pageCardId(first));
    expect(count()).toBe(String(MAX_COPIES));
    expect(screen.getByTestId(pageCardId(second))).not.toHaveAttribute("data-in-deck");
  });

  it("stops at deckSize", () => {
    mount();
    newDeck();
    let added = 0;
    for (let page = 0; added < DECK_SIZE + 1 && page < PAGES; page += 1) {
      for (let slot = 1; slot <= PER_PAGE && added < DECK_SIZE + 1; slot += 1) {
        rightClick(pageCardId(fixtureCardId(page * PER_PAGE + slot)));
        added += 1;
      }
      fireEvent.click(screen.getByTestId(PAGE_NEXT));
    }
    expect(added).toBe(DECK_SIZE + 1);
    expect(count()).toBe(String(DECK_SIZE));
    expect(screen.getByTestId(DECK_CARD_COUNT)).toHaveAttribute("data-deck-size", String(DECK_SIZE));
    expect(screen.queryByTestId(LIBRARY_INCOMPLETE)).toBeNull();
  });

  it("takes deckSize and maxCopies as props, and hands them to the validator", () => {
    const deckSize = 3;
    const maxCopies = MAX_COPIES + 1;
    // A stored deck one over the override: the validator's L2, under the same override.
    mount({ deckSize, maxCopies, decks: [deck("big", deckSize + 1)] });
    expect(screen.getByTestId(libraryDeckId("big"))).toHaveTextContent(`${String(deckSize + 1)}/${String(deckSize)}`);
    fireEvent.click(screen.getByTestId(libraryDeckId("big")));
    const want = issuesFor(deck("big", deckSize + 1).cards, "Deck big", { deckSize, maxCopies })
      .filter((issue) => issue.rule === "L2")
      .map((issue) => issue.message);
    expect(want).toHaveLength(1);
    expect(screen.getAllByTestId(deckErrorId("L2")).map((node) => node.textContent)).toEqual(want);

    fireEvent.click(screen.getByTestId(DECK_BACK));
    fireEvent.click(screen.getByTestId(LIBRARY_NEW_DECK));
    for (let copy = 0; copy < maxCopies + 1; copy += 1) rightClick(pageCardId(first));
    expect(count()).toBe(String(maxCopies));
    expect(screen.getByTestId(deckBarId(first))).toHaveTextContent(`×${String(maxCopies)}`);
    expect(screen.getByTestId(DECK_CARD_COUNT)).toHaveAttribute("data-deck-size", String(deckSize));
    rightClick(pageCardId(second));
    rightClick(pageCardId(fixtureCardId(3)));
    expect(count()).toBe(String(deckSize));
  });
});

describe("the decklist's bars", () => {
  it("show the cost gem and the name, and nothing else at one copy", () => {
    mount();
    newDeck();
    rightClick(pageCardId(fixtureCardId(1)));
    const bar = screen.getByTestId(deckBarId(fixtureCardId(1)));
    expect(bar.textContent).toBe(`${String(catalog.cards[fixtureCardId(1)]?.cost)}${fixtureCardName(1)}`);
  });

  it("preview the card while hovered or focused, and hide it after", () => {
    mount();
    newDeck();
    rightClick(pageCardId(fixtureCardId(1)));
    const bar = screen.getByTestId(deckBarId(fixtureCardId(1)));

    fireEvent.mouseEnter(bar);
    expect(screen.getByTestId(HOVER_PREVIEW)).toHaveTextContent(fixtureCardName(1));
    fireEvent.mouseLeave(bar);
    expect(screen.queryByTestId(HOVER_PREVIEW)).toBeNull();

    fireEvent.focus(bar);
    expect(screen.getByTestId(HOVER_PREVIEW)).toBeInTheDocument();
    fireEvent.blur(bar);
    expect(screen.queryByTestId(HOVER_PREVIEW)).toBeNull();
  });

  it("drop the preview when the hovered card leaves the deck", () => {
    mount();
    newDeck();
    rightClick(pageCardId(fixtureCardId(1)));
    fireEvent.mouseEnter(screen.getByTestId(deckBarId(fixtureCardId(1))));
    rightClick(deckBarId(fixtureCardId(1)));
    expect(screen.queryByTestId(HOVER_PREVIEW)).toBeNull();
  });
});

describe("the inspector", () => {
  const cardId = fixtureCardId(1);

  function transform(): string {
    return screen.getByTestId(INSPECTOR_CARD).style.transform;
  }

  it("opens on a click, turns on a drag, settles on a face, and closes on Esc", () => {
    mount();
    const opener = screen.getByTestId(pageCardId(cardId));
    opener.focus();
    fireEvent.click(opener);

    const dialog = screen.getByTestId(INSPECTOR);
    expect(dialog).toHaveAttribute("role", "dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(screen.getByRole("dialog", { name: fixtureCardName(1) })).toBe(dialog);
    const card = screen.getByTestId(INSPECTOR_CARD);
    const before = transform();
    expect(before).toContain("perspective(");
    expect(before).toContain("rotateY(0deg)");

    fireEvent.pointerDown(card, { button: 0, pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerMove(card, { pointerId: 1, clientX: 400, clientY: 100 });
    expect(transform()).not.toBe(before);
    expect(card.style.transition).toBe("none");
    fireEvent.pointerUp(card, { pointerId: 1, clientX: 400, clientY: 100 });
    // 300px at the drag rate is past 90°, so it settles on the back: the Radiant face.
    expect(transform()).toContain("rotateY(180deg)");
    expect(card).toHaveAttribute("data-face", "back");

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId(INSPECTOR)).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("flips, zooms, and closes from its button and from the backdrop", () => {
    mount();
    fireEvent.click(screen.getByTestId(pageCardId(cardId)));
    fireEvent.click(screen.getByTestId(INSPECTOR_FLIP));
    expect(transform()).toContain("rotateY(180deg)");
    fireEvent.wheel(screen.getByTestId(INSPECTOR), { deltaY: -200 });
    expect(transform()).not.toContain("scale(1)");
    fireEvent.click(screen.getByTestId(INSPECTOR_CLOSE));
    expect(screen.queryByTestId(INSPECTOR)).toBeNull();

    fireEvent.click(screen.getByTestId(pageCardId(cardId)));
    const dialog = screen.getByTestId(INSPECTOR);
    // A click on the card is not a backdrop click.
    fireEvent.pointerDown(screen.getByTestId(INSPECTOR_CARD), { button: 0, pointerId: 2 });
    fireEvent.pointerUp(screen.getByTestId(INSPECTOR_CARD), { pointerId: 2 });
    fireEvent.click(screen.getByTestId(INSPECTOR_CARD));
    expect(screen.getByTestId(INSPECTOR)).toBeInTheDocument();
    fireEvent.pointerDown(dialog);
    fireEvent.click(dialog);
    expect(screen.queryByTestId(INSPECTOR)).toBeNull();
  });

  it("tilts toward an idle cursor, except under reduced motion", () => {
    const rect = { left: 0, top: 0, width: 200, height: 280, right: 200, bottom: 280, x: 0, y: 0 };
    const spy = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(rect as DOMRect);
    try {
      mount();
      fireEvent.click(screen.getByTestId(pageCardId(cardId)));
      const before = transform();
      fireEvent.pointerMove(screen.getByTestId(INSPECTOR), { clientX: 200, clientY: 0 });
      expect(transform()).not.toBe(before);
      cleanup();

      setReducedMotion(true);
      mount();
      fireEvent.click(screen.getByTestId(pageCardId(cardId)));
      const still = transform();
      fireEvent.pointerMove(screen.getByTestId(INSPECTOR), { clientX: 200, clientY: 0 });
      expect(transform()).toBe(still);
      fireEvent.click(screen.getByTestId(INSPECTOR_FLIP));
      expect(screen.getByTestId(INSPECTOR_CARD).style.transition).toBe("none");
    } finally {
      spy.mockRestore();
    }
  });

  it("adds and removes the card from its toggle, and cannot add with no deck open", () => {
    mount();
    fireEvent.click(screen.getByTestId(pageCardId(cardId)));
    expect(screen.getByTestId(INSPECTOR_TOGGLE)).toBeDisabled();
    fireEvent.click(screen.getByTestId(INSPECTOR_CLOSE));

    newDeck();
    fireEvent.click(screen.getByTestId(pageCardId(cardId)));
    expect(screen.getByTestId(INSPECTOR_TOGGLE)).toHaveAttribute("data-action", "add");
    fireEvent.click(screen.getByTestId(INSPECTOR_TOGGLE));
    expect(screen.getByTestId(deckBarId(cardId))).toBeInTheDocument();
    expect(screen.getByTestId(INSPECTOR_TOGGLE)).toHaveAttribute("data-action", "remove");
    fireEvent.click(screen.getByTestId(INSPECTOR_TOGGLE));
    expect(screen.queryByTestId(deckBarId(cardId))).toBeNull();
  });

  it("opens from a bar too", () => {
    mount();
    newDeck();
    rightClick(pageCardId(cardId));
    fireEvent.click(screen.getByTestId(deckBarId(cardId)));
    expect(screen.getByRole("dialog", { name: fixtureCardName(1) })).toBeInTheDocument();
  });

  it("shows the Radiant face on the back, or a card back for a card with no radiant form", () => {
    const plain = { ...catalog.cards[cardId], radiant: catalog.cards[cardId]?.base } as NonNullable<
      CatalogSnapshot["cards"][string]
    >;
    mount({ catalog: { ...catalog, cards: { ...catalog.cards, [cardId]: plain } } });
    fireEvent.click(screen.getByTestId(pageCardId(cardId)));
    const card = screen.getByTestId(INSPECTOR_CARD);
    expect(card.querySelector('[data-radiant="true"]')).toBeNull();
    expect(within(card).getByText("No Radiant form")).toBeInTheDocument();
    cleanup();

    mount();
    fireEvent.click(screen.getByTestId(pageCardId(fixtureCardId(2))));
    expect(screen.getByTestId(INSPECTOR_CARD).querySelector('[data-radiant="true"]')).not.toBeNull();
  });
});

describe("saving", () => {
  const first = fixtureCardId(1);
  const second = fixtureCardId(2);

  it("creates a new deck, then updates it, sending each draft", async () => {
    const props = mount();
    newDeck();
    expect(screen.getByTestId(DECK_NAME_INPUT)).toHaveValue("New deck");
    fireEvent.change(screen.getByTestId(DECK_NAME_INPUT), { target: { value: "Aggro" } });
    rightClick(pageCardId(first));
    fireEvent.click(screen.getByTestId(DECK_SAVE));
    await waitFor(() => {
      expect(screen.getByTestId(DECK_SAVED)).toBeInTheDocument();
    });
    expect(props.create).toHaveBeenCalledWith({ name: "Aggro", cards: [first] });

    rightClick(pageCardId(second));
    expect(screen.queryByTestId(DECK_SAVED), "an edit retires the Saved marker").toBeNull();
    fireEvent.click(screen.getByTestId(DECK_SAVE));
    await waitFor(() => {
      expect(screen.getByTestId(DECK_SAVED)).toBeInTheDocument();
    });
    expect(props.save).toHaveBeenCalledWith("new-1", { name: "Aggro", cards: [first, second] });
    expect(props.create).toHaveBeenCalledTimes(1);
  });

  it("shows the client's verdict on an open deck, from the validator, verbatim", () => {
    const stored: LibraryDeck = { id: "bad", name: "Odd one", cards: [fixtureCardId(1), TOKEN_ID, "core-999"] };
    mount({ decks: [stored] });
    fireEvent.click(screen.getByTestId(libraryDeckId("bad")));
    const want = issuesFor(stored.cards, stored.name);
    expect(new Set(want.map((issue) => issue.rule))).toEqual(new Set(["L3", "L5", "L6"]));
    const shown = screen.getByTestId(DECK_ERRORS).querySelectorAll("li");
    expect([...shown].map((node) => node.textContent)).toEqual(want.map((issue) => issue.message));
    expect([...shown].every((node) => node.getAttribute("data-source") === "client")).toBe(true);
  });

  it("skips the client verdict without a collection", () => {
    mount({ collection: null, decks: [{ id: "bad", name: "Odd one", cards: [TOKEN_ID] }] });
    fireEvent.click(screen.getByTestId(libraryDeckId("bad")));
    expect(screen.getByTestId(DECK_ERRORS)).toHaveAttribute("data-count", "0");
  });

  it("renders the server's issues verbatim and as the server's, until the next edit", async () => {
    const serverIssues = issuesFor([TOKEN_ID], "New deck");
    expect(serverIssues.length).toBeGreaterThan(0);
    mount({ create: vi.fn().mockResolvedValue({ ok: false, message: serverIssues[0]?.message ?? "", issues: serverIssues }) });
    newDeck();
    rightClick(pageCardId(first));
    fireEvent.click(screen.getByTestId(DECK_SAVE));
    await waitFor(() => {
      expect(screen.getByTestId(DECK_ERRORS)).toHaveAttribute("data-count", String(serverIssues.length));
    });
    const shown = [...screen.getByTestId(DECK_ERRORS).querySelectorAll("li")];
    expect(shown.map((node) => node.textContent)).toEqual(serverIssues.map((issue) => issue.message));
    expect(shown.every((node) => node.getAttribute("data-source") === "server")).toBe(true);
    expect(screen.queryByTestId(DECK_SAVE_ERROR)).toBeNull();

    rightClick(pageCardId(second));
    expect(screen.getByTestId(DECK_ERRORS)).toHaveAttribute("data-count", "0");
  });

  it("shows a refusal that is not a rule failure as the server wrote it", async () => {
    const message = "update required";
    mount({ create: vi.fn().mockResolvedValue({ ok: false, message, issues: [] }) });
    newDeck();
    fireEvent.click(screen.getByTestId(DECK_SAVE));
    await waitFor(() => {
      expect(screen.getByTestId(DECK_SAVE_ERROR)).toHaveTextContent(message);
    });
  });

  it("keeps edits made while a save is in flight, and the deck stays unsaved", async () => {
    const save = inFlight();
    const props = mount({ create: vi.fn().mockReturnValue(save.promise) });
    newDeck();
    rightClick(pageCardId(first));
    fireEvent.click(screen.getByTestId(DECK_SAVE));
    rightClick(pageCardId(second));
    fireEvent.change(screen.getByTestId(DECK_NAME_INPUT), { target: { value: "Aggro" } });
    await save.land({ ok: true, deck: { id: "d1", name: "New deck", cards: [first] } });

    expect(count()).toBe("2");
    expect(screen.getByTestId(deckBarId(second))).toBeInTheDocument();
    expect(screen.getByTestId(DECK_NAME_INPUT)).toHaveValue("Aggro");
    expect(screen.queryByTestId(DECK_SAVED), "the edits are not saved").toBeNull();
    fireEvent.click(screen.getByTestId(DECK_BACK));
    expect(screen.getByTestId(DECK_DISCARD_CONFIRM), "Back asks before dropping them").toBeInTheDocument();

    // The stored deck's id was adopted: the next save updates it.
    fireEvent.click(screen.getByTestId(DECK_SAVE));
    expect(props.save).toHaveBeenCalledWith("d1", { name: "Aggro", cards: [first, second] });
  });

  it("drops a refusal that lands after the deck was edited: it was about a deck that no longer exists", async () => {
    const save = inFlight();
    mount({ create: vi.fn().mockReturnValue(save.promise) });
    newDeck();
    rightClick(pageCardId(first));
    fireEvent.click(screen.getByTestId(DECK_SAVE));
    rightClick(pageCardId(second));
    await save.land({ ok: false, message: "STALE", issues: [{ rule: "L5", message: "STALE", cardId: first }] });

    expect(screen.queryByTestId(DECK_SAVE_ERROR)).toBeNull();
    expect(screen.getByTestId(DECK_ERRORS).querySelectorAll('[data-source="server"]')).toHaveLength(0);
    expect(count()).toBe("2");
  });

  it("holds Discard while a save is in flight", async () => {
    const save = inFlight();
    mount({ decks: [deck("a", 1)], save: vi.fn().mockReturnValue(save.promise) });
    fireEvent.click(screen.getByTestId(libraryDeckId("a")));
    rightClick(pageCardId(fixtureCardId(2)));
    fireEvent.click(screen.getByTestId(DECK_BACK));
    fireEvent.click(screen.getByTestId(DECK_SAVE));
    expect(screen.getByTestId(DECK_DISCARD_CONFIRM)).toBeDisabled();

    await save.land({ ok: true, deck: deck("a", 2) });
    expect(screen.getByTestId(DECK_SAVED)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId(DECK_BACK));
    expect(screen.getByTestId(LIBRARY_DECKS), "nothing is left to discard").toBeInTheDocument();
  });

  it("asks before Back drops unsaved edits, and not when there are none", () => {
    mount({ decks: [deck("a", 2)] });
    fireEvent.click(screen.getByTestId(libraryDeckId("a")));
    fireEvent.click(screen.getByTestId(DECK_BACK));
    expect(screen.getByTestId(LIBRARY_DECKS)).toBeInTheDocument();

    fireEvent.click(screen.getByTestId(libraryDeckId("a")));
    rightClick(pageCardId(fixtureCardId(5)));
    fireEvent.click(screen.getByTestId(DECK_BACK));
    expect(screen.getByTestId(DECKLIST)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId(DECK_DISCARD_CONFIRM));
    expect(screen.getByTestId(LIBRARY_DECKS)).toBeInTheDocument();
  });
});

describe("the deck list", () => {
  it("lists each deck with its count and an Incomplete badge when short", () => {
    mount({ decks: [deck("short", DECK_SIZE - 1), deck("full", DECK_SIZE)] });
    const short = screen.getByTestId(libraryDeckId("short"));
    expect(short).toHaveTextContent(`${String(DECK_SIZE - 1)}/${String(DECK_SIZE)}`);
    expect(within(short).getByTestId(LIBRARY_INCOMPLETE)).toBeInTheDocument();
    expect(within(screen.getByTestId(libraryDeckId("full"))).queryByTestId(LIBRARY_INCOMPLETE)).toBeNull();
  });

  it("opens a deck on click", () => {
    mount({ decks: [deck("a", 2)] });
    fireEvent.click(screen.getByTestId(libraryDeckId("a")));
    expect(screen.getByTestId(DECK_NAME_INPUT)).toHaveValue("Deck a");
    expect(count()).toBe("2");
  });

  it("deletes in two steps", async () => {
    const props = mount({ decks: [deck("a", 2)] });
    fireEvent.click(screen.getByTestId(libraryDeckDeleteId("a")));
    expect(props.remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId(libraryDeckDeleteConfirmId("a")));
    await waitFor(() => {
      expect(props.remove).toHaveBeenCalledWith("a");
    });
  });

  it("disables New deck at maxDecks", () => {
    const maxDecks = 2;
    mount({ maxDecks, decks: [deck("a", 1), deck("b", 1)] });
    expect(screen.getByTestId(LIBRARY_NEW_DECK)).toBeDisabled();
    expect(screen.getByTestId(LIBRARY_DECK_TOTAL)).toHaveTextContent(`2/${String(maxDecks)}`);
  });

  it("allows New deck under maxDecks", () => {
    mount({ maxDecks: 2, decks: [deck("a", 1)] });
    expect(screen.getByTestId(LIBRARY_NEW_DECK)).toBeEnabled();
  });
});
