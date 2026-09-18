// BUILD M8 `04-combat.cy.ts` — "Taunt, DEF position, First Strike, Divine Shield on board".
//
// Key assertions (BUILD M8's table, verbatim):
//
//   "illegal target not highlighted; DEF card rotated; damage pops match pipeline numbers"
//
// Every number below is computed from SPEC §4.3 (the two combat steps) and §4.4 (the ten-step
// damage pipeline) before the spec is run, never read back off the UI — that is the point of the
// third assertion. The arithmetic, once, for the three combats this spec drives:
//
//  A. #8 Mr. Vanilla (3/3, ATK) attacks #8 Mr. Vanilla (3/3, DEF).
//     Neither has First Strike, so §4.3 step 2 is simultaneous.
//     Attacker → defender: step 1 no Divine Shield; step 2 Armor = Defense Position's +1 (§4.1),
//       3 − 1 = 2; step 3 not a hero; step 5 apply 2. Pop "2", defender at 3 − 2 = 1 health.
//     Defender → attacker: "a defender in Defense Position still strikes back with its full
//       attack" (§4.3), and the attacker has no Armor: 3. Pop "3", attacker at 0 → destroyed at
//       the state check (§4.5).
//
//  B. #11 Tempo Timmy (3/3, First Strike) attacks #56 Jilliax (3/2, Divine Shield, Taunt,
//     Lifesteal).
//     §4.3 step 1, Timmy strikes first: §4.4 step 1 Divine Shield "negates the whole hit and
//       removes the shield. Stop." — so there is NO `damage` event and NO pop on Jilliax, and it
//       is still at 2/2 afterwards.
//     Jilliax is not destroyed, so step 2 runs; R93 makes step 1 Timmy's only strike, so only
//       Jilliax deals damage here: 3 with no Armor in the way. Pop "3", Timmy at 0 → destroyed.
//     Step 8, Lifesteal on the source: heal Jilliax's controller's hero by the 3 actually dealt.
//       Heal pop "3", and that hero goes 30 → 33 (§3: "Health has no upper cap").
//
//  C. #20 Pointmaster (7/2, First Strike) attacks the same Jilliax, now shieldless.
//     Step 1: no shield, no Armor → 7 applied. Pop "7", Jilliax at 2 − 7 → destroyed in step 1,
//       and §4.3 says "If D is destroyed here it deals nothing" — so Pointmaster ends the combat
//       at 2/2, untouched, and Jilliax's Lifesteal heals nothing.
//
// The pops are asserted while the animation runs, which is the only time they exist (BUILD M5-T4:
// the number comes from the event the runner is animating on that element), so these two combats
// are driven by clicks rather than by `cy.attack`, which settles first. Each pop assertion is
// followed by the durable stat it implies, so the run is checked twice over.
//
// Seed `04-combat-1604` was chosen against these fixtures so Mr. Vanilla and Tempo Timmy are in
// player 1's opening hand, Pointmaster arrives by its second turn, and Mr. Vanilla and Jilliax are
// in player 2's hand for its first and second.

import { seedFor } from "../../support/config.ts";
import {
  DAMAGE_POP,
  HEAL_POP,
  cardId,
  graveyardCountId,
  heroId,
  ts,
} from "../../support/testids.ts";
import type { PlayerId } from "../../support/types.ts";

const SEED = seedFor("04-combat-1604");

/**
 * Card hooks BUILD M5-T4's acceptance rows read ("stat numbers ... equal the view's", the position
 * rotation, the keyword icons). They are not in `e2e/support/testids.ts`, so they are spelled once
 * here rather than at each use, and adding them to support is reported.
 */
const attackIs = (n: number): string => `[data-attack="${n}"]`;
const healthIs = (n: number): string => `[data-health="${n}"]`;
const maxHealthIs = (n: number): string => `[data-max-health="${n}"]`;
const armorIs = (n: number): string => `[data-armor="${n}"]`;
const keywordIs = (keyword: string): string => `[data-keyword="${keyword}"]`;

/** BUILD M5-T3: a hotseat device is handed over, so put it on the seat that has to act. */
function ensureSeat(player: PlayerId): void {
  cy.jackioh().then((handle) => {
    expect(handle.seat, "window.__jackioh.seat (the hotseat handle names the seat holding it)").to.not.eq(
      undefined,
    );
    if (handle.seat !== player) cy.handOver();
  });
}

