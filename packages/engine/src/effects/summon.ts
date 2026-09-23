// Summon, Recruit and "fill your board": every way a card reaches the field without being played
// (SPEC §6.3 Summon and Recruit, §3.2, §7, R64). A summon fires no Cry; `play` and `cast` do (R1).
//
// Three of the five verbs are a summon with one extra clause, so each is written as the same
// placement path with that clause bolted on rather than as a second placement: `summonCopy` is
// §10.7's copy semantics (R57), `summonRandom` is §10.7's `catalog.query` pool (§5.1), and
// `randomKeywords` on `summon` is R21's roll (#80). Placement, the `summoned` event, the face-down
// Trap and every fizzle stay in `zoneFor`/`summonOnto` for all of them.

import type { CardDef, CardType, PlayerId, Row, Tag } from "@jackioh/shared";
import { defOf, excludingIndex, query, type CatalogQueryArgs } from "../catalog";
import { effectiveCost } from "../mana";
import { runHook } from "../resolve";
import type { Effect, EffectContext } from "../script";
import { scriptOf } from "../scripts";
import { newInstance, type CardInstance } from "../state";
import { exitMark } from "../stays";
import {
  fillBoardZones,
  firstFreeZone,
  isEmpty,
  isLocked,
  isReserved,
  isUnitToken,
  placeOnField,
  removeFromAnyZone,
  rowSize,
  type ZoneSlot,
} from "../zones";
import { grantRandomKeywords } from "./buff";
import { instanceOf, playerOf, resolveTarget, type PlayerSpec, type TargetSpec } from "./targets";

/** §7: the stats a token is summoned with instead of its printed ones (Bread Token, Call to Chaos). */
export type StatsOverride = { attack: number; health: number };

export type SummonPlacement = {
  /** Who controls the summoned card; its owner too when the card is created here (R12). */
  player?: PlayerSpec;
  /** A named lane ("this lane", Reborn's zone); it fails when that zone is occupied or Locked (R47). */
  lane?: number;
  /** §3.2: a Stack card may enter an occupied unit zone and becomes the top of the pile. */
  stack?: boolean;
  radiant?: boolean;
  /** §7: the Bread Token's "Armor X", carried beside `statsOverride` for the same reason. */
  armorOverride?: number;
  statsOverride?: StatsOverride;
};

export type SummonArgs = SummonPlacement & {
  /** Create a fresh card of this definition, a token included (§7). */
  defId?: string;
  /** Or move a card that already exists onto the field (from a hand, library, GY or exile). */
  instance?: TargetSpec;
  /**
   * R21: "each with N random keywords" (#80 Zao Gao). The roll belongs to the summon rather than to
   * a second effect because nothing else can name a card that was just created: `summon` returns
   * an `Effect`, not an instance, and `TargetSpec` has no "last summoned" case. Rolling it here
   * also keeps the rng draws adjacent to the summon they belong to, which is what a replay folds
   * (§9.3), and removes the fizzle hazard of a follow-up effect aimed at a card that never landed.
   */
  randomKeywords?: number;
};

/** §5.1: the row a card type lives in, or null for a Spell, which is never summoned. */
function rowOf(def: CardDef): Row | null {
  if (def.type === "Unit") return "units";
  if (def.type === "Spell") return null;
  return "backrow";
}

/** §6.3 Recruit: Unit, Field Spell, Trap and Field Trap are the permanents. */
function isPermanentType(type: CardType): boolean {
  return type !== "Spell";
}

/** What `placeOnField` will accept, checked before the card leaves the zone it is in (§3.2). */
function canPlace(ctx: EffectContext, ref: ZoneSlot, stack: boolean): boolean {
  if (isLocked(ctx.state, ref) || isReserved(ctx.state, ref)) return false;
  if (isEmpty(ctx.state, ref)) return true;
  return ref.row === "units" && stack;
}

