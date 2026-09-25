// BUILD M8 spec 19 — "The three queue modes, and a Conquest series between the browser and
// `cy.task(\"wsPlayer\")` (R257–R264, R330–R338)".
//
// Key assertions (BUILD M8, quoted verbatim):
//
//     "Best of 1 plays the chosen deck; All Random needs no saved deck; a series pick is chosen,
//      locked in and hidden until both have picked; each game starts on the picked decks; a deck
//      that wins is locked and a deck that lost may be picked again; a player's last deck is picked
//      for them; a conceded game loses the game, not the series; the series ends when one side has
//      won with all three decks and moves the rating once; a room refuses a joiner in another mode"
//
// WHO IS WHO. Seat one is the browser, signed in as the `e2e-p1` fixture account; it only ever acts
// through the lobby (`/play`), the series screen (`/series/<id>`) and the board, the way a player
// does. Seat two is the `e2e-p2` account, driven over HTTP (`cy.request`) and, inside a game, over a
// socket from Node (`cy.task("wsPlayer")`). Every enqueue, room and join seat two makes carries a
// seed (R143), so every game here is seeded: the older ticket's seed wins and seat one's lobby never
// sends one, so seat two's is the one the match or the series is made with.
//
// "PLAYS THE CHOSEN DECK" / "STARTS ON THE PICKED DECKS" is read off the opening hand. Every card
// in a hand at the mulligan was drawn from the deck the match froze, except a Token a rule dealt
// (The Coin, R245), and the fixture decks hold nothing that puts any other card into a hand at the
// opening (see their descriptions). So a hand whose every non-Token card is in the chosen deck, and
// none in another, is the chosen deck; the three decks `cy.installLoadout` saves are disjoint, so
// "in the chosen deck" already excludes the others, and the spec says so anyway. The browser's hand
// is read off the DOM (`hand-card-<id>` carries `data-def-id`, which is `viewFor`'s own `defId`);
// seat two's off its socket's view.
//
// THE RATING. The fixture accounts live as long as the E2E server does, and every rated ending
// moves them apart. §9.5's rating window only widens with waiting (R108, up to
// `RATING_WINDOW_UNCAPPED_AFTER_SECONDS`), so accounts that drift apart pair ever more slowly on
// every re-run. This file therefore keeps its own endings level: seat one concedes the Best-of-1
// game, seat two the All Random one, seat one wins the series and forfeits the room's series — two
// rated wins and two rated losses each. The pairing waits still allow for the full widening.
//
// CLEAN SLATE. Each `it` starts with `cy.freeAccount` for both accounts (dequeue, concede a live
// match, forfeit a series between games), because the server keeps state across specs and across
// runs, and a test that failed half-way must not poison the next one. Each `it` also ends by taking
// both accounts out of whatever it made.
//
// Needs: M6 and M7 (server, match actor, queue, results) and TASK 1's modes, series and lobby, against
// the `E2E=1` server and a `build:e2e` client. See e2e/README.md.

import {
  MATCHMAKER_SWEEP_INTERVAL_SECONDS,
  RATING_WINDOW_UNCAPPED_AFTER_SECONDS,
  SERIES_POLL_SECONDS,
  SERIES_WINS_NEEDED,
} from "../../../apps/server/src/config.ts";
import { TOKEN_NAMES, tokenId } from "../../support/cards.ts";
import { INSTALLED_TRIO_NAME, type InstalledLoadout } from "../../support/commands.ts";
import {
  accounts,
  constants,
  routes,
  seedFor,
  server,
  timeouts,
  type E2EAccount,
} from "../../support/config.ts";
import {
  PLAY_CREATE_ROOM,
  PLAY_DECK_SELECT,
  PLAY_QUEUE,
  PLAY_ROOM_CODE,
  PLAY_ROOM_MODE,
  PLAY_STATUS,
  PLAY_TRIO_SELECT,
  PLAY_VERDICT,
  RESULT_OVERLAY,
  SERIES_BANNER,
  SERIES_BANNER_CONTINUE,
  SERIES_BANNER_RESULT,
  SERIES_LOCK_IN,
  SERIES_OPPONENT_STATUS,
  SERIES_PICKER,
  SERIES_RESULT,
  SERIES_SCORE,
  SERIES_SCREEN,
  handCardId,
  playModeId,
  seriesBannerOpponentDeckId,
  seriesBannerYourDeckId,
  seriesDeckId,
  seriesGameId,
  seriesOpponentDeckId,
  seriesPickId,
  ts,
  type QueueMode,
} from "../../support/testids.ts";

