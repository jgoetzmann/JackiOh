/**
 * The one table of typed and pasted invite codes that the client and the server must read the same
 * way (R191, docs/polish/5-sign-in.md B1-B5 and B17).
 *
 * Three suites read it:
 *   - packages/shared/test/codes.test.ts runs `canonicalCode`, `readCodeInput` and
 *     `findCodeInText` over every row;
 *   - apps/server/test/api/code-input-parity.test.ts redeems every row's `input` through the real
 *     router against a code minted as the row's `canonical`;
 *   - apps/web/src/auth/CodeField.test.tsx types and pastes the rows into the code field.
 *
 * Every column is what the shared reading gives for `INVITE_CODE_FORMAT`:
 *   - `canonical` is `canonicalCode(input)`: the code the server redeems, or null for a malformed
 *     input (R145's identical error);
 *   - `formatted` is `readCodeInput(input).formatted`: the characters accepted before the first
 *     problem, grouped;
 *   - `problem` and `character` are `readCodeInput(input).problem`;
 *   - `foundInText` is `findCodeInText(input) !== null`. Every row whose `foundInText` is true but
 *     whose `canonical` is null finds the table's base code, `ABCD-EFGH-JKMN-PQRS`.
 *
 * Every canonical code is built from R104's alphabet ("23456789ABCDEFGHJKLMNPQRSTUVWXYZ"), which
 * leaves out 0, 1, I and O. The base code is `ABCDEFGHJKMNPQRS`; the one row about `l` uses
 * `ABCDEFGHJKLMNPQR`, because the base code has no L in it.
 *
 * Plain TypeScript with no Node or DOM API, so the web project can import it by relative path.
 */

import type { CodeInputProblem } from "../../src/codes.ts";
import { CODE_INPUT_MAX_LENGTH } from "../../../../apps/server/src/config.ts";

export type CodeInputCase = {
  readonly name: string;
  readonly input: string;
  /** canonicalCode(input, INVITE_CODE_FORMAT). The server must redeem a code minted as this. */
  readonly canonical: string | null;
  /** readCodeInput(input, INVITE_CODE_FORMAT).formatted */
  readonly formatted: string;
  readonly problem: CodeInputProblem["kind"] | null;
  /** The character an excluded or foreign problem names. */
  readonly character?: string;
  /** findCodeInText(input, INVITE_CODE_FORMAT) !== null: the paste handler fills the field. */
  readonly foundInText: boolean;
};

/** The table's base code, all of it inside R104's alphabet. */
const BASE = "ABCDEFGHJKMNPQRS";
const BASE_FORMATTED = "ABCD-EFGH-JKMN-PQRS";

/** The one code with an L in it, for the row that types a lowercase `l`. */
const WITH_L = "ABCDEFGHJKLMNPQR";
const WITH_L_FORMATTED = "ABCD-EFGH-JKLM-NPQR";

/** Printable ASCII moved to its fullwidth form (U+FF01-U+FF5E), which NFKC maps back. */
const FULLWIDTH_OFFSET = 0xfee0;
function fullwidth(ascii: string): string {
  return [...ascii]
    .map((character) => String.fromCodePoint((character.codePointAt(0) ?? 0) + FULLWIDTH_OFFSET))
    .join("");
}

/** A row that reads as the base code, wherever it came from. */
function base(name: string, input: string): CodeInputCase {
  return { name, input, canonical: BASE, formatted: BASE_FORMATTED, problem: null, foundInText: true };
}

