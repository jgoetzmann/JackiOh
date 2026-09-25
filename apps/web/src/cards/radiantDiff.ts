// What a Radiant face prints that its base face does not (SPEC §10.10, R277).
//
// The catalog carries each Radiant face's whole text (`radiant.text`, §8's Radiant cell read by its
// Conventions and written out), so a face prints it as it stands and marks the words and numbers
// in it that the base face's text does not have: #44 True Strike's "Deal 9 damage to a target,
// ignoring Armor; exile this" marks the 9 and nothing else. A word the Radiant face drops is simply
// absent, since the face prints the Radiant text alone.
//
// The mark is a word-level diff of the two public catalog texts — a longest common subsequence over
// their tokens — so it is the same wherever the face is drawn, and it is presentation only: nothing
// reads it but the renderer (CLAUDE.md rule 7). Tokens are compared without regard to case, so
// #17's "Bounce all units" becoming "bounce all units" inside a longer sentence marks nothing.
//
// A token is a run of anything but spaces and the separators `, ; : . ( )`, which are tokens of
// their own: "Fib(cost+3)" is `Fib`, `(`, `cost+3`, `)`, so only the `cost+3` is marked, and
// "−10/−10)" leaves its bracket unmarked. A marked range runs from the first marked word to the
// last of a stretch, over the spaces and separators between them, but never starts or ends on a
// separator, so the underline reads as one phrase ("and the units adjacent to it on its side").
//
// A fused definition's texts are its ingredients' texts one per line (R102); when both faces have
// the same number of lines, each Radiant line is diffed against the base line of the same
// ingredient, as each ingredient's own face is.

/** A stretch of a printed text, by UTF-16 offsets: `start` inclusive, `end` exclusive. */
export type TextRange = { readonly start: number; readonly end: number };

type Token = { text: string; start: number; end: number; word: boolean };

const SEPARATORS = ",;:.()";
/** A separator alone, or a run of anything that is neither a space nor a separator. */
const TOKEN = /[,;:.()]|[^\s,;:.()]+/g;
/** R102: a fused definition's text is its ingredients' texts, one per line. */
const LINE_BREAK = "\n";

function tokensOf(text: string, offset: number): Token[] {
  const tokens: Token[] = [];
  for (const match of text.matchAll(TOKEN)) {
    const start = offset + (match.index ?? 0);
    tokens.push({ text: match[0], start, end: start + match[0].length, word: !SEPARATORS.includes(match[0]) });
  }
  return tokens;
}

/** Which of `radiant`'s tokens are in a longest common subsequence with `base`'s, case aside. */
function commonTokens(base: readonly Token[], radiant: readonly Token[]): boolean[] {
  const a = base.map((token) => token.text.toLowerCase());
  const b = radiant.map((token) => token.text.toLowerCase());
  const rows = a.length + 1;
  const cols = b.length + 1;
  // lcs[i][j]: the LCS length of a[i..] and b[j..], filled from the end.
  const lcs: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    const row = lcs[i] ?? [];
    const next = lcs[i + 1] ?? [];
    for (let j = b.length - 1; j >= 0; j -= 1) {
      row[j] = a[i] === b[j] ? (next[j + 1] ?? 0) + 1 : Math.max(next[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  const kept = new Array<boolean>(b.length).fill(false);
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      kept[j] = true;
      i += 1;
      j += 1;
    } else if ((lcs[i + 1]?.[j] ?? 0) >= (lcs[i]?.[j + 1] ?? 0)) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return kept;
}

/** The marked stretches of one Radiant line against one base line. */
function lineMarks(base: string, radiant: string, offset: number): TextRange[] {
  const baseTokens = tokensOf(base, 0);
  const radiantTokens = tokensOf(radiant, offset);
  const kept = commonTokens(baseTokens, radiantTokens);
  const ranges: TextRange[] = [];
  let open: { start: number; end: number } | null = null;
  for (let at = 0; at < radiantTokens.length; at += 1) {
    const token = radiantTokens[at];
    if (token === undefined || !token.word) continue;
    // A separator, changed or kept, waits to see what follows it; a kept word closes the stretch.
    if (kept[at] === true) {
      if (open !== null) ranges.push(open);
      open = null;
    } else if (open === null) {
      open = { start: token.start, end: token.end };
    } else {
      open.end = token.end;
    }
  }
  if (open !== null) ranges.push(open);
  return ranges;
}

/**
 * R277: the stretches of `radiant` that `base` does not have, in order and never overlapping. A
 * Radiant text equal to its base marks nothing; an empty base marks every word of the Radiant text.
 */
export function radiantMarks(base: string, radiant: string): TextRange[] {
  const baseLines = base.split(LINE_BREAK);
  const radiantLines = radiant.split(LINE_BREAK);
  if (radiantLines.length > 1 && radiantLines.length === baseLines.length) {
    const ranges: TextRange[] = [];
    let offset = 0;
    radiantLines.forEach((line, at) => {
      ranges.push(...lineMarks(baseLines[at] ?? "", line, offset));
      offset += line.length + LINE_BREAK.length;
    });
    return ranges;
  }
  return lineMarks(base, radiant, 0);
}

/** The marked words themselves, for tests and accessible summaries. */
export function markedText(text: string, marks: readonly TextRange[]): string[] {
  return marks.map((range) => text.slice(range.start, range.end));
}
