// BUILD M9 spec 13 — "Deck library".
//
// Acceptance (BUILD M9-T3, quoted verbatim):
//
//     "`e2e/13-deck-library.cy.ts` builds a deck across two pages with right-clicks, saves it,
//      reloads, checks the hover preview and the inspector, imports it into a loadout slot and
//      creates a room with its `deckId`."
//
// Every selector is `support/testids.ts`'s A14 block, which mirrors
// `apps/web/src/game/library/testids.ts` name for name. The `it`s run in order and share the
// deck the first one saves, the way spec 09's share the loadout it saves.
//
// THE PAGES. How many cards a page holds depends on the viewport (the constructor measures its
// grid), so the spec never assumes a page size: it right-clicks at most half the deck from any one
// page and turns the page for the rest, which is "across two pages" at every size.
//
// THE ROOMS (R172). A room freezes a library deck by id exactly as it freezes a loadout deck, and
// validates it strictly: a deck saved short of DECK_SIZE (fine for R171) is refused as 422
// `loadout_invalid`, and another account's deck id is not found, never forbidden.
//
// Needs: M9 (the `/api/decks` routes, the constructor, R172's `deckId`). See e2e/README.md.

import { DECK_NAME_MAX_LENGTH } from "../../../apps/server/src/config.ts";
import { CARD_NAMES, allCardIds } from "../../support/cards.ts";
import { accounts, constants, routes, seedFor, server, timeouts } from "../../support/config.ts";
import {
  DECKBUILDER,
  DECKLIST,
  DECK_CARD_COUNT,
  DECK_NAME_INPUT,
  DECK_SAVE,
  DECK_SAVED,
  HOVER_PREVIEW,
  INSPECTOR,
  INSPECTOR_CARD,
  LIBRARY,
  LIBRARY_DECKS,
  LIBRARY_INCOMPLETE,
  LIBRARY_NEW_DECK,
  LIBRARY_PAGES,
  PAGE_INDICATOR,
  PAGE_NEXT,
  deckBarId,
  deckCardRowId,
  deckCountId,
  deckImportId,
  libraryDeckId,
  pageCardId,
  ts,
} from "../../support/testids.ts";

const DECK_SIZE = constants.DECK_SIZE;

/** At most this many cards from one page, so the deck needs at least two. */
const PER_PAGE = Math.ceil(DECK_SIZE / 2);

/** A visible card on the open page. Scoped to the pages, so a preview's card never counts. */
const PAGE_CARD = `${ts(LIBRARY_PAGES)} [data-testid^="${pageCardId("")}"]`;

type LibraryDeckBody = { id: string; name: string; cards: string[]; updatedAt: number };
type DeckListBody = { catalogVersion: string; maxDecks: number; decks: LibraryDeckBody[] };
type ErrorBody = {
  error: { code: string; message: string; details?: { rule: string; message: string }[] };
};
type RoomBody = { code: string; expiresAt: number; deckIndex?: number; deckId?: string };

