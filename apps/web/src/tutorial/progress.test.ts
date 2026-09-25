// The tutorial's progress store (tutorial/progress.ts): R294.
//
// Progress is kept on the device only, in localStorage, read and written inside try/catch, parsed
// tolerantly, and synced across tabs by the `storage` event. The unlock rule is lesson 1 always,
// lesson N once lesson N-1 is completed, and completed stays completed.

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TUTORIAL_PROGRESS_KEY, TUTORIAL_PROGRESS_VERSION } from "./config.ts";
import { TUTORIAL_LESSONS, type TutorialLesson } from "./lessons.ts";
import {
  __resetTutorialProgressForTests,
  lessonStatus,
  markLessonComplete,
  nextLessonToPlay,
  parseTutorialProgress,
  readTutorialProgress,
  resetTutorialProgress,
  useTutorialProgress,
} from "./progress.ts";

function lesson(number: number): TutorialLesson {
  const found = TUTORIAL_LESSONS.find((candidate) => candidate.number === number);
  if (found === undefined) throw new Error(`no lesson ${String(number)}`);
  return found;
}

function stored(): unknown {
  const raw = window.localStorage.getItem(TUTORIAL_PROGRESS_KEY);
  return raw === null ? null : (JSON.parse(raw) as unknown);
}

beforeEach(() => {
  window.localStorage.clear();
  __resetTutorialProgressForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  __resetTutorialProgressForTests();
});

