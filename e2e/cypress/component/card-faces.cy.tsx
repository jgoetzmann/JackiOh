// Polish 6: the pixel half of the card faces (docs/polish/6-cards.md, behaviours B15 and B21).
//
// jsdom has no layout, so apps/web/src/cards/CardFace.test.tsx can only check the DOM. Whether a
// name and a rules box fit their boxes is a question for a real layout engine, and so is whether
// the board still fits BUILD M5-T1's two viewports once every card on it wears a full face with the
// real catalog's names. Both are measured here, in Chrome, on real client components.
//
//   B15  every catalog card, base and radiant face, as a full CardFace in a 5:7 box 270 px wide
//        and 170 px wide: `.card-name` and `.card-text` stay inside their own boxes on both axes
//        (scroll <= client + 1). At 270 px nothing may clamp; at 170 px only a face whose printed
//        text (base plus radiant clause) runs past 260 characters may carry `data-clamped`.
//   B21  `Game` rendering `fullBoardView()` inside `.app-shell.app-shell--wide`, WITH the real
//        catalog in `CatalogContext`: no horizontal overflow and all 20 field cards visible at
//        1280x720 and 390x844. board-layout.cy.tsx measures the same board with no catalog, where
//        every name is a short def id; this is the long-name case. The centre of every field card
//        must also hit the card itself, because that is where a click lands.
//
// Every measurement sits inside `.should()`, so it retries while `useFitText` settles. Each also
// carries a control, because "fits" is satisfied perfectly by a box that collapsed to nothing:
// the face must fill its 5:7 box, the name must have a box of its own, and the board must span
// the viewport.
//
// The catalog comes from packages/cards/src/catalog-data.ts, the package's one reader of
// catalog.json (e2e/ cannot resolve `@jackioh/cards`). Client code comes from apps/web/src, and
// from outside apps/web/src/cards only through its barrel, cards/index.ts.

import { CATALOG } from "../../../packages/cards/src/catalog-data.ts";
import { CardFace, FACE_ASPECT, TEXT_TIER_MAX, faceModel } from "../../../apps/web/src/cards/index.ts";
import { CatalogContext, lookupFromDefs } from "../../../apps/web/src/game/catalog.ts";
import Game from "../../../apps/web/src/game/Game.tsx";
import { fullBoardView, pendingFor } from "../../../apps/web/src/test/fixtures.ts";

type CardDef = (typeof CATALOG)[string];

const DEFS: readonly CardDef[] = Object.values(CATALOG);

/** Retries cover `useFitText`'s binary search and the ResizeObserver passes behind it. */
const SETTLE_TIMEOUT_MS = 15_000;

/* ----------------------------------------------------------------------------------------- B15 */

type FitBox = { width: number; clampAllowed: boolean };

/** B15's two widths. At 270 px nothing may clamp; at 170 px only the longest texts may. */
const FIT_BOXES: readonly FitBox[] = [
  { width: 270, clampAllowed: false },
  { width: 170, clampAllowed: true },
];

const FACES = [
  { label: "base", radiant: false },
  { label: "radiant", radiant: true },
] as const;

function heightFor(width: number): number {
  return Math.round(width / FACE_ASPECT);
}

/** What the face prints: its text and, on a radiant face, the clause under the gold rule. */
function printedLength(def: CardDef, radiant: boolean): number {
  const text = faceModel({ defId: def.id, def, radiant }).text;
  return text.base.length + (text.radiant?.length ?? 0);
}

function FaceGrid({ width, radiant }: { width: number; radiant: boolean }) {
  const height = heightFor(width);
  return (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-start", gap: 8, padding: 8 }}>
      {DEFS.map((def) => (
        <div key={def.id} data-fit-box={def.id} style={{ width, height, flex: "none" }}>
          <CardFace face={faceModel({ defId: def.id, def, radiant })} layout="full" />
        </div>
      ))}
    </div>
  );
}

