// Polish task 7 (docs/polish/7-mobile-ux.md): the testids and attributes the drag layer, the
// settings panel and the highlights add to the client, and the pointer gesture that drives a drag.
//
// Like support/testids.ts, this is the one place a spec finds these names, so a spec never spells a
// raw selector. The vocabulary is the design doc's Surface: S6 (DOM attributes), S8 (settings
// testids) and S9 (the drag overlay).
//
// THE GESTURE. The DragLayer listens on `window` (S9), tracks one pointer by `pointerId`, starts a
// drag once the pointer has travelled `DRAG_THRESHOLD_PX`, and hit-tests the release point with
// `document.elementsFromPoint`. So the release is judged by its COORDINATES, not by the element
// the event is dispatched on. Every event below is a real `PointerEvent` with `pointerId`,
// `clientX` and `clientY` set; `isPrimary` and `pointerType` keep the constructor's defaults, which
// S9 says the layer must not depend on.
//
// Coordinates are viewport coordinates, so an element is scrolled into view (only when it is not
// already) before its centre is read, and every trigger passes `scrollBehavior: false` so Cypress
// does not scroll the page again between reading a point and dispatching at it.

import { timeouts } from "./config.ts";

// ---------------------------------------------------------------------------------------------
// S9: the drag overlay. Rendered only while a drag is in flight.
// ---------------------------------------------------------------------------------------------

/** The overlay root; `data-kind="play" | "attack"`. */
export const DRAG_LAYER = "drag-layer";
/** The card being placed; `data-instance-id`. Shown when the drag does not draw an arrow. */
export const DRAG_GHOST = "drag-ghost";
/** The targeting arrow; `data-from=<source testid>`, `data-valid="true" | "false"`. */
export const DRAG_ARROW = "drag-arrow";
/** The reticle over a valid target; `data-target=<target testid>`. */
export const DRAG_RETICLE = "drag-reticle";

/** S9: the overlay's attributes. */
export const DRAG_KIND_ATTR = "data-kind";
export const DRAG_INSTANCE_ATTR = "data-instance-id";
export const DRAG_FROM_ATTR = "data-from";
export const DRAG_VALID_ATTR = "data-valid";
export const DRAG_TARGET_ATTR = "data-target";

/** S9: pointer travel, in CSS px, before a press becomes a drag. */
export const DRAG_THRESHOLD_PX = 8;

// ---------------------------------------------------------------------------------------------
// S6: attributes.
// ---------------------------------------------------------------------------------------------

/** On a card, zone, hero, `power` or `end-turn`: `"ready"` or absent (the green glow). */
export const GLOW_ATTR = "data-glow";
export const GLOW_READY = "ready";
/** On a face-up card root: `"true"` or absent (the yellow glow's flag). */
export const CONDITION_ATTR = "data-condition-active";
/** On `board`: `"on" | "off"`, from the "Drag to play" setting. */
export const DRAG_ATTR = "data-drag";
/** On `<html>`: `"play" | "attack"` while a drag is in flight, absent otherwise. */
export const DRAGGING_ATTR = "data-dragging";
/** The element that carries `data-dragging`. */
export const ROOT = "html";
/** On `end-turn`: `"armed"` after the first click when "Confirm end turn" asks twice. */
export const CONFIRM_ATTR = "data-confirm";

// ---------------------------------------------------------------------------------------------
// S8: the settings panel.
// ---------------------------------------------------------------------------------------------

/** The gear in the game's control bar. */
export const SETTINGS_OPEN_GAME = "settings-open-game";
/** The gear in the nav (`BackLink`). */
export const SETTINGS_OPEN_NAV = "settings-open-nav";
/** The dialog. */
export const SETTINGS_PANEL = "settings-panel";
/** The full-screen scrim behind it; a click on it closes the panel. */
export const SETTINGS_SCRIM = "settings-scrim";
export const SETTINGS_CLOSE = "settings-close";
export const SETTINGS_RESET = "settings-reset";

export type SettingKey = "dragToPlay" | "confirmEndTurn" | "hoverPreviews" | "reduceMotion";
export type SettingsSection = "gameplay" | "visuals" | "audio";

/** One `<input type="checkbox" role="switch">`: `setting-dragToPlay`, … */
export function settingId(key: SettingKey): string {
  return `setting-${key}`;
}

