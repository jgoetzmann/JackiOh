// Game.tsx's integration-QA findings: the moves of a view the board is not showing yet, the
// game-over state (Result.tsx), and animations that played twice.
//
// 1. While the animation runner holds a newer view back, the board draws the older one; the newer
//    view's `legal` used to reach it anyway, so End turn lit up and the hand glowed during the AI's
//    playback, and a click ended a turn the player had not seen.
// 2. The result overlay printed the engine's reason slug ("hero-death") in a bare box with no way
//    on. It now says why in words, keeps the slug in `data-reason`, and offers the route's actions.
// 3. Animations played twice in a row whenever R97 re-redacted an event the new view's window
//    shared with the last one (the opponent playing a card it had just drawn): the diff of the two
//    windows found no overlap and the runner replayed the whole window before the new events.

import type { ActionBody, GameEvent, PlayerView } from "@jackioh/shared";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { StrictMode, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ANIMATIONS, HIDDEN_ID } from "./animations.ts";
import Game from "./Game.tsx";
import { resultReason } from "./Result.tsx";
import { __resetSettingsForTests, writeSettings } from "../settings/store.ts";
import { baseView, emptySide, unit, withEvents } from "../test/fixtures.ts";

const END_TURN: ActionBody = { type: "endTurn" };

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  window.localStorage.clear();
  __resetSettingsForTests();
});

const START: GameEvent[] = [{ type: "turnStarted", player: "p1", turn: 3 }];
/** A hit on the viewer's hero: an event the runner animates, so it holds the view back. */
const HIT: GameEvent = { type: "damage", sourceId: null, targetId: "hero-p1", amount: 3, combat: false };

describe("the board's moves wait for the board", () => {
  it("does not enable End turn for a view the runner is still holding back, and does once it drains", () => {
    const before = withEvents(baseView({ active: "p2" }), START);
    const onAction = vi.fn();
    const { rerender } = render(<Game view={before} legal={[]} onAction={onAction} />);
    expect(screen.getByTestId("end-turn")).toBeDisabled();

    // The opponent's last hit arrives with the viewer's turn: the board still shows the hit landing.
    const after = withEvents(baseView({ active: "p1" }), [...START, HIT]);
    rerender(<Game view={after} legal={[END_TURN]} onAction={onAction} />);
    expect(screen.getByTestId("animation-queue")).toBeInTheDocument();
    expect(screen.getByTestId("end-turn")).toBeDisabled();
    fireEvent.click(screen.getByTestId("end-turn"));
    expect(onAction).not.toHaveBeenCalled();

    // The runner drains; the board shows the new view, and its moves with it.
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(screen.queryByTestId("animation-queue")).toBeNull();
    expect(screen.getByTestId("end-turn")).not.toBeDisabled();
    fireEvent.click(screen.getByTestId("end-turn"));
    expect(onAction).toHaveBeenCalledWith(END_TURN);
  });

  it("offers the moves at once when nothing is animating", () => {
    render(<Game view={withEvents(baseView(), START)} legal={[END_TURN]} onAction={vi.fn()} />);
    expect(screen.getByTestId("end-turn")).not.toBeDisabled();
  });
});

function finished(over: Partial<PlayerView> = {}): PlayerView {
  return baseView({ result: { winner: "p2", reason: "hero-death" }, ...over });
}

