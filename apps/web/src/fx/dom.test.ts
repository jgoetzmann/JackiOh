// Polish 1 (docs/polish/1-animations.md, S10): `mountDomEffect`, B39.
//
// One cue per kind, mounted into a plain jsdom `div`. The element contract is the S10 table: one
// appended element per cue, `class="fx-<kind>"`, `data-fx="<kind>"`, `aria-hidden="true"`, no text
// node (numbers and words ride in `data-amount` / `data-text` and reach the screen only through CSS
// `content: attr(…)`), placement in `--fx-x/--fx-y/--fx-w/--fx-h`, flight in `--fx-dx/--fx-dy`, and
// timing in `--fx-ms`. A cue missing a box its kind needs mounts nothing and returns null.
//
// The boxes are whole numbers with even sizes, so every centre is a whole number and the expected
// lengths are plain `<n>px` strings.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { mountDomEffect, type DomEffect } from "./dom.ts";
import type { FxBox, FxDomCue } from "./types.ts";

const AT: FxBox = { x: 100, y: 200, width: 80, height: 120 }; // centre (140, 260)
const TO: FxBox = { x: 700, y: 40, width: 60, height: 60 }; // centre (730, 70)

let root: HTMLElement;

beforeEach(() => {
  root = document.createElement("div");
  document.body.appendChild(root);
});

afterEach(() => {
  vi.useRealTimers();
  document.body.innerHTML = "";
});

function cssVar(el: HTMLElement, name: string): string {
  return el.style.getPropertyValue(name).trim();
}

function textNodeCount(el: Node): number {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let n = 0;
  while (walker.nextNode() !== null) n += 1;
  return n;
}

/** The part of the S10 contract every kind shares. Returns the element for kind-specific checks. */
function expectMounted(effect: DomEffect | null, cue: FxDomCue): HTMLElement {
  expect(effect).not.toBeNull();
  if (effect === null) throw new Error("nothing mounted");
  const el = effect.el;
  expect(el.parentElement).toBe(root);
  expect(root.childElementCount).toBe(1);
  expect(el.classList.contains(`fx-${cue.kind}`)).toBe(true);
  expect(el.getAttribute("data-fx")).toBe(cue.kind);
  expect(el.getAttribute("aria-hidden")).toBe("true");
  expect(cssVar(el, "--fx-ms")).toBe(`${cue.durationMs}ms`);
  expect(textNodeCount(el)).toBe(0);
  expect(el.textContent).toBe("");
  return el;
}

function expectCentredOn(el: HTMLElement, box: FxBox): void {
  expect(cssVar(el, "--fx-x")).toBe(`${box.x + box.width / 2}px`);
  expect(cssVar(el, "--fx-y")).toBe(`${box.y + box.height / 2}px`);
  expect(cssVar(el, "--fx-w")).toBe(`${box.width}px`);
  expect(cssVar(el, "--fx-h")).toBe(`${box.height}px`);
}

function expectCovering(el: HTMLElement, box: FxBox): void {
  expect(cssVar(el, "--fx-x")).toBe(`${box.x}px`);
  expect(cssVar(el, "--fx-y")).toBe(`${box.y}px`);
  expect(cssVar(el, "--fx-w")).toBe(`${box.width}px`);
  expect(cssVar(el, "--fx-h")).toBe(`${box.height}px`);
}

const anchor = { kind: "testid", testid: "card-u1" } as const;

const SPLAT_DAMAGE: FxDomCue = { kind: "splat", tone: "damage", amount: 5, at: anchor, delayMs: 0, durationMs: 950 };
const SPLAT_HEAL: FxDomCue = { kind: "splat", tone: "heal", amount: 3, at: anchor, delayMs: 60, durationMs: 890 };
const SPLAT_LOSS: FxDomCue = { kind: "splat", tone: "loss", amount: 2, at: anchor, delayMs: 0, durationMs: 950 };
const RAYS: FxDomCue = { kind: "rays", tone: "mythic", at: anchor, delayMs: 0, durationMs: 850 };
const SHEEN: FxDomCue = { kind: "sheen", at: anchor, delayMs: 0, durationMs: 400 };
const GHOST: FxDomCue = { kind: "ghost", from: anchor, to: { kind: "testid", testid: "hand-you" }, delayMs: 0, durationMs: 250 };
const ARROWS_UP: FxDomCue = { kind: "arrows", direction: "up", at: anchor, delayMs: 0, durationMs: 550 };
const ARROWS_DOWN: FxDomCue = { kind: "arrows", direction: "down", at: anchor, delayMs: 0, durationMs: 550 };
const BANNER: FxDomCue = { kind: "banner", text: "Your turn", tone: "you", delayMs: 0, durationMs: 1500 };
const RESULT: FxDomCue = { kind: "result", outcome: "defeat", text: "Defeat", delayMs: 0, durationMs: 3200 };

