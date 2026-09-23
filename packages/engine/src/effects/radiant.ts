// Make Radiant (SPEC §6.3, §5.2, R74): set the instance's `radiant` flag, and nothing else. The
// flag is the whole model — never a separate card id — so in hand or library the stats and text
// swap on the next read, and on the field the base-stat layer swaps at once while damage and buffs
// stay and no Cry re-fires, because setting a flag is not an entry to the field (R22).

import type { PlayerId } from "@jackioh/shared";
import { defOf } from "../catalog";
import type { Effect, EffectContext } from "../script";
import { findInstance, type CardInstance } from "../state";
import { cardAt, slotsOf } from "../zones";
import { playerOf, resolveTarget, type PlayerSpec, type TargetSpec } from "./targets";

/**
 * Which card becomes Radiant: the pick the play or a prompt carried (#26 Glowy Jelly Bean's hand
 * pick, R81), `{ of: "self" }` for Radiant Saintess including itself (R22), or an instance id a
 * script captured earlier. All plain data, so a card file stays pure (CLAUDE.md rule 5).
 */
export type RadiantTarget = { target?: TargetSpec; instanceId?: string };

/** Where a random "becomes Radiant" looks: one zone, or the union of several (#28). */
export type RadiantZone = "hand" | "library" | "field";

function instanceOf(ctx: EffectContext, args: RadiantTarget): CardInstance | null {
  if (args.instanceId !== undefined) return findInstance(ctx.state, args.instanceId) ?? null;
  const target = resolveTarget(ctx, args.target ?? { of: "chosen" });
  if (target === null || target.kind !== "unit") return null;
  return target.instance;
}

/**
 * R97, R177: whether some player may not read this card where it sits — a hand is its owner's alone
 * and a library nobody's (§9.1), and a face-down trap is read by its controller only (R33, §10.8).
 */
function hiddenFromSomeone(ctx: EffectContext, card: CardInstance): boolean {
  const zone = card.zone;
  if (zone.z === "hand" || zone.z === "library") return true;
  if (zone.z !== "field" || zone.row !== "backrow" || card.faceUp === true) return false;
  const type = defOf(ctx.state, card.defId).type;
  return type === "Trap" || type === "Field Trap";
}

/**
 * §5.2: the flag is never unset, so a card that is already Radiant is untouched (§6.3). The cue is
 * another matter on a card someone may not read: R97 keeps a hidden card's event in the other seat's
 * stream, redacted but present, so a cue only for the cards that changed would count, for the
 * opponent, which of #29's hand or #26's chosen card were Radiant already — the face R177 hides. So a
 * named Make Radiant on a hidden card is always reported, changed or not; the random picks only ever
 * pick non-Radiant cards (R60), and a public card's face is public either way.
 */
function makeRadiant(ctx: EffectContext, card: CardInstance): boolean {
  if (card.radiant) {
    if (hiddenFromSomeone(ctx, card)) {
      ctx.events.push({ type: "radiantSet", instanceId: card.id, defId: card.defId, zone: card.zone });
    }
    return false;
  }
  card.radiant = true;
  ctx.events.push({ type: "radiantSet", instanceId: card.id, defId: card.defId, zone: card.zone });
  return true;
}

/** §3.2 and R13: only the top of a Stack pile is on the field, so only it can be picked. */
function fieldCardsOf(ctx: EffectContext, player: PlayerId): CardInstance[] {
  return (["units", "backrow"] as const).flatMap((row) =>
    slotsOf(player, row).flatMap((ref) => {
      const card = cardAt(ctx.state, ref);
      return card === null ? [] : [card];
    }),
  );
}

/**
 * The cards a random pick may choose from: hand order, library top down and lane order, so the
 * draw depends only on (seed, cursor). R60 narrows it to the non-Radiant cards.
 */
function poolOf(ctx: EffectContext, player: PlayerId, zones: readonly RadiantZone[]): CardInstance[] {
  const side = ctx.state.players[player];
  const seen = new Set<string>();
  const pool: CardInstance[] = [];
  for (const zone of zones) {
    const cards =
      zone === "hand" ? side.hand : zone === "library" ? side.library : fieldCardsOf(ctx, player);
    for (const card of cards) {
      if (card.radiant || seen.has(card.id)) continue;
      seen.add(card.id);
      pool.push(card);
    }
  }
  return pool;
}

