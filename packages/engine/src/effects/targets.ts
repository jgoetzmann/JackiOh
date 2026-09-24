// How an effect names what it acts on. A card script writes a spec; the engine resolves it against
// the context, so a card file never reaches into state (CLAUDE.md rule 5).

import type { CardType, PlayerId, Row, Tag } from "@jackioh/shared";
import { PLAYER_IDS, opponentOf } from "@jackioh/shared";
import { defOf } from "../catalog";
import type { DamageTarget } from "../damage";
import type { EffectContext } from "../script";
import { findInstance, type CardInstance } from "../state";
import { exitMark, leftFieldAfter } from "../stays";
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
  if (spec.of === "self") {
    const self = selfOnItsStay(ctx);
    return self === null ? null : { kind: "unit", instance: self };
  }
  if (spec.of === "selfHero") return { kind: "hero", player: ctx.controller };
  if (spec.of === "enemyHero") return { kind: "hero", player: opponentOf(ctx.controller) };
  if (spec.of === "instance") {
    const instance = instanceOnItsStay(ctx, spec.instanceId);
    return instance === null ? null : { kind: "unit", instance };
  }

  const selection = ctx.targets[spec.index ?? 0];
  if (selection === undefined) return null;
  if (selection.pick === "hero") return { kind: "hero", player: selection.player };
  if (selection.pick === "instance") {
    const instance = findInstance(ctx.state, selection.instanceId);
    if (instance === undefined) return null;
    // R174: a card chosen on the field is chosen as that stay. One an earlier effect of this same
    // list took off the field is gone for this one, wherever it is now: back already — a fused
    // card's #22 half sacrificed it and Reborn returned it, a new arrival (R83) — or in a graveyard
    // or a hand, reset (R78), where a buff or an exile aimed at the unit on the field has nothing to
    // land on (§8 Conventions). The same holds when a prompt split the list across actions (R113),
    // and for a play's declared target a trap answering the play took off the field at §10.5 step 4
    // (the play's Cry runs with the mark step 1 checked the choices at). A pick an answer made is
    // chosen as its prompt offered it (`ctx.chosenFrom`, §10.6): a Reborn body the list's own
    // sacrifice put back before it asked is the stay that was picked.
    if (leftFieldAfter(ctx.state, ctx.chosenFrom ?? ctx.exitsFrom ?? exitMark(ctx.state), instance.id)) return null;
    return { kind: "unit", instance };
  }
  return null;
}

/**
 * R174: a card a script names by its id — captured in a continuation's data, read off the event a
 * trigger answers, or enumerated by the list itself — on the stay it had when the run began. An
 * effect later in the list is aimed at the card the list named, and a card an earlier effect of the
 * same list took off the field is gone for it wherever it is now, a Reborn body included (R83);
 * naming it by id rather than as "the chosen one" changes nothing, and neither does a prompt that
 * split the list (R113). Null when there is no such card.
 */
export function instanceOnItsStay(ctx: EffectContext, instanceId: string): CardInstance | null {
  const instance = findInstance(ctx.state, instanceId);
  if (instance === undefined) return null;
  return leftFieldSince(ctx, instance.id) ? null : instance;
}

/**
 * R174: the card running the script, while it is on the stay it had when the run began — a card an
 * earlier effect of the same list took off the field (#22's sacrifice, radiant #52's bounce) is gone
 * for "this", even once it is back, and a card R78 has reset in a hand is not what the effect was
 * aimed at. A card that never stood on the field in the run (a Spell resolving, a hand card) has no
 * stay to lose, and a Death hook's snapshot (R89) died before its hook began.
 */
export function selfOnItsStay(ctx: EffectContext): CardInstance | null {
  const self = ctx.self;
  if (self === null) return null;
  return leftFieldSince(ctx, self.id) ? null : self;
}

/**
 * R174: whether a card is on the field on the same stay it had when the running script began — on
 * the field now, and not taken off it since. A card an earlier effect of the list bounced,
 * sacrificed or exiled has no stay left, even once it is back.
 */
export function standsSinceScriptBegan(ctx: EffectContext, instanceId: string): boolean {
  const card = findInstance(ctx.state, instanceId);
  if (card === undefined || card.zone.z !== "field") return false;
  return !leftFieldSince(ctx, instanceId);
}

/** R174: whether a card has left the field since the running script began (`ctx.exitsFrom`). */
function leftFieldSince(ctx: EffectContext, instanceId: string): boolean {
  return leftFieldAfter(ctx.state, ctx.exitsFrom ?? exitMark(ctx.state), instanceId);
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
