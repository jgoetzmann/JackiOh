// The enlarged card a resting mouse or pen pointer opens (B22): the live face at
// PREVIEW_HEIGHT_PX with its glossary beside it, fixed beside the anchor card. It never takes
// pointer events and is hidden from assistive tech, so it can never cover what a click aims at.
// A face in play whose printed text differs (SPEC §10.10) has that text above its glossary, and a
// face whose text names other cards has their faces there too (References.tsx, R279), since a
// reference inside a preview that takes no pointer events cannot be hovered itself.

import { useLayoutEffect, useRef } from "react";
import type { ReactElement } from "react";
import { createPortal } from "react-dom";
import { CardFace } from "../CardFace.tsx";
import { FACE_ASPECT } from "../constants.ts";
import type { FaceModel } from "../model.ts";
import { glossaryFor } from "../rules.ts";
import {
  PREVIEW_GLOSSARY_GAP_PX,
  PREVIEW_GLOSSARY_WIDTH_PX,
  PREVIEW_HEIGHT_PX,
  PREVIEW_MAX_VIEWPORT_SHARE,
} from "./constants.ts";
import { Glossary } from "./Glossary.tsx";
import { placePreview, type PreviewPrefer, type Rect } from "./placement.ts";
import { Printed } from "./Printed.tsx";
import { namedCards, References } from "./References.tsx";
import { useDefResolver } from "../refContext.tsx";
import { OVERLAY_ROOT_PROPS } from "./store.ts";
import { INSPECT_FACE, INSPECT_HOVER } from "./testids.ts";
import "./inspect.css";

type HoverPreviewProps = { face: FaceModel; anchor: Rect; prefer?: PreviewPrefer };

function viewportSize(): { width: number; height: number } {
  return { width: window.innerWidth, height: window.innerHeight };
}

/** The preview's size before it has been laid out, from the same numbers inspect.css uses. */
function estimatedSize(withGlossary: boolean): { width: number; height: number } {
  const height = Math.min(PREVIEW_HEIGHT_PX, window.innerHeight * PREVIEW_MAX_VIEWPORT_SHARE);
  const cardWidth = height * FACE_ASPECT;
  const width = withGlossary ? cardWidth + PREVIEW_GLOSSARY_GAP_PX + PREVIEW_GLOSSARY_WIDTH_PX : cardWidth;
  return { width, height };
}

export function HoverPreview({ face, anchor, prefer = "beside" }: HoverPreviewProps): ReactElement {
  const ref = useRef<HTMLDivElement>(null);
  const entries = glossaryFor(face);
  const resolve = useDefResolver();
  const named = resolve === null ? 0 : namedCards(face, resolve).length;
  const side = entries.length > 0 || face.printed !== null || named > 0;
  const placed = placePreview(anchor, viewportSize(), estimatedSize(side), prefer);

  // Once laid out, place it again by its real size. jsdom has no layout and keeps the estimate.
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return;
    const width = element.offsetWidth;
    const height = element.offsetHeight;
    if (width === 0 || height === 0) return;
    const measured = placePreview(anchor, viewportSize(), { width, height }, prefer);
    element.style.left = `${measured.left}px`;
    element.style.top = `${measured.top}px`;
    element.dataset.side = measured.side;
  });

  return createPortal(
    <div
      ref={ref}
      className="inspect-hover"
      data-testid={INSPECT_HOVER}
      data-side={placed.side}
      aria-hidden="true"
      style={{ position: "fixed", left: placed.left, top: placed.top, pointerEvents: "none" }}
      {...OVERLAY_ROOT_PROPS}
    >
      <div className="inspect-face" data-testid={INSPECT_FACE} style={{ height: PREVIEW_HEIGHT_PX }}>
        <CardFace face={face} layout="full" />
      </div>
      {face.printed === null && named === 0 ? (
        <Glossary entries={entries} />
      ) : (
        <div className="inspect-side">
          <Printed face={face} />
          <References face={face} />
          <Glossary entries={entries} />
        </div>
      )}
    </div>,
    document.body,
  );
}
