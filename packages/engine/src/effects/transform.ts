// Transform and Vanilla (SPEC §6.3): the two verbs that rewrite what a card is, so Immutable
// refuses both (R23). A Transform puts a new instance of another definition in the same zone and
// position, with no Cry (R1); the card it replaces ceases to exist rather than reaching a graveyard
// (R35). Vanilla is a flag the layers read (§10.4): stats, buffs and damage are other layers and
// must survive it, and the definition is shared by every copy of the card, so it is never edited.

import type { CardDef, CardType, PlayerId, Row } from "@jackioh/shared";
import { PLAYER_IDS, opponentOf } from "@jackioh/shared";
import { defOf } from "../catalog";
import { unitHas } from "../layers";
import type { Effect, EffectContext } from "../script";
import { newInstance, type CardInstance } from "../state";
import { ceaseToExist, moveToZone, replaceInZone, slotOf, zoneOf, type OffFieldZone } from "../zones";
import { instanceOnItsStay, resolveTarget, type TargetSpec } from "./targets";

/**
 * Which card to rewrite: the pick the play or a prompt carried (R81), or an instance id a trigger
 * read off the event it answers — Sheepish transforms the unit the opponent just played (#41).
 */
export type TransformTarget = { target?: TargetSpec; instanceId?: string };

function instanceOf(ctx: EffectContext, args: TransformTarget): CardInstance | null {
  // R174: a card named by id is aimed at the stay it had when the run began (`instanceOnItsStay`).
  if (args.instanceId !== undefined) return instanceOnItsStay(ctx, args.instanceId);
  const target = resolveTarget(ctx, args.target ?? { of: "chosen" });
  if (target === null || target.kind !== "unit") return null;
  return target.instance;
}

/** §5.1: the row a type lives in; a Spell is never a permanent, so it can never replace one. */
function rowFor(type: CardType): Row | null {
  if (type === "Unit") return "units";
  if (type === "Spell") return null;
  return "backrow";
}

/**
 * §6.3 Replace: the same zone and position, with the old card's owner and controller. The new card
 * takes the old one's place (`zones.replaceInZone`) rather than being summoned into an emptied zone:
 * a Transform result is no summon (§6.2), so the Lock §3.2 puts on a zone — "accepts no summons … the
 * current occupant is unaffected" — does not refuse it, and neither does a reservation (R64). #36
 * Magic Jammed locks the zone of a Heroic Power it could not destroy (R46), and radiant #36 locks
 * the zone of a card it could not steal (R15); R35 still replaces either. A Stack pile keeps its
 * dormant cards beneath the replacement (§3.2).
 */
function replaceOnField(ctx: EffectContext, old: CardInstance, def: CardDef, radiant: boolean): CardInstance | null {
  const at = slotOf(ctx.state, old);
  if (at === null) return null;
  if (rowFor(def.type) !== at.row) return null;

  const replacement = newInstance(ctx.state, def.id, old.owner, zoneOf(at));
  replacement.radiant = radiant;
  if (old.position !== undefined) replacement.position = old.position;
  // A new body enters the field this turn, so it is summoning sick like a summoned card (§4.1).
  replacement.summonedTurn = ctx.state.turn;

  if (!replaceInZone(ctx.state, old, replacement)) return null;
  // The replaced card ceases to exist: no graveyard, no exile pile, no Death trigger (§6.3, R35) —
  // and it has left the field, which R174 counts like any departure (`zones.ceaseToExist`).
  ceaseToExist(ctx.state, old);
  // §3.2: a Field Spell is public where a Trap stays face-down until it fires (R33).
  if (def.type === "Field Spell") replacement.faceUp = true;
  return replacement;
}

/**
 * R35's other zones: Transmogulate replaces hand, library, graveyard and exile cards too, "same
 * counts" per zone. A library keeps its order, so the replacement takes the old card's index;
 * `moveToZone` appends in the other piles, which leaves a wholly replaced hand in its old order.
 */
