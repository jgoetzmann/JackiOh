// Polish 1 (docs/polish/1-animations.md, S8): the effects director, B32 to B35.
//
// The director is driven only through the seams S8 gives it: a fake clock for `now`, a frame
// source whose callbacks the test runs by hand, a visibility the test flips, a `measure` that
// returns fixed boxes from a table the test can edit, a stub `FxSurface` whose 2D context accepts
// and records every call, a recording `FxShakeSink`, and a plain jsdom `div` as the DOM root.
//
// Every assertion is on something the director shows to the outside: `active()`, `particles()`,
// `capacity()`, the DOM root's children, the `measure` calls and the sink calls. None of it reads
// the director's parts.
//
// Timing convention: `play()` happens at T0, and the harness runs a frame AT T0 and then every
// 5 ms. Every delay below is a multiple of 5, so each cue's due time lands exactly on a frame and
// the S8 rule "fires on the first frame where now >= playTime + delayMs" leaves no slack to argue
// about.

import { afterEach, describe, expect, it } from "vitest";

import {
  FX_ADAPT_RECOVER_WINDOWS,
  FX_ADAPT_SLOW_MS,
  FX_ADAPT_WINDOW,
  FX_MAX_DT_MS,
  FX_MAX_TAIL_MS,
  FX_MOBILE_WIDTH,
  FX_PARTICLE_CAP,
  FX_PARTICLE_CAP_MIN,
  FX_PARTICLE_CAP_MOBILE,
  FX_SHAKE_MAX_DEG,
  FX_SHAKE_MAX_PX,
} from "./constants.ts";
import { capacityFor, createFxDirector, type FxDirector, type FxDirectorOptions } from "./director.ts";
import { PARTICLE_PRESETS } from "./presets.ts";
import type { FxSurface } from "./surface.ts";
import type {
  FxAnchor,
  FxBox,
  FxCue,
  FxFrameSource,
  FxShakeOffset,
  FxShakeSink,
  FxVisibility,
} from "./types.ts";

/* ------------------------------------------------------------------------------------------- *
 * Seams
 * ------------------------------------------------------------------------------------------- */

const T0 = 10_000;
const STEP = 5;

function fakeClock(start = T0) {
  let t = start;
  return {
    now: (): number => t,
    set(value: number): void {
      t = value;
    },
    advance(ms: number): void {
      t += ms;
    },
  };
}

/** A frame source whose callbacks run only when the test says so. */
function fakeFrames() {
  let nextHandle = 1;
  const pending = new Map<number, (timestampMs: number) => void>();
  const source: FxFrameSource = {
    request(callback) {
      const handle = nextHandle;
      nextHandle += 1;
      pending.set(handle, callback);
      return handle;
    },
    cancel(handle) {
      pending.delete(handle);
    },
  };
  return {
    source,
    pending: (): number => pending.size,
    /** Runs every callback requested so far; the ones they request in turn wait for the next run. */
    run(timestampMs: number): void {
      const due = [...pending.values()];
      pending.clear();
      for (const callback of due) callback(timestampMs);
    },
  };
}

