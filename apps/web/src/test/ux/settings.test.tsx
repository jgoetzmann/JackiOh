// The settings store and panel (docs/polish/7-mobile-ux.md, S8):
//
//   B19  empty, corrupt or throwing storage reads as DEFAULT_SETTINGS, and no store function throws;
//   B20  writeSettings merges, persists JSON under `jackioh.settings`, notifies each subscriber once
//        and returns the new snapshot; parseSettings is tolerant; resetSettings restores defaults;
//   B21  a `storage` event for the key updates the snapshot and re-renders every `useSetting` user;
//   B22  `reduceMotion` drives `<html data-reduce-motion>`, and settings.css maps it to
//        `--anim-scale: 0`;
//   B23  the game and nav gears open the `settings-panel` dialog; close, Escape and the scrim shut
//        it and give focus back to the gear that opened it;
//   B24  the panel's sections, switches, reset and slots;
//   B41  `reduceMotion` also reaches the animation runner: a new view shows at once, as it does
//        under the OS preference, not only with the CSS motion stopped.
//
// The store is module state, so every test starts from empty storage and a forgotten snapshot.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ReactElement } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_SETTINGS,
  SETTINGS_STORAGE_KEY,
  SettingsPanel,
  __resetSettingsForTests,
  parseSettings,
  readSettings,
  resetSettings,
  subscribeSettings,
  useSetting,
  useSettings,
  writeSettings,
  type SettingKey,
  type Settings,
  type SettingsSlot,
} from "../../settings/index.ts";
import Game from "../../game/Game.tsx";
import { BackLink } from "../../routes/nav.tsx";
import { baseView } from "../fixtures.ts";

const here = dirname(fileURLToPath(import.meta.url));
const SETTINGS_CSS = join(here, "../../settings/settings.css");

const DEFAULTS: Settings = { dragToPlay: true, confirmEndTurn: false, hoverPreviews: true, reduceMotion: false };
const KEYS = ["confirmEndTurn", "dragToPlay", "hoverPreviews", "reduceMotion"];

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  __resetSettingsForTests();
  document.documentElement.removeAttribute("data-reduce-motion");
});

const noop = (): void => undefined;

/** Put a raw value in storage and forget the snapshot, so the next read is a first load. */
function storeRaw(raw: string): void {
  localStorage.setItem(SETTINGS_STORAGE_KEY, raw);
  __resetSettingsForTests();
}

function store(value: unknown): void {
  storeRaw(JSON.stringify(value));
}

function persisted(): unknown {
  const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
  if (raw === null) throw new Error(`nothing stored under ${SETTINGS_STORAGE_KEY}`);
  return JSON.parse(raw);
}

/** Another tab wrote `raw` under `key`: the value lands in storage and the event reaches `window`. */
function storageEventFor(key: string, raw: string | null): void {
  if (raw === null) localStorage.removeItem(key);
  else localStorage.setItem(key, raw);
  act(() => {
    window.dispatchEvent(new StorageEvent("storage", { key, newValue: raw, storageArea: localStorage }));
  });
}

function reduceMotionAttr(): string | null {
  return document.documentElement.getAttribute("data-reduce-motion");
}

function Probe({ name }: { name: SettingKey }): ReactElement {
  const value = useSetting(name);
  return <span data-testid={`probe-${name}`}>{String(value)}</span>;
}

function WholeProbe(): ReactElement {
  const settings = useSettings();
  return <span data-testid="probe-all">{settings.hoverPreviews ? "hover-on" : "hover-off"}</span>;
}

function switchFor(key: SettingKey): HTMLInputElement {
  const el = screen.getByTestId(`setting-${key}`);
  if (!(el instanceof HTMLInputElement)) throw new Error(`setting-${key} is not an <input>`);
  return el;
}

function throwingStorage(): void {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("storage is blocked");
  });
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("storage is blocked");
  });
  vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
    throw new Error("storage is blocked");
  });
}

// ---------------------------------------------------------------------------------------------
// B19: defaults, whatever storage holds
// ---------------------------------------------------------------------------------------------

