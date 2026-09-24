// Every number and test id the opponent's-play showcase uses (CLAUDE.md rule 9).

import { normalizeSpeed } from "../../fx/settings.ts";

/**
 * How long the opponent's played card stays up at the default effects speed: about a second, long
 * enough to read a name and a short text, short enough never to sit over the viewer's next move. It
 * is divided by the viewer's effects speed (R201), as every animation duration is.
 */
export const SHOWCASE_HOLD_MS = 1000;

/**
 * The most plays waiting their turn. A hotseat hand-over brings a whole turn's plays at once; the
 * newest few are shown, one after another, and the rest are in the log.
 */
export const SHOWCASE_QUEUE_MAX = 3;

/** The fade in and the fade out, inside the hold (showcase.css); none under reduced motion. */
export const SHOWCASE_FADE_MS = 160;

/** The hold at an effects speed, never below the two fades. */
export function showcaseHoldMs(speed: number): number {
  return Math.max(2 * SHOWCASE_FADE_MS, Math.round(SHOWCASE_HOLD_MS / normalizeSpeed(speed)));
}

/**
 * Test ids. None starts with `card-` or `hand-card-`, so `cy.fieldCardByName` and
 * `cy.handCardByName` can never resolve to the showcase (B20). e2e/support/testids.ts mirrors them.
 */
export const showcaseTestid = {
  /** The showcase itself, present only while a play is held up. Carries `data-showcase`. */
  root: "showcase",
  caption: "showcase-caption",
  /** The face of a card the view names. */
  face: "showcase-face",
  /** The back drawn for a card the view hides (R97, R227). */
  back: "showcase-back",
  /** The polite live region that says what was played; always mounted, empty between plays. */
  live: "showcase-live",
} as const;

/** `data-showcase`: what is being held up. The practice route holds the AI's next step while it is set. */
export type ShowcaseKind = "played" | "set" | "hidden";
