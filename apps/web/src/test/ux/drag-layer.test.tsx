// Polish task 7, B36 to B39 and B42 (docs/polish/7-mobile-ux.md, Surface S9 and S10): drag to play,
// driven through `<Game/>` exactly as a player's pointer drives it.
//
// jsdom has no layout, so it has no `document.elementsFromPoint` either. Each test stubs it to
// return whatever element the pointer is "over" (`over(...)`), and deletes the stub afterwards. The
// press goes to the element, as a real `pointerdown` does; the moves and the release go to
// `window`, where the DragLayer listens. `isPrimary` and `pointerType` are left at jsdom's defaults
// on purpose: S9 says the layer must not need them.
//
// Every expected action is a body the fixture's `legal` array lists, and the tests that say "the
// same action click-click sends" record click-click in a render of its own and compare.

import type { ActionBody, PlayerView } from "@jackioh/shared";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import Game from "../../game/Game.tsx";
import { DRAG_THRESHOLD_PX } from "../../game/drag/model.ts";
import { __resetSettingsForTests, writeSettings } from "../../settings/index.ts";
import { baseView, card, emptySide, unit } from "../fixtures.ts";

// ---------------------------------------------------------------------------------------------
// The fixture.
// ---------------------------------------------------------------------------------------------

/**
 * h1 is a unit that may go into your units lane 3 or 4, s1 is a spell with a single candidate,
 * n1 is a card nothing lets you play. u1 may attack e1 or the enemy hero; u2 may only switch.
 */
function dragView(): PlayerView {
  return baseView({
    you: emptySide("p1", {
      hand: [
        card({ instanceId: "h1", defId: "core-008", cost: 3 }),
        card({ instanceId: "s1", defId: "core-005", cost: 1 }),
        card({ instanceId: "n1", defId: "core-019", cost: 2 }),
      ],
      units: [unit("p1", { instanceId: "u1" }), unit("p1", { instanceId: "u2" }), null, null, null],
    }),
    opponent: emptySide("p2", {
      hand: { count: 3 },
      units: [unit("p2", { instanceId: "e1" }), null, null, null, null],
    }),
  });
}

const H1_LANE3: ActionBody = { type: "play", instanceId: "h1", zone: { row: "units", lane: 3 } };
const H1_LANE4: ActionBody = { type: "play", instanceId: "h1", zone: { row: "units", lane: 4 } };
const S1_PLAY: ActionBody = { type: "play", instanceId: "s1" };
const U1_E1: ActionBody = { type: "attack", attackerId: "u1", targetId: "e1" };
const U1_HERO: ActionBody = { type: "attack", attackerId: "u1", targetId: "hero-p2" };

const LEGAL: readonly ActionBody[] = [
  H1_LANE3,
  H1_LANE4,
  S1_PLAY,
  U1_E1,
  U1_HERO,
  { type: "switchPosition", instanceId: "u2" },
  { type: "endTurn" },
  { type: "offerDraw" },
  { type: "concede" },
];

function renderGame(onAction = vi.fn()) {
  const utils = render(<Game view={dragView()} legal={LEGAL} onAction={onAction} />);
  return { ...utils, onAction };
}

const el = (testid: string): HTMLElement => screen.getByTestId(testid);

// ---------------------------------------------------------------------------------------------
// The pointer.
// ---------------------------------------------------------------------------------------------

const POINTER = 1;
/** Where every press starts. The source element is what matters; the numbers only set distance. */
const START = { x: 200, y: 400 };

/** What `document.elementsFromPoint` answers, topmost first. */
let under: Element[] = [];

function over(...stack: Element[]): void {
  under = stack;
}

function press(target: Element, options: { button?: number; pointerId?: number } = {}): void {
  fireEvent.pointerDown(target, {
    pointerId: options.pointerId ?? POINTER,
    button: options.button ?? 0,
    clientX: START.x,
    clientY: START.y,
  });
}

function move(x: number, y: number, pointerId = POINTER): void {
  fireEvent.pointerMove(window, { pointerId, clientX: x, clientY: y });
}

function release(x = START.x, y = START.y): void {
  fireEvent.pointerUp(window, { pointerId: POINTER, button: 0, clientX: x, clientY: y });
}

