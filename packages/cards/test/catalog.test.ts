// BUILD M4-T1 acceptance: catalog.json is the diff against SPEC §8.
//
// PROVENANCE OF `SPEC_8` BELOW. The table is a transcription of SPEC.md, not of catalog.json, so
// that a card whose data drifts from the spec fails here. It was produced mechanically from the
// spec's own markdown tables and checked in as a literal; the test never reads SPEC.md at run time
// (a test that re-parsed the spec would pass while spec and catalog drifted together, and would
// put file I/O in a package that must stay pure — CLAUDE.md rule 4).
//
//   index, name, rarity, cost, type, tags, base/radiant stats
//                       — SPEC §8.1–§8.5, the 105 rows of the catalog table, columns
//                         "#", "Name", "Rarity", "Cost", "Type, tags" and "Stats"
//                         (`A/B → C/D` is base → radiant; `A/B` alone means the radiant
//                         form keeps those stats; an empty cell means the card has no stats).
//                         In "Type, tags" the first comma-separated segment is the card type
//                         (no type name contains a comma) and the rest are tags.
//   the five named tokens (`T-rush`, `T-sheep`, `T-felinor`, `T-bread`, and `T-coin`, the one
//                         §2.1's setup deals rather than a card, R244)
//                       — SPEC §7, columns "Token", "Index", "Cost", "Type",
//                         "Stats and text" (its leading `A/B`; Bread Token's printed 0/0) and
//                         "Radiant form". §7 has no rarity column and its "Type" column omits
//                         the Token tag: `rarity: "Token"` follows §8's five in-catalog token
//                         rows, and the Token tag follows §7's token rules ("it counts as a
//                         Token for every filter") with BUILD M4-T2 ("`catalog.query` never
//                         returns a token unless `tags` includes `Token`").
//   radiant faces       — no §8 or §7 cell reads "No radiant form" or "none" any more: every
//                         entry has a Radiant face of its own (§5.2, R276).
//   rarity distribution — SPEC §8's rarity paragraph (35/37/16/7/5, superseding the source
//                         list's #1–20 Common … grouping) and BUILD M4-T1.
//   tag vocabulary      — SPEC §5/§6 tags as BUILD M4-T1 lists them, and R278's Jlockeed.
//
// BUILD M4-T1's bullets do not ask for `name`; it is compared anyway, from the same §8 "Name"
// column (§5.3 settles #12, #31, #51 and #90.1), because a row whose name drifts is a row a reader
// can no longer line up with the spec.
//
// Not asserted here: `keywords`, `text`, `set`, `token`'s per-card value beyond the token set, and
// id shape. The per-card tests (M4-T3/T4) prove the behaviour `keywords` and `text` describe, and
// `packages/validator` owns the schema.

import { describe, expect, it } from "vitest";
import type { CardCost, CardDef, CardFace, CardType, Rarity, Tag } from "@jackioh/shared";
import { CATALOG } from "../src/catalog-data";

/** `[attack, health]`, or `null` for a §8 Stats cell that is empty (a card with no stats). */
type StatPair = readonly [number | null, number | null];

type SpecRow = {
  readonly index: string;
  readonly name: string;
  readonly cost: CardCost;
  readonly type: CardType;
  readonly tags: readonly Tag[];
  readonly rarity: Rarity;
  readonly base: StatPair;
  readonly radiant: StatPair;
};

