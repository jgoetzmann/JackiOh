// BUILD M8 `11-radiant.cy.ts` — "Glowy Jelly Bean on a hand card, Knockoff Temu on a field unit".
//
// Key assertions (BUILD M8's table, verbatim):
//
//   "glow animation; stats swap on the field card keeping damage"
//
// The second half is the whole point. §10.4 layer 1 is "printed stats of the base or radiant form
// (per `radiant`)" and damage is layer 6's subtrahend, not part of the printed face, so §5.2's
// on-field rule — "the base-stat layer swaps immediately, damage taken and buffs are kept" — must
// hold through the flip: a 3/3 Mr. Vanilla carrying 1 damage reads 2/3, and the same instance as a
// 7/7 must read 6/7 and not 7/7. A client (or an engine) that rebuilt the instance on the flip
// would show 7/7 and pass every other assertion in this file.
//
// Why the deck is built the way it is (11-radiant-a's description has the full version): #28
// Knockoff Temu Glowy Jelly Bean picks "2 random cards among your library, hand and field",
// uniformly over the union's NON-RADIANT cards (R60), so a spec can only name the card it
// converts by leaving one candidate. #94 Genn's Greed does that in one play — it draws the deck's
// only 2-cost card (Knockoff Temu itself) and exiles every odd-cost card from the library and the
// hand, and every other card in 11-radiant-a costs 1 or 3 — after which the library is empty, the
// hand holds nothing but the Knockoff Temu about to be cast, and the damaged unit on the field is
// the union's last non-Radiant card. The spec asserts that precondition before it casts, so a
// deck or an engine change that breaks it fails here with a readable message instead of quietly
// turning the conversion into a coin flip.
//
// House rules (BUILD M8): the seed is set here and overridable with `--expose seed=…`; there is
// no fixed `cy.wait(ms)` — every wait is `cy.settled()`, `cy.expectAnimating` or a retried
// assertion; every selector comes from `e2e/support/testids.ts`.
//
// The catalog blocker this header used to name is CLOSED. The note is kept rather than deleted
// because a stale "blocked" claim is worse than none — it invites a reader to write off a real
// failure as known. `apps/web` now depends on `@jackioh/cards` and calls `registerAll()` in its
// composition root, so `registeredCatalog()` is populated, `/dev/hotseat` resolves a fixture deck
// and `window.__jackioh` is exposed. If this spec fails in `cy.seedGame` now, it is a finding.
//     hotseat spec fails in `cy.seedGame` until that is fixed.
//   * `packages/cards/src/scripts/094-genns-greed.ts` is down to its `gainMana` clause: neither
//     of the two verbs its other two clauses need ("draw every 2-cost card", "exile every
//     odd-cost card") is in `packages/engine/src/effects` yet. #26's `setRadiant` and #28's
//     `setRadiantRandom` both exist, so the Glowy Jelly Bean half of this spec should pass and
//     the precondition assertion in step 3 should be the first thing to fail — which is the
//     point of asserting it rather than casting into a board the engine did not clear.
//
// Two things this file cannot do with today's support API, both reported rather than worked
// around:
//   * the shown stats are read with `contain.text` on the card element, because
//     `support/testids.ts` has no stat selector. The numbers are the view's (BUILD M5-T4's
//     `buffed` row: "shown stats equal the view"), but the assertion is on rendered text and a
//     reformat of `{health}/{maxHealth}` would break it. `STAT_ATTACK` / `STAT_HEALTH` in the
//     support map would fix it.
//   * `cy.playByName` ends with `cy.settled()`, so the `data-animating="radiantSet"` window is
//     gone by the time a spec could look. It is awaited live for the one play that needs no
//     picker (Knockoff Temu) by writing that play's single click out, and asserted for the other
//     through BUILD M5-T4's own `radiantSet` acceptance — "card has class `radiant` afterwards".

import { CARDS, CARD_NAMES, cardId as catalogId } from "../../support/cards.ts";
import { seedFor } from "../../support/config.ts";
import { RADIANT, cardId, handCardId, ts } from "../../support/testids.ts";
import type { GameStateLike, Lane, PlayerId } from "../../support/types.ts";

/** Every spec sets a seed (BUILD M8); `--expose seed=…` overrides it. */
const SEED = seedFor("11-radiant");

const TURN_BUDGET = 34;
const UNIT_LANE: Lane = 1;

const GENNS_GREED = catalogId(94);
const MATH_EQUATION = catalogId(31);

/** SPEC §8 #8 Mr. Vanilla: "1 | Unit, Human | 3/3 → 7/7 | Immutable". */
const VANILLA = { attack: 3, health: 3 } as const;
const VANILLA_RADIANT = { attack: 7, health: 7 } as const;
/** SPEC §8 #31 at its printed cost of 1: Fib(cost + 1) = Fib(2) = 1 (R25's table). */
const MATH_DAMAGE = 1;

/** Costs come from SPEC §8; §2.3 caps max mana at 4, so each of these waits for its own turn. */
const COSTS: Record<string, number> = {
  [CARDS.mrVanilla]: 1,
  [CARDS.glowyJellyBean]: 3,
  [CARDS.knockoffTemu]: 2,
  [GENNS_GREED]: 4,
  [MATH_EQUATION]: 1,
};

