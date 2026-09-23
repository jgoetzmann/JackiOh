// One test per step of the damage pipeline (SPEC §4.4), in order, plus §6.3 healing and R18.

import type { CardDef, PlayerId } from "@jackioh/shared";
import { describe, expect, it } from "vitest";
import { registerCatalog, registeredCatalog } from "../src/catalog";
import { resolveCombat } from "../src/combat";
import { ANTI_ONESHOT_CAP, HERO_HEALTH } from "../src/config";
import {
  dealDamage,
  healHero,
  healHeroUpTo,
  healToFull,
  healUnit,
  loseHealth,
  type DamageArgs,
  type DamageSink,
  type DamageTarget,
} from "../src/damage";
import { plague } from "../src/effects/counters";
import { unitHas, unitView } from "../src/layers";
import { registerScripts, registeredScripts } from "../src/scripts";
import { settle } from "../src/triggers";
import type { CardInstance } from "../src/state";
import { cardAt } from "../src/zones";
import {
  armoured,
  bigBody,
  bigDfender,
  cleaver,
  indestructible,
  lifestealer,
  plain,
  poisonous,
  shielded,
  trampleLifesteal,
  trampler,
} from "./fixtures/combat";
import { eventsOfType, newGame, put, sinkFor, slot } from "./fixtures/harness";
import { antiOneshot } from "./fixtures/scripts";

const onUnit = (instance: CardInstance): DamageTarget => ({ kind: "unit", instance });
const onHero = (player: PlayerId): DamageTarget => ({ kind: "hero", player });

/** One damage instance, returning the amount actually dealt. */
function hit(
  sink: DamageSink,
  source: CardInstance | null,
  target: DamageTarget,
  amount: number,
  flags?: DamageArgs["flags"],
): number {
  return dealDamage(sink, { source, target, amount, flags });
}