function fakeVisibility() {
  let hidden = false;
  const listeners = new Set<() => void>();
  const source: FxVisibility = {
    hidden: () => hidden,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return {
    source,
    set(next: boolean): void {
      hidden = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

/**
 * A 2D context that has every method and every property. Methods record their name and return
 * something harmless (a gradient that takes colour stops, an empty metric); properties can be set
 * and read back. It is enough for any drawing code without the test knowing which calls it makes.
 */
function recordingContext(canvas: HTMLCanvasElement): { ctx: CanvasRenderingContext2D; calls: string[] } {
  const calls: string[] = [];
  const state: Record<string, unknown> = {
    canvas,
    globalAlpha: 1,
    globalCompositeOperation: "source-over",
    fillStyle: "#000000",
    strokeStyle: "#000000",
    lineWidth: 1,
    lineCap: "butt",
    lineJoin: "miter",
    lineDashOffset: 0,
    miterLimit: 10,
    filter: "none",
    font: "10px sans-serif",
    textAlign: "start",
    textBaseline: "alphabetic",
    shadowBlur: 0,
    shadowColor: "rgba(0, 0, 0, 0)",
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    imageSmoothingEnabled: true,
  };
  const gradient = { addColorStop: (): void => undefined };
  const ctx = new Proxy(state, {
    get(target, key) {
      if (typeof key !== "string") return undefined;
      if (key in target) return target[key];
      return (): unknown => {
        calls.push(key);
        if (key.startsWith("create") && key.endsWith("Gradient")) return gradient;
        if (key === "createPattern") return null;
        if (key === "measureText") return { width: 0 };
        if (key === "getTransform") return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
        if (key === "getLineDash") return [];
        if (key === "isPointInPath" || key === "isPointInStroke") return false;
        if (key === "getImageData" || key === "createImageData") {
          return { data: new Uint8ClampedArray(4), width: 1, height: 1 };
        }
        return undefined;
      };
    },
    set(target, key, value) {
      if (typeof key === "string") {
        target[key] = value;
        calls.push(`set ${key}`);
      }
      return true;
    },
  });
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

function stubSurface(width = 1280, height = 720) {
  const canvas = document.createElement("canvas");
  const { ctx, calls } = recordingContext(canvas);
  let clears = 0;
  const surface: FxSurface = {
    canvas,
    ctx,
    dpr: () => 1,
    width: () => width,
    height: () => height,
    resize: () => undefined,
    clear: () => {
      clears += 1;
    },
    dispose: () => undefined,
  };
  return { surface, calls, clears: (): number => clears };
}

type SinkEntry = { kind: "apply"; offset: FxShakeOffset } | { kind: "clear" };

function recordingSink() {
  const log: SinkEntry[] = [];
  const sink: FxShakeSink = {
    apply(offset) {
      log.push({ kind: "apply", offset: { x: offset.x, y: offset.y, angle: offset.angle } });
    },
    clear() {
      log.push({ kind: "clear" });
    },
  };
  return {
    sink,
    log,
    applies: (): FxShakeOffset[] => log.flatMap((entry) => (entry.kind === "apply" ? [entry.offset] : [])),
  };
}

const CARD: FxBox = { x: 400, y: 120, width: 90, height: 126 };
const MOVED: FxBox = { x: 700, y: 300, width: 90, height: 126 };
const HERO: FxBox = { x: 600, y: 20, width: 120, height: 120 };
const HAND: FxBox = { x: 500, y: 600, width: 300, height: 110 };

/** `measure`: a table of testid boxes (anything absent measures null), and a log of every call. */
function fakeMeasure(clock: { now: () => number }) {
  const boxes = new Map<string, FxBox>([
    ["card-a", CARD],
    ["hero-opponent", HERO],
    ["hand-you", HAND],
  ]);
  const calls: { anchor: FxAnchor; at: number }[] = [];
  const measure = (anchor: FxAnchor): FxBox | null => {
    calls.push({ anchor, at: clock.now() });
    if (anchor.kind === "testid") return boxes.get(anchor.testid) ?? null;
    if (anchor.kind === "viewport") return { x: 1280 * anchor.at.x, y: 720 * anchor.at.y, width: 0, height: 0 };
    return { x: 40 + anchor.index * 20, y: 690, width: 16, height: 16 };
  };
  return { measure, boxes, calls };
}

const live: FxDirector[] = [];

afterEach(() => {
  for (const director of live.splice(0)) director.dispose();
  document.body.innerHTML = "";
});

function harness(over: Partial<FxDirectorOptions> = {}) {
  const clock = fakeClock();
  const frames = fakeFrames();
  const visibility = fakeVisibility();
  const surface = stubSurface();
  const sink = recordingSink();
  const measure = fakeMeasure(clock);
  const root = document.createElement("div");
  document.body.appendChild(root);
  const director = createFxDirector({
    surface: surface.surface,
    domRoot: root,
    now: clock.now,
    frames: frames.source,
    visibility: visibility.source,
    measure: measure.measure,
    shakeSink: sink.sink,
    seed: 42,
    capacity: FX_PARTICLE_CAP,
    ...over,
  });
  live.push(director);

  /** One frame at absolute time `at`. */
  function frame(at: number): void {
    clock.set(at);
    frames.run(at);
  }
  /** Frames every `step` ms from now until absolute time `until`, the last one exactly at `until`. */
  function pumpTo(until: number, step = STEP): void {
    while (clock.now() + step <= until) frame(clock.now() + step);
    if (clock.now() < until) frame(until);
  }
  /** `n` frames, each `ms` after the previous one. */
  function frameEvery(ms: number, n: number): void {
    for (let i = 0; i < n; i += 1) frame(clock.now() + ms);
  }

  return { clock, frames, visibility, surface, sink, measure, root, director, frame, pumpTo, frameEvery };
}

const at = (testid: string): FxAnchor => ({ kind: "testid", testid });

/**
 * One entry's worth of cues for D = 300 ms, one of every kind, each inside the S7 bounds: every
 * delay <= D, the projectile lands by D, and every duration ends by D + FX_MAX_TAIL_MS. The banner
 * ends exactly on that bound and the ember burst starts exactly at D, which are the two cases that
 * press hardest on it.
 */
const D = 300;
const HIT = 165;

function entryCues(): FxCue[] {
  return [
    { kind: "projectile", preset: "fire", from: at("hand-you"), to: at("card-a"), delayMs: 0, flightMs: HIT, density: 1 },
    { kind: "burst", preset: "spark", at: at("card-a"), delayMs: HIT, count: 24, spread: "point", power: 1 },
    { kind: "burst", preset: "ember", at: at("card-a"), delayMs: D, count: 18, spread: "area", power: 1 },
    { kind: "ring", preset: "gold", at: at("card-a"), delayMs: 0, durationMs: 500 },
    { kind: "crack", at: at("card-a"), delayMs: 0, durationMs: D + 400 },
    { kind: "shake", trauma: 0.8, delayMs: HIT },
    { kind: "splat", tone: "damage", amount: 8, at: at("card-a"), delayMs: HIT, durationMs: D - HIT + 650 },
    { kind: "rays", tone: "legendary", at: at("card-a"), delayMs: 0, durationMs: D + 600 },
    { kind: "sheen", at: at("card-a"), delayMs: 0, durationMs: D },
    { kind: "ghost", from: at("hand-you"), to: at("hero-opponent"), delayMs: 0, durationMs: D },
    { kind: "arrows", direction: "up", at: at("card-a"), delayMs: 0, durationMs: D + 300 },
    { kind: "banner", text: "Your turn", tone: "you", delayMs: 0, durationMs: D + FX_MAX_TAIL_MS },
  ];
}

function measuredTestids(calls: readonly { anchor: FxAnchor }[]): string[] {
  return calls.flatMap((call) => (call.anchor.kind === "testid" ? [call.anchor.testid] : []));
}

/* ------------------------------------------------------------------------------------------- *
 * B32: cues fire on time, at the box measured then, and nothing outlives D + T
 * ------------------------------------------------------------------------------------------- */

describe("B32 — the director fires each cue on time and leaves nothing behind", () => {
  it("R200 every cue of an entry is gone D + FX_MAX_TAIL_MS after the entry started: no activity, no particle, an empty DOM root", () => {
    const h = harness();
    h.director.play(entryCues());
    h.frame(T0);

    // Mid-entry the effects really are running, so the zeros at the end are not vacuous.
    h.pumpTo(T0 + 200);
    expect(h.director.active()).toBeGreaterThan(0);
    expect(h.director.particles()).toBeGreaterThan(0);
    expect(h.root.childElementCount).toBeGreaterThan(0);
    expect(h.sink.applies().length).toBeGreaterThan(0);

    h.pumpTo(T0 + D + FX_MAX_TAIL_MS);
    expect(h.director.active()).toBe(0);
    expect(h.director.particles()).toBe(0);
    expect(h.root.childElementCount).toBe(0);
    // The shake ended too, and the sink was told so.
    expect(h.sink.log.at(-1)).toEqual({ kind: "clear" });
  });

  it("B32 a cue that is not due yet measures nothing and shows nothing", () => {
    const h = harness();
    h.director.play([
      { kind: "splat", tone: "damage", amount: 3, at: at("card-a"), delayMs: 100, durationMs: 500 },
      { kind: "burst", preset: "spark", at: at("card-a"), delayMs: 100, count: 12, spread: "point", power: 1 },
      { kind: "shake", trauma: 0.4, delayMs: 100 },
    ]);
    // Nothing is measured at play() time: anchors are resolved when the cue fires.
    expect(h.measure.calls).toHaveLength(0);

    h.frame(T0 + 50);
    h.frame(T0 + 99);
    expect(h.measure.calls).toHaveLength(0);
    expect(h.root.childElementCount).toBe(0);
    expect(h.director.particles()).toBe(0);
    expect(h.sink.applies()).toHaveLength(0);
    // Still pending, so still reported as work.
    expect(h.director.active()).toBeGreaterThan(0);
  });

  it("B32 a cue fires on the first frame where now >= playTime + delayMs, and its anchor is measured on that frame", () => {
    const h = harness();
    h.director.play([
      { kind: "splat", tone: "damage", amount: 3, at: at("card-a"), delayMs: 100, durationMs: 500 },
      { kind: "burst", preset: "spark", at: at("card-a"), delayMs: 100, count: 12, spread: "point", power: 1 },
      { kind: "shake", trauma: 0.4, delayMs: 100 },
    ]);
    h.frame(T0 + 50);
    h.frame(T0 + 99);
    h.frame(T0 + 100);

    expect(h.root.querySelectorAll('[data-fx="splat"]')).toHaveLength(1);
    expect(h.director.particles()).toBeGreaterThan(0);
    expect(h.sink.applies().length).toBeGreaterThan(0);
    expect(measuredTestids(h.measure.calls)).toContain("card-a");
    expect(h.measure.calls.every((call) => call.at === T0 + 100)).toBe(true);
  });

  it("B32 an anchor is resolved when its cue fires, not when it was played: a box that moved in between is the one used", () => {
    const h = harness();
    h.director.play([{ kind: "splat", tone: "heal", amount: 2, at: at("card-a"), delayMs: 100, durationMs: 400 }]);
    h.frame(T0 + 50);
    h.measure.boxes.set("card-a", MOVED);
    h.frame(T0 + 100);

    const splat = h.root.querySelector<HTMLElement>('[data-fx="splat"]');
    expect(splat).not.toBeNull();
    expect(splat?.style.getPropertyValue("--fx-x").trim()).toBe(`${MOVED.x + MOVED.width / 2}px`);
    expect(splat?.style.getPropertyValue("--fx-y").trim()).toBe(`${MOVED.y + MOVED.height / 2}px`);
  });

  it("B32 a cue whose anchor measures null is skipped, and the cues around it still fire", () => {
    const h = harness();
    h.director.play([
      { kind: "splat", tone: "damage", amount: 5, at: at("card-gone"), delayMs: 0, durationMs: 600 },
      { kind: "burst", preset: "fire", at: at("card-gone"), delayMs: 0, count: 30, spread: "area", power: 1 },
      { kind: "ring", preset: "arcane", at: at("card-gone"), delayMs: 0, durationMs: 400 },
      { kind: "crack", at: at("card-gone"), delayMs: 0, durationMs: 400 },
      { kind: "rays", tone: "holy", at: at("card-gone"), delayMs: 0, durationMs: 600 },
      { kind: "sheen", at: at("card-gone"), delayMs: 0, durationMs: 300 },
      { kind: "arrows", direction: "down", at: at("card-gone"), delayMs: 0, durationMs: 400 },
      { kind: "splat", tone: "damage", amount: 5, at: at("card-a"), delayMs: 0, durationMs: 600 },
    ]);
    h.frame(T0);

    expect(h.root.childElementCount).toBe(1);
    expect(h.root.querySelector('[data-fx="splat"]')?.getAttribute("data-amount")).toBe("-5");
    expect(h.director.particles()).toBe(0);
    // The one mounted splat is the only thing left: skipped cues are not held as pending work.
    expect(h.director.active()).toBe(1);
  });

  it("B32 a projectile or a ghost with either end measuring null is skipped whole", () => {
    const h = harness();
    h.director.play([
      { kind: "projectile", preset: "fire", from: at("hand-you"), to: at("card-gone"), delayMs: 0, flightMs: 200, density: 1 },
      { kind: "projectile", preset: "arcane", from: at("card-gone"), to: at("card-a"), delayMs: 0, flightMs: 200, density: 1 },
      { kind: "ghost", from: at("card-gone"), to: at("hand-you"), delayMs: 0, durationMs: 300 },
      { kind: "ghost", from: at("hand-you"), to: at("card-gone"), delayMs: 0, durationMs: 300 },
    ]);
    h.frame(T0);
    h.pumpTo(T0 + 100);

    expect(h.root.childElementCount).toBe(0);
    expect(h.director.particles()).toBe(0);
    expect(h.director.active()).toBe(0);
  });

  it("B32 a projectile between two measured anchors flies, trails particles and ends", () => {
    const h = harness();
    h.director.play([
      { kind: "projectile", preset: "fire", from: at("hand-you"), to: at("card-a"), delayMs: 0, flightMs: 200, density: 1 },
      { kind: "ghost", from: at("hand-you"), to: at("hero-opponent"), delayMs: 0, durationMs: 300 },
    ]);
    h.frame(T0);
    h.pumpTo(T0 + 100);

    expect(h.director.active()).toBeGreaterThan(0);
    expect(h.director.particles()).toBeGreaterThan(0);
    expect(h.root.querySelectorAll('[data-fx="ghost"]')).toHaveLength(1);

    h.pumpTo(T0 + 200 + FX_MAX_TAIL_MS);
    expect(h.director.active()).toBe(0);
    expect(h.director.particles()).toBe(0);
    expect(h.root.childElementCount).toBe(0);
  });

  it("B32 with no surface, canvas cues (burst, projectile, crack, ring) are dropped while DOM cues still fire", () => {
    const h = harness({ surface: null });
    h.director.play([
      { kind: "burst", preset: "holy", at: at("card-a"), delayMs: 0, count: 40, spread: "area", power: 1 },
      { kind: "projectile", preset: "arcane", from: at("hand-you"), to: at("card-a"), delayMs: 0, flightMs: 200, density: 1 },
      { kind: "crack", at: at("card-a"), delayMs: 0, durationMs: 500 },
      { kind: "ring", preset: "void", at: at("card-a"), delayMs: 0, durationMs: 500 },
      { kind: "splat", tone: "loss", amount: 4, at: at("card-a"), delayMs: 0, durationMs: 600 },
    ]);
    h.frame(T0);
    h.pumpTo(T0 + 50);

    expect(h.director.particles()).toBe(0);
    expect(h.root.querySelectorAll('[data-fx="splat"]')).toHaveLength(1);
    expect(h.director.active()).toBe(1);
  });

  it("B32 a banner and a result need no anchor: they mount even when every testid measures null", () => {
    const h = harness();
    h.measure.boxes.clear();
    h.director.play([
      { kind: "banner", text: "Your turn", tone: "you", delayMs: 0, durationMs: 1400 },
      { kind: "result", outcome: "victory", text: "Victory", delayMs: 0, durationMs: 3200 },
    ]);
    h.frame(T0);

    expect(h.root.querySelectorAll('[data-fx="banner"]')).toHaveLength(1);
    expect(h.root.querySelectorAll('[data-fx="result"]')).toHaveLength(1);
  });

  it("B32 a DOM effect is removed on the first frame where firedAt + durationMs <= now, not before", () => {
    const h = harness();
    h.director.play([{ kind: "sheen", at: at("card-a"), delayMs: 0, durationMs: 400 }]);
    h.frame(T0);
    h.pumpTo(T0 + 395);
    expect(h.root.querySelectorAll('[data-fx="sheen"]')).toHaveLength(1);
    h.pumpTo(T0 + 400);
    expect(h.root.childElementCount).toBe(0);
    expect(h.director.active()).toBe(0);
  });
});

/* ------------------------------------------------------------------------------------------- *
 * B33: clear(), and the page going hidden
 * ------------------------------------------------------------------------------------------- */

describe("B32 — review fixes: one banner at a time, a quiet canvas, wall-clock ages", () => {
  it("B32 a banner replaces one still fading, so two never read over each other", () => {
    const h = harness();
    h.director.play([{ kind: "banner", text: "No moves left", tone: "muted", delayMs: 0, durationMs: 1_000 }]);
    h.frame(T0);
    h.director.play([{ kind: "banner", text: "Opponent's turn", tone: "opponent", delayMs: 0, durationMs: 1_000 }]);
    h.frame(T0 + 300);
    const banners = h.root.querySelectorAll('[data-fx="banner"]');
    expect(banners).toHaveLength(1);
    expect(banners[0]?.getAttribute("data-text")).toBe("Opponent's turn");
    // Other kinds are left alone.
    h.director.play([{ kind: "splat", tone: "damage", amount: 2, at: at("card-a"), delayMs: 0, durationMs: 500 }]);
    h.director.play([{ kind: "banner", text: "Your turn", tone: "you", delayMs: 0, durationMs: 1_000 }]);
    h.frame(T0 + 320);
    expect(h.root.querySelectorAll('[data-fx="banner"]')).toHaveLength(1);
    expect(h.root.querySelectorAll('[data-fx="splat"]')).toHaveLength(1);
  });

  it("dismissBanner takes the turn banner and its rays at once, and leaves everything else", () => {
    // Integration QA: "YOUR TURN" sat over the zones a play was asking about for a second or two.
    const h = harness();
    h.director.play([
      { kind: "banner", text: "Your turn", tone: "you", delayMs: 0, durationMs: 1_400 },
      { kind: "rays", tone: "victory", at: at("card-a"), delayMs: 0, durationMs: 1_400 },
      { kind: "splat", tone: "damage", amount: 2, at: at("card-a"), delayMs: 0, durationMs: 500 },
    ]);
    h.frame(T0);
    expect(h.root.querySelectorAll('[data-fx="banner"]')).toHaveLength(1);
    h.director.dismissBanner();
    expect(h.root.querySelectorAll('[data-fx="banner"]')).toHaveLength(0);
    expect(h.root.querySelectorAll('[data-fx="rays"]')).toHaveLength(0);
    expect(h.root.querySelectorAll('[data-fx="splat"]')).toHaveLength(1);
  });

  it("dismissBanner leaves a result's rays alone: no banner is up during the result", () => {
    const h = harness();
    h.director.play([{ kind: "rays", tone: "victory", at: at("card-a"), delayMs: 0, durationMs: 1_400 }]);
    h.frame(T0);
    h.director.dismissBanner();
    expect(h.root.querySelectorAll('[data-fx="rays"]')).toHaveLength(1);
  });

  it("B32 the canvas is cleared while it shows anything and once after, then left alone", () => {
    const h = harness();
    // A cue due in an hour keeps the loop running with nothing to draw.
    h.director.play([
      { kind: "burst", preset: "spark", at: at("card-a"), delayMs: 0, count: 10, spread: "point", power: 1 },
      { kind: "banner", text: "Your turn", tone: "you", delayMs: 3_600_000, durationMs: 100 },
    ]);
    h.frame(T0);
    h.pumpTo(T0 + FX_MAX_TAIL_MS + 100);
    expect(h.director.particles()).toBe(0);
    const settled = h.surface.clears();
    expect(settled).toBeGreaterThan(0);
    h.pumpTo(T0 + FX_MAX_TAIL_MS + 1_000);
    expect(h.surface.clears()).toBe(settled);
  });

  it("R200 a stalled frame ages particles, shapes and the shake by the real time that passed", () => {
    const h = harness();
    h.director.play(entryCues());
    h.frame(T0);
    h.frame(T0 + 200);
    expect(h.director.particles()).toBeGreaterThan(0);
    // One frame, 1.2 s late: dt is clamped to FX_MAX_DT_MS, but everything is 1.2 s older.
    h.frame(T0 + 200 + D + FX_MAX_TAIL_MS);
    expect(h.director.particles()).toBe(0);
    expect(h.director.active()).toBe(0);
  });
});

describe("B33 — clear() and visibility", () => {
  it("B33 clear() removes every pending cue, DOM effect, particle and projectile at once and clears the shake sink", () => {
    const h = harness();
    h.director.play(entryCues());
    h.frame(T0);
    h.pumpTo(T0 + 200);
    expect(h.director.active()).toBeGreaterThan(0);
    expect(h.director.particles()).toBeGreaterThan(0);
    expect(h.root.childElementCount).toBeGreaterThan(0);

    h.director.clear();

    expect(h.director.active()).toBe(0);
    expect(h.director.particles()).toBe(0);
    expect(h.root.childElementCount).toBe(0);
    expect(h.sink.log.at(-1)).toEqual({ kind: "clear" });
  });

  it("B33 a cue still pending when clear() runs never fires afterwards, and the shake never resumes", () => {
    const h = harness();
    h.director.play(entryCues());
    h.frame(T0);
    h.pumpTo(T0 + 200);
    h.director.clear();
    const logged = h.sink.log.length;
    const measured = h.measure.calls.length;

    // The ember burst was due at D and the splat's tail ran to 950 ms: neither may come back.
    h.pumpTo(T0 + 3_000);
    expect(h.root.childElementCount).toBe(0);
    expect(h.director.particles()).toBe(0);
    expect(h.director.active()).toBe(0);
    expect(h.sink.log.slice(logged).some((entry) => entry.kind === "apply")).toBe(false);
    expect(h.measure.calls.length).toBe(measured);
  });

  it("B33 play() while the page is hidden drops its cues and requests no frame", () => {
    const h = harness();
    h.visibility.set(true);
    h.director.play(entryCues());

    expect(h.director.active()).toBe(0);
    expect(h.frames.pending()).toBe(0);

    h.pumpTo(T0 + 500);
    h.visibility.set(false);
    h.pumpTo(T0 + 3_000);
    expect(h.root.childElementCount).toBe(0);
    expect(h.director.particles()).toBe(0);
    expect(h.measure.calls).toHaveLength(0);
    expect(h.sink.applies()).toHaveLength(0);
  });

  it("B33 the page turning visible again clears everything that was running when it hid", () => {
    const h = harness();
    h.director.play(entryCues());
    h.frame(T0);
    h.pumpTo(T0 + 200);
    expect(h.root.childElementCount).toBeGreaterThan(0);
    expect(h.director.particles()).toBeGreaterThan(0);

    h.visibility.set(true);
    h.clock.advance(5_000);
    h.visibility.set(false);

    expect(h.director.active()).toBe(0);
    expect(h.director.particles()).toBe(0);
    expect(h.root.childElementCount).toBe(0);
    expect(h.sink.log.at(-1)).toEqual({ kind: "clear" });
  });

  it("B33 after clear() the director plays new cues normally", () => {
    const h = harness();
    h.director.play(entryCues());
    h.frame(T0);
    h.pumpTo(T0 + 100);
    h.director.clear();

    h.director.play([{ kind: "splat", tone: "heal", amount: 6, at: at("card-a"), delayMs: 0, durationMs: 500 }]);
    h.frame(h.clock.now() + STEP);
    expect(h.root.querySelectorAll('[data-fx="splat"]')).toHaveLength(1);
    expect(h.root.querySelector('[data-fx="splat"]')?.getAttribute("data-amount")).toBe("+6");
  });
});

/* ------------------------------------------------------------------------------------------- *
 * B34: capacity, and adaptive quality on slow frames
 * ------------------------------------------------------------------------------------------- */

/** A cue due in an hour: keeps the frame loop busy without drawing anything in the meantime. */
function keepBusy(director: FxDirector): void {
  director.play([{ kind: "banner", text: "Your turn", tone: "you", delayMs: 3_600_000, durationMs: 100 }]);
}

const halved = (capacity: number): number => Math.max(FX_PARTICLE_CAP_MIN, Math.floor(capacity / 2));

describe("B34 — particle capacity", () => {
  it("B34 capacityFor gives a phone the mobile cap and a desktop the full cap", () => {
    expect(capacityFor(390)).toBe(FX_PARTICLE_CAP_MOBILE);
    expect(capacityFor(1280)).toBe(FX_PARTICLE_CAP);
  });

  it("B34 capacityFor switches exactly at FX_MOBILE_WIDTH: one pixel narrower is a phone", () => {
    expect(capacityFor(FX_MOBILE_WIDTH - 1)).toBe(FX_PARTICLE_CAP_MOBILE);
    expect(capacityFor(FX_MOBILE_WIDTH)).toBe(FX_PARTICLE_CAP);
  });

  it("B34 a director starts at the capacity it was given", () => {
    expect(harness().director.capacity()).toBe(FX_PARTICLE_CAP);
    expect(harness({ capacity: capacityFor(390) }).director.capacity()).toBe(FX_PARTICLE_CAP_MOBILE);
  });

  /**
   * A 60 Hz display, learned: a first frame (timed from the wake, so it counts for nothing) and then
   * one whole window of 16 ms frames. The next window starts empty.
   */
  function settleOn60Hz(h: ReturnType<typeof harness>): void {
    h.frameEvery(16, FX_ADAPT_WINDOW + 1);
    expect(h.director.capacity()).toBe(FX_PARTICLE_CAP);
  }

  /** How many frames of `ms` it takes a window to run past FX_ADAPT_WINDOW frames at `slowMs`. */
  const framesToTrip = (ms: number, slowMs: number): number => Math.floor((FX_ADAPT_WINDOW * slowMs) / ms) + 1;

  it("B34 on a 60 Hz display, 40 ms frames halve the capacity once a window's worth of time runs slow, down to FX_PARTICLE_CAP_MIN", () => {
    const h = harness();
    keepBusy(h.director);
    settleOn60Hz(h);

    const trip = framesToTrip(40, FX_ADAPT_SLOW_MS);
    h.frameEvery(40, trip - 1);
    expect(h.director.capacity()).toBe(FX_PARTICLE_CAP);
    h.frameEvery(40, 1);
    const once = halved(FX_PARTICLE_CAP);
    expect(h.director.capacity()).toBe(once);

    // The window restarts after a halving, so the next one needs as long again.
    h.frameEvery(40, trip);
    expect(h.director.capacity()).toBe(halved(once));

    h.frameEvery(40, FX_ADAPT_WINDOW * 6);
    expect(h.director.capacity()).toBe(FX_PARTICLE_CAP_MIN);
  });

  it("B34 fast frames never lower the capacity", () => {
    const h = harness();
    keepBusy(h.director);
    h.frameEvery(16, FX_ADAPT_WINDOW * 5);
    expect(h.director.capacity()).toBe(FX_PARTICLE_CAP);
  });

  it("B34 a steady 30 Hz display is not load: 33.4 ms frames never lower the capacity, 15 fps on it does", () => {
    // Review: iOS Low Power Mode and Chrome's energy saver cap rAF at 30 Hz, and the old rule
    // (mean over 24 ms) pinned such a phone at the floor for the whole game.
    const steady = harness({ capacity: capacityFor(390) });
    keepBusy(steady.director);
    steady.frameEvery(33.4, FX_ADAPT_WINDOW * 10);
    expect(steady.director.capacity()).toBe(FX_PARTICLE_CAP_MOBILE);

    const struggling = harness({ capacity: capacityFor(390) });
    keepBusy(struggling.director);
    struggling.frameEvery(33.4, FX_ADAPT_WINDOW + 1);
    struggling.frameEvery(66.8, FX_ADAPT_WINDOW);
    expect(struggling.director.capacity()).toBe(halved(FX_PARTICLE_CAP_MOBILE));
  });

  it("B34 a window at exactly FX_ADAPT_SLOW_MS a frame does not count as slow; one millisecond more does", () => {
    const steady = harness();
    keepBusy(steady.director);
    settleOn60Hz(steady);
    steady.frameEvery(FX_ADAPT_SLOW_MS, FX_ADAPT_WINDOW * 3);
    expect(steady.director.capacity()).toBe(FX_PARTICLE_CAP);

    const slow = harness();
    keepBusy(slow.director);
    settleOn60Hz(slow);
    slow.frameEvery(FX_ADAPT_SLOW_MS + 1, FX_ADAPT_WINDOW);
    expect(slow.director.capacity()).toBe(halved(FX_PARTICLE_CAP));
  });

  it("B34 the slow-frame test reads the raw frame time, not the clamped dt, and a stall trips it at once", () => {
    const h = harness();
    keepBusy(h.director);
    settleOn60Hz(h);
    // Three 300 ms frames already run past a whole window at 24 ms; the old rule waited 30 frames (9 s).
    h.frameEvery(FX_MAX_DT_MS * 6, 3);
    expect(h.director.capacity()).toBe(halved(FX_PARTICLE_CAP));
  });

  it("B34 the first frame after a wake is timed from the wake and counts for nothing", () => {
    const h = harness();
    keepBusy(h.director);
    h.frame(T0 + 5_000);
    h.frameEvery(16, 3);
    expect(h.director.capacity()).toBe(FX_PARTICLE_CAP);
  });

  it("B34 a lowered capacity doubles back after healthy windows, and never past the one it started at", () => {
    const h = harness();
    keepBusy(h.director);
    settleOn60Hz(h);
    h.frameEvery(40, framesToTrip(40, FX_ADAPT_SLOW_MS));
    expect(h.director.capacity()).toBe(halved(FX_PARTICLE_CAP));

    h.frameEvery(16, FX_ADAPT_WINDOW * FX_ADAPT_RECOVER_WINDOWS - 1);
    expect(h.director.capacity()).toBe(halved(FX_PARTICLE_CAP));
    h.frameEvery(16, 1);
    expect(h.director.capacity()).toBe(FX_PARTICLE_CAP);

    h.frameEvery(16, FX_ADAPT_WINDOW * FX_ADAPT_RECOVER_WINDOWS * 4);
    expect(h.director.capacity()).toBe(FX_PARTICLE_CAP);
  });

  it("B34 once the capacity is lowered, a huge burst never holds more live particles than it", () => {
    const h = harness();
    keepBusy(h.director);
    settleOn60Hz(h);
    h.frameEvery(40, FX_ADAPT_WINDOW * 8);
    expect(h.director.capacity()).toBe(FX_PARTICLE_CAP_MIN);

    h.director.play([
      { kind: "burst", preset: "confetti", at: at("card-a"), delayMs: 0, count: FX_PARTICLE_CAP * 3, spread: "area", power: 1 },
    ]);
    h.frame(h.clock.now() + 16);
    expect(h.director.particles()).toBeGreaterThan(0);
    expect(h.director.particles()).toBeLessThanOrEqual(h.director.capacity());
  });
});

/* ------------------------------------------------------------------------------------------- *
 * B35: the shake reaches the board only through the sink
 * ------------------------------------------------------------------------------------------- */

describe("B35 — the shake goes through the sink", () => {
  it("B35 a shake cue drives the sink with offsets bounded by trauma², then clears it once when the trauma is spent", () => {
    const h = harness();
    const trauma = 0.5;
    h.director.play([{ kind: "shake", trauma, delayMs: 0 }]);
    h.frame(T0);
    h.pumpTo(T0 + 1_000);

    const applies = h.sink.applies();
    expect(applies.length).toBeGreaterThan(1);
    const maxPx = FX_SHAKE_MAX_PX * trauma * trauma + 1e-9;
    const maxDeg = FX_SHAKE_MAX_DEG * trauma * trauma + 1e-9;
    for (const offset of applies) {
      expect(Math.abs(offset.x)).toBeLessThanOrEqual(maxPx);
      expect(Math.abs(offset.y)).toBeLessThanOrEqual(maxPx);
      expect(Math.abs(offset.angle)).toBeLessThanOrEqual(maxDeg);
    }
    expect(applies.some((offset) => offset.x !== 0 || offset.y !== 0 || offset.angle !== 0)).toBe(true);

    // The last apply is followed by a clear, and nothing is applied after it.
    let lastApply = -1;
    h.sink.log.forEach((entry, index) => {
      if (entry.kind === "apply") lastApply = index;
    });
    expect(h.sink.log.slice(lastApply + 1)).toContainEqual({ kind: "clear" });
    expect(h.director.active()).toBe(0);
  });

  it("B35 a running shake counts as one unit of activity until it decays", () => {
    const h = harness();
    h.director.play([{ kind: "shake", trauma: 0.5, delayMs: 0 }]);
    h.frame(T0);
    h.pumpTo(T0 + 50);
    expect(h.director.active()).toBe(1);
    h.pumpTo(T0 + 1_000);
    expect(h.director.active()).toBe(0);
  });

  it("B35 the director never writes the board element itself; only the sink hears about the shake", () => {
    const board = document.createElement("div");
    board.setAttribute("data-testid", "board");
    document.body.appendChild(board);

    const h = harness();
    h.director.play([{ kind: "shake", trauma: 1, delayMs: 0 }]);
    h.frame(T0);
    h.pumpTo(T0 + 200);

    expect(h.sink.applies().length).toBeGreaterThan(0);
    expect(board.getAttribute("style")).toBeNull();
  });

  it("B35 cues without a shake never apply an offset", () => {
    const h = harness();
    h.director.play(entryCues().filter((cue) => cue.kind !== "shake"));
    h.frame(T0);
    h.pumpTo(T0 + D + FX_MAX_TAIL_MS);
    expect(h.sink.applies()).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------------------------------- *
 * B41: a burst of a preset with a flash blooms where it fires
 * ------------------------------------------------------------------------------------------- */

describe("B41 — bursts of a flash preset bloom at their origin", () => {
  it("B41 a spark burst leaves a bloom running after its particles are counted, and it is gone within the preset's flash time", () => {
    const flashMs = PARTICLE_PRESETS.spark.flash?.ms ?? 0;
    expect(flashMs).toBeGreaterThan(0);
    const h = harness();
    h.director.play([{ kind: "burst", preset: "spark", at: at("card-a"), delayMs: 0, count: 24, spread: "point", power: 1 }]);
    h.frame(T0);
    // The bloom is canvas activity of its own: active() counts it while particles run separately.
    expect(h.director.active()).toBe(1);
    expect(h.director.particles()).toBe(24);
    h.pumpTo(T0 + flashMs);
    expect(h.director.active()).toBe(0);
  });

  it("B41 a burst of a preset without a flash starts no bloom", () => {
    expect(PARTICLE_PRESETS.dust.flash).toBeUndefined();
    const h = harness();
    h.director.play([{ kind: "burst", preset: "dust", at: at("card-a"), delayMs: 0, count: 12, spread: "area", power: 1 }]);
    h.frame(T0);
    expect(h.director.particles()).toBe(12);
    expect(h.director.active()).toBe(0);
  });

  it("B41 the bloom is painted with lighter blending and a radial gradient", () => {
    const h = harness();
    h.director.play([{ kind: "burst", preset: "gold", at: at("card-a"), delayMs: 0, count: 30, spread: "area", power: 1 }]);
    h.frame(T0);
    h.frame(T0 + STEP);
    expect(h.surface.calls).toContain("createRadialGradient");
    expect(h.surface.calls).toContain("set globalCompositeOperation");
  });
});
