// docs/polish/1-animations.md, behaviours B6 and B7: the effects settings store (S3).
//
// `localStorage` must only ever be touched inside try/catch: a missing, throwing or full storage and
// unparsable JSON all fall back to the defaults without throwing, and `setFxSettings` keeps working
// in memory. Every test leaves storage empty and the store reset.

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createElement, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { FX_SETTINGS_KEY, FX_SPEED_MAX, FX_SPEED_MIN, FX_SPEED_STEPS } from "./constants.ts";
import {
  DEFAULT_FX_SETTINGS,
  getFxSettings,
  loadFxSettings,
  normalizeFxSettings,
  normalizeSpeed,
  resetFxSettingsForTests,
  setFxSettings,
  subscribeFxSettings,
  useFxSettings,
  type FxSettings,
} from "./settings.ts";

function clearStorage(): void {
  try {
    window.localStorage.clear();
  } catch {
    // A test that broke storage restores it in its own finally.
  }
}

beforeEach(() => {
  clearStorage();
  resetFxSettingsForTests();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  clearStorage();
  resetFxSettingsForTests();
});

const DEFAULTS: FxSettings = { speed: 1, intensity: "normal", motion: "system" };

/** A `Storage` whose every member throws, as Safari's private mode and a blocked origin do. */
function throwingStorage(): Storage {
  const fail = (): never => {
    throw new DOMException("storage is disabled", "SecurityError");
  };
  return {
    get length(): number {
      return fail();
    },
    clear: fail,
    getItem: fail,
    key: fail,
    removeItem: fail,
    setItem: fail,
  } as unknown as Storage;
}

/** A `Storage` holding `raw` under the settings key and nothing else. */
function storageWith(raw: string | null): Storage {
  return {
    length: raw === null ? 0 : 1,
    clear: () => {},
    getItem: (key: string) => (key === FX_SETTINGS_KEY ? raw : null),
    key: () => null,
    removeItem: () => {},
    setItem: () => {},
  } as unknown as Storage;
}

/** Makes reading `localStorage` itself throw, on every global the store might read it from. */
function breakLocalStorage(): () => void {
  const targets = [...new Set<object>([globalThis, window])];
  const saved = targets.map((target) => [target, Object.getOwnPropertyDescriptor(target, "localStorage")] as const);
  for (const target of targets) {
    Object.defineProperty(target, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("storage is disabled", "SecurityError");
      },
    });
  }
  return () => {
    for (const [target, descriptor] of saved) {
      if (descriptor !== undefined) Object.defineProperty(target, "localStorage", descriptor);
      else delete (target as { localStorage?: unknown }).localStorage;
    }
  };
}

function store(value: unknown): void {
  window.localStorage.setItem(FX_SETTINGS_KEY, JSON.stringify(value));
}

/* ------------------------------------------------------------------------------------------- *
 * B6: loading and normalizing
 * ------------------------------------------------------------------------------------------- */

