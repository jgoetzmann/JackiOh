// The buff and grantKeyword effects (BUILD M3-T1): layer 4 of §10.4, under the auras of layer 5,
// plus §6.1's keyword set, Armor summing across sources, and R21's random keyword pool.
// The all-keyword fixture unit this file needs is defined and registered here (BUILD §0).

import type { CardDef, GameEvent, Keyword, PlayerId, Selection } from "@jackioh/shared";
import { armorOf, hasKeyword } from "@jackioh/shared";
import { describe, expect, it } from "vitest";
import { registerCatalog, registeredCatalog } from "../src/catalog";
import { RANDOM_KEYWORD_POOL } from "../src/config";
import { dealDamage } from "../src/damage";
import { buff, buffAllUnits, grantKeyword, grantRandomKeywords } from "../src/effects/buff";
import { unitHas, unitView } from "../src/layers";
import type { EngineSink } from "../src/resolve";
import { makeContext } from "../src/resolve";
import type { Effect } from "../src/script";
import { registerScripts, registeredScripts } from "../src/scripts";
import type { CardInstance, GameState } from "../src/state";
import { moveToZone } from "../src/zones";
import { plain, shielded, spikeyPillow, taunter, zeroAttack } from "./fixtures/combat";
import { eventsOfType, newGame, put, sinkFor, slot } from "./fixtures/harness";

/** A unit holding every keyword in R21's pool, so the pool can run dry. */
const POOL_KEYWORDS: Keyword[] = [
  { kind: "Taunt" },
  { kind: "Armor", n: 1 },
  { kind: "Rush" },
  { kind: "Charge" },
  { kind: "First Strike" },
  { kind: "Poisonous" },
  { kind: "Lifesteal" },
  { kind: "Reborn" },
  { kind: "Divine Shield" },
  { kind: "Trample" },
  { kind: "Cleave" },
];

const everyKeyword: CardDef = {
  id: "bf-every-keyword",
  index: "901",
  name: "Every Keyword (buff fixture)",
  set: "Core",
  type: "Unit",
  tags: [],
  rarity: "Common",
  token: false,
  cost: 1,
  base: { attack: 2, health: 2, keywords: POOL_KEYWORDS, text: "every pool keyword" },
  radiant: { attack: 4, health: 4, keywords: POOL_KEYWORDS, text: "every pool keyword" },
};

function game(seed: string): GameState {
  const state = newGame(seed);
  registerCatalog({ ...registeredCatalog(), [everyKeyword.id]: everyKeyword });
  registerScripts({ ...registeredScripts(), [everyKeyword.id]: { base: {}, radiant: {} } });
  return state;
}

/** Apply one effect the way the engine does: a context over the sink, then `apply` (§10.9). */
function run(
  sink: EngineSink,
  effect: Effect,
  options: { self?: CardInstance | null; controller?: PlayerId; targets?: Selection[] } = {},
): void {
  const { self = null, ...rest } = options;
  effect.apply(makeContext(sink, self, rest));
}

function onInstance(instance: CardInstance): Selection[] {
  return [{ pick: "instance", instanceId: instance.id }];
}

function grantedKinds(events: readonly GameEvent[]): string[] {
  return eventsOfType(events, "keywordGranted").map((e) => e.keyword.kind);
}