function api(path: string): string {
  return `${server.http()}${path}`;
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function listDecks(token: string): Cypress.Chainable<DeckListBody> {
  return cy
    .request<DeckListBody>({ method: "GET", url: api("/api/decks"), headers: bearer(token) })
    .then((response) => response.body);
}

/** SPEC §8's name for a catalog id: data, not copy a designer owns (as in spec 09). */
function nameOf(catalogCardId: string): string {
  const name = CARD_NAMES[allCardIds().indexOf(catalogCardId) + 1];
  if (name === undefined) throw new Error(`no SPEC §8 card with id ${catalogCardId}`);
  return name;
}

/**
 * Right-click cards onto the decklist, page by page, until it holds DECK_SIZE. Asserts the page
 * indicator on every page, so "across two pages" is checked rather than assumed.
 */
function addAcrossPages(page: number, added: readonly string[]): Cypress.Chainable<string[]> {
  cy.get(ts(PAGE_INDICATOR)).should("have.attr", "data-page", String(page));
  return cy
    .get(PAGE_CARD)
    .filter(":visible")
    .then(($cards) => {
      const ids = [...$cards]
        .map((card) => (card.getAttribute("data-testid") ?? "").slice(pageCardId("").length))
        .slice(0, Math.min(PER_PAGE, DECK_SIZE - added.length));
      expect(ids.length, `page ${String(page)} offers cards`).to.be.greaterThan(0);
      for (const id of ids) cy.get(ts(pageCardId(id))).rightclick();

      const next = [...added, ...ids];
      cy.get(ts(DECK_CARD_COUNT)).should("have.attr", "data-count", String(next.length));
      if (next.length >= DECK_SIZE) return cy.wrap(next);
      cy.get(ts(PAGE_NEXT)).click();
      return addAcrossPages(page + 1, next);
    });
}

describe("13 deck library — build, save, inspect, import, play", () => {
  // BUILD M8's house rule holds here too: every spec sets a seed. Nothing here starts a game, so
  // the seed only names this run's decks.
  const seed = seedFor("13-deck-library");
  const deckName = `Spec 13 ${seed}`;
  const shortName = `Spec 13 short ${seed}`;

  /** Set by the first `it`: the saved deck's server id and the cards right-clicked into it. */
  let deckId = "";
  let added: string[] = [];

  before(() => {
    expect(seed, "BUILD M8: every spec sets a seed").to.be.a("string").and.not.eq("");
    expect(shortName.length, "R171: a name the library accepts").to.be.at.most(DECK_NAME_MAX_LENGTH);

    // A re-run against the same server starts from the same library: this spec's decks, and only
    // this spec's, are deleted first.
    const p1 = accounts.p1();
    listDecks(p1.token).then((body) => {
      for (const deck of body.decks.filter((held) => [deckName, shortName].includes(held.name))) {
        cy.request({ method: "DELETE", url: api(`/api/decks/${deck.id}`), headers: bearer(p1.token) });
      }
    });
  });

  beforeEach(() => {
    cy.signIn(accounts.p1());
  });

  it("builds a deck across two pages by right-click, names it, saves it and reloads it", () => {
    cy.visit(routes.library());
    cy.get(ts(LIBRARY), { timeout: timeouts.view }).should("exist");

    cy.get(ts(LIBRARY_NEW_DECK)).click();
    cy.get(ts(DECK_CARD_COUNT))
      .should("have.attr", "data-count", "0")
      .and("have.attr", "data-deck-size", String(DECK_SIZE));

    addAcrossPages(1, []).then((ids) => {
      added = ids;
    });
    cy.get(ts(PAGE_INDICATOR)).should(($indicator) => {
      expect(Number($indicator.attr("data-page")), "the deck came from more than one page").to.be.at.least(
        2,
      );
    });

    cy.get(ts(DECK_NAME_INPUT)).clear();
    cy.get(ts(DECK_NAME_INPUT)).type(deckName);
    cy.get(ts(DECK_SAVE)).click();
    cy.get(ts(DECK_SAVED), { timeout: timeouts.view }).should("exist");

    // The server holds exactly what was right-clicked (R171), whatever order the list keeps.
    listDecks(accounts.p1().token).then((body) => {
      const saved = body.decks.find((deck) => deck.name === deckName);
      expect(saved, "the saved deck, by its name").to.not.eq(undefined);
      deckId = saved?.id ?? "";
      expect([...(saved?.cards ?? [])].sort()).to.deep.eq([...added].sort());
    });

    cy.reload();
    cy.get(ts(LIBRARY), { timeout: timeouts.view }).should("exist");
    cy.then(() => {
      cy.get(ts(LIBRARY_DECKS)).find(ts(libraryDeckId(deckId))).should("contain.text", deckName);
      cy.get(ts(libraryDeckId(deckId))).find(ts(LIBRARY_INCOMPLETE)).should("not.exist");
    });
  });

  it("opens the deck: a hovered bar shows the card, a right-clicked bar comes out", () => {
    cy.visit(routes.library());
    cy.get(ts(libraryDeckId(deckId)), { timeout: timeouts.view }).click();
    cy.get(ts(DECK_CARD_COUNT)).should("have.attr", "data-count", String(DECK_SIZE));
    cy.get(ts(DECK_NAME_INPUT)).should("have.value", deckName);
    for (const id of added) cy.get(ts(DECKLIST)).find(ts(deckBarId(id))).should("exist");

    // React's onMouseEnter is built from `mouseover`, which is what Cypress has to send.
    const hovered = added[0] ?? "";
    cy.get(ts(deckBarId(hovered))).trigger("mouseover");
    cy.get(ts(HOVER_PREVIEW)).should("be.visible").and("contain.text", nameOf(hovered));

    // Not saved: the next `it`s use the deck as the first one stored it.
    cy.get(ts(deckBarId(hovered))).rightclick();
    cy.get(ts(deckBarId(hovered))).should("not.exist");
    cy.get(ts(DECK_CARD_COUNT)).should("have.attr", "data-count", String(DECK_SIZE - 1));
  });

  it("opens a card in the inspector, turns it on a drag and closes on Esc", () => {
    cy.visit(routes.library());
    cy.get(ts(libraryDeckId(deckId)), { timeout: timeouts.view }).click();
    cy.get(PAGE_CARD).filter(":visible").first().click();
    cy.get(ts(INSPECTOR)).should("be.visible");

    cy.get(ts(INSPECTOR_CARD)).then(($card) => {
      const before = $card[0]?.style.transform ?? "";
      const halfWidth = ($card[0]?.getBoundingClientRect().width ?? 0) / 2;
      // `pointerId` 1 is the mouse's, so a `setPointerCapture` on a synthetic press has a pointer.
      const pointer = {
        eventConstructor: "PointerEvent",
        pointerId: 1,
        pointerType: "mouse",
        isPrimary: true,
        force: true,
      };
      // Re-queried each time: a re-render may replace the node the first query found.
      cy.get(ts(INSPECTOR_CARD)).trigger("pointerdown", "center", { ...pointer, button: 0, buttons: 1 });
      cy.get(ts(INSPECTOR_CARD)).trigger("pointermove", "right", {
        ...pointer,
        buttons: 1,
        movementX: halfWidth,
      });
      cy.get(ts(INSPECTOR_CARD)).should(($turned) => {
        expect($turned[0]?.style.transform, "a drag turns the card").to.not.eq(before);
      });
      cy.get(ts(INSPECTOR_CARD)).trigger("pointerup", "right", { ...pointer, button: 0, buttons: 0 });
    });

    cy.get(ts(INSPECTOR)).trigger("keydown", {
      eventConstructor: "KeyboardEvent",
      key: "Escape",
      code: "Escape",
      force: true,
    });
    cy.get(ts(INSPECTOR)).should("not.exist");
  });

  it("R171 imports the library deck into loadout slot 1", () => {
    cy.visit(routes.deckbuilder());
    cy.get(ts(DECKBUILDER), { timeout: timeouts.view }).should("exist");

    cy.get(ts(deckImportId(1))).select(deckId);
    cy.get(ts(deckCountId(1))).should("have.attr", "data-count", String(DECK_SIZE));
    for (const id of added) cy.get(ts(deckCardRowId(1, id))).should("exist");
    // Not saved: spec 09's loadout is left as it was.
  });

  it("R172 a room freezes the library deck by id; a short deck is 422, a foreign one 404", () => {
    const p1 = accounts.p1();

    cy.request<RoomBody>({
      method: "POST",
      url: api("/api/rooms"),
      headers: bearer(p1.token),
      body: { deckId },
    }).then((created) => {
      expect(created.status).to.eq(200);
      expect(created.body.code, "a room code").to.be.a("string").and.not.eq("");
      expect(created.body.deckId, "the room echoes the deck it froze").to.eq(deckId);
    });

    // R171 saves a short deck; R172 will not freeze one.
    listDecks(p1.token).then((body) => {
      cy.request<{ deck: LibraryDeckBody }>({
        method: "POST",
        url: api("/api/decks"),
        headers: bearer(p1.token),
        body: {
          catalogVersion: body.catalogVersion,
          name: shortName,
          cards: added.slice(0, DECK_SIZE - 1),
        },
      }).then((saved) => {
        cy.request<ErrorBody>({
          method: "POST",
          url: api("/api/rooms"),
          headers: bearer(p1.token),
          body: { deckId: saved.body.deck.id },
          failOnStatusCode: false,
        }).then((refused) => {
          expect(refused.status, "an incomplete deck is refused").to.eq(422);
          expect(refused.body.error.code).to.eq("loadout_invalid");
          expect(
            (refused.body.error.details ?? []).map((issue) => issue.rule),
            "the validator's L2, relayed",
          ).to.include("L2");
        });
      });
    });

    // Another account's deck reads exactly like no deck at all.
    cy.request<ErrorBody>({
      method: "POST",
      url: api("/api/rooms"),
      headers: bearer(accounts.p2().token),
      body: { deckId },
      failOnStatusCode: false,
    }).then((foreign) => {
      expect(foreign.status).to.eq(404);
      expect(foreign.body.error.code).to.eq("not_found");
    });
  });
});
