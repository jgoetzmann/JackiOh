/**
 * How a typed or pasted code is read (SPEC §11 R191, which extends R104).
 *
 * The client's code field and the server's redemption read a code through these functions and
 * nothing else, so the two can never disagree about what a player typed. The shape of a code (its
 * alphabet, length and grouping) is not stated here: it lives in `apps/server/src/config.ts`
 * (`INVITE_CODE_FORMAT`, `ROOM_CODE_FORMAT`, CLAUDE.md rule 9) and is passed in as a `CodeFormat`.
 *
 * The reading is:
 *  1. Input longer than `maxInputLength` is refused unread, so config bounds the work a caller can
 *     make a redemption do.
 *  2. Unicode compatibility normalisation (NFKC), which folds fullwidth forms and ligatures.
 *  3. Upper case one code point at a time. A code point whose upper case is more than one character
 *     ("ß" becomes "SS") is kept as it was, so it reads as foreign instead of growing the code.
 *  4. Every separator removed: whitespace, ASCII and Unicode dashes, the soft hyphen and the
 *     invisible joiners that mail and chat clients insert.
 *  5. What remains is walked against the alphabet, stopping at the first character that is not in
 *     it. Nothing is ever dropped, mapped or guessed at: R104's alphabet leaves out both halves of
 *     each look-alike pair (0 and O, 1 and I), so there is nothing to map to, and dropping a
 *     character shifts every later one and turns a typo into a different code.
 */

/** The shape of a code. The values live in apps/server/src/config.ts (CLAUDE.md rule 9). */
export type CodeFormat = {
  readonly alphabet: string;
  readonly length: number;
  readonly groupSize: number;
  readonly separator: string;
  /** Longer raw input reads as `tooLong` without being read. */
  readonly maxInputLength: number;
};

export type CodeInputProblem =
  /** An ASCII letter or digit outside the alphabet after upper-casing: R104's 0, 1, I, O. */
  | { readonly kind: "excluded"; readonly character: string }
  /** Any other character that is neither in the alphabet nor a separator. */
  | { readonly kind: "foreign"; readonly character: string }
  /** More than `length` alphabet characters, or raw input longer than `maxInputLength`. */
  | { readonly kind: "tooLong" };

export type CodeInputReading = {
  /** The alphabet characters accepted, in order, stopping at the first problem; at most `length`. */
  readonly characters: string;
  /** `characters` in groups of `groupSize` joined by `separator`, with no trailing separator. */
  readonly formatted: string;
  /** problem === null && characters.length === length */
  readonly complete: boolean;
  readonly problem: CodeInputProblem | null;
};

/**
 * The separator set as a regular-expression character class: `\s` (which covers NBSP, U+3000 and
 * U+FEFF), the ASCII hyphen-minus, U+2010 to U+2015 (hyphens, figure dash, en and em dash, the
 * horizontal bar), U+2212 minus, U+FE58 and U+FE63 (small em dash and small hyphen-minus), U+FF0D
 * (fullwidth hyphen-minus), U+00AD (soft hyphen), U+200B to U+200D (zero-width space and joiners),
 * U+2060 (word joiner) and U+FEFF (the zero-width no-break space).
 */
const SEPARATOR_CLASS =
  "[\\s\\-\\u2010-\\u2015\\u2212\\uFE58\\uFE63\\uFF0D\\u00AD\\u200B-\\u200D\\u2060\\uFEFF]";
const SEPARATOR = new RegExp(`^${SEPARATOR_CLASS}$`, "u");

/** An ASCII letter or digit, after upper-casing. */
const ASCII_LETTER_OR_DIGIT = /^[0-9A-Z]$/u;
const ASCII_LETTERS_AND_DIGITS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/** True for exactly one separator code point, and for nothing else. */
export function isCodeSeparator(character: string): boolean {
  return SEPARATOR.test(character);
}

/**
 * NFKC, then each code point upper-cased on its own. A code point whose upper case is more than one
 * character is kept as it was. Separators are kept here; `normalizeCodeText` drops them.
 */
function upperCodePoints(raw: string): string[] {
  const out: string[] = [];
  for (const character of raw.normalize("NFKC")) {
    const upper = character.toUpperCase();
    out.push(Array.from(upper).length === 1 ? upper : character);
  }
  return out;
}

/**
 * NFKC, then each code point upper-cased on its own (one that upper-cases to more than one
 * character, such as "ß", is kept as it was so it reads as foreign), then separators removed.
 * Knows nothing of an alphabet.
 */
export function normalizeCodeText(raw: string): string {
  return upperCodePoints(raw)
    .filter((character) => !isCodeSeparator(character))
    .join("");
}

export function formatCodeCharacters(characters: string, format: CodeFormat): string {
  const size = Math.max(1, format.groupSize);
  const groups: string[] = [];
  for (let start = 0; start < characters.length; start += size) {
    groups.push(characters.slice(start, start + size));
  }
  return groups.join(format.separator);
}

