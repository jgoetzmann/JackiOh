// A card's return to its hand: the price it returns with, and §5.1's end-of-turn return (SPEC §2.4,
// §5.1, §10.5 step 7, R4, R78, R153, R155). Found by the polish-4 edge-case hunt, round 3
// (docs/polish/4-edge-cases.md, lenses L2 and L8); every case here failed before its fix.
//
//  - R4: a price a card is given as it returns to a hand — #31's "+1", #37r's "costs 1 less" — is
//    its price in that hand. A full hand burns the card instead (§2.4), and the burned card keeps
//    its cost, as radiant #52's "costing 0" already did (re-entry.test.ts).
//  - R155: the end-of-turn return belongs to the Spell its own play landed in the graveyard, so a
//    card that left the graveyard and came back some other way the same turn stays there (R153).
//  - R215 (round 4, lens L2): a hand card that reaches a graveyard is reset as a card leaving the
//    field is (R78), so it comes back as the printed card; and #99's crafted card, like every price
//    a card is given as it reaches a hand, takes its "costs 0" only in that hand.
//  - R215 (round 5, lenses "card by card" and "engine invariants"): a card landing from the resolving
//    zone is reset too, so a #95 an earlier Call to Chaos cast carries no link of that chain (R28)
//    into a play of its own once Reminisce has brought it back.
//  - R155 (round 7, lens L8): a return Spell cast on the other player's turn (a cast on draw, R70) is
//    flagged and cleared at that turn's cleanup — §6.2's "End of turn" is its controller's own — so it
//    does not come back at the end of a later turn it was not played on.
//  - R215 (round 8, lens "engine invariants"): radiant #52's "costing 0" is announced with a
//    `costChanged` once the card has landed, as #31's +1 and #72r's 0 are (§10.3).

import type { CardDef, CardType, GameEvent } from "@jackioh/shared";
import {
  CALL_TO_CHAOS_CHAIN_CAP,
  createRng,
  newInstance,
  registerScripts,
  registeredScripts,
  subsystems,
  type Script,
} from "@jackioh/engine";
import { bounce } from "@jackioh/engine/effects";
import { describe, expect, it } from "vitest";
import { scenario, type Scenario } from "./_harness";

const VANILLA = "core-008";
const STOCKPILE = "core-005";
const TIMMY = "core-011";
const DREAM = "core-023";
const SEVEN_SEVEN = "core-025";
const KY_MATH = "core-031";
const GRAVEDIGGER = "core-037";
const REMINISCE = "core-072";
const FIELD_OF_DREAMS = "core-076";
const POINTMASTER = "core-020";
const TWINSPELL = "core-079";
const ZAO_GAO = "core-080";
const CORPSE_EATER = "core-089";
const CRAFT = "core-099";
const MENACE = "core-019";
const CHAOS = "core-095";

/** A cursor at which a base #95's single roll is `effect`, the pick 095's own tests use (R28). */
function chaosCursor(seed: string, effect: string): number {
  for (let cursor = 0; cursor < 500; cursor += 1) {
    if (subsystems.rollChaosEffects(createRng(seed, cursor), false)[0]?.name === effect) return cursor;
  }
  throw new Error(`no cursor below 500 rolls "${effect}" from seed "${seed}"`);
}

const AT_P2 = [{ pick: "hero", player: "p2" } as const];

