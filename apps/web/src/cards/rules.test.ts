// Polish 6, slice B: the rules-text tokenizer and the glossary, tested pure (docs/polish/6-cards.md,
// Surface B `glossary.ts` / `rules.ts`, "Glossary terms", "Tokenizer", behaviours B10–B11).
//
// The rendered half of B10 (`RulesText` → `strong.cf-term[data-term]`) is in CardFace.test.tsx,
// through the face that uses it.
//
// B11 says each keyword carries "SPEC §6.1's rule text", and the Surface says the rule is "SPEC's
// 'Rule' column, copied verbatim". So the SPEC tables are read here at test time, rather than
// retyped: a transcription in this file would be a second copy that could drift from both.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { CATALOG } from "@jackioh/cards";
import { KEYWORD_KINDS, type KeywordKind } from "@jackioh/shared";

import { GLOSSARY, KEYWORD_MARK, RULED_TERMS, type GlossaryTermId, type TriggerTermId, type VerbTermId } from "./glossary.ts";
import { termsIn, tokenizeRules, type RulesToken } from "./rules.ts";

/* -------------------------------------------------------------------------------------- helpers */

const SPEC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../../../../SPEC.md"), "utf8");

/** The `Rule` column of one SPEC §6 table, keyed by the table's first column. */
function ruleColumn(section: "6.1" | "6.2" | "6.3"): Map<string, string> {
  const lines = SPEC.split("\n");
  const start = lines.findIndex((line) => line.startsWith(`### ${section} `));
  if (start < 0) throw new Error(`SPEC.md has no §${section} heading`);
  const rules = new Map<string, string>();
  for (const line of lines.slice(start + 1)) {
    if (line.startsWith("#")) break;
    if (!line.startsWith("|")) continue;
    const [term, rule] = line
      .split("|")
      .slice(1)
      .map((cell) => cell.trim());
    if (term === undefined || rule === undefined) continue;
    if (/^-+$/.test(term) || rule === "Rule") continue;
    rules.set(term, rule);
  }
  return rules;
}

/** Where a glossary id's SPEC row spells it differently (a trailing X, a capital). */
const SPEC_ROW_NAME: Readonly<Partial<Record<GlossaryTermId, string>>> = {
  Armor: "Armor X",
  Lucky: "Lucky X",
  "Start of game": "Start of Game",
  "Once per turn": "Once per Turn",
  Combo: "Combo X",
  Echo: "Echo X",
  Tribute: "Tribute X",
};

function specRule(section: "6.1" | "6.2" | "6.3", id: GlossaryTermId): string {
  const name = SPEC_ROW_NAME[id] ?? id;
  const rule = ruleColumn(section).get(name);
  if (rule === undefined) throw new Error(`SPEC §${section} has no row "${name}"`);
  return rule;
}

const TRIGGERS: readonly TriggerTermId[] = [
  "Cry",
  "Death",
  "Start of turn",
  "End of turn",
  "Start of game",
  "Once per turn",
  "Aura",
  "Combo",
  "Echo",
  "Cast on draw",
  "Quickdraw",
];

const VERBS_6_3: readonly VerbTermId[] = [
  "Discover",
  "Tribute",
  "Embiggen",
  "Recruit",
  "Fuse",
  "Transform",
  "Vanilla",
  "Lock",
  "Choose one",
];

/** "Moved unchanged out of Card.tsx": TA RU CH FS PO LS RB DS TR CL ND IM ST NA AR LK. */
const MARKS: Readonly<Record<KeywordKind, string>> = {
  Taunt: "TA",
  Rush: "RU",
  Charge: "CH",
  "First Strike": "FS",
  Poisonous: "PO",
  Lifesteal: "LS",
  Reborn: "RB",
  "Divine Shield": "DS",
  Trample: "TR",
  Cleave: "CL",
  Indestructible: "ND",
  Immutable: "IM",
  Stack: "ST",
  "Can't attack": "NA",
  Armor: "AR",
  Lucky: "LK",
};

type Term = { text: string; term: GlossaryTermId };

function termsOf(text: string): Term[] {
  return tokenizeRules(text).flatMap((token: RulesToken) =>
    token.kind === "term" ? [{ text: token.text, term: token.term }] : [],
  );
}

function joined(text: string): string {
  return tokenizeRules(text)
    .map((token) => token.text)
    .join("");
}