function readingOf(
  characters: string,
  problem: CodeInputProblem | null,
  format: CodeFormat,
): CodeInputReading {
  return {
    characters,
    formatted: formatCodeCharacters(characters, format),
    complete: problem === null && characters.length === format.length,
    problem,
  };
}

/**
 * Refuses raw.length > maxInputLength without reading it. Otherwise it walks normalizeCodeText(raw)
 * and stops at the first excluded, foreign or tooLong character. Never drops or maps a character.
 */
export function readCodeInput(raw: string, format: CodeFormat): CodeInputReading {
  if (raw.length > format.maxInputLength) return readingOf("", { kind: "tooLong" }, format);

  let characters = "";
  for (const character of normalizeCodeText(raw)) {
    if (format.alphabet.includes(character)) {
      if (characters.length >= format.length) {
        return readingOf(characters, { kind: "tooLong" }, format);
      }
      characters += character;
      continue;
    }
    const problem: CodeInputProblem = ASCII_LETTER_OR_DIGIT.test(character)
      ? { kind: "excluded", character }
      : { kind: "foreign", character };
    return readingOf(characters, problem, format);
  }
  return readingOf(characters, null, format);
}

/** readCodeInput(raw, format).complete ? characters : null */
export function canonicalCode(raw: string, format: CodeFormat): string | null {
  const reading = readCodeInput(raw, format);
  return reading.complete ? reading.characters : null;
}

/**
 * Caret index in `formatted` after `characterCount` characters:
 * n + (n > 0 ? Math.floor((n - 1) / groupSize) : 0).
 */
export function formattedCaret(characterCount: number, format: CodeFormat): number {
  const n = characterCount;
  return n + (n > 0 ? Math.floor((n - 1) / Math.max(1, format.groupSize)) : 0);
}

/**
 * Which letters a word of pasted text is written in; digits have no case. "sentence" is a first
 * letter in upper case and every later letter in lower case ("Abcd"), which a phone keyboard makes
 * of the first word of a message.
 */
type LetterCase = "upper" | "lower" | "sentence" | "mixed" | "none";

/** One run of ASCII letters and digits (after upper-casing) in pasted text. */
type Word = { readonly characters: string; readonly letterCase: LetterCase };

/**
 * Words that sit next to each other in pasted text, each pair joined by separators only (`joins[i]`
 * joins `words[i]` and `words[i + 1]`), in the same case. Anything else between two words (a colon,
 * a full stop, a bracket, a letter outside ASCII) ends a chain, and so does a change of case: an
 * invite writes its code in one case, and "Here" or "Jack" beside it does not.
 */
type Chain = { readonly words: Word[]; readonly joins: string[] };

function letterCaseOf(original: string): LetterCase {
  let upper = false;
  let lower = false;
  /** Only the first letter is upper case, so far. */
  let sentence = true;
  let letters = 0;
  for (const character of original) {
    const isUpper = character !== character.toLowerCase();
    const isLower = !isUpper && character !== character.toUpperCase();
    if (!isUpper && !isLower) continue;
    if (isUpper) upper = true;
    else lower = true;
    if (letters === 0 ? !isUpper : isUpper) sentence = false;
    letters += 1;
  }
  if (upper && lower) return sentence ? "sentence" : "mixed";
  if (upper) return "upper";
  if (lower) return "lower";
  return "none";
}

/**
 * Whether two neighbouring words can belong to one code. Strict, the first reading: the same case.
 * Loose, the second reading `findCodeInText` falls back on when the strict one found nothing: a
 * sentence-case word counts as lower case, so "Abcd-efgh-jkmn-pqrs is your code", typed by hand on
 * a phone that capitalised the first letter, still holds its code.
 */
function sameCase(a: LetterCase, b: LetterCase, loose: boolean): boolean {
  const fold = (letterCase: LetterCase): LetterCase => (loose && letterCase === "sentence" ? "lower" : letterCase);
  const x = fold(a);
  const y = fold(b);
  return x === "none" || y === "none" || x === y;
}

function chainsIn(text: string, loose: boolean): Chain[] {
  const chains: Chain[] = [];
  let words: Word[] = [];
  let joins: string[] = [];
  let original = "";
  let characters = "";
  /** The separators since the last word, or null when something else came between. (Cast, so the
   *  checker does not narrow it to `null`: `endWord` sets it.) */
  let join = null as string | null;

  const endWord = (): void => {
    if (characters.length === 0) return;
    const word: Word = { characters, letterCase: letterCaseOf(original) };
    const last = words[words.length - 1];
    if (last !== undefined && join !== null && sameCase(last.letterCase, word.letterCase, loose)) {
      joins.push(join);
      words.push(word);
    } else {
      if (words.length > 0) chains.push({ words, joins });
      words = [word];
      joins = [];
    }
    original = "";
    characters = "";
    join = "";
  };

  for (const character of text.normalize("NFKC")) {
    const upper = character.toUpperCase();
    const read = Array.from(upper).length === 1 ? upper : character;
    if (ASCII_LETTER_OR_DIGIT.test(read)) {
      original += character;
      characters += read;
      continue;
    }
    endWord();
    if (isCodeSeparator(character)) {
      if (join !== null) join += character;
    } else {
      join = null;
    }
  }
  endWord();
  if (words.length > 0) chains.push({ words, joins });
  return chains;
}

