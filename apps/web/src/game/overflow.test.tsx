// R318: the board shows §2.4's three overflows on both seats — a fatigue draw on the library pile
// ("Fatigue N"), a full library turning a card away ("Library full" and the card), and a full hand
// burning one ("Hand full" and the card) — from the redacted event alone.
//
// The notices are the board's own elements (OverflowNotices.tsx), so they are proved here through
// the whole client (`Game`, whose runner starts the entries), with fake timers: a notice mounts when
// its entry starts, is `data-playing` only while that entry is in flight, stays up through the rest
// of the burst (the fatigue hit landing after it), and goes when the board catches up. A card the
// viewer reads is drawn face up with its name; R97's sentinel is a back that names nothing. Reduced
// motion starts no entry, so nothing mounts, and the effects speed scales the entries (R201).
// `animations.window.test.ts` proves the other half: each event reaches each seat's runner once.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { CATALOG } from "@jackioh/cards";
import type { GameEvent, PlayerView } from "@jackioh/shared";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ANIMATIONS, HIDDEN_ID, MIN_ENTRY_MS, targetFor } from "./animations.ts";
import Board from "./Board.tsx";
import { CatalogContext, lookupFromDefs } from "./catalog.ts";
import { animTestid } from "./animations.ts";
import Game from "./Game.tsx";
import Log from "./Log.tsx";
import { noticeTestid } from "./OverflowNotices.tsx";
import { testid } from "./contract.ts";
import { resetFxSettingsForTests, setFxSettings } from "../fx/settings.ts";
import { __resetSettingsForTests, writeSettings } from "../settings/store.ts";
import { baseView, emptySide, withEvents } from "../test/fixtures.ts";
import { setReducedMotion } from "../test/setup.ts";

const lookup = lookupFromDefs(CATALOG);
const PANTHER = "core-032";
const SHEEPISH = "core-041";
const VIRUS = "core-090-1";

function nameOf(defId: string): string {
  const name = CATALOG[defId]?.name;
  if (name === undefined || name === "") throw new Error(`the catalog has no name for ${defId}`);
  return name;
}

const TURN: GameEvent = { type: "turnStarted", player: "p1", turn: 5 };

/** The same board from either seat: p1 sits in `you` for p1, in `opponent` for p2. */
function seatView(viewer: "p1" | "p2", events: GameEvent[] = [TURN]): PlayerView {
  const other = viewer === "p1" ? "p2" : "p1";
  return withEvents(
    baseView({
      viewer,
      you: emptySide(viewer, { libraryCount: 0 }),
      opponent: emptySide(other, { hand: { count: 4 }, libraryCount: 0 }),
    }),
    events,
  );
}

function withCatalog(node: ReactElement): ReactElement {
  return <CatalogContext.Provider value={lookup}>{node}</CatalogContext.Provider>;
}

/** Mounts the client on a quiet board, then hands it the view `events` produced (after the turn). */
function play(viewer: "p1" | "p2", events: GameEvent[]): void {
  const { rerender } = render(withCatalog(<Game view={seatView(viewer)} legal={[]} onAction={vi.fn()} />));
  rerender(withCatalog(<Game view={seatView(viewer, [TURN, ...events])} legal={[]} onAction={vi.fn()} />));
}

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

/** Every attribute value under `root` but `aria-hidden`'s: where an id or a def id would show. */
function attributeValues(root: Element): string[] {
  return [root, ...root.querySelectorAll("*")].flatMap((el) =>
    [...el.attributes].filter((attr) => attr.name !== "aria-hidden").map((attr) => attr.value),
  );
}

function inFlight(): string | null {
  return screen.queryByTestId("animation-queue")?.getAttribute("data-animating") ?? null;
}

function clearStorage(): void {
  try {
    window.localStorage.clear();
  } catch {
    // Storage is optional.
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  clearStorage();
  resetFxSettingsForTests();
  __resetSettingsForTests();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  setReducedMotion(false);
  clearStorage();
  resetFxSettingsForTests();
  __resetSettingsForTests();
});

