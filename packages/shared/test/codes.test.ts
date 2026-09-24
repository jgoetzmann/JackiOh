/**
 * R191, docs/polish/5-sign-in.md B1-B4: the one shared reading of a typed or pasted code.
 *
 * The client's code field and the server's redemption both read a code through
 * `packages/shared/src/codes.ts`, so what is proved here holds on both sides. The table in
 * `fixtures/code-input-cases.ts` is shared with the server's parity suite
 * (`apps/server/test/api/code-input-parity.test.ts`) and the web's field suite, so a row changed
 * here changes what all three prove.
 *
 * The format comes from `apps/server/src/config.ts`, where every server number lives (CLAUDE.md
 * rule 9); nothing below restates its length, group size or input cap.
 */

import { describe, expect, it } from "vitest";

import {
  canonicalCode,
  excludedCharacters,
  findCodeInText,
  formatCodeCharacters,
  formattedCaret,
  isCodeSeparator,
  normalizeCodeText,
  readCodeInput,
  type CodeInputProblem,
} from "../src/index";
import {
  CODE_ALPHABET,
  CODE_INPUT_MAX_LENGTH,
  INVITE_CODE_FORMAT,
  ROOM_CODE_FORMAT,
} from "../../../apps/server/src/config";
import { CODE_INPUT_CASES, type CodeInputCase } from "./fixtures/code-input-cases";

const FORMAT = INVITE_CODE_FORMAT;

/** The table's base code, inside R104's alphabet. */
const BASE = "ABCDEFGHJKMNPQRS";
const BASE_FORMATTED = "ABCD-EFGH-JKMN-PQRS";

/** The problem a row expects, in the exact shape `CodeInputProblem` declares. */
function expectedProblem(row: CodeInputCase): CodeInputProblem | null {
  if (row.problem === null) return null;
  if (row.problem === "tooLong") return { kind: "tooLong" };
  return { kind: row.problem, character: row.character ?? "" };
}

/** `formatted` with the separators taken out: the characters the reading accepted. */
function charactersOf(formatted: string): string {
  return formatted.split(FORMAT.separator).join("");
}

// ---------------------------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------------------------

describe("R191 the shared code-input table (B1-B4)", () => {
  it("R191 B1 every canonical code in the table is a whole code of R104's alphabet", () => {
    const canonicals = CODE_INPUT_CASES.flatMap((row) => (row.canonical === null ? [] : [row.canonical]));
    expect(canonicals.length).toBeGreaterThan(0);
    for (const code of canonicals) {
      expect(code).toHaveLength(FORMAT.length);
      for (const character of code) expect(CODE_ALPHABET).toContain(character);
    }
    // The rows name their problems, so a row that reads as a code must not also claim one.
    for (const row of CODE_INPUT_CASES) {
      if (row.canonical !== null) expect(row.problem, row.name).toBeNull();
    }
  });

  for (const row of CODE_INPUT_CASES) {
    it(`R191 B1 canonicalCode reads: ${row.name}`, () => {
      expect(canonicalCode(row.input, FORMAT)).toBe(row.canonical);
    });

    it(`R191 B2 readCodeInput reports: ${row.name}`, () => {
      const reading = readCodeInput(row.input, FORMAT);

      expect(reading.formatted).toBe(row.formatted);
      expect(reading.characters).toBe(charactersOf(row.formatted));
      expect(reading.problem).toEqual(expectedProblem(row));
      // "problem === null && characters.length === length"
      expect(reading.complete).toBe(row.canonical !== null);
      expect(reading.characters.length).toBeLessThanOrEqual(FORMAT.length);
      expect(formatCodeCharacters(reading.characters, FORMAT)).toBe(reading.formatted);
    });

    it(`R191 B4 findCodeInText: ${row.name}`, () => {
      const found = findCodeInText(row.input, FORMAT);

      expect(found !== null).toBe(row.foundInText);
      if (row.canonical !== null) expect(found).toBe(row.canonical);
      // Whatever it finds is a whole code, never a fragment.
      if (found !== null) expect(canonicalCode(found, FORMAT)).toBe(found);
    });
  }
});

