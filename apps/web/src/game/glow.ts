// The two glows as DOM attributes (docs/polish/7-mobile-ux.md S5, S6).
//
// Green is `data-glow="ready"`: the element's testid is in `Highlight.glow`, which `highlightFor`
// derived from `legalActions` alone. Yellow is `data-condition-active="true"`: the engine put
// `conditionActive: true` on the card's view (R195, CLAUDE.md rule 7). Neither is decided here;
// these helpers only turn a set membership or a view flag into an attribute value, and return
// `undefined` so React omits the attribute rather than writing "false". `highlights.css` paints
// them.

import type { CardView } from "@jackioh/shared";

import { testid, type Highlight } from "./contract.ts";

export type GlowAttr = "ready";

/** `data-glow`: "ready" when `testId` is in `highlight.glow`; undefined (attribute omitted) otherwise. */
export function glowAttr(highlight: Highlight | undefined, testId: string | undefined): GlowAttr | undefined {
  if (highlight === undefined || testId === undefined) return undefined;
  return highlight.glow?.has(testId) === true ? "ready" : undefined;
}

/** `data-condition-active`: "true" when the view says so; undefined otherwise. */
export function conditionAttr(card: Pick<CardView, "conditionActive"> | null | undefined): "true" | undefined {
  return card?.conditionActive === true ? "true" : undefined;
}

/** True when `glow` holds a playable card, an attacker or the power: any testid starting `hand-card-` or `card-`, or `power`. */
export function hasMovesLeft(highlight: Highlight | undefined): boolean {
  const glow = highlight?.glow;
  if (glow === undefined) return false;
  for (const id of glow) {
    if (id.startsWith("hand-card-") || id.startsWith("card-") || id === testid.power) return true;
  }
  return false;
}