export function settingsSectionId(section: SettingsSection): string {
  return `settings-section-${section}`;
}

// ---------------------------------------------------------------------------------------------
// The gesture.
// ---------------------------------------------------------------------------------------------

export type Point = { x: number; y: number };

/** One pointer for the whole gesture, as a finger or a mouse is. */
const POINTER_ID = 1;

/** The first move goes this far straight up from the press: twice the threshold, so it starts a drag. */
const LIFT_PX = DRAG_THRESHOLD_PX * 2;

/** The element's centre in viewport coordinates, scrolling it into view first if it is not. */
function centreOf(element: HTMLElement): Point {
  const win = element.ownerDocument.defaultView;
  let box = element.getBoundingClientRect();
  if (win !== null && (box.top < 0 || box.left < 0 || box.bottom > win.innerHeight || box.right > win.innerWidth)) {
    element.scrollIntoView({ block: "center", inline: "center" });
    box = element.getBoundingClientRect();
  }
  return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
}

/**
 * A point that is not on the board: the left edge of the page, inside `.app-shell--wide`'s 12 px
 * of padding (apps/web/src/index.css), half way down the viewport. `elementsFromPoint` there finds
 * the shell, never anything under `[data-testid="board"]`, at any scroll position.
 */
function outsidePoint(win: Window): Point {
  return { x: 2, y: Math.round(win.innerHeight / 2) };
}

function pointer(at: Point, phase: "down" | "move" | "up") {
  return {
    eventConstructor: "PointerEvent",
    pointerId: POINTER_ID,
    clientX: at.x,
    clientY: at.y,
    button: 0,
    buttons: phase === "up" ? 0 : 1,
    bubbles: true,
    cancelable: true,
    force: true,
    scrollBehavior: false as const,
  };
}

function moveTo(at: Point): void {
  cy.get("body", { log: false }).trigger("pointermove", pointer(at, "move"));
}

/**
 * Press the source and move the pointer past the drag threshold, so a drag is in flight (if the
 * client starts one). Yields the pointer's position.
 */
export function pressAndLift(source: string): Cypress.Chainable<Point> {
  return cy
    .get(source, { timeout: timeouts.view })
    .should("be.visible")
    .then(($source) => {
      const element = $source[0] as HTMLElement;
      const from = centreOf(element);
      cy.wrap($source, { log: false }).trigger("pointerdown", pointer(from, "down"));
      const lifted = { x: from.x, y: from.y - LIFT_PX };
      moveTo(lifted);
      return cy.wrap(lifted, { log: false });
    });
}

/** Move the held pointer over the target's centre, or to a point off the board. */
export function hoverOver(target: string | "outside"): Cypress.Chainable<Point> {
  if (target === "outside") {
    return cy.window({ log: false }).then((win) => {
      const at = outsidePoint(win);
      moveTo(at);
      return cy.wrap(at, { log: false });
    });
  }
  return cy.get(target, { timeout: timeouts.view }).then(($target) => {
    const at = centreOf($target[0] as HTMLElement);
    // Arrive from a little way off, as a hand does, rather than teleporting onto the target.
    moveTo({ x: at.x - 24, y: at.y + 24 });
    moveTo(at);
    return cy.wrap(at, { log: false });
  });
}

/** Lift the pointer over the target's centre, or off the board. */
export function releaseOver(target: string | "outside"): void {
  if (target === "outside") {
    cy.window({ log: false }).then((win) => {
      cy.get("body", { log: false }).trigger("pointerup", pointer(outsidePoint(win), "up"));
    });
    return;
  }
  cy.get(target, { timeout: timeouts.view }).then(($target) => {
    const at = centreOf($target[0] as HTMLElement);
    cy.wrap($target, { log: false }).trigger("pointerup", pointer(at, "up"));
  });
}

/**
 * The whole drag: `pointerdown` on the source, `pointermove`s on `body` carrying `clientX` /
 * `clientY` and `pointerId`, then `pointerup` on the target (or off the board), and then
 * `cy.settled()` so whatever the drop did has finished animating.
 */
export function dragTo(source: string, target: string | "outside"): void {
  pressAndLift(source);
  hoverOver(target);
  releaseOver(target);
  cy.settled();
}