const fatigue = (player: "p1" | "p2", count: number): GameEvent => ({ type: "fatigue", player, count, amount: count });
const hit = (player: "p1" | "p2", amount: number): GameEvent => ({
  type: "damage",
  sourceId: null,
  targetId: `hero-${player}`,
  amount,
  combat: false,
});

describe("R318 the animation table's three rows", () => {
  it("R318 fatigue runs 600 ms, a full library 500 and a burn 700, on the owner's library pile or hand from either seat", () => {
    expect(ANIMATIONS.fatigue.durationMs).toBe(600);
    expect(ANIMATIONS.libraryOverflow.durationMs).toBe(500);
    expect(ANIMATIONS.burned.durationMs).toBe(700);
    expect(ANIMATIONS.fatigue.fx).toEqual({ recipe: "fatigue" });
    expect(ANIMATIONS.libraryOverflow.fx).toEqual({ recipe: "overflow" });
    expect(ANIMATIONS.burned.fx).toEqual({ recipe: "burn" });

    for (const viewer of ["p1", "p2"] as const) {
      const view = seatView(viewer);
      for (const owner of ["p1", "p2"] as const) {
        const side = owner === viewer ? "you" : "opponent";
        expect(targetFor(fatigue(owner, 1), view), `${viewer} sees ${owner}'s fatigue`).toBe(`library-${side}`);
        expect(
          targetFor({ type: "libraryOverflow", player: owner, instanceId: HIDDEN_ID, defId: HIDDEN_ID, outcome: "notCreated" }, view),
          `${viewer} sees ${owner}'s full library`,
        ).toBe(`library-${side}`);
        expect(
          targetFor({ type: "burned", instanceId: "c9", defId: SHEEPISH, owner }, view),
          `${viewer} sees ${owner}'s burn`,
        ).toBe(`hand-${side}`);
      }
    }
  });
});

