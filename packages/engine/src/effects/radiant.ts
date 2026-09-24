// Make Radiant (SPEC §6.3, §5.2, R74): set the instance's `radiant` flag, and nothing else. The
// flag is the whole model — never a separate card id — so in hand or library the stats and text
// swap on the next read, and on the field the base-stat layer swaps at once while damage and buffs
// stay and no Cry re-fires, because setting a flag is not an entry to the field (R22).

import type { PlayerId } from "@jackioh/shared";
import { defOf } from "../catalog";
import type { Effect, EffectContext } from "../script";
import type { CardInstance } from "../state";
import { cardAt, slotsOf } from "../zones";
import { playerOf, instanceOnItsStay, resolveTarget, type PlayerSpec, type TargetSpec } from "./targets";

/**
 * Which card becomes Radiant: the pick the play or a prompt carried (#26 Glowy Jelly Bean's hand
 * pick, R81), `{ of: "self" }` for Radiant Saintess including itself (R22), or an instance id a
 * script captured earlier. All plain data, so a card file stays pure (CLAUDE.md rule 5).
 */
export type RadiantTarget = { target?: TargetSpec; instanceId?: string };

/** Where a random "becomes Radiant" looks: one zone, or the union of several (#28). */
export type RadiantZone = "hand" | "library" | "field";

function instanceOf(ctx: EffectContext, args: RadiantTarget): CardInstance | null {
  // R174: a card named by id is aimed at the stay it had when the run began (`instanceOnItsStay`).
  if (args.instanceId !== undefined) return instanceOnItsStay(ctx, args.instanceId);
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
  gainPrintedShield(ctx, card);
  ctx.events.push({ type: "radiantSet", instanceId: card.id, defId: card.defId, zone: card.zone });
  return true;
}

/**
 * §5.2: on the field "newly gained keywords apply at once". A radiant face that prints Divine Shield
 * where the base face does not (#20, #50, #89) gives the unit a shield it did not have, so one an
 * earlier, granted Divine Shield spent is up again — the same as a shield granted again (§10.4,
 * `buff.grantTo`). A shield printed on both faces is not newly gained, and stays spent.
 */
function gainPrintedShield(ctx: EffectContext, card: CardInstance): void {
  // A Vanilla unit has no printed text on either face (§6.3), so its face prints no shield.
  if (card.zone.z !== "field" || card.divineShieldSpent !== true || card.vanilla) return;
  const def = defOf(ctx.state, card.defId);
  const prints = (keywords: readonly { kind: string }[] | undefined): boolean =>
    (keywords ?? []).some((keyword) => keyword.kind === "Divine Shield");
  if (prints(def.radiant.keywords) && !prints(def.base.keywords)) delete card.divineShieldSpent;
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
 * The cards of the named zones in hand order, library top down and lane order, so a draw over them
 * depends only on (seed, cursor). A random pick narrows it to the non-Radiant cards (R60); a
 * per-card roll (#42) takes every one (`radiantChance`).
 */
function poolOf(
  ctx: EffectContext,
  player: PlayerId,
  zones: readonly RadiantZone[],
  options: { radiantToo?: boolean } = {},
): CardInstance[] {
  const side = ctx.state.players[player];
  const seen = new Set<string>();
  const pool: CardInstance[] = [];
  for (const zone of zones) {
    const cards =
      zone === "hand" ? side.hand : zone === "library" ? side.library : fieldCardsOf(ctx, player);
    for (const card of cards) {
      if ((card.radiant && options.radiantToo !== true) || seen.has(card.id)) continue;
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
      const count = Math.max(0, Math.trunc(args.count ?? 1));
      const pool = poolOf(ctx, player, zones);
      const picked = pool.length === 0 ? [] : ctx.rng.shuffle(pool).slice(0, count);
      for (const card of picked) makeRadiant(ctx, card);
      cueUnpicked(ctx, player, zones, count - picked.length, new Set(picked.map((card) => card.id)));
    },
  };
}

/**
 * R177 over a random pick: R60 picks among the non-Radiant cards only, so when a hidden hand or
 * library holds fewer of them than the pick wants, fewer cards change — and a cue for the changed
 * cards alone would tell the other seat how many of the hidden ones were Radiant already (none at all
 * for an all-Radiant hand under #27). So the picks R60 could not make are cued on the zones' Radiant
 * cards in their own order, as a Make Radiant on a card that was already Radiant is (R177), until the
 * cues number what the pick wanted or the zones run out — and the zones' sizes are public. No card
 * changes and no random number is drawn for them (R129). A public card's face is public either way,
 * so only cards hidden from someone are cued.
 */
function cueUnpicked(
  ctx: EffectContext,
  player: PlayerId,
  zones: readonly RadiantZone[],
  missing: number,
  picked: ReadonlySet<string>,
): void {
  if (missing <= 0) return;
  let left = missing;
  for (const card of poolOf(ctx, player, zones, { radiantToo: true })) {
    if (left <= 0) return;
    if (picked.has(card.id) || !card.radiant || !hiddenFromSomeone(ctx, card)) continue;
    makeRadiant(ctx, card);
    left -= 1;
  }
}

/** §6.1's Lucky X keeps "the best"; for a chance roll that is a success beating a failure (R32). */
function keepSuccess(a: boolean, b: boolean): boolean {
  return a || b;
}

/**
 * A per-card chance rather than a pick of N (#42 Eugenics: "each remaining library card has a 30%
 * chance to become Radiant", radiant "Lucky 1 at 40%"). One INDEPENDENT `rng.chance` roll per
 * card in the named zones, in `poolOf`'s order — hand order, library top down, lane order — so the
 * draws depend only on (seed, cursor) and nothing else (§10.7).
 *
 * EVERY card is rolled, a Radiant one included. §8 #42 rolls "each remaining library card", and it
 * is not one of R60's random picks, which choose among the non-Radiant cards: skipping the Radiant
 * ones made the number of draws, and so every later draw, hang on how many of a library nobody may
 * read were Radiant already, and a success on one is cued like any other (R177), so the cues cannot
 * count them either (§9.1). A success on a card that is already Radiant changes nothing (§6.3).
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

      // The pool is a snapshot taken before any roll, so every card gets exactly its own rolls.
      for (const card of poolOf(ctx, player, zones, { radiantToo: true })) {
        const roll = (): boolean => ctx.rng.chance(args.chance);
        if (lucky === 0 ? roll() : ctx.rng.lucky(lucky, roll, keepSuccess)) makeRadiant(ctx, card);
      }
    },
  };
}