describe("B19 the store falls back to the defaults", () => {
  it("B19 with empty storage it reads drag on, confirm off, hover previews on, reduce motion off", () => {
    expect(SETTINGS_STORAGE_KEY).toBe("jackioh.settings");
    expect(DEFAULT_SETTINGS).toEqual(DEFAULTS);
    expect(readSettings()).toEqual(DEFAULTS);
  });

  it("B19 corrupt JSON reads as the defaults", () => {
    storeRaw("{not json");

    expect(readSettings()).toEqual(DEFAULTS);
  });

  it("B19 a stored value that is not an object reads as the defaults", () => {
    for (const raw of ["42", "null", "[]", '"on"', "true", ""]) {
      storeRaw(raw);
      expect(readSettings(), `stored ${JSON.stringify(raw)}`).toEqual(DEFAULTS);
    }
  });

  it("B19 a throwing storage reads as the defaults, and no store function throws", () => {
    throwingStorage();
    __resetSettingsForTests();

    expect(() => readSettings()).not.toThrow();
    expect(readSettings()).toEqual(DEFAULTS);

    let written: Settings | undefined;
    expect(() => {
      written = writeSettings({ dragToPlay: false });
    }).not.toThrow();
    expect(written).toEqual({ ...DEFAULTS, dragToPlay: false });

    let unsubscribe: (() => void) | undefined;
    expect(() => {
      unsubscribe = subscribeSettings(noop);
    }).not.toThrow();
    expect(() => unsubscribe?.()).not.toThrow();

    let reset: Settings | undefined;
    expect(() => {
      reset = resetSettings();
    }).not.toThrow();
    expect(reset).toEqual(DEFAULTS);
    expect(() => parseSettings(undefined)).not.toThrow();
  });

  it("B19 a failed write keeps the value in memory", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota exceeded");
    });

    const next = writeSettings({ reduceMotion: true, confirmEndTurn: true });

    expect(next).toEqual({ ...DEFAULTS, reduceMotion: true, confirmEndTurn: true });
    expect(readSettings()).toEqual({ ...DEFAULTS, reduceMotion: true, confirmEndTurn: true });
  });

  it("B19 a storage that throws on read still lets a component render with the defaults", () => {
    throwingStorage();
    __resetSettingsForTests();

    render(<Probe name="dragToPlay" />);

    expect(screen.getByTestId("probe-dragToPlay")).toHaveTextContent("true");
  });
});

// ---------------------------------------------------------------------------------------------
// B20: write, persist, notify, parse, reset
// ---------------------------------------------------------------------------------------------

