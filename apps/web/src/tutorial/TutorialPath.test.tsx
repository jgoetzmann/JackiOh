// The lesson path (tutorial/TutorialPath.tsx): every lesson in order with what it teaches, its
// status in words, and a button that starts, replays or explains why it is locked; and R322's Hide
// tutorial and Show tutorial.

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TUTORIAL_PROGRESS_KEY } from "./config.ts";
import { TUTORIAL_LESSONS, type TutorialLesson } from "./lessons.ts";
import {
  __resetTutorialProgressForTests,
  markLessonComplete,
  readTutorialProgress,
  setTutorialHidden,
} from "./progress.ts";
import { tutorialTestid } from "./testids.ts";
import { TutorialPath } from "./TutorialPath.tsx";

function lesson(number: number): TutorialLesson {
  const found = TUTORIAL_LESSONS.find((candidate) => candidate.number === number);
  if (found === undefined) throw new Error(`no lesson ${String(number)}`);
  return found;
}

function node(each: TutorialLesson): HTMLElement {
  return screen.getByTestId(tutorialTestid.lesson(each.id));
}

function button(each: TutorialLesson): HTMLElement {
  return screen.getByTestId(tutorialTestid.lessonStart(each.id));
}

beforeEach(() => {
  window.localStorage.clear();
  __resetTutorialProgressForTests();
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  __resetTutorialProgressForTests();
});

