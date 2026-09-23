// The effects director (docs/polish/1-animations.md, S8): one frame loop that turns planned cues into
// particles, canvas strokes, DOM flourishes and board shake.
//
// R200 is the reason for its shape. The runner owns every duration the client waits on; the
// director only decorates. So it never sets a timer and never tells the runner anything: cues are
// scheduled against `now()` when `play` is called, fired on the first frame at or after their due
// time, and everything they start is bounded by the planner's durations (which already fit inside
// the entry plus FX_MAX_TAIL_MS) and by FX_MAX_PARTICLE_LIFE_MS. Anchors are measured when a cue
// fires, not when it is planned, because the board has usually moved in between.
//
// A DOM effect expires at `due + durationMs`, where `due` is the time the cue was scheduled to fire
// (playTime + delayMs). A frame lands a few milliseconds after that at worst, and counting from the
// frame instead would let a splat outlive R200's bound by that much.
//
// Frame work, in the order S8 fixes:
//   1. fire due cues (measuring anchors now; a null box skips the cue),
//   2. move particles, canvas effects and the shake by dt, and age them by the real time that
//      passed, so a stalled frame never keeps an effect alive past its wall-clock end (R200),
//   3. push the shake to the sink, or clear the sink on the frame it goes idle,
//   4. clear the surface and draw (skipped once the canvas is empty and already clear),
//   5. remove expired DOM effects, expire stage effects, and move a stand-in only when the board
//      under it moved (a shake, a scroll, a resize),
//   6. adapt the particle cap to slow frames,
//   7. keep the loop running while anything is pending, alive or shaking. A parked stage effect
//      (a stand-in waiting in its zone, a hidden card) needs no frame, so it does not keep it going.

import { createCanvasFx } from "./canvasFx.ts";
import {
  FX_ADAPT_DISPLAY_MAX_MS,
  FX_ADAPT_MIN_INTERVAL_MS,
  FX_ADAPT_RECOVER_WINDOWS,
  FX_ADAPT_SLOW_FACTOR,
  FX_ADAPT_SLOW_MS,
  FX_ADAPT_WINDOW,
  FX_LUNGE_MAX_PX,
  FX_LUNGE_MIN_PX,
  FX_LUNGE_STANDOFF,
  FX_MOBILE_WIDTH,
  FX_PARTICLE_CAP,
  FX_PARTICLE_CAP_MIN,
  FX_PARTICLE_CAP_MOBILE,
} from "./constants.ts";
import { landingBox, mountDomEffect, mountHold, type DomEffect, type DomEffectBoxes } from "./dom.ts";
import { createFrameLoop, type FxFrame } from "./loop.ts";
import { createParticleSystem } from "./particles.ts";
import { pointIn } from "./anchors.ts";
import { createRng } from "./rng.ts";
import { createShake } from "./shake.ts";
import type { FxSurface } from "./surface.ts";
import type {
  FxAnchor,
  FxBox,
  FxCue,
  FxDomCue,
  FxFrameSource,
  FxPoint,
  FxShakeSink,
  FxStageCue,
  FxVisibility,
} from "./types.ts";

/** < FX_MOBILE_WIDTH ? FX_PARTICLE_CAP_MOBILE : FX_PARTICLE_CAP */
export function capacityFor(viewportWidth: number): number {
  return viewportWidth < FX_MOBILE_WIDTH ? FX_PARTICLE_CAP_MOBILE : FX_PARTICLE_CAP;
}

export type FxDirectorOptions = {
  surface: FxSurface | null; // null: canvas cues (burst, projectile, crack, ring) are dropped
  domRoot: HTMLElement; // DOM cues mount here via mountDomEffect (S10)
  now: () => number;
  frames: FxFrameSource;
  visibility: FxVisibility;
  measure: (anchor: FxAnchor) => FxBox | null;
  shakeSink: FxShakeSink;
  seed: number;
  capacity: number;
  /** The board element a stage cue acts on, by testid. Defaults to a `document` query. */
  element?: (testid: string) => HTMLElement | null;
  /**
   * Tells the director the page scrolled or resized, so a parked stand-in follows its zone. Defaults
   * to the window's `scroll` (capture) and `resize` events.
   */
  viewport?: FxViewportEvents;
};

/** Scroll and resize, as one subscription; returns its own unsubscribe. */
export type FxViewportEvents = { subscribe(listener: () => void): () => void };

