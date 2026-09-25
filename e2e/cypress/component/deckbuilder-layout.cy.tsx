// Polish 6, B39: the deck builder with the real catalog has no horizontal overflow at 390x844 and
// 1280x720, and shows at least two pool columns on the phone (docs/polish/6-cards.md). It also
// holds B29's layout half: the detail view's two faces sit side by side at both sizes.
//
// jsdom has no layout, so the workshop's own tests can only prove structure. This spec puts the
// builder in front of a real layout engine with the heaviest pool it ever shows: every one of the
// 100 deckable Core cards as a full CardFace, a full deck of 20 open in the sidebar, and three
// saved decks and a trio in the rail.
//
// THE MOUNT. The deck builder is now the deck workshop (SPEC §9.4, R250–R256): `DeckWorkshop`, the
// component `/decks` renders once its reads have landed, whose own root is the page shell —
// `div.app-shell.app-shell--wide.deckbuilder.workshop [workshop]`. So it is mounted bare, as the
// route mounts it, and the first assertion is that its root really carries both shell classes.
// Wrapping it in a second `.app-shell--wide` would take another 24px off the phone, a width the
// builder never gets on /decks, and the two-column check would then measure a page that does not
// exist. Its I/O is four stubs that resolve (nothing here is about saving), `storage: null` keeps
// the local mirror out of the measurement, and `initialOpen` opens the full deck — on a phone the
// rail and the editor take turns (`data-view`), and it is the editor, pool and all, that has to fit.
//
// WHAT IS MEASURED, as board-layout.cy.tsx does for the board: documentElement, body and the
// workshop's own scrollWidth, each at most the viewport width. Two controls keep "it fits" from
// being satisfied by a builder that is not there: all 100 pool items are present, and the workshop
// spans the viewport. Each measure sits inside `.should()`, so it retries while the fonts, the
// procedural art and `useFitText` settle.

import { DECK_NAME_MAX_LENGTH, MAX_SAVED_DECKS, MAX_SAVED_TRIOS } from "../../../apps/server/src/config.ts";
import DeckWorkshop, { type WorkshopOpen } from "../../../apps/web/src/game/deckbuilder/DeckWorkshop.tsx";
import type { DecksResponse } from "../../../apps/web/src/net/api.ts";
import { CATALOG, CATALOG_VERSION } from "../../../packages/cards/src/catalog-data.ts";
import { FIT_FLOOR_PX, TEXT_TIER_MAX } from "../../../apps/web/src/cards/constants.ts";
import { faceModel } from "../../../apps/web/src/cards/model.ts";
import {
  CARD_POOL,
  DB_DETAIL_ADD,
  DB_FILTERS,
  DB_SIDEBAR,
  DECK_EDITOR,
  DECK_VERDICT,
  INSPECT_CLOSE,
  INSPECT_DETAIL,
  INSPECT_FACE_BASE,
  INSPECT_FACE_RADIANT,
  LOADOUT_ERRORS,
  WORKSHOP,
  poolCardId,
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

/** Three disjoint decks of 20, in catalog order, and a trio of them: a legal Best-of-3 choice. */
const DECK_SIZE = 20;
const SAVED_AT = 0;
const DECK_IDS = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
  "00000000-0000-4000-8000-000000000003",
] as const;
const TRIO_ID = "00000000-0000-4000-8000-000000000004";

function decksResponse(decks: readonly (readonly string[])[]): DecksResponse {
  return {
    catalogVersion: CATALOG_VERSION,
    decks: decks.map((cards, at) => ({
      id: DECK_IDS[at] ?? DECK_IDS[0],
      name: `Deck ${String(at + 1)}`,
      cards: [...cards],
      catalogVersion: CATALOG_VERSION,
      createdAt: SAVED_AT + at,
      updatedAt: SAVED_AT + at,
    })),
    trios:
      decks.length === DECK_IDS.length
        ? [{ id: TRIO_ID, name: "Trio 1", deckIds: [DECK_IDS[0], DECK_IDS[1], DECK_IDS[2]], createdAt: SAVED_AT, updatedAt: SAVED_AT }]
        : [],
    limits: { decks: MAX_SAVED_DECKS, trios: MAX_SAVED_TRIOS, nameLength: DECK_NAME_MAX_LENGTH },
  };
}

const FULL_DECKS: string[][] = [0, 1, 2].map((deck) =>
  DECKABLE.slice(deck * DECK_SIZE, (deck + 1) * DECK_SIZE).map((def) => def.id),
);

