// BUILD M8 `01-hotseat-full-game.cy.ts` — "Seeded game to completion via the UI with two aggro
// decks".
//
// Key assertions (BUILD M8's table, verbatim):
//
//   "result overlay appears; final state hash equals the vitest replay of the recorded actions"
//
// The second half is the point of this spec and the reason it exists alongside the engine's own
// replay tests: the log is recorded by the BROWSER, action by action, as a human would build it
// out of clicks, and is then folded by `packages/engine/src/replay.ts` in Node
// (`cy.task("replayHash")` → `e2e/support/tasks/replay-runner.ts`) and hashed. Equal hashes mean
// the client sent nothing the engine did not accept, in the order it accepted it — BUILD M5-T3's
// "the same seed and actions reproduce the same final state hash in the browser and in vitest".
//
// House rules (BUILD M8): the seed is set here and overridable with `--expose seed=…`, so BUILD
// §4's "nightly run of 01 over 20 seeds" needs no edit to this file; there is no fixed
// `cy.wait(ms)` — every wait is `cy.settled()` (`data-animating` drained) or a retried assertion;
// and every selector comes from `e2e/support/testids.ts`.
//
// Why the game is driven generically rather than from a scripted turn plan: a spec that is re-run
// over twenty seeds cannot know its own draw order. So each turn plays whatever the client has
// highlighted as playable, attacks with whatever it has highlighted as able to attack, and ends
// the turn — which is also the shape of a real game and touches nothing but the board. The two
// fixture decks are built so that path never meets a choice it cannot answer: every card in
// `01-aggro-a` / `01-aggro-b` is choice-free at play time (no target, mode, direction, X,
// embiggen or Tribute declaration — R81) and opens no `PendingChoice` while it resolves, so the
// only pickers in the whole game are the opening mulligan, which `cy.seedGame` answers, and the
// zone grid, which a board click finishes (BUILD M5-T2).

import { seedFor, timeouts } from "../../support/config.ts";
import {
  LEGAL,
  RESULT_OVERLAY,
  cardId,
  handCardId,
  heroId,
  ts,
  zoneId,
} from "../../support/testids.ts";
import type { GameStateLike, Lane, PlayerId, Row } from "../../support/types.ts";

/** Every spec sets a seed (BUILD M8); `--expose seed=…` overrides it for the nightly sweep. */
const SEED = seedFor("01-hotseat");

/** §2.5 / R2 cap the game at 30 player-turns; the budget is that plus slack for `turnAutoEnded`. */
const MAX_TURNS = 40;
/** A turn cannot hold more than five plays and five attacks (five lanes, one exertion each). */
const MAX_PLAYS_PER_TURN = 12;

const ROWS: readonly Row[] = ["units", "backrow"];
const LANES: readonly Lane[] = [1, 2, 3, 4, 5];

function other(player: PlayerId): PlayerId {
  return player === "p1" ? "p2" : "p1";
}

/**
 * One seat's hand and unit piles, read off `window.__jackioh.state` with the same cast
 * `e2e/support/commands.ts` uses in `instanceInHand` and `instanceAt`. It answers exactly one
 * question — "which instance ids might I click?" — and never what the game says happened: every
 * assertion below reads the DOM, which is `viewFor` (CLAUDE.md rule 7). A `cy.handIds(player)` /
 * `cy.unitIds(player)` pair in `support/commands.ts` would delete this (reported).
 */
type SidePeek = {
  hand?: { id: string; defId: string }[];
  units?: ({ id: string }[] | null)[];
};

function peek(state: GameStateLike, player: PlayerId): SidePeek {
  return state.players[player] as SidePeek;
}

function handOf(state: GameStateLike, player: PlayerId): string[] {
  return (peek(state, player).hand ?? []).map((card) => card.id);
}

/** The top card of each of a seat's unit zones — §3.2: only a Stack pile's top card is active. */
function unitsOf(state: GameStateLike, player: PlayerId): string[] {
  return (peek(state, player).units ?? []).flatMap((pile) => {
    const top = pile === null ? undefined : pile[0];
    return top === undefined ? [] : [top.id];
  });
}

/**
 * The first of `testids` the client has marked `data-legal="true"`, or null when none is.
 * `data-legal` is the client's copy of `legalActions` (BUILD M5-T2), so this asks the engine what
 * is playable and never decides it here. The `cy.get("body")` probe is `support/commands.ts`'s own
 * pattern for "is this in the DOM at all", which `cy.get` cannot answer without failing.
 */
function firstLegal(testids: readonly string[]): Cypress.Chainable<string | null> {
  return cy.get("body", { log: false }).then(($body) => {
    const found = testids.find((testid) => $body.find(`${ts(testid)}${LEGAL}`).length > 0);
    // Wrapped rather than returned bare: Cypress reads a bare `null` from `.then` as "keep the
    // current subject", which would hand back the body element instead of the answer.
    return cy.wrap(found ?? null, { log: false });
  });
}

