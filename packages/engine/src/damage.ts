// One damage instance: the ten ordered steps of SPEC §4.4, plus heal and lose health.
// M2-T3 adds a test per step; combat's Cleave step lives in combat.ts (M2-T4).

import type { GameEvent, PlayerId } from "@jackioh/shared";
import { armorOf, hasKeyword, opponentOf } from "@jackioh/shared";
import { ANTI_ONESHOT_CAP, HERO_ARMOR } from "./config";
import { unitView } from "./layers";
import { flagsOf } from "./scripts";
import type { CardInstance, GameState } from "./state";
import { cardAt, slotsOf } from "./zones";

export type DamageTarget = { kind: "unit"; instance: CardInstance } | { kind: "hero"; player: PlayerId };

export type DamageArgs = {
  source: CardInstance | null;
  target: DamageTarget;
  amount: number;
  flags?: { ignoreArmor?: boolean; combat?: boolean; lifesteal?: boolean };
};

export type DamageSink = { state: GameState; events: GameEvent[] };

function targetId(target: DamageTarget): string {
  return target.kind === "unit" ? target.instance.id : `hero-${target.player}`;
}

function controllerOf(target: DamageTarget): PlayerId {
  return target.kind === "unit" ? target.instance.controller : target.player;
}

/**
 * §4.4 step 2 for a hero: the Armor written on the hero itself plus every backrow card that grants
 * it (#84 Going Long), each contributing the `HERO_ARMOR` value its own face and price select.
 *
 * R124: hero Armor from several sources **adds up**, exactly as §6.2's Armor stacks on a unit
 * (printed + Defense +1 + auras) — two Going Longs paid 2 are Armor 4. That is deliberately the
 * opposite of `heroDamageCap` below, which takes the *smallest* cap on offer: a cap is a ceiling,
 * Armor is a reduction, so they compose in opposite directions and are not unified.
 *
 * Nothing about the grant is stored, so it stops the moment the granting card leaves the backrow.
 * Every reader of hero Armor goes through here — the pipeline, `subsystems/lethal`'s projection,
 * `subsystems/scorer` and §10.8's hero block — so no projection can disagree with the hit (R44).
 */
export function heroArmorOf(state: GameState, player: PlayerId): number {
  return slotsOf(player, "backrow")
    .map((ref) => cardAt(state, ref))
    .reduce((sum, card) => {
      if (card === null || flagsOf(card).heroArmor !== true) return sum;
      const side = card.radiant ? HERO_ARMOR.radiant : HERO_ARMOR.base;
      return sum + (card.embiggened === true ? side.embiggen : side.paid);
    }, state.players[player].hero.armor);
}

/** §4.4 step 3: the smallest hero cap any Anti-oneshot Armor this player controls provides. */
export function heroDamageCap(state: GameState, player: PlayerId): number | null {
  const caps = slotsOf(player, "backrow")
    .map((ref) => cardAt(state, ref))
    .flatMap((card) => {
      if (card === null || flagsOf(card).antiOneshot !== true) return [];
      return [card.radiant ? ANTI_ONESHOT_CAP.radiant : ANTI_ONESHOT_CAP.base];
    });
  return caps.length === 0 ? null : Math.min(...caps);
}

/**
 * Deal one damage instance. Returns the amount actually dealt. A hit of 0 before step 1 is not a
 * damage instance at all: Divine Shield stays and nothing triggers (R63).
 */
