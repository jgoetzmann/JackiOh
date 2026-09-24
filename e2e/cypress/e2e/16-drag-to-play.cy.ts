// Polish task 7, B40 (docs/polish/7-mobile-ux.md): drag to play in a seeded hotseat game.
//
//   - dragging a glowing hand card onto a glowing zone plays it;
//   - dragging a unit onto the enemy hero attacks;
//   - releasing outside the board cancels;
//   - after drag to play is turned off in the settings panel (still off after a reload),
//     click-click plays a card.
//
// The gesture is `support/ux.ts`'s: a real `PointerEvent` pointerdown on the source, pointermoves
// on `body` carrying `clientX`/`clientY` and `pointerId` 1, and a pointerup whose COORDINATES the
// client hit-tests. Every new testid and attribute comes from `support/ux.ts`, every existing one
// from `support/testids.ts`.
//
// The game is spec 04's: `04-combat-a` / `04-combat-b` with seed `04-combat-1604`, which that spec
// chose so #11 Tempo Timmy is in player 1's opening hand. Timmy costs 1, so it is playable on
// player-turn 1, and nothing in either deck acts on the board by itself (04-combat-a.json's
// description), so the numbers below come from SPEC and not from the screen:
//
//   §8 #11 Tempo Timmy is a 3/3 (Rush, First Strike). Played on player-turn 1, it may attack the
//   hero on player-turn 3 (Rush only lets it hit units on the turn it arrives, §6.1). Player 2's
//   hero starts at HERO_HEALTH (30, §2) and nothing has touched it, so one hit leaves it at 27.
//
// Setup that is not the behaviour under test (Timmy's play in the attack test) is done by
// click-click, which B39 says keeps working with drag to play on.

import { constants, seedFor } from "../../support/config.ts";
import { BOARD, attackIs, cardId, handCardId, healthIs, heroId, ts, zoneId } from "../../support/testids.ts";
import type { PlayerId } from "../../support/types.ts";
import {
  DRAGGING_ATTR,
  DRAG_ARROW,
  DRAG_ATTR,
  DRAG_FROM_ATTR,
  DRAG_GHOST,
  DRAG_INSTANCE_ATTR,
  DRAG_KIND_ATTR,
  DRAG_LAYER,
  DRAG_RETICLE,
  DRAG_TARGET_ATTR,
  DRAG_VALID_ATTR,
  GLOW_ATTR,
  GLOW_READY,
  ROOT,
  SETTINGS_CLOSE,
  SETTINGS_OPEN_GAME,
  SETTINGS_PANEL,
  dragTo,
  hoverOver,
  pressAndLift,
  releaseOver,
  settingId,
} from "../../support/ux.ts";

const SEED = seedFor("04-combat-1604");
const DECK_A = "04-combat-a";
const DECK_B = "04-combat-b";

/** §8 #11: in player 1's opening hand under this seed (see spec 04's header). */
const TIMMY = "Tempo Timmy";
const TIMMY_ATTACK = 3;

/** An empty zone Timmy may be played into on player-turn 1: the whole units row is empty. */
const LANE_1 = zoneId("you", "units", 1);
const LANE_1_REF = { side: "you", row: "units", lane: 1 } as const;

const OPPONENT_HERO = heroId("opponent");

/** BUILD M5-T3: a hotseat device is handed over, so put it on the seat that has to act. */
function ensureSeat(player: PlayerId): void {
  cy.jackioh().then((handle) => {
    expect(handle.seat, "window.__jackioh.seat (the hotseat handle names the seat holding it)").to.not.eq(
      undefined,
    );
    if (handle.seat !== player) cy.handOver();
  });
}

function startGame(): void {
  cy.seedGame({ seed: SEED, a: DECK_A, b: DECK_B });
  ensureSeat("p1");
}

/** No overlay and no `data-dragging`: nothing is being dragged. */
function expectNoDrag(): void {
  cy.get(ts(DRAG_LAYER)).should("not.exist");
  cy.get(ROOT).should("not.have.attr", DRAGGING_ATTR);
}

