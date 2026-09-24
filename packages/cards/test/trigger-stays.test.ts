// An event is answered as the board stood when it happened (SPEC §10.3, §4.5, R174, R212). Found by
// the polish-4 edge-case hunt, round 3 (docs/polish/4-edge-cases.md, lenses L2, L7 and the combat
// windows); every case here failed before its fix.
//
// §10.3's loop hands an event to the triggers after whatever ran before it was dispatched: the state
// check that follows a combat, an Echo repeat or a whole Cry, and inside that check the Death hooks
// and Reborn. So by the time #91 Fed Fauci's "whenever this takes damage" or #32 Prem Panther's
// "whenever this destroys a unit" is offered its event, the card can be a Reborn body, a card drawn
// since, or a unit a Death has stolen since. R212: a card that has moved zones since the event is on
// a stay that did not see it, and a card whose controller changed since answers for the player who
// controlled it then.
//
// Round 8 (lens "control-change") carried R212 to the traps, which are an event's first responders:
// a trap a later effect stole before the event reached the traps — a cast's events wait for the list
// that cast it (R70), and the end-of-turn window offers `turnEnded` to one trap after another (R62)
// — answers for the player who held it then, and a trap that arrived since does not answer it. No
// Core effect steals or summons a trap between an event and its dispatch, so the effect that does is
// a fixture (a transient def and its script in the registry, as combat-windows.test.ts builds them).

import type { CardDef, CardType, GameEvent, PlayerId, Selection } from "@jackioh/shared";
import { opponentOf } from "@jackioh/shared";
import {
  cardAt,
  newInstance,
  placeOnField,
  registerScripts,
  registeredScripts,
  type CardInstance,
  type EffectContext,
  type Script,
} from "@jackioh/engine";
import { draw, steal, summon } from "@jackioh/engine/effects";
import { describe, expect, it } from "vitest";
import { scenario, type Scenario } from "./_harness";

const GARY = "core-004";
const STOCKPILE = "core-005";
const VANILLA = "core-008";
const MOTHS = "core-009";
const PANTHER = "core-032";
const TRUE_STRIKE = "core-044";
const SORCERER = "core-068";
const ADAPTIVE_UI = "core-074";
const TWINSPELL = "core-079";
const MROW = "core-086";
const CORPSE_EATER = "core-089";
const FAUCI = "core-091";
const RENO = "core-053";
const BREAD = "core-018";
const HINDER = "core-021";
const HONEYPOT = "core-060";
const BREAD_TOKEN = "core-t-bread";
const RUSH_TOKEN = "core-t-rush";
const LIBRARY = [VANILLA, VANILLA, VANILLA, VANILLA, VANILLA, VANILLA, VANILLA, VANILLA];

const at = (card: CardInstance): Selection[] => [{ pick: "instance", instanceId: card.id }];

function unitAt(g: Scenario, player: "p1" | "p2", lane: number): CardInstance {
  const card = g.unit(player, lane);
  if (card === null) throw new Error(`setup: ${player} should hold a unit in lane ${lane}`);
  return card;
}

/** Grant Reborn to a unit on the field directly, as deaths-and-reborn.test.ts does (R21). */
function grantReborn(g: Scenario, card: CardInstance): void {
  g.card(card).grantedKeywords.push({ kind: "Reborn" });
}

function died(g: Scenario, card: CardInstance): boolean {
  return g.events.some((e: GameEvent) => e.type === "destroyed" && e.instanceId === card.id);
}

/** The Echo repeat's fresh target prompt, answered with the enemy hero (§10.5 step 6). */
function answerRepeatWithHero(g: Scenario): void {
  const pending = g.state.pending;
  if (pending === null) throw new Error("the Echo repeat should ask for a target");
  const hero = pending.options.find((o) => o.selection.pick === "hero" && o.selection.player === "p2");
  if (hero === undefined) throw new Error(`no enemy hero option: ${pending.options.map((o) => o.key).join(", ")}`);
  g.answer([hero.selection]);
}

