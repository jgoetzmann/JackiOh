// Trio codes (SPEC §9.4, R339): a trio and its three decks as one line of text, the way a deck code
// (R255, `deckCode.ts`) carries one deck.
//
// CLIENT-SIDE LIKE A DECK CODE. The code is read here and nowhere else; what an import sends the
// server is the decks and the trio it holds (`POST /api/trios/import`, R341), which the server
// checks like any save. So this module decides nothing about legality. It reads what the code
// says, and each deck in it is resolved exactly as a deck code's deck is (`resolveDeck`): what no
// deck could hold is dropped and listed, and cards the player does not own are kept and flagged.
//
// THE FORMAT. `JKT<version>.` then base64url (no padding) of:
//
//   [trio name length: 1 byte] [trio name: UTF-8] [slots: 1 byte] [deck body]… [checksum: 2 bytes]
//
// - The slots byte says which of the trio's three slots hold a deck: bit n for slot n. A trio is a
//   draft and may have an empty slot (R252); an empty slot stays empty on import. Any other bit is
//   a damaged code.
// - A deck body is a deck code's payload without its checksum (`writeDeckBody`): the deck's name,
//   its card count and each card's catalog number. One per set bit, in slot order.
// - The trio's name is written as a deck's is: stored form, cut to `DECK_NAME_MAX_LENGTH`, and
//   "Imported trio" when T1 would refuse it.
// - One checksum over everything, FNV-1a folded to 16 bits, as a deck code's: it catches a paste
//   that lost or mangled characters.
// - The version is `TRIO_CODE_VERSION`; a newer or older one is refused with a sentence.
//
// DECODING IS TOTAL. It never throws, whatever it is handed: input longer than
// `TRIO_CODE_MAX_INPUT_LENGTH` is refused unread, a deck code is sent to the deck import, and every
// other failure is a sentence for the player (`TRIO_CODE_MESSAGES`).

import { checkTrioDraft, normalizeName, type CatalogSnapshot, type Collection } from "@jackioh/validator";

import {
  DECK_NAME_MAX_LENGTH,
  TRIO_CODE_MAX_INPUT_LENGTH,
  TRIO_CODE_VERSION,
} from "../../../../server/src/config.ts";
import {
  DECK_CODE_PREFIX,
  checkEnd,
  decodeName,
  payloadReader,
  pushChecksum,
  pushName,
  readByte,
  readCodeText,
  readDeckBody,
  readNameBytes,
  resolveDeck,
  toBase64Url,
  writeDeckBody,
  type DeckBody,
  type ResolvedDeck,
} from "./deckCode.ts";

/** What every trio code starts with, before its version digits and a ".". */
export const TRIO_CODE_PREFIX = "JKT";

/** The name an import gets when the code's own trio name is unusable (R339). */
export const IMPORTED_TRIO_NAME = "Imported trio";

/** A trio's slots: three, by T2. */
export const TRIO_CODE_SLOTS = 3;

/** One slot of a trio as a code carries it: a deck's name and cards, or nothing. */
export type TrioCodeSlot = { name: string; cards: readonly string[] } | null;

export type DecodedTrio =
  | {
      ok: true;
      name: string;
      nameFellBack: boolean;
      /** Slot by slot: each deck as `resolveDeck` makes it, or null for a slot the code left empty. */
      slots: readonly [ResolvedDeck | null, ResolvedDeck | null, ResolvedDeck | null];
    }
  | { ok: false; message: string };

/** Every refusal, as the trio import shows it. */
export const TRIO_CODE_MESSAGES = Object.freeze({
  tooLong: "That’s too long to be a JackiOh trio code.",
  empty: "Paste a trio code to import it.",
  notACode: "That isn’t a JackiOh trio code.",
  deckCode: "That’s a deck code, not a trio code: import it with Import, under Decks.",
  newer: "This trio code was made by a newer version of JackiOh. Reload the page to update, then try again.",
  older: "This trio code was made by an older version of JackiOh, and this version can’t read it.",
  damaged: "That trio code is damaged. Copy it again from where it was shared.",
  incomplete: "That trio code is incomplete. Copy the whole code and try again.",
  checksum: "That trio code doesn’t check out: part of it was changed or lost. Copy it again from where it was shared.",
  unreadable: "That trio code couldn’t be read.",
});

const NAME_LENGTH_BYTES = 1;
const SLOTS_BYTES = 1;
const CHECKSUM_BYTES = 2;
/** The trio name's length byte, the slots byte and the checksum: the smallest payload there is. */
const MIN_PAYLOAD_BYTES = NAME_LENGTH_BYTES + SLOTS_BYTES + CHECKSUM_BYTES;
/** Bits 0, 1 and 2 of the slots byte; anything else set is damage. */
const SLOT_BITS = (1 << TRIO_CODE_SLOTS) - 1;

