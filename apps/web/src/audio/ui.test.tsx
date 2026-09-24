// The audio UI and its wiring into Game (docs/polish/2-sound.md, B28 to B32, B44's preload, and
// B58: no background voice work while the board animates).
//
// B28's other half, "every pre-existing web test stays green", is the whole `web` project run, not
// a test of its own: `pnpm vitest run --project web`.

import type { GameEvent, PlayerView } from "@jackioh/shared";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { appAudioHolders, retainAppAudio } from "./appAudio.ts";
import AudioControls from "./AudioControls.tsx";
import AudioToggle from "./AudioToggle.tsx";
import {
  AUDIO_SETTINGS_KEY,
  UI_HOVER_THROTTLE_MS,
  VOICE_DELAY_MS,
  VOICE_PREFETCH_CONCURRENCY,
  VOICE_PREFETCH_DELAY_MS,
  VOICE_PREVIEW_DEF_ID,
  VOICE_PRIORITY,
} from "./constants.ts";
import { exposeAudioDebug, type AudioDebugHandle } from "./debug.ts";
import { createAudioEngine, getAudioEngine, setAudioEngineForTests } from "./engine.ts";
import { readAudioSettings, resetAudioSettingsForTests, writeAudioSettings } from "./settings.ts";
import { FakeClock, FakeFetch, fakeContextFactory } from "./test/fakeAudio.ts";
import type { AudioEngine, AudioState, PlayedCue, SoundSink } from "./types.ts";
import { installUiSounds } from "./uiSounds.ts";
import { VOICE_LINES, voiceKeysForView } from "./voiceData.ts";
import { durationFor } from "../game/animations.ts";
import Game from "../game/Game.tsx";
import { baseView, card, emptySide, unit, withEvents } from "../test/fixtures.ts";
import { setReducedMotion } from "../test/setup.ts";

/* --------------------------------------------------------------------------------------------- *
 * Fixtures
 * --------------------------------------------------------------------------------------------- */

type FakeEngine = { [K in keyof AudioEngine]: Mock<AudioEngine[K]> };

/** A stand-in for the singleton: records every call, plays nothing. */
function fakeEngine(options: { state?: AudioState; contexts?: number; log?: PlayedCue[] } = {}): FakeEngine {
  const log: PlayedCue[] = [...(options.log ?? [])];
  const engine: FakeEngine = {
    state: vi.fn<AudioEngine["state"]>(() => options.state ?? "locked"),
    unlock: vi.fn<AudioEngine["unlock"]>(),
    preloadVoices: vi.fn<AudioEngine["preloadVoices"]>(),
    setBusy: vi.fn<AudioEngine["setBusy"]>(),
    log: vi.fn<AudioEngine["log"]>(() => log),
    clearLog: vi.fn<AudioEngine["clearLog"]>(() => {
      log.length = 0;
    }),
    contextsCreated: vi.fn<AudioEngine["contextsCreated"]>(() => options.contexts ?? 0),
    speaking: vi.fn<AudioEngine["speaking"]>(() => false),
    subscribeSpeaking: vi.fn<AudioEngine["subscribeSpeaking"]>(() => () => undefined),
    dispose: vi.fn<AudioEngine["dispose"]>(),
    playSfx: vi.fn<AudioEngine["playSfx"]>(() => true),
    playVoice: vi.fn<AudioEngine["playVoice"]>(() => true),
  };
  return engine;
}

function renderGame(view: PlayerView) {
  return render(<Game view={view} legal={[]} onAction={() => undefined} />);
}

function rerenderGame(rerender: (ui: ReactElement) => void, view: PlayerView): void {
  rerender(<Game view={view} legal={[]} onAction={() => undefined} />);
}

const turnStarted: GameEvent = { type: "turnStarted", player: "p1", turn: 4 };
/** #4 Gary the Gambler, a Unit with a play line in the shipped voice table. */
const unitPlayed: GameEvent = { type: "cardPlayed", player: "p1", instanceId: "c77", defId: "core-004", costPaid: 3 };

function storedSettings(): Record<string, unknown> | null {
  const raw = localStorage.getItem(AUDIO_SETTINGS_KEY);
  return raw === null ? null : (JSON.parse(raw) as Record<string, unknown>);
}

