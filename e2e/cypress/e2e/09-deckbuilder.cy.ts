// BUILD M8 spec 09 — "The deck workshop and the queue's rules (§9.4, R250–R253)".
//
// Key assertions (BUILD M8, quoted verbatim):
//
//     "each of L1–L6 shows its message, in the builder's verdict and in the queue's refusal; a
//      card a compared deck holds is refused; a legal deck and trio queue"
//
// THE MESSAGES ARE THE ACCEPTANCE CRITERION, so they are asserted as text: every sentence below is
// rebuilt from `packages/validator/src/index.ts`, which SPEC §9.4 makes the single implementation
// ("one validator module shared by client and server"), with every number from `support/config.ts`
// and every card name from `support/cards.ts`. If a sentence here and the validator disagree, one
// of them is wrong — that is the point of asserting the string and not only the rule code.
//
// TWO VERDICTS, ONE MODULE. §9.3: "the client's verdict is UX while the server's is law". The UX
// half is the workshop's verdict — `deck-verdict` for Best of 1 (`validateDeck`: L2, L3, L5, L6)
// and `trio-verdict` for Best of 3 (`validateTrio`: L1–L6) — each sentence a `loadout-error-<rule>`
// with `data-source="client"`. The law half is the queue (R253): `POST /api/queue` with a deck or a
// trio answers 422 `loadout_invalid`, the first sentence as its message and every one in `details`.
// Both name the decks by their saved names, so the two are asserted to say the same words.
//
// WHICH RULES THE QUEUE CAN BE SHOWN. A save checks only D1–D4 (R250): a deck may be incomplete or
// share cards with another deck of a trio, so L1, L2, L4 and L5 (which here only ever rides with L4:
// R111 grants one copy of every card, so a second copy is the only way to use more than is owned)
// are built by saving and refused at the queue. L3 and L6 cannot reach the queue at all: D3 refuses
// a Token or an id outside the catalog, and D4 a second copy, when the deck is SAVED — so the queue's
// L3 and L6 guard only a catalog that changed under a saved deck, which one E2E server cannot stage.
// What this file shows for those two is everything a player can meet: the builder's verdict on a
// draft this device kept (the workshop restores unsynced drafts from its local mirror, R256, and a
// mirror is untrusted input), the server refusing that draft's save with its D-rule sentence, and
// the queue never having it to judge ("That deck is no longer saved").
//
// Every seed is set (BUILD M8), though nothing here starts a game: the queue tickets are taken out
// again at once, and `cy.freeAccount` clears both fixture accounts first so no ticket another spec
// left can pair with them.
//
// Needs: M6 (validator, deck and queue endpoints) and TASK 1's deck workshop. See e2e/README.md.

import { CARD_NAMES, TOKEN_NAMES, cardId, tokenId } from "../../support/cards.ts";
import { INSTALLED_TRIO_NAME, mintId, type SavedDecksBody } from "../../support/commands.ts";
import { accounts, constants, deckMirrorKey, routes, seedFor, server, timeouts, type E2EAccount } from "../../support/config.ts";
import {
  DECK_COMPARE_SELECT,
  DECK_COUNT,
  DECK_EDITOR,
  DECK_SAVE_ERROR,
  DECK_STATUS,
  DECK_VERDICT,
  LOADOUT_ERRORS,
  SYNC_STATUS,
  TRIO_EDITOR,
  TRIO_VERDICT,
  WORKSHOP,
  addPoolId,
  deckCardId,
  deckCompareChipId,
  deckRowId,
  loadoutErrorId,
  poolCardId,
  trioRowId,
  ts,
} from "../../support/testids.ts";
import type { FixtureDeck } from "../../support/types.ts";

// ---------------------------------------------------------------------------------------------
// the validator's sentences (packages/validator/src/index.ts), rebuilt
// ---------------------------------------------------------------------------------------------

const DECK_SIZE = constants.DECK_SIZE;
const MAX_COPIES = constants.MAX_COPIES;
const TRIO_DECKS = constants.DECKS_PER_LOADOUT;

/** R111: one copy of every non-token card is what an active fixture account owns. */
const OWNED = MAX_COPIES;

/** An id in no catalog version, for L6. Deliberately outside SPEC §8's 1..100. */
const NOT_A_CARD = "core-999";

/** SPEC §8 #65.1: a Token, for L3's Token sentence. */
const SPIKEY_PILLOW = tokenId("65.1");

function nameOf(id: string): string | undefined {
  const index = /^core-(\d{3})$/.exec(id)?.[1];
  if (index !== undefined) return CARD_NAMES[Number(index)];
  const token = Object.keys(TOKEN_NAMES).find((key) => tokenId(key) === id);
  return token === undefined ? undefined : TOKEN_NAMES[token];
}