/**
 * Whether a word could be part of a code, and so must not be cut away from one beside it: a stray
 * single character (a 17th key, even an excluded one), or a run of alphabet characters as long as a
 * group or shorter (a group, or part of one), or several whole groups run together. Anything else
 * is prose: a word holding a character the alphabet leaves out ("is", "code", "your"), or one whose
 * length no run of groups has ("thanks", "invite").
 */
function couldBelongToCode(word: Word, format: CodeFormat): boolean {
  const length = word.characters.length;
  if (length <= 1) return true;
  for (const character of word.characters) {
    if (!format.alphabet.includes(character)) return false;
  }
  const size = Math.max(1, format.groupSize);
  return length <= size || length % size === 0;
}

/**
 * The codes one chain holds. A chain that reads as exactly one code as a whole is that code,
 * however its groups are joined. Otherwise a code inside a longer chain counts only when its own
 * groups are joined one way and neither word beside it could be read as more of it: a neighbour
 * joined to it some other way ("HERE ABCD-EFGH-JKMN-PQRS") is not, and neither is one joined the
 * same way that no code could hold ("my code is abcd efgh jkmn pqrs thanks": "is" holds an I, and
 * "thanks" is six letters long). But in "ABCD-EFGH-JKMN-PQRS-T", "X-ABCD-EFGH-JKMN-PQRS" or
 * "abcd efgh jkmn pqrs tuvw" the extra word is joined exactly as the groups are and could be part
 * of a code, so the whole reads as one code too long (the server's reading, R145's identical error),
 * and the field must not quietly cut it down to a code the player never had.
 */
function codesInChain(chain: Chain, format: CodeFormat): string[] {
  let text = "";
  chain.words.forEach((word, index) => {
    text += (index === 0 ? "" : (chain.joins[index - 1] ?? "")) + word.characters;
  });
  const whole = canonicalCode(text, format);
  if (whole !== null) return [whole];

  const size = Math.max(1, format.groupSize);
  const found: string[] = [];
  const count = chain.words.length;
  for (let start = 0; start < count; start += 1) {
    const internal = chain.joins[start];
    let characters = "";
    for (let end = start; end < count; end += 1) {
      if (end > start) {
        // One way of joining groups, and only ever between whole groups.
        if (chain.joins[end - 1] !== internal || characters.length % size !== 0) break;
      }
      characters += chain.words[end]?.characters ?? "";
      if (characters.length < format.length) continue;
      if (characters.length === format.length && end > start) {
        const leftWord = chain.words[start - 1];
        const rightWord = chain.words[end + 1];
        const leftBlocks =
          leftWord !== undefined && chain.joins[start - 1] === internal && couldBelongToCode(leftWord, format);
        const rightBlocks =
          rightWord !== undefined && chain.joins[end] === internal && couldBelongToCode(rightWord, format);
        const code = !leftBlocks && !rightBlocks ? canonicalCode(characters, format) : null;
        if (code !== null) found.push(code);
      }
      break;
    }
  }
  return found;
}

/** The distinct codes the text's chains hold, stopping once there are two. */
function codesInText(text: string, format: CodeFormat, loose: boolean): Set<string> {
  const found = new Set<string>();
  for (const chain of chainsIn(text, loose)) {
    for (const code of codesInChain(chain, format)) {
      found.add(code);
      if (found.size > 1) return found;
    }
  }
  return found;
}

/**
 * If canonicalCode(text) is non-null, returns it. Otherwise it reads the text as chains of words
 * (see `Chain`) and returns the code only if exactly one distinct code is found in them. Two
 * different codes, a code with an extra group joined on, or no code at all is null, and the paste
 * then goes through to the field's own reading.
 *
 * Only when the strict reading finds nothing at all is the text read again with a sentence-case
 * word joining lower-case ones (`sameCase`), so the looser reading can add a code but never change
 * what the strict one found.
 */
export function findCodeInText(text: string, format: CodeFormat): string | null {
  const direct = canonicalCode(text, format);
  if (direct !== null) return direct;

  let found = codesInText(text, format, false);
  if (found.size === 0) found = codesInText(text, format, true);
  if (found.size !== 1) return null;
  const [only] = [...found];
  return only ?? null;
}

/** ASCII [0-9A-Z] minus the alphabet, sorted: ["0", "1", "I", "O"] for R104. */
export function excludedCharacters(format: CodeFormat): readonly string[] {
  return Array.from(ASCII_LETTERS_AND_DIGITS)
    .filter((character) => !format.alphabet.includes(character))
    .sort();
}
