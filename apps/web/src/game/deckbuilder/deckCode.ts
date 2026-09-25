// Deck codes (SPEC §9.4, R255): a deck as a line of text a player can paste into a chat and a
// friend can paste back into the builder.
//
// CLIENT-ONLY. No endpoint reads or writes a code: an import is simply a NEW saved deck (R250),
// which the builder saves like any other draft and the server judges like any other deck. So this
// module decides nothing about legality. It reads what the code says, drops what no deck could
// hold (a number the catalog does not know, a Token, a copy past `MAX_COPIES`, a card past
// `DECK_SIZE`) and reports every drop so the import dialog can say so, and it flags the cards the
// player does not own without dropping them (they are judged at queue, R253).
//
// THE FORMAT. `JKO<version>.` then base64url (no padding) of:
//
//   [name byte length: 1 byte] [name: UTF-8] [card count: LEB128] [card number: LEB128]… [checksum: 2 bytes]
//
// - A card is carried as its catalog NUMBER (`index`, "1".."100" in Core), not its id: numbers are
//   what the printed set shows, and a code stays valid through an id rename. Only whole numbers
//   are encodable; Tokens carry numbers like "51.1" and are never deckable anyway (R251).
// - The name is the deck's name as it is stored (`normalizeName`), cut to `DECK_NAME_MAX_LENGTH`
//   characters; a name the draft rule D1 would refuse is written as "Imported deck" instead.
// - The checksum is FNV-1a (32-bit) over every byte before it, folded to 16 bits. It is not
//   security: it catches a paste that lost or mangled characters, so the player is told the code
//   is damaged instead of being handed a different deck.
// - The version is `DECK_CODE_VERSION`. A newer one is refused with a sentence saying so (this
//   client cannot know what it means); so is an older one.
//
// DECODING IS TOTAL. It never throws, whatever it is handed: over-long input is refused before it
// is read at all (`DECK_CODE_MAX_INPUT_LENGTH`), and each failure is a sentence for the player. The
// order is: length, whitespace, prefix and version, base64url, structure (a payload that declares
// more than it carries is "incomplete"; bytes left over are "damaged"), then the checksum, then the
// name (D1, falling back to "Imported deck") and the cards.

import { checkDeckDraft, normalizeName, type CatalogSnapshot, type Collection } from "@jackioh/validator";

import {
  DECK_CODE_MAX_INPUT_LENGTH,
  DECK_CODE_VERSION,
  DECK_NAME_MAX_LENGTH,
} from "../../../../server/src/config.ts";
import { DECK_SIZE, MAX_COPIES } from "./deckSize.ts";

/** What every code starts with, before its version digits and a ".". */
export const DECK_CODE_PREFIX = "JKO";

/** The name an import gets when the code's own name is unusable (R255). */
export const IMPORTED_DECK_NAME = "Imported deck";

export type DroppedCards = {
  /** Card numbers the catalog does not know, in code order (numbers, not ids). */
  unknown: readonly number[];
  /** Ids of Tokens the code named. */
  tokens: readonly string[];
  /** Ids of copies past MAX_COPIES (one entry per dropped copy). */
  duplicates: readonly string[];
  /** Ids past DECK_SIZE, in code order. */
  overflow: readonly string[];
};

export type DecodedDeck =
  | {
      ok: true;
      name: string;
      cards: readonly string[];
      dropped: DroppedCards;
      unowned: readonly string[];
      nameFellBack: boolean;
    }
  | { ok: false; message: string };

/** Every refusal, as the import dialog shows it. */
export const DECK_CODE_MESSAGES = Object.freeze({
  tooLong: "That’s too long to be a JackiOh deck code.",
  empty: "Paste a deck code to import it.",
  notACode: "That isn’t a JackiOh deck code.",
  newer: "This code was made by a newer version of JackiOh. Reload the page to update, then try again.",
  older: "This code was made by an older version of JackiOh, and this version can’t read it.",
  damaged: "That deck code is damaged. Copy it again from where it was shared.",
  incomplete: "That deck code is incomplete. Copy the whole code and try again.",
  checksum: "That deck code doesn’t check out: part of it was changed or lost. Copy it again from where it was shared.",
  unreadable: "That deck code couldn’t be read.",
});

