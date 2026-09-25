// The tutorial's progress: which lessons this device has completed, and whether the player hid the
// lesson path (SPEC §9.10, R294, R322).
//
// This module is the device's copy, and nothing in it talks to a server: a lesson is a practice
// game (§9.9), which records no result, and the lesson path is a guide rather than a gate on
// anything the rules or the server care about. An active account keeps a copy too (R320), and
// `accountSync.ts` merges the two through `adoptTutorialProgress` (R321): a union of completed
// lessons and the newest Hide/Show choice, so nothing here ever steps backwards but a reset. It sits
// in `localStorage[TUTORIAL_PROGRESS_KEY]` as `{ v: 1, completed: string[], hiddenChoice?: { hidden,
// at } }` (the choice only once one was made), the same way the settings store keeps its preferences
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

/** The player's explicit choice to hide or show the lesson path, and when it was made (epoch ms). */
export type TutorialHiddenChoice = {
  readonly hidden: boolean;
  readonly at: number;
};

export type TutorialProgress = {
  /** Completed lesson ids, in path order, each once. */
  readonly completed: readonly string[];
  /** The newest Hide/Show choice (R321, R322), or null while the player has made none. */
  readonly hiddenChoice: TutorialHiddenChoice | null;
};

export type LessonStatus = "locked" | "unlocked" | "completed";

const EMPTY: TutorialProgress = Object.freeze({
  completed: Object.freeze([]) as readonly string[],
  hiddenChoice: null,
});

/** The cached snapshot; `null` until the first read, and again after the test seam. */
let snapshot: TutorialProgress | null = null;

const listeners = new Set<() => void>();
let storageListening = false;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A choice as stored or as the account sends it: a boolean and a whole, non-negative epoch ms. */
function parseChoice(raw: unknown): TutorialHiddenChoice | null {
  if (!isRecord(raw)) return null;
  const { hidden, at } = raw;
  if (typeof hidden !== "boolean" || typeof at !== "number" || !Number.isSafeInteger(at) || at < 0) return null;
  return Object.freeze({ hidden, at });
}

/** Known ids only, each once, in the path's order; the choice as given. */
function normalise(ids: Iterable<unknown>, hiddenChoice: TutorialHiddenChoice | null = null): TutorialProgress {
  const wanted = new Set<string>();
  for (const id of ids) if (typeof id === "string") wanted.add(id);
  const completed = TUTORIAL_LESSONS.filter((lesson) => wanted.has(lesson.id)).map((lesson) => lesson.id);
  if (completed.length === 0 && hiddenChoice === null) return EMPTY;
  return Object.freeze({ completed: Object.freeze(completed), hiddenChoice });
}

/**
 * Tolerant: anything but `{ v: TUTORIAL_PROGRESS_VERSION, completed: [...] }` is no progress, and
 * ids that name no lesson are dropped. A `hiddenChoice` that is not `{ hidden: boolean, at: whole
 * epoch ms }` reads as no choice. A JSON string is parsed first. Never throws.
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
    return normalise(value.completed as unknown[], parseChoice(value.hiddenChoice));
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
      JSON.stringify({
        v: TUTORIAL_PROGRESS_VERSION,
        completed: progress.completed,
        // Written only once a choice was made, so a device that never hid the path keeps R294's shape.
        ...(progress.hiddenChoice === null ? {} : { hiddenChoice: progress.hiddenChoice }),
      }),
    );
  } catch {
    // Quota, private mode or blocked storage: the in-memory value stays in force.
  }
}

function sameChoice(a: TutorialHiddenChoice | null, b: TutorialHiddenChoice | null): boolean {
  return a === null || b === null ? a === b : a.hidden === b.hidden && a.at === b.at;
}

function sameProgress(a: TutorialProgress, b: TutorialProgress): boolean {
  return (
    a.completed.length === b.completed.length &&
    a.completed.every((id, at) => b.completed[at] === id) &&
    sameChoice(a.hiddenChoice, b.hiddenChoice)
  );
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
  const current = readTutorialProgress();
  return commit(normalise([...current.completed, id], current.hiddenChoice));
}

/**
 * R322: the player hides (or shows) the lesson path. The choice is stamped with this device's
 * clock, and always later than the choice it replaces, so under R321's "newest choice wins" a
 * choice made here is never older than the one it overrode, even if the clock has stepped back.
 */
export function setTutorialHidden(hidden: boolean, now: number = Date.now()): TutorialProgress {
  const current = readTutorialProgress();
  const at = Math.max(Math.floor(now), (current.hiddenChoice?.at ?? -1) + 1);
  return commit(normalise(current.completed, Object.freeze({ hidden, at })));
}

/** R322: whether the player has hidden the lesson path. */
export function isTutorialHidden(progress: TutorialProgress): boolean {
  return progress.hiddenChoice?.hidden === true;
}

/** Forget every completed lesson and any Hide/Show choice (the whole path locks again behind lesson 1). */
export function resetTutorialProgress(): TutorialProgress {
  return commit(EMPTY);
}

/** Progress as another copy holds it (the account's, R320): any lesson ids, and a choice or none. */
export type TutorialProgressLike = {
  readonly completed: readonly string[];
  readonly hiddenChoice: TutorialHiddenChoice | null;
};

/** `a`'s choice unless `b`'s was made strictly later; a tie keeps `a`'s. */
function newerChoice(a: TutorialHiddenChoice | null, b: TutorialHiddenChoice | null): TutorialHiddenChoice | null {
  if (b === null) return a;
  if (a === null || b.at > a.at) return b;
  return a;
}

/**
 * R321's merge of two copies: the union of their completed lessons (known ids only, in path order)
 * and the newer of their Hide/Show choices, a tie keeping `a`'s. Neither copy loses anything it
 * could show: a completed lesson stays completed, and an older choice never undoes a newer one.
 */
export function mergeTutorialProgress(a: TutorialProgressLike, b: TutorialProgressLike): TutorialProgress {
  return normalise([...a.completed, ...b.completed], newerChoice(parseChoice(a.hiddenChoice), parseChoice(b.hiddenChoice)));
}

/**
 * R321: whether `device` holds something `account` lacks, and so should be sent up: a completed
 * lesson the account does not list, or a choice made later than the account's that says otherwise
 * (a later choice that says the same needs no write).
 */
export function accountLacks(account: TutorialProgressLike, device: TutorialProgress): boolean {
  const listed = new Set(account.completed);
  if (device.completed.some((id) => !listed.has(id))) return true;
  const mine = device.hiddenChoice;
  const theirs = parseChoice(account.hiddenChoice);
  if (mine === null) return false;
  return theirs === null || (mine.hidden !== theirs.hidden && mine.at > theirs.at);
}

/**
 * R321: take another copy's progress into this device's, as the merge above: nothing here steps
 * backwards, and a copy that adds nothing changes nothing (the same snapshot, no re-render).
 */
export function adoptTutorialProgress(other: TutorialProgressLike): TutorialProgress {
  return commit(mergeTutorialProgress(readTutorialProgress(), other));
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