// ---------------------------------------------------------------------------------------------
// B1: separators, normalisation and the canonical reading
// ---------------------------------------------------------------------------------------------

/** Every separator `isCodeSeparator` names, one of each kind. */
const SEPARATORS: readonly (readonly [string, string])[] = [
  ["space", " "],
  ["tab", "\t"],
  ["line feed", "\n"],
  ["carriage return", "\r"],
  ["NBSP", " "],
  ["thin space", " "],
  ["ideographic space", "　"],
  ["hyphen-minus", "-"],
  ["hyphen", "‐"],
  ["non-breaking hyphen", "‑"],
  ["figure dash", "‒"],
  ["en dash", "–"],
  ["em dash", "—"],
  ["horizontal bar", "―"],
  ["minus sign", "−"],
  ["small em dash", "﹘"],
  ["small hyphen-minus", "﹣"],
  ["fullwidth hyphen-minus", "－"],
  ["soft hyphen", "­"],
  ["zero-width space", "​"],
  ["zero-width non-joiner", "‌"],
  ["zero-width joiner", "‍"],
  ["word joiner", "⁠"],
  ["BOM", "﻿"],
];

/** Characters next to the separators, in code-point order or in look, that are not separators. */
const NOT_SEPARATORS: readonly (readonly [string, string])[] = [
  ["underscore", "_"],
  ["full stop", "."],
  ["slash", "/"],
  ["plus", "+"],
  ["tilde", "~"],
  ["number sign", "#"],
  ["middle dot", "·"],
  ["double vertical line (after U+2015)", "‖"],
  ["left-to-right mark (after U+200D)", "‎"],
  ["function application (after U+2060)", "⁡"],
  ["letter A", "A"],
  ["digit 2", "2"],
  ["digit 0", "0"],
];

describe("R191 B1 isCodeSeparator", () => {
  it("R191 B1 treats every listed space, dash and invisible character as a separator", () => {
    for (const [name, character] of SEPARATORS) {
      expect(isCodeSeparator(character), name).toBe(true);
    }
  });

  it("R191 B1 treats nothing else as a separator", () => {
    for (const [name, character] of NOT_SEPARATORS) {
      expect(isCodeSeparator(character), name).toBe(false);
    }
  });
});

describe("R191 B1 normalizeCodeText", () => {
  it("R191 B1 upper-cases and removes every separator", () => {
    expect(normalizeCodeText(" ab-cd–ef​gh ")).toBe("ABCDEFGH");
  });

  it("R191 B1 applies NFKC first, so fullwidth forms and ligatures read as ASCII", () => {
    expect(normalizeCodeText("ａｂ－ＣＤ")).toBe("ABCD");
    // U+FB01 LATIN SMALL LIGATURE FI is "fi" under NFKC.
    expect(normalizeCodeText("ﬁ")).toBe("FI");
  });

  it("R191 B1 knows nothing of an alphabet: excluded and foreign characters stay", () => {
    expect(normalizeCodeText("o0-1i l#")).toBe("O01IL#");
  });

  it("R191 B1 keeps a character whose upper case is longer than one character", () => {
    // "ß".toUpperCase() is "SS"; kept as it was, it reads as foreign rather than as two S.
    expect(normalizeCodeText("aßb")).toBe("AßB");
  });
});

