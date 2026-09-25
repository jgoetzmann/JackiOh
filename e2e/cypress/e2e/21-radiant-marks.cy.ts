// Spec 21 — the Radiant pass's three marks on a card in play (SPEC §10.10, R277, R279, R280).
//
// What it proves, in a real browser against `pnpm build:e2e` + `vite preview` and no server, on
// `/dev/hotseat`:
//
//   * a computed value (R280): #31 KY's Math Equation in hand carries what its formula comes to now
//     in the view (`CardView.preview`), and its face prints it in braces after the formula —
//     "Fib(cost+1) {1}" at its printed cost of 1 — in the hover preview a resting mouse opens;
//   * a reference (R279): #65 Masochism Mask's text names Spikey Pillow. Resting on the Mask shows
//     the Pillow's face in the preview's "Mentions" column, and in the touch sheet a long press
//     opens the name is a control: tapping it shows the Pillow's face in a tooltip;
//   * a Radiant face's gold (R277): #26 Glowy Jelly Bean makes the Math Equation Radiant in hand,
//     and its face then prints "Fib(cost+3)" with `cost+3` marked (gold, bold, underlined) and the
//     value its Radiant formula comes to, {3}.
//
// House rules (BUILD M8): the seed comes from `seedFor`, there is no fixed `cy.wait(ms)` (a long
// press is held until the sheet is asserted open, a retried assertion), and every selector comes
// from support/testids.ts.
//
// Run it with:
//   pnpm build:e2e
//   pnpm --dir apps/web exec vite preview --port 5182 --strictPort
//   E2E_BASE_URL=http://localhost:5182 pnpm --dir e2e exec cypress run --browser chrome \
//     --spec cypress/e2e/21-radiant-marks.cy.ts

import { seedFor, timeouts } from "../../support/config.ts";
import {
  CARD_REF,
  CARD_REF_TOOLTIP,
  CARD_VALUE,
  INSPECT_CLOSE,
  INSPECT_HOVER,
  INSPECT_REFS,
  INSPECT_REFS_FACE,
  INSPECT_SHEET,
  RADIANT,
  RADIANT_MARK,
  handCardId,
  ts,
} from "../../support/testids.ts";

/**
 * Every spec sets a seed (BUILD M8); `--expose seed=…` overrides it. With 21-marks-163, player 1
 * holds #31, #26 and #65 on its first turn and has 3 mana on its third (e2e/fixtures/decks/21-marks-a.json).
 */
const SEED = seedFor("21-marks-163");
const DECK_A = "21-marks-a";
const DECK_B = "08-do-nothing-b";

const MATH_EQUATION = "core-031";
const GLOWY_JELLY_BEAN = "core-026";
const MASOCHISM_MASK = "core-065";
const SPIKEY_PILLOW = "core-065-1";
/** Player 1's third turn: 3 mana, what #26 costs (§2.3). */
const THIRD_TURN = 5;

/** A shown hand card of `defId`, by the attribute the board puts on its root. */
const inHand = (defId: string): string => `[data-testid^="hand-card-"][data-def-id="${defId}"]`;

function restOn(selector: string): void {
  cy.get(selector).trigger("pointerover", { pointerType: "mouse" });
}

function leave(selector: string): void {
  cy.get(selector).trigger("pointerout", { pointerType: "mouse" });
  cy.get(ts(INSPECT_HOVER)).should("not.exist");
}

