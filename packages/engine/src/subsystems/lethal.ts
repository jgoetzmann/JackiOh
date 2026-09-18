// What a declared attack would actually do to the defending hero, for My Pawn's trap window
// (SPEC §4.2 step 4, BUILD M3-T7, R44): "Lethal = projected damage to the hero after Armor and the
// cap, Trample excess from an attack on a unit included, ≥ health".
//
// This is a projection, so it never touches the state: it walks the ordered steps of §4.4 reading
// the same sources the pipeline reads (`unitView` for the layers, `heroDamageCap` for the
// Anti-oneshot clamp) instead of dealing the damage and looking at the result.

import type { PlayerId } from "@jackioh/shared";
import { armorOf, hasKeyword } from "@jackioh/shared";
import type { AttackTarget } from "../combat";
import { heroArmorOf, heroDamageCap } from "../damage";
import { unitView } from "../layers";
import type { CardInstance, GameState } from "../state";

/**
 * The hero a hit on this target can reach: the hero itself, or, through Trample, the target unit's
 * controller (§4.4 step 9 sends the excess to "the target's controller's hero").
 */
export function defendingHero(target: AttackTarget): PlayerId {
  return target.kind === "hero" ? target.player : target.instance.controller;
}

/**
 * §4.4 on a hero: step 2 subtracts the hero's Armor, step 3 clamps to the Anti-oneshot cap, and
 * the zero rule stops anything left at 0 (R63). Combat never sets "ignores armor" — that flag
 * belongs to True Strike's own effect — so a declared attack always pays step 2.
 *
 * The Armor is `heroArmorOf`, the pipeline's own reader: the hero's stored Armor plus every backrow
 * grant (#84), summed per R124. Reading the bare field instead would make My Pawn (R44) call an
 * attack lethal that Going Long is about to blunt.
 */
export function projectedHeroDamage(state: GameState, player: PlayerId, amount: number): number {
  if (amount <= 0) return 0;
  const afterArmor = Math.max(0, amount - heroArmorOf(state, player));
  const cap = heroDamageCap(state, player);
  return cap === null ? afterArmor : Math.min(afterArmor, cap);
}

/**
 * §4.4 step 9: what a Trample source's hit on a unit passes on to that unit's hero. Steps 1, 2, 4
 * and the zero rule can all end the hit on the unit, and then nothing tramples through.
 *
 * R44 counts the excess of the declared attack. Cleave's extra instances (step 10) are their own
 * hits on other units and are not part of the projection the ruling names.
 */
function trampleExcess(
  state: GameState,
  source: CardInstance,
  unit: CardInstance,
  amount: number,
): number {
  if (amount <= 0) return 0;
  const view = unitView(state, unit);

  // Step 1: Divine Shield negates the whole hit, so there is no excess.
  if (hasKeyword(view.keywords, "Divine Shield") && unit.divineShieldSpent !== true) return 0;
  // Step 4: an Indestructible unit takes nothing at all.
  if (hasKeyword(view.keywords, "Indestructible")) return 0;

  // Step 2, then the zero rule.
  const afterArmor = Math.max(0, amount - armorOf(view.keywords));
  if (afterArmor <= 0) return 0;

  if (!hasKeyword(unitView(state, source).keywords, "Trample")) return 0;
  if (afterArmor <= view.health) return 0;
  // Step 5: only what lands beyond the unit's health becomes the step 9 instance (R63).
  return afterArmor - Math.max(0, view.health);
}

/**
 * The damage a declared attack by `attacker` on `target` would deal to the defending hero, after
 * Armor and the Anti-oneshot cap, Trample excess from an attack on a unit included (R44).
 * The attack is assumed legal: §4.2 steps 1 to 3 have already passed when the trap window opens.
 */
export function projectedDamage(state: GameState, attacker: CardInstance, target: AttackTarget): number {
  const attack = unitView(state, attacker).attack;
  const hero = defendingHero(target);
  if (target.kind === "hero") return projectedHeroDamage(state, hero, attack);
  return projectedHeroDamage(state, hero, trampleExcess(state, attacker, target.instance, attack));
}

/**
 * R44: the projection against the defending hero's health. §4.5 step 2 ends the game at 0 or less,
 * so "≥ health" is exactly the hit that would end it.
 */
export function isLethal(state: GameState, attacker: CardInstance, target: AttackTarget): boolean {
  const hero = defendingHero(target);
  return projectedDamage(state, attacker, target) >= state.players[hero].hero.health;
}
