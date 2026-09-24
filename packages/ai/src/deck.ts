// AI decks (SPEC §9.9, R184, R186): a curve-aware, tag-aware random draw of distinct non-token Core
// cards, minus the shadow ban.
//
// The draw is weighted sampling without replacement. Every remaining card gets a weight that is the
// product of the boosts in AI_DECK: its cost bucket is under or over its curve target, the deck is
// still short of units, the card carries the deck's theme, or the seat could never cast it. Two
// floors are hard rather than weighted: once the slots left equal the units (or theme cards) still
// owed, only units (or theme cards) are eligible, so every deck meets `minUnitShare` and every themed
// deck meets `themeMinShare` whatever the rng does. Everything comes from the rng passed in, so the
// same seed deals the same deck in any process.

import type { CardDef, Tag } from "@jackioh/shared";
import { MAX_MANA, query, queryCost, type Rng } from "@jackioh/engine";
import { SHADOW_BAN_IDS } from "./shadowBan";

export type CostBucket = "0-1" | "2" | "3" | "4+";

export type AiDeckOptions = {
  /** Default SHADOW_BAN_IDS; pass [] for a human's random deck. */
  banned?: readonly string[];
  /** Ids forced in (the sweep); must be non-token and not banned. */
  include?: readonly string[];
  /** A tag to lean on; undefined = roll one (AI_DECK.themeChance), null = none. */
  theme?: string | null;
  /** The seat's handicap manaCap; default MAX_MANA. Shifts the curve and the uncastable test. */
  manaCap?: number;
};

export const AI_DECK = {
  /** Share of each bucket at manaCap 4; each crystal above 4 moves `curveShiftPerMana` from "0-1" to "4+". */
  curve: { "0-1": 0.3, "2": 0.33, "3": 0.22, "4+": 0.15 },
  curveShiftPerMana: 0.025,
  /** Allowed gap between a bucket's mean share over many seeds and its target. */
  curveTolerance: 0.08,
  minUnitShare: 0.45,
  /** Chance of rolling a theme when `theme` is undefined. */
  themeChance: 0.35,
  /** A tag needs this many cards in the pool to be a theme (Core: only Human qualifies). */
  minThemeSize: 6,
  themeBoost: 4,
  themeMinShare: 0.3,
  /** Weight for a card whose bucket is under target / already full. */
  curveBoost: 3,
  curveOverflow: 0.15,
  /** Weight for a Unit while units < ceil(size × minUnitShare). */
  unitBoost: 2.5,
  /** Weight for a card with queryCost > manaCap + costSlack. */
  uncastable: 0.05,
  costSlack: 1,
  /** The unbanned pool must hold at least this many cards. */
  minPool: 45,
} as const;

/** The buckets in curve order; the last one, "4+", takes every cost above the others' ceilings. */
const BUCKET_ORDER: readonly CostBucket[] = ["0-1", "2", "3", "4+"];

/** The highest queryCost each bucket below "4+" holds, in curve order. */
const BUCKET_CEILINGS: readonly (readonly [CostBucket, number])[] = [
  ["0-1", 1],
  ["2", 2],
  ["3", 3],
];

/** The tag every token carries; never a theme (the pool holds no tokens anyway, §2.6 L3). */
const TOKEN_TAG: Tag = "Token";

/** By queryCost (X → 0, embiggen → base). */
export function costBucket(def: CardDef): CostBucket {
  const cost = queryCost(def);
  for (const [bucket, ceiling] of BUCKET_CEILINGS) {
    if (cost <= ceiling) return bucket;
  }
  return "4+";
}

/** The four target shares for a seat's mana cap, summing to 1. */
function curveShares(manaCap: number): Record<CostBucket, number> {
  const shares: Record<CostBucket, number> = { ...AI_DECK.curve };
  const wanted = Math.max(0, manaCap - MAX_MANA) * AI_DECK.curveShiftPerMana;
  const moved = Math.min(wanted, shares["0-1"]);
  shares["0-1"] -= moved;
  shares["4+"] += moved;
  return shares;
}

/** Integers summing to size (largest remainder). */
export function curveTargets(size: number, manaCap: number): Record<CostBucket, number> {
  const shares = curveShares(manaCap);
  const targets: Record<CostBucket, number> = { "0-1": 0, "2": 0, "3": 0, "4+": 0 };
  const remainders: { bucket: CostBucket; fraction: number; order: number }[] = [];
  let assigned = 0;
  BUCKET_ORDER.forEach((bucket, order) => {
    const raw = shares[bucket] * size;
    const whole = Math.floor(raw);
    targets[bucket] = whole;
    assigned += whole;
    remainders.push({ bucket, fraction: raw - whole, order });
  });
  // Largest fractional part first; a tie goes to the cheaper bucket, so the result is a total order.
  remainders.sort((a, b) => (b.fraction !== a.fraction ? b.fraction - a.fraction : a.order - b.order));
  for (let i = 0; assigned < size && remainders.length > 0; i = (i + 1) % remainders.length) {
    const entry = remainders[i];
    if (entry === undefined) break;
    targets[entry.bucket] += 1;
    assigned += 1;
  }
  return targets;
}

