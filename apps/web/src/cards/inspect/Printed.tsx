// The card as printed, beside a face in play that prints something else (SPEC §10.10): a #98
// Heroic Power's seven powers beside the one it rolled, a Vanilla unit's lost text. The collection
// prints every card this way; in play the hover preview and the sheet show it only where the face
// and the print differ (FaceModel.printed), and never for a card play keeps a mystery ("???"). A
// Radiant card's printed text is marked as its face is (R277), and names its references (R279).

import type { ReactElement } from "react";
import type { FaceModel } from "../model.ts";
import { RulesText } from "../RulesText.tsx";
import { INSPECT_PRINTED } from "./testids.ts";

export function Printed({ face }: { face: FaceModel }): ReactElement | null {
  const printed = face.printed;
  if (printed === null) return null;
  return (
    <div className="inspect-printed" data-testid={INSPECT_PRINTED}>
      <p className="inspect-printed-label">Printed</p>
      <p className="inspect-printed-text">
        <RulesText text={printed.full} marks={printed.marks} refs={face.refs} />
      </p>
    </div>
  );
}
