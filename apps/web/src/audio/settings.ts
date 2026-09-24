// The audio settings store (docs/polish/2-sound.md, Surface; B12, B13).
//
// One cached `AudioSettings` object, persisted as JSON under `localStorage["jackioh.audio.v1"]`.
// Every storage access sits inside try/catch: private windows, blocked site data and quota errors
// must never break the game, so a failed read gives the defaults and a failed write still updates
// memory. The cached object is frozen and replaced (never mutated) on each change, which is what
// lets `useSyncExternalStore` compare snapshots by identity. A "storage" event from another tab
// re-reads the key, so two open games share one mute switch.

import { useSyncExternalStore } from "react";

import { AUDIO_SETTINGS_KEY } from "./constants.ts";
import type { AudioSettings } from "./types.ts";

export const DEFAULT_AUDIO_SETTINGS: Readonly<AudioSettings> = Object.freeze({
  master: 0.8,
  sfx: 0.8,
  voice: 1,
  muted: false,
  voiceOn: true,
});

function level(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}

function flag(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/** Total: any input → valid settings. Each field independently: a finite number is clamped to [0,1],
 *  anything else takes the default; a boolean field that is not a boolean takes the default. */
export function parseAudioSettings(raw: unknown): AudioSettings {
  const o: Record<string, unknown> =
    typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  return {
    master: level(o.master, DEFAULT_AUDIO_SETTINGS.master),
    sfx: level(o.sfx, DEFAULT_AUDIO_SETTINGS.sfx),
    voice: level(o.voice, DEFAULT_AUDIO_SETTINGS.voice),
    muted: flag(o.muted, DEFAULT_AUDIO_SETTINGS.muted),
    voiceOn: flag(o.voiceOn, DEFAULT_AUDIO_SETTINGS.voiceOn),
  };
}

let cache: Readonly<AudioSettings> | null = null;

type Subscription = { fn: (s: AudioSettings) => void };
const subscriptions = new Set<Subscription>();
let storageHandler: ((event: Event) => void) | null = null;

function parseStored(text: string): Readonly<AudioSettings> {
  try {
    return Object.freeze(parseAudioSettings(JSON.parse(text)));
  } catch {
    return DEFAULT_AUDIO_SETTINGS;
  }
}

function readStoredText(): string | null {
  try {
    return window.localStorage.getItem(AUDIO_SETTINGS_KEY);
  } catch {
    return null;
  }
}

function loadFromStorage(): Readonly<AudioSettings> {
  const text = readStoredText();
  return text === null ? DEFAULT_AUDIO_SETTINGS : parseStored(text);
}

function notify(next: AudioSettings): void {
  for (const sub of [...subscriptions]) {
    try {
      sub.fn(next);
    } catch {
      // A throwing subscriber must not stop the others from hearing the change.
    }
  }
}

/** Cached after the first read. Reads localStorage[AUDIO_SETTINGS_KEY] inside try/catch. */
export function readAudioSettings(): AudioSettings {
  if (cache === null) cache = loadFromStorage();
  return cache;
}

/** Merges, parses (clamps), caches, persists as JSON inside try/catch, notifies each subscriber once. */
export function writeAudioSettings(patch: Partial<AudioSettings>): AudioSettings {
  const merged: Record<string, unknown> = { ...readAudioSettings() };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) merged[key] = value;
  }
  const next = Object.freeze(parseAudioSettings(merged));
  cache = next;
  try {
    window.localStorage.setItem(AUDIO_SETTINGS_KEY, JSON.stringify(next));
  } catch {
    // Storage is unavailable or full: the change still holds for this page.
  }
  notify(next);
  return next;
}

function installStorageListener(): void {
  if (storageHandler !== null) return;
  storageHandler = (event: Event) => {
    const key = (event as StorageEvent).key;
    // A null key is `localStorage.clear()` in another tab; any other key is not ours.
    if (key != null && key !== AUDIO_SETTINGS_KEY) return;
    const text = readStoredText();
    const next = text === null ? DEFAULT_AUDIO_SETTINGS : parseStored(text);
    cache = next;
    notify(next);
  };
  window.addEventListener("storage", storageHandler);
}

function removeStorageListener(): void {
  if (storageHandler === null) return;
  window.removeEventListener("storage", storageHandler);
  storageHandler = null;
}

/** The first subscription also installs one window "storage" listener for AUDIO_SETTINGS_KEY that re-reads and notifies. */
export function subscribeAudioSettings(listener: (s: AudioSettings) => void): () => void {
  const sub: Subscription = { fn: listener };
  subscriptions.add(sub);
  installStorageListener();
  return () => {
    subscriptions.delete(sub);
    if (subscriptions.size === 0) removeStorageListener();
  };
}

/** useSyncExternalStore over the store; the snapshot object is referentially stable until a change. */
export function useAudioSettings(): readonly [AudioSettings, (patch: Partial<AudioSettings>) => void] {
  const settings = useSyncExternalStore(subscribeAudioSettings, readAudioSettings, readAudioSettings);
  return [settings, writeAudioSettings] as const;
}

/** Drops the cache, every subscriber and the storage listener. Tests only. */
export function resetAudioSettingsForTests(): void {
  cache = null;
  subscriptions.clear();
  removeStorageListener();
}
