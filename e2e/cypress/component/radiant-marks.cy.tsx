// The Radiant pass's marks on a card face, in a real browser (SPEC §10.10, R277, R279, R280).
//
// apps/web's vitest suite proves the DOM: which words a Radiant face marks, which names are
// references, where a value's braces go. What only a layout and style engine can say is measured
// here: the gold mark is really gold, bold and underlined, and readable on the Radiant parchment
// (contrast from the computed colours); a reference in the collection's detail view opens a tooltip
// holding the named card's face, inside the viewport; and a computed value sits inside the rules
// box without pushing it out.

import { CATALOG } from "../../../packages/cards/src/catalog-data.ts";
import { CardDefsProvider, CardDetail, CardFace, faceModel } from "../../../apps/web/src/cards/index.ts";

type CardDef = (typeof CATALOG)[string];

function def(id: string): CardDef {
  const found = CATALOG[id];
  if (found === undefined) throw new Error(`no ${id}`);
  return found;
}

/** WCAG relative luminance of a computed `rgb(…)`/`rgba(…)` colour. */
function luminance(css: string): number {
  const [r = 0, g = 0, b = 0] = (css.match(/[\d.]+/g) ?? []).map(Number);
  const channel = (value: number): number => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

/** The Radiant rules box's lightest and darkest parchment stops (cards.css). */
const PARCHMENT_STOPS = ["rgb(255, 246, 214)", "rgb(241, 217, 140)"];
/** WCAG AA for body text. */
const AA = 4.5;

function Face({ id, radiant, height = 380 }: { id: string; radiant: boolean; height?: number }) {
  return (
    <div style={{ height, width: height * (5 / 7), margin: 24 }}>
      <CardFace face={faceModel({ defId: id, def: def(id), radiant })} layout="full" />
    </div>
  );
}

describe("R277 a Radiant face's gold marks", () => {
  it("R277 True Strike's 9 is the one mark: gold ink, bold, underlined, and AA on the Radiant parchment", () => {
    cy.mount(<Face id="core-044" radiant />);
    cy.get(".cf-mark").should("have.length", 1).and("have.text", "9");
    cy.get(".cf-mark").should(($mark) => {
      const style = getComputedStyle($mark[0] as Element);
      expect(Number(style.fontWeight), "bold").to.be.at.least(700);
      expect(style.textDecorationLine, "underlined").to.contain("underline");
      for (const stop of PARCHMENT_STOPS) {
        expect(contrast(style.color, stop), `ink ${style.color} on ${stop}`).to.be.at.least(AA);
      }
      // Gold: warm, with more red than blue by a clear margin.
      const [r = 0, , b = 0] = (style.color.match(/[\d.]+/g) ?? []).map(Number);
      expect(r - b, "a warm (gold) ink").to.be.greaterThan(60);
    });
  });

  it("R277 the base face of the same card marks nothing", () => {
    cy.mount(<Face id="core-044" radiant={false} />);
    cy.get(".card-text").should("contain.text", "Deal 4 damage");
    cy.get(".cf-mark").should("not.exist");
  });

  it("R277 on the collection's dark reading panel the mark is the bright gold, still AA", () => {
    cy.mount(<CardDetail def={def("core-013")} onClose={() => undefined} />);
    cy.viewport(390, 844);
    cy.get(".inspect-rules-line--radiant .cf-mark").should("have.text", "5").and(($mark) => {
      const style = getComputedStyle($mark[0] as Element);
      expect(contrast(style.color, "rgb(26, 29, 40)"), "bright gold on the dark panel").to.be.at.least(AA);
    });
  });
});

describe("R279 a reference opens the card it names", () => {
  it("R279 in the detail view, focusing CN-Viral Injection's CN-Virus shows the CN-Virus face in a tooltip", () => {
    cy.viewport(1280, 900);
    cy.mount(
      <CardDefsProvider defs={CATALOG}>
        <CardDetail def={def("core-090")} onClose={() => undefined} />
      </CardDefsProvider>,
    );
    cy.get('[data-testid="inspect-face-radiant"] .cf-ref[data-ref="core-090-1"]').first().focus();
    cy.get('[data-testid="card-ref-tooltip"]')
      .should("be.visible")
      .and("have.attr", "data-ref", "core-090-1")
      .and("have.attr", "data-ref-face", "radiant")
      .within(() => {
        cy.get(".card-name").should("have.text", "CN-Virus");
        cy.get(".card-text").should("contain.text", "take 2 damage");
      });
    cy.get('[data-testid="card-ref-tooltip"]').should(($tip) => {
      const box = ($tip[0] as Element).getBoundingClientRect();
      expect(box.left, "inside the viewport").to.be.at.least(0);
      expect(box.right, "inside the viewport").to.be.at.most(window.innerWidth);
      expect(box.height, "a face, not a sliver").to.be.greaterThan(100);
    });
  });

  it("R279 a mouse resting on Sheepish's Lava Golem opens it too", () => {
    cy.viewport(1280, 900);
    cy.mount(
      <CardDefsProvider defs={CATALOG}>
        <CardDetail def={def("core-041")} onClose={() => undefined} />
      </CardDefsProvider>,
    );
    cy.get('[data-testid="inspect-face-radiant"] .cf-ref[data-ref="core-055"]').first().trigger("pointerenter", { pointerType: "mouse" });
    cy.get('[data-testid="card-ref-tooltip"]').should("be.visible").find(".card-name").should("have.text", "Lava Golem");
  });
});

describe("R280 a computed value in a face in play", () => {
  it("R280 #31's {3} sits right after its formula and inside the rules box", () => {
    const face = faceModel({
      defId: "core-031",
      def: def("core-031"),
      radiant: false,
      liveCost: 3,
      inPlay: { preview: [{ label: "Fib(cost+1)", value: 3 }] },
    });
    cy.mount(
      <div style={{ height: 380, width: 380 * (5 / 7), margin: 24 }}>
        <CardFace face={face} layout="full" />
      </div>,
    );
    cy.get(".cf-value").should("have.text", "{3}");
    cy.get(".card-text").should("contain.text", "Fib(cost+1) {3} damage").and(($text) => {
      const box = ($text[0] as Element).getBoundingClientRect();
      const value = ($text[0] as Element).querySelector(".cf-value")?.getBoundingClientRect();
      expect(value, "the value is drawn").to.not.equal(undefined);
      if (value === undefined) return;
      expect(value.right, "inside the rules box").to.be.at.most(box.right + 1);
      expect(value.bottom, "inside the rules box").to.be.at.most(box.bottom + 1);
    });
  });
});
