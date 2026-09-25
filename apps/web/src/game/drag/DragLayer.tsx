// Drag to play with unified pointer events (docs/polish/7-mobile-ux.md S9, B36-B39).
//
// One pointer at a time, mouse, pen and touch alike. A press on a hand card or on one of your
// units is only a *press* until it has travelled DRAG_THRESHOLD_PX; below that it is a click and
// the board's own click handlers run exactly as they always have, so click-click works in every
// mode. Past the threshold the press becomes a drag: the interaction the source click would have
// started is lifted (unsettled, `model.ts`), the board glows where it may land, and the release
// is handed to the same `onClickTarget` a second click would reach. Nothing here decides a rule
// (CLAUDE.md rule 7), and nothing is sent until the release.
//
// The listeners sit on `window`. Pointer events are taken in the capture phase so nothing on the
// board can hide a press or a release from the drag; keys and the context menu are taken in the
// bubble phase so a dialog that handles Escape itself (the settings panel) can keep it.
//
// A drop that sends a play leaves the card where it was dropped (`drag-landing`) and out of the
// fan (landing.ts) until the board shows a newer view: the runner holds the old one back while the
// play's events animate, and the card flying back into the hand for that time read as a refusal.

import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactElement } from "react";

import type { ActionBody, CardView, PlayerView } from "@jackioh/shared";

import { readSettings } from "../../settings/index.ts";
import { IDLE, type Interaction } from "../actions.ts";
import { MatchCardsProvider, useCardInfo } from "../catalog.ts";
import { liveFace } from "../faces.ts";
import { setLanding } from "./landing.ts";
import { DRAG_THRESHOLD_PX, planDrag, resolveDrop, type DragPlan, type DragSource, type DropSpot } from "./model.ts";
import { pickDropSpot, targetFromElement } from "./targets.ts";
import "./drag.css";

export type DragLayerProps = {
  view: PlayerView;
  legal: readonly ActionBody[];
  interaction: Interaction;
  onInteraction: (next: Interaction) => void;
  onAction: (body: ActionBody) => void;
};

type Point = { x: number; y: number };
/** The drop target under the pointer: its centre, its size, and the ring drawn on it. */
type Box = { x: number; y: number; size: number; width: number; height: number };
/**
 * What marks the target an arrow or a card is aimed at: Hearthstone's crosshair "ring" on a hero's
 * gem, a lit "frame" round a card, and a "pad" filling the zone a card being placed lands in.
 */
type ReticleShape = "ring" | "frame" | "pad";
/** Where an arrow over a target stops: the edge of its ring (a circle) or of its frame (a box). */
type ArrowStop = { shape: "circle" | "box"; halfWidth: number; halfHeight: number };

/** A press that has not yet travelled far enough to be a drag. */
type Press = { pointerId: number; start: Point; source: DragSource; element: Element };

/** A drag in flight: everything the overlay draws. */
type Flight = {
  pointerId: number;
  plan: DragPlan;
  element: Element;
  pointer: Point;
  /** The centre of the source element, where the arrow starts. */
  from: Point;
  touch: boolean;
  spot: DropSpot;
  /** Where the reticle sits: the centre of the drop target the pointer is over. */
  reticle: Box | null;
};

/**
 * A card a drop has just played, drawn where it landed until the board shows a newer view than
 * `view` (the one showing when it was dropped).
 */
type Landed = { instanceId: string; card: CardView | null; at: Point; view: PlayerView };

const BOARD = '[data-testid="board"]';
/**
 * The longest a landed card waits for the board to catch up. A drop only ever sends an action the
 * engine listed, so the view always moves on; this only covers a refusal the client cannot see
 * coming (a networked match whose clock ran out as the card was dropped).
 */
const LANDING_TIMEOUT_MS = 4_000;
/** The smallest reticle drawn, so a small target still gets a visible ring (a touch target's size). */
const RETICLE_MIN_PX = 44;
/**
 * A hero's health gem, which its reticle rings; the room the ring leaves round the gem; and the
 * smallest gem ring. It hugs the gem, because a wider ring covered the first letter of the hero's
 * name beside it and the pile count below.
 */
