// The bottom sheet a touch long-press opens (B24, B25): the live face, its glossary and Close, over
// a scrim. Focus moves to Close on open and back on close; Escape, the scrim and Close all close it.

import { useRef } from "react";
import type { ReactElement } from "react";
import { createPortal } from "react-dom";
import { CardFace } from "../CardFace.tsx";
import type { FaceModel } from "../model.ts";
import { glossaryFor } from "../rules.ts";
import { Glossary } from "./Glossary.tsx";
import { OVERLAY_ROOT_PROPS, useModalOverlay } from "./store.ts";
import { INSPECT_CLOSE, INSPECT_FACE, INSPECT_SCRIM, INSPECT_SHEET } from "./testids.ts";
import "./inspect.css";

type InspectSheetProps = { face: FaceModel; onClose: () => void };

export function InspectSheet({ face, onClose }: InspectSheetProps): ReactElement {
  const closeButton = useRef<HTMLButtonElement>(null);
  const modal = useModalOverlay(onClose, closeButton);

  return createPortal(
    <div className="inspect-layer inspect-layer--sheet" {...OVERLAY_ROOT_PROPS}>
      <div className="inspect-scrim" data-testid={INSPECT_SCRIM} aria-hidden="true" {...modal.dismissProps} />
      <div
        className="inspect-sheet"
        data-testid={INSPECT_SHEET}
        role="dialog"
        aria-modal="true"
        aria-label={face.name}
      >
        <span className="inspect-grip" aria-hidden="true" />
        <div className="inspect-sheet-body">
          <div className="inspect-face inspect-face--sheet" data-testid={INSPECT_FACE}>
            <CardFace face={face} layout="full" />
          </div>
          <Glossary entries={glossaryFor(face)} />
        </div>
        <button
          ref={closeButton}
          type="button"
          className="inspect-close"
          data-testid={INSPECT_CLOSE}
          {...modal.dismissProps}
        >
          Close
        </button>
      </div>
    </div>,
    document.body,
  );
}
