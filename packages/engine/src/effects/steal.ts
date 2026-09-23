// Steal (SPEC §6.3): take control of a card on the field. Control is a field-only notion, so the
// card keeps its owner and still goes to that owner's hand, library, graveyard or exile when it
// later leaves the field (R12, §3.2). Where it lands is R15, and it keeps its damage, buffs,
// counters and position because it never leaves the field, which is what R78's reset is about.
// What a steal does change besides `controller` is R171's: the card has entered its new
// controller's side on this turn, so it takes the turn as its `summonedTurn` (summoning sick, §4.1)
// and a fresh exertion. A steal that does nothing (R15, R76) changes neither.

import type { PlayerId, Row } from "@jackioh/shared";
import { opponentOf } from "@jackioh/shared";
import { enterNewSide, isActiveOnField } from "../combat";
import type { Effect, EffectContext } from "../script";
import type { CardInstance } from "../state";
import {
  cardAt,
  firstFreeZone,
  isOpen,
  placeOnField,
  removeFromField,
  slotOf,
  slotsOf,
  type ZoneSlot,
} from "../zones";
import { instanceOnItsStay, resolveTarget, type TargetSpec } from "./targets";

/**
 * Which card to steal: the pick the play or a prompt carried (R81), or an instance id a script
 * captured earlier — Kpop Fanatic's delayed steal names its target that way (R76). Both are plain
 * data, so a card file never holds a closure over state (CLAUDE.md rule 5).
 */
export type StealTarget = { target?: TargetSpec; instanceId?: string };

function instanceOf(ctx: EffectContext, args: StealTarget): CardInstance | null {
  // R174: a card named by id is aimed at the stay it had when the run began (`instanceOnItsStay`).
  if (args.instanceId !== undefined) return instanceOnItsStay(ctx, args.instanceId);
  const target = resolveTarget(ctx, args.target ?? { of: "chosen" });
  if (target === null || target.kind !== "unit") return null;
  return target.instance;
}

/** R15: the same lane on the stealer's side when that zone is free, else its first free zone. */
function destinationFor(ctx: EffectContext, thief: PlayerId, from: ZoneSlot): ZoneSlot | null {
  const sameLane: ZoneSlot = { player: thief, row: from.row, lane: from.lane };
  if (isOpen(ctx.state, sameLane)) return sameLane;
  return firstFreeZone(ctx.state, thief, from.row);
}

/**
 * One card to `ctx.controller`'s side. Nothing happens when the card is not on the field (control
 * means nothing off it, R12), when that player already controls it (R76), or when the row has no
 * free zone: then it stays with its owner (R15).
 */
function takeControl(ctx: EffectContext, card: CardInstance): boolean {
  const from = slotOf(ctx.state, card);
  if (from === null) return false;
  // R13: only the top of a Stack pile is on the field. A card dormant under one — #50's chosen
  // permanent after a Stack card was played onto it — is not there to be taken.
  if (!isActiveOnField(ctx.state, card)) return false;
  if (card.controller === ctx.controller) return false;
  const previous = card.controller;

  const to = destinationFor(ctx, ctx.controller, from);
  if (to === null) return false;

  removeFromField(ctx.state, card);
  if (!placeOnField(ctx.state, card, to)) {
    // `to` was open a line ago and the card came off the other side of the field, so this cannot
    // happen; putting the card back keeps the board legal rather than losing it to a refusal.
    placeOnField(ctx.state, card, from, { stack: true });
    return false;
  }

  // R171: the card has entered its new controller's side on this turn.
  enterNewSide(ctx, card, previous);

  // R33: a stolen face-down trap stays face-down, and the new controller is the one who may read
  // it — the controller decides that, so `faceUp` is deliberately untouched here.
  ctx.events.push({
    type: "controlChanged",
    instanceId: card.id,
    controller: to.player,
    row: to.row,
    lane: to.lane,
  });
  return true;
}

/** §6.3 Steal: take control of one card on the field (#36 radiant, #49, #50). */
export function steal(args: StealTarget = {}): Effect {
  return {
    kind: "steal",
    apply(ctx): void {
      const card = instanceOf(ctx, args);
      if (card === null) return;
      takeControl(ctx, card);
    },
  };
}

/**
 * "Miss" Mrow's Death: steal every enemy card of a row (#86). Lane order (§3.2), each placed per
 * R15, and the ones that find no free zone stay with their owner. Only the top of a Stack pile is
 * on the field, so only it is taken (R13).
 */
export function stealAll(args: { row?: Row } = {}): Effect {
  return {
    kind: "stealAll",
    apply(ctx): void {
      const row = args.row ?? "units";
      for (const ref of slotsOf(opponentOf(ctx.controller), row)) {
        const card = cardAt(ctx.state, ref);
        if (card !== null) takeControl(ctx, card);
      }
    },
  };
}
