// Every rules constant lives here (BUILD §2). The engine never hard-codes these numbers.
// Rows SPEC §11 marks "decide" (R1, R2, R4, R5, R14, R26, R39) are flipped here in one line.

/** §2.6 */
export const DECK_SIZE = 20;
/** §2.6, §9.4 */
export const MAX_COPIES = 1;
/** §2.3 */
export const MAX_MANA = 4;
/** §2 */
export const HERO_HEALTH = 30;

/** §2.5, R2 (decide): the cap counts player-turns, so 30 means 15 each. */
export const TURN_CAP_PLAYER_TURNS = 30;
/** §2.4, R4 (decide): a card drawn or added to a full hand is burned. */
export const HAND_CAP = 10;

/** §2.1: indexed by seat; the Nth seat (1-based) draws N+2. */
export const OPENING_DRAW: readonly number[] = [3, 4];

/** §3 */
export const UNIT_ZONES = 5;
/** §3 */
export const BACKROW_ZONES = 5;

/** R5 (decide): any unit may attack any enemy unit or hero, subject to Taunt. */
export const LANE_RESTRICTED_ATTACKS: boolean = false;
/** R1 (decide): Cry fires only when played from hand or cast by an effect. */
export const CRY_ON_PLAY_ONLY: boolean = true;
/** R14 (decide): units and backrow form two independent rings. */
export const ROTATION_RING = "two-rings" as const;
/** R26 (decide): Genn's Greed exiles odd current-cost cards. */
export const GENN_GREED_EXILES = "odd" as const;
/** R39 (decide): Felinor Fiender = printed stats plus the sum of your Felinors. */
export const FIENDER_STATS_MODE = "printed-plus-sum" as const;

/** R3: the Nth draw from an empty library deals N damage. */
export const FATIGUE_DAMAGE = (n: number): number => n;

/** §2.5, R36: offers allowed per player per turn. */
export const DRAW_OFFERS_PER_TURN = 1;
/** §2.5, R36: a declined offer blocks that player for this many of their turns. */
export const DRAW_OFFER_BLOCK_TURNS = 3;

/** R28 */
export const CALL_TO_CHAOS_CHAIN_CAP = 20;
/** R58: cast-on-draw cards one draw may cast before the next one goes to hand uncast. */
export const CAST_ON_DRAW_CHAIN_CAP = 20;
/** §8 #73: largest single damage instance a hero with Anti-oneshot Armor takes. */
export const ANTI_ONESHOT_CAP = { base: 5, radiant: 3 } as const;
/**
 * §8 #84 Going Long: the Armor it gives its controller's hero (§4.4 step 2), by face and by which
 * price was paid — "Armor 2 (paid 4: 5)", radiant "Armor 4 (paid 4: 10)". `paid` is the printed
 * cost 2, `embiggen` the embiggen price 4 (R81 records which on the instance).
 */
export const HERO_ARMOR = {
  base: { paid: 2, embiggen: 5 },
  radiant: { paid: 4, embiggen: 10 },
} as const;

/** R21: Plastic Surgery and Zao Gao draw from this pool; a unit never gets a keyword it has. */
export const RANDOM_KEYWORD_POOL = [
  "Taunt",
  "Armor 1",
  "Rush",
  "Charge",
  "First Strike",
  "Poisonous",
  "Lifesteal",
  "Reborn",
  "Divine Shield",
  "Trample",
  "Cleave",
] as const;

/** R25: KY's Math Equation; the index clamps at 11. */
export const FIB = [0, 1, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89] as const;

export function fib(index: number): number {
  const clamped = Math.min(Math.max(Math.trunc(index), 0), FIB.length - 1);
  return FIB[clamped] ?? 0;
}

/** R80: a library holds at most this many cards. */
export const LIBRARY_CAP = 60;

/** §6.3 */
export const FUSE_COST_CAP = 4;
/** R9: replacements are drawn before the returned cards are shuffled back. */
export const MULLIGAN_ORDER = "draw-then-shuffle" as const;
/** §10.7: the random policy ends its turn with this probability when other actions exist. */
export const AI_END_TURN_PROBABILITY = 0.1;
/** R90: the most choice combinations `legalActions` enumerates for one play. */
export const MAX_CHOICE_COMBINATIONS = 64;
/** §9.3: how many answered nonces the state remembers for dedupe. */
export const NONCE_HISTORY = 64;