const ALL_TEXTS: readonly { where: string; text: string }[] = Object.values(CATALOG).flatMap((card) => [
  { where: `${card.id} base`, text: card.base.text },
  { where: `${card.id} radiant`, text: card.radiant.text },
]);

/* ----------------------------------------------------------------------------------------- B10 */

describe("B10: tokenizeRules and termsIn", () => {
  it("B10 'Cry: deal 2' is the term 'Cry:' followed by plain text", () => {
    expect(termsOf("Cry: deal 2")).toEqual([{ text: "Cry:", term: "Cry" }]);
    expect(joined("Cry: deal 2")).toBe("Cry: deal 2");
  });

  it("B10 'Armor 2' is one term", () => {
    expect(termsOf("Armor 2")).toEqual([{ text: "Armor 2", term: "Armor" }]);
    expect(joined("Armor 2")).toBe("Armor 2");
  });

  it("B10 'Start of your turn:' is the Start of turn term, through its alias", () => {
    expect(termsOf("Start of your turn:")).toEqual([{ text: "Start of your turn:", term: "Start of turn" }]);
    expect(termsOf("Start of turn: gain 1 mana")).toEqual([{ text: "Start of turn:", term: "Start of turn" }]);
  });

  it("B10 'Start of Game' and 'Once per Turn' are aliases of Start of game and Once per turn", () => {
    expect(termsOf("Start of Game: gain a power")).toEqual([{ text: "Start of Game:", term: "Start of game" }]);
    expect(termsOf("Start of game: gain a power")).toEqual([{ text: "Start of game:", term: "Start of game" }]);
    expect(termsOf('each "Once per Turn, spend X"')).toEqual([{ text: "Once per Turn", term: "Once per turn" }]);
    expect(termsOf('each "Once per turn, spend X"')).toEqual([{ text: "Once per turn", term: "Once per turn" }]);
  });

  it("B10 matching is case-sensitive: 'taunt', 'cry:' and 'choose one' stay text", () => {
    for (const text of ["taunt", "cry: deal 2", "choose one: a or b", "may tribute enemy units", "DIVINE SHIELD"]) {
      expect(termsOf(text), text).toEqual([]);
      expect(joined(text), text).toBe(text);
    }
  });

  it("B10 a term glued to a letter or digit on either side stays text: 'Locked', 'Rushing', 'Rush2', 'unTaunt'", () => {
    for (const text of ["Locked", "Rushing", "Rush2", "unTaunt", "XRush", "Crying", "Deathless", "Tauntx"]) {
      expect(termsOf(text), text).toEqual([]);
      expect(joined(text), text).toBe(text);
    }
  });

  it("B10 punctuation and spaces are word boundaries: 'Lock its zone', '(Taunt)', 'Rush.'", () => {
    expect(termsOf("Destroy target backrow card; Lock its zone")).toEqual([{ text: "Lock", term: "Lock" }]);
    expect(termsOf("(Taunt)")).toEqual([{ text: "Taunt", term: "Taunt" }]);
    expect(termsOf("Rush.")).toEqual([{ text: "Rush", term: "Rush" }]);
    expect(joined("Rush.")).toBe("Rush.");
  });

  it("B10 multi-word terms are one token: Divine Shield, First Strike, Can't attack, Cast on draw, Choose one", () => {
    expect(termsOf("Rush, Taunt, Lifesteal, Divine Shield")).toEqual([
      { text: "Rush", term: "Rush" },
      { text: "Taunt", term: "Taunt" },
      { text: "Lifesteal", term: "Lifesteal" },
      { text: "Divine Shield", term: "Divine Shield" },
    ]);
    expect(termsOf("First Strike")).toEqual([{ text: "First Strike", term: "First Strike" }]);
    expect(termsOf("Can't attack. Death: steal all enemy units")).toEqual([
      { text: "Can't attack", term: "Can't attack" },
      { text: "Death:", term: "Death" },
    ]);
    expect(termsOf("Cast on draw: take 1 damage")).toEqual([{ text: "Cast on draw:", term: "Cast on draw" }]);
    expect(termsOf("Choose one: bounce all units")).toEqual([{ text: "Choose one:", term: "Choose one" }]);
  });

  it("B10 the match extends over ' <digits|X>' and then ':': 'Combo 2:', 'Combo X:', 'Lucky 1', 'Tribute 3'", () => {
    expect(termsOf("Combo 2: draw 1")).toEqual([{ text: "Combo 2:", term: "Combo" }]);
    expect(termsOf("Combo X: deal X damage")).toEqual([{ text: "Combo X:", term: "Combo" }]);
    expect(termsOf("Lucky 1 (two rolls, keep the success)")).toEqual([{ text: "Lucky 1", term: "Lucky" }]);
    expect(termsOf("Armor X")).toEqual([{ text: "Armor X", term: "Armor" }]);
    expect(termsOf("Armor 12")).toEqual([{ text: "Armor 12", term: "Armor" }]);
    expect(termsOf("Tribute 3, Armor 3, Taunt; may tribute enemy units")).toEqual([
      { text: "Tribute 3", term: "Tribute" },
      { text: "Armor 3", term: "Armor" },
      { text: "Taunt", term: "Taunt" },
    ]);
  });

  it("B10 anything but a space then digits or X is not absorbed: 'Echo +1', 'Choose 2'", () => {
    expect(termsOf("The next Spell you play gains Echo +1")).toEqual([{ text: "Echo", term: "Echo" }]);
    // "Choose" alone is not a term; only "Choose one" is.
    expect(termsOf("Choose 2")).toEqual([]);
  });

  it("B10 tokens are lossless for every catalog text, and every term is a glossary id at word boundaries", () => {
    const ids = new Set<string>(Object.keys(GLOSSARY));
    for (const { where, text } of ALL_TEXTS) {
      const tokens = tokenizeRules(text);
      expect(tokens.map((token) => token.text).join(""), where).toBe(text);

      let offset = 0;
      for (const token of tokens) {
        if (token.kind === "term") {
          expect(ids.has(token.term), `${where}: ${token.term}`).toBe(true);
          const entry = GLOSSARY[token.term];
          const spellings = [entry.label, ...entry.aliases];
          expect(
            spellings.some((spelling) => token.text.startsWith(spelling)),
            `${where}: "${token.text}" starts with a spelling of ${token.term}`,
          ).toBe(true);
          const before = text.charAt(offset - 1);
          const after = text.charAt(offset + token.text.length);
          expect(/[A-Za-z0-9]/.test(before), `${where}: "${token.text}" has a letter before it`).toBe(false);
          expect(/[A-Za-z0-9]/.test(after), `${where}: "${token.text}" has a letter after it`).toBe(false);
        }
        offset += token.text.length;
      }
    }
  });

  it("B10 real card texts: Cry, Death, Combo, Cast on draw, Radiant and keywords are marked", () => {
    expect(termsIn("Cry: destroy target enemy non-Human unit")).toEqual(["Cry"]);
    expect(termsIn("Reborn; Death: all your other units become Radiant")).toEqual(["Reborn", "Death", "Radiant"]);
    expect(termsIn("Combo 3: draw 3; otherwise nothing")).toEqual(["Combo"]);
    expect(termsIn("Cast on draw: the opponent's next mana refresh is 1 lower")).toEqual(["Cast on draw"]);
    expect(termsIn("Deal 2 damage to a target, Lifesteal")).toEqual(["Lifesteal"]);
    expect(termsIn("Recruit 3 Units costing 1 or less")).toEqual(["Recruit"]);
    expect(termsIn("When the opponent plays a Unit: Transform it into a Sheep Token")).toEqual(["Transform"]);
  });

  it("B10 termsIn lists distinct terms in order of first appearance", () => {
    expect(termsIn("Tribute 3, Armor 3, Taunt; may tribute enemy units")).toEqual(["Tribute", "Armor", "Taunt"]);
    expect(termsIn("Rush; Rush, Rush.")).toEqual(["Rush"]);
    expect(termsIn("Start of your turn: x. Start of turn: y. End of turn: z")).toEqual(["Start of turn", "End of turn"]);
    expect(termsIn("Armor 1; Taunt; Armor 2")).toEqual(["Armor", "Taunt"]);
  });

  it("B10 empty or term-free text gives no terms", () => {
    expect(tokenizeRules("").filter((token) => token.kind === "term")).toEqual([]);
    expect(joined("")).toBe("");
    expect(termsIn("")).toEqual([]);
    expect(termsIn("taunt, Locked, choose one, Rushing")).toEqual([]);
    expect(termsIn("   ")).toEqual([]);
  });
});

