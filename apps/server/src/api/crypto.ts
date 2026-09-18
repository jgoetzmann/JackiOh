/**
 * Codes, hashes and ids (SPEC §9.4, §9.5, R79).
 *
 * The alphabet, the invite-code length and the group size come from `src/config.ts`; nothing
 * here restates them. Invite codes and room codes share the alphabet, so both build on
 * `randomCode`: 16 characters for an invite code (80 bits), `ROOM_CODE_LENGTH` for a room code.
 */

import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  CODE_ALPHABET,
  INVITE_CODE_GROUP_SIZE,
  INVITE_CODE_SEPARATOR,
} from "../config";
import type { Hashes, Ids } from "./ports";

if (CODE_ALPHABET.length !== 32) {
  throw new Error("CODE_ALPHABET must hold exactly 32 symbols (§9.4)");
}

/** Uniform because 256 is a multiple of 32: a byte masked to 5 bits has no modulo bias. */
export function codeFromBytes(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += CODE_ALPHABET[byte & 31];
  return out;
}

export function randomCode(length: number): string {
  return codeFromBytes(randomBytes(length));
}

/** `XXXX-XXXX-XXXX-XXXX` (§9.4). */
export function formatCode(raw: string): string {
  const groups: string[] = [];
  for (let i = 0; i < raw.length; i += INVITE_CODE_GROUP_SIZE) {
    groups.push(raw.slice(i, i + INVITE_CODE_GROUP_SIZE));
  }
  return groups.join(INVITE_CODE_SEPARATOR);
}

/**
 * What the client typed, reduced to the canonical form that gets hashed: upper case, separators
 * and whitespace dropped. A string holding characters outside the alphabet is still returned, so
 * a malformed code takes the same path as a lookup miss and no oracle distinguishes
 * "well-formed but unknown" from "malformed" (§9.4).
 */
export function normalizeCode(input: string): string {
  return input.toUpperCase().replace(/[\s-]+/gu, "");
}

export function isWellFormedCode(normalized: string, length: number): boolean {
  if (normalized.length !== length) return false;
  for (const ch of normalized) if (!CODE_ALPHABET.includes(ch)) return false;
  return true;
}

/**
 * §9.4: codes are stored hashed. A keyed SHA-256 rather than a password hash, because redemption
 * must find a code *by hash* and 80 bits of entropy needs no work factor; the pepper keeps a
 * stolen table from being brute-forced offline.
 */
export function createHashes(peppers: { code: string; ip: string }): Hashes {
  const digest = (key: string, value: string): string =>
    createHmac("sha256", key).update(value).digest("hex");
  return {
    code: (plain) => digest(peppers.code, normalizeCode(plain)),
    ip: (raw) => digest(peppers.ip, raw.trim().toLowerCase()),
  };
}

/** Constant-time compare, for a secret that is not looked up by hash. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export const systemIds: Ids = {
  uuid: () => randomUUID(),
  seed: () => randomBytes(16).toString("hex"),
  code: (length) => randomCode(length),
};