describe("the damage pipeline (§4.4, M2-T3)", () => {
  it("step 1: Divine Shield negates a 10 hit fully and is gone, and the next hit lands", () => {
    const state = newGame();
    const target = put(state, shielded.id, slot("p2", "units", 1));
    const sink = sinkFor(state);

    expect(hit(sink, null, onUnit(target), 10)).toBe(0);
    expect(target.damage).toBe(0);
    expect(target.divineShieldSpent).toBe(true);
    expect(unitHas(state, target, "Divine Shield")).toBe(false);
    expect(eventsOfType(sink.events, "divineShieldLost").map((e) => e.instanceId)).toEqual([target.id]);
    expect(eventsOfType(sink.events, "damage")).toHaveLength(0);

    // The second hit is a normal instance, and step 5 does not cap it at the target's 2 health.
    expect(hit(sink, null, onUnit(target), 10)).toBe(10);
    expect(target.damage).toBe(10);
    expect(unitView(state, target).health).toBe(-8);
    expect(eventsOfType(sink.events, "damage").map((e) => e.amount)).toEqual([10]);
  });

  it("step 2: Armor 7 turns a 7 into 0, Defense adds 1, Big D-fender adds 2 more, True Strike ignores it", () => {
    const state = newGame();
    const target = put(state, armoured.id, slot("p2", "units", 1));
    const sink = sinkFor(state);

    expect(unitView(state, target).armor).toBe(7);
    expect(hit(sink, null, onUnit(target), 7)).toBe(0);
    expect(target.damage).toBe(0);
    expect(hit(sink, null, onUnit(target), 8)).toBe(1);

    // §4.1: Defense Position is Armor +1 on top of the printed value.
    target.position = "DEF";
    expect(unitView(state, target).armor).toBe(8);
    expect(hit(sink, null, onUnit(target), 8)).toBe(0);

    // Big D-fender's aura: its controller's Defense units get Armor +2 (§10.4 layer 5).
    put(state, bigDfender.id, slot("p2", "units", 2));
    expect(unitView(state, target).armor).toBe(10);
    expect(hit(sink, null, onUnit(target), 10)).toBe(0);
    expect(hit(sink, null, onUnit(target), 12)).toBe(2);

    // True Strike skips step 2 entirely: printed, Defense and aura Armor all.
    expect(hit(sink, null, onUnit(target), 12, { ignoreArmor: true })).toBe(12);
    expect(eventsOfType(sink.events, "damage").map((e) => e.amount)).toEqual([1, 2, 12]);
  });

  it("step 3: the hero cap clamps 12 to 5, 3 when radiant, and applies to a hero only", () => {
    const state = newGame();
    put(state, antiOneshot.id, slot("p1", "backrow", 1));
    const own = put(state, plain.id, slot("p1", "units", 1));
    const sink = sinkFor(state);

    expect(hit(sink, null, onHero("p1"), 12)).toBe(ANTI_ONESHOT_CAP.base);
    expect(state.players.p1.hero.health).toBe(HERO_HEALTH - 5);

    // A unit behind the same Anti-oneshot Armor takes the whole hit.
    expect(hit(sink, null, onUnit(own), 12)).toBe(12);
    expect(own.damage).toBe(12);

    // The other hero has no Anti-oneshot Armor of its own, so nothing clamps it.
    expect(hit(sink, null, onHero("p2"), 12)).toBe(12);
    expect(state.players.p2.hero.health).toBe(HERO_HEALTH - 12);

    const radiant = newGame();
    put(radiant, antiOneshot.id, slot("p1", "backrow", 1), { radiant: true });
    expect(hit(sinkFor(radiant), null, onHero("p1"), 12)).toBe(ANTI_ONESHOT_CAP.radiant);
    expect(radiant.players.p1.hero.health).toBe(HERO_HEALTH - 3);
  });

  it("step 4: an Indestructible unit takes 0, stays on the field and emits no damage event", () => {
    const state = newGame();
    const target = put(state, indestructible.id, slot("p2", "units", 3));
    const source = put(state, plain.id, slot("p1", "units", 1));
    const sink = sinkFor(state);

    expect(hit(sink, source, onUnit(target), 99)).toBe(0);
    expect(hit(sink, source, onUnit(target), 99, { ignoreArmor: true })).toBe(0);
    expect(target.damage).toBe(0);
    expect(target.markedDestroyed).toBeUndefined();
    expect(unitView(state, target).health).toBe(4);
    expect(cardAt(state, slot("p2", "units", 3))?.id).toBe(target.id);
    expect(eventsOfType(sink.events, "damage")).toHaveLength(0);
  });

  it("step 5: the damage event carries the amount actually dealt", () => {
    const state = newGame();
    const source = put(state, plain.id, slot("p1", "units", 1));
    const target = put(state, armoured.id, slot("p2", "units", 1));
    const sink = sinkFor(state);

    expect(hit(sink, source, onUnit(target), 10, { combat: true })).toBe(3);
    expect(eventsOfType(sink.events, "damage")[0]).toEqual({
      type: "damage",
      sourceId: source.id,
      targetId: target.id,
      amount: 3,
      combat: true,
    });
    expect(target.damage).toBe(3);
    // R42: the hit left the unit standing, so it killed nothing and credits no killer.
    expect(target.lastDamagedBy).toBeUndefined();

    state.players.p2.hero.armor = 1;
    expect(hit(sink, null, onHero("p2"), 4)).toBe(3);
    expect(eventsOfType(sink.events, "damage")[1]).toEqual({
      type: "damage",
      sourceId: null,
      targetId: "hero-p2",
      amount: 3,
      combat: false,
    });
  });

  it("step 6: an instance Armor reduces to 0 emits no damage event, and a 0 hit is no instance at all (R63)", () => {
    // M1 has no trigger dispatch, so what step 6 makes observable is the `damage` event an
    // on-damage trigger such as Fed Fauci's Plague Token would fire from: one per instance dealt,
    // none at all for an instance stopped before step 5.
    const state = newGame();
    const armour = put(state, armoured.id, slot("p2", "units", 1));
    const shield = put(state, shielded.id, slot("p2", "units", 2));
    const sink = sinkFor(state);

    expect(hit(sink, null, onUnit(armour), 7)).toBe(0);
    expect(armour.damage).toBe(0);
    expect(sink.events).toHaveLength(0);

    // A hit of 0 before step 1 is not a damage instance: the shield is still there.
    expect(hit(sink, null, onUnit(shield), 0)).toBe(0);
    expect(shield.divineShieldSpent).toBeUndefined();
    expect(unitHas(state, shield, "Divine Shield")).toBe(true);
    expect(sink.events).toHaveLength(0);

    // Two instances that do land emit exactly one `damage` event each.
    expect(hit(sink, null, onUnit(armour), 9)).toBe(2);
    expect(hit(sink, null, onUnit(armour), 9)).toBe(2);
    expect(eventsOfType(sink.events, "damage").map((e) => e.amount)).toEqual([2, 2]);
  });

  it("R85 an effect may state its damage has Lifesteal, without the source carrying the keyword", () => {
    const state = newGame();
    // A plain 3/3 source: no Lifesteal anywhere on it (§6.1).
    const source = put(state, plain.id, slot("p1", "units", 1));
    const armour = put(state, armoured.id, slot("p2", "units", 1)); // Armor 7
    state.players.p1.hero.health = 20;
    const sink = sinkFor(state);

    expect(unitHas(state, source, "Lifesteal")).toBe(false);
    expect(hit(sink, source, onHero("p2"), 8, { lifesteal: true })).toBe(8);
    expect(state.players.p1.hero.health).toBe(28);
    // The keyword is not granted: the next hit without the flag heals nothing.
    expect(hit(sink, source, onHero("p2"), 2)).toBe(2);
    expect(state.players.p1.hero.health).toBe(28);

    // R85 heals the amount actually dealt, so Armor takes its share first (§4.4 step 2)...
    expect(hit(sink, source, onUnit(armour), 9, { lifesteal: true })).toBe(2);
    expect(state.players.p1.hero.health).toBe(30);
    // ...and a hit Armor reduces to 0 heals nothing at all (R63).
    expect(hit(sink, source, onUnit(armour), 7, { lifesteal: true })).toBe(0);
    expect(state.players.p1.hero.health).toBe(30);
  });

  it("step 7: Poisonous destroys on 1 dealt, not on 0, and never affects a hero (R63)", () => {
    const state = newGame();
    const source = put(state, poisonous.id, slot("p1", "units", 1));
    const victim = put(state, bigBody.id, slot("p2", "units", 1));
    const armour = put(state, armoured.id, slot("p2", "units", 2));
    const sink = sinkFor(state);

    expect(hit(sink, source, onUnit(victim), 1)).toBe(1);
    expect(victim.markedDestroyed).toBe(true);
    expect(unitView(state, victim).health).toBe(9);

    // Armor 7 leaves 0 dealt, so steps 5 to 9 never run and nothing is marked.
    expect(hit(sink, source, onUnit(armour), 1)).toBe(0);
    expect(armour.markedDestroyed).toBeUndefined();

    // Poisonous only affects units: the hero just takes the damage.
    expect(hit(sink, source, onHero("p2"), 1)).toBe(1);
    expect(state.players.p2.hero.health).toBe(HERO_HEALTH - 1);
    expect(state.result).toBeNull();
    expect(eventsOfType(sink.events, "destroyed")).toHaveLength(0);
  });

  it("step 8: Lifesteal heals the source's controller's hero by the amount dealt, after Armor", () => {
    const state = newGame();
    state.players.p1.hero.health = 20;
    const source = put(state, lifestealer.id, slot("p1", "units", 1));
    const target = put(state, armoured.id, slot("p2", "units", 1));
    const sink = sinkFor(state);

    expect(hit(sink, source, onUnit(target), 10)).toBe(3);
    expect(state.players.p1.hero.health).toBe(23);
    expect(state.players.p2.hero.health).toBe(HERO_HEALTH);
    expect(eventsOfType(sink.events, "healed")).toEqual([{ type: "healed", targetId: "hero-p1", amount: 3 }]);

    // A hit Armor reduces to 0 heals nothing, because step 8 never runs.
    expect(hit(sink, source, onUnit(target), 5)).toBe(0);
    expect(state.players.p1.hero.health).toBe(23);
    expect(eventsOfType(sink.events, "healed")).toHaveLength(1);
  });

  it("step 9: Trample sends only the excess to the target's hero, from non-combat damage too (R63)", () => {
    const state = newGame();
    const source = put(state, trampler.id, slot("p1", "units", 1));
    const target = put(state, plain.id, slot("p2", "units", 1));
    const spare = put(state, plain.id, slot("p2", "units", 2));
    const sink = sinkFor(state);

    // No combat flag: Trample applies to any damage the unit deals.
    expect(hit(sink, source, onUnit(target), 10)).toBe(3);
    expect(target.damage).toBe(3);
    expect(state.players.p2.hero.health).toBe(HERO_HEALTH - 7);
    expect(eventsOfType(sink.events, "damage").map((e) => [e.targetId, e.amount, e.combat])).toEqual([
      [target.id, 3, false],
      ["hero-p2", 7, false],
    ]);

    // Nothing beyond the target's health means no second instance.
    expect(hit(sink, source, onUnit(spare), 2)).toBe(2);
    expect(state.players.p2.hero.health).toBe(HERO_HEALTH - 7);
    expect(eventsOfType(sink.events, "damage")).toHaveLength(3);

    // Trample plus Lifesteal heals the total damage once: 3 to the unit and 7 to the hero.
    const both = newGame();
    const drainer = put(both, trampleLifesteal.id, slot("p1", "units", 1));
    const victim = put(both, plain.id, slot("p2", "units", 1));
    const bothSink = sinkFor(both);

    expect(hit(bothSink, drainer, onUnit(victim), 10)).toBe(3);
    expect(both.players.p2.hero.health).toBe(HERO_HEALTH - 7);
    expect(eventsOfType(bothSink.events, "healed").map((e) => e.amount)).toEqual([3, 7]);
    expect(both.players.p1.hero.health).toBe(HERO_HEALTH + 10);
  });

  it("step 10: Cleave hits both neighbours for the attacker's attack, never across sides, and through a Divine Shield (R63)", () => {
    const state = newGame();
    const attacker = put(state, cleaver.id, slot("p1", "units", 3));
    const ownLeft = put(state, bigBody.id, slot("p1", "units", 2));
    const ownRight = put(state, bigBody.id, slot("p1", "units", 4));
    const defender = put(state, bigBody.id, slot("p2", "units", 3));
    const left = put(state, bigBody.id, slot("p2", "units", 2));
    const right = put(state, bigBody.id, slot("p2", "units", 4));
    const sink = sinkFor(state);

    resolveCombat(sink, attacker, { kind: "unit", instance: defender });

    expect(defender.damage).toBe(3);
    expect(left.damage).toBe(3);
    expect(right.damage).toBe(3);
    expect(attacker.damage).toBe(5); // the defender struck back
    // The attacker's own neighbours are on the other side of the field and are never cleaved.
    expect(ownLeft.damage).toBe(0);
    expect(ownRight.damage).toBe(0);
    expect(eventsOfType(sink.events, "damage").every((e) => e.combat)).toBe(true);

    // Cleave belongs to the attack, so Divine Shield on the defender does not stop it.
    const shieldState = newGame();
    const striker = put(shieldState, cleaver.id, slot("p1", "units", 3));
    const shield = put(shieldState, shielded.id, slot("p2", "units", 3));
    const nextTo = put(shieldState, bigBody.id, slot("p2", "units", 2));
    const alsoNextTo = put(shieldState, bigBody.id, slot("p2", "units", 4));
    const shieldSink = sinkFor(shieldState);

    resolveCombat(shieldSink, striker, { kind: "unit", instance: shield });

    expect(shield.damage).toBe(0);
    expect(shield.divineShieldSpent).toBe(true);
    expect(nextTo.damage).toBe(3);
    expect(alsoNextTo.damage).toBe(3);
  });
});