const mounted: HTMLElement[] = [];

/**
 * Renders fixed markup into its own attached root. Through React, not by assigning raw HTML, so
 * this file keeps to task 5's B36 like every other file under apps/web/src (auth/no-raw-html.test.ts).
 */
function mount(ui: ReactElement): HTMLElement {
  const root = document.createElement("div");
  document.body.append(root);
  mounted.push(root);
  render(ui, { container: root });
  return root;
}

function byId(root: ParentNode, id: string): HTMLElement {
  const el = root.querySelector<HTMLElement>(`#${id}`);
  if (el === null) throw new Error(`no #${id}`);
  return el;
}

function hover(el: Element, pointerType: string): void {
  el.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, pointerType }));
}

function uiSink(): { playSfx: Mock<SoundSink["playSfx"]> } {
  return { playSfx: vi.fn<SoundSink["playSfx"]>(() => true) };
}

const played = (sink: ReturnType<typeof uiSink>): string[] => sink.playSfx.mock.calls.map((call) => call[0]);

beforeEach(() => {
  localStorage.clear();
  resetAudioSettingsForTests();
  setAudioEngineForTests(null);
});

afterEach(() => {
  cleanup();
  for (const root of mounted.splice(0)) root.remove();
  setAudioEngineForTests(null);
  setReducedMotion(false);
  vi.useRealTimers();
  vi.restoreAllMocks();
  resetAudioSettingsForTests();
  localStorage.clear();
});

/* --------------------------------------------------------------------------------------------- *
 * B28: Game with audio
 * --------------------------------------------------------------------------------------------- */

describe("B28 Game plays sound in step with its runner", () => {
  it("B28 Game renders in jsdom with no AudioContext, shows the audio toggle, and new views change nothing audible", () => {
    const first = baseView();
    const { rerender } = renderGame(first);

    expect(screen.getByTestId("audio-toggle")).toBeInTheDocument();
    const engine = getAudioEngine();
    expect(engine.state()).toBe("unsupported");

    expect(() =>
      rerenderGame(rerender, withEvents(first, [turnStarted, unitPlayed, { type: "gameOver", winner: "p1", reason: "concede" }])),
    ).not.toThrow();
    fireEvent.click(screen.getByTestId("audio-toggle"));

    expect(engine.log()).toEqual([]);
    expect(engine.contextsCreated()).toBe(0);
    expect(getAudioEngine()).toBe(engine);
  });

  it("B28 a unit's play line reaches the engine when the runner starts its entry, not when the view arrives", () => {
    vi.useFakeTimers();
    const engine = fakeEngine();
    setAudioEngineForTests(engine);
    const first = baseView();
    const { rerender } = renderGame(first);

    rerenderGame(rerender, withEvents(first, [turnStarted, unitPlayed]));

    // The turn-start entry is in flight; the play is queued behind it.
    expect(engine.playSfx.mock.calls.map((c) => c[0])).toContain("turnStart");
    expect(engine.playVoice).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(durationFor("turnStarted", false));
    });
    expect(engine.playVoice).toHaveBeenCalledTimes(1);
    expect(engine.playVoice).toHaveBeenCalledWith("core-004", "play", VOICE_DELAY_MS, VOICE_PRIORITY.play);

    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(engine.playVoice, "the runner going idle does not voice it again").toHaveBeenCalledTimes(1);
  });

  it("B28 under reduced motion the play line arrives through the flush, once", () => {
    setReducedMotion(true);
    vi.useFakeTimers();
    const engine = fakeEngine();
    setAudioEngineForTests(engine);
    const first = baseView();
    const { rerender } = renderGame(first);

    rerenderGame(rerender, withEvents(first, [turnStarted, unitPlayed]));

    expect(engine.playVoice).toHaveBeenCalledTimes(1);
    expect(engine.playVoice).toHaveBeenCalledWith("core-004", "play", VOICE_DELAY_MS, VOICE_PRIORITY.play);
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(engine.playVoice).toHaveBeenCalledTimes(1);
  });

  it("B2 inside Game, the first click unlocks the engine", () => {
    const engine = fakeEngine({ state: "locked" });
    setAudioEngineForTests(engine);
    renderGame(baseView());
    expect(engine.unlock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("audio-toggle"));

    expect(engine.unlock).toHaveBeenCalled();
  });

  it("B31 inside Game, clicking an enabled button plays uiClick", () => {
    const engine = fakeEngine({ state: "running" });
    setAudioEngineForTests(engine);
    renderGame(baseView());

    fireEvent.click(screen.getByTestId("audio-toggle"));

    expect(engine.playSfx.mock.calls.map((c) => c[0])).toContain("uiClick");
  });
});

