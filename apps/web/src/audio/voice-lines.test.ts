// Polish task 2 (docs/polish/2-sound.md), behaviours B33 and B34: `voice-lines.json` against the
// catalog it voices.
//
//   B33  exactly the 109 catalog ids, each `kind` from the catalog type, units carry `play` and
//        `death` and nothing else carries either, non-units carry `cast`, and every referenced
//        persona exists with a usable `say` voice and in-range rate, pbas, pmod, web values and
//        (where set) loudness trim `gain`, 0-2.
//   B34  every line is non-empty, uses only /^[A-Za-z ,.'!?-]+$/, stays within
//        VOICE_MAX_WORDS[line] words (a word is a token that contains a letter), and never uses a
//        BANNED_RULES_WORDS entry as a whole word, in any case.
//
// Both files are read off disk rather than imported, so this checks the committed JSON itself and
// not whatever `voiceData.ts` makes of it. Each test collects every offender before asserting, so
// a red run names all of them at once instead of the first.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { BANNED_RULES_WORDS, VOICE_MAX_WORDS } from "./constants.ts";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, "../../../..");
const CATALOG_PATH = resolve(REPO, "packages/cards/catalog.json");
const LINES_PATH = resolve(here, "voice-lines.json");

type EntryKind = "unit" | "spell" | "trap";
type LineKind = "play" | "death" | "cast";

const LINE_KINDS: readonly LineKind[] = ["play", "death", "cast"];

/** docs/polish/2-sound.md: Unit -> unit; Spell and Field Spell -> spell; Trap and Field Trap -> trap. */
const KIND_OF_TYPE: Readonly<Record<string, EntryKind>> = {
  Unit: "unit",
  Spell: "spell",
  "Field Spell": "spell",
  Trap: "trap",
  "Field Trap": "trap",
};

/** The fields `VoiceLineEntry` allows for each kind (types.ts), per-card overrides included. */
const OVERRIDE_FIELDS = ["rate", "pbas", "pmod"] as const;
const ALLOWED_FIELDS: Readonly<Record<EntryKind, readonly string[]>> = {
  unit: ["kind", "persona", "play", "death", ...OVERRIDE_FIELDS],
  spell: ["kind", "persona", "cast", ...OVERRIDE_FIELDS],
  trap: ["kind", "persona", "cast", ...OVERRIDE_FIELDS],
};