describe("R212: a Reborn body does not answer for the stay that died", () => {
  it("R212 Fed Fauci that dies attacking and comes back through Reborn gets no Plague Token for the hit that killed it (R174)", () => {
    const g = scenario({
      p1: { hand: [STOCKPILE], field: [{ def: FAUCI, lane: 1, damage: 5 }], library: [...LIBRARY] },
      p2: { hand: [STOCKPILE], field: [{ def: VANILLA, lane: 1 }], library: [...LIBRARY] },
    });
    const fauci = unitAt(g, "p1", 1);
    grantReborn(g, fauci);

    // A 1/6 with 5 damage attacks a 3/3: the strike back is lethal, and Reborn brings the same
    // instance straight back (§4.5 step 4) before the combat's damage events are dispatched.
    g.attack(fauci, unitAt(g, "p2", 1));

    expect(died(g, fauci)).toBe(true);
    g.expectInZone(fauci, "field");
    expect(g.card(fauci).rebornSpent).toBe(true);
    expect(g.card(fauci).counters.plague ?? 0).toBe(0);
  });

  it("R212 Fed Fauci forced into Moths to the Flame, killed by the strike back and reborn, gets no Plague Token (R53, R174)", () => {
    const g = scenario({
      p1: { hand: [STOCKPILE], field: [{ def: MOTHS, lane: 1 }], library: [...LIBRARY] },
      p2: { hand: [STOCKPILE], field: [{ def: FAUCI, lane: 1, damage: 5 }], library: [...LIBRARY] },
    });
    const fauci = unitAt(g, "p2", 1);
    grantReborn(g, fauci);

    // p1's start of turn: Moths makes Fauci attack it, and the strike back (1) is lethal.
    g.startTurn();

    expect(died(g, fauci)).toBe(true);
    g.expectInZone(fauci, "field");
    expect(g.card(fauci).counters.plague ?? 0).toBe(0);
  });

  it("R212 Fed Fauci killed by the first resolution of an Echoed True Strike gets no Plague Token on its Reborn body (§10.5 step 6)", () => {
    const g = scenario({
      p1: {
        hand: [TWINSPELL, TRUE_STRIKE, VANILLA],
        field: [{ def: FAUCI, lane: 1, damage: 5 }],
        library: [...LIBRARY],
      },
      p2: { hand: [VANILLA], library: [...LIBRARY] },
    });
    const fauci = unitAt(g, "p1", 1);
    grantReborn(g, fauci);

    g.play(TWINSPELL);
    // The check between the resolutions (§4.5) kills Fauci and Reborn returns it; the repeat then
    // asks for a fresh target, and the first hit's damage event is dispatched after all of that.
    g.play(TRUE_STRIKE, { targets: at(fauci) });
    answerRepeatWithHero(g);

    expect(died(g, fauci)).toBe(true);
    g.expectInZone(fauci, "field");
    expect(g.card(fauci).counters.plague ?? 0).toBe(0);
  });

  it("R212 a Prem Panther that trades and comes back through Reborn draws what a Panther that trades without Reborn draws (R42, R174)", () => {
    const trade = (reborn: boolean): Scenario => {
      const g = scenario({
        p1: { hand: [VANILLA], field: [{ def: PANTHER, lane: 1 }], library: [...LIBRARY] },
        p2: { hand: [VANILLA], field: [{ def: SORCERER, lane: 1 }], library: [...LIBRARY] },
      });
      const panther = unitAt(g, "p1", 1);
      if (reborn) grantReborn(g, panther);
      const prey = unitAt(g, "p2", 1);
      // A 5/4 Panther into a 5/5 Twisted Sorcerer: both die.
      g.attack(panther, prey);
      expect(died(g, panther)).toBe(true);
      expect(died(g, prey)).toBe(true);
      return g;
    };

    // Without Reborn the Panther is in its graveyard when the `destroyed` event is dispatched, and a
    // graveyard registers none of its field triggers (R153): it draws nothing.
    const plain = trade(false);
    // With Reborn the same trade happens, and the body back in lane 1 is a new arrival (R83) that
    // destroyed nothing.
    const back = trade(true);
    back.expectInZone(unitAt(back, "p1", 1), "field");
    expect(back.hand("p1")).toHaveLength(plain.hand("p1").length);
  });
});

describe("R212: a card that arrived after a death does not answer it", () => {
  it("R212 a Corpse Eater drawn by an Echo repeat does not feed on a unit that died before it reached the hand (§8 #89, R89)", () => {
    const g = scenario({
      p1: { hand: [TWINSPELL, ADAPTIVE_UI], library: [VANILLA, CORPSE_EATER, ...LIBRARY] },
      p2: { hand: [VANILLA], field: [{ def: GARY, lane: 1 }], library: [...LIBRARY] },
    });
    const gary = unitAt(g, "p2", 1);

    g.play(TWINSPELL);
    // Resolution 1 (X = 1): 1 damage kills the 1/1 Gary and draws Mr. Vanilla, and the check before
    // the repeat collects Gary. Resolution 2 draws Corpse Eater — after Gary died.
    g.play(ADAPTIVE_UI, { x: 1, targets: at(gary) });
    answerRepeatWithHero(g);

    expect(died(g, gary)).toBe(true);
    const eater = g.hand("p1").find((c) => c.defId === CORPSE_EATER);
    if (eater === undefined) throw new Error("Corpse Eater should have been drawn by the repeat");
    // "While in your hand: whenever a unit ... dies" — it was still in the library when Gary died.
    expect(g.card(eater).buffs).toEqual({ attack: 0, health: 0 });
  });
});

