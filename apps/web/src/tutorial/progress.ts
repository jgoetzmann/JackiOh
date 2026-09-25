// The tutorial's progress: which lessons this device has completed (SPEC §9.10, R294).
//
// Kept on the device and nowhere else. Nothing here talks to a server: a lesson is a practice game
// (§9.9), which records no result, and the lesson path is a guide rather than a gate on anything
// the rules or the server care about. It sits in `localStorage[TUTORIAL_PROGRESS_KEY]` as
// `{ v: 1, completed: string[] }`, the same way the settings store keeps its preferences
// (settings/store.ts):
//
//  - `localStorage` is untrusted and may be missing. Private windows, blocked site data and
//    sandboxed frames make it throw on access, and a hand-edited value can hold anything. Every
//    access sits in try/catch: a failed read means "no progress", and a failed write keeps the
//    in-memory value, so a player without storage still walks the path for the session.
//  - The parse is tolerant: a value of the wrong shape or version is no progress, and an id that
//    names no lesson is dropped.
//  - A `storage` event (another tab finished a lesson) re-reads the key and re-renders.
//
// Lesson 1 is always open; lesson N opens once lesson N-1 is completed; a completed lesson stays
// completed. That is the whole unlock rule, and `lessonStatus` is its one owner.

import { useSyncExternalStore } from "react";

import { TUTORIAL_PROGRESS_KEY, TUTORIAL_PROGRESS_VERSION } from "./config.ts";
import { TUTORIAL_LESSONS, type TutorialLesson } from "./lessons.ts";

export type TutorialProgress = {
  /** Completed lesson ids, in path order, each once. */
  readonly completed: readonly string[];
};

export type LessonStatus = "locked" | "unlocked" | "completed";

const EMPTY: TutorialProgress = Object.freeze({ completed: Object.freeze([]) as readonly string[] });

/** The cached snapshot; `null` until the first read, and again after the test seam. */
let snapshot: TutorialProgress | null = null;

const listeners = new Set<() => void>();
let storageListening = false;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Known ids only, each once, in the path's order. */
function normalise(ids: Iterable<unknown>): TutorialProgress {
  const wanted = new Set<string>();
  for (const id of ids) if (typeof id === "string") wanted.add(id);
  const completed = TUTORIAL_LESSONS.filter((lesson) => wanted.has(lesson.id)).map((lesson) => lesson.id);
  return completed.length === 0 ? EMPTY : Object.freeze({ completed: Object.freeze(completed) });
}

/**
 * Tolerant: anything but `{ v: TUTORIAL_PROGRESS_VERSION, completed: [...] }` is no progress, and
 * ids that name no lesson are dropped. A JSON string is parsed first. Never throws.
 */
export function parseTutorialProgress(raw: unknown): TutorialProgress {
  try {
    let value: unknown = raw;
    if (typeof value === "string") {
      try {
        value = JSON.parse(value) as unknown;
      } catch {
        return EMPTY;
      }
    }
    if (!isRecord(value) || value.v !== TUTORIAL_PROGRESS_VERSION || !Array.isArray(value.completed)) return EMPTY;
    return normalise(value.completed as unknown[]);
  } catch {
    return EMPTY;
  }
}

function storageOrNull(): Storage | null {
  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

function loadStored(): TutorialProgress {
  try {
    const raw = storageOrNull()?.getItem(TUTORIAL_PROGRESS_KEY) ?? null;
    return raw === null ? EMPTY : parseTutorialProgress(raw);
  } catch {
    return EMPTY;
  }
}

function persist(progress: TutorialProgress): void {
  try {
    storageOrNull()?.setItem(
      TUTORIAL_PROGRESS_KEY,
      JSON.stringify({ v: TUTORIAL_PROGRESS_VERSION, completed: progress.completed }),
    );
  } catch {
    // Quota, private mode or blocked storage: the in-memory value stays in force.
  }
}

function sameProgress(a: TutorialProgress, b: TutorialProgress): boolean {
  return a.completed.length === b.completed.length && a.completed.every((id, at) => b.completed[at] === id);
}

function notify(): void {
  for (const listener of [...listeners]) listener();
}

/** The current snapshot: the same object until something changes. Reads storage on first call. */
export function readTutorialProgress(): TutorialProgress {
  if (snapshot === null) snapshot = loadStored();
  return snapshot;
}

function commit(next: TutorialProgress): TutorialProgress {
  const current = readTutorialProgress();
  const settled = sameProgress(current, next) ? current : next;
  snapshot = settled;
  persist(settled);
  if (settled !== current) notify();
  return settled;
}

/** Record a won lesson. Idempotent; an unknown id changes nothing. */
export function markLessonComplete(id: string): TutorialProgress {
  return commit(normalise([...readTutorialProgress().completed, id]));
}

/** Forget every completed lesson (the whole path locks again behind lesson 1). */
export function resetTutorialProgress(): TutorialProgress {
  return commit(EMPTY);
}

/** Another tab wrote the key, or cleared storage (`key === null`). */
function onStorage(event: StorageEvent): void {
  if (typeof event.key === "string" && event.key !== TUTORIAL_PROGRESS_KEY) return;
  const next = typeof event.newValue === "string" ? parseTutorialProgress(event.newValue) : loadStored();
  const current = snapshot;
  if (current !== null && sameProgress(current, next)) return;
  snapshot = next;
  notify();
}

/** The `storage` listener is on `window` only while someone is subscribed. */
export function subscribeTutorialProgress(listener: () => void): () => void {
  const subscription = (): void => {
    listener();
  };
  listeners.add(subscription);
  if (!storageListening) {
    window.addEventListener("storage", onStorage);
    storageListening = true;
  }
  return () => {
    listeners.delete(subscription);
    if (listeners.size === 0 && storageListening) {
      window.removeEventListener("storage", onStorage);
      storageListening = false;
    }
  };
}

export function useTutorialProgress(): TutorialProgress {
  return useSyncExternalStore(subscribeTutorialProgress, readTutorialProgress, readTutorialProgress);
}

/** Lesson 1 is always open; lesson N opens once lesson N-1 is completed; completed stays completed. */
export function lessonStatus(progress: TutorialProgress, lesson: TutorialLesson): LessonStatus {
  if (progress.completed.includes(lesson.id)) return "completed";
  if (lesson.number <= 1) return "unlocked";
  const previous = TUTORIAL_LESSONS.find((candidate) => candidate.number === lesson.number - 1);
  return previous !== undefined && progress.completed.includes(previous.id) ? "unlocked" : "locked";
}

/** The lesson to play next: the first open lesson not yet completed, if any. */
export function nextLessonToPlay(progress: TutorialProgress): TutorialLesson | undefined {
  return TUTORIAL_LESSONS.find((lesson) => lessonStatus(progress, lesson) === "unlocked");
}

/** Test seam: forget the cached snapshot so the next read re-parses storage. */
export function __resetTutorialProgressForTests(): void {
  snapshot = null;
}
