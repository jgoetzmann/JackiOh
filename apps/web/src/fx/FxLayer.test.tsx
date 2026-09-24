// Polish 1 (docs/polish/1-animations.md, S9): the effects layer, B36 to B38.
//
// The layer is rendered the way `Game` renders it, as a direct child of `.game`, next to a real
// animation runner whose timer is a fake `schedule` the test fires by hand. Every browser API the
// layer would reach for comes in through `seams`: a fake clock and frame source, an always-visible
// page, a `measure` that returns one fixed box for every anchor and logs what it was asked for, a
// stub surface with a recording 2D context, and a recording shake sink.
//
// What the tests read is what the layer shows: the `--anim-squeeze` property on its parent, the
// `data-fx` attribute and children of its root, the DOM effects in `fx-dom`, the anchors it asked
// `measure` to resolve (which is how a planned cue becomes visible to a test), and the runner's own
// `schedule` calls.

import type { CardDef, CardDefs, GameEvent, PlayerView } from "@jackioh/shared";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ANIMATIONS, createAnimationQueue, type AnimationQueue } from "../game/animations.ts";
import { CatalogContext, lookupFromDefs, type CardLookup } from "../game/catalog.ts";
import Game from "../game/Game.tsx";
import { baseView, emptySide, fullBoardView, withEvents } from "../test/fixtures.ts";
import { setReducedMotion } from "../test/setup.ts";
import { FX_TEXT } from "./constants.ts";
import FxLayer, { type FxSeams } from "./FxLayer.tsx";
import { resetFxSettingsForTests, setFxSettings } from "./settings.ts";
import type { FxSurface } from "./surface.ts";
import type { FxAnchor, FxBox, FxFrameSource, FxShakeSink, FxVisibility } from "./types.ts";

beforeEach(() => {
  localStorage.clear();
  resetFxSettingsForTests();
});

afterEach(() => {
  cleanup();
  setReducedMotion(false);
  resetFxSettingsForTests();
  localStorage.clear();
});

/* ------------------------------------------------------------------------------------------- *
 * Seams
 * ------------------------------------------------------------------------------------------- */

/** A `schedule` spy: every call is logged, and the callbacks run only when the test says so. */
function fakeSchedule() {
  const pending: { ms: number; run: () => void }[] = [];
  const log: number[] = [];
  return {
    schedule: (fn: () => void, ms: number): void => {
      pending.push({ ms, run: fn });
      log.push(ms);
    },
    log,
    pending: (): number => pending.length,
    tick(): void {
      const next = pending.shift();
      if (next === undefined) throw new Error("nothing scheduled");
      next.run();
    },
    flush(): void {
      for (let guard = 0; pending.length > 0; guard += 1) {
        if (guard > 10_000) throw new Error("schedule loop did not terminate");
        pending.shift()?.run();
      }
    },
  };
}