// ---------------------------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------------------------

/** Unit conversion, not configuration. */
const MS_PER_SECOND = 1000;

/**
 * How long a pairing may take to reach the browser. §9.5's window is uncapped once a ticket has
 * waited `RATING_WINDOW_UNCAPPED_AFTER_SECONDS`; the next sweep (R108) then pairs it, and the lobby
 * reads `/api/auth/me` every `SERIES_POLL_SECONDS`. Most runs pair on the second enqueue at once;
 * this is the bound for accounts whose ratings earlier runs have pulled apart (see the header).
 */
const PAIRING_TIMEOUT_MS =
  (RATING_WINDOW_UNCAPPED_AFTER_SECONDS + MATCHMAKER_SWEEP_INTERVAL_SECONDS + SERIES_POLL_SECONDS) *
    MS_PER_SECOND +
  timeouts.view;

/** A series screen or banner reads the server every `SERIES_POLL_SECONDS`; allow a few reads. */
const SERIES_POLL_TIMEOUT_MS = SERIES_POLL_SECONDS * MS_PER_SECOND + timeouts.view;

/** Every Token's catalog id: the only cards a hand may hold that no deck does (R245's Coin). */
const TOKEN_IDS: ReadonlySet<string> = new Set(Object.keys(TOKEN_NAMES).map((index) => tokenId(index)));

const MATCH_PATH = /^\/match\/([^/]+)$/;
const SERIES_PATH = /^\/series\/([^/]+)$/;

/** Seat two's socket, one per game. */
const SEAT_TWO = "seat-two";

/** The fixture that is the browser's Best-of-1 choice: saved as deck 2 (index 1), not deck 1. */
const CHOSEN_DECK_INDEX = 1;

/** Game 1 of the series: the browser picks its chosen deck's slot, seat two its last slot. */
const GAME_ONE_PICKS = { browser: CHOSEN_DECK_INDEX, seatTwo: 2 } as const;
/** Game 2: the browser picks slot 0; seat two picks slot 2 again, the deck that lost (R330). */
const GAME_TWO_PICKS = { browser: 0, seatTwo: 2 } as const;
/** Game 3: the browser's last deck is picked for it (R332); seat two picks its fixture deck, slot 0. */
const GAME_THREE_PICKS = { browser: 2, seatTwo: 0 } as const;

// ---------------------------------------------------------------------------------------------
// the HTTP surface, as far as this spec reads it (apps/web/src/net/api.ts is the contract)
// ---------------------------------------------------------------------------------------------

type EnqueueBody = {
  ticketId: string;
  status: "open" | "matched" | "cancelled";
  matchId: string | null;
  seriesId: string | null;
  mode: QueueMode;
};

type ErrorBody = { error: { code: string; message: string; details?: unknown } };

type JoinBody = {
  matchId: string | null;
  seriesId: string | null;
  code: string;
  seat: "p1" | "p2";
  mode: QueueMode;
};

type MeBody = { currentMatchId: string | null; currentSeriesId?: string | null };

type ProfileBody = { rating: number; record: { wins: number; losses: number; draws: number } };

/** `SeriesView` (apps/web/src/net/api.ts). */
type SeriesView = {
  id: string;
  status: "picking" | "playing" | "over";
  gameNo: number;
  winsNeeded: number;
  maxGames: number;
  currentMatchId: string | null;
  you: {
    seat: "p1" | "p2";
    wins: number;
    trioName: string;
    decks: { slot: number; name: string; cards: string[]; won: boolean; games: number }[];
    pick: number | null;
    autoPick: boolean;
  };
  opponent: { wins: number; decks: Record<string, unknown>[]; picked: boolean } & Record<string, unknown>;
  games: {
    gameNo: number;
    matchId: string;
    yourSlot: number;
    opponentSlot: number;
    youWentFirst: boolean;
    result: "win" | "loss" | "draw" | null;
  }[];
  result: {
    outcome: "win" | "loss" | "draw" | "abandoned";
    endReason: string;
    ratingBefore: number | null;
    ratingAfter: number | null;
  } | null;
};

function api(path: string): string {
  return `${server.http()}${path}`;
}

