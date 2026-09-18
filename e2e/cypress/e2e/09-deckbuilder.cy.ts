// BUILD M8 spec 09 — "Loadout editor".
//
// Key assertions (BUILD M8, quoted verbatim):
//
//     "each of L1–L6 shows its message; a card dragged into a second deck is refused; save
//      succeeds when legal"
//
// THE MESSAGES ARE THE ACCEPTANCE CRITERION, so they are asserted as text — the one place the M8
// house rule "never select by text a designer may change" does not apply. Every sentence below is
// reconstructed from `packages/validator/src/index.ts`, which SPEC §9.4 makes the single
// implementation ("one validator module shared by client and server, at save and again at
// queue"), and every number in it comes from `support/config.ts`'s constants table rather than
// from a literal. If a message here and the validator disagree, one of them is wrong — that is
// the point of asserting the string and not the rule code.
//
// WHERE THEY ARE ASSERTED — BOTH HALVES. §9.3 and §9.4: "the client's verdict is UX while the
// server's is law". `PUT /api/loadout` is that law — it calls the same `@jackioh/validator` the
// deckbuilder calls, passes its issues through untouched ("no renumbering, no recomposed
// sentence") and is what a player's loadout is actually judged by. So each of the six rules is
// driven through the endpoint, and those assertions are the law half.
//
// The UX half — the sentence actually RENDERED, which is what BUILD's "shows" asks for — is
// asserted through the deckbuilder's own testids. That was once impossible and the note here said
// so; it is possible now. `e2e/support/testids.ts` carries the builder's vocabulary
// (`cardPoolId`, `deckTabId`, `deckDropId`, `deckListId`, `deckCountId`, `deckCardId`,
// `deckCardRowId`, `LOADOUT_ERRORS`, `LOADOUT_SAVE`, `LOADOUT_SAVED`, `loadoutErrorId`), it
// mirrors `apps/web/src/game/deckbuilder/testids.ts` name for name, and `cy.dragCardToDeck` is a
// whole dragstart/dragover/drop/dragend gesture with a real `DataTransfer`. Nothing is invented in
// this file.
//
// HOW MUCH OF L1–L6 A BROWSER CAN REACH, and why the rest is not a gap this file can close. The
// builder's draft has exactly two sources: the loadout `GET /api/loadout` returns, which the
// server will only ever have stored if it was legal, and edits made through the UI. And the UI
// refuses to construct five of the six failures by design:
//   - `addCard` (`deckbuilder/loadout.ts`) refuses any card already held in ANY deck, so a draft
//     can never reach L3's duplicate or L4's same-card-in-two-decks. That refusal is not a
//     limitation — it is BUILD's own second clause, and it is asserted below.
//   - `poolFrom` excludes Token-tagged cards and anything the collection does not hold, so L3's
//     Token branch and L6's unknown id are not draggable in the first place.
//   - The builder always renders three decks, so L1's wrong deck count cannot be typed into it.
//   - L5 cannot be isolated at all (see below), in the UI or out of it.
// What remains reachable by editing is L2: take a card out of a deck and it holds 19. So L2 is the
// rule whose rendered sentence this file asserts, and it asserts it TWICE — once as the client's
// own live verdict (`data-source="client"`) and once as the server's after a refused save
// (`data-source="server"`) — which is §9.3's two-verdict claim shown agreeing word for word.
// The other five sentences are rendered-message-tested where a draft can actually be handed in:
// `apps/web/src/game/deckbuilder/Deckbuilder.test.tsx`, which mounts an arbitrary draft and
// asserts all six against `validateLoadout`'s own output.
//
// L4 IS ALSO A DATABASE INVARIANT. §9.4: "a card id appears in at most one deck, also enforced by
// a unique index on `(profile_id, card_id)`" — `loadout_card_unique`, which
// `docs/architecture.md` §5 step 5 and §12 check with SQL. The UI refusal, the validator's
// refusal and the index must all agree; a browser can only see the first two, so the third stays
// where it belongs (`apps/server/test/sql/run.sh`) and is named here so the agreement is on the
// record.
//
// WHAT IS NOT PROVOKABLE, and why that is a finding rather than a gap:
//   - L6's "that card is banned" branch: `apps/server/src/api/catalog.ts` `isBanned` returns
//     false for everything ("Nothing in SPEC §8 is banned at launch"), so no loadout can reach it.
//     The "no such card in catalog version …" branch is the one asserted.
//   - L5 on its own: R111 grants "one copy of every non-token card", so the only way to use more
//     copies than are owned is to use a card twice (L3 or L4) or to use one that is not granted
//     at all (a Token, L3, or an unknown id, L6). Every L5 case therefore rides along with
//     another rule, and the spec asserts both messages instead of pretending otherwise.
//
// Needs: M6-T3 (validator + loadout endpoints) and the deckbuilder UI. See e2e/README.md.

