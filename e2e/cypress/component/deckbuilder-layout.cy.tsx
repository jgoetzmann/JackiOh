// Polish 6, B39: the deck builder with the real catalog has no horizontal overflow at 390x844 and
// 1280x720, and shows at least two pool columns on the phone (docs/polish/6-cards.md). It also
// holds B29's layout half: the detail view's two faces sit side by side at both sizes.
//
// jsdom has no layout, so browse.test.tsx can only prove structure. This spec puts the builder in
// front of a real layout engine with the heaviest pool it ever shows: every one of the 100
// deckable Core cards as a full CardFace, and a legal three-deck loadout filling the sidebar.
//
// THE MOUNT. The Surface's screen structure makes the builder's own root the page shell:
// `div.app-shell.app-shell--wide.deckbuilder [deckbuilder]`, and spec 09 waits on that testid as
// "the builder itself, not the route". So the builder is mounted bare, and the first assertion is
// that its root really carries both shell classes. Wrapping it in a second `.app-shell--wide` would
// take another 24px off the phone, a width the builder never gets on /decks, and the two-column
// check would then measure a page that does not exist.
//
// WHAT IS MEASURED, as board-layout.cy.tsx does for the board: documentElement, body and the
// builder's own scrollWidth, each at most the viewport width. Two controls keep "it fits" from
// being satisfied by a builder that is not there: all 100 pool items are present, and the builder
// spans the viewport. Each measure sits inside `.should()`, so it retries while the fonts, the
// procedural art and `useFitText` settle.

import Deckbuilder from "../../../apps/web/src/game/deckbuilder/Deckbuilder.tsx";
import { CATALOG, CATALOG_VERSION } from "../../../packages/cards/src/catalog-data.ts";
import { FIT_FLOOR_PX, TEXT_TIER_MAX } from "../../../apps/web/src/cards/constants.ts";
import { faceModel } from "../../../apps/web/src/cards/model.ts";
import {
  CARD_POOL,
  DB_FILTERS,
  DB_SIDEBAR,
  LOADOUT_ERRORS,
  LOADOUT_SAVE,
  DECKBUILDER,
  INSPECT_DETAIL,
  INSPECT_FACE_BASE,
  INSPECT_FACE_RADIANT,
  DB_DETAIL_ADD,
  INSPECT_CLOSE,
  cardPoolId,
  ts,
} from "../../support/testids.ts";

const VIEWPORTS = [
  { label: "phone", width: 390, height: 844 },
  { label: "desktop", width: 1280, height: 720 },
] as const;

/** The deckable cards: no token, by flag or by tag, the same test the validator's L3 applies. */
const DECKABLE = Object.values(CATALOG).filter((def) => !def.token && !def.tags.includes("Token"));
const DECKABLE_COUNT = 100;

/** A collection owning every deckable card once. */
const COLLECTION: Record<string, number> = Object.fromEntries(DECKABLE.map((def) => [def.id, 1]));

/** Three disjoint decks of 20, in catalog order: a legal loadout, so the sidebar is full. */
const DECK_SIZE = 20;
const DECKS: string[][] = [0, 1, 2].map((deck) =>
  DECKABLE.slice(deck * DECK_SIZE, (deck + 1) * DECK_SIZE).map((def) => def.id),
);

const POOL_ITEMS = `${ts(CARD_POOL)} .db-item`;

