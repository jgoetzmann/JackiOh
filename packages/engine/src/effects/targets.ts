// How an effect names what it acts on. A card script writes a spec; the engine resolves it against
// the context, so a card file never reaches into state (CLAUDE.md rule 5).

import type { CardType, PlayerId, Row, Tag } from "@jackioh/shared";
import { PLAYER_IDS, opponentOf } from "@jackioh/shared";
import { defOf } from "../catalog";
import type { DamageTarget } from "../damage";
import type { EffectContext } from "../script";
import { findInstance, type CardInstance } from "../state";
import { leftFieldSince } from "../stays";
import { adjacent, cardAt, slotOf, slotsOf, type ZoneSlot } from "../zones";

export type TargetSpec =
  /** The unit running the script. */
  | { of: "self" }
  | { of: "selfHero" }
  | { of: "enemyHero" }
  /**
   * A card a script already has the id of: an instance captured in a `Resume`'s data (#50 Kpop
   * Fanatic), or one an enclosing scope enumerated. `transform`, `vanilla`, `setRadiant` and
   * `steal` each grew a private `instanceId` argument for want of this; it belongs here, so every
   * verb that takes a `TargetSpec` can name such a card without one of its own.
   */
  | { of: "instance"; instanceId: string }
  /** The n-th selection the play carried (R81), default the first. */
  | { of: "chosen"; index?: number };

export type PlayerSpec = "self" | "enemy";

export function playerOf(ctx: EffectContext, spec: PlayerSpec): PlayerId {
  return spec === "self" ? ctx.controller : opponentOf(ctx.controller);
}

export function resolveTarget(ctx: EffectContext, spec: TargetSpec): DamageTarget | null {
  if (spec.of === "self") return ctx.self === null ? null : { kind: "unit", instance: ctx.self };
  if (spec.of === "selfHero") return { kind: "hero", player: ctx.controller };
  if (spec.of === "enemyHero") return { kind: "hero", player: opponentOf(ctx.controller) };
  if (spec.of === "instance") {
    const instance = findInstance(ctx.state, spec.instanceId);
    return instance === undefined ? null : { kind: "unit", instance };
  }

  const selection = ctx.targets[spec.index ?? 0];
  if (selection === undefined) return null;
  if (selection.pick === "hero") return { kind: "hero", player: selection.player };
  if (selection.pick === "instance") {
    const instance = findInstance(ctx.state, selection.instanceId);
    if (instance === undefined) return null;
    // R174: a card chosen on the field is chosen as that stay. One an earlier effect of this same
    // list took off the field and that is back already — a fused card's #22 half sacrificed it and
    // Reborn returned it — is a new arrival (R83), and what this effect was aimed at is gone.
    if (instance.zone.z === "field" && leftFieldSince(ctx.events, ctx.eventsFrom ?? 0, instance.id)) return null;
    return { kind: "unit", instance };
  }
  return null;
}

/**
 * R174: whether a card is on the field on the same stay it had when the running script began — on
 * the field now, and not taken off it by anything this script's events show. A card an earlier
 * effect of the list bounced, sacrificed or exiled has no stay left, even once it is back.
 */
export function standsSinceScriptBegan(ctx: EffectContext, instanceId: string): boolean {
  const card = findInstance(ctx.state, instanceId);
  if (card === undefined || card.zone.z !== "field") return false;
  return !leftFieldSince(ctx.events, ctx.eventsFrom ?? 0, instanceId);
}

/** The instance a `TargetSpec` names, or null when it named a hero or nothing. */
export function instanceOf(ctx: EffectContext, spec: TargetSpec): CardInstance | null {
  const target = resolveTarget(ctx, spec);
  if (target === null || target.kind !== "unit") return null;
  return target.instance;
}

// ---------------------------------------------------------------------------
// Board scope: how a verb names cards nobody chose
// ---------------------------------------------------------------------------

