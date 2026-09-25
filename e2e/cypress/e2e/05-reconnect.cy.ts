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
// player-turn 3), it opens one `mode` PendingChoice at the start of EVERY later seat-1 turn —
// seat 1's own turn, which is what the fixture was built for: R79 arms the separate
// `PROMPT_CLOCK_SECONDS` clock only for a prompt held by the *non-active* player, so the clock
// under test here is the active player's `TURN_CLOCK_SECONDS` turn clock.
//
// WHY THE RELOAD IS ON PLAYER-TURN 7 AND NOT 5. The Mask asks the same question on 5, 7, 9 …, so
// any of them would do for "reload mid-prompt". Turn 7 is chosen so that the view being rebuilt
// carries a player modifier, because R169's badge list is the one part of the rendered view that
// `fingerprint()` could not see until it was read separately (see below), and a fingerprint that
// covers a list it never sees populated is the same hole one level up. So seat 1 answers the
// turn-5 question, spends the freed mana on SPEC §8 #77 Professor Curvature — already in
// `05-reconnect-a`, so no fixture changed — and reloads on turn 7 instead. R48 puts the discount
// on "your next turn", which from turn 5 is turn 7 exactly: the badge is LIVE across the reload
// rather than dormant, which is the harder of the two captions for a rebuilt view to get right,
// since it depends on `state.turn` and `state.active` and not only on the modifier's existence.
// The three options the Mask offers are the same on 5 and on 7, and the option answered on turn 5
// is the first one — exiling the bottom card of seat 1's library, which leaves both heroes' health
// alone and so leaves every other assertion in this file reading exactly as it did.
//
// WHAT "SAME VIEW" IS ASSERTED AS, AND WHAT IT IS NOT. The client renders `viewFor` and never
// sees hidden state (CLAUDE.md rule 7), so the view is asserted through the DOM the client
// produced. `fingerprint()` reads four things, and it is worth being exact about which, because
// the first one used to be described here as covering the whole rendered view and does not:
//
//   * `testids`   — the complete, sorted set of `data-testid` values in the document. Instance ids
//                   are engine-generated and deterministic in (seed, log), so this is every card
//                   in every lane, every hand card, both heroes, every counter, every mana crystal
//                   — every element the testid vocabulary NAMES (BUILD M5-T1, M5-T4, and the A-
//                   numbered additions in support/testids.ts). It is not every element on screen.
//   * `promptKind` and the `prompt-option-<key>` ids that fall out of `testids`.
//   * `counters`  — the per-side hand/library/graveyard/exile readouts and the mana crystals,
//                   which are text and counts rather than testids and so are read separately.
//   * `modifiers` — R169's badge list per side. These are read separately for the same reason the
//                   counters are: a badge carries `data-modifier-id`, NOT a `data-testid`, so the
//                   whole list is invisible to `testids` — only its container `modifiers-<side>`
//                   appears there, and that container is rendered even when the list is empty.
//                   Before this field existed, a reconnect that came back having dropped every
//                   modifier deep-equalled a pre-reload view with its badges on screen: the two
//                   containers were in `testids` either way and nothing read what was inside them.
//
// Values that MUST move across a reload (the clock) are deliberately in none of them.
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
import { CARD_NAMES } from "../../support/cards.ts";
import { accounts, routes, seedFor, server, timeouts } from "../../support/config.ts";
import {
  END_TURN,
  MANA_CRYSTAL,
  MODIFIER_BADGE,
  PROMPT,
  exileCountId,
  graveyardCountId,
  handCountId,
  heroId,
  libraryCountId,
  manaId,
  modifiersId,
  promptOptionId,
  ts,
  zoneId,
} from "../../support/testids.ts";
import type { ActionInput, Lane, PlayerId, Side } from "../../support/types.ts";

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

/** `promptOptionId("")` is the prefix, so no spec spells a testid format. */
const OPTION_PREFIX = promptOptionId("");

