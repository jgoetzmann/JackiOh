/**
 * Structural validation of packages/cards/catalog.json against SPEC §5, §6.1, §7 and §8.
 *
 * Run with: pnpm exec tsx packages/cards/scripts/validate-catalog.ts
 *
 * This checks the shape and the census of the catalog: that it holds every Core card and
 * every token exactly once, that every enum value is in the union `packages/shared` declares,
 * that stats sit on Units and nowhere else, and that the rarity distribution §8 prints is the
 * one the file carries. It does NOT re-read the §8 cells — `test/catalog.test.ts` does that
 * with an independent transcription.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { KEYWORD_KINDS, type CardType, type Keyword, type Rarity, type SetName, type Tag } from "@jackioh/shared";

/* ------------------------------------------------------------------ unions */

// `satisfies` keeps each list inside its union; the `Exhaustive` aliases fail to
// compile if the union ever grows a member the list does not carry.
const CARD_TYPES = ["Unit", "Spell", "Field Spell", "Trap", "Field Trap"] as const satisfies readonly CardType[];
const TAGS = [
  "Human",
  "Felinor",
  "KY",
  "CN",
  "Fruit",
  "Call to Chaos",
  "Quickdraw",
  "Jlockeed",
  "Token",
] as const satisfies readonly Tag[];
const RARITIES = ["Common", "Rare", "Epic", "Legendary", "Mythic", "Token"] as const satisfies readonly Rarity[];
const SET_NAMES = ["Core", "Classic", "Boss", "Boss-X"] as const satisfies readonly SetName[];

type Exhaustive<Union, Listed extends Union> = [Exclude<Union, Listed>] extends [never] ? true : never;
const _typesExhaustive: Exhaustive<CardType, (typeof CARD_TYPES)[number]> = true;
const _tagsExhaustive: Exhaustive<Tag, (typeof TAGS)[number]> = true;
const _raritiesExhaustive: Exhaustive<Rarity, (typeof RARITIES)[number]> = true;
const _setsExhaustive: Exhaustive<SetName, (typeof SET_NAMES)[number]> = true;
void _typesExhaustive;
void _tagsExhaustive;
void _raritiesExhaustive;
void _setsExhaustive;

/** §6.1: the two keywords that carry a number; every other kind is bare. */
const NUMBERED_KEYWORDS: ReadonlySet<string> = new Set(["Armor", "Lucky"]);

/* ------------------------------------------------------------- expectations */

/**
 * §8 + §7: the 100 Core indices, the 5 card-defined tokens, and the 5 named ones — the 4 tokens
 * several cards share and The Coin, which §2.1's setup deals (R244).
 */
const CARD_DEFINED_TOKEN_INDICES = ["51.1", "65.1", "90.1", "93.1", "95.1"] as const;
const SHARED_TOKEN_INDICES = ["T-rush", "T-sheep", "T-felinor", "T-bread", "T-coin"] as const;
const EXPECTED_INDICES: readonly string[] = [
  ...Array.from({ length: 100 }, (_, i) => String(i + 1)),
  ...CARD_DEFINED_TOKEN_INDICES,
  ...SHARED_TOKEN_INDICES,
];

const EXPECTED_TOTAL = 110;
const EXPECTED_NON_TOKEN = 100;
const EXPECTED_TOKEN = 10;

/** §8: "Distribution: 35 Common, 37 Rare, 16 Epic, 7 Legendary, 5 Mythic." */
const EXPECTED_RARITY_COUNTS: Readonly<Record<string, number>> = {
  Common: 35,
  Rare: 37,
  Epic: 16,
  Legendary: 7,
  Mythic: 5,
};

/**
 * §5, §7, §8: how many catalog entries carry each tag, tokens included — a census, so a tag that
 * drifts onto or off a card fails here (R278: Jlockeed is #13 and #14's and no other card's).
 */
const EXPECTED_TAG_COUNTS: Readonly<Record<(typeof TAGS)[number], number>> = {
  Human: 18,
  Felinor: 4,
  KY: 5,
  CN: 2,
  Fruit: 1,
  "Call to Chaos": 1,
  Quickdraw: 3,
  Jlockeed: 2,
  Token: 10,
};

