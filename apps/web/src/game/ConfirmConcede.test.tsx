// "Concede this game?" (ConfirmConcede.tsx), on its own and as Game.tsx mounts it for every mode:
// the board's Concede control only asks, and only the dialog's Concede sends `{ type: "concede" }`.
// Keep playing, Escape and a click outside close it; the focus starts on Keep playing, Tab stays
// inside, and the focus goes back to the Concede control when it closes.

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ActionBody, PlayerView } from "@jackioh/shared";

import ConfirmConcede, { CONCEDE_BODY, CONCEDE_TITLE } from "./ConfirmConcede.tsx";
import Game from "./Game.tsx";
import { baseView } from "../test/fixtures.ts";

afterEach(cleanup);

const LEGAL: ActionBody[] = [{ type: "endTurn" }, { type: "offerDraw" }, { type: "concede" }];

function renderGame(view: PlayerView = baseView(), legal: readonly ActionBody[] = LEGAL) {
  const onAction = vi.fn<(body: ActionBody) => void>();
  const utils = render(<Game view={view} legal={legal} onAction={onAction} />);
  return { onAction, ...utils };
}

function press(key: string, options: { shiftKey?: boolean } = {}): void {
  fireEvent.keyDown(document.activeElement ?? document.body, { key, ...options });
}