/** Press the source and move it straight up past the threshold: the drag is now in flight. */
function lift(source: Element): void {
  over(source);
  press(source);
  move(START.x, START.y - 20);
}

function expectNoDrag(): void {
  expect(screen.queryByTestId("drag-layer")).toBeNull();
  expect(screen.queryByTestId("drag-ghost")).toBeNull();
  expect(screen.queryByTestId("drag-arrow")).toBeNull();
  expect(screen.queryByTestId("drag-reticle")).toBeNull();
  expect(document.documentElement).not.toHaveAttribute("data-dragging");
}

/** Idle as the board shows it: nothing selected, h1's zones neither glowing nor clickable. */
function expectBoardIdle(): void {
  expect(el("hand-card-h1")).not.toHaveAttribute("data-selected");
  expect(el("card-u1")).not.toHaveAttribute("data-selected");
  for (const zone of ["zone-you-units-3", "zone-you-units-4"]) {
    expect(el(zone)).not.toHaveAttribute("data-glow");
    expect(el(zone)).toHaveAttribute("data-legal", "false");
  }
  expect(el("hero-opponent")).not.toHaveAttribute("data-glow");
  // No zone picker is open, which it would be for a lifted h1.
  expect(screen.queryByTestId("prompt-modal")).toBeNull();
}

beforeEach(() => {
  under = [];
  document.elementsFromPoint = (() => under) as Document["elementsFromPoint"];
});

afterEach(() => {
  cleanup();
  delete (document as Partial<Document>).elementsFromPoint;
  // Isolation only: a leak from one test must not fail the next one for the wrong reason.
  document.documentElement.removeAttribute("data-dragging");
  localStorage.clear();
  __resetSettingsForTests();
});

// ---------------------------------------------------------------------------------------------
// B36: dragging a hand card onto a zone
// ---------------------------------------------------------------------------------------------

describe("B36 dragging a hand card onto a glowing zone plays it", () => {
  it("B36 a press on a legal hand card and an 8 px move lift it: its zones glow, the ghost shows, <html data-dragging=play>", () => {
    const { onAction } = renderGame();
    const source = el("hand-card-h1");

    over(source);
    press(source);
    move(START.x, START.y - DRAG_THRESHOLD_PX);

    expect(el("zone-you-units-3")).toHaveAttribute("data-glow", "ready");
    expect(el("zone-you-units-4")).toHaveAttribute("data-glow", "ready");
    // Only h1's candidates glow: an empty zone it cannot go into does not.
    expect(el("zone-you-units-5")).not.toHaveAttribute("data-glow");

    expect(el("drag-layer")).toHaveAttribute("data-kind", "play");
    expect(el("drag-ghost")).toHaveAttribute("data-instance-id", "h1");
    expect(screen.queryByTestId("drag-arrow")).toBeNull();
    expect(document.documentElement).toHaveAttribute("data-dragging", "play");
    expect(onAction).not.toHaveBeenCalled();
  });

  it("B36 the ghost shows the card's name and cost, and nothing in the overlay carries a card testid", () => {
    renderGame();
    lift(el("hand-card-h1"));

    // No catalog is mounted, so `useCardInfo` names the card by its def id (catalog.ts).
    expect(el("drag-ghost")).toHaveTextContent("core-008");
    expect(el("drag-ghost")).toHaveTextContent("3");
    const layer = el("drag-layer");
    expect(within(layer).queryAllByTestId(/^(hand-)?card-/)).toHaveLength(0);
  });

  it("B36 hovering a glowing zone puts the reticle on it", () => {
    renderGame();
    lift(el("hand-card-h1"));

    over(el("zone-you-units-4"));
    move(420, 180);

    expect(el("drag-reticle")).toHaveAttribute("data-target", "zone-you-units-4");
  });

  it("B36 releasing over a glowing zone sends the same play click-click sends", () => {
    const clicks = renderGame();
    fireEvent.click(el("hand-card-h1"));
    fireEvent.click(el("zone-you-units-4"));
    expect(clicks.onAction).toHaveBeenCalledTimes(1);
    const clickClick = clicks.onAction.mock.calls[0]?.[0] as ActionBody;
    clicks.unmount();

    const { onAction } = renderGame();
    lift(el("hand-card-h1"));
    over(el("zone-you-units-4"));
    move(420, 180);
    release(420, 180);

    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction).toHaveBeenCalledWith(clickClick);
    expect(onAction).toHaveBeenCalledWith(H1_LANE4);
    expectNoDrag();
  });

  it("B36 a one-candidate spell sends nothing while lifted, and is played when released over the board", () => {
    const { onAction } = renderGame();
    lift(el("hand-card-s1"));

    expect(el("drag-layer")).toHaveAttribute("data-kind", "play");
    expect(onAction).not.toHaveBeenCalled();

    over(el("board"));
    move(420, 180);
    release(420, 180);

    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction).toHaveBeenCalledWith(S1_PLAY);
    expectNoDrag();
  });

  it("B36 a press with a button other than the primary one starts no drag", () => {
    const { onAction } = renderGame();
    const source = el("hand-card-h1");

    over(source);
    press(source, { button: 2 });
    move(START.x, START.y - 40);

    expectNoDrag();
    expect(el("zone-you-units-4")).not.toHaveAttribute("data-glow");
    expect(onAction).not.toHaveBeenCalled();
  });

  it("B36 a move by a different pointer does not start the press's drag", () => {
    renderGame();
    const source = el("hand-card-h1");

    over(source);
    press(source);
    move(START.x, START.y - 40, POINTER + 1);

    expectNoDrag();
  });
});