function spec8Name(index: number): string {
  const name = CARD_NAMES[index];
  if (name === undefined) throw new Error(`no SPEC §8 card #${String(index)}`);
  return name;
}

/** SPEC §8 #65: the Quickdraw Field Spell whose start-of-turn choice this spec reloads on. */
const MASOCHISM_MASK = spec8Name(65);

/**
 * SPEC §8 #77: the 2-cost unit whose Cry installs the one player modifier this fixture can reach,
 * so that the view the reload rebuilds has a badge in it (see the header).
 */
const PROFESSOR_CURVATURE = spec8Name(77);

/**
 * R48 / R65 as `viewFor.modifierLabel` writes them: a `costDiscount` of 1 gated on a current cost
 * of 4. No suffix, because by the turn this file reloads on the discount is live — `modifierViews`
 * appends "(next turn)" only while `modifierIsLive` is false, which is the turn it was played and
 * the opponent's turn after it.
 */
const CURVATURE_LIVE_LABEL = "Cost-4 cards cost 1 less";

function api(path: string): string {
  return `${server.http()}${path}`;
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
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
  /**
   * R169's badge list per side, each badge as `<modifier id>=<caption>`, in the view's own order
   * ("the order they were installed"). Read separately from `testids` because a badge carries
   * `data-modifier-id` and no `data-testid`, so the list is invisible to the set above — only its
   * container is in there, and the container is rendered even when it holds nothing.
   *
   * The caption is part of the key on purpose. The id alone would survive a rebuilt view that
   * came back with the same modifier reading the wrong thing — R48's "(next turn)" suffix is
   * computed from `state.turn` and `state.active` rather than stored, so it is exactly the kind of
   * thing a reconnect could get wrong while the modifier itself round-tripped fine.
   */
  modifiers: Record<string, string[]>;
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

    const modifiers: Record<string, string[]> = {};
    for (const side of SIDES) {
      modifiers[modifiersId(side)] = $body
        .find(`${ts(modifiersId(side))} ${MODIFIER_BADGE}`)
        .map(
          (_index, element) =>
            `${element.getAttribute("data-modifier-id") ?? ""}=${(element.textContent ?? "").trim()}`,
        )
        .get();
    }

    return {
      testids,
      promptKind: prompt.length === 0 ? null : (prompt.attr("data-prompt-kind") ?? null),
      counters,
      modifiers,
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
    const seed = seedFor("05-reconnect-14");
    const seatOne = accounts.p1();
    const seatTwo = accounts.p2();
    let matchId = "";
    let before: ViewFingerprint = { testids: [], promptKind: null, counters: {}, modifiers: {} };
    let beforeClock: ClockFrame = {
      now: 0,
      clocks: { turnDeadline: null, promptDeadline: null, graceDeadline: { p1: null, p2: null }, ceilingAt: 0 },
    };
    let clockFramesBefore = 0;

    // --- both seats are free, and their first saved deck is this spec's fixture (§9.4) ---------
    // `cy.freeAccount`: the E2E server keeps its state for its whole life, so a match or series an
    // earlier spec left behind would answer the room calls below with 409 `already_in_match`.
    // `cy.installLoadout` saves the fixture as the oldest of three decks (R250), which is the one
    // the legacy `{ deckIndex: 0 }` bodies below name (R257).
    cy.freeAccount(seatOne);
    cy.freeAccount(seatTwo);
    cy.installLoadout(seatOne, "05-reconnect-a");
    cy.installLoadout(seatTwo, "05-reconnect-b");

    // --- a live match: seat 1 opens a room, seat 2 claims it (§9.5) ---------------------------
    // `seed` is BUILD M8's "every spec sets a seed". A networked match's seed is normally minted
    // by the server (§9.3, `deps.ids.seed()`); R143 makes it an optional field that an end-to-end
    // server honours and every other server REFUSES with a 400 — never ignores, so a production
    // caller cannot quietly get an unseeded match while believing it asked for one. The room is
    // created before anyone joins, so the host's seed is held against the code until the join
    // consumes it (`match/rooms.ts` `rememberSeed`/`takeSeedForRoom`).
    //
    // This comment used to say the field was ignored and that the fixture therefore had to work
    // for every seed. That was true when the spec was written and is not true now: `rooms.test.ts`
    // proves the host's seed is used verbatim for the match the join creates. The fixture still
    // guarantees its Quickdraw card for every seed, which costs nothing and is one less thing to
    // depend on — but the match this spec drives IS seeded, and its determinism is real.
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

    // --- R9, R265: both mulligans open with the deal; seat 1 answers in the browser, seat 2 over
    // the socket. Either order would do (spec 20 drives both); this one keeps the browser's first.
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

    // --- player-turn 5: answer the Mask, then install the modifier the reload has to rebuild ---
    // No `waitForMyTurn()` here, deliberately: the Mask's choice opens at the START of this turn,
    // and while a `PendingChoice` is open `legalActions` for its holder is `['answer']` alone — no
    // `endTurn` — so `end-turn` is correctly disabled and waiting for it to enable can never
    // succeed. `waitForPrompt` is the right wait for a turn that begins with a question.
    cy.waitForPrompt("mode");
    // `first: 1` is the first option offered, which for #65 base is "exile the bottom card of your
    // library" — the one of the three that touches neither hero's health, so nothing later in this
    // file reads differently for having answered it.
    cy.answerPrompt("mode", { first: 1 });
    cy.noPrompt();
    // …and the freed mana buys the badge. R48 makes the discount cover seat 1's NEXT turn, which
    // is player-turn 7 — the turn this file reloads on.
    cy.playByName(PROFESSOR_CURVATURE, { zone: { side: "you", row: "units", lane: 1 } });
    cy.get(ts(modifiersId("you"))).should("have.attr", "data-count", "1");
    cy.endTurn();
    seatTwoEndsTurn();

    // --- player-turn 7: the Mask asks again, and now the view under the prompt has a badge ----
    cy.waitForPrompt("mode");

    // Stated rather than assumed, because the fingerprint below is a self-comparison and would be
    // just as green over an empty list. R169's badge is on screen, and R48's suffix is gone
    // because `modifierIsLive` is true on the controller's next turn.
    cy.get(ts(modifiersId("you"))).should("have.attr", "data-count", "1");
    cy.get(ts(modifiersId("you"))).find(MODIFIER_BADGE).should("have.text", CURVATURE_LIVE_LABEL);

    fingerprint().then((print) => {
      before = print;
      expect(print.promptKind, "the Mask's start-of-turn choice is a `mode` prompt (§10.6)").to.eq(
        "mode",
      );
      expect(
        optionKeysOf(print).length,
        '#65 base offers three options: "exile the bottom card of your library, lose 3 health, or summon a Spikey Pillow"',
      ).to.eq(3);
      // The badge is IN the fingerprint, so the comparison after the reload covers a populated
      // list rather than an empty one. The modifier's id is deterministic in (seed, log) but is
      // not spelled here: pinning it would turn any unrelated change in `nextSeq` into a failure
      // that reads like a modifier bug.
      const badges = print.modifiers[modifiersId("you")] ?? [];
      expect(badges, "R169's badge list reached the fingerprint").to.have.length(1);
      expect(badges[0] ?? "", "…carrying R48's live caption, not just an id").to.have.string(
        `=${CURVATURE_LIVE_LABEL}`,
      );
      expect(
        print.modifiers[modifiersId("opponent")] ?? [],
        "seat 2 installed none of its own, so the badge above is seat 1's",
      ).to.have.length(0);
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
      // R169: the same badges, per side, in the same order, with the same captions. The captions
      // are the load-bearing half — R48's "(next turn)" is derived from `state.turn` and
      // `state.active` on every read rather than stored, so a view rebuilt from a fresh full push
      // (§9.5: "Reconnect gets a fresh full view, never a log replay") has to arrive at it again.
      expect(after.modifiers, "the same player modifiers, side by side").to.deep.eq(
        before.modifiers,
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
