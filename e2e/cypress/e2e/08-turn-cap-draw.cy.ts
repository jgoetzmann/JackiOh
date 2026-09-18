// BUILD M8 `08-turn-cap-draw.cy.ts` — "Two do-nothing decks, seed with no lethal".
//
// Key assertions (BUILD M8's table, verbatim):
//
//   "after the 30th player-turn the overlay says Draw"
//
// R2 is the ruling under this row: "the cap counts player-turns, so 30 means 15 turns each". So
// the assertion is not "some number of turns happened" but the two halves of R2 — fifteen turns
// started by each seat, thirty player-turns in all — and then §2.5's "End of the 30th turn →
// Draw" on the overlay. Both heroes are still at `HERO_HEALTH` when it appears, which is what
// makes it the cap's draw and not §2.5's "both heroes at 0 or less in the same check".
//
// R82 is the other ruling here: "A turn ends by itself when the active player's only legal
// actions are ending the turn, conceding and offering a draw; the engine emits `turnAutoEnded`
// and ends the turn." Both fixture decks cost 3 or more per card, and max mana is min(turns you
// have started, 4) (§2.3), so on each seat's first two turns there is nothing to do but end them
// and the engine does it — a turn this spec never sees and never clicks. That is asserted by
// counting the clicks: fewer presses than player-turns means the engine ended some of them
// itself. It cannot be asserted for all thirty, because a 20-card deck cannot be made entirely
// unplayable — only #29 (cost 6), #100 (cost 100 less the game's counters), #55 (Tribute 3) and
// #66 (Tribute 1) can never be played at all, and four cards are not twenty. See the report note.
//
// House rules (BUILD M8): the seed is set here and overridable with `--expose seed=…`; there is
// no fixed `cy.wait(ms)` — every wait is `cy.settled()` or a retried assertion; every selector
// comes from `e2e/support/testids.ts`.
//
// The catalog blocker this header used to name is CLOSED. The note is kept rather than deleted
// because a stale "blocked" claim is worse than none — it invites a reader to write off a real
// failure as known. `apps/web` now depends on `@jackioh/cards` and calls `registerAll()` in its
// composition root, so `registeredCatalog()` is populated, `/dev/hotseat` resolves a fixture deck
// and `window.__jackioh` is exposed. If this spec fails in `cy.seedGame` now, it is a finding.
// that registration is the only thing standing between it and a green run.

import { constants, seedFor } from "../../support/config.ts";
import { END_TURN, ts } from "../../support/testids.ts";
import type { GameStateLike, PlayerId } from "../../support/types.ts";

/** Every spec sets a seed (BUILD M8); `--expose seed=…` overrides it. */
const SEED = seedFor("08-turn-cap");

/** §2.5 / R2: 30 player-turns, 15 each. `support/config.ts` keeps the number. */
const CAP = constants.TURN_CAP_PLAYER_TURNS;
const TURNS_EACH = CAP / 2;

/** One more iteration than the cap can possibly need, so a stuck loop fails instead of hanging. */
const STEP_BUDGET = CAP + 4;

type SidePeek = {
  hero?: { health: number };
  mana?: { current: number; max: number };
  hand?: { id: string; defId: string }[];
  turnsStarted?: number;
};

function peek(state: GameStateLike, player: PlayerId): SidePeek {
  return state.players[player] as SidePeek;
}

/** BUILD M5-T3: a hotseat device is handed over, so make sure it is on the seat that has to act. */
function ensureSeat(player: PlayerId): void {
  cy.jackioh().then((handle) => {
    expect(handle.seat, "window.__jackioh.seat names the seat holding the device").to.not.eq(undefined);
    if (handle.seat !== player) cy.handOver();
  });
}

describe("BUILD M8 08 — two do-nothing decks run out the turn cap as a draw", () => {
  it("R2 ends the game as a draw after the 30th player-turn, and R82 ends the dead turns itself", () => {
    cy.seedGame({ seed: SEED, a: "08-do-nothing-a", b: "08-do-nothing-b" });

    // Nothing has happened yet but the opening draws, and nothing ever will: neither deck holds a
    // Cast-on-draw card, a Quickdraw card or a hand trigger, so no card can resolve unless this
    // spec plays one, and it plays none.
    cy.gameState().then((opening) => {
      expect(opening.result, "the game is live after setup").to.eq(null);
      expect(peek(opening, "p1").hero?.health, "seat 1 starts at HERO_HEALTH").to.eq(
        constants.HERO_HEALTH,
      );
      expect(peek(opening, "p2").hero?.health, "seat 2 starts at HERO_HEALTH").to.eq(
        constants.HERO_HEALTH,
      );
    });

    // Press `end-turn` for whoever is to act, until the engine hands back a result. Every turn
    // this loop sees belongs to a player who has a legal action, because R82 means the engine has
    // already ended any turn that does not — which is why `end-turn` must be live here, and a
    // disabled one is a real failure rather than something to skip.
    let pressed = 0;
    const runOut = (left: number): void => {
      cy.gameState().then((state) => {
        if (state.result !== null) return;
        expect(left, `the game ended inside ${STEP_BUDGET} end-turn presses`).to.be.greaterThan(0);
        ensureSeat(state.active);
        cy.get(ts(END_TURN)).should("not.be.disabled");
        cy.endTurn();
        pressed += 1;
        runOut(left - 1);
      });
    };
    runOut(STEP_BUDGET);

    // "after the 30th player-turn": R2's own arithmetic, both halves of it.
    cy.gameState().then((state) => {
      expect(peek(state, "p1").turnsStarted, "R2: seat 1 started 15 turns").to.eq(TURNS_EACH);
      expect(peek(state, "p2").turnsStarted, "R2: seat 2 started 15 turns").to.eq(TURNS_EACH);
      expect(state.turn, "R2: the player-turn counter reached the cap").to.be.at.least(CAP);

      // "the overlay says Draw", and it is the cap's draw: §2.5's other draw is two heroes at 0
      // or less in the same check, and neither hero has lost a point of health in thirty turns.
      expect(state.result?.winner, "§2.5: the turn cap is a draw").to.eq("draw");
      expect(peek(state, "p1").hero?.health, "seat 1 never took damage").to.eq(constants.HERO_HEALTH);
      expect(peek(state, "p2").hero?.health, "seat 2 never took damage").to.eq(constants.HERO_HEALTH);

      // R82: some of those thirty player-turns ended without anybody pressing anything. With
      // both decks at cost 3 and up that is each seat's first two turns (1 mana, then 2).
      expect(pressed, "R82: the engine ended at least one dead turn itself").to.be.lessThan(CAP);
    });

    // BUILD M5-T4 `gameOver`: "overlay text Win / Loss / Draw". A draw is the one result that
    // reads the same from both seats, so it is asserted from both (§10.8 orients the view).
    cy.expectResult("Draw");
    cy.handOver();
    cy.expectResult("Draw");
  });
});