describe("heal and lose health (§6.3, R18, R19, M2-T3)", () => {
  it("heals a unit only up to its max health, and heal to full removes all damage", () => {
    const state = newGame();
    const unit = put(state, bigBody.id, slot("p1", "units", 1)); // 5/10
    unit.damage = 4;
    const sink = sinkFor(state);

    expect(healUnit(sink, unit, 10)).toBe(4);
    expect(unit.damage).toBe(0);
    expect(unitView(state, unit).health).toBe(10);
    expect(eventsOfType(sink.events, "healed")).toEqual([{ type: "healed", targetId: unit.id, amount: 4 }]);

    // An undamaged unit heals nothing and emits nothing.
    expect(healUnit(sink, unit, 5)).toBe(0);
    expect(eventsOfType(sink.events, "healed")).toHaveLength(1);

    unit.damage = 7;
    expect(healToFull(sink, unit)).toBe(7);
    expect(unit.damage).toBe(0);
    expect(unitView(state, unit).health).toBe(10);
  });

  it("heals a hero with no cap, and heal up to N raises only a hero below N (R19)", () => {
    const state = newGame();
    const sink = sinkFor(state);

    expect(healHero(sink, "p1", 5)).toBe(5);
    expect(state.players.p1.hero.health).toBe(HERO_HEALTH + 5);
    expect(eventsOfType(sink.events, "healed")).toEqual([{ type: "healed", targetId: "hero-p1", amount: 5 }]);

    state.players.p2.hero.health = 12;
    expect(healHeroUpTo(sink, "p2", 30)).toBe(18);
    expect(state.players.p2.hero.health).toBe(30);
    expect(healHeroUpTo(sink, "p2", 30)).toBe(0);
    expect(state.players.p2.hero.health).toBe(30);
    expect(healHeroUpTo(sink, "p1", 30)).toBe(0);
    expect(state.players.p1.hero.health).toBe(HERO_HEALTH + 5);
  });

  it("R18: lose health bypasses Armor, the hero cap and the damage event", () => {
    const state = newGame();
    put(state, antiOneshot.id, slot("p1", "backrow", 1));
    state.players.p1.hero.armor = 5;
    const sink = sinkFor(state);

    expect(loseHealth(sink, "p1", 12)).toBe(12);
    expect(state.players.p1.hero.health).toBe(HERO_HEALTH - 12);
    expect(eventsOfType(sink.events, "healthLost")).toEqual([{ type: "healthLost", player: "p1", amount: 12 }]);
    expect(eventsOfType(sink.events, "damage")).toHaveLength(0);

    // The same 12 as damage loses 5 to Armor and is then clamped by the cap.
    expect(hit(sink, null, onHero("p1"), 12)).toBe(ANTI_ONESHOT_CAP.base);
    expect(state.players.p1.hero.health).toBe(HERO_HEALTH - 17);
  });
});