export const CODE_INPUT_CASES: readonly CodeInputCase[] = [
  // -------------------------------------------------------------------------------------------
  // Every spelling of one code reads as that code (B1).
  // -------------------------------------------------------------------------------------------
  base("canonical form", "ABCD-EFGH-JKMN-PQRS"),
  base("lower case", "abcd-efgh-jkmn-pqrs"),
  base("mixed case", "aBcD-eFgH-jKmN-pQrS"),
  base("no separators", "ABCDEFGHJKMNPQRS"),
  base("spaces as separators", "ABCD EFGH JKMN PQRS"),
  base("leading and trailing whitespace, tabs and newlines", " \t\nABCD-EFGH-JKMN-PQRS\r\n\t "),
  base("en and em dashes", "ABCD–EFGH—JKMN–PQRS"),
  base("hyphen, non-breaking hyphen, horizontal bar and minus sign", "ABCD‐EFGH‑JKMN―PQ−RS"),
  base("small and fullwidth dash forms", "ABCD﹘EFGH﹣JKMN－PQRS"),
  base("NBSP", "ABCD EFGH JKMN PQRS"),
  base("ideographic space", "ABCD　EFGH　JKMN　PQRS"),
  base("a zero-width space inside a group", "AB​CD-EFGH-JKMN-PQRS"),
  base(
    "BOM, soft hyphen, zero-width joiners and word joiner",
    "﻿ABCD­EFGH‌JKMN‍PQ⁠RS",
  ),
  base("the fullwidth form", fullwidth("ABCD-EFGH-JKMN-PQRS")),
  base("the fullwidth form in lower case", fullwidth("abcd-efgh-jkmn-pqrs")),
  base("mixed ' - ' separators", "ABCD - EFGH - JKMN - PQRS"),
  base("a padded paste longer than the old 19-character field", " abcd - efgh - jkmn - pqrs "),
  base("a separator between every character", "A-B-C-D-E-F-G-H-J-K-M-N-P-Q-R-S"),
  base("a code padded to exactly the input cap", BASE_FORMATTED.padEnd(CODE_INPUT_MAX_LENGTH, " ")),
  {
    name: "a lowercase l, read as L",
    input: "abcd-efgh-jklm-npqr",
    canonical: WITH_L,
    formatted: WITH_L_FORMATTED,
    problem: null,
    foundInText: true,
  },

  // -------------------------------------------------------------------------------------------
  // R104's excluded characters stop the reading and are named, never dropped or mapped (B2).
  // -------------------------------------------------------------------------------------------
  {
    name: "excluded 0",
    input: "ABCD-EF0H-JKMN-PQRS",
    canonical: null,
    formatted: "ABCD-EF",
    problem: "excluded",
    character: "0",
    foundInText: false,
  },
  {
    name: "excluded 1",
    input: "ABCD-1FGH-JKMN-PQRS",
    canonical: null,
    formatted: "ABCD",
    problem: "excluded",
    character: "1",
    foundInText: false,
  },
  {
    name: "excluded O",
    input: "ABCD-EFGH-OKMN-PQRS",
    canonical: null,
    formatted: "ABCD-EFGH",
    problem: "excluded",
    character: "O",
    foundInText: false,
  },
  {
    name: "excluded I",
    input: "IBCD-EFGH-JKMN-PQRS",
    canonical: null,
    formatted: "",
    problem: "excluded",
    character: "I",
    foundInText: false,
  },
  {
    name: "a lowercase o, excluded as O",
    input: "abcd-efgh-jkmn-pqro",
    canonical: null,
    formatted: "ABCD-EFGH-JKMN-PQR",
    problem: "excluded",
    character: "O",
    foundInText: false,
  },
  {
    name: "a lowercase i, excluded as I",
    input: "abcd-efgh-jkmi-pqrs",
    canonical: null,
    formatted: "ABCD-EFGH-JKM",
    problem: "excluded",
    character: "I",
    foundInText: false,
  },
  {
    name: "a fullwidth zero, excluded as 0",
    input: `ABCD-EFGH-JKMN-PQR${fullwidth("0")}`,
    canonical: null,
    formatted: "ABCD-EFGH-JKMN-PQR",
    problem: "excluded",
    character: "0",
    foundInText: false,
  },

  // -------------------------------------------------------------------------------------------
  // Anything else outside the alphabet is foreign (B2).
  // -------------------------------------------------------------------------------------------
  {
    name: "foreign #",
    input: "ABCD-EF#H-JKMN-PQRS",
    canonical: null,
    formatted: "ABCD-EF",
    problem: "foreign",
    character: "#",
    foundInText: false,
  },
  {
    name: "foreign dotted capital I",
    input: "ABCD-EFGH-JKMN-PQRİ",
    canonical: null,
    formatted: "ABCD-EFGH-JKMN-PQR",
    problem: "foreign",
    character: "İ",
    foundInText: false,
  },
  {
    // A homoglyph: it looks like A, and NFKC leaves it Cyrillic.
    name: "foreign Cyrillic capital A",
    input: "АBCD-EFGH-JKMN-PQRS",
    canonical: null,
    formatted: "",
    problem: "foreign",
    character: "А",
    foundInText: false,
  },
  {
    name: "foreign underscores used as separators",
    input: "ABCD_EFGH_JKMN_PQRS",
    canonical: null,
    formatted: "ABCD",
    problem: "foreign",
    character: "_",
    foundInText: false,
  },
  {
    name: "foreign full stops used as separators",
    input: "ABCD.EFGH.JKMN.PQRS",
    canonical: null,
    formatted: "ABCD",
    problem: "foreign",
    character: ".",
    foundInText: false,
  },
  {
    // Upper-casing the whole string would turn "PQß" into "PQSS" and complete a different code.
    name: "foreign sharp s, which never becomes SS",
    input: "ABCD-EFGH-JKMN-PQß",
    canonical: null,
    formatted: "ABCD-EFGH-JKMN-PQ",
    problem: "foreign",
    character: "ß",
    foundInText: false,
  },

  // -------------------------------------------------------------------------------------------
  // Length (B3).
  // -------------------------------------------------------------------------------------------
  {
    name: "15 characters: incomplete, with no problem",
    input: "ABCD-EFGH-JKMN-PQR",
    canonical: null,
    formatted: "ABCD-EFGH-JKMN-PQR",
    problem: null,
    foundInText: false,
  },
  {
    name: "17 characters: tooLong",
    input: "ABCD-EFGH-JKMN-PQRST",
    canonical: null,
    formatted: BASE_FORMATTED,
    problem: "tooLong",
    foundInText: false,
  },
  {
    // Read like any other input that holds no code: R145's identical error on the server, never
    // a request-shape refusal of its own.
    name: "the empty string",
    input: "",
    canonical: null,
    formatted: "",
    problem: null,
    foundInText: false,
  },
  {
    name: "input longer than the input cap: tooLong, unread",
    input: "A".repeat(CODE_INPUT_MAX_LENGTH + 1),
    canonical: null,
    formatted: "",
    problem: "tooLong",
    foundInText: false,
  },

  // -------------------------------------------------------------------------------------------
  // Codes inside pasted text (B4).
  // -------------------------------------------------------------------------------------------
  {
    // Found: BASE. Read as typed, it stops at the O of "Your".
    name: "an invite sentence",
    input: "Your invite: abcd-efgh-jkmn-pqrs.",
    canonical: null,
    formatted: "Y",
    problem: "excluded",
    character: "O",
    foundInText: true,
  },
  {
    name: "a text holding two different codes",
    input: "(ABCD-EFGH-JKMN-PQRS) (ABCD-EFGH-JKMN-PQRT)",
    canonical: null,
    formatted: "",
    problem: "foreign",
    character: "(",
    foundInText: false,
  },
  {
    name: "a text holding no code",
    input: "No code here.",
    canonical: null,
    formatted: "N",
    problem: "excluded",
    character: "O",
    foundInText: false,
  },
  {
    name: "a sentence whose code holds an excluded character",
    input: "Your invite: ABCD-EFGH-JKMN-PQR0.",
    canonical: null,
    formatted: "Y",
    problem: "excluded",
    character: "O",
    foundInText: false,
  },
  {
    // One letter too many, glued on: neither a code nor a bounded run of groups.
    name: "a code glued to another letter",
    input: "XABCD-EFGH-JKMN-PQRS",
    canonical: null,
    formatted: "XABC-DEFG-HJKM-NPQR",
    problem: "tooLong",
    foundInText: false,
  },

  // Four-letter words beside a code are words, not a fifth group: each is joined to the code
  // differently from the way its groups are joined, or written in another case.
  {
    name: "a leading word",
    input: "Here ABCD-EFGH-JKMN-PQRS",
    canonical: null,
    formatted: "HERE-ABCD-EFGH-JKMN",
    problem: "tooLong",
    foundInText: true,
  },
  {
    name: "a leading word in capitals",
    input: "HERE ABCD-EFGH-JKMN-PQRS",
    canonical: null,
    formatted: "HERE-ABCD-EFGH-JKMN",
    problem: "tooLong",
    foundInText: true,
  },
  {
    name: "a closing word on the next line",
    input: "Your invite code:\nABCD-EFGH-JKMN-PQRS\nHave fun!",
    canonical: null,
    formatted: "Y",
    problem: "excluded",
    character: "O",
    foundInText: true,
  },
  {
    name: "a four-letter signature",
    input: "ABCD-EFGH-JKMN-PQRS\n\nBest,\nJack",
    canonical: null,
    formatted: BASE_FORMATTED,
    problem: "tooLong",
    foundInText: true,
  },
  {
    name: "a signature after a dash",
    input: "ABCD-EFGH-JKMN-PQRS\n— Mark",
    canonical: null,
    formatted: BASE_FORMATTED,
    problem: "tooLong",
    foundInText: true,
  },

  // A whole chat message copied from its bubble, the code in lower case and spaced like the words
  // around it. A neighbour joined the way the groups are is still a word when no code could hold
  // it: "is", "code" and "your" hold an I or an O, and "thanks" is six letters long.
  {
    name: "a chat message ending in a lower-case code",
    input: "my invite code is abcd efgh jkmn pqrs",
    canonical: null,
    formatted: "MY",
    problem: "excluded",
    character: "I",
    foundInText: true,
  },
  {
    name: "a chat message with a greeting and a comma",
    input: "hey, my code is abcd efgh jkmn pqrs",
    canonical: null,
    formatted: "HEY",
    problem: "foreign",
    character: ",",
    foundInText: true,
  },
  {
    name: "a chat message in capitals",
    input: "MY CODE IS ABCD EFGH JKMN PQRS",
    canonical: null,
    formatted: "MYC",
    problem: "excluded",
    character: "O",
    foundInText: true,
  },
  {
    name: "your code is, then the code",
    input: "your code is abcd efgh jkmn pqrs",
    canonical: null,
    formatted: "Y",
    problem: "excluded",
    character: "O",
    foundInText: true,
  },
  {
    name: "a lower-case code with a word after it",
    input: "abcd efgh jkmn pqrs thanks",
    canonical: null,
    formatted: BASE_FORMATTED,
    problem: "tooLong",
    foundInText: true,
  },
  // A word that could itself be a group (or part of one), joined as the groups are, is read as
  // part of the code: which four of five groups were meant cannot be told, so nothing is found.
  {
    name: "a fifth group of four in lower case",
    input: "abcd efgh jkmn pqrs tuvw",
    canonical: null,
    formatted: BASE_FORMATTED,
    problem: "tooLong",
    foundInText: false,
  },
  {
    name: "a short word of code letters in front, spaced like the groups",
    input: "hey abcd efgh jkmn pqrs",
    canonical: null,
    formatted: "HEYA-BCDE-FGHJ-KMNP",
    problem: "tooLong",
    foundInText: false,
  },

  // An extra character joined on exactly as the groups are joined is part of what was pasted:
  // the whole is one character too long, and the field never cuts it down to 16.
  {
    name: "a fifth group of one character",
    input: "ABCD-EFGH-JKMN-PQRS-T",
    canonical: null,
    formatted: BASE_FORMATTED,
    problem: "tooLong",
    foundInText: false,
  },
  {
    name: "a 17th character after a space, in lower case",
    input: "abcd efgh jkmn pqrs t",
    canonical: null,
    formatted: BASE_FORMATTED,
    problem: "tooLong",
    foundInText: false,
  },
  {
    name: "a stray character joined on in front",
    input: "X-ABCD-EFGH-JKMN-PQRS",
    canonical: null,
    formatted: "XABC-DEFG-HJKM-NPQR",
    problem: "tooLong",
    foundInText: false,
  },
  {
    name: "an excluded 0 in a fifth group",
    input: "ABCD-EFGH-JKMN-PQRS-0",
    canonical: null,
    formatted: BASE_FORMATTED,
    problem: "excluded",
    character: "0",
    foundInText: false,
  },
];
