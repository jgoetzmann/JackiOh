// Call to Chaos (BUILD M3-T7): SPEC §8 #95, §7's tokens and R28's capped recursion. The card file
// arrives in M4; these tests pin the machinery it will call — each of the ten effects, the base and
// radiant rolls, the chain cap, and what the ten do against a full board, a full hand and an empty
// library.

import type { CardDef, GameEvent, PlayerId } from "@jackioh/shared";
import { describe, expect, it } from "vitest";
import { defOf, queryCost, registerCatalog, registeredCatalog } from "../src/catalog";
import { CALL_TO_CHAOS_CHAIN_CAP, HAND_CAP, LIBRARY_CAP } from "../src/config";
import { unitView } from "../src/layers";
import { effectiveCost } from "../src/mana";
import { applyEffects, makeContext, type EngineSink } from "../src/resolve";
import { createRng } from "../src/rng";
import type { CardScripts, Effect, Hook } from "../src/script";
import { registerScripts, registeredScripts } from "../src/scripts";
import { cloneState, newInstance, type CardInstance, type GameState } from "../src/state";
import {
  CHAOS_CHAIN_KEY,
  CHAOS_EFFECTS,
  CHAOS_RECURSION,
  addRandomZeroCostCards,
  callToChaos,
  castRandomCallToChaos,
  chaosChainCapReached,
  chaosChainOf,
  discountHandAndLibrary,
  drawLibraryAndGainMana,
  healHeroThirty,
  makeHandRadiant,
  rollChaosEffects,
  summonChaosGolem,
  summonRandomBackrow,
  summonRandomThreeCostUnits,
  summonRushTokens,
} from "../src/subsystems/callToChaos";
import { eventsOfType, inHand, newGame, put, setLibrary, sinkFor, slot } from "./fixtures/harness";

let nextIndex = 900;
function def(name: string, type: CardDef["type"], extra: Partial<CardDef> = {}): CardDef {
  nextIndex += 1;
  return {
    id: `cc-${name}`,
    index: String(nextIndex),
    name,
    set: "Core",
    type,
    tags: [],
    rarity: "Common",
    token: false,
    cost: 1,
    base: { keywords: [], text: name },
    radiant: { keywords: [], text: name },
    ...extra,
  };
}

/** #95 itself: the Spell the recursion's pool is drawn from (§8, §5). */
const chaos = def("chaos", "Spell", {
  index: "95",
  name: "Call to Chaos (fixture)",
  tags: ["Call to Chaos"],
  rarity: "Legendary",
  cost: 4,
});

/** §7: the 10/10 token index 95.1. */
const golem = def("golem", "Unit", {
  index: "95.1",
  name: "Chaos Golem (fixture)",
  tags: ["Token"],
  rarity: "Token",
  token: true,
  cost: 4,
  base: {
    attack: 10,
    health: 10,
    keywords: [{ kind: "Rush" }, { kind: "Lifesteal" }, { kind: "Divine Shield" }, { kind: "First Strike" }],
    text: "Chaos Golem",
  },
  radiant: {
    attack: 10,
    health: 10,
    keywords: [{ kind: "Rush" }, { kind: "Lifesteal" }, { kind: "Divine Shield" }, { kind: "First Strike" }],
    text: "Chaos Golem",
  },
});

/** Three 3-cost Units and one 5-cost Unit, so the cost filter of effect 1 has something to refuse. */
const threeA = def("three-a", "Unit", { cost: 3, base: { attack: 3, health: 3, keywords: [], text: "3a" }, radiant: { attack: 6, health: 6, keywords: [], text: "3a+" } });
const threeB = def("three-b", "Unit", { cost: 3, base: { attack: 2, health: 4, keywords: [], text: "3b" }, radiant: { attack: 4, health: 8, keywords: [], text: "3b+" } });
const threeC = def("three-c", "Unit", { cost: 3, base: { attack: 4, health: 2, keywords: [], text: "3c" }, radiant: { attack: 8, health: 4, keywords: [], text: "3c+" } });
const fiveCost = def("five", "Unit", { cost: 5, base: { attack: 5, health: 5, keywords: [], text: "5" }, radiant: { attack: 5, health: 5, keywords: [], text: "5" } });

