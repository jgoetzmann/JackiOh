// Polish 6, slice C: the card settings store (docs/polish/6-cards.md, B28).
//
// One localStorage key, `jackioh.cards.settings.v1`, with every read and write inside try/catch.
// What a page load sees is tested on a freshly imported module (`vi.resetModules()`), so the
// answer does not depend on whether the store caches what it read. Storage failures are a
// `Storage.prototype` stub that throws, as the Tests section asks.
//
// This file is .ts, so the one component it renders is built with `createElement`.

import { act, cleanup, render, screen } from "@testing-library/react";
import { createElement, type ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CARD_SETTINGS_DEFAULTS,
  CARD_SETTINGS_FIELDS,
  CARD_SETTINGS_KEY,
  readCardSettings,
  subscribeCardSettings,
  useCardSettings,
  writeCardSettings,
  type CardSettings,
} from "./settings.ts";

type SettingsModule = typeof import("./settings.ts");

/** A module instance that has never run, as on a fresh page load. */
async function freshSettings(): Promise<SettingsModule> {
  vi.resetModules();
  return import("./settings.ts");
}

function breakStorage(methods: readonly ("getItem" | "setItem")[]): void {
  for (const method of methods) {
    vi.spyOn(Storage.prototype, method).mockImplementation(() => {
      throw new Error(`storage ${method} is unavailable`);
    });
  }
}

function stored(): unknown {
  const raw = window.localStorage.getItem(CARD_SETTINGS_KEY);
  return raw === null ? null : (JSON.parse(raw) as unknown);
}

function Probe(): ReactElement {
  const settings = useCardSettings();
  return createElement(
    "output",
    { "data-testid": "probe" },
    `${String(settings.hoverPreviews)}|${String(settings.animatedFoil)}`,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
  writeCardSettings(CARD_SETTINGS_DEFAULTS);
  window.localStorage.clear();
});

describe("the contract (B28)", () => {
  it("B28 settings live under jackioh.cards.settings.v1, and both default to on", () => {
    expect(CARD_SETTINGS_KEY).toBe("jackioh.cards.settings.v1");
    expect(CARD_SETTINGS_DEFAULTS).toEqual({ hoverPreviews: true, animatedFoil: true });
  });

  it("B28 CARD_SETTINGS_FIELDS puts hoverPreviews under gameplay and animatedFoil under visuals, each labelled", () => {
    const byKey = new Map(CARD_SETTINGS_FIELDS.map((field) => [field.key, field]));
    expect([...byKey.keys()].sort()).toEqual(["animatedFoil", "hoverPreviews"]);
    expect(CARD_SETTINGS_FIELDS).toHaveLength(2);
    expect(byKey.get("hoverPreviews")?.section).toBe("gameplay");
    expect(byKey.get("animatedFoil")?.section).toBe("visuals");
    for (const field of CARD_SETTINGS_FIELDS) {
      expect(field.label.trim().length, `${field.key} label`).toBeGreaterThan(0);
      expect(field.description.trim().length, `${field.key} description`).toBeGreaterThan(0);
    }
  });
});

describe("reading (B28)", () => {
  it("B28 an empty storage reads as the defaults", async () => {
    window.localStorage.clear();
    const fresh = await freshSettings();
    expect(fresh.readCardSettings()).toEqual(CARD_SETTINGS_DEFAULTS);
  });

  it("B28 a stored value is what a fresh page reads", async () => {
    window.localStorage.setItem(CARD_SETTINGS_KEY, JSON.stringify({ hoverPreviews: false, animatedFoil: false }));
    const fresh = await freshSettings();
    expect(fresh.readCardSettings()).toEqual({ hoverPreviews: false, animatedFoil: false });
  });

  it("B28 a missing key is filled from the defaults", async () => {
    window.localStorage.setItem(CARD_SETTINGS_KEY, JSON.stringify({ animatedFoil: false }));
    const fresh = await freshSettings();
    expect(fresh.readCardSettings()).toEqual({ hoverPreviews: true, animatedFoil: false });
  });

  it("B28 invalid JSON reads as the defaults", async () => {
    window.localStorage.setItem(CARD_SETTINGS_KEY, "{hoverPreviews: nope");
    const fresh = await freshSettings();
    expect(fresh.readCardSettings()).toEqual(CARD_SETTINGS_DEFAULTS);
  });

  it("B28 valid JSON that is not a settings object reads as the defaults", async () => {
    for (const raw of ["null", "[]", "[false, false]", "0", "false", '"off"']) {
      window.localStorage.setItem(CARD_SETTINGS_KEY, raw);
      const fresh = await freshSettings();
      expect(fresh.readCardSettings(), raw).toEqual(CARD_SETTINGS_DEFAULTS);
    }
  });

  it("B28 a key holding anything but a boolean is filled from the defaults, and the other key is kept", async () => {
    window.localStorage.setItem(CARD_SETTINGS_KEY, JSON.stringify({ hoverPreviews: "no", animatedFoil: false }));
    let fresh = await freshSettings();
    expect(fresh.readCardSettings()).toEqual({ hoverPreviews: true, animatedFoil: false });

    window.localStorage.setItem(CARD_SETTINGS_KEY, JSON.stringify({ hoverPreviews: false, animatedFoil: 0 }));
    fresh = await freshSettings();
    expect(fresh.readCardSettings()).toEqual({ hoverPreviews: false, animatedFoil: true });

    window.localStorage.setItem(CARD_SETTINGS_KEY, JSON.stringify({ hoverPreviews: null, animatedFoil: "false" }));
    fresh = await freshSettings();
    expect(fresh.readCardSettings()).toEqual(CARD_SETTINGS_DEFAULTS);
  });

  it("B28 a storage that throws on read gives the defaults, not an exception", async () => {
    breakStorage(["getItem"]);
    const fresh = await freshSettings();
    let read: CardSettings | undefined;
    expect(() => {
      read = fresh.readCardSettings();
    }).not.toThrow();
    expect(read).toEqual(CARD_SETTINGS_DEFAULTS);
  });

  it("B28 a value under any other key is not read", async () => {
    window.localStorage.setItem("jackioh.cards.settings.v0", JSON.stringify({ hoverPreviews: false, animatedFoil: false }));
    window.localStorage.setItem("jackioh.settings", JSON.stringify({ hoverPreviews: false, animatedFoil: false }));
    const fresh = await freshSettings();
    expect(fresh.readCardSettings()).toEqual(CARD_SETTINGS_DEFAULTS);
  });
});

