// Looking through a graveyard or an exile pile (Board.tsx `Pile`, cards/inspect/CardList.tsx). Both
// are public on both seats (§10.8: full `CardView` lists), so both seats' piles can be browsed; the
// library is a count and nothing else. A resting mouse shows the count and the newest faces; a
// click, a tap, a long-press or Enter opens every card, newest first, in a dialog.

import { CATALOG } from "@jackioh/cards";
import type { PlayerView } from "@jackioh/shared";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  INSPECT_CLOSE,
  INSPECT_LIST_BACK,
  INSPECT_LIST_CARD,
  INSPECT_LIST_COUNT,
  INSPECT_LIST_DETAIL,
  INSPECT_LIST_HOVER,
  INSPECT_LIST_MORE,
  INSPECT_LIST_SHEET,
  closeInspect,
} from "../cards/index.ts";
import { HOVER_DELAY_MS, LIST_PREVIEW_MAX, LONG_PRESS_MS } from "../cards/inspect/index.ts";
import { __resetSettingsForTests, writeSettings } from "../settings/store.ts";
import { card, fullBoardView } from "../test/fixtures.ts";
import Board from "./Board.tsx";
import { CatalogContext, lookupFromDefs } from "./catalog.ts";

const lookup = lookupFromDefs(CATALOG);
const nameOf = (defId: string): string => CATALOG[defId]?.name ?? defId;

function renderBoard(view: PlayerView = fullBoardView()): void {
  render(
    <CatalogContext.Provider value={lookup}>
      <Board view={view} />
    </CatalogContext.Provider>,
  );
}

function hover(element: HTMLElement): void {
  fireEvent.pointerEnter(element, { pointerType: "mouse" });
  act(() => {
    vi.advanceTimersByTime(HOVER_DELAY_MS);
  });
}

function names(root: HTMLElement): (string | null)[] {
  return within(root)
    .getAllByTestId(INSPECT_LIST_CARD)
    .map((element) => element.getAttribute("data-def-name"));
}

beforeEach(() => {
  vi.useFakeTimers();
  __resetSettingsForTests();
});

afterEach(() => {
  cleanup();
  closeInspect();
  vi.useRealTimers();
  __resetSettingsForTests();
  try {
    window.localStorage.clear();
  } catch {
    // Storage is optional.
  }
});

