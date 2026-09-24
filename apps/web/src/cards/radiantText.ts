// What a Radiant face prints, read from the catalog's two text cells by SPEC §8's reading rule
// (docs/polish/6-cards.md, B7 and B14):
//
//   "a cell that lists keywords without 'Plus' gives the radiant form's complete keyword list;
//   'Plus X' adds keyword X to the base keywords; a cell that names no keywords keeps the base
//   keywords. A clause the cell restates replaces the base version and every base clause it does
//   not restate is kept; a cell that changes only a number changes only that number. 'same' says
//   so explicitly, and 'Also' and 'Then' add effects."
//
// So a radiant face is not "base text, then the radiant cell". It prints:
//
// - `kept`: the keyword line the radiant form has, then every base clause the cell does not
//   restate. Radiant Jilliax (#56) prints "Charge, Taunt, Lifesteal, Indestructible", never
//   base's "Rush … Divine Shield" as well.
// - `changed`: what the cell adds or restates, printed under a gold rule: Bigot's (#2) new Cry
//   replaces the old one rather than following it, and Gary's (#4) "7 coins; +2 per heads …"
//   follows the Cry whose numbers it changes. Null when the cell changes nothing but keywords.
//
// Presentation only: the engine never reads a card's text (CLAUDE.md rule 7). The keyword line is
// cross-checked against the catalog's own `radiant.keywords`, which is proved against §8, so a
// cell that drops a keyword without naming it ("Can attack; same", #86) drops it here too.

import { KEYWORD_KINDS, type Keyword } from "@jackioh/shared";

import { GLOSSARY, type GlossaryTermId } from "./glossary.ts";
import { tokenizeRules, type RulesToken } from "./rules.ts";

export type RadiantText = { kept: string; changed: string | null };

type LineTerm = { text: string; term: GlossaryTermId };
type KeywordLine = { terms: LineTerm[]; rest: string; separator: string };

const KEYWORDS: ReadonlySet<string> = new Set<string>(KEYWORD_KINDS);

/** The catalog prints Tribute among a unit's keywords ("Tribute 3, Armor 3, Taunt"). */
const LINE_VERBS: ReadonlySet<GlossaryTermId> = new Set<GlossaryTermId>(["Tribute"]);

const PLUS = "Plus ";
const LIST_SEPARATOR = ", ";
/** How a keyword line ends when the text goes on: "Taunt; End of turn: …" or "Rush. Whenever …". */
const LINE_END = /^(?:; |\. |\.$)/;
const SAME = /^same$/i;
const TRAILING_SAME = /;\s*same$/i;
/** A sentence ends at a full stop followed by a space. */
const SENTENCE_BREAK = /(?<=\.)\s+/;
const DEFAULT_LINE_SEPARATOR = ". ";

function isKeyword(term: GlossaryTermId): boolean {
  return KEYWORDS.has(term);
}

function isLineTerm(term: GlossaryTermId): boolean {
  return isKeyword(term) || LINE_VERBS.has(term);
}

function isTrigger(term: GlossaryTermId): boolean {
  return GLOSSARY[term].section === "§6.2";
}

/**
 * The keyword line a text opens with: line terms joined by ", ", running to the end of the text or
 * to "; ", ". " or a final ".". A first clause that is not keywords alone ("Lucky 1 (two rolls …)
 * at 40%", "Cry: …") is no line, and the whole text is `rest`.
 */
export function splitKeywordLine(text: string): KeywordLine {
  const none: KeywordLine = { terms: [], rest: text, separator: "" };
  const tokens: readonly RulesToken[] = tokenizeRules(text);
  const terms: LineTerm[] = [];
  let offset = 0;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined) break;
    if (terms.length === 0 || tokens[index - 1]?.kind === "text") {
      // A term is expected here.
      if (token.kind !== "term" || !isLineTerm(token.term) || token.text.endsWith(":")) return none;
      terms.push({ text: token.text, term: token.term });
      offset += token.text.length;
      continue;
    }
    // After a term: ", " and another term, the end of the line, or anything else (no line).
    if (token.kind !== "text") return none;
    if (token.text === LIST_SEPARATOR && tokens[index + 1]?.kind === "term") {
      offset += token.text.length;
      continue;
    }
    const end = LINE_END.exec(token.text);
    if (end === null) return none;
    return { terms, rest: text.slice(offset + end[0].length), separator: end[0] };
  }
  return { terms, rest: "", separator: "" };
}