const SPEC_8: readonly SpecRow[] = [
  { index: "1", name: "Big D-fender", cost: 2, type: "Unit", tags: ["Human"], rarity: "Common", base: [0, 8], radiant: [0, 16] },
  { index: "2", name: "Bigot", cost: 2, type: "Unit", tags: ["Human"], rarity: "Common", base: [6, 1], radiant: [12, 2] },
  { index: "3", name: "Right-house defender", cost: 1, type: "Unit", tags: ["Human"], rarity: "Common", base: [1, 1], radiant: [2, 2] },
  { index: "4", name: "Gary the Gambler", cost: 1, type: "Unit", tags: ["Human"], rarity: "Common", base: [1, 1], radiant: [2, 2] },
  { index: "5", name: "Stockpile", cost: 1, type: "Spell", tags: [], rarity: "Common", base: [null, null], radiant: [null, null] },
  { index: "6", name: "Mana Well", cost: 3, type: "Field Spell", tags: [], rarity: "Common", base: [null, null], radiant: [null, null] },
  { index: "7", name: "Jewelosco Scarab", cost: 1, type: "Unit", tags: [], rarity: "Rare", base: [1, 1], radiant: [2, 2] },
  { index: "8", name: "Mr. Vanilla", cost: 1, type: "Unit", tags: ["Human"], rarity: "Common", base: [3, 3], radiant: [7, 7] },
  { index: "9", name: "Moths to the Flame", cost: 2, type: "Unit", tags: [], rarity: "Rare", base: [1, 14], radiant: [2, 28] },
  { index: "10", name: "Rapid Replenish", cost: 0, type: "Spell", tags: [], rarity: "Common", base: [null, null], radiant: [null, null] },
  { index: "11", name: "Tempo Timmy", cost: 1, type: "Unit", tags: ["Human"], rarity: "Common", base: [3, 3], radiant: [6, 6] },
  { index: "12", name: "Duplicating Felinors", cost: 2, type: "Unit", tags: ["Felinor"], rarity: "Rare", base: [3, 4], radiant: [6, 9] },
  { index: "13", name: "Jlockeed Shredder-10", cost: 3, type: "Unit", tags: ["Jlockeed"], rarity: "Common", base: [8, 10], radiant: [16, 20] },
  { index: "14", name: "Jlockeed's Weapons", cost: 4, type: "Field Spell", tags: ["Jlockeed"], rarity: "Common", base: [null, null], radiant: [null, null] },
  { index: "15", name: "Me and Mr Token", cost: 1, type: "Unit", tags: ["Human"], rarity: "Common", base: [1, 1], radiant: [2, 2] },
  { index: "16", name: "Hit Job", cost: 2, type: "Spell", tags: [], rarity: "Common", base: [null, null], radiant: [null, null] },
  { index: "17", name: "Flood", cost: 3, type: "Spell", tags: [], rarity: "Rare", base: [null, null], radiant: [null, null] },
  { index: "18", name: "Bread and Butter", cost: 1, type: "Field Trap", tags: [], rarity: "Epic", base: [null, null], radiant: [null, null] },
  { index: "19", name: "Midrange Menace", cost: 3, type: "Unit", tags: [], rarity: "Common", base: [9, 9], radiant: [18, 18] },
  { index: "20", name: "Pointmaster", cost: 2, type: "Unit", tags: ["Human"], rarity: "Common", base: [7, 2], radiant: [14, 4] },
  { index: "21", name: "Hinder", cost: 0, type: "Spell", tags: [], rarity: "Common", base: [null, null], radiant: [null, null] },
  { index: "22", name: "Carnivorous Cube", cost: 3, type: "Unit", tags: [], rarity: "Epic", base: [4, 6], radiant: [8, 12] },
  { index: "23", name: "Reoccurring Dream", cost: 1, type: "Spell", tags: [], rarity: "Rare", base: [null, null], radiant: [null, null] },
  { index: "24", name: "Efficiency Dividend", cost: "X", type: "Spell", tags: [], rarity: "Epic", base: [null, null], radiant: [null, null] },
  { index: "25", name: "4-mana 7/7", cost: 4, type: "Unit", tags: [], rarity: "Common", base: [7, 7], radiant: [14, 14] },
  { index: "26", name: "Glowy Jelly Bean", cost: 3, type: "Spell", tags: [], rarity: "Rare", base: [null, null], radiant: [null, null] },
  { index: "27", name: "Blood Ridden Glowy Jelly Bean", cost: 1, type: "Spell", tags: [], rarity: "Common", base: [null, null], radiant: [null, null] },
  { index: "28", name: "Knockoff Temu Glowy Jelly Bean", cost: 2, type: "Spell", tags: [], rarity: "Common", base: [null, null], radiant: [null, null] },
  { index: "29", name: "GIGA Glowy Jelly Bean", cost: 6, type: "Spell", tags: [], rarity: "Rare", base: [null, null], radiant: [null, null] },
  { index: "30", name: "Archivist", cost: 2, type: "Unit", tags: [], rarity: "Rare", base: [4, 5], radiant: [8, 10] },
  { index: "31", name: "KY's Math Equation", cost: 1, type: "Spell", tags: ["KY"], rarity: "Rare", base: [null, null], radiant: [null, null] },
  { index: "32", name: "Prem Panther", cost: 2, type: "Unit", tags: [], rarity: "Rare", base: [5, 4], radiant: [10, 8] },
  { index: "33", name: "Unstable Clone Machine", cost: 2, type: "Field Spell", tags: [], rarity: "Rare", base: [null, null], radiant: [null, null] },
  { index: "34", name: "Collateral Damage", cost: 3, type: "Spell", tags: [], rarity: "Rare", base: [null, null], radiant: [null, null] },
  { index: "35", name: "Lunar Eclipse", cost: 1, type: "Spell", tags: [], rarity: "Rare", base: [null, null], radiant: [null, null] },
  { index: "36", name: "Magic Jammed", cost: 1, type: "Spell", tags: [], rarity: "Rare", base: [null, null], radiant: [null, null] },
  { index: "37", name: "Gravedigger", cost: 2, type: "Unit", tags: [], rarity: "Rare", base: [4, 5], radiant: [8, 10] },
  { index: "38", name: "Quickstriker", cost: 3, type: "Field Spell", tags: [], rarity: "Epic", base: [null, null], radiant: [null, null] },
  { index: "39", name: "Recycling Initiative", cost: 0, type: "Spell", tags: [], rarity: "Epic", base: [null, null], radiant: [null, null] },
  { index: "40", name: "Echoes of the Forgotten", cost: 2, type: "Field Spell", tags: [], rarity: "Common", base: [null, null], radiant: [null, null] },
  { index: "41", name: "Sheepish", cost: 1, type: "Trap", tags: [], rarity: "Epic", base: [null, null], radiant: [null, null] },
  { index: "42", name: "Eugenics", cost: 2, type: "Spell", tags: [], rarity: "Common", base: [null, null], radiant: [null, null] },
  { index: "43", name: "Big Felinor", cost: 3, type: "Unit", tags: ["Felinor"], rarity: "Rare", base: [3, 10], radiant: [6, 20] },
  { index: "44", name: "True Strike", cost: 1, type: "Spell", tags: [], rarity: "Common", base: [null, null], radiant: [null, null] },
  { index: "45", name: "Deft Duelist", cost: 2, type: "Unit", tags: ["Human"], rarity: "Rare", base: [4, 3], radiant: [8, 6] },
  { index: "46", name: "Suppressive Aura", cost: { base: 2, embiggen: 4 }, type: "Field Spell", tags: [], rarity: "Rare", base: [null, null], radiant: [null, null] },
  { index: "47", name: "Fig of Life", cost: 3, type: "Spell", tags: ["Fruit"], rarity: "Common", base: [null, null], radiant: [null, null] },
  { index: "48", name: "5pek Controller", cost: 0, type: "Spell", tags: [], rarity: "Common", base: [null, null], radiant: [null, null] },
  { index: "49", name: "Snom Bunny Mind Control", cost: 3, type: "Spell", tags: [], rarity: "Rare", base: [null, null], radiant: [null, null] },
  { index: "50", name: "Kpop Fanatic", cost: 1, type: "Unit", tags: [], rarity: "Epic", base: [1, 1], radiant: [2, 2] },
  { index: "51", name: "KY's Private Tutor", cost: 1, type: "Spell", tags: ["KY"], rarity: "Epic", base: [null, null], radiant: [null, null] },
  { index: "51.1", name: "KY's Empty Notebook", cost: 1, type: "Spell", tags: ["KY", "Token"], rarity: "Token", base: [null, null], radiant: [null, null] },
  { index: "52", name: "Silly Silas", cost: 3, type: "Unit", tags: ["Human"], rarity: "Legendary", base: [4, 4], radiant: [8, 8] },
  { index: "53", name: "Reno", cost: 3, type: "Unit", tags: ["Human"], rarity: "Common", base: [4, 6], radiant: [8, 12] },
  { index: "54", name: "Straaza", cost: 4, type: "Unit", tags: [], rarity: "Common", base: [8, 8], radiant: [16, 16] },
  { index: "55", name: "Lava Golem", cost: 3, type: "Unit", tags: [], rarity: "Rare", base: [10, 5], radiant: [20, 10] },
  { index: "56", name: "Jilliax", cost: 2, type: "Unit", tags: [], rarity: "Common", base: [3, 2], radiant: [6, 4] },
  { index: "57", name: "Conjure KY", cost: 2, type: "Spell", tags: ["KY"], rarity: "Common", base: [null, null], radiant: [null, null] },
  { index: "58", name: "Rush Token Farm", cost: 2, type: "Field Spell", tags: [], rarity: "Common", base: [null, null], radiant: [null, null] },
  { index: "59", name: "Unbiased Immigration", cost: { base: 2, embiggen: 4 }, type: "Field Spell", tags: [], rarity: "Rare", base: [null, null], radiant: [null, null] },
  { index: "60", name: "Bear Honeypot", cost: 1, type: "Trap", tags: [], rarity: "Epic", base: [null, null], radiant: [null, null] },
  { index: "61", name: "Prejudiced Postdoc", cost: 2, type: "Unit", tags: ["Human"], rarity: "Rare", base: [2, 4], radiant: [4, 8] },
  { index: "62", name: "Friend of Felinors", cost: 1, type: "Spell", tags: [], rarity: "Common", base: [null, null], radiant: [null, null] },
  { index: "63", name: "Plastic Surgery", cost: 1, type: "Spell", tags: [], rarity: "Common", base: [null, null], radiant: [null, null] },
  { index: "64", name: "Gifted Program", cost: 2, type: "Field Spell", tags: [], rarity: "Rare", base: [null, null], radiant: [null, null] },
  { index: "65", name: "Masochism Mask", cost: 2, type: "Field Spell", tags: ["Quickdraw"], rarity: "Epic", base: [null, null], radiant: [null, null] },
  { index: "65.1", name: "Spikey Pillow", cost: 1, type: "Unit", tags: ["Token"], rarity: "Token", base: [0, 2], radiant: [0, 4] },
  { index: "66", name: "The Rock", cost: 4, type: "Unit", tags: ["Human"], rarity: "Common", base: [10, 10], radiant: [20, 20] },
  { index: "67", name: "Zoomerbin Oomen", cost: 1, type: "Unit", tags: ["Human"], rarity: "Rare", base: [1, 2], radiant: [2, 4] },
  { index: "68", name: "Twisted Sorcerer", cost: 2, type: "Unit", tags: [], rarity: "Common", base: [5, 5], radiant: [10, 10] },
  { index: "69", name: "Call to Arms", cost: 2, type: "Spell", tags: [], rarity: "Common", base: [null, null], radiant: [null, null] },
  { index: "70", name: "Spiteful Stab", cost: 3, type: "Spell", tags: [], rarity: "Common", base: [null, null], radiant: [null, null] },
  { index: "71", name: "Intern Stimmy", cost: 1, type: "Field Trap", tags: [], rarity: "Rare", base: [null, null], radiant: [null, null] },
  { index: "72", name: "Reminisce", cost: 1, type: "Spell", tags: [], rarity: "Rare", base: [null, null], radiant: [null, null] },
  { index: "73", name: "Anti-oneshot Armor", cost: 2, type: "Field Spell", tags: [], rarity: "Rare", base: [null, null], radiant: [null, null] },
  { index: "74", name: "Adaptive UI", cost: "X", type: "Spell", tags: [], rarity: "Rare", base: [null, null], radiant: [null, null] },
  { index: "75", name: "Infinite Reserves", cost: 0, type: "Field Spell", tags: [], rarity: "Rare", base: [null, null], radiant: [null, null] },
  { index: "76", name: "Field of Dreams", cost: 3, type: "Spell", tags: [], rarity: "Rare", base: [null, null], radiant: [null, null] },
  { index: "77", name: "Professor Curvature", cost: 2, type: "Unit", tags: ["Human"], rarity: "Rare", base: [4, 5], radiant: [8, 10] },
  { index: "78", name: "/fullsend", cost: 4, type: "Spell", tags: [], rarity: "Epic", base: [null, null], radiant: [null, null] },
  { index: "79", name: "Twinspell", cost: 2, type: "Field Spell", tags: [], rarity: "Rare", base: [null, null], radiant: [null, null] },
  { index: "80", name: "Zao Gao", cost: 2, type: "Spell", tags: [], rarity: "Rare", base: [null, null], radiant: [null, null] },
  { index: "81", name: "Radiant Saintess", cost: 1, type: "Unit", tags: ["Human"], rarity: "Epic", base: [2, 2], radiant: [4, 4] },
  { index: "82", name: "KY's Trial", cost: 1, type: "Spell", tags: ["KY"], rarity: "Rare", base: [null, null], radiant: [null, null] },
  { index: "83", name: "Transmogulate", cost: 2, type: "Spell", tags: [], rarity: "Legendary", base: [null, null], radiant: [null, null] },
  { index: "84", name: "Going Long", cost: { base: 2, embiggen: 4 }, type: "Field Spell", tags: ["Quickdraw"], rarity: "Rare", base: [null, null], radiant: [null, null] },
  { index: "85", name: "Unlicensed Experimentation", cost: 1, type: "Trap", tags: [], rarity: "Legendary", base: [null, null], radiant: [null, null] },
  { index: "86", name: "\"Miss\" Mrow", cost: 1, type: "Unit", tags: ["Felinor"], rarity: "Epic", base: [1, 1], radiant: [2, 2] },
  { index: "87", name: "Pocket Chaos", cost: 2, type: "Spell", tags: [], rarity: "Legendary", base: [null, null], radiant: [null, null] },
  { index: "88", name: "Twisting Nether", cost: 3, type: "Spell", tags: [], rarity: "Epic", base: [null, null], radiant: [null, null] },
  { index: "89", name: "Corpse Eater", cost: 4, type: "Unit", tags: [], rarity: "Epic", base: [2, 2], radiant: [6, 6] },
  { index: "90", name: "CN-Viral Injection", cost: 1, type: "Spell", tags: ["CN"], rarity: "Rare", base: [null, null], radiant: [null, null] },
  { index: "90.1", name: "CN-Virus", cost: 1, type: "Spell", tags: ["CN", "Token"], rarity: "Token", base: [null, null], radiant: [null, null] },
  { index: "91", name: "Fed Fauci", cost: 2, type: "Unit", tags: ["Human"], rarity: "Rare", base: [1, 6], radiant: [2, 12] },
  { index: "92", name: "Felinor Fiender", cost: 2, type: "Unit", tags: ["Human"], rarity: "Legendary", base: [5, 7], radiant: [10, 14] },
  { index: "93", name: "Combo-Index", cost: 2, type: "Field Spell", tags: [], rarity: "Legendary", base: [null, null], radiant: [null, null] },
  { index: "93.1", name: "Combo-Fodder", cost: 0, type: "Spell", tags: ["Token"], rarity: "Token", base: [null, null], radiant: [null, null] },
  { index: "94", name: "Genn's Greed", cost: 4, type: "Spell", tags: [], rarity: "Epic", base: [null, null], radiant: [null, null] },
  { index: "95", name: "Call to Chaos (Core Edition)", cost: 4, type: "Spell", tags: ["Call to Chaos"], rarity: "Legendary", base: [null, null], radiant: [null, null] },
  { index: "95.1", name: "Chaos Golem", cost: 4, type: "Unit", tags: ["Token"], rarity: "Token", base: [10, 10], radiant: [20, 20] },
  { index: "96", name: "My Pawn", cost: 1, type: "Trap", tags: [], rarity: "Mythic", base: [null, null], radiant: [null, null] },
  { index: "97", name: "Zephyrs", cost: 0, type: "Spell", tags: [], rarity: "Mythic", base: [null, null], radiant: [null, null] },
  { index: "98", name: "Heroic Power", cost: "X", type: "Field Spell", tags: ["Quickdraw"], rarity: "Mythic", base: [null, null], radiant: [null, null] },
  { index: "99", name: "Craft a Card", cost: 3, type: "Spell", tags: [], rarity: "Mythic", base: [null, null], radiant: [null, null] },
  { index: "100", name: "Ceaseless Void", cost: 100, type: "Unit", tags: [], rarity: "Mythic", base: [10, 10], radiant: [20, 20] },
  { index: "T-rush", name: "Rush Token", cost: 1, type: "Unit", tags: ["Token"], rarity: "Token", base: [3, 3], radiant: [6, 6] },
  { index: "T-sheep", name: "Sheep Token", cost: 1, type: "Unit", tags: ["Token"], rarity: "Token", base: [1, 1], radiant: [2, 2] },
  { index: "T-felinor", name: "Felinor Token", cost: 1, type: "Unit", tags: ["Felinor", "Token"], rarity: "Token", base: [1, 1], radiant: [2, 2] },
  { index: "T-bread", name: "Bread Token", cost: 0, type: "Unit", tags: ["Token"], rarity: "Token", base: [0, 0], radiant: [0, 0] },
  { index: "T-coin", name: "The Coin", cost: 0, type: "Spell", tags: ["Token"], rarity: "Token", base: [null, null], radiant: [null, null] },
];