import { CARD_NAMES, cardId } from "../../support/cards.ts";
import { accounts, constants, routes, seedFor, server, timeouts } from "../../support/config.ts";
import {
  DECKBUILDER,
  ILLEGAL,
  LEGAL,
  LOADOUT_ERRORS,
  LOADOUT_SAVE,
  cardPoolId,
  deckCardId,
  deckCardRowId,
  deckCountId,
  loadoutErrorId,
  ts,
} from "../../support/testids.ts";
import type { FixtureDeck } from "../../support/types.ts";

// ---------------------------------------------------------------------------------------------
// Local scaffolding. Items marked ASK belong in `e2e/support/**` and are in the hand-off report.
// ---------------------------------------------------------------------------------------------

/** ASK (support/commands.ts + support/config.ts): `cy.signIn(account)` and the session key. */
const SESSION_STORAGE_KEY = "jackioh.e2e.session";

/** SPEC §8 numbers 100 Core cards, and R111 grants one copy of each to an active profile. */
const CORE_CARD_COUNT = Object.keys(CARD_NAMES).length;

const DECK_SIZE = constants.DECK_SIZE;
const MAX_COPIES = constants.MAX_COPIES;
const DECKS_PER_LOADOUT = constants.DECKS_PER_LOADOUT;

/**
 * SPEC §8 #65.1's token. `support/cards.ts` lists only the 100 deckable cards ("Tokens are
 * excluded: L3 bans them from decks"), so L3's token sentence needs the name from here.
 * ASK (support/cards.ts): a `TOKEN_NAMES` map, so no spec spells a card name.
 */
const SPIKEY_PILLOW = { id: "core-065-1", name: "Spikey Pillow" };

/** An id that is in no catalog version, for L6. Deliberately outside SPEC §8's 1..100. */
const NOT_A_CARD = "core-999";

function spec8Name(index: number): string {
  const name = CARD_NAMES[index];
  if (name === undefined) throw new Error(`no SPEC §8 card #${String(index)}`);
  return name;
}