describe("R318 fatigue on the library pile", () => {
  for (const viewer of ["p1", "p2"] as const) {
    const side = viewer === "p1" ? "you" : "opponent";
    it(`R318 p1's third fatigue draw, seen by ${viewer}: the pile shakes under "Fatigue 3", and the badge stays up while the hit lands`, () => {
      play(viewer, [fatigue("p1", 3), hit("p1", 3)]);

      const pile = screen.getByTestId(animTestid.library(side));
      expect(pile).toHaveAttribute("data-animating", "fatigue");
      const notice = within(pile).getByTestId(noticeTestid.pile(side));
      expect(notice).toHaveClass("pile-notice");
      expect(notice).toHaveAttribute("data-kind", "fatigue");
      expect(notice).toHaveTextContent(/^Fatigue 3$/);
      expect(notice).toHaveAttribute("data-playing", "true");
      expect(notice, "a notice carries no data-animating of its own (R200)").not.toHaveAttribute("data-animating");
      expect(notice.querySelector("[data-animating]")).toBeNull();
      // The other seat's pile has nothing to say.
      expect(screen.queryByTestId(noticeTestid.pile(side === "you" ? "opponent" : "you"))).toBeNull();

      // The hit lands on the hero with its number; the badge rests on the pile meanwhile.
      advance(ANIMATIONS.fatigue.durationMs);
      expect(inFlight()).toBe("damage");
      expect(screen.getByTestId(testid.hero(side))).toHaveAttribute("data-animating", "damage");
      expect(screen.getByTestId(testid.hero(side)).querySelector(".damage-pop")).toHaveTextContent("3");
      expect(pile).not.toHaveAttribute("data-animating");
      expect(screen.getByTestId(noticeTestid.pile(side))).toHaveTextContent(/^Fatigue 3$/);
      expect(screen.getByTestId(noticeTestid.pile(side))).not.toHaveAttribute("data-playing");

      // The board catches up: the notice goes with the burst.
      advance(ANIMATIONS.damage.durationMs);
      expect(inFlight()).toBeNull();
      expect(screen.queryByTestId(noticeTestid.pile(side))).toBeNull();
    });
  }

  it("R318 a hit Armor took whole still shows the badge, and R240's zero hit on the hero", () => {
    play("p1", [fatigue("p1", 2), hit("p1", 0)]);
    expect(screen.getByTestId(noticeTestid.pile("you"))).toHaveTextContent(/^Fatigue 2$/);
    advance(ANIMATIONS.fatigue.durationMs);
    expect(screen.getByTestId(testid.hero("you"))).toHaveAttribute("data-animating", "damage");
    expect(screen.getByTestId(testid.hero("you")).querySelector(".damage-pop"), "R240's hit of 0 pops as any 0 hit").toHaveTextContent(/^0$/);
    expect(screen.getByTestId(noticeTestid.pile("you"))).toHaveTextContent(/^Fatigue 2$/);
  });

  it("R318 two fatigue draws in one burst: the newest started wins, and data-playing follows its own entry", () => {
    play("p1", [fatigue("p1", 1), hit("p1", 1), fatigue("p1", 2), hit("p1", 2)]);
    expect(screen.getByTestId(noticeTestid.pile("you"))).toHaveTextContent(/^Fatigue 1$/);
    expect(screen.getByTestId(noticeTestid.pile("you"))).toHaveAttribute("data-playing", "true");

    advance(ANIMATIONS.fatigue.durationMs);
    expect(screen.getByTestId(noticeTestid.pile("you"))).toHaveTextContent(/^Fatigue 1$/);
    expect(screen.getByTestId(noticeTestid.pile("you"))).not.toHaveAttribute("data-playing");

    advance(ANIMATIONS.damage.durationMs);
    expect(inFlight()).toBe("fatigue");
    expect(screen.getAllByTestId(noticeTestid.pile("you"))).toHaveLength(1);
    expect(screen.getByTestId(noticeTestid.pile("you"))).toHaveTextContent(/^Fatigue 2$/);
    expect(screen.getByTestId(noticeTestid.pile("you"))).toHaveAttribute("data-playing", "true");
  });
});