/** A 2D context with every method and property; see director.test.ts for the same stub. */
function recordingContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const state: Record<string, unknown> = {
    canvas,
    globalAlpha: 1,
    globalCompositeOperation: "source-over",
    fillStyle: "#000000",
    strokeStyle: "#000000",
    lineWidth: 1,
    lineCap: "butt",
    lineJoin: "miter",
    filter: "none",
    font: "10px sans-serif",
    shadowBlur: 0,
    shadowColor: "rgba(0, 0, 0, 0)",
    imageSmoothingEnabled: true,
  };
  const gradient = { addColorStop: (): void => undefined };
  return new Proxy(state, {
    get(target, key) {
      if (typeof key !== "string") return undefined;
      if (key in target) return target[key];
      return (): unknown => {
        if (key.startsWith("create") && key.endsWith("Gradient")) return gradient;
        if (key === "createPattern") return null;
        if (key === "measureText") return { width: 0 };
        if (key === "getTransform") return { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
        if (key === "getLineDash") return [];
        if (key === "getImageData" || key === "createImageData") {
          return { data: new Uint8ClampedArray(4), width: 1, height: 1 };
        }
        return undefined;
      };
    },
    set(target, key, value) {
      if (typeof key === "string") target[key] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

function stubSurface(canvas: HTMLCanvasElement): FxSurface {
  return {
    canvas,
    ctx: recordingContext(canvas),
    dpr: () => 1,
    width: () => 1280,
    height: () => 720,
    resize: () => undefined,
    clear: () => undefined,
    dispose: () => undefined,
  };
}

const BOX: FxBox = { x: 300, y: 200, width: 90, height: 126 };

function fakeSeams() {
  let t = 50_000;
  let nextHandle = 1;
  const pending = new Map<number, (timestampMs: number) => void>();
  const frames: FxFrameSource = {
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
  const visibility: FxVisibility = { hidden: () => false, subscribe: () => () => undefined };
  const measured: FxAnchor[] = [];
  const shakes: ("apply" | "clear")[] = [];
  const shakeSink: FxShakeSink = {
    apply: () => {
      shakes.push("apply");
    },
    clear: () => {
      shakes.push("clear");
    },
  };
  const seams: FxSeams = {
    now: () => t,
    frames,
    visibility,
    measure: (anchor) => {
      measured.push(anchor);
      return BOX;
    },
    surface: (canvas) => stubSurface(canvas),
    shakeSink,
    seed: 11,
    catalog: () => undefined,
    viewportWidth: () => 1280,
    element: () => null,
  };
  function runFrames(): void {
    const due = [...pending.values()];
    pending.clear();
    for (const callback of due) callback(t);
  }
  return {
    seams,
    measured,
    shakes,
    testids: (): string[] => measured.flatMap((anchor) => (anchor.kind === "testid" ? [anchor.testid] : [])),
    /** A frame now, then one every `step` ms for `ms` of fake time. */
    pump(ms = 100, step = 10): void {
      act(() => {
        const end = t + ms;
        runFrames();
        while (t + step <= end) {
          t += step;
          runFrames();
        }
      });
    },
  };
}

type Fx = ReturnType<typeof fakeSeams>;

/** `<div className="game"><FxLayer …/></div>`, with a rerender that keeps the queue and seams. */
function mountLayer(queue: AnimationQueue, view: PlayerView, fx: Fx) {
  const tree = (shown: PlayerView) => (
    <div className="game">
      <FxLayer queue={queue} view={shown} seams={fx.seams} />
    </div>
  );
  const utils = render(tree(view));
  const game = utils.container.firstElementChild as HTMLElement;
  return {
    game,
    layer: (): HTMLElement | null => game.querySelector<HTMLElement>('[data-testid="fx-layer"]'),
    fxDom: (): HTMLElement | null => game.querySelector<HTMLElement>('[data-testid="fx-dom"]'),
    canvas: (): HTMLElement | null => game.querySelector<HTMLElement>('[data-testid="fx-canvas"]'),
    show: (next: PlayerView): void => {
      utils.rerender(tree(next));
    },
    count: (kind: string): number => game.querySelectorAll(`[data-fx="${kind}"]`).length,
    squeeze: (): string => game.style.getPropertyValue("--anim-squeeze").trim(),
  };
}

function queueWith(schedule: ReturnType<typeof fakeSchedule>, onSettled?: () => void): AnimationQueue {
  return createAnimationQueue({ schedule: schedule.schedule, reducedMotion: false, onSettled });
}

/** The same board with hot-seat's other seat looking at it: p2 is the viewer and the active player. */
function p2View(over: Partial<PlayerView> = {}): PlayerView {
  return baseView({
    viewer: "p2",
    active: "p2",
    you: emptySide("p2"),
    opponent: emptySide("p1", { hand: { count: 4 } }),
    ...over,
  });
}

/* fullBoardView's ids: your units u1..u5, the enemy's u6..u10, your hand c11..c14, your face-up
 * trap b20 in backrow lane 5. u2 carries every keyword; u10 is a 10/10. */
const HIT: GameEvent = { type: "damage", sourceId: "u1", targetId: "u10", amount: 4, combat: true };

/* ------------------------------------------------------------------------------------------- *
 * B36: the squeeze, planning per entry, and a runner that is not slowed at all
 * ------------------------------------------------------------------------------------------- */

describe("B36 — FxLayer follows the runner without pacing it", () => {
  it("R200 each start writes --anim-squeeze on the layer's parent and idle removes it", () => {
    const sched = fakeSchedule();
    const queue = queueWith(sched);
    const fx = fakeSeams();
    const view = fullBoardView();
    const m = mountLayer(queue, view, fx);
    expect(m.squeeze()).toBe("");

    act(() => queue.enqueue([HIT], view));
    const entry = queue.inFlight();
    expect(entry).not.toBeNull();
    if (entry === null) return;
    expect(m.squeeze()).toBe((entry.durationMs / ANIMATIONS[entry.type].durationMs).toFixed(3));
    expect(m.squeeze()).toBe("1.000");

    act(() => sched.flush());
    expect(queue.idle()).toBe(true);
    expect(m.squeeze()).toBe("");
  });

  it("B36 the squeeze follows the burst budget entry by entry", () => {
    const sched = fakeSchedule();
    const queue = queueWith(sched);
    const fx = fakeSeams();
    const view = fullBoardView();
    const m = mountLayer(queue, view, fx);
    const traps = Array.from(
      { length: 10 },
      (_, i): GameEvent => ({
        type: "trapFired",
        instanceId: `t${i + 1}`,
        defId: "core-084",
        controller: "p2",
        row: "backrow",
        lane: (i % 5) + 1,
      }),
    );

    act(() => queue.enqueue(traps, view));
    for (let i = 0; i < traps.length; i += 1) {
      const entry = queue.inFlight();
      expect(entry, `entry ${i + 1} is in flight`).not.toBeNull();
      if (entry === null) return;
      const expected = (entry.durationMs / ANIMATIONS[entry.type].durationMs).toFixed(3);
      expect(Number(expected)).toBeLessThan(1);
      expect(m.squeeze()).toBe(expected);
      fx.pump(50);
      act(() => sched.tick());
    }
    expect(m.squeeze()).toBe("");
  });

  it("B36 the squeeze also carries the speed setting", () => {
    setFxSettings({ speed: 2 });
    const sched = fakeSchedule();
    const queue = queueWith(sched);
    const fx = fakeSeams();
    const view = fullBoardView();
    const m = mountLayer(queue, view, fx);

    act(() => queue.enqueue([HIT], view));
    expect(m.squeeze()).toBe("0.500");
  });

  it("B36 the squeeze is written on start even while effects are off", () => {
    setFxSettings({ intensity: "off" });
    const sched = fakeSchedule();
    const queue = queueWith(sched);
    const fx = fakeSeams();
    const view = fullBoardView();
    const m = mountLayer(queue, view, fx);

    act(() => queue.enqueue([HIT], view));
    expect(m.squeeze()).toBe("1.000");
    act(() => sched.flush());
    expect(m.squeeze()).toBe("");
  });

  it("B36 drain() removes the squeeze and every effect on screen", () => {
    const sched = fakeSchedule();
    const queue = queueWith(sched);
    const fx = fakeSeams();
    const view = fullBoardView();
    const m = mountLayer(queue, view, fx);

    act(() => queue.enqueue([HIT, HIT], view));
    fx.pump(50);
    expect(m.fxDom()?.childElementCount ?? 0).toBeGreaterThan(0);

    act(() => queue.drain());
    expect(m.squeeze()).toBe("");
    expect(m.fxDom()?.childElementCount).toBe(0);
    fx.pump(2_000);
    expect(m.fxDom()?.childElementCount).toBe(0);
  });

  it("B36 reset() removes the squeeze and every effect on screen", () => {
    const sched = fakeSchedule();
    const queue = queueWith(sched);
    const fx = fakeSeams();
    const view = fullBoardView();
    const m = mountLayer(queue, view, fx);

    act(() => queue.enqueue([HIT, HIT], view));
    fx.pump(50);
    expect(m.fxDom()?.childElementCount ?? 0).toBeGreaterThan(0);

    act(() => queue.reset());
    expect(m.squeeze()).toBe("");
    expect(m.fxDom()?.childElementCount).toBe(0);
    fx.pump(2_000);
    expect(m.fxDom()?.childElementCount).toBe(0);
  });

  it("B36 an entry is planned against the view it was enqueued with, not the view the layer is given", () => {
    const sched = fakeSchedule();
    const queue = queueWith(sched);
    const fx = fakeSeams();
    // The layer shows an empty board, where u10 does not exist; the entry was planned over the
    // full board, where it does.
    const m = mountLayer(queue, baseView(), fx);

    act(() => queue.enqueue([HIT], fullBoardView()));
    fx.pump(50);

    expect(fx.testids()).toContain("card-u10");
    const splat = m.game.querySelector('[data-fx="splat"]');
    expect(splat).not.toBeNull();
    expect(splat?.getAttribute("data-amount")).toBe("-4");
  });

  it("B36 the layer remembers a caster across entries: a spell's damage flies from its caster's hero", () => {
    const sched = fakeSchedule();
    const queue = queueWith(sched);
    const fx = fakeSeams();
    const view = fullBoardView();
    mountLayer(queue, view, fx);

    act(() => queue.enqueue([{ type: "cardPlayed", player: "p2", instanceId: "s1", defId: "core-050", costPaid: 2 }], view));
    fx.pump(50);
    act(() => sched.flush());
    expect(fx.testids()).not.toContain("hero-opponent");

    act(() => queue.enqueue([{ type: "damage", sourceId: "s1", targetId: "u1", amount: 3, combat: false }], view));
    fx.pump(100);
    expect(fx.testids()).toContain("hero-opponent");
    expect(fx.testids()).toContain("card-u1");
  });

  it("B36 without the caster's cardPlayed, the same spell damage has no source to fly from", () => {
    const sched = fakeSchedule();
    const queue = queueWith(sched);
    const fx = fakeSeams();
    const view = fullBoardView();
    mountLayer(queue, view, fx);

    act(() => queue.enqueue([{ type: "damage", sourceId: "s1", targetId: "u1", amount: 3, combat: false }], view));
    fx.pump(300);
    expect(fx.testids()).toContain("card-u1");
    expect(fx.testids()).not.toContain("hero-opponent");
  });

  it("B36 drain() forgets what the layer remembered", () => {
    const sched = fakeSchedule();
    const queue = queueWith(sched);
    const fx = fakeSeams();
    const view = fullBoardView();
    mountLayer(queue, view, fx);

    act(() => queue.enqueue([{ type: "cardPlayed", player: "p2", instanceId: "s1", defId: "core-050", costPaid: 2 }], view));
    fx.pump(50);
    act(() => queue.drain());

    act(() => queue.enqueue([{ type: "damage", sourceId: "s1", targetId: "u1", amount: 3, combat: false }], view));
    fx.pump(300);
    expect(fx.testids()).toContain("card-u1");
    expect(fx.testids()).not.toContain("hero-opponent");
  });

  it("R200 mounting the layer changes no schedule call the runner makes, and settles it exactly as often", () => {
    const events: GameEvent[] = [
      { type: "cardPlayed", player: "p1", instanceId: "c12", defId: "core-019", costPaid: 3 },
      { type: "summoned", player: "p1", instanceId: "c12", defId: "core-019", row: "units", lane: 3 },
      { type: "damage", sourceId: "u2", targetId: "u10", amount: 7, combat: false },
      { type: "healed", targetId: "hero-p1", amount: 3 },
      { type: "trapFired", instanceId: "b20", defId: "core-084", controller: "p1", row: "backrow", lane: 5 },
      { type: "destroyed", instanceId: "u9", defId: "core-040", owner: "p2", attack: 1, maxHealth: 1, killerId: "u2" },
      { type: "manaChanged", player: "p1", current: 4, max: 4 },
      { type: "turnStarted", player: "p2", turn: 4 },
      { type: "gameOver", winner: "p1", reason: "hero-death" },
    ];
    const layered = fakeSchedule();
    const bare = fakeSchedule();
    const settledLayered = vi.fn();
    const settledBare = vi.fn();
    const withLayer = queueWith(layered, settledLayered);
    const without = queueWith(bare, settledBare);
    const fx = fakeSeams();
    const view = fullBoardView();
    const m = mountLayer(withLayer, view, fx);

    act(() => withLayer.enqueue(events, view));
    without.enqueue(events, view);

    let mostEffects = 0;
    while (layered.pending() > 0) {
      fx.pump(120);
      mostEffects = Math.max(mostEffects, m.fxDom()?.childElementCount ?? 0);
      act(() => layered.tick());
    }
    bare.flush();

    // The effects really ran alongside the runner.
    expect(mostEffects).toBeGreaterThan(0);
    expect(layered.log.length).toBeGreaterThan(0);
    expect(layered.log).toEqual(bare.log);
    expect(settledLayered).toHaveBeenCalledTimes(1);
    expect(settledBare).toHaveBeenCalledTimes(1);
  });
});

/* ------------------------------------------------------------------------------------------- *
 * B37: on and off, and nothing the layer renders can be clicked, read or waited on
 * ------------------------------------------------------------------------------------------- */

describe("B37 — when the layer draws, and what it never renders", () => {
  it("B37 with effects enabled it renders data-fx=\"on\", aria-hidden, and holds fx-canvas and fx-dom", () => {
    const fx = fakeSeams();
    const m = mountLayer(queueWith(fakeSchedule()), fullBoardView(), fx);
    const layer = m.layer();

    expect(layer).not.toBeNull();
    expect(layer?.classList.contains("fx-layer")).toBe(true);
    expect(layer?.getAttribute("data-fx")).toBe("on");
    expect(layer?.getAttribute("aria-hidden")).toBe("true");

    const canvas = m.canvas();
    expect(canvas?.tagName).toBe("CANVAS");
    expect(canvas?.classList.contains("fx-canvas")).toBe(true);
    expect(canvas?.parentElement).toBe(layer);

    const fxDom = m.fxDom();
    expect(fxDom?.classList.contains("fx-dom")).toBe(true);
    expect(fxDom?.parentElement).toBe(layer);
  });

  it("B37 prefers-reduced-motion switches the layer off: no canvas, no DOM root, no cue", () => {
    setReducedMotion(true);
    const sched = fakeSchedule();
    const queue = queueWith(sched);
    const fx = fakeSeams();
    const view = fullBoardView();
    const m = mountLayer(queue, view, fx);

    expect(m.layer()?.getAttribute("data-fx")).toBe("off");
    expect(m.layer()?.getAttribute("aria-hidden")).toBe("true");
    expect(m.canvas()).toBeNull();
    expect(m.fxDom()).toBeNull();

    act(() => queue.enqueue([HIT], view));
    fx.pump(500);
    expect(fx.measured).toHaveLength(0);
    expect(fx.shakes).not.toContain("apply");
    expect(m.layer()?.childElementCount).toBe(0);
  });

  it("B37 the viewer's reduce-motion setting switches the layer off", () => {
    setFxSettings({ motion: "reduce" });
    const fx = fakeSeams();
    const m = mountLayer(queueWith(fakeSchedule()), fullBoardView(), fx);

    expect(m.layer()?.getAttribute("data-fx")).toBe("off");
    expect(m.canvas()).toBeNull();
    expect(m.fxDom()).toBeNull();
  });

  it("B37 intensity \"off\" switches the layer off and plans no cue, while the runner still animates", () => {
    setFxSettings({ intensity: "off" });
    const sched = fakeSchedule();
    const queue = queueWith(sched);
    const fx = fakeSeams();
    const view = fullBoardView();
    const m = mountLayer(queue, view, fx);

    expect(m.layer()?.getAttribute("data-fx")).toBe("off");
    expect(m.canvas()).toBeNull();

    act(() => queue.enqueue([HIT], view));
    expect(sched.log).toEqual([ANIMATIONS.damage.durationMs]);
    fx.pump(500);
    expect(fx.measured).toHaveLength(0);
    expect(fx.shakes).not.toContain("apply");
    expect(m.layer()?.childElementCount).toBe(0);
  });

  it("B37 the layer follows the settings live: off, then back on", () => {
    const fx = fakeSeams();
    const m = mountLayer(queueWith(fakeSchedule()), fullBoardView(), fx);
    expect(m.layer()?.getAttribute("data-fx")).toBe("on");

    act(() => {
      setFxSettings({ intensity: "off" });
    });
    expect(m.layer()?.getAttribute("data-fx")).toBe("off");
    expect(m.canvas()).toBeNull();

    act(() => {
      setFxSettings({ intensity: "high" });
    });
    expect(m.layer()?.getAttribute("data-fx")).toBe("on");
    expect(m.canvas()).not.toBeNull();
    expect(m.fxDom()).not.toBeNull();
  });

  it("B37 nothing inside the layer carries a data-animating of its own, a role, focusable content or a text node", () => {
    const sched = fakeSchedule();
    const queue = queueWith(sched);
    const fx = fakeSeams();
    const view = fullBoardView();
    const m = mountLayer(queue, view, fx);
    const events: GameEvent[] = [
      HIT,
      { type: "healed", targetId: "hero-p1", amount: 3 },
      { type: "buffed", instanceId: "u2", attack: 1, health: 1 },
      { type: "radiantSet", instanceId: "u3", defId: "core-017", zone: { z: "field", player: "p1", row: "units", lane: 3 } },
      { type: "turnStarted", player: "p1", turn: 4 },
    ];

    act(() => queue.enqueue(events, view));
    const kinds = new Set<string>();
    const check = (): void => {
      const layer = m.layer();
      expect(layer).not.toBeNull();
      if (layer === null) return;
      for (const el of layer.querySelectorAll("[data-fx]")) kinds.add(el.getAttribute("data-fx") ?? "");
      expect(layer.hasAttribute("data-animating")).toBe(false);
      expect(layer.querySelectorAll("[data-animating]")).toHaveLength(0);
      expect(layer.hasAttribute("role")).toBe(false);
      expect(layer.querySelectorAll("[role]")).toHaveLength(0);
      expect(
        layer.querySelectorAll("a, button, input, select, textarea, [tabindex], [contenteditable]"),
      ).toHaveLength(0);
      const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
      expect(walker.nextNode()).toBeNull();
    };
    while (sched.pending() > 0) {
      fx.pump(120);
      check();
      act(() => sched.tick());
    }
    fx.pump(120);
    check();

    // The DOM effects really were there while the checks ran.
    for (const kind of ["splat", "rays", "arrows", "sheen", "banner"]) expect(kinds).toContain(kind);
  });

  it("B37 Game mounts the layer as a direct child of .game and logs no console.error through a burst and a game over", async () => {
    const errors = vi.spyOn(console, "error");
    try {
      const view = fullBoardView();
      const events: GameEvent[] = [
        { type: "damage", sourceId: "c11", targetId: "u10", amount: 8, combat: false },
        { type: "summoned", player: "p1", instanceId: "c90", defId: "core-019", row: "units", lane: 3 },
        { type: "turnStarted", player: "p1", turn: 4 },
      ];
      const onAction = (): void => undefined;
      const { container, rerender, unmount } = render(<Game view={view} legal={[]} onAction={onAction} />);

      const game = container.querySelector('[data-testid="game"]');
      const layer = container.querySelector('[data-testid="fx-layer"]');
      expect(game).not.toBeNull();
      expect(layer).not.toBeNull();
      expect(layer?.parentElement).toBe(game);
      expect(layer?.getAttribute("data-fx")).toBe("on");

      const busy = withEvents(view, events);
      rerender(<Game view={busy} legal={[]} onAction={onAction} />);
      await act(async () => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 1_300);
        });
      });
      expect(container.querySelector('[data-testid="fx-layer"] [data-animating]')).toBeNull();

      rerender(<Game view={{ ...busy, result: { winner: "p1", reason: "hero-death" } }} legal={[]} onAction={onAction} />);
      await act(async () => {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 100);
        });
      });
      unmount();

      expect(errors.mock.calls).toEqual([]);
    } finally {
      errors.mockRestore();
    }
  });
});

