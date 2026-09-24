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
    // §7: the Bread Token's radiant "Armor X" is the same X as its X/X, so the printed `n` is a
    // placeholder the summon fills in, exactly as `statsOverride` fills in the printed 0/0.
    keywords:
      instance.armorOverride === undefined
        ? face.keywords
        : face.keywords.map((keyword) =>
            keyword.kind === "Armor" ? { kind: "Armor" as const, n: instance.armorOverride ?? 0 } : keyword,
          ),
  };
}

/** §3.2, R13: a card in a unit zone that is not the top of its pile. */
function isDormant(state: GameState, instance: CardInstance): boolean {
  const zone = instance.zone;
  if (zone.z !== "field" || zone.row !== "units") return false;
  return cardAt(state, { player: zone.player, row: zone.row, lane: zone.lane })?.id !== instance.id;
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

/**
 * §6.1: a unit's keywords are "computed as a set per unit", and §10.4 makes them the union of the
 * printed, granted, aura and position keywords — so a keyword two sources give is had once (Tempo
 * Timmy's printed Rush under Jlockeed's Weapons, a Taunt unit's own Taunt in Defense Position), and
 * the view hands the client one entry for it (§10.8). The numbered keywords are the exception: Armor
 * sums across its sources (§10.4) and Lucky X stacks, so every entry of theirs is kept for the sum.
 */
function asSet(keywords: readonly Keyword[]): Keyword[] {
  const seen = new Set<Keyword["kind"]>();
  return keywords.filter((keyword) => {
    if (keyword.kind === "Armor" || keyword.kind === "Lucky") return true;
    if (seen.has(keyword.kind)) return false;
    seen.add(keyword.kind);
    return true;
  });
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
  // R132 and R150: this is the ONE floor R39 asks for, on each stat's combined total separately.
  // The contributors reach the hook unfloored (`statsWithBuffs`), so a negative buff really does
  // pull its sum down, and flooring attack here never touches the health sum (R116's per-component
  // clamp).
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

  // Layer 5: auras. A card dormant under a Stack pile is "not on the field for effects" (§3.2, R13)
  // and an aura is one, so none reaches it: it keeps its damage and its own layers 1 to 4, and the
  // board's auras apply again the moment it resumes on top. Without this an aura that shrinks max
  // health (#46) killed buried cards the top of the pile shielded.
  const auras = isDormant(state, instance) ? [] : auraMods(state, instance);
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
  const finalKeywords = asSet(
    keywords.filter(
      (k) =>
        !(tauntSuppressed && k.kind === "Taunt") &&
        !(instance.divineShieldSpent === true && k.kind === "Divine Shield") &&
        !(instance.rebornSpent === true && k.kind === "Reborn"),
    ),
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
 * §10.4 layers 1 to 4: printed stats plus permanent buffs, before auras — the reading a set-stat
 * layer that sums other units needs (#92 Felinor Fiender, R116).
 *
 * R150: NO PER-UNIT FLOOR. §10.4 floors attack at layer 5 and at nothing earlier, so this reading
 * reports what layers 1 to 4 actually come to, negative included. A `Math.max(0, …)` here would be
 * invisible to a single card and wrong for every caller that sums: a Felinor carrying a −5 buff
 * would contribute 0 instead of −2 and could never "pull the attack sum toward 0", which is exactly
 * what R132 requires of #92's total. The floor belongs where the value is finally used — on the
 * combined total in `unitView`'s layer 2 above (R116, R132), and on the displayed attack at the end
 * of `unitView` (§10.4 layer 5) — so it is applied once, by the reader that knows which number the
 * rule floors, rather than baked into a reading that has more than one reader.
 *
 * The only other readers are the tests and `query.ts`'s re-export; R89's death snapshot reads
 * `unitView` (`stateCheck.ts`), which floors its own attack, so nothing is left unclamped by this.
 */
export function statsWithBuffs(state: GameState, instance: CardInstance): { attack: number; maxHealth: number } {
  const printed = faceOf(state, instance);
  return {
    attack: printed.attack + instance.buffs.attack,
    maxHealth: printed.health + instance.buffs.health,
  };
}

export function keywordsOf(state: GameState, instance: CardInstance): Keyword[] {
  return unitView(state, instance).keywords;
}

export function unitHas(state: GameState, instance: CardInstance, kind: Keyword["kind"]): boolean {
  return hasKeyword(unitView(state, instance).keywords, kind);
}
