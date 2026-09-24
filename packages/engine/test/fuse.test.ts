// Fuse and Craft a Card: SPEC §6.3's Fuse row as R77 spells it out, and BUILD M3-T7's `fuse.ts`
// bullet. One test per clause of R77, in the order the ruling writes them.
//
// R77, verbatim: "Fuse creates a transient definition. Its base form sums the ingredients' base
// attack and health, unions their base keywords and tags, and concatenates their base scripts; its
// radiant form does the same with their radiant forms. Its cost is min(sum of the printed costs per
// R65, 4). Its type is the target's, or the ingredients' shared type when there is no target on the
// field (Field Trap if any ingredient is one). Radiant Unlicensed Experimentation fuses the played
// permanent onto each matching permanent separately, one fusion at a time. One ingredient may be a
// target already on the field: the result then keeps that instance, with its zone, position, damage,
// exertion, summonedTurn, counters, memory and radiant flag, and only the other ingredients cease to
// exist, without a Death trigger and without counting as destroyed. The result's buffs are the sum
// of every ingredient's buffs and its granted keywords their union; every other field of the kept
// instance is unchanged, `statsOverride` and the Vanilla flag included. A fused trap has every
// ingredient's trigger condition, runs only the script whose condition was met, and is consumed
// unless it is a Field Trap. Craft a Card fuses two or three cards with no target on the field, and
// its result is a fresh, non-Radiant hand card with `costOverride` 0."
//
// The fixtures are local (`fu-` ids, indexes from 1501, so nothing collides with another test
// file's) because no shared fixture expresses what the two-face clause needs: an ingredient whose
// radiant stats are deliberately *not* double its base, so "the radiant form does the same with
// their radiant forms" is observable rather than a coincidence of doubling.

import type { CardDef, GameEvent } from "@jackioh/shared";
import { describe, expect, it } from "vitest";
import { defOf, registerCatalog, registeredCatalog } from "../src/catalog";
import { FUSE_COST_CAP, HERO_HEALTH } from "../src/config";
import { damage } from "../src/effects";
import { unitView } from "../src/layers";
import { effectiveCost, printedCost } from "../src/mana";
import { runHook } from "../src/resolve";
import type { CardScripts, Script } from "../src/script";
import { registerScripts, registeredScripts, scriptsFor } from "../src/scripts";
import type { CardInstance, GameState } from "../src/state";
import { fuse } from "../src/subsystems/fuse";
import { fireTrapsFor } from "../src/traps";
import { cardAt } from "../src/zones";
import { eventsOfType, inHand, newGame, put, sinkFor, slot } from "./fixtures/harness";

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

let nextIndex = 1500;

function def(name: string, type: CardDef["type"], extra: Partial<CardDef> = {}): CardDef {
  nextIndex += 1;
  return {
    id: `fu-${name}`,
    index: String(nextIndex),
    name: `${name} (fuse)`,
    set: "Core",
    type,
    tags: [],
    rarity: "Common",
    token: false,
    cost: 1,
    base: { keywords: [], text: `${name} base` },
    radiant: { keywords: [], text: `${name} radiant` },
    ...extra,
  };
}

/**
 * Half of every fusion below. 2/3 Taunt on the base face and 3/9 Taunt + Divine Shield on the
 * radiant one: the radiant stats are neither double the base nor the same keywords, so a fused
 * radiant face built out of base forms would read differently from one built out of radiant forms.
 */
const ingredientA = def("ingredient-a", "Unit", {
  tags: ["Human"],
  rarity: "Rare",
  cost: 2,
  base: { attack: 2, health: 3, keywords: [{ kind: "Taunt" }], text: "2/3 Taunt" },
  radiant: {
    attack: 3,
    health: 9,
    keywords: [{ kind: "Taunt" }, { kind: "Divine Shield" }],
    text: "3/9 Taunt, Divine Shield",
  },
});