/** BUILD M4-T1: the only tags any entry may carry. */
const ALLOWED_TAGS: readonly string[] = [
  "Human",
  "Felinor",
  "KY",
  "CN",
  "Fruit",
  "Call to Chaos",
  "Quickdraw",
  "Jlockeed",
  "Token",
];

/** BUILD M4-T1 / SPEC §8 rarity paragraph. Tokens carry rarity "Token" and are counted apart. */
const RARITY_COUNTS: Readonly<Record<string, number>> = {
  Common: 35,
  Rare: 37,
  Epic: 16,
  Legendary: 7,
  Mythic: 5,
};

const ENTRIES: readonly CardDef[] = Object.values(CATALOG);

const BY_INDEX = new Map<string, CardDef>();
for (const entry of ENTRIES) {
  if (BY_INDEX.has(entry.index)) {
    throw new Error(`catalog has two entries with index "${entry.index}"`);
  }
  BY_INDEX.set(entry.index, entry);
}

function entryFor(index: string): CardDef {
  const entry = BY_INDEX.get(index);
  if (entry === undefined) {
    throw new Error(`#${index} is in SPEC §8 but missing from catalog.json`);
  }
  return entry;
}

/** A face's stat as the fixture spells it: a number, or `null` when the card has no stats. */
function statOf(face: CardFace, field: "attack" | "health"): number | null {
  const value = face[field];
  return value === undefined ? null : value;
}