export function dealDamage(sink: DamageSink, args: DamageArgs): number {
  const { state, events } = sink;
  const { source, target } = args;
  const amountIn = Math.trunc(args.amount);
  if (amountIn <= 0) return 0;

  // Step 1: Divine Shield negates the whole hit and is gone.
  if (target.kind === "unit") {
    const view = unitView(state, target.instance);
    if (hasKeyword(view.keywords, "Divine Shield") && target.instance.divineShieldSpent !== true) {
      target.instance.divineShieldSpent = true;
      events.push({ type: "divineShieldLost", instanceId: target.instance.id });
      return 0;
    }
  }

  // Step 2: Armor, unless the source ignores it (True Strike). A hero's total is `heroArmorOf`:
  // what is written on the hero plus every backrow grant (#84), summed per R124. Fatigue is an
  // ordinary instance on its own hero and pays this step like any other hit (R125); only "lose
  // health" bypasses the pipeline (R18), and that never comes through here.
  let amount = amountIn;
  if (args.flags?.ignoreArmor !== true) {
    const armor =
      target.kind === "unit"
        ? armorOf(unitView(state, target.instance).keywords)
        : heroArmorOf(state, target.player);
    amount = Math.max(0, amount - armor);
  }

  // Step 3: the hero cap.
  if (target.kind === "hero") {
    const cap = heroDamageCap(state, target.player);
    if (cap !== null) amount = Math.min(amount, cap);
  }

  // Step 4: Indestructible units take nothing, and emit no damage event.
  if (target.kind === "unit" && hasKeyword(unitView(state, target.instance).keywords, "Indestructible")) {
    return 0;
  }

  // The zero rule: a hit reduced to 0 emits nothing and triggers nothing (R63).
  if (amount <= 0) return 0;

  // Step 5: apply, capping what a Trample source deals to a unit at its health (R63).
  let dealt = amount;
  let trampleExcess = 0;
  if (target.kind === "unit") {
    const view = unitView(state, target.instance);
    const trample = source !== null && hasKeyword(unitView(state, source).keywords, "Trample");
    if (trample && amount > view.health) {
      dealt = Math.max(0, view.health);
      trampleExcess = amount - dealt;
    }
  }

  // R63's zero rule, now for the Trample cap: a unit already at 0 or less health (max health
  // dragged down by Suppressive Aura, or damage the state check has not collected yet) has no
  // health for the hit to count against, so nothing is dealt to it. Nothing dealt is not a damage
  // instance: no `damage` event, no `lastDamagedBy`, and none of steps 6 to 8. Step 9 still runs,
  // with the whole amount, because the excess beyond that unit's health is all of it.
  if (dealt <= 0) {
    if (trampleExcess > 0) {
      dealDamage(sink, {
        source,
        target: { kind: "hero", player: controllerOf(target) },
        amount: trampleExcess,
        flags: args.flags,
      });
    }
    return 0;
  }

  if (target.kind === "unit") {
    target.instance.damage += dealt;
    if (source !== null) target.instance.lastDamagedBy = source.id;
  } else {
    state.players[target.player].hero.health -= dealt;
  }

  events.push({
    type: "damage",
    sourceId: source?.id ?? null,
    targetId: targetId(target),
    amount: dealt,
    combat: args.flags?.combat === true,
  });

  // Step 6 (on-damage triggers) is dispatched by the trigger loop from the `damage` event (§10.3).

  // Step 7: Poisonous destroys a damaged unit.
  if (
    target.kind === "unit" &&
    dealt >= 1 &&
    source !== null &&
    hasKeyword(unitView(state, source).keywords, "Poisonous")
  ) {
    target.instance.markedDestroyed = true;
  }

  // Step 8: Lifesteal heals the source's controller's hero by the amount dealt. R85: an effect
  // may state that its own damage has Lifesteal, which heals without granting the source the keyword.
  // R85's heal goes to the source's controller, so an effect with no source heals nobody.
  const sourceHasLifesteal = source !== null && hasKeyword(unitView(state, source).keywords, "Lifesteal");
  if (source !== null && (sourceHasLifesteal || args.flags?.lifesteal === true)) {
    healHero(sink, source.controller, dealt);
  }

  // Step 9: Trample sends the excess to the target's controller's hero as its own instance.
  if (trampleExcess > 0) {
    dealDamage(sink, {
      source,
      target: { kind: "hero", player: controllerOf(target) },
      amount: trampleExcess,
      flags: args.flags,
    });
  }

  return dealt;
}

/** §6.3 Heal: units are capped at max health, heroes are not. */
export function healUnit(sink: DamageSink, instance: CardInstance, amount: number): number {
  if (amount <= 0) return 0;
  const healed = Math.min(instance.damage, Math.trunc(amount));
  instance.damage -= healed;
  if (healed > 0) sink.events.push({ type: "healed", targetId: instance.id, amount: healed });
  return healed;
}

export function healHero(sink: DamageSink, player: PlayerId, amount: number): number {
  if (amount <= 0) return 0;
  const healed = Math.trunc(amount);
  sink.state.players[player].hero.health += healed;
  sink.events.push({ type: "healed", targetId: `hero-${player}`, amount: healed });
  return healed;
}

/** "Heal to full" removes all damage; "heal up to N" raises a hero to at least N (§6.3). */
export function healToFull(sink: DamageSink, instance: CardInstance): number {
  return healUnit(sink, instance, instance.damage);
}

export function healHeroUpTo(sink: DamageSink, player: PlayerId, floor: number): number {
  const hero = sink.state.players[player].hero;
  if (hero.health >= floor) return 0;
  return healHero(sink, player, floor - hero.health);
}

/** R18: lose health is not damage. No pipeline, no armor, no cap, no on-damage effects. */
export function loseHealth(sink: DamageSink, player: PlayerId, amount: number): number {
  if (amount <= 0) return 0;
  const lost = Math.trunc(amount);
  sink.state.players[player].hero.health -= lost;
  sink.events.push({ type: "healthLost", player, amount: lost });
  return lost;
}

export function enemyOf(player: PlayerId): PlayerId {
  return opponentOf(player);
}
