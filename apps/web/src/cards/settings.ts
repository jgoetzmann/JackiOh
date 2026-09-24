// Card presentation settings (B28). One localStorage key; every storage access sits in try/catch,
// because storage can be missing, full, or throw on access (private mode, sandboxed frames). When
// storage refuses a write the value lives on in memory, so the toggle still works for this page.
// Task 7's settings panel mounts CARD_SETTINGS_FIELDS at integration.

import { useSyncExternalStore } from "react";

export type CardSettings = { hoverPreviews: boolean; animatedFoil: boolean };

export const CARD_SETTINGS_KEY = "jackioh.cards.settings.v1";

export const CARD_SETTINGS_DEFAULTS: Readonly<CardSettings> = Object.freeze({
  hoverPreviews: true,
  animatedFoil: true,
});

type CardSettingsField = {
  key: keyof CardSettings;
  section: "gameplay" | "visuals";
  label: string;
  description: string;
};

export const CARD_SETTINGS_FIELDS: readonly CardSettingsField[] = [
  {
    key: "hoverPreviews",
    section: "gameplay",
    label: "Hover previews",
    description: "Rest the pointer on a card to see it enlarged, with its keywords explained.",
  },
  {
    key: "animatedFoil",
    section: "visuals",
    label: "Animated foil",
    description: "Mythic and Radiant cards shimmer. Off shows the foil standing still.",
  },
];

const SETTING_KEYS: readonly (keyof CardSettings)[] = ["hoverPreviews", "animatedFoil"];

/**
 * The value of a write that storage refused, and what storage held at that moment (`undefined`
 * when it could not be read at all). Storage wins again as soon as it holds something else.
 */
let fallback: { value: CardSettings; raw: string | null | undefined } | null = null;

const listeners = new Set<() => void>();

/** What storage holds under the key: `null` when empty, `undefined` when storage is unusable. */
function readRaw(): string | null | undefined {
  try {
    return window.localStorage.getItem(CARD_SETTINGS_KEY);
  } catch {
    return undefined;
  }
}

function writeRaw(raw: string): boolean {
  try {
    window.localStorage.setItem(CARD_SETTINGS_KEY, raw);
    return true;
  } catch {
    return false;
  }
}

/** Parsed settings with every missing or mistyped key taken from the defaults. */
function parse(raw: string): CardSettings {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return CARD_SETTINGS_DEFAULTS;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) return CARD_SETTINGS_DEFAULTS;
  const record = data as Record<string, unknown>;
  const settings: CardSettings = { ...CARD_SETTINGS_DEFAULTS };
  for (const key of SETTING_KEYS) {
    const value = record[key];
    if (typeof value === "boolean") settings[key] = value;
  }
  return settings;
}

export function readCardSettings(): CardSettings {
  const raw = readRaw();
  if (fallback !== null) {
    if (raw === undefined || raw === fallback.raw) return fallback.value;
    fallback = null;
  }
  if (raw === undefined || raw === null) return CARD_SETTINGS_DEFAULTS;
  return parse(raw);
}

export function writeCardSettings(patch: Partial<CardSettings>): CardSettings {
  const next: CardSettings = { ...readCardSettings() };
  for (const key of SETTING_KEYS) {
    const value = patch[key];
    if (typeof value === "boolean") next[key] = value;
  }
  fallback = writeRaw(JSON.stringify(next)) ? null : { value: next, raw: readRaw() };
  for (const listener of [...listeners]) listener();
  return next;
}

export function subscribeCardSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The last snapshot handed to React: unchanged values keep the same object, as useSyncExternalStore needs. */
let snapshot: CardSettings = CARD_SETTINGS_DEFAULTS;

function getSnapshot(): CardSettings {
  const next = readCardSettings();
  if (next.hoverPreviews !== snapshot.hoverPreviews || next.animatedFoil !== snapshot.animatedFoil) {
    snapshot = next;
  }
  return snapshot;
}

export function useCardSettings(): CardSettings {
  return useSyncExternalStore(subscribeCardSettings, getSnapshot);
}
