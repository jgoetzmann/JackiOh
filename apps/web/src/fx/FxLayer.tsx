// The effects layer (docs/polish/1-animations.md, S9): a fixed, click-through overlay that listens to
// the animation runner and decorates whatever entry it has in flight.
//
// It paces nothing (R200). The runner decides when an entry starts and ends and when the board
// swaps views; this component only hears about it through `subscribeSignals` and never calls
// `schedule`, `drain` or anything else that would change the runner's timing. The one thing it
// writes outside itself, besides the board shake, is `--anim-squeeze` on its parent: the ratio of
// the duration the runner actually gave an entry (after the speed setting and the burst budget,
// R201) to the table's duration, so the CSS keyframes play their whole motion in the time they got.
//
// The subscription is a LAYOUT effect on purpose. `Game` enqueues a view's events in its own layout
// effect, and child layout effects run before the parent's, so the listener is in place before the
// first entry of the first burst starts. A passive effect would miss it.
//
// It reads only the redacted stream (R202): the entry's events, the view the runner planned them
// against, and the public catalog, looked up by a `defId` the viewer can read ("hidden" never is).
//
// Under reduced motion (the media query or the viewer's setting) or with intensity "off", it renders
// the empty root with `data-fx="off"`: no canvas, no director, no cues. `--anim-squeeze` is still
// kept, because a speed-scaled entry still needs its keyframes squeezed. The viewer's reduce setting
// also writes `--anim-scale: 0` on the parent, exactly what index.css does under the media query, so
// the CSS-only motion (the result overlay's fade, the board's transitions) stops with it too.
//
// A finished game drains the runner (Game.tsx settles at once), which would clear the killing blow
// before it drew. The layer keeps the entries the drain cut short and replays the lethal one ahead of
// the game-over sequence (`planLethal`).

import {
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  type ReactElement,
} from "react";

import type { PlayerId, PlayerView } from "@jackioh/shared";

import {
  ANIMATIONS,
  reducedMotionNow,
  type AnimationEntry,
  type AnimationQueue,
  type RunnerSignal,
} from "../game/animations.ts";
import { CatalogContext, type CardLookup } from "../game/catalog.ts";
import { boardShakeSink, resolveAnchor } from "./anchors.ts";
import { FX_DEFAULT_SEED, FX_INTENSITY_SCALE } from "./constants.ts";
import { delayCues, planFx, planHandover, planLethal, planResult } from "./cues.ts";
import { planStage } from "./stage.ts";
import { capacityFor, createFxDirector, type FxDirector } from "./director.ts";
import { createFxMemory } from "./memory.ts";
import { useFxSettings } from "./settings.ts";
import { useSetting } from "../settings/store.ts";
import { createSurface, type FxSurface } from "./surface.ts";
import type {
  FxAnchor,
  FxBox,
  FxCardFacts,
  FxFrameSource,
  FxMemory,
  FxPlanEnv,
  FxShakeSink,
  FxVisibility,
} from "./types.ts";
import "./fx.css";

export type FxSeams = {
  now: () => number;
  frames: FxFrameSource;
  visibility: FxVisibility;
  measure: (anchor: FxAnchor) => FxBox | null;
  surface: (canvas: HTMLCanvasElement) => FxSurface | null;
  shakeSink: FxShakeSink;
  seed: number;
  /** Overrides the CatalogContext lookup. */
  catalog: (defId: string) => FxCardFacts | undefined;
  viewportWidth: () => number;
  /** The board element a stage cue acts on (stage.ts), by testid. */
  element: (testid: string) => HTMLElement | null;
};

export type FxLayerProps = {
  queue: AnimationQueue;
  /** The view the board is SHOWING (Game's `shown`), not the newest one. */
  view: PlayerView;
  /** Test seams; production passes none. */
  seams?: Partial<FxSeams>;
};

const SQUEEZE = "--anim-squeeze";
const SCALE = "--anim-scale";

function defaultNow(): number {
  return performance.now();
}

/** `requestAnimationFrame`, or a source that never fires where there is none (no timers: R200). */
function defaultFrames(): FxFrameSource {
  if (typeof window.requestAnimationFrame !== "function") {
    return { request: () => 0, cancel: () => undefined };
  }
  return {
    request: (callback) => window.requestAnimationFrame(callback),
    cancel: (handle) => window.cancelAnimationFrame(handle),
  };
}