/** The tags with at least AI_DECK.minThemeSize cards among `defs`, sorted by name. */
function themeCandidates(defs: readonly CardDef[]): string[] {
  const counts = new Map<string, number>();
  for (const def of defs) {
    for (const tag of def.tags) {
      if (tag === TOKEN_TAG) continue;
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, count]) => count >= AI_DECK.minThemeSize)
    .map(([tag]) => tag)
    .sort();
}

/** One index into `weights`, chosen with probability proportional to its weight. */
function weightedIndex(weights: readonly number[], rng: Rng): number {
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const roll = rng.next() * total;
  let cumulative = 0;
  for (let i = 0; i < weights.length; i += 1) {
    cumulative += weights[i] ?? 0;
    if (roll < cumulative) return i;
  }
  return weights.length - 1;
}

function hasTag(def: CardDef, tag: string): boolean {
  return (def.tags as readonly string[]).includes(tag);
}

function isUnit(def: CardDef): boolean {
  return def.type === "Unit";
}

/** Distinct non-token Core ids, exactly `size`, deterministic for the rng. Throws if the pool is too small. */
export function buildAiDeck(rng: Rng, size: number, options: AiDeckOptions = {}): string[] {
  const banned = new Set(options.banned ?? SHADOW_BAN_IDS);
  const include = options.include ?? [];
  const manaCap = options.manaCap ?? MAX_MANA;

  // `query` never returns tokens unless asked, so this is §2.6 L3's deck-legal Core pool (R184).
  const core = query({ set: "Core" });
  const byId = new Map(core.map((def) => [def.id, def]));

  const includeDefs: CardDef[] = [];
  const includeIds = new Set<string>();
  for (const id of include) {
    const def = byId.get(id);
    if (def === undefined) throw new Error(`buildAiDeck: include "${id}" is not a non-token Core card`);
    if (banned.has(id)) throw new Error(`buildAiDeck: include "${id}" is banned`);
    if (includeIds.has(id)) throw new Error(`buildAiDeck: include "${id}" is listed twice`);
    includeIds.add(id);
    includeDefs.push(def);
  }
  if (includeDefs.length > size) {
    throw new Error(`buildAiDeck: ${includeDefs.length} included cards do not fit a ${size}-card deck`);
  }

  const pool = core.filter((def) => !banned.has(def.id) && !includeIds.has(def.id));
  if (includeDefs.length + pool.length < size) {
    throw new Error(
      `buildAiDeck: a ${size}-card deck needs ${size} distinct cards, but only ` +
        `${includeDefs.length + pool.length} non-token Core cards are unbanned`,
    );
  }

  let theme: string | null;
  if (options.theme === undefined) {
    // The chance is always rolled, so the draws after it sit at the same cursor whatever the pool.
    const rolled = rng.chance(AI_DECK.themeChance);
    const candidates = themeCandidates([...includeDefs, ...pool]);
    theme = rolled && candidates.length > 0 ? (rng.pick(candidates) ?? null) : null;
  } else {
    theme = options.theme;
  }

  const targets = curveTargets(size, manaCap);
  const unitsNeeded = Math.ceil(size * AI_DECK.minUnitShare);
  const themeNeeded = theme === null ? 0 : Math.ceil(size * AI_DECK.themeMinShare);
  const castableCeiling = manaCap + AI_DECK.costSlack;

  const deck: CardDef[] = [...includeDefs];
  const counts: Record<CostBucket, number> = { "0-1": 0, "2": 0, "3": 0, "4+": 0 };
  let units = 0;
  let themed = 0;
  const count = (def: CardDef): void => {
    counts[costBucket(def)] += 1;
    if (isUnit(def)) units += 1;
    if (theme !== null && hasTag(def, theme)) themed += 1;
  };
  for (const def of deck) count(def);

  let remaining = pool;
  while (deck.length < size) {
    const slotsLeft = size - deck.length;

    let eligible = remaining;
    if (theme !== null && themeNeeded - themed >= slotsLeft) {
      const themedCards = eligible.filter((def) => hasTag(def, theme as string));
      if (themedCards.length > 0) eligible = themedCards;
    }
    if (unitsNeeded - units >= slotsLeft) {
      const unitCards = eligible.filter(isUnit);
      if (unitCards.length > 0) eligible = unitCards;
    }

    const weights = eligible.map((def) => {
      let weight = 1;
      const bucket = costBucket(def);
      weight *= counts[bucket] < targets[bucket] ? AI_DECK.curveBoost : AI_DECK.curveOverflow;
      if (isUnit(def) && units < unitsNeeded) weight *= AI_DECK.unitBoost;
      if (theme !== null && hasTag(def, theme)) weight *= AI_DECK.themeBoost;
      if (queryCost(def) > castableCeiling) weight *= AI_DECK.uncastable;
      return weight;
    });

    const chosen = eligible[weightedIndex(weights, rng)];
    if (chosen === undefined) {
      throw new Error(`buildAiDeck: ran out of cards at ${deck.length} of ${size}`);
    }
    deck.push(chosen);
    count(chosen);
    remaining = remaining.filter((def) => def.id !== chosen.id);
  }

  return deck.map((def) => def.id);
}