describe("ConfirmConcede on its own", () => {
  it("is a labelled, described, modal alertdialog that asks the question and says what follows", () => {
    render(<ConfirmConcede onConfirm={vi.fn()} onCancel={vi.fn()} />);
    const dialog = screen.getByTestId("concede-dialog");
    expect(dialog).toHaveAttribute("role", "alertdialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleName(CONCEDE_TITLE);
    expect(dialog).toHaveAccessibleDescription(CONCEDE_BODY);
    expect(CONCEDE_TITLE).toBe("Concede this game?");
    expect(screen.getByTestId("concede-confirm")).toHaveTextContent("Concede");
    expect(screen.getByTestId("concede-cancel")).toHaveTextContent("Keep playing");
  });

  it("starts with the focus on Keep playing, the safe choice", () => {
    render(<ConfirmConcede onConfirm={vi.fn()} onCancel={vi.fn()} />);
    expect(screen.getByTestId("concede-cancel")).toHaveFocus();
  });

  it("keeps Tab and Shift+Tab between its two buttons", () => {
    render(<ConfirmConcede onConfirm={vi.fn()} onCancel={vi.fn()} />);
    const stay = screen.getByTestId("concede-cancel");
    const concede = screen.getByTestId("concede-confirm");
    press("Tab");
    expect(concede).toHaveFocus();
    press("Tab");
    expect(stay).toHaveFocus();
    press("Tab", { shiftKey: true });
    expect(concede).toHaveFocus();
    press("Tab", { shiftKey: true });
    expect(stay).toHaveFocus();
  });

  it("keeps Tab inside even once the focus has left the buttons (a click on the text or the page)", () => {
    render(
      <>
        <button type="button" data-testid="behind">
          behind
        </button>
        <ConfirmConcede onConfirm={vi.fn()} onCancel={vi.fn()} />
      </>,
    );
    // The panel itself can hold the focus, so a click on its text leaves it inside.
    expect(screen.getByTestId("concede-dialog")).toHaveAttribute("tabindex", "-1");
    // Wherever the focus has gone, the next Tab lands on a button of the dialog, never behind it.
    for (const shiftKey of [false, true]) {
      (document.activeElement as HTMLElement | null)?.blur();
      fireEvent.keyDown(document.body, { key: "Tab", shiftKey });
      expect(screen.getByTestId("behind")).not.toHaveFocus();
      expect([screen.getByTestId("concede-cancel"), screen.getByTestId("concede-confirm")]).toContain(document.activeElement);
    }
  });

  it("Concede confirms; Keep playing, Escape and a click outside the panel cancel", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    const { container } = render(<ConfirmConcede onConfirm={onConfirm} onCancel={onCancel} />);

    fireEvent.click(screen.getByTestId("concede-cancel"));
    press("Escape");
    fireEvent.keyDown(window, { key: "Escape" });
    const scrim = container.querySelector(".concede-scrim");
    if (scrim === null) throw new Error("no scrim");
    fireEvent.click(scrim);
    // A click inside the panel is not a click outside it.
    fireEvent.click(screen.getByTestId("concede-dialog"));
    expect(onCancel).toHaveBeenCalledTimes(4);
    expect(onConfirm).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("concede-confirm"));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});

describe("the board's Concede control asks first, in every mode (Game.tsx)", () => {
  it("opens the dialog and sends nothing; the control keeps its concede testid", () => {
    const { onAction } = renderGame();
    const control = screen.getByTestId("concede");
    expect(control.tagName).toBe("BUTTON");
    fireEvent.click(control);
    expect(screen.getByTestId("concede-dialog")).toBeInTheDocument();
    expect(onAction).not.toHaveBeenCalled();
  });

  it("only the dialog's Concede sends { type: \"concede\" }, once, and the dialog closes", () => {
    const { onAction } = renderGame();
    fireEvent.click(screen.getByTestId("concede"));
    fireEvent.click(screen.getByTestId("concede-confirm"));
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction).toHaveBeenCalledWith({ type: "concede" });
    expect(screen.queryByTestId("concede-dialog")).toBeNull();
  });

  it("Keep playing closes it, sends nothing and puts the focus back on the Concede control", () => {
    const { onAction } = renderGame();
    const control = screen.getByTestId("concede");
    fireEvent.click(control);
    expect(screen.getByTestId("concede-cancel")).toHaveFocus();
    fireEvent.click(screen.getByTestId("concede-cancel"));
    expect(screen.queryByTestId("concede-dialog")).toBeNull();
    expect(onAction).not.toHaveBeenCalled();
    expect(control).toHaveFocus();
  });

  it("Escape is Keep playing, and the focus goes back to the control", () => {
    const { onAction } = renderGame();
    const control = screen.getByTestId("concede");
    fireEvent.click(control);
    act(() => {
      press("Escape");
    });
    expect(screen.queryByTestId("concede-dialog")).toBeNull();
    expect(onAction).not.toHaveBeenCalled();
    expect(control).toHaveFocus();
  });

  it("a greyed-out Concede opens nothing (the engine did not list it)", () => {
    renderGame(baseView(), [{ type: "endTurn" }]);
    fireEvent.click(screen.getByTestId("concede"));
    expect(screen.queryByTestId("concede-dialog")).toBeNull();
  });

  it("the game ending while it is open closes it, and a hotseat hand-over drops the question for good", () => {
    const onAction = vi.fn();
    const { rerender } = render(<Game view={baseView()} legal={LEGAL} onAction={onAction} />);
    fireEvent.click(screen.getByTestId("concede"));
    expect(screen.getByTestId("concede-dialog")).toBeInTheDocument();

    rerender(<Game view={baseView({ viewer: "p2" })} legal={LEGAL} onAction={onAction} />);
    expect(screen.queryByTestId("concede-dialog")).toBeNull();
    rerender(<Game view={baseView()} legal={LEGAL} onAction={onAction} />);
    expect(screen.queryByTestId("concede-dialog"), "handing back does not reopen it").toBeNull();

    fireEvent.click(screen.getByTestId("concede"));
    expect(screen.getByTestId("concede-dialog")).toBeInTheDocument();
    rerender(<Game view={baseView({ result: { winner: "p2", reason: "hero-death" } })} legal={[]} onAction={onAction} />);
    expect(screen.queryByTestId("concede-dialog")).toBeNull();
    expect(onAction).not.toHaveBeenCalled();
  });

  it("works in the mulligan too, where concede is the only other move (R211)", () => {
    const view = baseView({ turn: 0, phase: "mulligan", pending: { forYou: false, pendingFor: "p2" } });
    const { onAction } = renderGame(view, [{ type: "concede" }]);
    fireEvent.click(screen.getByTestId("concede"));
    fireEvent.click(screen.getByTestId("concede-confirm"));
    expect(onAction).toHaveBeenCalledWith({ type: "concede" });
  });
});