const HERO_GEM = ".hero-health";
const RETICLE_GEM_MARGIN_PX = 10;
const RETICLE_GEM_MIN_PX = 36;
/** How far a card target's frame stands off the card, so it rings the card without covering it. */
const RETICLE_FRAME_OUTSET_PX = 6;
const ARROW_HEAD_PX = 30;
const ARROW_HEAD_HALF_WIDTH_PX = 19;
/** How far the head's back edge is notched in toward its tip, so it reads as an arrowhead. */
const ARROW_HEAD_NOTCH_PX = 9;
/** How far the arrow bows away from a straight line, as a share of its length, and at most. */
const ARROW_BEND_SHARE = 0.22;
const ARROW_BEND_MAX_PX = 90;
/** The glow's blur, and the margin its filter region keeps round the arrow so the blur is not cut. */
const ARROW_GLOW_BLUR_PX = 4;
const ARROW_GLOW_MARGIN_PX = 40;

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

function centreOf(element: Element): Point | null {
  if (!element.isConnected) return null;
  const rect = element.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

function byTestid(id: string): Element | null {
  return document.querySelector(`[data-testid="${id.replace(/["\\]/g, "\\$&")}"]`);
}

/**
 * Where the reticle goes on a drop target. A hero is a wide plate with its name in the middle, so
 * its ring locks onto the health gem, the thing an attack takes from, and the name stays readable.
 * Anything else is ringed at its centre. `width` and `height` are always the whole target's, for
 * the pad a card being placed lights up.
 */
function reticleFor(spot: DropSpot): Box | null {
  if (spot.at !== "target") return null;
  const element = byTestid(spot.testid);
  if (element === null) return null;
  const rect = element.getBoundingClientRect();
  const gem = spot.testid.startsWith("hero-") ? element.querySelector(HERO_GEM) : null;
  const aim = gem === null ? rect : gem.getBoundingClientRect();
  const size =
    gem === null
      ? Math.max(RETICLE_MIN_PX, Math.min(rect.width, rect.height))
      : Math.max(RETICLE_GEM_MIN_PX, Math.max(aim.width, aim.height) + RETICLE_GEM_MARGIN_PX);
  return {
    x: aim.left + aim.width / 2,
    y: aim.top + aim.height / 2,
    size,
    width: rect.width,
    height: rect.height,
  };
}

function isValidSpot(plan: DragPlan, spot: DropSpot): boolean {
  if (spot.at === "target") return true;
  return spot.at === "board" && plan.freeDrop;
}

export default function DragLayer(props: DragLayerProps): ReactElement | null {
  // The listeners are attached once and read the newest props through this ref, so a re-render
  // mid-drag (the lifted interaction arriving back as a prop) never drops the drag.
  const latest = useRef(props);
  latest.current = props;

  const [drawn, setDrawn] = useState<Flight | null>(null);
  const [landed, setLanded] = useState<Landed | null>(null);

  // The landed card goes as soon as the board shows any view newer than the one it was dropped
  // on, or after LANDING_TIMEOUT_MS, and never outlives the layer.
  useEffect(() => {
    if (landed === null) return undefined;
    if (props.view !== landed.view) {
      setLanded(null);
      return undefined;
    }
    const timer = setTimeout(() => setLanded(null), LANDING_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [landed, props.view]);

  // A layout effect, so the card leaves the fan in the same frame the landed copy is drawn.
  useLayoutEffect(() => {
    setLanding(landed === null ? null : landed.instanceId);
  }, [landed]);

  useEffect(() => () => setLanding(null), []);

  useEffect(() => {
    const root = document.documentElement;
    let press: Press | null = null;
    let flight: Flight | null = null;
    /** Armed when a drag ends: the click the release produces is not a second click. */
    let swallowClick = false;

    /** Topmost first. jsdom has no elementsFromPoint, so tests stub it on `document`. */
    function hits(x: number, y: number): readonly Element[] {
      try {
        return document.elementsFromPoint(x, y);
      } catch {
        // jsdom has no elementsFromPoint: nothing is under the pointer.
        return [];
      }
    }

    function spotAt(plan: DragPlan, x: number, y: number): DropSpot {
      return pickDropSpot(hits(x, y), plan.dropTestids);
    }

    function stopDragging(): void {
      const ending = flight;
      flight = null;
      press = null;
      root.removeAttribute("data-dragging");
      if (ending !== null) {
        try {
          if (ending.element.hasPointerCapture(ending.pointerId)) ending.element.releasePointerCapture(ending.pointerId);
        } catch {
          // jsdom has no pointer capture.
        }
      }
      swallowClick = true;
      setDrawn(null);
    }

    /** Back to idle with nothing sent. A press that never became a drag is simply forgotten. */
    function cancel(): void {
      if (flight === null) {
        press = null;
        return;
      }
      stopDragging();
      latest.current.onInteraction(IDLE);
    }

    function onPointerDown(event: PointerEvent): void {
      if (flight !== null) {
        // A second finger while dragging is ignored; the same pointer pressing again means its
        // release was lost somewhere, so the stale drag is dropped.
        if (event.pointerId !== flight.pointerId) return;
        cancel();
      }
      swallowClick = false;
      if (press !== null && press.pointerId !== event.pointerId) return;
      press = null;

      if (event.button !== 0) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest(BOARD) === null) return;
      const hit = targetFromElement(target);
      if (hit === null) return;
      const source = hit.target;
      if (source.on !== "hand" && !(source.on === "unit" && source.side === "you")) return;
      if (!readSettings().dragToPlay) return;

      const element = target.closest(`[data-testid="${hit.testid.replace(/["\\]/g, "\\$&")}"]`) ?? target;
      press = { pointerId: event.pointerId, start: { x: event.clientX, y: event.clientY }, source, element };
      // Never preventDefault: below the threshold this press is a click.
    }

    function onPointerMove(event: PointerEvent): void {
      if (flight !== null) {
        if (event.pointerId !== flight.pointerId) return;
        if (event.button === 2) {
          cancel();
          return;
        }
        const pointer = { x: event.clientX, y: event.clientY };
        const spot = spotAt(flight.plan, pointer.x, pointer.y);
        flight = {
          ...flight,
          pointer,
          from: centreOf(flight.element) ?? flight.from,
          spot,
          reticle: reticleFor(spot),
        };
        setDrawn(flight);
        return;
      }

      if (press === null || event.pointerId !== press.pointerId) return;
      const travelled = Math.hypot(event.clientX - press.start.x, event.clientY - press.start.y);
      if (travelled < DRAG_THRESHOLD_PX) return;

      const { view, legal, interaction, onInteraction } = latest.current;
      const plan = planDrag(view, legal, interaction, press.source);
      const element = press.element;
      const start = press.start;
      press = null;
      // Nothing to drag: the press stays a press, and whatever click follows goes through.
      if (plan === null) return;

      onInteraction(plan.lifted);
      root.setAttribute("data-dragging", plan.kind);
      try {
        element.setPointerCapture(event.pointerId);
      } catch {
        // jsdom has no pointer capture, and a pointer that is already gone cannot be captured.
      }

      const pointer = { x: event.clientX, y: event.clientY };
      const spot = spotAt(plan, pointer.x, pointer.y);
      flight = {
        pointerId: event.pointerId,
        plan,
        element,
        pointer,
        from: centreOf(element) ?? start,
        touch: event.pointerType === "touch",
        spot,
        reticle: reticleFor(spot),
      };
      setDrawn(flight);
    }

    function onPointerUp(event: PointerEvent): void {
      if (flight !== null) {
        if (event.pointerId !== flight.pointerId) return;
        const { view, legal, onInteraction, onAction } = latest.current;
        const spot = spotAt(flight.plan, event.clientX, event.clientY);
        const result = resolveDrop(view, legal, flight.plan, spot);
        const { plan } = flight;
        // Where the card lands: the middle of the zone or target it was dropped on, or the pointer
        // for a drop anywhere on the board.
        const reticle = reticleFor(spot);
        const at = reticle === null ? { x: event.clientX, y: event.clientY } : { x: reticle.x, y: reticle.y };
        stopDragging();
        onInteraction(result.interaction);
        if (result.action !== undefined) {
          if (plan.kind === "play" && plan.source.on === "hand") {
            const instanceId = plan.source.instanceId;
            setLanded({ instanceId, card: handCard(view, instanceId), at, view });
          }
          onAction(result.action);
        }
        return;
      }
      // A press released before the threshold: the click that follows is the player's.
      if (press !== null && event.pointerId === press.pointerId) press = null;
    }

    function onPointerCancel(event: PointerEvent): void {
      if (flight !== null && event.pointerId === flight.pointerId) {
        cancel();
        return;
      }
      if (press !== null && event.pointerId === press.pointerId) press = null;
    }

    function onBlur(): void {
      cancel();
    }

    function onKeyDown(event: KeyboardEvent): void {
      // No click is pending once a key is pressed; a keyboard "click" must never be swallowed.
      swallowClick = false;
      if (event.key !== "Escape") return;
      if (flight !== null) {
        cancel();
        return;
      }
      press = null;
      if (latest.current.interaction.stage !== "idle") latest.current.onInteraction(IDLE);
    }

    function onContextMenu(event: MouseEvent): void {
      if (flight !== null) {
        event.preventDefault();
        cancel();
        return;
      }
      const target = event.target;
      if (!(target instanceof Element) || target.closest(BOARD) === null) return;
      if (latest.current.interaction.stage === "idle") return;
      event.preventDefault();
      press = null;
      latest.current.onInteraction(IDLE);
    }

    function onClickCapture(event: MouseEvent): void {
      if (!swallowClick) return;
      swallowClick = false;
      event.stopPropagation();
      event.preventDefault();
    }

    /**
     * A native HTML5 drag (an image, a link, anything still `draggable`) starting under a press
     * would make the browser send `pointercancel` and kill the pointer drag, so it never starts
     * while this layer is tracking one. The deckbuilder's own drag is outside the board.
     */
    function onDragStart(event: DragEvent): void {
      if (press === null && flight === null) return;
      const target = event.target;
      if (!(target instanceof Element) || target.closest(BOARD) === null) return;
      event.preventDefault();
    }

    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("pointermove", onPointerMove, true);
    window.addEventListener("pointerup", onPointerUp, true);
    window.addEventListener("pointercancel", onPointerCancel, true);
    window.addEventListener("click", onClickCapture, true);
    window.addEventListener("dragstart", onDragStart, true);
    window.addEventListener("blur", onBlur);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("contextmenu", onContextMenu);

    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("pointermove", onPointerMove, true);
      window.removeEventListener("pointerup", onPointerUp, true);
      window.removeEventListener("pointercancel", onPointerCancel, true);
      window.removeEventListener("click", onClickCapture, true);
      window.removeEventListener("dragstart", onDragStart, true);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("contextmenu", onContextMenu);
      if (flight !== null) {
        try {
          if (flight.element.hasPointerCapture(flight.pointerId)) flight.element.releasePointerCapture(flight.pointerId);
        } catch {
          // jsdom has no pointer capture.
        }
      }
      flight = null;
      press = null;
      root.removeAttribute("data-dragging");
    };
  }, []);

  if (drawn === null) {
    if (landed === null) return null;
    return (
      <div className="drag-layer drag-landing" data-testid="drag-landing" aria-hidden="true" style={{ pointerEvents: "none" }}>
        <MatchCardsProvider view={props.view}>
          <DragGhost
            testId="drag-landing-card"
            card={landed.card}
            instanceId={landed.instanceId}
            at={landed.at}
            touch={false}
            valid
            landing
          />
        </MatchCardsProvider>
      </div>
    );
  }

  const { plan, spot } = drawn;
  const valid = isValidSpot(plan, spot);
  // Over a target the arrow locks onto it, as Hearthstone's does: its tip is the reticle's centre,
  // not wherever on the target the pointer happens to be.
  const locked = spot.at === "target" ? drawn.reticle : null;
  const shape: ReticleShape =
    spot.at !== "target" || !plan.arrow ? "pad" : spot.testid.startsWith("card-") ? "frame" : "ring";

  return (
    <div
      className="drag-layer"
      data-testid="drag-layer"
      data-kind={plan.kind}
      aria-hidden="true"
      style={{ pointerEvents: "none" }}
    >
      {plan.arrow ? (
        <DragArrow
          from={drawn.from}
          to={locked === null ? drawn.pointer : { x: locked.x, y: locked.y }}
          sourceTestid={plan.sourceTestid}
          valid={valid}
          // Over a target the reticle is the arrow's tip, as in Hearthstone: the shaft stops at
          // the ring or the frame and no head is drawn on top of it.
          stop={locked === null ? null : arrowStop(locked, shape)}
        />
      ) : (
        <MatchCardsProvider view={props.view}>
          <DragGhost
            card={handCard(props.view, plan.source.instanceId)}
            instanceId={plan.source.instanceId}
            at={drawn.pointer}
            touch={drawn.touch}
            valid={valid}
          />
        </MatchCardsProvider>
      )}
      {spot.at === "target" ? (
        <Reticle testid={spot.testid} box={drawn.reticle} shape={shape} />
      ) : null}
    </div>
  );
}

function arrowStop(box: Box, shape: ReticleShape): ArrowStop {
  return shape === "frame"
    ? {
        shape: "box",
        halfWidth: box.width / 2 + RETICLE_FRAME_OUTSET_PX,
        halfHeight: box.height / 2 + RETICLE_FRAME_OUTSET_PX,
      }
    : { shape: "circle", halfWidth: box.size / 2, halfHeight: box.size / 2 };
}

function handCard(view: PlayerView, instanceId: string): CardView | null {
  const hand = view.you.hand;
  if (!Array.isArray(hand)) return null;
  return hand.find((card) => card.instanceId === instanceId) ?? null;
}

/**
 * The card being placed, following the pointer: a small face (cost, name, rules text and, for a
 * unit, its attack and health), so it reads as that card and not as a face-down one. It is the
 * card in play (faces.ts): a hand Unit's grown stats, a Heroic Power's rolled power, a crafted
 * card's own text. Carries no card testid, so nothing mistakes it for the card.
 */
function DragGhost(props: {
  card: CardView | null;
  instanceId: string;
  at: Point;
  touch: boolean;
  valid: boolean;
  /** The card a drop has played, settled where it landed rather than following the pointer. */
  landing?: boolean;
  testId?: string;
}): ReactElement {
  const info = useCardInfo(props.card?.defId ?? "", props.card?.radiant ?? false);
  const face = props.card === null ? null : liveFace(info, props.card);
  const text = face === null ? info.text : face.text.full;
  const stats = face === null ? (info.attack === undefined || info.health === undefined ? null : { attack: info.attack, health: info.health }) : face.stats;
  const style: CSSProperties = { left: props.at.x, top: props.at.y };
  return (
    <div
      className="drag-ghost"
      data-testid={props.testId ?? "drag-ghost"}
      data-instance-id={props.instanceId}
      data-pointer={props.touch ? "touch" : "mouse"}
      data-valid={props.valid ? "true" : "false"}
      data-landing={props.landing === true ? "true" : undefined}
      data-radiant={props.card?.radiant === true ? "true" : undefined}
      style={style}
    >
      {props.card === null ? null : <span className="drag-ghost-cost">{props.card.cost}</span>}
      <span className="drag-ghost-name">{face?.name ?? info.name}</span>
      {text === "" ? null : <span className="drag-ghost-text">{text}</span>}
      {stats === null ? null : (
        <span className="drag-ghost-stats" aria-hidden="true">
          <span className="drag-ghost-attack">{stats.attack}</span>
          <span className="drag-ghost-health">{stats.health}</span>
        </span>
      )}
    </div>
  );
}

/**
 * Hearthstone's targeting arrow: a bowed, lit shaft from the source's centre to the pointer, and a
 * notched head. The shaft brightens from its tail to its tip, has a pale core and a glow, and a
 * faint pulse runs along it toward the target. `stop` ends it at a reticle's edge instead of the
 * pointer, and then draws no head.
 */
function DragArrow(props: {
  from: Point;
  to: Point;
  sourceTestid: string;
  valid: boolean;
  stop: ArrowStop | null;
}): ReactElement {
  const { from, to } = props;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.hypot(dx, dy) || 1;

  // Bow the shaft upward, whichever way it points.
  const bend = Math.min(ARROW_BEND_MAX_PX, length * ARROW_BEND_SHARE);
  let nx = -dy / length;
  let ny = dx / length;
  if (ny > 0) {
    nx = -nx;
    ny = -ny;
  }
  const cx = (from.x + to.x) / 2 + nx * bend;
  const cy = (from.y + to.y) / 2 + ny * bend;

  // The head points along the curve's tangent at its end: from the control point to the tip.
  const tx = to.x - cx;
  const ty = to.y - cy;
  const tangent = Math.hypot(tx, ty) || 1;
  const ux = tx / tangent;
  const uy = ty / tangent;

  const withHead = props.stop === null;
  const head = Math.min(ARROW_HEAD_PX, length);
  // Where the shaft ends: under the head's notch, or at the reticle's edge.
  const cut =
    props.stop === null ? head - ARROW_HEAD_NOTCH_PX : Math.min(stopDistance(props.stop, ux, uy), length * 0.6);
  const endX = to.x - ux * cut;
  const endY = to.y - uy * cut;

  const baseX = to.x - ux * head;
  const baseY = to.y - uy * head;
  const notchX = to.x - ux * (head - ARROW_HEAD_NOTCH_PX);
  const notchY = to.y - uy * (head - ARROW_HEAD_NOTCH_PX);
  const leftX = baseX - uy * ARROW_HEAD_HALF_WIDTH_PX;
  const leftY = baseY + ux * ARROW_HEAD_HALF_WIDTH_PX;
  const rightX = baseX + uy * ARROW_HEAD_HALF_WIDTH_PX;
  const rightY = baseY - ux * ARROW_HEAD_HALF_WIDTH_PX;

  const shaft = `M ${round(from.x)} ${round(from.y)} Q ${round(cx)} ${round(cy)} ${round(endX)} ${round(endY)}`;
  const tip = [
    `${round(to.x)},${round(to.y)}`,
    `${round(leftX)},${round(leftY)}`,
    `${round(notchX)},${round(notchY)}`,
    `${round(rightX)},${round(rightY)}`,
  ].join(" ");

  // The glow's filter region, in screen space round the whole arrow: a region sized off the
  // arrow's own box would collapse to nothing for a straight vertical or horizontal arrow.
  const glowX = Math.min(from.x, to.x, cx) - ARROW_GLOW_MARGIN_PX;
  const glowY = Math.min(from.y, to.y, cy) - ARROW_GLOW_MARGIN_PX;
  const glowW = Math.max(from.x, to.x, cx) + ARROW_GLOW_MARGIN_PX - glowX;
  const glowH = Math.max(from.y, to.y, cy) + ARROW_GLOW_MARGIN_PX - glowY;

  return (
    <svg
      className="drag-arrow"
      data-testid="drag-arrow"
      data-from={props.sourceTestid}
      data-valid={props.valid ? "true" : "false"}
      width="100%"
      height="100%"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        {/* Along the arrow in screen space: dim at the source, full at the tip. */}
        <linearGradient
          id="drag-arrow-fade"
          gradientUnits="userSpaceOnUse"
          x1={round(from.x)}
          y1={round(from.y)}
          x2={round(to.x)}
          y2={round(to.y)}
        >
          <stop offset="0" className="drag-arrow-stop-tail" />
          <stop offset="1" className="drag-arrow-stop-tip" />
        </linearGradient>
        <filter
          id="drag-arrow-glow"
          filterUnits="userSpaceOnUse"
          x={round(glowX)}
          y={round(glowY)}
          width={round(glowW)}
          height={round(glowH)}
        >
          <feGaussianBlur in="SourceGraphic" stdDeviation={ARROW_GLOW_BLUR_PX} result="glow" />
          <feMerge>
            <feMergeNode in="glow" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      <path className="drag-arrow-shadow" d={shaft} />
      <g className="drag-arrow-lit" filter="url(#drag-arrow-glow)">
        <path className="drag-arrow-shaft" d={shaft} />
        <path className="drag-arrow-core" d={shaft} />
        <path className="drag-arrow-pulse" d={shaft} />
        {withHead ? <polygon className="drag-arrow-head" points={tip} /> : null}
      </g>
      <circle className="drag-arrow-origin" cx={round(from.x)} cy={round(from.y)} r={7} />
    </svg>
  );
}

/** How far back from the target's centre, along the arrow's final direction, its reticle's edge is. */
function stopDistance(stop: ArrowStop, ux: number, uy: number): number {
  if (stop.shape === "circle") return stop.halfWidth;
  const alongX = Math.abs(ux) < 1e-6 ? Infinity : stop.halfWidth / Math.abs(ux);
  const alongY = Math.abs(uy) < 1e-6 ? Infinity : stop.halfHeight / Math.abs(uy);
  return Math.min(alongX, alongY);
}

/**
 * What marks the drop target the pointer is on. A "ring" is Hearthstone's crosshair on a hero's
 * health gem. A "frame" rings a card an arrow is aimed at, standing just off it, so the card's name
 * and its attack and health stay readable: a crosshair the card's size covered both. A "pad" lights
 * the whole zone a card being placed will land in, so the spot under the card still reads while
 * the card covers its middle.
 */
function Reticle(props: { testid: string; box: Box | null; shape: ReticleShape }): ReactElement {
  const { box } = props;
  const style: CSSProperties =
    box === null
      ? { display: "none" }
      : props.shape === "ring"
        ? { left: box.x, top: box.y, width: box.size, height: box.size }
        : props.shape === "frame"
          ? {
              left: box.x,
              top: box.y,
              width: box.width + 2 * RETICLE_FRAME_OUTSET_PX,
              height: box.height + 2 * RETICLE_FRAME_OUTSET_PX,
            }
          : { left: box.x, top: box.y, width: box.width, height: box.height };
  return (
    <div
      className="drag-reticle"
      data-testid="drag-reticle"
      data-target={props.testid}
      data-shape={props.shape}
      style={style}
    />
  );
}