describe("R318 a full library on the library pile", () => {
  for (const viewer of ["p1", "p2"] as const) {
    const side = viewer === "p1" ? "you" : "opponent";
    it(`R318 a copy p1's full library never created, seen by ${viewer}: "Library full" and the card's face`, () => {
      play(viewer, [{ type: "libraryOverflow", player: "p1", instanceId: "c80", defId: PANTHER, outcome: "notCreated" }]);

      const pile = screen.getByTestId(animTestid.library(side));
      expect(pile).toHaveAttribute("data-animating", "libraryOverflow");
      const notice = within(pile).getByTestId(noticeTestid.pile(side));
      expect(notice).toHaveAttribute("data-kind", "libraryFull");
      expect(notice).toHaveAttribute("data-playing", "true");
      expect(notice).toHaveTextContent("Library full");
      expect(notice).not.toHaveAttribute("data-animating");
      const refused = within(notice).getByTestId(noticeTestid.overflowCard(side));
      expect(refused).toHaveClass("overflow-card");
      expect(refused).toHaveAttribute("data-face", "face");
      expect(refused).toHaveAttribute("data-outcome", "notCreated");
      expect(refused).toHaveTextContent(nameOf(PANTHER));

      advance(ANIMATIONS.libraryOverflow.durationMs);
      expect(screen.queryByTestId(noticeTestid.pile(side))).toBeNull();
    });
  }

  it("R318 an existing card sent to the graveyard drops toward it, and the notice rests through its enteredGraveyard", () => {
    play("p2", [
      { type: "libraryOverflow", player: "p2", instanceId: "c81", defId: VIRUS, outcome: "graveyard" },
      { type: "enteredGraveyard", instanceId: "c81", defId: VIRUS, owner: "p2" },
    ]);
    const refused = screen.getByTestId(noticeTestid.overflowCard("you"));
    expect(refused).toHaveAttribute("data-outcome", "graveyard");
    expect(refused).toHaveAttribute("data-face", "face");
    expect(refused).toHaveTextContent(nameOf(VIRUS));

    advance(ANIMATIONS.libraryOverflow.durationMs);
    expect(inFlight()).toBe("enteredGraveyard");
    expect(screen.getByTestId(noticeTestid.pile("you"))).not.toHaveAttribute("data-playing");
    expect(screen.getByTestId(noticeTestid.pile("you"))).toHaveTextContent("Library full");
  });

  it("R318 a card the viewer may not read (R97's sentinel) is a back, and the notice names nothing", () => {
    play("p1", [{ type: "libraryOverflow", player: "p2", instanceId: HIDDEN_ID, defId: HIDDEN_ID, outcome: "notCreated" }]);
    const notice = screen.getByTestId(noticeTestid.pile("opponent"));
    const refused = within(notice).getByTestId(noticeTestid.overflowCard("opponent"));
    expect(refused).toHaveAttribute("data-face", "back");
    expect(refused.textContent, "a back draws no text at all").toBe("");
    expect(refused.querySelector(".cf-back")).not.toBeNull();
    expect(notice.textContent).toBe("Library full");
    expect(attributeValues(notice)).not.toContain(HIDDEN_ID);
  });

  it("R318 three refusals in a row (#33's three copies) are three notices, each playing its own motion", () => {
    const refusal = (id: string): GameEvent => ({ type: "libraryOverflow", player: "p1", instanceId: id, defId: PANTHER, outcome: "notCreated" });
    play("p1", [refusal("c90"), refusal("c91"), refusal("c92")]);
    const seen: Element[] = [];
    for (let k = 0; k < 3; k += 1) {
      const notice = screen.getByTestId(noticeTestid.pile("you"));
      expect(notice, `refusal ${String(k + 1)}`).toHaveAttribute("data-playing", "true");
      // A fresh element for each entry, so its CSS animations start again rather than holding their
      // end frame, where the refused card is gone.
      expect(seen, `refusal ${String(k + 1)} is a new notice`).not.toContain(notice);
      seen.push(notice);
      advance(ANIMATIONS.libraryOverflow.durationMs);
    }
    expect(screen.queryByTestId(noticeTestid.pile("you"))).toBeNull();
  });

  it("R318 a refused Radiant copy shows the Radiant face it would have had", () => {
    play("p1", [{ type: "libraryOverflow", player: "p1", instanceId: "c93", defId: PANTHER, outcome: "notCreated", radiant: true }]);
    const refused = screen.getByTestId(noticeTestid.overflowCard("you"));
    expect(refused.querySelector("[data-radiant-face='true']"), "the face is the Radiant one").not.toBeNull();
    cleanup();
    play("p1", [{ type: "libraryOverflow", player: "p1", instanceId: "c94", defId: PANTHER, outcome: "notCreated" }]);
    expect(screen.getByTestId(noticeTestid.overflowCard("you")).querySelector("[data-radiant-face='true']")).toBeNull();
  });

  it("R318 a ceased unit-token card fizzles like a copy that was never made", () => {
    play("p1", [{ type: "libraryOverflow", player: "p1", instanceId: "c82", defId: "core-t-sheep", outcome: "ceased" }]);
    expect(screen.getByTestId(noticeTestid.overflowCard("you"))).toHaveAttribute("data-outcome", "ceased");
    expect(screen.getByTestId(noticeTestid.overflowCard("you"))).toHaveTextContent(nameOf("core-t-sheep"));
  });

  it("R318 a fatigue then a refusal on one pile: the newest started wins", () => {
    play("p1", [fatigue("p1", 1), { type: "libraryOverflow", player: "p1", instanceId: "c83", defId: PANTHER, outcome: "notCreated" }]);
    expect(screen.getByTestId(noticeTestid.pile("you"))).toHaveAttribute("data-kind", "fatigue");
    advance(ANIMATIONS.fatigue.durationMs);
    expect(screen.getAllByTestId(noticeTestid.pile("you"))).toHaveLength(1);
    expect(screen.getByTestId(noticeTestid.pile("you"))).toHaveAttribute("data-kind", "libraryFull");
  });
});