describe("the result overlay", () => {
  it("says why in words, keeps Win / Loss / Draw and the engine's reason in data-reason", () => {
    render(<Game view={finished()} legal={[]} onAction={vi.fn()} />);
    const overlay = screen.getByTestId("result-overlay");
    expect(overlay).toHaveTextContent("Loss");
    expect(overlay).toHaveTextContent("Your hero has fallen.");
    expect(overlay).not.toHaveTextContent("hero-death");
    expect(overlay).toHaveAttribute("data-reason", "hero-death");
    expect(overlay).toHaveAttribute("data-outcome", "loss");
  });

  it("has a sentence for every reason, from either side", () => {
    const reasons = ["hero-death", "both-heroes-dead", "concede", "draw-accepted", "turn-cap", "disconnect", "match-ceiling"] as const;
    for (const reason of reasons) {
      for (const outcome of ["win", "loss", "draw"] as const) {
        const text = resultReason(outcome, reason);
        // A sentence, never the slug.
        expect(text, `${outcome} ${reason}`).toMatch(/^[A-Z].*\.$/);
        expect(text).not.toContain("-");
      }
    }
    expect(resultReason("win", "concede")).toBe("Your opponent conceded.");
    expect(resultReason("loss", "concede")).toBe("You conceded.");
  });

  it("offers the route's actions in a panel over a dimmed board, and folds to a chip to view the board", () => {
    const onBack = vi.fn();
    render(
      <Game
        view={finished()}
        legal={[]}
        onAction={vi.fn()}
        resultActions={
          <button type="button" data-testid="route-back" onClick={onBack}>
            Back
          </button>
        }
      />,
    );
    expect(screen.getByTestId("result-overlay")).toHaveAttribute("data-form", "panel");
    expect(document.querySelector(".result-scrim")).not.toBeNull();
    // Once it has come in, the route's first way on has the focus.
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(document.activeElement).toBe(screen.getByTestId("route-back"));
    fireEvent.click(screen.getByTestId("route-back"));
    expect(onBack).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByTestId("result-view-board"));
    expect(screen.getByTestId("result-overlay")).toHaveAttribute("data-form", "chip");
    expect(screen.getByTestId("result-overlay")).toHaveTextContent("Loss");
    expect(document.querySelector(".result-scrim")).toBeNull();

    fireEvent.click(screen.getByTestId("result-reopen"));
    expect(screen.getByTestId("result-overlay")).toHaveAttribute("data-form", "panel");
  });

  it("waits out the effects layer's Victory / Defeat before it takes the pointer", () => {
    render(<Game view={finished()} legal={[]} onAction={vi.fn()} />);
    const overlay = screen.getByTestId("result-overlay");
    expect(overlay).toHaveAttribute("data-revealed", "false");
    expect(overlay.style.animationDelay).not.toBe("");
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(screen.getByTestId("result-overlay")).toHaveAttribute("data-revealed", "true");
  });

  it("stays a chip when the route draws its own result dialog", () => {
    render(<Game view={finished()} legal={[]} onAction={vi.fn()} resultForm="chip" />);
    expect(screen.getByTestId("result-overlay")).toHaveAttribute("data-form", "chip");
    expect(screen.queryByTestId("result-view-board")).toBeNull();
    expect(screen.queryByTestId("result-reopen")).toBeNull();
    expect(document.querySelector(".result-scrim")).toBeNull();
  });

  it("says Game over where the turn was, and a hero past lethal reads 0", () => {
    const view = finished({
      you: { ...baseView().you, hero: { ...baseView().you.hero, health: -6 } },
    });
    render(<Game view={view} legal={[]} onAction={vi.fn()} />);
    expect(screen.getByTestId("turn-banner")).toHaveTextContent("Game over");
    expect(document.querySelector(".turn-plate")).toHaveTextContent("Game over");
    const health = document.querySelector('[data-testid="hero-you"] .hero-health, .hero .hero-health[data-health="-6"]');
    expect(health).not.toBeNull();
    expect(health).toHaveTextContent("0");
    expect(health).toHaveAttribute("data-health", "-6");
  });
});

