// BUILD M8 `07-my-pawn-ai.cy.ts` — "P2 has My Pawn; P1 declares lethal".
//
// Key assertions (BUILD M8's table, verbatim):
//
//   "attack cancelled; P1's controls disabled; AI actions animate; turn ends"
//
// #96 My Pawn (§8.5): "When the opponent declares an attack that would be lethal to your hero:
// cancel it, and an AI plays the rest of their turn with random legal actions". The AI policy of
// §10.7 runs inside `reduce`, so this whole spec is local: no server, no `cy.task`, just the
// hotseat route (e2e/README.md's "Which spec needs which milestone" row for 07).
//
// Four rulings shape what is asserted here:
//
//   R44  Lethal is the PROJECTION of this one attack: "projected damage to the hero after Armor
//        and the cap … >= health". 07-my-pawn-b carries no hero Armor (#84, #1) and no
//        Anti-oneshot Armor (#73), so the projection is the attacker's printed attack and the
//        threshold is exact arithmetic rather than a guess. R44 also fixes what the cancel costs:
//        "the exertion is not given back, so the attack is gone either way".
//   R99  The trap's condition lives in its trigger's `when` predicate, not in its effect list,
//        precisely so that an event it should ignore does not spend it: "a trap whose condition
//        simply was not met cannot say so through `run` and would be spent by an event it should
//        ignore". So every swing before the lethal one has to leave the trap armed and face-down,
//        and this spec asserts that after each of them — it is the assertion that would catch a
//        My Pawn implemented with an empty `run` instead of a predicate.
//   R121 A forced attack "is declared by the effect, not the player": it skips declaration steps
//        1 to 3, spends no exertion, and may happen on the compelling player's own turn, so it is
//        never "the opponent declaring an attack" and never arms this trap. That is why BUILD's
//        row says "an AI plays the rest of their turn" and names nobody: the AI drives the
//        DECLARER's turn (`aiTurn` on their `PlayerState`, §8.5), and the declaration that is
//        cancelled is a player's own, not a forced one. 07-lethal-a therefore holds no forced
//        attacker (#9, #60 excluded) and this spec declares its attacks by hand.
//   R33   Only the current controller sees a face-down trap's identity, so from seat 1's side the
//        trap has no `card-<instanceId>` element at all until it fires (§10.8, and `Backrow.tsx`
//        renders a `{ faceDown: true }` entry as a back with no testid).
//
// House rules (BUILD M8): the seed is set here and overridable with `--expose seed=…`; there is
// no fixed `cy.wait(ms)` — every wait is `cy.settled()`, `cy.expectAnimating` or a retried
// assertion; every selector comes from `e2e/support/testids.ts`.
//
// Both blockers this header used to name are now CLOSED, and the note is kept rather than deleted
// because a stale "blocked" claim is worse than none — it invites a reader to write off a real
// failure as known. If this spec fails now, it is a finding:
//   * `apps/web` registers the catalog: it depends on `@jackioh/cards` and calls `registerAll()` in
//     its composition root, so `registeredCatalog()` is populated and `/dev/hotseat` resolves a
//     fixture deck. The "not in the catalog (§9.4 L6)" symptom is gone.
//   * #96 My Pawn has a real body — `cancelAttack()` and `aiPlaysOutTurn()` — because `GameState`
//     now carries `declaredAttack` and §4.2 step 4's trap window exists between the declaration and
//     the damage of step 5 (audit finding B-1). So the lethal half of this spec should now pass
//     too, not just the non-lethal half.
//
// One deliberate deviation from the support API, marked again at the line: the lethal declaration
// is two board clicks written out instead of `cy.attack`, because `cy.attack` ends with
// `cy.settled()` and BUILD's "AI actions animate" has to be read while the queue is still
// draining. Both clicks use `ts`/`cardId`/`heroId` from the support map; no raw selector.

import { CARD_NAMES, cardId as catalogId } from "../../support/cards.ts";
import { seedFor, timeouts } from "../../support/config.ts";
import {
  ANIMATING,
  END_TURN,
  ILLEGAL,
  OFFER_DRAW,
  animating,
  cardId,
  handCardId,
  heroId,
  ts,
} from "../../support/testids.ts";
import type { GameStateLike, Lane, PlayerId } from "../../support/types.ts";

