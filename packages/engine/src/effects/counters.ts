// Counters on an instance and locks on a zone (§6.3). Plague Tokens live on the instance and R78
// clears them when the card leaves the field; a Lock lives on the zone and outlives every occupant.

import type { Row } from "@jackioh/shared";
import type { Effect, EffectContext } from "../script";
import type { CardInstance } from "../state";
import { isLocked, lockZone, rowSize, slotOf, type ZoneSlot } from "../zones";
import { playerOf, type PlayerSpec, resolveTarget, type TargetSpec } from "./targets";

function instanceOf(ctx: EffectContext, spec: TargetSpec): CardInstance | null {
  const target = resolveTarget(ctx, spec);
  return target === null || target.kind !== "unit" ? null : target.instance;
}

function emitCounter(ctx: EffectContext, card: CardInstance, value: number): void {
  ctx.events.push({ type: "counterChanged", instanceId: card.id, counter: "plague", value });
}

/** The tokens this card carries now; an untouched card carries none (§6.3 Plague Token). */
function plagueOn(card: CardInstance): number {
  return card.counters.plague ?? 0;
}

function setPlague(ctx: EffectContext, card: CardInstance, next: number): void {
  const value = Math.max(0, Math.trunc(next));
  if (value === plagueOn(card)) return;
  if (value === 0) delete card.counters.plague;
  else card.counters.plague = value;
  emitCounter(ctx, card, value);
}

/**
 * #91 Fed Fauci: add Plague Tokens to a permanent, any number of them. A negative amount takes
 * them off and the count floors at 0; R78 resets the counter when the card leaves the field.
 */
export function plague(args: { target?: TargetSpec; amount: number }): Effect {
  return {
    kind: "plague",
    apply(ctx): void {
      const card = instanceOf(ctx, args.target ?? { of: "self" });
      if (card === null) return;
      setPlague(ctx, card, plagueOn(card) + Math.trunc(args.amount));
    },
  };
}

/** Clear every Plague Token on a permanent. */
export function clearPlague(args: { target?: TargetSpec } = {}): Effect {
  return {
    kind: "clearPlague",
    apply(ctx): void {
      const card = instanceOf(ctx, args.target ?? { of: "self" });
      if (card === null) return;
      setPlague(ctx, card, 0);
    },
  };
}

/**
 * Which zone a Lock names: the one this card sits in, the one a named card sits in (#36 Magic
 * Jammed locks its target's zone, so the lock effect runs before the destroy that empties it), or
 * a lane by index (§3.1 "this lane").
 */
export type ZoneSpec =
  | { of: "self" }
  | { of: "chosen"; index?: number }
  | { of: "lane"; row: Row; lane: number; player?: PlayerSpec };

function zoneFor(ctx: EffectContext, spec: ZoneSpec): ZoneSlot | null {
  if (spec.of === "lane") {
    if (spec.lane < 1 || spec.lane > rowSize(spec.row)) return null;
    return { player: playerOf(ctx, spec.player ?? "self"), row: spec.row, lane: spec.lane };
  }
  const card = spec.of === "self" ? ctx.self : instanceOf(ctx, spec);
  return card === null ? null : slotOf(ctx.state, card);
}

/**
 * §3.2 Lock: the zone accepts no summons for the rest of the game. The current occupant is
 * unaffected and the lock persists after it leaves; nothing in Core unlocks a zone.
 */
export function lock(args: { zone: ZoneSpec }): Effect {
  return {
    kind: "lock",
    apply(ctx): void {
      const ref = zoneFor(ctx, args.zone);
      if (ref === null || isLocked(ctx.state, ref)) return;
      lockZone(ctx.state, ref);
      ctx.events.push({ type: "locked", player: ref.player, row: ref.row, lane: ref.lane });
    },
  };
}