describe("21 — a card's marks in play: a computed value, a reference and a Radiant face's gold", () => {
  beforeEach(() => {
    cy.seedGame({ seed: SEED, a: DECK_A, b: DECK_B });
    cy.jackioh().then((handle) => {
      if (handle.seat !== "p1") cy.handOver();
    });
  });

  it("R280 KY's Math Equation in hand prints what its formula comes to now", () => {
    restOn(inHand(MATH_EQUATION));
    cy.get(`${ts(INSPECT_HOVER)} ${CARD_VALUE}`, { timeout: timeouts.view })
      .should("be.visible")
      .and("have.text", "{1}")
      .and("have.attr", "data-label", "Fib(cost+1)");
    cy.get(`${ts(INSPECT_HOVER)} .card-text`).should("contain.text", "Deal Fib(cost+1) {1} damage");
    leave(inHand(MATH_EQUATION));
  });

  it("R279 Masochism Mask names Spikey Pillow: its face is beside the preview, and the sheet's reference opens it", () => {
    // Resting on the Mask: the preview lists the card its text names.
    restOn(inHand(MASOCHISM_MASK));
    cy.get(`${ts(INSPECT_HOVER)} ${ts(INSPECT_REFS)}`, { timeout: timeouts.view })
      .should("be.visible")
      .find(`${INSPECT_REFS_FACE}[data-ref="${SPIKEY_PILLOW}"]`)
      .should("have.length", 1)
      .find(".card-name")
      .should("have.text", "Spikey Pillow");
    leave(inHand(MASOCHISM_MASK));

    // A long press opens the sheet, where the name is a control.
    cy.get(inHand(MASOCHISM_MASK)).trigger("pointerdown", { pointerType: "touch", pointerId: 7, button: 0 });
    cy.get(ts(INSPECT_SHEET), { timeout: timeouts.view }).should("be.visible");
    // The finger lifts off the card the sheet now covers.
    cy.get(inHand(MASOCHISM_MASK)).trigger("pointerup", { pointerType: "touch", pointerId: 7, button: 0, force: true });
    cy.get(`${ts(INSPECT_SHEET)} ${CARD_REF}[data-ref="${SPIKEY_PILLOW}"]`)
      .first()
      .should("have.attr", "tabindex", "0")
      .click();
    cy.get(ts(CARD_REF_TOOLTIP))
      .should("be.visible")
      .and("have.attr", "role", "tooltip")
      .and("have.attr", "data-ref", SPIKEY_PILLOW)
      .find(".card-name")
      .should("have.text", "Spikey Pillow");
    cy.get(`${ts(INSPECT_SHEET)} ${CARD_REF}[data-ref="${SPIKEY_PILLOW}"]`)
      .first()
      .invoke("attr", "aria-describedby")
      .then((described) => {
        cy.get(ts(CARD_REF_TOOLTIP)).should("have.attr", "id", described ?? "");
      });
    cy.get(ts(INSPECT_CLOSE)).click();
    cy.get(ts(INSPECT_SHEET)).should("not.exist");
  });

  it("R277 a Math Equation made Radiant prints Fib(cost+3) with cost+3 in gold, and its new value", () => {
    cy.advanceToTurn(THIRD_TURN);
    cy.jackioh().then((handle) => {
      if (handle.seat !== "p1") cy.handOver();
    });
    cy.instanceInHand("p1", MATH_EQUATION).then((mathId) => {
      cy.get(`${ts(handCardId(mathId))}${RADIANT}`).should("not.exist");
      cy.instanceInHand("p1", GLOWY_JELLY_BEAN).then((beanId) => {
        cy.playCard(beanId, { answers: [{ kind: "hand", cards: [mathId] }] });
      });
      cy.get(`${ts(handCardId(mathId))}${RADIANT}`).should("exist");

      restOn(ts(handCardId(mathId)));
      cy.get(`${ts(INSPECT_HOVER)} .card-text`, { timeout: timeouts.view })
        .should("contain.text", "Deal Fib(cost+3) {3} damage")
        .find(RADIANT_MARK)
        .should("have.length", 1)
        .and("have.text", "cost+3")
        .and(($mark) => {
          const style = getComputedStyle($mark[0] as Element);
          expect(Number(style.fontWeight), "the mark is bold").to.be.at.least(700);
          expect(style.textDecorationLine, "the mark is underlined").to.contain("underline");
        });
      cy.get(`${ts(INSPECT_HOVER)} ${CARD_VALUE}`).should("have.text", "{3}").and("have.attr", "data-label", "Fib(cost+3)");
      leave(ts(handCardId(mathId)));
    });
  });
});
