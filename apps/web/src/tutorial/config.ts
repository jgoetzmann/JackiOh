// Every number and key the tutorial states (CLAUDE.md rule 9). The rules numbers — the tutorial
// opponent's handicap — are the engine's (`AI_TUTORIAL` in packages/engine/src/config.ts, R290);
// these are the browser's own: the coach's patience, its mark's geometry, and where progress is kept.

/**
 * A coach step still current after this many of the player's own turn starts is retired by itself
 * (coach.ts), so a step whose moment has passed never strands the lesson. The lesson's last step is
 * exempt: it ends with the game.
 */
export const TUTORIAL_STEP_TURNS_MAX = 2;

/** localStorage: `{ v: 1, completed: string[] }` (progress.ts), read and written inside try/catch. */
export const TUTORIAL_PROGRESS_KEY = "jackioh.tutorial.v1";

/** The stored progress shape's version; anything else reads as no progress. */
export const TUTORIAL_PROGRESS_VERSION = 1;

/** The coach mark's ring stands this far outside the element it points at, in CSS pixels. */
export const COACH_RING_PAD_PX = 6;

/** The gap between the coach bubble and the ring it points from, in CSS pixels. */
export const COACH_BUBBLE_GAP_PX = 12;

/** The coach bubble never comes closer than this to the viewport's edge, in CSS pixels. */
export const COACH_VIEWPORT_MARGIN_PX = 8;

/**
 * How often the coach mark re-measures the element it points at while it shows, in ms. The board
 * moves cards as it animates and the hand fans out on hover, and none of that fires a resize.
 */
export const COACH_TRACK_INTERVAL_MS = 250;