function api(path: string): string {
  return `${server.http()}${path}`;
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

/** `cardLabel` in packages/validator: `"Name" (id)` when catalogued, else the bare id. */
function cardLabel(id: string, name?: string): string {
  return name === undefined ? `"${id}"` : `"${name}" (${id})`;
}

/** `deckLabel` in packages/validator: the builder's own label, else the 1-based position. */
function deckLabel(oneBased: number): string {
  return `Deck ${String(oneBased)}`;
}

type ApiErrorBody = {
  error: { code: string; message: string; details?: { rule: string; message: string; deck?: number; cardId?: string }[] };
};

type SaveResponse = { catalogVersion: string; loadout: { catalogVersion: string; decks: string[][] } | null };

function catalogVersion(): Cypress.Chainable<string> {
  return cy
    .request<SaveResponse>({
      method: "GET",
      url: api("/api/loadout"),
      headers: bearer(accounts.p1().token),
    })
    .then((response) => response.body.catalogVersion);
}

/** One save attempt, however it turns out. `failOnStatusCode: false` so a 422 is data, not a throw. */
function save(decks: readonly (readonly string[])[]): Cypress.Chainable<Cypress.Response<ApiErrorBody & SaveResponse>> {
  return catalogVersion().then((version) =>
    cy.request<ApiErrorBody & SaveResponse>({
      method: "PUT",
      url: api("/api/loadout"),
      headers: bearer(accounts.p1().token),
      body: { catalogVersion: version, decks },
      failOnStatusCode: false,
    }),
  );
}

/**
 * §9.4's save is the authority, so this is where a rule's sentence is asserted: the first issue
 * becomes the error's message verbatim, and every issue rides along in `details` "exactly as the
 * validator reported it".
 */
function expectRefusal(
  response: Cypress.Response<ApiErrorBody & SaveResponse>,
  expected: { rule: string; message: string; first?: boolean },
): void {
  expect(response.status, "an illegal loadout is 422 loadout_invalid (§9.4)").to.eq(422);
  expect(response.body.error.code).to.eq("loadout_invalid");

  const issues = response.body.error.details ?? [];
  expect(issues, "every failure rides along in `details`, so the builder can show them all").to.be.an(
    "array",
  );
  const found = issues.find((issue) => issue.message === expected.message);
  expect(
    found,
    `${expected.rule}, verbatim from packages/validator/src/index.ts:\n  want: ${expected.message}\n  got:  ${issues.map((issue) => `[${issue.rule}] ${issue.message}`).join("\n        ")}`,
  ).to.not.eq(undefined);
  expect(found?.rule, "the issue is reported under its own rule").to.eq(expected.rule);
  if (expected.first === true) {
    expect(response.body.error.message, "the first issue is the error's own message").to.eq(
      expected.message,
    );
  }
}

type Decks = { a: string[]; b: string[]; c: string[] };

function legalDecks(): Cypress.Chainable<Decks> {
  return cy.fixture<FixtureDeck>("decks/09-deckbuilder-a.json").then((a) =>
    cy.fixture<FixtureDeck>("decks/09-deckbuilder-b.json").then((b) =>
      cy.fixture<FixtureDeck>("decks/09-deckbuilder-c.json").then((c) => ({
        a: [...a.cards],
        b: [...b.cards],
        c: [...c.cards],
      })),
    ),
  );
}

function illegalDeck(name: string): Cypress.Chainable<string[]> {
  return cy.fixture<FixtureDeck>(`decks/${name}.json`).then((deck) => [...deck.cards]);
}

/**
 * Open `/decks` as the active fixture account and wait for the builder itself, not for the route.
 *
 * `DECKBUILDER` is only rendered once the three reads the screen needs have landed — until then it
 * is `deckbuilder-loading`, or `deckbuilder-error` if one failed — so waiting for it is what makes
 * the assertions below about a loaded draft rather than about a spinner.
 */
function openBuilder(): void {
  cy.visit(routes.deckbuilder(), {
    onBeforeLoad(win) {
      win.localStorage.setItem(
        SESSION_STORAGE_KEY,
        JSON.stringify({ accessToken: accounts.p1().token }),
      );
    },
  });
  cy.get(ts(DECKBUILDER), { timeout: timeouts.view }).should("exist");
}

// ---------------------------------------------------------------------------------------------

describe("09 deckbuilder — L1 to L6, and a legal save", () => {
  // BUILD M8: every spec sets a seed. Nothing here starts a game, so the seed only pins the
  // scenario's identity (and lets CI re-run the file with `--expose seed=`); it is asserted to
  // exist so the house rule is visible rather than implied.
  const seed = seedFor("09-deckbuilder");

  before(() => {
    expect(seed, "BUILD M8: every spec sets a seed").to.be.a("string").and.not.eq("");
  });

  it("L1 — a loadout needs exactly three decks", () => {
    legalDecks().then((decks) => {
      const sent = [decks.a, decks.b];
      save(sent).then((response) => {
        expectRefusal(response, {
          rule: "L1",
          first: true,
          message: `A loadout needs exactly ${String(DECKS_PER_LOADOUT)} decks; this one has ${String(sent.length)}.`,
        });
      });
    });
  });

  it("L2 — every deck needs exactly DECK_SIZE cards", () => {
    legalDecks().then((decks) => {
      illegalDeck("09-illegal-l2-short").then((short) => {
        save([short, decks.b, decks.c]).then((response) => {
          expectRefusal(response, {
            rule: "L2",
            first: true,
            message: `${deckLabel(1)} has ${String(short.length)} cards; every deck needs exactly ${String(DECK_SIZE)}.`,
          });
        });
      });
    });
  });

  it("L3 — at most MAX_COPIES of a card per deck", () => {
    legalDecks().then((decks) => {
      illegalDeck("09-illegal-l3-duplicate").then((duplicated) => {
        const repeated = cardId(1);
        const name = spec8Name(1);
        save([duplicated, decks.b, decks.c]).then((response) => {
          expectRefusal(response, {
            rule: "L3",
            first: true,
            message:
              `${deckLabel(1)} has 2 copies of ${cardLabel(repeated, name)}; ` +
              `at most ${String(MAX_COPIES)} copy of a card is allowed per deck.`,
          });
          // R111 owns one copy of everything, so two copies is also one more than is owned.
          expectRefusal(response, {
            rule: "L5",
            message: `Your loadout uses 2 copies of ${cardLabel(repeated, name)} but you own ${String(MAX_COPIES)}.`,
          });
        });
      });
    });
  });

  it("L3 — no Token-tagged cards", () => {
    legalDecks().then((decks) => {
      illegalDeck("09-illegal-l3-token").then((withToken) => {
        save([withToken, decks.b, decks.c]).then((response) => {
          expectRefusal(response, {
            rule: "L3",
            first: true,
            message: `${deckLabel(1)} cannot contain ${cardLabel(SPIKEY_PILLOW.id, SPIKEY_PILLOW.name)}: Token cards are never deckable.`,
          });
        });
      });
    });
  });

  it("L4 — a card dragged into a second deck is refused, and L5 with it", () => {
    // BUILD's "a card dragged into a second deck is refused", at the layer that decides it. The
    // same refusal exists twice more: in the deckbuilder as UX (ASK: the drag testids), and in the
    // database as `loadout_card_unique` on `(profile_id, card_id)` (§9.4), which SQL tests cover
    // because "raw SQL putting one card in two decks is refused even with the application check
    // bypassed" (docs/architecture.md §10 step 11) is not reachable from a browser.
    legalDecks().then((decks) => {
      const shared = decks.a[0] ?? "";
      const name = spec8Name(1);
      expect(shared, "the card to duplicate across two decks").to.eq(cardId(1));

      const third = [...decks.c];
      third[third.length - 1] = shared;

      save([decks.a, decks.b, third]).then((response) => {
        expectRefusal(response, {
          rule: "L4",
          first: true,
          message: `${cardLabel(shared, name)} appears in ${deckLabel(1)} and ${deckLabel(3)}; a card may be in only one deck of a loadout.`,
        });
        expectRefusal(response, {
          rule: "L5",
          message: `Your loadout uses 2 copies of ${cardLabel(shared, name)} but you own ${String(MAX_COPIES)}.`,
        });
      });
    });
  });

  it("L5 — copies across the loadout never exceed the quantity owned", () => {
    // The Token case makes L5's "you own 0" branch reachable: R111 grants every *non-token* card,
    // so a Token is owned zero times, and `copyWord(1)` is the singular.
    legalDecks().then((decks) => {
      illegalDeck("09-illegal-l3-token").then((withToken) => {
        save([withToken, decks.b, decks.c]).then((response) => {
          expectRefusal(response, {
            rule: "L5",
            message: `Your loadout uses ${String(MAX_COPIES)} copy of ${cardLabel(SPIKEY_PILLOW.id, SPIKEY_PILLOW.name)} but you own 0.`,
          });
        });
      });
    });
  });

  it("L6 — every card exists in the current catalog version", () => {
    legalDecks().then((decks) => {
      illegalDeck("09-illegal-l6-unknown").then((unknown) => {
        catalogVersion().then((version) => {
          save([unknown, decks.b, decks.c]).then((response) => {
            // An uncatalogued id has no name, so the validator labels it with the bare id.
            expectRefusal(response, {
              rule: "L6",
              first: true,
              message: `${deckLabel(1)} cannot contain ${cardLabel(NOT_A_CARD)}: no such card in catalog version ${version}.`,
            });
          });
        });
      });
    });
  });

  it("save succeeds when legal, and the loadout reads back exactly", () => {
    legalDecks().then((decks) => {
      const sent = [decks.a, decks.b, decks.c];
      save(sent).then((response) => {
        expect(
          response.status,
          `a legal loadout saves: ${String(DECKS_PER_LOADOUT)} disjoint decks of ${String(DECK_SIZE)}`,
        ).to.eq(200);
        expect(response.body.loadout?.decks, "all three decks, in order (§9.4: one transaction)").to.deep.eq(
          sent,
        );
      });

      // §9.4: "Saving is saveLoadout(profileId, catalogVersion, decks[3]), which writes all three
      // decks in one transaction or nothing". So the read-back is part of the assertion.
      cy.request<SaveResponse>({
        method: "GET",
        url: api("/api/loadout"),
        headers: bearer(accounts.p1().token),
      }).should((response) => {
        expect(response.status).to.eq(200);
        expect(response.body.loadout?.decks).to.deep.eq(sent);
        expect(response.body.loadout?.catalogVersion, "stamped with the version it was saved under").to.eq(
          response.body.catalogVersion,
        );
      });
    });
  });

  it("the deckbuilder screen opens for an active profile and shows the saved loadout", () => {
    // What this suite can assert about the screen without new testids: §9.4's gate lets an active
    // account in (spec 10 shows the same route bouncing a pending one to the code screen), and the
    // builder renders the loadout the previous `it` saved. The card names come from
    // `support/cards.ts`, which is SPEC §8 data rather than copy a designer owns, so this is not
    // the "select by text" the M8 house rule bans — and it fails if the route serves anything
    // other than a loaded deckbuilder.
    //
    // The other two things BUILD's row asks of the DOM — a rendered rule sentence, and the drag
    // into a second deck being refused — are the two `it`s after this one.
    cy.visit(routes.deckbuilder(), {
      onBeforeLoad(win) {
        win.localStorage.setItem(
          SESSION_STORAGE_KEY,
          JSON.stringify({ accessToken: accounts.p1().token }),
        );
      },
    });
    cy.location("pathname").should("eq", routes.deckbuilder());
    cy.location("pathname").should("not.eq", routes.login());
    cy.location("pathname").should("not.eq", routes.invite());

    // One card from each of the three saved decks: #1 (deck 1), #21 (deck 2), #41 (deck 3).
    for (const index of [1, 21, 41]) {
      cy.contains(spec8Name(index)).should("exist");
    }
  });

  it("L2 — the builder SHOWS the validator's sentence, and the server's copy of it says the same", () => {
    // BUILD's "shows its message", at the layer the word means. The draft starts as the legal
    // loadout the save above stored, so the one failure a browser can steer it into is L2: take a
    // card out of deck 1 and it holds DECK_SIZE - 1.
    openBuilder();

    const removed = cardId(1);
    const short = DECK_SIZE - 1;
    const sentence = `${deckLabel(1)} has ${String(short)} cards; every deck needs exactly ${String(DECK_SIZE)}.`;

    cy.get(ts(deckCountId(1))).should("have.attr", "data-count", String(DECK_SIZE));
    cy.get(ts(deckCardId(1, removed))).click();
    cy.get(ts(deckCountId(1))).should("have.attr", "data-count", String(short));

    // The client's own verdict, live, with no save involved (§9.3: "the client's verdict is UX").
    // Asserted inside the errors list, so a sentence rendered anywhere else would not count.
    cy.get(ts(LOADOUT_ERRORS)).find(ts(loadoutErrorId("L2"))).should("have.length", 1);
    cy.get(ts(LOADOUT_ERRORS)).find(ts(loadoutErrorId("L2"))).should("have.text", sentence);
    cy.get(ts(loadoutErrorId("L2"))).should("have.attr", "data-source", "client");
    cy.get(ts(loadoutErrorId("L2"))).should("have.attr", "data-rule", "L2");

    // …and the server's, which §9.4 makes law. `PUT /api/loadout` refuses the same draft and its
    // issues replace the client's — so this is the two verdicts of §9.3 shown agreeing word for
    // word, which is the whole reason the validator is one shared module (M6-T3).
    cy.get(ts(LOADOUT_SAVE)).click();
    cy.get(ts(loadoutErrorId("L2")), { timeout: timeouts.view }).should(
      "have.attr",
      "data-source",
      "server",
    );
    cy.get(ts(LOADOUT_ERRORS)).find(ts(loadoutErrorId("L2"))).should("have.text", sentence);

    // The refused save changed nothing on the server, so the next `it` still opens a legal draft.
    cy.request<SaveResponse>({
      method: "GET",
      url: api("/api/loadout"),
      headers: bearer(accounts.p1().token),
    })
      .its("body.loadout.decks.0.length")
      .should("eq", DECK_SIZE);
  });

  it("BUILD M8 — a card dragged into a second deck is refused, on screen", () => {
    // The clause this file used to prove only as JSON. `cy.dragCardToDeck` is the real gesture:
    // dragstart on the pool card with a `DataTransfer` built in the app's own window, dragover and
    // drop on the deck region, dragend to let go.
    openBuilder();

    // #1 is in deck 1 of the loadout the save above stored, so dropping it into deck 2 is exactly
    // "a card dragged into a second deck". L4 and the `loadout_card_unique` index say the same
    // thing one and two layers down (§9.4); this is the top layer saying it first.
    const held = cardId(1);
    cy.get(ts(deckCardRowId(1, held))).should("exist");
    // The pool marks it before anything is dragged: M5-T2's `data-legal="false"` vocabulary,
    // reused here rather than a second word for the same statement.
    cy.get(`${ts(cardPoolId(held))}${ILLEGAL}`).should("exist");
    cy.get(ts(cardPoolId(held))).should("have.attr", "data-in-deck", "1");

    cy.dragCardToDeck(held, 1); // 0-based, like the API's deckIndex: deck 2 on screen.

    // Refused: deck 2 never gained it, deck 1 never lost it, and both are still DECK_SIZE.
    cy.get(ts(deckCardRowId(2, held))).should("not.exist");
    cy.get(ts(deckCardRowId(1, held))).should("exist");
    cy.get(ts(deckCountId(1))).should("have.attr", "data-count", String(DECK_SIZE));
    cy.get(ts(deckCountId(2))).should("have.attr", "data-count", String(DECK_SIZE));
    // …and the builder said so, rather than silently dropping the gesture.
    cy.get(ts(cardPoolId(held))).should("have.attr", "data-refused", "true");

    // The draft is still legal, so no rule sentence is on screen: the refusal is what kept it
    // legal, which is the difference between refusing a drag and reporting L4 after the fact.
    cy.get(ts(LOADOUT_ERRORS)).should("have.attr", "data-count", "0");
    cy.get(ts(loadoutErrorId("L4"))).should("not.exist");

    // THE CONTROL, and the reason the assertions above mean anything. "Refused" and "the gesture
    // never fired" leave an identical board, so a drag that did nothing at all would satisfy every
    // line above. Dragging a card the loadout does NOT hold, with the same command onto the same
    // region, has to land — and then the refusal is specific to the card being held elsewhere
    // rather than a property of `cy.dragCardToDeck`.
    legalDecks().then((decks) => {
      const used = new Set([...decks.a, ...decks.b, ...decks.c]);
      const free = Array.from({ length: CORE_CARD_COUNT }, (_unused, index) => cardId(index + 1)).find(
        (id) => !used.has(id),
      );
      expect(free, "a Core card the saved loadout does not hold (R111 grants all 100)").to.not.eq(
        undefined,
      );
      if (free === undefined) return;

      cy.get(`${ts(cardPoolId(free))}${LEGAL}`).should("exist");
      cy.dragCardToDeck(free, 1);

      cy.get(ts(deckCardRowId(2, free))).should("exist");
      cy.get(ts(deckCountId(2))).should("have.attr", "data-count", String(DECK_SIZE + 1));
      // …and the builder shows L2 for the deck that is now one card over, which is the same
      // sentence from the same validator about the other end of the same rule.
      cy.get(ts(LOADOUT_ERRORS))
        .find(ts(loadoutErrorId("L2")))
        .should(
          "have.text",
          `${deckLabel(2)} has ${String(DECK_SIZE + 1)} cards; every deck needs exactly ${String(DECK_SIZE)}.`,
        );
    });
  });
});
