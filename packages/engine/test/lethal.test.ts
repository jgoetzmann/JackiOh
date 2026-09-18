// Projected attack damage and the lethal check of R44 (BUILD M3-T7): a plain hit, hero Armor, the
// Anti-oneshot cap in both forms, Trample excess from an attack on a unit, a non-lethal hit, and
// the rule that a projection is a projection: SPEC §4.2 step 4, §4.3 and the §4.4 pipeline.

import { describe, expect, it } from "vitest";
import type { AttackTarget } from "../src/combat";
import { ANTI_ONESHOT_CAP, HERO_HEALTH } from "../src/config";
import { unitView } from "../src/layers";
import type { CardInstance, GameState } from "../src/state";
import { defendingHero, isLethal, projectedDamage } from "../src/subsystems/lethal";
import {
  armoured,
  bigBody,
  indestructible,
  plain,
  shielded,
  trampler,
} from "./fixtures/combat";
import { newGame, put, slot } from "./fixtures/harness";
import { antiOneshot } from "./fixtures/scripts";

/** p1's main phase on turn 4, so nothing placed with `put` is summoning sick (§4.1). */
function board(seed: string): GameState {
  const state = newGame(seed);
  state.turn = 4;
  state.active = "p1";
  state.phase = "main";
  return state;
}

function onUnit(instance: CardInstance): AttackTarget {
  return { kind: "unit", instance };
}

const onHero: AttackTarget = { kind: "hero", player: "p2" };