/** Every spec sets a seed (BUILD M8); `--expose seed=…` overrides it. */
const SEED = seedFor("07-my-pawn");

/** Budgets: R2 caps the game at 30 player-turns, so nothing here may loop forever. */
const TURN_BUDGET = 34;
const SWING_BUDGET = 8;

const TRAP_LANE: Lane = 3;
const GRINDER_LANE: Lane = 1;

/**
 * The three units 07-lethal-a offers as the single attacker ("Three cards are the grinders, and
 * the spec plays exactly one of them"), with the printed attack SPEC §8 gives each and the cost
 * it has to be able to pay. The attack is written down rather than read off the board because
 * `support/testids.ts` has no stat selector (reported) — and it is the printed number in play
 * here: 07-lethal-a carries no attack aura (#14 excluded) and no buff, and nothing but this spec
 * plays a card before the declaration, so layer 1 of §10.4 is the whole computation.
 */
const GRINDERS: readonly { defId: string; name: string; attack: number; cost: number }[] = [
  { defId: catalogId(19), name: nameOf(19), attack: 9, cost: 3 },
  { defId: catalogId(20), name: nameOf(20), attack: 7, cost: 2 },
  { defId: catalogId(25), name: nameOf(25), attack: 7, cost: 4 },
];

/** SPEC §8's name for card #index, which is what the client prints on a card (BUILD M5-T1). */
function nameOf(index: number): string {
  const name = CARD_NAMES[index];
  if (name === undefined) throw new Error(`no SPEC §8 card #${index}`);
  return name;
}

/**
 * The parts of a `PlayerState` this spec reads off `window.__jackioh.state`, with the same cast
 * `support/commands.ts` uses in `instanceInHand` / `instanceAt`. It answers "what may I click"
 * and "what did the engine do to the hero and the backrow"; every assertion about what the PLAYER
 * can see reads the DOM, which is `viewFor` (CLAUDE.md rule 7).
 */
type SidePeek = {
  hero?: { health: number };
  mana?: { current: number };
  hand?: { id: string; defId: string }[];
  units?: ({ id: string; summonedTurn?: number; exertion?: { attacked: boolean } }[] | null)[];
  backrow?: ({ id: string } | null)[];
  graveyard?: { defId: string }[];
};

function peek(state: GameStateLike, player: PlayerId): SidePeek {
  return state.players[player] as SidePeek;
}

function heroHealth(state: GameStateLike, player: PlayerId): number {
  const health = peek(state, player).hero?.health;
  expect(health, `${player}'s hero health`).to.be.a("number");
  return health ?? 0;
}

function handOf(state: GameStateLike, player: PlayerId): { id: string; defId: string }[] {
  return peek(state, player).hand ?? [];
}

/** §3.2: only the top card of a unit pile is active, so that is the one this spec ever clicks. */
function unitAt(state: GameStateLike, player: PlayerId, lane: Lane) {
  return (peek(state, player).units ?? [])[lane - 1]?.[0];
}

/** BUILD M5-T3: a hotseat device is handed over, so make sure it is on the seat that has to act. */
function ensureSeat(player: PlayerId): void {
  cy.jackioh().then((handle) => {
    expect(handle.seat, "window.__jackioh.seat names the seat holding the device").to.not.eq(undefined);
    if (handle.seat !== player) cy.handOver();
  });
}

/**
 * End the active player's turn and hand the device on. The active player always has `endTurn`
 * among its legal actions — R82 means no state where it does not can persist, because the engine
 * ends such a turn itself — so `end-turn` is live here and a disabled one is a real failure.
 */
function passTurn(): void {
  cy.gameState().then((state) => {
    if (state.result !== null) return;
    ensureSeat(state.active);
    cy.endTurn();
  });
}

/** Take turns until `ready` holds, then leave the device on the seat that has to act. */
function advanceUntil(label: string, ready: (state: GameStateLike) => boolean): void {
  const step = (left: number): void => {
    cy.gameState().then((state) => {
      expect(state.result, `${label}: the game ended first`).to.eq(null);
      if (ready(state)) return;
      expect(left, `${label}: not reached inside ${TURN_BUDGET} player-turns`).to.be.greaterThan(0);
      passTurn();
      step(left - 1);
    });
  };
  step(TURN_BUDGET);
}