// --- byte format ---------------------------------------------------------------------------------

/** The name's byte length is one byte. */
const NAME_LENGTH_BYTES = 1;
/** The most name bytes one length byte can say. */
const NAME_BYTES_MAX = 0xff;
const CHECKSUM_BYTES = 2;
/** The smallest payload: an empty name's length, a zero count and the checksum. */
const MIN_PAYLOAD_BYTES = NAME_LENGTH_BYTES + 1 + CHECKSUM_BYTES;

const BYTE_BITS = 8;
const BYTE_MASK = 0xff;

/** LEB128: seven bits of value per byte, the top bit set on every byte but the last. */
const VARINT_PAYLOAD_BITS = 7;
/** What one byte of payload is worth: the next byte counts this many times more. */
const VARINT_BASE = 2 ** VARINT_PAYLOAD_BITS;
const VARINT_PAYLOAD_MASK = 0x7f;
const VARINT_CONTINUE = 0x80;
/** Four bytes carry up to 2^28, far past any card number or count; more is a damaged code. */
const VARINT_MAX_BYTES = 4;

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const HALF_BITS = 16;
const HALF_MASK = 0xffff;

const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const SEXTET_BITS = 6;
const SEXTET_MASK = 0x3f;
/** A base64 group is 4 characters; a lone trailing character carries no whole byte. */
const BASE64_GROUP = 4;
const BASE64_IMPOSSIBLE_REMAINDER = 1;

const BASE64URL_BODY = /^[A-Za-z0-9_-]*$/;
/** Up to two "=" of standard padding, which a chat client or a hand may add. */
const TRAILING_PADDING = /={1,2}$/;
const HEADER = /^JKO(\d+)\.(.*)$/su;
const WHITESPACE = /\s+/gu;
/** A card number that can be encoded: a whole number from 1, as a Core `index` is. */
const WHOLE_NUMBER = /^[1-9]\d*$/;

// --- helpers --------------------------------------------------------------------------------------

