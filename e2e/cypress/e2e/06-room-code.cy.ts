// BUILD M8 spec 06 — "Create room, second player joins via `cy.task(\"wsPlayer\")`".
//
// Key assertions (BUILD M8, quoted verbatim):
//
//     "both see the board; actions round-trip; game ends and both are queue-eligible"
//
// This is also the M6 gate: "`e2e/06` (room-code match) passes with the second player driven by a
// Node WebSocket client via `cy.task`."
//
// THE ROOM CODE. R79 and §9.5 make it 6 characters (`ROOM_CODE_LENGTH`) from the invite-code
// alphabet, and R104 writes that alphabet out: `23456789ABCDEFGHJKLMNPQRSTUVWXYZ`. R104 exists
// because §9.4's "32-symbol alphabet without 0/O/1/I/l" is unsatisfiable as written — dropping
// 0, 1, I, O *and* L from the 36 alphanumerics leaves 31 — so the resolution keeps 32 symbols by
// dropping four and normalising input to upper case. Neither the length nor the alphabet is
// spelled in this file: both are imported from `apps/server/src/config.ts`, and the spec also
// checks that `support/config.ts`'s own mirror of the length has not drifted from it.
//
// R110: a room code is unique only among matches that are not yet `over`, so a finished match
// releases its code rather than burning it. That is not directly observable from a browser (the
// suite cannot make the server mint a chosen code), so what this spec asserts is R110's visible
// consequence and BUILD's actual criterion: once the match is over, both profiles are out of a
// match and can enter the queue again. The reuse of the code itself belongs to a server test.
//
// HOW SEAT 2 JOINS. Not over the socket. `apps/server/src/match/protocol.ts` accepts a `joinRoom`
// frame "only so a client that speaks it gets a pointed `error` instead of 'malformed': joining a
// room is `POST /api/rooms/:code/join`, because the atomic single-claim and the loadout re-check
// are HTTP concerns and a socket is opened for a match that already exists." So seat 2 claims the
// room over HTTP and only then opens its socket onto the match id it was given. The
// `cy.wsPlayer({ action: "joinRoom" })` command in `support/commands.ts` cannot work against this
// protocol — see the hand-off report.
//
// HIDDEN INFORMATION. CLAUDE.md rule 7: the client renders `viewFor` and never sees hidden
// information. Two assertions hold the line: seat 2's view must report its opponent's hand as a
// bare count (§10.8), and the browser must render exactly as many hand cards as that count says
// seat 1 holds — no more.
//
// Needs: M6 (server, match actor, WS protocol). See e2e/README.md.

import { CODE_ALPHABET, ROOM_CODE_LENGTH } from "../../../apps/server/src/config.ts";
import { CARD_NAMES, cardId } from "../../support/cards.ts";
import { accounts, constants, routes, seedFor, server, timeouts } from "../../support/config.ts";
import {
  END_TURN,
  MANA_CRYSTAL,
  handCardId,
  handCountId,
  heroId,
  manaId,
  ts,
  zoneId,
} from "../../support/testids.ts";
import type { ActionInput, FixtureDeck, Lane, PlayerId, Row, Side } from "../../support/types.ts";

// ---------------------------------------------------------------------------------------------
// Local scaffolding. Items marked ASK belong in `e2e/support/**` (one place to change) and are
// listed in the hand-off report for this spec.
// ---------------------------------------------------------------------------------------------

/** ASK (support/commands.ts + support/config.ts): `cy.signIn(account)` and the session key. */
const SESSION_STORAGE_KEY = "jackioh.e2e.session";

const SEAT_TWO = "seat-two";
const SEAT_ONE_ID: PlayerId = "p1";
const SEAT_TWO_ID: PlayerId = "p2";

const LANES: readonly Lane[] = [1, 2, 3, 4, 5];
const ROWS: readonly Row[] = ["units", "backrow"];
const SIDES: readonly Side[] = ["you", "opponent"];

const CORE_CARD_COUNT = Object.keys(CARD_NAMES).length;

/** `handCardId("")` is the prefix, so no spec spells a testid format. */
const HAND_CARD_PREFIX = handCardId("");