describe("each event animates once", () => {
  // p2's turn as p1 watches it: p2 drew a card face-down, then plays it. R97 judges a card by where
  // it sits now, so the second view's copy of that `drawn` names the card the first view's hid.
  const ended: GameEvent = { type: "turnEnded", player: "p1", turn: 3, unspentMana: 0 };
  const started: GameEvent = { type: "turnStarted", player: "p2", turn: 4 };
  const mana: GameEvent = { type: "manaChanged", player: "p2", current: 4, max: 4 };
  const hiddenDraw: GameEvent = { type: "drawn", player: "p2", instanceId: HIDDEN_ID, defId: HIDDEN_ID };
  const namedDraw: GameEvent = { type: "drawn", player: "p2", instanceId: "c26", defId: "core-004" };
  const play: GameEvent = { type: "cardPlayed", player: "p2", instanceId: "c26", defId: "core-004", costPaid: 3 };
  const land: GameEvent = { type: "summoned", player: "p2", instanceId: "c26", defId: "core-004", row: "units", lane: 1 };

  const drawnView = withEvents(baseView({ active: "p2", turn: 4 }), [ended, started, mana, hiddenDraw]);
  const playedView = withEvents(
    baseView({
      active: "p2",
      turn: 4,
      opponent: emptySide("p2", {
        hand: { count: 3 },
        units: [unit("p2", { instanceId: "c26", defId: "core-004" }), null, null, null, null],
      }),
    }),
    [{ ...ended }, { ...started }, { ...mana }, namedDraw, play, land],
  );

  /** The one entry the play is: in flight at once, and nothing after it. */
  function expectOnlyThePlay(): void {
    expect(screen.getByTestId("animation-queue")).toHaveAttribute("data-animating", "cardPlayed");
    // The replay started with the turn banner and the opponent's library, which already played.
    expect(screen.getByTestId("turn-banner")).not.toHaveAttribute("data-animating");
    expect(screen.getByTestId("library-opponent")).not.toHaveAttribute("data-animating");
    act(() => {
      vi.advanceTimersByTime(ANIMATIONS.cardPlayed.durationMs);
    });
    expect(screen.queryByTestId("animation-queue")).toBeNull();
    expect(screen.getByTestId("turn-banner")).not.toHaveAttribute("data-animating");
  }

  it("R97 naming a card the last window drew face-down replays none of the window", () => {
    const { rerender } = render(<Game view={drawnView} legal={[]} onAction={vi.fn()} />);
    rerender(<Game view={playedView} legal={[]} onAction={vi.fn()} />);
    expectOnlyThePlay();
  });

  it("and not under StrictMode's doubled effects either", () => {
    const strict = (view: PlayerView): ReactElement => (
      <StrictMode>
        <Game view={view} legal={[]} onAction={vi.fn()} />
      </StrictMode>
    );
    const { rerender } = render(strict(drawnView));
    expect(screen.queryByTestId("animation-queue"), "the first view is the board as it has always been").toBeNull();
    rerender(strict(playedView));
    expectOnlyThePlay();
  });

  it("a runner rebuilt for Reduce motion mid-burst replays nothing when motion comes back", () => {
    const hit: GameEvent = { type: "damage", sourceId: null, targetId: "hero-p1", amount: 3, combat: false };
    const again: GameEvent = { type: "damage", sourceId: null, targetId: "hero-p1", amount: 2, combat: false };
    const first = withEvents(baseView(), START);
    const { rerender } = render(<Game view={first} legal={[]} onAction={vi.fn()} />);
    rerender(<Game view={withEvents(baseView(), [...START, hit])} legal={[]} onAction={vi.fn()} />);
    expect(screen.getByTestId("animation-queue")).toHaveAttribute("data-animating", "damage");

    act(() => {
      writeSettings({ reduceMotion: true });
    });
    expect(screen.queryByTestId("animation-queue")).toBeNull();
    act(() => {
      writeSettings({ reduceMotion: false });
    });
    expect(screen.queryByTestId("animation-queue"), "the rebuilt runner does not replay the hit").toBeNull();

    rerender(<Game view={withEvents(baseView(), [...START, hit, again])} legal={[]} onAction={vi.fn()} />);
    expect(screen.getByTestId("animation-queue")).toHaveAttribute("data-animating", "damage");
    expect(screen.getByTestId("hero-you")).toHaveAttribute("data-animating", "damage");
    act(() => {
      vi.advanceTimersByTime(ANIMATIONS.damage.durationMs);
    });
    expect(screen.queryByTestId("animation-queue"), "one hit, one entry").toBeNull();
  });
});
