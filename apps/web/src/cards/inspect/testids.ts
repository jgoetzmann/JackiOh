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
