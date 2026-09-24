// The settings panel as the integration branch wires it (docs/polish/reference.md, "Who owns what"):
// task 7's panel mounts task 1's effects speed and intensity, task 6's animated foil and task 2's
// audio controls through SETTINGS_SLOTS, beside its own drag, confirm, hover and motion switches.
// Every control writes its owner's store, which persists it, and the surface that reads that store
// changes at once, on a board already on screen behind the panel. "Reset to defaults" resets every
// store the panel shows. Two settings are one switch each across two stores: "Hover previews" also
// gates task 6's enlarged preview, and "Reduce motion" also stops task 1's effects layer.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CATALOG } from "@jackioh/cards";
import type { PlayerView } from "@jackioh/shared";

import { AUDIO_SETTINGS_KEY } from "../audio/constants.ts";
import { DEFAULT_AUDIO_SETTINGS, readAudioSettings, resetAudioSettingsForTests } from "../audio/settings.ts";
import { CardFace, faceModel, INSPECT_HOVER, closeInspect } from "../cards/index.ts";
import { HOVER_DELAY_MS } from "../cards/inspect/constants.ts";
import { CARD_SETTINGS_DEFAULTS, CARD_SETTINGS_KEY, readCardSettings, writeCardSettings } from "../cards/settings.ts";
import { FX_SETTINGS_KEY, FX_SPEED_STEPS } from "../fx/constants.ts";
import { DEFAULT_FX_SETTINGS, getFxSettings, resetFxSettingsForTests, setFxSettings } from "../fx/settings.ts";
import { reducedMotionNow } from "../game/animations.ts";
import { CatalogContext, lookupFromDefs } from "../game/catalog.ts";
import Game from "../game/Game.tsx";
import Prompt from "../game/Prompt.tsx";
import { baseView, card, emptySide, pendingFor } from "../test/fixtures.ts";
import {
  DEFAULT_SETTINGS,
  SETTINGS_SLOTS,
  SettingsPanel,
  __resetSettingsForTests,
  readSettings,
  writeSettings,
} from "./index.ts";

const noop = (): void => undefined;

beforeEach(() => {
  localStorage.clear();
  __resetSettingsForTests();
  resetFxSettingsForTests();
  resetAudioSettingsForTests();
  writeCardSettings({ ...CARD_SETTINGS_DEFAULTS });
  localStorage.clear();
});

afterEach(() => {
  act(() => {
    closeInspect();
  });
  cleanup();
  vi.useRealTimers();
  localStorage.clear();
  __resetSettingsForTests();
  resetFxSettingsForTests();
  resetAudioSettingsForTests();
  writeCardSettings({ ...CARD_SETTINGS_DEFAULTS });
  localStorage.clear();
});

function stored(key: string): unknown {
  const raw = localStorage.getItem(key);
  return raw === null ? null : JSON.parse(raw);
}

function renderGame(view: PlayerView = baseView()): void {
  render(
    <CatalogContext.Provider value={lookupFromDefs(CATALOG)}>
      <Game view={view} legal={[{ type: "endTurn" }]} onAction={noop} />
    </CatalogContext.Provider>,
  );
}

/** Opens the panel from the board's own gear, as a player would mid-game. */
function openFromBoard(): HTMLElement {
  fireEvent.click(screen.getByTestId("settings-open-game"));
  return screen.getByTestId("settings-panel");
}

function select(testId: string): HTMLSelectElement {
  return screen.getByTestId(testId) as HTMLSelectElement;
}

function toggle(testId: string): HTMLInputElement {
  return screen.getByTestId(testId) as HTMLInputElement;
}

const MYTHIC = Object.values(CATALOG).find((def) => def.rarity === "Mythic");