describe("lethal projection (M3-T7, R44)", () => {
  it("R44 projects a plain hit on the hero as the attacker's attack", () => {
    const state = board("plain-hit");
    const attacker = put(state, bigBody.id, slot("p1", "units", 1)); // 5/10

    expect(unitView(state, attacker).attack).toBe(5);
    expect(defendingHero(onHero)).toBe("p2");
    expect(projectedDamage(state, attacker, onHero)).toBe(5);

    // §4.5 step 2 ends the game at 0 or less, so R44's "≥ health" is exactly that hit.
    expect(isLethal(state, attacker, onHero)).toBe(false);
    state.players.p2.hero.health = 6;
    expect(isLethal(state, attacker, onHero)).toBe(false);
    state.players.p2.hero.health = 5;
    expect(isLethal(state, attacker, onHero)).toBe(true);
    state.players.p2.hero.health = 4;
    expect(isLethal(state, attacker, onHero)).toBe(true);
  });

  it("R44 subtracts the defending hero's Armor before the comparison (§4.4 step 2)", () => {
    const state = board("hero-armor");
    const attacker = put(state, bigBody.id, slot("p1", "units", 1)); // 5/10
    state.players.p2.hero.armor = 2;

    expect(projectedDamage(state, attacker, onHero)).toBe(3);
    state.players.p2.hero.health = 4;
    expect(isLethal(state, attacker, onHero)).toBe(false);
    state.players.p2.hero.health = 3;
    expect(isLethal(state, attacker, onHero)).toBe(true);

    // Armor above the attack leaves nothing at all, so a hero on 1 is safe.
    state.players.p2.hero.armor = 5;
    state.players.p2.hero.health = 1;
    expect(projectedDamage(state, attacker, onHero)).toBe(0);
    expect(isLethal(state, attacker, onHero)).toBe(false);
  });

  it("R44 clamps the projection with Anti-oneshot Armor, base 5 and radiant 3 (§4.4 step 3)", () => {
    const state = board("cap-base");
    const attacker = put(state, bigBody.id, slot("p1", "units", 1), { radiant: true }); // 10/20
    put(state, antiOneshot.id, slot("p2", "backrow", 1));

    expect(unitView(state, attacker).attack).toBe(10);
    expect(projectedDamage(state, attacker, onHero)).toBe(ANTI_ONESHOT_CAP.base);
    state.players.p2.hero.health = 6;
    expect(isLethal(state, attacker, onHero)).toBe(false);
    state.players.p2.hero.health = 5;
    expect(isLethal(state, attacker, onHero)).toBe(true);

    // Radiant Anti-oneshot Armor clamps to 3, so the same 10 attack needs a hero on 3.
    const radiant = board("cap-radiant");
    const bigger = put(radiant, bigBody.id, slot("p1", "units", 1), { radiant: true });
    put(radiant, antiOneshot.id, slot("p2", "backrow", 1), { radiant: true });

    expect(projectedDamage(radiant, bigger, onHero)).toBe(ANTI_ONESHOT_CAP.radiant);
    radiant.players.p2.hero.health = 4;
    expect(isLethal(radiant, bigger, onHero)).toBe(false);
    radiant.players.p2.hero.health = 3;
    expect(isLethal(radiant, bigger, onHero)).toBe(true);

    // Armor is step 2 and the cap step 3: a hit already under the cap still pays Armor.
    radiant.players.p2.hero.armor = 8;
    expect(projectedDamage(radiant, bigger, onHero)).toBe(2);
  });

  it("R44 counts the Trample excess of an attack on a unit toward lethal (§4.4 step 9)", () => {
    const state = board("trample-excess");
    const attacker = put(state, trampler.id, slot("p1", "units", 1)); // 6/4 Trample
    const blocker = put(state, plain.id, slot("p2", "units", 1)); // 3/3

    // 6 into a 3-health unit: 3 lands on the unit, 3 goes on to its controller's hero.
    expect(defendingHero(onUnit(blocker))).toBe("p2");
    expect(projectedDamage(state, attacker, onUnit(blocker))).toBe(3);
    state.players.p2.hero.health = 4;
    expect(isLethal(state, attacker, onUnit(blocker))).toBe(false);
    state.players.p2.hero.health = 3;
    expect(isLethal(state, attacker, onUnit(blocker))).toBe(true);

    // The excess is an ordinary hero instance, so hero Armor and the cap still apply to it.
    state.players.p2.hero.armor = 1;
    expect(projectedDamage(state, attacker, onUnit(blocker))).toBe(2);
    state.players.p2.hero.armor = 0;

    const capped = board("trample-capped");
    const big = put(capped, trampler.id, slot("p1", "units", 1), { radiant: true }); // 12/8 Trample
    const small = put(capped, plain.id, slot("p2", "units", 1)); // 3/3
    put(capped, antiOneshot.id, slot("p2", "backrow", 1));
    expect(projectedDamage(capped, big, onUnit(small))).toBe(ANTI_ONESHOT_CAP.base);
  });

  it("R44 projects nothing at a hero from an attack on a unit without Trample", () => {
    const state = board("no-trample");
    const attacker = put(state, bigBody.id, slot("p1", "units", 1)); // 5/10, no Trample
    const blocker = put(state, plain.id, slot("p2", "units", 1)); // 3/3
    state.players.p2.hero.health = 1;

    expect(projectedDamage(state, attacker, onUnit(blocker))).toBe(0);
    expect(isLethal(state, attacker, onUnit(blocker))).toBe(false);
  });

  it("R44 stops the Trample excess wherever the hit on the unit stops (§4.4 steps 1, 2 and 4)", () => {
    const state = board("trample-stopped");
    const attacker = put(state, trampler.id, slot("p1", "units", 1)); // 6/4 Trample
    const shield = put(state, shielded.id, slot("p2", "units", 1)); // 2/2 Divine Shield
    const armour = put(state, armoured.id, slot("p2", "units", 2)); // 7/7 Armor 7
    const immortal = put(state, indestructible.id, slot("p2", "units", 3)); // 4/4 Indestructible
    state.players.p2.hero.health = 1;

    // Step 1: Divine Shield negates the whole hit, so nothing tramples through.
    expect(projectedDamage(state, attacker, onUnit(shield))).toBe(0);
    // Step 2: Armor 7 leaves 0 of a 6, so there is no excess either.
    expect(projectedDamage(state, attacker, onUnit(armour))).toBe(0);
    // Step 4: an Indestructible unit takes nothing at all.
    expect(projectedDamage(state, attacker, onUnit(immortal))).toBe(0);
    for (const target of [shield, armour, immortal]) {
      expect(isLethal(state, attacker, onUnit(target))).toBe(false);
    }

    // A spent Divine Shield is gone (§6.1), so the excess flows again.
    shield.divineShieldSpent = true;
    expect(projectedDamage(state, attacker, onUnit(shield))).toBe(4);
    expect(isLethal(state, attacker, onUnit(shield))).toBe(true);
  });

  it("R44 is a projection: neither call touches the state", () => {
    const state = board("no-mutation");
    const attacker = put(state, trampler.id, slot("p1", "units", 1));
    const blocker = put(state, plain.id, slot("p2", "units", 1));
    const shield = put(state, shielded.id, slot("p2", "units", 2));
    put(state, antiOneshot.id, slot("p2", "backrow", 1));
    state.players.p2.hero.armor = 1;
    state.players.p2.hero.health = 3;

    const before = JSON.stringify(state);
    const targets: AttackTarget[] = [onHero, onUnit(blocker), onUnit(shield)];
    for (const target of targets) {
      projectedDamage(state, attacker, target);
      isLethal(state, attacker, target);
    }

    expect(JSON.stringify(state)).toBe(before);
    expect(state.players.p2.hero.health).toBe(3);
    expect(blocker.damage).toBe(0);
    expect(shield.divineShieldSpent).toBeUndefined();
    expect(state.players.p1.hero.health).toBe(HERO_HEALTH);
  });
});
