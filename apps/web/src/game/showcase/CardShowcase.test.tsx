// The opponent's-play showcase as the player sees it (CardShowcase.tsx): held up for about a second
// from the redacted view alone, click-through, never for the viewer's own play, a back for a card
// the view hides (R97, R227), per viewer on a hotseat device, and gone on Escape or a pointer down.

import { CATALOG } from "@jackioh/cards";
import type { GameEvent, PlayerView } from "@jackioh/shared";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resetFxSettingsForTests, setFxSettings } from "../../fx/settings.ts";
import { __resetSettingsForTests, writeSettings } from "../../settings/store.ts";
import { baseView, withEvents } from "../../test/fixtures.ts";
import { CatalogContext, lookupFromDefs } from "../catalog.ts";
import Game from "../Game.tsx";
import CardShowcase from "./CardShowcase.tsx";
import { SHOWCASE_HOLD_MS, SHOWCASE_QUEUE_MAX, showcaseHoldMs, showcaseTestid as T } from "./constants.ts";

const lookup = lookupFromDefs(CATALOG);
const PANTHER = "core-032";
const PANTHER_NAME = CATALOG[PANTHER]?.name ?? "";
const SHEEPISH = "core-041";

const TURN: GameEvent = { type: "turnStarted", player: "p2", turn: 4 };

function played(player: "p1" | "p2", instanceId: string, defId: string): GameEvent {
  return { type: "cardPlayed", player, instanceId, defId, costPaid: 2 };
}

function withCatalog(node: ReactElement): ReactElement {
  return <CatalogContext.Provider value={lookup}>{node}</CatalogContext.Provider>;
}

/** The first view has no "since"; the second brings `events` after it. */
function mountThen(events: GameEvent[], before: PlayerView = withEvents(baseView(), [TURN])): { next: (view: PlayerView) => void } {
  const { rerender } = render(withCatalog(<CardShowcase view={before} />));
  const next = (view: PlayerView): void => {
    rerender(withCatalog(<CardShowcase view={view} />));
  };
  next(withEvents(baseView(), [TURN, ...events]));
  return { next };
}

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  resetFxSettingsForTests();
  __resetSettingsForTests();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  resetFxSettingsForTests();
  __resetSettingsForTests();
  try {
    window.localStorage.clear();
  } catch {
    // Storage is optional.
  }
});

describe("the opponent's play is held up", () => {
  it("shows the opponent's played card face, click-through, and says so politely", () => {
    mountThen([played("p2", "c7", PANTHER)]);
    const showcase = screen.getByTestId(T.root);
    expect(showcase).toHaveAttribute("data-showcase", "played");
    expect(showcase).toHaveAttribute("data-showcase-def", PANTHER);
    expect(showcase).toHaveAttribute("aria-hidden", "true");
    expect(showcase.style.pointerEvents, "click-through").toBe("none");
    expect(screen.getByTestId(T.caption)).toHaveTextContent("Opponent played");
    expect(screen.getByTestId(T.face)).toHaveTextContent(PANTHER_NAME);
    expect(screen.getByTestId(T.live)).toHaveTextContent(`Opponent played ${PANTHER_NAME}`);
    expect(screen.getByTestId(T.live)).toHaveAttribute("aria-live", "polite");
    // A face in the showcase answers no board selector (B20).
    expect(showcase.querySelector("[data-testid^='card-'], [data-testid^='hand-card-']")).toBeNull();
  });

  it("goes by itself after SHOWCASE_HOLD_MS", () => {
    mountThen([played("p2", "c7", PANTHER)]);
    advance(SHOWCASE_HOLD_MS - 1);
    expect(screen.getByTestId(T.root)).toBeInTheDocument();
    advance(1);
    expect(screen.queryByTestId(T.root)).toBeNull();
    expect(screen.getByTestId(T.live)).toHaveTextContent("");
  });

  it("R201 holds for SHOWCASE_HOLD_MS divided by the effects speed", () => {
    setFxSettings({ speed: 2 });
    mountThen([played("p2", "c7", PANTHER)]);
    expect(showcaseHoldMs(2)).toBe(SHOWCASE_HOLD_MS / 2);
    advance(SHOWCASE_HOLD_MS / 2);
    expect(screen.queryByTestId(T.root)).toBeNull();
    expect(showcaseHoldMs(0.5)).toBe(SHOWCASE_HOLD_MS * 2);
  });

  it("never shows the viewer's own play", () => {
    mountThen([played("p1", "c3", "core-011")]);
    expect(screen.queryByTestId(T.root)).toBeNull();
    expect(screen.getByTestId(T.live)).toHaveTextContent("");
  });

  it("shows nothing for the first view it is given: that board has always been there", () => {
    render(withCatalog(<CardShowcase view={withEvents(baseView(), [TURN, played("p2", "c7", PANTHER)])} />));
    expect(screen.queryByTestId(T.root)).toBeNull();
  });

  it("R97 / R227 a card set face down is a back with a caption, and nothing names it", () => {
    mountThen([
      played("p2", "hidden", "hidden"),
      { type: "summoned", player: "p2", instanceId: "hidden", defId: "hidden", row: "backrow", lane: 3 },
    ]);
    const showcase = screen.getByTestId(T.root);
    expect(showcase).toHaveAttribute("data-showcase", "set");
    expect(showcase).not.toHaveAttribute("data-showcase-def");
    expect(screen.getByTestId(T.back)).toBeInTheDocument();
    expect(screen.queryByTestId(T.face)).toBeNull();
    expect(screen.getByTestId(T.caption)).toHaveTextContent("Opponent set a card");
    expect(screen.getByTestId(T.live)).toHaveTextContent("Opponent set a card");
    expect(document.body.innerHTML).not.toMatch(/core-\d+/);
    expect(document.body.textContent).not.toContain(CATALOG[SHEEPISH]?.name ?? "Sheepish");
  });

  it("plays one after another, newest SHOWCASE_QUEUE_MAX at most", () => {
    const many = ["core-001", "core-003", "core-005", "core-008", "core-011"].map((defId, at) => played("p2", `c${String(at + 10)}`, defId));
    mountThen(many);
    const shown: (string | null)[] = [];
    for (let i = 0; i < many.length; i += 1) {
      shown.push(screen.queryByTestId(T.root)?.getAttribute("data-showcase-def") ?? null);
      advance(SHOWCASE_HOLD_MS);
    }
    expect(shown.filter((defId) => defId !== null)).toEqual(["core-005", "core-008", "core-011"]);
    expect(SHOWCASE_QUEUE_MAX).toBe(3);
  });

  it("Escape, or a pointer down anywhere, puts it away with whatever was waiting", () => {
    const { next } = mountThen([played("p2", "c7", PANTHER), played("p2", "c8", "core-011")]);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByTestId(T.root)).toBeNull();
    advance(SHOWCASE_HOLD_MS * 3);
    expect(screen.queryByTestId(T.root)).toBeNull();

    next(withEvents(baseView(), [TURN, played("p2", "c7", PANTHER), played("p2", "c8", "core-011"), played("p2", "c9", "core-003")]));
    expect(screen.getByTestId(T.root)).toHaveAttribute("data-showcase-def", "core-003");
    fireEvent.pointerDown(document.body);
    expect(screen.queryByTestId(T.root)).toBeNull();
  });

  it("a game over takes it down", () => {
    const { next } = mountThen([played("p2", "c7", PANTHER)]);
    next({ ...withEvents(baseView(), [TURN, played("p2", "c7", PANTHER)]), result: { winner: "p2", reason: "concede" } });
    expect(screen.queryByTestId(T.root)).toBeNull();
  });

  it("reduced motion still shows it, for the same hold, without motion", () => {
    writeSettings({ reduceMotion: true });
    mountThen([played("p2", "c7", PANTHER)]);
    expect(screen.getByTestId(T.root)).toHaveAttribute("data-motion", "reduce");
    advance(SHOWCASE_HOLD_MS);
    expect(screen.queryByTestId(T.root)).toBeNull();
  });
});

