// Text that fits its box (docs/polish/6-cards.md, Surface B "fit.ts").
//
// Two layers. The tiers are coarse and pure: a long name or a long rules text starts from a smaller
// font (TIER_SCALE), chosen from its length alone, so the first paint is already close. Then
// `useFitText` measures the real box and shrinks the font the rest of the way by writing one inline
// custom property, `--cf-fit`, which cards.css multiplies into the font size. Everything on a face
// is sized in container units, so the factor that fits at one card size fits at every size.

import { useLayoutEffect, type RefObject } from "react";

import { FIT_MIN, FIT_STEPS, NAME_TIER_MAX, TEXT_TIER_MAX } from "./constants.ts";

export type LengthTier = "s" | "m" | "l" | "xl" | "xxl";

function tierOf(length: number, max: { s: number; m: number; l: number; xl: number }): LengthTier {
  if (length <= max.s) return "s";
  if (length <= max.m) return "m";
  if (length <= max.l) return "l";
  if (length <= max.xl) return "xl";
  return "xxl";
}

/** ≤12 s, ≤18 m, ≤24 l, ≤30 xl, else xxl. */
export function nameTier(name: string): LengthTier {
  return tierOf(name.length, NAME_TIER_MAX);
}

/** ≤40 s, ≤90 m, ≤160 l, ≤260 xl, else xxl. Pass the base text and the radiant clause together. */
export function textTier(text: string): LengthTier {
  return tierOf(text.length, TEXT_TIER_MAX);
}

/** The one pixel of slack every measurement allows, for sub-pixel rounding. */
const SLACK_PX = 1;

const FIT_PROPERTY = "--cf-fit";
const CLAMPED = "data-clamped";

function overflows(element: HTMLElement): boolean {
  return (
    element.scrollHeight > element.clientHeight + SLACK_PX || element.scrollWidth > element.clientWidth + SLACK_PX
  );
}

function setFit(element: HTMLElement, factor: number): void {
  element.style.setProperty(FIT_PROPERTY, String(Math.round(factor * 1000) / 1000));
}

/**
 * One fitting pass. Without layout (jsdom, or a rules box the small-card container query hides)
 * it only drops a stale `data-clamped`, which is absent in jsdom, so there it changes nothing.
 */
function fit(element: HTMLElement): void {
  if (element.clientWidth === 0 && element.clientHeight === 0) {
    if (element.hasAttribute(CLAMPED)) element.removeAttribute(CLAMPED);
    return;
  }

  element.removeAttribute(CLAMPED);
  setFit(element, 1);
  if (!overflows(element)) return;

  setFit(element, FIT_MIN);
  if (overflows(element)) {
    // Even the smallest font spills: the CSS line-clamps with an ellipsis instead.
    element.setAttribute(CLAMPED, "true");
    return;
  }

  // FIT_MIN fits and 1 does not: binary-search the largest factor that still fits.
  let fits = FIT_MIN;
  let spills = 1;
  for (let step = 0; step < FIT_STEPS; step += 1) {
    const middle = (fits + spills) / 2;
    setFit(element, middle);
    if (overflows(element)) spills = middle;
    else fits = middle;
  }
  setFit(element, fits);
}

/**
 * Binary-searches the inline custom property `--cf-fit` (FIT_MIN..1, FIT_STEPS steps) on `ref`
 * until scrollHeight ≤ clientHeight + 1 and scrollWidth ≤ clientWidth + 1. Re-runs on resize
 * (ResizeObserver when present) and when `content` changes. If FIT_MIN still overflows it sets
 * `data-clamped="true"` and the CSS line-clamps with an ellipsis. A no-op when the element has no
 * layout (clientWidth and clientHeight both 0, which is every element in jsdom).
 */
export function useFitText(ref: RefObject<HTMLElement | null>, content: string): void {
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) return undefined;

    fit(element);

    if (typeof ResizeObserver === "undefined") return undefined;
    // The observed box is sized by its container, never by its font, so refitting cannot resize it
    // again and loop.
    let last = `${element.clientWidth}x${element.clientHeight}`;
    const observer = new ResizeObserver(() => {
      const size = `${element.clientWidth}x${element.clientHeight}`;
      if (size === last) return;
      last = size;
      fit(element);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, content]);
}
