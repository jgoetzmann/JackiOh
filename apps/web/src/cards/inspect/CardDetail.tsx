// The deck builder's detail view (B29): both printed faces side by side at every width, a meta
// line, the glossary of both faces, and the caller's meta and actions above Close. It is a centred
// modal dialog over a scrim, closed by Close, the scrim or Escape (B25), and it takes the one
// inspect slot: opening it closes any hover preview or sheet, and closeInspect() closes it.
//
// Under the faces, the rules text is printed again at reading size. Two faces side by side on a
// 390 px phone are about 170 px wide each, where a 400-character card prints at 5 px; inspect.css
// shows this block on narrow screens and short ones, and on any screen for a card long enough to
// shrink hard. On a wide screen up to 900 px tall (a 1280x720 desktop, a phone on its side) the
// faces stand at the height the screen allows, with the rest of the dialog in a column beside
// them. The actions row (the caller's actions and Close) is pinned under the scrolling body, so it
// is visible the moment the dialog opens, which is also where focus lands.

import { useLayoutEffect, useRef } from "react";
import type { ReactElement, ReactNode } from "react";
import { createPortal } from "react-dom";
import type { CardDef } from "@jackioh/shared";
import { CardFace } from "../CardFace.tsx";
import { textTier } from "../fit.ts";
import { faceModel, type FaceModel } from "../model.ts";
import { glossaryFor } from "../rules.ts";
import { RulesText } from "../RulesText.tsx";
import { Glossary, mergeGlossary } from "./Glossary.tsx";
import { closeInspect, OVERLAY_ROOT_PROPS, registerDetail, useModalOverlay } from "./store.ts";
import {
  INSPECT_CLOSE,
  INSPECT_DETAIL,
  INSPECT_FACE_BASE,
  INSPECT_FACE_RADIANT,
  INSPECT_SCRIM,
} from "./testids.ts";
import "./inspect.css";

export type CardDetailProps = { def: CardDef; onClose: () => void; actions?: ReactNode; meta?: ReactNode };

/** `#<index> · <set> · <rarity> · <type>`, then ` · <tags>` when there are any. */
function detailMetaLine(def: CardDef): string {
  const parts = [`#${def.index}`, def.set, def.rarity, def.type];
  if (def.tags.length > 0) parts.push(def.tags.join(", "));
  return parts.join(" · ");
}

/** Text tiers whose printed face shrinks far enough to want the reading-size copy on any screen. */
const LONG_TEXT_TIERS: ReadonlySet<string> = new Set(["xl", "xxl"]);

function printed(face: FaceModel): string {
  return face.text.radiant === null ? face.text.base : `${face.text.base} ${face.text.radiant}`;
}

/**
 * The radiant line says what the radiant face prints that the base face does not. When the radiant
 * face keeps the base text whole it is only the new clause ("Radiant: 7 coins; +2 per heads …");
 * when it has dropped or replaced part of it (a new keyword line, a restated Cry) it is the radiant
 * face's whole text, with the changed part marked as on the face.
 */
function radiantLineOf(base: FaceModel, radiant: FaceModel): ReactElement | null {
  const kept = radiant.text.base === base.text.base ? "" : radiant.text.base;
  if (kept === "" && radiant.text.radiant === null) return null;
  return (
    <>
      {kept === "" ? null : <RulesText text={kept} />}
      {kept === "" || radiant.text.radiant === null ? null : " "}
      {radiant.text.radiant === null ? null : (
        <span className="inspect-rules-changed">
          <RulesText text={radiant.text.radiant} />
        </span>
      )}
    </>
  );
}

function DetailRules({ base, radiant }: { base: FaceModel; radiant: FaceModel }): ReactElement | null {
  const radiantLine = radiantLineOf(base, radiant);
  if (base.text.base === "" && radiantLine === null) return null;
  const long = LONG_TEXT_TIERS.has(textTier(printed(base))) || LONG_TEXT_TIERS.has(textTier(printed(radiant)));
  return (
    <div className="inspect-rules" data-long={long ? "true" : "false"}>
      {base.text.base === "" ? null : (
        <p className="inspect-rules-line">
          <span className="inspect-rules-label">Base</span>
          <span className="inspect-rules-text">
            <RulesText text={base.text.base} />
          </span>
        </p>
      )}
      {radiantLine === null ? null : (
        <p className="inspect-rules-line inspect-rules-line--radiant">
          <span className="inspect-rules-label">Radiant</span>
          <span className="inspect-rules-text">{radiantLine}</span>
        </p>
      )}
    </div>
  );
}

export function CardDetail({ def, onClose, actions, meta }: CardDetailProps): ReactElement {
  const closeButton = useRef<HTMLButtonElement>(null);
  const modal = useModalOverlay(onClose, closeButton);
  const onCloseRef = useRef(onClose);

  useLayoutEffect(() => {
    onCloseRef.current = onClose;
  });

  // Take the inspect slot: close what is open, then let closeInspect() reach this dialog.
  useLayoutEffect(() => {
    closeInspect();
    return registerDetail(`inspect-detail:${def.id}`, () => onCloseRef.current());
  }, [def.id]);

  const base = faceModel({ defId: def.id, def, radiant: false });
  const radiant = faceModel({ defId: def.id, def, radiant: true });
  const glossary = mergeGlossary(glossaryFor(base), glossaryFor(radiant));

  return createPortal(
    <div className="inspect-layer inspect-layer--detail" {...OVERLAY_ROOT_PROPS}>
      <div className="inspect-scrim" data-testid={INSPECT_SCRIM} aria-hidden="true" {...modal.dismissProps} />
      <div
        className="inspect-detail"
        data-testid={INSPECT_DETAIL}
        data-card={def.id}
        role="dialog"
        aria-modal="true"
        aria-label={def.name}
      >
        {/* The faces and everything about them scroll; the actions row is pinned under them, so
            Add and Close are on screen as the dialog opens, whatever the card's length. */}
        <div className="inspect-detail-body">
          <div className="inspect-detail-faces">
            <figure className="inspect-detail-face">
              <div className="inspect-face inspect-face--detail" data-testid={INSPECT_FACE_BASE}>
                <CardFace face={base} layout="full" />
              </div>
              <figcaption className="inspect-detail-caption">Base</figcaption>
            </figure>
            <figure className="inspect-detail-face inspect-detail-face--radiant">
              <div className="inspect-face inspect-face--detail" data-testid={INSPECT_FACE_RADIANT}>
                <CardFace face={radiant} layout="full" />
              </div>
              <figcaption className="inspect-detail-caption">Radiant</figcaption>
            </figure>
          </div>
          {/* Everything but the faces, as one column: under the faces on a tall screen, beside
              them on a wide, short one such as a 1280x720 desktop (inspect.css). */}
          <div className="inspect-detail-info">
            <p className="inspect-meta">{detailMetaLine(def)}</p>
            <DetailRules base={base} radiant={radiant} />
            <Glossary entries={glossary} />
            {meta === undefined || meta === null ? null : <div className="inspect-detail-meta">{meta}</div>}
          </div>
        </div>
        <div className="inspect-actions">
          {actions}
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
      </div>
    </div>,
    document.body,
  );
}