/** Mount the workshop as `/decks` does, with `decks` saved and the first of them open. */
function mountWorkshop(decks: readonly (readonly string[])[]): void {
  const open: WorkshopOpen = { kind: "deck", id: DECK_IDS[0] };
  // Nothing here saves; the stubs only satisfy the prop.
  const api = {
    putDeck: cy.stub().resolves({}),
    deleteDeck: cy.stub().resolves({}),
    putTrio: cy.stub().resolves({}),
    deleteTrio: cy.stub().resolves({}),
  };
  cy.mount(
    <DeckWorkshop
      catalog={{ version: CATALOG_VERSION, cards: CATALOG }}
      collection={COLLECTION}
      data={decksResponse(decks)}
      profileId="component-spec"
      api={api}
      storage={null}
      initialOpen={open}
    />,
  );
}

const POOL_ITEMS = `${ts(CARD_POOL)} .db-item`;

describe("B39 the deck builder fits /decks at 390x844 and 1280x720", () => {
  beforeEach(() => {
    expect(DECKABLE, "the Core set has 100 deckable cards").to.have.length(DECKABLE_COUNT);
    mountWorkshop(FULL_DECKS);
  });

  for (const viewport of VIEWPORTS) {
    const where = `${viewport.label} ${String(viewport.width)}x${String(viewport.height)}`;

    it(`B39 has no horizontal overflow at ${where}`, () => {
      cy.viewport(viewport.width, viewport.height);

      cy.get(ts(WORKSHOP))
        .should("be.visible")
        .and("have.class", "app-shell")
        .and("have.class", "app-shell--wide")
        .and("have.class", "deckbuilder")
        .and("have.attr", "data-view", "editor");
      cy.get(ts(DECK_EDITOR)).should("have.attr", "data-deck", DECK_IDS[0]);
      cy.get(ts(DB_FILTERS)).should("be.visible");
      cy.get(ts(DB_SIDEBAR)).should("be.visible");
      cy.get(POOL_ITEMS).should("have.length", DECKABLE_COUNT);

      cy.document().should((doc) => {
        const builder = doc.querySelector(ts(WORKSHOP));
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

      cy.get(ts(poolCardId(first.id))).click();
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
      cy.get(ts(poolCardId("core-098"))).click();
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
            const printed = face === null ? 0 : face.full.length;
            expect(printed, `${id} clamps only past 260 characters`).to.be.greaterThan(TEXT_TIER_MAX.xl);
          }
        }
        expect(small, "rules text under the floor").to.deep.equal([]);
      });
    });
  }

  // Integration QA: a refused save's reasons rendered under all 100 pool cards on a phone. There is
  // no Save button any more (R256); the deck's verdict sits in its sidebar, on the first screen, at
  // every size — and on a phone, where the sidebar and the pool stack, above the pool, never under
  // its cards. (On a desktop the two are side by side, so "above" means nothing there.)
  for (const viewport of VIEWPORTS) {
    const where = `${viewport.label} ${String(viewport.width)}x${String(viewport.height)}`;
    const stacked = viewport.label === "phone";
    it(`the deck's verdict sits in its sidebar on the first screen${stacked ? ", above the pool," : ""} at ${where}`, () => {
      cy.viewport(viewport.width, viewport.height);
      // An empty deck, so the verdict has something to say (L2: 0 of 20 cards).
      mountWorkshop([[]]);
      cy.get(`${ts(DB_SIDEBAR)} ${ts(DECK_VERDICT)} ${ts(LOADOUT_ERRORS)}`).should("have.attr", "data-count", "1");
      cy.get(POOL_ITEMS).should("have.length", DECKABLE_COUNT);
      cy.document().should((doc) => {
        const verdict = doc.querySelector(ts(DECK_VERDICT))?.getBoundingClientRect();
        const firstCard = doc.querySelector(POOL_ITEMS)?.getBoundingClientRect();
        expect(verdict, "the verdict").to.not.eq(undefined);
        expect(firstCard, "the first pool card").to.not.eq(undefined);
        if (verdict === undefined || firstCard === undefined) return;
        expect(verdict.height, "the verdict is drawn").to.be.greaterThan(0);
        expect(Math.floor(verdict.top), `the verdict starts on the first screen at ${where}`).to.be.below(viewport.height);
        if (stacked) {
          expect(verdict.top, `the verdict starts above the first pool card at ${where}`).to.be.below(firstCard.top);
        }
      });
    });
  }

  it("at 390x844 with a full deck open, the first row of the pool is on the first screen", () => {
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