describe("buff (§10.4 layer 4, M3-T1)", () => {
  it("adds to buffs.attack and buffs.health permanently and emits the change", () => {
    const state = game("buff-basic");
    const unit = put(state, plain.id, slot("p1", "units", 1)); // 3/3
    const sink = sinkFor(state);

    run(sink, buff({ target: { of: "chosen" }, attack: 2, health: 3 }), { targets: onInstance(unit) });

    expect(unit.buffs).toEqual({ attack: 2, health: 3 });
    expect(unitView(state, unit).attack).toBe(5);
    expect(unitView(state, unit).maxHealth).toBe(6);
    expect(unitView(state, unit).health).toBe(6);
    expect(eventsOfType(sink.events, "buffed")).toEqual([
      { type: "buffed", instanceId: unit.id, attack: 2, health: 3 },
    ]);

    // A second buff accumulates, and a damaged unit keeps its damage: health = max − damage.
    dealDamage(sink, { source: null, target: { kind: "unit", instance: unit }, amount: 4 });
    run(sink, buff({ target: { of: "self" }, attack: 1, health: 1 }), { self: unit });
    expect(unit.buffs).toEqual({ attack: 3, health: 4 });
    expect(unitView(state, unit).maxHealth).toBe(7);
    expect(unitView(state, unit).health).toBe(3);
    expect(eventsOfType(sink.events, "buffed")).toHaveLength(2);
  });

  it("is layer 4, so an aura adds on top of it without touching the stored buff (§10.4 layer 5)", () => {
    const state = game("buff-layers");
    const unit = put(state, plain.id, slot("p1", "units", 1)); // 3/3
    const sink = sinkFor(state);

    run(sink, buff({ target: { of: "self" }, attack: 3, health: 3 }), { self: unit });
    expect(unitView(state, unit).attack).toBe(6);

    // Spikey Pillow's aura: your units have −2 attack, applied after the buff.
    put(state, spikeyPillow.id, slot("p1", "units", 2));
    expect(unitView(state, unit).attack).toBe(4);
    expect(unit.buffs.attack).toBe(3);

    // §10.4: attack floors at 0 in the aura layer, and the buff below it is still on the instance.
    const weakling = put(state, zeroAttack.id, slot("p1", "units", 3)); // 0/8
    run(sink, buff({ target: { of: "self" }, attack: 1 }), { self: weakling });
    expect(unitView(state, weakling).attack).toBe(0);
    expect(weakling.buffs.attack).toBe(1);
  });

  it("R78: a buff is dropped when the card leaves the field", () => {
    const state = game("buff-leaves");
    const unit = put(state, plain.id, slot("p1", "units", 1));
    const sink = sinkFor(state);

    run(sink, buff({ target: { of: "self" }, attack: 4, health: 4 }), { self: unit });
    expect(unit.buffs).toEqual({ attack: 4, health: 4 });

    moveToZone(state, unit, "hand");
    expect(unit.buffs).toEqual({ attack: 0, health: 0 });
  });

  it("buffs every unit you control in lane order and leaves the enemy board alone", () => {
    const state = game("buff-all");
    const first = put(state, plain.id, slot("p1", "units", 1));
    const third = put(state, plain.id, slot("p1", "units", 3));
    const enemy = put(state, plain.id, slot("p2", "units", 1));
    const sink = sinkFor(state);

    run(sink, buffAllUnits({ attack: 1, health: 1 }), { controller: "p1" });

    expect(eventsOfType(sink.events, "buffed").map((e) => e.instanceId)).toEqual([first.id, third.id]);
    expect(unitView(state, first).attack).toBe(4);
    expect(unitView(state, third).attack).toBe(4);
    expect(enemy.buffs).toEqual({ attack: 0, health: 0 });

    // The enemy form reaches only the other side.
    run(sink, buffAllUnits({ side: "enemy", attack: 2 }), { controller: "p1" });
    expect(enemy.buffs).toEqual({ attack: 2, health: 0 });
    expect(first.buffs).toEqual({ attack: 1, health: 1 });
  });

  it("does nothing to a hero target, and a +0/+0 buff emits nothing", () => {
    const state = game("buff-fizzle");
    const unit = put(state, plain.id, slot("p1", "units", 1));
    const sink = sinkFor(state);

    run(sink, buff({ target: { of: "enemyHero" }, attack: 5, health: 5 }), { controller: "p1" });
    run(sink, buff({ target: { of: "chosen" }, attack: 5 }), { targets: [] });
    run(sink, buff({ target: { of: "self" }, attack: 0, health: 0 }), { self: unit });

    expect(sink.events).toHaveLength(0);
    expect(unit.buffs).toEqual({ attack: 0, health: 0 });
    expect(state.players.p2.hero).toEqual({ health: 30, armor: 0 });
  });
});