/** T1, as the validator states it: whether `name` may be a saved trio's name. */
function passesT1(name: string): boolean {
  const issues = checkTrioDraft({ name, deckIds: [null, null, null], nameMaxLength: DECK_NAME_MAX_LENGTH });
  return !issues.some((issue) => issue.rule === "T1");
}

/** The trio name a code carries: stored form, at most `DECK_NAME_MAX_LENGTH` characters, T1-clean. */
function trioNameForCode(raw: string): string {
  const cut = normalizeName([...normalizeName(raw)].slice(0, DECK_NAME_MAX_LENGTH).join(""));
  return passesT1(cut) ? cut : IMPORTED_TRIO_NAME;
}

// --- encode ---------------------------------------------------------------------------------------

/**
 * The code for a trio: its name and its three slots, each a deck's name and cards or empty. Each
 * deck is written as a deck code writes it (`writeDeckBody`).
 */
export function encodeTrioCode(name: string, slots: readonly TrioCodeSlot[], catalog: CatalogSnapshot): string {
  const payload: number[] = [];
  pushName(payload, trioNameForCode(name), IMPORTED_TRIO_NAME);
  let mask = 0;
  for (let slot = 0; slot < TRIO_CODE_SLOTS; slot += 1) {
    if ((slots[slot] ?? null) !== null) mask |= 1 << slot;
  }
  payload.push(mask);
  for (let slot = 0; slot < TRIO_CODE_SLOTS; slot += 1) {
    const deck = slots[slot] ?? null;
    if (deck !== null) writeDeckBody(payload, deck.name, deck.cards, catalog);
  }
  pushChecksum(payload);
  return `${TRIO_CODE_PREFIX}${String(TRIO_CODE_VERSION)}.${toBase64Url(payload)}`;
}

// --- decode ---------------------------------------------------------------------------------------

type Parsed =
  | { ok: true; nameBytes: Uint8Array; bodies: (DeckBody | null)[] }
  | { ok: false; message: string };

function parsePayload(bytes: Uint8Array): Parsed {
  const reader = payloadReader(bytes, MIN_PAYLOAD_BYTES);
  if (reader === "incomplete") return { ok: false, message: TRIO_CODE_MESSAGES.incomplete };
  const nameBytes = readNameBytes(reader);
  if (nameBytes === "incomplete") return { ok: false, message: TRIO_CODE_MESSAGES.incomplete };
  const mask = readByte(reader);
  if (mask === "incomplete") return { ok: false, message: TRIO_CODE_MESSAGES.incomplete };
  if ((mask & ~SLOT_BITS) !== 0) return { ok: false, message: TRIO_CODE_MESSAGES.damaged };

  const bodies: (DeckBody | null)[] = [];
  for (let slot = 0; slot < TRIO_CODE_SLOTS; slot += 1) {
    if ((mask & (1 << slot)) === 0) {
      bodies.push(null);
      continue;
    }
    const body = readDeckBody(reader);
    if (body === "incomplete") return { ok: false, message: TRIO_CODE_MESSAGES.incomplete };
    if (body === "damaged") return { ok: false, message: TRIO_CODE_MESSAGES.damaged };
    bodies.push(body);
  }
  const end = checkEnd(reader);
  if (end === "damaged") return { ok: false, message: TRIO_CODE_MESSAGES.damaged };
  if (end === "checksum") return { ok: false, message: TRIO_CODE_MESSAGES.checksum };
  return { ok: true, nameBytes, bodies };
}

function decodeUnsafe(text: unknown, catalog: CatalogSnapshot, collection: Collection | null): DecodedTrio {
  const read = readCodeText(
    text,
    {
      prefix: TRIO_CODE_PREFIX,
      version: TRIO_CODE_VERSION,
      maxInputLength: TRIO_CODE_MAX_INPUT_LENGTH,
      other: DECK_CODE_PREFIX,
      otherMessage: TRIO_CODE_MESSAGES.deckCode,
    },
    TRIO_CODE_MESSAGES,
  );
  if (!read.ok) return read;
  const parsed = parsePayload(read.bytes);
  if (!parsed.ok) return parsed;

  const { name, fellBack } = decodeName(parsed.nameBytes, IMPORTED_TRIO_NAME, passesT1);
  const resolve = (body: DeckBody | null | undefined): ResolvedDeck | null =>
    body === null || body === undefined ? null : resolveDeck(body, catalog, collection);
  const [first, second, third] = parsed.bodies;
  return { ok: true, name, nameFellBack: fellBack, slots: [resolve(first), resolve(second), resolve(third)] };
}

/**
 * What a pasted trio code holds, or why it cannot be read. Never throws: a player can paste
 * anything, and every failure is a sentence (`TRIO_CODE_MESSAGES`).
 */
export function decodeTrioCode(text: unknown, catalog: CatalogSnapshot, collection: Collection | null): DecodedTrio {
  try {
    return decodeUnsafe(text, catalog, collection);
  } catch {
    return { ok: false, message: TRIO_CODE_MESSAGES.unreadable };
  }
}