describe("B20 writing, parsing and resetting", () => {
  it("B20 writeSettings merges the patch, persists the four keys as JSON and returns the new snapshot", () => {
    const first = writeSettings({ dragToPlay: false });

    expect(first).toEqual({ ...DEFAULTS, dragToPlay: false });
    expect(readSettings()).toBe(first);
    expect(persisted()).toEqual({ ...DEFAULTS, dragToPlay: false });

    const second = writeSettings({ reduceMotion: true });

    expect(second).toEqual({ ...DEFAULTS, dragToPlay: false, reduceMotion: true });
    expect(readSettings()).toBe(second);
    expect(persisted()).toEqual({ ...DEFAULTS, dragToPlay: false, reduceMotion: true });
  });

  it("B20 a write survives a reload: the next first load reads it back", () => {
    writeSettings({ hoverPreviews: false, confirmEndTurn: true });
    __resetSettingsForTests();

    expect(readSettings()).toEqual({ ...DEFAULTS, hoverPreviews: false, confirmEndTurn: true });
  });

  it("B20 notifies each subscriber exactly once per write, and not after it unsubscribes", () => {
    const first = vi.fn();
    const second = vi.fn();
    const stopFirst = subscribeSettings(first);
    const stopSecond = subscribeSettings(second);

    writeSettings({ confirmEndTurn: true });

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);

    stopFirst();
    writeSettings({ confirmEndTurn: false });

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
    stopSecond();
  });

  it("B20 readSettings is the same object until something changes", () => {
    const a = readSettings();
    const b = readSettings();
    expect(b).toBe(a);

    const c = writeSettings({ dragToPlay: false });

    expect(c).not.toBe(a);
    expect(readSettings()).toBe(c);
    // The old snapshot was not mutated in place.
    expect(a).toEqual(DEFAULTS);
  });

  it("B20 a write never changes DEFAULT_SETTINGS", () => {
    writeSettings({ dragToPlay: false, confirmEndTurn: true, hoverPreviews: false, reduceMotion: true });

    expect(DEFAULT_SETTINGS).toEqual(DEFAULTS);
  });

  it("B20 parseSettings drops unknown keys", () => {
    const parsed = parseSettings({ dragToPlay: false, legacyTheme: "dark", volume: 3 });

    expect(parsed).toEqual({ ...DEFAULTS, dragToPlay: false });
    expect(Object.keys(parsed).sort()).toEqual(KEYS);
  });

  it("B20 parseSettings replaces wrong-typed values with the defaults, key by key", () => {
    expect(
      parseSettings({ dragToPlay: "no", confirmEndTurn: 1, hoverPreviews: null, reduceMotion: "true" }),
    ).toEqual(DEFAULTS);
    expect(parseSettings({ dragToPlay: 0, reduceMotion: true })).toEqual({ ...DEFAULTS, reduceMotion: true });
  });

  it("B20 parseSettings fills missing keys with the defaults", () => {
    expect(parseSettings({ confirmEndTurn: true })).toEqual({ ...DEFAULTS, confirmEndTurn: true });
    expect(parseSettings({})).toEqual(DEFAULTS);
  });

  it("B20 parseSettings of anything that is not an object is the defaults", () => {
    for (const raw of [null, undefined, 42, "dragToPlay", true, [], [false, false]]) {
      expect(parseSettings(raw), JSON.stringify(raw) ?? "undefined").toEqual(DEFAULTS);
    }
  });

  it("B20 a stored object with unknown and wrong-typed keys loads tolerantly", () => {
    store({ dragToPlay: false, hoverPreviews: "yes", legacy: 1 });

    const loaded = readSettings();

    expect(loaded).toEqual({ ...DEFAULTS, dragToPlay: false });
    expect(Object.keys(loaded).sort()).toEqual(KEYS);
  });

  it("B20 resetSettings restores the defaults in memory and in storage, and notifies", () => {
    writeSettings({ dragToPlay: false, confirmEndTurn: true, hoverPreviews: false, reduceMotion: true });
    const listener = vi.fn();
    const stop = subscribeSettings(listener);

    const reset = resetSettings();

    expect(reset).toEqual(DEFAULTS);
    expect(readSettings()).toEqual(DEFAULTS);
    expect(listener).toHaveBeenCalledTimes(1);
    stop();

    __resetSettingsForTests();
    expect(readSettings()).toEqual(DEFAULTS);
  });
});

// ---------------------------------------------------------------------------------------------
// B21: other tabs
// ---------------------------------------------------------------------------------------------

describe("B21 a storage event from another tab", () => {
  it("B21 for jackioh.settings, it updates readSettings and notifies subscribers", () => {
    const listener = vi.fn();
    const stop = subscribeSettings(listener);
    expect(readSettings()).toEqual(DEFAULTS);

    storageEventFor(SETTINGS_STORAGE_KEY, JSON.stringify({ ...DEFAULTS, confirmEndTurn: true }));

    expect(readSettings()).toEqual({ ...DEFAULTS, confirmEndTurn: true });
    expect(listener).toHaveBeenCalled();
    stop();
  });

  it("B21 re-renders every component that uses useSetting or useSettings", () => {
    render(
      <>
        <Probe name="dragToPlay" />
        <Probe name="confirmEndTurn" />
        <WholeProbe />
      </>,
    );
    expect(screen.getByTestId("probe-dragToPlay")).toHaveTextContent("true");
    expect(screen.getByTestId("probe-confirmEndTurn")).toHaveTextContent("false");
    expect(screen.getByTestId("probe-all")).toHaveTextContent("hover-on");

    storageEventFor(
      SETTINGS_STORAGE_KEY,
      JSON.stringify({ dragToPlay: false, confirmEndTurn: true, hoverPreviews: false, reduceMotion: false }),
    );

    expect(screen.getByTestId("probe-dragToPlay")).toHaveTextContent("false");
    expect(screen.getByTestId("probe-confirmEndTurn")).toHaveTextContent("true");
    expect(screen.getByTestId("probe-all")).toHaveTextContent("hover-off");
  });

  it("B21 an event for another key changes nothing", () => {
    const stop = subscribeSettings(noop);
    const before = readSettings();

    // Storage for our key moved without its own event; an unrelated event must not pick it up.
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ ...DEFAULTS, dragToPlay: false }));
    storageEventFor("some.other.key", "1");

    expect(readSettings()).toBe(before);
    stop();
  });

  it("B21 an event carrying corrupt JSON, or a removal, reads as the defaults without throwing", () => {
    render(<Probe name="dragToPlay" />);
    act(() => {
      writeSettings({ dragToPlay: false });
    });
    expect(screen.getByTestId("probe-dragToPlay")).toHaveTextContent("false");

    expect(() => storageEventFor(SETTINGS_STORAGE_KEY, "{broken")).not.toThrow();
    expect(readSettings()).toEqual(DEFAULTS);
    expect(screen.getByTestId("probe-dragToPlay")).toHaveTextContent("true");

    act(() => {
      writeSettings({ dragToPlay: false });
    });
    storageEventFor(SETTINGS_STORAGE_KEY, null);
    expect(readSettings()).toEqual(DEFAULTS);
  });
});

