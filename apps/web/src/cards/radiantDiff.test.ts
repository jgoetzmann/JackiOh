// R277: a Radiant face prints its whole catalog text and marks what its base face's text does not
// have. The diff itself (radiantDiff.ts), then every real card rendered through it.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { CATALOG } from "@jackioh/cards";
import type { CardDef } from "@jackioh/shared";

import { CardFace } from "./CardFace.tsx";
import { faceModel } from "./model.ts";
import { CardDefsProvider } from "./refContext.tsx";
import { markedText, radiantMarks } from "./radiantDiff.ts";

afterEach(cleanup);

const DEFS: readonly CardDef[] = Object.values(CATALOG);

function marks(base: string, radiant: string): string[] {
  return markedText(radiant, radiantMarks(base, radiant));
}

describe("R277 the word diff", () => {
  it("R277 marks a changed number and nothing else (the user's example: True Strike's 9)", () => {
    expect(marks("Deal 4 damage to the enemy hero", "Deal 9 damage to the enemy hero")).toEqual(["9"]);
    expect(marks(CATALOG["core-044"]?.base.text ?? "", CATALOG["core-044"]?.radiant.text ?? "")).toEqual(["9"]);
  });

  it("R277 marks an added phrase as one stretch, over its spaces and inner separators", () => {
    expect(marks("Destroy target unit", "Destroy target unit and the units adjacent to it on its side")).toEqual([
      "and the units adjacent to it on its side",
    ]);
    expect(marks("Taunt", "Taunt; Death: summon a copy")).toEqual(["Death: summon a copy"]);
  });

  it("R277 never starts or ends a mark on a separator", () => {
    for (const card of DEFS) {
      for (const range of radiantMarks(card.base.text, card.radiant.text)) {
        const text = card.radiant.text.slice(range.start, range.end);
        expect(text, card.id).toMatch(/^[^\s,;:.()].*[^\s,;:.()]$|^[^\s,;:.()]$/s);
      }
    }
  });

  it("R277 compares words without regard to case, so a capital moved by a new clause marks nothing", () => {
    expect(marks("Bounce all units on both sides", "Choose one: bounce all units on both sides, or draw 1")).toEqual([
      "Choose one",
      "or draw 1",
    ]);
  });

  it("R277 splits a formula at its brackets, so only the changed argument is marked", () => {
    expect(marks("Deal Fib(cost+1) damage", "Deal Fib(cost+3) damage")).toEqual(["cost+3"]);
  });

  it("R277 marks the whole Radiant text when the base text is empty, and nothing when the two are equal", () => {
    expect(marks("", "Rush")).toEqual(["Rush"]);
    expect(marks("Cry: summon a copy of this unit", "Cry: summon a copy of this unit")).toEqual([]);
  });

  it("R277 R102 diffs a fused text line by line against the same ingredient's base line", () => {
    const base = "Rush, First Strike\nCry: destroy target enemy non-Human unit";
    const radiant = "Charge, First Strike\nCry: destroy all enemy non-Human units";
    expect(marks(base, radiant)).toEqual(["Charge", "all", "units"]);
  });

  it("R277 a pure deletion marks nothing, so no Core Radiant text is written as one", () => {
    expect(marks("Cry: choose a Human unit", "Cry: choose a unit")).toEqual([]);
    const silent = DEFS.filter(
      (card) => card.radiant.text !== card.base.text && radiantMarks(card.base.text, card.radiant.text).length === 0,
    ).map((card) => card.id);
    expect(silent).toEqual([]);
  });
});

describe("R277 every Radiant face renders its marks gold, bold and underlined", () => {
  it("R277 R279 every catalog card's Radiant face shows each marked stretch in a .cf-mark, references and all, and its base face none", () => {
    for (const card of DEFS) {
      const expected = marks(card.base.text, card.radiant.text);
      // Inside the catalog, so the names its refs link are references and nest with the marks.
      const { container, unmount } = render(
        createElement(CardDefsProvider, {
          defs: CATALOG,
          children: createElement(CardFace, { face: faceModel({ defId: card.id, def: card, radiant: true }), layout: "full" }),
        }),
      );
      const shown = [...container.querySelectorAll(".cf-mark")].map((mark) => mark.textContent);
      expect(shown.join("|"), card.id).toBe(expected.join("|"));
      unmount();
      const base = render(createElement(CardFace, { face: faceModel({ defId: card.id, def: card, radiant: false }), layout: "full" }));
      expect(base.container.querySelector(".cf-mark"), `${card.id} base`).toBeNull();
      base.unmount();
    }
  }, 30_000);

  it("R277 the mark is a non-colour cue too: bold and underlined, in the stylesheet every face loads", () => {
    const css = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "cards.css"), "utf8");
    const rule = /\.cf-mark\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).toMatch(/font-weight:\s*800/);
    expect(rule).toMatch(/text-decoration:\s*underline/);
    expect(rule).toMatch(/color:\s*var\(--mark-ink\)/);
  });
});
