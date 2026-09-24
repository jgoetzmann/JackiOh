// B12 and B13 (docs/polish/2-sound.md): the audio settings store. Reading is total (any stored
// value, or a storage that throws, gives valid settings), and writing clamps, persists under
// "jackioh.audio.v1", notifies every subscriber once, and survives a storage that refuses writes.

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { AUDIO_SETTINGS_KEY } from "./constants.ts";
import {
  DEFAULT_AUDIO_SETTINGS,
  parseAudioSettings,
  readAudioSettings,
  resetAudioSettingsForTests,
  subscribeAudioSettings,
  writeAudioSettings,
} from "./settings.ts";
import type { AudioSettings } from "./types.ts";

const DEFAULTS: AudioSettings = { master: 0.8, sfx: 0.8, voice: 1, muted: false, voiceOn: true };

function stored(): unknown {
  const raw = localStorage.getItem("jackioh.audio.v1");
  return raw === null ? null : (JSON.parse(raw) as unknown);
}

function storeRaw(raw: string): void {
  localStorage.setItem("jackioh.audio.v1", raw);
}

const unsubscribers: (() => void)[] = [];

function listen(): Mock<(s: AudioSettings) => void> {
  const listener = vi.fn<(s: AudioSettings) => void>();
  unsubscribers.push(subscribeAudioSettings(listener));
  return listener;
}

beforeEach(() => {
  localStorage.clear();
  resetAudioSettingsForTests();
});

afterEach(() => {
  for (const off of unsubscribers.splice(0)) off();
  vi.restoreAllMocks();
  localStorage.clear();
  resetAudioSettingsForTests();
});

/* --------------------------------------------------------------------------------------------- *
 * B12: reading
 * --------------------------------------------------------------------------------------------- */

describe("B12 reading the settings", () => {
  it("B12 DEFAULT_AUDIO_SETTINGS is master 0.8, sfx 0.8, voice 1, not muted, voice on", () => {
    expect({ ...DEFAULT_AUDIO_SETTINGS }).toEqual(DEFAULTS);
  });

  it("B12 empty storage reads as the defaults", () => {
    expect(readAudioSettings()).toEqual(DEFAULTS);
  });

  it("B12 invalid JSON reads as the defaults", () => {
    storeRaw("{not json");
    expect(readAudioSettings()).toEqual(DEFAULTS);
  });

  it("B12 stored JSON that is not an object reads as the defaults", () => {
    for (const raw of ["42", "null", "[]", '"loud"', "true"]) {
      resetAudioSettingsForTests();
      storeRaw(raw);
      expect(readAudioSettings(), raw).toEqual(DEFAULTS);
    }
  });

  it("B12 a storage that throws on read gives the defaults, and does not throw", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("SecurityError: storage is blocked");
    });
    expect(() => readAudioSettings()).not.toThrow();
    expect(readAudioSettings()).toEqual(DEFAULTS);
  });

  it("B12 a valid stored value is read back", () => {
    storeRaw(JSON.stringify({ master: 0.25, sfx: 0.5, voice: 0, muted: true, voiceOn: false }));
    expect(readAudioSettings()).toEqual({ master: 0.25, sfx: 0.5, voice: 0, muted: true, voiceOn: false });
  });

  it("B12 numbers are clamped to [0, 1], each field on its own", () => {
    storeRaw(JSON.stringify({ master: 2, sfx: -1, voice: 0.4, muted: false, voiceOn: true }));
    expect(readAudioSettings()).toEqual({ master: 1, sfx: 0, voice: 0.4, muted: false, voiceOn: true });
  });

  it("B12 a non-number takes that field's default while the valid fields survive", () => {
    storeRaw(JSON.stringify({ master: "0.3", sfx: null, voice: 0.25, muted: true, voiceOn: false }));
    expect(readAudioSettings()).toEqual({ master: 0.8, sfx: 0.8, voice: 0.25, muted: true, voiceOn: false });
  });

  it("B12 a non-boolean muted or voiceOn takes the default while the numbers survive", () => {
    storeRaw(JSON.stringify({ master: 0.1, sfx: 0.2, voice: 0.3, muted: "yes", voiceOn: 0 }));
    expect(readAudioSettings()).toEqual({ master: 0.1, sfx: 0.2, voice: 0.3, muted: false, voiceOn: true });
  });

  it("B12 missing fields take their defaults", () => {
    storeRaw(JSON.stringify({ voice: 0.6 }));
    expect(readAudioSettings()).toEqual({ ...DEFAULTS, voice: 0.6 });
  });

  it("B12 parseAudioSettings maps non-finite numbers to the defaults", () => {
    expect(parseAudioSettings({ master: Number.NaN, sfx: Number.POSITIVE_INFINITY, voice: Number.NEGATIVE_INFINITY, muted: true, voiceOn: true })).toEqual({
      ...DEFAULTS,
      muted: true,
    });
  });

  it("B12 parseAudioSettings is total: any input gives valid settings", () => {
    for (const raw of [undefined, null, 0, 1, "x", true, [], [0.5, 0.5], () => 0, { master: {} }, { muted: 1, voiceOn: "false" }]) {
      const parsed = parseAudioSettings(raw);
      expect(Object.keys(parsed).sort(), String(raw)).toEqual(["master", "muted", "sfx", "voice", "voiceOn"]);
      for (const key of ["master", "sfx", "voice"] as const) {
        expect(Number.isFinite(parsed[key]), `${String(raw)}.${key}`).toBe(true);
        expect(parsed[key]).toBeGreaterThanOrEqual(0);
        expect(parsed[key]).toBeLessThanOrEqual(1);
      }
      expect(typeof parsed.muted).toBe("boolean");
      expect(typeof parsed.voiceOn).toBe("boolean");
    }
    expect(parseAudioSettings({ muted: 1, voiceOn: "false" })).toEqual(DEFAULTS);
  });

  it("B12 parseAudioSettings clamps the boundaries and keeps 0 and 1", () => {
    expect(parseAudioSettings({ master: 0, sfx: 1, voice: 1.0000001, muted: false, voiceOn: true })).toEqual({
      master: 0,
      sfx: 1,
      voice: 1,
      muted: false,
      voiceOn: true,
    });
  });
});