/** End turns until `turn` is the current player-turn (§10.1: 1-based, player 1 takes the odd ones). */
function advanceToTurn(turn: number, budget = 12): void {
  cy.gameState().then((state) => {
    expect(budget, `turn ${turn} is reachable inside the budget`).to.be.greaterThan(0);
    ensureSeat(state.active);
    if (state.turn === turn) return;
    cy.endTurn();
    advanceToTurn(turn, budget - 1);
  });
}

/**
 * What the client has highlighted, which is its copy of `legalActions` and nothing else
 * (BUILD M5-T2, CLAUDE.md rule 7): `data-legal="false"` is "the engine did not offer this", which
 * is what "illegal target not highlighted" means.
 */
function expectHighlight(testid: string, legal: boolean, why: string): void {
  cy.get(ts(testid)).should(($element) => {
    expect($element.attr("data-legal"), why).to.eq(legal ? "true" : "false");
  });
}

/** Select a unit as the attacker: the first click of an attack (BUILD M5-T2). */
function selectAttacker(instanceId: string): void {
  cy.get(ts(cardId(instanceId))).click();
}

describe("BUILD M8 04 — Taunt, Defense Position, First Strike and Divine Shield on the board", () => {
  it("§4.2 step 3 — Taunt leaves every other target un-highlighted", () => {
    cy.seedGame({ seed: SEED, a: "04-combat-a", b: "04-combat-b" });

    // Player 1's attacker, played early so it is not summoning sick when it attacks (§4.1).
    ensureSeat("p1");
    cy.playByName("Tempo Timmy", { zone: { side: "you", row: "units", lane: 1 } });

    // Player 2 puts up a plain 3/3 first and the Taunt unit after it, so the board holds one legal
    // and one illegal target when the attack is declared.
    advanceToTurn(2);
    cy.playByName("Mr. Vanilla", { zone: { side: "you", row: "units", lane: 1 } });
    advanceToTurn(4);
    cy.playByName("Jilliax", { zone: { side: "you", row: "units", lane: 2 } });

    advanceToTurn(5);
    cy.instanceAt("p1", "units", 1).then((timmy) => {
      cy.instanceAt("p2", "units", 1).then((vanilla) => {
        cy.instanceAt("p2", "units", 2).then((jilliax) => {
          // #56 Jilliax has printed Taunt, so the taunt check narrows the target set to it.
          cy.get(ts(cardId(jilliax))).find(keywordIs("Taunt")).should("exist");

          selectAttacker(timmy);
          expectHighlight(cardId(jilliax), true, "the Taunt unit is the one legal target (§4.2 step 3)");
          expectHighlight(cardId(vanilla), false, "a non-Taunt enemy unit is not a legal target");
          expectHighlight(heroId("opponent"), false, "the enemy hero is not a legal target while Taunt is up");
          // The attacker itself stays clickable, which is how a selection is put back down.
          expectHighlight(cardId(timmy), true, "the selected attacker stays clickable (M5-T2)");
        });
      });
    });
  });

  it("§4.1 / §4.4 step 2 — a Defense Position card is rotated, taunts, and its Armor 1 is in the numbers", () => {
    cy.seedGame({ seed: SEED, a: "04-combat-a", b: "04-combat-b" });

    ensureSeat("p1");
    cy.playByName("Mr. Vanilla", { zone: { side: "you", row: "units", lane: 1 } });
    advanceToTurn(2);
    cy.playByName("Mr. Vanilla", { zone: { side: "you", row: "units", lane: 1 } });

    advanceToTurn(3);
    cy.playByName("Tempo Timmy", { zone: { side: "you", row: "units", lane: 2 } });

    cy.instanceAt("p1", "units", 1).then((defender) => {
      cy.instanceAt("p1", "units", 2).then((timmy) => {
        cy.instanceAt("p2", "units", 1).then((attacker) => {
          // §4.1: "Each unit has one exertion per turn: one attack or one position switch."
          cy.get(ts(cardId(defender))).should("have.attr", "data-position", "ATK");
          cy.switchPosition(defender);

          // "DEF card rotated": BUILD M5-T4's `positionSwitched` row is a 90° rotation, and the
          // client writes it inline so a test can read it off the style attribute.
          cy.get(ts(cardId(defender))).should("have.attr", "data-position", "DEF");
          cy.get(ts(cardId(defender))).should("have.attr", "style").and("contain", "rotate(90deg)");
          // §4.1: "Defense Position grants Taunt and Armor +1".
          cy.get(ts(cardId(defender))).find(keywordIs("Taunt")).should("exist");
          cy.get(ts(cardId(defender))).find(armorIs(1)).should("exist");

          advanceToTurn(4);
          selectAttacker(attacker);
          // The Taunt the position granted narrows the target set exactly as a printed one does.
          expectHighlight(cardId(defender), true, "the Defense Position unit taunts (§4.1, §4.2 step 3)");
          expectHighlight(cardId(timmy), false, "player 1's other unit is not a legal target");
          expectHighlight(heroId("opponent"), false, "player 1's hero is not a legal target while Taunt is up");

          // Combat A of the header: 3 − 1 Armor = 2 out, 3 back with no Armor in the way.
          cy.get(ts(cardId(defender))).click();
          cy.get(ts(cardId(defender))).find(DAMAGE_POP).should("have.text", "2");
          cy.get(ts(cardId(attacker))).find(DAMAGE_POP).should("have.text", "3");
          cy.settled();

          cy.get(ts(cardId(defender))).find(healthIs(1)).should("exist");
          cy.get(ts(cardId(defender))).find(maxHealthIs(3)).should("exist");
          cy.get(ts(cardId(defender))).should("have.attr", "data-position", "DEF");
          // The attacker took its own 3 and died at the state check (§4.5 step 1).
          cy.get(ts(cardId(attacker))).should("not.exist");
          cy.get(ts(graveyardCountId("you"))).should("have.text", "1");
        });
      });
    });
  });

  it("§4.3 / §4.4 — First Strike, Divine Shield and Lifesteal produce the pipeline's numbers", () => {
    cy.seedGame({ seed: SEED, a: "04-combat-a", b: "04-combat-b" });

    ensureSeat("p1");
    cy.playByName("Tempo Timmy", { zone: { side: "you", row: "units", lane: 1 } });
    advanceToTurn(3);
    cy.playByName("Pointmaster", { zone: { side: "you", row: "units", lane: 2 } });
    advanceToTurn(4);
    cy.playByName("Jilliax", { zone: { side: "you", row: "units", lane: 1 } });

    advanceToTurn(5);
    cy.instanceAt("p1", "units", 1).then((timmy) => {
      cy.instanceAt("p1", "units", 2).then((pointmaster) => {
        cy.instanceAt("p2", "units", 1).then((jilliax) => {
          cy.get(ts(cardId(timmy))).find(keywordIs("First Strike")).should("exist");
          cy.get(ts(cardId(jilliax))).find(keywordIs("Divine Shield")).should("exist");
          cy.get(ts(heroId("opponent"))).find(healthIs(30)).should("exist");

          // Combat B of the header. The shield shatter is the evidence the hit was negated whole:
          // there is no `damage` event for it, so there is no pop on Jilliax to wait for.
          selectAttacker(timmy);
          cy.get(ts(cardId(jilliax))).click();
          cy.expectAnimating("divineShieldLost");
          cy.get(ts(cardId(timmy))).find(DAMAGE_POP).should("have.text", "3");
          cy.get(ts(heroId("opponent"))).find(HEAL_POP).should("have.text", "3");
          cy.settled();

          // §4.4 step 1 negates the whole hit, so Jilliax is undamaged — and has no shield left.
          cy.get(ts(cardId(jilliax))).find(healthIs(2)).should("exist");
          cy.get(ts(cardId(jilliax))).find(maxHealthIs(2)).should("exist");
          cy.get(ts(cardId(jilliax))).find(keywordIs("Divine Shield")).should("not.exist");
          // Timmy took the full 3 back and died; Lifesteal healed its killer's hero by the 3 dealt.
          cy.get(ts(cardId(timmy))).should("not.exist");
          cy.get(ts(graveyardCountId("you"))).should("have.text", "1");
          cy.get(ts(heroId("opponent"))).find(healthIs(33)).should("exist");

          // Combat C of the header: 7 in step 1 kills, so nothing comes back.
          selectAttacker(pointmaster);
          cy.get(ts(cardId(jilliax))).click();
          cy.get(ts(cardId(jilliax))).find(DAMAGE_POP).should("have.text", "7");
          cy.settled();

          cy.get(ts(cardId(jilliax))).should("not.exist");
          cy.get(ts(graveyardCountId("opponent"))).should("have.text", "1");
          // "If D is destroyed here it deals nothing" (§4.3): Pointmaster is a 7/2 at full health.
          cy.get(ts(cardId(pointmaster))).find(attackIs(7)).should("exist");
          cy.get(ts(cardId(pointmaster))).find(healthIs(2)).should("exist");
          cy.get(ts(cardId(pointmaster))).find(DAMAGE_POP).should("not.exist");
          // The heal did not run twice: Jilliax dealt nothing in this combat.
          cy.get(ts(heroId("opponent"))).find(healthIs(33)).should("exist");
        });
      });
    });
  });
});
