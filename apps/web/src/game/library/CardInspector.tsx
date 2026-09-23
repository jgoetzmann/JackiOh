// The library's full-screen card inspector (BUILD M9-T2).
//
// The card is a 3D object with the base face in front and the Radiant face (§5.2) on the back, or
// a card back when the card has no radiant form. All of its motion is one inline `transform` on
// INSPECTOR_CARD — perspective, the two rotations, the zoom — so a test can read what a drag did.
// Idle pointer movement tilts it toward the cursor; a drag turns it freely (Y unbounded, X
// clamped), and on release it settles on the nearest face, a multiple of 180° on Y. The settle is
// CSS's transition, not a JS loop; under `prefers-reduced-motion` there is no idle tilt and no
// transition, so a flip is instant (BUILD M5-T4's rule, read the way `animations.ts` reads it).

import { useEffect, useId, useRef, useState, type CSSProperties, type PointerEvent, type ReactElement } from "react";

import type { CardDef } from "@jackioh/shared";

import { prefersReducedMotion } from "../animations.ts";
import CardFace, { hasRadiantForm } from "./CardFace.tsx";
import { CARD_ASPECT } from "./library.ts";
import { INSPECTOR, INSPECTOR_CARD, INSPECTOR_CLOSE, INSPECTOR_FLIP, INSPECTOR_TOGGLE } from "./testids.ts";

const PERSPECTIVE_PX = 1400;
/** How far the idle tilt leans toward the cursor. */
const TILT_DEG = 10;
const DRAG_DEG_PER_PX = 0.45;
/** Past this the card would show its edge; Y has no limit. */
const MAX_X_DEG = 40;
const ZOOM = { min: 0.6, max: 1.8, perWheelPixel: 0.0015 } as const;

type Angles = { x: number; y: number };
const LEVEL: Angles = { x: 0, y: 0 };

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** The face a Y rotation is closest to showing. */
function nearestFace(y: number): number {
  return Math.round(y / 180) * 180;
}