function replaceOffField(ctx: EffectContext, old: CardInstance, def: CardDef, radiant: boolean): CardInstance | null {
  const zone = old.zone.z;
  // A card mid-resolution, or one that has ceased to exist (R11), is in no pile to replace it in.
  if (zone === "field" || zone === "resolving" || zone === "gone") return null;
  const at: OffFieldZone = zone;
  // R11: a unit-token card cannot sit in a graveyard or exile, so a replacement that would cease
  // to exist on arrival is refused instead of thinning the zone.
  if ((at === "graveyard" || at === "exile") && def.token && def.type === "Unit") return null;

  const owner = old.owner;
  const pile = ctx.state.players[owner][at];
  const index = pile.findIndex((card) => card.id === old.id);
  if (index < 0) return null;

  ceaseToExist(ctx.state, old);
  const replacement = newInstance(ctx.state, def.id, owner, { z: at, player: owner });
  replacement.radiant = radiant;
  moveToZone(ctx.state, replacement, at, { position: index });
  return replacement;
}

/**
 * §6.3 Transform: a new instance of `defId` where the old card was, no Cry (R1), and the old card
 * ceases to exist. Immutable refuses it (R23), and so does a definition that cannot live in the
 * zone the old card occupies (§5.1).
 */
export function transform(args: TransformTarget & { defId: string; radiant?: boolean }): Effect {
  return {
    kind: "transform",
    apply(ctx): void {
      const old = instanceOf(ctx, args);
      if (old === null) return;
      // R23: Immutable blocks a Transform, which is what a Replace is on the field (§6.3). Off the
      // field a Replace is no Transform — the card is not rewritten, it ceases to exist and another
      // takes its place — so R35's "other zones: any card from the pool, same counts" replaces an
      // Immutable card too, and a library keeps its count whatever it held (§9.1).
      if (old.zone.z === "field" && unitHas(ctx.state, old, "Immutable")) return;

      const def = defOf(ctx.state, args.defId);
      const radiant = args.radiant === true;
      const fromDefId = old.defId;
      const hiddenFrom = unreadableBy(ctx, old);
      const replacement =
        old.zone.z === "field"
          ? replaceOnField(ctx, old, def, radiant)
          : replaceOffField(ctx, old, def, radiant);
      if (replacement === null) return;

      ctx.events.push({
        type: "transformed",
        instanceId: old.id,
        fromDefId,
        toDefId: replacement.defId,
        newInstanceId: replacement.id,
        ...(hiddenFrom.length === 0 ? {} : { hiddenFrom }),
      });
    },
  };
}

/**
 * R177: who could not read this card where it is, read before it ceases to exist there — a library
 * card is hidden from both players (§9.1), a hand card from the other one, and a face-down trap from
 * everyone but its controller (R33). A card that ceases to exist leaves no zone of its own to be
 * judged by later, so the event records this for the view.
 */
function unreadableBy(ctx: EffectContext, card: CardInstance): PlayerId[] {
  const zone = card.zone;
  if (zone.z === "library") return [...PLAYER_IDS];
  if (zone.z === "hand") return [opponentOf(zone.player)];
  if (zone.z !== "field" || zone.row !== "backrow" || card.faceUp === true) return [];
  const type = defOf(ctx.state, card.defId).type;
  return type === "Trap" || type === "Field Trap" ? [opponentOf(card.controller)] : [];
}

/**
 * §6.3 Vanilla: the card's text stops applying — its printed keywords and its scripts — while its
 * stats, buffs and damage stay. Immutable refuses it (R23), and a card that is already Vanilla is
 * unchanged. The flag lives on the instance; the layers read it (§10.4) and R78 clears it when the
 * card leaves the field.
 */
export function vanilla(args: TransformTarget = {}): Effect {
  return {
    kind: "vanilla",
    apply(ctx): void {
      const card = instanceOf(ctx, args);
      if (card === null) return;
      if (unitHas(ctx.state, card, "Immutable")) return;
      if (card.vanilla) return;

      card.vanilla = true;
      // No instance is created and no definition changes, so both sides of `transformed` name the
      // same card and the same def: the event the client animates is the text going away.
      ctx.events.push({
        type: "transformed",
        instanceId: card.id,
        fromDefId: card.defId,
        toDefId: card.defId,
        newInstanceId: card.id,
      });
    },
  };
}
