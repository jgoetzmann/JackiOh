// What the sign-in, sign-up and reset forms check before they send anything (B24, B31).
//
// UX, NOT RULES. The auth provider is the authority on what an address or a password may be, and
// it refuses on its own terms (`classifyProviderRefusal` turns that into a sentence). These checks
// only save a round trip and say what is wrong next to the field that is wrong. So they are
// deliberately loose: an address needs an `@` and a dot after it, and a new password only has to
// fit the provider's length window. Anything subtler is the provider's call.
//
// The length window is two named constants in `apps/server/src/config.ts` (CLAUDE.md rule 9),
// imported by relative path the way `invite.tsx` imports the code alphabet. Both are public.

import { AUTH_PASSWORD_MAX_LENGTH, AUTH_PASSWORD_MIN_LENGTH } from "../../../server/src/config.ts";

/** Loose on purpose: something, an `@`, something, a dot, something, and no whitespace. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

/** Trim only. Case is left alone: the provider folds it, and the address is shown back as typed. */
export function normalizeEmail(raw: string): string {
  return raw.trim();
}

/** Null when `raw`, trimmed, looks like an email address; otherwise the sentence to show. */
export function emailProblem(raw: string): string | null {
  const email = normalizeEmail(raw);
  if (email.length === 0) return "Enter your email address.";
  if (!EMAIL_SHAPE.test(email)) return "Enter a valid email address, like name@example.com.";
  return null;
}

/** A password's length as the provider measures its limit: UTF-8 bytes, not characters. */
export function passwordBytes(password: string): number {
  return new TextEncoder().encode(password).length;
}

/**
 * A password being CHOSEN (sign-up and reset). Sign-in never calls this: an existing password is
 * whatever the account has, and judging it here would refuse a player the provider would accept.
 *
 * The upper limit is the provider's, which counts BYTES (`AUTH_PASSWORD_MAX_LENGTH`): 40 Cyrillic
 * letters or 25 Chinese characters are over it. So the sentence promises no number of characters.
 * The lower limit counts characters, which is never more than the bytes the provider counts, so a
 * password this check lets through is never too short for it.
 */
export function newPasswordProblem(password: string): string | null {
  if (password.length < AUTH_PASSWORD_MIN_LENGTH) {
    return `Use at least ${String(AUTH_PASSWORD_MIN_LENGTH)} characters.`;
  }
  if (passwordBytes(password) > AUTH_PASSWORD_MAX_LENGTH) {
    return `That password is too long. Use a shorter one: the limit is ${String(AUTH_PASSWORD_MAX_LENGTH)} bytes, and a letter outside A–Z takes two or more.`;
  }
  return null;
}

/** The reset form's second field. */
export function confirmProblem(password: string, confirm: string): string | null {
  if (confirm.length === 0) return "Type the new password again.";
  if (confirm !== password) return "The two passwords don't match.";
  return null;
}

/** Sign-in's only check: the field has something in it. `label` names it ("email", "password"). */
export function requiredProblem(value: string, label: string): string | null {
  if (value.trim().length === 0) return `Enter your ${label.toLowerCase()}.`;
  return null;
}