describe("the lesson path", () => {
  it("lists every lesson in order with its number, title, summary and mechanics", () => {
    render(<TutorialPath onStart={vi.fn()} />);
    const path = screen.getByTestId(tutorialTestid.path);
    expect(within(path).getByRole("heading", { level: 2, name: "Learn to play" })).toBeInTheDocument();
    const items = within(path).getAllByRole("listitem").filter((item) => item.hasAttribute("data-status"));
    expect(items.map((item) => item.getAttribute("data-testid"))).toEqual(
      TUTORIAL_LESSONS.map((each) => tutorialTestid.lesson(each.id)),
    );
    for (const each of TUTORIAL_LESSONS) {
      const item = node(each);
      expect(item).toHaveTextContent(`Lesson ${String(each.number)}`);
      expect(within(item).getByRole("heading", { level: 3, name: each.title })).toBeInTheDocument();
      expect(item).toHaveTextContent(each.summary);
      const chips = within(within(item).getByRole("list", { name: "What it teaches" })).getAllByRole("listitem");
      expect(chips.map((chip) => chip.textContent)).toEqual([...each.mechanics]);
    }
  });

  it("with no progress: lesson 1 is open and up next, the rest are locked and say why", () => {
    const onStart = vi.fn();
    render(<TutorialPath onStart={onStart} />);
    expect(node(lesson(1))).toHaveAttribute("data-status", "unlocked");
    expect(node(lesson(1))).toHaveAttribute("data-next", "true");
    expect(button(lesson(1))).toHaveTextContent("Start");
    expect(button(lesson(1))).not.toHaveAttribute("aria-disabled");
    expect(button(lesson(1))).toHaveAccessibleDescription("Up next");

    for (const number of [2, 3, 4]) {
      const each = lesson(number);
      expect(node(each)).toHaveAttribute("data-status", "locked");
      expect(button(each)).toHaveTextContent("Locked");
      expect(button(each)).toHaveAttribute("aria-disabled", "true");
      expect(button(each)).toHaveAccessibleDescription(`Finish lesson ${String(number - 1)} first`);
      expect(node(each)).toHaveTextContent(`Finish lesson ${String(number - 1)} first`);
      fireEvent.click(button(each));
    }
    expect(onStart).not.toHaveBeenCalled();
    expect(screen.getByTestId(tutorialTestid.path)).toHaveTextContent("0 of 4 lessons complete");
    expect(screen.queryByTestId(tutorialTestid.continue)).toBeNull();
  });

  it("Start starts an open lesson; a completed one reads Completed and offers Replay", () => {
    markLessonComplete(lesson(1).id);
    const onStart = vi.fn();
    render(<TutorialPath onStart={onStart} />);

    expect(node(lesson(1))).toHaveAttribute("data-status", "completed");
    expect(node(lesson(1))).toHaveTextContent("Completed");
    expect(button(lesson(1))).toHaveTextContent("Replay");
    expect(node(lesson(2))).toHaveAttribute("data-status", "unlocked");
    expect(node(lesson(2))).toHaveAttribute("data-next", "true");
    expect(node(lesson(3))).toHaveAttribute("data-status", "locked");

    fireEvent.click(button(lesson(2)));
    expect(onStart).toHaveBeenLastCalledWith(lesson(2));
    fireEvent.click(button(lesson(1)));
    expect(onStart).toHaveBeenLastCalledWith(lesson(1));

    // Continue: the next lesson, one press from the path's header.
    expect(screen.getByTestId(tutorialTestid.continue)).toHaveTextContent("Continue: Lesson 2");
    fireEvent.click(screen.getByTestId(tutorialTestid.continue));
    expect(onStart).toHaveBeenLastCalledWith(lesson(2));
  });

  it("is keyboard reachable: every lesson's button is a real button in path order, locked ones included", () => {
    render(<TutorialPath onStart={vi.fn()} />);
    const buttons = TUTORIAL_LESSONS.map((each) => button(each));
    for (const each of buttons) {
      expect(each.tagName).toBe("BUTTON");
      expect(each).not.toHaveAttribute("disabled");
      expect(each).toHaveAttribute("type", "button");
    }
    // Each is named for its lesson, so a screen reader hears which Start it is on.
    expect(buttons[0]).toHaveAccessibleName(`Start: lesson 1, ${lesson(1).title}`);
    expect(buttons[1]).toHaveAccessibleName(`Locked: lesson 2, ${lesson(2).title}`);
    buttons[0]?.focus();
    expect(buttons[0]).toHaveFocus();
  });

  it("updates when a lesson is won elsewhere (this tab or another)", () => {
    render(<TutorialPath onStart={vi.fn()} />);
    expect(node(lesson(2))).toHaveAttribute("data-status", "locked");
    act(() => {
      markLessonComplete(lesson(1).id);
    });
    expect(node(lesson(2))).toHaveAttribute("data-status", "unlocked");
  });

  it("folds to its header once every lesson is done, and opens again on request", () => {
    for (const each of TUTORIAL_LESSONS) markLessonComplete(each.id);
    render(<TutorialPath onStart={vi.fn()} />);
    const path = screen.getByTestId(tutorialTestid.path);
    expect(path).toHaveAttribute("data-complete", "true");
    expect(path).toHaveTextContent("Tutorial complete");
    expect(path).toHaveTextContent("4 of 4 lessons complete");
    const toggle = screen.getByTestId(tutorialTestid.pathToggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(node(lesson(1)).closest("ol")).not.toBeVisible();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(node(lesson(1)).closest("ol")).toBeVisible();
    expect(button(lesson(4))).toHaveTextContent("Replay");
  });
});

describe("R322 Hide tutorial and Show tutorial", () => {
  it("R322 Hide folds the path to one Show tutorial button in its place, and Show brings the path back", () => {
    markLessonComplete(lesson(1).id);
    render(<TutorialPath onStart={vi.fn()} />);
    const hide = screen.getByTestId(tutorialTestid.hide);
    expect(hide).toHaveTextContent("Hide tutorial");

    fireEvent.click(hide);
    expect(screen.queryByTestId(tutorialTestid.path)).toBeNull();
    expect(screen.queryByTestId(tutorialTestid.lesson(lesson(1).id))).toBeNull();
    const bar = screen.getByTestId(tutorialTestid.hidden);
    expect(bar).toHaveAttribute("data-complete", "false");
    expect(bar).toHaveTextContent("Tutorial hidden");
    expect(bar).toHaveTextContent("1 of 4 lessons complete");

    fireEvent.click(screen.getByTestId(tutorialTestid.show));
    expect(screen.queryByTestId(tutorialTestid.hidden)).toBeNull();
    expect(screen.getByTestId(tutorialTestid.path)).toBeInTheDocument();
    expect(node(lesson(2))).toHaveAttribute("data-status", "unlocked");
  });

  it("R322 both are real buttons a keyboard reaches, and focus moves to the one that undoes the press", () => {
    render(<TutorialPath onStart={vi.fn()} />);
    const hide = screen.getByRole("button", { name: "Hide tutorial" });
    expect(hide).toHaveAttribute("type", "button");
    hide.focus();
    expect(hide).toHaveFocus();

    fireEvent.click(hide);
    const show = screen.getByRole("button", { name: "Show tutorial" });
    expect(show).toHaveAttribute("type", "button");
    expect(show).toHaveFocus();
    // The hidden path is still a named landmark a screen reader can find.
    expect(screen.getByRole("region", { name: "Tutorial hidden" })).toBe(screen.getByTestId(tutorialTestid.hidden));

    fireEvent.click(show);
    expect(screen.getByRole("button", { name: "Hide tutorial" })).toHaveFocus();
  });

  it("R322 the choice is kept on the device with when it was made, and holds on the next visit", () => {
    const { unmount } = render(<TutorialPath onStart={vi.fn()} />);
    fireEvent.click(screen.getByTestId(tutorialTestid.hide));
    const raw = window.localStorage.getItem(TUTORIAL_PROGRESS_KEY);
    const saved = JSON.parse(raw ?? "null") as { v: number; completed: string[]; hiddenChoice: { hidden: boolean; at: number } };
    expect(saved.v).toBe(1);
    expect(saved.completed).toEqual([]);
    expect(saved.hiddenChoice.hidden).toBe(true);
    expect(Number.isSafeInteger(saved.hiddenChoice.at)).toBe(true);
    unmount();

    // A reload: the module reads storage again.
    __resetTutorialProgressForTests();
    render(<TutorialPath onStart={vi.fn()} />);
    expect(screen.getByTestId(tutorialTestid.hidden)).toBeInTheDocument();
    expect(screen.queryByTestId(tutorialTestid.path)).toBeNull();
  });

  it("R322 a choice made elsewhere (another tab, or the account's newer one) hides or shows the path here", () => {
    render(<TutorialPath onStart={vi.fn()} />);
    act(() => {
      setTutorialHidden(true, 1_000);
    });
    expect(screen.getByTestId(tutorialTestid.hidden)).toBeInTheDocument();
    act(() => {
      setTutorialHidden(false, 2_000);
    });
    expect(screen.getByTestId(tutorialTestid.path)).toBeInTheDocument();
    // Focus is moved only by this component's own press, never by a change from elsewhere.
    expect(screen.getByTestId(tutorialTestid.hide)).not.toHaveFocus();
  });

  it("R322 a finished path offers no Hide; one hidden before it was finished stays hidden, and Show opens its folded header", () => {
    render(<TutorialPath onStart={vi.fn()} />);
    fireEvent.click(screen.getByTestId(tutorialTestid.hide));
    act(() => {
      for (const each of TUTORIAL_LESSONS) markLessonComplete(each.id);
    });
    const bar = screen.getByTestId(tutorialTestid.hidden);
    expect(bar).toHaveAttribute("data-complete", "true");
    expect(bar).toHaveTextContent("4 of 4 lessons complete");

    fireEvent.click(screen.getByTestId(tutorialTestid.show));
    const path = screen.getByTestId(tutorialTestid.path);
    expect(path).toHaveAttribute("data-complete", "true");
    expect(screen.queryByTestId(tutorialTestid.hide)).toBeNull();
    // With no Hide to go to, focus lands on the folded header's own button.
    const toggle = screen.getByTestId(tutorialTestid.pathToggle);
    expect(toggle).toHaveFocus();
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(readTutorialProgress().hiddenChoice?.hidden).toBe(false);
  });
});
