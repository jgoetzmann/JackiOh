// The player's client-side preferences (polish task 7, docs/polish/7-mobile-ux.md S8, B19–B22).
//
// One module-level store read through `useSyncExternalStore`, so no React context is needed and
// code outside React (the drag layer's `pointerdown`) can call `readSettings()` directly. These
// are input and display preferences only: nothing here changes a rule or reaches the server
// (CLAUDE.md rule 7).
//
// `localStorage` is untrusted and may be missing. Private windows, blocked site data and
// sandboxed frames make it throw on access, and a hand-edited value can hold anything. Every
// access sits in try/catch: a failed read means "nothing stored", and a failed write keeps the
// in-memory value, so a player without storage still gets working toggles for the session.

import { useSyncExternalStore } from "react";

export type Settings = {
  /** Gameplay. Drag cards and units to act. Off: tap to select, then the Prompt pickers. */
  dragToPlay: boolean;
  /**
   * Gameplay. Ask before ending the turn while a card is playable or a unit can attack. Default
   * false, and it must stay false: every e2e spec ends its turns with one click.
   */
  confirmEndTurn: boolean;
  /** Gameplay. Hovering a hand card with a fine pointer lifts it; task 6's hover inspect reads it. */
  hoverPreviews: boolean;
  /** Visuals. Force reduced motion on top of the OS preference (`--anim-scale: 0`). */
  reduceMotion: boolean;
};

export type SettingKey = keyof Settings;

export const SETTINGS_STORAGE_KEY = "jackioh.settings";

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  dragToPlay: true,
  confirmEndTurn: false,
  hoverPreviews: true,
  reduceMotion: false,
});

/** The keys `parseSettings` keeps, in the order they are written to storage. */
const SETTING_KEYS: readonly SettingKey[] = [
  "dragToPlay",
  "confirmEndTurn",
  "hoverPreviews",
  "reduceMotion",
];

/** `<html data-reduce-motion="true">`; settings.css maps it to `--anim-scale: 0` (B22). */
const REDUCE_MOTION_ATTRIBUTE = "data-reduce-motion";

/** The cached snapshot. `null` until the first read, and again after `__resetSettingsForTests`. */
let snapshot: Settings | null = null;

/** One entry per subscription, so subscribing the same function twice unsubscribes cleanly. */
const subscriptions = new Set<() => void>();

let storageListening = false;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Tolerant: unknown keys dropped, wrong-typed or missing values replaced by the default. A JSON
 * string is parsed first, so the raw storage value can be passed straight in. Never throws.
 */
export function parseSettings(raw: unknown): Settings {
  const next: Settings = { ...DEFAULT_SETTINGS };
  try {
    let value: unknown = raw;
    if (typeof value === "string") {
      try {
        value = JSON.parse(value) as unknown;
      } catch {
        value = null;
      }
    }
    if (!isRecord(value)) return next;
    for (const key of SETTING_KEYS) {
      const candidate = value[key];
      if (typeof candidate === "boolean") next[key] = candidate;
    }
    return next;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function storageOrNull(): Storage | null {
  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

/** What storage holds now, as a frozen snapshot. Anything unreadable reads as the defaults. */
function loadStored(): Settings {
  try {
    const storage = storageOrNull();
    if (storage === null) return DEFAULT_SETTINGS;
    const raw = storage.getItem(SETTINGS_STORAGE_KEY);
    if (raw === null) return DEFAULT_SETTINGS;
    return Object.freeze(parseSettings(raw));
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function persist(settings: Settings): void {
  try {
    storageOrNull()?.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Quota, private mode or blocked storage: the in-memory value stays in force.
  }
}

function applyToDocument(settings: Settings): void {
  const root = document.documentElement;
  if (settings.reduceMotion) root.setAttribute(REDUCE_MOTION_ATTRIBUTE, "true");
  else root.removeAttribute(REDUCE_MOTION_ATTRIBUTE);
}

function sameSettings(a: Settings, b: Settings): boolean {
  return SETTING_KEYS.every((key) => a[key] === b[key]);
}

function notify(): void {
  for (const subscription of [...subscriptions]) subscription();
}

/**
 * Install `next` as the snapshot. The object is kept when nothing changed, because
 * `useSyncExternalStore` re-renders on identity; every subscriber is still told once per write.
 */
function commit(next: Settings): Settings {
  const current = readSettings();
  const settled = sameSettings(current, next) ? current : Object.freeze({ ...next });
  snapshot = settled;
  persist(settled);
  applyToDocument(settled);
  notify();
  return settled;
}

/** The current snapshot. Same object until something changes. Loads storage on first call. */
export function readSettings(): Settings {
  if (snapshot === null) {
    snapshot = loadStored();
    applyToDocument(snapshot);
  }
  return snapshot;
}

/** Merge, persist (try/catch), re-apply <html> attributes, notify each subscriber once. */
export function writeSettings(patch: Partial<Settings>): Settings {
  const next: Settings = { ...readSettings() };
  for (const key of SETTING_KEYS) {
    const value: unknown = patch[key];
    if (typeof value === "boolean") next[key] = value;
  }
  return commit(next);
}

export function resetSettings(): Settings {
  return commit({ ...DEFAULT_SETTINGS });
}

/**
 * Another tab wrote the key (or cleared storage, which reports `key === null`). The event's
 * `newValue` is used when it carries one; otherwise storage is read again.
 */
function onStorage(event: StorageEvent): void {
  if (typeof event.key === "string" && event.key !== SETTINGS_STORAGE_KEY) return;
  const next =
    typeof event.newValue === "string" ? Object.freeze(parseSettings(event.newValue)) : loadStored();
  const current = snapshot;
  const settled = current !== null && sameSettings(current, next) ? current : next;
  snapshot = settled;
  applyToDocument(settled);
  notify();
}

/** The `storage` listener is on `window` only while at least one subscriber exists. */
export function subscribeSettings(listener: () => void): () => void {
  const subscription = (): void => {
    listener();
  };
  subscriptions.add(subscription);
  if (!storageListening) {
    window.addEventListener("storage", onStorage);
    storageListening = true;
  }
  return () => {
    subscriptions.delete(subscription);
    if (subscriptions.size === 0 && storageListening) {
      window.removeEventListener("storage", onStorage);
      storageListening = false;
    }
  };
}

export function useSettings(): Settings {
  return useSyncExternalStore(subscribeSettings, readSettings, readSettings);
}

export function useSetting<K extends SettingKey>(key: K): Settings[K] {
  const read = (): Settings[K] => readSettings()[key];
  return useSyncExternalStore(subscribeSettings, read, read);
}

/** Test seam: forget the cached snapshot so the next read re-parses storage. */
export function __resetSettingsForTests(): void {
  snapshot = null;
  document.documentElement.removeAttribute(REDUCE_MOTION_ATTRIBUTE);
}