const show = (value: unknown): string =>
  typeof value === "string" ? value : JSON.stringify(value);

/** "core-043 rarity: expected Rare, got Epic" — the label every failure in this file carries. */
const label = (entry: CardDef, field: string, expected: unknown, actual: unknown): string =>
  `${entry.id} (#${entry.index}) ${field}: expected ${show(expected)}, got ${show(actual)}`;

describe("catalog membership (BUILD M4-T1)", () => {
  it("holds exactly 100 cards and 10 tokens", () => {
    const cards = ENTRIES.filter((entry) => entry.token === false);
    const tokens = ENTRIES.filter((entry) => entry.token === true);
    expect(cards.length, "entries with token: false").toBe(100);
    expect(tokens.length, "entries with token: true").toBe(10);
    expect(ENTRIES.length, "catalog entries").toBe(110);
  });

  it("has indices 1-100 each present exactly once", () => {
    const missing: string[] = [];
    for (let n = 1; n <= 100; n += 1) {
      const entry = BY_INDEX.get(String(n));
      if (entry === undefined) {
        missing.push(`#${n} missing`);
      } else if (entry.token !== false) {
        missing.push(`#${n} (${entry.id}) is flagged token: true`);
      }
    }
    expect(missing, "indices 1-100").toEqual([]);
    // BY_INDEX is built with a duplicate guard, so one entry per index is already proved.
    expect(ENTRIES.filter((entry) => /^\d+$/.test(entry.index)).length, "plain numeric indices").toBe(100);
  });

  it("has the five card-defined tokens, the four shared tokens and The Coin", () => {
    const expected = ["51.1", "65.1", "90.1", "93.1", "95.1", "T-rush", "T-sheep", "T-felinor", "T-bread", "T-coin"];
    for (const index of expected) {
      const entry = BY_INDEX.get(index);
      expect(entry?.index, `token index ${index}`).toBe(index);
      expect(entry?.token, `token index ${index} token flag`).toBe(true);
    }
    const flagged = ENTRIES.filter((entry) => entry.token === true)
      .map((entry) => entry.index)
      .sort();
    expect(flagged, "entries flagged token: true").toEqual([...expected].sort());
  });

  it("holds no entry SPEC §8 and §7 do not list", () => {
    const known = new Set(SPEC_8.map((row) => row.index));
    const extra = ENTRIES.filter((entry) => !known.has(entry.index)).map(
      (entry) => `${entry.id} (#${entry.index})`,
    );
    expect(extra, "catalog entries with no SPEC row").toEqual([]);
    expect(SPEC_8.length, "SPEC §8 + §7 fixture rows").toBe(110);
  });
});