describe("Polish 7 B40 — drag to play in a seeded hotseat game", () => {
  it("B40 dragging a glowing hand card onto a glowing zone plays it", () => {
    startGame();

    cy.handCardByName(TIMMY).then((timmy) => {
      const source = ts(handCardId(timmy));
      cy.get(source).should("have.attr", GLOW_ATTR, GLOW_READY);

      pressAndLift(source);
      cy.get(ts(DRAG_LAYER)).should("have.attr", DRAG_KIND_ATTR, "play");
      cy.get(ts(DRAG_GHOST)).should("have.attr", DRAG_INSTANCE_ATTR, timmy);
      cy.get(ROOT).should("have.attr", DRAGGING_ATTR, "play");
      cy.get(ts(LANE_1)).should("have.attr", GLOW_ATTR, GLOW_READY);

      hoverOver(ts(LANE_1));
      cy.get(ts(DRAG_RETICLE)).should("have.attr", DRAG_TARGET_ATTR, LANE_1);

      releaseOver(ts(LANE_1));
      cy.settled();

      expectNoDrag();
      cy.get(source).should("not.exist");
      cy.get(ts(LANE_1)).should("contain.text", TIMMY);
      cy.instanceAt("p1", "units", 1).then((placed) => {
        cy.get(ts(LANE_1)).find(ts(cardId(placed))).should("exist");
      });
    });
  });

  it("B40 dragging a unit onto the enemy hero attacks", () => {
    startGame();
    cy.playByName(TIMMY, { zone: LANE_1_REF });
    cy.advanceToTurn(3);
    ensureSeat("p1");

    cy.instanceAt("p1", "units", 1).then((timmy) => {
      const source = ts(cardId(timmy));
      const hero = ts(OPPONENT_HERO);
      cy.get(source).should("have.attr", GLOW_ATTR, GLOW_READY).find(attackIs(TIMMY_ATTACK)).should("exist");
      cy.get(hero).find(healthIs(constants.HERO_HEALTH)).should("exist");

      pressAndLift(source);
      cy.get(ts(DRAG_LAYER)).should("have.attr", DRAG_KIND_ATTR, "attack");
      cy.get(ts(DRAG_ARROW)).should("have.attr", DRAG_FROM_ATTR, cardId(timmy));
      cy.get(ROOT).should("have.attr", DRAGGING_ATTR, "attack");
      cy.get(hero).should("have.attr", GLOW_ATTR, GLOW_READY);

      hoverOver(hero);
      cy.get(ts(DRAG_RETICLE)).should("have.attr", DRAG_TARGET_ATTR, OPPONENT_HERO);
      cy.get(ts(DRAG_ARROW)).should("have.attr", DRAG_VALID_ATTR, "true");

      releaseOver(hero);
      cy.settled();

      expectNoDrag();
      cy.get(hero).find(healthIs(constants.HERO_HEALTH - TIMMY_ATTACK)).should("exist");
    });
  });

  it("B40 releasing a lifted card outside the board cancels it", () => {
    startGame();

    cy.handCardByName(TIMMY).then((timmy) => {
      const source = ts(handCardId(timmy));

      pressAndLift(source);
      cy.get(ts(DRAG_LAYER)).should("exist");
      cy.get(ts(LANE_1)).should("have.attr", GLOW_ATTR, GLOW_READY);

      hoverOver("outside");
      cy.get(ts(DRAG_RETICLE)).should("not.exist");

      releaseOver("outside");
      cy.settled();

      expectNoDrag();
      // Nothing was sent: Timmy is still in hand, unselected, and the units row is still empty.
      cy.get(source).should("exist").and("not.have.attr", "data-selected");
      cy.get(ts(LANE_1)).should("not.have.attr", GLOW_ATTR);
      cy.unitIds("p1").should("have.length", 0);
    });
  });

  it("B40 with drag to play turned off in the settings panel, still off after a reload, click-click plays a card", () => {
    startGame();
    cy.get(ts(BOARD)).should("have.attr", DRAG_ATTR, "on");

    // Turn it off in the panel.
    cy.get(ts(SETTINGS_OPEN_GAME)).click();
    cy.get(ts(SETTINGS_PANEL)).should("be.visible");
    cy.get(ts(settingId("dragToPlay"))).should("be.checked").uncheck({ force: true });
    cy.get(ts(settingId("dragToPlay"))).should("not.be.checked");
    cy.get(ts(SETTINGS_CLOSE)).click();
    cy.get(ts(SETTINGS_PANEL)).should("not.exist");
    cy.get(ts(BOARD)).should("have.attr", DRAG_ATTR, "off");

    // A reload restarts the hotseat game from the same seed and decks, and keeps the setting.
    cy.reload();
    cy.jackioh().should((handle) => {
      expect(handle.seed, "the same seed after the reload").to.eq(SEED);
    });
    cy.settled();
    cy.keepMulligans();
    ensureSeat("p1");

    cy.get(ts(BOARD)).should("have.attr", DRAG_ATTR, "off");
    cy.get(ts(SETTINGS_OPEN_GAME)).click();
    cy.get(ts(settingId("dragToPlay"))).should("not.be.checked");
    cy.get(ts(SETTINGS_CLOSE)).click();
    cy.get(ts(SETTINGS_PANEL)).should("not.exist");

    cy.handCardByName(TIMMY).then((timmy) => {
      const source = ts(handCardId(timmy));

      // With the setting off a drag starts nothing, and releasing on a zone sends nothing.
      pressAndLift(source);
      expectNoDrag();
      hoverOver(ts(LANE_1));
      // Asked again after more travel: an overlay that rendered late would be caught here.
      expectNoDrag();
      cy.get(ts(LANE_1)).should("not.have.attr", GLOW_ATTR);
      cy.get(ts(DRAG_RETICLE)).should("not.exist");
      releaseOver(ts(LANE_1));
      cy.settled();
      expectNoDrag();
      cy.get(source).should("exist");
      cy.unitIds("p1").should("have.length", 0);

      // Click-click still plays it.
      cy.playCard(timmy, { zone: LANE_1_REF });
      cy.get(source).should("not.exist");
      cy.get(ts(LANE_1)).should("contain.text", TIMMY);
    });
  });

  it("B40 the whole drag in one call, dragTo, plays a card and a drag cancelled outside leaves it in hand", () => {
    startGame();

    cy.handCardByName(TIMMY).then((timmy) => {
      const source = ts(handCardId(timmy));

      dragTo(source, "outside");
      expectNoDrag();
      cy.get(source).should("exist");
      cy.unitIds("p1").should("have.length", 0);

      dragTo(source, ts(LANE_1));
      expectNoDrag();
      cy.get(source).should("not.exist");
      cy.get(ts(LANE_1)).should("contain.text", TIMMY);
    });
  });
});