/**
 * Which cards on the field a board-wide verb acts on (§3.1, §3.2). `TargetSpec` cannot carry this:
 * `resolveTarget` answers with one `DamageTarget | null`, and every verb written in it — `damage`,
 * `destroy`, `buff`, `transform` — is single-target by construction. So the scope is its own
 * vocabulary, defined once here, and each board-wide verb is a thin walk over `cardsInScope`.
 * `buffAllUnits`, `stealAll` and `switchAllPositions` are the same shape from before it existed.
 */
export type BoardScope = {
  /** Sides, relative to `ctx.controller`. Default "any". */
  side?: "any" | "self" | "enemy";
  /** Rows. Default `["units"]`; a verb that reaches permanents passes both (§6.3). */
  rows?: Row[];
  /** Card types to keep, by the def; absent keeps every type in the named rows. */
  types?: CardType[];
  /** Tags to keep (#61's "Human unit"). */
  tags?: Tag[];
  /** Tags to reject (#2's "non-Human", #43's "non-Felinor"). */
  notTags?: Tag[];
  /** Leave the card running the script standing (#100 "all *other* permanents"). */
  excludeSelf?: boolean;
};

/**
 * R68's walk order: the active player's side first, then the opponent's. Exported because heroes
 * are not cards, so a sweep that also hits heroes (#13's `heroes: true`) needs the side order
 * without going through `cardsInScope` — which answers nothing at all on a cleared board, while
 * that sweep must still reach the hero.
 */
export function sidesOf(ctx: EffectContext, side: BoardScope["side"]): PlayerId[] {
  if (side === "self") return [ctx.controller];
  if (side === "enemy") return [opponentOf(ctx.controller)];
  const active = ctx.state.active;
  return PLAYER_IDS.includes(active) ? [active, opponentOf(active)] : [...PLAYER_IDS];
}

/** Whether one card passes a scope's filters. Zone membership is the caller's business. */
export function matchesScope(ctx: EffectContext, card: CardInstance, scope: BoardScope = {}): boolean {
  if (scope.excludeSelf === true && ctx.self !== null && card.id === ctx.self.id) return false;
  const def = defOf(ctx.state, card.defId);
  if (scope.types !== undefined && !scope.types.includes(def.type)) return false;
  if (scope.tags !== undefined && !scope.tags.some((tag) => def.tags.includes(tag))) return false;
  if (scope.notTags !== undefined && scope.notTags.some((tag) => def.tags.includes(tag))) return false;
  return true;
}

/** The slots a scope covers, in R68 order: side by side, then row by row, lane 1 upward. */
function slotsInScope(ctx: EffectContext, scope: BoardScope = {}): ZoneSlot[] {
  const rows = scope.rows ?? ["units"];
  return sidesOf(ctx, scope.side).flatMap((player) => rows.flatMap((row) => slotsOf(player, row)));
}

/**
 * Every card on the field a scope matches, in R68 order (the active player's side first, then the
 * opponent's; within a side the named rows lane 1 upward). Only the top card of a Stack pile is on
 * the field, so a dormant card underneath is never matched (§3.2, R13).
 */
export function cardsInScope(ctx: EffectContext, scope: BoardScope = {}): CardInstance[] {
  const out: CardInstance[] = [];
  for (const ref of slotsInScope(ctx, scope)) {
    const card = cardAt(ctx.state, ref);
    if (card === null) continue;
    if (!matchesScope(ctx, card, scope)) continue;
    out.push(card);
  }
  return out;
}

/**
 * §3.1 Adjacent: lanes N-1 and N+1 on the target's own side and row, never across sides and never
 * the target itself. An empty or dormant neighbour contributes nothing (§3.2, R13). The target may
 * be anywhere the spec can name it; off the field it has no neighbours.
 */
export function adjacentTo(ctx: EffectContext, spec: TargetSpec, scope: BoardScope = {}): CardInstance[] {
  const card = instanceOf(ctx, spec);
  if (card === null || card.zone.z !== "field") return [];
  const ref = slotOf(ctx.state, card);
  if (ref === null) return [];

  const out: CardInstance[] = [];
  for (const neighbour of adjacent(ref)) {
    const found = cardAt(ctx.state, neighbour);
    if (found === null || found.id === card.id) continue;
    if (!matchesScope(ctx, found, scope)) continue;
    out.push(found);
  }
  return out;
}