/** Every way one face fails B15, as readable lines. Empty means it fits. */
function fitProblems(doc: Document, def: CardDef, box: FitBox, radiant: boolean): string[] {
  const problems: string[] = [];
  const where = `${def.id} (${def.name}) ${radiant ? "radiant" : "base"} at ${box.width}px`;
  const cell = doc.querySelector(`[data-fit-box="${def.id}"]`);
  const cf = cell?.querySelector<HTMLElement>(":scope > .cf") ?? null;
  if (cf === null) return [`${where}: no .cf in its box`];

  // Control: the face fills its 5:7 box, so a collapsed face cannot "fit" by being empty.
  const rect = cf.getBoundingClientRect();
  const height = heightFor(box.width);
  if (Math.abs(rect.width - box.width) > 1 || Math.abs(rect.height - height) > 1) {
    problems.push(`${where}: .cf is ${rect.width}x${rect.height}, not ${box.width}x${height}`);
  }

  for (const selector of [".card-name", ".card-text"]) {
    const el = cf.querySelector<HTMLElement>(selector);
    if (el === null) {
      problems.push(`${where}: no ${selector}`);
      continue;
    }
    if (el.scrollHeight > el.clientHeight + 1) {
      problems.push(`${where}: ${selector} scrollHeight ${el.scrollHeight} > clientHeight ${el.clientHeight} + 1`);
    }
    if (el.scrollWidth > el.clientWidth + 1) {
      problems.push(`${where}: ${selector} scrollWidth ${el.scrollWidth} > clientWidth ${el.clientWidth} + 1`);
    }
  }

  // Controls: the name is there and has a box; a card with text shows its rules box (both
  // widths are well above FACE_TEXT_MIN_HEIGHT_PX, so the container query hides nothing).
  const name = cf.querySelector<HTMLElement>(".card-name");
  if (name !== null) {
    if (name.textContent !== def.name) problems.push(`${where}: .card-name reads "${name.textContent ?? ""}"`);
    if (name.clientWidth === 0 || name.clientHeight === 0) problems.push(`${where}: .card-name has no box`);
  }
  const text = cf.querySelector<HTMLElement>(".card-text");
  if (text !== null && def.base.text !== "" && (text.clientWidth === 0 || text.clientHeight === 0)) {
    problems.push(`${where}: .card-text has no box`);
  }

  const clamped = [...cf.querySelectorAll<HTMLElement>("[data-clamped]")];
  const mayClamp = box.clampAllowed && printedLength(def, radiant) > TEXT_TIER_MAX.xl;
  if (clamped.length > 0 && !mayClamp) {
    const which = clamped.map((el) => `.${(el.getAttribute("class") ?? "").split(/\s+/).join(".")}`).join(", ");
    problems.push(`${where}: data-clamped on ${which} (printed text is ${printedLength(def, radiant)} characters)`);
  }
  for (const el of clamped) {
    if (el.getAttribute("data-clamped") !== "true") problems.push(`${where}: data-clamped="${el.getAttribute("data-clamped") ?? ""}"`);
  }
  return problems;
}

describe("B15: every catalog face fits its name and rules text at 270 px and 170 px", () => {
  it("B15 the premise: the clamp allowance covers exactly the four longest faces (core-093, 095, 098, 051 radiant)", () => {
    const long = DEFS.flatMap((def) =>
      FACES.filter((face) => printedLength(def, face.radiant) > TEXT_TIER_MAX.xl).map((face) => `${def.id} ${face.label}`),
    );
    expect(TEXT_TIER_MAX.xl).to.eq(260);
    expect(long).to.have.members([
      "core-093 base",
      "core-093 radiant",
      "core-095 base",
      "core-095 radiant",
      "core-098 base",
      "core-098 radiant",
      "core-051 radiant",
    ]);
  });

  for (const box of FIT_BOXES) {
    for (const face of FACES) {
      const rule = box.clampAllowed ? "only the longest texts may clamp" : "nothing clamps";
      it(`B15 every ${face.label} face at ${box.width}px wide: name and text within their boxes, ${rule}`, () => {
        cy.mount(<FaceGrid width={box.width} radiant={face.radiant} />);
        cy.get("[data-fit-box] > .cf").should("have.length", DEFS.length);

        cy.document({ log: false, timeout: SETTLE_TIMEOUT_MS }).should((doc) => {
          const problems = DEFS.flatMap((def) => fitProblems(doc, def, box, face.radiant));
          expect(problems, `B15 ${face.label} faces at ${box.width}px`).to.deep.equal([]);
        });
      });
    }
  }
});