/** R64 with no lane named, the named lane otherwise; null when the summon fizzles (§3.2). */
function zoneFor(ctx: EffectContext, player: PlayerId, row: Row, at: SummonPlacement): ZoneSlot | null {
  if (at.lane === undefined) return firstFreeZone(ctx.state, player, row);
  if (at.lane < 1 || at.lane > rowSize(row)) return null;
  const ref: ZoneSlot = { player, row, lane: at.lane };
  return canPlace(ctx, ref, at.stack === true) ? ref : null;
}

/**
 * The body every summon shares: put the card in the zone, apply the §7 stat override, leave a Trap
 * face-down while a Field Spell is public (§3.2, R33), and emit `summoned`.
 */
function summonOnto(ctx: EffectContext, card: CardInstance, ref: ZoneSlot, at: SummonPlacement): boolean {
  if (!placeOnField(ctx.state, card, ref, { stack: at.stack === true })) return false;

  card.summonedTurn = ctx.state.turn;
  if (at.statsOverride !== undefined) {
    card.statsOverride = { attack: at.statsOverride.attack, health: at.statsOverride.health };
  }
  if (defOf(ctx.state, card.defId).type === "Field Spell") card.faceUp = true;

  ctx.events.push({
    type: "summoned",
    player: ref.player,
    instanceId: card.id,
    defId: card.defId,
    row: ref.row,
    lane: ref.lane,
  });
  // R43, R151: "one created later rolls when it is created", as it arrives anywhere a card can be
  // looked at, and the field is such a place. A #98 Heroic Power that #22's Death summons as a copy
  // or #95 summons into the backrow reaches neither a hand nor a library, the two arrivals
  // `draw.ts` rolls on, and would otherwise hold no power and never be offered `activatePower`. The
  // hook keeps a power the card already rolled (`heroPower.ensurePower`), so a card that arrives
  // with its answer takes no rng draw.
  if (scriptOf(card).startOfGame !== undefined) {
    runHook(ctx, card, "startOfGame", { controller: card.owner });
  }
  return true;
}

/** A fresh card of `defId`, created only once a zone is known so a fizzle creates nothing. */
function summonFresh(
  ctx: EffectContext,
  defId: string,
  player: PlayerId,
  at: SummonPlacement,
): CardInstance | null {
  const row = rowOf(defOf(ctx.state, defId));
  if (row === null) return null;
  const ref = zoneFor(ctx, player, row, at);
  if (ref === null) return null;

  const card = newInstance(ctx.state, defId, player, { z: "resolving", player });
  if (at.radiant === true) card.radiant = true;
  if (at.armorOverride !== undefined) card.armorOverride = at.armorOverride;
  return summonOnto(ctx, card, ref, at) ? card : null;
}

/** A card that already exists, moved onto the field "from anywhere else" (§6.3 Summon). */
function summonExisting(
  ctx: EffectContext,
  card: CardInstance,
  player: PlayerId,
  at: SummonPlacement,
): CardInstance | null {
  if (card.zone.z === "field") return null;
  const row = rowOf(defOf(ctx.state, card.defId));
  if (row === null) return null;
  const ref = zoneFor(ctx, player, row, at);
  if (ref === null) return null;

  removeFromAnyZone(ctx.state, card);
  if (at.radiant === true) card.radiant = true;
  if (at.armorOverride !== undefined) card.armorOverride = at.armorOverride;
  return summonOnto(ctx, card, ref, at) ? card : null;
}

/**
 * R21's roll, applied to the card the summon actually created and only once it has landed. There is
 * one keyword-roll implementation in the engine and it lives in `./buff`: `grantRandomKeywords`
 * already recomputes R21's pool per draw (so the two keywords of one token are distinct and never
 * one the token already has, which is why a Rush Token draws from the other ten), and it is reached
 * here through the `{ of: "instance" }` `TargetSpec` rather than by copying the pool into this file.
 */
