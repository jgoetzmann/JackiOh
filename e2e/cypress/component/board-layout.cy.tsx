// BUILD M5-T1's pixel acceptance, measured on the fixture the acceptance names.
//
//   "a snapshot test renders a fixture `PlayerView` with 10 units, 10 backrow cards and a stacked
//    pile WITHOUT LAYOUT OVERFLOW at 1280x720 and 390x844"
//
// The snapshot half has always been green (apps/web/src/game/Board.test.tsx). The four words in
// capitals had never been measured anywhere, and three files said so, each deferring to one of the
// others:
//
//   apps/web/src/game/Board.test.tsx:68  "jsdom has no layout engine … the real pixel check at
//                                         1280x720 and 390x844 is the Cypress spec's job"
//   apps/web/src/game/board.css:5        "The real pixel check is the Cypress spec's"
//   e2e/cypress.config.ts (before this)  "the responsive case (390x844) is a component test there"
//
// `cypress/e2e/12-rotation-and-swaps.cy.ts` closed two thirds of that circle: it measures both
// viewports in a real browser at the end of its run. What it cannot do is measure the board the
// acceptance describes. A seeded game reaches six occupied field zones — four units, one readable
// trap, one face-down back — because no deck fixture in e2e/fixtures/decks holds more than one
// settable backrow card and /dev/hotseat has no state injection. A sparse board is the easy case.
// 10 units and 10 backrow cards is the case that overflows if anything does, and it exists only as
// a fixture.
//
// So this spec mounts that fixture. `fullBoardView()` is the SAME function Board.test.tsx renders
// (apps/web/src/test/fixtures.ts) — not a copy of it here, which would drift — and the browser lays
// it out for real.
//
// ---------------------------------------------------------------------------------------------
// WHY `Game` INSIDE `.app-shell`, AND NOT `Board` ON ITS OWN
// ---------------------------------------------------------------------------------------------
//
// `Board` is never rendered anywhere but inside `Game`, and `Game` is never rendered anywhere but
// inside a `<div className="app-shell">` — routes/dev/hotseat.tsx and routes/match.tsx both do
// exactly that. `.app-shell` has `padding: 12px` (src/index.css), so in the real client the board
// gets the viewport MINUS 24px. Mounting `Board` bare would hand it 24px it never has: a board
// that overflows the phone by 20px would measure as fitting, and the acceptance item would have
// been "closed" by a test that is more generous than the product. The mount is therefore the
// narrowest honest container the board is ever given.
//
// What is deliberately left out is the per-route header (`.match-bar` in /match/<id>,
// `.hotseat-bar` in /dev/hotseat). Those are siblings of the board in a flex COLUMN: they take
// vertical space, never horizontal, so they cost the board nothing that this spec measures — and
// including one would turn a red run into an argument about whose bug it is. This is M5-T1's
// board, measured alone.
//
// ---------------------------------------------------------------------------------------------
// WHAT IS ASSERTED, AND WHY EACH OF THE FOUR
// ---------------------------------------------------------------------------------------------
//
//   documentElement.scrollWidth  the page as a whole. src/index.css sets `body { overflow-x:
//                                hidden }`, which a UA propagates to the viewport, so the worry
//                                was that a document-level overflow would be clipped out of this
//                                number rather than reported by it. Measured, not assumed: under
//                                the probe below it read 1620 against a 1280 viewport and 1618
//                                against a 390 one, so the clip hides the scrollbar, not the
//                                measurement.
//   body.scrollWidth             the content width the body would need.
//   board.scrollWidth            the width the board's own contents need — the five lane columns,
//                                the seat rows, the hands, the control bar. This is the number
//                                that isolates a board-internal overflow: the board is
//                                `width: 100%`, so its right EDGE stays inside the viewport
//                                however far its guts spill past it.
//   board right edge             where the board's border box actually ends on screen.
//
// Two controls, because an assertion that the board "fits" is satisfied perfectly by a board that
// is not there:
//
//   - all 20 field cards are present, and EACH one is visible (`.each`, one assertion per card —
//     see the note at the assertion for why the one-liner it replaced was a fake check). Cypress's
//     visibility check fails an element an overflow-hidden ancestor clips out of existence, so a
//     board that fits by cropping its own right-hand lane fails here rather than passing quietly.
//   - the board's border box really does span the viewport (>= width - 40). A collapsed or
//     unmounted board cannot satisfy this and the "fits" assertions at the same time.
//
// ---------------------------------------------------------------------------------------------
// WHAT IT MEASURED WHEN IT WAS WRITTEN (Electron 146 and Chrome 153, identical to the pixel)
// ---------------------------------------------------------------------------------------------
//
//   desktop 1280x720   document 1280  body 1280  board scrollWidth 1256  right edge 1268
//   phone   390x844    document  390  body  390  board scrollWidth  366  right edge  378
//
// The board is the viewport less `.app-shell`'s 24px, its contents need exactly that much, and
// nothing spills. BUILD M5-T1's 10 units, 10 backrow cards and stacked pile fit both viewports.
//
// One thing the same run records and does NOT assert: at 390x844 the document's scrollHeight is
// 847 against a viewport of 844, so the phone page scrolls about 3px VERTICALLY. The board itself
// is not the overflow — its own box is 806px tall and ends at y=836 — it is the turn banner and
// `.app-shell`'s padding on top of it. That is left as a reading rather than an assertion because
// the vertical budget belongs to whichever route wraps the board: /match/<id> and /dev/hotseat
// each add a header this mount deliberately omits (see above), so an assertion here would be a
// claim about a page this spec is not rendering. It is reported so that the number exists
// somewhere; the acceptance item, and every assertion below, is about horizontal overflow.
//
// ---------------------------------------------------------------------------------------------
// PROOF THAT THIS CAN FAIL (both viewports)
// ---------------------------------------------------------------------------------------------
//
// A layout assertion that never executes is indistinguishable from one that passes. The board's
// own `scrollWidth` assertion was inverted (`to.be.at.most` -> `to.be.greaterThan`) and watched go
// red at BOTH viewports before being reverted:
//
//   AssertionError: Timed out retrying after 4000ms: the board's contents fit desktop 1280x720:
//                   expected 1256 to be above 1280
//   AssertionError: Timed out retrying after 4000ms: the board's contents fit phone 390x844:
//                   expected 366 to be above 390
//
// 1256 and 366 are the board's real widths — the viewport less `.app-shell`'s 24px of padding —
// so the assertion is executing against the board this spec claims to measure. The whole measured
// set is in the run's terminal output, one `[M5-T1 layout]` line per viewport (the `layout:report`
// task in cypress.config.ts).
//
// The inversion proves the assertion RUNS. A second probe proved it is SENSITIVE to the thing it
// is about: a stylesheet carrying `.field { min-width: 1600px }` was appended to the mounted
// document, and the run went red at both sizes on the first of the four measures —
//
//   AssertionError: Timed out retrying after 4000ms: the document fits desktop 1280x720:
//                   expected 1620 to be at most 1280
//   AssertionError: Timed out retrying after 4000ms: the document fits phone 390x844:
//                   expected 1618 to be at most 390
//
// — so a board wider than its viewport is seen and reported, not silently clipped.
//
// A third probe went after the CONTROL rather than the measurement, and caught this spec's own
// first draft: with `.field .lane[data-lane="5"] .card { display: none }` injected — the fifth
// lane's four cards gone — the per-card loop goes red,
//
//   AssertionError: Timed out retrying after 4000ms: expected '<div.card.card-back.card-backrow>'
//                   to be 'visible'
//
// while the `.and("be.visible")` one-liner it replaced stayed GREEN. See the assertion itself.
//
// None of the three probes is kept: a spec that ships its own overflow would be measuring itself.

