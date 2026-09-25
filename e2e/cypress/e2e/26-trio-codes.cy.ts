// Spec 26 — "Trio codes: copy a trio's code, import it as three new decks and a trio, and the cap
// refusal (R339–R341)".
//
// Key assertions:
//
//     "Copy trio code shows the trio as a code; pasting it into another account's Import trio
//      previews its three decks and imports them as three new decks and a trio naming them, which
//      the server holds; with too little room the import is off and says exactly how many slots it
//      needs, the server refuses the same import with the same numbers, and nothing is made"
//
// WHO IS WHO. The code is copied from `e2e-p2`'s trio (the one `cy.installLoadout` saves: "E2E
// trio", Deck 1..3) and imported into `e2e-p1`, which starts each test with nothing saved, so the
// import is the only thing that could have made what `GET /api/decks` then lists. The clipboard is
// not read: a Cypress browser may refuse it, and the workshop shows the code in a read-only field
// for exactly that case, which is where the spec reads it.
//
// Needs: M6 (the deck endpoints), TASK 1's deck workshop and the trio import route
// (`POST /api/trios/import`). See e2e/README.md.

import { MAX_SAVED_DECKS, MAX_SAVED_TRIOS } from "../../../apps/server/src/config.ts";
import { INSTALLED_DECK_NAMES, INSTALLED_TRIO_NAME, mintId, type InstalledLoadout } from "../../support/commands.ts";
import { accounts, constants, routes, server, timeouts, type E2EAccount } from "../../support/config.ts";
import {
  DECK_LIST,
  TRIO_CODE_OUTPUT,
  TRIO_COPY_CODE,
  TRIO_EDITOR,
  TRIO_IMPORT,
  TRIO_IMPORT_CAP_REASON,
  TRIO_IMPORT_INPUT,
  TRIO_IMPORT_OPEN,
  TRIO_IMPORT_PREVIEW,
  TRIO_IMPORT_SHARED,
  TRIO_IMPORT_SUBMIT,
  TRIO_NAME_INPUT,
  TRIO_VERDICT,
  WORKSHOP,
  deckRowId,
  trioImportSlotId,
  trioRowId,
  ts,
} from "../../support/testids.ts";

const DECK_SIZE = constants.DECK_SIZE;

/** Every deck row in the rail, whatever its id. */
const DECK_ROWS = `${ts(DECK_LIST)} [data-testid^="${deckRowId("")}"]`;

type ErrorBody = { error: { code: string; message: string; details?: unknown } };

function api(path: string): string {
  return `${server.http()}${path}`;
}

function bearer(account: E2EAccount): Record<string, string> {
  return { authorization: `Bearer ${account.token}` };
}

/** Open `/decks` and wait for the workshop itself, not for the route. */
function openWorkshop(account: E2EAccount): void {
  cy.visitAs(account, routes.deckbuilder());
  cy.get(ts(WORKSHOP), { timeout: timeouts.view }).should("exist");
}

/** `e2e-p2`'s installed trio, as a code copied off its trio editor. */
function copiedTrioCode(): Cypress.Chainable<{ code: string; installed: InstalledLoadout }> {
  const exporter = accounts.p2();
  return cy.installLoadout(exporter, "19-modes-b").then((installed) => {
    openWorkshop(exporter);
    cy.get(ts(trioRowId(installed.trioId)), { timeout: timeouts.view }).click();
    cy.get(ts(TRIO_EDITOR)).should("have.attr", "data-trio", installed.trioId);
    cy.get(ts(TRIO_COPY_CODE)).click();
    return cy
      .get(ts(TRIO_CODE_OUTPUT))
      .invoke("val")
      .then((value) => {
        const code = String(value);
        expect(code, "R339: a trio code").to.match(/^JKT\d+\.[A-Za-z0-9_-]+$/u);
        return { code, installed };
      });
  });
}

/** Paste `code` into the trio import panel of the open workshop. */
function pasteTrioCode(code: string): void {
  cy.get(ts(TRIO_IMPORT_OPEN), { timeout: timeouts.view }).click();
  cy.get(ts(TRIO_IMPORT)).should("be.visible");
  cy.get(ts(TRIO_IMPORT_INPUT)).type(code, { delay: 0 });
}

