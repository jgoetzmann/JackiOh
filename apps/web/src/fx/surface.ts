/**
 * The effects canvas (docs/polish/1-animations.md, S5). One `<canvas>` overlays the board. Its backing
 * store is the CSS size times the device pixel ratio, clamped to FX_MAX_DPR so a 3× phone does not
 * pay for 9× the pixels, and it is only reallocated when the size or the ratio actually changes.
 *
 * jsdom has no 2D context and logs "Not implemented" when asked for one, so under jsdom the surface
 * is never created and `getContext` is never called: the layer simply draws nothing there.
 */
import { FX_MAX_DPR } from "./constants.ts";

export type FxSurface = {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  dpr(): number;
  /** CSS px */
  width(): number;
  /** CSS px */
  height(): number;
  /** Re-reads CSS size (rect, else window.inner*) and DPR; reallocates the backing store only on change. */
  resize(): void;
  /** Clears the whole store and sets the transform to scale(dpr). */
  clear(): void;
  /** Removes the resize listener / ResizeObserver. */
  dispose(): void;
};

/** True when running under jsdom (its user agent names itself). */
export function isHeadlessDom(win?: Window): boolean {
  return (win ?? window).navigator.userAgent.includes("jsdom");
}

/** Clamp to [1, FX_MAX_DPR]; NaN/undefined → 1. */
export function effectiveDpr(devicePixelRatio: number | undefined): number {
  if (typeof devicePixelRatio !== "number" || Number.isNaN(devicePixelRatio)) return 1;
  return Math.min(FX_MAX_DPR, Math.max(1, devicePixelRatio));
}

/** null under jsdom (never calls getContext there), or when getContext("2d") is null or throws. */
export function createSurface(canvas: HTMLCanvasElement, win?: Window): FxSurface | null {
  const host: Window = win ?? canvas.ownerDocument.defaultView ?? window;
  if (isHeadlessDom(host)) return null;

  let ctx: CanvasRenderingContext2D | null;
  try {
    ctx = canvas.getContext("2d");
  } catch {
    return null;
  }
  if (!ctx) return null;
  const context = ctx;

  let cssWidth = 0;
  let cssHeight = 0;
  let ratio = 1;
  let disposed = false;

  const resize = () => {
    const rect = canvas.getBoundingClientRect();
    let w = rect.width;
    let h = rect.height;
    if (!(w > 0 && h > 0)) {
      w = host.innerWidth;
      h = host.innerHeight;
    }
    cssWidth = w;
    cssHeight = h;
    ratio = effectiveDpr(host.devicePixelRatio);
    const storeWidth = Math.round(w * ratio);
    const storeHeight = Math.round(h * ratio);
    // Assigning width or height reallocates (and wipes) the store even when the value is the same,
    // so only touch them when something changed.
    if (canvas.width !== storeWidth) canvas.width = storeWidth;
    if (canvas.height !== storeHeight) canvas.height = storeHeight;
  };

  const clear = () => {
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.globalAlpha = 1;
    context.globalCompositeOperation = "source-over";
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
  };

  const onResize = () => resize();
  host.addEventListener("resize", onResize);

  let observer: ResizeObserver | null = null;
  const Observer = (host as Window & { ResizeObserver?: typeof ResizeObserver }).ResizeObserver;
  if (typeof Observer === "function") {
    observer = new Observer(onResize);
    observer.observe(canvas);
  }

  resize();

  return {
    canvas,
    ctx: context,
    dpr: () => ratio,
    width: () => cssWidth,
    height: () => cssHeight,
    resize,
    clear,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      host.removeEventListener("resize", onResize);
      observer?.disconnect();
      observer = null;
    },
  };
}