/** BUILD M5-T3: a hotseat device is handed over, so make sure it is on the seat that has to act. */
function ensureSeat(player: PlayerId): void {
  cy.jackioh().then((handle) => {
    expect(handle.seat, "window.__jackioh.seat (the hotseat handle names the seat holding it)").to.not.eq(
      undefined,
    );
    if (handle.seat !== player) cy.handOver();
  });
}

/** Play cards while the client offers one. Each play is a hand click plus, for a permanent, a zone. */
function playWhilePossible(budget: number): void {
  if (budget <= 0) return;
  cy.gameState().then((state) => {
    if (state.result !== null) return;
    firstLegal(handOf(state, state.active).map(handCardId)).then((card) => {
      if (card === null) return;
      cy.get(ts(card)).click();
      cy.settled();
      // R81: the zone travels inside the `play` action, and M5-T2 has the board click finish the
      // play — a spell needs no zone, and then no zone is highlighted and nothing is clicked.
      firstLegal(ROWS.flatMap((row) => LANES.map((lane) => zoneId("you", row, lane)))).then((zone) => {
        if (zone !== null) {
          cy.get(ts(zone)).click();
          cy.settled();
        }
        playWhilePossible(budget - 1);
      });
    });
  });
}

/**
 * Try each of this seat's units as an attacker, once. The target is the enemy hero when the client
 * offers it and otherwise the first enemy unit it offers, which is how Taunt (§4.2 step 3) steers
 * the run without this spec knowing the rule.
 */
function attackWith(attackers: readonly string[], index: number): void {
  const attacker = attackers[index];
  if (attacker === undefined) return;
  cy.gameState().then((state) => {
    if (state.result !== null) return;
    firstLegal([cardId(attacker)]).then((selectable) => {
      if (selectable === null) {
        attackWith(attackers, index + 1);
        return;
      }
      cy.get(ts(cardId(attacker))).click();
      const targets = [heroId("opponent"), ...unitsOf(state, other(state.active)).map(cardId)];
      firstLegal(targets).then((target) => {
        // A unit the client highlighted only because it may switch position (M5-T2 puts
        // `switchPosition` on the card too) has no attack to declare; clicking it again puts it
        // down and the run moves to the next unit.
        cy.get(ts(target ?? cardId(attacker))).click();
        cy.settled();
        attackWith(attackers, index + 1);
      });
    });
  });
}

function takeTurns(remaining: number): void {
  cy.gameState().then((state) => {
    expect(remaining, "the game reached a result inside the turn budget").to.be.greaterThan(0);
    if (state.result !== null) return;
    // Both fixture decks are choice-free (see the header), so a prompt open here means the decks or
    // the client have changed under the spec rather than that the spec missed an answer.
    expect(state.pending, "01-aggro-a/b open no prompt once the mulligan is answered").to.eq(null);

    const me = state.active;
    ensureSeat(me);
    playWhilePossible(MAX_PLAYS_PER_TURN);

    cy.gameState().then((afterPlays) => {
      if (afterPlays.result !== null) return;
      attackWith(unitsOf(afterPlays, me), 0);

      cy.gameState().then((afterAttacks) => {
        if (afterAttacks.result !== null) return;
        // R82: with nothing else legal the engine ends the turn itself and emits `turnAutoEnded`,
        // so there is no `end-turn` to press — only a device to hand over.
        if (afterAttacks.active === me) cy.endTurn();
        else cy.handOver();
        takeTurns(remaining - 1);
      });
    });
  });
}

describe("BUILD M8 01 — a seeded hotseat game played to completion through the UI", () => {
  it("shows the result overlay and the recorded log folds to the same state hash", () => {
    cy.seedGame({ seed: SEED, a: "01-aggro-a", b: "01-aggro-b" });

    takeTurns(MAX_TURNS);

    // "result overlay appears" — and it says what the engine's result says for the seat holding
    // the device (§10.8: the client renders `viewFor`, so Win / Loss is viewer-relative).
    cy.get(ts(RESULT_OVERLAY), { timeout: timeouts.game }).should("be.visible");
    cy.jackioh().then((handle) => {
      const result = handle.state.result;
      expect(result, "the engine ended the game (§2.5)").to.not.eq(null);
      if (result === null) return;
      const shown = result.winner === "draw" ? "Draw" : result.winner === handle.seat ? "Win" : "Loss";
      cy.get(ts(RESULT_OVERLAY)).should("contain.text", shown);
      cy.get(ts(RESULT_OVERLAY)).should("contain.text", result.reason);
    });

    // "final state hash equals the vitest replay of the recorded actions": `cy.replayCheck` hands
    // (seed, decks, log, final state) to `cy.task("replayHash")`, which folds the log through
    // `packages/engine/src/replay.ts` under the repo's tsx and compares `hashState` on both sides.
    // It also asserts the fold rejected none of the recorded actions.
    cy.replayCheck("01-hotseat-full-game");
  });
});