/** The other half: 1/1 Rush, radiant 5/2 Rush + Cleave — again not a doubling. */
const ingredientB = def("ingredient-b", "Unit", {
  tags: ["Felinor"],
  cost: 1,
  base: { attack: 1, health: 1, keywords: [{ kind: "Rush" }], text: "1/1 Rush" },
  radiant: { attack: 5, health: 2, keywords: [{ kind: "Rush" }, { kind: "Cleave" }], text: "5/2 Rush, Cleave" },
});

/** A 4-cost body, so one fusion's printed costs sum past FUSE_COST_CAP. */
const pricey = def("pricey", "Unit", {
  cost: 4,
  base: { attack: 1, health: 1, keywords: [], text: "1/1" },
  radiant: { attack: 2, health: 2, keywords: [], text: "2/2" },
});

/** R65: an X-cost card's printed cost is the X on the instance. */
const xUnit = def("x-unit", "Unit", {
  cost: "X",
  base: { attack: 1, health: 1, keywords: [], text: "1/1 X" },
  radiant: { attack: 2, health: 2, keywords: [], text: "2/2 X" },
});

/** R65: an embiggen card's printed cost is the price it was played for. */
const embiggenUnit = def("embiggen-unit", "Unit", {
  cost: { base: 2, embiggen: 4 },
  base: { attack: 1, health: 1, keywords: [], text: "1/1 embiggen" },
  radiant: { attack: 2, health: 2, keywords: [], text: "2/2 embiggen" },
});

/** A Field Spell ingredient, so "its type is the target's" has a type to override. */
const fieldy = def("fieldy", "Field Spell", { cost: 1 });

/** Craft a Card's ingredients: plain Spells, two or three of them (#99). */
const spellA = def("spell-a", "Spell");
const spellB = def("spell-b", "Spell");
const spellC = def("spell-c", "Spell");

/** Two traps whose conditions are different events, and one Field Trap (§5.1). */
const trapPlayed = def("trap-played", "Trap", { cost: 1 });
const trapAttack = def("trap-attack", "Trap", { cost: 1 });
const fieldTrapPlayed = def("field-trap-played", "Field Trap", { cost: 1 });

const DEFS: CardDef[] = [
  ingredientA,
  ingredientB,
  pricey,
  xUnit,
  embiggenUnit,
  fieldy,
  spellA,
  spellB,
  spellC,
  trapPlayed,
  trapAttack,
  fieldTrapPlayed,
];

function both(script: Script): CardScripts {
  return { base: script, radiant: script };
}

/** Deal `amount` to the enemy hero, the one visible thing a concatenated script list can do. */
const hit = (amount: number): Script["cry"] => () => [damage({ to: { of: "enemyHero" }, amount })];

const SCRIPTS: Record<string, CardScripts> = {
  // The base texts hit for 1 and 2 and the base Deaths for 3 and 4; the radiant texts hit for 10
  // and 20, so which pair of scripts a fusion concatenated is readable off the hero's health.
  [ingredientA.id]: { base: { cry: hit(1), death: hit(3) }, radiant: { cry: hit(10), death: hit(30) } },
  [ingredientB.id]: { base: { cry: hit(2), death: hit(4) }, radiant: { cry: hit(20), death: hit(40) } },
  [trapPlayed.id]: both({
    triggers: [{ id: "on-play", on: ["cardPlayed"], run: () => [damage({ to: { of: "enemyHero" }, amount: 1 })] }],
  }),
  [trapAttack.id]: both({
    triggers: [
      { id: "on-attack", on: ["attackDeclared"], run: () => [damage({ to: { of: "enemyHero" }, amount: 2 })] },
    ],
  }),
  [fieldTrapPlayed.id]: both({
    triggers: [{ id: "on-play", on: ["cardPlayed"], run: () => [damage({ to: { of: "enemyHero" }, amount: 5 })] }],
  }),
};

/** A game whose catalog and script registry also carry this file's fixtures (BUILD §0). */
function game(seed: string): GameState {
  const state = newGame(seed);
  registerCatalog({ ...registeredCatalog(), ...Object.fromEntries(DEFS.map((entry) => [entry.id, entry])) });
  registerScripts({ ...registeredScripts(), ...SCRIPTS });
  state.turn = 4;
  state.active = "p1";
  state.phase = "main";
  return state;
}

