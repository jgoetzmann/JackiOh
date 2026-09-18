// Catalog ids, one place. SPEC §8 numbers every card; the id of card #N is `core-` plus N
// zero-padded to three digits, as `packages/cards/catalog.json` spells it ("core-001", "core-043")
// and `packages/shared/src/catalog-types.ts` documents it. No spec spells an id itself: if the
// format ever moves, `cardId` below and the fixture decks are the only places to fix.

/** SPEC §8: index -> name, all 100 Core cards. Tokens are excluded: L3 bans them from decks. */
export const CARD_NAMES: Record<number, string> = {
  1: "Big D-fender",
  2: "Bigot",
  3: "Right-house defender",
  4: "Gary the Gambler",
  5: "Stockpile",
  6: "Mana Well",
  7: "Jewelosco Scarab",
  8: "Mr. Vanilla",
  9: "Moths to the Flame",
  10: "Rapid Replenish",
  11: "Tempo Timmy",
  12: "Duplicating Felinors",
  13: "Jlockeed Shredder-10",
  14: "Jlockeed's Weapons",
  15: "Me and Mr Token",
  16: "Hit Job",
  17: "Flood",
  18: "Bread and Butter",
  19: "Midrange Menace",
  20: "Pointmaster",
  21: "Hinder",
  22: "Carnivorous Cube",
  23: "Reoccurring Dream",
  24: "Efficiency Dividend",
  25: "4-mana 7/7",
  26: "Glowy Jelly Bean",
  27: "Blood Ridden Glowy Jelly Bean",
  28: "Knockoff Temu Glowy Jelly Bean",
  29: "GIGA Glowy Jelly Bean",
  30: "Archivist",
  31: "KY's Math Equation",
  32: "Prem Panther",
  33: "Unstable Clone Machine",
  34: "Collateral Damage",
  35: "Lunar Eclipse",
  36: "Magic Jammed",
  37: "Gravedigger",
  38: "Quickstriker",
  39: "Recycling Initiative",
  40: "Echoes of the Forgotten",
  41: "Sheepish",
  42: "Eugenics",
  43: "Big Felinor",
  44: "True Strike",
  45: "Deft Duelist",
  46: "Suppressive Aura",
  47: "Fig of Life",
  48: "5pek Controller",
  49: "Snom Bunny Mind Control",
  50: "Kpop Fanatic",
  51: "KY's Private Tutor",
  52: "Silly Silas",
  53: "Reno",
  54: "Straaza",
  55: "Lava Golem",
  56: "Jilliax",
  57: "Conjure KY",
  58: "Rush Token Farm",
  59: "Unbiased Immigration",
  60: "Bear Honeypot",
  61: "Prejudiced Postdoc",
  62: "Friend of Felinors",
  63: "Plastic Surgery",
  64: "Gifted Program",
  65: "Masochism Mask",
  66: "The Rock",
  67: "Zoomerbin Oomen",
  68: "Twisted Sourcerer",
  69: "Call to Arms",
  70: "Spiteful Stab",
  71: "Intern Stimmy",
  72: "Reminisce",
  73: "Anti-oneshot Armor",
  74: "Adaptive UI",
  75: "Infinite Reserves",
  76: "Field of Dreams",
  77: "Professor Curvature",
  78: "/fullsend",
  79: "Twinspell",
  80: "Zao Gao",
  81: "Radiant Saintess",
  82: "KY's Trial",
  83: "Transmogulate",
  84: "Going Long",
  85: "Unlicensed Experimentation",
  86: '"Miss" Mrow',
  87: "Pocket Chaos",
  88: "Twisting Nether",
  89: "Corpse Eater",
  90: "CN-Viral Injection",
  91: "Fed Fauci",
  92: "Felinor Fiender",
  93: "Combo-Index",
  94: "Genn's Greed",
  95: "Call to Chaos (Core Edition)",
  96: "My Pawn",
  97: "Zephyrs",
  98: "Heroic Power",
  99: "Craft a Card",
  100: "Ceaseless Void",
};

/** How many deckable cards SPEC §8 numbers. `packages/cards/catalog.json` holds exactly 100. */
export const CORE_CARD_COUNT = Object.keys(CARD_NAMES).length;

/** The catalog id of SPEC §8 card #index. */
export function cardId(index: number): string {
  return `core-${String(index).padStart(3, "0")}`;
}