describe("BUILD M8 07 — My Pawn cancels the lethal swing and an AI plays out the rest of the turn", () => {
  beforeEach(() => {
    cy.seedGame({ seed: SEED, a: "07-lethal-a", b: "07-my-pawn-b" });
  });

  it("R99/R44 cancels the attack, locks P1 out, animates the AI turn and ends it", () => {
    // ---------------------------------------------------------------------------------------
    // 1. Seat 2 sets My Pawn, face-down, on the first of its turns that it holds it.
    // ---------------------------------------------------------------------------------------
    const myPawn = catalogId(96);
    advanceUntil(
      "p2 holds My Pawn on its own turn",
      (state) => state.active === "p2" && handOf(state, "p2").some((card) => card.defId === myPawn),
    );
    ensureSeat("p2");
    cy.playByName(nameOf(96), { zone: { side: "you", row: "backrow", lane: TRAP_LANE } });

    // The trap is in the zone the play named, and §10.8 / R33 keep its identity off seat 1's
    // screen: `Backrow.tsx` gives a face-down entry no instance id, so there is no card element
    // to find. Captured here because seat 1 can never learn it from the DOM.
    cy.instanceAt("p2", "backrow", TRAP_LANE).then((trapId) => {
      // -------------------------------------------------------------------------------------
      // 2. Seat 1 summons one grinder — whichever of the three it holds first (07-lethal-a).
      // -------------------------------------------------------------------------------------
      advanceUntil("p1 can summon a grinder", (state) => {
        if (state.active !== "p1") return false;
        const mana = peek(state, "p1").mana?.current ?? 0;
        return handOf(state, "p1").some((card) =>
          GRINDERS.some((g) => g.defId === card.defId && g.cost <= mana),
        );
      });
      ensureSeat("p1");

      cy.gameState().then((state) => {
        const mana = peek(state, "p1").mana?.current ?? 0;
        const grinder = GRINDERS.find(
          (g) => g.cost <= mana && handOf(state, "p1").some((card) => card.defId === g.defId),
        );
        expect(grinder, "one of 07-lethal-a's three grinders is in hand and affordable").to.not.eq(
          undefined,
        );
        if (grinder === undefined) return;

        cy.playByName(grinder.name, { zone: { side: "you", row: "units", lane: GRINDER_LANE } });

        cy.instanceAt("p1", "units", GRINDER_LANE).then((attackerId) => {
          // ---------------------------------------------------------------------------------
          // 3. Grind the hero down. Every one of these declarations is BELOW the projection R44
          //    measures, so R99's `when` predicate must refuse them and the trap must survive.
          //    07-my-pawn-b never summons, so the hero is the only legal target (§4.2 step 3).
          // ---------------------------------------------------------------------------------
          const swing = (left: number): void => {
            cy.gameState().then((state2) => {
              expect(state2.result, "the grind did not end the game").to.eq(null);
              if (heroHealth(state2, "p2") <= grinder.attack) return; // the next one is lethal
              expect(left, "the hero came into lethal range inside the swing budget").to.be.greaterThan(0);

              advanceUntil("p1 can swing again", (s) => {
                if (s.active !== "p1") return false;
                const unit = unitAt(s, "p1", GRINDER_LANE);
                // §4.1: summoning sickness on the turn it entered, one exertion per turn after.
                return unit !== undefined && unit.summonedTurn !== s.turn && unit.exertion?.attacked !== true;
              });
              ensureSeat("p1");

              cy.gameState().then((atSwing) => {
                const before = heroHealth(atSwing, "p2");
                cy.attack(attackerId, { hero: "opponent" });

                cy.gameState().then((after) => {
                  // The swing landed in full: not cancelled, so no cap and no Armor took anything
                  // off it (R44's projection is the same arithmetic).
                  expect(heroHealth(after, "p2"), "a non-lethal swing deals its full attack").to.eq(
                    before - grinder.attack,
                  );
                  // R99: the condition was not met, so the trap was NOT spent by the event.
                  expect(
                    (peek(after, "p2").backrow ?? [])[TRAP_LANE - 1]?.id,
                    "R99: a non-lethal declaration leaves My Pawn armed in its zone",
                  ).to.eq(trapId);
                  expect(
                    (peek(after, "p2").graveyard ?? []).some((card) => card.defId === myPawn),
                    "R99: a non-lethal declaration does not send My Pawn to the graveyard",
                  ).to.eq(false);
                });
                // R33 from the other side of the table: still face-down, still nameless to seat 1.
                cy.get(ts(cardId(trapId))).should("not.exist");

                swing(left - 1);
              });
            });
          };
          swing(SWING_BUDGET);

          // ---------------------------------------------------------------------------------
          // 4. The lethal declaration. R44: the projection now reaches the hero, so the trap
          //    fires in the §4.2 step 4 window, after the exertion has already been spent.
          // ---------------------------------------------------------------------------------
          advanceUntil("p1 can declare the lethal swing", (s) => {
            if (s.active !== "p1") return false;
            const unit = unitAt(s, "p1", GRINDER_LANE);
            return unit !== undefined && unit.summonedTurn !== s.turn && unit.exertion?.attacked !== true;
          });
          ensureSeat("p1");

          cy.gameState().then((before) => {
            const health = heroHealth(before, "p2");
            expect(health, "R44: the projected damage now reaches the hero").to.be.at.most(grinder.attack);
            const turn = before.turn;

            // Written out rather than `cy.attack(...)`: that command settles, and the assertions
            // below have to be made while the animation queue is still draining. Same two clicks,
            // same support selectors (§4.2 steps 1-2: choose an attacker, choose a target).
            cy.get(ts(cardId(attackerId))).click();
            cy.get(ts(heroId("opponent"))).click();

            // "attack cancelled" — BUILD M5-T4's `attackCancelled` row animates the attacker
            // ("Attacker snaps back with a Cancelled tag"), which is seat 1's own card and so is
            // on screen. `trapFired` is deliberately not awaited: it targets the trap's card
            // element, which does not exist on the declarer's screen while the trap is face-down
            // (see the report note on `backrow-<side>`).
            cy.expectAnimating("attackCancelled");

            // "AI actions animate; turn ends" — the AI turn is played inside the same `reduce`,
            // so the browser never renders it as state; the animation queue replays it, and the
            // client is still draining that queue here. The one action §10.7's policy is certain
            // to take is the end of the turn, and BUILD M5-T4 animates it on the `end-turn`
            // control, so that is the row awaited. `cy.expectAnimating` is not used for it
            // because its `timeouts.animation` budget is one animation's worth and a whole AI
            // turn's queue can be longer than that; `timeouts.view` is the honest budget.
            cy.get(ANIMATING).should("exist");
            cy.get(animating("turnEnded"), { timeout: timeouts.view }).should("exist");
            cy.settled();

            // "P1's controls disabled": from the cancel until the device is handed over, seat 1
            // has no legal action at all — first because §8.5 puts `aiTurn` on their
            // `PlayerState`, then because the turn belongs to seat 2. The client takes every
            // `data-legal` from `legalActions` (BUILD M5-T2), so this is the engine's answer.
            cy.get(ts(END_TURN)).should("be.disabled");
            cy.get(ts(OFFER_DRAW)).should("be.disabled");
            cy.gameState().then((after) => {
              const held = handOf(after, "p1")[0];
              expect(held, "seat 1 still holds cards it cannot play").to.not.eq(undefined);
              if (held !== undefined) {
                cy.get(`${ts(handCardId(held.id))}${ILLEGAL}`).should("exist");
              }
            });

            cy.gameState().should((after) => {
              // "attack cancelled", the state half: the hit never happened.
              expect(heroHealth(after, "p2"), "the cancelled attack dealt no damage").to.eq(health);
              expect(after.result, "the cancelled swing did not end the game").to.eq(null);
              // The trap is spent: a Trap goes to its owner's graveyard after firing (§5.1).
              expect(
                (peek(after, "p2").backrow ?? [])[TRAP_LANE - 1],
                "My Pawn left the backrow when it fired",
              ).to.eq(null);
              expect(
                (peek(after, "p2").graveyard ?? []).some((card) => card.defId === myPawn),
                "My Pawn is in its owner's graveyard (§5.1: a Trap goes there after it fires)",
              ).to.eq(true);
              // "turn ends": the AI played the rest of seat 1's turn and ended it.
              expect(after.turn, "the player-turn advanced").to.be.greaterThan(turn);
              expect(after.active, "the turn ended and seat 2 is to act").to.eq("p2");
            });
          });
        });
      });
    });
  });
});
