// DOM effects: the CSS half of the effects layer (docs/polish/1-animations.md S10, B39).
//
// The director hands every DOM cue (splat, rays, sheen, ghost, arrows, banner, result) to
// `mountDomEffect` at the moment the cue fires, with the anchor boxes it measured then. This module
// appends exactly one element per cue and writes only data: its kind, its tone, its text as an
// attribute, and its geometry and timing as `--fx-*` custom properties. Everything visual lives in
// fx.css, keyed off `data-fx`.
//
// Three invariants the rest of the build leans on:
// - No text node is ever created. Numbers and words ride in `data-amount` / `data-text` and reach the
//   screen through CSS `content: attr(…)`, so no Cypress `contains` can ever match an effect and no
//   screen reader reads one (the element is `aria-hidden` as well).
// - A cue whose kind needs a box that is missing mounts nothing and returns null, so an anchor that
//   left the board between planning and firing simply skips its flourish.
// - No timers. The director removes each element when `firedAt + durationMs ≤ now` (S8 step 5), and
//   `remove()` is idempotent so a clear() racing an expiry is harmless.
//
// Nothing here reads a card identity: a ghost is a card BACK only (R202).

import type { FxBox, FxDomCue, FxHoldCue } from "./types.ts";

export type DomEffectBoxes = { at?: FxBox | null; from?: FxBox | null; to?: FxBox | null };
export type DomEffect = { readonly el: HTMLElement; remove(): void };

/** A length in CSS pixels, written as `<n>px` (S10). */
function px(value: number): string {
  return `${value}px`;
}

