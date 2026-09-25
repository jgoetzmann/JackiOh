// The coach on the board (tutorial/Coach.tsx, fed by tutorial/tracker.ts), on a small fake lesson
// script and a fake controller, so nothing here depends on the real lessons.

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ActionBody, GameEvent, PlayerView } from "@jackioh/shared";

import { PRACTICE_IDLE_STATE, type PracticeControllerState } from "../practice/controller.ts";
import type { PracticeSnapshot } from "../practice/protocol.ts";
import { baseView, card, emptySide, resetIds } from "../test/fixtures.ts";
import { setReducedMotion } from "../test/setup.ts";
import { Coach } from "./Coach.tsx";
import type { LessonScript } from "./coach.ts";
import { COACH_DOCK_QUERY, COACH_SHOWCASE_WAIT_MAX_MS, COACH_TRACK_INTERVAL_MS } from "./config.ts";
import { inHand, myMain } from "./steps.ts";
import { tutorialTestid } from "./testids.ts";
import { COACH_HOLD, createCoachTracker, suggestedAction, type CoachSource, type CoachTracker } from "./tracker.ts";

const VANILLA = "core-008";

/** The fake lesson: a welcome that holds the AI, a play step, an end-turn step, and one tip. */
const SCRIPT: LessonScript = {
  lessonId: "fake",
  steps: [
    { id: "welcome", kind: "info", title: "Welcome", text: "These cards are your hand.", anchor: { kind: "hand" }, holdAi: true },
    {
      id: "play",
      kind: "act",
      title: "Play a unit",
      text: (ctx) => `You have ${String(ctx.view.you.mana.current)} mana: play Mr. Vanilla.`,
      anchor: { kind: "handCard", defId: VANILLA },
      when: (ctx) => myMain(ctx),
      done: (ctx) => inHand(ctx.view, VANILLA) === undefined,
      expect: (action) => action.type === "play",
    },
    {
      id: "end",
      kind: "act",
      title: "End your turn",
      text: "Press End turn.",
      anchor: { kind: "endTurn" },
      when: (ctx) => myMain(ctx),
      done: (ctx, since) => ctx.view.turn !== since.turn,
      final: true,
    },
  ],
  tips: [
    {
      id: "fatigue",
      title: "Out of cards",
      text: "Your library is empty.",
      when: (ctx) => ctx.view.you.libraryCount === 0,
      holdAi: true,
    },
  ],
};

type FakeSource = CoachSource & {
  setHold: ReturnType<typeof vi.fn>;
  push(snapshot: PracticeSnapshot): void;
};

function fakeSource(): FakeSource {
  let state: PracticeControllerState = { ...PRACTICE_IDLE_STATE, phase: "playing" };
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    subscribe(fn) {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    setHold: vi.fn(),
    push(snapshot) {
      state = { ...state, snapshot };
      for (const fn of [...listeners]) fn();
    },
  };
}

const PLAY: ActionBody = { type: "play", instanceId: "h1", zone: { row: "units", lane: 1 } };

function myTurn(turn: number, over: Partial<PlayerView> = {}): PlayerView {
  return baseView({
    turn,
    active: "p1",
    you: emptySide("p1", { hand: [card({ instanceId: "h1", defId: VANILLA, cost: 1 })] }),
    ...over,
  });
}

function snap(view: PlayerView, legal: ActionBody[] = [PLAY, { type: "endTurn" }], aiToAct = false): PracticeSnapshot {
  return { view, legal, aiToAct, error: null };
}

