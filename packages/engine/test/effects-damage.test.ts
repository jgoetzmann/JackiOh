// The `damage` effect itself (BUILD M3-T1 "every effect has its own test file"; SPEC §6.3, §4.4,
// R85). `damage.test.ts` covers the ten pipeline steps of `dealDamage`; this file covers the
// factory a card script writes: what it declares, what it hands the pipeline, what it emits, and
// what it does when its declared target is not there.

import type { CardDef } from "@jackioh/shared";
import { describe, expect, it } from "vitest";
import { registerCatalog, registeredCatalog } from "../src/catalog";
import { damage } from "../src/effects";
import { makeContext } from "../src/resolve";
import type { EffectContext } from "../src/script";
import { newInstance, type CardInstance, type GameState } from "../src/state";
import { armoured, plain, shielded } from "./fixtures/combat";
import { eventsOfType, newGame, put, sinkFor, slot } from "./fixtures/harness";

/** A Spell, so a damage effect can run with the resolving card as its source. */
const boltDef: CardDef = {
  id: "ed-bolt",
  index: "1201",
  name: "Damage effect bolt",
  set: "Core",
  type: "Spell",
  tags: [],
  rarity: "Common",
  token: false,
  cost: 1,
  base: { keywords: [], text: "bolt" },
  radiant: { keywords: [], text: "bolt" },
};

function game(seed: string): GameState {
  const state = newGame(seed);
  registerCatalog({ ...registeredCatalog(), [boltDef.id]: boltDef });
  state.turn = 3;
  state.active = "p1";
  state.phase = "main";
  return state;
}

/** A context as a resolving card would see it, so the effect runs the way a script runs it. */
function ctxFor(state: GameState, self: CardInstance | null, extra: Partial<EffectContext> = {}): EffectContext {
  return { ...makeContext(sinkFor(state), self, { controller: "p1" }), ...extra };
}

function run(ctx: EffectContext, effects: { apply: (c: EffectContext) => void }[]): void {
  for (const effect of effects) effect.apply(ctx);
}

/** A Spell mid-resolution: the source a Spell's own damage carries (§10.5 step 4). */
function resolvingBolt(state: GameState): CardInstance {
  const card = newInstance(state, boltDef.id, "p1", { z: "resolving", player: "p1" });
  state.players.p1.resolving.push(card);
  return card;
}

