// BUILD M8 `03-trap-opponent-turn.cy.ts` — "P2 has Sheepish set; P1 plays a unit".
//
// Key assertions (BUILD M8's table, verbatim):
//
//   "trap flips during P1's turn; the unit is a Sheep; P1 can continue"
//
// The third one is R118, and it is the reason a trap is not just another effect: "A trap that
// interrupts a play resolves to completion first (§10.3), and the play then resumes at the step
// after the one that paused, so the Cry still fires — exactly once (R1). R17's 'the Cry is lost'
// applies only where the trap has taken the card off the field, as Sheepish does, which the
// resolving check already covers."
//
// So one play here shows both halves of that sentence:
//
//   * #15 Me and Mr Token is the unit that springs the trap. Sheepish "fires on the play, before
//     the Cry resolves" (R17), and the Transform takes the card off the field, so the Rush Token
//     its Cry would have summoned never arrives — the exception R118 points at. It also has to be
//     a unit that is not Immutable: R17 and R23 let an Immutable target refuse the Transform and
//     the trap is merely spent, which would be a different test (#8 Mr. Vanilla is that card).
//   * #81 Radiant Saintess is played straight afterwards, on the same turn, and its Cry ("all your
//     units become Radiant", including itself — R22) lands on the Sheep. That is "P1 can
//     continue": the turn is still player 1's, the client is not locked, and the next play's Cry
//     fires normally.
//
// Hidden information is asserted on the way through, because it is the other thing a trap on the
// far side of the board tests (CLAUDE.md rule 7, §10.8, R33): while the trap is set, player 1's
// screen has no `card-<instanceId>` for it at all — only a face-down card in a zone.
//
// Seed `03-sheep-167` was chosen against these two fixtures so #15 and #81 are in player 1's hand
// by its second turn (two mana, one each) and Sheepish is in player 2's hand on its first.

import { seedFor } from "../../support/config.ts";
import {
  END_TURN,
  RADIANT,
  cardId,
  graveyardCountId,
  handCardId,
  ts,
  zoneId,
} from "../../support/testids.ts";
import type { PlayerId } from "../../support/types.ts";

const SEED = seedFor("03-sheep-12");

/** Stat hooks BUILD M5-T4's acceptance rows read off a card; not in support/testids.ts (reported). */
const attackIs = (n: number): string => `[data-attack="${n}"]`;
const healthIs = (n: number): string => `[data-health="${n}"]`;

/** BUILD M5-T3: a hotseat device is handed over, so put it on the seat that has to act. */
function ensureSeat(player: PlayerId): void {
  cy.jackioh().then((handle) => {
    expect(handle.seat, "window.__jackioh.seat (the hotseat handle names the seat holding it)").to.not.eq(
      undefined,
    );
    if (handle.seat !== player) cy.handOver();
  });
}

/**
 * End turns until `turn` is the current player-turn (§10.1: 1-based, player 1 takes the odd ones).
 *
 * R82 is why this is a loop over the turn counter rather than a pair of `cy.endTurn()` calls: "a
 * turn ends by itself when the active player's only legal actions are ending the turn, conceding
 * and offering a draw", and player 2 setting a one-mana trap on a one-mana turn is exactly that —
 * the engine emits `turnAutoEnded` and there is no `end-turn` left to press, only a device to hand
 * over.
 */
function advanceToTurn(turn: number, budget = 8): void {
  cy.gameState().then((state) => {
    expect(budget, `turn ${turn} is reachable inside the budget`).to.be.greaterThan(0);
    ensureSeat(state.active);
    if (state.turn === turn) return;
    cy.endTurn();
    advanceToTurn(turn, budget - 1);
  });
}