export type FxDirector = {
  /** Schedules cues relative to now(); each fires on the first frame where now() ≥ playTime + delayMs. Dropped while hidden. */
  play(cues: readonly FxCue[]): void;
  /** Removes every pending cue, DOM effect, particle, projectile, crack and ring; resets the shake and calls shakeSink.clear(). */
  clear(): void;
  /**
   * The board now shows a newer view: removes every stand-in and un-hides every concealed card and
   * every aimed lunge (B46–B48), and leaves everything else to finish.
   */
  release(): void;
  /** Pending cues + mounted DOM effects + canvasFx.alive() + (shake active ? 1 : 0). */
  active(): number;
  particles(): number;
  capacity(): number;
  dispose(): void;
};

type PendingCue = { cue: FxCue; due: number };
type MountedEffect = { effect: DomEffect; expiresAt: number; kind: FxDomCue["kind"] };
/**
 * A stage effect: undone by release(), clear() or its own expiry. `track` moves a stand-in after its
 * zone, and runs only on frames where the board under it moved.
 */
type StagedEffect = { undo(): void; track?: () => void; expiresAt: number };

function defaultViewport(): FxViewportEvents {
  return {
    subscribe(listener) {
      if (typeof window === "undefined") return () => undefined;
      const options = { capture: true, passive: true } as const;
      window.addEventListener("scroll", listener, options);
      window.addEventListener("resize", listener, options);
      return () => {
        window.removeEventListener("scroll", listener, options);
        window.removeEventListener("resize", listener, options);
      };
    },
  };
}

const sameBox = (a: FxBox, b: FxBox): boolean =>
  a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;

/**
 * The board writes `data-animating` on the card a stand-in carries (a Cry that buffs or transforms
 * the unit just played targets its hand card). That card is hidden, so its keyframes would play on
 * nothing: the stand-in plays them instead. `cardPlayed` stays on the hand card, which the stand-in
 * has already left.
 */
function mirrorAnimating(source: Element, copy: Element): () => void {
  const sync = (): void => {
    const value = source.getAttribute("data-animating");
    if (value !== null && value !== "cardPlayed") copy.setAttribute("data-animating", value);
    else copy.removeAttribute("data-animating");
  };
  sync();
  if (typeof MutationObserver === "undefined") return () => undefined;
  const observer = new MutationObserver(sync);
  observer.observe(source, { attributes: true, attributeFilter: ["data-animating"] });
  return () => observer.disconnect();
}

function isStageCue(cue: FxCue): cue is FxStageCue {
  return cue.kind === "hold" || cue.kind === "conceal" || cue.kind === "lunge";
}

function defaultElement(testid: string): HTMLElement | null {
  if (typeof document === "undefined") return null;
  return document.querySelector<HTMLElement>(`[data-testid="${testid.replace(/["\\]/g, "\\$&")}"]`);
}

/** The card a stand-in copies: the element itself when it is a card, else the last card inside it (a hand of backs). */
function cardIn(element: HTMLElement | null): HTMLElement | null {
  if (element === null) return null;
  if (element.classList.contains("card")) return element;
  const cards = element.querySelectorAll<HTMLElement>(".card");
  return cards.length > 0 ? (cards[cards.length - 1] ?? null) : null;
}

function boxOfElement(element: Element): FxBox | null {
  const rect = element.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;
  return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
}

function isCanvasCue(cue: FxCue): boolean {
  return cue.kind === "burst" || cue.kind === "projectile" || cue.kind === "crack" || cue.kind === "ring";
}

/** The point inside an anchor's box an emission aims at: a testid anchor may name one. */
function atOf(anchor: FxAnchor): FxPoint | undefined {
  return anchor.kind === "testid" ? anchor.at : undefined;
}

