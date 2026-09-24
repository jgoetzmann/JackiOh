// The practice table (apps/web/src/practice/table.css) at the viewports practice is played on,
// measured on the M5-T1 fixture board with a hand of 4, 7 and 10 cards.
//
// The skin makes the page exactly one screen tall with `overflow: hidden`, so anything it lays out
// past the viewport is not scrolled to: it is gone. Two things the first skin got wrong are pinned
// here, each a public part of the view (§10.8) that has to stay on screen:
//
//   - every card in the player's hand lies inside the viewport, however many there are. A 7-card
//     hand at 768x720 once put its last card 14 px past the right edge, where it could not be
//     clicked, because the fan's overlap was fixed per card count rather than fitted to the room;
//   - R169's modifier badges (`modifiers-<side>`), the plague and grade counters, and a Stack's
//     buried count are drawn at every size. The skin once hid the badge list on every portrait
//     screen and on landscape phones, and the counters and buried count in every narrow lane,
//     which brought back exactly the invisible modifiers R169 exists to prevent.
//
// The mount is the route's own shell (routes/practice.tsx): `.app-shell--wide.practice--game`
// with a HUD row above `.practice-board.practice-table`, so the table gets the height it really has.

import Game from "../../../apps/web/src/game/Game.tsx";
import "../../../apps/web/src/practice/practice.css";
import "../../../apps/web/src/practice/table.css";
import { card, fullBoardView } from "../../../apps/web/src/test/fixtures.ts";

const VIEWPORTS = [
  { label: "desktop", width: 1280, height: 720 },
  { label: "half-screen laptop", width: 768, height: 720 },
  { label: "phone landscape", width: 844, height: 390 },
  { label: "phone portrait", width: 390, height: 844 },
  { label: "tablet portrait", width: 768, height: 1024 },
] as const;

const HAND_SIZES = [4, 7, 10] as const;

const HAND_CARD_IDS = [
  "core-002", "core-019", "core-055", "core-077", "core-011",
  "core-013", "core-025", "core-054", "core-066", "core-068",
] as const;

/** Sub-pixel rounding at a fractional overlap; nothing a player could miss a card by. */
const EPSILON = 1;

function mountTable(handSize: number): void {
  const view = fullBoardView();
  const hand = HAND_CARD_IDS.slice(0, handSize).map((defId, index) => card({ defId, cost: index % 5 }));
  const withHand = { ...view, you: { ...view.you, hand } };
  cy.mount(
    <div className="app-shell app-shell--wide practice practice--game">
      <header className="practice-hud" data-testid="practice-hud">
        <span className="practice-hud__tier">Practice Easy</span>
      </header>
      <div className="practice-board practice-table" data-difficulty="easy" data-thinking="false">
        <Game view={withHand} legal={[]} onAction={() => undefined} />
      </div>
    </div>,
  );
}

/** Visible in the sense a player means: displayed, with an area, and inside the viewport. */
function expectOnScreen(element: Element, label: string, width: number, height: number): void {
  const style = getComputedStyle(element);
  expect(style.display, `${label} is displayed`).to.not.eq("none");
  expect(style.visibility, `${label} is not hidden`).to.not.eq("hidden");
  const box = element.getBoundingClientRect();
  expect(box.width, `${label} has a width`).to.be.greaterThan(0);
  expect(box.height, `${label} has a height`).to.be.greaterThan(0);
  expect(box.left, `${label} starts inside the viewport`).to.be.at.least(-EPSILON);
  expect(box.top, `${label} starts inside the viewport`).to.be.at.least(-EPSILON);
  expect(box.right, `${label} ends inside ${String(width)} px`).to.be.at.most(width + EPSILON);
  expect(box.bottom, `${label} ends inside ${String(height)} px`).to.be.at.most(height + EPSILON);
}

describe("the practice table keeps the hand, the modifiers and the counters on screen", () => {
  for (const viewport of VIEWPORTS) {
    for (const handSize of HAND_SIZES) {
      const where = `${viewport.label} ${String(viewport.width)}x${String(viewport.height)}`;

      it(`${where}, ${String(handSize)} cards in hand`, () => {
        cy.viewport(viewport.width, viewport.height);
        mountTable(handSize);

        cy.get('[data-testid="board"]').should("be.visible");
        cy.get(".hand-you .hand-cards > .card").should("have.length", handSize);

        cy.document().should((doc) => {
          const handCards = [...doc.querySelectorAll(".hand-you .hand-cards > .card")];
          expect(handCards, "the hand is drawn").to.have.length(handSize);
          handCards.forEach((element, index) => {
            expectOnScreen(element, `hand card ${String(index + 1)} of ${String(handSize)}`, viewport.width, viewport.height);
          });
          // A card must show enough of itself to be clicked: at least 12 px of its left edge.
          for (let index = 0; index + 1 < handCards.length; index += 1) {
            const here = (handCards[index] as Element).getBoundingClientRect();
            const next = (handCards[index + 1] as Element).getBoundingClientRect();
            expect(next.left - here.left, `hand card ${String(index + 1)} shows a clickable edge`).to.be.at.least(12);
          }

          for (const side of ["you", "opponent"] as const) {
            const badges = doc.querySelector(`[data-testid="modifiers-${side}"]`);
            expect(badges, `modifiers-${side} is in the DOM`).to.not.eq(null);
            if (badges !== null) expectOnScreen(badges, `modifiers-${side}`, viewport.width, viewport.height);
          }

          const counters = [...doc.querySelectorAll(".field .card-unit .counter")];
          expect(counters, "the fixture's plague and grade counters on units").to.have.length(3);
          counters.forEach((element) => {
            expectOnScreen(element, `counter ${element.getAttribute("data-counter") ?? ""}`, viewport.width, viewport.height);
          });

          const buried = [...doc.querySelectorAll(".field .card-unit .buried-badge")];
          expect(buried, "the fixture's Stack pile").to.have.length(1);
          buried.forEach((element) => {
            expectOnScreen(element, "the Stack's buried count", viewport.width, viewport.height);
          });
        });
      });
    }
  }
});
