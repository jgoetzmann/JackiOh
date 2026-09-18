// Permanent stat buffs and keyword grants. A buff is layer 4 of §10.4, under the auras of layer 5,
// so it is stored on the instance and survives the aura that came and went; §10.4 computes the
// totals, so nothing here ever writes a stat. R78 drops both when the card leaves the field.

import type { Keyword } from "@jackioh/shared";
import { hasKeyword } from "@jackioh/shared";
import { RANDOM_KEYWORD_POOL } from "../config";
import { unitView } from "../layers";
import type { Effect, EffectContext } from "../script";
import type { CardInstance } from "../state";
import { activeUnitsOf } from "../zones";
import { playerOf, type PlayerSpec, resolveTarget, type TargetSpec } from "./targets";

/** A stat change in attack, max health, or both (#4 Gary, #43 Friend of Felinors, #63). */
export type BuffAmount = { attack?: number; health?: number };

/** R21's pool is written as text in config; "Armor 1" is its one numbered entry (§6.1). */
const POOL_KEYWORDS: Record<(typeof RANDOM_KEYWORD_POOL)[number], Keyword> = {
  Taunt: { kind: "Taunt" },
  "Armor 1": { kind: "Armor", n: 1 },
  Rush: { kind: "Rush" },
  Charge: { kind: "Charge" },
  "First Strike": { kind: "First Strike" },
  Poisonous: { kind: "Poisonous" },
  Lifesteal: { kind: "Lifesteal" },
  Reborn: { kind: "Reborn" },
  "Divine Shield": { kind: "Divine Shield" },
  Trample: { kind: "Trample" },
  Cleave: { kind: "Cleave" },
};

function applyBuff(ctx: EffectContext, unit: CardInstance, amount: BuffAmount): void {
  const attack = Math.trunc(amount.attack ?? 0);
  const health = Math.trunc(amount.health ?? 0);
  if (attack === 0 && health === 0) return;
  unit.buffs.attack += attack;
  unit.buffs.health += health;
  // The event carries the change this buff made; a unit's totals are read through `unitView`.
  ctx.events.push({ type: "buffed", instanceId: unit.id, attack, health });
}

/** "+X/+Y" on one unit: a permanent layer-4 buff (§10.4). */
export function buff(args: { target: TargetSpec } & BuffAmount): Effect {
  return {
    kind: "buff",
    apply(ctx): void {
      const target = resolveTarget(ctx, args.target);
      if (target === null || target.kind !== "unit") return;
      applyBuff(ctx, target.instance, args);
    },
  };
}

/** "+X/+Y to every unit you control" (#43), in lane order, one `buffed` event each. */
export function buffAllUnits(args: { side?: PlayerSpec | "both" } & BuffAmount): Effect {
  return {
    kind: "buffAllUnits",
    apply(ctx): void {
      const side = args.side ?? "self";
      const players =
        side === "both" ? [playerOf(ctx, "self"), playerOf(ctx, "enemy")] : [playerOf(ctx, side)];
      for (const player of players) {
        for (const unit of activeUnitsOf(ctx.state, player)) applyBuff(ctx, unit, args);
      }
    },
  };
}

/**
 * Add a keyword to `grantedKeywords` (§10.4). Keywords are a set, so a kind the unit was already
 * granted is not stored twice, while Armor and Lucky carry a number and sum across sources (§6.1).
 * A spent Divine Shield and a used Reborn come back when the keyword is granted again (§10.4).
 */
function grantTo(ctx: EffectContext, unit: CardInstance, keyword: Keyword): void {
  if (keyword.kind === "Divine Shield") delete unit.divineShieldSpent;
  if (keyword.kind === "Reborn") delete unit.rebornSpent;

  const stacks = keyword.kind === "Armor" || keyword.kind === "Lucky";
  const already = unit.grantedKeywords.some((k) => k.kind === keyword.kind);
  if (stacks || !already) unit.grantedKeywords.push(keyword);

  ctx.events.push({ type: "keywordGranted", instanceId: unit.id, keyword });
}

export function grantKeyword(args: { target: TargetSpec; keyword: Keyword }): Effect {
  return {
    kind: "grantKeyword",
    apply(ctx): void {
      const target = resolveTarget(ctx, args.target);
      if (target === null || target.kind !== "unit") return;
      grantTo(ctx, target.instance, args.keyword);
    },
  };
}

/**
 * Every pool keyword this unit does not have yet, read through the layers (§10.4, R21). A unit
 * that already has Armor from any source is not offered "Armor 1", as R21 counts by keyword.
 */
function poolCandidates(ctx: EffectContext, unit: CardInstance): Keyword[] {
  const held = unitView(ctx.state, unit).keywords;
  return RANDOM_KEYWORD_POOL.map((entry) => POOL_KEYWORDS[entry]).filter(
    (keyword) => !hasKeyword(held, keyword.kind),
  );
}

/**
 * R21: #63 Plastic Surgery's and #80 Zao Gao's random keywords. Each draw comes from `ctx.rng`,
 * never picks a keyword the unit already has, and never repeats inside one grant; a unit that
 * already holds the whole pool gets nothing.
 */
export function grantRandomKeywords(args: { target: TargetSpec; count?: number }): Effect {
  return {
    kind: "grantRandomKeywords",
    apply(ctx): void {
      const target = resolveTarget(ctx, args.target);
      if (target === null || target.kind !== "unit") return;
      const unit = target.instance;
      const count = Math.max(0, Math.trunc(args.count ?? 1));

      for (let i = 0; i < count; i += 1) {
        // Recomputed each draw, so the keyword just granted is out of the pool for the next one.
        const candidates = poolCandidates(ctx, unit);
        if (candidates.length === 0) return;
        const keyword = ctx.rng.pick(candidates);
        if (keyword === undefined) return;
        grantTo(ctx, unit, keyword);
      }
    },
  };
}