describe("writing (B28)", () => {
  it("B28 writeCardSettings merges the patch, returns the whole settings, and stores them under the key", () => {
    const next = writeCardSettings({ animatedFoil: false });
    expect(next).toEqual({ hoverPreviews: true, animatedFoil: false });
    expect(readCardSettings()).toEqual(next);
    expect(stored()).toMatchObject({ animatedFoil: false });
  });

  it("B28 a written value is what the next page load reads", async () => {
    writeCardSettings({ hoverPreviews: false });
    const fresh = await freshSettings();
    expect(fresh.readCardSettings()).toEqual({ hoverPreviews: false, animatedFoil: true });
  });

  it("B28 an empty patch changes nothing and returns the current settings", () => {
    writeCardSettings({ animatedFoil: false });
    expect(writeCardSettings({})).toEqual({ hoverPreviews: true, animatedFoil: false });
    expect(readCardSettings()).toEqual({ hoverPreviews: true, animatedFoil: false });
  });

  it("B28 writing never changes CARD_SETTINGS_DEFAULTS", () => {
    writeCardSettings({ hoverPreviews: false, animatedFoil: false });
    expect(CARD_SETTINGS_DEFAULTS).toEqual({ hoverPreviews: true, animatedFoil: true });
  });

  it("B28 writeCardSettings keeps working in memory when setItem throws", () => {
    breakStorage(["setItem"]);
    let next: CardSettings | undefined;
    expect(() => {
      next = writeCardSettings({ hoverPreviews: false });
    }).not.toThrow();
    expect(next).toEqual({ hoverPreviews: false, animatedFoil: true });
    expect(readCardSettings()).toEqual({ hoverPreviews: false, animatedFoil: true });
  });

  it("B28 writeCardSettings keeps working in memory when getItem and setItem both throw", () => {
    breakStorage(["getItem", "setItem"]);
    let next: CardSettings | undefined;
    expect(() => {
      next = writeCardSettings({ animatedFoil: false });
    }).not.toThrow();
    expect(next).toEqual({ hoverPreviews: true, animatedFoil: false });
    expect(readCardSettings()).toEqual({ hoverPreviews: true, animatedFoil: false });
  });
});

describe("subscribing (B28)", () => {
  it("B28 subscribeCardSettings calls its listener on every write, and not after unsubscribing", () => {
    const listener = vi.fn<() => void>();
    const unsubscribe = subscribeCardSettings(listener);
    writeCardSettings({ hoverPreviews: false });
    writeCardSettings({ animatedFoil: false });
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    writeCardSettings({ hoverPreviews: true });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("B28 useCardSettings re-renders on every write", () => {
    render(createElement(Probe));
    const probe = screen.getByTestId("probe");
    expect(probe).toHaveTextContent("true|true");

    act(() => {
      writeCardSettings({ hoverPreviews: false });
    });
    expect(probe).toHaveTextContent("false|true");

    act(() => {
      writeCardSettings({ animatedFoil: false });
    });
    expect(probe).toHaveTextContent("false|false");

    act(() => {
      writeCardSettings({ hoverPreviews: true });
    });
    expect(probe).toHaveTextContent("true|false");
  });

  it("B28 useCardSettings follows writes even when storage throws", () => {
    breakStorage(["getItem", "setItem"]);
    render(createElement(Probe));
    act(() => {
      writeCardSettings({ hoverPreviews: false });
    });
    expect(screen.getByTestId("probe")).toHaveTextContent("false|true");
  });
});