/** Every deckable catalog id, in SPEC §8 order. The pool `installLoadout` pads a loadout from. */
export function allCardIds(): string[] {
  return Array.from({ length: CORE_CARD_COUNT }, (_, index) => cardId(index + 1));
}

/** The catalog id of the card SPEC §8 calls `name`. Throws on a typo, so a spec cannot drift. */
export function idOf(name: string): string {
  for (const [index, cardName] of Object.entries(CARD_NAMES)) {
    if (cardName === name) return cardId(Number(index));
  }
  throw new Error(`no SPEC §8 card named "${name}"`);
}

// ---------------------------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------------------------

/**
 * The 9 Token cards, read off `packages/cards/catalog.json` (`"token": true`), keyed by the
 * catalog's own `index` string. They are deliberately NOT in `CARD_NAMES`: L3 bans Tokens from
 * decks, and `asDeck` in support/commands.ts checks a fixture against `CARD_NAMES` being exactly
 * the deckable set, so a Token added there would let an illegal fixture through.
 *
 * Two id shapes, both spelled by the catalog rather than invented here: a token created by a
 * numbered card takes that card's index with a `.1` suffix (`65.1` -> `core-065-1`), and a token
 * no single card owns is named (`T-sheep` -> `core-t-sheep`).
 */
export const TOKEN_NAMES: Record<string, string> = {
  "51.1": "KY's Empty Notebook",
  "65.1": "Spikey Pillow",
  "90.1": "CN-Virus",
  "93.1": "Combo-Fodder",
  "95.1": "Chaos Golem",
  "T-rush": "Rush Token",
  "T-sheep": "Sheep Token",
  "T-felinor": "Felinor Token",
  "T-bread": "Bread Token",
};

/**
 * The catalog id of the token the catalog indexes as `index`. Unlike `cardId`, this validates:
 * the two id shapes are irregular enough that a typo would otherwise produce a plausible-looking
 * id for a card that does not exist.
 */
export function tokenId(index: string): string {
  if (!(index in TOKEN_NAMES)) throw new Error(`no Token card indexed "${index}"`);
  const numbered = /^(\d+)\.(\d+)$/.exec(index);
  if (numbered !== null) {
    return `core-${(numbered[1] ?? "").padStart(3, "0")}-${numbered[2] ?? ""}`;
  }
  return `core-${index.toLowerCase()}`;
}

/** The catalog id of the Token called `name`. Throws on a typo, exactly as `idOf` does. */
export function idOfToken(name: string): string {
  for (const [index, tokenName] of Object.entries(TOKEN_NAMES)) {
    if (tokenName === name) return tokenId(index);
  }
  throw new Error(`no Token card named "${name}"`);
}

/** Cards the M8 table names by hand, so a spec can say `CARDS.sheepish`. */
export const CARDS = {
  bigDfender: cardId(1),
  rightHouseDefender: cardId(3),
  stockpile: cardId(5),
  manaWell: cardId(6),
  jewelscoScarab: cardId(7),
  mrVanilla: cardId(8),
  tempoTimmy: cardId(11),
  hitJob: cardId(16),
  flood: cardId(17),
  midrangeMenace: cardId(19),
  pointmaster: cardId(20),
  efficiencyDividend: cardId(24),
  glowyJellyBean: cardId(26),
  knockoffTemu: cardId(28),
  archivist: cardId(30),
  sheepish: cardId(41),
  suppressiveAura: cardId(46),
  sillySilas: cardId(52),
  lavaGolem: cardId(55),
  zoomerbinOomen: cardId(67),
  pocketChaos: cardId(87),
  myPawn: cardId(96),
} as const;

/** Tokens the M8 table names by hand, in the same style as `CARDS` (spec 09's L3 sentence). */
export const TOKENS = {
  kysEmptyNotebook: tokenId("51.1"),
  spikeyPillow: tokenId("65.1"),
  cnVirus: tokenId("90.1"),
  comboFodder: tokenId("93.1"),
  chaosGolem: tokenId("95.1"),
  rushToken: tokenId("T-rush"),
  sheepToken: tokenId("T-sheep"),
  felinorToken: tokenId("T-felinor"),
  breadToken: tokenId("T-bread"),
} as const;
