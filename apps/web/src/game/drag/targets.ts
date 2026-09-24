// Reading a drag's source and landing spot off the DOM (docs/polish/7-mobile-ux.md S9).
//
// The board already names every clickable thing with a `data-testid` (contract.ts `testid`), and
// each zone carries its side, row and lane as `data-*`. This file only reads those back into the
// `ClickTarget` the board's own click handlers would have reported. No React, no rules.

import type { Row } from "@jackioh/shared";

import type { ClickTarget, Side } from "../contract.ts";
import type { DropSpot } from "./model.ts";

const HAND_CARD = /^hand-card-(.+)$/;
const CARD = /^card-(.+)$/;
const ZONE = /^zone-(you|opponent)-(units|backrow)-(\d+)$/;

type Place = { side: Side; row: Row; lane: number };

function asSide(value: string | null): Side | null {
  return value === "you" || value === "opponent" ? value : null;
}

function asRow(value: string | null): Row | null {
  return value === "units" || value === "backrow" ? value : null;
}

/** A zone element's side, row and lane, from the `data-*` Zone.tsx writes. */
function placeOf(zone: Element): Place | null {
  const side = asSide(zone.getAttribute("data-side"));
  const row = asRow(zone.getAttribute("data-row"));
  const lane = Number(zone.getAttribute("data-lane"));
  if (side !== null && row !== null && Number.isInteger(lane) && lane > 0) return { side, row, lane };
  return null;
}

/** The nearest ancestor (not self) whose testid is a board zone's, `zone-<side>-<row>-<lane>`. */
function enclosingZone(element: Element): Element | null {
  for (let at = element.parentElement; at !== null; at = at.parentElement) {
    if (ZONE.test(at.getAttribute("data-testid") ?? "")) return at;
  }
  return null;
}

/** A control inside a card (the switch button) is pressed, never dragged. */
function isControl(element: Element): boolean {
  const tag = element.tagName.toLowerCase();
  return tag === "button" || tag === "input" || element.getAttribute("role") === "button";
}

/**
 * The ClickTarget an element reports, from the nearest ancestor-or-self whose testid matches:
 *   hand-card-<id>                   -> { on: "hand", instanceId }
 *   card-<id> inside a zone-*        -> { on: "unit" | "backrow", instanceId, side, lane } (from the zone's data-row/data-side/data-lane)
 *   card-<id> outside any zone       -> null (e.g. the resolving strip)
 *   hero-you | hero-opponent         -> { on: "hero", side }   (a press on `power` inside a hero reports the hero)
 *   zone-<side>-<row>-<lane>         -> { on: "zone", side, row, lane }
 * A press on a <button>, <input> or [role=button] inside a card (the switch button) is NOT a drag source.
 */
export function targetFromElement(element: Element): { target: ClickTarget; testid: string } | null {
  let throughControl = false;
  for (let at: Element | null = element; at !== null; at = at.parentElement) {
    const id = at.getAttribute("data-testid");
    if (id !== null) {
      const hand = HAND_CARD.exec(id);
      if (hand !== null) {
        if (throughControl) return null;
        return { target: { on: "hand", instanceId: hand[1] as string }, testid: id };
      }

      const card = CARD.exec(id);
      if (card !== null) {
        if (throughControl) return null;
        const zone = enclosingZone(at);
        const place = zone === null ? null : placeOf(zone);
        if (place === null) return null;
        const instanceId = card[1] as string;
        return {
          target:
            place.row === "units"
              ? { on: "unit", instanceId, side: place.side, lane: place.lane }
              : { on: "backrow", instanceId, side: place.side, lane: place.lane },
          testid: id,
        };
      }

      if (id === "hero-you" || id === "hero-opponent") {
        return { target: { on: "hero", side: id === "hero-you" ? "you" : "opponent" }, testid: id };
      }

      if (ZONE.test(id)) {
        const place = placeOf(at);
        if (place === null) return null;
        return { target: { on: "zone", side: place.side, row: place.row, lane: place.lane }, testid: id };
      }
    }
    if (isControl(at)) throughControl = true;
  }
  return null;
}

/** The first element of `stack` (topmost first) mapping to a testid in `allowed` gives a target spot; otherwise board/outside by stack[0]. */
export function pickDropSpot(stack: readonly Element[], allowed: ReadonlySet<string>): DropSpot {
  for (const element of stack) {
    const hit = targetFromElement(element);
    if (hit !== null && allowed.has(hit.testid)) return { at: "target", target: hit.target, testid: hit.testid };
  }
  const top = stack[0];
  if (top === undefined) return { at: "outside" };
  if (top.closest('[data-testid="board"]') === null) return { at: "outside" };
  if (top.closest('[data-testid="hand-you"]') !== null) return { at: "outside" };
  return { at: "board" };
}