function must(card: CardInstance | null | undefined, what: string): CardInstance {
  if (card === null || card === undefined) throw new Error(`expected ${what}`);
  return card;
}

function keywordKinds(keywords: readonly { kind: string }[]): string[] {
  return keywords.map((keyword) => keyword.kind).sort();
}

// ---------------------------------------------------------------------------
// The transient definition.
// ---------------------------------------------------------------------------

describe("Fuse: the transient definition (R77, M3-T7)", () => {
  it("R77 fuse creates a transient definition and registers its new defId in state.transientDefs", () => {
    const state = game("fuse-transient");
    const target = put(state, ingredientA.id, slot("p1", "units", 1));
    const food = put(state, ingredientB.id, slot("p1", "units", 2));

    expect(Object.keys(state.transientDefs)).toEqual([]);
    const result = must(fuse(sinkFor(state), { ingredients: [target, food], target }), "a fusion");

    // A def id that is not a catalog id: it lives in the state, where `defOf` finds it first (§10.1).
    expect(result.defId).not.toBe(ingredientA.id);
    expect(Object.keys(state.transientDefs)).toEqual([result.defId]);
    expect(state.transientDefs[result.defId]?.id).toBe(result.defId);
    expect(defOf(state, result.defId)).toBe(state.transientDefs[result.defId]);

    // A second fusion is its own definition, so the first one is never edited (§10.1).
    const other = put(state, ingredientA.id, slot("p1", "units", 3));
    const otherFood = put(state, ingredientB.id, slot("p1", "units", 4));
    const second = must(fuse(sinkFor(state), { ingredients: [other, otherFood], target: other }), "a second fusion");
    expect(second.defId).not.toBe(result.defId);
    expect(Object.keys(state.transientDefs).sort()).toEqual([result.defId, second.defId].sort());
  });

  it("R77 sums the ingredients' base attack and health, and does the same with the radiant forms", () => {
    const state = game("fuse-both-faces");
    const target = put(state, ingredientA.id, slot("p1", "units", 1)); // base 2/3, radiant 3/9
    const food = put(state, ingredientB.id, slot("p1", "units", 2)); // base 1/1, radiant 5/2

    const result = must(fuse(sinkFor(state), { ingredients: [target, food], target }), "a fusion");
    const fused = defOf(state, result.defId);

    // Each face is built from that face of every ingredient, never from the base forms twice.
    expect({ attack: fused.base.attack, health: fused.base.health }).toEqual({ attack: 3, health: 4 });
    expect({ attack: fused.radiant.attack, health: fused.radiant.health }).toEqual({ attack: 8, health: 11 });

    // And the layers read them (§10.4 layer 1): the running face is the instance's.
    expect(result.radiant).toBe(false);
    expect(unitView(state, result)).toMatchObject({ attack: 3, maxHealth: 4 });
    result.radiant = true;
    expect(unitView(state, result)).toMatchObject({ attack: 8, maxHealth: 11 });
  });

  it("R77 unions the base keywords and the tags, and takes the radiant keywords from the radiant forms", () => {
    const state = game("fuse-keywords");
    const target = put(state, ingredientA.id, slot("p1", "units", 1)); // Taunt / Taunt + Divine Shield
    const food = put(state, ingredientB.id, slot("p1", "units", 2)); // Rush / Rush + Cleave

    const result = must(fuse(sinkFor(state), { ingredients: [target, food], target }), "a fusion");
    const fused = defOf(state, result.defId);

    expect(keywordKinds(fused.base.keywords)).toEqual(["Rush", "Taunt"]);
    expect(keywordKinds(fused.radiant.keywords)).toEqual(["Cleave", "Divine Shield", "Rush", "Taunt"]);
    // A union, so the keyword both ingredients share appears once.
    expect(fused.base.keywords.filter((keyword) => keyword.kind === "Taunt")).toHaveLength(1);
    expect([...fused.tags].sort()).toEqual(["Felinor", "Human"]);
  });

  it("R77 concatenates the base scripts, so both ingredients' Cry and Death lists run", () => {
    const state = game("fuse-scripts");
    const sink = sinkFor(state);
    const target = put(state, ingredientA.id, slot("p1", "units", 1)); // Cry 1, Death 3
    const food = put(state, ingredientB.id, slot("p1", "units", 2)); // Cry 2, Death 4

    const result = must(fuse(sink, { ingredients: [target, food], target }), "a fusion");
    const fusedScripts = scriptsFor(result.defId);
    expect(fusedScripts.base.cry).toBeDefined();
    expect(fusedScripts.base.death).toBeDefined();

    runHook(sink, result, "cry");
    expect(state.players.p2.hero.health).toBe(HERO_HEALTH - 3); // 1 + 2

    runHook(sink, result, "death");
    expect(state.players.p2.hero.health).toBe(HERO_HEALTH - 3 - 7); // 3 + 4
  });

  it("R77 concatenates the radiant scripts separately, so a Radiant fusion runs the radiant texts", () => {
    const state = game("fuse-radiant-scripts");
    const sink = sinkFor(state);
    const target = put(state, ingredientA.id, slot("p1", "units", 1), { radiant: true }); // radiant Cry 10
    const food = put(state, ingredientB.id, slot("p1", "units", 2)); // radiant Cry 20

    const result = must(fuse(sink, { ingredients: [target, food], target }), "a fusion");
    expect(result.radiant).toBe(true);

    // The running face is the radiant one (§5.2), and it is the radiant texts that were fused.
    runHook(sink, result, "cry");
    expect(state.players.p2.hero.health).toBe(HERO_HEALTH - 30); // 10 + 20

    // The base face of the same definition still holds the base pair.
    result.radiant = false;
    runHook(sink, result, "cry");
    expect(state.players.p2.hero.health).toBe(HERO_HEALTH - 30 - 3); // 1 + 2
  });

  it("R77 costs min(sum of the printed costs, FUSE_COST_CAP)", () => {
    const under = game("fuse-cost-under");
    const targetA = put(under, ingredientA.id, slot("p1", "units", 1)); // cost 2
    const foodA = put(under, ingredientB.id, slot("p1", "units", 2)); // cost 1
    const cheap = must(fuse(sinkFor(under), { ingredients: [targetA, foodA], target: targetA }), "a fusion");
    expect(defOf(under, cheap.defId).cost).toBe(3);
    expect(3).toBeLessThan(FUSE_COST_CAP);

    const over = game("fuse-cost-capped");
    const targetB = put(over, ingredientA.id, slot("p1", "units", 1)); // cost 2
    const foodB = put(over, pricey.id, slot("p1", "units", 2)); // cost 4
    const capped = must(fuse(sinkFor(over), { ingredients: [targetB, foodB], target: targetB }), "a fusion");
    expect(defOf(over, capped.defId).cost).toBe(Math.min(2 + 4, FUSE_COST_CAP));
    expect(defOf(over, capped.defId).cost).toBe(FUSE_COST_CAP);
  });

  it("R77 sums the printed costs per R65: an X card counts its X and an embiggen card its price", () => {
    const state = game("fuse-cost-r65");
    const target = put(state, xUnit.id, slot("p1", "units", 1));
    target.x = 1;
    const [food] = inHand(state, embiggenUnit.id, "p1");
    const embiggen = must(food, "an embiggen ingredient");

    expect(printedCost(state, target)).toBe(1);
    expect(printedCost(state, embiggen)).toBe(2);
    const base = must(fuse(sinkFor(state), { ingredients: [target, embiggen], target }), "a fusion");
    expect(defOf(state, base.defId).cost).toBe(3);

    // The chosen embiggen price is the printed cost of the card that was played for it (R65).
    const other = game("fuse-cost-r65-embiggened");
    const target2 = put(other, xUnit.id, slot("p1", "units", 1));
    target2.x = 1;
    const bigger = must(inHand(other, embiggenUnit.id, "p1")[0], "an embiggen ingredient");
    bigger.embiggened = true;
    expect(printedCost(other, bigger)).toBe(4);
    const capped = must(fuse(sinkFor(other), { ingredients: [target2, bigger], target: target2 }), "a fusion");
    expect(defOf(other, capped.defId).cost).toBe(Math.min(1 + 4, FUSE_COST_CAP));
  });

  it("R77 takes the target's type when an ingredient is a target on the field", () => {
    const state = game("fuse-type-target");
    const target = put(state, ingredientA.id, slot("p1", "units", 1)); // Unit
    const food = must(inHand(state, fieldy.id, "p1")[0], "a Field Spell ingredient"); // Field Spell

    const result = must(fuse(sinkFor(state), { ingredients: [target, food], target }), "a fusion");
    expect(defOf(state, result.defId).type).toBe("Unit");
  });

  it("R77 takes the ingredients' shared type when there is no target on the field", () => {
    const state = game("fuse-type-shared");
    const a = must(inHand(state, spellA.id, "p1")[0], "a Spell");
    const b = must(inHand(state, spellB.id, "p1")[0], "another Spell");

    const crafted = must(fuse(sinkFor(state), { ingredients: [a, b], toHand: "p1" }), "a crafted card");
    expect(defOf(state, crafted.defId).type).toBe("Spell");
  });

  it("R77 makes the result a Field Trap when an ingredient is one and no target is on the field", () => {
    const state = game("fuse-type-field-trap");
    const plainTrap = must(inHand(state, trapPlayed.id, "p1")[0], "a Trap");
    const field = must(inHand(state, fieldTrapPlayed.id, "p1")[0], "a Field Trap");

    const crafted = must(fuse(sinkFor(state), { ingredients: [plainTrap, field], toHand: "p1" }), "a crafted card");
    expect(defOf(state, crafted.defId).type).toBe("Field Trap");

    // Two plain Traps share their type and stay one (§5.1).
    const two = game("fuse-type-two-traps");
    const first = must(inHand(two, trapPlayed.id, "p1")[0], "a Trap");
    const second = must(inHand(two, trapAttack.id, "p1")[0], "another Trap");
    const plainResult = must(fuse(sinkFor(two), { ingredients: [first, second], toHand: "p1" }), "a crafted card");
    expect(defOf(two, plainResult.defId).type).toBe("Trap");
  });
});