/** The backrow pool of effect 9: a Trap, a Field Trap and a Field Spell (§3.2, R33). */
const trap = def("trap", "Trap", { cost: 2 });
const fieldTrap = def("field-trap", "Field Trap", { cost: 2 });
const fieldSpell = def("field-spell", "Field Spell", { cost: 2 });

const DEFS = [chaos, golem, threeA, threeB, threeC, fiveCost, trap, fieldTrap, fieldSpell];

type GameOptions = {
  /** What the cast copy of #95 does when it resolves; the default is the real card (§8). */
  chaosCry?: Hook;
};

function game(seed: string, options: GameOptions = {}): GameState {
  const state = newGame(seed);
  registerCatalog({ ...registeredCatalog(), ...Object.fromEntries(DEFS.map((d) => [d.id, d])) });

  const cry: Hook = options.chaosCry ?? (() => [callToChaos()]);
  const scripts: CardScripts = { base: { cry }, radiant: { cry } };
  registerScripts({ ...registeredScripts(), [chaos.id]: scripts });

  state.turn = 4;
  state.active = "p1";
  state.phase = "main";
  // Every test sets the library it needs; the dealt deck would only add noise to the draw effects.
  setLibrary(state, "p1", []);
  return state;
}

/** A #95 instance mid-resolution, which is what `self` is while its spell script runs (§10.5). */
function chaosCard(state: GameState, options: { radiant?: boolean; chain?: number } = {}): CardInstance {
  const card = newInstance(state, chaos.id, "p1", { z: "resolving", player: "p1" });
  if (options.radiant === true) card.radiant = true;
  if (options.chain !== undefined) card.memory[CHAOS_CHAIN_KEY] = options.chain;
  return card;
}

function run(
  sink: EngineSink,
  effect: Effect,
  self: CardInstance | null = null,
  controller: PlayerId = "p1",
): void {
  const ctx = makeContext(sink, self, { controller });
  applyEffects([effect], ctx);
}

function summonedDefs(state: GameState, events: readonly GameEvent[]): CardDef[] {
  return eventsOfType(events, "summoned").map((event) => defOf(state, event.defId));
}