describe("R318 a full hand over the hand", () => {
  const burn = (owner: "p1" | "p2", defId: string, instanceId = "c90"): GameEvent[] => [
    { type: "drawn", player: owner, instanceId, defId },
    { type: "burned", instanceId, defId, owner },
    { type: "enteredGraveyard", instanceId, defId, owner },
  ];

  for (const viewer of ["p1", "p2"] as const) {
    const side = viewer === "p1" ? "you" : "opponent";
    it(`R318 p1's burned draw, seen by ${viewer}: "Hand full" over p1's hand and the card's name`, () => {
      play(viewer, burn("p1", SHEEPISH));
      expect(screen.queryByTestId(noticeTestid.burn(side)), "nothing before the burn's own entry starts").toBeNull();

      advance(ANIMATIONS.drawn.durationMs);
      expect(inFlight()).toBe("burned");
      const hand = screen.getByTestId(animTestid.hand(side));
      const notice = within(hand).getByTestId(noticeTestid.burn(side));
      expect(notice).toHaveClass("burn-notice");
      expect(notice.tagName).toBe("DIV");
      expect(notice).toHaveAttribute("data-playing", "true");
      expect(notice).not.toHaveAttribute("data-animating");
      expect(hand, "the hand region itself never takes data-animating").not.toHaveAttribute("data-animating");
      expect(notice.querySelector(".burn-tag")).toHaveTextContent(/^Hand full$/);
      const burned = within(notice).getByTestId(noticeTestid.burnCard(side));
      expect(burned).toHaveClass("burn-card");
      expect(burned).toHaveAttribute("data-face", "face");
      expect(burned).toHaveTextContent(nameOf(SHEEPISH));
      // The hand's own count and cards are untouched: the notice is drawn over them.
      expect(screen.getByTestId(`hand-count-${side}`)).toHaveTextContent(side === "you" ? "0" : "4");

      advance(ANIMATIONS.burned.durationMs);
      expect(inFlight()).toBe("enteredGraveyard");
      expect(screen.getByTestId(noticeTestid.burn(side))).not.toHaveAttribute("data-playing");
      advance(ANIMATIONS.enteredGraveyard.durationMs);
      expect(screen.queryByTestId(noticeTestid.burn(side))).toBeNull();
    });
  }

  it("R318 a burned card the viewer may not read is a back over the opponent's hand, named nowhere", () => {
    play("p1", [
      { type: "drawn", player: "p2", instanceId: HIDDEN_ID, defId: HIDDEN_ID },
      { type: "burned", instanceId: HIDDEN_ID, defId: HIDDEN_ID, owner: "p2" },
    ]);
    advance(ANIMATIONS.drawn.durationMs);
    const notice = within(screen.getByTestId(animTestid.hand("opponent"))).getByTestId(noticeTestid.burn("opponent"));
    const burned = within(notice).getByTestId(noticeTestid.burnCard("opponent"));
    expect(burned).toHaveAttribute("data-face", "back");
    expect(burned.textContent).toBe("");
    expect(notice.textContent).toBe("Hand full");
    expect(attributeValues(notice)).not.toContain(HIDDEN_ID);
  });

  it("R318 notices on both seats' piles and hands at once, each on its own side", () => {
    play("p1", [
      { type: "burned", instanceId: "c91", defId: SHEEPISH, owner: "p1" },
      fatigue("p2", 4),
    ]);
    expect(screen.getByTestId(noticeTestid.burn("you"))).toBeInTheDocument();
    advance(ANIMATIONS.burned.durationMs);
    expect(screen.getByTestId(noticeTestid.burn("you"))).not.toHaveAttribute("data-playing");
    expect(within(screen.getByTestId(animTestid.library("opponent"))).getByTestId(noticeTestid.pile("opponent"))).toHaveTextContent(
      /^Fatigue 4$/,
    );
    expect(screen.queryByTestId(noticeTestid.pile("you"))).toBeNull();
    expect(screen.queryByTestId(noticeTestid.burn("opponent"))).toBeNull();
  });
});

