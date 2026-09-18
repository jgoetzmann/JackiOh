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
// Seed `03-sheep-19` was chosen against these two fixtures so #15 and #81 are in player 1's hand
// by its second turn (two mana, one each) and Sheepish is in player 2's hand on its first.
//
// ---------------------------------------------------------------------------------------------
// THE SECOND `it` IS THE OTHER HALF OF THE SAME SENTENCE. This file is the suite's
// hidden-information-on-the-board spec: §10.8 and R33 decide what each seat may read off a card
// standing in a zone, and the trap above is the FACE-DOWN case — player 1's screen has no
// `card-<instanceId>` for Sheepish at all while it is set.
//
// R169 is the face-up case, and it had no browser coverage anywhere in the twelve. The player
// modifiers travel in the view "as `{ id, label }` on **both** seats, because every one of them is
// installed by a card played FACE-UP", and the caption "is built from the modifier's own kind and
// numbers and never from its `sourceId`, so no card identity can leave through a badge". #77
// Professor Curvature is the one Core modifier installed by a Cry, and `03-plays-a` already holds
// it, so the second `it` plays it and reads the badge from both seats.
//
// R48 is what makes the caption worth asserting rather than merely counting. "During your NEXT
// turn" means the discount is installed at once and bites later, so `viewFor` appends
// "(next turn)" while `modifierIsLive` is still false — otherwise the badge would claim a discount
// on the very turn the discount does nothing. Three readings pin that down: the turn it lands
// (dormant), the opponent's turn in between (still dormant — "your" next turn, not the next turn),
// and the controller's next turn (live). Then R48's cleanup takes it away and the empty container
// stays behind.
// ---------------------------------------------------------------------------------------------

import { seedFor } from "../../support/config.ts";
import {
  END_TURN,
  MODIFIER_BADGE,
  RADIANT,
  cardId,
  graveyardCountId,
  handCardId,
  modifierBadgeOf,
  modifiersId,
  ts,
  zoneId,
} from "../../support/testids.ts";
import type { PlayerId, Side } from "../../support/types.ts";

const SEED = seedFor("03-sheep-19");

/**
 * The second `it`'s seed, chosen the same way the first one's was: against these two fixtures it
 * puts #77 in player 1's hand by player-turn 3, which is player 1's second turn and the first one
 * whose two mana can pay SPEC §8's price for it.
 */
const CURVATURE_SEED = seedFor("03-curvature-4");

/** SPEC §8 #77, as the client prints it on a card. */
const CURVATURE = "Professor Curvature";

/**
 * The badge caption, whole. `viewFor.modifierLabel` builds it from the modifier's own kind and
 * numbers — a `costDiscount` of 1 gated on a current cost of 4 (R48, R65) — and `modifierViews`
 * appends the suffix while the discount is dormant. Asserted with `have.text` rather than
 * `contain.text` precisely so that a caption which quietly dropped the suffix fails here.
 */
const CURVATURE_DISCOUNT = "Cost-4 cards cost 1 less";
const CURVATURE_DORMANT = `${CURVATURE_DISCOUNT} (next turn)`;

/** BUILD M5-T1's two viewports; the first is `cypress.config.ts`'s default. */
const DESKTOP = { width: 1280, height: 720 } as const;
const PHONE = { width: 390, height: 844 } as const;

const SIDES: readonly Side[] = ["you", "opponent"];

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