// ---------------------------------------------------------------------------
// The kept instance, and the ingredients that cease to exist.
// ---------------------------------------------------------------------------

describe("Fuse: the instance the result keeps (R77, M3-T7)", () => {
  it("R77 keeps the target instance with its zone, position, damage, exertion, summonedTurn, counters, memory and radiant flag", () => {
    const state = game("fuse-keeps-instance");
    const target = put(state, ingredientA.id, slot("p1", "units", 3), { radiant: true });
    const food = put(state, ingredientB.id, slot("p1", "units", 1));

    target.position = "DEF";
    target.damage = 2;
    target.exertion = { attacked: true, switched: false };
    target.summonedTurn = 2;
    target.counters = { plague: 3, grade: 1 };
    target.memory = { meal: "felinor" };

    const result = must(fuse(sinkFor(state), { ingredients: [target, food], target }), "a fusion");

    // The result *is* that card: same instance id, still in its own zone.
    expect(result.id).toBe(target.id);
    expect(result.zone).toEqual({ z: "field", player: "p1", row: "units", lane: 3 });
    expect(must(cardAt(state, slot("p1", "units", 3)), "the fused card").id).toBe(target.id);
    expect(result.position).toBe("DEF");
    expect(result.damage).toBe(2);
    expect(result.exertion).toEqual({ attacked: true, switched: false });
    expect(result.summonedTurn).toBe(2);
    expect(result.counters).toEqual({ plague: 3, grade: 1 });
    expect(result.memory).toEqual({ meal: "felinor" });
    expect(result.radiant).toBe(true);
  });

  it("R77 sums every ingredient's buffs and unions their granted keywords", () => {
    const state = game("fuse-buffs");
    const target = put(state, ingredientA.id, slot("p1", "units", 1));
    const food = put(state, ingredientB.id, slot("p1", "units", 2));

    target.buffs = { attack: 1, health: 2 };
    target.grantedKeywords = [{ kind: "Lifesteal" }, { kind: "Taunt" }];
    food.buffs = { attack: 3, health: -1 };
    food.grantedKeywords = [{ kind: "Taunt" }, { kind: "Charge" }];

    const result = must(fuse(sinkFor(state), { ingredients: [target, food], target }), "a fusion");

    expect(result.buffs).toEqual({ attack: 4, health: 1 });
    expect(keywordKinds(result.grantedKeywords)).toEqual(["Charge", "Lifesteal", "Taunt"]);
    // Layer 4 sits on top of the fused printed stats (§10.4): 3/4 printed plus +4/+1.
    expect(unitView(state, result)).toMatchObject({ attack: 7, maxHealth: 5 });
  });

  it("R77 leaves every other field of the kept instance unchanged, the Vanilla flag included, and sums its statsOverride into the fused face", () => {
    const state = game("fuse-other-fields");
    const target = put(state, ingredientA.id, slot("p1", "units", 1));
    const food = put(state, ingredientB.id, slot("p1", "units", 2));

    target.statsOverride = { attack: 7, health: 7 };
    target.vanilla = true;
    target.costMod = 2;
    target.costOverride = 1;
    target.divineShieldSpent = true;
    target.lastDamagedBy = "c99";
    target.faceUp = true;
    target.tauntSuppressedTurn = state.turn;

    const result = must(fuse(sinkFor(state), { ingredients: [target, food], target }), "a fusion");

    // §7, R175: the token's X/X is its printed face, so the fusion sums it (7/7 + 1/1) into the
    // fused definition, and the override leaves the instance rather than hiding that sum.
    expect(result.statsOverride).toBeUndefined();
    const fusedDef = state.transientDefs[result.defId];
    expect(fusedDef?.base).toMatchObject({ attack: 8, health: 8 });
    expect(fusedDef?.radiant).toMatchObject({ attack: 12, health: 9 });
    expect(result.vanilla).toBe(true);
    expect(result.costMod).toBe(2);
    expect(result.costOverride).toBe(1);
    expect(result.divineShieldSpent).toBe(true);
    expect(result.lastDamagedBy).toBe("c99");
    expect(result.faceUp).toBe(true);
    expect(result.tauntSuppressedTurn).toBe(state.turn);
    expect(result.owner).toBe("p1");
    expect(result.controller).toBe("p1");

    // Layer 1 reads the fused face, and Vanilla still clears the fused printed keywords while the
    // granted ones stay.
    expect(unitView(state, result)).toMatchObject({ attack: 8, maxHealth: 8, keywords: [] });
  });

  it("R77 the other ingredients cease to exist, without a Death trigger and without counting as destroyed", () => {
    const state = game("fuse-ingredients-gone");
    const events: GameEvent[] = [];
    const target = put(state, ingredientA.id, slot("p1", "units", 1));
    const food = put(state, ingredientB.id, slot("p1", "units", 2)); // Death: 4 to the enemy hero

    const before = state.counters.destroyed;
    const result = must(fuse(sinkFor(state, events), { ingredients: [target, food], target }), "a fusion");
    expect(result.id).toBe(target.id);

    // Off the field and in no pile at all: `{ z: "gone" }` (§10.1, R86).
    expect(cardAt(state, slot("p1", "units", 2))).toBeNull();
    expect(food.zone).toEqual({ z: "gone", player: "p1" });
    expect(state.players.p1.graveyard).toEqual([]);
    expect(state.players.p1.exile).toEqual([]);

    // Not a death and not a destruction: no events, no counter, and the Death script never ran.
    expect(eventsOfType(events, "destroyed")).toEqual([]);
    expect(eventsOfType(events, "enteredGraveyard")).toEqual([]);
    expect(state.counters.destroyed).toBe(before);
    expect(state.players.p2.hero.health).toBe(HERO_HEALTH);

    // What it does emit is one `fused` event naming every ingredient and the result (§10.3).
    expect(eventsOfType(events, "fused")).toEqual([
      {
        type: "fused",
        instanceIds: [target.id, food.id],
        resultInstanceId: target.id,
        defId: result.defId,
      },
    ]);
  });

  it("R77 radiant Unlicensed Experimentation fuses onto each matching permanent separately, one fusion at a time", () => {
    // #85r's loop is the card's (M4); what the engine promises is that each fusion is its own,
    // with its own transient definition and its own kept instance, rather than one fusion of
    // everything at once.
    const state = game("fuse-one-at-a-time");
    const sink = sinkFor(state);
    const first = put(state, ingredientA.id, slot("p1", "units", 1));
    const second = put(state, ingredientA.id, slot("p1", "units", 2));
    const played = put(state, ingredientB.id, slot("p2", "units", 1));

    const one = must(fuse(sink, { ingredients: [played], target: first }), "the first fusion");
    expect(one.id).toBe(first.id);
    expect(played.zone).toEqual({ z: "gone", player: "p2" });

    // The second fusion is a separate call with a separate copy of the played permanent, and it
    // leaves the first fusion's card and definition alone.
    const again = put(state, ingredientB.id, slot("p2", "units", 2));
    const two = must(fuse(sink, { ingredients: [again], target: second }), "the second fusion");
    expect(two.id).toBe(second.id);
    expect(two.defId).not.toBe(one.defId);
    expect(Object.keys(state.transientDefs).sort()).toEqual([one.defId, two.defId].sort());
    expect(unitView(state, one)).toMatchObject({ attack: 3, maxHealth: 4 });
    expect(unitView(state, two)).toMatchObject({ attack: 3, maxHealth: 4 });
  });
});

