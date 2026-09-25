// BUILD M8 spec 18 — "Saved decks, deck codes and trios in `/decks` (R250–R252, R255, R256)".
//
// Key assertions (BUILD M8, quoted verbatim):
//
//     "a deck saves while incomplete and survives a reload; an edit made while the server is
//      unreachable is kept on the device and saved once it answers; a copied code imports as a new
//      deck and a damaged one is refused with a sentence; a trio marks every card two of its decks
//      share with the other deck's name, and is ready once they share none; an eleventh deck cannot
//      be made"
//
// THERE IS NO SAVE BUTTON (R256). Every edit is mirrored to this device at once and saved
// `DECK_AUTOSAVE_DEBOUNCE_MS` after the last one; the status line (`sync-status`, `data-state`)
// says saved, saving, offline or error, and a deck row carries `data-unsynced="true"` until the
// server has confirmed its latest edit. So "saved" is asserted as the row losing that mark and the
// status line reading saved, and then read back from `GET /api/decks` — the server's copy is the
// only proof a save happened, the screen being the device's copy.
//
// UNREACHABLE is a `cy.intercept` that fails every `PUT /api/decks/:id` at the network, which the
// client sees exactly as a dropped connection (`ApiUnreachableError`). "Once it answers" is a second
// intercept that lets the request through: Cypress runs the newest matching handler first and a
// handler that sends the request on ends the chain, so the failing one is never reached again. The
// workshop retries a failed transport after `DECK_AUTOSAVE_RETRY_SECONDS` by itself (R256); nothing
// here nudges it.
//
// Every seed is set (BUILD M8), though nothing here starts a game. The trio's readiness is also
// checked where it is law: its Best-of-3 ticket is taken, then dropped at once.
//
// Needs: M6 (the deck endpoints) and TASK 1's deck workshop. See e2e/README.md.

import {
  DECK_AUTOSAVE_RETRY_SECONDS,
  MAX_SAVED_DECKS,
} from "../../../apps/server/src/config.ts";
import { allCardIds, cardId } from "../../support/cards.ts";
import { mintId } from "../../support/commands.ts";
import { accounts, constants, routes, seedFor, server, timeouts, type E2EAccount } from "../../support/config.ts";
import {
  DECK_CAP,
  DECK_CAP_REASON,
  DECK_CODE_OUTPUT,
  DECK_COPY_CODE,
  DECK_COUNT,
  DECK_EDITOR,
  DECK_IMPORT,
  DECK_IMPORT_CAP_REASON,
  DECK_IMPORT_INPUT,
  DECK_IMPORT_OPEN,
  DECK_IMPORT_PREVIEW,
  DECK_IMPORT_SUBMIT,
  DECK_LIST,
  DECK_NAME_INPUT,
  DECK_NEW,
  SYNC_STATUS,
  TRIO_COMPARE,
  TRIO_EDITOR,
  TRIO_VERDICT,
  WORKSHOP,
  addPoolId,
  deckCardId,
  deckRowId,
  trioCardId,
  trioOpenDeckId,
  trioRowId,
  ts,
} from "../../support/testids.ts";
import type { FixtureDeck } from "../../support/types.ts";

/**
 * WHOSE WORKSHOP. `e2e-p2`, not `e2e-p1`. R109 limits every account to `API_REQUESTS_PER_MINUTE`
 * requests a minute, and a workshop is a busy screen (three reads per visit, an autosave per edit);
 * specs 09 and 19 lean on `e2e-p1` in the same minute of a suite run, and this file on the same
 * account pushed it past the limit — the lobby's reads then came back 429 in spec 19. Spread over the
 * two fixture accounts, each stays well inside.
 */
function workshopAccount(): E2EAccount {
  return accounts.p2();
}

/** Unit conversion, not configuration. */
const MS_PER_SECOND = 1000;

const DECK_SIZE = constants.DECK_SIZE;

/** A failed save goes again after `DECK_AUTOSAVE_RETRY_SECONDS` (R256); allow one retry and a view. */
const RETRY_TIMEOUT_MS = DECK_AUTOSAVE_RETRY_SECONDS * MS_PER_SECOND + timeouts.view;

/** Every deck row in the rail, whatever its id. */
const DECK_ROWS = `${ts(DECK_LIST)} [data-testid^="${deckRowId("")}"]`;

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

/** The open deck's id, off the editor. */
function openDeckId(): Cypress.Chainable<string> {
  return cy
    .get(ts(DECK_EDITOR), { timeout: timeouts.view })
    .invoke("attr", "data-deck")
    .then((id) => {
      expect(id, "the deck editor names its deck").to.be.a("string").and.not.eq("");
      return String(id);
    });
}