/* --------------------------------------------------------------------------------------------- *
 * B29: the mute toggle
 * --------------------------------------------------------------------------------------------- */

describe("B29 AudioToggle", () => {
  it("B29 renders an unpressed button labelled Mute sound while not muted", () => {
    render(<AudioToggle />);
    const button = screen.getByTestId("audio-toggle");

    expect(button.tagName).toBe("BUTTON");
    expect(button).toHaveAttribute("type", "button");
    expect(button).toHaveClass("audio-toggle");
    expect(button).toHaveAttribute("aria-pressed", "false");
    expect(button).toHaveAttribute("aria-label", "Mute sound");
    expect(button).toHaveAttribute("title", "Mute sound");
  });

  it("B29 a click flips muted, persists it, and relabels the button", () => {
    render(<AudioToggle />);
    const button = screen.getByTestId("audio-toggle");

    fireEvent.click(button);

    expect(button).toHaveAttribute("aria-pressed", "true");
    expect(button).toHaveAttribute("aria-label", "Unmute sound");
    expect(button).toHaveAttribute("title", "Unmute sound");
    expect(readAudioSettings().muted).toBe(true);
    expect(storedSettings()?.muted).toBe(true);

    fireEvent.click(button);
    expect(button).toHaveAttribute("aria-pressed", "false");
    expect(storedSettings()?.muted).toBe(false);
  });

  it("B29 a remounted toggle shows the stored value", () => {
    render(<AudioToggle />);
    fireEvent.click(screen.getByTestId("audio-toggle"));
    cleanup();
    resetAudioSettingsForTests(); // forget the cache: the next read comes from storage

    render(<AudioToggle />);

    expect(screen.getByTestId("audio-toggle")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("audio-toggle")).toHaveAttribute("aria-label", "Unmute sound");
  });

  it("B29 stored muted settings render pressed, labelled Unmute sound", () => {
    localStorage.setItem(AUDIO_SETTINGS_KEY, JSON.stringify({ master: 0.8, sfx: 0.8, voice: 1, muted: true, voiceOn: true }));
    render(<AudioToggle />);

    expect(screen.getByTestId("audio-toggle")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("audio-toggle")).toHaveAttribute("aria-label", "Unmute sound");
  });

  it("B29 unreadable stored settings render the default, not muted", () => {
    localStorage.setItem(AUDIO_SETTINGS_KEY, "{broken");
    render(<AudioToggle />);

    expect(screen.getByTestId("audio-toggle")).toHaveAttribute("aria-pressed", "false");
  });

  it("B29 follows a change made elsewhere in the store", () => {
    render(<AudioToggle />);

    act(() => {
      writeAudioSettings({ muted: true });
    });

    expect(screen.getByTestId("audio-toggle")).toHaveAttribute("aria-pressed", "true");
  });

  it("B29 a className is added to audio-toggle, not put in its place", () => {
    render(<AudioToggle className="hud-slot" />);
    const button = screen.getByTestId("audio-toggle");

    expect(button).toHaveClass("audio-toggle");
    expect(button).toHaveClass("hud-slot");
  });
});

/* --------------------------------------------------------------------------------------------- *
 * B30: the full controls
 * --------------------------------------------------------------------------------------------- */