describe("R294 tutorial progress is kept on this device", () => {
  it("R294 a won lesson is stored under jackioh.tutorial.v1 as { v: 1, completed } and read back after a reload", () => {
    expect(TUTORIAL_PROGRESS_KEY).toBe("jackioh.tutorial.v1");
    expect(TUTORIAL_PROGRESS_VERSION).toBe(1);
    const first = lesson(1);

    markLessonComplete(first.id);
    expect(stored()).toEqual({ v: 1, completed: [first.id] });

    // A reload: the module forgets its snapshot and reads storage again.
    __resetTutorialProgressForTests();
    expect(readTutorialProgress().completed).toEqual([first.id]);
  });

  it("R294 nothing is sent anywhere: no fetch and no socket while progress is read and written", () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error("progress needs no server")));
    vi.stubGlobal("fetch", fetchSpy);
    const socketSpy = vi.fn();
    vi.stubGlobal(
      "WebSocket",
      class {
        constructor() {
          socketSpy();
        }
      },
    );

    readTutorialProgress();
    markLessonComplete(lesson(1).id);
    resetTutorialProgress();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(socketSpy).not.toHaveBeenCalled();
  });

  it("R294 a localStorage that throws reads as no progress, and a refused write keeps the win for the session", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("site data is blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("site data is blocked");
    });

    expect(readTutorialProgress().completed).toEqual([]);
    expect(() => markLessonComplete(lesson(1).id)).not.toThrow();
    expect(readTutorialProgress().completed).toEqual([lesson(1).id]);
    expect(lessonStatus(readTutorialProgress(), lesson(2))).toBe("unlocked");
  });

  it("R294 a window whose localStorage accessor itself throws still works in memory", () => {
    const descriptor = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new Error("SecurityError");
      },
    });
    try {
      __resetTutorialProgressForTests();
      expect(readTutorialProgress().completed).toEqual([]);
      markLessonComplete(lesson(1).id);
      expect(readTutorialProgress().completed).toEqual([lesson(1).id]);
    } finally {
      if (descriptor !== undefined) Object.defineProperty(window, "localStorage", descriptor);
      else Reflect.deleteProperty(window, "localStorage");
    }
  });

  it("R294 the unlock order: lesson 1 always, lesson N once lesson N-1 is completed, completed stays completed", () => {
    const [one, two, three, four] = [lesson(1), lesson(2), lesson(3), lesson(4)];
    let progress = readTutorialProgress();
    expect(TUTORIAL_LESSONS.map((each) => lessonStatus(progress, each))).toEqual([
      "unlocked",
      "locked",
      "locked",
      "locked",
    ]);
    expect(nextLessonToPlay(progress)?.id).toBe(one.id);

    progress = markLessonComplete(one.id);
    expect([one, two, three, four].map((each) => lessonStatus(progress, each))).toEqual([
      "completed",
      "unlocked",
      "locked",
      "locked",
    ]);
    expect(nextLessonToPlay(progress)?.id).toBe(two.id);

    // Winning lesson 3 by URL (it was never unlocked) completes it, and opens lesson 4; lesson 2 is
    // still merely open, since only its own win completes it.
    progress = markLessonComplete(three.id);
    expect([one, two, three, four].map((each) => lessonStatus(progress, each))).toEqual([
      "completed",
      "unlocked",
      "completed",
      "unlocked",
    ]);

    // Winning a completed lesson again changes nothing; nothing ever un-completes one but a reset.
    const again = markLessonComplete(one.id);
    expect(again).toBe(progress);
    expect(lessonStatus(again, one)).toBe("completed");

    progress = resetTutorialProgress();
    expect(TUTORIAL_LESSONS.map((each) => lessonStatus(progress, each))).toEqual([
      "unlocked",
      "locked",
      "locked",
      "locked",
    ]);
    expect(stored()).toEqual({ v: 1, completed: [] });
  });

  it("R294 the parse is tolerant: wrong shapes and versions are no progress, unknown ids are dropped", () => {
    const first = lesson(1).id;
    const second = lesson(2).id;
    expect(parseTutorialProgress("{not json").completed).toEqual([]);
    expect(parseTutorialProgress(null).completed).toEqual([]);
    expect(parseTutorialProgress([first]).completed).toEqual([]);
    expect(parseTutorialProgress({ completed: [first] }).completed).toEqual([]);
    expect(parseTutorialProgress({ v: 2, completed: [first] }).completed).toEqual([]);
    expect(parseTutorialProgress({ v: 1, completed: first }).completed).toEqual([]);
    expect(parseTutorialProgress({ v: 1, completed: [first, 7, null, "no-such-lesson", first] }).completed).toEqual([
      first,
    ]);
    // Stored in path order whatever order the value lists them in.
    expect(parseTutorialProgress(JSON.stringify({ v: 1, completed: [second, first] })).completed).toEqual([
      first,
      second,
    ]);

    window.localStorage.setItem(TUTORIAL_PROGRESS_KEY, JSON.stringify({ v: 1, completed: ["ghost", second] }));
    __resetTutorialProgressForTests();
    expect(readTutorialProgress().completed).toEqual([second]);
    expect(lessonStatus(readTutorialProgress(), lesson(3))).toBe("unlocked");
  });

  it("R294 a lesson won in another tab reaches this one through the storage event", () => {
    const { result } = renderHook(() => useTutorialProgress());
    expect(result.current.completed).toEqual([]);

    const value = JSON.stringify({ v: 1, completed: [lesson(1).id] });
    act(() => {
      window.localStorage.setItem(TUTORIAL_PROGRESS_KEY, value);
      window.dispatchEvent(new StorageEvent("storage", { key: TUTORIAL_PROGRESS_KEY, newValue: value }));
    });
    expect(result.current.completed).toEqual([lesson(1).id]);

    // Another key is not ours; a cleared storage (key null) is re-read.
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: "jackioh.settings", newValue: "{}" }));
    });
    expect(result.current.completed).toEqual([lesson(1).id]);
    act(() => {
      window.localStorage.clear();
      window.dispatchEvent(new StorageEvent("storage", { key: null }));
    });
    expect(result.current.completed).toEqual([]);
  });

  it("R294 the hook re-renders on this tab's own win and keeps its snapshot otherwise", () => {
    const { result } = renderHook(() => useTutorialProgress());
    const before = result.current;
    act(() => {
      markLessonComplete("no-such-lesson");
    });
    expect(result.current).toBe(before);
    act(() => {
      markLessonComplete(lesson(1).id);
    });
    expect(result.current.completed).toEqual([lesson(1).id]);
  });
});