/* ------------------------------------------------------------------- Radiant frames, B13/B14 */

// A radiant face is gold foil, but gilds its frame rather than replacing it: the type's panel
// colour and the rarity's edge still show, so a radiant Trap and a radiant Field Trap, or a radiant
// Common and a radiant Rare, never draw the same frame.
describe("radiant frames keep their type and rarity", () => {
  const RADIANT = [
    { id: "core-041", what: "Trap" },
    { id: "core-018", what: "Field Trap" },
    { id: "core-005", what: "Common Spell" },
    { id: "core-017", what: "Rare Spell" },
  ] as const;

  it("the radiant Trap and Field Trap panels differ, and so do the radiant Common and Rare edges", () => {
    cy.mount(
      <div style={{ display: "flex", gap: 8, padding: 8 }}>
        {RADIANT.map(({ id }) => {
          const def = CATALOG[id] as CardDef;
          return (
            <div key={id} data-frame={id} style={{ width: 150, height: heightFor(150) }}>
              <CardFace face={faceModel({ defId: id, def, radiant: true })} layout="full" />
            </div>
          );
        })}
      </div>,
    );
    cy.document().should((doc) => {
      const panel = (id: string): string =>
        getComputedStyle(doc.querySelector(`[data-frame="${id}"] .cf-scale`) as Element).backgroundImage;
      const edge = (id: string): string => getComputedStyle(doc.querySelector(`[data-frame="${id}"] .cf`) as Element).backgroundImage;
      const art = (id: string): string =>
        getComputedStyle(doc.querySelector(`[data-frame="${id}"] .cf-art`) as Element).clipPath;
      expect(panel("core-041"), "radiant Trap vs Field Trap panel").to.not.eq(panel("core-018"));
      expect(art("core-041"), "Trap vs Field Trap window").to.not.eq(art("core-018"));
      expect(edge("core-005"), "radiant Common vs Rare edge").to.not.eq(edge("core-017"));
    });
  });
});

/* ----------------------------------------------------------------------------------------- B21 */

/** BUILD M5-T1's two viewports. */
const VIEWPORTS = [
  { label: "desktop", width: 1280, height: 720 },
  { label: "phone", width: 390, height: 844 },
] as const;

/** `[data-testid="board"]`: apps/web/src/game/contract.ts `testid.board`. */
const BOARD = '[data-testid="board"]';
/** 10 units and 10 backrow cards: `.card` is on faces and backs alike, `.field` holds only lanes. */
const FIELD_CARDS = `${BOARD} .field .card`;
const FIELD_CARD_COUNT = 20;