describe("B30 AudioControls", () => {
  function input(id: string): HTMLInputElement {
    const el = screen.getByTestId(id);
    if (!(el instanceof HTMLInputElement)) throw new Error(`${id} is not an <input>`);
    return el;
  }

  it("B30 renders a fieldset with the legend Audio, three 0 to 100 step 5 ranges and two checkboxes bound to the store", () => {
    render(<AudioControls />);
    const fieldset = screen.getByTestId("audio-controls");

    expect(fieldset.tagName).toBe("FIELDSET");
    expect(fieldset).toHaveClass("audio-controls");
    expect(fieldset.querySelector("legend")?.textContent).toBe("Audio");
    for (const [id, value] of [
      ["audio-master", "80"],
      ["audio-sfx", "80"],
      ["audio-voice", "100"],
    ] as const) {
      const range = input(id);
      expect(range.type, id).toBe("range");
      expect(range.min, id).toBe("0");
      expect(range.max, id).toBe("100");
      expect(range.step, id).toBe("5");
      expect(range.value, id).toBe(value);
    }
    expect(input("audio-mute").type).toBe("checkbox");
    expect(input("audio-mute").checked).toBe(false);
    expect(input("audio-voice-on").type).toBe("checkbox");
    expect(input("audio-voice-on").checked).toBe(true);
  });

  it("B30 every input has a label", () => {
    render(<AudioControls />);

    for (const id of ["audio-master", "audio-sfx", "audio-voice", "audio-mute", "audio-voice-on"]) {
      expect(input(id).labels?.length ?? 0, id).toBeGreaterThan(0);
    }
  });

  it("B30 changing a range writes value / 100 to the store", () => {
    render(<AudioControls />);

    fireEvent.change(input("audio-master"), { target: { value: "35" } });
    fireEvent.change(input("audio-sfx"), { target: { value: "0" } });
    fireEvent.change(input("audio-voice"), { target: { value: "55" } });

    const settings = readAudioSettings();
    expect(settings.master).toBeCloseTo(0.35, 6);
    expect(settings.sfx).toBe(0);
    expect(settings.voice).toBeCloseTo(0.55, 6);
    expect(storedSettings()?.master).toBeCloseTo(0.35, 6);
    expect(input("audio-master").value).toBe("35");
  });

  it("B30 toggling audio-mute writes muted, and toggling audio-voice-on writes voiceOn", () => {
    render(<AudioControls />);

    fireEvent.click(input("audio-mute"));
    expect(readAudioSettings().muted).toBe(true);
    expect(input("audio-mute").checked).toBe(true);

    fireEvent.click(input("audio-voice-on"));
    expect(readAudioSettings().voiceOn).toBe(false);
    expect(input("audio-voice-on").checked).toBe(false);
    expect(storedSettings()).toMatchObject({ muted: true, voiceOn: false });
  });

  it("B30 follows the store: a write elsewhere moves the controls, rounded to the nearest percent", () => {
    render(<AudioControls />);

    act(() => {
      writeAudioSettings({ master: 0.333, voice: 0.45, muted: true, voiceOn: false });
    });

    expect(input("audio-master").value).toBe("33");
    expect(input("audio-voice").value).toBe("45");
    expect(input("audio-mute").checked).toBe(true);
    expect(input("audio-voice-on").checked).toBe(false);
  });

  it("B30 the mute toggle and the controls share one store", () => {
    render(
      <>
        <AudioToggle />
        <AudioControls />
      </>,
    );

    fireEvent.click(screen.getByTestId("audio-toggle"));

    expect(input("audio-mute").checked).toBe(true);
  });

  it("B30 a className is added to audio-controls", () => {
    render(<AudioControls className="settings-section" />);

    expect(screen.getByTestId("audio-controls")).toHaveClass("audio-controls");
    expect(screen.getByTestId("audio-controls")).toHaveClass("settings-section");
  });
});

/* --------------------------------------------------------------------------------------------- *
 * B31: UI ticks
 * --------------------------------------------------------------------------------------------- */