describe("R212: a card answers for the player who controlled it when the event happened", () => {
  it("R212 Prem Panther that kills \"Miss\" Mrow draws for the player who controlled it, not for the player Mrow's Death gave it to (§8 #32, §8 Conventions)", () => {
    // The Panther destroyed a unit while it was p1's; Mrow's Death then steals every p1 unit, the
    // Panther included, before the `destroyed` event is dispatched. Hearthstone resolves a minion's
    // kill trigger for its controller before a Deathrattle takes it.
    const g = scenario({
      p1: { hand: [RENO], field: [{ def: PANTHER, lane: 1 }], library: [...LIBRARY] },
      p2: { hand: [RENO], field: [{ def: MROW, lane: 1 }], library: [...LIBRARY] },
    });
    const panther = unitAt(g, "p1", 1);
    const mrow = unitAt(g, "p2", 1);
    const p1Hand = g.hand("p1").length;
    const p2Hand = g.hand("p2").length;

    g.attack(panther, mrow);

    g.expectInZone(mrow, "graveyard");
    expect(g.card(panther).controller).toBe("p2");
    expect(g.hand("p1")).toHaveLength(p1Hand + 2);
    expect(g.hand("p2")).toHaveLength(p2Hand);
  });
});

// ---------------------------------------------------------------------------------------------
// Round 8: the traps answer an event as the board stood when it happened
// ---------------------------------------------------------------------------------------------

function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`expected ${what}`);
  return value;
}

function eventsOf<T extends GameEvent["type"]>(s: Scenario, type: T): Extract<GameEvent, { type: T }>[] {
  return s.events.filter((event): event is Extract<GameEvent, { type: T }> => event.type === type);
}

function unitsOf(s: Scenario, player: PlayerId): CardInstance[] {
  return [1, 2, 3, 4, 5].flatMap((lane) => {
    const found = s.unit(player, lane);
    return found === null ? [] : [found];
  });
}

/** A fixture card: a transient def in the match state and its script in the registry. */
function fixture(s: Scenario, id: string, type: CardType, script: Script, cost = 0): void {
  const face = { keywords: [], text: id };
  const def: CardDef = {
    id,
    index: id,
    name: id,
    set: "Core",
    type,
    tags: [],
    rarity: "Common",
    token: false,
    cost,
    base: { ...face },
    radiant: { ...face },
  };
  s.state.transientDefs[id] = def;
  registerScripts({ ...registeredScripts(), [id]: { base: script, radiant: script } });
}

function inHand(s: Scenario, defId: string, player: PlayerId): CardInstance {
  const card = newInstance(s.state, defId, player, { z: "hand", player });
  s.state.players[player].hand.push(card);
  return card;
}

/** A face-down trap of `player`'s in a backrow lane (R33). */
function setTrap(s: Scenario, defId: string, player: PlayerId, lane: number): CardInstance {
  const card = newInstance(s.state, defId, player, { z: "hand", player });
  if (!placeOnField(s.state, card, { player, row: "backrow", lane })) throw new Error(`could not place ${defId}`);
  card.faceUp = false;
  return card;
}

/** "The enemy's backrow card in lane 2", read as the hook builds its list. */
function enemyBackrowLane2(ctx: EffectContext): CardInstance | null {
  return cardAt(ctx.state, { player: opponentOf(ctx.controller), row: "backrow", lane: 2 });
}