/** §6.3 Make Radiant: one named card, with no effect when it is already Radiant. */
export function setRadiant(args: RadiantTarget = {}): Effect {
  return {
    kind: "setRadiant",
    apply(ctx): void {
      const card = instanceOf(ctx, args);
      if (card === null) return;
      makeRadiant(ctx, card);
    },
  };
}

/**
 * A random "becomes Radiant" (#23, #27, #28, #93 grade B): `count` different cards drawn uniformly
 * from the non-Radiant cards of the named zones, all of them when fewer exist, and nothing at all
 * when none are left (R60).
 */
export function setRadiantRandom(args: {
  zones: RadiantZone | RadiantZone[];
  count?: number;
  player?: PlayerSpec;
}): Effect {
  return {
    kind: "setRadiantRandom",
    apply(ctx): void {
      const player = playerOf(ctx, args.player ?? "self");
      const zones = Array.isArray(args.zones) ? args.zones : [args.zones];
      const pool = poolOf(ctx, player, zones);
      if (pool.length === 0) return;

      const count = Math.max(0, Math.trunc(args.count ?? 1));
      for (const card of ctx.rng.shuffle(pool).slice(0, count)) makeRadiant(ctx, card);
    },
  };
}

/** §6.1's Lucky X keeps "the best"; for a chance roll that is a success beating a failure (R32). */
function keepSuccess(a: boolean, b: boolean): boolean {
  return a || b;
}

/**
 * A per-card chance rather than a pick of N (#42 Eugenics: "each remaining library card has a 30%
 * chance to become Radiant", radiant "Lucky 1 at 40%"). One INDEPENDENT `rng.chance` roll per
 * non-Radiant card in the named zones, in `poolOf`'s order — hand order, library top down, lane
 * order — so the draws depend only on (seed, cursor) and nothing else (§10.7).
 *
 * R60 makes the flag the whole model and nothing ever unsets it, so an already-Radiant card is
 * skipped by `poolOf` rather than rolled: the number of draws is the number of non-Radiant cards.
 * `lucky: n` is §6.1's Lucky X — n extra rolls per card, keeping the success — so the draw count is
 * (n + 1) per card, which is what makes "Lucky 1 at 40%" two rolls a card.
 *
 * ORDER WITHIN AN EFFECT LIST. #42 exiles 8 cards first and then rolls over what is LEFT. The pool
 * is read here, when this effect applies, straight off the live library, so an exile earlier in the
 * same list has already taken its cards out and they are never rolled — §4.5 and R59 put the state
 * check after the whole list, never between two of its effects.
 */
export function radiantChance(args: {
  /**
   * Which zones are rolled. Singular to match the card files; `setRadiantRandom` above spells the
   * same argument `zones`, and the inconsistency is reported rather than papered over by accepting
   * both names here.
   */
  zone: RadiantZone | RadiantZone[];
  /** The per-card probability, as `rng.chance` reads it: 0.3 for "30%". */
  chance: number;
  /** §6.1 Lucky X: this many extra rolls per card, keeping the success. */
  lucky?: number;
  player?: PlayerSpec;
}): Effect {
  return {
    kind: "radiantChance",
    apply(ctx): void {
      const player = playerOf(ctx, args.player ?? "self");
      const zones = Array.isArray(args.zone) ? args.zone : [args.zone];
      const lucky = Math.max(0, Math.trunc(args.lucky ?? 0));

      // The pool is a snapshot of the non-Radiant cards, so a card this effect just flagged is
      // never reconsidered and every card gets exactly its own rolls.
      for (const card of poolOf(ctx, player, zones)) {
        const roll = (): boolean => ctx.rng.chance(args.chance);
        if (lucky === 0 ? roll() : ctx.rng.lucky(lucky, roll, keepSuccess)) makeRadiant(ctx, card);
      }
    },
  };
}
