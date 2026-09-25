// Face numbers (CLAUDE.md rule 9: named, never inline). cards.css mirrors the two that CSS has to
// know as literals: the 5:7 aspect ratio and the 149px container-query breakpoint.

import type { LengthTier } from "./fit.ts";

/** A full card is a tall 5:7 rectangle, like a Hearthstone card. */
export const FACE_ASPECT = 5 / 7;

/** Name length ceilings for each tier: `nameTier` returns the first tier whose ceiling holds. */
export const NAME_TIER_MAX = { s: 12, m: 18, l: 24, xl: 30 } as const;

/** Rules-text length ceilings (base text plus the radiant clause) for each tier. */
export const TEXT_TIER_MAX = { s: 40, m: 90, l: 160, xl: 260 } as const;

/** The font scale each tier starts from, before `useFitText` shrinks it further. */
export const TIER_SCALE: Readonly<Record<LengthTier, number>> = { s: 1, m: 0.92, l: 0.82, xl: 0.72, xxl: 0.62 };

/** The smallest `--cf-fit` factor `useFitText` tries before it clamps with an ellipsis. */
export const FIT_MIN = 0.55;

/** Binary-search steps between FIT_MIN and 1. */
export const FIT_STEPS = 6;

/**
 * The rules text's reading floor, in CSS pixels. Rules text that would have to shrink below it to
 * fit first takes the long layout (`data-long` on the face: a shorter art window and a taller rules
 * box), and if it still does not fit at this size there, it clamps with an ellipsis at this size
 * instead of shrinking further. The detail view and the hover preview print it whole.
 */
export const FIT_FLOOR_PX = 9;

/** Below this face height the rules box, tags and type line hide. Mirrored in cards.css's @container rule. */
export const FACE_TEXT_MIN_HEIGHT_PX = 150;

/** R279: a mouse or pen resting this long on a reference in a card's text opens the card it names. */
export const REF_HOVER_DELAY_MS = 250;

/** R279: the height of the card face a reference's tooltip shows. */
export const REF_TOOLTIP_HEIGHT_PX = 300;

/** R279: the height of each named card's face in a hover preview's references column. */
export const REF_PANEL_FACE_HEIGHT_PX = 170;