describe("grantKeyword (§6.1, §10.4, M3-T1)", () => {
  it("adds to grantedKeywords, shows in the view, and emits keywordGranted", () => {
    const state = game("grant-basic");
    const unit = put(state, plain.id, slot("p1", "units", 1));
    const sink = sinkFor(state);

    run(sink, grantKeyword({ target: { of: "chosen" }, keyword: { kind: "Taunt" } }), {
      targets: onInstance(unit),
    });

    expect(unit.grantedKeywords).toEqual([{ kind: "Taunt" }]);
    expect(unitHas(state, unit, "Taunt")).toBe(true);
    expect(eventsOfType(sink.events, "keywordGranted")).toEqual([
      { type: "keywordGranted", instanceId: unit.id, keyword: { kind: "Taunt" } },
    ]);

    // Keywords are a set (§10.4): the same kind is not stored twice.
    run(sink, grantKeyword({ target: { of: "self" }, keyword: { kind: "Taunt" } }), { self: unit });
    expect(unit.grantedKeywords).toEqual([{ kind: "Taunt" }]);

    // R78: the grant goes when the card leaves the field.
    moveToZone(state, unit, "hand");
    expect(unit.grantedKeywords).toEqual([]);
  });

  it("§6.1: Armor sums across sources, so a granted Armor 1 adds to printed Armor and Defense", () => {
    const state = game("grant-armor");
    const unit = put(state, taunter.id, slot("p1", "units", 1));
    const sink = sinkFor(state);

    run(sink, grantKeyword({ target: { of: "self" }, keyword: { kind: "Armor", n: 3 } }), { self: unit });
    expect(unitView(state, unit).armor).toBe(3);

    // Armor carries a number, so a second grant stacks instead of being folded into the first.
    run(sink, grantKeyword({ target: { of: "self" }, keyword: { kind: "Armor", n: 1 } }), { self: unit });
    expect(unitView(state, unit).armor).toBe(4);
    expect(unit.grantedKeywords).toEqual([{ kind: "Armor", n: 3 }, { kind: "Armor", n: 1 }]);

    // Defense Position adds its own +1 on top (§4.1).
    unit.position = "DEF";
    expect(unitView(state, unit).armor).toBe(5);
    expect(armorOf(unitView(state, unit).keywords)).toBe(5);
  });

  it("granting Divine Shield to a unit whose shield was spent makes the shield work again (§10.4)", () => {
    const state = game("grant-shield");
    const unit = put(state, shielded.id, slot("p2", "units", 1)); // 2/2, Divine Shield
    const sink = sinkFor(state);

    expect(dealDamage(sink, { source: null, target: { kind: "unit", instance: unit }, amount: 5 })).toBe(0);
    expect(unit.divineShieldSpent).toBe(true);
    expect(unitHas(state, unit, "Divine Shield")).toBe(false);

    run(sink, grantKeyword({ target: { of: "self" }, keyword: { kind: "Divine Shield" } }), { self: unit });

    expect(unit.divineShieldSpent).toBeUndefined();
    expect(unitHas(state, unit, "Divine Shield")).toBe(true);
    expect(dealDamage(sink, { source: null, target: { kind: "unit", instance: unit }, amount: 5 })).toBe(0);
    expect(unit.damage).toBe(0);
    expect(unit.divineShieldSpent).toBe(true);
  });

  it("granting Reborn to a unit that already used it makes Reborn available again (§10.4)", () => {
    const state = game("grant-reborn");
    const unit = put(state, plain.id, slot("p1", "units", 1));
    unit.rebornSpent = true;
    const sink = sinkFor(state);

    run(sink, grantKeyword({ target: { of: "self" }, keyword: { kind: "Reborn" } }), { self: unit });

    expect(unit.rebornSpent).toBeUndefined();
    expect(unitHas(state, unit, "Reborn")).toBe(true);
  });
});

describe("R21 random keywords (M3-T1)", () => {
  it("R21 draws from the pool, never repeats within one grant, and is seeded", () => {
    const state = game("random-kw");
    const unit = put(state, plain.id, slot("p1", "units", 1));
    const sink = sinkFor(state);

    run(sink, grantRandomKeywords({ target: { of: "chosen" }, count: 2 }), { targets: onInstance(unit) });

    const kinds = grantedKinds(sink.events);
    expect(kinds).toHaveLength(2);
    expect(new Set(kinds).size).toBe(2);
    expect(unit.grantedKeywords).toHaveLength(2);
    const poolKinds = RANDOM_KEYWORD_POOL.map((entry) => (entry === "Armor 1" ? "Armor" : entry));
    for (const kind of kinds) expect(poolKinds).toContain(kind);
    for (const keyword of unit.grantedKeywords) {
      expect(hasKeyword(unitView(state, unit).keywords, keyword.kind)).toBe(true);
    }

    // Same seed, same draws: the effect only ever touches ctx.rng (§9.3).
    const replay = game("random-kw");
    const same = put(replay, plain.id, slot("p1", "units", 1));
    const replaySink = sinkFor(replay);
    run(replaySink, grantRandomKeywords({ target: { of: "self" }, count: 2 }), { self: same });
    expect(same.grantedKeywords).toEqual(unit.grantedKeywords);
  });

  it("R21 never grants a keyword the unit already has, from any source", () => {
    const state = game("random-kw-held");
    const unit = put(state, taunter.id, slot("p1", "units", 1)); // printed Taunt
    unit.position = "DEF"; // Defense grants Taunt and Armor 1 (§4.1)
    const sink = sinkFor(state);

    // 11 draws from an 11-entry pool: everything the unit lacks, and nothing it has.
    run(sink, grantRandomKeywords({ target: { of: "self" }, count: 11 }), { self: unit });

    const kinds = grantedKinds(sink.events);
    expect(kinds).not.toContain("Taunt");
    expect(kinds).not.toContain("Armor");
    expect(new Set(kinds).size).toBe(kinds.length);
    expect(kinds).toHaveLength(RANDOM_KEYWORD_POOL.length - 2);
  });

  it("R21: a unit holding the whole pool gets nothing and emits nothing", () => {
    const state = game("random-kw-full");
    const unit = put(state, everyKeyword.id, slot("p1", "units", 1));
    const sink = sinkFor(state);

    run(sink, grantRandomKeywords({ target: { of: "self" }, count: 3 }), { self: unit });

    expect(unit.grantedKeywords).toEqual([]);
    expect(sink.events).toHaveLength(0);
  });
});