describe("R318 the settings", () => {
  const BURST: GameEvent[] = [
    fatigue("p1", 1),
    hit("p1", 1),
    { type: "libraryOverflow", player: "p2", instanceId: "c84", defId: PANTHER, outcome: "notCreated" },
    { type: "burned", instanceId: "c85", defId: SHEEPISH, owner: "p1" },
  ];

  function expectNothingMounted(): void {
    expect(inFlight()).toBeNull();
    for (const side of ["you", "opponent"] as const) {
      expect(screen.queryByTestId(noticeTestid.pile(side))).toBeNull();
      expect(screen.queryByTestId(noticeTestid.burn(side))).toBeNull();
    }
  }

  it("R318 the settings panel's Reduce motion starts no entry, so nothing mounts", () => {
    writeSettings({ reduceMotion: true });
    play("p1", BURST);
    expectNothingMounted();
  });

  it("R318 prefers-reduced-motion starts no entry, so nothing mounts", () => {
    setReducedMotion(true);
    play("p1", BURST);
    expectNothingMounted();
  });

  it("R318 the effects store's reduce setting does the same", () => {
    setFxSettings({ motion: "reduce" });
    play("p1", BURST);
    expectNothingMounted();
  });

  it("R318 the effects speed scales the notices' entries (R201): twice as fast, half as long", () => {
    setFxSettings({ speed: 2 });
    play("p1", [fatigue("p1", 1), hit("p1", 1)]);
    const half = Math.max(MIN_ENTRY_MS, ANIMATIONS.fatigue.durationMs / 2);
    advance(half - 1);
    expect(inFlight()).toBe("fatigue");
    expect(screen.getByTestId(noticeTestid.pile("you"))).toHaveAttribute("data-playing", "true");
    advance(1);
    expect(inFlight()).toBe("damage");
    expect(screen.getByTestId(noticeTestid.pile("you"))).not.toHaveAttribute("data-playing");
  });

  it("R318 and half as fast, twice as long", () => {
    setFxSettings({ speed: 0.5 });
    play("p1", [
      { type: "burned", instanceId: "c86", defId: SHEEPISH, owner: "p1" },
      { type: "enteredGraveyard", instanceId: "c86", defId: SHEEPISH, owner: "p1" },
    ]);
    advance(ANIMATIONS.burned.durationMs * 2 - 1);
    expect(inFlight()).toBe("burned");
    expect(screen.getByTestId(noticeTestid.burn("you"))).toHaveAttribute("data-playing", "true");
    advance(1);
    expect(inFlight()).toBe("enteredGraveyard");
  });
});

describe("R318 a board handed only what is animating", () => {
  it("R318 draws the notice from the view's own events, as the number pops fall back to", () => {
    const view = seatView("p1", [TURN, fatigue("p2", 2)]);
    render(withCatalog(<Board view={view} animating={new Map([[animTestid.library("opponent"), "fatigue"]])} />));
    const notice = screen.getByTestId(noticeTestid.pile("opponent"));
    expect(notice).toHaveTextContent(/^Fatigue 2$/);
    expect(notice).toHaveAttribute("data-playing", "true");
  });

  it("R318 and nothing at all when nothing is animating", () => {
    render(withCatalog(<Board view={seatView("p1", [TURN, fatigue("p2", 2)])} />));
    expect(screen.queryByTestId(noticeTestid.pile("opponent"))).toBeNull();
  });
});

