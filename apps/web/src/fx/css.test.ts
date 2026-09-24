// Polish 1 (docs/polish/1-animations.md, S10): the stylesheets, B40's text half.
//
// Vitest stubs CSS imports, so both files are read as text with `node:fs`, the way
// `animations.test.ts` reads `animations.css`. A small parser below turns a sheet into rules
// (selector list, declarations, the @media it sits in) and a set of @keyframes names, and the
// tests ask questions of that rather than of raw substrings, so formatting, ordering and grouping
// are the stylesheet author's choice. The browser half of B40 is e2e/cypress/component/fx-layer.cy.tsx.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

/* ------------------------------------------------------------------------------------------- *
 * Reading and parsing
 * ------------------------------------------------------------------------------------------- */

function readSheet(fromWeb: string): string {
  for (const candidate of [fromWeb, `apps/web/${fromWeb}`]) {
    const path = resolve(process.cwd(), candidate);
    if (existsSync(path)) return readFileSync(path, "utf8");
  }
  throw new Error(`${fromWeb} not found from ${process.cwd()}`);
}

type Rule = { selectors: string[]; decls: Map<string, string>; media: string | null };
type Sheet = { rules: Rule[]; keyframes: Set<string>; text: string };

function closingBrace(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return src.length;
}

/** Splits on `sep` at bracket depth 0, so `:is(a, b)` and `rgb(1, 2, 3)` stay whole. */
function splitTop(text: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "(" || ch === "[") depth += 1;
    else if (ch === ")" || ch === "]") depth -= 1;
    else if (ch === sep && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out.map((part) => part.trim()).filter((part) => part !== "");
}

function parseDecls(text: string): Map<string, string> {
  const decls = new Map<string, string>();
  for (const part of splitTop(text, ";")) {
    const colon = part.indexOf(":");
    if (colon <= 0) continue;
    decls.set(part.slice(0, colon).trim().toLowerCase(), part.slice(colon + 1).trim().replace(/\s+/g, " "));
  }
  return decls;
}

/** Native nesting: `&` stands for the parent, and a bare child selector is a descendant of it. */
function nest(parents: readonly string[] | null, selectors: readonly string[]): string[] {
  if (parents === null) return [...selectors];
  return parents.flatMap((parent) =>
    selectors.map((child) => (child.includes("&") ? child.replaceAll("&", parent) : `${parent} ${child}`)),
  );
}

function walk(src: string, media: string | null, parents: string[] | null, sheet: Sheet): string {
  let flat = "";
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf("{", i);
    if (open < 0) {
      flat += src.slice(i);
      break;
    }
    const head = src.slice(i, open);
    const cut = Math.max(head.lastIndexOf(";"), head.lastIndexOf("}"));
    flat += head.slice(0, cut + 1);
    const prelude = head.slice(cut + 1).trim();
    const close = closingBrace(src, open);
    const body = src.slice(open + 1, close);
    if (/^@(-webkit-)?keyframes\s/.test(prelude)) {
      sheet.keyframes.add(prelude.replace(/^@(-webkit-)?keyframes\s+/, "").trim());
    } else if (prelude.startsWith("@media")) {
      walk(body, prelude, parents, sheet);
    } else if (prelude.startsWith("@")) {
      walk(body, media, parents, sheet);
    } else {
      const selectors = nest(parents, splitTop(prelude, ","));
      const own = walk(body, media, selectors, sheet);
      sheet.rules.push({ selectors, decls: parseDecls(own), media });
    }
    i = close + 1;
  }
  return flat;
}

function parseSheet(css: string): Sheet {
  const text = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const sheet: Sheet = { rules: [], keyframes: new Set(), text };
  walk(text, null, null, sheet);
  return sheet;
}

