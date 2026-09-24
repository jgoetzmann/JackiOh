// The viewer's effects settings (docs/polish/1-animations.md, Surface S3): speed (R201), intensity
// and a motion override. They are a per-viewer presentation preference, so they live in this
// browser only, under `FX_SETTINGS_KEY` in `localStorage`. Task 7's settings panel mounts
// `useFxSettings` at integration; the animation runner reads `getFxSettings()` at every enqueue.
//
// Storage is optional. A missing `window`, a throwing `localStorage` getter (private mode, blocked
// site data), a quota error on write or unparsable JSON all fall back to the defaults or to the
// in-memory value, and nothing here ever throws because of it. Every value read back is normalized
// field by field, so a stale or hand-edited entry can never put the runner outside R201's range.

import { useSyncExternalStore } from "react";

import { FX_INTENSITY_SCALE, FX_SETTINGS_KEY, FX_SPEED_DEFAULT, FX_SPEED_MAX, FX_SPEED_MIN } from "./constants.ts";

export type FxIntensity = "off" | "low" | "normal" | "high";
export type FxMotion = "system" | "reduce";
export type FxSettings = { speed: number; intensity: FxIntensity; motion: FxMotion };

export const DEFAULT_FX_SETTINGS: FxSettings = {
  speed: FX_SPEED_DEFAULT,
  intensity: "normal",
  motion: "system",
};
Object.freeze(DEFAULT_FX_SETTINGS);

/** A finite number clamped to [FX_SPEED_MIN, FX_SPEED_MAX]; anything else is the default speed. */
export function normalizeSpeed(speed: unknown): number {
  if (typeof speed !== "number" || !Number.isFinite(speed)) return FX_SPEED_DEFAULT;
  return Math.min(FX_SPEED_MAX, Math.max(FX_SPEED_MIN, speed));
}

function normalizeIntensity(intensity: unknown): FxIntensity {
  if (typeof intensity === "string" && Object.prototype.hasOwnProperty.call(FX_INTENSITY_SCALE, intensity)) {
    return intensity as FxIntensity;
  }
  return DEFAULT_FX_SETTINGS.intensity;
}

function normalizeMotion(motion: unknown): FxMotion {
  return motion === "system" || motion === "reduce" ? motion : DEFAULT_FX_SETTINGS.motion;
}

/** Field by field: each unknown or missing value becomes its default, and speed is clamped. */
export function normalizeFxSettings(raw: unknown): FxSettings {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return DEFAULT_FX_SETTINGS;
  const record = raw as Record<string, unknown>;
  return {
    speed: normalizeSpeed(record.speed),
    intensity: normalizeIntensity(record.intensity),
    motion: normalizeMotion(record.motion),
  };
}

/** `window.localStorage`, or null when there is no window or the getter throws. */
function defaultStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Reads `FX_SETTINGS_KEY` from `storage` (the page's `localStorage` when omitted; `null` means no
 * storage at all). Absent, throwing or unparsable storage gives `DEFAULT_FX_SETTINGS` itself (it is
 * frozen, and `setFxSettings` always builds a new object, so sharing it is safe).
 */
export function loadFxSettings(storage?: Storage | null): FxSettings {
  try {
    const store = storage === undefined ? defaultStorage() : storage;
    if (store === null) return DEFAULT_FX_SETTINGS;
    const text = store.getItem(FX_SETTINGS_KEY);
    if (text === null) return DEFAULT_FX_SETTINGS;
    return normalizeFxSettings(JSON.parse(text));
  } catch {
    return DEFAULT_FX_SETTINGS;
  }
}

function persist(settings: FxSettings): void {
  try {
    const store = defaultStorage();
    if (store === null) return;
    store.setItem(FX_SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Quota, private mode or blocked storage: the setting still holds in memory for this page.
  }
}

let current: FxSettings | null = null;
const listeners = new Set<(settings: FxSettings) => void>();

/** The in-memory current value, loaded from storage once, on first read. */
export function getFxSettings(): FxSettings {
  if (current === null) current = loadFxSettings();
  return current;
}

/** Merges `patch` over the current value, normalizes, persists in try/catch and notifies synchronously. */
export function setFxSettings(patch: Partial<FxSettings>): FxSettings {
  const merged: Record<string, unknown> = { ...getFxSettings() };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) merged[key] = value;
  }
  const next = normalizeFxSettings(merged);
  current = next;
  persist(next);
  for (const listener of [...listeners]) listener(next);
  return next;
}

export function subscribeFxSettings(listener: (settings: FxSettings) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The current settings and a setter; re-renders whenever `setFxSettings` runs. */
export function useFxSettings(): readonly [FxSettings, (patch: Partial<FxSettings>) => void] {
  const settings = useSyncExternalStore(subscribeFxSettings, getFxSettings, getFxSettings);
  return [settings, setFxSettings] as const;
}

/** Test seam: drops the in-memory value and listeners so the next read reloads storage. */
export function resetFxSettingsForTests(): void {
  current = null;
  listeners.clear();
}