/** SPEC §8's name for card #index, which is what the client prints on a card (BUILD M5-T1). */
function nameOf(index: number): string {
  const name = CARD_NAMES[index];
  if (name === undefined) throw new Error(`no SPEC §8 card #${index}`);
  return name;
}

/**
 * The parts of a `PlayerState` this spec reads off `window.__jackioh.state`, with the same cast
 * `support/commands.ts` uses in `instanceInHand` / `instanceAt`. It answers "what may I click"
 * and "what does the engine say the instance is carrying"; what the PLAYER can see is asserted
 * against the DOM, which is `viewFor` (CLAUDE.md rule 7).
 */
type Held = { id: string; defId: string; radiant?: boolean };
type FieldUnit = Held & { damage?: number; buffs?: { attack: number; health: number } };
type SidePeek = {
  mana?: { current: number };
  hand?: Held[];
  library?: Held[];
  units?: (FieldUnit[] | null)[];
  backrow?: (Held | null)[];
};

function peek(state: GameStateLike, player: PlayerId): SidePeek {
  return state.players[player] as SidePeek;
}

function handOf(state: GameStateLike, player: PlayerId): Held[] {
  return peek(state, player).hand ?? [];
}

/** §3.2: only the top card of a unit pile is active. */
function unitsOf(state: GameStateLike, player: PlayerId): FieldUnit[] {
  return (peek(state, player).units ?? []).flatMap((pile) => {
    const top = pile === null ? undefined : pile[0];
    return top === undefined ? [] : [top];
  });
}

function unitById(state: GameStateLike, player: PlayerId, instanceId: string): FieldUnit {
  const unit = unitsOf(state, player).find((candidate) => candidate.id === instanceId);
  expect(unit, `${instanceId} is on ${player}'s field`).to.not.eq(undefined);
  return unit ?? { id: instanceId, defId: "" };
}

/** BUILD M5-T3: a hotseat device is handed over, so make sure it is on the seat that has to act. */
function ensureSeat(player: PlayerId): void {
  cy.jackioh().then((handle) => {
    expect(handle.seat, "window.__jackioh.seat names the seat holding the device").to.not.eq(undefined);
    if (handle.seat !== player) cy.handOver();
  });
}

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

/** Wait for `player` to hold `defId` on their own turn with the mana SPEC §8 prices it at. */
function waitToPlay(player: PlayerId, defId: string): void {
  const cost = COSTS[defId] ?? 0;
  advanceUntil(`${player} can pay ${cost} for ${defId}`, (state) => {
    if (state.active !== player) return false;
    if ((peek(state, player).mana?.current ?? 0) < cost) return false;
    return handOf(state, player).some((card) => card.defId === defId);
  });
  ensureSeat(player);
}

/**
 * The shown stats of a field card. `contain.text` on the card element because the support map has
 * no stat selector (see the header): the client renders `{health}/{maxHealth}` inside the card, so
 * "6/7" on a 7/7 body is "one point of damage is still there".
 */
function expectShownHealth(instanceId: string, health: number, maxHealth: number): void {
  cy.get(ts(cardId(instanceId))).should("contain.text", `${health}/${maxHealth}`);
}

