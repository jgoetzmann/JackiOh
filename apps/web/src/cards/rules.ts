// Rules text as tokens: plain text, and glossary terms the face prints in bold
// (docs/polish/6-cards.md, Surface B "Tokenizer").
//
// - Matching is case-sensitive and longest-first over every GLOSSARY label and alias.
// - A term matches only at a word boundary: the characters either side are not [A-Za-z0-9], so
//   "Locked" and "taunt" stay plain text.
// - A match extends over a following ` <digits|X>` and then a `:`, so "Cry:", "Armor 2" and
//   "Combo 2:" are each one term.

import { GLOSSARY, type GlossaryEntry, type GlossaryTermId } from "./glossary.ts";
import type { FaceModel } from "./model.ts";

export type RulesToken = { kind: "text"; text: string } | { kind: "term"; text: string; term: GlossaryTermId };

type Pattern = { text: string; term: GlossaryTermId };

const ENTRIES: readonly GlossaryEntry[] = Object.values(GLOSSARY);

/** Every spelling, longest first, so "Start of your turn" is tried before anything shorter. */
const PATTERNS: readonly Pattern[] = ENTRIES.flatMap((entry) =>
  [entry.label, ...entry.aliases].map((text) => ({ text, term: entry.id })),
).sort((a, b) => b.text.length - a.text.length);

/** ` 3`, ` 10` or ` X`, ending at a word boundary. */
const NUMBER_SUFFIX = /^ (?:\d+|X)(?![A-Za-z0-9])/;

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && /[A-Za-z0-9]/.test(char);
}

function matchAt(text: string, start: number): { end: number; term: GlossaryTermId } | null {
  if (isWordChar(text[start - 1])) return null;
  for (const pattern of PATTERNS) {
    if (!text.startsWith(pattern.text, start)) continue;
    let end = start + pattern.text.length;
    if (isWordChar(text[end])) continue;
    const suffix = NUMBER_SUFFIX.exec(text.slice(end));
    if (suffix !== null) end += suffix[0].length;
    if (text[end] === ":") end += 1;
    return { end, term: pattern.term };
  }
  return null;
}

export function tokenizeRules(text: string): RulesToken[] {
  const tokens: RulesToken[] = [];
  let plain = "";
  let index = 0;

  while (index < text.length) {
    const match = matchAt(text, index);
    if (match === null) {
      plain += text[index] ?? "";
      index += 1;
      continue;
    }
    if (plain !== "") {
      tokens.push({ kind: "text", text: plain });
      plain = "";
    }
    tokens.push({ kind: "term", text: text.slice(index, match.end), term: match.term });
    index = match.end;
  }

  if (plain !== "") tokens.push({ kind: "text", text: plain });
  return tokens;
}

/** Distinct terms in order of first appearance. */
export function termsIn(text: string): GlossaryTermId[] {
  const seen: GlossaryTermId[] = [];
  for (const token of tokenizeRules(text)) {
    if (token.kind === "term" && !seen.includes(token.term)) seen.push(token.term);
  }
  return seen;
}

/** termsIn(the face's text), then face.keywords' kinds; distinct; mapped to entries. */
export function glossaryFor(face: FaceModel): GlossaryEntry[] {
  const ids: GlossaryTermId[] = [];
  const add = (id: GlossaryTermId): void => {
    if (!ids.includes(id)) ids.push(id);
  };
  for (const id of termsIn(face.text.full)) add(id);
  for (const keyword of face.keywords) add(keyword.kind);
  return ids.map((id) => GLOSSARY[id]);
}