describe("Call to Chaos (§8 #95, R28, M3-T7)", () => {
  it("§8 #95 summons 3 random 3-cost Units into the leftmost free zones (R60, R64)", () => {
    const state = game("chaos-units");
    const events: GameEvent[] = [];
    const sink = sinkFor(state, events);

    run(sink, summonRandomThreeCostUnits());

    const summoned = eventsOfType(events, "summoned");
    expect(summoned).toHaveLength(3);
    // R64: no zone is named, so they take the leftmost empty unlocked zones in order.
    expect(summoned.map((event) => event.lane)).toEqual([1, 2, 3]);
    expect(summoned.every((event) => event.row === "units")).toBe(true);
    for (const cardDef of summonedDefs(state, events)) {
      expect(cardDef.type).toBe("Unit");
      expect(queryCost(cardDef)).toBe(3);
      expect(cardDef.token).toBe(false);
    }
  });

  it("R60 lets the three summoned Units repeat, since they are generated from the catalog", () => {
    // Over many seeds the three picks are independent draws, so a repeat must be reachable.
    const repeats = ["r1", "r2", "r3", "r4", "r5", "r6", "r7", "r8"].map((seed) => {
      const state = game(`chaos-repeat-${seed}`);
      const events: GameEvent[] = [];
      run(sinkFor(state, events), summonRandomThreeCostUnits());
      const ids = eventsOfType(events, "summoned").map((event) => event.defId);
      return new Set(ids).size < ids.length;
    });
    expect(repeats).toContain(true);
  });

  it("§6.3 Heal: heals your hero 30, with no cap on a hero's health", () => {
    const state = game("chaos-heal");
    const sink = sinkFor(state);
    state.players.p1.hero.health = 12;

    run(sink, healHeroThirty());
    expect(state.players.p1.hero.health).toBe(42);
    expect(state.players.p2.hero.health).toBe(30); // "your hero" only
  });

  it("R58 draws the library it had when the effect started and gains 4 mana", () => {
    const state = game("chaos-draw");
    const sink = sinkFor(state);
    setLibrary(state, "p1", ["fx-1", "fx-2", "fx-3", "fx-4"]);

    run(sink, drawLibraryAndGainMana());

    expect(state.players.p1.library).toHaveLength(0);
    expect(state.players.p1.hand).toHaveLength(4);
    expect(state.players.p1.mana.current).toBe(4);
    expect(state.players.p1.fatigueCount).toBe(0);
  });

  it("R60 adds 3 random non-token cards to hand, each costing 0 (R65)", () => {
    const state = game("chaos-add");
    const sink = sinkFor(state);

    run(sink, addRandomZeroCostCards());

    const hand = state.players.p1.hand;
    expect(hand).toHaveLength(3);
    for (const card of hand) {
      // §5.1: `query` keeps tokens out of a pool that does not ask for them.
      expect(defOf(state, card.defId).token).toBe(false);
      expect(card.costOverride).toBe(0);
      expect(effectiveCost(state, card)).toBe(0);
    }
  });

  it("§5.2 makes every card in your hand Radiant and leaves an already Radiant card alone", () => {
    const state = game("chaos-radiant");
    const events: GameEvent[] = [];
    const sink = sinkFor(state, events);
    const [first, second, third] = inHand(state, "fx-1", "p1", 3);
    if (first === undefined || second === undefined || third === undefined) throw new Error("hand");
    third.radiant = true;
    const enemy = inHand(state, "fx-1", "p2", 1)[0];

    run(sink, makeHandRadiant());

    expect(state.players.p1.hand.every((card) => card.radiant)).toBe(true);
    // §6.3: the flag is set once and never unset; the cue goes out for all three, because a hand
    // card is hidden from the opponent and a cue only for the changed ones would give away its face
    // (R177, R97).
    expect(eventsOfType(events, "radiantSet").map((event) => event.instanceId)).toEqual([
      first.id,
      second.id,
      third.id,
    ]);
    expect(enemy?.radiant).toBe(false);
  });

  it("§7 summons five RADIANT Rush Tokens, whose 6/6 comes from the catalog", () => {
    const state = game("chaos-tokens");
    const events: GameEvent[] = [];
    const sink = sinkFor(state, events);

    run(sink, summonRushTokens());

    const summoned = eventsOfType(events, "summoned");
    expect(summoned).toHaveLength(5);
    expect(summoned.map((event) => event.lane)).toEqual([1, 2, 3, 4, 5]);
    for (const pile of state.players.p1.units) {
      const token = pile?.[0];
      expect(token).toBeDefined();
      if (token === undefined) continue;
      expect(defOf(state, token.defId).index).toBe("T-rush");
      // No `statsOverride`: #95 was the only card that invented a Rush Token size, and it now
      // summons the token's own Radiant face instead, so the 6/6 is the catalog's.
      expect(token.radiant).toBe(true);
      expect(token.statsOverride).toBeUndefined();
      expect(unitView(state, token)).toMatchObject({ attack: 6, maxHealth: 6 });
    }
  });

  it("§6.3 Cost: every card in your hand and library costs 2 less, floored at 0 (R78)", () => {
    const state = game("chaos-discount");
    const sink = sinkFor(state);
    const cheap = inHand(state, "fx-1", "p1", 1)[0]; // printed cost 1
    const pricey = inHand(state, chaos.id, "p1", 1)[0]; // printed cost 4
    const [inLibrary] = setLibrary(state, "p1", [chaos.id]);
    const enemy = inHand(state, chaos.id, "p2", 1)[0];
    if (cheap === undefined || pricey === undefined || inLibrary === undefined || enemy === undefined) {
      throw new Error("fixture");
    }

    run(sink, discountHandAndLibrary());

    expect(cheap.costMod).toBe(-2);
    expect(pricey.costMod).toBe(-2);
    expect(inLibrary.costMod).toBe(-2);
    expect(enemy.costMod).toBe(0); // "your" hand and library only
    // R65 floors the result at 0, and the discount travels with the card between zones (R78).
    expect(effectiveCost(state, cheap)).toBe(0);
    expect(effectiveCost(state, pricey)).toBe(2);
    expect(effectiveCost(state, inLibrary)).toBe(2);
  });

  it("§7 summons a Chaos Golem, the 10/10 token of index 95.1", () => {
    const state = game("chaos-golem");
    const events: GameEvent[] = [];
    const sink = sinkFor(state, events);

    run(sink, summonChaosGolem());

    const summoned = eventsOfType(events, "summoned");
    expect(summoned).toHaveLength(1);
    const card = state.players.p1.units[0]?.[0];
    expect(card).toBeDefined();
    if (card === undefined) return;
    expect(defOf(state, card.defId).index).toBe("95.1");
    expect(unitView(state, card)).toMatchObject({ attack: 10, maxHealth: 10 });
  });

  it("R33 summons 5 random Field Spells or Traps into your backrow, traps face-down", () => {
    const seen = new Set<string>();

    for (const seed of ["b1", "b2", "b3", "b4", "b5", "b6"]) {
      const state = game(`chaos-backrow-${seed}`);
      const events: GameEvent[] = [];
      const sink = sinkFor(state, events);

      run(sink, summonRandomBackrow());

      const summoned = eventsOfType(events, "summoned");
      expect(summoned).toHaveLength(5);
      expect(summoned.every((event) => event.row === "backrow")).toBe(true);
      expect(summoned.map((event) => event.lane)).toEqual([1, 2, 3, 4, 5]);

      for (const card of state.players.p1.backrow) {
        expect(card).not.toBeNull();
        if (card === null) continue;
        const cardDef = defOf(state, card.defId);
        seen.add(cardDef.type);
        expect(["Field Spell", "Trap", "Field Trap"]).toContain(cardDef.type);
        // §3.2 and R33: a Field Spell is public, a Trap or Field Trap stays face-down.
        expect(card.faceUp).toBe(cardDef.type === "Field Spell" ? true : undefined);
      }
    }

    // The pool really does include all three types, Field Traps among them (§8 #95).
    expect(seen).toContain("Field Spell");
    expect(seen).toContain("Trap");
    expect(seen).toContain("Field Trap");
  });

  it("R70 casts a random Call to Chaos: free, counted as a play, and its script resolves", () => {
    // The cast card's script is one of #95's own effects, so its resolution is visible.
    const state = game("chaos-cast", { chaosCry: () => [healHeroThirty()] });
    const events: GameEvent[] = [];
    const sink = sinkFor(state, events);
    state.players.p1.mana.current = 2;
    const self = chaosCard(state, { radiant: true });

    run(sink, castRandomCallToChaos(), self);

    const played = eventsOfType(events, "cardPlayed");
    expect(played).toHaveLength(1);
    expect(played[0]).toMatchObject({ player: "p1", defId: chaos.id, costPaid: 0 });
    // R70: a cast counts as a play for everything that counts plays, and pays nothing.
    expect(state.counters.played).toBe(1);
    expect(state.players.p1.turnLog.cardsPlayed).toBe(1);
    expect(state.players.p1.mana.current).toBe(2);
    // The script ran: heal 30 on the caster's hero.
    expect(state.players.p1.hero.health).toBe(60);

    const cast = state.players.p1.graveyard[0];
    expect(cast).toBeDefined();
    expect(cast?.defId).toBe(chaos.id);
    // R28: only Core exists, so a Radiant #95 still casts the *base* card.
    expect(cast?.radiant).toBe(false);
    // R215: it was the chain's first cast while it resolved, and it has landed (R87) as the printed
    // card again, carrying no link of that chain into whatever brings it back.
    expect(chaosChainOf(cast ?? null)).toBe(0);
  });

  it("R28 the base form rolls exactly one of the ten effects, and all ten are reachable", () => {
    const rolled = new Set<string>();
    for (let seed = 0; seed < 200; seed += 1) {
      const effects = rollChaosEffects(createRng(`base-${seed}`), false);
      expect(effects).toHaveLength(1);
      const name = effects[0]?.name;
      expect(CHAOS_EFFECTS.some((effect) => effect.name === name)).toBe(true);
      if (name !== undefined) rolled.add(name);
    }
    expect(rolled.size).toBe(CHAOS_EFFECTS.length);
    expect(CHAOS_EFFECTS).toHaveLength(10);
  });

  it("R28 the radiant form rolls two effects: the recursion plus one of the other nine", () => {
    const partners = new Set<string>();
    for (let seed = 0; seed < 200; seed += 1) {
      const effects = rollChaosEffects(createRng(`radiant-${seed}`), true);
      expect(effects).toHaveLength(2);
      // §8 lists the recursion first, so it is the first of the two to resolve.
      expect(effects[0]?.name).toBe(CHAOS_RECURSION);
      const partner = effects[1]?.name;
      expect(partner).not.toBe(CHAOS_RECURSION);
      if (partner !== undefined) partners.add(partner);
    }
    // Exactly the other nine are reachable as the partner effect.
    expect(partners.size).toBe(CHAOS_EFFECTS.length - 1);
  });

  it("R28 a radiant Call to Chaos runs both rolled effects, the guaranteed recursion included", () => {
    // A seed whose partner effect is the hero heal, so both halves of the roll are visible at once.
    const seed = Array.from({ length: 50 }, (_, i) => `chaos-radiant-run-${i}`).find(
      (candidate) => rollChaosEffects(createRng(candidate), true)[1]?.name === "heal",
    );
    expect(seed).toBeDefined();
    if (seed === undefined) return;

    // The cast copy resolves into nothing, so every change left belongs to the card that cast it.
    const state = game(seed, { chaosCry: () => [] });
    const events: GameEvent[] = [];
    const sink = sinkFor(state, events);
    const self = chaosCard(state, { radiant: true });

    run(sink, callToChaos(), self);

    // "Cast a random Call to Chaos" always fires …
    expect(eventsOfType(events, "cardPlayed")).toHaveLength(1);
    expect(state.players.p1.graveyard.map((card) => card.defId)).toEqual([chaos.id]);
    // … and so does the one effect drawn from the other nine.
    expect(state.players.p1.hero.health).toBe(60);
  });

  it("R28 caps the recursion at CALL_TO_CHAOS_CHAIN_CAP casts", () => {
    // Every cast copy recurses again, which is the worst case the cap has to stop.
    // Each cast reports the link it is as its own script runs; a test builder, not a card file.
    const depths: number[] = [];
    const state = game("chaos-chain", {
      chaosCry: (ctx) => {
        depths.push(chaosChainOf(ctx.self));
        return [castRandomCallToChaos()];
      },
    });
    const events: GameEvent[] = [];
    const sink = sinkFor(state, events);
    const played = chaosCard(state); // the card the player played: chain 0

    run(sink, castRandomCallToChaos(), played);

    expect(eventsOfType(events, "cardPlayed")).toHaveLength(CALL_TO_CHAOS_CHAIN_CAP);
    expect(state.counters.played).toBe(CALL_TO_CHAOS_CHAIN_CAP);
    expect(state.players.p1.graveyard).toHaveLength(CALL_TO_CHAOS_CHAIN_CAP);

    // The player's card cast link 1, which cast link 2, and so on to the cap.
    expect(depths).toEqual(Array.from({ length: CALL_TO_CHAOS_CHAIN_CAP }, (_, i) => i + 1));
    // R215: each landed in the graveyard (§10.5 step 7, R87) as the printed card again.
    expect(state.players.p1.graveyard.every((card) => chaosChainOf(card) === 0)).toBe(true);
    expect(Math.max(...depths)).toBe(CALL_TO_CHAOS_CHAIN_CAP);
    expect(chaosChainCapReached(CALL_TO_CHAOS_CHAIN_CAP)).toBe(true);
    expect(chaosChainCapReached(CALL_TO_CHAOS_CHAIN_CAP - 1)).toBe(false);
  });

  it("R28 the cap is a hard stop: a cast at the cap resolves into nothing at all", () => {
    const state = game("chaos-cap", { chaosCry: () => [castRandomCallToChaos()] });
    const events: GameEvent[] = [];
    const sink = sinkFor(state, events);
    const atCap = chaosCard(state, { chain: CALL_TO_CHAOS_CHAIN_CAP });
    const before = cloneState(state);

    run(sink, castRandomCallToChaos(), atCap);

    expect(events).toHaveLength(0);
    expect(state.counters.played).toBe(0);
    expect(state.players.p1.graveyard).toHaveLength(0);
    // Not even an instance was created, so the id counter did not move either.
    expect(state.nextId).toBe(before.nextId);
  });

  it("R28 the chain counter is instance state, so two Calls in one turn do not share it", () => {
    const state = game("chaos-two-calls", { chaosCry: () => [castRandomCallToChaos()] });
    const sink = sinkFor(state);

    run(sink, castRandomCallToChaos(), chaosCard(state));
    run(sink, castRandomCallToChaos(), chaosCard(state));

    expect(state.counters.played).toBe(CALL_TO_CHAOS_CHAIN_CAP * 2);
    // §9.3: the counter lives on the instance, so a serialized game resumes with the same chain.
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
  });

  it("§10.7 the same seed rolls the same effects and different seeds roll different ones", () => {
    const first = game("chaos-determinism");
    const second = game("chaos-determinism");
    const selfA = chaosCard(first);
    const selfB = chaosCard(second);

    run(sinkFor(first), callToChaos(), selfA);
    run(sinkFor(second), callToChaos(), selfB);
    expect(cloneState(first)).toEqual(cloneState(second));

    const names = Array.from({ length: 20 }, (_, i) =>
      rollChaosEffects(createRng(`spread-${i}`), false)[0]?.name,
    );
    expect(new Set(names).size).toBeGreaterThan(1);
    expect(rollChaosEffects(createRng("one"), false)[0]?.name).toBe(
      rollChaosEffects(createRng("one"), false)[0]?.name,
    );
  });

  it("R4 a full hand burns what the draw and the added cards cannot fit", () => {
    const state = game("chaos-full-hand");
    const events: GameEvent[] = [];
    const sink = sinkFor(state, events);
    inHand(state, "fx-1", "p1", HAND_CAP);
    setLibrary(state, "p1", ["fx-2", "fx-3", "fx-4"]);

    run(sink, drawLibraryAndGainMana());
    run(sink, addRandomZeroCostCards());

    expect(state.players.p1.hand).toHaveLength(HAND_CAP);
    expect(state.players.p1.library).toHaveLength(0);
    // §2.4, R4: three drawn and three added, all burned to the graveyard.
    expect(eventsOfType(events, "burned")).toHaveLength(6);
    expect(state.players.p1.graveyard).toHaveLength(6);
    expect(state.players.p1.mana.current).toBe(4);
  });

  it("R80 no chaos effect creates a library card, so a full library only ever shrinks", () => {
    const state = game("chaos-library-cap");
    const sink = sinkFor(state);
    setLibrary(state, "p1", Array.from({ length: LIBRARY_CAP }, () => "fx-1"));

    for (const entry of CHAOS_EFFECTS) {
      if (entry.name === CHAOS_RECURSION) continue; // its own test; nothing here reaches a library
      run(sink, entry.build());
      expect(state.players.p1.library.length).toBeLessThanOrEqual(LIBRARY_CAP);
    }
    expect(state.players.p1.library).toHaveLength(0);
  });

  it("R3 and R58 an empty library draws nothing and takes no fatigue", () => {
    const state = game("chaos-empty-library");
    const events: GameEvent[] = [];
    const sink = sinkFor(state, events);

    run(sink, drawLibraryAndGainMana());

    expect(state.players.p1.hand).toHaveLength(0);
    expect(state.players.p1.fatigueCount).toBe(0);
    expect(state.players.p1.hero.health).toBe(30);
    expect(eventsOfType(events, "drawn")).toHaveLength(0);
    // The mana half of the effect still happens.
    expect(state.players.p1.mana.current).toBe(4);
  });

  it("R64 a full board fizzles the token, Golem and backrow summons without touching the enemy", () => {
    const state = game("chaos-full-board");
    const events: GameEvent[] = [];
    const sink = sinkFor(state, events);
    for (let lane = 1; lane <= 5; lane += 1) {
      put(state, "fx-1", slot("p1", "units", lane));
      put(state, trap.id, slot("p1", "backrow", lane));
    }

    run(sink, summonRushTokens());
    run(sink, summonChaosGolem());
    run(sink, summonRandomThreeCostUnits());
    run(sink, summonRandomBackrow());

    expect(eventsOfType(events, "summoned")).toHaveLength(0);
    expect(state.players.p2.units.every((pile) => pile === null)).toBe(true);
    expect(state.players.p2.backrow.every((card) => card === null)).toBe(true);
  });

  it("R64 a locked or reserved zone is skipped, so the summons fill what is left", () => {
    const state = game("chaos-locked");
    const events: GameEvent[] = [];
    const sink = sinkFor(state, events);
    state.players.p1.locks.units[0] = true; // lane 1 Locked (§3.2)
    state.reserved.push({ player: "p1", row: "units", lane: 2 }); // lane 2 held by a Reborn unit

    run(sink, summonRushTokens());

    // Five were asked for; lanes 3, 4 and 5 are all that can take one.
    expect(eventsOfType(events, "summoned").map((event) => event.lane)).toEqual([3, 4, 5]);
    expect(state.players.p1.units[0]).toBeNull();
    expect(state.players.p1.units[1]).toBeNull();
  });
});