describe("B6 loadFxSettings and normalization", () => {
  it("B6 the defaults are speed 1, intensity normal and motion system, under the key jackioh.fx.v1", () => {
    expect(DEFAULT_FX_SETTINGS).toEqual(DEFAULTS);
    expect(FX_SETTINGS_KEY).toBe("jackioh.fx.v1");
  });

  it("B6 empty storage loads the defaults", () => {
    expect(loadFxSettings()).toEqual(DEFAULTS);
    expect(loadFxSettings(window.localStorage)).toEqual(DEFAULTS);
    expect(loadFxSettings(storageWith(null))).toEqual(DEFAULTS);
  });

  it("B6 no storage at all loads the defaults", () => {
    expect(loadFxSettings(null)).toEqual(DEFAULTS);
  });

  it("B6 a throwing storage loads the defaults without throwing", () => {
    expect(() => loadFxSettings(throwingStorage())).not.toThrow();
    expect(loadFxSettings(throwingStorage())).toEqual(DEFAULTS);
  });

  it("B6 a throwing localStorage getter loads the defaults without throwing", () => {
    const restore = breakLocalStorage();
    try {
      expect(() => loadFxSettings()).not.toThrow();
      expect(loadFxSettings()).toEqual(DEFAULTS);
    } finally {
      restore();
    }
  });

  it("B6 unparsable JSON loads the defaults", () => {
    for (const raw of ["{not json", "", "undefined", "{\"speed\":"]) {
      expect(loadFxSettings(storageWith(raw)), raw).toEqual(DEFAULTS);
    }
  });

  it("B6 JSON that is not an object loads the defaults", () => {
    for (const raw of ["42", "\"fast\"", "null", "[]", "[1.5,\"high\",\"reduce\"]", "true"]) {
      expect(loadFxSettings(storageWith(raw)), raw).toEqual(DEFAULTS);
    }
  });

  it("B6 valid stored values load as stored", () => {
    const saved: FxSettings = { speed: 1.5, intensity: "high", motion: "reduce" };
    expect(loadFxSettings(storageWith(JSON.stringify(saved)))).toEqual(saved);
    store({ speed: 0.5, intensity: "off", motion: "system" });
    expect(loadFxSettings(window.localStorage)).toEqual({ speed: 0.5, intensity: "off", motion: "system" });
  });

  it("B6 a stored speed out of range is clamped to [FX_SPEED_MIN, FX_SPEED_MAX]", () => {
    expect(loadFxSettings(storageWith(JSON.stringify({ speed: 9, intensity: "low", motion: "system" })))).toEqual({
      speed: FX_SPEED_MAX,
      intensity: "low",
      motion: "system",
    });
    expect(loadFxSettings(storageWith(JSON.stringify({ speed: 0.1, intensity: "low", motion: "system" })))).toEqual({
      speed: FX_SPEED_MIN,
      intensity: "low",
      motion: "system",
    });
  });

  it("B6 an unknown intensity becomes normal and an unknown motion becomes system, field by field", () => {
    expect(loadFxSettings(storageWith(JSON.stringify({ speed: 1.5, intensity: "ultra", motion: "reduce" })))).toEqual({
      speed: 1.5,
      intensity: "normal",
      motion: "reduce",
    });
    expect(loadFxSettings(storageWith(JSON.stringify({ speed: 2, intensity: "high", motion: "never" })))).toEqual({
      speed: 2,
      intensity: "high",
      motion: "system",
    });
    expect(loadFxSettings(storageWith(JSON.stringify({ speed: "fast", intensity: 3, motion: null })))).toEqual(DEFAULTS);
  });

  it("B6 a stored object with missing fields fills them from the defaults", () => {
    expect(loadFxSettings(storageWith(JSON.stringify({ intensity: "low" })))).toEqual({
      speed: 1,
      intensity: "low",
      motion: "system",
    });
    expect(loadFxSettings(storageWith(JSON.stringify({})))).toEqual(DEFAULTS);
  });

  it("B6 normalizeSpeed maps every non-finite value to 1", () => {
    for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, undefined, null, "fast", {}, []]) {
      expect(normalizeSpeed(value), String(value)).toBe(1);
    }
  });

  it("B6 normalizeSpeed clamps to [0.5, 2] and keeps values inside it", () => {
    expect(normalizeSpeed(0)).toBe(0.5);
    expect(normalizeSpeed(-1)).toBe(0.5);
    expect(normalizeSpeed(0.49)).toBe(0.5);
    expect(normalizeSpeed(2.01)).toBe(2);
    expect(normalizeSpeed(100)).toBe(2);
    expect(normalizeSpeed(0.75)).toBe(0.75);
    expect(normalizeSpeed(1.25)).toBe(1.25);
    for (const step of FX_SPEED_STEPS) expect(normalizeSpeed(step)).toBe(step);
  });

  it("B6 normalizeFxSettings turns anything that is not a settings object into the defaults", () => {
    for (const raw of [undefined, null, 0, "normal", true, [], () => 1]) {
      expect(normalizeFxSettings(raw), String(raw)).toEqual(DEFAULTS);
    }
  });

  it("B6 normalizeFxSettings keeps every valid intensity and motion", () => {
    for (const intensity of ["off", "low", "normal", "high"] as const) {
      for (const motion of ["system", "reduce"] as const) {
        expect(normalizeFxSettings({ speed: 1.5, intensity, motion })).toEqual({ speed: 1.5, intensity, motion });
      }
    }
  });
});

/* ------------------------------------------------------------------------------------------- *
 * B6: the in-memory store and persistence
 * ------------------------------------------------------------------------------------------- */