function bearer(account: E2EAccount): Record<string, string> {
  return { authorization: `Bearer ${account.token}` };
}

function enqueue(account: E2EAccount, body: Record<string, unknown>): Cypress.Chainable<Cypress.Response<EnqueueBody>> {
  return cy.request<EnqueueBody>({ method: "POST", url: api("/api/queue"), headers: bearer(account), body });
}

function dequeue(account: E2EAccount): void {
  cy.request({ method: "DELETE", url: api("/api/queue"), headers: bearer(account) })
    .its("status")
    .should("eq", 200);
}

function me(account: E2EAccount): Cypress.Chainable<MeBody> {
  return cy
    .request<MeBody>({ method: "GET", url: api("/api/auth/me"), headers: bearer(account) })
    .its("body");
}

function profile(account: E2EAccount): Cypress.Chainable<ProfileBody> {
  return cy
    .request<ProfileBody>({ method: "GET", url: api("/api/profile"), headers: bearer(account) })
    .its("body");
}

function seriesAs(account: E2EAccount, seriesId: string): Cypress.Chainable<SeriesView> {
  return cy
    .request<SeriesView>({ method: "GET", url: api(`/api/series/${seriesId}`), headers: bearer(account) })
    .its("body");
}

function pickAs(account: E2EAccount, seriesId: string, slot: number): Cypress.Chainable<SeriesView> {
  return cy
    .request<SeriesView>({
      method: "POST",
      url: api(`/api/series/${seriesId}/pick`),
      headers: bearer(account),
      body: { slot },
    })
    .its("body");
}

function forfeitAs(account: E2EAccount, seriesId: string): Cypress.Chainable<SeriesView> {
  return cy
    .request<SeriesView>({ method: "POST", url: api(`/api/series/${seriesId}/forfeit`), headers: bearer(account) })
    .its("body");
}

// ---------------------------------------------------------------------------------------------
// reading hands
// ---------------------------------------------------------------------------------------------

/** `hand-card-` is the prefix every hand card's testid starts with (BUILD M5-T1). */
const HAND_CARD = `[data-testid^="${handCardId("")}"]`;

/** The browser's opening hand, as catalog ids, once the board has rendered it. */
function browserHand(): Cypress.Chainable<string[]> {
  return cy
    .get(HAND_CARD, { timeout: timeouts.view })
    .should("have.length.at.least", constants.OPENING_DRAW[0])
    .then(($cards) => $cards.map((_index, element) => element.getAttribute("data-def-id") ?? "").get());
}

/** A socket view's own hand, as catalog ids (§10.8: the viewer's hand arrives as cards). */
function socketHand(view: Record<string, unknown> | null | undefined): string[] {
  const you = (view?.you ?? {}) as { hand?: unknown };
  expect(Array.isArray(you.hand), "the viewer's own hand arrives as cards, not a count (§10.8)").to.eq(true);
  return (Array.isArray(you.hand) ? (you.hand as { defId?: string }[]) : []).map((card) => card.defId ?? "");
}

/**
 * Every card of `hand` that is not a Token is in `deck`, and none is in any of `others`. A hand of
 * fewer than `OPENING_DRAW[0]` such cards would prove nothing, so that is asserted too.
 */