function fnv1a16(bytes: readonly number[] | Uint8Array, end: number): number {
  let hash = FNV_OFFSET_BASIS;
  for (let at = 0; at < end; at += 1) {
    hash ^= bytes[at] ?? 0;
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return ((hash >>> HALF_BITS) ^ (hash & HALF_MASK)) & HALF_MASK;
}

function pushVarint(out: number[], value: number): void {
  let rest = value;
  while (rest > VARINT_PAYLOAD_MASK) {
    out.push((rest & VARINT_PAYLOAD_MASK) | VARINT_CONTINUE);
    rest = Math.floor(rest / VARINT_BASE);
  }
  out.push(rest);
}

function toBase64Url(bytes: readonly number[]): string {
  let out = "";
  let acc = 0;
  let bits = 0;
  for (const byte of bytes) {
    acc = (acc << BYTE_BITS) | (byte & BYTE_MASK);
    bits += BYTE_BITS;
    while (bits >= SEXTET_BITS) {
      bits -= SEXTET_BITS;
      out += BASE64URL_ALPHABET[(acc >>> bits) & SEXTET_MASK] ?? "";
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out += BASE64URL_ALPHABET[(acc << (SEXTET_BITS - bits)) & SEXTET_MASK] ?? "";
  return out;
}

/** Null when the text is not base64url or has an impossible length. */
function fromBase64Url(text: string): Uint8Array | null {
  if (!BASE64URL_BODY.test(text)) return null;
  if (text.length % BASE64_GROUP === BASE64_IMPOSSIBLE_REMAINDER) return null;
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const char of text) {
    const value = BASE64URL_ALPHABET.indexOf(char);
    if (value < 0) return null;
    acc = (acc << SEXTET_BITS) | value;
    bits += SEXTET_BITS;
    if (bits >= BYTE_BITS) {
      bits -= BYTE_BITS;
      out.push((acc >>> bits) & BYTE_MASK);
    }
    acc &= (1 << bits) - 1;
  }
  return Uint8Array.from(out);
}

/** D1, as the validator states it: whether `name` may be a saved deck's name. */
function passesD1(name: string): boolean {
  const issues = checkDeckDraft({
    name,
    cards: [],
    isDeckable: () => true,
    nameMaxLength: DECK_NAME_MAX_LENGTH,
  });
  return !issues.some((issue) => issue.rule === "D1");
}

/** The name a code carries: stored form, at most `DECK_NAME_MAX_LENGTH` characters, D1-clean. */
function nameForCode(raw: string): string {
  const cut = normalizeName([...normalizeName(raw)].slice(0, DECK_NAME_MAX_LENGTH).join(""));
  return passesD1(cut) ? cut : IMPORTED_DECK_NAME;
}

function isToken(catalog: CatalogSnapshot, cardId: string): boolean {
  const def = catalog.cards[cardId];
  return def !== undefined && (def.token || def.tags.includes("Token"));
}

// --- encode ---------------------------------------------------------------------------------------

/**
 * The code for a deck. Cards the catalog does not know, or whose number is not a whole number,
 * are skipped; everything else is written as given, in order, so the code says exactly what the
 * deck holds (duplicates and all: the decoder is the one that drops).
 */
export function encodeDeckCode(name: string, cardIds: readonly string[], catalog: CatalogSnapshot): string {
  let nameBytes = new TextEncoder().encode(nameForCode(name));
  if (nameBytes.length > NAME_BYTES_MAX) nameBytes = new TextEncoder().encode(IMPORTED_DECK_NAME);

  const numbers: number[] = [];
  for (const cardId of cardIds) {
    const index = catalog.cards[cardId]?.index;
    if (index === undefined || !WHOLE_NUMBER.test(index)) continue;
    numbers.push(Number(index));
  }

  const payload: number[] = [nameBytes.length, ...nameBytes];
  pushVarint(payload, numbers.length);
  for (const number of numbers) pushVarint(payload, number);
  const checksum = fnv1a16(payload, payload.length);
  payload.push((checksum >>> BYTE_BITS) & BYTE_MASK, checksum & BYTE_MASK);

  return `${DECK_CODE_PREFIX}${String(DECK_CODE_VERSION)}.${toBase64Url(payload)}`;
}

// --- decode ---------------------------------------------------------------------------------------

type Parsed =
  | { ok: true; nameBytes: Uint8Array; numbers: number[] }
  | { ok: false; message: string };

/** Reads the structure between the header and the checksum; the checksum is checked after. */
function parsePayload(bytes: Uint8Array): Parsed {
  if (bytes.length < MIN_PAYLOAD_BYTES) return { ok: false, message: DECK_CODE_MESSAGES.incomplete };
  const end = bytes.length - CHECKSUM_BYTES;
  let at = 0;

  const nameLength = bytes[at] ?? 0;
  at += NAME_LENGTH_BYTES;
  if (at + nameLength > end) return { ok: false, message: DECK_CODE_MESSAGES.incomplete };
  const nameBytes = bytes.slice(at, at + nameLength);
  at += nameLength;

  const readVarint = (): number | "incomplete" | "damaged" => {
    let value = 0;
    let scale = 1;
    for (let used = 0; used < VARINT_MAX_BYTES; used += 1) {
      if (at >= end) return "incomplete";
      const byte = bytes[at] ?? 0;
      at += 1;
      value += (byte & VARINT_PAYLOAD_MASK) * scale;
      if ((byte & VARINT_CONTINUE) === 0) return value;
      scale *= VARINT_BASE;
    }
    return "damaged";
  };

  const count = readVarint();
  if (count === "incomplete") return { ok: false, message: DECK_CODE_MESSAGES.incomplete };
  if (count === "damaged") return { ok: false, message: DECK_CODE_MESSAGES.damaged };
  // Every number takes at least one byte, so a count past what is left cannot be satisfied.
  if (count > end - at) return { ok: false, message: DECK_CODE_MESSAGES.incomplete };

  const numbers: number[] = [];
  for (let read = 0; read < count; read += 1) {
    const number = readVarint();
    if (number === "incomplete") return { ok: false, message: DECK_CODE_MESSAGES.incomplete };
    if (number === "damaged") return { ok: false, message: DECK_CODE_MESSAGES.damaged };
    numbers.push(number);
  }
  if (at !== end) return { ok: false, message: DECK_CODE_MESSAGES.damaged };

  const stored = ((bytes[end] ?? 0) << BYTE_BITS) | (bytes[end + 1] ?? 0);
  if (stored !== fnv1a16(bytes, end)) return { ok: false, message: DECK_CODE_MESSAGES.checksum };
  return { ok: true, nameBytes, numbers };
}

function decodeName(nameBytes: Uint8Array): { name: string; fellBack: boolean } {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(nameBytes);
  } catch {
    return { name: IMPORTED_DECK_NAME, fellBack: true };
  }
  const name = normalizeName(text);
  return passesD1(name) ? { name, fellBack: false } : { name: IMPORTED_DECK_NAME, fellBack: true };
}

function decodeUnsafe(text: unknown, catalog: CatalogSnapshot, collection: Collection | null): DecodedDeck {
  if (typeof text !== "string") return { ok: false, message: DECK_CODE_MESSAGES.notACode };
  // Refused unread: nothing below runs on a paste this long.
  if (text.length > DECK_CODE_MAX_INPUT_LENGTH) return { ok: false, message: DECK_CODE_MESSAGES.tooLong };

  const compact = text.replace(WHITESPACE, "");
  if (compact.length === 0) return { ok: false, message: DECK_CODE_MESSAGES.empty };

  const header = HEADER.exec(compact);
  if (header === null) return { ok: false, message: DECK_CODE_MESSAGES.notACode };
  const version = Number(header[1] ?? "");
  if (version > DECK_CODE_VERSION) return { ok: false, message: DECK_CODE_MESSAGES.newer };
  if (version !== DECK_CODE_VERSION) return { ok: false, message: DECK_CODE_MESSAGES.older };

  const bytes = fromBase64Url((header[2] ?? "").replace(TRAILING_PADDING, ""));
  if (bytes === null) return { ok: false, message: DECK_CODE_MESSAGES.damaged };

  const parsed = parsePayload(bytes);
  if (!parsed.ok) return parsed;

  const { name, fellBack } = decodeName(parsed.nameBytes);

  const byNumber = new Map<number, string>();
  for (const [cardId, def] of Object.entries(catalog.cards)) {
    if (WHOLE_NUMBER.test(def.index)) byNumber.set(Number(def.index), cardId);
  }

  const cards: string[] = [];
  const copies = new Map<string, number>();
  const unknown: number[] = [];
  const tokens: string[] = [];
  const duplicates: string[] = [];
  const overflow: string[] = [];
  for (const number of parsed.numbers) {
    const cardId = byNumber.get(number);
    if (cardId === undefined) {
      unknown.push(number);
      continue;
    }
    if (isToken(catalog, cardId)) {
      tokens.push(cardId);
      continue;
    }
    const held = copies.get(cardId) ?? 0;
    if (held >= MAX_COPIES) {
      duplicates.push(cardId);
      continue;
    }
    if (cards.length >= DECK_SIZE) {
      overflow.push(cardId);
      continue;
    }
    copies.set(cardId, held + 1);
    cards.push(cardId);
  }

  const unowned =
    collection === null ? [] : [...new Set(cards)].filter((cardId) => (collection[cardId] ?? 0) < 1);

  return {
    ok: true,
    name,
    cards,
    dropped: { unknown, tokens, duplicates, overflow },
    unowned,
    nameFellBack: fellBack,
  };
}

/**
 * What a pasted code holds, or why it cannot be read. Never throws: a player can paste anything,
 * and every failure is a sentence (`DECK_CODE_MESSAGES`).
 */
export function decodeDeckCode(text: unknown, catalog: CatalogSnapshot, collection: Collection | null): DecodedDeck {
  try {
    return decodeUnsafe(text, catalog, collection);
  } catch {
    return { ok: false, message: DECK_CODE_MESSAGES.unreadable };
  }
}