describe("SETTINGS_SLOTS mounts every task's controls in its own section", () => {
  it("lists task 1's effects and task 6's foil under visuals, and task 2's audio under audio, each with a reset", () => {
    expect(SETTINGS_SLOTS.map((slot) => [slot.section, slot.id])).toEqual([
      ["visuals", "fx"],
      ["visuals", "card-foil"],
      ["audio", "audio"],
    ]);
    for (const slot of SETTINGS_SLOTS) expect(typeof slot.reset, slot.id).toBe("function");
  });

  it("the panel shows effects speed, intensity and foil after Reduce motion, and the audio controls in their section", () => {
    render(<SettingsPanel onClose={noop} />);
    const visuals = screen.getByTestId("settings-section-visuals");
    const audio = screen.getByTestId("settings-section-audio");

    for (const id of ["setting-fxSpeed", "setting-fxIntensity", "setting-animatedFoil"]) {
      const control = screen.getByTestId(id);
      expect(visuals.contains(control), id).toBe(true);
      expect(
        screen.getByTestId("setting-reduceMotion").compareDocumentPosition(control) & Node.DOCUMENT_POSITION_FOLLOWING,
        `${id} follows the built-in switch`,
      ).toBeTruthy();
    }
    const controls = within(audio).getByTestId("audio-controls");
    for (const id of ["audio-master", "audio-sfx", "audio-voice", "audio-mute", "audio-voice-on"]) {
      expect(controls.contains(screen.getByTestId(id)), id).toBe(true);
    }
    // Every control has an accessible name, including the task-owned ones.
    expect(screen.getByRole("combobox", { name: "Effects speed" })).toBe(select("setting-fxSpeed"));
    expect(screen.getByRole("combobox", { name: "Effects intensity" })).toBe(select("setting-fxIntensity"));
    expect(screen.getByRole("switch", { name: "Animated foil" })).toBe(toggle("setting-animatedFoil"));
  });

  it("the speed picker offers R201's steps and shows the stored speed, even one off the steps", () => {
    render(<SettingsPanel onClose={noop} />);
    const values = Array.from(select("setting-fxSpeed").options).map((option) => Number(option.value));
    expect(values).toEqual([...FX_SPEED_STEPS]);
    expect(select("setting-fxSpeed").value).toBe(String(DEFAULT_FX_SETTINGS.speed));
    cleanup();

    act(() => {
      setFxSettings({ speed: 1.25 });
    });
    render(<SettingsPanel onClose={noop} />);
    expect(select("setting-fxSpeed").value).toBe("1.25");
  });
});

describe("every setting persists and applies live, on a board already on screen", () => {
  it("effects speed: the store the runner reads at every enqueue (R201), persisted", () => {
    renderGame();
    openFromBoard();
    fireEvent.change(select("setting-fxSpeed"), { target: { value: "2" } });

    expect(getFxSettings().speed).toBe(2);
    expect(stored(FX_SETTINGS_KEY)).toMatchObject({ speed: 2 });
    expect(select("setting-fxSpeed").value).toBe("2");
  });

  it("effects intensity Off turns the effects layer off at once, and Normal back on", () => {
    renderGame();
    const layer = screen.getByTestId("fx-layer");
    expect(layer).toHaveAttribute("data-fx", "on");
    openFromBoard();

    fireEvent.change(select("setting-fxIntensity"), { target: { value: "off" } });
    expect(screen.getByTestId("fx-layer")).toHaveAttribute("data-fx", "off");
    expect(stored(FX_SETTINGS_KEY)).toMatchObject({ intensity: "off" });

    fireEvent.change(select("setting-fxIntensity"), { target: { value: "normal" } });
    expect(screen.getByTestId("fx-layer")).toHaveAttribute("data-fx", "on");
  });

  it("animated foil: a Mythic face on screen stops shimmering and starts again", () => {
    if (MYTHIC === undefined) throw new Error("the catalog has no Mythic card");
    render(
      <>
        <CardFace face={faceModel({ defId: MYTHIC.id, def: MYTHIC, radiant: false })} layout="full" />
        <SettingsPanel onClose={noop} />
      </>,
    );
    const face = (): Element | null => document.querySelector(".cf[data-foil]");
    expect(face()).toHaveAttribute("data-foil", "animated");

    fireEvent.click(toggle("setting-animatedFoil"));
    expect(face()).toHaveAttribute("data-foil", "static");
    expect(readCardSettings().animatedFoil).toBe(false);
    expect(stored(CARD_SETTINGS_KEY)).toMatchObject({ animatedFoil: false });

    fireEvent.click(toggle("setting-animatedFoil"));
    expect(face()).toHaveAttribute("data-foil", "animated");
  });

  it("audio: a volume, mute and voice lines write task 2's store, which the engine hears", () => {
    renderGame();
    openFromBoard();
    fireEvent.change(screen.getByTestId("audio-master"), { target: { value: "35" } });
    fireEvent.click(screen.getByTestId("audio-voice-on"));

    expect(readAudioSettings()).toMatchObject({ master: 0.35, voiceOn: false });
    expect(stored(AUDIO_SETTINGS_KEY)).toMatchObject({ master: 0.35, voiceOn: false });

    // The HUD's mute button and the panel's mute are one setting.
    fireEvent.click(screen.getByTestId("audio-mute"));
    expect(screen.getByTestId("audio-toggle")).toHaveAttribute("aria-pressed", "true");
  });

  it("drag to play: the board behind the panel switches to tap-to-select at once", () => {
    renderGame();
    expect(screen.getByTestId("board")).toHaveAttribute("data-drag", "on");
    openFromBoard();
    fireEvent.click(toggle("setting-dragToPlay"));
    expect(screen.getByTestId("board")).toHaveAttribute("data-drag", "off");
    expect(readSettings().dragToPlay).toBe(false);
  });

  it("Reset to defaults resets every store the panel shows, not only task 7's", () => {
    render(<SettingsPanel onClose={noop} />);
    act(() => {
      writeSettings({ dragToPlay: false, reduceMotion: true });
    });
    fireEvent.change(select("setting-fxSpeed"), { target: { value: "0.5" } });
    fireEvent.change(select("setting-fxIntensity"), { target: { value: "high" } });
    fireEvent.click(toggle("setting-animatedFoil"));
    fireEvent.change(screen.getByTestId("audio-sfx"), { target: { value: "10" } });
    fireEvent.click(screen.getByTestId("audio-mute"));

    fireEvent.click(screen.getByTestId("settings-reset"));

    expect(readSettings()).toEqual(DEFAULT_SETTINGS);
    expect(getFxSettings()).toEqual(DEFAULT_FX_SETTINGS);
    expect(readCardSettings()).toEqual(CARD_SETTINGS_DEFAULTS);
    expect(readAudioSettings()).toEqual(DEFAULT_AUDIO_SETTINGS);
    expect(select("setting-fxSpeed").value).toBe(String(DEFAULT_FX_SETTINGS.speed));
    expect(toggle("setting-animatedFoil").checked).toBe(true);
  });
});