describe("R318 the log says each overflow in words", () => {
  function lines(view: PlayerView): string[] {
    render(withCatalog(<Log view={view} />));
    return [...screen.getByTestId(testid.log).querySelectorAll(".log-line")].map((li) => li.textContent ?? "");
  }

  it("R318 names the card only where the viewer reads it, and each outcome in its own words", () => {
    expect(
      lines(
        seatView("p1", [
          fatigue("p1", 3),
          fatigue("p2", 1),
          { type: "libraryOverflow", player: "p1", instanceId: "c1", defId: VIRUS, outcome: "notCreated" },
          { type: "libraryOverflow", player: "p2", instanceId: "c2", defId: PANTHER, outcome: "graveyard" },
          { type: "libraryOverflow", player: "p1", instanceId: "c3", defId: "core-t-sheep", outcome: "ceased" },
          { type: "libraryOverflow", player: "p2", instanceId: HIDDEN_ID, defId: HIDDEN_ID, outcome: "notCreated" },
          { type: "burned", instanceId: "c4", defId: SHEEPISH, owner: "p1" },
          { type: "burned", instanceId: HIDDEN_ID, defId: HIDDEN_ID, owner: "p2" },
        ]),
      ),
    ).toEqual([
      "Your library is empty: fatigue 3",
      "The opponent's library is empty: fatigue 1",
      `Your library is full: ${nameOf(VIRUS)} was not created`,
      `The opponent's library is full: ${nameOf(PANTHER)} went to the graveyard`,
      `Your library is full: ${nameOf("core-t-sheep")} ceased to exist`,
      "The opponent's library is full: a card was not created",
      `Your hand is full: ${nameOf(SHEEPISH)} burned`,
      "The opponent's hand is full: a card burned",
    ]);
  });
});

describe("R318 the stylesheets", () => {
  function sheet(fromWeb: string): string {
    for (const candidate of [fromWeb, `apps/web/${fromWeb}`]) {
      const path = resolve(process.cwd(), candidate);
      if (existsSync(path)) return readFileSync(path, "utf8");
    }
    throw new Error(`${fromWeb} not found from ${process.cwd()}`);
  }

  function block(css: string, selector: string): string {
    const at = css.indexOf(`${selector} {`);
    expect(at, `a rule for ${selector}`).toBeGreaterThanOrEqual(0);
    return css.slice(at, css.indexOf("}", at));
  }

  it("R318 the notices float over the board out of flow and never take a pointer event", () => {
    const css = sheet("src/game/overflow.css");
    for (const selector of [".pile > .pile-notice", ".hand > .burn-notice"]) {
      const rule = block(css, selector);
      expect(rule).toMatch(/position:\s*absolute/);
      expect(rule).toMatch(/pointer-events:\s*none/);
      expect(rule).toMatch(/z-index:\s*\d+/);
    }
  });

  it("R318 each row's motion follows the squeeze and stops under reduced motion", () => {
    const css = sheet("src/game/animations.css");
    for (const type of ["fatigue", "libraryOverflow", "burned"] as const) {
      expect(css).toContain(`@keyframes ${ANIMATIONS[type].animation}`);
      expect(css).toContain(`calc(${String(ANIMATIONS[type].durationMs)}ms * var(--anim-scale) * var(--anim-squeeze, 1))`);
    }
    const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    for (const part of [".pile-notice-tag", ".overflow-card", ".burn-tag", ".burn-card"]) expect(reduced).toContain(part);
    // The hand region never animates as a whole: the burn plays on the notice inside it.
    expect(css).not.toContain('[data-animating="burned"]');
  });
});
