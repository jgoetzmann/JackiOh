// Spec 24 — your own library, looked through without its order (SPEC §10.8, §10.10, R310–R313),
// and the tutorial without its Skip step (R314).
//
// What it proves, against `pnpm build:e2e` + `vite preview` and no server:
//
//   * on `/dev/hotseat`, the seat whose view is shown can look through its own library: a resting
//     mouse on `library-you` opens a preview that says "Your library", how many cards and "Order
//     hidden"; a click opens every card in a dialog, one face per card and face with its count
//     ("×2" when above one), which Escape closes back onto the pile; Enter on the focused pile opens
//     it too. What the dialog lists is exactly what is in that seat's library, card for card (the
//     spec reads the true state through the dev handle; the page never does);
//   * the opponent's library is a count and nothing else: it is not a button, and neither a resting
//     mouse nor a click opens anything;
//   * after the hand-over the other seat's own library is the one that opens, with its own cards,
//     and the first seat's is the count;
//   * in a tutorial lesson (`/practice?lesson=basics`) there is no Skip step anywhere — no button,
//     label or testid in the HUD or the coach's bubble says "skip" — Exit tutorial is still in the
//     HUD, and the human's library opens its list there too.
//
// Screenshots (the evidence folder): the first seat's preview and dialog, at 1280x720.
//
// House rules (BUILD M8): seeds come from `seedFor`, there is no fixed `cy.wait(ms)` (every wait is
// `cy.settled()` or a retried assertion), and every selector comes from support/testids.ts.
//
// Run it with:
//   pnpm build:e2e
//   pnpm --dir apps/web exec vite preview --port 5185 --strictPort
//   E2E_BASE_URL=http://localhost:5185 pnpm --dir e2e exec cypress run --browser chrome \
//     --spec cypress/e2e/24-library-browse.cy.ts

import { CARD_NAMES } from "../../support/cards.ts";
import { seedFor } from "../../support/config.ts";
import {
  BOARD,
  BROWSABLE,
  COACH,
  INSPECT_CLOSE,
  INSPECT_LIST_CARD,
  INSPECT_LIST_COUNT,
  INSPECT_LIST_HOVER,
  INSPECT_LIST_SHEET,
  TUTORIAL_EXIT,
  TUTORIAL_HUD,
  libraryCountId,
  libraryId,
  ts,
} from "../../support/testids.ts";
import {
  TUTORIAL_BOOT_TIMEOUT,
  currentView,
  lessonUrl,
  takeMoment,
  visitTutorial,
  waitForMoment,
  type Moment,
} from "../../support/tutorial.ts";
import type { PlayerId } from "../../support/types.ts";

/** Every spec sets a seed (BUILD M8); `--expose seed=…` overrides it. */
const SEED = seedFor("24-library");
const DECK_A = "01-aggro-a";
const DECK_B = "01-aggro-b";

/** The first lesson (SPEC §9.10): its seed and decks are its own. */
const LESSON = "basics";
/** Moments the tutorial part may pass (a mulligan, "Got it" on the opening steps) before the human's turn. */
const MOMENT_BUDGET = 12;

/** What the list says of its order (R313). */
const ORDER_HIDDEN = /order hidden/i;

type Seat = PlayerId;
type LibraryCard = { defId: string };

/** A catalog id's printed name: `core-032` is SPEC §8 #32. */
function nameOf(defId: string): string {
  const match = /^core-(\d{3})$/.exec(defId);
  const name = match === null ? undefined : CARD_NAMES[Number(match[1])];
  expect(name, `SPEC §8 names ${defId}`).to.not.eq(undefined);
  return name ?? defId;
}

/** A multiset of names, as sorted "name × count" lines, so two lists compare regardless of order. */
function tally(names: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  return [...counts.entries()].map(([name, count]) => `${name} × ${String(count)}`).sort();
}

/** What `seat`'s library truly holds, read off the hotseat's dev handle (the page never reads it). */
function trueLibrary(seat: Seat): Cypress.Chainable<string[]> {
  return cy.gameState().then((state) => {
    const side = state.players[seat] as { library?: LibraryCard[] };
    expect(side.library, `${seat}'s library in the dev handle`).to.be.an("array");
    return (side.library ?? []).map((card) => nameOf(card.defId));
  });
}

