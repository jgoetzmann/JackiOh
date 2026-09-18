// Stat and keyword layers (SPEC §10.4). Always computed on read, never stored.

import type { Keyword, PlayerId } from "@jackioh/shared";
import { PLAYER_IDS, armorOf, hasKeyword } from "@jackioh/shared";
import { defOf } from "./catalog";
import { scriptOf } from "./scripts";
import type { CardInstance, GameState } from "./state";
import type { StatMod } from "./script";
import { activeUnitsOf, slotsOf, cardAt } from "./zones";

export type UnitView = {
  attack: number;
  maxHealth: number;
  health: number;
  keywords: Keyword[];
  armor: number;
  position: "ATK" | "DEF";
};

/** The card's printed face, radiant when the instance is (§5.2). */
export function faceOf(state: GameState, instance: CardInstance): { attack: number; health: number; keywords: Keyword[] } {
  const def = defOf(state, instance.defId);
  const face = instance.radiant ? def.radiant : def.base;
  return {
    attack: instance.statsOverride?.attack ?? face.attack ?? 0,
    health: instance.statsOverride?.health ?? face.health ?? 0,
    keywords: face.keywords,
  };
}

/** Every permanent whose aura is in play, in lane order per side (§10.4 layer 5). */
function auraSources(state: GameState): CardInstance[] {
  return PLAYER_IDS.flatMap((player: PlayerId) => [
    ...activeUnitsOf(state, player),
    ...slotsOf(player, "backrow").flatMap((ref) => {
      const card = cardAt(state, ref);
      return card === null ? [] : [card];
    }),
  ]);
}

/**
 * Aura contributions for one unit. An aura's `applies` predicate reads instance data only: it must
 * never call back into `unitView`, or the layers would recurse.
 */
function auraMods(state: GameState, unit: CardInstance): StatMod[] {
  const mods: StatMod[] = [];
  for (const source of auraSources(state)) {
    // §6.1/§6.3: Vanilla "clears printed keywords and scripts", and an aura is part of a card's
    // Script (§10.9), so a Vanilla'd permanent projects nothing. It still *receives* aura grants:
    // an aura is the board's text, not the unit's.
    if (source.vanilla === true) continue;
    const aura = scriptOf(source).aura;
    if (aura === undefined) continue;
    for (const entry of aura({ state, self: source, radiant: source.radiant })) {
      if (entry.applies(unit)) mods.push(entry.mod);
    }
  }
  return mods;
}

export function unitView(state: GameState, instance: CardInstance): UnitView {
  const printed = faceOf(state, instance);
  const position = instance.position ?? "ATK";

  // Layers 1 and 3: printed stats of the running face, with Fuse already baked in (R77).
  let attack = printed.attack;
  let maxHealth = printed.health;

  // Layer 2: a card that sets its own stats from the board (#92 Felinor Fiender, R39). §10.4 words
  // it as "Felinor Fiender *adds* the sum of your Felinors' layer-4 stats", so the hook returns the
  // sum rather than a finished total, and R39's "never below printed" floors each sum at 0 — a
  // Felinor carrying a negative health buff can pull the total back toward printed, never past it.
  // Vanilla has cleared the card's scripts, so a Vanilla'd body keeps its printed stats (§6.1).
  if (instance.vanilla !== true) {
    const setStat = scriptOf(instance).setStat;
    if (setStat !== undefined) {
      const set = setStat({ state, self: instance, radiant: instance.radiant });
      attack += Math.max(0, set.attack ?? 0);
      maxHealth += Math.max(0, set.maxHealth ?? 0);
    }
  }

  // Layer 4: permanent buffs.
  attack += instance.buffs.attack;
  maxHealth += instance.buffs.health;

  // Layer 5: auras.
  const auras = auraMods(state, instance);
  for (const mod of auras) {
    attack += mod.attack ?? 0;
    maxHealth += mod.maxHealth ?? 0;
  }

  const keywords: Keyword[] = [
    ...(instance.vanilla ? [] : printed.keywords),
    ...instance.grantedKeywords,
    ...auras.flatMap((mod) => mod.keywords ?? []),
  ];

  // Position grants: Defense adds Taunt and Armor +1 (§4.1).
  if (position === "DEF") keywords.push({ kind: "Taunt" }, { kind: "Armor", n: 1 });

  // R46: an Indestructible unit that would have been destroyed loses Taunt for the turn.
  // A spent Divine Shield and a used Reborn are gone until granted again (§6.1, §4.5 step 4).
  const tauntSuppressed = instance.tauntSuppressedTurn === state.turn;
  const finalKeywords = keywords.filter(
    (k) =>
      !(tauntSuppressed && k.kind === "Taunt") &&
      !(instance.divineShieldSpent === true && k.kind === "Divine Shield") &&
      !(instance.rebornSpent === true && k.kind === "Reborn"),
  );

  // Attack floors at 0; max health may fall to 0, which the state check turns into a death (§10.4).
  const clampedAttack = Math.max(0, attack);
  return {
    attack: clampedAttack,
    maxHealth,
    health: maxHealth - instance.damage,
    keywords: finalKeywords,
    armor: armorOf(finalKeywords),
    position,
  };
}

/**
 * §10.4 layers 1 to 4: printed stats plus permanent buffs, before auras. R89's death snapshot and
 * a set-stat layer that sums other units (#92) both need the pre-aura numbers.
 */
export function statsWithBuffs(state: GameState, instance: CardInstance): { attack: number; maxHealth: number } {
  const printed = faceOf(state, instance);
  return {
    attack: Math.max(0, printed.attack + instance.buffs.attack),
    maxHealth: printed.health + instance.buffs.health,
  };
}

export function keywordsOf(state: GameState, instance: CardInstance): Keyword[] {
  return unitView(state, instance).keywords;
}

export function unitHas(state: GameState, instance: CardInstance, kind: Keyword["kind"]): boolean {
  return hasKeyword(unitView(state, instance).keywords, kind);
}