describe("B21: the full board with the real catalog fits 1280x720 and 390x844", () => {
  beforeEach(() => {
    cy.mount(
      <CatalogContext.Provider value={lookupFromDefs(CATALOG)}>
        <div className="app-shell app-shell--wide">
          <Game view={fullBoardView()} legal={[]} onAction={() => undefined} />
        </div>
      </CatalogContext.Provider>,
    );
  });

  for (const viewport of VIEWPORTS) {
    const where = `${viewport.label} ${viewport.width}x${viewport.height}`;

    it(`B21 all 20 field cards are visible and nothing overflows horizontally at ${where}`, () => {
      cy.viewport(viewport.width, viewport.height);
      cy.get(BOARD).should("be.visible");

      // Control: the catalog really is in, so the board carries full names, not def ids.
      cy.get(`${BOARD} .field .card-name`).should(($names) => {
        const names = $names.toArray().map((el) => el.textContent ?? "");
        expect(names, "catalog names on the field").to.include.members([
          "Gary the Gambler",
          "Echoes of the Forgotten",
          "Jlockeed Shredder-10",
        ]);
        expect(names.filter((name) => /^core-\d/.test(name)), "def ids standing in for names").to.deep.equal([]);
      });

      // Card by card: the collection form of be.visible passes if ANY card is visible (see the
      // note in board-layout.cy.tsx).
      cy.get(FIELD_CARDS)
        .should("have.length", FIELD_CARD_COUNT)
        .each(($card) => {
          cy.wrap($card, { log: false }).should("be.visible");
        });

      cy.document({ log: false }).should((doc) => {
        const board = doc.querySelector(BOARD);
        expect(board, "the board is mounted").to.not.eq(null);
        if (board === null) return;
        const box = board.getBoundingClientRect();

        expect(doc.documentElement.scrollWidth, `the document fits ${where}`).to.be.at.most(viewport.width);
        expect(doc.body.scrollWidth, `the body fits ${where}`).to.be.at.most(viewport.width);
        expect(board.scrollWidth, `the board's contents fit ${where}`).to.be.at.most(viewport.width);
        expect(Math.ceil(box.right), `the board's right edge is inside ${where}`).to.be.at.most(viewport.width);
        // Control: a collapsed board trivially fits; `.app-shell--wide` costs it 24px and no more.
        expect(Math.round(box.width), `the board spans ${where}`).to.be.at.least(viewport.width - 40);
      });
    });

    // Keyword chips are legible (an 8px floor, where scaling with a 59px minion alone gave 4.8px),
    // and the badges beside the face (the switch button, the counters, a Stack's buried count)
    // cover neither the cost gem nor the name plate.
    it(`B21 minion keyword chips are at least 8px, and no badge covers a cost gem or a name at ${where}`, () => {
      cy.viewport(viewport.width, viewport.height);
      cy.get(`${BOARD} .field .keywords`).should("have.length.at.least", 3);

      cy.document({ log: false }).should((doc) => {
        const chips = [...doc.querySelectorAll<HTMLElement>(`${BOARD} .field .keywords > :is(.keyword, .cf-kw-more)`)].filter(
          (chip) => getComputedStyle(chip).display !== "none",
        );
        expect(chips.length, "visible keyword chips").to.be.at.least(3);
        for (const chip of chips) {
          expect(parseFloat(getComputedStyle(chip).fontSize), `chip ${chip.textContent ?? ""} font`).to.be.at.least(8);
          expect(chip.getBoundingClientRect().height, `chip ${chip.textContent ?? ""} height`).to.be.at.least(10);
        }

        const overlap = (a: DOMRect, b: DOMRect): number =>
          Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) *
          Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
        const problems: string[] = [];
        for (const card of doc.querySelectorAll<HTMLElement>(`${BOARD} .field .card.cf-host`)) {
          const name = card.querySelector(".cf .card-name")?.getBoundingClientRect();
          const gem = card.querySelector(".cf .cost-gem")?.getBoundingClientRect();
          for (const badge of card.querySelectorAll<HTMLElement>(":scope > .switch-button, :scope > .counter, :scope > .buried-badge")) {
            const box = badge.getBoundingClientRect();
            const label = `${card.getAttribute("data-testid") ?? "?"} ${badge.className}`;
            if (name !== undefined && overlap(box, name) > 1) problems.push(`${label} covers the name`);
            if (gem !== undefined && overlap(box, gem) > 1) problems.push(`${label} covers the cost gem`);
          }
        }
        expect(problems, `badges over a name or a cost gem at ${where}`).to.deep.equal([]);

        // A damaged or reduced stat reads red, as Hearthstone draws it, not a pale tint of white.
        const toned = [...doc.querySelectorAll<HTMLElement>(`${BOARD} .field .stat:is([data-tone="damaged"], [data-tone="reduced"])`)];
        expect(toned.length, "damaged or reduced stats on the fixture board").to.be.at.least(1);
        for (const stat of toned) {
          const [r = 0, g = 0, b = 0] = (getComputedStyle(stat).color.match(/\d+/g) ?? []).map(Number);
          expect(r - Math.max(g, b), `${stat.className} ${stat.textContent ?? ""} is red`).to.be.at.least(100);
        }
      });
    });

    // Cypress (and a player) clicks a card at its centre. Every field unit carries a switch-position
    // <button>, disabled unless switching is legal, and a disabled button swallows the click, so a
    // badge drawn over the centre makes the card unclickable (found by e2e specs 02, 04 and 11).
    it(`B21 the centre of every field card hits the card itself, not a control inside it, at ${where}`, () => {
      cy.viewport(viewport.width, viewport.height);
      cy.get(`${BOARD} .field [data-testid^="card-"]`).should("have.length.at.least", 10);

      cy.document({ log: false }).should((doc) => {
        const cards = [...doc.querySelectorAll<HTMLElement>(`${BOARD} .field [data-testid^="card-"]`)];
        const covered = cards.flatMap((card) => {
          const rect = card.getBoundingClientRect();
          const hit = doc.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
          const owner = hit?.closest("[data-testid]") ?? null;
          return owner === card ? [] : [`${card.getAttribute("data-testid") ?? "?"} → ${owner?.getAttribute("data-testid") ?? hit?.tagName ?? "nothing"}`];
        });
        expect(covered, `field cards whose centre is covered at ${where}`).to.deep.equal([]);
      });
    });
  }
});

