// Where an effect plays, measured the moment it fires (docs/polish/1-animations.md, S8).
//
// Every anchor is resolved against the DOM the board has already rendered: a `data-testid`
// rectangle, the n-th `.mana-crystal` in a `mana-<side>` tray, or a point on the viewport. Nothing
// here caches a rectangle, because the board re-lays itself out between entries (a unit that dies
// leaves its zone empty, a hand that grows re-fans), and an effect aimed at last frame's box lands
// in the wrong place. An element that is not laid out, and every element under jsdom, reports a
// 0×0 rect; that resolves to null so the director skips the cue instead of drawing at the origin.
//
// A hand is the exception to "a testid is its element's rect". The hand strip (`hand-you`,
// `hand-opponent`) runs the width of the board while its cards sit at one end, so its centre is
// empty table. A hand anchor resolves to the box of the cards it holds plus the slot the next card
// takes, clipped to the strip: a drawn card's ghost lands where the card will appear, and a burn or a
// glint plays on the cards rather than beside them. An empty hand is the strip itself.
//
// `boardShakeSink` is the one place the shake touches the page. It writes the individual CSS
// `translate` and `rotate` properties, which compose with the `transform` keyframes the board's
// rotate and swap animations use instead of overriding them, and it puts back whatever inline
// values the board carried before the first shaking frame.

import type { FxAnchor, FxBox, FxPoint, FxShakeOffset, FxShakeSink, FxVec } from "./types.ts";

const CENTRE: FxPoint = { x: 0.5, y: 0.5 };

/** `CSS.escape` does not exist under jsdom; a testid only needs its quotes and backslashes escaped. */
function attrValue(value: string): string {
  return value.replace(/["\\]/g, "\\$&");
}

/** The element's viewport rectangle, or null when there is no element or it has no size yet. */
function boxOf(element: Element | null | undefined): FxBox | null {
  if (element === null || element === undefined) return null;
  const rect = element.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;
  return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
}

const HAND_TESTIDS: ReadonlySet<string> = new Set(["hand-you", "hand-opponent"]);

/** A hand's cards plus the slot after the last one, inside the strip (see the header). */
function handBox(hand: Element): FxBox | null {
  const strip = boxOf(hand);
  if (strip === null) return null;
  const cards: FxBox[] = [];
  for (const card of Array.from(hand.querySelectorAll(".card"))) {
    const box = boxOf(card);
    if (box !== null) cards.push(box);
  }
  const last = cards[cards.length - 1];
  if (last === undefined) return strip;
  const previous = cards[cards.length - 2];
  // The next card lands one step on from the last: the spacing the hand already uses (a fan
  // overlaps, a row leaves a gap), or one card's width when there is only one card to go by.
  const step = previous !== undefined && last.x > previous.x ? last.x - previous.x : last.width;
  let left = last.x;
  let top = last.y;
  let right = last.x + last.width + step;
  let bottom = last.y + last.height;
  for (const box of cards) {
    left = Math.min(left, box.x);
    top = Math.min(top, box.y);
    right = Math.max(right, box.x + box.width);
    bottom = Math.max(bottom, box.y + box.height);
  }
  left = Math.max(left, strip.x);
  right = Math.min(right, strip.x + strip.width);
  if (!(right > left)) return strip;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/**
 * testid → the element's rect (a hand: its cards and the next card's slot, see the header); crystal → the index-th `.mana-crystal` in `mana-<side>` (falling back
 * to the tray's box); viewport → a zero-size box at (innerWidth·at.x, innerHeight·at.y). An element
 * with a 0×0 rect (not laid out, or jsdom) resolves to null.
 */
export function resolveAnchor(anchor: FxAnchor, doc?: Document, win?: Window): FxBox | null {
  if (anchor.kind === "viewport") {
    const view = win ?? window;
    return { x: view.innerWidth * anchor.at.x, y: view.innerHeight * anchor.at.y, width: 0, height: 0 };
  }

  const page = doc ?? document;

  if (anchor.kind === "testid") {
    const element = page.querySelector(`[data-testid="${attrValue(anchor.testid)}"]`);
    if (element !== null && HAND_TESTIDS.has(anchor.testid)) return handBox(element);
    return boxOf(element);
  }

  const tray = page.querySelector(`[data-testid="mana-${anchor.side}"]`);
  if (tray === null) return null;
  const crystal = tray.querySelectorAll(".mana-crystal")[anchor.index];
  return boxOf(crystal) ?? boxOf(tray);
}

/** The point `at` inside `box`, as fractions of its width and height; the centre by default. */
export function pointIn(box: FxBox, at?: FxPoint): FxVec {
  const p = at ?? CENTRE;
  return { x: box.x + box.width * p.x, y: box.y + box.height * p.y };
}

type SavedInline = { translate: string; rotate: string; translatePriority: string; rotatePriority: string };

function restoreProperty(style: CSSStyleDeclaration, name: string, value: string, priority: string): void {
  if (value === "") style.removeProperty(name);
  else style.setProperty(name, value, priority);
}

/** CSS `translate`/`rotate` on [data-testid="board"] while shaking; restores the prior inline values on clear(). */
export function boardShakeSink(doc?: Document): FxShakeSink {
  let target: HTMLElement | null = null;
  let saved: SavedInline | null = null;

  const restore = (): void => {
    if (target !== null && saved !== null) {
      restoreProperty(target.style, "translate", saved.translate, saved.translatePriority);
      restoreProperty(target.style, "rotate", saved.rotate, saved.rotatePriority);
    }
    target = null;
    saved = null;
  };

  return {
    apply(offset: FxShakeOffset): void {
      const page = doc ?? document;
      const board = page.querySelector<HTMLElement>('[data-testid="board"]');
      if (board === null) {
        restore();
        return;
      }
      if (board !== target) {
        // A new board element (a remount, a seat hand-over) gets its own saved values; the old one
        // gets its own back first.
        restore();
        target = board;
        saved = {
          translate: board.style.getPropertyValue("translate"),
          rotate: board.style.getPropertyValue("rotate"),
          translatePriority: board.style.getPropertyPriority("translate"),
          rotatePriority: board.style.getPropertyPriority("rotate"),
        };
      }
      board.style.setProperty("translate", `${offset.x.toFixed(2)}px ${offset.y.toFixed(2)}px`);
      board.style.setProperty("rotate", `${offset.angle.toFixed(3)}deg`);
    },
    clear(): void {
      restore();
    },
  };
}