describe("one switch across two stores", () => {
  const DISCOVER = ["core-043", "core-055"] as const;

  function discover(): PlayerView {
    return baseView({
      you: emptySide("p1", { hand: [card({ instanceId: "h1", defId: "core-002" })] }),
      opponent: emptySide("p2", { hand: { count: 3 } }),
      pending: pendingFor(
        "discover",
        DISCOVER.map((defId) => ({ key: `mode:${defId}`, label: defId, defId })),
      ),
    });
  }

  function restOn(testId: string): void {
    fireEvent.pointerEnter(screen.getByTestId(testId), { pointerType: "mouse" });
    act(() => {
      vi.advanceTimersByTime(HOVER_DELAY_MS);
    });
  }

  it("Hover previews off in the panel keeps task 6's enlarged preview shut, and on lets it open again", () => {
    vi.useFakeTimers();
    render(
      <CatalogContext.Provider value={lookupFromDefs(CATALOG)}>
        <Prompt view={discover()} onAction={noop} />
      </CatalogContext.Provider>,
    );

    act(() => {
      writeSettings({ hoverPreviews: false });
    });
    restOn("prompt-option-mode:core-043");
    expect(screen.queryByTestId(INSPECT_HOVER), "the panel's switch is off").toBeNull();
    // Task 6's own store still says yes: the panel's switch alone kept it shut.
    expect(readCardSettings().hoverPreviews).toBe(true);
    fireEvent.pointerLeave(screen.getByTestId("prompt-option-mode:core-043"), { pointerType: "mouse" });

    act(() => {
      writeSettings({ hoverPreviews: true });
    });
    restOn("prompt-option-mode:core-055");
    expect(screen.getByTestId(INSPECT_HOVER)).toBeInTheDocument();
  });

  it("Hover previews off also brings back a card's native tooltip, which the preview replaces", () => {
    renderGame(
      baseView({
        you: emptySide("p1", { hand: [card({ instanceId: "h1", defId: "core-002" })] }),
      }),
    );
    const handCard = (): HTMLElement => screen.getByTestId("hand-card-h1");
    expect(handCard()).not.toHaveAttribute("title");
    act(() => {
      writeSettings({ hoverPreviews: false });
    });
    expect(handCard()).toHaveAttribute("title", CATALOG["core-002"]?.name ?? "");
    expect(screen.getByTestId("hand-you")).toHaveAttribute("data-hover-preview", "off");
  });

  it("Reduce motion in the panel turns task 1's effects layer off live, as the media query does", () => {
    renderGame();
    expect(screen.getByTestId("fx-layer")).toHaveAttribute("data-fx", "on");
    expect(reducedMotionNow()).toBe(false);

    openFromBoard();
    fireEvent.click(toggle("setting-reduceMotion"));

    expect(screen.getByTestId("fx-layer")).toHaveAttribute("data-fx", "off");
    expect(reducedMotionNow(), "every motion check outside React reads the switch too").toBe(true);
    expect(document.documentElement).toHaveAttribute("data-reduce-motion", "true");

    fireEvent.click(toggle("setting-reduceMotion"));
    expect(screen.getByTestId("fx-layer")).toHaveAttribute("data-fx", "on");
    expect(reducedMotionNow()).toBe(false);
  });

  it("Reduce motion stops CSS motion on every screen: index.css keys animations.css's reduced block on the attribute", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const css = readFileSync(join(here, "../index.css"), "utf8").replace(/\s+/g, " ");
    expect(css).toContain(':root[data-reduce-motion="true"] { --anim-scale: 0; }');
    const block = /:root\[data-reduce-motion="true"\] \*, :root\[data-reduce-motion="true"\] \*::before, :root\[data-reduce-motion="true"\] \*::after \{([^}]*)\}/.exec(css);
    expect(block, "the attribute's own copy of the reduced-motion block").not.toBeNull();
    for (const decl of ["animation-duration: 0s !important", "animation-iteration-count: 1 !important", "transition-duration: 0s !important"]) {
      expect(block?.[1], decl).toContain(decl);
    }
  });
});
