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

  it("a step done on the board moves on by itself when the next snapshot shows it", () => {
    const source = fakeSource();
    source.push(snap(myTurn(1)));
    mount(source, boardWith([]));
    fireEvent.click(screen.getByTestId(tutorialTestid.coachAck));
    expect(bubble()).toHaveAttribute("data-coach-step", "play");

    act(() => {
      source.push(snap(myTurn(1, { you: emptySide("p1", { hand: [] }) }), [{ type: "endTurn" }]));
    });
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

  it("holds the AI while a holdAi step shows, and lets go when it goes, and on dispose", () => {
    const source = fakeSource();
    source.push(snap(myTurn(1)));
    mount(source, boardWith([]));
    expect(source.setHold).toHaveBeenLastCalledWith(COACH_HOLD, true);

    fireEvent.click(screen.getByTestId(tutorialTestid.coachAck));
    expect(source.setHold).toHaveBeenLastCalledWith(COACH_HOLD, false);

    // A holdAi tip arrives: held again until "Got it"; then the tracker goes and nothing is held.
    act(() => {
      source.push(snap(myTurn(1, { you: emptySide("p1", { libraryCount: 0, hand: [card({ instanceId: "h1", defId: VANILLA })] }) })));
    });
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

  it("shows nothing once the game is over", () => {
    const source = fakeSource();
    source.push(snap(myTurn(1)));
    mount(source, boardWith([]));
    act(() => {
      source.push(snap(myTurn(1, { result: { winner: "p1", reason: "hero-death" } }), []));
    });
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