function api(path: string): string {
  return `${server.http()}${path}`;
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

/** See 05-reconnect.cy.ts: L1 wants 3 decks and L4 wants them disjoint. ASK: `cy.installLoadout`. */
function loadoutFrom(deck: readonly string[]): string[][] {
  const used = new Set(deck);
  const spare = Array.from({ length: CORE_CARD_COUNT }, (_, index) => cardId(index + 1)).filter(
    (id) => !used.has(id),
  );
  const size = constants.DECK_SIZE;
  expect(spare.length, "enough spare Core ids to pad a loadout").to.be.at.least(size * 2);
  return [[...deck], spare.slice(0, size), spare.slice(size, size * 2)];
}

function installLoadout(token: string, deck: readonly string[]): void {
  cy.request<{ catalogVersion: string }>({
    method: "GET",
    url: api("/api/loadout"),
    headers: bearer(token),
  }).then((current) => {
    cy.request({
      method: "PUT",
      url: api("/api/loadout"),
      headers: bearer(token),
      body: { catalogVersion: current.body.catalogVersion, decks: loadoutFrom(deck) },
    })
      .its("status")
      .should("eq", 200);
  });
}

function visitAs(token: string, path: string): void {
  cy.visit(path, {
    onBeforeLoad(win) {
      win.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify({ accessToken: token }));
    },
  });
}

// --- reading seat 2's view --------------------------------------------------------------------

type CardLike = { instanceId: string };
type SideLike = {
  player?: string;
  hero?: { health?: number; armor?: number };
  hand?: CardLike[] | { count: number };
  units?: unknown[];
  backrow?: unknown[];
  libraryCount?: number;
};

type ViewLike = {
  viewer?: string;
  turn?: number;
  active?: string;
  phase?: string;
  you?: SideLike;
  opponent?: SideLike;
  result?: { winner?: string; reason?: string } | null;
};

function asView(view: Record<string, unknown> | null | undefined): ViewLike {
  expect(view, "a PlayerView on seat 2's socket (§10.8)").to.be.an("object");
  return (view ?? {}) as ViewLike;
}

function ownHandIds(view: Record<string, unknown> | null | undefined): string[] {
  const hand = asView(view).you?.hand;
  expect(Array.isArray(hand), "the viewer's own hand arrives as cards, not a count (§10.8)").to.eq(
    true,
  );
  return (Array.isArray(hand) ? hand : []).map((card) => card.instanceId);
}

/** §10.8: "counts for the opponent's hand". A number here, never an array. */
function opponentHandCount(view: Record<string, unknown> | null | undefined): number {
  const hand = asView(view).opponent?.hand;
  expect(
    Array.isArray(hand),
    "CLAUDE.md rule 7 / §10.8: the opponent's hand is a count, never cards",
  ).to.eq(false);
  const count = (hand as { count?: number } | undefined)?.count;
  expect(count, "the opponent's hand count").to.be.a("number");
  return count ?? -1;
}

function seatTwoKeepsMulligan(): void {
  cy.wsPlayer({ action: "awaitView", name: SEAT_TWO, where: { promptKind: "mulligan" } }).then(
    (result) => {
      // R9: the answer names the cards kept, so keeping everything is the whole hand.
      const body: ActionInput = {
        type: "mulligan",
        keep: ownHandIds(result.view),
        // Discarded by `parseClientMessage`; the actor stamps the authenticated seat.
        playerId: SEAT_TWO_ID,
      };
      cy.wsPlayer({ action: "send", name: SEAT_TWO, body });
    },
  );
}

/** The turn is seat 1's again when the client re-enables its own `end-turn` (BUILD M5-T1). */
function waitForMyTurn(): void {
  cy.get(ts(END_TURN), { timeout: timeouts.view }).should("not.be.disabled");
}

/** How many hand cards the client is rendering right now. */
function renderedHandCards(): Cypress.Chainable<number> {
  cy.settled();
  return cy.get("body", { log: false }).then(
    ($body) =>
      $body
        .find("[data-testid]")
        .map((_index, element) => element.getAttribute("data-testid") ?? "")
        .get()
        .filter((testid) => testid.startsWith(HAND_CARD_PREFIX)).length,
  );
}

// ---------------------------------------------------------------------------------------------