describe("B31 UI click and hover sounds", () => {
  const PAGE = (
    <>
      <button id="enabled">
        <span id="inside">Play</span>
      </button>
      <button id="enabled-2">Pass</button>
      <button id="disabled" disabled>
        Nope
      </button>
      <div id="role" role="button">
        Role
      </div>
      <div id="role-disabled" role="button" aria-disabled="true">
        Role off
      </div>
      <div id="legal" data-legal="true">
        Zone
      </div>
      <div id="legal-2" data-legal="true">
        Zone 2
      </div>
      <div id="illegal" data-legal="false">
        Zone off
      </div>
      <p id="plain">Just text</p>
    </>
  );

  function rig() {
    const root = mount(PAGE);
    const sink = uiSink();
    const clock = new FakeClock(1_000);
    const remove = installUiSounds(sink, root, clock.now);
    return { root, sink, clock, remove };
  }

  it("B31 a click on an enabled button, on anything inside it, on a [role=button] or on a [data-legal=true] element plays uiClick", () => {
    const { root, sink, remove } = rig();

    for (const id of ["enabled", "inside", "role", "legal"]) fireEvent.click(byId(root, id));

    expect(played(sink)).toEqual(["uiClick", "uiClick", "uiClick", "uiClick"]);
    remove();
  });

  it("B31 a click on a disabled button, an aria-disabled [role=button], a data-legal=false element or plain content plays nothing", () => {
    const { root, sink, remove } = rig();

    for (const id of ["disabled", "role-disabled", "illegal", "plain"]) fireEvent.click(byId(root, id));

    expect(sink.playSfx).not.toHaveBeenCalled();
    remove();
  });

  it("B31 a mouse pointerover onto a new button or [data-legal=true] element plays uiHover", () => {
    const { root, sink, clock, remove } = rig();

    hover(byId(root, "enabled"), "mouse");
    clock.advance(UI_HOVER_THROTTLE_MS);
    hover(byId(root, "legal"), "mouse");

    expect(played(sink)).toEqual(["uiHover", "uiHover"]);
    remove();
  });

  it("B31 hover sounds are throttled to one per UI_HOVER_THROTTLE_MS", () => {
    const { root, sink, clock, remove } = rig();

    hover(byId(root, "enabled"), "mouse");
    clock.advance(UI_HOVER_THROTTLE_MS - 1);
    hover(byId(root, "enabled-2"), "mouse");
    expect(played(sink)).toEqual(["uiHover"]);

    clock.advance(1);
    hover(byId(root, "legal-2"), "mouse");
    expect(played(sink)).toEqual(["uiHover", "uiHover"]);
    remove();
  });

  it("B31 moving within the element last hovered plays nothing more", () => {
    const { root, sink, clock, remove } = rig();

    hover(byId(root, "enabled"), "mouse");
    clock.advance(UI_HOVER_THROTTLE_MS * 5);
    hover(byId(root, "inside"), "mouse");
    hover(byId(root, "enabled"), "mouse");
    expect(played(sink)).toEqual(["uiHover"]);

    clock.advance(UI_HOVER_THROTTLE_MS * 5);
    hover(byId(root, "legal"), "mouse");
    clock.advance(UI_HOVER_THROTTLE_MS * 5);
    hover(byId(root, "inside"), "mouse");
    expect(played(sink)).toEqual(["uiHover", "uiHover", "uiHover"]);
    remove();
  });

  it("B31 a touch or pen pointerover plays nothing", () => {
    const { root, sink, clock, remove } = rig();

    hover(byId(root, "enabled"), "touch");
    clock.advance(UI_HOVER_THROTTLE_MS * 5);
    hover(byId(root, "legal"), "pen");

    expect(sink.playSfx).not.toHaveBeenCalled();
    remove();
  });

  it("B31 hovering a disabled button, a [role=button], a data-legal=false element or plain content plays nothing", () => {
    const { root, sink, clock, remove } = rig();

    for (const id of ["disabled", "role", "illegal", "plain"]) {
      hover(byId(root, id), "mouse");
      clock.advance(UI_HOVER_THROTTLE_MS * 5);
    }

    expect(sink.playSfx).not.toHaveBeenCalled();
    remove();
  });

  it("B31 the remover takes both listeners off", () => {
    const { root, sink, clock, remove } = rig();
    remove();

    fireEvent.click(byId(root, "enabled"));
    clock.advance(UI_HOVER_THROTTLE_MS * 5);
    hover(byId(root, "legal"), "mouse");

    expect(sink.playSfx).not.toHaveBeenCalled();
  });

  it("B31 with the document as root, a click anywhere in the page is heard", () => {
    const root = mount(PAGE);
    const sink = uiSink();
    const remove = installUiSounds(sink, document, new FakeClock().now);

    fireEvent.click(byId(root, "legal"));
    fireEvent.click(byId(root, "plain"));

    expect(played(sink)).toEqual(["uiClick"]);
    remove();
  });
});

/* --------------------------------------------------------------------------------------------- *
 * B32: the debug handle
 * --------------------------------------------------------------------------------------------- */