describe("B39 the deck builder fits /decks at 390x844 and 1280x720", () => {
  beforeEach(() => {
    expect(DECKABLE, "the Core set has 100 deckable cards").to.have.length(DECKABLE_COUNT);
    // Nothing here saves; the stub only satisfies the prop.
    const save = cy.stub().resolves({ ok: true });
    cy.mount(
      <Deckbuilder
        catalog={{ version: CATALOG_VERSION, cards: CATALOG }}
        collection={COLLECTION}
        initialDecks={DECKS}
        save={save}
      />,
    );
  });

  for (const viewport of VIEWPORTS) {
    const where = `${viewport.label} ${String(viewport.width)}x${String(viewport.height)}`;

    it(`B39 has no horizontal overflow at ${where}`, () => {
      cy.viewport(viewport.width, viewport.height);

      cy.get(ts(DECKBUILDER))
        .should("be.visible")
        .and("have.class", "app-shell")
        .and("have.class", "app-shell--wide");
      cy.get(ts(DB_FILTERS)).should("be.visible");
      cy.get(ts(DB_SIDEBAR)).should("be.visible");
      cy.get(POOL_ITEMS).should("have.length", DECKABLE_COUNT);

      cy.document().should((doc) => {
        const builder = doc.querySelector(ts(DECKBUILDER));
        expect(builder, "the builder is mounted").to.not.eq(null);
        if (builder === null) return;

        expect(doc.documentElement.scrollWidth, `the document fits ${where}`).to.be.at.most(viewport.width);
        expect(doc.body.scrollWidth, `the body fits ${where}`).to.be.at.most(viewport.width);
        expect(builder.scrollWidth, `the builder's contents fit ${where}`).to.be.at.most(viewport.width);
        expect(Math.ceil(builder.getBoundingClientRect().right), `the builder ends inside ${where}`).to.be.at.most(
          viewport.width,
        );
        // The control: a collapsed builder would trivially fit.
        expect(builder.getBoundingClientRect().width, `the builder spans ${where}`).to.be.at.least(viewport.width - 40);
      });
    });
  }

  // B29 is jsdom-only in CardDetail.test.tsx, which can prove DOM order but not "side by side at
  // every width". Here the detail opens from a click on the pool card, as on /decks, and the two
  // faces are measured: one row, base on the left, no overlap, both inside the viewport and drawn.
  for (const viewport of VIEWPORTS) {
    const where = `${viewport.label} ${String(viewport.width)}x${String(viewport.height)}`;

    it(`B29 the detail view shows the base and radiant faces side by side at ${where}`, () => {
      cy.viewport(viewport.width, viewport.height);
      const first = DECKABLE[0];
      expect(first, "a deckable card to inspect").to.not.eq(undefined);
      if (first === undefined) return;

      cy.get(ts(cardPoolId(first.id))).click();
      cy.get(ts(INSPECT_DETAIL)).should("be.visible");
      cy.document().should((doc) => {
        const base = doc.querySelector(ts(INSPECT_FACE_BASE));
        const radiant = doc.querySelector(ts(INSPECT_FACE_RADIANT));
        expect(base, "the base face").to.not.eq(null);
        expect(radiant, "the radiant face").to.not.eq(null);
        if (base === null || radiant === null) return;
        const b = base.getBoundingClientRect();
        const r = radiant.getBoundingClientRect();

        expect(b.width, `the base face has a size at ${where}`).to.be.greaterThan(0);
        expect(r.width, `the radiant face has a size at ${where}`).to.be.greaterThan(0);
        expect(Math.abs(b.top - r.top), `both faces start on one row at ${where}`).to.be.at.most(1);
        expect(b.right, `the base face ends before the radiant one starts at ${where}`).to.be.at.most(r.left + 1);
        expect(Math.floor(b.left), `the base face starts inside ${where}`).to.be.at.least(0);
        expect(Math.ceil(r.right), `the radiant face ends inside ${where}`).to.be.at.most(viewport.width);
      });
    });
  }

  // The longest card's detail used to run 300 px past a 1280x720 screen, with Add and Close (and
  // the focus, on Close) below the fold. The actions row is pinned: both are on screen on open.
  for (const viewport of VIEWPORTS) {
    const where = `${viewport.label} ${String(viewport.width)}x${String(viewport.height)}`;

    it(`B38 the detail's Add to Deck and Close are on screen as it opens, for the longest card, at ${where}`, () => {
      cy.viewport(viewport.width, viewport.height);
      cy.get(ts(cardPoolId("core-098"))).click();
      cy.get(ts(INSPECT_DETAIL)).should("be.visible");
      cy.document().should((doc) => {
        for (const id of [DB_DETAIL_ADD, INSPECT_CLOSE]) {
          const box = doc.querySelector(ts(id))?.getBoundingClientRect();
          expect(box, id).to.not.eq(undefined);
          if (box === undefined) continue;
          expect(box.height, `${id} is drawn`).to.be.greaterThan(0);
          expect(Math.floor(box.top), `${id} starts on screen at ${where}`).to.be.at.least(0);
          expect(Math.ceil(box.bottom), `${id} ends on screen at ${where}`).to.be.at.most(viewport.height);
        }
        expect(doc.activeElement?.getAttribute("data-testid"), "focus lands on Close").to.eq(INSPECT_CLOSE);
      });
    });
  }

  // On a desktop the pool scrolls inside its column; its bottom edge (and its scrollbar) used to
  // sit 90 px below a 720 px screen, under a page that scrolled as well.
  it("B39 at 1280x720 the pool's own bottom edge is on screen and the page itself does not scroll", () => {
    cy.viewport(1280, 720);
    cy.get(POOL_ITEMS).should("have.length", DECKABLE_COUNT);
    cy.document().should((doc) => {
      const pool = doc.querySelector(ts(CARD_POOL));
      expect(pool, "the pool").to.not.eq(null);
      if (pool === null) return;
      expect(Math.ceil(pool.getBoundingClientRect().bottom), "the pool ends on screen").to.be.at.most(720);
      expect(pool.scrollHeight, "the pool scrolls inside itself").to.be.greaterThan(pool.clientHeight);
      expect(doc.documentElement.scrollHeight, "the page fits the screen").to.be.at.most(720 + 1);
    });
  });

  // Integration QA: at 1280x720 the pool held one row of cards (a 164 px filter block over
  // 213 px cards); Hearthstone's collection shows two. The chip rows fold on a short screen and the
  // cards size to the screen's height.
  it("the pool shows two whole rows of cards at 1280x720", () => {
    cy.viewport(1280, 720);
    cy.get(POOL_ITEMS).should("have.length", DECKABLE_COUNT);
    cy.document().should((doc) => {
      const pool = doc.querySelector(ts(CARD_POOL));
      expect(pool, "the pool").to.not.eq(null);
      if (pool === null) return;
      const bottom = pool.getBoundingClientRect().bottom;
      const items = [...pool.querySelectorAll<HTMLElement>(".db-item")];
      const tops = [...new Set(items.map((item) => Math.round(item.getBoundingClientRect().top)))].sort((a, b) => a - b);
      expect(tops.length, "rows").to.be.at.least(2);
      const second = items.find((item) => Math.round(item.getBoundingClientRect().top) === tops[1]);
      expect(second, "a card in the second row").to.not.eq(undefined);
      if (second === undefined) return;
      expect(Math.ceil(second.getBoundingClientRect().bottom), "the second row ends inside the pool").to.be.at.most(Math.ceil(bottom));
    });
  });

  // Integration QA: dense cards printed their rules at 6-7 px in the grid. Every face now prints at
  // the floor or above: the long layout first, then a clamp at the floor (fit.ts), and only the
  // texts past 260 characters (B15's allowance) may clamp.
  for (const viewport of VIEWPORTS) {
    const where = `${viewport.label} ${String(viewport.width)}x${String(viewport.height)}`;
    it(`every pool card's rules text is at least ${String(FIT_FLOOR_PX)} px at ${where}`, () => {
      cy.viewport(viewport.width, viewport.height);
      cy.get(POOL_ITEMS).should("have.length", DECKABLE_COUNT);
      cy.document().should((doc) => {
        const small: string[] = [];
        for (const text of doc.querySelectorAll<HTMLElement>(`${ts(CARD_POOL)} .card-text`)) {
          const px = parseFloat(getComputedStyle(text).fontSize);
          const id = text.closest(".db-item")?.getAttribute("data-card") ?? "?";
          if (px < FIT_FLOOR_PX - 0.05) small.push(`${id} at ${px.toFixed(2)}px`);
          if (text.getAttribute("data-clamped") === "true") {
            const def = CATALOG[id];
            const face = def === undefined ? null : faceModel({ defId: id, def, radiant: false }).text;
            const printed = face === null ? 0 : face.base.length + (face.radiant?.length ?? 0);
            expect(printed, `${id} clamps only past 260 characters`).to.be.greaterThan(TEXT_TIER_MAX.xl);
          }
        }
        expect(small, "rules text under the floor").to.deep.equal([]);
      });
    });
  }

  // Integration QA: a refused save's reasons rendered under all 100 pool cards on a phone. They sit
  // in the sidebar, directly under Save, at every size.
  for (const viewport of VIEWPORTS) {
    const where = `${viewport.label} ${String(viewport.width)}x${String(viewport.height)}`;
    it(`the verdicts sit directly under Save at ${where}`, () => {
      cy.viewport(viewport.width, viewport.height);
      // A fresh account: three empty decks, so the list has something to say (the legal loadout
      // the other tests mount has no verdict at all).
      cy.mount(
        <Deckbuilder
          catalog={{ version: CATALOG_VERSION, cards: CATALOG }}
          collection={COLLECTION}
          initialDecks={null}
          save={cy.stub().resolves({ ok: true })}
        />,
      );
      cy.get(`${ts(DB_SIDEBAR)} ${ts(LOADOUT_ERRORS)}`).should("have.attr", "data-count", "3");
      cy.document().should((doc) => {
        const save = doc.querySelector(ts(LOADOUT_SAVE))?.getBoundingClientRect();
        const errors = doc.querySelector(ts(LOADOUT_ERRORS))?.getBoundingClientRect();
        expect(save, "Save").to.not.eq(undefined);
        expect(errors, "the verdict list").to.not.eq(undefined);
        if (save === undefined || errors === undefined) return;
        expect(errors.top - save.bottom, "the verdicts start within 40 px under Save").to.be.within(-1, 40);
      });
    });
  }

  it("at 390x844 with a full loadout, the first row of the pool is on the first screen", () => {
    cy.viewport(390, 844);
    cy.get(POOL_ITEMS).should("have.length", DECKABLE_COUNT);
    cy.document().should((doc) => {
      const first = doc.querySelector(POOL_ITEMS);
      expect(first, "the first pool card").to.not.eq(null);
      if (first === null) return;
      expect(Math.ceil(first.getBoundingClientRect().bottom), "it ends on the first screen").to.be.at.most(844);
    });
  });

  it("B39 shows at least two pool columns at 390 px", () => {
    cy.viewport(390, 844);
    cy.get(POOL_ITEMS).should(($items) => {
      const firstRow = $items.toArray().slice(0, 4) as HTMLElement[];
      expect(firstRow, "at least four pool items to compare").to.have.length(4);
      const lefts = new Set(firstRow.map((item) => item.offsetLeft));
      expect(lefts.size, "distinct offsetLeft values among the first pool items").to.be.at.least(2);
    });
  });

  it("B39 keeps every pool item inside the viewport at 390 px", () => {
    cy.viewport(390, 844);
    cy.get(POOL_ITEMS).should(($items) => {
      for (const item of $items.toArray()) {
        const box = item.getBoundingClientRect();
        expect(box.width, "a pool item has a width").to.be.greaterThan(0);
        expect(Math.ceil(box.right), `${item.getAttribute("data-card") ?? "?"} ends inside 390`).to.be.at.most(390);
        expect(Math.floor(box.left), `${item.getAttribute("data-card") ?? "?"} starts inside 390`).to.be.at.least(0);
      }
    });
  });
});