/* ------------------------------------------------------------------ helpers */

const failures: string[] = [];
function fail(where: string, message: string): void {
  failures.push(`${where}: ${message}`);
}

/** §5: "43" → "core-043", "90.1" → "core-090-1", "T-rush" → "core-t-rush". */
function idForIndex(index: string): string {
  if (index.startsWith("T-")) return `core-${index.toLowerCase()}`;
  const [main, sub] = index.split(".");
  const padded = String(main ?? "").padStart(3, "0");
  return sub === undefined ? `core-${padded}` : `core-${padded}-${sub}`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describe(value: unknown): string {
  return JSON.stringify(value) ?? String(value);
}

/* -------------------------------------------------------------------- faces */

function validateFace(where: string, faceName: "base" | "radiant", face: unknown, isUnit: boolean): void {
  const at = `${where}.${faceName}`;
  if (!isPlainObject(face)) {
    fail(at, `face is not an object (got ${describe(face)})`);
    return;
  }

  // Stats: present on both faces of every Unit, absent on every non-Unit (§5, §8).
  for (const stat of ["attack", "health"] as const) {
    const value = face[stat];
    if (isUnit) {
      if (typeof value !== "number" || !Number.isInteger(value)) {
        fail(at, `Unit face must carry an integer \`${stat}\` (got ${describe(value)})`);
      }
    } else if (value !== undefined) {
      fail(at, `non-Unit face must not carry \`${stat}\` (got ${describe(value)})`);
    }
  }

  if (typeof face["text"] !== "string") {
    fail(at, `\`text\` must be a string (got ${describe(face["text"])})`);
  }

  const keywords = face["keywords"];
  if (!Array.isArray(keywords)) {
    fail(at, `\`keywords\` must be an array (got ${describe(keywords)})`);
    return;
  }
  keywords.forEach((keyword: unknown, i: number) => {
    const kwAt = `${at}.keywords[${i}]`;
    if (!isPlainObject(keyword)) {
      fail(kwAt, `keyword must be an object (got ${describe(keyword)})`);
      return;
    }
    const kind = keyword["kind"];
    if (typeof kind !== "string" || !(KEYWORD_KINDS as readonly string[]).includes(kind)) {
      fail(kwAt, `\`kind\` is not a Keyword kind (got ${describe(kind)})`);
      return;
    }
    const numbered = NUMBERED_KEYWORDS.has(kind);
    const n = keyword["n"];
    if (numbered && (typeof n !== "number" || !Number.isInteger(n))) {
      fail(kwAt, `${kind} must carry an integer \`n\` (got ${describe(n)})`);
    }
    if (!numbered && n !== undefined) {
      fail(kwAt, `${kind} must not carry \`n\` (got ${describe(n)})`);
    }
    const extra = Object.keys(keyword).filter((k) => k !== "kind" && k !== "n");
    if (extra.length > 0) fail(kwAt, `unknown keyword field(s) ${extra.join(", ")}`);
    // The narrowed object is assignable to Keyword only if the shape above held.
    void (keyword as unknown as Keyword);
  });
}

/* --------------------------------------------------------------------- main */

const catalogPath = fileURLToPath(new URL("../catalog.json", import.meta.url));
const raw: unknown = JSON.parse(readFileSync(catalogPath, "utf8"));

if (!isPlainObject(raw)) {
  console.error(`FAIL catalog.json: expected a JSON object keyed by card id, got ${describe(raw)}`);
  process.exit(1);
}
const catalog = raw;
const entries = Object.entries(catalog);

// 1. 110 entries.
if (entries.length !== EXPECTED_TOTAL) {
  fail("catalog", `expected ${EXPECTED_TOTAL} entries, found ${entries.length}`);
}

let nonTokenCount = 0;
let tokenCount = 0;
const rarityCounts = new Map<string, number>();
const tagCounts = new Map<string, number>();
/** R279: every entry's `refs`, checked against the ids once the whole file has been read. */
const refsByCard = new Map<string, unknown>();
const seenIndices = new Map<string, string[]>();

for (const [key, value] of entries) {
  const where = `catalog["${key}"]`;
  if (!isPlainObject(value)) {
    fail(where, `entry is not an object (got ${describe(value)})`);
    continue;
  }

  const index = value["index"];
  const id = value["id"];

  // The object must be keyed by the card's own id (integration decision 1).
  if (typeof id !== "string") {
    fail(where, `\`id\` must be a string (got ${describe(id)})`);
  } else if (id !== key) {
    fail(where, `key does not match \`id\` "${id}"`);
  }

  // 4. `id` follows the index convention (§5).
  if (typeof index !== "string") {
    fail(where, `\`index\` must be a string (got ${describe(index)})`);
  } else {
    const expectedId = idForIndex(index);
    if (id !== expectedId) fail(where, `index "${index}" implies id "${expectedId}", found ${describe(id)}`);
    const keys = seenIndices.get(index) ?? [];
    keys.push(key);
    seenIndices.set(index, keys);
  }

  if (typeof value["name"] !== "string" || value["name"] === "") {
    fail(where, `\`name\` must be a non-empty string (got ${describe(value["name"])})`);
  }

  // 5. `type`, `tags`, `set`, `rarity` are in the unions shared/src/catalog-types.ts declares.
  const type = value["type"];
  const isUnit = type === "Unit";
  if (typeof type !== "string" || !(CARD_TYPES as readonly string[]).includes(type)) {
    fail(where, `\`type\` is not a CardType (got ${describe(type)})`);
  }

  const setName = value["set"];
  if (typeof setName !== "string" || !(SET_NAMES as readonly string[]).includes(setName)) {
    fail(where, `\`set\` is not a SetName (got ${describe(setName)})`);
  }

  const tags = value["tags"];
  let tagList: string[] = [];
  if (!Array.isArray(tags)) {
    fail(where, `\`tags\` must be an array (got ${describe(tags)})`);
  } else {
    tagList = tags.map(String);
    for (const tag of tagList) tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    tags.forEach((tag: unknown, i: number) => {
      if (typeof tag !== "string" || !(TAGS as readonly string[]).includes(tag)) {
        fail(where, `tags[${i}] is not a Tag (got ${describe(tag)})`);
      }
    });
    if (new Set(tagList).size !== tagList.length) fail(where, `\`tags\` repeats a tag (${tagList.join(", ")})`);
  }

  const rarity = value["rarity"];
  if (typeof rarity !== "string" || !(RARITIES as readonly string[]).includes(rarity)) {
    fail(where, `\`rarity\` is not a Rarity (got ${describe(rarity)})`);
  }

  // 8. token === (rarity === "Token"); 2. the token/non-token split.
  const token = value["token"];
  if (typeof token !== "boolean") {
    fail(where, `\`token\` must be a boolean (got ${describe(token)})`);
  } else {
    if (token !== (rarity === "Token")) {
      fail(where, `token=${token} but rarity=${describe(rarity)} (§5: rarity is "Token" for exactly the tokens)`);
    }
    if (token) {
      tokenCount += 1;
      // 9. every token carries the Token tag (§5.1: random pools filter on it).
      if (!tagList.includes("Token")) fail(where, `token is missing the "Token" tag (tags: ${tagList.join(", ") || "none"})`);
    } else {
      nonTokenCount += 1;
      if (tagList.includes("Token")) fail(where, `non-token carries the "Token" tag`);
      if (typeof rarity === "string") rarityCounts.set(rarity, (rarityCounts.get(rarity) ?? 0) + 1);
    }
  }

  // §5: cost is 0..6, 100, "X", or {base, embiggen}.
  const cost = value["cost"];
  if (typeof cost === "number") {
    if (!Number.isInteger(cost) || cost < 0) fail(where, `numeric \`cost\` must be a non-negative integer (got ${cost})`);
  } else if (cost === "X") {
    // fine
  } else if (isPlainObject(cost)) {
    const { base, embiggen } = cost as { base?: unknown; embiggen?: unknown };
    if (typeof base !== "number" || typeof embiggen !== "number") {
      fail(where, `embiggen \`cost\` needs numeric \`base\` and \`embiggen\` (got ${describe(cost)})`);
    }
    const extra = Object.keys(cost).filter((k) => k !== "base" && k !== "embiggen");
    if (extra.length > 0) fail(where, `unknown cost field(s) ${extra.join(", ")}`);
  } else {
    fail(where, `\`cost\` is not a CardCost (got ${describe(cost)})`);
  }

  // 6, 7. Faces: valid keywords, stats on Units only.
  validateFace(where, "base", value["base"], isUnit);
  validateFace(where, "radiant", value["radiant"], isUnit);

  if ("refs" in value) refsByCard.set(key, value["refs"]);

  const unknownFields = Object.keys(value).filter(
    (k) => !["id", "index", "name", "set", "type", "tags", "rarity", "token", "cost", "refs", "base", "radiant"].includes(k),
  );
  if (unknownFields.length > 0) fail(where, `unknown field(s) ${unknownFields.join(", ")}`);
}

// 2. 100 non-token and 10 token.
if (nonTokenCount !== EXPECTED_NON_TOKEN) {
  fail("catalog", `expected ${EXPECTED_NON_TOKEN} non-token cards, found ${nonTokenCount}`);
}
if (tokenCount !== EXPECTED_TOKEN) {
  fail("catalog", `expected ${EXPECTED_TOKEN} tokens, found ${tokenCount}`);
}

// 3. Indices 1–100 each exactly once, plus the 10 token indices.
for (const index of EXPECTED_INDICES) {
  const keys = seenIndices.get(index);
  if (keys === undefined) fail("catalog", `index "${index}" is missing`);
  else if (keys.length > 1) fail("catalog", `index "${index}" appears ${keys.length} times (${keys.join(", ")})`);
}
for (const index of seenIndices.keys()) {
  if (!EXPECTED_INDICES.includes(index)) fail("catalog", `unexpected index "${index}"`);
}

// 10. Rarity distribution across the 100 non-token cards (§8).
for (const [rarity, expected] of Object.entries(EXPECTED_RARITY_COUNTS)) {
  const found = rarityCounts.get(rarity) ?? 0;
  if (found !== expected) fail("catalog", `expected ${expected} ${rarity} non-token cards, found ${found}`);
}
for (const [rarity, found] of rarityCounts) {
  if (!(rarity in EXPECTED_RARITY_COUNTS)) {
    fail("catalog", `${found} non-token card(s) carry rarity "${rarity}", which §8 does not distribute`);
  }
}

// 11. The tag census (R278).
for (const [tag, expected] of Object.entries(EXPECTED_TAG_COUNTS)) {
  const found = tagCounts.get(tag) ?? 0;
  if (found !== expected) fail("catalog", `expected ${expected} entries tagged "${tag}", found ${found}`);
}

// 12. R279: `refs` is a non-empty list of distinct catalog ids. Whether each one is named in the
// card's text, and every named card listed, is test/references.test.ts's to prove.
for (const [key, refs] of refsByCard) {
  const where = `catalog["${key}"].refs`;
  if (!Array.isArray(refs) || refs.length === 0) {
    fail(where, `must be a non-empty array of card ids when present (got ${describe(refs)})`);
    continue;
  }
  if (new Set(refs).size !== refs.length) fail(where, `repeats an id (${refs.join(", ")})`);
  for (const ref of refs) {
    if (typeof ref !== "string" || !(ref in catalog)) fail(where, `${describe(ref)} is not a catalog id`);
  }
}

/* ------------------------------------------------------------------ verdict */

if (failures.length > 0) {
  console.error(`validate-catalog: ${failures.length} failure(s) in ${catalogPath}\n`);
  for (const message of failures) console.error(`  FAIL ${message}`);
  console.error("");
  process.exit(1);
}

console.log(`validate-catalog: OK`);
console.log(`  ${entries.length} entries (${nonTokenCount} cards + ${tokenCount} tokens)`);
console.log(`  indices 1-100 plus ${CARD_DEFINED_TOKEN_INDICES.join(", ")} and ${SHARED_TOKEN_INDICES.join(", ")}`);
console.log(
  `  tags ${Object.entries(EXPECTED_TAG_COUNTS)
    .map(([tag, n]) => `${n} ${tag}`)
    .join(", ")}; refs on ${refsByCard.size} entries`,
);
console.log(
  `  rarities ${Object.entries(EXPECTED_RARITY_COUNTS)
    .map(([r, n]) => `${n} ${r}`)
    .join(", ")}`,
);