import Game from "../../../apps/web/src/game/Game.tsx";
import { fullBoardView } from "../../../apps/web/src/test/fixtures.ts";

/** BUILD M5-T1's two viewports. The first is also this project's configured default. */
const VIEWPORTS = [
  { label: "desktop", width: 1280, height: 720 },
  { label: "phone", width: 390, height: 844 },
] as const;

type Viewport = (typeof VIEWPORTS)[number];

/** `[data-testid="board"]` — `apps/web/src/game/contract.ts` `testid.board`. */
const BOARD = '[data-testid="board"]';

/**
 * Every card the field draws: `.card` is on face-up cards and face-down backs alike
 * (`Card.tsx` gives a back `cx("card", "card-back", …)`), and the `.field` element holds the four
 * rows of five lanes and nothing else — the hands, the piles and the resolving zone are outside
 * it. So this is 10 units + 10 backrow cards, and it is 20 or the fixture is not M5-T1's.
 */
const FIELD_CARDS = `${BOARD} .field .card`;
const FIELD_CARD_COUNT = 20;

/** One measured viewport, as it reaches the terminal. */
type Measurement = {
  viewport: string;
  viewportWidth: number;
  documentScrollWidth: number;
  bodyScrollWidth: number;
  boardScrollWidth: number;
  boardRight: number;
  boardWidth: number;
  /** Recorded, never asserted — see the note where these are filled in. */
  documentScrollHeight: number;
  boardHeight: number;
  boardBottom: number;
};

