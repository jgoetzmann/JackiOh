// The end of a lesson (tutorial/TutorialResult.tsx): a win completes the lesson and offers the next
// one, a loss offers the lesson's tip and Retry.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TUTORIAL_LESSONS, type TutorialLesson } from "./lessons.ts";
import { __resetTutorialProgressForTests, lessonStatus, readTutorialProgress } from "./progress.ts";
import { tutorialTestid } from "./testids.ts";
import { TutorialResult } from "./TutorialResult.tsx";

function lesson(number: number): TutorialLesson {
  const found = TUTORIAL_LESSONS.find((candidate) => candidate.number === number);
  if (found === undefined) throw new Error(`no lesson ${String(number)}`);
  return found;
}

function handlers() {
  return {
    onNext: vi.fn(),
    onRetry: vi.fn(),
    onBack: vi.fn(),
    onPlayPractice: vi.fn(),
    onViewBoard: vi.fn(),
  };
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

describe("the end of a lesson", () => {
  it("a win completes the lesson, names what it opened and offers the next lesson", () => {
    const on = handlers();
    render(
      <TutorialResult
        result={{ winner: "p1", reason: "hero-death" }}
        viewer="p1"
        lesson={lesson(2)}
        next={lesson(3)}
        unlockedNow
        {...on}
      />,
    );
    const dialog = screen.getByTestId(tutorialTestid.result);
    expect(dialog).toHaveAttribute("role", "dialog");
    expect(dialog).toHaveAttribute("data-outcome", "win");
    expect(dialog).toHaveAccessibleName("Lesson complete");
    expect(dialog).toHaveTextContent(`Lesson 3: ${lesson(3).title} is unlocked.`);
    expect(readTutorialProgress().completed).toContain(lesson(2).id);
    expect(lessonStatus(readTutorialProgress(), lesson(2))).toBe("completed");

    const next = screen.getByTestId(tutorialTestid.next);
    expect(next).toHaveTextContent("Next lesson");
    expect(next).toHaveFocus();
    fireEvent.click(next);
    expect(on.onNext).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId(tutorialTestid.back));
    expect(on.onBack).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId(tutorialTestid.retry)).toBeNull();
  });

  it("a replayed win says what is next rather than what it unlocked", () => {
    render(
      <TutorialResult
        result={{ winner: "p2", reason: "hero-death" }}
        viewer="p2"
        lesson={lesson(1)}
        next={lesson(2)}
        unlockedNow={false}
        {...handlers()}
      />,
    );
    expect(screen.getByTestId(tutorialTestid.result)).toHaveTextContent(`Next up: Lesson 2: ${lesson(2).title}.`);
  });

  it("the last lesson won completes the tutorial and offers a practice game instead of Next", () => {
    const on = handlers();
    const last = lesson(TUTORIAL_LESSONS.length);
    render(
      <TutorialResult result={{ winner: "p1", reason: "hero-death" }} viewer="p1" lesson={last} next={undefined} unlockedNow={false} {...on} />,
    );
    expect(screen.getByTestId(tutorialTestid.result)).toHaveAccessibleName("Tutorial complete");
    expect(screen.queryByTestId(tutorialTestid.next)).toBeNull();
    fireEvent.click(screen.getByTestId(tutorialTestid.playPractice));
    expect(on.onPlayPractice).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId(tutorialTestid.back)).toBeInTheDocument();
  });

  it("a loss is Not quite, with the lesson's tip and Retry, and completes nothing", () => {
    const on = handlers();
    render(
      <TutorialResult
        result={{ winner: "p2", reason: "hero-death" }}
        viewer="p1"
        lesson={lesson(1)}
        next={lesson(2)}
        unlockedNow
        {...on}
      />,
    );
    const dialog = screen.getByTestId(tutorialTestid.result);
    expect(dialog).toHaveAttribute("data-outcome", "loss");
    expect(dialog).toHaveAccessibleName("Not quite");
    expect(dialog).toHaveTextContent(`Tip: ${lesson(1).retryTip}`);
    expect(screen.queryByTestId(tutorialTestid.next)).toBeNull();
    const retry = screen.getByTestId(tutorialTestid.retry);
    expect(retry).toHaveFocus();
    fireEvent.click(retry);
    expect(on.onRetry).toHaveBeenCalledTimes(1);
    expect(readTutorialProgress().completed).toEqual([]);
  });

  it("a draw is Not quite too", () => {
    render(
      <TutorialResult result={{ winner: "draw", reason: "turn-cap" }} viewer="p1" lesson={lesson(1)} next={lesson(2)} unlockedNow {...handlers()} />,
    );
    expect(screen.getByTestId(tutorialTestid.result)).toHaveAttribute("data-outcome", "draw");
    expect(screen.getByTestId(tutorialTestid.retry)).toBeInTheDocument();
    expect(readTutorialProgress().completed).toEqual([]);
  });

  it("View the board and Escape close it", () => {
    const on = handlers();
    render(
      <TutorialResult result={{ winner: "p2", reason: "hero-death" }} viewer="p1" lesson={lesson(1)} next={lesson(2)} unlockedNow {...on} />,
    );
    fireEvent.click(screen.getByTestId(tutorialTestid.viewBoard));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(on.onViewBoard).toHaveBeenCalledTimes(2);
  });
});