/* ------------------------------------------------------------------------------------------- *
 * B38: the view-driven sequences
 * ------------------------------------------------------------------------------------------- */

describe("R200 — the reduce setting stops CSS-only motion exactly as the media query does", () => {
  it("R200 the reduce setting zeroes --anim-scale on the game root, and turning it back restores it", () => {
    // index.css zeroes --anim-scale on :root under prefers-reduced-motion; the setting only turned
    // the layer off, so the result overlay's fade and the board's transitions kept moving.
    setFxSettings({ motion: "reduce" });
    const fx = fakeSeams();
    const m = mountLayer(queueWith(fakeSchedule()), fullBoardView(), fx);
    expect(m.game.style.getPropertyValue("--anim-scale")).toBe("0");
    expect(m.layer()?.getAttribute("data-fx")).toBe("off");

    act(() => {
      setFxSettings({ motion: "system" });
    });
    expect(m.game.style.getPropertyValue("--anim-scale")).toBe("");
    expect(m.layer()?.getAttribute("data-fx")).toBe("on");
  });

  it("R200 intensity off (motion left to the system) draws nothing but leaves the table's motion alone", () => {
    setFxSettings({ intensity: "off" });
    const m = mountLayer(queueWith(fakeSchedule()), fullBoardView(), fakeSeams());
    expect(m.layer()?.getAttribute("data-fx")).toBe("off");
    expect(m.game.style.getPropertyValue("--anim-scale")).toBe("");
  });
});