describe("B6 getFxSettings and setFxSettings", () => {
  it("B6 getFxSettings starts at the defaults with empty storage", () => {
    expect(getFxSettings()).toEqual(DEFAULTS);
  });

  it("B6 setFxSettings persists under jackioh.fx.v1, and a fresh load reads the same value back", () => {
    const next = setFxSettings({ speed: 2, intensity: "high" });
    expect(next).toEqual({ speed: 2, intensity: "high", motion: "system" });
    expect(window.localStorage.getItem("jackioh.fx.v1")).not.toBeNull();
    expect(loadFxSettings(window.localStorage)).toEqual(next);

    resetFxSettingsForTests();
    expect(getFxSettings()).toEqual(next);
  });

  it("B6 setFxSettings merges a partial patch over the current value", () => {
    setFxSettings({ intensity: "low" });
    expect(setFxSettings({ motion: "reduce" })).toEqual({ speed: 1, intensity: "low", motion: "reduce" });
    expect(getFxSettings()).toEqual({ speed: 1, intensity: "low", motion: "reduce" });
  });

  it("B6 setFxSettings normalizes the patch before storing and returning it", () => {
    expect(setFxSettings({ speed: 10 })).toEqual({ speed: 2, intensity: "normal", motion: "system" });
    expect(getFxSettings().speed).toBe(2);
    expect(setFxSettings({ speed: Number.NaN })).toEqual(DEFAULTS);
    expect(setFxSettings({ intensity: "loud" as FxSettings["intensity"] }).intensity).toBe("normal");
    expect(loadFxSettings(window.localStorage)).toEqual(getFxSettings());
  });

  it("B6 setFxSettings never throws when storage refuses the write, and keeps the value in memory", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota exceeded", "QuotaExceededError");
    });
    let result: FxSettings | undefined;
    expect(() => {
      result = setFxSettings({ speed: 0.5, intensity: "off" });
    }).not.toThrow();
    expect(result).toEqual({ speed: 0.5, intensity: "off", motion: "system" });
    expect(getFxSettings()).toEqual({ speed: 0.5, intensity: "off", motion: "system" });
  });

  it("B6 the store works in memory when reading localStorage itself throws", () => {
    const restore = breakLocalStorage();
    try {
      resetFxSettingsForTests();
      expect(getFxSettings()).toEqual(DEFAULTS);
      expect(() => setFxSettings({ motion: "reduce" })).not.toThrow();
      expect(getFxSettings()).toEqual({ speed: 1, intensity: "normal", motion: "reduce" });
    } finally {
      restore();
    }
  });

  it("B6 an unparsable stored value makes getFxSettings fall back to the defaults", () => {
    window.localStorage.setItem(FX_SETTINGS_KEY, "{broken");
    resetFxSettingsForTests();
    expect(() => getFxSettings()).not.toThrow();
    expect(getFxSettings()).toEqual(DEFAULTS);
  });

  it("B6 getFxSettings loads storage once, lazily, and keeps its value until reset", () => {
    store({ speed: 1.5, intensity: "low", motion: "system" });
    resetFxSettingsForTests();
    expect(getFxSettings()).toEqual({ speed: 1.5, intensity: "low", motion: "system" });

    // Written behind the store's back: the in-memory value stands.
    store({ speed: 0.5, intensity: "high", motion: "reduce" });
    expect(getFxSettings()).toEqual({ speed: 1.5, intensity: "low", motion: "system" });

    resetFxSettingsForTests();
    expect(getFxSettings()).toEqual({ speed: 0.5, intensity: "high", motion: "reduce" });
  });
});

/* ------------------------------------------------------------------------------------------- *
 * B7: notification and the hook
 * ------------------------------------------------------------------------------------------- */

function Probe(): ReactElement {
  const [settings, update] = useFxSettings();
  const props = { type: "button" as const, "data-testid": "fx-probe", onClick: () => update({ speed: 0.5 }) };
  return createElement("button", props, `${settings.speed}|${settings.intensity}|${settings.motion}`);
}

describe("B7 subscriptions", () => {
  it("B7 setFxSettings notifies listeners synchronously with the normalized value", () => {
    const first = vi.fn();
    const second = vi.fn();
    subscribeFxSettings(first);
    subscribeFxSettings(second);

    setFxSettings({ speed: 7, intensity: "low" });

    expect(first).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenLastCalledWith({ speed: 2, intensity: "low", motion: "system" });
    expect(second).toHaveBeenLastCalledWith({ speed: 2, intensity: "low", motion: "system" });
  });

  it("B7 an unsubscribed listener is not notified", () => {
    const listener = vi.fn();
    const off = subscribeFxSettings(listener);
    off();
    setFxSettings({ intensity: "high" });
    expect(listener).not.toHaveBeenCalled();
  });

  it("B7 resetFxSettingsForTests drops every listener", () => {
    const listener = vi.fn();
    subscribeFxSettings(listener);
    resetFxSettingsForTests();
    setFxSettings({ intensity: "high" });
    expect(listener).not.toHaveBeenCalled();
  });

  it("B7 listeners are still notified when storage refuses the write", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota exceeded", "QuotaExceededError");
    });
    const listener = vi.fn();
    subscribeFxSettings(listener);
    setFxSettings({ motion: "reduce" });
    expect(listener).toHaveBeenLastCalledWith({ speed: 1, intensity: "normal", motion: "reduce" });
  });

  it("B7 a component using useFxSettings re-renders with every change", () => {
    render(createElement(Probe));
    const probe = screen.getByTestId("fx-probe");
    expect(probe.textContent).toBe("1|normal|system");

    act(() => {
      setFxSettings({ intensity: "high" });
    });
    expect(probe.textContent).toBe("1|high|system");

    act(() => {
      setFxSettings({ speed: 99, motion: "reduce" });
    });
    expect(probe.textContent).toBe("2|high|reduce");
  });

  it("B7 the hook's setter updates the store and every subscriber", () => {
    const listener = vi.fn();
    subscribeFxSettings(listener);
    render(createElement(Probe));

    fireEvent.click(screen.getByTestId("fx-probe"));

    expect(screen.getByTestId("fx-probe").textContent).toBe("0.5|normal|system");
    expect(getFxSettings()).toEqual({ speed: 0.5, intensity: "normal", motion: "system" });
    expect(listener).toHaveBeenLastCalledWith({ speed: 0.5, intensity: "normal", motion: "system" });
  });
});