/** `cardLabel`: `"Name" (id)` for a catalogued card, else the bare id in quotes. */
function cardLabel(id: string): string {
  const name = nameOf(id);
  return name === undefined ? `"${id}"` : `"${name}" (${id})`;
}

function copyWord(count: number): string {
  return count === 1 ? "copy" : "copies";
}

function cardWord(count: number): string {
  return count === 1 ? "card" : "cards";
}

const sentence = {
  L1: (decks: number) => `A trio needs exactly ${String(TRIO_DECKS)} decks; this one has ${String(decks)}.`,
  L2: (deck: string, cards: number) =>
    `${deck} has ${String(cards)} ${cardWord(cards)}; every deck needs exactly ${String(DECK_SIZE)}.`,
  L3token: (deck: string, id: string) => `${deck} cannot contain ${cardLabel(id)}: Token cards are never deckable.`,
  L3copies: (deck: string, id: string, count: number) =>
    `${deck} has ${String(count)} ${copyWord(count)} of ${cardLabel(id)}; ` +
    `at most ${String(MAX_COPIES)} ${copyWord(MAX_COPIES)} of a card is allowed per deck.`,
  L4: (id: string, decks: readonly [string, string]) =>
    `${cardLabel(id)} appears in ${decks[0]} and ${decks[1]}; a card may be in only one deck of a trio.`,
  L5trio: (id: string, used: number, owned: number) =>
    `Your trio uses ${String(used)} ${copyWord(used)} of ${cardLabel(id)} but you own ${String(owned)}.`,
  L5deck: (deck: string, id: string, used: number, owned: number) =>
    `${deck} uses ${String(used)} ${copyWord(used)} of ${cardLabel(id)} but you own ${String(owned)}.`,
  L6: (deck: string, id: string, version: string) =>
    `${deck} cannot contain ${cardLabel(id)}: no such card in catalog version ${version}.`,
};

// ---------------------------------------------------------------------------------------------
// the HTTP half
// ---------------------------------------------------------------------------------------------

type Issue = { rule: string; message: string; deck?: number; cardId?: string };
type ErrorBody = { error: { code: string; message: string; details?: unknown } };

function api(path: string): string {
  return `${server.http()}${path}`;
}

function bearer(account: E2EAccount): Record<string, string> {
  return { authorization: `Bearer ${account.token}` };
}

/** One enqueue attempt, however it turns out: a 422 is data here, not a throw. */
function enqueue(account: E2EAccount, body: Record<string, unknown>): Cypress.Chainable<Cypress.Response<ErrorBody & { mode?: string }>> {
  return cy.request<ErrorBody & { mode?: string }>({
    method: "POST",
    url: api("/api/queue"),
    headers: bearer(account),
    body,
    failOnStatusCode: false,
  });
}

/**
 * The queue's refusal (R253): 422 `loadout_invalid`, each expected sentence present under its own
 * rule in `details`, and the first of them the error's own message.
 */
function expectQueueRefusal(
  response: Cypress.Response<ErrorBody>,
  expected: readonly { rule: string; message: string }[],
): void {
  expect(response.status, "the queue refuses an illegal choice with 422 (R253)").to.eq(422);
  expect(response.body.error.code).to.eq("loadout_invalid");
  const issues = (Array.isArray(response.body.error.details) ? response.body.error.details : []) as Issue[];
  for (const want of expected) {
    const found = issues.find((issue) => issue.message === want.message);
    expect(
      found,
      `${want.rule} from the queue, verbatim:\n  want: ${want.message}\n  got:  ${issues.map((issue) => `[${issue.rule}] ${issue.message}`).join("\n        ")}`,
    ).to.not.eq(undefined);
    expect(found?.rule, "reported under its own rule").to.eq(want.rule);
  }
  expect(response.body.error.message, "the first sentence is the refusal's own message").to.eq(issues[0]?.message);
}

/** The workshop's own verdict: the sentence, under its rule, from the client. */
function expectVerdict(verdict: string, rule: string, message: string): void {
  cy.get(ts(verdict)).should("have.attr", "data-ready", "false");
  cy.get(ts(verdict))
    .find(`${ts(LOADOUT_ERRORS)} ${ts(loadoutErrorId(rule))}`)
    .filter((_index, element) => element.textContent === message)
    .should("have.length", 1)
    .and("have.attr", "data-rule", rule)
    .and("have.attr", "data-source", "client");
}

// ---------------------------------------------------------------------------------------------
// decks
// ---------------------------------------------------------------------------------------------