function rollRandomKeywords(ctx: EffectContext, card: CardInstance, count: number | undefined): void {
  if (count === undefined || count <= 0) return;
  // R174: the roll is aimed at the stay the card has just arrived on, so it is named from a mark
  // taken now — a unit the same list sent to the graveyard and has just summoned back is this one.
  const now = { ...ctx, exitsFrom: exitMark(ctx.state) };
  grantRandomKeywords({ target: { of: "instance", instanceId: card.id }, count }).apply(now);
}

/**
 * §6.3 Summon: put a card on the field from anywhere else, with no Cry. With no lane named it takes
 * the leftmost empty, unlocked, unreserved zone of its row (R64) and fails silently when the row
 * has none; a named lane fails the same way when it is occupied or Locked (R47).
 */
export function summon(args: SummonArgs): Effect {
  return {
    kind: "summon",
    apply(ctx): void {
      const player = playerOf(ctx, args.player ?? "self");

      if (args.instance !== undefined) {
        const target = resolveTarget(ctx, args.instance);
        if (target === null || target.kind !== "unit") return;
        const moved = summonExisting(ctx, target.instance, player, args);
        if (moved !== null) rollRandomKeywords(ctx, moved, args.randomKeywords);
        return;
      }
      if (args.defId === undefined) return;
      const made = summonFresh(ctx, args.defId, player, args);
      if (made !== null) rollRandomKeywords(ctx, made, args.randomKeywords);
    },
  };
}

/** What §10.7's copy semantics need on top of a placement: R57's two #61 deviations. */
export type SummonCopyArgs = {
  /** The card to copy. #12 copies `{ of: "self" }`; #61 copies the unit the play chose. */
  of: TargetSpec;
  player?: PlayerSpec;
  lane?: number;
  stack?: boolean;
  /** #61: the copy comes out textless, which R23 allows even from an Immutable source. */
  vanilla?: boolean;
  /** #61: `false` drops the source's granted keywords, which R57 would otherwise carry. */
  grantedKeywords?: boolean;
};

/**
 * §10.7's `cloneInstance(inst)` and R57: the copy keeps the radiant flag, the buffs, the granted
 * keywords, the Vanilla state and `statsOverride`, and resets damage, exertion, counters and
 * `summonedTurn` — the last of which `summonOnto` sets to the current turn, so the copy is
 * summoning sick like any other new body (§4.1).
 *
 * §10.7 names `cloneInstance` as the copy primitive but nothing in the engine provides it, so the
 * clone is written here, once, behind `summonCopy`. Everything R57 does not list is left at
 * `newInstance`'s default rather than carried: the copy is a new card, so it owes no cost history
 * (`costMod`, `costOverride`), has an unspent Divine Shield and an unused Reborn, and remembers
 * nothing of its own (`memory`). Auras are layer 5 of §10.4 and computed on read, so they apply to
 * the copy afresh with no work here (§8.3 #61).
 */
function cloneOf(
  ctx: EffectContext,
  source: CardInstance,
  player: PlayerId,
  args: SummonCopyArgs,
): CardInstance {
  const copy = newInstance(ctx.state, source.defId, player, { z: "resolving", player });
  copy.radiant = source.radiant;
  copy.buffs = { attack: source.buffs.attack, health: source.buffs.health };
  copy.vanilla = args.vanilla === true || source.vanilla;
  // A `Keyword` is never mutated in place — `./buff` pushes pool constants that several units
  // already share — so the array is copied and its entries are not.
  if (args.grantedKeywords !== false) copy.grantedKeywords = [...source.grantedKeywords];
  if (source.statsOverride !== undefined) {
    copy.statsOverride = { attack: source.statsOverride.attack, health: source.statsOverride.health };
  }
  // §7: a Bread Token's "Armor X" is carried beside its X/X, so a copy keeps both halves (R57).
  if (source.armorOverride !== undefined) copy.armorOverride = source.armorOverride;
  return copy;
}

/**
 * §6.3 Summon plus §10.7's copy semantics: "summon a copy of this unit" (#12) and "summon a Vanilla
 * copy" (#61). The copy is placed per R64 through the same path as `summon`, so it emits `summoned`,
 * fizzles silently on a full, occupied or Locked zone, and fires no Cry (§6.2, R1) — which is the
 * whole reason #12 does not fill the board for 2 mana.
 */
