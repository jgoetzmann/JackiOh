// Vitest setup for the web package: jsdom matchers plus a `matchMedia` stub, which jsdom lacks
// and the animation table needs for `prefers-reduced-motion` (BUILD M5-T4).

import "@testing-library/jest-dom/vitest";

let reducedMotion = false;

export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

/** Flip `prefers-reduced-motion` for a test. Always reset it in an `afterEach`. */
export function setReducedMotion(on: boolean): void {
  reducedMotion = on;
}

function matches(query: string): boolean {
  return reducedMotion && query.replace(/\s+/g, "") === REDUCED_MOTION_QUERY.replace(/\s+/g, "");
}

if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string): MediaQueryList =>
      ({
        media: query,
        get matches() {
          return matches(query);
        },
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  });
}