describe("26 trio codes — copy, import, and the caps (R339–R341)", () => {
  beforeEach(() => {
    cy.clearDecks(accounts.p1());
  });

  it("R339 R341 a copied trio code imports into another account as three new decks and a trio", () => {
    const importer = accounts.p1();
    copiedTrioCode().then(({ code, installed }) => {
      openWorkshop(importer);
      cy.get(DECK_ROWS).should("have.length", 0);
      pasteTrioCode(code);

      // The preview: the trio's name, each deck with its count, and nothing shared (L4's trio).
      cy.get(ts(TRIO_IMPORT_PREVIEW)).should("have.attr", "data-ok", "true").and("contain.text", INSTALLED_TRIO_NAME);
      INSTALLED_DECK_NAMES.forEach((name, at) => {
        cy.get(ts(trioImportSlotId(at + 1)))
          .should("have.attr", "data-count", String(DECK_SIZE))
          .and("contain.text", name);
      });
      cy.get(ts(TRIO_IMPORT_SHARED)).should("not.exist");
      cy.get(ts(TRIO_IMPORT_SUBMIT)).should("not.be.disabled").click();

      // The new trio opens, whole, and is ready for Conquest.
      cy.get(ts(TRIO_EDITOR), { timeout: timeouts.view }).should("be.visible");
      cy.get(ts(TRIO_NAME_INPUT)).should("have.value", INSTALLED_TRIO_NAME);
      cy.get(ts(TRIO_VERDICT)).should("have.attr", "data-ready", "true");
      cy.get(DECK_ROWS).should("have.length", constants.DECKS_PER_LOADOUT);

      // The server holds exactly what the code carried: three decks, and a trio naming them in order.
      cy.savedDecks(importer).should((saved) => {
        expect(saved.decks.map((deck) => deck.name), "the decks' names").to.deep.eq([...INSTALLED_DECK_NAMES]);
        expect(saved.decks.map((deck) => deck.cards), "the decks' cards, card for card").to.deep.eq(installed.decks);
        expect(saved.decks.map((deck) => deck.id), "new decks, not the exporter's").to.not.include.members(installed.deckIds);
        expect(saved.trios, "one trio").to.have.length(1);
        expect(saved.trios[0]?.name).to.eq(INSTALLED_TRIO_NAME);
        expect(saved.trios[0]?.deckIds, "the trio names the new decks in slot order").to.deep.eq(
          saved.decks.map((deck) => deck.id),
        );
      });
    });
  });

  it("R340 with too little room the import says how many slots it needs, the server refuses it too, and nothing is made", () => {
    const importer = accounts.p1();
    copiedTrioCode().then(({ code, installed }) => {
      // Leave one free deck slot: the code's three decks need three.
      cy.savedDecks(importer).then((saved) => {
        for (let at = 0; at < MAX_SAVED_DECKS - 1; at += 1) {
          cy.saveDeck(importer, { name: `Filler ${String(at + 1)}`, cards: [], catalogVersion: saved.catalogVersion });
        }
      });
      openWorkshop(importer);
      cy.get(DECK_ROWS).should("have.length", MAX_SAVED_DECKS - 1);
      pasteTrioCode(code);
      cy.get(ts(TRIO_IMPORT_PREVIEW)).should("have.attr", "data-ok", "true");
      cy.get(ts(TRIO_IMPORT_CAP_REASON))
        .should("have.attr", "data-decks-short", "2")
        .and("have.attr", "data-trios-short", "0")
        .and("contain.text", "needs 3 free deck slots")
        .and("contain.text", "Delete 2 decks");
      cy.get(ts(TRIO_IMPORT_SUBMIT)).should("be.disabled");

      // The server is law (rule 7): the same import sent straight to it is refused with the same
      // numbers, and writes nothing.
      cy.savedDecks(importer).then((saved) => {
        cy.request<ErrorBody>({
          method: "POST",
          url: api("/api/trios/import"),
          headers: bearer(importer),
          body: {
            catalogVersion: saved.catalogVersion,
            trio: { id: mintId(), name: INSTALLED_TRIO_NAME },
            slots: installed.decks.map((cards, at) => ({ id: mintId(), name: INSTALLED_DECK_NAMES[at] ?? "Deck", cards })),
          },
          failOnStatusCode: false,
        }).should((response) => {
          expect(response.status, "R340: past the deck cap").to.eq(409);
          expect(response.body.error.code).to.eq("conflict");
          expect(response.body.error.details).to.deep.eq({
            decksShort: 2,
            triosShort: 0,
            limits: { decks: MAX_SAVED_DECKS, trios: MAX_SAVED_TRIOS },
          });
          expect(response.body.error.message).to.contain("Nothing was imported.");
        });
      });
      cy.savedDecks(importer).should((saved) => {
        expect(saved.decks, "no deck was made").to.have.length(MAX_SAVED_DECKS - 1);
        expect(saved.trios, "no trio was made").to.have.length(0);
      });
    });
  });
});