describe("R4: a card a full hand burns keeps its cost, without the price of a return it never made", () => {
  it("R4 KY's Math Equation that a full hand burns at end of turn stays at its cost, without the +1 (§8 #31, R78)", () => {
    const fillers = Array.from({ length: 8 }, () => VANILLA);
    const g = scenario({
      p1: { hand: [KY_MATH, STOCKPILE, ...fillers], field: [TIMMY], library: [VANILLA, VANILLA, VANILLA, VANILLA] },
      p2: { field: [TIMMY], hand: [VANILLA], library: [VANILLA, VANILLA, VANILLA] },
    });
    const equation = g.card(KY_MATH);

    g.play(equation, { targets: AT_P2 });
    g.play(STOCKPILE); // hand 8 → draws 2 → 10: the hand is full when the turn ends
    expect(g.hand("p1")).toHaveLength(10);

    g.endTurn();

    // "Return to hand with cost +1": the hand is full, so the card is burned back to the graveyard
    // (§2.4) and never returns, and the +1 was the price of that return.
    g.expectInZone(equation, "graveyard");
    expect(g.card(equation).costMod).toBe(0);
  });

  it("R4 radiant Gravedigger's start-of-turn pick that a full hand burns stays at its cost, without the 1 less (§8 #37, R62, R78)", () => {
    const fillers = Array.from({ length: 10 }, () => VANILLA);
    const g = scenario({
      p1: {
        hand: fillers,
        field: [{ def: GRAVEDIGGER, radiant: true }],
        graveyard: [SEVEN_SEVEN],
        library: [VANILLA, VANILLA, VANILLA],
      },
      p2: { field: [TIMMY], hand: [VANILLA], library: [VANILLA, VANILLA, VANILLA] },
    });
    const seven = g.card(SEVEN_SEVEN);
    expect(g.hand("p1")).toHaveLength(10);

    g.endTurn(); // p2's turn
    g.endTurn(); // p1's start of turn: the Discover opens before the draw (R62)
    expect(g.state.pending?.playerId).toBe("p1");
    g.answer(seven.id);

    g.expectInZone(seven, "graveyard");
    expect(g.card(seven).costMod).toBe(0);
  });
});

describe("R155: the end-of-turn return belongs to the landing the Spell's own play made", () => {
  it("R155 Reoccurring Dream played, taken back to hand and then discarded into the graveyard the same turn does not return at end of turn (§5.1, R153)", () => {
    const g = scenario({
      p1: {
        hand: [DREAM, REMINISCE, FIELD_OF_DREAMS, VANILLA],
        field: [TIMMY],
        mana: 10,
        library: [VANILLA, VANILLA, VANILLA, VANILLA],
      },
      p2: { field: [TIMMY], hand: [VANILLA], library: [VANILLA, VANILLA, VANILLA] },
    });
    const dream = g.card(DREAM);

    g.play(dream); // §10.5 step 7 lands it in the graveyard, flagged to return (R155)
    g.expectInZone(dream, "graveyard");
    g.play(REMINISCE);
    g.answer(dream.id); // back to hand, never played again
    g.expectInZone(dream, "hand");
    g.play(FIELD_OF_DREAMS); // the hand is replaced: the Dream is discarded to the graveyard (R31)
    g.expectInZone(dream, "graveyard");

    g.endTurn();

    // What lies in the graveyard now arrived by a discard, not by its own play's step 7.
    g.expectInZone(dream, "graveyard");
  });
});

describe("R215: a hand card that reaches a graveyard is the printed card again", () => {
  it("R215 a Corpse Eater that fed in hand, was discarded by Zao Gao and came back by Reminisce is a fresh 2/2 (§8 #89, R78)", () => {
    const g = scenario({
      p1: {
        hand: [CORPSE_EATER, ZAO_GAO, REMINISCE, STOCKPILE],
        field: [{ def: POINTMASTER, lane: 1 }],
        library: [VANILLA, VANILLA, VANILLA, VANILLA, VANILLA, VANILLA],
      },
      p2: { hand: [STOCKPILE], field: [{ def: VANILLA, lane: 1 }], library: [VANILLA, VANILLA, VANILLA] },
    });
    const eater = g.card(CORPSE_EATER);
    const filler = g.card(STOCKPILE);
    const prey = g.unit("p2", 1);
    if (prey === null) throw new Error("setup: p2's lane-1 unit");

    // A 3/3 dies while the Eater is in hand: it gains +3/+3 (§8 #89).
    g.attack(POINTMASTER, prey);
    g.expectInZone(prey, "graveyard");
    expect(g.stats(eater).attack).toBe(5);

    // Zao Gao discards it; Reminisce brings it back from the graveyard.
    g.play(ZAO_GAO).answer([eater.id, filler.id]);
    g.expectInZone(eater, "graveyard");
    g.play(REMINISCE).answer(eater.id);
    g.expectInZone(eater, "hand");

    // The card that went to the graveyard and came back is the printed card, not the one that fed.
    expect(g.card(eater).buffs).toEqual({ attack: 0, health: 0 });
    expect(g.stats(eater).attack).toBe(2);
    expect(g.stats(eater).maxHealth).toBe(2);
  });

  it("R215 a crafted card a full hand burns does not keep the cost 0 it was to have in hand (§8 #99, R4, R77)", () => {
    const fillers = Array.from({ length: 8 }, () => VANILLA);
    const g = scenario({
      p1: { hand: [TWINSPELL, CRAFT, ...fillers], library: [VANILLA, VANILLA, VANILLA] },
      p2: { hand: [VANILLA], library: [VANILLA, VANILLA, VANILLA] },
    });
    g.play(TWINSPELL, { zone: 1 });
    g.endTurn();
    g.endTurn();
    expect(g.state.active).toBe("p1");
    expect(g.hand("p1")).toHaveLength(10);
    g.play(CRAFT);
    // Twinspell's Echo +1: two crafts. The first lands in the hand, which is then full again.
    for (let i = 0; i < 4 && g.state.pending !== null; i += 1) g.answer(g.state.pending.options[0]?.key ?? "");
    const burned = g.events.filter((event): event is Extract<GameEvent, { type: "burned" }> => event.type === "burned");
    expect(burned).toHaveLength(1);
    const crafted = g.card(burned[0]?.instanceId ?? "");
    expect(crafted.zone.z).toBe("graveyard");
    expect(crafted.costOverride).toBeUndefined();
  });
});

