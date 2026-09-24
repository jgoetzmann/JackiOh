// The rules box's reading floor (fit.ts), against a modelled layout.
//
// jsdom has no layout, so `useFitText` is a no-op there (CardFace.test.tsx B15). This file gives a
// rules box a small model of one instead: a box of a known height, a font that is the base size
// times the length tier's scale times `--cf-fit` (or the base size times `--cf-fit` in the long
// layout, as cards.css has it), and text that needs `need × font²` pixels of height. That is enough
// to drive every branch of the floor: fits as it is, fits once the tier's head start is dropped,
// fits in the long layout, clamps at the floor, and a face too small for the floor at all. The
// component specs (card-faces B15, deckbuilder-layout) prove the same thing on real layout.

import { render } from "@testing-library/react";
import { useRef, type ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FIT_FLOOR_PX, FIT_MIN } from "./constants.ts";
import { LONG_ATTRIBUTE, useFitText } from "./fit.ts";

type Model = {
  /** The font at full size (4.4cqh on a real face), in px. */
  basePx: number;
  /** The length tier's head start (TIER_SCALE). */
  tierScale: number;
  /** Box heights in px: the ordinary rules box and the long layout's. */
  box: number;
  longBox: number;
  /** Height the text needs is `need × font²`. */
  need: number;
};

const WIDTH = 150;
const PADDING = 4;
const LINE_HEIGHT = 1.18;

function fitOf(element: HTMLElement): number {
  return Number(element.style.getPropertyValue("--cf-fit")) || 1;
}

/** The model's font for this element, as cards.css would compute it. */
function fontOf(element: HTMLElement, model: Model): number {
  const long = element.closest(".cf")?.getAttribute(LONG_ATTRIBUTE) === "true";
  const inline = element.style.getPropertyValue("--cf-text-scale");
  const scale = long ? 1 : inline === "" ? model.tierScale : Number(inline);
  return model.basePx * scale * fitOf(element);
}

function boxOf(element: HTMLElement, model: Model): number {
  return element.closest(".cf")?.getAttribute(LONG_ATTRIBUTE) === "true" ? model.longBox : model.box;
}

/** Wires the model into the one element the probe renders. */
function modelLayout(model: Model): void {
  const text = (element: Element): element is HTMLElement =>
    element instanceof HTMLElement && element.dataset.probe === "text";
  const real = window.getComputedStyle.bind(window);
  vi.spyOn(window, "getComputedStyle").mockImplementation((element: Element) => {
    if (!text(element)) return real(element);
    const font = fontOf(element, model);
    return {
      fontSize: `${String(font)}px`,
      lineHeight: `${String(font * LINE_HEIGHT)}px`,
      paddingTop: `${String(PADDING)}px`,
      paddingBottom: `${String(PADDING)}px`,
      maxHeight: `${String(boxOf(element, model))}px`,
    } as CSSStyleDeclaration;
  });
  const proto = HTMLElement.prototype;
  vi.spyOn(proto, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
    return text(this) ? WIDTH : 0;
  });
  vi.spyOn(proto, "scrollWidth", "get").mockImplementation(function (this: HTMLElement) {
    return text(this) ? WIDTH : 0;
  });
  vi.spyOn(proto, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
    return text(this) ? boxOf(this, model) : 0;
  });
  vi.spyOn(proto, "scrollHeight", "get").mockImplementation(function (this: HTMLElement) {
    if (!text(this)) return 0;
    const font = fontOf(this, model);
    const needed = model.need * font * font + 2 * PADDING;
    // A clamped box shows its clamped lines only.
    const lines = this.style.getPropertyValue("--cf-clamp-lines");
    return lines === "" ? needed : Math.min(needed, Number(lines) * font * LINE_HEIGHT + 2 * PADDING);
  });
}