describe("BUILD M8 11 — Glowy Jelly Bean on a hand card, Knockoff Temu on a damaged field unit", () => {
  beforeEach(() => {
    cy.seedGame({ seed: SEED, a: "11-radiant-a", b: "11-radiant-b" });
  });

  it("§5.2 flips a hand card and a damaged field unit, keeping the damage on the field card", () => {
    // ---------------------------------------------------------------------------------------
    // 1. Seat 1 puts Mr. Vanilla on the field; seat 2 puts one point of damage on it.
    // ---------------------------------------------------------------------------------------
    waitToPlay("p1", CARDS.mrVanilla);
    cy.playByName(nameOf(8), { zone: { side: "you", row: "units", lane: UNIT_LANE } });

    cy.instanceAt("p1", "units", UNIT_LANE).then((vanillaId) => {
      cy.get(`${ts(cardId(vanillaId))}${RADIANT}`).should("not.exist");
      expectShownHealth(vanillaId, VANILLA.health, VANILLA.health);

      waitToPlay("p2", MATH_EQUATION);
      // R81: #31's target travels in the play action, and the client builds it with its `target`
      // picker. `cy.answerPrompt` resolves the pick against the modal first and the board second.
      cy.playByName(nameOf(31), { answers: [{ kind: "target", cards: [vanillaId] }] });

      cy.gameState().then((damaged) => {
        expect(unitById(damaged, "p1", vanillaId).damage, "§4.4: the spell dealt Fib(2) = 1").to.eq(
          MATH_DAMAGE,
        );
      });
      // §4.1: current health = max health − damage, and damage stays on a unit between turns.
      ensureSeat("p1");
      expectShownHealth(vanillaId, VANILLA.health - MATH_DAMAGE, VANILLA.health);

      // -------------------------------------------------------------------------------------
      // 2. "Glowy Jelly Bean on a hand card": #26 (3) makes one card in the hand Radiant. R81
      //    calls the pick a declared `hand` choice; it travels in the play action's `targets`,
      //    so the client renders it with its `target` picker and never pauses resolution.
      // -------------------------------------------------------------------------------------
      waitToPlay("p1", CARDS.glowyJellyBean);
      cy.gameState().then((state) => {
        // Any hand card but the four this spec is steering. Radiant #94 gains 6 mana instead of 2
        // and radiant #28 picks 5 cards instead of 2, and a Radiant Mr. Vanilla would be 7/7
        // before it was ever damaged — none of which is what is under test here.
        const steered = [CARDS.mrVanilla, CARDS.glowyJellyBean, CARDS.knockoffTemu, GENNS_GREED];
        const target = handOf(state, "p1").find((card) => !steered.includes(card.defId));
        expect(target, "seat 1 holds a card for Glowy Jelly Bean to convert").to.not.eq(undefined);
        if (target === undefined) return;

        cy.get(`${ts(handCardId(target.id))}${RADIANT}`).should("not.exist");
        // By def id rather than `cy.playByName`: three §8 names end in "Glowy Jelly Bean" (#26,
        // #27, #28) and #28 is in this hand, so a name match is ambiguous here.
        cy.instanceInHand("p1", CARDS.glowyJellyBean).then((beanId) => {
          cy.playCard(beanId, { answers: [{ kind: "target", cards: [target.id] }] });
        });

        // "glow animation", through BUILD M5-T4's own `radiantSet` acceptance: "card has class
        // `radiant` afterwards". §5.2 in hand: "cost unchanged, stats and text swap".
        cy.get(`${ts(handCardId(target.id))}${RADIANT}`).should("exist");
        cy.gameState().then((after) => {
          const held = handOf(after, "p1").find((card) => card.id === target.id);
          expect(held?.radiant, "§5.2: Radiant is a flag on the instance").to.eq(true);
        });
      });

      // -------------------------------------------------------------------------------------
      // 3. Genn's Greed empties the library and the hand, leaving Knockoff Temu one candidate.
      // -------------------------------------------------------------------------------------
      waitToPlay("p1", GENNS_GREED);
      cy.playByName(nameOf(94));

      cy.gameState().then((state) => {
        const side = peek(state, "p1");
        expect(side.library ?? [], "#94 exiled the last of the library (every other card is odd-cost)")
          .to.have.length(0);
        expect(
          handOf(state, "p1").map((card) => card.defId),
          "#94 drew the deck's only 2-cost card and exiled the rest of the hand",
        ).to.deep.eq([CARDS.knockoffTemu]);
        expect(
          unitsOf(state, "p1").map((unit) => unit.id),
          "Mr. Vanilla is the only card seat 1 has on the field",
        ).to.deep.eq([vanillaId]);
        expect(
          (side.backrow ?? []).filter((slot) => slot !== null),
          "seat 1's backrow is empty, so the union holds nothing else",
        ).to.have.length(0);
        expect(unitById(state, "p1", vanillaId).radiant, "Mr. Vanilla is still on its base face").to.eq(
          false,
        );
        expect(side.mana?.current, "#94's +2 mana pays for Knockoff Temu on the same turn").to.be.at.least(
          COSTS[CARDS.knockoffTemu] ?? 2,
        );
      });

      // -------------------------------------------------------------------------------------
      // 4. "Knockoff Temu on a field unit": one candidate, so the conversion lands on it
      //    whatever the seed says. #28 declares no play-time choice, so the play is one click —
      //    written out rather than `cy.playByName` so the glow can be awaited while it runs.
      // -------------------------------------------------------------------------------------
      cy.instanceInHand("p1", CARDS.knockoffTemu).then((temuId) => {
        cy.get(ts(handCardId(temuId))).click();

        // "glow animation": BUILD M5-T4 `radiantSet`, "Gold glow pulse, stats swap", 400 ms.
        cy.expectAnimating("radiantSet");
        cy.settled();

        cy.get(`${ts(cardId(vanillaId))}${RADIANT}`).should("exist");

        // "stats swap on the field card keeping damage" — the assertion this spec exists for.
        expectShownHealth(vanillaId, VANILLA_RADIANT.health - MATH_DAMAGE, VANILLA_RADIANT.health);
        cy.gameState().then((after) => {
          const unit = unitById(after, "p1", vanillaId);
          expect(unit.radiant, "§5.2: the flag is set on the same instance").to.eq(true);
          expect(unit.damage, "§5.2: damage taken is kept across the flip").to.eq(MATH_DAMAGE);
          expect(unit.buffs, "§5.2: buffs are kept too, and this unit never had any").to.deep.eq({
            attack: 0,
            health: 0,
          });
          // It is the same instance, not a rebuilt one: a new card would have a new id (§10.1).
          expect(unit.defId, "the instance was converted in place (§5.2)").to.eq(CARDS.mrVanilla);
        });
      });
    });
  });
});