/** The names the open dialog lists, each as many times as its count says. */
function listedNames(): Cypress.Chainable<string[]> {
  return cy.get(`${ts(INSPECT_LIST_SHEET)} ${ts(INSPECT_LIST_CARD)}`).then(($tiles) =>
    $tiles.toArray().flatMap((tile) => {
      const count = Number(tile.getAttribute("data-count") ?? "1");
      expect(tile.getAttribute("data-unknown"), "every card of a deck its owner built is known (R311)").to.not.eq("true");
      return Array.from({ length: count }, () => tile.getAttribute("data-def-name") ?? "");
    }),
  );
}

/** The seat the board draws as "you": the seat whose view the hotseat is showing. */
const YOUR_SEAT = '[data-side="you"][data-player]';

function shownSeat(): Cypress.Chainable<Seat> {
  return cy
    .get(`${ts(BOARD)} ${YOUR_SEAT}`)
    .invoke("attr", "data-player")
    .then((seat) => {
      expect(seat, "the board names the seat it shows").to.match(/^p[12]$/);
      return seat as Seat;
    });
}

/** The shown seat's library, looked through on hover and in the dialog, against the true state. */
function expectOwnLibraryBrowsable(shot?: string): void {
  shownSeat().then((seat) => {
    cy.get(ts(libraryCountId("you")))
      .invoke("text")
      .then((text) => {
        const count = Number(text);
        expect(count, "a library with cards in it").to.be.greaterThan(0);
        const pile = ts(libraryId("you"));

        // A resting mouse: the title, the size and "Order hidden", click-through.
        cy.get(`${pile}${BROWSABLE}`).should("have.attr", "role", "button");
        cy.get(pile).invoke("attr", "aria-label").should("match", ORDER_HIDDEN);
        cy.get(pile).trigger("pointerover", { pointerType: "mouse" });
        cy.get(ts(INSPECT_LIST_HOVER)).should("be.visible").and("have.css", "pointer-events", "none");
        cy.get(ts(INSPECT_LIST_HOVER)).should("contain.text", "Your library").invoke("text").should("match", ORDER_HIDDEN);
        cy.get(`${ts(INSPECT_LIST_HOVER)} ${ts(INSPECT_LIST_COUNT)}`).should("have.attr", "data-count", String(count));
        if (shot !== undefined) cy.screenshot(`${shot}-preview`, { capture: "viewport" });
        cy.get(pile).trigger("pointerout", { pointerType: "mouse" });
        cy.get(ts(INSPECT_LIST_HOVER)).should("not.exist");

        // A click: every card, grouped with its count, exactly what the library holds.
        cy.get(pile).click();
        cy.get(ts(INSPECT_LIST_SHEET)).should("be.visible").and("have.attr", "role", "dialog");
        cy.get(ts(INSPECT_LIST_SHEET)).invoke("text").should("match", ORDER_HIDDEN);
        cy.get(`${ts(INSPECT_LIST_SHEET)} ${ts(INSPECT_LIST_COUNT)}`).should("have.attr", "data-count", String(count));
        listedNames().then((listed) => {
          expect(listed, "the list has one name per card").to.have.length(count);
          trueLibrary(seat).then((truth) => {
            expect(tally(listed), `${seat}'s library, card for card`).to.deep.eq(tally(truth));
          });
        });
        if (shot !== undefined) cy.screenshot(`${shot}-dialog`, { capture: "viewport" });
        // A count above one is printed on the face.
        cy.get(`${ts(INSPECT_LIST_SHEET)} ${ts(INSPECT_LIST_CARD)}`).each(($tile) => {
          const tileCount = Number($tile.attr("data-count") ?? "1");
          if (tileCount > 1) expect($tile.text(), "the count on the face").to.contain(`×${String(tileCount)}`);
        });
        cy.get("body").type("{esc}");
        cy.get(ts(INSPECT_LIST_SHEET)).should("not.exist");
        cy.get(pile).should("have.focus");

        // Enter on the focused pile opens it too.
        cy.get(pile).trigger("keydown", { key: "Enter" });
        cy.get(ts(INSPECT_LIST_SHEET)).should("be.visible");
        cy.get(ts(INSPECT_CLOSE)).click();
        cy.get(ts(INSPECT_LIST_SHEET)).should("not.exist");
      });
  });
}

