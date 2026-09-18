// BUILD M8 spec 05 — "Networked game, reload mid-prompt".
//
// Key assertions (BUILD M8, quoted verbatim):
//
//     "same view and same open prompt after reload; clock kept running"
//
// This is the strongest test of SPEC §9.3's central claim. Prompts are STATE, not callbacks:
// "a choice made during resolution ... sets `state.pending` and returns; the answer is another
// action", and "(seed, log) reconstructs any match". A browser that reloads mid-prompt therefore
// does not resume a conversation — it asks for a fresh view (§9.5: "Reconnect gets a fresh full
// view, never a log replay") of a state that still holds the same open `PendingChoice`. If the
// view or the prompt came back different, prompts would be callbacks somewhere.
//
// HOW THE PROMPT IS OPENED. `05-reconnect-a` puts SPEC §8 #65 Masochism Mask in seat 1's opening
// hand for every seed (Quickdraw, §6.2), a 2-cost Field Spell whose base script is "Start of
// turn: choose one: ...". Played on seat 1's second turn (§2.3: max mana = turns started, so 2 on
// player-turn 3), it opens one `mode` PendingChoice at the start of player-turn 5 — seat 1's own
// turn, which is what the fixture was built for: R79 arms the separate `PROMPT_CLOCK_SECONDS`
// clock only for a prompt held by the *non-active* player, so the clock under test here is the
// active player's `TURN_CLOCK_SECONDS` turn clock.
//
// WHAT "SAME VIEW" IS ASSERTED AS. The client renders `viewFor` and never sees hidden state
// (CLAUDE.md rule 7), so the view is asserted through the DOM the client produced: the complete,
// sorted set of `data-testid` values in the document, plus the open prompt's `data-prompt-kind`
// and its `prompt-option-<key>` testids. Instance ids are engine-generated and deterministic in
// (seed, log), so that set is a fingerprint of the whole rendered view — every card in every
// lane, every hand card, both heroes, every counter, every mana crystal. Values that MUST move
// across a reload (the clock) are deliberately not in it.
//
// WHAT "CLOCK KEPT RUNNING" IS ASSERTED AS. Seat 2's socket, driven from Node by
// `cy.task("wsPlayer")`, records the `clock` frames the actor pushes (`MatchClocks` + the server's
// `now`). §9.5: "The clock keeps running while a player is disconnected, and the grace countdown
// is stored on the match so both clients show it", and the actor pushes a clock to *both* seats
// when either re-attaches. So the reload is observed from the seat that did not reload: same
// `turnDeadline` (the clock was not restarted), a later `now`, strictly less time remaining, and
// seat 1's grace cleared because it came back inside `DISCONNECT_GRACE_SECONDS`.
//
// R79's values are never spelled here: they are imported from `apps/server/src/config.ts`, which
// is where BUILD §2 and R79 put them.
//
// Needs: M6 (server, match actor, WS protocol) and M7-T1 (the clock). See e2e/README.md.

import {
  DISCONNECT_GRACE_SECONDS,
  PROMPT_CLOCK_SECONDS,
  TURN_CLOCK_SECONDS,
} from "../../../apps/server/src/config.ts";
import { CARD_NAMES, cardId } from "../../support/cards.ts";
import { accounts, constants, routes, seedFor, server, timeouts } from "../../support/config.ts";
import {
  END_TURN,
  MANA_CRYSTAL,
  PROMPT,
  exileCountId,
  graveyardCountId,
  handCountId,
  heroId,
  libraryCountId,
  manaId,
  promptOptionId,
  ts,
  zoneId,
} from "../../support/testids.ts";
import type { ActionInput, FixtureDeck, Lane, PlayerId, Side } from "../../support/types.ts";

// ---------------------------------------------------------------------------------------------
// Local scaffolding. Every item marked ASK is something `e2e/support/**` should own (one place to
// change) and does not yet; each is listed in the hand-off report for this spec.
// ---------------------------------------------------------------------------------------------

