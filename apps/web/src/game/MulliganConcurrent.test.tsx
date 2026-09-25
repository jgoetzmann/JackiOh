// R265, R266: the concurrent mulligan as the picker shows it. Both seats' mulligans are open at once;
// the view says whether the opponent has answered (`view.mulligan.opponentReady`) and, once the
// viewer has, what it kept (`view.mulligan.kept`). The picker's confirm reads "Ready"; after it, the
// picker gives way to `mulligan-waiting` until the game begins. Everything is read off the view.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { MulliganView, PlayerView } from "@jackioh/shared";

import Game from "./Game.tsx";
import Prompt from "./Prompt.tsx";
import { baseView, card, emptySide, pendingFor } from "../test/fixtures.ts";

afterEach(cleanup);

const HAND = [
  card({ instanceId: "h1", defId: "core-002" }),
  card({ instanceId: "h2", defId: "core-019" }),
  card({ instanceId: "h3", defId: "core-004" }),
];

function mulliganView(mulligan: MulliganView, over: Partial<PlayerView> = {}): PlayerView {
  const waiting = mulligan.youReady;
  return baseView({
    turn: 0,
    phase: "mulligan",
    you: emptySide("p1", { hand: HAND }),
    opponent: emptySide("p2", { hand: { count: 4 } }),
    pending: waiting
      ? { forYou: false, pendingFor: "p2" }
      : pendingFor(
          "mulligan",
          HAND.map((c) => ({ key: c.instanceId, label: c.defId, instanceId: c.instanceId })),
          { min: 0, max: HAND.length, prompt: "Choose the cards to keep; the rest are returned and redrawn" },
        ),
    mulligan,
    ...over,
  });
}

describe("R265 the mulligan picker, while the viewer still owes its answer", () => {
  it("R265 says the opponent is choosing until it has answered, with one hook and data-ready", () => {
    render(<Prompt view={mulliganView({ youReady: false, opponentReady: false })} onAction={vi.fn()} />);
    const status = screen.getByTestId("mulligan-opponent-status");
    expect(status).toHaveAttribute("data-ready", "false");
    expect(status).toHaveTextContent("Opponent is choosing…");
    expect(screen.queryByTestId("mulligan-opponent-ready")).toBeNull();
    expect(screen.getByTestId("prompt-modal")).toHaveAttribute("data-prompt-kind", "mulligan");
  });

  it("R265 says the opponent is ready once it has answered, and the picker stays the viewer's to answer", () => {
    render(<Prompt view={mulliganView({ youReady: false, opponentReady: true })} onAction={vi.fn()} />);
    expect(screen.getByTestId("mulligan-opponent-status")).toHaveAttribute("data-ready", "true");
    expect(screen.getByTestId("mulligan-opponent-ready")).toHaveTextContent("Opponent is ready");
    expect(screen.getByTestId("prompt-modal")).toHaveAttribute("data-prompt-kind", "mulligan");
    expect(screen.queryByTestId("mulligan-waiting")).toBeNull();
  });

  it("R265 the confirm reads Ready and sends the viewer's own mulligan, whether or not the opponent has answered", () => {
    for (const opponentReady of [false, true]) {
      const onAction = vi.fn();
      render(<Prompt view={mulliganView({ youReady: false, opponentReady })} onAction={onAction} />);
      const ready = screen.getByTestId("prompt-submit");
      expect(ready).toHaveTextContent("Ready");
      fireEvent.click(screen.getByTestId("prompt-option-h2"));
      fireEvent.click(ready);
      expect(onAction).toHaveBeenCalledWith({ type: "mulligan", keep: ["h1", "h3"] });
      cleanup();
    }
  });

  it("any other picker still confirms with Confirm", () => {
    const view = baseView({
      you: emptySide("p1", { hand: HAND }),
      pending: pendingFor("tribute", [{ key: "h1", label: "One", instanceId: "h1" }], { min: 1, max: 1 }),
    });
    render(<Prompt view={view} onAction={vi.fn()} />);
    expect(screen.getByTestId("prompt-submit")).toHaveTextContent("Confirm");
    expect(screen.queryByTestId("mulligan-opponent-status")).toBeNull();
  });
});

describe("R266 after the viewer's answer, until the game begins", () => {
  it("R266 shows mulligan-waiting, not the generic waiting notice, with each card marked Keep or Redraw from kept", () => {
    render(<Prompt view={mulliganView({ youReady: true, opponentReady: false, kept: ["h1", "h3"] })} onAction={vi.fn()} />);
    const waiting = screen.getByTestId("mulligan-waiting");
    expect(waiting).toHaveTextContent("Waiting for your opponent…");
    expect(waiting).toHaveAttribute("data-returning", "1");
    expect(waiting).toHaveTextContent("1 card goes back");
    expect(screen.getByTestId("mulligan-waiting-card-h1")).toHaveAttribute("data-verdict", "keep");
    expect(screen.getByTestId("mulligan-waiting-card-h2")).toHaveAttribute("data-verdict", "redraw");
    expect(screen.getByTestId("mulligan-waiting-card-h3")).toHaveAttribute("data-verdict", "keep");

    // Nothing is left to answer, and it is not the other seat's "a choice is open" notice either:
    // no `prompt-modal`, no `data-prompt-kind` for e2e's picker helpers to find.
    expect(screen.queryByTestId("prompt-submit")).toBeNull();
    expect(screen.queryByTestId("prompt-modal")).toBeNull();
    expect(document.querySelector("[data-prompt-kind]")).toBeNull();
    expect(document.querySelector("[data-testid^='prompt-option-']")).toBeNull();
  });

  it("R266 a whole hand kept says so", () => {
    render(<Prompt view={mulliganView({ youReady: true, opponentReady: false, kept: ["h1", "h2", "h3"] })} onAction={vi.fn()} />);
    const waiting = screen.getByTestId("mulligan-waiting");
    expect(waiting).toHaveAttribute("data-returning", "0");
    expect(waiting).toHaveTextContent("keeping your whole hand");
    for (const c of HAND) expect(screen.getByTestId(`mulligan-waiting-card-${c.instanceId}`)).toHaveAttribute("data-verdict", "keep");
  });

  it("R266 every card going back is marked, and the count agrees", () => {
    render(<Prompt view={mulliganView({ youReady: true, opponentReady: false, kept: [] })} onAction={vi.fn()} />);
    expect(screen.getByTestId("mulligan-waiting")).toHaveAttribute("data-returning", "3");
    expect(screen.getByTestId("mulligan-waiting")).toHaveTextContent("3 cards go back");
  });

  it("outside the mulligan window, another seat's prompt is still the generic notice", () => {
    render(<Prompt view={baseView({ pending: { forYou: false, pendingFor: "p2" } })} onAction={vi.fn()} />);
    expect(screen.getByTestId("prompt-modal")).toHaveAttribute("data-prompt-waiting", "waiting");
    expect(screen.queryByTestId("mulligan-waiting")).toBeNull();
  });

  it("the whole board shows the same: the Game mounts the waiting panel, and the banner says Mulligan", () => {
    const view = mulliganView({ youReady: true, opponentReady: false, kept: ["h2"] });
    render(<Game view={view} legal={[{ type: "concede" }]} onAction={vi.fn()} />);
    expect(screen.getByTestId("mulligan-waiting")).toBeInTheDocument();
    expect(screen.getByTestId("turn-banner")).toHaveTextContent("Mulligan");
  });
});