/** The opponent's library is a count: not a button, and nothing opens on it. */
function expectOpponentLibraryClosed(): void {
  const pile = ts(libraryId("opponent"));
  // One attribute per `should`: a negated `have.attr` leaves no subject for a second one.
  cy.get(pile).should("not.have.attr", "data-browsable");
  cy.get(pile).should("not.have.attr", "role");
  cy.get(ts(libraryCountId("opponent"))).invoke("text").then((text) => expect(Number(text)).to.be.greaterThan(0));
  cy.get(pile).trigger("pointerover", { pointerType: "mouse" });
  cy.get(pile).click();
  cy.get(ts(INSPECT_LIST_HOVER)).should("not.exist");
  cy.get(ts(INSPECT_LIST_SHEET)).should("not.exist");
  cy.get(pile).trigger("pointerout", { pointerType: "mouse" });
}

/** No button, label or testid in the HUD or the coach's bubble says "skip" (R314). */
function expectNoSkip(doc: Document): void {
  for (const region of [TUTORIAL_HUD, COACH]) {
    const root = doc.querySelector(ts(region));
    const skips = Array.from(root?.querySelectorAll("button, [data-testid], [aria-label]") ?? []).filter((element) =>
      /skip/i.test(
        [element.textContent ?? "", element.getAttribute("aria-label") ?? "", element.getAttribute("data-testid") ?? ""].join(" "),
      ),
    );
    expect(
      skips.map((element) => element.outerHTML),
      `no Skip step in ${region}`,
    ).to.deep.eq([]);
  }
}

/** Take the lesson's moments until the human's own turn, checking there is no Skip at each one. */
function untilMyTurn(budget: number): void {
  expect(budget, "the human's turn comes within the budget").to.be.greaterThan(0);
  waitForMoment().then((moment: Moment) => {
    cy.document().then(expectNoSkip);
    if (moment.kind === "turn") return;
    expect(moment.kind, "the lesson is not over before the human's first turn").to.not.eq("over");
    if (moment.kind === "over") return;
    takeMoment(moment).then(() => {
      untilMyTurn(budget - 1);
    });
  });
}

describe("24 — your library, without its order (R310–R313)", () => {
  it("R310 R313 hotseat: your library opens its cards with counts and 'order hidden'; the opponent's is a count; the other seat's opens after the hand-over", () => {
    cy.seedGame({ seed: SEED, a: DECK_A, b: DECK_B });
    // The mulligans leave the device with whoever answered last; hand it to the seat on turn.
    cy.handOver();
    // Screenshots (the evidence folder): the preview and the dialog, at the default viewport.
    expectOwnLibraryBrowsable("24-library");
    expectOpponentLibraryClosed();

    shownSeat().then((first) => {
      cy.endTurn();
      cy.get(`${ts(BOARD)} ${YOUR_SEAT}`).invoke("attr", "data-player").should("not.eq", first);
      expectOwnLibraryBrowsable();
      expectOpponentLibraryClosed();
    });
  });
});

describe("24 — the tutorial (R313, R314)", () => {
  it("R314 R313 lesson 1: no Skip step in the HUD or the bubble, Exit tutorial is there, and your library opens its list", () => {
    visitTutorial(lessonUrl(LESSON), { reducedMotion: true });
    cy.get(ts(TUTORIAL_HUD), { timeout: TUTORIAL_BOOT_TIMEOUT }).should("have.attr", "data-lesson", LESSON);
    cy.get(ts(TUTORIAL_EXIT)).should("be.visible");
    cy.document().then(expectNoSkip);
    untilMyTurn(MOMENT_BUDGET);

    cy.window().then((win) => {
      const view = currentView(win);
      expect(view, "the page holds the human's view").to.not.eq(null);
    });
    cy.get(ts(libraryCountId("you")))
      .invoke("text")
      .then((text) => {
        const count = Number(text);
        expect(count, "the lesson's library has cards").to.be.greaterThan(0);
        // The coach's bubble may sit over the pile, and what is under test is the list: open it from
        // the keyboard, which the pile takes wherever the bubble is.
        cy.get(`${ts(libraryId("you"))}${BROWSABLE}`).trigger("keydown", { key: "Enter", force: true });
        cy.get(ts(INSPECT_LIST_SHEET)).should("be.visible").and("contain.text", "Your library");
        cy.get(ts(INSPECT_LIST_SHEET)).invoke("text").should("match", ORDER_HIDDEN);
        cy.get(`${ts(INSPECT_LIST_SHEET)} ${ts(INSPECT_LIST_COUNT)}`).should("have.attr", "data-count", String(count));
        cy.get(ts(INSPECT_CLOSE)).click();
        cy.get(ts(INSPECT_LIST_SHEET)).should("not.exist");
      });
    cy.get(ts(libraryId("opponent"))).should("not.have.attr", "data-browsable");
    cy.document().then(expectNoSkip);
  });
});