describe("every entry equals its SPEC §8 row (BUILD M4-T1)", () => {
  for (const row of SPEC_8) {
    it(`#${row.index} ${row.name}`, () => {
      const entry = entryFor(row.index);
      const problems: string[] = [];

      if (entry.name !== row.name) problems.push(label(entry, "name", row.name, entry.name));
      if (JSON.stringify(entry.cost) !== JSON.stringify(row.cost)) {
        problems.push(label(entry, "cost", row.cost, entry.cost));
      }
      if (entry.type !== row.type) problems.push(label(entry, "type", row.type, entry.type));
      if (entry.rarity !== row.rarity) {
        problems.push(label(entry, "rarity", row.rarity, entry.rarity));
      }

      // §8's cell order and the catalog's tag order may differ without either being wrong, so the
      // assertion is on the set.
      const expectedTags = [...row.tags].sort();
      const actualTags = [...entry.tags].sort();
      if (JSON.stringify(expectedTags) !== JSON.stringify(actualTags)) {
        problems.push(label(entry, "tags (as a set)", expectedTags, actualTags));
      }

      const stats: [string, CardFace, StatPair][] = [
        ["base", entry.base, row.base],
        ["radiant", entry.radiant, row.radiant],
      ];
      for (const [face, actual, expected] of stats) {
        if (statOf(actual, "attack") !== expected[0]) {
          problems.push(label(entry, `${face}.attack`, expected[0], statOf(actual, "attack")));
        }
        if (statOf(actual, "health") !== expected[1]) {
          problems.push(label(entry, `${face}.health`, expected[1], statOf(actual, "health")));
        }
      }

      expect(problems.join("\n"), `#${row.index} ${row.name} vs SPEC §8`).toBe("");
    });
  }
});