/** Selector text with quotes dropped and the whitespace that carries no meaning removed. */
function normSelector(selector: string): string {
  return selector
    .replace(/['"]/g, "")
    .replace(/\s+/g, " ")
    .replace(/\s*([>,+~=])\s*/g, "$1")
    .replace(/\(\s+/g, "(")
    .replace(/\s+\)/g, ")")
    .replace(/\[\s+/g, "[")
    .replace(/\s+\]/g, "]")
    .trim();
}

function normValue(value: string): string {
  return value.replace(/\s+/g, " ").replace(/\s*,\s*/g, ",").replace(/\(\s+/g, "(").replace(/\s+\)/g, ")").trim().toLowerCase();
}

const REDUCED = /prefers-reduced-motion\s*:\s*reduce/;

function isReduced(rule: Rule): boolean {
  return rule.media !== null && REDUCED.test(rule.media);
}

/** Rules outside the reduced-motion block that list `selector` (compared normalised). */
function rulesListing(sheet: Sheet, selector: string): Rule[] {
  const wanted = normSelector(selector);
  return sheet.rules.filter((rule) => !isReduced(rule) && rule.selectors.some((s) => normSelector(s) === wanted));
}

/** The declarations those rules give `selector`, later rules winning. */
function declsFor(sheet: Sheet, selector: string): Map<string, string> {
  const merged = new Map<string, string>();
  for (const rule of rulesListing(sheet, selector)) for (const [k, v] of rule.decls) merged.set(k, v);
  return merged;
}

const isZero = (value: string | undefined): boolean => value !== undefined && /^0(px)?( 0(px)?){0,3}$/.test(normValue(value));

/* ------------------------------------------------------------------------------------------- *
 * The two sheets, and what animations.css carried before this task
 * ------------------------------------------------------------------------------------------- */

const fx = parseSheet(readSheet("src/fx/fx.css"));
const anim = parseSheet(readSheet("src/game/animations.css"));

/** Every `@keyframes` animations.css defined before this task (BUILD M5-T4's Animation column). */
const EXISTING_KEYFRAMES = [
  "jk-card-played", "jk-summon-scale", "jk-lunge", "jk-snap-back", "jk-damage-shake", "jk-number-pop",
  "jk-heal-pop", "jk-loss-pop", "jk-shield-shatter", "jk-dissolve", "jk-pile-pulse", "jk-card-resolved",
  "jk-exile-fade", "jk-bounce-to-hand", "jk-burn-away", "jk-discard-drop", "jk-draw-slide", "jk-hand-edge",
  "jk-shuffle-in", "jk-stat-tick", "jk-icon-pop", "jk-badge-tick", "jk-gem-tick", "jk-badge-fade",
  "jk-radiant-pulse", "jk-spin-face", "jk-fuse-merge", "jk-rotate-def", "jk-cross-centre", "jk-lane-slide",
  "jk-swap-cross", "jk-chain-close", "jk-trap-flip", "jk-trap-flip-hold", "jk-crystal-fill", "jk-banner",
  "jk-grey-out", "jk-fade-in", "jk-fade-out", "jk-toast-in", "jk-toast-resolve", "jk-result-overlay",
];

/** The `<n>ms` in every `animation-duration: calc(<n>ms * var(--anim-scale))` before this task. */
const EXISTING_DURATION_LITERALS = [
  400, 250, 350, 350, 350, 300, 300, 300, 300, 250, 350, 150, 150, 350, 350, 400, 300, 250, 250, 300, 250,
  200, 200, 200, 200, 400, 400, 500, 250, 450, 500, 500, 250, 700, 150, 600, 150, 150, 150, 150, 300, 220,
];

const DOM_KINDS = {
  splat: "fx-splat-pop",
  rays: "fx-rays-spin",
  sheen: "fx-sheen-sweep",
  ghost: "fx-ghost-fly",
  arrows: "fx-arrows-rise",
  banner: "fx-banner-in",
  result: "fx-result-in",
} as const;

const POP_GATE = normSelector('.game:has(> .fx-layer[data-fx="on"])');
const COCOON = '.game:has(> .fx-layer[data-fx="on"]) [data-testid^="card-"]:has([data-keyword="Divine Shield"])::after';

/** Every `@keyframes name { … }` body in a sheet's comment-free text. */
function keyframeBodies(sheet: Sheet): Map<string, string> {
  const out = new Map<string, string>();
  const head = /@(?:-webkit-)?keyframes\s+([\w-]+)\s*\{/g;
  for (let match = head.exec(sheet.text); match !== null; match = head.exec(sheet.text)) {
    const open = match.index + match[0].length - 1;
    out.set(match[1]!, sheet.text.slice(open + 1, closingBrace(sheet.text, open)));
  }
  return out;
}

/** The property: value pairs a keyframes body animates, every stop together. */
function animatedDecls(body: string): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = [];
  const stop = /\{([^{}]*)\}/g;
  for (let match = stop.exec(body); match !== null; match = stop.exec(body)) {
    for (const [name, value] of parseDecls(match[1]!)) out.push({ name, value: normValue(value) });
  }
  return out;
}

/**
 * What Chrome's compositor can animate off the main thread: transforms, opacity, and a filter that
 * moves no pixels. drop-shadow and blur move pixels (compositeFailed 4096); box-shadow, mask-position,
 * background-position and letter-spacing are main-thread properties (8192), and letter-spacing
 * re-lays the text out every frame. `animation-timing-function` is a per-stop easing, not a property.
 */
function compositorOnly(decl: { name: string; value: string }): boolean {
  if (["transform", "translate", "scale", "rotate", "opacity", "animation-timing-function"].includes(decl.name)) return true;
  if (decl.name === "filter") return !/drop-shadow|blur|url\(/.test(decl.value);
  return false;
}

/** Every `animation-duration` value outside the reduced-motion block, and every `animation` shorthand. */
function durationValues(sheet: Sheet): string[] {
  return sheet.rules
    .filter((rule) => !isReduced(rule))
    .flatMap((rule) => ["animation-duration", "animation"].flatMap((name) => {
      const value = rule.decls.get(name);
      return value === undefined ? [] : [normValue(value)];
    }));
}

/* ------------------------------------------------------------------------------------------- *
 * fx.css
 * ------------------------------------------------------------------------------------------- */

describe("B40 — fx.css", () => {
  it("B40 .fx-layer is fixed over the whole viewport at z-index 38, clips its overflow and takes no pointer event", () => {
    const layer = declsFor(fx, ".fx-layer");
    expect(layer.get("position")).toBe("fixed");
    const inset = isZero(layer.get("inset")) || ["top", "right", "bottom", "left"].every((side) => isZero(layer.get(side)));
    expect(inset, ".fx-layer is at inset: 0").toBe(true);
    expect(layer.get("z-index")).toBe("38");
    expect(normValue(layer.get("pointer-events") ?? "")).toBe("none");
    expect(normValue(layer.get("overflow") ?? "")).toBe("hidden");
  });

  it("B40 every descendant of .fx-layer takes no pointer event either", () => {
    const all = declsFor(fx, ".fx-layer *");
    expect(normValue(all.get("pointer-events") ?? "")).toBe("none");
  });

  it("B40 no rule in fx.css hands pointer events back to anything inside the layer", () => {
    const offenders = fx.rules.filter(
      (rule) =>
        rule.selectors.some((selector) => selector.includes("fx-")) &&
        rule.decls.has("pointer-events") &&
        !normValue(rule.decls.get("pointer-events") ?? "").startsWith("none"),
    );
    expect(offenders.map((rule) => rule.selectors.join(", "))).toEqual([]);
  });

  it("B40 .fx-canvas fills the layer", () => {
    const canvasRules = fx.rules.filter(
      (rule) => !isReduced(rule) && rule.selectors.some((s) => /\.fx-canvas\b/.test(s)),
    );
    expect(canvasRules.length).toBeGreaterThan(0);
    const decls = new Map<string, string>();
    for (const rule of canvasRules) for (const [k, v] of rule.decls) decls.set(k, normValue(v));
    const sized = decls.get("width") === "100%" && decls.get("height") === "100%";
    const pinned = ["absolute", "fixed"].includes(decls.get("position") ?? "") && isZero(decls.get("inset"));
    expect(sized || pinned, ".fx-canvas is 100% x 100% or pinned at inset: 0").toBe(true);
  });

  it("B40 the children of .fx-dom are absolutely positioned", () => {
    const childRule = fx.rules.some(
      (rule) =>
        !isReduced(rule) &&
        rule.selectors.some((s) => /^\.fx-dom\s*>?\s*\*$/.test(normSelector(s))) &&
        normValue(rule.decls.get("position") ?? "") === "absolute",
    );
    const everyKind = Object.keys(DOM_KINDS).every((kind) =>
      fx.rules.some(
        (rule) =>
          !isReduced(rule) &&
          rule.selectors.some((s) => normSelector(s).includes(`.fx-${kind}`)) &&
          normValue(rule.decls.get("position") ?? "") === "absolute",
      ),
    );
    expect(childRule || everyKind, "`.fx-dom > *`, or every .fx-<kind>, is position: absolute").toBe(true);
  });

  it("B40 every DOM kind has its own keyframes, run for var(--fx-ms)", () => {
    for (const [kind, keyframes] of Object.entries(DOM_KINDS)) {
      expect(fx.keyframes, `@keyframes ${keyframes}`).toContain(keyframes);
      const rules = fx.rules.filter(
        (rule) =>
          !isReduced(rule) &&
          rule.selectors.some((s) => {
            const n = normSelector(s);
            return n.includes(`.fx-${kind}`) || n.includes(`[data-fx=${kind}]`) || /^\.fx-dom\s*>?\s*\*/.test(n);
          }),
      );
      const values = rules.flatMap((rule) =>
        ["animation", "animation-name", "animation-duration"].flatMap((name) => {
          const value = rule.decls.get(name);
          return value === undefined ? [] : [{ name, value: normValue(value) }];
        }),
      );
      expect(
        values.some((v) => (v.name === "animation" || v.name === "animation-name") && v.value.includes(keyframes)),
        `.fx-${kind} runs ${keyframes}`,
      ).toBe(true);
      expect(
        values.some((v) => (v.name === "animation" || v.name === "animation-duration") && v.value.includes("var(--fx-ms")),
        `.fx-${kind} runs for var(--fx-ms)`,
      ).toBe(true);
    }
  });

  it("B40 the splat is a clip-path starburst and the rays a repeating conic gradient", () => {
    expect(fx.text).toMatch(/clip-path\s*:/);
    expect(fx.text).toMatch(/repeating-conic-gradient\(/);
  });

  it("B40 the Divine Shield cocoon hangs off the card root's ::after with a radial gradient and a slow pulse", () => {
    const rules = rulesListing(fx, COCOON);
    expect(rules.length, COCOON).toBeGreaterThan(0);
    const values = rules.flatMap((rule) => [...rule.decls.values()].map(normValue));
    expect(values.some((v) => v.includes("radial-gradient("))).toBe(true);
    expect(values.some((v) => v.includes("fx-shield-pulse"))).toBe(true);
    expect(fx.keyframes).toContain("fx-shield-pulse");
  });

  it("B40 the classic number pops are hidden, not removed, while the layer is on", () => {
    for (const pop of [".damage-pop", ".heal-pop", ".loss-pop"]) {
      const rules = fx.rules.filter(
        (rule) =>
          !isReduced(rule) &&
          rule.selectors.some((s) => {
            const n = normSelector(s);
            return n.startsWith(POP_GATE) && n.includes(pop);
          }),
      );
      expect(rules.length, `${POP_GATE} … ${pop}`).toBeGreaterThan(0);
      const decls = new Map<string, string>();
      for (const rule of rules) for (const [k, v] of rule.decls) decls.set(k, normValue(v));
      expect(decls.get("visibility"), `${pop} is visibility: hidden`).toBe("hidden");
      // Removing it would take its text out of the layout tree and out of BUILD's `.damage-pop`
      // assertions; only `visibility` may hide it.
      expect(decls.has("display"), `${pop} keeps its display`).toBe(false);
    }
  });

  it("B40 the pop-hiding rule is gated on the layer being on, so an off layer hides nothing", () => {
    const hidingPops = fx.rules.filter(
      (rule) =>
        !isReduced(rule) &&
        normValue(rule.decls.get("visibility") ?? "") === "hidden" &&
        rule.selectors.some((s) => /\.(damage|heal|loss)-pop\b/.test(s)),
    );
    expect(hidingPops.length).toBeGreaterThan(0);
    for (const rule of hidingPops) {
      for (const selector of rule.selectors.filter((s) => /\.(damage|heal|loss)-pop\b/.test(s))) {
        expect(normSelector(selector).startsWith(POP_GATE), selector).toBe(true);
      }
    }
  });

  it("R200 the cocoon, its pop and its shell are drawn only while the layer is on: nothing under the reduce setting or intensity off", () => {
    // Review: the cocoon was gated on nothing but the media query, so the viewer's reduce setting and
    // intensity "off" (which only turn the layer's own root to data-fx="off") left an endless pulse
    // on every Divine Shield card.
    const cocoonRules = fx.rules.filter(
      (rule) => !isReduced(rule) && rule.selectors.some((s) => s.includes('data-keyword="Divine Shield"')),
    );
    expect(cocoonRules.length).toBeGreaterThanOrEqual(3);
    for (const rule of cocoonRules) {
      for (const selector of rule.selectors) expect(normSelector(selector).startsWith(POP_GATE), selector).toBe(true);
    }
    const pop = declsFor(fx, '.game:has(> .fx-layer[data-fx="on"]) [data-testid^="card-"][data-animating="divineShieldLost"]:has([data-keyword="Divine Shield"])::after');
    expect(pop.get("animation")).toContain("fx-shield-pop");
  });

  it("B40 the cocoon reads at a glance: a bright rim inside the card and a shell outside it that leaves a focus ring alone", () => {
    const shell = declsFor(fx, '.game:has(> .fx-layer[data-fx="on"]) [data-testid^="card-"]:has([data-keyword="Divine Shield"]):not(:focus-visible)');
    expect(shell.get("outline")).toMatch(/^2px solid/);
    expect(normValue(shell.get("outline-offset") ?? "")).toBe("2px");
    const bubble = declsFor(fx, COCOON);
    expect(bubble.get("box-shadow")).toMatch(/inset 0 0 0 2px/);
  });

  it("B40 while a layer banner is up, the classic turn status steps aside (hidden, still in the DOM)", () => {
    const rule = declsFor(fx, '.game:has(> .fx-layer [data-fx="banner"]) > .turn-banner');
    expect(rule.get("visibility")).toBe("hidden");
    expect(rule.has("display")).toBe(false);
  });

  it("B46 a stand-in's copy is still, except for what the board plays on the card it carries", () => {
    expect(declsFor(fx, ".fx-hold > .fx-hold-card:not([data-animating])").get("animation")).toBe("none");
    expect(declsFor(fx, ".fx-hold > .fx-hold-card").has("animation")).toBe(false);
  });

  it("B40 a reduced-motion block stops every fx animation and the cocoon's pulse", () => {
    const reduced = fx.rules.filter(isReduced);
    expect(reduced.length).toBeGreaterThan(0);
    const stops = (rule: Rule): boolean => {
      const animation = normValue(rule.decls.get("animation") ?? "");
      const name = normValue(rule.decls.get("animation-name") ?? "");
      return animation.startsWith("none") || name.startsWith("none");
    };
    // A universal selector (`*`, `*::after`) covers both, so it counts for both.
    const universal = (s: string): boolean => /^\*(::?(before|after))?$/.test(normSelector(s));
    expect(
      reduced.some((rule) => stops(rule) && rule.selectors.some((s) => s.includes("fx-") || universal(s))),
      "animation: none on the .fx-* elements",
    ).toBe(true);
    expect(
      reduced.some((rule) => stops(rule) && rule.selectors.some((s) => s.includes("Divine Shield") || universal(s))),
      "animation: none on the cocoon",
    ).toBe(true);
  });
});

/* ------------------------------------------------------------------------------------------- *
 * animations.css
 * ------------------------------------------------------------------------------------------- */

describe("B40 — animations.css follows the squeeze and loses nothing", () => {
  it("B40 every existing @keyframes name survives", () => {
    const missing = EXISTING_KEYFRAMES.filter((name) => !anim.keyframes.has(name));
    expect(missing).toEqual([]);
  });

  it("B40 every table duration multiplies by var(--anim-squeeze, 1) as well as var(--anim-scale)", () => {
    const scaled = durationValues(anim).filter((value) => value.includes("var(--anim-scale)"));
    expect(scaled.length).toBeGreaterThanOrEqual(EXISTING_DURATION_LITERALS.length);
    for (const value of scaled) expect(value).toContain("var(--anim-squeeze,1)");
  });

  it("B40 the squeeze is never read without its fallback of 1, so an entry with no squeeze set keeps its full duration", () => {
    // `var(--anim-squeeze)` with no fallback is invalid wherever the property is unset, which
    // makes the whole calc() invalid and the duration 0: every motion outside a runner entry
    // would vanish.
    expect(anim.text).not.toMatch(/var\(\s*--anim-squeeze\s*\)/);
    const withSqueeze = durationValues(anim).filter((value) => value.includes("--anim-squeeze"));
    expect(withSqueeze.length).toBeGreaterThan(0);
    for (const value of withSqueeze) expect(value).toContain("var(--anim-squeeze,1)");
  });

  it("B40 every existing duration literal is still there", () => {
    const counts = new Map<number, number>();
    for (const value of durationValues(anim)) {
      for (const match of value.matchAll(/calc\((\d+)ms/g)) {
        const n = Number(match[1]);
        counts.set(n, (counts.get(n) ?? 0) + 1);
      }
    }
    const expected = new Map<number, number>();
    for (const n of EXISTING_DURATION_LITERALS) expected.set(n, (expected.get(n) ?? 0) + 1);
    for (const [n, count] of expected) {
      expect(counts.get(n) ?? 0, `calc(${n}ms …) occurrences`).toBeGreaterThanOrEqual(count);
    }
  });

  it("B50 the result overlay is a panel fixed on screen, and a finished game shows no turn", () => {
    // Review: after the 3.2 s Victory / Defeat sequence the only result left was an unstyled line
    // below the fold (y 874 in a 720 px viewport), under a status line still saying "Your turn".
    const overlay = declsFor(anim, '[data-testid="result-overlay"]');
    expect(overlay.get("position")).toBe("fixed");
    expect(overlay.get("z-index")).toBe("39");
    expect(normValue(overlay.get("max-width") ?? "")).toBe("calc(100vw - 32px)");
    expect(overlay.get("animation-name")).toBe("jk-result-overlay");
    const banner = declsFor(anim, '.game:has(> [data-testid="result-overlay"]) > [data-testid="turn-banner"]');
    expect(banner.get("visibility")).toBe("hidden");
  });

  it("B40 the reduced-motion block still zeroes every duration", () => {
    const reduced = anim.rules.filter(isReduced);
    expect(reduced.length).toBeGreaterThan(0);
    expect(
      reduced.some((rule) => /^0(s|ms)?\b/.test(normValue(rule.decls.get("animation-duration") ?? "x"))),
    ).toBe(true);
  });
});

/* ------------------------------------------------------------------------------------------- *
 * B45: the summon silhouette and the burn-away (visual pass 1)
 * ------------------------------------------------------------------------------------------- */

describe("B45 — a summon lands a silhouette, a dying card burns away", () => {
  it("B45 a zone being summoned into glows without scaling the zone box itself", () => {
    const zone = declsFor(anim, '.zone[data-animating="summoned"]');
    expect(zone.get("animation-name")).toBe("none");
    // The glow is drawn once on the ::before and faded in and out by opacity.
    const glow = declsFor(anim, '.zone[data-animating="summoned"]::before');
    expect(glow.get("animation-name")).toBe("jk-zone-landing");
    expect(glow.get("box-shadow")).toBeDefined();
    const landing = keyframeBodies(anim).get("jk-zone-landing") ?? "";
    expect(new Set(animatedDecls(landing).map((d) => d.name))).toEqual(new Set(["opacity"]));
  });

  it("B46 with the layer on, the silhouette steps aside for the stand-in, so the card is never in two places", () => {
    const hidden = declsFor(anim, '.game:has(> .fx-layer[data-fx="on"]) .zone[data-animating="summoned"]::after');
    expect(hidden.get("content")).toBe("none");
  });

  it("B45 a card-sized silhouette drops into that zone on jk-summon-scale, under the squeeze", () => {
    const after = declsFor(anim, '.zone[data-animating="summoned"]::after');
    expect(after.get("content")).toBe('""');
    expect(after.get("animation-name")).toBe("jk-summon-scale");
    expect(normValue(after.get("animation-duration") ?? "")).toContain("var(--anim-squeeze,1)");
    expect(after.get("pointer-events")).toBe("none");
  });

  it("B45 played from a hand, the silhouette waits for the card to leave it", () => {
    const delayed = declsFor(anim, '.game:has([data-animating="cardPlayed"]) .zone[data-animating="summoned"]::after');
    expect(normValue(delayed.get("animation-delay") ?? "")).toContain("var(--anim-squeeze,1)");
  });

  it("B45 a destroyed card burns from the bottom up: a charred front climbs it by transform, under the squeeze", () => {
    const front = declsFor(anim, '[data-testid^="card-"][data-animating="destroyed"]::before');
    expect(front.get("content")).toBe('""');
    expect(front.get("background")).toMatch(/linear-gradient\(\s*to top/);
    expect(front.get("animation-name")).toBe("jk-burn-climb");
    expect(normValue(front.get("animation-duration") ?? "")).toContain("var(--anim-squeeze,1)");
    expect(front.get("pointer-events")).toBe("none");
    const climb = animatedDecls(keyframeBodies(anim).get("jk-burn-climb") ?? "");
    expect(climb.length).toBeGreaterThan(0);
    expect(climb.every((d) => d.name === "transform")).toBe(true);
    // No mask moves any more (mask-position is not compositable).
    expect(anim.text).not.toMatch(/mask-position/);
  });
});

describe("Every motion runs on the compositor (review: lunge, splat, dissolve, hold, sheen, zone glow and result word did not)", () => {
  /** BUILD's own jk-chain-close: its motion is the inset ring closing on a locked zone. */
  const MAIN_THREAD_ALLOWED = new Set(["jk-chain-close"]);

  for (const [label, sheet] of [
    ["fx.css", fx],
    ["animations.css", anim],
  ] as const) {
    it(`B55 ${label}: every @keyframes animates only transform, opacity and pixel-preserving filters`, () => {
      const bodies = keyframeBodies(sheet);
      expect(bodies.size).toBeGreaterThan(5);
      const offenders: string[] = [];
      for (const [name, body] of bodies) {
        if (MAIN_THREAD_ALLOWED.has(name)) continue;
        for (const decl of animatedDecls(body)) {
          if (!compositorOnly(decl)) offenders.push(`${name}: ${decl.name}: ${decl.value}`);
        }
      }
      expect(offenders).toEqual([]);
    });
  }

  it("the check itself catches what the review found", () => {
    expect(compositorOnly({ name: "filter", value: "brightness(1.2) drop-shadow(0 4px 4px black)" })).toBe(false);
    expect(compositorOnly({ name: "letter-spacing", value: "0.4em" })).toBe(false);
    expect(compositorOnly({ name: "mask-position", value: "0 100%" })).toBe(false);
    expect(compositorOnly({ name: "box-shadow", value: "0 0 4px red" })).toBe(false);
    expect(compositorOnly({ name: "filter", value: "brightness(1.2) sepia(40%)" })).toBe(true);
  });
});