describe("BUILD M8 03 — a trap fires on the other player's turn", () => {
  it("R17 / R118 — Sheepish flips during P1's turn, the unit is a Sheep, and P1 plays on", () => {
    cy.seedGame({ seed: SEED, a: "03-plays-a", b: "03-sheepish-b" });

    // Player 1's first turn: nothing to do until the trap is set, so pass it to player 2.
    advanceToTurn(2);

    // Player 2 sets Sheepish face-down in backrow lane 3 (§5.1: "paid for and placed face-down").
    cy.playByName("Sheepish", { zone: { side: "you", row: "backrow", lane: 3 } });
    cy.instanceAt("p2", "backrow", 3).then((trap) => {
      // R33: its controller sees its identity, so on THIS seat the card has its own testid.
      cy.get(ts(zoneId("you", "backrow", 3))).find(ts(cardId(trap))).should("exist");

      // One mana spent on a one-mana turn leaves player 2 with nothing else to do, so R82 has
      // probably ended the turn already; either way this lands on player 1's second turn.
      advanceToTurn(3);

      // R33 / §10.8 from the other side: player 1 sees a face-down card and nothing else. A
      // `card-<instanceId>` here would be the client holding information `viewFor` never sent.
      cy.get(ts(zoneId("opponent", "backrow", 3))).find(ts(cardId(trap))).should("not.exist");
      cy.get(ts(cardId(trap))).should("not.exist");

      cy.handCardByName("Me and Mr Token").then((played) => {
        // The play, click by click, rather than through `cy.playByName`, because the trap's
        // animation has to be caught while it runs and `cy.playCard` settles first.
        cy.get(ts(handCardId(played))).click();
        cy.get(ts(zoneId("you", "units", 1))).click();

        // "trap flips during P1's turn": BUILD M5-T4's `trapFired` row is the flip, and §10.3 has
        // the trap resolve inside player 1's action rather than after it.
        cy.expectAnimating("trapFired");
        cy.settled();
        cy.gameState().should((state) => {
          expect(state.active, "the trap fired inside player 1's turn (§10.3)").to.eq("p1");
          expect(state.pending, "Sheepish asks nothing, so nothing is paused").to.eq(null);
        });

        // "the unit is a Sheep": the played card is gone and a Sheep Token stands in the zone
        // player 1 chose — §6.3 Transform puts the new instance in the same zone.
        cy.get(ts(cardId(played))).should("not.exist");
        cy.get(ts(handCardId(played))).should("not.exist");
        cy.fieldCardByName("Sheep Token").then((sheep) => {
          cy.get(ts(zoneId("you", "units", 1))).find(ts(cardId(sheep))).should("exist");
          // §7: the Sheep Token is a 1/1 (and is worth 2 Tributes while on the field).
          cy.get(ts(cardId(sheep))).find(attackIs(1)).should("exist");
          cy.get(ts(cardId(sheep))).find(healthIs(1)).should("exist");

          // R17: Sheepish fires BEFORE the Cry and takes the card off the field, so the Rush Token
          // #15 would have summoned never arrives — a second unit here would mean the Cry resolved
          // first. Counted off the state rather than the DOM because "nothing was summoned" is a
          // claim about every zone at once, and a token would have gone to the leftmost free one
          // (R64) rather than to a lane this spec could name.
          cy.gameState().should((state) => {
            const side = state.players.p1 as { units?: ({ id: string }[] | null)[] };
            const occupied = (side.units ?? []).filter((pile) => pile !== null && pile.length > 0);
            expect(occupied, "R17: the Cry went with the card, so no Rush Token was summoned").to.have.length(
              1,
            );
          });

          // The trap is spent: it is face-up nowhere, and a Trap (not a Field Trap) goes to its
          // owner's graveyard once it has fired (§3.2, §5.1).
          cy.get(ts(cardId(trap))).should("not.exist");
          cy.get(ts(graveyardCountId("opponent"))).should("have.text", "1");

          // "P1 can continue" (R118): the turn is still player 1's, the controls are live, and the
          // next play resolves its own Cry — which lands on the Sheep (R22: "all your units",
          // including itself; §5.2: a token with no radiant form still takes the flag).
          cy.get(ts(END_TURN)).should("not.be.disabled");
          cy.playByName("Radiant Saintess", { zone: { side: "you", row: "units", lane: 2 } });
          cy.get(ts(cardId(sheep))).should("have.attr", "data-radiant", "true");
          cy.get(`${ts(cardId(sheep))}${RADIANT}`).should("exist");
          cy.fieldCardByName("Radiant Saintess").then((saintess) => {
            cy.get(ts(cardId(saintess))).should("have.attr", "data-radiant", "true");
          });

          // …and the turn ends the ordinary way, so the trap left nothing half-resolved.
          cy.endTurn();
          cy.gameState().should((state) => {
            expect(state.active, "player 1 ended its own turn").to.eq("p2");
            expect(state.result, "the game is still running").to.eq(null);
          });
        });
      });
    });
  });
});