describe("R212 for traps: a trap answers an event as the board stood when it happened", () => {
  it("R212 a Bear Honeypot its opponent's Spell stole after a cast in the same list answers that cast for the player who held it then", () => {
    const s = scenario({
      seed: "edge-r8-honeypot-lifted",
      p1: { hand: [VANILLA], field: [{ def: VANILLA, lane: 5 }], library: [HINDER, VANILLA, VANILLA, VANILLA] },
      p2: {
        hand: [VANILLA],
        field: [{ def: VANILLA, lane: 5 }],
        backrow: [{ def: HONEYPOT, lane: 2, faceUp: false }],
        library: [...LIBRARY],
      },
    });
    const trap = must(s.backrow("p2", 2), "p2's Bear Honeypot");
    // A 2-cost Spell (so its own play is no "card costing 1 or less"): "Draw a card, then take
    // control of the enemy's backrow card in lane 2."
    fixture(
      s,
      "edge-r8-draw-then-lift",
      "Spell",
      {
        cry: (ctx) => {
          const enemy = enemyBackrowLane2(ctx);
          return [draw({ count: 1 }), ...(enemy === null ? [] : [steal({ instanceId: enemy.id })])];
        },
      },
      2,
    );
    const spell = inHand(s, "edge-r8-draw-then-lift", "p1");

    s.play(spell);

    // The draw cast Hinder (§2.4, R70: a play, paid 0) while the Honeypot was still p2's, and only
    // then did the Spell take the Honeypot.
    const cast = eventsOf(s, "cardResolved").filter((event) => event.defId === HINDER);
    expect(cast).toHaveLength(1);
    expect(cast[0]).toMatchObject({ player: "p1", costPaid: 0 });
    expect(eventsOf(s, "controlChanged").some((event) => event.instanceId === trap.id && event.controller === "p1")).toBe(true);
    // R212: the cast is answered as the board stood when it happened. p2's Honeypot saw its
    // opponent play a card costing 1 or less, so it fires, and its tokens are p2's (R52's shape:
    // everything a trap does is its controller's, and that controller is the one the event met).
    expect(eventsOf(s, "trapFired").filter((event) => event.instanceId === trap.id)).toHaveLength(1);
    expect(unitsOf(s, "p2").filter((unit) => unit.defId === RUSH_TOKEN)).toHaveLength(2);
    expect(unitsOf(s, "p1").filter((unit) => unit.defId === RUSH_TOKEN)).toHaveLength(0);
  });

  it("R212 a Bread and Butter an earlier trap of the end-of-turn window stole answers that turn end for the player who held it when it ended", () => {
    const s = scenario({
      seed: "edge-r8-window-lift",
      p1: { hand: [VANILLA], field: [{ def: VANILLA, lane: 5 }], library: [...LIBRARY] },
      p2: {
        hand: [VANILLA],
        field: [{ def: VANILLA, lane: 5 }],
        backrow: [{ def: BREAD, lane: 2, faceUp: false }],
        library: [...LIBRARY],
      },
    });
    const bread = must(s.backrow("p2", 2), "p2's Bread and Butter");
    // A Trap: "At the end of any turn: take control of the enemy's backrow card in lane 2."
    fixture(s, "edge-r8-window-lifter", "Trap", {
      triggers: [
        {
          id: "edge-r8-window-lifter",
          on: ["turnEnded"],
          run: (ctx) => {
            const enemy = enemyBackrowLane2(ctx);
            return enemy === null ? [] : [steal({ instanceId: enemy.id })];
          },
        },
      ],
    });
    setTrap(s, "edge-r8-window-lifter", "p1", 1);

    // p1 ends the turn with 4 unspent mana. The window offers the ending player's traps first (R62),
    // so the lifter takes the Bread and Butter before the Bread and Butter is offered the turn end.
    s.endTurn();

    expect(s.card(bread).controller).toBe("p1");
    // R212: the turn end is answered as the board stood when it happened, and the Bread and Butter
    // was p2's then, so its 4/4 is p2's (R52: "the trap's controller").
    expect(unitsOf(s, "p2").filter((unit) => unit.defId === BREAD_TOKEN)).toHaveLength(1);
    expect(unitsOf(s, "p1").filter((unit) => unit.defId === BREAD_TOKEN)).toHaveLength(0);
  });

  it("R212 a Bear Honeypot that arrived after a cast in the same list does not answer that cast (R174)", () => {
    const s = scenario({
      seed: "edge-r8-honeypot-late",
      p1: { hand: [VANILLA], field: [{ def: VANILLA, lane: 5 }], library: [HINDER, VANILLA, VANILLA, VANILLA] },
      p2: { hand: [VANILLA], field: [{ def: VANILLA, lane: 5 }], library: [...LIBRARY] },
    });
    // A 2-cost Spell: "Draw a card, then summon a Bear Honeypot face-down for the opponent."
    fixture(
      s,
      "edge-r8-draw-then-gift-trap",
      "Spell",
      { cry: () => [draw({ count: 1 }), summon({ defId: HONEYPOT, player: "enemy" })] },
      2,
    );
    const spell = inHand(s, "edge-r8-draw-then-gift-trap", "p1");

    s.play(spell);

    expect(eventsOf(s, "cardResolved").filter((event) => event.defId === HINDER)).toHaveLength(1);
    const honeypot = must(
      eventsOf(s, "summoned").find((event) => event.defId === HONEYPOT),
      "the Honeypot's summon",
    );
    // The only play costing 1 or less is Hinder's cast, which happened before the Honeypot was on
    // the field: a stay that did not see it, so it does not answer it and stays armed (R212, R99).
    expect(eventsOf(s, "trapFired").filter((event) => event.instanceId === honeypot.instanceId)).toHaveLength(0);
    expect(unitsOf(s, "p2").filter((unit) => unit.defId === RUSH_TOKEN)).toHaveLength(0);
    expect(s.backrow("p2", honeypot.lane)?.id).toBe(honeypot.instanceId);
  });
});