/** The board's elements the coach points at, each with a laid-out box (jsdom has no layout). */
function boardWith(ids: readonly string[]): HTMLElement {
  const root = document.createElement("div");
  root.setAttribute("data-testid", "fake-board");
  for (const [index, id] of ids.entries()) {
    const element = document.createElement("button");
    element.setAttribute("data-testid", id);
    element.textContent = id;
    element.getBoundingClientRect = () =>
      ({ left: 100 + 120 * index, top: 500, width: 100, height: 140, right: 200 + 120 * index, bottom: 640, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    root.appendChild(element);
  }
  document.body.appendChild(root);
  return root;
}

let tracker: CoachTracker | null = null;

type DockStub = { set(matches: boolean): void; restore(): void };
let dockStub: DockStub | null = null;

/**
 * The board's phone layouts, as `window.matchMedia(COACH_DOCK_QUERY)` reports them (jsdom has no
 * media queries: test/setup.ts's stub answers only reduced motion). `set` flips it the way turning
 * a phone does, firing the query's `change`.
 */
function phoneLayout(matches: boolean): DockStub {
  const listeners = new Set<() => void>();
  let now = matches;
  const original = window.matchMedia;
  window.matchMedia = ((query: string) => {
    if (query !== COACH_DOCK_QUERY) return original(query);
    return {
      media: query,
      get matches() {
        return now;
      },
      onchange: null,
      addEventListener: (_type: string, fn: () => void) => listeners.add(fn),
      removeEventListener: (_type: string, fn: () => void) => listeners.delete(fn),
      addListener: (fn: () => void) => listeners.add(fn),
      removeListener: (fn: () => void) => listeners.delete(fn),
      dispatchEvent: () => false,
    } as unknown as MediaQueryList;
  }) as typeof window.matchMedia;
  dockStub = {
    set(next) {
      now = next;
      for (const fn of [...listeners]) fn();
    },
    restore() {
      window.matchMedia = original;
    },
  };
  return dockStub;
}

/** jsdom lays nothing out: give the coach's text the heights a clamped (or unclamped) text has. */
function textHeights(scrollHeight: number, clientHeight: number): void {
  const text = bubble().querySelector(".coach__text");
  if (!(text instanceof HTMLElement)) throw new Error("the coach has no text");
  Object.defineProperty(text, "scrollHeight", { configurable: true, get: () => scrollHeight });
  Object.defineProperty(text, "clientHeight", { configurable: true, get: () => clientHeight });
  // The coach re-measures on a resize as well as on its timer.
  act(() => {
    window.dispatchEvent(new Event("resize"));
  });
}

/**
 * A new snapshot arrives. Its display shows a microtask later, once the board has had its chance to
 * mark what it animates (Coach.tsx `useCaughtUp`).
 */
async function arrive(source: FakeSource, snapshot: PracticeSnapshot): Promise<void> {
  await act(async () => {
    source.push(snapshot);
    await Promise.resolve();
  });
}

function mount(source: FakeSource, root: HTMLElement | null): ReturnType<typeof render> {
  tracker = createCoachTracker(source, SCRIPT);
  return render(<Coach tracker={tracker} boardRoot={root} />);
}

function bubble(): HTMLElement {
  return screen.getByTestId(tutorialTestid.coach);
}

beforeEach(() => {
  resetIds();
});

afterEach(() => {
  cleanup();
  dockStub?.restore();
  dockStub = null;
  tracker?.dispose();
  tracker = null;
  document.body.innerHTML = "";
  setReducedMotion(false);
  vi.useRealTimers();
});

describe("the coach bubble", () => {
  it("shows the step's title and text, which step it is, and what it points at", () => {
    const source = fakeSource();
    source.push(snap(myTurn(1)));
    const root = boardWith(["hand-you", "hand-card-h1", "end-turn"]);
    mount(source, root);

    const el = bubble();
    expect(el).toHaveAttribute("data-coach-mode", "step");
    expect(el).toHaveAttribute("data-coach-step", "welcome");
    expect(el).toHaveAttribute("data-coach-anchor", "hand-you");
    expect(el).toHaveAttribute("role", "region");
    expect(screen.getByRole("heading", { name: "Welcome" })).toBeInTheDocument();
    expect(el).toHaveAccessibleName("Welcome");
    expect(el).toHaveTextContent("These cards are your hand.");
    expect(el).toHaveTextContent("1 / 3");
    expect(el.querySelector('[aria-live="polite"]')).toHaveTextContent("These cards are your hand.");
    expect(screen.getByTestId(tutorialTestid.coachAck)).toHaveTextContent("Got it");
    expect(screen.getByTestId(tutorialTestid.coachSkip)).toHaveTextContent("Skip step");
  });

  it("Got it completes an info step, and the next step's text is read off the view", () => {
    const source = fakeSource();
    source.push(snap(myTurn(1)));
    mount(source, boardWith(["hand-you", "hand-card-h1"]));

    fireEvent.click(screen.getByTestId(tutorialTestid.coachAck));
    expect(bubble()).toHaveAttribute("data-coach-step", "play");
    expect(bubble()).toHaveAttribute("data-coach-anchor", "hand-card-h1");
    expect(bubble()).toHaveTextContent("You have 4 mana: play Mr. Vanilla.");
    expect(bubble()).toHaveTextContent("2 / 3");
    // An act step has no Got it: the player does what it says.
    expect(screen.queryByTestId(tutorialTestid.coachAck)).toBeNull();
  });

  it("Skip step moves on from any step", () => {
    const source = fakeSource();
    source.push(snap(myTurn(1)));
    mount(source, boardWith([]));

    fireEvent.click(screen.getByTestId(tutorialTestid.coachSkip));
    expect(bubble()).toHaveAttribute("data-coach-step", "play");
    fireEvent.click(screen.getByTestId(tutorialTestid.coachSkip));
    expect(bubble()).toHaveAttribute("data-coach-step", "end");
    expect(tracker?.getState().coach.outcomes).toEqual({ welcome: "skipped", play: "skipped" });
  });

  it("a step done on the board moves on by itself when the next snapshot shows it", async () => {
    const source = fakeSource();
    source.push(snap(myTurn(1)));
    mount(source, boardWith([]));
    fireEvent.click(screen.getByTestId(tutorialTestid.coachAck));
    expect(bubble()).toHaveAttribute("data-coach-step", "play");

    await arrive(source, snap(myTurn(1, { you: emptySide("p1", { hand: [] }) }), [{ type: "endTurn" }]));
    expect(bubble()).toHaveAttribute("data-coach-step", "end");
    expect(bubble()).toHaveAttribute("data-coach-anchor", "end-turn");
  });

  it("rings the anchor's elements, and shows the bubble without a ring when none is on screen", () => {
    const source = fakeSource();
    source.push(snap(myTurn(1)));
    const { unmount } = mount(source, boardWith(["hand-you"]));
    const ring = screen.getByTestId(tutorialTestid.coachRing);
    expect(ring).toHaveAttribute("aria-hidden", "true");
    // The anchor's box, padded by COACH_RING_PAD_PX all round.
    expect(ring.style.left).toBe("94px");
    expect(ring.style.width).toBe("112px");
    unmount();
    tracker?.dispose();
    document.body.innerHTML = "";

    const bare = fakeSource();
    bare.push(snap(myTurn(1)));
    mount(bare, boardWith([]));
    expect(bubble()).toHaveAttribute("data-coach-anchor", "hand-you");
    expect(screen.queryByTestId(tutorialTestid.coachRing)).toBeNull();
  });

  it("holds the AI while a holdAi step shows, and lets go when it goes, and on dispose", async () => {
    const source = fakeSource();
    source.push(snap(myTurn(1)));
    mount(source, boardWith([]));
    expect(source.setHold).toHaveBeenLastCalledWith(COACH_HOLD, true);

    fireEvent.click(screen.getByTestId(tutorialTestid.coachAck));
    expect(source.setHold).toHaveBeenLastCalledWith(COACH_HOLD, false);

    // A holdAi tip arrives: held again until "Got it"; then the tracker goes and nothing is held.
    await arrive(source, snap(myTurn(1, { you: emptySide("p1", { libraryCount: 0, hand: [card({ instanceId: "h1", defId: VANILLA })] }) })));
    expect(bubble()).toHaveAttribute("data-coach-mode", "tip");
    expect(bubble()).toHaveTextContent("Tip");
    expect(source.setHold).toHaveBeenLastCalledWith(COACH_HOLD, true);
    tracker?.dispose();
    expect(source.setHold).toHaveBeenLastCalledWith(COACH_HOLD, false);
  });

  it("the hold starts with the snapshot, before any render, so the controller cannot schedule the AI first", () => {
    const source = fakeSource();
    tracker = createCoachTracker(source, SCRIPT);
    expect(source.setHold).not.toHaveBeenCalled();
    source.push(snap(myTurn(1)));
    expect(source.setHold).toHaveBeenCalledWith(COACH_HOLD, true);
  });

  it("moves focus to Got it when a step that needs it appears, but never out of an open prompt", () => {
    const source = fakeSource();
    source.push(snap(myTurn(1)));
    mount(source, boardWith([]));
    expect(screen.getByTestId(tutorialTestid.coachAck)).toHaveFocus();
    cleanup();
    tracker?.dispose();
    document.body.innerHTML = "";

    const prompt = document.createElement("div");
    prompt.setAttribute("data-testid", "prompt-modal");
    const choice = document.createElement("button");
    choice.textContent = "Keep";
    prompt.appendChild(choice);
    document.body.appendChild(prompt);
    choice.focus();
    const again = fakeSource();
    again.push(snap(myTurn(1)));
    mount(again, null);
    expect(choice).toHaveFocus();
  });

  it("keeps the focus in the bubble when Got it goes, and Escape does nothing", () => {
    const source = fakeSource();
    source.push(snap(myTurn(1)));
    mount(source, boardWith([]));
    const ack = screen.getByTestId(tutorialTestid.coachAck);
    ack.focus();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(bubble()).toHaveAttribute("data-coach-step", "welcome");
    fireEvent.click(ack);
    expect(bubble()).toHaveFocus();
  });

  it("while it waits on the AI's turn, a slim bubble says so and keeps Skip step", () => {
    const source = fakeSource();
    source.push(snap(myTurn(2, { active: "p2" }), [], true));
    mount(source, boardWith([]));
    // The welcome is an info step with no `when`: it shows even now. Skip it to reach "play".
    fireEvent.click(screen.getByTestId(tutorialTestid.coachSkip));
    const el = bubble();
    expect(el).toHaveAttribute("data-coach-mode", "waiting");
    expect(el).not.toHaveAttribute("data-coach-step");
    expect(el).toHaveTextContent("The AI is taking its turn.");
    expect(el).toHaveAccessibleName("Tutorial coach");
    expect(screen.getByTestId(tutorialTestid.coachSkip)).toBeInTheDocument();
    expect(screen.queryByTestId(tutorialTestid.coachAck)).toBeNull();
  });

  it("waits for the board: a newer display shows only once nothing carries data-animating", async () => {
    const source = fakeSource();
    source.push(snap(myTurn(1)));
    const root = boardWith(["hand-you", "hand-card-h1"]);
    mount(source, root);
    fireEvent.click(screen.getByTestId(tutorialTestid.coachAck));
    expect(bubble()).toHaveAttribute("data-coach-step", "play");

    // The play lands, and the board animates it: the bubble keeps the step it was on, marked stale,
    // and a press on it answers nothing the player has not seen.
    root.firstElementChild?.setAttribute("data-animating", "summoned");
    act(() => {
      source.push(snap(myTurn(1, { you: emptySide("p1", { hand: [] }) }), [{ type: "endTurn" }]));
    });
    expect(tracker?.getState().display).toMatchObject({ mode: "step", id: "end" });
    expect(bubble()).toHaveAttribute("data-coach-step", "play");
    expect(bubble()).toHaveAttribute("data-stale", "true");
    fireEvent.click(screen.getByTestId(tutorialTestid.coachSkip));
    expect(tracker?.getState().display).toMatchObject({ mode: "step", id: "end" });

    // The board catches up.
    await act(async () => {
      root.firstElementChild?.removeAttribute("data-animating");
      await Promise.resolve();
    });
    expect(bubble()).toHaveAttribute("data-coach-step", "end");
    expect(bubble()).not.toHaveAttribute("data-stale");
  });

  it("looks at the board a microtask after a snapshot, so an animation the board marks in its next render holds the new display", async () => {
    const source = fakeSource();
    source.push(snap(myTurn(1)));
    const root = boardWith(["hand-you", "hand-card-h1"]);
    mount(source, root);
    fireEvent.click(screen.getByTestId(tutorialTestid.coachAck));
    expect(bubble()).toHaveAttribute("data-coach-step", "play");

    // The snapshot lands; the board draws `data-animating` in the render after it (Game.tsx plans
    // the events in a layout effect), which here is after the coach's own effect has run.
    act(() => {
      source.push(snap(myTurn(1, { you: emptySide("p1", { hand: [] }) }), [{ type: "endTurn" }]));
    });
    root.firstElementChild?.setAttribute("data-animating", "summoned");
    await act(async () => {
      await Promise.resolve();
    });
    expect(bubble()).toHaveAttribute("data-coach-step", "play");
    expect(bubble()).toHaveAttribute("data-stale", "true");

    await act(async () => {
      root.firstElementChild?.removeAttribute("data-animating");
      await Promise.resolve();
    });
    expect(bubble()).toHaveAttribute("data-coach-step", "end");
  });

  it("waits while the opponent's card is held up (data-showcase), and at most COACH_SHOWCASE_WAIT_MAX_MS", async () => {
    const source = fakeSource();
    source.push(snap(myTurn(1)));
    mount(source, boardWith(["hand-you", "hand-card-h1"]));
    fireEvent.click(screen.getByTestId(tutorialTestid.coachAck));

    const showcase = document.createElement("div");
    showcase.setAttribute("data-showcase", "played");
    document.body.appendChild(showcase);
    await arrive(source, snap(myTurn(1, { you: emptySide("p1", { hand: [] }) }), [{ type: "endTurn" }]));
    expect(bubble()).toHaveAttribute("data-coach-step", "play");
    expect(bubble()).toHaveAttribute("data-stale", "true");

    // The card goes down: the display the board has caught up with shows.
    await act(async () => {
      showcase.remove();
      await Promise.resolve();
    });
    expect(bubble()).toHaveAttribute("data-coach-step", "end");

    // A mark that is never cleared holds the coach for the cap and no longer.
    vi.useFakeTimers();
    const stuck = document.createElement("div");
    stuck.setAttribute("data-showcase", "played");
    document.body.appendChild(stuck);
    // A new turn: the last step is done, and the lesson's coach has nothing more to show.
    await arrive(source, snap(myTurn(2), [{ type: "endTurn" }]));
    expect(tracker?.getState().display).toEqual({ mode: "finished" });
    expect(bubble()).toHaveAttribute("data-coach-step", "end");
    expect(bubble()).toHaveAttribute("data-stale", "true");
    act(() => {
      vi.advanceTimersByTime(COACH_SHOWCASE_WAIT_MAX_MS - 1);
    });
    expect(bubble()).toHaveAttribute("data-stale", "true");
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryByTestId(tutorialTestid.coach)).toBeNull();
  });

  it("rings an anchor the board draws a frame after the display, before the next tick", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"] });
    const source = fakeSource();
    source.push(snap(myTurn(1)));
    const root = boardWith([]);
    mount(source, root);
    expect(screen.queryByTestId(tutorialTestid.coachRing)).toBeNull();

    act(() => {
      boardWith(["hand-you"]);
      vi.advanceTimersToNextFrame();
    });
    expect(screen.getByTestId(tutorialTestid.coachRing)).toBeInTheDocument();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    expect(COACH_TRACK_INTERVAL_MS).toBeGreaterThan(16);
  });

  it("draws no ring round an anchor under the open prompt, and one round an anchor inside it or clear of it", () => {
    const source = fakeSource();
    source.push(snap(myTurn(1)));
    const root = boardWith(["hand-you"]);
    // A phone's picker sheet over the bottom of the screen, where the hand is (boardWith: top 500).
    const sheet = document.createElement("div");
    sheet.setAttribute("data-testid", "prompt-modal");
    sheet.getBoundingClientRect = () =>
      ({ left: 0, top: 450, width: 1280, height: 270, right: 1280, bottom: 720, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    document.body.appendChild(sheet);
    mount(source, root);
    expect(bubble()).toHaveAttribute("data-coach-anchor", "hand-you");
    expect(screen.queryByTestId(tutorialTestid.coachRing)).toBeNull();

    // The same element inside the prompt (a card the picker offers) is what the step points at.
    act(() => {
      sheet.appendChild(root.firstElementChild as Element);
      window.dispatchEvent(new Event("resize"));
    });
    expect(screen.getByTestId(tutorialTestid.coachRing)).toBeInTheDocument();

    // A prompt clear of the anchor (a desktop's picker in the sidebar) hides nothing.
    act(() => {
      root.appendChild(sheet.firstElementChild as Element);
      sheet.getBoundingClientRect = () =>
        ({ left: 1000, top: 100, width: 260, height: 300, right: 1260, bottom: 400, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
      window.dispatchEvent(new Event("resize"));
    });
    expect(screen.getByTestId(tutorialTestid.coachRing)).toBeInTheDocument();
  });

  it("waiting on the player's own turn, says it is their move and offers no Skip step; on the AI's turn it says so and keeps it", async () => {
    const script: LessonScript = {
      lessonId: "later",
      steps: [{ id: "later", kind: "act", title: "Later", text: "Not yet.", when: () => false, final: true }],
      tips: [],
    };
    const source = fakeSource();
    source.push(snap(myTurn(1)));
    tracker = createCoachTracker(source, script);
    render(<Coach tracker={tracker} boardRoot={boardWith([])} />);
    expect(bubble()).toHaveAttribute("data-coach-mode", "waiting");
    expect(bubble()).toHaveTextContent("Your move: play cards and attack, then press End turn.");
    expect(screen.queryByTestId(tutorialTestid.coachSkip)).toBeNull();

    await arrive(source, snap(myTurn(1, { active: "p2" }), [], true));
    expect(bubble()).toHaveTextContent("The AI is taking its turn.");
    expect(bubble()).not.toHaveTextContent("Your move");
    expect(screen.getByTestId(tutorialTestid.coachSkip)).toBeInTheDocument();
  });

  it("shows nothing once the game is over", async () => {
    const source = fakeSource();
    source.push(snap(myTurn(1)));
    mount(source, boardWith([]));
    await arrive(source, snap(myTurn(1, { result: { winner: "p1", reason: "hero-death" } }), []));
    expect(screen.queryByTestId(tutorialTestid.coach)).toBeNull();
    expect(screen.queryByTestId(tutorialTestid.coachRing)).toBeNull();
    expect(source.setHold).toHaveBeenLastCalledWith(COACH_HOLD, false);
  });

  it("reads each snapshot's new events only once, and the first snapshot's as none", () => {
    const source = fakeSource();
    const seen: (readonly GameEvent[])[] = [];
    const script: LessonScript = {
      lessonId: "events",
      steps: [{ id: "watch", kind: "act", title: "Watch", text: "", done: (ctx) => (seen.push(ctx.fresh), false) }],
      tips: [],
    };
    const drawn: GameEvent = { type: "cardDrawn", player: "p1", instanceId: "h9" } as GameEvent;
    source.push(snap(myTurn(1, { events: [drawn] })));
    tracker = createCoachTracker(source, script);
    source.push(snap(myTurn(1, { events: [drawn, { ...drawn, instanceId: "h10" } as GameEvent] })));
    expect(seen).toEqual([[], [{ ...drawn, instanceId: "h10" }]]);
  });

  it("names the action the showing step expects, for the dev handle", () => {
    const source = fakeSource();
    source.push(snap(myTurn(1)));
    tracker = createCoachTracker(source, SCRIPT);
    // The welcome expects nothing.
    expect(suggestedAction(SCRIPT, tracker.getState())).toBeNull();
    tracker.ack();
    expect(suggestedAction(SCRIPT, tracker.getState())).toEqual(PLAY);
  });
});

describe("the coach on a phone: a panel between the HUD and the board", () => {
  it("floats beside its anchor on a desktop, and is a panel in the page on the board's phone layouts", () => {
    phoneLayout(false);
    const source = fakeSource();
    source.push(snap(myTurn(1)));
    const { unmount } = mount(source, boardWith(["hand-you"]));
    expect(bubble()).toHaveAttribute("data-coach-dock", "float");
    expect(bubble()).toHaveClass("coach--float");
    expect(bubble()).toHaveAttribute("data-coach-side");
    expect(bubble().style.left).not.toBe("");
    unmount();
    tracker?.dispose();
    dockStub?.restore();
    document.body.innerHTML = "";

    phoneLayout(true);
    const phone = fakeSource();
    phone.push(snap(myTurn(1)));
    mount(phone, boardWith(["hand-you"]));
    const el = bubble();
    expect(el).toHaveAttribute("data-coach-dock", "panel");
    expect(el).toHaveClass("coach--panel");
    // Laid out by the page: no side, no inline position, never hidden for want of one.
    expect(el).not.toHaveAttribute("data-coach-side");
    expect(el.getAttribute("style") ?? "").toBe("");
    expect(el).toHaveAttribute("data-placed", "true");
    // The same contract as the bubble: what it says, what it points at, and its buttons.
    expect(el).toHaveAttribute("data-coach-mode", "step");
    expect(el).toHaveAttribute("data-coach-step", "welcome");
    expect(el).toHaveAttribute("data-coach-anchor", "hand-you");
    expect(el).toHaveAccessibleName("Welcome");
    expect(el).toHaveTextContent("These cards are your hand.");
    expect(el).toHaveTextContent("1 / 3");
    expect(screen.getByTestId(tutorialTestid.coachSkip)).toHaveTextContent("Skip step");
    // "Got it" still takes the focus, and the ring still marks the anchor on the board.
    expect(screen.getByTestId(tutorialTestid.coachAck)).toHaveFocus();
    expect(screen.getByTestId(tutorialTestid.coachRing).style.left).toBe("94px");
  });

  it("switches live as the phone turns or the window is resized, and keeps the step and the focus", () => {
    const dock = phoneLayout(false);
    const source = fakeSource();
    source.push(snap(myTurn(1)));
    mount(source, boardWith(["hand-you"]));
    const ack = screen.getByTestId(tutorialTestid.coachAck);
    expect(ack).toHaveFocus();
    expect(bubble()).toHaveAttribute("data-coach-dock", "float");

    act(() => {
      dock.set(true);
    });
    expect(bubble()).toHaveAttribute("data-coach-dock", "panel");
    expect(bubble()).toHaveAttribute("data-coach-step", "welcome");
    // The same element, so the focus stays where it was.
    expect(screen.getByTestId(tutorialTestid.coachAck)).toBe(ack);
    expect(ack).toHaveFocus();

    act(() => {
      dock.set(false);
    });
    expect(bubble()).toHaveAttribute("data-coach-dock", "float");
  });

  it("clamps a long text with More, which shows it all and Less folds again; a new step starts folded", () => {
    phoneLayout(true);
    const source = fakeSource();
    source.push(snap(myTurn(1)));
    mount(source, boardWith(["hand-you", "hand-card-h1"]));
    expect(bubble()).toHaveAttribute("data-expanded", "false");
    // Everything fits: no More.
    textHeights(36, 36);
    expect(screen.queryByRole("button", { name: "More" })).toBeNull();

    // The text runs past the panel's lines.
    textHeights(72, 54);
    const more = screen.getByRole("button", { name: "More" });
    expect(more).toHaveAttribute("aria-expanded", "false");
    expect(more).toHaveAttribute("aria-controls", bubble().querySelector(".coach__text")?.id);
    fireEvent.click(more);
    expect(bubble()).toHaveAttribute("data-expanded", "true");
    const less = screen.getByRole("button", { name: "Less" });
    expect(less).toBe(more);
    expect(less).toHaveAttribute("aria-expanded", "true");
    // Unfolded, the text no longer runs over, and Less stays.
    textHeights(72, 72);
    expect(screen.getByRole("button", { name: "Less" })).toBe(more);
    // Folded, it will run over again (the page clamps it before the coach measures): the same
    // button says More, so a keyboard user's focus stays on it.
    textHeights(72, 54);
    fireEvent.click(less);
    expect(bubble()).toHaveAttribute("data-expanded", "false");
    expect(screen.getByRole("button", { name: "More" })).toBe(more);

    // Opened again, then the step changes: the next one starts folded.
    fireEvent.click(screen.getByRole("button", { name: "More" }));
    expect(bubble()).toHaveAttribute("data-expanded", "true");
    fireEvent.click(screen.getByTestId(tutorialTestid.coachAck));
    expect(bubble()).toHaveAttribute("data-coach-step", "play");
    expect(bubble()).toHaveAttribute("data-expanded", "false");
  });

  it("never offers More on a floating bubble, which shows its whole text", () => {
    phoneLayout(false);
    const source = fakeSource();
    source.push(snap(myTurn(1)));
    mount(source, boardWith(["hand-you"]));
    textHeights(72, 54);
    expect(screen.queryByRole("button", { name: "More" })).toBeNull();
    expect(bubble()).not.toHaveAttribute("data-expanded");
  });

  it("keeps the waiting line and Skip step in the panel while the AI plays", () => {
    phoneLayout(true);
    const source = fakeSource();
    source.push(snap(myTurn(2, { active: "p2" }), [], true));
    mount(source, boardWith([]));
    fireEvent.click(screen.getByTestId(tutorialTestid.coachSkip));
    const el = bubble();
    expect(el).toHaveAttribute("data-coach-dock", "panel");
    expect(el).toHaveAttribute("data-coach-mode", "waiting");
    expect(el).toHaveClass("coach--slim");
    expect(el).toHaveTextContent("The AI is taking its turn.");
    expect(screen.getByTestId(tutorialTestid.coachSkip)).toBeInTheDocument();
    expect(screen.queryByTestId(tutorialTestid.coachRing)).toBeNull();
  });
});