function centreOf(box: FxBox): { x: number; y: number } {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/** `--fx-x/--fx-y` at the box centre and `--fx-w/--fx-h` at its size (splat, rays). */
function placeAtCentre(el: HTMLElement, box: FxBox): void {
  const centre = centreOf(box);
  el.style.setProperty("--fx-x", px(centre.x));
  el.style.setProperty("--fx-y", px(centre.y));
  el.style.setProperty("--fx-w", px(box.width));
  el.style.setProperty("--fx-h", px(box.height));
}

/** `--fx-x/--fx-y` at the box's top-left and `--fx-w/--fx-h` at its size (sheen, arrows). */
function cover(el: HTMLElement, box: FxBox): void {
  el.style.setProperty("--fx-x", px(box.x));
  el.style.setProperty("--fx-y", px(box.y));
  el.style.setProperty("--fx-w", px(box.width));
  el.style.setProperty("--fx-h", px(box.height));
}

/** The splat's signed amount: ASCII hyphen-minus for damage and loss, plus for heal (S10). */
function signedAmount(tone: "damage" | "heal" | "loss", amount: number): string {
  return tone === "heal" ? `+${amount}` : `-${amount}`;
}

/** Appends one element for the cue; null (nothing appended) when a box the kind needs is missing. */
export function mountDomEffect(root: HTMLElement, cue: FxDomCue, boxes: DomEffectBoxes): DomEffect | null {
  const doc = root.ownerDocument;
  const el = doc.createElement("div");

  switch (cue.kind) {
    case "splat": {
      const at = boxes.at ?? null;
      if (at === null) return null;
      el.setAttribute("data-tone", cue.tone);
      el.setAttribute("data-amount", signedAmount(cue.tone, cue.amount));
      placeAtCentre(el, at);
      break;
    }
    case "rays": {
      const at = boxes.at ?? null;
      if (at === null) return null;
      el.setAttribute("data-tone", cue.tone);
      placeAtCentre(el, at);
      break;
    }
    case "sheen": {
      const at = boxes.at ?? null;
      if (at === null) return null;
      cover(el, at);
      break;
    }
    case "ghost": {
      const from = boxes.from ?? null;
      const to = boxes.to ?? null;
      if (from === null || to === null) return null;
      const start = centreOf(from);
      const end = centreOf(to);
      el.style.setProperty("--fx-x", px(start.x));
      el.style.setProperty("--fx-y", px(start.y));
      el.style.setProperty("--fx-dx", px(end.x - start.x));
      el.style.setProperty("--fx-dy", px(end.y - start.y));
      break;
    }
    case "arrows": {
      const at = boxes.at ?? null;
      if (at === null) return null;
      el.setAttribute("data-direction", cue.direction);
      cover(el, at);
      break;
    }
    case "banner": {
      el.setAttribute("data-tone", cue.tone);
      el.setAttribute("data-text", cue.text);
      break;
    }
    case "result": {
      el.setAttribute("data-outcome", cue.outcome);
      el.setAttribute("data-text", cue.text);
      break;
    }
  }

  el.className = `fx-${cue.kind}`;
  el.setAttribute("data-fx", cue.kind);
  el.setAttribute("aria-hidden", "true");
  el.style.setProperty("--fx-ms", `${Math.max(0, cue.durationMs)}ms`);

  root.appendChild(el);

  return {
    el,
    remove(): void {
      if (el.parentNode !== null) el.parentNode.removeChild(el);
    },
  };
}

/* ------------------------------------------------------------------------------------------- *
 * Stand-ins (B46): a copy of a card the board already renders, carried to the zone
 * the next view shows it in. The copy keeps the card's markup and classes, so it looks like the
 * card, and loses everything that would make it a second copy of the card to a test, a screen
 * reader or the keyboard: its testids, ids, roles, labels, legality marks and every text node
 * (the words move into `data-text` and come back through CSS, as the splats' do).
 * ------------------------------------------------------------------------------------------- */

/** Attributes a stand-in must not carry: identity, interaction and state the board owns. */
function strippable(name: string): boolean {
  return (
    name === "id" ||
    name === "tabindex" ||
    name === "role" ||
    name === "title" ||
    name === "draggable" ||
    name === "disabled" ||
    name === "data-testid" ||
    name === "data-legal" ||
    name === "data-selected" ||
    name === "data-animating" ||
    name === "data-fx-concealed" ||
    name.startsWith("aria-") ||
    name.startsWith("on")
  );
}

/** A copy of `source` with no testid, no interaction and no text node. */
export function standInCopy(source: Element): HTMLElement {
  const copy = source.cloneNode(true) as HTMLElement;
  const doc = copy.ownerDocument;
  for (const node of [copy, ...Array.from(copy.querySelectorAll("*"))]) {
    for (const name of node.getAttributeNames()) {
      if (strippable(name)) node.removeAttribute(name);
    }
  }
  const texts: Node[] = [];
  const walker = doc.createTreeWalker(copy, 4 /* NodeFilter.SHOW_TEXT */);
  while (walker.nextNode() !== null) texts.push(walker.currentNode);
  for (const text of texts) {
    const span = doc.createElement("span");
    span.className = "fx-hold-text";
    span.setAttribute("data-text", text.nodeValue ?? "");
    text.parentNode?.replaceChild(span, text);
  }
  copy.style.removeProperty("--fx-lunge-x");
  copy.style.removeProperty("--fx-lunge-y");
  copy.classList.add("fx-hold-card");
  return copy;
}

/** Where a stand-in lands in a zone: card-shaped, the zone's height, centred as the board centres a card. */
export function landingBox(zone: FxBox, source: FxBox | null): FxBox {
  const height = Math.max(1, zone.height - 2);
  const aspect = source !== null && source.height > 0 ? source.width / source.height : CARD_ASPECT;
  const width = Math.max(1, Math.min(zone.width - 2, height * aspect));
  return { x: zone.x + (zone.width - width) / 2, y: zone.y + (zone.height - height) / 2, width, height };
}

/** A card's width over its height where no source card says (board.css: --card-w = 0.74 × --card-h). */
const CARD_ASPECT = 0.74;
/** How far a stand-in with nothing to fly from drops in from, and how large it starts. */
const DROP_PX = -14;
const DROP_SCALE = 1.3;

export type HoldEffect = DomEffect & {
  /** Re-places the stand-in on a new landing box (its size changed: a resize). Costs a layout. */
  place(land: FxBox): void;
  /** Offsets the stand-in from where it was placed (the board shook or scrolled under it). No layout. */
  shift(dx: number, dy: number): void;
};

/**
 * Mounts a stand-in for `cue`: a copy of `source` (flying from `from`, its box) when there is one,
 * else a card-shaped light that drops into `land`. `font` is the font size the source card
 * inherits, so its `em` sizes resolve as they do on the board.
 */
export function mountHold(
  root: HTMLElement,
  cue: FxHoldCue,
  parts: { source: Element | null; from: FxBox | null; land: FxBox; font: string | null },
): HoldEffect {
  const doc = root.ownerDocument;
  const el = doc.createElement("div");
  el.className = "fx-hold";
  el.setAttribute("data-fx", "hold");
  el.setAttribute("data-look", parts.source !== null ? "card" : "glow");
  el.setAttribute("aria-hidden", "true");
  el.setAttribute("inert", "");
  el.style.setProperty("--fx-ms", `${Math.max(0, cue.durationMs)}ms`);
  el.style.setProperty("--fx-land-ms", `${Math.max(0, cue.landMs)}ms`);
  if (parts.font !== null && parts.font !== "") el.style.setProperty("font-size", parts.font);

  const place = (land: FxBox): void => {
    el.style.setProperty("--fx-x", px(land.x));
    el.style.setProperty("--fx-y", px(land.y));
    el.style.setProperty("--fx-w", px(land.width));
    el.style.setProperty("--fx-h", px(land.height));
  };
  place(parts.land);

  const landCentre = centreOf(parts.land);
  if (parts.from !== null) {
    const start = centreOf(parts.from);
    el.style.setProperty("--fx-dx", px(start.x - landCentre.x));
    el.style.setProperty("--fx-dy", px(start.y - landCentre.y));
    el.style.setProperty("--fx-s", (parts.from.height / Math.max(1, parts.land.height)).toFixed(3));
    el.style.setProperty("--fx-o0", "1");
  } else {
    el.style.setProperty("--fx-dx", px(0));
    el.style.setProperty("--fx-dy", px(DROP_PX));
    el.style.setProperty("--fx-s", String(DROP_SCALE));
    el.style.setProperty("--fx-o0", "0");
  }

  if (parts.source !== null) {
    el.appendChild(standInCopy(parts.source));
  } else {
    const glow = doc.createElement("div");
    glow.className = "fx-hold-glow";
    el.appendChild(glow);
  }

  root.appendChild(el);
  return {
    el,
    place,
    shift(dx: number, dy: number): void {
      if (dx === 0 && dy === 0) el.style.removeProperty("translate");
      else el.style.setProperty("translate", `${px(dx)} ${px(dy)}`);
    },
    remove(): void {
      if (el.parentNode !== null) el.parentNode.removeChild(el);
    },
  };
}