function defaultVisibility(): FxVisibility {
  return {
    hidden: () => document.hidden === true,
    subscribe: (listener) => {
      document.addEventListener("visibilitychange", listener);
      return () => document.removeEventListener("visibilitychange", listener);
    },
  };
}


/** The public catalog facts an effect may use: rarity and printed stats of the base face. */
function catalogFacts(lookup: CardLookup | null, defId: string): FxCardFacts | undefined {
  if (defId === "hidden" || lookup === null) return undefined;
  const info = lookup(defId, false);
  if (info === undefined) return undefined;
  return { rarity: info.rarity, attack: info.attack, health: info.health };
}

function removeSqueeze(root: HTMLElement | null): void {
  root?.parentElement?.style.removeProperty(SQUEEZE);
}

export function FxLayer({ queue, view, seams }: FxLayerProps): ReactElement {
  const [settings] = useFxSettings();
  // The settings panel's "Reduce motion" is read through its hook so a change re-renders the layer;
  // `reducedMotionNow` reads the same switch for callers outside React.
  const panelReduces = useSetting("reduceMotion");
  const enabled = !panelReduces && !reducedMotionNow(settings) && settings.intensity !== "off";
  const settingReduces = settings.motion === "reduce" || panelReduces;
  const intensity: number = FX_INTENSITY_SCALE[settings.intensity];
  const lookup = useContext(CatalogContext);

  const rootRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const domRef = useRef<HTMLDivElement | null>(null);
  const director = useRef<FxDirector | null>(null);
  const memory = useRef<FxMemory | null>(null);
  if (memory.current === null) memory.current = createFxMemory();

  // What the runner's listener reads when a signal arrives. It is a ref, not a dependency, so the
  // subscription is made once per queue and never torn down between two entries of one burst.
  const live = useRef({ enabled, intensity, lookup, seams });
  live.current = { enabled, intensity, lookup, seams };

  const planEnv = (): FxPlanEnv => {
    const current = live.current;
    const override = current.seams?.catalog;
    return {
      intensity: current.intensity,
      card: override ?? ((defId: string) => catalogFacts(live.current.lookup, defId)),
      memory: memory.current!,
    };
  };

  // The director lives exactly as long as the canvas and the DOM root it draws into.
  useLayoutEffect(() => {
    if (!enabled) return undefined;
    const canvas = canvasRef.current!;
    const domRoot = domRef.current!;
    const s = live.current.seams ?? {};
    const surface = (s.surface ?? createSurface)(canvas);
    const created = createFxDirector({
      surface,
      domRoot,
      now: s.now ?? defaultNow,
      frames: s.frames ?? defaultFrames(),
      visibility: s.visibility ?? defaultVisibility(),
      measure: s.measure ?? resolveAnchor,
      shakeSink: s.shakeSink ?? boardShakeSink(document),
      seed: s.seed ?? FX_DEFAULT_SEED,
      capacity: capacityFor(s.viewportWidth?.() ?? window.innerWidth),
      element: s.element,
    });
    director.current = created;
    return () => {
      if (director.current === created) director.current = null;
      created.dispose();
      surface?.dispose();
    };
  }, [enabled]);

  // The reduce setting behaves exactly like the media query (R200): index.css zeroes --anim-scale
  // on :root under the query, and this zeroes it on the game root under the setting.
  useLayoutEffect(() => {
    const parent = rootRef.current?.parentElement ?? null;
    if (parent === null || !settingReduces) return undefined;
    parent.style.setProperty(SCALE, "0");
    return () => {
      parent.style.removeProperty(SCALE);
    };
  }, [settingReduces]);

  /** Entries started since the runner last went idle, and the ones a drain cut short (for planLethal). */
  const played = useRef<AnimationEntry[]>([]);
  const drained = useRef<readonly AnimationEntry[]>([]);

  // Runner signals. Declared after the director so a first `start` already has one to play into.
  useLayoutEffect(() => {
    const onSignal = (signal: RunnerSignal): void => {
      const root = rootRef.current;
      switch (signal.kind) {
        case "start": {
          const entry = signal.entry;
          played.current.push(entry);
          drained.current = [];
          const table = ANIMATIONS[entry.type].durationMs;
          const parent = root?.parentElement ?? null;
          if (parent !== null) {
            parent.style.setProperty(SQUEEZE, (entry.durationMs / table).toFixed(3));
          }
          const target = director.current;
          if (!live.current.enabled || target === null) return;
          const env = planEnv();
          env.memory.remember(entry.events);
          target.play([...planFx(entry, entry.view, env), ...planStage(entry, entry.view, env)]);
          return;
        }
        case "idle":
          removeSqueeze(root);
          played.current = [];
          return;
        case "drain": {
          removeSqueeze(root);
          director.current?.clear();
          memory.current?.clear();
          const cut = signal.entries.filter((entry) => !played.current.includes(entry));
          drained.current = [...played.current, ...cut];
          played.current = [];
          return;
        }
        case "reset":
          removeSqueeze(root);
          director.current?.clear();
          memory.current?.clear();
          played.current = [];
          drained.current = [];
          return;
      }
    };
    const unsubscribe = queue.subscribeSignals(onSignal);
    return () => {
      unsubscribe();
      removeSqueeze(rootRef.current);
    };
    // `planEnv` reads refs only, so the subscription depends on the queue alone.
  }, [queue]);

  // A newer view on the board ends every stage effect (stage.ts): the stand-ins give way to the cards
  // they stood in for, and the hidden cards are gone from the view anyway. A LAYOUT effect, so the
  // swap and the release land in the same paint and no frame shows both, or neither.
  const releasedFor = useRef<PlayerView | null>(null);
  useLayoutEffect(() => {
    if (releasedFor.current !== null && releasedFor.current !== view) director.current?.release();
    releasedFor.current = view;
  }, [view]);

  // The turn banner says its piece until the player acts: the first pointer down anywhere, or a
  // prompt opening for the viewer, takes it (and its rays) away, so it never sits over the zones a
  // play is asking about or behind a Discover sheet (integration QA).
  useEffect(() => {
    const onDown = (): void => {
      director.current?.dismissBanner();
    };
    document.addEventListener("pointerdown", onDown, true);
    return () => {
      document.removeEventListener("pointerdown", onDown, true);
    };
  }, []);
  const promptForViewer = view.pending !== null && view.pending.forYou;
  useEffect(() => {
    if (promptForViewer) director.current?.dismissBanner();
  }, [promptForViewer]);

  // The game-over sequence and the hot-seat hand-over banner run off the shown view, not an entry:
  // `gameOver` is a zero-duration row the runner never plays, and a seat change drains the runner.
  // `undefined` means "no view seen yet", so a mount that is already finished plays nothing.
  const lastResult = useRef<PlayerView["result"] | undefined>(undefined);
  const lastViewer = useRef<PlayerId | undefined>(undefined);
  useEffect(() => {
    const previousResult = lastResult.current;
    const previousViewer = lastViewer.current;
    lastResult.current = view.result;
    lastViewer.current = view.viewer;

    const cut = drained.current;
    drained.current = [];
    const target = director.current;
    if (!live.current.enabled || target === null) return;
    const env = planEnv();
    if (previousResult === null && view.result !== null) {
      // The killing blow first (the drain cleared it before it drew), then the result on its beat.
      for (const entry of cut) env.memory.remember(entry.events);
      const lethal = planLethal(cut, view, env);
      target.play([...lethal.cues, ...delayCues(planResult(view, env), lethal.leadMs)]);
    }
    if (previousViewer !== undefined && previousViewer !== view.viewer) target.play(planHandover(view, env));
    // `planEnv` reads refs only, so the effect depends on the view alone.
  }, [view]);

  return (
    <div ref={rootRef} className="fx-layer" data-testid="fx-layer" data-fx={enabled ? "on" : "off"} aria-hidden="true">
      {enabled ? <canvas ref={canvasRef} className="fx-canvas" data-testid="fx-canvas" /> : null}
      {enabled ? <div ref={domRef} className="fx-dom" data-testid="fx-dom" /> : null}
    </div>
  );
}

export default FxLayer;