describe("B32 window.__jackiohAudio", () => {
  it("B32 mounting Game exposes the singleton's state, log, clearLog and contextsCreated, and unmounting removes it", () => {
    const entry: PlayedCue = { kind: "sfx", id: "draw", delayMs: 0, atMs: 12 };
    const engine = fakeEngine({ state: "suspended", contexts: 1, log: [entry] });
    setAudioEngineForTests(engine);
    expect(window.__jackiohAudio).toBeUndefined();

    const { unmount } = renderGame(baseView());
    const handle: AudioDebugHandle | undefined = window.__jackiohAudio;

    expect(handle).toBeDefined();
    expect(handle?.state()).toBe("suspended");
    expect(handle?.contextsCreated()).toBe(1);
    expect(handle?.log()).toEqual([entry]);
    handle?.clearLog();
    expect(engine.clearLog).toHaveBeenCalledTimes(1);
    expect(handle?.log()).toEqual([]);

    unmount();
    expect(window.__jackiohAudio).toBeUndefined();
  });

  it("B32 with no fake engine the handle reports jsdom's engine: unsupported, no context, an empty log", () => {
    const { unmount } = renderGame(baseView());

    expect(window.__jackiohAudio?.state()).toBe("unsupported");
    expect(window.__jackiohAudio?.contextsCreated()).toBe(0);
    expect(window.__jackiohAudio?.log()).toEqual([]);
    unmount();
  });

  it("B32 exposeAudioDebug sets the handle and its remover deletes it", () => {
    const engine = fakeEngine({ state: "running", contexts: 1 });
    const off = exposeAudioDebug(engine);

    expect(window.__jackiohAudio?.state()).toBe("running");
    off();
    expect(window.__jackiohAudio).toBeUndefined();
  });

  it("B32 the remover leaves a handle that is no longer its own", () => {
    const off = exposeAudioDebug(fakeEngine());
    const other: AudioDebugHandle = {
      state: () => "running",
      log: () => [],
      clearLog: () => undefined,
      contextsCreated: () => 1,
    };
    window.__jackiohAudio = other;

    off();

    expect(window.__jackiohAudio).toBe(other);
    delete window.__jackiohAudio;
  });
});

/* --------------------------------------------------------------------------------------------- *
 * B44: the hook preloads what a view makes likely (useGameAudio step 6)
 * --------------------------------------------------------------------------------------------- */

describe("B44 Game preloads the voice lines each view makes likely, once the context runs", () => {
  it("B44 a running engine is asked for voiceKeysForView of the first view and of every new one", () => {
    const engine = fakeEngine({ state: "running" });
    setAudioEngineForTests(engine);
    const first = baseView({ you: emptySide("p1", { hand: [card({ defId: "core-004" }), card({ defId: "core-005" })] }) });
    const { rerender } = renderGame(first);

    expect(engine.preloadVoices).toHaveBeenLastCalledWith(voiceKeysForView(first, VOICE_LINES));
    expect(engine.preloadVoices.mock.lastCall?.[0]).toEqual(["core-004-play", "core-005-cast"]);

    const second = baseView({ you: emptySide("p1", { units: [unit("p1", { defId: "core-012" }), null, null, null, null] }) });
    rerenderGame(rerender, second);

    expect(engine.preloadVoices).toHaveBeenLastCalledWith(["core-012-death"]);
  });

  it("B44 an engine that is not running is never asked to preload", () => {
    for (const state of ["locked", "suspended", "unsupported"] as const) {
      const engine = fakeEngine({ state });
      setAudioEngineForTests(engine);
      const view = baseView({ you: emptySide("p1", { hand: [card({ defId: "core-004" })] }) });
      const { rerender, unmount } = renderGame(view);
      rerenderGame(rerender, withEvents(view, [turnStarted]));

      expect(engine.preloadVoices, state).not.toHaveBeenCalled();
      unmount();
    }
  });
});

/* --------------------------------------------------------------------------------------------- *
 * B58: no background voice work while the board animates
 * --------------------------------------------------------------------------------------------- */

/**
 * The shape of the burst that broke e2e spec 08 in CI: R82 auto-ending dead turns back to back,
 * each with its banner, mana and draw. 3200 ms of table durations, played in BURST_BUDGET_MS.
 */