type Legal = { a: string[]; b: string[]; c: string[] };

/** The three disjoint legal decks of `09-deckbuilder-{a,b,c}` (SPEC §8 #1–#20, #21–#40, #41–#60). */
function legalDecks(): Cypress.Chainable<Legal> {
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

/** A Core card none of the three legal decks holds (SPEC §8 #61 onwards). */
const FREE_CARD = cardId(61);

/** Open `/decks` and wait for the workshop itself, not for the route. */
function openWorkshop(account: E2EAccount, options: Partial<Cypress.VisitOptions> = {}): void {
  cy.visitAs(account, routes.deckbuilder(), options);
  cy.get(ts(WORKSHOP), { timeout: timeouts.view }).should("exist");
}

// ---------------------------------------------------------------------------------------------

describe("09 deck workshop — L1 to L6 in the builder and at the queue, a compared deck's card, a legal queue", () => {
  const seed = seedFor("09-deckbuilder");

  before(() => {
    expect(seed, "BUILD M8: every spec sets a seed").to.be.a("string").and.not.eq("");
  });

  beforeEach(() => {
    cy.freeAccount(accounts.p1());
    cy.freeAccount(accounts.p2());
    cy.clearDecks(accounts.p1());
  });

  it("L1 — a trio with an empty slot: the trio's verdict and the Best-of-3 queue say the same", () => {
    const me = accounts.p1();
    legalDecks().then((legal) => {
      cy.saveDeck(me, { name: "Aggro", cards: legal.a }).then((aggro) => {
        cy.saveDeck(me, { name: "Control", cards: legal.c }).then((control) => {
          cy.saveTrio(me, { name: "Two decks", deckIds: [aggro, control, null] }).then((trio) => {
            const message = sentence.L1(2);

            openWorkshop(me);
            cy.get(ts(trioRowId(trio))).should("have.attr", "data-ready", "false").click();
            cy.get(ts(TRIO_EDITOR)).should("have.attr", "data-trio", trio);
            expectVerdict(TRIO_VERDICT, "L1", message);

            enqueue(me, { mode: "bo3", trioId: trio, seed }).then((response) => {
              expectQueueRefusal(response, [{ rule: "L1", message }]);
            });
          });
        });
      });
    });
  });

  it("L2 — an incomplete deck saves (R250), and the deck's verdict and the Best-of-1 queue refuse it", () => {
    const me = accounts.p1();
    legalDecks().then((legal) => {
      const short = legal.a.slice(0, DECK_SIZE - 1);
      cy.saveDeck(me, { name: "Short", cards: short }).then((deck) => {
        const message = sentence.L2("Short", short.length);

        openWorkshop(me);
        cy.get(ts(deckRowId(deck))).should("have.attr", "data-count", String(short.length)).click();
        cy.get(ts(DECK_EDITOR)).should("have.attr", "data-deck", deck);
        cy.get(ts(DECK_COUNT)).should("have.attr", "data-count", String(short.length));
        expectVerdict(DECK_VERDICT, "L2", message);

        enqueue(me, { mode: "bo1", deckId: deck, seed }).then((response) => {
          expectQueueRefusal(response, [{ rule: "L2", message }]);
        });
      });
    });
  });

  it("L4 and L5 — a trio whose decks share a card: marked in the trio's verdict and refused by the queue", () => {
    const me = accounts.p1();
    legalDecks().then((legal) => {
      const shared = legal.a[0] ?? "";
      // "Midrange" is 09-deckbuilder-b with its last card swapped for one Aggro holds.
      const midrange = [...legal.b.slice(0, DECK_SIZE - 1), shared];
      cy.saveDeck(me, { name: "Aggro", cards: legal.a }).then((aggro) => {
        cy.saveDeck(me, { name: "Midrange", cards: midrange }).then((mid) => {
          cy.saveDeck(me, { name: "Control", cards: legal.c }).then((control) => {
            cy.saveTrio(me, { name: "Shared card", deckIds: [aggro, mid, control] }).then((trio) => {
              const l4 = sentence.L4(shared, ["Aggro", "Midrange"]);
              // R111 owns one copy, so a card in two decks is one more than is owned.
              const l5 = sentence.L5trio(shared, 2, OWNED);

              openWorkshop(me);
              cy.get(ts(trioRowId(trio))).click();
              expectVerdict(TRIO_VERDICT, "L4", l4);
              expectVerdict(TRIO_VERDICT, "L5", l5);

              enqueue(me, { mode: "bo3", trioId: trio, seed }).then((response) => {
                expectQueueRefusal(response, [
                  { rule: "L4", message: l4 },
                  { rule: "L5", message: l5 },
                ]);
              });
            });
          });
        });
      });
    });
  });

  it("L3 and L6 — a draft this device kept shows its sentences, and the save refuses it before any queue can see it", () => {
    const me = accounts.p1();
    type Draft = { id: string; name: string; cards: string[]; rules: { rule: string; message: string }[]; save: string };
    let version = "";
    let drafts: Draft[] = [];

    cy.savedDecks(me).then((saved: SavedDecksBody) => {
      version = saved.catalogVersion;
    });
    legalDecks().then((legal) => {
      const base = legal.a.slice(0, DECK_SIZE - 1);
      const twice = legal.a[0] ?? "";
      drafts = [
        {
          id: mintId(),
          name: "Twice",
          cards: [...base, twice],
          rules: [
            { rule: "L3", message: sentence.L3copies("Twice", twice, 2) },
            { rule: "L5", message: sentence.L5deck("Twice", twice, 2, OWNED) },
          ],
          // D4, the save's own sentence (packages/validator `checkDeckDraft`).
          save: `A deck may hold at most ${String(MAX_COPIES)} ${copyWord(MAX_COPIES)} of "${twice}"; this one has 2.`,
        },
        {
          id: mintId(),
          name: "Pillow",
          cards: [...base, SPIKEY_PILLOW],
          rules: [
            { rule: "L3", message: sentence.L3token("Pillow", SPIKEY_PILLOW) },
            { rule: "L5", message: sentence.L5deck("Pillow", SPIKEY_PILLOW, 1, 0) },
          ],
          // D3.
          save: `"${SPIKEY_PILLOW}" is not a card a deck can hold.`,
        },
        {
          id: mintId(),
          name: "Stale",
          cards: [...base, NOT_A_CARD],
          // L6's sentence names the catalog version, which is read above; it is filled in below.
          rules: [
            { rule: "L6", message: "" },
            { rule: "L5", message: sentence.L5deck("Stale", NOT_A_CARD, 1, 0) },
          ],
          save: `"${NOT_A_CARD}" is not a card a deck can hold.`,
        },
      ];
    });

    // R256: the workshop mirrors every edit to this device and, on the next visit, restores what the
    // server never confirmed over the server's copy. These three are drafts it never confirmed.
    cy.request<{ profile: { id: string } }>({ method: "GET", url: api("/api/auth/me"), headers: bearer(me) })
      .its("body.profile.id")
      .then((profileId) => {
        const now = Date.now();
        const mirror = {
          v: 1,
          decks: drafts.map((draft, at) => ({
            item: { id: draft.id, name: draft.name, cards: draft.cards, createdAt: now + at, updatedAt: now + at },
            dirty: true,
          })),
          trios: [],
          deletedDecks: [],
          deletedTrios: [],
        };
        openWorkshop(me, {
          onBeforeLoad(win) {
            win.localStorage.setItem(deckMirrorKey(profileId), JSON.stringify(mirror));
          },
        });
      });

    cy.then(() => {
      for (const draft of drafts) {
        cy.get(ts(deckRowId(draft.id)), { timeout: timeouts.view }).should("have.attr", "data-unsynced", "true").click();
        cy.get(ts(DECK_EDITOR)).should("have.attr", "data-deck", draft.id);
        for (const want of draft.rules) {
          const message = want.rule === "L6" ? sentence.L6(draft.name, NOT_A_CARD, version) : want.message;
          expectVerdict(DECK_VERDICT, want.rule, message);
        }
        // The server is law: the save is refused with the draft rule's sentence, shown verbatim.
        cy.get(ts(DECK_SAVE_ERROR), { timeout: timeouts.view }).should("have.text", draft.save);
      }
    });
    cy.get(ts(SYNC_STATUS)).should("have.attr", "data-state", "error");

    // The same refusal over HTTP, and the queue never has these decks to judge.
    cy.then(() => {
      for (const draft of drafts) {
        cy.request<ErrorBody>({
          method: "PUT",
          url: api(`/api/decks/${draft.id}`),
          headers: bearer(me),
          body: { name: draft.name, cards: draft.cards, catalogVersion: version },
          failOnStatusCode: false,
        }).should((response) => {
          expect(response.status, "R250: D3/D4 refuse the save").to.eq(400);
          expect(response.body.error.message).to.eq(draft.save);
        });
        enqueue(me, { mode: "bo1", deckId: draft.id, seed }).should((response) => {
          expect(response.status).to.eq(422);
          expect(response.body.error.message, "the queue has no such deck to judge").to.eq(
            "That deck is no longer saved; pick another.",
          );
        });
      }
      cy.savedDecks(me).its("decks").should("have.length", 0);
    });
  });

  it("a card a compared deck holds is refused, and the status line names that deck (R251)", () => {
    const me = accounts.p1();
    legalDecks().then((legal) => {
      const held = legal.a[0] ?? "";
      const building = legal.c.slice(0, DECK_SIZE - 1);
      cy.saveDeck(me, { name: "Keeper", cards: legal.a }).then((keeper) => {
        cy.saveDeck(me, { name: "Builder", cards: building }).then((builder) => {
          openWorkshop(me);
          cy.get(ts(deckRowId(builder))).click();
          cy.get(ts(DECK_EDITOR)).should("have.attr", "data-deck", builder);
          cy.get(ts(DECK_COMPARE_SELECT)).select(`deck:${keeper}`);
          cy.get(ts(deckCompareChipId(keeper))).should("be.visible");

          // The pool marks it before anything is tried.
          cy.get(ts(poolCardId(held)))
            .should("have.attr", "data-unavailable", "true")
            .and("have.attr", "data-held-by", "Keeper")
            .and("have.attr", "data-legal", "false");

          // The "+" is refused, and says where the card is.
          cy.get(ts(addPoolId(held))).click();
          cy.get(ts(DECK_STATUS)).should("have.text", `${nameOf(held) ?? held} is in Keeper.`);
          cy.get(ts(deckCardId(held))).should("not.exist");
          cy.get(ts(DECK_COUNT)).should("have.attr", "data-count", String(building.length));

          // So is a drag onto the deck.
          cy.dragCardToDeck(held);
          cy.get(ts(DECK_STATUS)).should("have.text", `${nameOf(held) ?? held} is in Keeper.`);
          cy.get(ts(deckCardId(held))).should("not.exist");
          cy.get(ts(DECK_COUNT)).should("have.attr", "data-count", String(building.length));

          // THE CONTROL: "refused" and "the gesture did nothing" leave the same deck, so a card no
          // compared deck holds must land by the same gesture — and completing the deck saves it.
          cy.get(ts(poolCardId(FREE_CARD))).should("have.attr", "data-legal", "true");
          cy.dragCardToDeck(FREE_CARD);
          cy.get(ts(deckCardId(FREE_CARD))).should("exist");
          cy.get(ts(DECK_COUNT)).should("have.attr", "data-count", String(DECK_SIZE));
          // R256: the row loses its "not saved yet" mark once the server has confirmed the edit.
          cy.get(ts(deckRowId(builder)), { timeout: timeouts.view }).should("not.have.attr", "data-unsynced");
          cy.get(ts(SYNC_STATUS)).should("have.attr", "data-state", "saved");
          cy.savedDecks(me).should((saved) => {
            const found = saved.decks.find((deck) => deck.id === builder);
            expect(found?.cards, "the server has the completed deck").to.have.length(DECK_SIZE);
            expect(found?.cards).to.include(FREE_CARD).and.not.include(held);
          });
        });
      });
    });
  });

  it("a legal deck and a legal trio queue, and leave the queue again", () => {
    const me = accounts.p1();
    cy.installLoadout(me, "09-deckbuilder-a").then((installed) => {
      openWorkshop(me);
      cy.get(ts(trioRowId(installed.trioId))).should("have.attr", "data-ready", "true").click();
      cy.get(ts(TRIO_VERDICT)).should("have.attr", "data-ready", "true");
      cy.get(ts(TRIO_VERDICT)).find(ts(LOADOUT_ERRORS)).should("have.attr", "data-count", "0");
      cy.get(ts(deckRowId(installed.deckIds[0]))).click();
      cy.get(ts(DECK_VERDICT)).should("have.attr", "data-ready", "true");

      enqueue(me, { mode: "bo1", deckId: installed.deckIds[0], seed }).should((response) => {
        expect(response.status, "R253: a legal deck queues Best of 1").to.eq(200);
        expect(response.body.mode).to.eq("bo1");
      });
      cy.request({ method: "DELETE", url: api("/api/queue"), headers: bearer(me) }).its("status").should("eq", 200);

      enqueue(me, { mode: "bo3", trioId: installed.trioId, seed }).should((response) => {
        expect(response.status, `R253: "${INSTALLED_TRIO_NAME}", three disjoint legal decks, queues Best of 3`).to.eq(200);
        expect(response.body.mode).to.eq("bo3");
      });
      cy.request({ method: "DELETE", url: api("/api/queue"), headers: bearer(me) }).its("status").should("eq", 200);
    });
  });
});