// ---------------------------------------------------------------------------
// Fused traps and Craft a Card.
// ---------------------------------------------------------------------------

describe("Fuse: traps and Craft a Card (R77, M3-T7)", () => {
  it("R77 a fused trap has every ingredient's trigger condition and runs only the script whose condition was met", () => {
    const state = game("fuse-trap-conditions");
    const sink = sinkFor(state);
    const target = put(state, trapPlayed.id, slot("p1", "backrow", 1)); // fires on cardPlayed, for 1
    const food = must(inHand(state, trapAttack.id, "p1")[0], "a second trap"); // fires on attackDeclared, for 2

    const result = must(fuse(sink, { ingredients: [target, food], target }), "a fused trap");
    const triggers = scriptsFor(result.defId).base.triggers ?? [];
    expect(triggers.flatMap((trigger) => trigger.on).sort()).toEqual(["attackDeclared", "cardPlayed"]);
    // Two conditions, so two distinct trigger ids survive the fusion.
    expect(new Set(triggers.map((trigger) => trigger.id)).size).toBe(2);

    // Only the script whose condition was met runs: the `cardPlayed` half hits for 1, not for 3.
    fireTrapsFor(sink, {
      type: "cardPlayed",
      player: "p2",
      instanceId: "c999",
      defId: ingredientA.id,
      costPaid: 1,
    });
    expect(state.players.p2.hero.health).toBe(HERO_HEALTH - 1);
  });

  it("R77 a fused trap is consumed unless it is a Field Trap", () => {
    const consumed = game("fuse-trap-consumed");
    const consumedSink = sinkFor(consumed);
    const plainTarget = put(consumed, trapPlayed.id, slot("p1", "backrow", 1));
    const extra = must(inHand(consumed, trapAttack.id, "p1")[0], "a second trap");
    const plainResult = must(
      fuse(consumedSink, { ingredients: [plainTarget, extra], target: plainTarget }),
      "a fused Trap",
    );
    expect(defOf(consumed, plainResult.defId).type).toBe("Trap");

    fireTrapsFor(consumedSink, {
      type: "cardPlayed",
      player: "p2",
      instanceId: "c999",
      defId: ingredientA.id,
      costPaid: 1,
    });
    expect(cardAt(consumed, slot("p1", "backrow", 1))).toBeNull();
    expect(consumed.players.p1.graveyard.map((card) => card.id)).toEqual([plainResult.id]);

    // A Field Trap target keeps the type, so the fused trap stays and can fire again (§5.1).
    const stays = game("fuse-field-trap-stays");
    const staysSink = sinkFor(stays);
    const fieldTarget = put(stays, fieldTrapPlayed.id, slot("p1", "backrow", 1));
    const other = must(inHand(stays, trapAttack.id, "p1")[0], "a second trap");
    const fieldResult = must(
      fuse(staysSink, { ingredients: [fieldTarget, other], target: fieldTarget }),
      "a fused Field Trap",
    );
    expect(defOf(stays, fieldResult.defId).type).toBe("Field Trap");

    const played = {
      type: "cardPlayed" as const,
      player: "p2" as const,
      instanceId: "c999",
      defId: ingredientA.id,
      costPaid: 1,
    };
    fireTrapsFor(staysSink, played);
    fireTrapsFor(staysSink, played);
    expect(must(cardAt(stays, slot("p1", "backrow", 1)), "the field trap").id).toBe(fieldResult.id);
    expect(stays.players.p1.graveyard).toEqual([]);
    expect(stays.players.p2.hero.health).toBe(HERO_HEALTH - 10); // 5 twice
  });

  it("R77 Craft a Card fuses two or three cards with no target, giving a fresh non-Radiant hand card with costOverride 0", () => {
    const state = game("fuse-craft");
    const sink = sinkFor(state);
    const a = must(inHand(state, spellA.id, "p1")[0], "a Spell");
    const b = must(inHand(state, spellB.id, "p1")[0], "another Spell");
    a.radiant = true; // a Radiant ingredient still crafts a non-Radiant result

    const two = must(fuse(sink, { ingredients: [a, b], toHand: "p1" }), "a crafted card");
    expect(two.id).not.toBe(a.id);
    expect(two.id).not.toBe(b.id);
    expect(two.radiant).toBe(false);
    expect(two.costOverride).toBe(0);
    expect(effectiveCost(state, two)).toBe(0);
    expect(two.zone).toEqual({ z: "hand", player: "p1" });
    expect(state.players.p1.hand.map((card) => card.id)).toEqual([two.id]);
    expect(a.zone).toEqual({ z: "gone", player: "p1" });
    expect(b.zone).toEqual({ z: "gone", player: "p1" });

    // Three cards craft the same way, and the cost is still min(sum, cap).
    const three = game("fuse-craft-three");
    const [x, y, z] = [spellA, spellB, spellC].map((entry) =>
      must(inHand(three, entry.id, "p1")[0], `${entry.id} in hand`),
    );
    const crafted = must(
      fuse(sinkFor(three), { ingredients: [must(x, "x"), must(y, "y"), must(z, "z")], toHand: "p1" }),
      "a crafted card",
    );
    expect(defOf(three, crafted.defId).cost).toBe(Math.min(3, FUSE_COST_CAP));
    expect(crafted.costOverride).toBe(0);
    expect(three.players.p1.hand.map((card) => card.id)).toEqual([crafted.id]);

    // Fewer than two cards is not a fusion, and neither is one with nowhere to put the result.
    const lone = game("fuse-craft-one");
    const only = must(inHand(lone, spellA.id, "p1")[0], "a Spell");
    const pair = must(inHand(lone, spellB.id, "p1")[0], "another Spell");
    expect(fuse(sinkFor(lone), { ingredients: [only], toHand: "p1" })).toBeNull();
    expect(fuse(sinkFor(lone), { ingredients: [only, pair] })).toBeNull();
    expect(Object.keys(lone.transientDefs)).toEqual([]);
  });
});
