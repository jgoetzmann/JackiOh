// The coach on the board: a bubble that says what to do next, and a ring round what it is about
// (SPEC §9.10, R292).
//
// It draws what the tracker (tracker.ts) says the coach shows, with three rules of its own:
//
//  - It waits for the board. `Game.tsx` holds each new view back while its events animate, and an
//    element under the board carries `data-animating` for exactly that long, so a display from a
//    newer snapshot shows only once nothing under `boardRoot` does, and once the opponent's card
//    the board holds up (`data-showcase`, portalled to <body>) is down, for at most
//    COACH_SHOWCASE_WAIT_MAX_MS. It looks a microtask after the snapshot arrives, never in the same
//    commit: the board plans a snapshot's events in a layout effect and marks them in the render
//    that follows, which React can run after this component's effects, so a look in the effect
//    itself read a board that had not started animating yet. Until then the bubble keeps the
//    display the board has caught up with, marked stale, so the coach never points at a card the
//    board has not drawn yet; a press on a stale bubble answers nothing (tracker `expected`).
//  - It never covers what it points at, and never blocks the board: the ring is `pointer-events:
//    none`, and on a desktop or a tablet the bubble floats beside its anchor (layout.ts), off what
//    the player is about to tap before anything else (the zones and targets a play in progress
//    asks for, else the units ready to act). On the board's phone
//    layouts (COACH_DOCK_QUERY, followed live as the phone turns) there is no room beside anything,
//    and a bubble docked to an edge sat on your hand and End turn: there the coach is a panel in the
//    page instead, between the HUD and the board (`data-coach-dock="panel"`), and the board is laid
//    out in the height that is left, so nothing on it is ever covered. The panel keeps one height
//    whatever it says, so the board does not resize from step to step: its text is clamped to the
//    lines the screen can spare (tutorial.css), with More and Less when it runs over. With nothing
//    to point at on screen, the coach shows without a ring, and an anchor under an open prompt
//    (a phone's picker sheet over your hand) is not on screen.
//  - It never takes over, and it has no Skip step (R314). The only step or tip that holds the AI is
//    one with "Got it"; an action step waits while the game goes on; the waiting line says whose
//    move it is and has no buttons, and a step waiting for its moment retires by itself
//    (TUTORIAL_STEP_TURNS_MAX). Exit tutorial is in the HUD throughout, which nothing is ever placed
//    over. Escape does not end the tutorial; focus moves to "Got it" when a step that needs it
//    appears, but never out of an open prompt or dialog.
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

import { LANES, testid } from "../game/contract.ts";
import {
  COACH_BUBBLE_GAP_PX,
  COACH_BUBBLE_MIN_HEIGHT_PX,
  COACH_DOCK_QUERY,
  COACH_RING_PAD_PX,
  COACH_SHOWCASE_WAIT_MAX_MS,
  COACH_TRACK_INTERVAL_MS,
  COACH_VIEWPORT_MARGIN_PX,
} from "./config.ts";
import { padRect, placeBubble, unionRect, type BubblePlacement, type Rect } from "./layout.ts";
import { tutorialTestid } from "./testids.ts";
import { displayKey, type CoachTracker, type CoachView } from "./tracker.ts";
import "./tutorial.css";

/** What the bubble stays clear of when it can (an open prompt, your hand, End turn), besides its anchor. */
const SOFT_OBSTACLES: readonly string[] = ["prompt-modal", "hand-you", "end-turn"];

/**
 * Beside an anchor, the bubble also stays off both unit rows when one side lets it: the units a step
 * asks the player to attack with, or at, stand there. A step pointing at the enemy hero otherwise
 * sat below it, on the enemy Taunt unit its own attack had to hit first (e2e spec 22). An unanchored
 * bubble keeps to the middle of the screen, which is over the board whatever it does.
 */
const UNIT_ROWS: readonly string[] = (["opponent", "you"] as const).flatMap((side) =>
  LANES.map((lane) => testid.zone(side, "units", lane)),
);

/**
 * What the player is about to tap, which the bubble keeps clear of before anything else
 * (layout.ts `keepClear`). While a play or an attack is in progress (something on the board is
 * selected, or a card is being dragged), the zones and targets it asks for, which the board marks
 * legal: the bubble never sits on the lane it asks you to drop a card in. Otherwise the units that
 * glow ready to act: a step pointing at the unit to attack sat on the attacker it named. Board
 * testids only (game/contract.ts): zones, field cards and heroes, never your hand.
 */