/** "Armor 1; same" → "Armor 1"; "Same" → "". */
function withoutSame(text: string): string {
  const trimmed = text.trim();
  if (SAME.test(trimmed)) return "";
  return trimmed.replace(TRAILING_SAME, "").trim();
}

/** The §6.2 trigger a clause opens with ("Cry:", "Aura:", "Combo 3:"), if it opens with one. */
function leadingTrigger(text: string): GlossaryTermId | null {
  const first = tokenizeRules(text)[0];
  if (first === undefined || first.kind !== "term" || !first.text.endsWith(":")) return null;
  return isTrigger(first.term) ? first.term : null;
}

/** `rest` without the first sentence that opens with `trigger`, or null when none does. */
function withoutClause(rest: string, trigger: GlossaryTermId): string | null {
  const sentences = rest.split(SENTENCE_BREAK);
  const at = sentences.findIndex((sentence) => leadingTrigger(sentence) === trigger);
  if (at < 0) return null;
  return sentences.filter((_, index) => index !== at).join(" ");
}

function distinct(terms: readonly LineTerm[]): LineTerm[] {
  const out: LineTerm[] = [];
  for (const term of terms) {
    if (!out.some((seen) => seen.term === term.term)) out.push(term);
  }
  return out;
}

function joinLine(terms: readonly LineTerm[], rest: string, separator: string): string {
  const line = terms.map((term) => term.text).join(LIST_SEPARATOR);
  if (line === "") return rest;
  if (rest === "") return line;
  return `${line}${separator === "" || separator === "." ? DEFAULT_LINE_SEPARATOR : separator}${rest}`;
}

/**
 * A radiant face's text from the base text, the radiant cell and the radiant form's keywords. An
 * empty cell, or one equal to the base text, keeps the base text whole.
 */
export function radiantText(base: string, cell: string, radiantKeywords: readonly Keyword[]): RadiantText {
  if (cell === "" || cell === base) return { kept: base, changed: null };

  const baseLine = splitKeywordLine(base);
  const radiantKinds = new Set<string>(radiantKeywords.map((keyword) => keyword.kind));
  let line: LineTerm[];
  let cellRest: string;

  if (cell.startsWith(PLUS)) {
    // "Plus X": the base keywords, and X.
    const plus = splitKeywordLine(cell.slice(PLUS.length));
    line = distinct([...baseLine.terms, ...plus.terms]);
    cellRest = plus.terms.length === 0 ? cell : plus.rest;
  } else {
    const cellLine = splitKeywordLine(cell);
    if (cellLine.terms.length > 0) {
      // A listed line is the radiant form's complete keyword list; a Tribute cost is not a keyword.
      const costs = baseLine.terms.filter((term) => !isKeyword(term.term));
      line = distinct([...costs, ...cellLine.terms]);
      cellRest = cellLine.rest;
    } else {
      // No keywords named: the base keywords, less any the radiant form no longer has.
      line = baseLine.terms.filter((term) => !isKeyword(term.term) || radiantKinds.has(term.term));
      cellRest = cell;
    }
  }

  const change = withoutSame(cellRest);
  let rest = baseLine.rest;
  if (change !== "") {
    // A clause the cell restates replaces the base version.
    const trigger = leadingTrigger(change);
    const replaced = trigger === null ? null : withoutClause(rest, trigger);
    if (replaced !== null) rest = replaced;
  }

  return { kept: joinLine(line, rest, baseLine.separator), changed: change === "" ? null : change };
}