// §8 #91 Fed Fauci, trimmed to the half step 6 is responsible for: a trigger that reads the
// `damage` event this card's own hit emits. The mana half of its text is a card script (M4).
const fedFauci: CardDef = {
  id: "dm-fed-fauci",
  index: "91",
  name: "Fed Fauci (damage)",
  set: "Core",
  type: "Unit",
  tags: ["Human"],
  rarity: "Rare",
  token: false,
  cost: 2,
  base: { attack: 1, health: 6, keywords: [{ kind: "Rush" }], text: "+1 Plague Token when this takes damage" },
  radiant: { attack: 2, health: 12, keywords: [{ kind: "Rush" }], text: "same" },
};

describe("on-damage triggers (§4.4 step 6, M2-T3)", () => {
  it("R63 gives Fed Fauci one Plague Token per damage instance, and none for an instance Armor zeroed", () => {
    const state = newGame();
    registerCatalog({ ...registeredCatalog(), [fedFauci.id]: fedFauci });
    const script = {
      triggers: [
        {
          id: "plague-on-damage",
          on: ["damage" as const],
          run: ({ event, self }: { event: { type: string; targetId?: string }; self: CardInstance | null }) =>
            event.type === "damage" && self !== null && event.targetId === self.id ? [plague({ amount: 1 })] : [],
        },
      ],
    };
    registerScripts({ ...registeredScripts(), [fedFauci.id]: { base: script, radiant: script } });

    const fauci = put(state, fedFauci.id, slot("p2", "units", 1));
    const sink = sinkFor(state);

    // One instance of 2, one of 3: one token each, not one per point of damage.
    expect(hit(sink, null, onUnit(fauci), 2)).toBe(2);
    settle(sink);
    expect(fauci.counters.plague).toBe(1);

    expect(hit(sink, null, onUnit(fauci), 3)).toBe(3);
    settle(sink);
    expect(fauci.counters.plague).toBe(2);

    // An instance Armor reduces to 0 emits no `damage` event, so step 6 never runs (R63).
    fauci.grantedKeywords.push({ kind: "Armor", n: 7 });
    const before = sink.events.length;
    expect(hit(sink, null, onUnit(fauci), 7)).toBe(0);
    expect(sink.events.slice(before)).toHaveLength(0);
    settle(sink);
    expect(fauci.counters.plague).toBe(2);

    // R78: the counter is the instance's, so leaving the field clears it.
    expect(eventsOfType(sink.events, "counterChanged").map((e) => e.value)).toEqual([1, 2]);
  });
});
