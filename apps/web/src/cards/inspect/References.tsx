// The cards a face's text names, in a column beside it in the hover preview (SPEC §10.10, R279).
//
// The hover preview takes no pointer events and is hidden from assistive tech (B22), so a reference
// inside its face cannot be hovered or focused: the names are marked there, and this column shows
// each card they name, as a small printed face, so resting on any card on the board or in the
// collection shows what it refers to. A name the text calls Radiant shows the Radiant face.
// Presentation only: printed catalog faces (§5.1).

import type { ReactElement } from "react";

import type { CardDef } from "@jackioh/shared";

import { CardFace } from "../CardFace.tsx";
import { FACE_ASPECT, REF_PANEL_FACE_HEIGHT_PX } from "../constants.ts";
import { faceModel, type FaceModel } from "../model.ts";
import { RefsInteractive, useDefResolver } from "../refContext.tsx";
import { findRefs } from "../refs.ts";
import { INSPECT_REFS } from "./testids.ts";

/** The named cards of a face, in the order its text first names them, each once per face. */
export function namedCards(face: FaceModel, resolve: (id: string) => CardDef | undefined): { def: CardDef; radiant: boolean }[] {
  const defs = face.refs.flatMap((id) => resolve(id) ?? []);
  const seen = new Set<string>();
  const out: { def: CardDef; radiant: boolean }[] = [];
  for (const match of findRefs(face.text.full, defs)) {
    const key = `${match.id}:${String(match.radiant)}`;
    const def = defs.find((candidate) => candidate.id === match.id);
    if (def === undefined || seen.has(key)) continue;
    seen.add(key);
    out.push({ def, radiant: match.radiant });
  }
  return out;
}

export function References({ face }: { face: FaceModel }): ReactElement | null {
  const resolve = useDefResolver();
  if (resolve === null) return null;
  const named = namedCards(face, resolve);
  if (named.length === 0) return null;
  const width = REF_PANEL_FACE_HEIGHT_PX * FACE_ASPECT;
  return (
    <div className="inspect-refs" data-testid={INSPECT_REFS}>
      <p className="inspect-refs-label">Mentions</p>
      <div className="inspect-refs-faces">
        <RefsInteractive enabled={false}>
          {named.map(({ def, radiant }) => (
            <div
              key={`${def.id}:${String(radiant)}`}
              className="inspect-refs-face"
              data-ref={def.id}
              data-ref-face={radiant ? "radiant" : "base"}
              style={{ width, height: REF_PANEL_FACE_HEIGHT_PX }}
            >
              <CardFace face={faceModel({ defId: def.id, def, radiant })} layout="full" />
            </div>
          ))}
        </RefsInteractive>
      </div>
    </div>
  );
}