function showsBack(y: number): boolean {
  const turned = ((y % 360) + 360) % 360;
  return turned > 90 && turned < 270;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export type CardInspectorProps = {
  def: CardDef;
  /** What the Add/Remove button does for this card; null when it can do neither. */
  toggle: "add" | "remove" | null;
  onToggle: () => void;
  onClose: () => void;
};

export default function CardInspector({ def, toggle, onToggle, onClose }: CardInspectorProps): ReactElement {
  const [reducedMotion] = useState(prefersReducedMotion);
  const [turn, setTurn] = useState<Angles>(LEVEL);
  const [tilt, setTilt] = useState<Angles>(LEVEL);
  const [zoom, setZoom] = useState(1);
  const [glare, setGlare] = useState({ x: 50, y: 50 });
  const [dragging, setDragging] = useState(false);
  const drag = useRef<{ pointerId: number; x: number; y: number; from: Angles } | null>(null);
  /** A click closes only if it also began on the backdrop, so a drag released there does not. */
  const downOnBackdrop = useRef(false);
  const stage = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const titleId = useId();

  // Focus moves in on open and back to whatever opened the inspector on close.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeButton.current?.focus();
    return () => {
      if (opener?.isConnected === true) opener.focus();
    };
  }, []);

  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  // React's `onWheel` is passive, and a passive listener cannot stop the page behind from scrolling.
  useEffect(() => {
    const node = stage.current;
    if (node === null) return;
    function onWheel(event: WheelEvent): void {
      event.preventDefault();
      setZoom((z) => clamp(z * Math.exp(-event.deltaY * ZOOM.perWheelPixel), ZOOM.min, ZOOM.max));
    }
    node.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      node.removeEventListener("wheel", onWheel);
    };
  }, []);

  // A capture still held at unmount (Esc mid-drag) is released rather than left to the browser.
  useEffect(() => {
    const node = card.current;
    return () => {
      const held = drag.current;
      if (node !== null && held !== null && node.hasPointerCapture?.(held.pointerId) === true) {
        node.releasePointerCapture(held.pointerId);
      }
    };
  }, []);

  function onPointerDown(event: PointerEvent<HTMLDivElement>): void {
    if (event.button !== 0) return;
    drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, from: turn };
    // jsdom has no pointer capture; the stage's handlers still see the bubbled events.
    event.currentTarget.setPointerCapture?.(event.pointerId);
    setDragging(true);
    setTilt(LEVEL);
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>): void {
    const rect = card.current?.getBoundingClientRect();
    if (rect !== undefined && rect.width > 0 && rect.height > 0) {
      setGlare({
        x: round(clamp(((event.clientX - rect.left) / rect.width) * 100, 0, 100)),
        y: round(clamp(((event.clientY - rect.top) / rect.height) * 100, 0, 100)),
      });
    }
    const held = drag.current;
    if (held !== null) {
      if (held.pointerId !== event.pointerId) return;
      setTurn({
        x: clamp(held.from.x - (event.clientY - held.y) * DRAG_DEG_PER_PX, -MAX_X_DEG, MAX_X_DEG),
        y: held.from.y + (event.clientX - held.x) * DRAG_DEG_PER_PX,
      });
      return;
    }
    if (reducedMotion || rect === undefined || rect.width === 0 || rect.height === 0) return;
    // The card's front turns to face the cursor: +rotateY faces right, -rotateX faces down.
    const across = clamp((event.clientX - (rect.left + rect.width / 2)) / (rect.width / 2), -1, 1);
    const down = clamp((event.clientY - (rect.top + rect.height / 2)) / (rect.height / 2), -1, 1);
    setTilt({ x: round(-down * TILT_DEG), y: round(across * TILT_DEG) });
  }

  function onPointerUp(event: PointerEvent<HTMLDivElement>): void {
    const held = drag.current;
    if (held === null || held.pointerId !== event.pointerId) return;
    drag.current = null;
    if (card.current?.hasPointerCapture?.(held.pointerId) === true) {
      card.current.releasePointerCapture(held.pointerId);
    }
    setDragging(false);
    setTurn((t) => ({ x: 0, y: nearestFace(t.y) }));
  }

  const x = turn.x + tilt.x;
  const y = turn.y + tilt.y;
  const style = {
    transform: `perspective(${String(PERSPECTIVE_PX)}px) rotateX(${String(round(x))}deg) rotateY(${String(round(y))}deg) scale(${String(round(zoom))})`,
    transition: dragging || reducedMotion ? "none" : undefined,
    "--glare-x": `${String(glare.x)}%`,
    "--glare-y": `${String(glare.y)}%`,
  } as CSSProperties;

  return (
    <div
      ref={stage}
      className="insp"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      data-testid={INSPECTOR}
      style={{ "--card-aspect": CARD_ASPECT } as CSSProperties}
      onPointerDown={(event) => {
        downOnBackdrop.current = event.target === event.currentTarget;
      }}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onPointerLeave={() => {
        if (drag.current === null) setTilt(LEVEL);
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget && downOnBackdrop.current) onClose();
        downOnBackdrop.current = false;
      }}
    >
      <div className="insp-bar">
        <h2 id={titleId}>{def.name}</h2>
        <button
          type="button"
          data-testid={INSPECTOR_FLIP}
          onClick={() => {
            setTurn((t) => ({ x: 0, y: nearestFace(t.y) + 180 }));
          }}
        >
          Flip
        </button>
        <button
          type="button"
          className="button-primary"
          data-testid={INSPECTOR_TOGGLE}
          data-action={toggle ?? undefined}
          disabled={toggle === null}
          onClick={onToggle}
        >
          {toggle === "remove" ? "Remove from deck" : "Add to deck"}
        </button>
        <button type="button" ref={closeButton} data-testid={INSPECTOR_CLOSE} aria-label="Close" onClick={onClose}>
          ×
        </button>
      </div>

      <div
        ref={card}
        className="insp-card"
        data-testid={INSPECTOR_CARD}
        data-face={showsBack(y) ? "back" : "front"}
        style={style}
        onPointerDown={onPointerDown}
      >
        <div className="insp-face">
          <CardFace def={def} />
          <div className="insp-glare" />
        </div>
        <div className="insp-face insp-face--back">
          {hasRadiantForm(def) ? (
            <CardFace def={def} radiant />
          ) : (
            <div className="cf-back" style={{ aspectRatio: CARD_ASPECT }}>
              <span>JackiOh</span>
              <small>No Radiant form</small>
            </div>
          )}
          <div className="insp-glare" />
        </div>
      </div>

      <p className="insp-hint">Drag to turn · scroll to zoom · Esc to close</p>
    </div>
  );
}