const IN_PROGRESS = `[data-testid="${testid.board}"] [data-selected="true"]`;
const ASKED_FOR = ["zone-", "card-", "hero-"].map((prefix) => `[data-testid^="${prefix}"][data-legal="true"]`).join(", ");
const READY_UNITS = '[data-testid^="card-"][data-glow]';

/** The open prompt (the picker's modal, or a phone's sheet or bar). */
const PROMPT_MODAL = "prompt-modal";

/** Where focus must never be pulled out of. */
const FOCUS_KEEPERS = '[data-testid="prompt-modal"], [role="dialog"][aria-modal="true"], [role="alertdialog"]';

/** The generic line on the player's own turn when no step is showing. */
const YOUR_MOVE = "Your move: play cards and attack, then press End turn.";
const AI_MOVE = "The AI is taking its turn.";

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

/**
 * The anchor element's box, or null when it is not on screen: not laid out, or under the open
 * prompt (its centre inside the prompt's box, and the element not part of the prompt). On a phone
 * the picker is a sheet over the bottom of the board, and a ring there pointed at a card the sheet
 * hid.
 */
function visibleRect(element: Element | null, prompt: Element | null): Rect | null {
  const rect = rectOf(element);
  if (rect === null || element === null || prompt === null || prompt.contains(element)) return rect;
  const cover = rectOf(prompt);
  if (cover === null) return rect;
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const hidden = x >= cover.left && x <= cover.left + cover.width && y >= cover.top && y <= cover.top + cover.height;
  return hidden ? null : rect;
}

/** Where the coach sits: a panel in the page on the board's phone layouts, a floating bubble elsewhere. */
export type CoachDock = "panel" | "float";

function dockQuery(): MediaQueryList | null {
  try {
    return typeof window.matchMedia === "function" ? window.matchMedia(COACH_DOCK_QUERY) : null;
  } catch {
    return null;
  }
}

function currentDock(): CoachDock {
  return dockQuery()?.matches === true ? "panel" : "float";
}

function serverDock(): CoachDock {
  return "float";
}

/**
 * The layout switches live when a phone turns or a window is resized. `resize` as well as the
 * query's own `change`: an old Safari's MediaQueryList has only `addListener`, and a test's stub
 * fires nothing. Both only prompt a re-read, so hearing a change twice costs nothing.
 */
function subscribeDock(onChange: () => void): () => void {
  const query = dockQuery();
  window.addEventListener("resize", onChange);
  if (typeof query?.addEventListener === "function") query.addEventListener("change", onChange);
  else query?.addListener?.(onChange);
  return () => {
    window.removeEventListener("resize", onChange);
    if (typeof query?.removeEventListener === "function") query.removeEventListener("change", onChange);
    else query?.removeListener?.(onChange);
  };
}

/**
 * What the coach measured: the ring round its anchor, where the floating bubble goes (null for the
 * panel, which the page lays out), and whether the panel's text runs past the lines it shows.
 */
type Geometry = { ring: Rect | null; place: BubblePlacement | null; clamped: boolean };

const NO_GEOMETRY: Geometry = { ring: null, place: null, clamped: false };

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
  if (!sameRect(a.ring, b.ring) || a.clamped !== b.clamped) return false;
  const p = a.place;
  const q = b.place;
  if (p === null || q === null) return p === q;
  return (
    p.side === q.side &&
    Math.round(p.left) === Math.round(q.left) &&
    Math.round(p.top) === Math.round(q.top) &&
    p.maxHeight === q.maxHeight
  );
}

/**
 * The display the board has caught up with: the newest one once nothing under `root` animates and
 * no played card is held up, the one already showing until then (null before the first).
 *
 * A display from the snapshot already showing (after Got it) has nothing new on the board and
 * shows at once. One from a new snapshot is looked at a microtask later: `Game.tsx` plans the
 * snapshot's events in a layout effect and draws `data-animating` in the render that follows, and
 * React may run that render after this effect (it flushes a sync commit's passive effects first),
 * so a look here and now saw a board that had not started animating: the next step showed while the
 * board still played the last action. The showcase is waited for at most COACH_SHOWCASE_WAIT_MAX_MS
 * per card, as the AI is (routes/practice.tsx `useMarkHold`).
 */