function expectDealtFrom(hand: readonly string[], deck: readonly string[], others: readonly (readonly string[])[], label: string): void {
  const drawn = hand.filter((id) => !TOKEN_IDS.has(id));
  expect(drawn.length, `${label}: an opening hand (§2.1)`).to.be.at.least(constants.OPENING_DRAW[0]);
  for (const id of drawn) {
    expect(deck, `${label}: ${id} was drawn from this deck`).to.include(id);
    for (const other of others) {
      expect(other, `${label}: ${id} is not from another deck`).to.not.include(id);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// the lobby, driven as a player drives it
// ---------------------------------------------------------------------------------------------

/** Open `/play` as `account` and choose a mode (R257). */
function openLobby(account: E2EAccount, mode: QueueMode): void {
  cy.visitAs(account, routes.play());
  cy.get(ts(playModeId(mode)), { timeout: timeouts.view }).check();
  cy.get(ts(playModeId(mode))).should("be.checked");
}

/**
 * "Find a match", and wait for the lobby to say it is queued — so the browser's ticket is the older
 * one before seat two enqueues, which makes the browser series seat p1 (R335).
 */
function findMatch(): void {
  cy.get(ts(PLAY_QUEUE), { timeout: timeouts.view }).should("not.be.disabled").click();
  cy.get(ts(PLAY_STATUS), { timeout: timeouts.view }).should("be.visible");
}

/** Where the lobby (or the series screen) took the browser: the id in `/match/<id>` or `/series/<id>`. */
function landedOn(pattern: RegExp, timeout: number): Cypress.Chainable<string> {
  return cy
    .location("pathname", { timeout })
    .should("match", pattern)
    .then((pathname) => pattern.exec(pathname)?.[1] ?? "");
}

/**
 * §2.5: seat two concedes the game its socket is on. `playerId` is only the field the action type
 * carries: `parseClientMessage` discards it and the actor stamps the seat the token holds, which in
 * an even game of a series is the match's p1 (R335).
 */
function seatTwoConcedes(): void {
  cy.wsPlayer({ action: "send", name: SEAT_TWO, body: { type: "concede", playerId: "p2" } });
}

function installed(value: InstalledLoadout | null): InstalledLoadout {
  expect(value, "cy.installLoadout has answered").to.not.eq(null);
  return value as InstalledLoadout;
}

// ---------------------------------------------------------------------------------------------

describe("19 queue modes and series — Best of 1, All Random, Conquest and rooms", () => {
  beforeEach(() => {
    cy.freeAccount(accounts.p1());
    cy.freeAccount(accounts.p2());
  });

  it("Best of 1 plays the deck the player chose, not the first saved one (R257, R253)", () => {
    const seed = seedFor("19-bo1");
    const seatOne = accounts.p1();
    const seatTwo = accounts.p2();
    let mine: InstalledLoadout | null = null;
    let theirs: InstalledLoadout | null = null;
    let matchId = "";

    cy.installLoadout(seatOne, "19-modes-a", { deckIndex: CHOSEN_DECK_INDEX }).then((value) => {
      mine = value;
    });
    cy.installLoadout(seatTwo, "19-modes-b").then((value) => {
      theirs = value;
    });

    openLobby(seatOne, "bo1");
    cy.then(() => {
      const chosen = installed(mine).deckIds[CHOSEN_DECK_INDEX] ?? "";
      cy.get(ts(PLAY_DECK_SELECT), { timeout: timeouts.view }).select(chosen);
      cy.get(ts(PLAY_DECK_SELECT)).should("have.value", chosen);
    });
    // R253: the client's verdict is UX only, but the fixture deck is legal and it should say so.
    cy.get(ts(PLAY_VERDICT)).should("have.attr", "data-ready", "true");
    findMatch();

    cy.then(() => {
      enqueue(seatTwo, { mode: "bo1", deckId: installed(theirs).deckIds[0], seed }).should((response) => {
        expect(response.status).to.eq(200);
        expect(response.body.mode, "R257: a Best-of-1 ticket").to.eq("bo1");
        expect(response.body.seriesId, "Best of 1 makes a match, never a series").to.eq(null);
      });
    });

    // §9.5: the lobby reads `currentMatchId` and goes to the board by itself.
    landedOn(MATCH_PATH, PAIRING_TIMEOUT_MS).then((id) => {
      matchId = id;
    });
    // A Best-of-1 game is no series game: no banner (R259).
    browserHand().then((hand) => {
      const decks = installed(mine).decks;
      const chosen = decks[CHOSEN_DECK_INDEX] ?? [];
      const others = decks.filter((_deck, at) => at !== CHOSEN_DECK_INDEX);
      expectDealtFrom(hand, chosen, others, "Best of 1: the browser's hand is Deck 2, the chosen deck");
    });
    cy.get(ts(SERIES_BANNER)).should("not.exist");

    // Seat one concedes, which keeps this file's endings level (see the header).
    cy.then(() => {
      cy.concedeAs(seatOne, matchId).its("ok").should("eq", true);
    });
    me(seatOne).its("currentMatchId").should("eq", null);
    me(seatTwo).its("currentMatchId").should("eq", null);
  });

  it("All Random needs no saved deck: both players are dealt one (R258)", () => {
    const seed = seedFor("19-random");
    const seatOne = accounts.p1();
    const seatTwo = accounts.p2();

    // Neither player has a single saved deck.
    cy.clearDecks(seatOne);
    cy.clearDecks(seatTwo);
    cy.savedDecks(seatTwo).its("decks").should("have.length", 0);
    cy.savedDecks(seatOne).its("decks").should("have.length", 0);

    openLobby(seatOne, "random");
    // Nothing to choose, so nothing stands between the player and the queue.
    cy.get(ts(PLAY_DECK_SELECT)).should("not.exist");
    cy.get(ts(PLAY_TRIO_SELECT)).should("not.exist");
    findMatch();

    cy.then(() => {
      enqueue(seatTwo, { mode: "random", seed }).should((response) => {
        expect(response.status, "R258: All Random is queued with no deck at all").to.eq(200);
        expect(response.body.mode).to.eq("random");
      });
    });

    landedOn(MATCH_PATH, PAIRING_TIMEOUT_MS).then((matchId) => {
      cy.wsPlayer({ action: "connect", name: SEAT_TWO, url: server.ws(), token: seatTwo.token, matchId }).then(
        (result) => {
          const hand = socketHand(result.view);
          expect(hand.length, "seat two was dealt a deck and drew from it").to.be.at.least(constants.OPENING_DRAW[0]);
          for (const card of hand) {
            expect(card, "a catalog id").to.match(/^core-/);
          }
        },
      );
    });
    browserHand().should("have.length.at.least", constants.OPENING_DRAW[0]);

    // Seat two concedes: the other half of this file's level endings.
    cy.then(() => {
      seatTwoConcedes();
    });
    cy.get(ts(RESULT_OVERLAY), { timeout: timeouts.view }).should("contain.text", "Win");
    me(seatOne).its("currentMatchId").should("eq", null);
  });

  it("a Conquest series: sealed picks, the picked decks, won decks locked, the last deck picked for you, three wins end it and rate it once (R330–R338, R262)", () => {
    const seed = seedFor("19-series");
    const seatOne = accounts.p1();
    const seatTwo = accounts.p2();
    let mine: InstalledLoadout | null = null;
    let theirs: InstalledLoadout | null = null;
    let seriesId = "";
    const matchIds: string[] = [];
    let before: ProfileBody = { rating: 0, record: { wins: 0, losses: 0, draws: 0 } };

    cy.installLoadout(seatOne, "19-modes-a", { deckIndex: CHOSEN_DECK_INDEX }).then((value) => {
      mine = value;
    });
    cy.installLoadout(seatTwo, "19-modes-b").then((value) => {
      theirs = value;
    });
    profile(seatOne).then((body) => {
      before = body;
    });

    /** The browser selects `slot` in the picker and locks it in (R331). */
    const lockIn = (slot: number): void => {
      cy.get(ts(SERIES_PICKER), { timeout: timeouts.view }).should("have.attr", "data-state", "choosing");
      cy.get(ts(seriesPickId(slot))).should("not.be.disabled").check();
      cy.get(ts(seriesPickId(slot))).should("be.checked");
      cy.get(ts(SERIES_LOCK_IN)).should("not.be.disabled").click();
    };

    /**
     * Game `gameNo` on the board: both hands come from the picked decks, and seat two concedes it
     * (R334: that loses the game, not the series).
     */
    const playAndWin = (gameNo: number, picks: { browser: number; seatTwo: number }): void => {
      landedOn(MATCH_PATH, SERIES_POLL_TIMEOUT_MS).then((id) => {
        matchIds.push(id);
        expect(matchIds, `game ${String(gameNo)} is a match of its own`).to.have.length(gameNo);
      });
      cy.get(ts(SERIES_BANNER), { timeout: timeouts.view }).should("be.visible");
      browserHand().then((hand) => {
        const decks = installed(mine).decks;
        expectDealtFrom(
          hand,
          decks[picks.browser] ?? [],
          decks.filter((_deck, at) => at !== picks.browser),
          `game ${String(gameNo)}: the browser plays the deck it picked`,
        );
      });
      cy.then(() => {
        const matchId = matchIds[gameNo - 1] ?? "";
        cy.wsPlayer({ action: "connect", name: SEAT_TWO, url: server.ws(), token: seatTwo.token, matchId }).then((result) => {
          const decks = installed(theirs).decks;
          expectDealtFrom(
            socketHand(result.view),
            decks[picks.seatTwo] ?? [],
            decks.filter((_deck, at) => at !== picks.seatTwo),
            `game ${String(gameNo)}: seat two plays the deck it picked`,
          );
        });
        seatTwoConcedes();
      });
      cy.get(ts(RESULT_OVERLAY), { timeout: timeouts.view }).should("contain.text", "Win");
    };

    /** From the board after a won game, back to the series screen to pick for the next one. */
    const continueToPick = (wins: number): void => {
      cy.get(ts(SERIES_BANNER_RESULT)).should("not.exist");
      cy.get(ts(SERIES_BANNER_CONTINUE), { timeout: SERIES_POLL_TIMEOUT_MS }).should("be.visible").click();
      landedOn(SERIES_PATH, timeouts.view).then((id) => {
        expect(id).to.eq(seriesId);
      });
      cy.get(ts(SERIES_SCREEN), { timeout: timeouts.view }).should("have.attr", "data-status", "picking");
      cy.get(ts(SERIES_SCORE)).should("have.attr", "data-you", String(wins)).and("have.attr", "data-opponent", "0");
    };

    // --- both queue Conquest: the browser through the lobby, seat two over HTTP ------------------
    openLobby(seatOne, "bo3");
    cy.then(() => {
      cy.get(ts(PLAY_TRIO_SELECT), { timeout: timeouts.view }).select(installed(mine).trioId);
      cy.get(ts(PLAY_TRIO_SELECT)).should("have.value", installed(mine).trioId);
    });
    cy.get(ts(PLAY_VERDICT)).should("have.attr", "data-ready", "true");
    findMatch();
    cy.then(() => {
      enqueue(seatTwo, { mode: "bo3", trioId: installed(theirs).trioId, seed }).should((response) => {
        expect(response.status).to.eq(200);
        expect(response.body.mode, "R257: a Conquest ticket").to.eq("bo3");
        expect(response.body.matchId, "R338: a series opens on its pick phase, not on a match").to.eq(null);
      });
    });

    // The lobby reads `currentSeriesId` and goes to the series screen to pick.
    landedOn(SERIES_PATH, PAIRING_TIMEOUT_MS).then((id) => {
      seriesId = id;
    });
    cy.get(ts(SERIES_SCREEN), { timeout: timeouts.view }).should("have.attr", "data-status", "picking");
    cy.get(ts(SERIES_SCORE)).should("have.attr", "data-you", "0").and("have.attr", "data-opponent", "0");

    // --- game 1's picks: sealed, and hidden until both are in (R331) -----------------------------
    lockIn(GAME_ONE_PICKS.browser);
    cy.get(ts(SERIES_PICKER)).should("have.attr", "data-state", "waiting");
    cy.get(ts(seriesDeckId(GAME_ONE_PICKS.browser))).should("have.attr", "data-picked", "true");
    cy.get(ts(SERIES_OPPONENT_STATUS)).should("have.attr", "data-picked", "false");
    cy.then(() => {
      seriesAs(seatTwo, seriesId).should((view) => {
        expect(view.status).to.eq("picking");
        expect(view.opponent.picked, "R331: seat two sees THAT the browser picked").to.eq(true);
        // …and never WHAT: the opponent's side carries wins, which decks have won, and a yes/no.
        expect(Object.keys(view.opponent).sort(), "R336: no pick and no deck in the opponent's projection").to.deep.eq([
          "decks",
          "picked",
          "wins",
        ]);
        for (const deck of view.opponent.decks) {
          expect(Object.keys(deck).sort(), "R336: an opponent slot is its number and whether it has won").to.deep.eq([
            "slot",
            "won",
          ]);
        }
        expect(view.you.pick, "seat two has not picked yet").to.eq(null);
      });
      // Sealed: the browser's pick cannot be changed once it is in.
      cy.request<ErrorBody>({
        method: "POST",
        url: api(`/api/series/${seriesId}/pick`),
        headers: bearer(seatOne),
        body: { slot: 0 },
        failOnStatusCode: false,
      })
        .its("status")
        .should("eq", 409);
      pickAs(seatTwo, seriesId, GAME_ONE_PICKS.seatTwo).should((view) => {
        expect(view.status, "R331: both picked, so game 1 starts at once").to.eq("playing");
        expect(view.currentMatchId, "and the answer names it").to.be.a("string");
      });
    });

    // --- game 1, on the picked decks; seat two concedes it ----------------------------------------
    playAndWin(1, GAME_ONE_PICKS);

    // --- game 2: the deck that won is locked; the one that lost comes back ------------------------
    continueToPick(1);
    cy.get(ts(seriesGameId(1))).should("have.attr", "data-result", "win");
    cy.get(ts(seriesDeckId(GAME_ONE_PICKS.browser))).should("have.attr", "data-won", "true");
    cy.get(ts(seriesPickId(GAME_ONE_PICKS.browser))).should("be.disabled");
    cy.get(ts(seriesOpponentDeckId(GAME_ONE_PICKS.seatTwo))).should("have.attr", "data-won", "false");
    cy.then(() => {
      seriesAs(seatOne, seriesId).should((view) => {
        expect(view.gameNo, "the series is picking for game 2").to.eq(2);
        const game = view.games[0];
        expect(game?.yourSlot).to.eq(GAME_ONE_PICKS.browser);
        expect(game?.opponentSlot, "a played slot is shown once both picks are in").to.eq(GAME_ONE_PICKS.seatTwo);
        expect(game?.youWentFirst, "R335: series seat p1, the older ticket, goes first in game 1").to.eq(true);
        expect(view.result, "a conceded game did not end the series").to.eq(null);
      });
    });
    lockIn(GAME_TWO_PICKS.browser);
    cy.then(() => {
      pickAs(seatTwo, seriesId, GAME_TWO_PICKS.seatTwo).should((view) => {
        expect(view.status, "R330: seat two plays the deck that lost again, and game 2 starts").to.eq("playing");
      });
    });
    playAndWin(2, GAME_TWO_PICKS);

    // --- game 3: the browser's last deck is picked for it (R332) ----------------------------------
    continueToPick(2);
    cy.get(ts(SERIES_PICKER)).should("have.attr", "data-state", "waiting").and("have.attr", "data-auto", "true");
    cy.get(ts(seriesDeckId(GAME_THREE_PICKS.browser))).should("have.attr", "data-picked", "true");
    cy.then(() => {
      seriesAs(seatTwo, seriesId).its("opponent.picked").should("eq", true);
      pickAs(seatTwo, seriesId, GAME_THREE_PICKS.seatTwo).its("status").should("eq", "playing");
    });
    playAndWin(3, GAME_THREE_PICKS);

    // --- a win with every deck: the series is over, and won ---------------------------------------
    cy.get(ts(SERIES_BANNER_RESULT), { timeout: SERIES_POLL_TIMEOUT_MS }).should("have.attr", "data-outcome", "win");
    for (const slot of [0, 1, 2]) {
      cy.get(ts(seriesBannerYourDeckId(slot))).should("have.attr", "data-won", "true");
      cy.get(ts(seriesBannerOpponentDeckId(slot))).should("have.attr", "data-won", "false");
    }
    cy.then(() => {
      cy.visitAs(seatOne, routes.series(seriesId));
    });
    cy.get(ts(SERIES_RESULT), { timeout: timeouts.view }).should("have.attr", "data-outcome", "win");
    cy.get(ts(SERIES_SCORE))
      .should("have.attr", "data-you", String(SERIES_WINS_NEEDED))
      .and("have.attr", "data-opponent", "0");

    // --- the rating moved once: by the series' own Elo move, not by its games (R262) -------------
    cy.then(() => {
      seriesAs(seatOne, seriesId).then((view) => {
        expect(view.status).to.eq("over");
        expect(view.games, `the series ended at ${String(SERIES_WINS_NEEDED)} wins, one with each deck`).to.have.length(
          SERIES_WINS_NEEDED,
        );
        expect(view.games[1]?.youWentFirst, "R335: series seat p2 goes first in even games").to.eq(false);
        const result = view.result;
        expect(result?.outcome).to.eq("win");
        expect(result?.endReason).to.eq("decided");
        expect(result?.ratingBefore, "R262: rated from the rating before game 1").to.eq(before.rating);
        profile(seatOne).should((after) => {
          const moved = (result?.ratingAfter ?? 0) - (result?.ratingBefore ?? 0);
          expect(moved, "a won series moves the rating up").to.be.greaterThan(0);
          expect(after.rating - before.rating, "R262: the profile moved by exactly the series' move, once").to.eq(moved);
          expect(after.rating).to.eq(result?.ratingAfter);
          expect(after.record.wins - before.record.wins, "R262: every game is recorded as a win").to.eq(SERIES_WINS_NEEDED);
        });
      });
    });

    // --- and both players may queue again --------------------------------------------------------
    for (const account of [seatOne, seatTwo]) {
      cy.then(() => {
        me(account).should((body) => {
          expect(body.currentMatchId).to.eq(null);
          expect(body.currentSeriesId ?? null, "a finished series holds nobody").to.eq(null);
        });
        const decks = account === seatOne ? installed(mine) : installed(theirs);
        enqueue(account, { mode: "bo1", deckId: decks.deckIds[0] }).its("status").should("eq", 200);
        dequeue(account);
      });
    }
  });

  it("a Conquest room refuses a Best-of-1 joiner and makes a series for a trio (R264)", () => {
    const seed = seedFor("19-room");
    const seatOne = accounts.p1();
    const seatTwo = accounts.p2();
    let theirs: InstalledLoadout | null = null;
    let code = "";
    let seriesId = "";

    cy.installLoadout(seatOne, "19-modes-a", { deckIndex: CHOSEN_DECK_INDEX });
    cy.installLoadout(seatTwo, "19-modes-b").then((value) => {
      theirs = value;
    });

    // The browser makes a Conquest room with its only trio, through the lobby.
    openLobby(seatOne, "bo3");
    cy.get(ts(PLAY_TRIO_SELECT), { timeout: timeouts.view }).find("option:selected").should("have.text", INSTALLED_TRIO_NAME);
    cy.get(ts(PLAY_CREATE_ROOM)).should("not.be.disabled").click();
    cy.get(ts(PLAY_ROOM_MODE), { timeout: timeouts.view }).should("have.attr", "data-mode", "bo3");
    cy.get(ts(PLAY_ROOM_CODE))
      .invoke("text")
      .then((text) => {
        code = text.trim();
        expect(code, "R79: a room code").to.have.length(constants.ROOM_CODE_LENGTH);
      });

    // A Best-of-1 joiner is refused with the room's mode (R264).
    cy.then(() => {
      cy.request<ErrorBody>({
        method: "POST",
        url: api(`/api/rooms/${code}/join`),
        headers: bearer(seatTwo),
        body: { mode: "bo1", deckId: installed(theirs).deckIds[0], seed },
        failOnStatusCode: false,
      }).should((response) => {
        expect(response.status, "R264: a choice in another mode is a conflict").to.eq(409);
        expect(response.body.error.code).to.eq("conflict");
        expect(response.body.error.details, "and names the room's mode").to.deep.eq({ mode: "bo3" });
        expect(response.body.error.message).to.eq("This room plays Conquest: pick one of your trios.");
      });
    });
    // The refusal claimed nothing: the room still takes the right choice.
    cy.then(() => {
      cy.request<JoinBody>({
        method: "POST",
        url: api(`/api/rooms/${code}/join`),
        headers: bearer(seatTwo),
        body: { mode: "bo3", trioId: installed(theirs).trioId, seed },
      }).should((response) => {
        expect(response.status).to.eq(200);
        expect(response.body.mode).to.eq("bo3");
        expect(response.body.seat, "the joiner is series seat p2").to.eq("p2");
        expect(response.body.matchId, "R264: a Conquest join makes the series, no match yet").to.eq(null);
        expect(response.body.seriesId).to.be.a("string").and.not.eq("");
        seriesId = response.body.seriesId ?? "";
      });
    });

    // The host is told by its own poll, and taken to the pick.
    landedOn(SERIES_PATH, SERIES_POLL_TIMEOUT_MS).then((id) => {
      expect(id, "the host lands on the series the join made").to.eq(seriesId);
    });
    cy.get(ts(SERIES_SCREEN), { timeout: timeouts.view }).should("have.attr", "data-status", "picking");

    // Clean up, and keep this file's endings level: the host forfeits between games (R334).
    cy.then(() => {
      forfeitAs(seatOne, seriesId).should((view) => {
        expect(view.status).to.eq("over");
        expect(view.result?.outcome, "R334: a forfeit loses the series").to.eq("loss");
        expect(view.result?.endReason).to.eq("forfeit");
      });
      seriesAs(seatTwo, seriesId).its("result.outcome").should("eq", "win");
    });
    me(seatOne).its("currentSeriesId").should("eq", null);
    me(seatTwo).its("currentSeriesId").should("eq", null);
  });
});