describe("06 room code — a networked match between a browser and a Node client", () => {
  it("opens a room, plays it out and leaves both players queue-eligible", () => {
    const seed = seedFor("06-room-code");
    const seatOne = accounts.p1();
    const seatTwo = accounts.p2();
    let roomCode = "";
    let matchId = "";

    // --- both seats have a loadout whose deck 0 is this spec's fixture (§9.4) -----------------
    cy.fixture<FixtureDeck>("decks/06-room-a.json").then((deck) => {
      installLoadout(seatOne.token, deck.cards);
    });
    cy.fixture<FixtureDeck>("decks/06-room-b.json").then((deck) => {
      installLoadout(seatTwo.token, deck.cards);
    });

    // --- create the room ---------------------------------------------------------------------
    // ASK (support/testids.ts + apps/web): the room screen has no testids yet, so the room is
    // created over the endpoint §9.5 defines rather than by clicking. `seed` is BUILD M8's "every
    // spec sets a seed"; a networked seed is minted by the server, so honouring a supplied seed
    // under E2E=1 is an ASK (see the report). The fixture decks are written not to need one.
    cy.request<{ code: string; expiresAt: number; deckIndex: number }>({
      method: "POST",
      url: api("/api/rooms"),
      headers: bearer(seatOne.token),
      body: { deckIndex: 0, seed },
    }).then((created) => {
      roomCode = created.body.code;

      expect(
        constants.ROOM_CODE_LENGTH,
        "support/config.ts's mirror still agrees with apps/server/src/config.ts (R79)",
      ).to.eq(ROOM_CODE_LENGTH);
      expect(roomCode.length, `R79: a room code is ${String(ROOM_CODE_LENGTH)} characters`).to.eq(
        ROOM_CODE_LENGTH,
      );
      for (const character of roomCode) {
        expect(
          CODE_ALPHABET.includes(character),
          `R104: "${character}" is in the invite-code alphabet ${CODE_ALPHABET}`,
        ).to.eq(true);
      }
      expect(created.body.deckIndex, "the deck frozen into the room (§9.4, §9.5)").to.eq(0);
      expect(created.body.expiresAt, "the room's TTL is returned so a client can show it").to.be.a(
        "number",
      );
    });

    // --- seat 2 claims it: `app.join_room`'s atomic single-claim (§9.5) -----------------------
    cy.then(() => {
      cy.request<{ matchId: string; code: string; seat: string }>({
        method: "POST",
        url: api(`/api/rooms/${roomCode}/join`),
        headers: bearer(seatTwo.token),
        body: { deckIndex: 0 },
      }).then((joined) => {
        expect(joined.body.code, "the claim names the code it claimed").to.eq(roomCode);
        expect(joined.body.seat, "the joiner is seat 2 (§9.5)").to.eq(SEAT_TWO_ID);
        matchId = joined.body.matchId;
        expect(matchId, "a match id to open a socket onto").to.be.a("string").and.not.eq("");
      });
    });

    // --- both connect ------------------------------------------------------------------------
    cy.then(() => {
      // `seat` is omitted: `tasks/wsPlayer.ts` defaults it to "p2", and support/commands.ts's
      // `WsPlayerCommand` does not yet carry the field its own task accepts (ASK).
      cy.wsPlayer({
        action: "connect",
        name: SEAT_TWO,
        url: server.ws(),
        token: seatTwo.token,
        matchId,
      }).should((result) => {
        // The actor pushes a fresh full view on attach (§9.5), so the socket has one already.
        const view = asView(result.view);
        expect(view.viewer, "seat 2's view is seat 2's").to.eq(SEAT_TWO_ID);
      });
      visitAs(seatOne.token, routes.match(matchId));
    });

    // --- "both see the board" ----------------------------------------------------------------
    cy.get(ts(heroId("you")), { timeout: timeouts.view }).should("be.visible");
    cy.get(ts(heroId("opponent"))).should("be.visible");
    for (const side of SIDES) {
      for (const row of ROWS) {
        for (const lane of LANES) {
          cy.get(ts(zoneId(side, row, lane))).should("exist");
        }
      }
      cy.get(ts(handCountId(side))).should("exist");
    }

    cy.then(() => {
      cy.wsPlayer({ action: "view", name: SEAT_TWO }).should((result) => {
        const view = asView(result.view);
        expect(view.you?.player, "seat 2 is p2").to.eq(SEAT_TWO_ID);
        expect(view.opponent?.player, "and its opponent is p1").to.eq(SEAT_ONE_ID);
        expect(view.you?.units, `${String(constants.UNIT_ZONES)} unit lanes (§3.1)`).to.have.length(
          constants.UNIT_ZONES,
        );
        expect(
          view.you?.backrow,
          `${String(constants.BACKROW_ZONES)} backrow lanes (§3.1)`,
        ).to.have.length(constants.BACKROW_ZONES);
        expect(view.you?.hero?.health, "heroes start at HERO_HEALTH (§2)").to.eq(
          constants.HERO_HEALTH,
        );
        expect(view.opponent?.hero?.health).to.eq(constants.HERO_HEALTH);
      });
    });

    // --- "actions round-trip": browser -> actor -> Node ---------------------------------------
    // R9: `setup.ts` opens PLAYER_IDS[0]'s mulligan first, so seat 1 answers in the browser and
    // seat 2's own choice only opens because that answer reached the actor.
    cy.keepMulligans();
    seatTwoKeepsMulligan();
    waitForMyTurn();

    // Mana is asserted HERE and not with the rest of the board, because §2.1 puts the mulligan
    // before turn 1 and §2.3 makes max mana the number of turns the player has started — so during
    // the mulligan `you.mana` is correctly `{current: 0, max: 0}` and `Board.tsx` renders no
    // crystals at all. "Both see the board" is satisfied above; this is the first moment a crystal
    // is a thing that ought to exist.
    cy.get(`${ts(manaId("you"))} ${MANA_CRYSTAL}`)
      .its("length")
      .should("be.within", 1, constants.MAX_MANA);

    // CLAUDE.md rule 7: the browser renders seat 1's hand and nothing more.
    cy.then(() => {
      cy.wsPlayer({ action: "view", name: SEAT_TWO }).then((result) => {
        const held = opponentHandCount(result.view);
        expect(held, "an opening hand (§2.1: OPENING_DRAW)").to.be.within(
          constants.OPENING_DRAW[0],
          constants.HAND_CAP,
        );
        renderedHandCards().should((rendered) => {
          expect(
            rendered,
            "CLAUDE.md rule 7: the browser renders seat 1's own hand and not one card more",
          ).to.eq(held);
        });
      });
    });

    // --- ...and Node -> actor -> browser ------------------------------------------------------
    cy.endTurn();
    cy.then(() => {
      // `where` omits `turnAtLeast`, which `tasks/wsPlayer.ts` supports and support/commands.ts's
      // `WsPlayerCommand` does not yet declare (ASK); the turn is asserted off the view instead.
      // The actor pushes both views before it acks (`applyAction`), so a view read after an ack is
      // never the pre-action one.
      cy.wsPlayer({ action: "awaitView", name: SEAT_TWO, where: { active: SEAT_TWO_ID } }).should(
        (result) => {
          expect(
            asView(result.view).turn,
            "seat 2's first turn is player-turn 2 (R2: the cap counts player-turns)",
          ).to.be.at.least(2);
        },
      );
      cy.wsPlayer({
        action: "send",
        name: SEAT_TWO,
        body: { type: "endTurn", playerId: SEAT_TWO_ID },
      });
    });
    waitForMyTurn();
    cy.then(() => {
      cy.wsPlayer({ action: "awaitView", name: SEAT_TWO, where: { active: SEAT_ONE_ID } }).should(
        (result) => {
          expect(
            asView(result.view).turn,
            "the turn came back to seat 1 as player-turn 3 (R2)",
          ).to.be.at.least(3);
        },
      );
    });

    // --- "game ends" --------------------------------------------------------------------------
    // §2.5: a draw offer is answered by the opponent. The fixture decks cannot kill a hero, so
    // this is the only way this match reaches a result before R79's ceiling.
    cy.offerDraw();
    cy.then(() => {
      cy.wsPlayer({
        action: "send",
        name: SEAT_TWO,
        body: { type: "answerDraw", accept: true, playerId: SEAT_TWO_ID },
      });
    });

    cy.expectResult("Draw");
    cy.then(() => {
      cy.wsPlayer({ action: "awaitView", name: SEAT_TWO, where: { hasResult: true } }).should(
        (result) => {
          const view = asView(result.view);
          expect(view.result?.winner, "both seats see the same ending (§9.5)").to.eq("draw");
          expect(view.phase, "and the match is over (§10.1)").to.eq("over");
        },
      );
    });

    // --- "both are queue-eligible" -----------------------------------------------------------
    // §9.5: "Every ending records a result and clears both players' in-match state." `POST
    // /api/queue` is the assertion, because enqueue is exactly the endpoint that refuses an
    // account that is still in a match (`already_in_match`) or whose loadout no longer validates.
    // Each player is dequeued again before the next one enqueues, so this never pairs them into a
    // second match. R110's released room code is the same clearing, seen from the code's side.
    for (const token of [seatOne.token, seatTwo.token]) {
      cy.then(() => {
        cy.request<{ profile: { status: string } }>({
          method: "GET",
          url: api("/api/auth/me"),
          headers: bearer(token),
        })
          .its("body.profile.status")
          .should("eq", "active");
        cy.request({
          method: "POST",
          url: api("/api/queue"),
          headers: bearer(token),
          body: { deckIndex: 0 },
        })
          .its("status")
          .should("eq", 200);
        cy.request({ method: "DELETE", url: api("/api/queue"), headers: bearer(token) })
          .its("status")
          .should("eq", 200);
      });
    }
  });
});