/* ----------------------------------------------------------------------------------------- B11 */

describe("B11: GLOSSARY and KEYWORD_MARK", () => {
  it("B11 the SPEC tables this file reads are really there (a control for the checks below)", () => {
    expect(ruleColumn("6.1").size).toBeGreaterThanOrEqual(KEYWORD_KINDS.length);
    expect(ruleColumn("6.2").size).toBeGreaterThanOrEqual(TRIGGERS.length);
    expect(ruleColumn("6.3").size).toBeGreaterThanOrEqual(VERBS_6_3.length);
  });

  it("B11 one entry per KEYWORD_KINDS kind, carrying SPEC §6.1's rule text verbatim", () => {
    for (const kind of KEYWORD_KINDS) {
      const entry = GLOSSARY[kind];
      expect(entry, kind).toBeDefined();
      expect(entry.id, kind).toBe(kind);
      expect(entry.section, kind).toBe("§6.1");
      expect(entry.rule, kind).toBe(specRule("6.1", kind));
    }
  });

  it("B11 KEYWORD_MARK keeps the two-letter marks Card.tsx used, for exactly the 16 kinds", () => {
    expect(KEYWORD_MARK).toEqual(MARKS);
  });

  it("B11 every §6.2 term, with SPEC §6.2's rule text (or, for a ruled term, not the overridden Rule column)", () => {
    for (const id of TRIGGERS) {
      const entry = GLOSSARY[id];
      expect(entry, id).toBeDefined();
      expect(entry.id, id).toBe(id);
      expect(entry.section, id).toBe("§6.2");
      if (RULED_TERMS.includes(id)) expect(entry.rule, id).not.toBe(specRule("6.2", id));
      else expect(entry.rule, id).toBe(specRule("6.2", id));
    }
  });

  it("B11 Cry states §6.2's ruling: played from hand or cast, never summoned, copied, Recruited, Reborn or Transformed", () => {
    // The ruling this pins, read from SPEC so a change there fails here.
    const row = SPEC.split("\n").find((line) => line.startsWith("| Cry |"));
    expect(row).toBeDefined();
    expect(row).toContain("fires only when played from hand (or by Cast on draw / Echo / Call to Chaos casting)");
    expect(row).toContain("Copies, Recruit, Reborn, tokens and Transform results do not fire it");

    const rule = GLOSSARY.Cry.rule;
    expect(rule).not.toContain("enters the field");
    expect(rule).toMatch(/play this card from your hand/);
    for (const cast of ["Cast on draw", "Echo", "Call to Chaos"]) expect(rule).toContain(cast);
    for (const never of ["summoned", "copied", "Recruited", "Reborn", "Transformed"]) expect(rule).toContain(never);
    expect(RULED_TERMS).toEqual(["Cry"]);
  });

  it("B11 every §6.3 term, with SPEC §6.3's rule text, and Radiant under §5.2 with a non-empty rule", () => {
    for (const id of VERBS_6_3) {
      const entry = GLOSSARY[id];
      expect(entry, id).toBeDefined();
      expect(entry.id, id).toBe(id);
      expect(entry.section, id).toBe("§6.3");
      expect(entry.rule, id).toBe(specRule("6.3", id));
    }
    const radiant = GLOSSARY.Radiant;
    expect(radiant.id).toBe("Radiant");
    expect(radiant.section).toBe("§5.2");
    expect(radiant.rule.trim()).not.toBe("");
  });

  it("B11 the glossary is exactly those 37 terms, each with a label, a rule and an alias list", () => {
    const expected = [...KEYWORD_KINDS, ...TRIGGERS, ...VERBS_6_3, "Radiant"].sort();
    expect(Object.keys(GLOSSARY).sort()).toEqual(expected);
    for (const [key, entry] of Object.entries(GLOSSARY)) {
      expect(entry.id, key).toBe(key);
      expect(entry.label.trim(), key).not.toBe("");
      expect(entry.rule.trim(), key).not.toBe("");
      expect(Array.isArray(entry.aliases), key).toBe(true);
    }
  });

  it("B11 the three spelled variants are aliases: Start of your turn, Start of Game, Once per Turn", () => {
    expect(GLOSSARY["Start of turn"].aliases).toContain("Start of your turn");
    expect(GLOSSARY["Start of game"].aliases).toContain("Start of Game");
    expect(GLOSSARY["Once per turn"].aliases).toContain("Once per Turn");
  });
});