describe("the damage effect (§6.3, §4.4, R85, M3-T1)", () => {
  it("declares its target and amount, and deals one instance through the pipeline (§4.4)", () => {
    const state = game("damage-args");
    const self = put(state, plain.id, slot("p1", "units", 1));
    const enemy = put(state, plain.id, slot("p2", "units", 1));

    const effect = damage({ to: { of: "chosen" }, amount: 3 });
    expect(effect.kind).toBe("damage");

    const ctx = ctxFor(state, self, { targets: [{ pick: "instance", instanceId: enemy.id }] });
    run(ctx, [effect]);
    expect(enemy.damage).toBe(3);
    expect(enemy.lastDamagedBy).toBe(self.id);
    expect(eventsOfType(ctx.events, "damage")).toEqual([
      { type: "damage", sourceId: self.id, targetId: enemy.id, amount: 3, combat: false },
    ]);
  });

  it("reads every target spec the effect can name: a hero on either side, and itself", () => {
    const state = game("damage-targets");
    const self = put(state, plain.id, slot("p1", "units", 1));
    const ctx = ctxFor(state, self);

    run(ctx, [damage({ to: { of: "enemyHero" }, amount: 4 })]);
    expect(state.players.p2.hero.health).toBe(26);

    run(ctx, [damage({ to: { of: "selfHero" }, amount: 2 })]);
    expect(state.players.p1.hero.health).toBe(28);

    run(ctx, [damage({ to: { of: "self" }, amount: 1 })]);
    expect(self.damage).toBe(1);

    expect(eventsOfType(ctx.events, "damage").map((e) => e.targetId)).toEqual([
      "hero-p2",
      "hero-p1",
      self.id,
    ]);
  });

  it("§4.4 step 2 ignoreArmor puts the whole amount through, on a unit and on a hero", () => {
    const state = game("damage-ignore-armor");
    const self = resolvingBolt(state);
    const armouredUnit = put(state, armoured.id, slot("p2", "units", 1)); // Armor 7
    state.players.p2.hero.armor = 3;

    // Without the flag Armor eats the hit, and a hit reduced to 0 emits nothing (R63).
    const blocked = ctxFor(state, self, { targets: [{ pick: "instance", instanceId: armouredUnit.id }] });
    run(blocked, [damage({ to: { of: "chosen" }, amount: 4 })]);
    expect(armouredUnit.damage).toBe(0);
    expect(eventsOfType(blocked.events, "damage")).toHaveLength(0);

    const through = ctxFor(state, self, { targets: [{ pick: "instance", instanceId: armouredUnit.id }] });
    run(through, [damage({ to: { of: "chosen" }, amount: 4, ignoreArmor: true })]);
    expect(armouredUnit.damage).toBe(4);

    const hero = ctxFor(state, self);
    run(hero, [damage({ to: { of: "enemyHero" }, amount: 5 })]);
    expect(state.players.p2.hero.health).toBe(28); // 5 less the hero's 3 Armor
    run(hero, [damage({ to: { of: "enemyHero" }, amount: 5, ignoreArmor: true })]);
    expect(state.players.p2.hero.health).toBe(23);
  });

  it("marks the instance as combat damage only when the effect says so (§4.4)", () => {
    const state = game("damage-combat-flag");
    const self = put(state, plain.id, slot("p1", "units", 1));
    const enemy = put(state, plain.id, slot("p2", "units", 1));
    const ctx = ctxFor(state, self, { targets: [{ pick: "instance", instanceId: enemy.id }] });

    run(ctx, [
      damage({ to: { of: "chosen" }, amount: 1 }),
      damage({ to: { of: "chosen" }, amount: 1, combat: true }),
    ]);
    expect(eventsOfType(ctx.events, "damage").map((e) => e.combat)).toEqual([false, true]);
  });

  it("R85 heals the source's controller when the effect's own text has Lifesteal", () => {
    const state = game("damage-lifesteal");
    const self = put(state, plain.id, slot("p1", "units", 1)); // no Lifesteal keyword of its own
    state.players.p1.hero.health = 20;

    const plainHit = ctxFor(state, self);
    run(plainHit, [damage({ to: { of: "enemyHero" }, amount: 3 })]);
    expect(state.players.p1.hero.health).toBe(20);
    expect(eventsOfType(plainHit.events, "healed")).toHaveLength(0);

    const stealing = ctxFor(state, self);
    run(stealing, [damage({ to: { of: "enemyHero" }, amount: 3, lifesteal: true })]);
    expect(state.players.p1.hero.health).toBe(23);
    expect(eventsOfType(stealing.events, "healed")).toEqual([
      { type: "healed", targetId: "hero-p1", amount: 3 },
    ]);
  });

  it("R85 heals the amount actually dealt, and heals nobody when the effect has no source", () => {
    const state = game("damage-lifesteal-amount");
    const self = put(state, plain.id, slot("p1", "units", 1));
    state.players.p1.hero.health = 20;
    state.players.p2.hero.armor = 4;

    // Step 8 reads the amount after Armor and the cap, not the printed amount.
    const capped = ctxFor(state, self);
    run(capped, [damage({ to: { of: "enemyHero" }, amount: 6, lifesteal: true })]);
    expect(state.players.p2.hero.health).toBe(28);
    expect(state.players.p1.hero.health).toBe(22);

    // A Divine Shield negates the hit at step 1, so there is nothing to steal.
    const shieldedUnit = put(state, shielded.id, slot("p2", "units", 1));
    const negated = ctxFor(state, self, { targets: [{ pick: "instance", instanceId: shieldedUnit.id }] });
    run(negated, [damage({ to: { of: "chosen" }, amount: 5, lifesteal: true })]);
    expect(shieldedUnit.damage).toBe(0);
    expect(state.players.p1.hero.health).toBe(22);
    expect(eventsOfType(negated.events, "healed")).toHaveLength(0);

    // With no instance to be the source the damage still lands, but no hero heals.
    const sourceless = ctxFor(state, null);
    run(sourceless, [damage({ to: { of: "enemyHero" }, amount: 2, lifesteal: true, ignoreArmor: true })]);
    expect(state.players.p2.hero.health).toBe(26);
    expect(state.players.p1.hero.health).toBe(22);
    expect(eventsOfType(sourceless.events, "damage")[0]?.sourceId).toBeNull();
  });

  it("§6.3 fizzles with no legal target: nothing dealt, nothing emitted", () => {
    const state = game("damage-fizzle");
    const enemy = put(state, plain.id, slot("p2", "units", 1));

    // A chosen target the play never carried, one that is nowhere, and a mode pick.
    const empty = ctxFor(state, null);
    run(empty, [damage({ to: { of: "chosen" }, amount: 5 })]);
    const gone = ctxFor(state, null, { targets: [{ pick: "instance", instanceId: "no-such-card" }] });
    run(gone, [damage({ to: { of: "chosen" }, amount: 5 })]);
    const mode = ctxFor(state, null, { targets: [{ pick: "mode", option: "burn" }] });
    run(mode, [damage({ to: { of: "chosen" }, amount: 5 })]);
    // And "itself" while no instance is resolving (a Spell's own script).
    const noSelf = ctxFor(state, null);
    run(noSelf, [damage({ to: { of: "self" }, amount: 5 })]);

    expect(enemy.damage).toBe(0);
    expect(state.players.p1.hero.health).toBe(30);
    expect(state.players.p2.hero.health).toBe(30);
    for (const ctx of [empty, gone, mode, noSelf]) expect(ctx.events).toEqual([]);
  });

  it("R63 an amount of 0 or less is not a damage instance at all", () => {
    const state = game("damage-zero");
    const self = put(state, plain.id, slot("p1", "units", 1));
    const shieldedUnit = put(state, shielded.id, slot("p2", "units", 1));
    const ctx = ctxFor(state, self, { targets: [{ pick: "instance", instanceId: shieldedUnit.id }] });

    run(ctx, [damage({ to: { of: "chosen" }, amount: 0 }), damage({ to: { of: "chosen" }, amount: -3 })]);
    expect(shieldedUnit.damage).toBe(0);
    expect(shieldedUnit.divineShieldSpent).toBeUndefined();
    expect(ctx.events).toEqual([]);
  });
});