function autoEndedTurns(): GameEvent[] {
  const turn = (player: "p1" | "p2", n: number): GameEvent[] => [
    { type: "turnStarted", player, turn: n },
    { type: "manaChanged", player, current: 1, max: 1 },
    { type: "drawn", player, instanceId: `d${String(n)}`, defId: "core-001" },
    { type: "turnAutoEnded", player, turn: n },
  ];
  return [...turn("p2", 4), ...turn("p1", 5)];
}

describe("B58 the board's animations hold background voice work", () => {
  it("B58 Game holds the engine busy while its runner has an entry in flight, before that entry's cues, and frees it at idle", () => {
    vi.useFakeTimers();
    const engine = fakeEngine({ state: "running" });
    setAudioEngineForTests(engine);
    const first = baseView();
    const { rerender, unmount } = renderGame(first);
    expect(engine.setBusy).toHaveBeenLastCalledWith(false);

    rerenderGame(rerender, withEvents(first, [turnStarted, unitPlayed]));
    expect(engine.setBusy).toHaveBeenLastCalledWith(true);
    const busyAt = Math.min(...engine.setBusy.mock.calls.flatMap((call, i) => (call[0] ? [engine.setBusy.mock.invocationCallOrder[i] ?? 0] : [])));
    expect(busyAt, "busy before the entry's first cue").toBeLessThan(Math.min(...engine.playSfx.mock.invocationCallOrder));

    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    expect(engine.setBusy).toHaveBeenLastCalledWith(false);

    rerenderGame(rerender, withEvents(first, [turnStarted, unitPlayed, { type: "turnStarted", player: "p1", turn: 5 }]));
    expect(engine.setBusy).toHaveBeenLastCalledWith(true);
    unmount();
    expect(engine.setBusy, "a Game unmounted mid-burst frees the engine").toHaveBeenLastCalledWith(false);
  });

  it("B58 with the real engine, a burst holds the voice prefetch and the new view's preload until the board is still", async () => {
    vi.useFakeTimers();
    const fetch = new FakeFetch();
    fetch.mode = "hang";
    const engine = createAudioEngine({
      createContext: fakeContextFactory({ state: "running" }).create,
      speech: null,
      fetchBytes: fetch.fetchBytes,
      visibility: () => "visible",
    });
    setAudioEngineForTests(engine);
    engine.unlock();
    const url = (key: string): string => `/audio/voice/${key}.m4a`;
    const advance = async (ms: number): Promise<void> => {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
      });
    };

    try {
      const first = baseView({ you: emptySide("p1", { hand: [card({ defId: "core-004" })] }) });
      const { rerender } = renderGame(first);
      expect(fetch.urls(), "the first view's preload, on a still board").toEqual([url("core-004-play")]);

      // The prefetch comes due VOICE_PREFETCH_DELAY_MS after that preload: start the burst first.
      const lead = VOICE_PREFETCH_DELAY_MS / 2;
      await advance(lead);
      const hand = [card({ defId: "core-004" }), card({ defId: "core-012" })];
      rerenderGame(rerender, withEvents(baseView({ you: emptySide("p1", { hand }) }), autoEndedTurns()));
      expect(screen.queryByTestId("animation-queue"), "the burst is running").not.toBeNull();

      let animated = 0;
      while (screen.queryByTestId("animation-queue") !== null && animated < 10_000) {
        expect(fetch.urls(), `no voice request ${String(animated)} ms into the burst`).toEqual([url("core-004-play")]);
        await advance(50);
        animated += 50;
      }
      expect(lead + animated, "the prefetch came due mid-burst").toBeGreaterThan(VOICE_PREFETCH_DELAY_MS);
      expect(screen.queryByTestId("animation-queue"), "the burst ended").toBeNull();

      // Board still: the held preload (the new hand card) first, then the prefetch, a few at a time.
      const urls = fetch.urls();
      expect(urls.slice(0, 2)).toEqual([url("core-004-play"), url("core-012-play")]);
      expect(urls).toHaveLength(2 + VOICE_PREFETCH_CONCURRENCY);
    } finally {
      engine.dispose();
    }
  });
});

/* --------------------------------------------------------------------------------------------- *
 * B52: one set of page-wide listeners
 * --------------------------------------------------------------------------------------------- */