describe("per viewer, as a hotseat device is handed over", () => {
  const asP2 = (events: GameEvent[]): PlayerView =>
    withEvents(baseView({ viewer: "p2", you: baseView().opponent, opponent: baseView().you }), events);

  it("the arriving seat catches up on the plays made since it last held the device, and only those", () => {
    const log: GameEvent[] = [TURN];
    const { rerender } = render(withCatalog(<CardShowcase view={withEvents(baseView(), [...log])} />));
    const show = (view: PlayerView): void => {
      rerender(withCatalog(<CardShowcase view={view} />));
    };
    // p2 takes the device and plays; its own play is not shown to it.
    show(asP2([...log]));
    log.push(played("p2", "c7", PANTHER), { type: "turnEnded", player: "p2", turn: 4, unspentMana: 0 });
    show(asP2([...log]));
    expect(screen.queryByTestId(T.root)).toBeNull();
    // Back to p1: p2's play is new to p1.
    show(withEvents(baseView(), [...log]));
    expect(screen.getByTestId(T.root)).toHaveAttribute("data-showcase-def", PANTHER);
    advance(SHOWCASE_HOLD_MS);
    // p1 plays: its own. Back to p2, whose last view already had its own play: p1's is the only new one.
    log.push(played("p1", "c3", "core-011"));
    show(withEvents(baseView(), [...log]));
    expect(screen.queryByTestId(T.root)).toBeNull();
    show(asP2([...log]));
    expect(screen.getByTestId(T.root)).toHaveAttribute("data-showcase-def", "core-011");
    advance(SHOWCASE_HOLD_MS);
    expect(screen.queryByTestId(T.root)).toBeNull();
  });
});

describe("mounted by the board", () => {
  it("Game holds the opponent's play up as its view arrives, and never takes the board's moves away", () => {
    const before = withEvents(baseView({ active: "p2" }), [TURN]);
    const onAction = vi.fn();
    const { rerender } = render(withCatalog(<Game view={before} legal={[]} onAction={onAction} />));
    const after = withEvents(baseView({ active: "p2" }), [TURN, played("p2", "c7", PANTHER)]);
    rerender(withCatalog(<Game view={after} legal={[]} onAction={onAction} />));
    expect(screen.getByTestId(T.root)).toHaveAttribute("data-showcase-def", PANTHER);
    // The showcase carries no data-animating: it holds no view back and cy.settled() never waits on it.
    expect(screen.getByTestId(T.root)).not.toHaveAttribute("data-animating");
    expect(screen.getByTestId(T.root).querySelector("[data-animating]")).toBeNull();
  });
});
