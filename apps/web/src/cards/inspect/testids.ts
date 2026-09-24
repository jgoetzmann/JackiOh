// Test ids of the inspect overlays. Every id starts with `inspect-`, never `card-` or `hand-card-`,
// so `cy.fieldCardByName` and `cy.handCardByName` cannot resolve to an overlay (B20).
// e2e/support/testids.ts block A14 mirrors these name for name.

export const INSPECT_HOVER = "inspect-hover";
export const INSPECT_SHEET = "inspect-sheet";
export const INSPECT_DETAIL = "inspect-detail";
export const INSPECT_SCRIM = "inspect-scrim";
export const INSPECT_CLOSE = "inspect-close";
export const INSPECT_FACE = "inspect-face";
export const INSPECT_FACE_BASE = "inspect-face-base";
export const INSPECT_FACE_RADIANT = "inspect-face-radiant";
export const INSPECT_GLOSSARY = "inspect-glossary";
/** A face in play's printed text, where the two differ (SPEC §10.10). */
export const INSPECT_PRINTED = "inspect-printed";

// A list of cards (a graveyard or an exile pile): the hover preview, the sheet, and inside them.
export const INSPECT_LIST_HOVER = "inspect-list-hover";
export const INSPECT_LIST_SHEET = "inspect-list-sheet";
export const INSPECT_LIST_COUNT = "inspect-list-count";
export const INSPECT_LIST_CARD = "inspect-list-card";
export const INSPECT_LIST_MORE = "inspect-list-more";
export const INSPECT_LIST_DETAIL = "inspect-list-detail";
export const INSPECT_LIST_BACK = "inspect-list-back";