// ---------------------------------------------------------------------------------------------
// B22: reduce motion on <html>, and its CSS
// ---------------------------------------------------------------------------------------------

describe("B22 reduce motion", () => {
  it("B22 true sets <html data-reduce-motion='true'>, and false removes it", () => {
    writeSettings({ reduceMotion: true });
    expect(reduceMotionAttr()).toBe("true");

    writeSettings({ reduceMotion: false });
    expect(reduceMotionAttr()).toBeNull();
  });

  it("B22 is applied on first load from storage", () => {
    store({ reduceMotion: true });

    readSettings();

    expect(reduceMotionAttr()).toBe("true");
  });

  it("B22 is not set on first load when storage says false", () => {
    store({ reduceMotion: false });

    readSettings();

    expect(reduceMotionAttr()).toBeNull();
  });

  it("B22 follows a change from another tab and a reset", () => {
    const stop = subscribeSettings(noop);
    readSettings();

    storageEventFor(SETTINGS_STORAGE_KEY, JSON.stringify({ ...DEFAULTS, reduceMotion: true }));
    expect(reduceMotionAttr()).toBe("true");

    resetSettings();
    expect(reduceMotionAttr()).toBeNull();
    stop();
  });

  it("B22 settings.css sets --anim-scale: 0 under :root[data-reduce-motion='true']", () => {
    const css = readFileSync(SETTINGS_CSS, "utf8");

    expect(css).toMatch(/:root\[data-reduce-motion=["']?true["']?\]\s*\{[^}]*--anim-scale\s*:\s*0\s*[;}]/);
  });
});

// ---------------------------------------------------------------------------------------------
// B41: the setting reaches the animation queue, not only the CSS
// ---------------------------------------------------------------------------------------------

/** A turn later, with the `turnStarted` event that animates the banner for 600 ms. */
function nextTurn(view: ReturnType<typeof baseView>): ReturnType<typeof baseView> {
  return { ...view, turn: view.turn + 1, events: [{ type: "turnStarted", player: "p1", turn: view.turn + 1 }] };
}

function boardTurn(): string | null {
  return screen.getByTestId("board").getAttribute("data-turn");
}

describe("B41 reduce motion drains the animation queue at once, as the OS preference does", () => {
  it("B41 with the setting off, a new view with events waits behind the animation", () => {
    const first = baseView();
    const { rerender } = render(<Game view={first} legal={[]} onAction={noop} />);

    rerender(<Game view={nextTurn(first)} legal={[]} onAction={noop} />);

    expect(screen.getByTestId("animation-queue")).toHaveAttribute("data-animating", "turnStarted");
    expect(boardTurn()).toBe(String(first.turn));
  });

  it("B41 with the setting on, the board shows the new view at once and nothing is held back", () => {
    writeSettings({ reduceMotion: true });
    const first = baseView();
    const { rerender } = render(<Game view={first} legal={[]} onAction={noop} />);

    rerender(<Game view={nextTurn(first)} legal={[]} onAction={noop} />);

    expect(screen.queryByTestId("animation-queue")).toBeNull();
    expect(boardTurn()).toBe(String(first.turn + 1));
  });

  it("B41 turning it on mid-animation shows the newest view at once, and later views wait for nothing", () => {
    const first = baseView();
    const second = nextTurn(first);
    const { rerender } = render(<Game view={first} legal={[]} onAction={noop} />);
    rerender(<Game view={second} legal={[]} onAction={noop} />);
    expect(boardTurn()).toBe(String(first.turn));

    act(() => {
      writeSettings({ reduceMotion: true });
    });
    expect(screen.queryByTestId("animation-queue")).toBeNull();
    expect(boardTurn()).toBe(String(second.turn));

    rerender(<Game view={nextTurn(second)} legal={[]} onAction={noop} />);
    expect(screen.queryByTestId("animation-queue")).toBeNull();
    expect(boardTurn()).toBe(String(second.turn + 1));
  });
});

// ---------------------------------------------------------------------------------------------
// B23: the gears and the dialog
// ---------------------------------------------------------------------------------------------

function renderGame(): void {
  render(<Game view={baseView()} legal={[{ type: "endTurn" }, { type: "concede" }]} onAction={noop} />);
}

function panel(): HTMLElement {
  return screen.getByTestId("settings-panel");
}

function expectClosed(): void {
  expect(screen.queryByTestId("settings-panel")).toBeNull();
}

describe("B23 the settings gears open and close the dialog", () => {
  it("B23 settings-open-game sits in the board's control bar and opens the Settings dialog", async () => {
    renderGame();
    const gear = screen.getByTestId("settings-open-game");

    expect(gear.tagName).toBe("BUTTON");
    expect(gear.closest(".control-bar")).not.toBeNull();
    expect(gear).toHaveAttribute("aria-label", "Settings");
    expect(gear).toHaveAttribute("aria-haspopup", "dialog");
    expect(gear).toHaveAttribute("aria-expanded", "false");
    // A drawn gear, not the U+2699 glyph that rendered as a dot (integration QA).
    expect(gear.querySelector("svg path")).not.toBeNull();
    expectClosed();

    fireEvent.click(gear);

    const dialog = panel();
    expect(dialog).toHaveAttribute("role", "dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAttribute("aria-label", "Settings");
    expect(screen.getByRole("dialog", { name: "Settings" })).toBe(dialog);
    expect(gear).toHaveAttribute("aria-expanded", "true");
    await waitFor(() => expect(document.activeElement).toBe(switchFor("dragToPlay")));
  });

  it("B23 settings-open-nav sits in BackLink's nav and opens the same dialog", async () => {
    render(<BackLink />);
    const gear = screen.getByTestId("settings-open-nav");

    expect(gear.closest("nav")).not.toBeNull();
    expect(gear).toHaveAttribute("aria-label", "Settings");
    expect(gear).toHaveAttribute("aria-haspopup", "dialog");
    expectClosed();

    fireEvent.click(gear);

    expect(panel()).toHaveAttribute("role", "dialog");
    expect(gear).toHaveAttribute("aria-expanded", "true");
    await waitFor(() => expect(document.activeElement).toBe(switchFor("dragToPlay")));
  });

  it("B23 settings-close closes it and gives focus back to the gear", async () => {
    renderGame();
    const gear = screen.getByTestId("settings-open-game");
    fireEvent.click(gear);
    expect(panel()).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("settings-close"));

    expectClosed();
    expect(gear).toHaveAttribute("aria-expanded", "false");
    await waitFor(() => expect(document.activeElement).toBe(gear));
  });

  it("B23 Escape inside the panel closes it, gives focus back, and stops there", async () => {
    renderGame();
    const gear = screen.getByTestId("settings-open-game");
    fireEvent.click(gear);
    const seen = vi.fn();
    window.addEventListener("keydown", seen);

    try {
      fireEvent.keyDown(switchFor("dragToPlay"), { key: "Escape" });

      expectClosed();
      // stopPropagation(): a window-level Escape handler (the drag layer's) never sees it.
      expect(seen).not.toHaveBeenCalled();
      await waitFor(() => expect(document.activeElement).toBe(gear));
    } finally {
      window.removeEventListener("keydown", seen);
    }
  });

  it("B23 a click on the scrim closes it; a click on the panel itself does not", async () => {
    renderGame();
    const gear = screen.getByTestId("settings-open-game");
    fireEvent.click(gear);

    fireEvent.click(panel());
    expect(panel()).toBeInTheDocument();
    fireEvent.click(switchFor("confirmEndTurn"));
    expect(panel()).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("settings-scrim"));

    expectClosed();
    await waitFor(() => expect(document.activeElement).toBe(gear));
  });

  it("B23 focus goes back to whichever gear opened the panel", async () => {
    render(
      <>
        <BackLink />
        <Game view={baseView()} legal={[{ type: "endTurn" }]} onAction={noop} />
      </>,
    );
    const navGear = screen.getByTestId("settings-open-nav");
    const gameGear = screen.getByTestId("settings-open-game");

    fireEvent.click(navGear);
    fireEvent.click(screen.getByTestId("settings-scrim"));
    expectClosed();
    await waitFor(() => expect(document.activeElement).toBe(navGear));

    fireEvent.click(gameGear);
    fireEvent.click(screen.getByTestId("settings-close"));
    expectClosed();
    await waitFor(() => expect(document.activeElement).toBe(gameGear));
  });

  it("B23 settings-close on a bare panel calls onClose once", () => {
    const onClose = vi.fn();
    render(<SettingsPanel onClose={onClose} />);

    fireEvent.click(screen.getByTestId("settings-close"));

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------------------------
// B24: the panel's contents
// ---------------------------------------------------------------------------------------------

describe("B24 the panel's sections, switches, reset and slots", () => {
  const SWITCHES: [SettingKey, string][] = [
    ["dragToPlay", "Drag to play"],
    ["confirmEndTurn", "Confirm end turn"],
    ["hoverPreviews", "Hover previews"],
    ["reduceMotion", "Reduce motion"],
  ];

  it("B24 shows gameplay (drag, confirm, hover) and visuals (reduce motion), and no empty audio section", () => {
    // Integration mounts tasks 1, 2 and 6's controls through SETTINGS_SLOTS (settings-wiring.test.tsx);
    // with no slots the panel is task 7's alone, and a section with nothing in it is not drawn.
    render(<SettingsPanel onClose={noop} slots={[]} />);

    const gameplay = screen.getByTestId("settings-section-gameplay");
    const visuals = screen.getByTestId("settings-section-visuals");
    for (const section of [gameplay, visuals]) {
      expect(section.tagName).toBe("SECTION");
      expect(within(section).getByRole("heading", { level: 2 })).toBeInTheDocument();
    }
    for (const key of ["dragToPlay", "confirmEndTurn", "hoverPreviews"] as const) {
      expect(gameplay.contains(switchFor(key)), key).toBe(true);
    }
    expect(visuals.contains(switchFor("reduceMotion"))).toBe(true);
    expect(gameplay.contains(switchFor("reduceMotion"))).toBe(false);
    expect(screen.queryByTestId("settings-section-audio")).toBeNull();
  });

  it("B24 every control is a checkbox with role switch and its printed label", () => {
    render(<SettingsPanel onClose={noop} />);

    for (const [key, label] of SWITCHES) {
      const input = switchFor(key);
      expect(input.type, key).toBe("checkbox");
      expect(input, key).toHaveAttribute("role", "switch");
      expect(screen.getByRole("switch", { name: label })).toBe(input);
    }
  });

  it("B24 each switch reflects the stored settings", () => {
    store({ dragToPlay: false, reduceMotion: true });
    render(<SettingsPanel onClose={noop} />);

    expect(switchFor("dragToPlay").checked).toBe(false);
    expect(switchFor("confirmEndTurn").checked).toBe(false);
    expect(switchFor("hoverPreviews").checked).toBe(true);
    expect(switchFor("reduceMotion").checked).toBe(true);
  });

  it("B24 toggling a switch writes the store and persists it", () => {
    render(<SettingsPanel onClose={noop} />);

    fireEvent.click(switchFor("confirmEndTurn"));

    expect(readSettings().confirmEndTurn).toBe(true);
    expect(switchFor("confirmEndTurn").checked).toBe(true);
    expect(persisted()).toMatchObject({ confirmEndTurn: true });

    fireEvent.click(switchFor("dragToPlay"));

    expect(readSettings()).toEqual({ ...DEFAULTS, confirmEndTurn: true, dragToPlay: false });
    expect(switchFor("dragToPlay").checked).toBe(false);

    fireEvent.click(switchFor("reduceMotion"));
    expect(readSettings().reduceMotion).toBe(true);
    expect(reduceMotionAttr()).toBe("true");
  });

  it("B24 a change made elsewhere shows on the open panel", () => {
    render(<SettingsPanel onClose={noop} />);
    expect(switchFor("hoverPreviews").checked).toBe(true);

    act(() => {
      writeSettings({ hoverPreviews: false });
    });

    expect(switchFor("hoverPreviews").checked).toBe(false);
  });

  it("B24 settings-reset restores the defaults, in the store and on every switch", () => {
    store({ dragToPlay: false, confirmEndTurn: true, hoverPreviews: false, reduceMotion: true });
    render(<SettingsPanel onClose={noop} />);
    expect(switchFor("confirmEndTurn").checked).toBe(true);

    fireEvent.click(screen.getByTestId("settings-reset"));

    expect(readSettings()).toEqual(DEFAULTS);
    expect(switchFor("dragToPlay").checked).toBe(true);
    expect(switchFor("confirmEndTurn").checked).toBe(false);
    expect(switchFor("hoverPreviews").checked).toBe(true);
    expect(switchFor("reduceMotion").checked).toBe(false);
    expect(reduceMotionAttr()).toBeNull();
  });

  it("B24 an audio slot makes the audio section appear with the slot inside it", () => {
    const slots: SettingsSlot[] = [
      {
        section: "audio",
        id: "master-volume",
        render: () => <input type="range" aria-label="Master volume" data-testid="slot-master-volume" />,
      },
    ];
    render(<SettingsPanel onClose={noop} slots={slots} />);

    const audio = screen.getByTestId("settings-section-audio");
    expect(audio.tagName).toBe("SECTION");
    expect(within(audio).getByRole("heading", { level: 2 })).toBeInTheDocument();
    expect(audio.contains(screen.getByTestId("slot-master-volume"))).toBe(true);
    // The built-in sections are still there.
    expect(screen.getByTestId("settings-section-gameplay")).toBeInTheDocument();
    expect(screen.getByTestId("settings-section-visuals")).toBeInTheDocument();
  });

  it("B24 a slot renders inside its own section, after that section's built-in controls", () => {
    const slots: SettingsSlot[] = [
      { section: "visuals", id: "fx-speed", render: () => <input aria-label="Effects speed" data-testid="slot-fx-speed" /> },
      { section: "gameplay", id: "extra", render: () => <input aria-label="Extra" data-testid="slot-extra" /> },
    ];
    render(<SettingsPanel onClose={noop} slots={slots} />);

    const visuals = screen.getByTestId("settings-section-visuals");
    const gameplay = screen.getByTestId("settings-section-gameplay");
    const fxSpeed = screen.getByTestId("slot-fx-speed");
    const extra = screen.getByTestId("slot-extra");

    expect(visuals.contains(fxSpeed)).toBe(true);
    expect(gameplay.contains(extra)).toBe(true);
    expect(switchFor("reduceMotion").compareDocumentPosition(fxSpeed) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    for (const key of ["dragToPlay", "confirmEndTurn", "hoverPreviews"] as const) {
      expect(switchFor(key).compareDocumentPosition(extra) & Node.DOCUMENT_POSITION_FOLLOWING, key).toBeTruthy();
    }
    // No audio slot, so still no audio section.
    expect(screen.queryByTestId("settings-section-audio")).toBeNull();
  });

  it("B24 the panel opened from the gear shows the same switches, reflecting the store", () => {
    store({ hoverPreviews: false });
    renderGame();

    fireEvent.click(screen.getByTestId("settings-open-game"));

    const dialog = panel();
    for (const [key] of SWITCHES) expect(dialog.contains(switchFor(key)), key).toBe(true);
    expect(switchFor("hoverPreviews").checked).toBe(false);
    expect(switchFor("dragToPlay").checked).toBe(true);
  });
});