/* ------------------------------------------------------------------------------------------- *
 * Each kind mounts one element to the contract
 * ------------------------------------------------------------------------------------------- */

describe("B39 — mountDomEffect mounts one element per cue", () => {
  it("B39 a damage splat carries its tone and a hyphen-minus amount, centred on its box", () => {
    const el = expectMounted(mountDomEffect(root, SPLAT_DAMAGE, { at: AT }), SPLAT_DAMAGE);
    expect(el.getAttribute("data-tone")).toBe("damage");
    const amount = el.getAttribute("data-amount") ?? "";
    expect(amount).toBe("-5");
    expect(amount.charCodeAt(0)).toBe(0x2d);
    expectCentredOn(el, AT);
  });

  it("B39 a heal splat carries a plus-sign amount", () => {
    const el = expectMounted(mountDomEffect(root, SPLAT_HEAL, { at: AT }), SPLAT_HEAL);
    expect(el.getAttribute("data-tone")).toBe("heal");
    const amount = el.getAttribute("data-amount") ?? "";
    expect(amount).toBe("+3");
    expect(amount.charCodeAt(0)).toBe(0x2b);
    expectCentredOn(el, AT);
  });

  it("B39 a health-loss splat is signed like damage", () => {
    const el = expectMounted(mountDomEffect(root, SPLAT_LOSS, { at: AT }), SPLAT_LOSS);
    expect(el.getAttribute("data-tone")).toBe("loss");
    expect(el.getAttribute("data-amount")).toBe("-2");
  });

  it("B39 rays carry their tone and are centred on their box", () => {
    const el = expectMounted(mountDomEffect(root, RAYS, { at: AT }), RAYS);
    expect(el.getAttribute("data-tone")).toBe("mythic");
    expectCentredOn(el, AT);
  });

  it("B39 a sheen covers its box from the top-left corner", () => {
    const el = expectMounted(mountDomEffect(root, SHEEN, { at: AT }), SHEEN);
    expectCovering(el, AT);
  });

  it("B39 a ghost starts at its source's centre and flies by the offset to its destination's centre", () => {
    const el = expectMounted(mountDomEffect(root, GHOST, { from: AT, to: TO }), GHOST);
    expect(cssVar(el, "--fx-x")).toBe("140px");
    expect(cssVar(el, "--fx-y")).toBe("260px");
    expect(cssVar(el, "--fx-dx")).toBe("590px");
    expect(cssVar(el, "--fx-dy")).toBe("-190px");
  });

  it("B39 arrows carry their direction and cover their box", () => {
    const up = expectMounted(mountDomEffect(root, ARROWS_UP, { at: AT }), ARROWS_UP);
    expect(up.getAttribute("data-direction")).toBe("up");
    expectCovering(up, AT);

    root.innerHTML = "";
    const down = expectMounted(mountDomEffect(root, ARROWS_DOWN, { at: AT }), ARROWS_DOWN);
    expect(down.getAttribute("data-direction")).toBe("down");
  });

  it("B39 a banner needs no box and carries its tone and text as attributes", () => {
    const el = expectMounted(mountDomEffect(root, BANNER, {}), BANNER);
    expect(el.getAttribute("data-tone")).toBe("you");
    expect(el.getAttribute("data-text")).toBe("Your turn");
  });

  it("B39 a result needs no box and carries its outcome and text as attributes", () => {
    const el = expectMounted(mountDomEffect(root, RESULT, {}), RESULT);
    expect(el.getAttribute("data-outcome")).toBe("defeat");
    expect(el.getAttribute("data-text")).toBe("Defeat");
  });

  it("B39 remove() takes out its own element and leaves the others", () => {
    const first = mountDomEffect(root, SHEEN, { at: AT });
    const second = mountDomEffect(root, SPLAT_DAMAGE, { at: AT });
    expect(root.childElementCount).toBe(2);

    first?.remove();
    expect(root.childElementCount).toBe(1);
    expect(root.firstElementChild).toBe(second?.el);
  });
});

/* ------------------------------------------------------------------------------------------- *
 * What it refuses, and what it never does
 * ------------------------------------------------------------------------------------------- */