describe("R215: a card that lands from the resolving zone is the printed card again", () => {
  it("R215 a Call to Chaos cast at the end of a chain, taken back from the graveyard and played, starts a chain of its own (R28, R87)", () => {
    // The played #95 stands in for the 19th link of a chain, which is how 095's own tests pin R28's
    // counter. Its roll casts the 20th link, which R87 sends to the graveyard as it resolves, and
    // #72 Reminisce takes that card back. Played from hand, it is a new play, so a new chain from
    // nothing — and its "cast a random Call to Chaos" casts one, where the old link at the cap cast
    // nothing. Hearthstone likewise returns a card from the graveyard without what its last trip
    // left on it.
    const seed = "inv-r5-chaos-chain";
    const s = scenario({ seed, p1: { hand: [CHAOS, REMINISCE, MENACE], mana: 20 }, p2: { hand: [MENACE] } });
    s.card(CHAOS).memory[subsystems.CHAOS_CHAIN_KEY] = CALL_TO_CHAOS_CHAIN_CAP - 1;
    s.state.rngCursor = chaosCursor(seed, "recast");
    s.play(CHAOS);

    const plays = s.events.filter(
      (event): event is Extract<GameEvent, { type: "cardPlayed" }> => event.type === "cardPlayed" && event.defId === CHAOS,
    );
    expect(plays).toHaveLength(2); // the play and the chain's 20th cast
    const lastLink = (plays[1] as { instanceId: string }).instanceId;
    s.expectInZone(lastLink, "graveyard");
    // It landed as the printed card: the chain's count stayed with the chain.
    expect(s.card(lastLink).memory[subsystems.CHAOS_CHAIN_KEY]).toBeUndefined();

    s.play(REMINISCE).answer(lastLink);
    s.expectInZone(lastLink, "hand");

    s.state.rngCursor = chaosCursor(seed, "recast");
    s.play(lastLink);
    expect(s.lastEvents.filter((event) => event.type === "cardPlayed" && event.defId === CHAOS)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Round 7 (lens L8): a return Spell cast on the other player's turn.
// ---------------------------------------------------------------------------

const PREM_PANTHER = "core-032"; // 5/4 Rush; whenever this destroys a unit, draw 2
const RENO = "core-053";

/** A fixture card: a transient def in the match state and its script in the registry. */
function fixture(s: Scenario, id: string, type: CardType, script: Script, stats = { attack: 2, health: 2 }): void {
  const face = type === "Unit" ? { ...stats, keywords: [], text: id } : { keywords: [], text: id };
  const def: CardDef = {
    id,
    index: id,
    name: id,
    set: "Core",
    type,
    tags: [],
    rarity: "Common",
    token: false,
    cost: 0,
    base: { ...face },
    radiant: { ...face },
  };
  s.state.transientDefs[id] = def;
  registerScripts({ ...registeredScripts(), [id]: { base: script, radiant: script } });
}

describe("R155, §5.1: an end-of-turn return belongs to the turn the Spell was played on", () => {
  it("R155 a return Spell cast on the opponent's turn does not come back at the end of its caster's next turn (R70, §5.1, §6.2)", () => {
    // p2's Tempo Timmy (3/3 First Strike) attacks p1's Prem Panther (5/4): the Panther survives the
    // first strike and kills Timmy, so p1 draws 2 on p2's turn. The top card is a cast-on-draw Spell
    // carrying #23 Reoccurring Dream's "End of turn: returns from the GY to your hand" (the flag
    // R155 writes is what the return reads), so p1 casts it on p2's turn (§2.4, R70).
    const s = scenario({
      active: "p2",
      p1: { field: [PREM_PANTHER], hand: [RENO], library: [RENO, RENO, RENO, RENO] },
      p2: { field: [TIMMY], hand: [RENO], library: [RENO, RENO, RENO, RENO] },
    });
    fixture(s, "edge-r7-dream-cod", "Spell", {
      staticFlags: { castOnDraw: true },
      cry: () => [],
      endOfTurn: (ctx) => (ctx.self?.returnToHandAtEndOfTurn === true ? [bounce({ target: { of: "self" } })] : []),
    });
    const cod = newInstance(s.state, "edge-r7-dream-cod", "p1", { z: "library", player: "p1" });
    s.state.players.p1.library.unshift(cod);

    s.attack(TIMMY, PREM_PANTHER);
    // The cast happened on p2's turn, and the Spell landed in p1's graveyard (§10.5 step 7).
    expect(s.events.some((event) => event.type === "cardPlayed" && event.instanceId === cod.id)).toBe(true);
    s.expectInZone(cod, "graveyard");

    // p2's turn ends. §5.1: the Spell returns "at the end of that turn", and R155's cleanup clears
    // the flag "at the end of that turn" — whichever reading, nothing of that return is left once
    // the turn it was played on is over.
    s.endTurn();
    expect(s.state.active).toBe("p1");
    const afterItsTurn = s.card(cod);
    if (afterItsTurn.zone.z === "graveyard") {
      expect(
        afterItsTurn.returnToHandAtEndOfTurn,
        "the return flag outlived the cleanup of the turn the Spell was cast on",
      ).not.toBe(true);
    }

    // p1's own next turn ends: a Spell p1 did not play on this turn does not come back now.
    s.endTurn();
    const returned = s.lastEvents.some(
      (event) => (event.type === "bounced" || event.type === "addedToHand") && event.instanceId === cod.id,
    );
    expect(returned, "the Spell came back at the end of a turn it was not played on").toBe(false);
  });
});

describe("R215, §10.3: a price given as a card reaches a hand is announced", () => {
  it("R215 radiant #52's bounce at cost 0 emits costChanged for the card it prices, as #31's +1 and #72r's 0 do (§10.3)", () => {
    const silas = "core-052";
    const s = scenario({
      p1: { hand: [silas], field: [{ def: RENO, lane: 5 }] },
    });
    s.card(silas).radiant = true;
    const reno = s.unit("p1", 5)?.id;
    if (reno === undefined) throw new Error("expected p1's Reno in lane 5");

    // Rotating right would move Reno from p1's lane 5 to p2's, so radiant #52 bounces it to its
    // owner's hand costing 0 instead (§8 #52, R14).
    s.play(silas, { zone: 1, modes: ["right"] });

    s.expectInZone(reno, "hand");
    expect(s.card(reno).costOverride).toBe(0);
    // Reno's price in its owner's hand went from its printed 3 to 0, a visible change (§10.3), which
    // is announced once the card has landed, as #31's +1 and #72r's 0 are.
    const bounced = s.lastEvents.findIndex((event) => event.type === "bounced" && event.instanceId === reno);
    expect(bounced).toBeGreaterThanOrEqual(0);
    expect(s.lastEvents.slice(bounced)).toContainEqual({ type: "costChanged", instanceId: reno, cost: 0 });
  });
});
