// A name in a card's text that points at another card (SPEC §10.10, R279).
//
// Every such name is marked (`.cf-ref`, a dotted underline), and carries the id and face it points
// at (`data-ref`, `data-ref-face`). Where the surface makes references controls (`RefsInteractive`:
// the collection's detail view, the touch inspect sheet), it is also focusable, and it shows the
// named card's printed face in a tooltip beside it: after a mouse or pen rests on it for
// REF_HOVER_DELAY_MS, at once when the keyboard focuses it, and on a tap or a press on a touch
// screen. The tooltip is a portal at the end of <body> with `role="tooltip"`, and the reference is
// `aria-describedby` it while it is open. Leaving, blurring, Escape, or tapping again closes it.
//
// Elsewhere — a face inside a button, the hover preview, a small board face — the mark is all it
// is, and the hover preview lists the named cards beside the face instead (References.tsx).
// Presentation only: the tooltip shows a printed catalog face, public by §5.1 (CLAUDE.md rule 7).

import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";

import type { CardDef } from "@jackioh/shared";

import { CardFace } from "./CardFace.tsx";
import { FACE_ASPECT, REF_HOVER_DELAY_MS, REF_TOOLTIP_HEIGHT_PX } from "./constants.ts";
import { placePreview, type Rect } from "./inspect/placement.ts";
import { faceModel } from "./model.ts";
import { RefsInteractive, useRefsInteractive } from "./refContext.tsx";

export type CardRefProps = { def: CardDef; radiant: boolean; children: ReactNode };

/** A test id for the tooltip a reference opens, by the id it names. */
export const REF_TOOLTIP_TESTID = "card-ref-tooltip";

type Timer = ReturnType<typeof setTimeout>;

function rectOf(element: Element): Rect {
  const box = element.getBoundingClientRect();
  return { left: box.left, top: box.top, width: box.width, height: box.height };
}

function RefTooltip({ id, def, radiant, anchor }: { id: string; def: CardDef; radiant: boolean; anchor: Rect }): ReactElement {
  const height = Math.min(REF_TOOLTIP_HEIGHT_PX, window.innerHeight);
  const size = { width: height * FACE_ASPECT, height };
  const placed = placePreview(anchor, { width: window.innerWidth, height: window.innerHeight }, size, "above");
  const face = faceModel({ defId: def.id, def, radiant });
  return createPortal(
    <div
      id={id}
      role="tooltip"
      className="cf-ref-tooltip"
      data-testid={REF_TOOLTIP_TESTID}
      data-ref={def.id}
      data-ref-face={radiant ? "radiant" : "base"}
      style={{ position: "fixed", left: placed.left, top: placed.top, width: size.width, height: size.height }}
    >
      {/* The face in a tooltip marks its own references and opens none: one level is enough. */}
      <RefsInteractive enabled={false}>
        <CardFace face={face} layout="full" />
      </RefsInteractive>
    </div>,
    document.body,
  );
}

export function CardRef({ def, radiant, children }: CardRefProps): ReactElement {
  const interactive = useRefsInteractive();
  const tooltipId = useId();
  const ref = useRef<HTMLSpanElement>(null);
  const timer = useRef<Timer | null>(null);
  const [anchor, setAnchor] = useState<Rect | null>(null);

  const clearTimer = (): void => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };
  const open = (): void => {
    const element = ref.current;
    if (element !== null && element.isConnected) setAnchor(rectOf(element));
  };
  const close = (): void => {
    clearTimer();
    setAnchor(null);
  };

  useEffect(() => clearTimer, []);

  // While open: Escape, a scroll or a resize closes it, since its anchor would have moved.
  useLayoutEffect(() => {
    if (anchor === null) return undefined;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") close();
    };
    const onMove = (): void => close();
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [anchor]);

  const common = {
    ref,
    className: "cf-ref",
    "data-ref": def.id,
    "data-ref-face": radiant ? "radiant" : "base",
  } as const;

  if (!interactive) return <span {...common}>{children}</span>;

  return (
    <>
      <span
        {...common}
        data-ref-open={anchor === null ? undefined : "true"}
        tabIndex={0}
        aria-describedby={anchor === null ? undefined : tooltipId}
        onPointerEnter={(event) => {
          if (event.pointerType === "touch") return;
          clearTimer();
          timer.current = setTimeout(open, REF_HOVER_DELAY_MS);
        }}
        onPointerLeave={(event) => {
          if (event.pointerType === "touch") return;
          close();
        }}
        onFocus={open}
        onBlur={close}
        onClick={(event) => {
          // A tap (or a click with no hover first) opens it; a second one closes it. The click
          // never reaches a card underneath, which would otherwise take it as a pick.
          event.stopPropagation();
          if (anchor === null) open();
          else close();
        }}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          if (anchor === null) open();
          else close();
        }}
      >
        {children}
      </span>
      {anchor === null ? null : <RefTooltip id={tooltipId} def={def} radiant={radiant} anchor={anchor} />}
    </>
  );
}