// ---------------------------------------------------------------------------------------------
// B37: dragging an attacker onto the enemy hero
// ---------------------------------------------------------------------------------------------

describe("B37 dragging an attacker shows the arrow and attacks where it is released", () => {
  it("B37 an attacker lifted past the threshold shows the arrow from its card and no ghost", () => {
    const { onAction } = renderGame();
    lift(el("card-u1"));

    expect(el("drag-layer")).toHaveAttribute("data-kind", "attack");
    expect(el("drag-arrow")).toHaveAttribute("data-from", "card-u1");
    expect(screen.queryByTestId("drag-ghost")).toBeNull();
    expect(document.documentElement).toHaveAttribute("data-dragging", "attack");
    // Its targets glow.
    expect(el("hero-opponent")).toHaveAttribute("data-glow", "ready");
    expect(el("card-e1")).toHaveAttribute("data-glow", "ready");
    expect(onAction).not.toHaveBeenCalled();
  });

  it("B37 hovering the glowing enemy hero shows the reticle on it and marks the arrow valid", () => {
    renderGame();
    lift(el("card-u1"));

    // Something inside the hero panel, as a real hit test returns: the hero is its nearest testid.
    const hero = el("hero-opponent");
    over(hero.firstElementChild ?? hero, hero);
    move(600, 60);

    expect(el("drag-reticle")).toHaveAttribute("data-target", "hero-opponent");
    expect(el("drag-arrow")).toHaveAttribute("data-valid", "true");
  });

  it("B37 releasing on the enemy hero sends the same attack click-click sends", () => {
    const clicks = renderGame();
    fireEvent.click(el("card-u1"));
    fireEvent.click(el("hero-opponent"));
    expect(clicks.onAction).toHaveBeenCalledTimes(1);
    const clickClick = clicks.onAction.mock.calls[0]?.[0] as ActionBody;
    clicks.unmount();

    const { onAction } = renderGame();
    lift(el("card-u1"));
    over(el("hero-opponent"));
    move(600, 60);
    release(600, 60);

    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction).toHaveBeenCalledWith(clickClick);
    expect(onAction).toHaveBeenCalledWith(U1_HERO);
    expectNoDrag();
  });

  it("B37 hovering something that is not a target shows no reticle and an invalid arrow", () => {
    renderGame();
    lift(el("card-u1"));

    over(el("hero-you"));
    move(600, 700);
    expect(screen.queryByTestId("drag-reticle")).toBeNull();
    expect(el("drag-arrow")).toHaveAttribute("data-valid", "false");

    over(el("zone-you-units-4"));
    move(420, 500);
    expect(screen.queryByTestId("drag-reticle")).toBeNull();
    expect(el("drag-arrow")).toHaveAttribute("data-valid", "false");
  });

  it("B37 an enemy unit is not a drag source", () => {
    renderGame();
    lift(el("card-e1"));

    expectNoDrag();
  });
});

