// The coach on the board: a bubble that says what to do next, and a ring round what it is about
// (SPEC §9.10, R292).
//
// It draws what the tracker (tracker.ts) says the coach shows, with three rules of its own:
//
//  - It waits for the board. `Game.tsx` holds each new view back while its events animate, and an
//    element under the board carries `data-animating` for exactly that long, so a display from a
//    newer snapshot shows only once nothing under `boardRoot` does. Until then the bubble keeps the
//    display the board has caught up with, marked stale, so the coach never points at a card the
//    board has not drawn yet; a press on a stale bubble answers nothing (tracker `expected`).
//  - It never covers what it points at, and never blocks the board: the ring is `pointer-events:
//    none`, and the bubble is placed beside its anchor (layout.ts), or docked to the far edge on a
//    phone. With nothing to point at on screen, the bubble shows without a ring.
//  - It never takes over. "Skip step" is always there while the lesson is on (and Exit tutorial is
//    in the HUD, which nothing is ever placed over); Escape does not end the tutorial; focus moves
//    to "Got it" when a step that needs it appears, but never out of an open prompt or dialog.
//
// Rule 7: nothing here reads the rules. The anchor's testids come from the view (targets.ts).

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
  type ReactElement,
} from "react";

import {
  COACH_BUBBLE_GAP_PX,
  COACH_BUBBLE_MIN_HEIGHT_PX,
  COACH_DOCK_QUERY,
  COACH_RING_PAD_PX,
  COACH_TRACK_INTERVAL_MS,
  COACH_VIEWPORT_MARGIN_PX,
} from "./config.ts";
import { padRect, placeBubble, unionRect, type BubblePlacement, type Rect } from "./layout.ts";
import { tutorialTestid } from "./testids.ts";
import { displayKey, type CoachTracker, type CoachView } from "./tracker.ts";
import "./tutorial.css";

/** What the bubble stays clear of when it can (an open prompt, your hand, End turn), besides its anchor. */
const SOFT_OBSTACLES: readonly string[] = ["prompt-modal", "hand-you", "end-turn"];

/** Where focus must never be pulled out of. */
const FOCUS_KEEPERS = '[data-testid="prompt-modal"], [role="dialog"][aria-modal="true"], [role="alertdialog"]';

function byTestid(id: string): Element | null {
  return document.querySelector(`[data-testid="${id.replace(/["\\]/g, "\\$&")}"]`);
}

function rectOf(element: Element | null): Rect | null {
  if (element === null) return null;
  const box = element.getBoundingClientRect();
  // Not on screen (display: none, or not laid out): nothing to ring.
  if (box.width <= 0 && box.height <= 0) return null;
  return { left: box.left, top: box.top, width: box.width, height: box.height };
}

function docked(): boolean {
  try {
    return typeof window.matchMedia === "function" && window.matchMedia(COACH_DOCK_QUERY).matches;
  } catch {
    return false;
  }
}

type Geometry = { ring: Rect | null; place: BubblePlacement | null };

const NO_GEOMETRY: Geometry = { ring: null, place: null };

function sameRect(a: Rect | null, b: Rect | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    Math.round(a.left) === Math.round(b.left) &&
    Math.round(a.top) === Math.round(b.top) &&
    Math.round(a.width) === Math.round(b.width) &&
    Math.round(a.height) === Math.round(b.height)
  );
}

function sameGeometry(a: Geometry, b: Geometry): boolean {
  if (!sameRect(a.ring, b.ring)) return false;
  const p = a.place;
  const q = b.place;
  if (p === null || q === null) return p === q;
  return (
    p.side === q.side &&
    Math.round(p.left) === Math.round(q.left) &&
    Math.round(p.top) === Math.round(q.top) &&
    p.width === q.width &&
    p.maxHeight === q.maxHeight
  );
}

/**
 * The display the board has caught up with: the newest one once nothing under `root` animates,
 * the one already showing until then (null before the first).
 */
function useCaughtUp(latest: CoachView, root: HTMLElement | null): CoachView | null {
  const [shown, setShown] = useState<CoachView | null>(null);
  const newest = useRef(latest);
  newest.current = latest;

  useEffect(() => {
    const adopt = (): void => {
      if (root !== null && root.querySelector("[data-animating]") !== null) return;
      setShown(newest.current);
    };
    adopt();
    if (root === null || typeof MutationObserver !== "function") return;
    const observer = new MutationObserver(adopt);
    observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-animating"] });
    return () => {
      observer.disconnect();
    };
  }, [latest, root]);

  return shown;
}

export type CoachProps = {
  tracker: CoachTracker;
  /** The board's wrapper; a new display waits while anything under it carries `data-animating`. */
  boardRoot: HTMLElement | null;
};