describe("B39 — a cue without the box it needs mounts nothing", () => {
  for (const cue of [SPLAT_DAMAGE, RAYS, SHEEN, ARROWS_UP]) {
    it(`B39 a ${cue.kind} with no \`at\` box mounts nothing`, () => {
      expect(mountDomEffect(root, cue, {})).toBeNull();
      expect(root.childElementCount).toBe(0);
    });

    it(`B39 a ${cue.kind} whose \`at\` box is null mounts nothing, even when from and to are given`, () => {
      expect(mountDomEffect(root, cue, { at: null, from: AT, to: TO })).toBeNull();
      expect(root.childElementCount).toBe(0);
    });
  }

  it("B39 a ghost with no source box mounts nothing", () => {
    expect(mountDomEffect(root, GHOST, { to: TO })).toBeNull();
    expect(mountDomEffect(root, GHOST, { from: null, to: TO })).toBeNull();
    expect(root.childElementCount).toBe(0);
  });

  it("B39 a ghost with no destination box mounts nothing", () => {
    expect(mountDomEffect(root, GHOST, { from: AT })).toBeNull();
    expect(mountDomEffect(root, GHOST, { from: AT, to: null })).toBeNull();
    expect(root.childElementCount).toBe(0);
  });

  it("B39 a ghost given only an `at` box mounts nothing", () => {
    expect(mountDomEffect(root, GHOST, { at: AT })).toBeNull();
    expect(root.childElementCount).toBe(0);
  });

  it("B39 text that looks like markup stays an attribute and never becomes a node", () => {
    const cue: FxDomCue = { kind: "banner", text: "<b>Your turn</b>", tone: "you", delayMs: 0, durationMs: 1500 };
    const el = expectMounted(mountDomEffect(root, cue, {}), cue);
    expect(el.getAttribute("data-text")).toBe("<b>Your turn</b>");
    expect(el.children).toHaveLength(0);
    expect(root.querySelector("b")).toBeNull();
  });

  it("B39 mounting sets no timer, and a mounted effect stays until something removes it", () => {
    vi.useFakeTimers();
    const mounted = [
      mountDomEffect(root, SPLAT_DAMAGE, { at: AT }),
      mountDomEffect(root, RAYS, { at: AT }),
      mountDomEffect(root, SHEEN, { at: AT }),
      mountDomEffect(root, GHOST, { from: AT, to: TO }),
      mountDomEffect(root, ARROWS_UP, { at: AT }),
      mountDomEffect(root, BANNER, {}),
      mountDomEffect(root, RESULT, {}),
    ];
    expect(mounted.every((effect) => effect !== null)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);

    vi.advanceTimersByTime(60_000);
    expect(root.childElementCount).toBe(7);
  });

  it("B39 no mounted kind contains a text node, so no text search can match an effect", () => {
    mountDomEffect(root, SPLAT_DAMAGE, { at: AT });
    mountDomEffect(root, SPLAT_HEAL, { at: AT });
    mountDomEffect(root, RAYS, { at: AT });
    mountDomEffect(root, SHEEN, { at: AT });
    mountDomEffect(root, GHOST, { from: AT, to: TO });
    mountDomEffect(root, ARROWS_DOWN, { at: AT });
    mountDomEffect(root, BANNER, {});
    mountDomEffect(root, RESULT, {});
    expect(root.childElementCount).toBe(8);
    expect(textNodeCount(root)).toBe(0);
    expect(root.textContent).toBe("");
  });
});

describe("a stand-in swells inward from an edge (integration QA: lane 1 on a phone)", () => {
  // Imported here so the header's contract above stays about mountDomEffect.
  const view = { width: 390, height: 844 };

  it("keeps the resting origin where the swell has room", async () => {
    const { holdOrigin } = await import("./dom.ts");
    expect(holdOrigin({ x: 150, y: 400, width: 66, height: 90 }, 1.3, view)).toEqual({ x: 0.5, y: 0.6 });
  });

  it("scales from the left edge of a box in lane 1, so nothing crosses the screen's left edge", async () => {
    const { holdOrigin } = await import("./dom.ts");
    const land = { x: 8, y: 400, width: 66, height: 90 };
    const scale = 1.6;
    const origin = holdOrigin(land, scale, view);
    expect(origin.x).toBeLessThan(0.5);
    const left = land.x + origin.x * land.width * (1 - scale);
    expect(left).toBeGreaterThanOrEqual(0);
  });

  it("scales from the right for a box at the right edge", async () => {
    const { holdOrigin } = await import("./dom.ts");
    const land = { x: 316, y: 400, width: 66, height: 90 };
    const scale = 1.6;
    const origin = holdOrigin(land, scale, view);
    const right = land.x + origin.x * land.width + (1 - origin.x) * land.width * scale;
    expect(origin.x).toBeGreaterThan(0.5);
    expect(right).toBeLessThanOrEqual(view.width);
  });
});