/** B34's charset, verbatim. */
const LINE_CHARSET = /^[A-Za-z ,.'!?-]+$/;

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

const catalogRaw = readJson(CATALOG_PATH);
if (!isRecord(catalogRaw)) throw new Error(`${CATALOG_PATH}: expected an object keyed by card id`);
const CATALOG = catalogRaw as Record<string, { type?: unknown }>;
const CATALOG_IDS: readonly string[] = Object.keys(CATALOG);

const tableRaw = readJson(LINES_PATH);
if (!isRecord(tableRaw)) throw new Error(`${LINES_PATH}: expected an object`);
const TABLE: Json = tableRaw;
const PERSONAS: Json = isRecord(TABLE.personas) ? TABLE.personas : {};
const CARDS: Record<string, Json> = Object.fromEntries(
  Object.entries(isRecord(TABLE.cards) ? TABLE.cards : {}).map(([id, entry]) => [id, isRecord(entry) ? entry : {}]),
);

function catalogKind(id: string): EntryKind | undefined {
  const type = CATALOG[id]?.type;
  return typeof type === "string" ? KIND_OF_TYPE[type] : undefined;
}

/** Every line the table carries, whatever its shape, so a malformed one is still checked. */
type Line = { key: string; line: LineKind; text: unknown };

function allLines(): Line[] {
  const out: Line[] = [];
  for (const [defId, entry] of Object.entries(CARDS)) {
    for (const line of LINE_KINDS) {
      if (line in entry) out.push({ key: `${defId}-${line}`, line, text: entry[line] });
    }
  }
  return out;
}

/** The personas the cards table actually names. */
function referencedPersonas(): string[] {
  const names = new Set<string>();
  for (const entry of Object.values(CARDS)) {
    if (typeof entry.persona === "string") names.add(entry.persona);
  }
  return [...names].sort();
}

function inRange(value: unknown, min: number, max: number): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

/** B34: a word is a whitespace-separated token that contains a letter ("..." alone is not one). */
function wordCount(text: string): number {
  return text.split(/\s+/).filter((token) => /[A-Za-z]/.test(token)).length;
}

/** B34: whole word, case-insensitive; a multi-word entry matches across any run of whitespace. */
function bannedMatcher(word: string): RegExp {
  const body = word
    .trim()
    .split(/\s+/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("\\s+");
  return new RegExp(`(?<![A-Za-z])${body}(?![A-Za-z])`, "i");
}

describe("voice-lines.json covers the catalog (B33)", () => {
  it("B33 declares version 1 and one cards entry per catalog card, 109 in all", () => {
    expect(TABLE.version, "voice-lines.json version").toBe(1);
    expect(CATALOG_IDS, "packages/cards/catalog.json holds the 100 Core cards and 9 tokens").toHaveLength(109);
    expect(Object.keys(CARDS), "one cards entry per catalog id").toHaveLength(109);
  });

  it("B33 leaves no catalog id, tokens included, without an entry", () => {
    const missing = CATALOG_IDS.filter((id) => !(id in CARDS));
    expect(missing, "catalog ids with no voice-lines entry").toEqual([]);
  });

  it("B33 has no entry for an id the catalog does not hold", () => {
    const known = new Set(CATALOG_IDS);
    const extra = Object.keys(CARDS).filter((id) => !known.has(id));
    expect(extra, "voice-lines entries for ids outside packages/cards/catalog.json").toEqual([]);
  });

  it("B33 gives every entry the kind its catalog type maps to", () => {
    const unknownTypes = CATALOG_IDS.filter((id) => catalogKind(id) === undefined).map(
      (id) => `${id}: catalog type ${JSON.stringify(CATALOG[id]?.type)}`,
    );
    expect(unknownTypes, "every catalog type is Unit, Spell, Field Spell, Trap or Field Trap").toEqual([]);

    const wrong = Object.entries(CARDS)
      .filter(([id, entry]) => CATALOG_IDS.includes(id) && entry.kind !== catalogKind(id))
      .map(([id, entry]) => `${id}: kind ${JSON.stringify(entry.kind)}, catalog says ${String(catalogKind(id))}`);
    expect(wrong, "entries whose kind disagrees with the catalog type").toEqual([]);
  });

  it("B33 gives every unit a play and a death line and no cast line", () => {
    const wrong: string[] = [];
    for (const id of CATALOG_IDS.filter((catalogId) => catalogKind(catalogId) === "unit")) {
      const entry = CARDS[id] ?? {};
      if (typeof entry.play !== "string") wrong.push(`${id}: no play line`);
      if (typeof entry.death !== "string") wrong.push(`${id}: no death line`);
      if ("cast" in entry) wrong.push(`${id}: a unit carries a cast line`);
    }
    expect(wrong).toEqual([]);
  });

  it("B33 gives every spell and trap a cast line and neither a play nor a death line", () => {
    const wrong: string[] = [];
    for (const id of CATALOG_IDS.filter((catalogId) => catalogKind(catalogId) !== "unit")) {
      const entry = CARDS[id] ?? {};
      if (typeof entry.cast !== "string") wrong.push(`${id}: no cast line`);
      if ("play" in entry) wrong.push(`${id}: a ${String(catalogKind(id))} carries a play line`);
      if ("death" in entry) wrong.push(`${id}: a ${String(catalogKind(id))} carries a death line`);
    }
    expect(wrong).toEqual([]);
  });

  it("B33 puts no field on an entry outside its kind's shape, and overrides are numbers", () => {
    const wrong: string[] = [];
    for (const [id, entry] of Object.entries(CARDS)) {
      const kind = entry.kind;
      if (kind !== "unit" && kind !== "spell" && kind !== "trap") {
        wrong.push(`${id}: kind ${JSON.stringify(kind)} is not unit, spell or trap`);
        continue;
      }
      for (const field of Object.keys(entry)) {
        if (!ALLOWED_FIELDS[kind].includes(field)) wrong.push(`${id}: unexpected field "${field}" on a ${kind}`);
      }
      for (const field of OVERRIDE_FIELDS) {
        if (field in entry && (typeof entry[field] !== "number" || !Number.isFinite(entry[field]))) {
          wrong.push(`${id}: override ${field} is ${JSON.stringify(entry[field])}, not a number`);
        }
      }
    }
    expect(wrong).toEqual([]);
  });

  it("B33 names only personas that exist", () => {
    const dangling = Object.entries(CARDS)
      .filter(([, entry]) => typeof entry.persona !== "string" || !isRecord(PERSONAS[entry.persona]))
      .map(([id, entry]) => `${id}: persona ${JSON.stringify(entry.persona)}`);
    expect(dangling, "entries whose persona is missing from personas").toEqual([]);
  });

  it("B33 gives every referenced persona a non-empty say voice", () => {
    const personas = referencedPersonas();
    expect(personas.length, "the cards table names at least one persona").toBeGreaterThan(0);
    const wrong = personas
      .filter((name) => isRecord(PERSONAS[name]))
      .filter((name) => {
        const say = (PERSONAS[name] as Json).say;
        return typeof say !== "string" || say.trim() === "";
      });
    expect(wrong, "personas with no usable `say -v` voice").toEqual([]);
  });

  it("B33 keeps every referenced persona's rate within 90-360 and its pbas and pmod within 0-127", () => {
    const wrong: string[] = [];
    for (const name of referencedPersonas()) {
      const persona = PERSONAS[name];
      if (!isRecord(persona)) continue;
      if (!inRange(persona.rate, 90, 360)) wrong.push(`${name}: rate ${JSON.stringify(persona.rate)}`);
      if (!inRange(persona.pbas, 0, 127)) wrong.push(`${name}: pbas ${JSON.stringify(persona.pbas)}`);
      if (!inRange(persona.pmod, 0, 127)) wrong.push(`${name}: pmod ${JSON.stringify(persona.pmod)}`);
      if ("gain" in persona && !inRange(persona.gain, 0, 2)) wrong.push(`${name}: gain ${JSON.stringify(persona.gain)}`);
    }
    expect(wrong).toEqual([]);
  });

  it("B33 keeps every referenced persona's web pitch within 0-2 and web rate within 0.1-10", () => {
    const wrong: string[] = [];
    for (const name of referencedPersonas()) {
      const persona = PERSONAS[name];
      if (!isRecord(persona)) continue;
      const web = persona.web;
      if (!isRecord(web)) {
        wrong.push(`${name}: no web block`);
        continue;
      }
      if (!inRange(web.pitch, 0, 2)) wrong.push(`${name}: web pitch ${JSON.stringify(web.pitch)}`);
      if (!inRange(web.rate, 0.1, 10)) wrong.push(`${name}: web rate ${JSON.stringify(web.rate)}`);
    }
    expect(wrong).toEqual([]);
  });

  it("B33 comes to 43 units and 66 spells and traps, which is 152 lines", () => {
    const kinds = Object.values(CARDS).map((entry) => entry.kind);
    expect(kinds.filter((kind) => kind === "unit"), "unit entries").toHaveLength(43);
    expect(kinds.filter((kind) => kind === "spell" || kind === "trap"), "spell and trap entries").toHaveLength(66);
    expect(allLines(), "lines in the table").toHaveLength(152);
  });
});

describe("every voice line is short, plain flavour (B34)", () => {
  it("B34 has no empty or blank line", () => {
    const lines = allLines();
    expect(lines.length, "lines to check").toBeGreaterThan(0);
    const empty = lines.filter(({ text }) => typeof text !== "string" || text.trim() === "").map(({ key }) => key);
    expect(empty, "lines that are missing, not strings, or blank").toEqual([]);
  });

  it("B34 uses only letters, spaces and , . ' ! ? - in every line", () => {
    const wrong = allLines()
      .filter(({ text }) => typeof text !== "string" || !LINE_CHARSET.test(text))
      .map(({ key, text }) => `${key}: ${JSON.stringify(text)}`);
    expect(wrong, "lines outside /^[A-Za-z ,.'!?-]+$/").toEqual([]);
  });

  it("B34 keeps every line within VOICE_MAX_WORDS for its kind (play 8, death 6, cast 8)", () => {
    expect(VOICE_MAX_WORDS, "the limits the Surface fixes").toEqual({ play: 8, death: 6, cast: 8 });
    // The counter itself: punctuation-only tokens are not words, hyphenated and elided ones are one.
    expect(wordCount("Too... slow...")).toBe(2);
    expect(wordCount("Oops - Surf's up!")).toBe(3);

    const long = allLines()
      .filter(({ line, text }) => typeof text === "string" && wordCount(text) > VOICE_MAX_WORDS[line])
      .map(({ key, line, text }) => `${key}: ${wordCount(String(text))} words > ${VOICE_MAX_WORDS[line]}`);
    expect(long, "lines over their word limit").toEqual([]);
  });

  it("B34 uses no BANNED_RULES_WORDS entry as a whole word, in any case", () => {
    expect([...BANNED_RULES_WORDS], "the rules vocabulary the Surface bans").toEqual([
      "Taunt", "Divine Shield", "Reborn", "Lifesteal", "Poisonous", "First Strike", "Trample", "Cleave",
      "Immutable", "Indestructible", "Stack", "Echo", "Combo", "Discover", "Recruit", "Tribute",
      "Embiggen", "Radiant", "Armor", "Rush", "Charge", "Cry", "Deathrattle", "Battlecry", "mana",
      "damage", "summon", "exile", "fatigue", "backrow", "graveyard",
    ]);
    // The matcher itself: whole words in any case, across whitespace, and never inside a longer word.
    expect(bannedMatcher("Taunt").test("I TAUNT you!")).toBe(true);
    expect(bannedMatcher("Divine Shield").test("a divine  shield, dear")).toBe(true);
    expect(bannedMatcher("Echo").test("Echoes of the past")).toBe(false);
    expect(bannedMatcher("mana").test("Banana!")).toBe(false);

    const matchers = BANNED_RULES_WORDS.map((word) => ({ word, pattern: bannedMatcher(word) }));
    const offences: string[] = [];
    for (const { key, text } of allLines()) {
      if (typeof text !== "string") continue;
      for (const { word, pattern } of matchers) {
        if (pattern.test(text)) offences.push(`${key}: "${word}" in ${JSON.stringify(text)}`);
      }
    }
    expect(offences, "lines that restate rules vocabulary").toEqual([]);
  });
});