export function createFxDirector(options: FxDirectorOptions): FxDirector {
  const { surface, domRoot, now, frames, visibility, shakeSink, seed } = options;
  const element = options.element ?? defaultElement;

  /**
   * Cards a stand-in is carrying, by the testid they had: while one flies or waits in its new zone,
   * effects aimed at the card (a Cry's buff on the unit just played, a hit on the one just stolen)
   * land on the stand-in, not on the empty place the card was concealed in.
   */
  const carried = new Map<string, HTMLElement>();
  const measure = (anchor: FxAnchor): FxBox | null => {
    if (anchor.kind === "testid") {
      const standIn = carried.get(anchor.testid);
      if (standIn !== undefined) return boxOfElement(standIn) ?? options.measure(anchor);
    }
    return options.measure(anchor);
  };

  let cap = options.capacity;
  const particles = createParticleSystem({ capacity: cap, rng: createRng(seed) });
  const canvasFx = createCanvasFx({ particles, rng: createRng(seed + 1) });
  const shake = createShake({ seed });

  let pending: PendingCue[] = [];
  let mounted: MountedEffect[] = [];
  let staged: StagedEffect[] = [];
  let shaking = false;
  let disposed = false;
  /** The canvas still shows something from an earlier frame, so it must be cleared once more. */
  let painted = false;
  /** The page scrolled or resized since the last frame: parked stand-ins re-measure their zone. */
  let layoutDirty = false;

  // Adaptive quality (B34). The cap halves when frames run slow and doubles back once they are
  // healthy again. "Slow" is judged against the display's own refresh, learned as the shortest
  // steady interval seen, so a 30 Hz display (a phone in low-power mode) is not mistaken for load:
  // a window is slow once its frames take longer than FX_ADAPT_WINDOW frames at
  // max(FX_ADAPT_SLOW_MS, FX_ADAPT_SLOW_FACTOR × refresh). The check runs every frame, so a stall of
  // a few long frames trips it at once instead of after a whole window.
  const initialCap = cap;
  let displayMs = Number.POSITIVE_INFINITY;
  let windowCount = 0;
  let windowSum = 0;
  let healthyWindows = 0;

  const resetWindow = (): void => {
    windowCount = 0;
    windowSum = 0;
  };

  const setCap = (next: number): void => {
    if (next === cap) return;
    cap = next;
    particles.setCapacity(cap);
  };

  const adapt = (frame: FxFrame): void => {
    // The first frame after a wake is timed from the wake, not from a frame: it says nothing.
    if (frame.first) return;
    const raw = Math.max(0, frame.raw);
    if (raw >= FX_ADAPT_MIN_INTERVAL_MS) displayMs = Math.min(displayMs, raw);
    const refresh = Math.min(displayMs, FX_ADAPT_DISPLAY_MAX_MS);
    const slowMs = Math.max(FX_ADAPT_SLOW_MS, refresh * FX_ADAPT_SLOW_FACTOR);
    windowCount += 1;
    windowSum += raw;
    if (windowSum > FX_ADAPT_WINDOW * slowMs) {
      setCap(Math.max(FX_PARTICLE_CAP_MIN, Math.floor(cap / 2)));
      healthyWindows = 0;
      resetWindow();
      return;
    }
    if (windowCount < FX_ADAPT_WINDOW) return;
    resetWindow();
    healthyWindows += 1;
    if (healthyWindows >= FX_ADAPT_RECOVER_WINDOWS && cap < initialCap) {
      setCap(Math.min(initialCap, cap * 2));
      healthyWindows = 0;
    }
  };

  const mountDom = (cue: FxDomCue, due: number, at: number): void => {
    const expiresAt = due + cue.durationMs;
    // A cue whose whole life passed while no frame ran (a stalled tab) is not worth a mount.
    if (expiresAt <= at) return;
    let boxes: DomEffectBoxes = {};
    switch (cue.kind) {
      case "splat":
      case "rays":
      case "sheen":
      case "arrows": {
        const box = measure(cue.at);
        if (box === null) return;
        boxes = { at: box };
        break;
      }
      case "ghost": {
        const from = measure(cue.from);
        if (from === null) return;
        const to = measure(cue.to);
        if (to === null) return;
        boxes = { from, to };
        break;
      }
      // banner and result need no box: CSS places them on the viewport.
    }
    // One banner at a time: a new one replaces any still fading, so two never read over each other.
    if (cue.kind === "banner") {
      mounted = mounted.filter((item) => {
        if (item.kind !== "banner") return true;
        item.effect.remove();
        return false;
      });
    }
    const effect = mountDomEffect(domRoot, cue, boxes);
    if (effect !== null) mounted.push({ effect, expiresAt, kind: cue.kind });
  };

  /** Holds, conceals and lunges act on the board's own elements (stage.ts). */
  const stage = (cue: FxStageCue, due: number, at: number): void => {
    const expiresAt = due + cue.durationMs;
    if (expiresAt <= at) return;
    switch (cue.kind) {
      case "hold": {
        const zone = measure(cue.to);
        if (zone === null) return;
        const source = cue.from !== null && cue.from.kind === "testid" ? cardIn(element(cue.from.testid)) : null;
        const from = source !== null ? boxOfElement(source) : null;
        const copied = from !== null ? source : null;
        const parent = copied?.parentElement ?? null;
        const font = parent !== null ? (parent.ownerDocument.defaultView?.getComputedStyle(parent).fontSize ?? null) : null;
        // Placed once, here. After that it moves only when the board under it does (a shake, a
        // scroll), and then by `translate`, which needs no layout; a new size (a resize) re-places it.
        let placed = landingBox(zone, from);
        let shown = placed;
        const hold = mountHold(domRoot, cue, { source: copied, from, land: placed, font });
        const carriedId = copied !== null && cue.from !== null && cue.from.kind === "testid" && copied === element(cue.from.testid)
          ? cue.from.testid
          : null;
        if (carriedId !== null) carried.set(carriedId, hold.el);
        const copy = hold.el.firstElementChild;
        const unmirror = carriedId !== null && copied !== null && copy !== null ? mirrorAnimating(copied, copy) : () => undefined;
        staged.push({
          undo: () => {
            unmirror();
            if (carriedId !== null && carried.get(carriedId) === hold.el) carried.delete(carriedId);
            hold.remove();
          },
          track: () => {
            const next = measure(cue.to);
            if (next === null) return;
            const land = landingBox(next, from);
            if (sameBox(land, shown)) return;
            shown = land;
            if (land.width !== placed.width || land.height !== placed.height) {
              placed = land;
              hold.place(land);
              hold.shift(0, 0);
            } else {
              hold.shift(land.x - placed.x, land.y - placed.y);
            }
          },
          expiresAt,
        });
        return;
      }
      case "conceal": {
        const target = element(cue.testid);
        if (target === null) return;
        target.setAttribute("data-fx-concealed", cue.mode);
        staged.push({
          undo: () => {
            if (target.getAttribute("data-fx-concealed") === cue.mode) target.removeAttribute("data-fx-concealed");
          },
          expiresAt,
        });
        return;
      }
      case "lunge": {
        const attacker = element(cue.attacker);
        const target = element(cue.target);
        if (attacker === null || target === null) return;
        const a = boxOfElement(attacker);
        const b = boxOfElement(target);
        if (a === null || b === null) return;
        const dx = b.x + b.width / 2 - (a.x + a.width / 2);
        const dy = b.y + b.height / 2 - (a.y + a.height / 2);
        const distance = Math.hypot(dx, dy);
        if (!(distance > 0)) return;
        // How far each box reaches from its centre along the line between them, so the attacker
        // stops just into the target whichever way it comes at it.
        const ux = Math.abs(dx) / distance;
        const uy = Math.abs(dy) / distance;
        const extents = (ux * (a.width + b.width) + uy * (a.height + b.height)) / 2;
        const reach = Math.min(FX_LUNGE_MAX_PX, Math.max(FX_LUNGE_MIN_PX, distance - extents * FX_LUNGE_STANDOFF));
        attacker.style.setProperty("--fx-lunge-x", `${((dx / distance) * reach).toFixed(1)}px`);
        attacker.style.setProperty("--fx-lunge-y", `${((dy / distance) * reach).toFixed(1)}px`);
        staged.push({
          undo: () => {
            attacker.style.removeProperty("--fx-lunge-x");
            attacker.style.removeProperty("--fx-lunge-y");
          },
          expiresAt,
        });
        return;
      }
    }
  };

  const releaseStaged = (): void => {
    const undone = staged;
    staged = [];
    for (const item of undone) item.undo();
  };

  /** Undoes every stage effect whose safety cap has passed (FX_HOLD_MAX_MS, R200). */
  const expireStaged = (at: number): void => {
    if (staged.length === 0) return;
    const kept: StagedEffect[] = [];
    for (const item of staged) {
      if (item.expiresAt <= at) item.undo();
      else kept.push(item);
    }
    staged = kept;
  };

  const fire = (cue: FxCue, due: number, at: number): void => {
    if (isStageCue(cue)) {
      stage(cue, due, at);
      return;
    }
    switch (cue.kind) {
      case "burst": {
        const box = measure(cue.at);
        if (box === null) return;
        const origin = pointIn(box, atOf(cue.at));
        particles.emit(cue.preset, origin.x, origin.y, {
          count: cue.count,
          spread: cue.spread,
          box,
          power: cue.power,
        });
        // A preset with a `flash` blooms where it bursts (presets.ts); the rest paint nothing here.
        canvasFx.flash(cue.preset, origin, box, cue.count);
        return;
      }
      case "projectile": {
        const from = measure(cue.from);
        if (from === null) return;
        const to = measure(cue.to);
        if (to === null) return;
        canvasFx.projectile(cue.preset, pointIn(from, atOf(cue.from)), pointIn(to, atOf(cue.to)), cue.flightMs, cue.density);
        return;
      }
      case "crack": {
        const box = measure(cue.at);
        if (box === null) return;
        canvasFx.crack(box, cue.durationMs);
        return;
      }
      case "ring": {
        const box = measure(cue.at);
        if (box === null) return;
        canvasFx.ring(cue.preset, box, cue.durationMs);
        return;
      }
      case "shake":
        shake.add(cue.trauma);
        return;
      default:
        mountDom(cue, due, at);
        return;
    }
  };

  const hasWork = (): boolean =>
    pending.length > 0 ||
    mounted.length > 0 ||
    layoutDirty ||
    particles.alive() > 0 ||
    canvasFx.alive() > 0 ||
    shake.active();

  const onFrame = (frame: FxFrame): boolean => {
    const at = frame.now;

    // 1. Fire due cues, in the order they were played.
    if (pending.length > 0) {
      const due: PendingCue[] = [];
      const later: PendingCue[] = [];
      for (const item of pending) (item.due <= at ? due : later).push(item);
      pending = later;
      for (const item of due) fire(item.cue, item.due, at);
    }

    // 2. Move everything by the clamped frame time and age it by the real one.
    const age = Math.max(0, frame.raw);
    particles.step(frame.dt, age);
    canvasFx.step(frame.dt, age);
    shake.step(age);

    // 3. The shake reaches the page only through the sink. The board moved this frame if it shook
    //    now or shook last frame (this frame puts it back).
    const boardMoved = shake.active() || shaking;
    if (shake.active()) {
      shakeSink.apply(shake.sample(at));
      shaking = true;
    } else if (shaking) {
      shakeSink.clear();
      shaking = false;
    }

    // 4. Redraw the canvas, while anything is on it.
    if (surface !== null) {
      const live = particles.alive() > 0 || canvasFx.alive() > 0;
      if (live || painted) {
        surface.clear();
        particles.draw(surface.ctx, surface.dpr());
        canvasFx.draw(surface.ctx);
        painted = live;
      }
    }

    // 5. Expire DOM and stage effects. A stand-in follows its zone only when the board moved.
    if (mounted.length > 0) {
      const kept: MountedEffect[] = [];
      for (const item of mounted) {
        if (item.expiresAt <= at) item.effect.remove();
        else kept.push(item);
      }
      mounted = kept;
    }
    expireStaged(at);
    if (boardMoved || layoutDirty) for (const item of staged) item.track?.();
    layoutDirty = false;

    // 6. Adaptive quality on the raw (unclamped) frame time.
    adapt(frame);

    // 7. Keep going while there is anything left to do.
    return hasWork();
  };

  const clear = (): void => {
    pending = [];
    for (const item of mounted) item.effect.remove();
    mounted = [];
    releaseStaged();
    particles.clear();
    canvasFx.clear();
    shake.reset();
    shaking = false;
    shakeSink.clear();
    surface?.clear();
    painted = false;
  };

  const loop = createFrameLoop({
    frames,
    visibility,
    now,
    onFrame,
    // A page that was hidden has missed every frame its cues were due on; replaying them late
    // would stack a backlog of flourishes over a board that has long moved on.
    onResume: clear,
  });

  const unsubscribeViewport = (options.viewport ?? defaultViewport()).subscribe(() => {
    if (disposed || staged.length === 0) return;
    layoutDirty = true;
    loop.wake();
  });

  return {
    play(cues: readonly FxCue[]): void {
      if (disposed || cues.length === 0) return;
      if (visibility.hidden()) return;
      const playTime = now();
      expireStaged(playTime);
      let added = 0;
      for (const cue of cues) {
        if (surface === null && isCanvasCue(cue)) continue;
        // A stage cue due now acts at once, against the board as it is in this very task: the hand
        // card a stand-in replaces and the stand-in itself change in the same paint, and a lunge is
        // aimed before its keyframes' first frame.
        if (isStageCue(cue) && cue.delayMs <= 0) stage(cue, playTime, playTime);
        else pending.push({ cue, due: playTime + cue.delayMs });
        added += 1;
      }
      if (added > 0) loop.wake();
    },
    clear,
    release: releaseStaged,
    active(): number {
      return pending.length + mounted.length + staged.length + canvasFx.alive() + (shake.active() ? 1 : 0);
    },
    particles(): number {
      return particles.alive();
    },
    capacity(): number {
      return cap;
    },
    dispose(): void {
      if (disposed) return;
      clear();
      disposed = true;
      unsubscribeViewport();
      loop.dispose();
    },
  };
}