/**
 * ASK (support/commands.ts + support/config.ts): a `cy.signIn(account)` command and the storage
 * key the client reads its session from. A spec should not know how a session is delivered — but
 * `support/` has no sign-in helper yet, and ASSUMPTION A6 already promises the fixture accounts
 * carry ready-made tokens, so this is the smallest stand-in. It must survive `cy.reload()`, which
 * is why it is `localStorage` and not an in-page variable.
 */
const SESSION_STORAGE_KEY = "jackioh.e2e.session";

/** Seat 2 lives in Node for the whole file; `tasks/index.ts` resets the sockets per spec. */
const SEAT_TWO = "seat-two";
const SEAT_TWO_ID: PlayerId = "p2";

const LANES: readonly Lane[] = [1, 2, 3, 4, 5];
const SIDES: readonly Side[] = ["you", "opponent"];

/** SPEC §8 numbers 100 Core cards; `support/cards.ts` is the only place they are named. */
const CORE_CARD_COUNT = Object.keys(CARD_NAMES).length;

/** `promptOptionId("")` is the prefix, so no spec spells a testid format. */
const OPTION_PREFIX = promptOptionId("");

function spec8Name(index: number): string {
  const name = CARD_NAMES[index];
  if (name === undefined) throw new Error(`no SPEC §8 card #${String(index)}`);
  return name;
}

/** SPEC §8 #65: the Quickdraw Field Spell whose start-of-turn choice this spec reloads on. */
const MASOCHISM_MASK = spec8Name(65);