// ---------------------------------------------------------------------------------------------
// B38: every way a drag is cancelled
// ---------------------------------------------------------------------------------------------

describe("B38 a cancelled drag goes back to idle, sends nothing, and swallows the click after the release", () => {
  const CANCELS: [string, () => void][] = [
    ["Escape", () => fireEvent.keyDown(window, { key: "Escape" })],
    ["contextmenu", () => fireEvent.contextMenu(el("board"))],
    ["pointercancel", () => fireEvent.pointerCancel(window, { pointerId: POINTER })],
  ];

  it.each(CANCELS)("B38 %s during a card drag cancels it", (_name, cancel) => {
    const { onAction } = renderGame();
    const source = el("hand-card-h1");
    lift(source);
    expect(el("drag-layer")).toBeInTheDocument();

    cancel();

    expectNoDrag();
    expectBoardIdle();
    expect(onAction).not.toHaveBeenCalled();

    release();
    fireEvent.click(source);

    // The click was swallowed: had it reached the board, h1 would now be selected.
    expect(source).not.toHaveAttribute("data-selected");
    expect(el("zone-you-units-4")).toHaveAttribute("data-legal", "false");
    expect(onAction).not.toHaveBeenCalled();
  });

  it.each(CANCELS)("B38 %s during an attacker drag cancels it", (_name, cancel) => {
    const { onAction } = renderGame();
    const source = el("card-u1");
    lift(source);
    expect(el("drag-arrow")).toBeInTheDocument();

    cancel();

    expectNoDrag();
    expectBoardIdle();

    release();
    fireEvent.click(source);

    expect(source).not.toHaveAttribute("data-selected");
    expect(onAction).not.toHaveBeenCalled();
  });

  it.each(CANCELS)("B38 after %s, releasing over what was a glowing zone still sends nothing", (_name, cancel) => {
    const { onAction } = renderGame();
    lift(el("hand-card-h1"));
    over(el("zone-you-units-4"));
    move(420, 180);
    expect(el("drag-reticle")).toHaveAttribute("data-target", "zone-you-units-4");

    cancel();
    release(420, 180);

    expect(onAction).not.toHaveBeenCalled();
    expectNoDrag();
    expectBoardIdle();
  });

  it("B38 contextmenu during a drag also keeps the browser's menu away", () => {
    renderGame();
    lift(el("hand-card-h1"));

    const notPrevented = fireEvent.contextMenu(el("board"));

    expect(notPrevented).toBe(false);
  });

  it("B38 releasing a card with two open zones over the board, on no drop target, cancels", () => {
    const { onAction } = renderGame();
    const source = el("hand-card-h1");
    lift(source);

    over(el("board"));
    move(420, 180);
    release(420, 180);

    expectNoDrag();
    expectBoardIdle();
    expect(onAction).not.toHaveBeenCalled();

    fireEvent.click(source);
    expect(source).not.toHaveAttribute("data-selected");
    expect(onAction).not.toHaveBeenCalled();
  });

  it("B38 releasing over a zone that does not glow cancels", () => {
    const { onAction } = renderGame();
    const source = el("hand-card-h1");
    lift(source);

    over(el("zone-you-units-5"));
    move(500, 300);
    release(500, 300);

    expectNoDrag();
    expectBoardIdle();
    expect(onAction).not.toHaveBeenCalled();

    fireEvent.click(source);
    expect(source).not.toHaveAttribute("data-selected");
  });

  it("B38 releasing back over your own hand cancels, even a spell that may drop anywhere on the board", () => {
    const { onAction } = renderGame();
    const source = el("hand-card-s1");
    lift(source);

    over(el("hand-card-n1"), el("hand-you"));
    move(260, 400);
    release(260, 400);

    expectNoDrag();
    expect(onAction).not.toHaveBeenCalled();

    fireEvent.click(source);
    expect(onAction).not.toHaveBeenCalled();
    expect(source).not.toHaveAttribute("data-selected");
  });

  it("B38 releasing an attacker on a unit that is not its target cancels", () => {
    const { onAction } = renderGame();
    const source = el("card-u1");
    lift(source);

    over(el("card-u2"));
    move(300, 500);
    release(300, 500);

    expectNoDrag();
    expectBoardIdle();
    expect(onAction).not.toHaveBeenCalled();

    fireEvent.click(source);
    expect(source).not.toHaveAttribute("data-selected");
  });
});

