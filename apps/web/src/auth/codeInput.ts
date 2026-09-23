// The invite code's words: what the code screen says about a code while it is being typed.
//
// THE READING IS NOT THIS FILE'S. R191: client and server read a typed or pasted code through one
// shared function, `readCodeInput` in `@jackioh/shared`, so the field can never accept a code the
// server would call malformed, or refuse one it would redeem. This module only turns a reading
// into sentences. The shape of a code (alphabet, length, groups, separator) is config, imported
// from `apps/server/src/config.ts` the way the screen has always imported `CODE_ALPHABET`
// (CLAUDE.md rule 9); no number or character of the format is spelled here.
//
// R191 is also why the excluded-character sentence exists at all. R104's alphabet leaves out both
// halves of each look-alike pair (0 and O, 1 and I), so a typed `0` cannot be mapped to anything.
// The field refuses it and says which character it was, rather than dropping it and quietly
// turning a typo into a different code.

import { excludedCharacters, type CodeFormat, type CodeInputProblem, type CodeInputReading } from "@jackioh/shared";

import { INVITE_CODE_FORMAT } from "../../../server/src/config.ts";

export { INVITE_CODE_FORMAT } from "../../../server/src/config.ts";

/** §9.4's groups: `length / groupSize`, four for an invite code. */
export const INVITE_CODE_GROUPS = groupCount(INVITE_CODE_FORMAT);

/** `XXXX-XXXX-XXXX-XXXX`, built from the format so no literal spells it. */
export const INVITE_CODE_PLACEHOLDER = placeholderFor(INVITE_CODE_FORMAT);

/** How many groups a code of this format is drawn as. */
export function groupCount(format: CodeFormat): number {
  return Math.ceil(format.length / format.groupSize);
}

/** One `X` per character, grouped and separated the way a formatted code is. */
export function placeholderFor(format: CodeFormat): string {
  const groups: string[] = [];
  for (let at = 0; at < format.length; at += format.groupSize) {
    groups.push("X".repeat(Math.min(format.groupSize, format.length - at)));
  }
  return groups.join(format.separator);
}

/** "a, b, c or d" (or "… and d"): a list as a sentence names it. */
function listInWords(items: readonly string[], last: "or" | "and" = "or"): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} ${last} ${items[items.length - 1] ?? ""}`;
}

/** A character a reader cannot see (a control, format, separator or combining mark) as U+XXXX. */
function visibleCharacter(character: string): string {
  if (/^[\p{C}\p{Z}\p{M}]+$/u.test(character)) {
    const point = character.codePointAt(0) ?? 0;
    return `U+${point.toString(16).toUpperCase().padStart(4, "0")}`;
  }
  return character;
}

/** The alphabet's characters matching `pattern`, lowest and highest: "2" and "9" for R104's digits. */
function rangeOf(format: CodeFormat, pattern: RegExp): { lo: string; hi: string; missing: string[] } | null {
  const inAlphabet = [...format.alphabet].filter((character) => pattern.test(character)).sort();
  const lo = inAlphabet[0];
  const hi = inAlphabet[inAlphabet.length - 1];
  if (lo === undefined || hi === undefined) return null;
  // What the range leaves out between its ends: R104's I and O among the letters.
  const missing: string[] = [];
  for (let point = lo.charCodeAt(0); point <= hi.charCodeAt(0); point += 1) {
    const character = String.fromCharCode(point);
    if (!format.alphabet.includes(character)) missing.push(character);
  }
  return { lo, hi, missing };
}

/** "the letters A–Z except I and O, and the digits 2–9", built from the alphabet. */
function alphabetInWords(format: CodeFormat): string {
  const parts: string[] = [];
  const letters = rangeOf(format, /^[A-Z]$/);
  if (letters !== null) {
    const except = letters.missing.length === 0 ? "" : ` except ${listInWords(letters.missing, "and")}`;
    parts.push(`the letters ${letters.lo}–${letters.hi}${except}`);
  }
  const digits = rangeOf(format, /^[0-9]$/);
  if (digits !== null) {
    const except = digits.missing.length === 0 ? "" : ` except ${listInWords(digits.missing, "and")}`;
    parts.push(`the digits ${digits.lo}–${digits.hi}${except}`);
  }
  return parts.join(", and ");
}

/** A letter outside ASCII: most likely typed on a keyboard set to another script. */
function isNonLatinLetter(character: string): boolean {
  return /^\p{L}$/u.test(character) && !/^[A-Za-z]$/.test(character);
}

/** The sentence `code-field-hint` shows for a refused keystroke or paste. */
export function codeProblemMessage(problem: CodeInputProblem, format: CodeFormat = INVITE_CODE_FORMAT): string {
  switch (problem.kind) {
    case "excluded": {
      const never = listInWords(excludedCharacters(format));
      return `Invite codes never use ${never}, so “${visibleCharacter(problem.character)}” can’t be part of one. Check that character again.`;
    }
    case "foreign": {
      // Not "capital letters": a capital Ф is one, and a player on a Russian layout typed it.
      const keyboard = isNonLatinLetter(problem.character)
        ? " Check that your keyboard is set to Latin letters."
        : "";
      return `“${visibleCharacter(problem.character)}” isn’t used in invite codes. They use ${alphabetInWords(format)}.${keyboard}`;
    }
    case "tooLong":
      return `That’s longer than an invite code, which has ${String(format.length)} characters.`;
  }
}

/**
 * The refused paste, quoted after the hint so the player can see what they pasted: "You pasted
 * “ABCD-EFGH-JKMN-PQRST”." Trimmed, and cut at `maxInputLength` characters, the most the reading
 * would ever look at.
 */
export function pastedText(text: string, format: CodeFormat = INVITE_CODE_FORMAT): string {
  const trimmed = text.trim();
  const shown = Array.from(trimmed);
  const quoted = shown.length > format.maxInputLength ? `${shown.slice(0, format.maxInputLength).join("")}…` : trimmed;
  return `You pasted “${quoted}”.`;
}

/** `code-field-progress`: "12 of 16 characters". */
export function codeProgressText(reading: CodeInputReading, format: CodeFormat = INVITE_CODE_FORMAT): string {
  return `${String(reading.characters.length)} of ${String(format.length)} characters`;
}

/** Unit conversions, not configuration. */
const MS_PER_MINUTE = 60_000;
const MINUTES_PER_HOUR = 60;

/**
 * A stated wait in words: whole minutes rounded up under an hour ("about a minute", "about 12
 * minutes"), and hours from an hour on ("about an hour", "about 2 hours"), never "about 60 minutes".
 */
export function waitInWords(retryAfterMs: number): string {
  const minutes = Math.ceil(Math.max(0, retryAfterMs) / MS_PER_MINUTE);
  if (minutes <= 1) return "about a minute";
  if (minutes < MINUTES_PER_HOUR) return `about ${String(minutes)} minutes`;
  const hours = Math.round(minutes / MINUTES_PER_HOUR);
  return hours <= 1 ? "about an hour" : `about ${String(hours)} hours`;
}

/**
 * `invite-attempts`: how many redemptions `GET /api/codes/status` says this account has left, and,
 * with none left, how long until one comes back (R192) when the server said.
 */
export function attemptsText(remaining: number, retryAfterMs: number | null = null): string {
  if (remaining <= 0) {
    return retryAfterMs === null || retryAfterMs <= 0
      ? "No tries left for now. Try again later."
      : `No tries left for now. You can try again in ${waitInWords(retryAfterMs)}.`;
  }
  if (remaining === 1) return "1 try left this hour";
  return `${String(remaining)} tries left this hour`;
}