function Probe({ content }: { content: string }): ReactElement {
  const ref = useRef<HTMLSpanElement>(null);
  useFitText(ref, content, { floorPx: FIT_FLOOR_PX });
  return (
    <span className="cf">
      <span data-probe="text" ref={ref}>
        <span className="cf-text-base">{content}</span>
      </span>
    </span>
  );
}

function fitted(model: Model): { text: HTMLElement; face: HTMLElement; font: number } {
  modelLayout(model);
  const { container } = render(<Probe content="rules" />);
  const text = container.querySelector<HTMLElement>('[data-probe="text"]');
  const face = container.querySelector<HTMLElement>(".cf");
  if (text === null || face === null) throw new Error("probe did not render");
  return { text, face, font: fontOf(text, model) };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("the rules box's reading floor", () => {
  it("leaves a text that fits at or above the floor exactly as the tier fitted it", () => {
    const { text, face, font } = fitted({ basePx: 11, tierScale: 1, box: 80, longBox: 120, need: 0.5 });
    expect(font).toBeGreaterThanOrEqual(FIT_FLOOR_PX);
    expect(face.hasAttribute(LONG_ATTRIBUTE)).toBe(false);
    expect(text.hasAttribute("data-clamped")).toBe(false);
    expect(text.style.getPropertyValue("--cf-text-scale")).toBe("");
  });

  it("drops the tier's head start when that alone lifts the text to the floor", () => {
    // Tier scale 0.72 caps it at 7.9 px, though the box holds it at 9+ px from full size.
    const { text, face, font } = fitted({ basePx: 11, tierScale: 0.72, box: 80, longBox: 120, need: 0.8 });
    expect(text.style.getPropertyValue("--cf-text-scale")).toBe("1");
    expect(font).toBeGreaterThanOrEqual(FIT_FLOOR_PX - 0.05);
    expect(face.hasAttribute(LONG_ATTRIBUTE)).toBe(false);
    expect(text.hasAttribute("data-clamped")).toBe(false);
  });

  it("takes the long layout when the ordinary box cannot hold the text at the floor", () => {
    // Needs 1.2 × 9² ≈ 97 px: over the 80 px box, inside the 120 px one.
    const { text, face, font } = fitted({ basePx: 11, tierScale: 0.62, box: 80, longBox: 120, need: 1.2 });
    expect(face.getAttribute(LONG_ATTRIBUTE)).toBe("true");
    expect(font).toBeGreaterThanOrEqual(FIT_FLOOR_PX - 0.05);
    expect(text.hasAttribute("data-clamped")).toBe(false);
  });

  it("clamps at the floor, to the lines the long box holds, when even that is too small", () => {
    const { text, face, font } = fitted({ basePx: 11, tierScale: 0.62, box: 80, longBox: 120, need: 3 });
    expect(face.getAttribute(LONG_ATTRIBUTE)).toBe("true");
    expect(text.getAttribute("data-clamped")).toBe("true");
    expect(font).toBeGreaterThanOrEqual(FIT_FLOOR_PX);
    expect(font).toBeLessThan(FIT_FLOOR_PX + 0.05);
    const lines = Number(text.style.getPropertyValue("--cf-clamp-lines"));
    expect(lines).toBe(Math.floor((120 - 2 * PADDING) / (font * LINE_HEIGHT)));
  });

  it("fits a face too small for the floor as before: shrink, and clamp only past FIT_MIN", () => {
    // Full size is 6 px, so no layout could print it at 9: the floor does not apply.
    const { text, face } = fitted({ basePx: 6, tierScale: 0.82, box: 40, longBox: 60, need: 1.4 });
    expect(face.hasAttribute(LONG_ATTRIBUTE)).toBe(false);
    expect(text.style.getPropertyValue("--cf-text-scale")).toBe("");
    expect(text.hasAttribute("data-clamped")).toBe(false);
    expect(fitOf(text)).toBeGreaterThanOrEqual(FIT_MIN);
    expect(fitOf(text)).toBeLessThan(1);
  });
});