describe("rarity distribution (SPEC §8, BUILD M4-T1)", () => {
  it("is 35 Common, 37 Rare, 16 Epic, 7 Legendary, 5 Mythic", () => {
    const counted: Record<string, number> = {};
    for (const entry of ENTRIES.filter((e) => e.token === false)) {
      counted[entry.rarity] = (counted[entry.rarity] ?? 0) + 1;
    }
    expect(counted, "rarity counts over the 100 non-token cards").toEqual({ ...RARITY_COUNTS });
  });

  it("gives every token rarity Token and no card rarity Token", () => {
    const wrong = ENTRIES.filter((entry) => (entry.rarity === "Token") !== entry.token).map((entry) =>
      label(entry, "rarity", entry.token ? "Token" : "not Token", entry.rarity),
    );
    expect(wrong, "token rarity").toEqual([]);
  });
});

describe("tag vocabulary (BUILD M4-T1)", () => {
  it("uses only Human, Felinor, KY, CN, Fruit, Call to Chaos, Quickdraw, Jlockeed and Token", () => {
    const wrong: string[] = [];
    for (const entry of ENTRIES) {
      for (const tag of entry.tags) {
        if (!ALLOWED_TAGS.includes(tag)) {
          wrong.push(label(entry, "tags", `one of ${ALLOWED_TAGS.join(", ")}`, tag));
        }
      }
    }
    expect(wrong, "tags outside the allowed vocabulary").toEqual([]);
  });
});

describe("the Jlockeed tag (SPEC §5, §8, R278)", () => {
  it("R278 tags #13 Jlockeed Shredder-10 and #14 Jlockeed's Weapons, and no other entry", () => {
    const tagged = ENTRIES.filter((entry) => entry.tags.includes("Jlockeed")).map((entry) => entry.index);
    expect(tagged.sort(), "entries tagged Jlockeed").toEqual(["13", "14"]);
    // The tag follows the name: every entry whose name or text says Jlockeed carries it.
    const named = ENTRIES.filter((entry) =>
      [entry.name, entry.base.text, entry.radiant.text].some((text) => text.includes("Jlockeed")),
    ).map((entry) => entry.index);
    expect(named.sort(), "entries whose name or text names Jlockeed").toEqual(["13", "14"]);
  });
});

describe("every entry has a radiant face of its own (SPEC §5.2, R276)", () => {
  it("gives no entry a radiant face identical to its base face — the five that had none included", () => {
    const same = ENTRIES.filter((entry) => JSON.stringify(entry.radiant) === JSON.stringify(entry.base)).map(
      (entry) => `${entry.id} (#${entry.index}) radiant is a copy of base`,
    );
    expect(same, "entries whose radiant face is identical to base").toEqual([]);
  });
});