/** R256: the server has confirmed the latest edit of `deckId`, and the status line says so. */
function savedOnServer(deckId: string, timeout: number = timeouts.view): void {
  cy.get(ts(deckRowId(deckId)), { timeout }).should("not.have.attr", "data-unsynced");
  cy.get(ts(SYNC_STATUS)).should("have.attr", "data-state", "saved");
}

function legalDeck(fixture: string): Cypress.Chainable<string[]> {
  return cy.fixture<FixtureDeck>(`decks/${fixture}.json`).then((deck) => [...deck.cards]);
}

// ---------------------------------------------------------------------------------------------

describe("18 deck workshop — drafts, autosave offline, deck codes, trio conflicts and the cap", () => {
  const seed = seedFor("18-deck-workshop");

  before(() => {
    expect(seed, "BUILD M8: every spec sets a seed").to.be.a("string").and.not.eq("");
  });

  beforeEach(() => {
    cy.freeAccount(accounts.p1());
    cy.freeAccount(accounts.p2());
    cy.clearDecks(workshopAccount());
  });

  it("R250 a deck saves while incomplete, and survives a reload", () => {
    const me = workshopAccount();
    const cards = [cardId(1), cardId(2), cardId(3)];
    let deckId = "";

    openWorkshop(me);
    cy.get(ts(DECK_NEW)).should("not.be.disabled").click();
    openDeckId().then((id) => {
      deckId = id;
    });
    cy.get(ts(DECK_NAME_INPUT)).clear();
    cy.get(ts(DECK_NAME_INPUT)).type("Draft");
    for (const card of cards) {
      cy.get(ts(addPoolId(card))).click();
      cy.get(ts(deckCardId(card))).should("exist");
    }
    cy.get(ts(DECK_COUNT)).should("have.attr", "data-count", String(cards.length));

    // Saved as it is: three cards of twenty, which only the queue would refuse (R250, R253).
    cy.then(() => {
      savedOnServer(deckId);
      cy.savedDecks(me).should((saved) => {
        expect(saved.decks, "one saved deck").to.have.length(1);
        expect(saved.decks[0]?.id).to.eq(deckId);
        expect(saved.decks[0]?.name).to.eq("Draft");
        expect(saved.decks[0]?.cards, "saved incomplete").to.deep.eq(cards);
      });
    });

    cy.reload();
    cy.get(ts(WORKSHOP), { timeout: timeouts.view }).should("exist");
    cy.then(() => {
      cy.get(ts(deckRowId(deckId))).should("have.attr", "data-count", String(cards.length)).click();
    });
    cy.get(ts(DECK_NAME_INPUT)).should("have.value", "Draft");
    for (const card of cards) cy.get(ts(deckCardId(card))).should("exist");
  });

  it("R256 an edit made while the server is unreachable is kept on the device and saved once it answers", () => {
    const me = workshopAccount();
    const before = [cardId(1), cardId(2), cardId(3), cardId(4), cardId(5)];
    const added = cardId(6);
    const decksUrl = api("/api/decks/*");

    cy.saveDeck(me, { name: "Travel", cards: before }).then((deckId) => {
      openWorkshop(me);
      cy.get(ts(deckRowId(deckId))).click();
      cy.get(ts(DECK_COUNT)).should("have.attr", "data-count", String(before.length));

      // The connection drops.
      cy.intercept({ method: "PUT", url: decksUrl }, { forceNetworkError: true }).as("unreachable");
      cy.get(ts(addPoolId(added))).click();
      cy.get(ts(DECK_COUNT)).should("have.attr", "data-count", String(before.length + 1));
      cy.wait("@unreachable");
      cy.get(ts(SYNC_STATUS), { timeout: timeouts.view }).should("have.attr", "data-state", "offline");
      cy.get(ts(deckRowId(deckId))).should("have.attr", "data-unsynced", "true");
      cy.savedDecks(me).should((saved) => {
        expect(saved.decks[0]?.cards, "the server never got the edit").to.deep.eq(before);
      });

      // Kept on the device: a reload restores the edit over the server's copy.
      cy.reload();
      cy.get(ts(WORKSHOP), { timeout: timeouts.view }).should("exist");
      cy.get(ts(deckRowId(deckId)))
        .should("have.attr", "data-count", String(before.length + 1))
        .and("have.attr", "data-unsynced", "true")
        .click();
      cy.get(ts(deckCardId(added))).should("exist");
      cy.get(ts(SYNC_STATUS), { timeout: timeouts.view }).should("have.attr", "data-state", "offline");

      // The server answers again, and the workshop's own retry saves the edit.
      cy.intercept({ method: "PUT", url: decksUrl }, (request) => {
        request.continue();
      }).as("reachable");
      cy.wait("@reachable", { timeout: RETRY_TIMEOUT_MS });
      savedOnServer(deckId, RETRY_TIMEOUT_MS);
      cy.savedDecks(me).should((saved) => {
        expect(saved.decks[0]?.cards, "the edit reached the server").to.deep.eq([...before, added]);
      });
    });
  });

  it("R255 a copied code imports as a new deck, and a damaged code is refused with a sentence", () => {
    const me = workshopAccount();
    let code = "";

    legalDeck("09-deckbuilder-a").then((cards) => {
      cy.saveDeck(me, { name: "Shared", cards }).then((original) => {
        openWorkshop(me);
        cy.get(ts(deckRowId(original))).click();
        cy.get(ts(DECK_COPY_CODE)).click();
        cy.get(ts(DECK_CODE_OUTPUT))
          .invoke("val")
          .then((value) => {
            code = String(value);
            expect(code, "R255: a deck code").to.match(/^JKO\d+\./);
          });

        // Import it: a NEW deck, with the same cards.
        cy.get(ts(DECK_IMPORT_OPEN)).click();
        cy.get(ts(DECK_IMPORT)).should("be.visible");
        cy.then(() => {
          cy.get(ts(DECK_IMPORT_INPUT)).type(code, { delay: 0 });
        });
        cy.get(ts(DECK_IMPORT_PREVIEW))
          .should("have.attr", "data-ok", "true")
          .and("contain.text", `${String(DECK_SIZE)}/${String(DECK_SIZE)} cards`);
        cy.get(ts(DECK_IMPORT_SUBMIT)).should("not.be.disabled").click();

        cy.get(DECK_ROWS).should("have.length", 2);
        openDeckId().then((imported) => {
          expect(imported, "the import made a new deck").to.not.eq(original);
          cy.get(ts(DECK_COUNT)).should("have.attr", "data-count", String(DECK_SIZE));
          cy.get(ts(deckRowId(imported))).should("have.attr", "data-count", String(DECK_SIZE));
          savedOnServer(imported);
          cy.savedDecks(me).should((saved) => {
            expect(saved.decks, "the original and the import").to.have.length(2);
            const copy = saved.decks.find((deck) => deck.id === imported);
            expect([...(copy?.cards ?? [])].sort(), "the same cards").to.deep.eq([...cards].sort());
          });
        });

        // Damage one character of the payload: refused, with a sentence, and nothing to import.
        cy.get(ts(DECK_IMPORT_OPEN)).click();
        cy.then(() => {
          const at = code.length - 4;
          const was = code.charAt(at);
          const damaged = `${code.slice(0, at)}${was === "A" ? "B" : "A"}${code.slice(at + 1)}`;
          cy.get(ts(DECK_IMPORT_INPUT)).clear();
          cy.get(ts(DECK_IMPORT_INPUT)).type(damaged, { delay: 0 });
        });
        cy.get(ts(DECK_IMPORT_PREVIEW))
          .should("have.attr", "data-ok", "false")
          .find('[role="alert"]')
          .invoke("text")
          .should("match", /deck code/i)
          .and("match", /\.$/);
        cy.get(ts(DECK_IMPORT_SUBMIT)).should("be.disabled");
        cy.get(DECK_ROWS).should("have.length", 2);
      });
    });
  });

  it("R251 R252 a trio marks every card two of its decks share with the other deck's name, and is ready once they share none", () => {
    const me = workshopAccount();

    legalDeck("09-deckbuilder-a").then((alpha) => {
      legalDeck("09-deckbuilder-b").then((b) => {
        legalDeck("09-deckbuilder-c").then((gamma) => {
          const shared = [alpha[0] ?? "", alpha[1] ?? ""];
          const beta = [...b.slice(0, DECK_SIZE - shared.length), ...shared];
          const inAlphaOnly = alpha[2] ?? "";
          const used = new Set([...alpha, ...b, ...gamma]);
          const free = allCardIds().filter((id) => !used.has(id)).slice(0, shared.length);

          cy.saveDeck(me, { name: "Alpha", cards: alpha }).then((alphaId) => {
            cy.saveDeck(me, { name: "Beta", cards: beta }).then((betaId) => {
              cy.saveDeck(me, { name: "Gamma", cards: gamma }).then((gammaId) => {
                cy.saveTrio(me, { name: "Clash", deckIds: [alphaId, betaId, gammaId] }).then((trioId) => {
                  openWorkshop(me);
                  cy.get(ts(trioRowId(trioId))).should("have.attr", "data-ready", "false").click();
                  cy.get(ts(TRIO_EDITOR)).should("have.attr", "data-trio", trioId);

                  // Every shared card, in both decks, names the OTHER deck.
                  for (const card of shared) {
                    cy.get(ts(trioCardId(1, card)))
                      .should("have.attr", "data-conflict", "true")
                      .and("have.attr", "data-conflict-with", "Beta");
                    cy.get(ts(trioCardId(2, card)))
                      .should("have.attr", "data-conflict", "true")
                      .and("have.attr", "data-conflict-with", "Alpha");
                  }
                  // …and nothing else is marked.
                  cy.get(ts(trioCardId(1, inAlphaOnly))).should("have.attr", "data-conflict", "false");
                  cy.get(`${ts(TRIO_COMPARE)} [data-conflict="true"]`).should("have.length", shared.length * 2);
                  cy.get(ts(TRIO_VERDICT)).should("have.attr", "data-ready", "false");

                  // Swap them out of Beta in its editor, opened from the trio.
                  cy.get(ts(trioOpenDeckId(2))).click();
                  cy.get(ts(DECK_EDITOR)).should("have.attr", "data-deck", betaId);
                  for (const card of shared) {
                    cy.get(ts(deckCardId(card))).click();
                    cy.get(ts(deckCardId(card))).should("not.exist");
                  }
                  for (const card of free) {
                    cy.get(ts(addPoolId(card))).click();
                    cy.get(ts(deckCardId(card))).should("exist");
                  }
                  cy.get(ts(DECK_COUNT)).should("have.attr", "data-count", String(DECK_SIZE));
                  savedOnServer(betaId);

                  // The trio shares nothing now, and is ready.
                  cy.get(ts(trioRowId(trioId))).should("have.attr", "data-ready", "true").click();
                  cy.get(ts(TRIO_VERDICT)).should("have.attr", "data-ready", "true");
                  cy.get(`${ts(TRIO_COMPARE)} [data-conflict="true"]`).should("not.exist");

                  // The server agrees: a Best-of-3 ticket is taken, and dropped again.
                  cy.request<{ mode: string }>({
                    method: "POST",
                    url: api("/api/queue"),
                    headers: bearer(me),
                    body: { mode: "bo3", trioId, seed },
                  })
                    .its("body.mode")
                    .should("eq", "bo3");
                  cy.request({ method: "DELETE", url: api("/api/queue"), headers: bearer(me) })
                    .its("status")
                    .should("eq", 200);
                });
              });
            });
          });
        });
      });
    });
  });

  it(`R250 an eleventh deck cannot be made: ${String(MAX_SAVED_DECKS)} is the cap`, () => {
    const me = workshopAccount();
    let code = "";

    cy.savedDecks(me).then((saved) => {
      expect(saved.limits.decks, "the server's cap is MAX_SAVED_DECKS").to.eq(MAX_SAVED_DECKS);
      for (let at = 1; at <= MAX_SAVED_DECKS; at += 1) {
        cy.saveDeck(me, { name: `Deck ${String(at)}`, cards: [cardId(at)], catalogVersion: saved.catalogVersion });
      }
    });
    cy.savedDecks(me).its("decks").should("have.length", MAX_SAVED_DECKS);

    openWorkshop(me);
    cy.get(DECK_ROWS).should("have.length", MAX_SAVED_DECKS);
    cy.get(ts(DECK_CAP))
      .should("have.attr", "data-count", String(MAX_SAVED_DECKS))
      .and("have.attr", "data-limit", String(MAX_SAVED_DECKS));
    cy.get(ts(DECK_NEW)).should("be.disabled");
    cy.get(ts(DECK_CAP_REASON)).should("be.visible").and("contain.text", String(MAX_SAVED_DECKS));

    // An import is a new deck too, so it is off at the cap as well.
    cy.get(ts(DECK_COPY_CODE)).click();
    cy.get(ts(DECK_CODE_OUTPUT))
      .invoke("val")
      .then((value) => {
        code = String(value);
      });
    cy.get(ts(DECK_IMPORT_OPEN)).click();
    cy.then(() => {
      cy.get(ts(DECK_IMPORT_INPUT)).type(code, { delay: 0 });
    });
    cy.get(ts(DECK_IMPORT_PREVIEW)).should("have.attr", "data-ok", "true");
    cy.get(ts(DECK_IMPORT_SUBMIT)).should("be.disabled");
    cy.get(ts(DECK_IMPORT_CAP_REASON)).should("be.visible");

    // And the server is law: an eleventh PUT is a conflict naming the limit.
    cy.savedDecks(me).then((saved) => {
      cy.request<{ error: { code: string; details?: { limit?: number } } }>({
        method: "PUT",
        url: api(`/api/decks/${mintId()}`),
        headers: bearer(me),
        body: { name: "One too many", cards: [], catalogVersion: saved.catalogVersion },
        failOnStatusCode: false,
      }).should((response) => {
        expect(response.status, "R250: past the cap is 409").to.eq(409);
        expect(response.body.error.code).to.eq("conflict");
        expect(response.body.error.details?.limit).to.eq(MAX_SAVED_DECKS);
      });
    });
    cy.savedDecks(me).its("decks").should("have.length", MAX_SAVED_DECKS);
  });
});