describe("R191 B1 canonicalCode", () => {
  it("R191 B1 reads its own output back unchanged", () => {
    for (const row of CODE_INPUT_CASES) {
      if (row.canonical === null) continue;
      expect(canonicalCode(row.canonical, FORMAT), row.name).toBe(row.canonical);
      expect(canonicalCode(formatCodeCharacters(row.canonical, FORMAT), FORMAT), row.name).toBe(
        row.canonical,
      );
    }
  });

  it("R191 B1 refuses a code one character short, however it is spelled", () => {
    const short = BASE.slice(0, FORMAT.length - 1);
    const spellings = [
      short,
      short.toLowerCase(),
      formatCodeCharacters(short, FORMAT),
      ` ${formatCodeCharacters(short, FORMAT).split(FORMAT.separator).join("–")} `,
    ];
    for (const spelling of spellings) {
      expect(canonicalCode(spelling, FORMAT), spelling).toBeNull();
      expect(readCodeInput(spelling, FORMAT).complete, spelling).toBe(false);
    }
  });

  it("R191 B1 answers null for an empty input and for separators alone", () => {
    expect(canonicalCode("", FORMAT)).toBeNull();
    expect(canonicalCode(" -–​ ", FORMAT)).toBeNull();
  });

  it("R191 B1 reads a room code with the same rules and its own length", () => {
    expect(canonicalCode(" ab-c2 34 ", ROOM_CODE_FORMAT)).toBe("ABC234");
    expect(readCodeInput("abc234", ROOM_CODE_FORMAT).formatted).toBe("ABC234");
    expect(canonicalCode("ABC23", ROOM_CODE_FORMAT)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// B2: never drop, never map; stop at the first problem and name it
// ---------------------------------------------------------------------------------------------

describe("R191 B2 excluded and foreign characters", () => {
  it("R191 B2 excludes exactly 0, 1, I and O from R104's alphabet", () => {
    expect(excludedCharacters(INVITE_CODE_FORMAT)).toEqual(["0", "1", "I", "O"]);
    expect(excludedCharacters(ROOM_CODE_FORMAT)).toEqual(["0", "1", "I", "O"]);
  });

  it("R191 B2 names each excluded character, typed in either case, after the characters before it", () => {
    const prefix = BASE_FORMATTED.slice(0, FORMAT.groupSize + FORMAT.separator.length);
    for (const excluded of excludedCharacters(FORMAT)) {
      for (const typed of new Set([excluded, excluded.toLowerCase()])) {
        const reading = readCodeInput(`${prefix}${typed}`, FORMAT);
        expect(reading.problem, typed).toEqual({ kind: "excluded", character: excluded });
        expect(reading.characters, typed).toBe(BASE.slice(0, FORMAT.groupSize));
        expect(reading.formatted, typed).toBe(BASE.slice(0, FORMAT.groupSize));
        expect(reading.complete, typed).toBe(false);
        expect(canonicalCode(`${prefix}${typed}`, FORMAT), typed).toBeNull();
      }
    }
  });

  it("R191 B2 stops at the first problem and reports that one", () => {
    expect(readCodeInput("AB0O1I", FORMAT).problem).toEqual({ kind: "excluded", character: "0" });
    expect(readCodeInput("AB#0", FORMAT).problem).toEqual({ kind: "foreign", character: "#" });
    expect(readCodeInput("AB0#", FORMAT).problem).toEqual({ kind: "excluded", character: "0" });
  });

  it("R191 B2 never drops an excluded character to complete a code", () => {
    // Dropping the 0 would leave exactly the base code: the bug the old field had.
    const input = `${BASE_FORMATTED.slice(0, 7)}0${BASE_FORMATTED.slice(7)}`;
    expect(canonicalCode(input, FORMAT)).toBeNull();
    expect(readCodeInput(input, FORMAT).complete).toBe(false);
  });

  it("R191 B2 refuses each excluded character in every position of a code", () => {
    for (const excluded of excludedCharacters(FORMAT)) {
      for (let position = 0; position < FORMAT.length; position += 1) {
        const input = `${BASE.slice(0, position)}${excluded}${BASE.slice(position + 1)}`;
        const reading = readCodeInput(input, FORMAT);
        const where = `${excluded} at ${String(position)}`;

        expect(canonicalCode(input, FORMAT), where).toBeNull();
        expect(reading.problem, where).toEqual({ kind: "excluded", character: excluded });
        expect(reading.characters, where).toBe(BASE.slice(0, position));
      }
    }
  });

  it("R191 B2 reads an empty input as incomplete with no problem", () => {
    const reading = readCodeInput("", FORMAT);
    expect(reading).toEqual({ characters: "", formatted: "", complete: false, problem: null });
  });
});

describe("R191 B2 formatCodeCharacters", () => {
  it("R191 B2 groups characters with the format's separator and never ends on one", () => {
    const group = FORMAT.groupSize;
    expect(formatCodeCharacters("", FORMAT)).toBe("");
    expect(formatCodeCharacters(BASE.slice(0, 1), FORMAT)).toBe(BASE.slice(0, 1));
    expect(formatCodeCharacters(BASE.slice(0, group), FORMAT)).toBe(BASE.slice(0, group));
    expect(formatCodeCharacters(BASE.slice(0, group + 1), FORMAT)).toBe(
      `${BASE.slice(0, group)}${FORMAT.separator}${BASE.slice(group, group + 1)}`,
    );
    expect(formatCodeCharacters(BASE, FORMAT)).toBe(BASE_FORMATTED);
    expect(formatCodeCharacters(BASE, FORMAT).endsWith(FORMAT.separator)).toBe(false);
  });

  it("R191 B2 formats a room code as one group", () => {
    expect(formatCodeCharacters("ABC234", ROOM_CODE_FORMAT)).toBe("ABC234");
  });
});

// ---------------------------------------------------------------------------------------------
// B3: length
// ---------------------------------------------------------------------------------------------

describe("R191 B3 length", () => {
  it("R191 B3 refuses raw input longer than CODE_INPUT_MAX_LENGTH without reading it", () => {
    // A real code, padded one character past the cap: it is never looked at.
    const padded = BASE_FORMATTED.padEnd(CODE_INPUT_MAX_LENGTH + 1, " ");
    const reading = readCodeInput(padded, FORMAT);

    expect(reading.problem).toEqual({ kind: "tooLong" });
    expect(reading.characters).toBe("");
    expect(reading.formatted).toBe("");
    expect(reading.complete).toBe(false);
    expect(canonicalCode(padded, FORMAT)).toBeNull();
  });

  it("R191 B3 reads raw input of exactly CODE_INPUT_MAX_LENGTH", () => {
    const padded = BASE_FORMATTED.padStart(CODE_INPUT_MAX_LENGTH, " ");
    expect(padded).toHaveLength(CODE_INPUT_MAX_LENGTH);
    expect(canonicalCode(padded, FORMAT)).toBe(BASE);
    expect(readCodeInput(padded, FORMAT).problem).toBeNull();
  });

  it("R191 B3 measures the raw input, so separators past the cap still make it tooLong", () => {
    const reading = readCodeInput(" ".repeat(CODE_INPUT_MAX_LENGTH + 1), FORMAT);
    expect(reading.problem).toEqual({ kind: "tooLong" });
    expect(reading.characters).toBe("");
  });

  it("R191 B3 refuses a very long input the same way", () => {
    const huge = BASE.repeat(CODE_INPUT_MAX_LENGTH * CODE_INPUT_MAX_LENGTH);
    expect(readCodeInput(huge, FORMAT)).toEqual({
      characters: "",
      formatted: "",
      complete: false,
      problem: { kind: "tooLong" },
    });
    expect(canonicalCode(huge, FORMAT)).toBeNull();
  });

  it("R191 B3 reads a 17th alphabet character as tooLong, keeping the first 16", () => {
    const seventeen = `${BASE}${CODE_ALPHABET.slice(0, 1)}`;
    const reading = readCodeInput(seventeen, FORMAT);

    expect(reading.problem).toEqual({ kind: "tooLong" });
    expect(reading.characters).toBe(BASE);
    expect(reading.formatted).toBe(BASE_FORMATTED);
    expect(reading.complete).toBe(false);
    expect(canonicalCode(seventeen, FORMAT)).toBeNull();
  });

  it("R191 B3 counts a 15-character input as incomplete, not as a problem", () => {
    const reading = readCodeInput(BASE.slice(0, FORMAT.length - 1), FORMAT);
    expect(reading.problem).toBeNull();
    expect(reading.complete).toBe(false);
    expect(reading.characters).toHaveLength(FORMAT.length - 1);
  });
});

// ---------------------------------------------------------------------------------------------
// B4: a code inside pasted text
// ---------------------------------------------------------------------------------------------

describe("R191 B4 findCodeInText", () => {
  it("R191 B4 finds the one grouped code in an invite sentence", () => {
    expect(findCodeInText("Your invite: abcd-efgh-jkmn-pqrs.", FORMAT)).toBe(BASE);
  });

  it("R191 B4 finds a code whose groups are joined by Unicode dashes or line breaks", () => {
    expect(findCodeInText("Invite → ABCD–EFGH–JKMN–PQRS", FORMAT)).toBe(BASE);
    expect(findCodeInText("Your code:\nABCD-EFGH\nJKMN-PQRS\n", FORMAT)).toBe(BASE);
  });

  it("R191 B4 finds a code written with no separators at all", () => {
    expect(findCodeInText("Here: ABCDEFGHJKMNPQRS!", FORMAT)).toBe(BASE);
  });

  it("R191 B4 finds one code written twice, in two spellings", () => {
    expect(findCodeInText("(ABCD-EFGH-JKMN-PQRS) (abcd efgh jkmn pqrs)", FORMAT)).toBe(BASE);
  });

  it("R191 B4 returns null for a text holding two different codes", () => {
    expect(findCodeInText("(ABCD-EFGH-JKMN-PQRS) (ABCD-EFGH-JKMN-PQRT)", FORMAT)).toBeNull();
  });

  it("R191 B4 returns null for a text holding no code", () => {
    expect(findCodeInText("No code here.", FORMAT)).toBeNull();
    expect(findCodeInText("", FORMAT)).toBeNull();
  });

  it("R191 B4 returns null for a code with an excluded character in it", () => {
    expect(findCodeInText("Your invite: ABCD-EFGH-JKMN-PQR0.", FORMAT)).toBeNull();
  });

  it("R191 B4 returns null for groups glued to other letters or digits", () => {
    expect(findCodeInText("XABCD-EFGH-JKMN-PQRS", FORMAT)).toBeNull();
    expect(findCodeInText("ABCD-EFGH-JKMN-PQRS2", FORMAT)).toBeNull();
  });

  it("R191 B4 never completes a code by upper-casing sharp s to SS", () => {
    expect(findCodeInText("Code: ABCD-EFGH-JKMN-PQß.", FORMAT)).toBeNull();
  });

  it("R191 B4 reads a four-letter word beside a code as a word, not as a group", () => {
    for (const text of [
      "Here ABCD-EFGH-JKMN-PQRS",
      "Take ABCD-EFGH-JKMN-PQRS",
      "HERE ABCD-EFGH-JKMN-PQRS",
      "Your invite code:\nABCD-EFGH-JKMN-PQRS\nHave fun!",
      "ABCD-EFGH-JKMN-PQRS\n\nBest,\nJack",
      "ABCD-EFGH-JKMN-PQRS\n— Mark",
      "ABCD-EFGH-JKMN-PQRS - see you at the tavern, Jack",
      "Here aBcD-eFgH-jKmN-pQrS",
    ]) {
      expect(findCodeInText(text, FORMAT), JSON.stringify(text)).toBe(BASE);
    }
  });

  it("R191 B4 never cuts a pasted code with an extra group joined on down to a code the player never had", () => {
    for (const text of [
      "ABCD-EFGH-JKMN-PQRS-T",
      "abcd efgh jkmn pqrs t",
      "X-ABCD-EFGH-JKMN-PQRS",
      "ABCD-EFGH-JKMN-PQRS-0",
    ]) {
      // The server reads each of these as malformed; the paste handler must not disagree.
      expect(canonicalCode(text, FORMAT), JSON.stringify(text)).toBeNull();
      expect(findCodeInText(text, FORMAT), JSON.stringify(text)).toBeNull();
    }
  });

  it("R191 B4 returns null for two codes on one line, and the code for one code written twice", () => {
    expect(findCodeInText("ABCD-EFGH-JKMN-PQRS ABCD-EFGH-JKMN-PQRT", FORMAT)).toBeNull();
    expect(findCodeInText("ABCD-EFGH-JKMN-PQRS ABCD-EFGH-JKMN-PQRS", FORMAT)).toBe(BASE);
  });

  it("R191 B4 finds a code whose first letter a phone keyboard capitalised, inside a message", () => {
    for (const text of [
      "Abcd-efgh-jkmn-pqrs is your code",
      "Here it is: Abcd-efgh-jkmn-pqrs",
      "Abcd efgh jkmn pqrs",
      "Your code is Abcd-efgh-jkmn-pqrs, have fun",
    ]) {
      expect(findCodeInText(text, FORMAT), JSON.stringify(text)).toBe(BASE);
    }
  });

  it("R191 B4 the sentence-case reading only adds a code where the strict one found none", () => {
    // The strict reading already finds exactly this code beside a capitalised word; the looser one
    // must not glue "Here" onto it and lose it.
    expect(findCodeInText("Here abcd efgh jkmn pqrs", FORMAT)).toBe(BASE);
    // Two codes stay ambiguous under either reading.
    expect(findCodeInText("Abcd-efgh-jkmn-pqrs or Abcd-efgh-jkmn-pqrt", FORMAT)).toBeNull();
    // An extra group joined on is still one character too long.
    expect(findCodeInText("Abcd-efgh-jkmn-pqrs-t is it", FORMAT)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// B16: where the caret goes after n characters. The code field puts it back here after every
// accepted change, so typing never lands the caret on the wrong side of a drawn separator.
// ---------------------------------------------------------------------------------------------

describe("R191 B16 formattedCaret", () => {
  it("R191 B16 follows the Surface formula n + floor((n - 1) / groupSize) for every n", () => {
    for (let n = 0; n <= FORMAT.length; n += 1) {
      const expected = n + (n > 0 ? Math.floor((n - 1) / FORMAT.groupSize) : 0);
      expect(formattedCaret(n, FORMAT), `n = ${String(n)}`).toBe(expected);
    }
  });

  it("R191 B16 is the end of the formatted value, so it never sits after a trailing separator", () => {
    for (let n = 0; n <= FORMAT.length; n += 1) {
      const formatted = formatCodeCharacters(BASE.slice(0, n), FORMAT);
      expect(formattedCaret(n, FORMAT), `n = ${String(n)}`).toBe(formatted.length);
    }
  });

  it("R191 B16 stays inside a group at its edge: after a whole group it precedes the separator", () => {
    const group = FORMAT.groupSize;
    const formatted = BASE_FORMATTED;
    expect(formatted.charAt(formattedCaret(group, FORMAT))).toBe(FORMAT.separator);
    expect(formatted.charAt(formattedCaret(group + 1, FORMAT) - 1)).toBe(BASE.charAt(group));
  });

  it("R191 B16 counts no separators for a room code, which is one group", () => {
    for (let n = 0; n <= ROOM_CODE_FORMAT.length; n += 1) {
      expect(formattedCaret(n, ROOM_CODE_FORMAT)).toBe(n);
    }
  });
});