export function Coach({ tracker, boardRoot }: CoachProps): ReactElement | null {
  const latest = useSyncExternalStore(tracker.subscribe, tracker.getState, tracker.getState);
  const shown = useCaughtUp(latest, boardRoot);
  const display = shown?.display ?? null;
  const visible = display !== null && display.mode !== "finished";
  const key = display === null ? "none" : displayKey(display);
  const stale = shown !== null && key !== displayKey(latest.display);
  const targets = shown?.targets ?? [];
  const targetKey = targets.join(" ");
  const slim = display?.mode === "waiting";

  const bubble = useRef<HTMLElement>(null);
  const ackButton = useRef<HTMLButtonElement>(null);
  /** Focus was inside the bubble when its buttons last changed the display. */
  const refocus = useRef(false);
  const titleId = useId();
  const [geometry, setGeometry] = useState<Geometry>(NO_GEOMETRY);

  // Measure the anchor and place the bubble, now and every COACH_TRACK_INTERVAL_MS while it shows:
  // the board moves cards as it animates and the hand fans out on hover, and none of that resizes
  // anything the page could listen to.
  useLayoutEffect(() => {
    if (!visible) {
      setGeometry((prev) => (sameGeometry(prev, NO_GEOMETRY) ? prev : NO_GEOMETRY));
      return;
    }
    const ids = targetKey.length === 0 ? [] : targetKey.split(" ");
    const measure = (): void => {
      const found = ids.map((id) => rectOf(byTestid(id))).filter((rect): rect is Rect => rect !== null);
      const union = unionRect(found);
      const ring = union === null ? null : padRect(union, COACH_RING_PAD_PX);
      const own = new Set(ids);
      const avoid = SOFT_OBSTACLES.filter((id) => !own.has(id))
        .map((id) => rectOf(byTestid(id)))
        .filter((rect): rect is Rect => rect !== null);
      const hud = rectOf(byTestid(tutorialTestid.hud));
      const element = bubble.current;
      const place = placeBubble({
        anchor: ring,
        bubble: { width: element?.offsetWidth ?? 0, height: element?.offsetHeight ?? 0 },
        viewport: { width: window.innerWidth, height: window.innerHeight },
        docked: docked(),
        slim,
        insetTop: hud === null ? 0 : hud.top + hud.height,
        avoid,
        gap: COACH_BUBBLE_GAP_PX,
        margin: COACH_VIEWPORT_MARGIN_PX,
        minHeight: COACH_BUBBLE_MIN_HEIGHT_PX,
      });
      const next: Geometry = { ring, place };
      setGeometry((prev) => (sameGeometry(prev, next) ? prev : next));
    };
    measure();
    const timer = setInterval(measure, COACH_TRACK_INTERVAL_MS);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, { capture: true, passive: true });
    return () => {
      clearInterval(timer);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, { capture: true });
    };
  }, [visible, shown, targetKey, slim]);

  // A step that needs "Got it" takes the focus, unless the player is answering a prompt or a
  // dialog; one that does not hands the focus back to the bubble if its buttons had it.
  useEffect(() => {
    if (!visible || display === null) return;
    const wantsAck = (display.mode === "tip" || display.mode === "step") && display.ack;
    const active = document.activeElement;
    const kept = active instanceof Element && active.closest(FOCUS_KEEPERS) !== null;
    if (wantsAck && !kept) {
      ackButton.current?.focus({ preventScroll: true });
    } else if (refocus.current && !kept) {
      bubble.current?.focus({ preventScroll: true });
    }
    refocus.current = false;
    // Only a new display moves the focus (`key`), never a re-render of the same one.
  }, [visible, key]);

  const answer = useCallback(
    (how: "ack" | "skip") => {
      refocus.current = bubble.current?.contains(document.activeElement) === true;
      if (how === "ack") tracker.ack(key);
      else tracker.skip(key);
    },
    [tracker, key],
  );

  if (!visible || display === null || shown === null) return null;

  const place = geometry.place;
  const style: CSSProperties = {
    left: place?.left ?? 0,
    top: place?.top ?? 0,
    ...(place?.width == null ? {} : { width: place.width }),
    ...(place?.maxHeight == null ? {} : { maxHeight: place.maxHeight }),
  };
  const count = `${String(display.stepNumber)} / ${String(display.stepCount)}`;
  const countLabel = `Step ${String(display.stepNumber)} of ${String(display.stepCount)}`;
  const full = display.mode === "tip" || display.mode === "step";

  return (
    <>
      {geometry.ring === null ? null : (
        <div
          className="coach-ring"
          data-testid={tutorialTestid.coachRing}
          data-stale={stale ? "true" : undefined}
          aria-hidden="true"
          style={{
            left: geometry.ring.left,
            top: geometry.ring.top,
            width: geometry.ring.width,
            height: geometry.ring.height,
          }}
        />
      )}
      <section
        ref={bubble}
        className={full ? "coach" : "coach coach--slim"}
        data-testid={tutorialTestid.coach}
        data-coach-mode={display.mode}
        data-coach-step={full ? display.id : undefined}
        data-coach-anchor={targetKey}
        data-coach-side={place?.side}
        data-placed={place === null ? "false" : "true"}
        data-stale={stale ? "true" : undefined}
        role="region"
        aria-label={full ? undefined : "Tutorial coach"}
        aria-labelledby={full ? titleId : undefined}
        tabIndex={-1}
        style={style}
      >
        <header key="head" className="coach__head">
          <span className="coach__eyebrow">{display.mode === "tip" ? "Tip" : "Coach"}</span>
          <span className="coach__count" aria-label={countLabel}>
            {count}
          </span>
        </header>
        {full ? (
          <h2 key="title" className="coach__title" id={titleId}>
            {display.title}
          </h2>
        ) : null}
        <p key="text" className="coach__text" aria-live="polite">
          {full ? display.text : shown.aiBusy ? "The AI is taking its turn." : ""}
        </p>
        <div key="actions" className="coach__actions">
          {full && display.ack ? (
            <button
              ref={ackButton}
              type="button"
              className="coach__ack"
              data-testid={tutorialTestid.coachAck}
              onClick={() => {
                answer("ack");
              }}
            >
              Got it
            </button>
          ) : null}
          <button
            type="button"
            className="coach__skip"
            data-testid={tutorialTestid.coachSkip}
            onClick={() => {
              answer("skip");
            }}
          >
            Skip step
          </button>
        </div>
      </section>
    </>
  );
}