/* --------------------------------------------------------------------------------------------- *
 * B13: writing, persisting and notifying
 * --------------------------------------------------------------------------------------------- */

describe("B13 writing the settings", () => {
  it("B13 AUDIO_SETTINGS_KEY is jackioh.audio.v1", () => {
    expect(AUDIO_SETTINGS_KEY).toBe("jackioh.audio.v1");
  });

  it("B13 writeAudioSettings merges the patch, returns the result, and stores it as JSON under the key", () => {
    const result = writeAudioSettings({ master: 0.3 });

    expect(result).toEqual({ ...DEFAULTS, master: 0.3 });
    expect(readAudioSettings()).toEqual({ ...DEFAULTS, master: 0.3 });
    expect(stored()).toEqual({ ...DEFAULTS, master: 0.3 });

    writeAudioSettings({ muted: true });
    expect(stored()).toEqual({ ...DEFAULTS, master: 0.3, muted: true });
  });

  it("B13 writeAudioSettings clamps before it stores", () => {
    const result = writeAudioSettings({ master: 5, sfx: -2, voice: 0.5 });

    expect(result).toEqual({ ...DEFAULTS, master: 1, sfx: 0, voice: 0.5 });
    expect(stored()).toEqual({ ...DEFAULTS, master: 1, sfx: 0, voice: 0.5 });
  });

  it("B13 every subscriber is notified exactly once per write, with the new settings", () => {
    const a = listen();
    const b = listen();

    writeAudioSettings({ voice: 0.2 });

    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    expect(a).toHaveBeenLastCalledWith({ ...DEFAULTS, voice: 0.2 });
    expect(b).toHaveBeenLastCalledWith({ ...DEFAULTS, voice: 0.2 });

    writeAudioSettings({ voiceOn: false });
    expect(a).toHaveBeenCalledTimes(2);
    expect(a).toHaveBeenLastCalledWith({ ...DEFAULTS, voice: 0.2, voiceOn: false });
  });

  it("B13 an unsubscribed listener hears nothing more", () => {
    const listener = vi.fn<(s: AudioSettings) => void>();
    const off = subscribeAudioSettings(listener);
    off();

    writeAudioSettings({ master: 0.1 });

    expect(listener).not.toHaveBeenCalled();
  });

  it("B13 a setItem that throws still updates the in-memory settings and notifies", () => {
    const listener = listen();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });

    let result: AudioSettings | undefined;
    expect(() => {
      result = writeAudioSettings({ muted: true, sfx: 0.4 });
    }).not.toThrow();

    expect(result).toEqual({ ...DEFAULTS, muted: true, sfx: 0.4 });
    expect(readAudioSettings()).toEqual({ ...DEFAULTS, muted: true, sfx: 0.4 });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem("jackioh.audio.v1")).toBeNull();
  });

  it("B13 a storage event for the key re-reads it and notifies", () => {
    const listener = listen();
    expect(readAudioSettings()).toEqual(DEFAULTS);

    const next = { master: 0.25, sfx: 0.5, voice: 0.75, muted: true, voiceOn: false };
    storeRaw(JSON.stringify(next));
    window.dispatchEvent(new StorageEvent("storage", { key: "jackioh.audio.v1", newValue: JSON.stringify(next) }));

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenLastCalledWith(next);
    expect(readAudioSettings()).toEqual(next);
  });

  it("B13 a storage event from another tab is clamped like any other read", () => {
    const listener = listen();

    storeRaw(JSON.stringify({ master: 9, sfx: "loud", voice: -3, muted: "no", voiceOn: false }));
    window.dispatchEvent(new StorageEvent("storage", { key: "jackioh.audio.v1" }));

    expect(listener).toHaveBeenLastCalledWith({ master: 1, sfx: 0.8, voice: 0, muted: false, voiceOn: false });
  });

  it("B13 a storage event for another key is ignored", () => {
    const listener = listen();

    localStorage.setItem("jackioh.other", "1");
    window.dispatchEvent(new StorageEvent("storage", { key: "jackioh.other", newValue: "1" }));

    expect(listener).not.toHaveBeenCalled();
  });
});