function useCaughtUp(latest: CoachView, root: HTMLElement | null): CoachView | null {
  const [shown, setShown] = useState<CoachView | null>(null);
  const newest = useRef(latest);
  newest.current = latest;
  const showing = useRef<CoachView | null>(null);
  showing.current = shown;

  useEffect(() => {
    let live = true;
    let cap: ReturnType<typeof setTimeout> | null = null;
    /** The cap ran out on the card held up now; it is not waited for again until it goes. */
    let capped = false;
    const adopt = (): void => {
      if (!live) return;
      if (root !== null && root.querySelector("[data-animating]") !== null) return;
      if (document.querySelector("[data-showcase]") !== null) {
        if (!capped) {
          cap ??= setTimeout(() => {
            cap = null;
            capped = true;
            adopt();
          }, COACH_SHOWCASE_WAIT_MAX_MS);
          return;
        }
      } else {
        capped = false;
        if (cap !== null) clearTimeout(cap);
        cap = null;
      }
      setShown(newest.current);
    };
    const now = showing.current;
    if (now === null || now.ctx === latest.ctx) adopt();
    else queueMicrotask(adopt);
    if (typeof MutationObserver !== "function") {
      return () => {
        live = false;
        if (cap !== null) clearTimeout(cap);
      };
    }
    const observer = new MutationObserver(adopt);
    if (root !== null) {
      observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-animating"] });
    }
    // The showcase is portalled to <body>: it comes and goes as a child of it.
    observer.observe(document.body, { childList: true });
    return () => {
      live = false;
      observer.disconnect();
      if (cap !== null) clearTimeout(cap);
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
  const dock = useSyncExternalStore(subscribeDock, currentDock, serverDock);
  const panel = dock === "panel";

  const bubble = useRef<HTMLElement>(null);
  const text = useRef<HTMLParagraphElement>(null);
  const ackButton = useRef<HTMLButtonElement>(null);
  /** Focus was inside the bubble when its buttons last changed the display. */
  const refocus = useRef(false);
  const titleId = useId();
  const textId = useId();
  const [geometry, setGeometry] = useState<Geometry>(NO_GEOMETRY);
  /** The display whose whole text the panel shows ("More"); a new display starts clamped again. */
  const [expandedFor, setExpandedFor] = useState<string | null>(null);
  const expanded = panel && expandedFor === key;

  // Measure the anchor and place the bubble, now, on the next frame, and every
  // COACH_TRACK_INTERVAL_MS while it shows: the board moves cards as it animates and the hand fans
  // out on hover, and none of that resizes anything the page could listen to. The next frame catches
  // an anchor the board draws in the commit after this display's (a unit just played), which the
  // interval would ring up to a tick late. The panel is laid out by the page, so there it is only
  // the ring, and whether the text runs past the panel's lines (a step's text can change as it shows).
  useLayoutEffect(() => {
    if (!visible) {
      setGeometry((prev) => (sameGeometry(prev, NO_GEOMETRY) ? prev : NO_GEOMETRY));
      return;
    }
    const ids = targetKey.length === 0 ? [] : targetKey.split(" ");
    const measure = (): void => {
      const prompt = byTestid(PROMPT_MODAL);
      const found = ids.map((id) => visibleRect(byTestid(id), prompt)).filter((rect): rect is Rect => rect !== null);
      const union = unionRect(found);
      const ring = union === null ? null : padRect(union, COACH_RING_PAD_PX);
      if (panel) {
        // Unfolded, the text runs over nothing; it keeps the answer it had folded, so Less stays.
        const box = text.current;
        const over = box !== null && box.scrollHeight > box.clientHeight + 1;
        setGeometry((prev) => {
          const next: Geometry = { ring, place: null, clamped: expanded ? prev.clamped : over };
          return sameGeometry(prev, next) ? prev : next;
        });
        return;
      }
      const own = new Set(ids);
      const avoid = (ring === null ? SOFT_OBSTACLES : [...SOFT_OBSTACLES, ...UNIT_ROWS])
        .filter((id) => !own.has(id))
        .map((id) => rectOf(byTestid(id)))
        .filter((rect): rect is Rect => rect !== null);
      const inProgress = document.querySelector(IN_PROGRESS) !== null || document.documentElement.hasAttribute("data-dragging");
      const keepClear = [...document.querySelectorAll(inProgress ? ASKED_FOR : READY_UNITS)]
        .filter((element) => !own.has(element.getAttribute("data-testid") ?? ""))
        .map((element) => rectOf(element))
        .filter((rect): rect is Rect => rect !== null);
      const hud = rectOf(byTestid(tutorialTestid.hud));
      const element = bubble.current;
      const place = placeBubble({
        anchor: ring,
        bubble: { width: element?.offsetWidth ?? 0, height: element?.offsetHeight ?? 0 },
        viewport: { width: window.innerWidth, height: window.innerHeight },
        slim,
        insetTop: hud === null ? 0 : hud.top + hud.height,
        avoid,
        keepClear,
        gap: COACH_BUBBLE_GAP_PX,
        margin: COACH_VIEWPORT_MARGIN_PX,
        minHeight: COACH_BUBBLE_MIN_HEIGHT_PX,
      });
      const next: Geometry = { ring, place, clamped: false };
      setGeometry((prev) => (sameGeometry(prev, next) ? prev : next));
    };
    measure();
    const frame = typeof requestAnimationFrame === "function" ? requestAnimationFrame(measure) : null;
    const timer = setInterval(measure, COACH_TRACK_INTERVAL_MS);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, { capture: true, passive: true });
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      clearInterval(timer);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, { capture: true });
    };
  }, [visible, shown, targetKey, slim, panel, expanded]);

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

  const answer = useCallback(() => {
    refocus.current = bubble.current?.contains(document.activeElement) === true;
    tracker.ack(key);
  }, [tracker, key]);

  if (!visible || display === null || shown === null) return null;

  // The panel is laid out by the page; only the floating bubble is placed.
  const place = panel ? null : geometry.place;
  const style: CSSProperties | undefined = panel
    ? undefined
    : {
        left: place?.left ?? 0,
        top: place?.top ?? 0,
        ...(place?.maxHeight == null ? {} : { maxHeight: place.maxHeight }),
      };
  const count = `${String(display.stepNumber)} / ${String(display.stepCount)}`;
  const countLabel = `Step ${String(display.stepNumber)} of ${String(display.stepCount)}`;
  const full = display.mode === "tip" || display.mode === "step";
  // Waiting: a line saying whose move it is, and no buttons (see the header).
  const yourMove = !full && !shown.aiBusy && shown.yourMove;
  const waitingLine = shown.aiBusy ? AI_MOVE : yourMove ? YOUR_MOVE : "";
  const className = ["coach", panel ? "coach--panel" : "coach--float", ...(full ? [] : ["coach--slim"])].join(" ");
  const more = panel && (expanded || geometry.clamped);

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
        className={className}
        data-testid={tutorialTestid.coach}
        data-coach-mode={display.mode}
        data-coach-step={full ? display.id : undefined}
        data-coach-anchor={targetKey}
        data-coach-dock={dock}
        data-coach-side={place?.side}
        data-placed={panel || place !== null ? "true" : "false"}
        data-expanded={panel ? (expanded ? "true" : "false") : undefined}
        data-stale={stale ? "true" : undefined}
        role="region"
        aria-label={full ? undefined : "Tutorial coach"}
        aria-labelledby={full ? titleId : undefined}
        tabIndex={-1}
        style={style}
      >
        <div key="heading" className="coach__heading">
          <header className="coach__head">
            <span className="coach__eyebrow">{display.mode === "tip" ? "Tip" : "Coach"}</span>
            <span className="coach__count" aria-label={countLabel}>
              {count}
            </span>
          </header>
          {full ? (
            <h2 className="coach__title" id={titleId}>
              {display.title}
            </h2>
          ) : null}
        </div>
        <div key="body" className="coach__body">
          <p ref={text} id={textId} className="coach__text" aria-live="polite">
            {full ? display.text : waitingLine}
          </p>
          {more ? (
            <button
              type="button"
              className="coach__more"
              aria-expanded={expanded}
              aria-controls={textId}
              onClick={() => {
                setExpandedFor(expanded ? null : key);
              }}
            >
              {expanded ? "Less" : "More"}
            </button>
          ) : null}
        </div>
        <div key="actions" className="coach__actions">
          {full && display.ack ? (
            <button
              ref={ackButton}
              type="button"
              className="coach__ack"
              data-testid={tutorialTestid.coachAck}
              onClick={answer}
            >
              Got it
            </button>
          ) : null}
        </div>
      </section>
    </>
  );
}
