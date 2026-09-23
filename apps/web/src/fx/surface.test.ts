// docs/polish/1-animations.md, behaviour B28: the DPR-aware canvas surface (S5).
//
// jsdom has no 2D context (and logs "Not implemented" if asked), so `createSurface` must refuse to
// run there without calling `getContext`. Everything else is proved with a stub canvas and a stub
// window whose user agent is a browser's.

import { afterEach, describe, expect, it, vi } from "vitest";

import { FX_MAX_DPR } from "./constants.ts";
import { createSurface, effectiveDpr, isHeadlessDom } from "./surface.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

type Matrix = [number, number, number, number, number, number];

/** A 2D context that tracks its transform and records every clearRect in device pixels. */
function transformContext() {
  let matrix: Matrix = [1, 0, 0, 1, 0, 0];
  const stack: Matrix[] = [];
  const clears: { x: number; y: number; w: number; h: number }[] = [];
  const state: Record<string | symbol, unknown> = {
    globalAlpha: 1,
    globalCompositeOperation: "source-over",
    fillStyle: "#000",
    imageSmoothingEnabled: true,
  };
  const methods: Record<string, (...args: never[]) => unknown> = {
    setTransform: (...args: unknown[]) => {
      const first = args[0];
      if (typeof first === "object" && first !== null) {
        const m = first as { a?: number; b?: number; c?: number; d?: number; e?: number; f?: number };
        matrix = [m.a ?? 1, m.b ?? 0, m.c ?? 0, m.d ?? 1, m.e ?? 0, m.f ?? 0];
      } else if (args.length === 0) {
        matrix = [1, 0, 0, 1, 0, 0];
      } else {
        matrix = args.slice(0, 6).map(Number) as Matrix;
      }
    },
    resetTransform: () => {
      matrix = [1, 0, 0, 1, 0, 0];
    },
    scale: (x: number, y: number) => {
      matrix = [matrix[0] * x, matrix[1] * x, matrix[2] * y, matrix[3] * y, matrix[4], matrix[5]];
    },
    translate: (x: number, y: number) => {
      matrix = [matrix[0], matrix[1], matrix[2], matrix[3], matrix[4] + matrix[0] * x + matrix[2] * y, matrix[5] + matrix[1] * x + matrix[3] * y];
    },
    save: () => {
      stack.push([...matrix] as Matrix);
    },
    restore: () => {
      matrix = stack.pop() ?? matrix;
    },
    clearRect: (x: number, y: number, w: number, h: number) => {
      clears.push({ x: matrix[0] * x + matrix[4], y: matrix[3] * y + matrix[5], w: matrix[0] * w, h: matrix[3] * h });
    },
    getTransform: () => ({ a: matrix[0], b: matrix[1], c: matrix[2], d: matrix[3], e: matrix[4], f: matrix[5] }),
  };
  const ctx = new Proxy(state, {
    get(target, prop) {
      if (typeof prop === "string" && prop in methods) return methods[prop];
      if (prop in target) return target[prop];
      if (typeof prop === "symbol") return undefined;
      return () => undefined;
    },
    set(target, prop, value) {
      target[prop] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  return { ctx, clears, matrix: () => matrix };
}

type Rect = { width: number; height: number };

/** A canvas stub: a mutable CSS rect, counted writes to the backing store, and a `getContext` spy. */
function stubCanvas(rect: Rect, context: CanvasRenderingContext2D | null | "throws" = transformContext().ctx) {
  let width = 300;
  let height = 150;
  const writes = { width: 0, height: 0 };
  const getContext = vi.fn((kind: string) => {
    if (context === "throws") throw new Error("no context for you");
    return kind === "2d" ? context : null;
  });
  const canvas = {
    style: {} as Record<string, string>,
    get width() {
      return width;
    },
    set width(value: number) {
      width = value;
      writes.width += 1;
    },
    get height() {
      return height;
    },
    set height(value: number) {
      height = value;
      writes.height += 1;
    },
    get clientWidth() {
      return rect.width;
    },
    get clientHeight() {
      return rect.height;
    },
    getBoundingClientRect: () => ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: rect.width,
      bottom: rect.height,
      width: rect.width,
      height: rect.height,
      toJSON: () => ({}),
    }),
    getContext,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  return { canvas: canvas as unknown as HTMLCanvasElement, getContext, writes, rect };
}

/** A browser-like window: not jsdom, with a DPR, an inner size and tracked resize listeners. */
function stubWindow(dpr: number | undefined, inner: Rect = { width: 1280, height: 720 }) {
  const listeners = new Map<string, Set<unknown>>();
  const win = {
    navigator: { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36" },
    devicePixelRatio: dpr,
    innerWidth: inner.width,
    innerHeight: inner.height,
    document: { hidden: false },
    addEventListener: (type: string, listener: unknown) => {
      const set = listeners.get(type) ?? new Set();
      set.add(listener);
      listeners.set(type, set);
    },
    removeEventListener: (type: string, listener: unknown) => {
      listeners.get(type)?.delete(listener);
    },
    matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {} }),
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: () => {},
  };
  const fire = (type: string) => {
    for (const listener of [...(listeners.get(type) ?? [])]) {
      if (typeof listener === "function") listener({ type });
      else (listener as { handleEvent?: (e: unknown) => void }).handleEvent?.({ type });
    }
  };
  return { win: win as unknown as Window, raw: win, listeners, fire };
}

describe("B28 the headless check and the DPR clamp", () => {
  it("B28 isHeadlessDom is true under jsdom and false for a browser user agent", () => {
    expect(isHeadlessDom()).toBe(true);
    expect(isHeadlessDom(window)).toBe(true);
    expect(isHeadlessDom(stubWindow(2).win)).toBe(false);
  });

  it("B28 effectiveDpr keeps values inside [1, 2]", () => {
    expect(FX_MAX_DPR).toBe(2);
    expect(effectiveDpr(1)).toBe(1);
    expect(effectiveDpr(1.5)).toBe(1.5);
    expect(effectiveDpr(2)).toBe(2);
  });

  it("B28 effectiveDpr clamps high and low ratios", () => {
    expect(effectiveDpr(3)).toBe(2);
    expect(effectiveDpr(4)).toBe(2);
    expect(effectiveDpr(Number.POSITIVE_INFINITY)).toBe(2);
    expect(effectiveDpr(0.5)).toBe(1);
    expect(effectiveDpr(0)).toBe(1);
    expect(effectiveDpr(-2)).toBe(1);
  });

  it("B28 effectiveDpr maps NaN and undefined to 1", () => {
    expect(effectiveDpr(undefined)).toBe(1);
    expect(effectiveDpr(Number.NaN)).toBe(1);
  });
});

describe("B28 createSurface", () => {
  it("B28 returns null under jsdom without ever calling getContext", () => {
    const getContext = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => null);
    const canvas = document.createElement("canvas");
    expect(createSurface(canvas)).toBeNull();
    expect(createSurface(canvas, window)).toBeNull();
    expect(getContext).not.toHaveBeenCalled();
  });

  it("B28 sizes the backing store to the CSS size times the effective DPR", () => {
    const { canvas } = stubCanvas({ width: 300, height: 150 });
    const surface = createSurface(canvas, stubWindow(2).win);
    expect(surface).not.toBeNull();
    expect(canvas.width).toBe(600);
    expect(canvas.height).toBe(300);
    expect(surface?.dpr()).toBe(2);
    expect(surface?.width()).toBe(300);
    expect(surface?.height()).toBe(150);
    expect(surface?.canvas).toBe(canvas);

    const one = stubCanvas({ width: 390, height: 844 });
    const flat = createSurface(one.canvas, stubWindow(1).win);
    expect(one.canvas.width).toBe(390);
    expect(one.canvas.height).toBe(844);
    expect(flat?.dpr()).toBe(1);
  });

  it("B28 a DPR above 2 is clamped to 2", () => {
    const { canvas } = stubCanvas({ width: 300, height: 150 });
    const surface = createSurface(canvas, stubWindow(3).win);
    expect(surface?.dpr()).toBe(2);
    expect(canvas.width).toBe(600);
    expect(canvas.height).toBe(300);
  });

  it("B28 a missing or fractional-below-1 DPR counts as 1", () => {
    const missing = stubCanvas({ width: 200, height: 100 });
    expect(createSurface(missing.canvas, stubWindow(undefined).win)?.dpr()).toBe(1);
    expect(missing.canvas.width).toBe(200);
    const low = stubCanvas({ width: 200, height: 100 });
    expect(createSurface(low.canvas, stubWindow(0.75).win)?.dpr()).toBe(1);
    expect(low.canvas.height).toBe(100);
  });

  it("B28 resize reallocates the backing store only when the CSS size or the DPR changed", () => {
    const stub = stubCanvas({ width: 300, height: 150 });
    const window2 = stubWindow(2);
    const surface = createSurface(stub.canvas, window2.win);
    if (surface === null) throw new Error("a browser-like host should get a surface");
    const afterCreate = { ...stub.writes };

    surface.resize();
    surface.resize();
    expect(stub.writes).toEqual(afterCreate);
    expect(stub.canvas.width).toBe(600);

    stub.rect.width = 400;
    stub.rect.height = 200;
    surface.resize();
    expect(stub.canvas.width).toBe(800);
    expect(stub.canvas.height).toBe(400);
    expect(surface.width()).toBe(400);
    const afterSize = { ...stub.writes };
    expect(afterSize.width).toBeGreaterThan(afterCreate.width);

    window2.raw.devicePixelRatio = 1;
    surface.resize();
    expect(surface.dpr()).toBe(1);
    expect(stub.canvas.width).toBe(400);
    expect(stub.canvas.height).toBe(200);

    const settled = { ...stub.writes };
    surface.resize();
    expect(stub.writes).toEqual(settled);
  });

  it("B28 a canvas that is not laid out falls back to the window's inner size", () => {
    const { canvas } = stubCanvas({ width: 0, height: 0 });
    const surface = createSurface(canvas, stubWindow(1, { width: 1024, height: 768 }).win);
    expect(surface?.width()).toBe(1024);
    expect(surface?.height()).toBe(768);
    expect(canvas.width).toBe(1024);
    expect(canvas.height).toBe(768);
  });

  it("B28 a null 2D context gives no surface", () => {
    const { canvas, getContext } = stubCanvas({ width: 300, height: 150 }, null);
    expect(createSurface(canvas, stubWindow(2).win)).toBeNull();
    expect(getContext).toHaveBeenCalled();
  });

  it("B28 a throwing getContext gives no surface and does not throw", () => {
    const { canvas } = stubCanvas({ width: 300, height: 150 }, "throws");
    expect(() => createSurface(canvas, stubWindow(2).win)).not.toThrow();
    expect(createSurface(canvas, stubWindow(2).win)).toBeNull();
  });

  it("B28 clear wipes the whole backing store and leaves the transform at scale(dpr)", () => {
    const context = transformContext();
    const { canvas } = stubCanvas({ width: 300, height: 150 }, context.ctx);
    const surface = createSurface(canvas, stubWindow(2).win);
    if (surface === null) throw new Error("a browser-like host should get a surface");
    expect(surface.ctx).toBe(context.ctx);

    context.clears.length = 0;
    surface.clear();

    expect(context.matrix()).toEqual([2, 0, 0, 2, 0, 0]);
    const covered = context.clears.some(
      (c) => c.x <= 0 && c.y <= 0 && c.x + c.w >= canvas.width && c.y + c.h >= canvas.height,
    );
    expect(covered, JSON.stringify(context.clears)).toBe(true);
  });

  it("B28 window resizes are followed until dispose, and not after", () => {
    const stub = stubCanvas({ width: 300, height: 150 });
    const host = stubWindow(1);
    const surface = createSurface(stub.canvas, host.win);
    if (surface === null) throw new Error("a browser-like host should get a surface");

    stub.rect.width = 500;
    stub.rect.height = 250;
    host.fire("resize");
    expect(stub.canvas.width).toBe(500);

    surface.dispose();
    expect([...(host.listeners.get("resize") ?? [])]).toEqual([]);
    stub.rect.width = 700;
    host.fire("resize");
    expect(stub.canvas.width).toBe(500);
  });
});
