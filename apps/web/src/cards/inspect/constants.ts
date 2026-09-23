// Inspect timings and preview geometry (docs/polish/6-cards.md, Surface C). CLAUDE.md rule 9: every
// number the inspect overlays use is named here, never inline.

/** A mouse or pen pointer resting this long on a face-up card opens the hover preview (B22). */
export const HOVER_DELAY_MS = 300;
/** A touch held this long opens the inspect sheet, or calls `onLongPress` (B24). */
export const LONG_PRESS_MS = 450;
/** A touch that moves further than this from where it started is a drag, not a long-press. */
export const LONG_PRESS_SLOP_PX = 10;
/** After a long-press fires, the next click on the trigger is swallowed for at most this long. */
export const CLICK_SUPPRESS_MS = 600;
/** The hover preview's card height. inspect.css caps it at 80vh. */
export const PREVIEW_HEIGHT_PX = 380;
/** Space between the anchor card and the preview. */
export const PREVIEW_GAP_PX = 12;
/** The preview always stays this far inside the viewport. */
export const PREVIEW_MARGIN_PX = 8;

/** The share of the viewport height the preview card may use. Mirrors inspect.css's `80vh`. */
export const PREVIEW_MAX_VIEWPORT_SHARE = 0.8;
/** The glossary column beside the preview card. Mirrors `.inspect-hover .inspect-glossary`'s width. */
export const PREVIEW_GLOSSARY_WIDTH_PX = 240;
/** Space between the preview card and its glossary. Mirrors `.inspect-hover`'s `gap`. */
export const PREVIEW_GLOSSARY_GAP_PX = 10;