describe("what R28 leaves open (R87, M3-T7)", () => {
  it("R87 resolves the radiant pair in written order, leaves a cast card in the graveyard, and rolls no substitute at the cap", () => {
    // 1. Written order: the recursion is first of the two, so its whole chain resolves first.
    for (let seed = 0; seed < 25; seed += 1) {
      expect(rollChaosEffects(createRng(`r87-${seed}`), true)[0]?.name).toBe(CHAOS_RECURSION);
    }

    // 2. A card cast from no zone ends in the caster's graveyard (§10.5 step 7), so a chain feeds
    // Gravedigger and friends rather than vanishing.
    const state = game("r87-graveyard", { chaosCry: () => [healHeroThirty()] });
    const sink = sinkFor(state);
    run(sink, castRandomCallToChaos(), chaosCard(state));
    expect(state.players.p1.graveyard.map((card) => card.defId)).toEqual([chaos.id]);

    // 3. At the cap the recursion does nothing and nothing is rolled in its place: a radiant Call
    // at the cap runs only its partner effect.
    const capped = game("r87-cap", { chaosCry: () => [callToChaos({ radiant: true })] });
    const cappedSink = sinkFor(capped);
    const self = chaosCard(capped, { radiant: true, chain: CALL_TO_CHAOS_CHAIN_CAP });
    expect(chaosChainCapReached(chaosChainOf(self))).toBe(true);

    const rolled = rollChaosEffects(createRng(capped.seed), true);
    expect(rolled[0]?.name).toBe(CHAOS_RECURSION);
    const partner = rolled[1]?.name;

    run(cappedSink, callToChaos({ radiant: true }), self);
    expect(eventsOfType(cappedSink.events, "cardPlayed")).toHaveLength(0);
    expect(capped.counters.played).toBe(0);

    // What is left is exactly the partner effect: the same run on a twin state, with the partner
    // alone, produces the same events in the same order.
    const alone = game("r87-cap", { chaosCry: () => [callToChaos({ radiant: true })] });
    const aloneSink = sinkFor(alone);
    const partnerDef = CHAOS_EFFECTS.find((effect) => effect.name === partner);
    expect(partnerDef).toBeDefined();
    if (partnerDef === undefined) return;
    run(aloneSink, partnerDef.build(), chaosCard(alone, { radiant: true, chain: CALL_TO_CHAOS_CHAIN_CAP }));

    expect(cappedSink.events.map((event) => event.type)).toEqual(
      aloneSink.events.map((event) => event.type),
    );
  });
});
