// The card as printed, beside a face in play that prints something else (SPEC §10.10): a #98
// Heroic Power's seven powers beside the one it rolled, a Vanilla unit's lost text. The collection
// prints every card this way; in play the hover preview and the sheet show it only where the face
// and the print differ (FaceModel.printed), and never for a card play keeps a mystery ("???").

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
        <RulesText text={printed.base} />
      </p>
      {printed.radiant === null ? null : (
        <p className="inspect-printed-text inspect-printed-text--radiant">
          <RulesText text={printed.radiant} />
        </p>
      )}
    </div>
  );
}