describe("a pile that holds cards can be looked through", () => {
  it("graveyards and exile piles that hold cards are buttons; the library and an empty pile are not", () => {
    renderBoard();
    for (const id of ["graveyard-you", "exile-you", "graveyard-opponent"]) {
      const pile = screen.getByTestId(id);
      expect(pile, id).toHaveAttribute("data-browsable", "true");
      expect(pile, id).toHaveAttribute("role", "button");
      expect(pile, id).toHaveAttribute("tabindex", "0");
      expect(pile, id).toHaveAttribute("aria-haspopup", "dialog");
    }
    expect(screen.getByTestId("graveyard-you")).toHaveAttribute("aria-label", "Your graveyard: 2 cards. Show them");
    for (const id of ["library-you", "library-opponent", "exile-opponent"]) {
      const pile = screen.getByTestId(id);
      expect(pile, id).not.toHaveAttribute("data-browsable");
      expect(pile, id).not.toHaveAttribute("role");
      expect(pile, id).not.toHaveAttribute("tabindex");
    }
    // The counts the e2e specs read are where they were.
    expect(screen.getByTestId("graveyard-count-you")).toHaveTextContent("2");
  });

  it("a resting mouse shows the count and the faces, newest first, click-through; leaving hides it", () => {
    renderBoard();
    const pile = screen.getByTestId("graveyard-you");
    fireEvent.pointerEnter(pile, { pointerType: "mouse" });
    act(() => {
      vi.advanceTimersByTime(HOVER_DELAY_MS - 1);
    });
    expect(screen.queryByTestId(INSPECT_LIST_HOVER)).toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    const preview = screen.getByTestId(INSPECT_LIST_HOVER);
    expect(preview.style.pointerEvents).toBe("none");
    expect(preview).toHaveAttribute("aria-hidden", "true");
    expect(preview).toHaveTextContent("Your graveyard");
    expect(within(preview).getByTestId(INSPECT_LIST_COUNT)).toHaveAttribute("data-count", "2");
    // The engine appends each card that lands in a pile, so the last is the newest.
    expect(names(preview)).toEqual([nameOf("core-005"), nameOf("core-003")]);
    fireEvent.pointerLeave(pile, { pointerType: "mouse" });
    expect(screen.queryByTestId(INSPECT_LIST_HOVER)).toBeNull();
  });

  it(`the preview shows at most LIST_PREVIEW_MAX faces and says how many more there are`, () => {
    const view = fullBoardView();
    const graveyard = Array.from({ length: LIST_PREVIEW_MAX + 3 }, (_unused, at) =>
      card({ defId: `core-0${String(10 + at)}` }),
    );
    renderBoard({ ...view, you: { ...view.you, graveyard } });
    hover(screen.getByTestId("graveyard-you"));
    const preview = screen.getByTestId(INSPECT_LIST_HOVER);
    expect(within(preview).getAllByTestId(INSPECT_LIST_CARD)).toHaveLength(LIST_PREVIEW_MAX);
    expect(within(preview).getByTestId(INSPECT_LIST_MORE)).toHaveTextContent("+3 more");
    expect(names(preview)[0]).toBe(nameOf(`core-0${String(10 + LIST_PREVIEW_MAX + 2)}`));
  });

  it("a click opens every card newest first in a dialog; a face opens large, and Back and Escape step out", () => {
    renderBoard();
    const pile = screen.getByTestId("graveyard-you");
    pile.focus();
    fireEvent.click(pile);
    const sheet = screen.getByTestId(INSPECT_LIST_SHEET);
    expect(sheet).toHaveAttribute("role", "dialog");
    expect(sheet).toHaveAttribute("aria-modal", "true");
    expect(sheet).toHaveAttribute("aria-label", "Your graveyard");
    expect(within(sheet).getByTestId(INSPECT_LIST_COUNT)).toHaveTextContent("2 cards");
    expect(names(sheet)).toEqual([nameOf("core-005"), nameOf("core-003")]);
    expect(screen.getByTestId(INSPECT_CLOSE)).toHaveFocus();

    const [newest] = within(sheet).getAllByTestId(INSPECT_LIST_CARD);
    if (newest === undefined) throw new Error("a face");
    fireEvent.click(newest);
    const detail = screen.getByTestId(INSPECT_LIST_DETAIL);
    expect(detail).toHaveTextContent(nameOf("core-005"));
    expect(screen.getByTestId(INSPECT_LIST_BACK)).toHaveFocus();

    fireEvent.click(screen.getByTestId(INSPECT_LIST_BACK));
    expect(screen.queryByTestId(INSPECT_LIST_DETAIL)).toBeNull();
    expect(within(screen.getByTestId(INSPECT_LIST_SHEET)).getAllByTestId(INSPECT_LIST_CARD)[0]).toHaveFocus();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId(INSPECT_LIST_SHEET)).toBeNull();
    expect(pile).toHaveFocus();
  });

  it("Enter or Space on the focused pile opens the dialog", () => {
    renderBoard();
    const pile = screen.getByTestId("exile-you");
    fireEvent.keyDown(pile, { key: "Enter" });
    expect(screen.getByTestId(INSPECT_LIST_SHEET)).toHaveTextContent(nameOf("core-007"));
    fireEvent.click(screen.getByTestId(INSPECT_CLOSE));
    expect(screen.queryByTestId(INSPECT_LIST_SHEET)).toBeNull();
    fireEvent.keyDown(pile, { key: " " });
    expect(screen.getByTestId(INSPECT_LIST_SHEET)).toHaveAttribute("aria-label", "Your exile");
  });

  it("a touch long-press opens the dialog once, and the tap it ends with opens no second one", () => {
    renderBoard();
    const pile = screen.getByTestId("graveyard-opponent");
    fireEvent.pointerDown(pile, { pointerType: "touch", pointerId: 1, clientX: 10, clientY: 10 });
    act(() => {
      vi.advanceTimersByTime(LONG_PRESS_MS);
    });
    expect(screen.getByTestId(INSPECT_LIST_SHEET)).toHaveAttribute("aria-label", "Opponent's graveyard");
    fireEvent.pointerUp(pile, { pointerType: "touch", pointerId: 1 });
    fireEvent.click(pile);
    expect(screen.getAllByTestId(INSPECT_LIST_SHEET)).toHaveLength(1);
    expect(names(screen.getByTestId(INSPECT_LIST_SHEET))).toEqual([nameOf("core-009")]);
  });

  it("with hover previews off there is no preview and the pile's label is its tooltip again; a click still opens it", () => {
    writeSettings({ hoverPreviews: false });
    renderBoard();
    const pile = screen.getByTestId("graveyard-you");
    expect(pile).toHaveAttribute("title", "Graveyard");
    hover(pile);
    expect(screen.queryByTestId(INSPECT_LIST_HOVER)).toBeNull();
    fireEvent.click(pile);
    expect(screen.getByTestId(INSPECT_LIST_SHEET)).toBeInTheDocument();
  });
});