// ---------------------------------------------------------------------------------------------
// B39: clicks keep working
// ---------------------------------------------------------------------------------------------

describe("B39 a short press is a click, and click-click works with drag to play on or off", () => {
  it("B39 the drag threshold is 8 px", () => {
    expect(DRAG_THRESHOLD_PX).toBe(8);
  });

  it("B39 a press that moves 7 px starts no drag, and click-click then plays the card", () => {
    const { onAction } = renderGame();
    const source = el("hand-card-h1");

    over(source);
    press(source);
    move(START.x, START.y - (DRAG_THRESHOLD_PX - 1));
    expectNoDrag();
    release(START.x, START.y - (DRAG_THRESHOLD_PX - 1));
    fireEvent.click(source);

    expect(source).toHaveAttribute("data-selected", "true");
    fireEvent.click(el("zone-you-units-3"));

    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction).toHaveBeenCalledWith(H1_LANE3);
    expectNoDrag();
  });

  it("B39 a press on an attacker with no move lets click-click attack", () => {
    const { onAction } = renderGame();
    const source = el("card-u1");

    over(source);
    press(source);
    release();
    fireEvent.click(source);
    fireEvent.click(el("card-e1"));

    expect(onAction).toHaveBeenCalledTimes(1);
    expect(onAction).toHaveBeenCalledWith(U1_E1);
  });

  it("B39 with drag to play off, a long move starts no drag and a release over a zone sends nothing", () => {
    writeSettings({ dragToPlay: false });
    const { onAction } = renderGame();
    const source = el("hand-card-h1");

    over(source);
    press(source);
    move(START.x, START.y - 60);

    expectNoDrag();
    expect(el("zone-you-units-4")).not.toHaveAttribute("data-glow");

    over(el("zone-you-units-4"));
    move(420, 180);
    release(420, 180);

    expectNoDrag();
    expect(onAction).not.toHaveBeenCalled();
  });

  it("B39 with drag to play off, click-click still plays a card and attacks", () => {
    writeSettings({ dragToPlay: false });
    const { onAction } = renderGame();

    fireEvent.click(el("hand-card-h1"));
    fireEvent.click(el("zone-you-units-3"));
    fireEvent.click(el("card-u1"));
    fireEvent.click(el("hero-opponent"));

    expect(onAction).toHaveBeenCalledTimes(2);
    expect(onAction).toHaveBeenNthCalledWith(1, H1_LANE3);
    expect(onAction).toHaveBeenNthCalledWith(2, U1_HERO);
  });

  it("B39 a press on a card no play names starts no drag, however far it moves", () => {
    const { onAction } = renderGame();
    const source = el("hand-card-n1");

    over(source);
    press(source);
    move(START.x, START.y - 60);

    expectNoDrag();
    release();
    expect(onAction).not.toHaveBeenCalled();
  });

  it("B39 Escape cancels a click-selected play", () => {
    renderGame();
    fireEvent.click(el("hand-card-h1"));
    expect(el("hand-card-h1")).toHaveAttribute("data-selected", "true");
    expect(el("zone-you-units-4")).toHaveAttribute("data-legal", "true");

    fireEvent.keyDown(window, { key: "Escape" });

    expectBoardIdle();
  });

  it("B39 contextmenu cancels a click-selected attack and keeps the browser's menu away", () => {
    renderGame();
    fireEvent.click(el("card-u1"));
    expect(el("card-u1")).toHaveAttribute("data-selected", "true");

    const notPrevented = fireEvent.contextMenu(el("board"));

    expect(notPrevented).toBe(false);
    expectBoardIdle();
  });

  it("B39 contextmenu with nothing selected is left to the browser", () => {
    renderGame();

    const notPrevented = fireEvent.contextMenu(el("board"));

    expect(notPrevented).toBe(true);
    expectBoardIdle();
  });

  it("B39 the click swallow after a drag is disarmed by the next press, so the next click goes through", () => {
    const { onAction } = renderGame();
    const source = el("hand-card-h1");

    // A drag released on no drop target, with no click after it.
    lift(source);
    over(el("board"));
    release(420, 180);
    expectNoDrag();

    // A fresh tap: press, no move, release, click.
    over(source);
    press(source);
    release();
    fireEvent.click(source);

    expect(source).toHaveAttribute("data-selected", "true");
    fireEvent.click(el("zone-you-units-4"));
    expect(onAction).toHaveBeenCalledWith(H1_LANE4);
  });
});