function api(path: string): string {
  return `${server.http()}${path}`;
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

/**
 * L1 wants exactly 3 decks and L4 wants no card in two of them, so a one-deck scenario fixture
 * has to be padded before it can be saved. The padding is the next `DECK_SIZE * 2` Core ids the
 * fixture did not use, which keeps all three decks disjoint and — with R111's one copy of every
 * non-token card — inside L5.
 *
 * ASK (support/commands.ts): `cy.installLoadout(account, fixtureId)`. Specs 05, 06 and 10 all
 * need it and all three currently carry this copy.
 */
function loadoutFrom(deck: readonly string[]): string[][] {
  const used = new Set(deck);
  const spare = Array.from({ length: CORE_CARD_COUNT }, (_, index) => cardId(index + 1)).filter(
    (id) => !used.has(id),
  );
  const size = constants.DECK_SIZE;
  expect(spare.length, "enough spare Core ids to pad a loadout").to.be.at.least(size * 2);
  return [[...deck], spare.slice(0, size), spare.slice(size, size * 2)];
}

/** §9.4: `saveLoadout` is the only authority; the deck the match freezes is deck index 0. */
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

// --- reading seat 2's socket ------------------------------------------------------------------

/** `apps/server/src/api/ports.ts` `MatchClocks`, restated structurally (see support/types.ts). */
type Clocks = {
  turnDeadline: number | null;
  promptDeadline: number | null;
  graceDeadline: { p1: number | null; p2: number | null };
  ceilingAt: number;
};

type ClockFrame = { now: number; clocks: Clocks };

type SideLike = { hand?: { instanceId: string }[] | { count: number } };

function handIdsOf(view: Record<string, unknown> | null | undefined): string[] {
  const you = (view?.you ?? {}) as SideLike;
  const hand = you.hand;
  // §10.8: the viewer's own hand is full cards; only the opponent's is a count.
  expect(Array.isArray(hand), "the viewer's own hand arrives as cards, not a count (§10.8)").to.eq(
    true,
  );
  return (Array.isArray(hand) ? hand : []).map((card) => card.instanceId);
}

function clockFrames(name: string): Cypress.Chainable<ClockFrame[]> {
  return cy
    .wsPlayer({ action: "messages", name })
    .then((result) => (result.messages ?? []).filter((message) => message.type === "clock"))
    .then((frames) => frames as unknown as ClockFrame[]);
}

function lastClockFrame(name: string): Cypress.Chainable<ClockFrame> {
  return clockFrames(name).then((frames) => {
    const last = frames.at(-1);
    expect(last, `a clock frame on ${name}'s socket (R79, M7-T1)`).to.not.eq(undefined);
    return last as ClockFrame;
  });
}

/** Keep everything: R9's mulligan answer names the cards kept, so that is the whole hand. */
function seatTwoKeepsMulligan(): void {
  cy.wsPlayer({ action: "awaitView", name: SEAT_TWO, where: { promptKind: "mulligan" } }).then(
    (result) => {
      const body: ActionInput = {
        type: "mulligan",
        keep: handIdsOf(result.view),
        // Discarded by `parseClientMessage`; the actor stamps the authenticated seat itself.
        playerId: SEAT_TWO_ID,
      };
      cy.wsPlayer({ action: "send", name: SEAT_TWO, body });
    },
  );
}

function seatTwoEndsTurn(): void {
  cy.wsPlayer({ action: "awaitView", name: SEAT_TWO, where: { active: SEAT_TWO_ID } });
  cy.wsPlayer({ action: "send", name: SEAT_TWO, body: { type: "endTurn", playerId: SEAT_TWO_ID } });
}

/** The turn is seat 1's again when the client re-enables its own `end-turn` (BUILD M5-T1). */
function waitForMyTurn(): void {
  cy.get(ts(END_TURN), { timeout: timeouts.view }).should("not.be.disabled");
}

// --- the view fingerprint ---------------------------------------------------------------------

type ViewFingerprint = {
  /** Every `data-testid` in the document, sorted. */
  testids: string[];
  /** The open prompt's kind, or null when none is open (BUILD M5-T4 `data-prompt-kind`). */
  promptKind: string | null;
  /** Per-side counters and mana, read through the testids support/testids.ts builds. */
  counters: Record<string, string>;
};

/**
 * One generic read of the rendered view. `[data-testid]` is the only bare selector in this file
 * and it is the testid vocabulary itself (BUILD M5-T1), not a class or a designer's string: the
 * point is to compare the WHOLE set before and after, so nothing can be enumerated by hand.
 */
function fingerprint(): Cypress.Chainable<ViewFingerprint> {
  cy.settled();
  return cy.get("body", { log: false }).then(($body) => {
    const testids = $body
      .find("[data-testid]")
      .map((_index, element) => element.getAttribute("data-testid") ?? "")
      .get()
      .sort();

    const prompt = $body.find(PROMPT);

    const counters: Record<string, string> = {};
    for (const side of SIDES) {
      for (const id of [
        handCountId(side),
        libraryCountId(side),
        graveyardCountId(side),
        exileCountId(side),
      ]) {
        counters[id] = $body.find(ts(id)).text().trim();
      }
      counters[manaId(side)] = String($body.find(`${ts(manaId(side))} ${MANA_CRYSTAL}`).length);
    }

    return {
      testids,
      promptKind: prompt.length === 0 ? null : (prompt.attr("data-prompt-kind") ?? null),
      counters,
    };
  });
}

function optionKeysOf(print: ViewFingerprint): string[] {
  return print.testids
    .filter((testid) => testid.startsWith(OPTION_PREFIX))
    .map((testid) => testid.slice(OPTION_PREFIX.length));
}

// ---------------------------------------------------------------------------------------------

describe("05 reconnect — a networked game reloaded mid-prompt", () => {
  it("rebuilds the same view and the same open prompt, with the clock still running", () => {
    const seed = seedFor("05-reconnect");
    const seatOne = accounts.p1();
    const seatTwo = accounts.p2();
    let matchId = "";
    let before: ViewFingerprint = { testids: [], promptKind: null, counters: {} };
    let beforeClock: ClockFrame = {
      now: 0,
      clocks: { turnDeadline: null, promptDeadline: null, graceDeadline: { p1: null, p2: null }, ceilingAt: 0 },
    };
    let clockFramesBefore = 0;

    // --- both seats have a loadout whose deck 0 is this spec's fixture (§9.4) -----------------
    cy.fixture<FixtureDeck>("decks/05-reconnect-a.json").then((deck) => {
      installLoadout(seatOne.token, deck.cards);
    });
    cy.fixture<FixtureDeck>("decks/05-reconnect-b.json").then((deck) => {
      installLoadout(seatTwo.token, deck.cards);
    });

    // --- a live match: seat 1 opens a room, seat 2 claims it (§9.5) ---------------------------
    // `seed` is BUILD M8's "every spec sets a seed". A networked match's seed is minted by the
    // server (`deps.ids.seed()`), so this is an ASK: under E2E=1 the room endpoint must honour a
    // supplied seed. It is ignored today, which is why this spec's fixture guarantees the card it
    // needs (Quickdraw) for every seed rather than for one.
    cy.request<{ code: string }>({
      method: "POST",
      url: api("/api/rooms"),
      headers: bearer(seatOne.token),
      body: { deckIndex: 0, seed },
    }).then((created) => {
      cy.request<{ matchId: string; seat: string }>({
        method: "POST",
        url: api(`/api/rooms/${created.body.code}/join`),
        headers: bearer(seatTwo.token),
        body: { deckIndex: 0 },
      }).then((joined) => {
        expect(joined.body.seat, "the joiner is seat 2 (§9.5)").to.eq(SEAT_TWO_ID);
        matchId = joined.body.matchId;
      });
    });

    cy.then(() => {
      // `seat` is omitted on purpose: `tasks/wsPlayer.ts` defaults it to "p2", which is the seat
      // the joiner gets, and the `WsPlayerCommand` type in support/commands.ts does not yet carry
      // the field its own task accepts (ASK: add `seat?: PlayerId` to the `connect` variant).
      cy.wsPlayer({
        action: "connect",
        name: SEAT_TWO,
        url: server.ws(),
        token: seatTwo.token,
        matchId,
      });
      visitAs(seatOne.token, routes.match(matchId));
    });

    // --- R9: seat 1 mulligans first (setup.ts opens PLAYER_IDS[0]'s choice), then seat 2 ------
    cy.keepMulligans();
    seatTwoKeepsMulligan();
    waitForMyTurn();

    // --- player-turn 1: 1 mana, the Mask costs 2, so pass (§2.3) ------------------------------
    cy.endTurn();
    seatTwoEndsTurn();
    waitForMyTurn();

    // --- player-turn 3: 2 mana. A Field Spell takes a backrow zone (R81's play-time choice) ---
    cy.playByName(MASOCHISM_MASK, { zone: { side: "you", row: "backrow", lane: 1 } });
    cy.endTurn();
    seatTwoEndsTurn();
    waitForMyTurn();

    // --- player-turn 5: the Mask's start-of-turn choice is open for seat 1 --------------------
    cy.waitForPrompt("mode");

    fingerprint().then((print) => {
      before = print;
      expect(print.promptKind, "the Mask's start-of-turn choice is a `mode` prompt (§10.6)").to.eq(
        "mode",
      );
      expect(
        optionKeysOf(print).length,
        '#65 base offers three options: "exile the bottom card of your library, lose 3 health, or summon a Spikey Pillow"',
      ).to.eq(3);
    });

    clockFrames(SEAT_TWO).then((frames) => {
      clockFramesBefore = frames.length;
    });
    lastClockFrame(SEAT_TWO).then((frame) => {
      beforeClock = frame;
      expect(frame.clocks.turnDeadline, "the active player's turn clock is armed (R79)").to.not.eq(
        null,
      );
      expect(
        (frame.clocks.turnDeadline ?? 0) - frame.now,
        `at most TURN_CLOCK_SECONDS (${String(TURN_CLOCK_SECONDS)} s) remains on a turn clock (R79)`,
      ).to.be.at.most(TURN_CLOCK_SECONDS * 1000);
      expect(
        frame.clocks.promptDeadline,
        `no ${String(PROMPT_CLOCK_SECONDS)} s prompt clock: R79 arms it only for a prompt held by the non-active player`,
      ).to.eq(null);
    });

    // --- the reload --------------------------------------------------------------------------
    // Everything after this line is the assertion. The socket drops, the actor starts seat 1's
    // grace, the page comes back, `hello`/attach asks for a fresh full view (§9.5), and the actor
    // clears the grace and pushes a clock to both seats.
    cy.reload();

    cy.waitForPrompt("mode");

    fingerprint().should((after) => {
      expect(after.testids, "the same rendered view: every testid, before and after").to.deep.eq(
        before.testids,
      );
      expect(after.promptKind, "the same open prompt kind").to.eq(before.promptKind);
      expect(after.counters, "the same hand, library, graveyard, exile and mana readouts").to.deep.eq(
        before.counters,
      );
      expect(optionKeysOf(after), "the same PendingChoice options (§10.8)").to.deep.eq(
        optionKeysOf(before),
      );
    });

    // Belt and braces on the two testids a reconnected board cannot do without.
    cy.get(ts(heroId("you"))).should("be.visible");
    cy.get(ts(heroId("opponent"))).should("be.visible");
    for (const lane of LANES) {
      cy.get(ts(zoneId("you", "units", lane))).should("exist");
      cy.get(ts(zoneId("you", "backrow", lane))).should("exist");
    }

    // --- "clock kept running" ----------------------------------------------------------------
    cy.then(() => {
      cy.wsPlayer({ action: "messages", name: SEAT_TWO }).should((result) => {
        const seen = (result.messages ?? []).filter((message) => message.type === "clock").length;
        expect(
          seen,
          "seat 1's reconnect pushed a fresh clock to seat 2 as well (§9.5: both clients show it)",
        ).to.be.greaterThan(clockFramesBefore);
      });
    });

    cy.then(() => {
      lastClockFrame(SEAT_TWO).should((after) => {
        const beforeRemaining = (beforeClock.clocks.turnDeadline ?? 0) - beforeClock.now;
        const afterRemaining = (after.clocks.turnDeadline ?? 0) - after.now;

        expect(
          after.clocks.turnDeadline,
          "the turn clock was not restarted by the reconnect: the same absolute deadline",
        ).to.eq(beforeClock.clocks.turnDeadline);
        expect(after.now, "the server's clock advanced across the reload").to.be.greaterThan(
          beforeClock.now,
        );
        expect(
          afterRemaining,
          "§9.5: the clock keeps running while a player is disconnected",
        ).to.be.lessThan(beforeRemaining);
        expect(afterRemaining, "and it has not expired: the turn is still seat 1's").to.be.greaterThan(
          0,
        );
        expect(
          after.clocks.ceilingAt,
          "the ceiling is measured from the match's start, not from the reconnect (R79)",
        ).to.eq(beforeClock.clocks.ceilingAt);
        expect(
          after.clocks.graceDeadline.p1,
          `seat 1 returned inside DISCONNECT_GRACE_SECONDS (${String(DISCONNECT_GRACE_SECONDS)} s), so its grace is cleared (§9.5)`,
        ).to.eq(null);
      });
    });

    // Any grace countdown seat 2 did observe while seat 1 was away is bounded by R79's value.
    cy.then(() => {
      clockFrames(SEAT_TWO).should((frames) => {
        for (const frame of frames) {
          const grace = frame.clocks.graceDeadline.p1;
          if (grace === null) continue;
          expect(
            grace - frame.now,
            `a grace countdown never exceeds DISCONNECT_GRACE_SECONDS (${String(DISCONNECT_GRACE_SECONDS)} s, R79)`,
          ).to.be.at.most(DISCONNECT_GRACE_SECONDS * 1000);
        }
      });
    });

    // --- the rebuilt prompt is live state, not a screenshot ----------------------------------
    // §9.3: "the answer is another action". If the reload had rebuilt a picture of a prompt
    // instead of the `PendingChoice` itself, this answer would be refused.
    cy.then(() => {
      const [first] = optionKeysOf(before);
      expect(first, "an option key to answer with").to.be.a("string");
      cy.answerPrompt("mode", { options: [first ?? ""] });
      cy.noPrompt();
      waitForMyTurn();
    });
  });
});