function measure(doc: Document, viewport: Viewport, board: Element): Measurement {
  const box = board.getBoundingClientRect();
  return {
    viewport: `${viewport.label} ${viewport.width}x${viewport.height}`,
    viewportWidth: viewport.width,
    documentScrollWidth: doc.documentElement.scrollWidth,
    bodyScrollWidth: doc.body.scrollWidth,
    boardScrollWidth: board.scrollWidth,
    boardRight: Math.ceil(box.right),
    boardWidth: Math.round(box.width),
    documentScrollHeight: doc.documentElement.scrollHeight,
    boardHeight: Math.round(box.height),
    boardBottom: Math.ceil(box.bottom),
  };
}

describe("BUILD M5-T1 — the full fixture board fits 1280x720 and 390x844", () => {
  beforeEach(() => {
    // The premise, asserted rather than assumed, in the fixture this spec is about to mount. One
    // `null` in a backrow lane once left `fullBoardView()` with 9 backrow cards while every test
    // that rendered it still passed (see Board.test.tsx:67) — and a sparse board is precisely the
    // easy case this spec exists to stop standing in for the hard one.
    const view = fullBoardView();
    const units = [...view.you.units, ...view.opponent.units].filter((unit) => unit !== null);
    const backrow = [...view.you.backrow, ...view.opponent.backrow].filter((slot) => slot !== null);

    expect(units, "BUILD M5-T1: the fixture board holds 10 units").to.have.length(10);
    expect(backrow, "BUILD M5-T1: the fixture board holds 10 backrow cards").to.have.length(10);
    expect(
      units.filter((unit) => unit.buried > 0),
      "BUILD M5-T1: a stacked pile",
    ).to.have.length.greaterThan(0);

    // `legal: []` is the honest default for a board nobody has told what is legal: `NO_HIGHLIGHT`,
    // everything greyed out (Board.tsx). It changes borders and opacity, never geometry. `pending`
    // is null in this fixture, so `Prompt` renders nothing and no modal covers the measurement.
    cy.mount(
      <div className="app-shell">
        <Game view={view} legal={[]} onAction={() => undefined} />
      </div>,
    );
  });

  for (const viewport of VIEWPORTS) {
    const where = `${viewport.label} ${viewport.width}x${viewport.height}`;

    it(`draws all 20 field cards with no horizontal overflow at ${where}`, () => {
      cy.viewport(viewport.width, viewport.height);

      cy.get(BOARD).should("be.visible");
      // Both controls: the board really drew the 10/10 fixture, and nothing clipped a card out of
      // existence to make the rest fit.
      //
      // `.each` with a per-element assertion, NOT `.and("be.visible")` on the collection. That
      // shorter form was written here first and probed: with `.field .lane[data-lane="5"] .card
      // { display: none }` injected — four of the twenty cards gone — the spec stayed GREEN, and
      // only went red when all twenty were hidden. Cypress's collection form inherits jQuery's
      // `:visible`, which is satisfied by ANY matching element. A board that fits by dropping its
      // fifth lane is exactly what this control exists to catch, so it is asserted card by card.
      cy.get(FIELD_CARDS)
        .should("have.length", FIELD_CARD_COUNT)
        .each(($card) => {
          cy.wrap($card, { log: false }).should("be.visible");
        });

      const out: { measured?: Measurement } = {};

      // `should`, not `then`: a viewport change relays out asynchronously, so this retries until
      // the layout settles instead of reading whichever frame happened to be current.
      cy.document({ log: false }).should((doc) => {
        const board = doc.querySelector(BOARD);
        expect(board, "the board is mounted").to.not.eq(null);
        if (board === null) return;

        const m = measure(doc, viewport, board);

        expect(m.documentScrollWidth, `the document fits ${where}`).to.be.at.most(viewport.width);
        expect(m.bodyScrollWidth, `the body fits ${where}`).to.be.at.most(viewport.width);
        expect(m.boardScrollWidth, `the board's contents fit ${where}`).to.be.at.most(viewport.width);
        expect(m.boardRight, `the board's right edge is inside ${where}`).to.be.at.most(viewport.width);

        // The control that keeps the three above honest: `.app-shell` costs the board 24px of
        // padding and nothing else may, so a board narrower than this is a board that collapsed,
        // and a collapsed board trivially "fits".
        expect(m.boardWidth, `the board spans ${where} (minus .app-shell's padding)`).to.be.at.least(
          viewport.width - 40,
        );

        out.measured = m;
      });

      // Into the run's terminal output: an assertion nobody can read the numbers of is half a
      // measurement. `documentScrollHeight` rides along unasserted on purpose — the vertical budget
      // is shared with route chrome this mount deliberately omits (see the header), so a vertical
      // assertion here would be measuring something other than the board.
      cy.then(() => {
        cy.task("layout:report", out.measured, { log: false });
      });
    });
  }
});