// ---------------------------------------------------------------------------------------------
// B42: a dropped play stays where it landed until the board catches up
// ---------------------------------------------------------------------------------------------

/** h1 has left the hand and stands in your units lane 4: the view the play produces. */
function afterH1(): PlayerView {
  const before = dragView();
  const hand = before.you.hand as ReturnType<typeof card>[];
  const units = [...before.you.units];
  units[3] = unit("p1", { instanceId: "h1", defId: "core-008" });
  return { ...before, you: { ...before.you, hand: hand.filter((c) => c.instanceId !== "h1"), units } };
}

function slotOf(testid: string): HTMLElement {
  const slot = el(testid).closest(".hand-slot");
  if (!(slot instanceof HTMLElement)) throw new Error(`${testid} is not in a hand slot`);
  return slot;
}

function dropH1OnLane4(): void {
  lift(el("hand-card-h1"));
  over(el("zone-you-units-4"));
  move(420, 180);
  release(420, 180);
}

describe("B42 a dropped play stays where it landed until the board shows the play", () => {
  it("B42 after the drop the card is drawn on its zone and is out of the fan, with the drag itself over", () => {
    const { onAction } = renderGame();
    dropH1OnLane4();

    expect(onAction).toHaveBeenCalledWith(H1_LANE4);
    expectNoDrag();
    expect(el("drag-landing")).toBeInTheDocument();
    expect(el("drag-landing-card")).toHaveAttribute("data-instance-id", "h1");
    expect(el("drag-landing-card")).toHaveAttribute("data-landing", "true");
    expect(slotOf("hand-card-h1")).toHaveAttribute("data-landing", "true");
    expect(slotOf("hand-card-s1")).not.toHaveAttribute("data-landing");
  });

  it("B42 it goes as soon as the board shows a newer view: the card is on the field and nothing is marked", () => {
    const { onAction, rerender } = renderGame();
    dropH1OnLane4();
    expect(el("drag-landing")).toBeInTheDocument();

    rerender(<Game view={afterH1()} legal={LEGAL} onAction={onAction} />);

    expect(screen.queryByTestId("drag-landing")).toBeNull();
    expect(screen.queryByTestId("hand-card-h1")).toBeNull();
    expect(within(el("zone-you-units-4")).getByTestId("card-h1")).toBeInTheDocument();
    expect(document.querySelector('[data-landing="true"]')).toBeNull();
  });

  it("B42 a drop that sends nothing leaves nothing behind", () => {
    const { onAction } = renderGame();
    lift(el("hand-card-h1"));
    over(document.body);
    move(20, 20);
    release(20, 20);

    expect(onAction).not.toHaveBeenCalled();
    expect(screen.queryByTestId("drag-landing")).toBeNull();
    expect(slotOf("hand-card-h1")).not.toHaveAttribute("data-landing");
  });

  it("B42 an attack leaves nothing behind either: only a played card lands", () => {
    const { onAction } = renderGame();
    lift(el("card-u1"));
    over(el("hero-opponent"));
    move(420, 60);
    release(420, 60);

    expect(onAction).toHaveBeenCalledWith(U1_HERO);
    expect(screen.queryByTestId("drag-landing")).toBeNull();
  });

  it("B42 if the board never moves on (a refusal the client could not foresee), the card comes back after a while", () => {
    vi.useFakeTimers();
    try {
      renderGame();
      dropH1OnLane4();
      expect(slotOf("hand-card-h1")).toHaveAttribute("data-landing", "true");

      act(() => {
        vi.advanceTimersByTime(4_000);
      });

      expect(screen.queryByTestId("drag-landing")).toBeNull();
      expect(slotOf("hand-card-h1")).not.toHaveAttribute("data-landing");
    } finally {
      vi.useRealTimers();
    }
  });
});