/* -------------------------------------------------------------------------- prompt card options */

// The mulligan is the first thing a player sees in every game. Its options (and Discover's) draw
// the card's face, and the face fills the option box prompt.css gives it: index.css pads every
// `.app-shell button` 9px 16px, which had squeezed the face to 48 px of an 82 px box.
describe("a card option in a prompt draws the card's face across its box", () => {
  for (const viewport of VIEWPORTS) {
    const where = `${viewport.label} ${viewport.width}x${viewport.height}`;

    it(`the mulligan's faces fill their options at ${where}`, () => {
      cy.viewport(viewport.width, viewport.height);
      const base = fullBoardView();
      const hand = Array.isArray(base.you.hand) ? base.you.hand : [];
      const view = {
        ...base,
        pending: pendingFor(
          "mulligan",
          hand.map((card) => ({ key: card.instanceId, label: card.defId, instanceId: card.instanceId })),
          { min: 0, max: hand.length, prompt: "Keep which cards?" },
        ),
      };
      cy.mount(
        <CatalogContext.Provider value={lookupFromDefs(CATALOG)}>
          <div className="app-shell app-shell--wide">
            <Game view={view} legal={[]} onAction={() => undefined} />
          </div>
        </CatalogContext.Provider>,
      );

      cy.document({ log: false }).should((doc) => {
        const options = [...doc.querySelectorAll<HTMLElement>('[data-testid^="prompt-option-"]')];
        expect(options.length, "one option per hand card").to.eq(hand.length);
        for (const option of options) {
          const face = option.querySelector<HTMLElement>(".cf-option > .cf");
          expect(face, "the option draws a face").to.not.eq(null);
          if (face === null) continue;
          const box = option.getBoundingClientRect();
          const drawn = face.getBoundingClientRect();
          const label = option.getAttribute("data-testid") ?? "?";
          expect(drawn.width, `${label} face width`).to.be.at.least(box.width - 12);
          expect(drawn.right, `${label} inside its box`).to.be.at.most(box.right + 0.5);
          expect(face.querySelector(".card-name")?.textContent ?? "", `${label} is named`).to.not.eq("");
        }
      });
    });
  }
});
