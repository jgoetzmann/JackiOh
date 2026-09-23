/**
 * The effects frame loop (docs/polish/1-animations.md, S5; B29). It runs on the injected frame source
 * (requestAnimationFrame in the browser) only while there is work: `onFrame` returning false stops it
 * until the next `wake()`. It never runs while the page is hidden (MDN, Page Visibility API): turning
 * hidden cancels the pending frame, and turning visible calls `onResume` but requests nothing until
 * someone wakes it again. `dt` is clamped to FX_MAX_DT_MS so one long stall cannot fling particles.
 */
import { FX_MAX_DT_MS } from "./constants.ts";
import type { FxFrameSource, FxVisibility } from "./types.ts";

/**
 * dt = clamp(raw, 0, FX_MAX_DT_MS). `first` marks the first frame after a `wake()`, whose `raw` runs
 * from the wake rather than from a previous frame, so it says nothing about the display's rate.
 */
export type FxFrame = { dt: number; raw: number; now: number; first: boolean };
export type FrameLoop = { wake(): void; running(): boolean; dispose(): void };

export function createFrameLoop(options: {
  frames: FxFrameSource;
  visibility: FxVisibility;
  now: () => number;
  /** Return true while there is still work; false stops requesting frames until the next wake(). */
  onFrame: (frame: FxFrame) => boolean;
  /** Called when the page turns visible after being hidden. */
  onResume?: () => void;
}): FrameLoop {
  const { frames, visibility, now, onFrame, onResume } = options;
  /**
   * Each request carries a token and only the pending one may run, so a callback the frame source
   * delivers after a cancel (or a second one) does nothing. 0 means no frame is pending.
   */
  let pending = 0;
  let issued = 0;
  let handle: number | null = null;
  let last = 0;
  let fromWake = false;
  let disposed = false;
  let wasHidden = visibility.hidden();

  const cancel = () => {
    const h = handle;
    pending = 0;
    handle = null;
    if (h !== null) frames.cancel(h);
  };

  const request = () => {
    const token = ++issued;
    pending = token;
    const h = frames.request(() => tick(token));
    // A frame source that ran the callback synchronously has already cleared or replaced `pending`.
    if (pending === token) handle = h;
  };

  function tick(token: number): void {
    if (token !== pending) return;
    pending = 0;
    handle = null;
    if (disposed || visibility.hidden()) return;
    const t = now();
    // `raw` is the measurement as it came (a clock can step backwards); only `dt` is clamped.
    const raw = t - last;
    last = t;
    const dt = Math.min(FX_MAX_DT_MS, Math.max(0, raw));
    const first = fromWake;
    fromWake = false;
    const more = onFrame({ dt, raw, now: t, first });
    // `onFrame` may have woken the loop itself (a cue played mid-frame); never double-request.
    if (more && !disposed && pending === 0 && !visibility.hidden()) request();
  }

  const unsubscribe = visibility.subscribe(() => {
    if (disposed) return;
    if (visibility.hidden()) {
      wasHidden = true;
      cancel();
      return;
    }
    if (wasHidden) {
      wasHidden = false;
      onResume?.();
    }
  });

  return {
    wake() {
      if (disposed || pending !== 0 || visibility.hidden()) return;
      last = now();
      fromWake = true;
      request();
    },
    running: () => pending !== 0,
    dispose() {
      if (disposed) return;
      disposed = true;
      cancel();
      unsubscribe();
    },
  };
}