export function summonCopy(args: SummonCopyArgs): Effect {
  return {
    kind: "summonCopy",
    apply(ctx): void {
      const source = instanceOf(ctx, args.of);
      // R57 copies "a unit on the field" (#12 itself, #61's chosen Human). One that has left it —
      // sacrificed by a fused card's other half (#22) earlier in the same list — is gone for this
      // effect (R174), and a copy is never made of a card in a graveyard.
      if (source === null || source.zone.z !== "field") return;
      const player = playerOf(ctx, args.player ?? "self");
      const row = rowOf(defOf(ctx.state, source.defId));
      if (row === null) return;

      // The zone is found before the clone exists, so a fizzle creates nothing and takes no id.
      const ref = zoneFor(ctx, player, row, args);
      if (ref === null) return;
      summonOnto(ctx, cloneOf(ctx, source, player, args), ref, args);
    },
  };
}

/**
 * §6.3 Summon from a random pool: "summon a random 1-cost Trap face-down into your backrow zone in
 * this lane" (#67 Zoomerbin Oomen), "summon 3 random 3-cost Units" and "summon 5 random Field Spells
 * or Traps" (#95 Call to Chaos, one of these per card). §10.7 makes `catalog.query` the single source
 * of random pools and §5.1 keeps the requesting def out of one, so the draw is one `ctx.rng.pick`
 * over `query({ …, excludeIndex })`, exactly as `discoverFromCatalog` builds its offer.
 *
 * The draw happens inside `apply`, never when the effect is built: a draw taken at
 * factory-construction time would escape the reducer and desync every later replay (§9.3, R60).
 * It precedes the placement because the row follows from the def drawn (§5.1) — a Trap goes to
 * the backrow and a Unit to the units row — and placement is then `summon`'s own code, so R64's
 * leftmost-free fallback, R47's occupied-or-Locked fizzle, the `summoned` event and the face-down
 * Trap of §3.2/R33 all stay in one place.
 *
 * But R129 comes first: "an effect that finds nothing to do draws no random numbers". So the draw is
 * taken only when some card of the pool has a zone to go to — #67's lane already holding a backrow
 * card, or a full unit row under #95's third summon, draws nothing at all.
 */
export function summonRandom(
  args: {
    query?: CatalogQueryArgs;
    player?: PlayerSpec;
    lane?: number;
    radiant?: boolean;
    stack?: boolean;
  } = {},
): Effect {
  return {
    kind: "summonRandom",
    apply(ctx): void {
      const self = ctx.self;
      // §5.1: a random pool never offers the card that generated it.
      const pool = query(
        excludingIndex(args.query ?? {}, self === null ? undefined : defOf(ctx.state, self.defId).index),
      );
      const player = playerOf(ctx, args.player ?? "self");
      const rows = new Set(pool.flatMap((def) => {
        const row = rowOf(def);
        return row === null ? [] : [row];
      }));
      if (![...rows].some((row) => zoneFor(ctx, player, row, args) !== null)) return;

      const def = ctx.rng.pick(pool);
      if (def === undefined) return;
      summonFresh(ctx, def.id, player, args);
    },
  };
}

/** Which library cards a Recruit will consider, on top of "must be a permanent" (§6.3). */
export type RecruitFilter = {
  type?: CardType | CardType[];
  tags?: Tag[];
  notTags?: Tag[];
  cost?: number;
  costRange?: { min?: number; max?: number };
  defId?: string | string[];
  index?: string | string[];
};