describe("B38 — the result sequence and the hot-seat hand-over banner", () => {
  it("B38 a result arriving during the mount plays the victory sequence for the winner", () => {
    const fx = fakeSeams();
    const view = fullBoardView();
    const m = mountLayer(queueWith(fakeSchedule()), view, fx);
    fx.pump(50);
    expect(m.count("result")).toBe(0);

    m.show({ ...view, result: { winner: "p1", reason: "hero-death" } });
    fx.pump(50);

    expect(m.count("result")).toBe(1);
    const result = m.game.querySelector('[data-fx="result"]');
    expect(result?.getAttribute("data-outcome")).toBe("victory");
    expect(result?.getAttribute("data-text")).toBe(FX_TEXT.victory);
  });

  it("B38 a result against the viewer plays the defeat sequence", () => {
    const fx = fakeSeams();
    const view = fullBoardView();
    const m = mountLayer(queueWith(fakeSchedule()), view, fx);

    m.show({ ...view, result: { winner: "p2", reason: "hero-death" } });
    fx.pump(50);

    const result = m.game.querySelector('[data-fx="result"]');
    expect(result?.getAttribute("data-outcome")).toBe("defeat");
    expect(result?.getAttribute("data-text")).toBe(FX_TEXT.defeat);
  });

  it("B38 a layer that mounts on a finished game plays nothing", () => {
    const fx = fakeSeams();
    const finished = fullBoardView({ result: { winner: "p1", reason: "concede" } });
    const m = mountLayer(queueWith(fakeSchedule()), finished, fx);
    fx.pump(500);

    expect(m.count("result")).toBe(0);
    expect(fx.measured).toHaveLength(0);
    expect(m.fxDom()?.childElementCount).toBe(0);
  });

  it("B38 a later view with the same result does not replay the sequence", () => {
    const fx = fakeSeams();
    const view = fullBoardView();
    const m = mountLayer(queueWith(fakeSchedule()), view, fx);
    m.show({ ...view, result: { winner: "p1", reason: "hero-death" } });
    fx.pump(50);
    expect(m.count("result")).toBe(1);

    m.show({ ...view, turn: view.turn + 1, result: { winner: "p1", reason: "hero-death" } });
    fx.pump(50);
    expect(m.count("result")).toBe(1);
  });

  it("B38 a viewer change after the first render plays the \"Your turn\" hand-over banner", () => {
    const fx = fakeSeams();
    const m = mountLayer(queueWith(fakeSchedule()), fullBoardView(), fx);
    fx.pump(50);
    expect(m.count("banner")).toBe(0);

    m.show(p2View());
    fx.pump(50);

    expect(m.count("banner")).toBe(1);
    const banner = m.game.querySelector('[data-fx="banner"]');
    expect(banner?.getAttribute("data-tone")).toBe("you");
    expect(banner?.getAttribute("data-text")).toBe(FX_TEXT.yourTurn);
  });

  it("B38 a new view for the same viewer plays no banner", () => {
    const fx = fakeSeams();
    const view = fullBoardView();
    const m = mountLayer(queueWith(fakeSchedule()), view, fx);

    m.show({ ...view, turn: view.turn + 1 });
    fx.pump(500);
    expect(m.count("banner")).toBe(0);
  });

  it("B38 the first render plays no hand-over banner", () => {
    const fx = fakeSeams();
    const m = mountLayer(queueWith(fakeSchedule()), p2View(), fx);
    fx.pump(500);
    expect(m.count("banner")).toBe(0);
    expect(fx.measured).toHaveLength(0);
  });

  it("B38 a hand-over to a seat that is not the active one plays no banner", () => {
    const fx = fakeSeams();
    const m = mountLayer(queueWith(fakeSchedule()), fullBoardView(), fx);

    m.show(p2View({ active: "p1" }));
    fx.pump(500);
    expect(m.count("banner")).toBe(0);
  });

  it("R200 the killing blow a finished game drains is replayed first, and the result lands on its beat", () => {
    // Game.tsx drains the runner the moment a finished view arrives, which cleared the lethal hit
    // before it drew (review: the last blow of the match never showed).
    const sched = fakeSchedule();
    const queue = queueWith(sched);
    const fx = fakeSeams();
    const view = fullBoardView();
    const m = mountLayer(queue, view, fx);
    const lethal: GameEvent[] = [
      { type: "attackDeclared", attackerId: "u1", targetId: "hero-p2", forced: false },
      { type: "damage", sourceId: "u1", targetId: "hero-p2", amount: 5, combat: true },
    ];
    act(() => queue.enqueue(lethal, view));
    act(() => queue.drain());
    m.show({ ...view, result: { winner: "p1", reason: "hero-death" } });

    fx.pump(0);
    expect(m.count("splat")).toBe(1);
    expect(m.game.querySelector('[data-fx="splat"]')?.getAttribute("data-amount")).toBe("-5");
    expect(m.count("result")).toBe(0);

    fx.pump(ANIMATIONS.damage.durationMs);
    expect(m.count("result")).toBe(1);
  });

  it("R200 a game that ends with no blow (a concession) plays its result at once", () => {
    const fx = fakeSeams();
    const queue = queueWith(fakeSchedule());
    const view = fullBoardView();
    const m = mountLayer(queue, view, fx);
    act(() => queue.drain());
    m.show({ ...view, result: { winner: "p1", reason: "concede" } });
    fx.pump(0);
    expect(m.count("result")).toBe(1);
    expect(m.count("splat")).toBe(0);
  });

  it("B38 with effects off, neither a result nor a hand-over plays anything", () => {
    setFxSettings({ intensity: "off" });
    const fx = fakeSeams();
    const view = fullBoardView();
    const m = mountLayer(queueWith(fakeSchedule()), view, fx);

    m.show({ ...view, result: { winner: "p1", reason: "hero-death" } });
    fx.pump(200);
    m.show(p2View({ result: { winner: "p1", reason: "hero-death" } }));
    fx.pump(200);

    expect(m.count("result")).toBe(0);
    expect(m.count("banner")).toBe(0);
    expect(fx.measured).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------------------------------- *
 * S9 and S11: the default catalog (CatalogContext, fed by lookupFromDefs) and the surface seam.
 * Every test above overrides `seams.catalog`; these leave it out, as production does.
 * ------------------------------------------------------------------------------------------- */

function def(id: string, over: Partial<CardDef> = {}): CardDef {
  return {
    id,
    index: id.slice(5),
    name: `Card ${id}`,
    set: "Core",
    type: "Unit",
    tags: [],
    rarity: "Common",
    token: false,
    cost: 3,
    base: { attack: 2, health: 2, keywords: [], text: "" },
    radiant: { attack: 3, health: 3, keywords: [], text: "" },
    ...over,
  };
}

const DEFS: CardDefs = {
  "core-019": def("core-019", { rarity: "Legendary" }),
  "core-020": def("core-020", { rarity: "Mythic" }),
  "core-021": def("core-021"),
  // A big base face and a small radiant one: only the base face's stats shake the board.
  "core-022": def("core-022", {
    base: { attack: 6, health: 6, keywords: [], text: "" },
    radiant: { attack: 1, health: 1, keywords: [], text: "" },
  }),
};

function summon(defId: string): GameEvent {
  return { type: "summoned", player: "p1", instanceId: "c90", defId, row: "units", lane: 3 };
}

/** The production seams minus `catalog`, so the layer falls back to CatalogContext. */
function withoutCatalog(fx: Fx): Partial<FxSeams> {
  const seams: Partial<FxSeams> = { ...fx.seams };
  delete seams.catalog;
  return seams;
}

function mountWithCatalog(queue: AnimationQueue, view: PlayerView, seams: Partial<FxSeams>, lookup: CardLookup | null) {
  const utils = render(
    <CatalogContext.Provider value={lookup}>
      <div className="game">
        <FxLayer queue={queue} view={view} seams={seams} />
      </div>
    </CatalogContext.Provider>,
  );
  return {
    rays: (tone: string): number => utils.container.querySelectorAll(`[data-fx="rays"][data-tone="${tone}"]`).length,
  };
}

describe("S9 — the default catalog and the surface seam", () => {
  it("S11 lookupFromDefs carries each def's catalog rarity on both faces", () => {
    const lookup = lookupFromDefs(DEFS);

    expect(lookup("core-019", false)?.rarity).toBe("Legendary");
    expect(lookup("core-019", true)?.rarity).toBe("Legendary");
    expect(lookup("core-020", false)?.rarity).toBe("Mythic");
    expect(lookup("core-021", false)?.rarity).toBe("Common");
    expect(lookup("core-999", false)).toBeUndefined();
  });

  it("S9 with no catalog seam, a Legendary summon reads its rarity from CatalogContext and plays legendary rays", () => {
    const sched = fakeSchedule();
    const queue = queueWith(sched);
    const fx = fakeSeams();
    const view = fullBoardView();
    const m = mountWithCatalog(queue, view, withoutCatalog(fx), lookupFromDefs(DEFS));

    act(() => queue.enqueue([summon("core-019")], view));
    fx.pump(50);

    expect(m.rays("legendary")).toBe(1);
    expect(m.rays("mythic")).toBe(0);
  });

  it("S9 a Mythic reads as mythic, and a Common plays no rays at all", () => {
    const sched = fakeSchedule();
    const queue = queueWith(sched);
    const fx = fakeSeams();
    const view = fullBoardView();
    const m = mountWithCatalog(queue, view, withoutCatalog(fx), lookupFromDefs(DEFS));

    act(() => queue.enqueue([summon("core-020")], view));
    fx.pump(50);
    expect(m.rays("mythic")).toBe(1);
    act(() => sched.flush());
    fx.pump(2_000);

    act(() => queue.enqueue([summon("core-021")], view));
    fx.pump(50);
    expect(m.rays("legendary") + m.rays("mythic")).toBe(0);
  });

  it("S9 the default catalog looks up the base face and maps its printed stats, so a big base unit shakes the board", () => {
    const sched = fakeSchedule();
    const queue = queueWith(sched);
    const fx = fakeSeams();
    const view = fullBoardView();
    const lookup = vi.fn<CardLookup>(lookupFromDefs(DEFS));
    mountWithCatalog(queue, view, withoutCatalog(fx), lookup);

    act(() => queue.enqueue([summon("core-022")], view));
    fx.pump(400);

    expect(lookup).toHaveBeenCalledWith("core-022", false);
    expect(lookup).not.toHaveBeenCalledWith("core-022", true);
    expect(fx.shakes).toContain("apply");
  });

  it("S9 a hidden defId never reaches the catalog lookup and gets no entrance", () => {
    const sched = fakeSchedule();
    const queue = queueWith(sched);
    const fx = fakeSeams();
    const view = fullBoardView();
    const lookup = vi.fn<CardLookup>(lookupFromDefs(DEFS));
    const m = mountWithCatalog(queue, view, withoutCatalog(fx), lookup);

    act(() => queue.enqueue([summon("hidden")], view));
    fx.pump(400);

    expect(lookup.mock.calls.map(([defId]) => defId)).not.toContain("hidden");
    expect(m.rays("legendary") + m.rays("mythic")).toBe(0);
    expect(fx.shakes).not.toContain("apply");
  });

  it("S9 with no catalog at all, a summon plans only the dust burst at the zone's foot (and its stand-in, B46)", () => {
    const sched = fakeSchedule();
    const queue = queueWith(sched);
    const fx = fakeSeams();
    const view = fullBoardView();
    const m = mountWithCatalog(queue, view, withoutCatalog(fx), null);

    act(() => queue.enqueue([summon("core-019")], view));
    fx.pump(400);

    expect(m.rays("legendary")).toBe(0);
    expect(fx.shakes).not.toContain("apply");
    // Every measure is the landing zone: once at its foot for the dust, and bare for the stand-in
    // that lands there and follows it frame by frame.
    const zone = { kind: "testid", testid: "zone-you-units-3" };
    expect(fx.measured.filter((anchor) => anchor.kind === "testid" && anchor.at !== undefined)).toEqual([
      { ...zone, at: { x: 0.5, y: 1 } },
    ]);
    expect(fx.measured.filter((anchor) => !(anchor.kind === "testid" && anchor.at !== undefined)).length).toBeGreaterThan(0);
    for (const anchor of fx.measured) expect(anchor).toMatchObject(zone);
  });

  it("S9 a catalog seam overrides CatalogContext", () => {
    const sched = fakeSchedule();
    const queue = queueWith(sched);
    const fx = fakeSeams();
    const view = fullBoardView();
    const m = mountWithCatalog(queue, view, { ...fx.seams, catalog: () => ({ rarity: "Mythic" }) }, lookupFromDefs(DEFS));

    act(() => queue.enqueue([summon("core-019")], view));
    fx.pump(50);

    expect(m.rays("mythic")).toBe(1);
    expect(m.rays("legendary")).toBe(0);
  });

  it("S9 the surface seam is handed the layer's own fx-canvas", () => {
    const sched = fakeSchedule();
    const queue = queueWith(sched);
    const fx = fakeSeams();
    const surface = vi.fn((canvas: HTMLCanvasElement) => stubSurface(canvas));
    const view = fullBoardView();
    const m = mountLayer(queue, view, { ...fx, seams: { ...fx.seams, surface } });

    act(() => queue.enqueue([HIT], view));
    fx.pump(100);

    expect(surface).toHaveBeenCalled();
    for (const [canvas] of surface.mock.calls) expect(canvas).toBe(m.canvas());
  });

  it("S9 with effects off the surface seam is never asked for a surface", () => {
    setFxSettings({ intensity: "off" });
    const sched = fakeSchedule();
    const queue = queueWith(sched);
    const fx = fakeSeams();
    const surface = vi.fn((canvas: HTMLCanvasElement) => stubSurface(canvas));
    const view = fullBoardView();
    mountLayer(queue, view, { ...fx, seams: { ...fx.seams, surface } });

    act(() => queue.enqueue([HIT], view));
    fx.pump(100);

    expect(surface).not.toHaveBeenCalled();
  });
});