describe("B52 the unlock and the UI ticks are page-wide, installed once", () => {
  it("B52 the app root and a Game share one set of listeners: a click ticks once and unlocks once", () => {
    const engine = fakeEngine({ state: "locked" });
    setAudioEngineForTests(engine);
    const releaseRoot = retainAppAudio();
    renderGame(baseView());
    expect(appAudioHolders()).toBe(2);

    fireEvent.click(screen.getByTestId("audio-toggle"));

    expect(engine.unlock).toHaveBeenCalledTimes(1);
    expect(engine.playSfx.mock.calls.filter((c) => c[0] === "uiClick")).toHaveLength(1);
    cleanup();
    expect(appAudioHolders(), "the Game let go; the root still holds").toBe(1);
    releaseRoot();
    expect(appAudioHolders()).toBe(0);
  });

  it("B52 outside any Game, a held app root ticks on a button click, and a release takes the listeners off", () => {
    const engine = fakeEngine({ state: "running" });
    setAudioEngineForTests(engine);
    const root = mount(<button id="menu">Decks</button>);
    const release = retainAppAudio();

    fireEvent.click(byId(root, "menu"));
    expect(played({ playSfx: engine.playSfx })).toEqual(["uiClick"]);

    release();
    release();
    fireEvent.click(byId(root, "menu"));
    expect(played({ playSfx: engine.playSfx })).toEqual(["uiClick"]);
    expect(appAudioHolders()).toBe(0);
  });

  it("B52 the listeners reach whichever engine is the singleton at the time of the event", () => {
    const first = fakeEngine({ state: "running" });
    setAudioEngineForTests(first);
    const root = mount(<button id="menu">Play</button>);
    const release = retainAppAudio();

    const second = fakeEngine({ state: "running" });
    setAudioEngineForTests(second);
    fireEvent.click(byId(root, "menu"));

    expect(first.playSfx).not.toHaveBeenCalled();
    expect(second.playSfx).toHaveBeenCalledWith("uiClick", undefined, undefined);
    release();
  });
});

/* --------------------------------------------------------------------------------------------- *
 * B54: a setting you can hear
 * --------------------------------------------------------------------------------------------- */

describe("B54 changing a sound setting answers with a sound", () => {
  it("B54 unmuting with the toggle plays uiClick after the store says unmuted; muting plays nothing more", () => {
    const engine = fakeEngine({ state: "running" });
    setAudioEngineForTests(engine);
    writeAudioSettings({ muted: true });
    render(<AudioToggle />);
    const seenMuted: boolean[] = [];
    engine.playSfx.mockImplementation(() => {
      seenMuted.push(readAudioSettings().muted);
      return true;
    });

    fireEvent.click(screen.getByTestId("audio-toggle"));
    expect(engine.playSfx).toHaveBeenCalledWith("uiClick");
    expect(seenMuted).toEqual([false]);

    engine.playSfx.mockClear();
    fireEvent.click(screen.getByTestId("audio-toggle"));
    expect(readAudioSettings().muted).toBe(true);
    expect(engine.playSfx).not.toHaveBeenCalled();
  });

  it("B54 the master and effects sliders tick as they move; the voice slider speaks its sample on release, at the lowest priority", () => {
    const engine = fakeEngine({ state: "running" });
    setAudioEngineForTests(engine);
    render(<AudioControls />);

    fireEvent.change(screen.getByTestId("audio-master"), { target: { value: "40" } });
    fireEvent.change(screen.getByTestId("audio-sfx"), { target: { value: "60" } });
    expect(engine.playSfx.mock.calls.map((c) => c[0])).toEqual(["uiClick", "uiClick"]);

    fireEvent.change(screen.getByTestId("audio-voice"), { target: { value: "30" } });
    expect(engine.playVoice).not.toHaveBeenCalled();
    fireEvent.pointerUp(screen.getByTestId("audio-voice"));
    fireEvent.keyUp(screen.getByTestId("audio-voice"), { key: "ArrowLeft" });
    expect(engine.playVoice).toHaveBeenCalledTimes(2);
    expect(engine.playVoice).toHaveBeenCalledWith(VOICE_PREVIEW_DEF_ID, "play", 0, VOICE_PRIORITY.summon);
    expect(readAudioSettings().voice).toBeCloseTo(0.3, 6);
  });
});