function asList<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Whether a library card passes a Recruit's filter. The cost is R65's one calculation for that
 * instance (`effectiveCost`), which R65 applies outside play ("library, hand, GY, pools, filters,
 * comparisons") and #30 Archivist and #94 Genn's Greed already read library cards by (R24, R66): a
 * card never played has no X (an X-cost card reads 0) and no embiggen price (its base), and its
 * `costMod` and `costOverride` travel with it into every zone (R78), so a printed-3 Unit #95 made
 * "cost 2 less" is a Unit costing 1 for #69 Call to Arms. The definition's printed cost would miss it.
 */
function matchesFilter(ctx: EffectContext, card: CardInstance, filter: RecruitFilter): boolean {
  const def = defOf(ctx.state, card.defId);
  const types = asList(filter.type);
  if (types.length > 0 && !types.includes(def.type)) return false;
  const defIds = asList(filter.defId);
  if (defIds.length > 0 && !defIds.includes(def.id)) return false;
  const indexes = asList(filter.index);
  if (indexes.length > 0 && !indexes.includes(def.index)) return false;
  if (filter.tags !== undefined && !filter.tags.every((tag) => def.tags.includes(tag))) return false;
  if (filter.notTags !== undefined && filter.notTags.some((tag) => def.tags.includes(tag))) return false;

  const cost = effectiveCost(ctx.state, card);
  if (filter.cost !== undefined && cost !== filter.cost) return false;
  if (filter.costRange?.min !== undefined && cost < filter.costRange.min) return false;
  if (filter.costRange?.max !== undefined && cost > filter.costRange.max) return false;
  return true;
}

/**
 * §6.3 Recruit: scan the library top down for the first permanent that matches, summon it per R64
 * (a Trap face-down), and leave the rest of the library in its order.
 */
export function recruit(
  args: { filter?: RecruitFilter; player?: PlayerSpec; lane?: number; radiant?: boolean } = {},
): Effect {
  return {
    kind: "recruit",
    apply(ctx): void {
      const player = playerOf(ctx, args.player ?? "self");
      const filter = args.filter ?? {};
      const found = ctx.state.players[player].library.find(
        (card) =>
          isPermanentType(defOf(ctx.state, card.defId).type) &&
          // R218: a unit-token card leaves a library only by being drawn (R11), so it is never
          // recruited — the scan passes over it to the next card that matches.
          !isUnitToken(ctx.state, card) &&
          matchesFilter(ctx, card, filter),
      );
      if (found === undefined) return;

      const recruited = summonExisting(ctx, found, player, {
        ...(args.lane === undefined ? {} : { lane: args.lane }),
        ...(args.radiant === undefined ? {} : { radiant: args.radiant }),
      });
      // #98 radiant, "Recruit and make it Radiant": the second half is §6.3's Make Radiant, and
      // every visible change is announced (§10.3) — `radiantSet` is what §10.10 animates the glow
      // from. The flag went on as the card left the library, so it lands on its Radiant face; the
      // cue follows the summon, and goes out whether or not the card was Radiant already, as R177
      // has a Make Radiant on a card someone may not read (a face-down Trap) do.
      if (recruited !== null && args.radiant === true) {
        ctx.events.push({ type: "radiantSet", instanceId: recruited.id, defId: recruited.defId, zone: recruited.zone });
      }
    },
  };
}

/**
 * §7 and R64: "fill your board" summons the named token into every empty, unlocked unit zone,
 * left to right.
 */
export function fillBoard(args: {
  defId: string;
  player?: PlayerSpec;
  radiant?: boolean;
  statsOverride?: StatsOverride;
  /** §7: the Bread Token's "Armor X", carried beside `statsOverride` (#22 radiant's copies). */
  armorOverride?: number;
}): Effect {
  return {
    kind: "fillBoard",
    apply(ctx): void {
      const player = playerOf(ctx, args.player ?? "self");
      if (rowOf(defOf(ctx.state, args.defId)) !== "units") return;

      for (const ref of fillBoardZones(ctx.state, player)) {
        summonFresh(ctx, args.defId, player, {
          lane: ref.lane,
          ...(args.radiant === undefined ? {} : { radiant: args.radiant }),
          ...(args.statsOverride === undefined ? {} : { statsOverride: args.statsOverride }),
          ...(args.armorOverride === undefined ? {} : { armorOverride: args.armorOverride }),
        });
      }
    },
  };
}
