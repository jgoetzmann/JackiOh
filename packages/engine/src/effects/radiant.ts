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
  // R311: a library card's `knownAs` is left as it was, so its owner's list keeps showing the face
  // it went in with — the change was made where nobody reads it.
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
 * Every card of the named zones, Radiant ones included, in hand order, library top down and lane
 * order, so a draw over them depends only on (seed, cursor). A random pick narrows it to the
 * non-Radiant cards group by group (R60, R242); a per-card roll (#42) takes every one
 * (`radiantChance`).
 */
function poolOf(ctx: EffectContext, player: PlayerId, zones: readonly RadiantZone[]): CardInstance[] {
  const side = ctx.state.players[player];
  const seen = new Set<string>();
  const pool: CardInstance[] = [];
  for (const zone of zones) {
    const cards =
      zone === "hand" ? side.hand : zone === "library" ? side.library : fieldCardsOf(ctx, player);
    for (const card of cards) {
      if (seen.has(card.id)) continue;
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
 * when none are left (R60) — split by who may read each card when the zones mix them (R242).
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
      // The zones' cards in their own order, read before anything changes, split by who reads them.
      const everyCard = poolOf(ctx, player, zones);
      const groups = READERS.map((reader) => everyCard.filter((card) => readersOf(ctx, card) === reader));
      // R242: a public card's face is public, so only its non-Radiant cards are slots; a hidden
      // card is a slot whatever its face, since whether it is Radiant is what the reader may not see.
      const slots = groups.map((cards, at) => (READERS[at] === "everyone" ? cards.filter((card) => !card.radiant) : cards));
      const quotas = splitPicks(ctx, slots.map((cards) => cards.length), count);

      const chosen = new Set<string>();
      groups.forEach((cards, at) => {
        const quota = quotas[at] ?? 0;
        if (quota <= 0) return;
        // R60 within the group: its non-Radiant cards, uniformly; R129: nothing drawn when none is left.
        const fresh = cards.filter((card) => !card.radiant);
        const picks = fresh.length === 0 ? [] : ctx.rng.shuffle(fresh).slice(0, quota);
        for (const card of picks) chosen.add(card.id);
        // R177: the picks the group could not make are cued on its Radiant cards, in its own order,
        // so a hidden group's cues always number its share of the pick.
        for (const card of cards.filter((held) => held.radiant).slice(0, quota - picks.length)) chosen.add(card.id);
      });
      // R242: the events go out group by group — the public cards', the owner's hidden cards', then
      // the library's — each in the zones' own order (hand order, lane order, the library top down).
      // In the zones' order a pick's place beside a public pick would say which zone it was in, and
      // so which hidden card was base-face: the hand's comes before a unit's, a face-down trap's after.
      for (const cards of groups) {
        for (const card of cards) if (chosen.has(card.id)) makeRadiant(ctx, card);
      }
    },
  };
}

/**
 * R242: who may read a card of a random pick's pool where it sits — everyone (a unit, a face-up
 * backrow card), only the player whose side it is on (their hand, their face-down trap: §9.1, R33),
 * or nobody (a library, §3). The groups are listed in the order their events go out.
 */
const READERS = ["everyone", "owner", "nobody"] as const;

type Readers = (typeof READERS)[number];

function readersOf(ctx: EffectContext, card: CardInstance): Readers {
  if (card.zone.z === "library") return "nobody";
  return hiddenFromSomeone(ctx, card) ? "owner" : "everyone";
}

/**
 * R242: how many of `count` picks each reader group takes — a uniform draw of `count` different
 * slots among all of them, which is how a uniform pick of `count` cards over the whole pool falls,
 * except that a hidden card is a slot whatever its face. So the chance that a public card is picked,
 * and how many picks land among each player's unread cards, hang on the groups' sizes alone, which
 * both players can count: never on a face a player may not read (§9.1). When every slot is taken, or
 * the pool is one group only, there is nothing random to decide and nothing is drawn (R129) — which
 * leaves a single group's pick exactly R60's.
 */
function splitPicks(ctx: EffectContext, sizes: readonly number[], count: number): number[] {
  const total = sizes.reduce((sum, size) => sum + size, 0);
  const groups = sizes.filter((size) => size > 0).length;
  if (total <= count || groups <= 1) return sizes.map((size) => Math.min(size, count));
  const slots = sizes.flatMap((size, at) => Array.from({ length: size }, () => at));
  const quotas = sizes.map(() => 0);
  for (const at of ctx.rng.shuffle(slots).slice(0, count)) quotas[at] = (quotas[at] ?? 0) + 1;
  return quotas;
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
      for (const card of poolOf(ctx, player, zones)) {
        const roll = (): boolean => ctx.rng.chance(args.chance);
        if (lucky === 0 ? roll() : ctx.rng.lucky(lucky, roll, keepSuccess)) makeRadiant(ctx, card);
      }
    },
  };
}