describe("BUILD M8 03 — a trap fires on the other player's turn; a face-up modifier shows on both seats", () => {
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

          // …and the turn finishes the ordinary way, so the trap left nothing half-resolved.
          // Both mana are spent by now, so this is player 1 pressing `end-turn` or R82 having
          // ended it for them; the assertion is that the game moved on either way.
          advanceToTurn(4);
          cy.gameState().should((state) => {
            expect(state.turn, "player 1's turn finished").to.eq(4);
            expect(state.active, "and player 2 is up").to.eq("p2");
            expect(state.result, "the game is still running").to.eq(null);
          });
        });
      });
    });
  });

  it("R169 / R48 — Professor Curvature's badge is on both seats, says it is not live yet, and goes at cleanup", () => {
    cy.seedGame({ seed: CURVATURE_SEED, a: "03-plays-a", b: "03-sheepish-b" });

    // Before anything installs one, the list exists on both seats and holds nothing. Both halves
    // matter: `Hero.tsx` keeps the container when the list is empty because `modifierChanged`'s
    // fade is the animation for the badge that has just left, so "no badges" and "no list" have to
    // be distinguishable — and a suite that only ever saw an empty list would not notice either.
    for (const side of SIDES) {
      cy.get(ts(modifiersId(side))).should("exist").and("have.attr", "data-count", "0");
      cy.get(ts(modifiersId(side))).find(MODIFIER_BADGE).should("not.exist");
    }

    // Player-turn 3 is player 1's second turn: two mana, which is what SPEC §8 prices #77 at.
    // `cy.advanceToTurn` rather than this file's older local helper because it is R82-safe — it
    // presses `end-turn` only when the client is still offering one.
    cy.advanceToTurn(3);
    ensureSeat("p1");

    cy.playByName(CURVATURE, {
      zone: { side: "you", row: "units", lane: 2 },
      // BUILD M5-T4 `modifierChanged`: "Player modifier badge appears or fades by the hero", 200 ms
      // on `modifiers-<side>`. Caught between the click and `cy.playCard`'s own `cy.settled()`.
      // This is the row whose animation had a target that no component rendered until R169.
      expectAnimating: "modifierChanged",
    });

    // R169 from the controller's own seat: one badge, and it is the view's list rather than a
    // count the client kept for itself.
    cy.get(ts(modifiersId("you"))).should("have.attr", "data-count", "1");
    cy.get(ts(modifiersId("you"))).find(MODIFIER_BADGE).should("have.length", 1);
    // R48, and the whole reason the caption is asserted and not just the count: on the turn
    // Curvature lands the discount does nothing, so the badge says so. A badge reading the bare
    // discount here would be telling the player they have something they do not have yet.
    cy.get(ts(modifiersId("you"))).find(MODIFIER_BADGE).should("have.text", CURVATURE_DORMANT);
    // The opponent's own list is still empty, so the badge below is player 1's and not a stray.
    cy.get(ts(modifiersId("opponent"))).should("have.attr", "data-count", "0");

    cy.get(ts(modifiersId("you")))
      .find(MODIFIER_BADGE)
      .invoke("attr", "data-modifier-id")
      .should("be.a", "string")
      .then((raw) => {
        const modifierId = String(raw);

        // R169's "on BOTH seats". The device goes to player 2 and the same modifier, by the same
        // id and with the same caption, is now drawn against the opponent's hero. §10.8 lists no
        // `mods`, so this is the ruling being visible rather than merely written down.
        cy.handOver();
        cy.get(ts(modifiersId("opponent"))).should("have.attr", "data-count", "1");
        cy.get(ts(modifiersId("opponent"))).find(modifierBadgeOf(modifierId)).should("exist");
        cy.get(ts(modifiersId("opponent")))
          .find(MODIFIER_BADGE)
          .should("have.text", CURVATURE_DORMANT);
        // …and player 2 has none of their own, which is what makes the line above a statement
        // about whose modifier it is rather than about how many badges exist.
        cy.get(ts(modifiersId("you"))).should("have.attr", "data-count", "0");
        cy.get(ts(modifiersId("you"))).find(MODIFIER_BADGE).should("not.exist");

        // THE BADGE AT PHONE WIDTH. `.modifiers` and `.modifier-badge` are new content inside
        // `.hero`, which is a `display: flex` row with no wrap of its own, and this is the only
        // place in the twelve where a badge is on screen at all — so it is the only browser-side
        // look that CSS will ever get at 390 px. Spec 12 measures the board at both viewports;
        // this measures the one element spec 12's board never has.
        cy.viewport(PHONE.width, PHONE.height);
        cy.get(ts(modifiersId("opponent"))).find(modifierBadgeOf(modifierId)).should("be.visible");
        cy.get(ts(modifiersId("opponent")))
          .find(MODIFIER_BADGE)
          .should("have.text", CURVATURE_DORMANT);
        cy.document({ log: false }).should((doc) => {
          expect(
            doc.documentElement.scrollWidth,
            `the badge did not widen the document past ${String(PHONE.width)}px`,
          ).to.be.at.most(PHONE.width);
          expect(doc.body.scrollWidth, `nor the body past ${String(PHONE.width)}px`).to.be.at.most(
            PHONE.width,
          );
        });
        cy.viewport(DESKTOP.width, DESKTOP.height);

        // R48's middle case, and the one a naive reading gets wrong. `modifierIsLive` is
        // `state.turn > fromTurn && state.active === player`: the opponent's turn in between
        // satisfies the first half and not the second, because #77 says "during **your** next
        // turn". So the caption is still the dormant one here.
        cy.advanceToTurn(4);
        cy.gameState().should((state) => {
          expect(state.active, "player 2's turn").to.eq("p2");
        });
        cy.get(ts(modifiersId("opponent"))).find(modifierBadgeOf(modifierId)).should("exist");
        cy.get(ts(modifiersId("opponent")))
          .find(MODIFIER_BADGE)
          .should("have.text", CURVATURE_DORMANT);

        // The controller's next turn: live, and the caption drops the suffix. Nothing else about
        // the badge changes, which is how this reads as one modifier becoming live rather than as
        // one badge being replaced by another.
        cy.advanceToTurn(5);
        ensureSeat("p1");
        cy.get(ts(modifiersId("you"))).should("have.attr", "data-count", "1");
        cy.get(ts(modifiersId("you"))).find(modifierBadgeOf(modifierId)).should("exist");
        cy.get(ts(modifiersId("you"))).find(MODIFIER_BADGE).should("have.text", CURVATURE_DISCOUNT);

        // R48's expiry: `expireModifiers` drops it at the cleanup of that player's next turn
        // (§2.2). The badge goes with it and the container stays — the state `Hero.tsx` renders an
        // empty list for.
        cy.advanceToTurn(6);
        cy.get(modifierBadgeOf(modifierId)).should("not.exist");
        for (const side of SIDES) {
          cy.get(ts(modifiersId(side))).should("exist").and("have.attr", "data-count", "0");
          cy.get(ts(modifiersId(side))).find(MODIFIER_BADGE).should("not.exist");
        }
        // …because the modifier went, not because the list stopped being drawn.
        cy.gameState().should((state) => {
          const side = state.players.p1 as { mods?: unknown[] };
          expect(side.mods ?? [], "R48: expired at the cleanup of player 1's next turn").to.have.length(
            0,
          );
        });
      });
  });
});
