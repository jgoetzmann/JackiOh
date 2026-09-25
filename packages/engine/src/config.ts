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

/**
 * BUILD M1-T1 (`createGame` yields `turn = 0`): the turn number §2.1's setup runs at. Setup is no
 * player's turn — p1 takes the first turn after it (§2.1 step 5) — so nothing played during it
 * belongs to a turn of its controller's (R155, R241).
 */
export const SETUP_TURN = 0;
/** §2.5, R2 (decide): the cap counts player-turns, so 30 means 15 each. */
export const TURN_CAP_PLAYER_TURNS = 30;
/** §2.4, R4 (decide): a card drawn or added to a full hand is burned. */
export const HAND_CAP = 10;

/** §2.1: indexed by seat; the Nth seat (1-based) draws N+2. */
export const OPENING_DRAW: readonly number[] = [3, 4];

/**
 * §2.1, R244: indexed by seat like `OPENING_DRAW`, the copies of The Coin each seat is dealt once both
 * mulligans are answered. Hearthstone's rule: the player going second gets one, the first none.
 */
export const OPENING_COINS: readonly number[] = [0, 1];
/** §7, R245: the catalog id of The Coin, the one token a rule deals rather than a card. */
export const COIN_DEF_ID = "core-t-coin";

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
/**
 * §2.5, R79: the most prompts one `timeout` answers for the active player. A chain of prompts is a
 * handful (KY's Private Tutor asks three times), after which the turn ends. This only bounds a card
 * that would keep asking, so one `timeout` always returns: if a prompt is still open after this many
 * answers, the timeout stops there with the turn still running, and the next expiry carries on. No
 * Core card can reach it.
 */
export const TIMEOUT_ANSWER_CAP = 500;

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

/** §2.4: the draws each start of turn makes before any handicap (R183). */
export const DRAWS_PER_TURN = 1;

/**
 * §9.9, R180: the resources one seat plays with. Every field is a non-negative integer. The type
 * lives here because `config.ts` imports nothing; `state.ts` stores it on a `PlayerState`.
 */
export type Handicap = {
  /** R184: exactly how many cards `createGame` requires in this seat's deck. */
  readonly deckSize: number;
  /** R181: crystals added to the turns-started count before the cap. */
  readonly manaBonus: number;
  /** R181: the most max mana a refresh gives, before persistent modifiers. */
  readonly manaCap: number;
  /** R182: cards added to §2.1's opening draw. */
  readonly extraOpeningCards: number;
  /** R183: separate draws after DRAWS_PER_TURN at each start of turn. */
  readonly extraDrawsPerTurn: number;
  /**
   * R290: the health this seat's hero starts the game with, in place of HERO_HEALTH. Absent means
   * HERO_HEALTH, which is why the three practice tiers never set it and hash exactly as before the
   * field existed. Only the tutorial's handicap (`AI_TUTORIAL`) sets it, and only lower.
   */
  readonly heroHealth?: number;
};

/** R180: this spec's own resources. A seat with no handicap plays with these. */
export const HUMAN_HANDICAP: Handicap = {
  deckSize: DECK_SIZE,
  manaBonus: 0,
  manaCap: MAX_MANA,
  extraOpeningCards: 0,
  extraDrawsPerTurn: 0,
};

/** §9.9: the three practice tiers. */
export type Difficulty = "easy" | "medium" | "hard";
export const DIFFICULTIES: readonly Difficulty[] = ["easy", "medium", "hard"];

/**
 * §9.9's table (R180): the AI seat's handicap per tier. The AI itself is identical at every tier;
 * only these resources differ. Easy is a human's resources exactly, so an Easy game stores no
 * handicap and hashes like any other game.
 */
export const AI_DIFFICULTY: Readonly<Record<Difficulty, Handicap>> = {
  easy: HUMAN_HANDICAP,
  medium: { deckSize: 25, manaBonus: 1, manaCap: 5, extraOpeningCards: 1, extraDrawsPerTurn: 0 },
  hard: { deckSize: 30, manaBonus: 1, manaCap: 7, extraOpeningCards: 1, extraDrawsPerTurn: 1 },
};

/**
 * §9.10, R290: the tutorial opponent's handicap, the one below Easy. It is a handicap like the
 * three tiers (R180) and lowers the AI seat's resources instead of raising them: a 12-card deck
 * (each lesson's own list, R291, so it runs out and fatigues sooner), at most 3 mana crystals, and
 * a hero that starts at 20 health. The AI's search, evaluation and budget are the ones every tier
 * plays with. It is not in `DIFFICULTIES`: nobody picks it, the tutorial deals it.
 */
export const AI_TUTORIAL: Handicap = {
  deckSize: 12,
  manaBonus: 0,
  manaCap: 3,
  extraOpeningCards: 0,
  extraDrawsPerTurn: 0,
  heroHealth: 20,
};
