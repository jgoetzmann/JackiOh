// R339: trio codes. Encode and decode are proved against each other (a trio of legal decks survives
// the round trip exactly, empty slots included) and decode is proved total (no input makes it
// throw). The byte-level cases build payloads by hand with their own copy of the checksum, so a test
// can write exactly the bytes it means, including ones `encodeTrioCode` would never produce.

import { Buffer } from "node:buffer";

import { checkTrioDraft, normalizeName, type CatalogSnapshot, type Collection } from "@jackioh/validator";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  DECK_NAME_MAX_LENGTH,
  TRIO_CODE_MAX_INPUT_LENGTH,
  TRIO_CODE_VERSION,
} from "../../../../server/src/config.ts";
import { DECK_CODE_MESSAGES, IMPORTED_DECK_NAME, decodeDeckCode, encodeDeckCode } from "./deckCode.ts";
import { DECK_SIZE } from "./deckSize.ts";
import { FIXTURE_CARD_COUNT, TOKEN_ID, fixtureCardId, fixtureCatalog, fixtureCollection } from "./fixtures.ts";
import {
  IMPORTED_TRIO_NAME,
  TRIO_CODE_MESSAGES,
  TRIO_CODE_PREFIX,
  decodeTrioCode,
  encodeTrioCode,
  type DecodedTrio,
  type TrioCodeSlot,
} from "./trioCode.ts";

const catalog: CatalogSnapshot = fixtureCatalog();
const collection: Collection = fixtureCollection();
const HEADER = `${TRIO_CODE_PREFIX}${String(TRIO_CODE_VERSION)}.`;

const DECKABLE: readonly string[] = Array.from({ length: FIXTURE_CARD_COUNT }, (_unused, at) => fixtureCardId(at + 1));
const deckOf = (from: number): string[] => DECKABLE.slice(from, from + DECK_SIZE);

const FULL_TRIO: readonly TrioCodeSlot[] = [
  { name: "Aggro", cards: deckOf(0) },
  { name: "Control", cards: deckOf(DECK_SIZE) },
  { name: "Ramp", cards: deckOf(2 * DECK_SIZE) },
];

// --- a hand-built payload, with its own copy of the checksum -------------------------------------

function fnv1a16(bytes: readonly number[]): number {
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return ((hash >>> 16) ^ (hash & 0xffff)) & 0xffff;
}

function base64url(bytes: readonly number[] | Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function nameBytes(name: string): number[] {
  const bytes = [...new TextEncoder().encode(name)];
  return [bytes.length, ...bytes];
}

/** A deck body with small card numbers (each one byte). */
function deckBody(name: string, numbers: readonly number[]): number[] {
  return [...nameBytes(name), numbers.length, ...numbers];
}

function rawTrio(name: string, mask: number, bodies: readonly number[][], trailing: readonly number[] = []): string {
  const body = [...nameBytes(name), mask, ...bodies.flat(), ...trailing];
  const sum = fnv1a16(body);
  return HEADER + base64url([...body, sum >> 8, sum & 0xff]);
}

function expectOk(result: DecodedTrio): Extract<DecodedTrio, { ok: true }> {
  if (!result.ok) throw new Error(`expected a trio, got: ${result.message}`);
  return result;
}

function passesT1(name: string): boolean {
  return !checkTrioDraft({ name, deckIds: [null, null, null], nameMaxLength: DECK_NAME_MAX_LENGTH }).some(
    (issue) => issue.rule === "T1",
  );
}

const nameArb = fc
  .string({ unit: "binary", minLength: 1, maxLength: DECK_NAME_MAX_LENGTH })
  .map(normalizeName)
  .filter((name) => passesT1(name) && new TextDecoder().decode(new TextEncoder().encode(name)) === name);

const slotArb: fc.Arbitrary<TrioCodeSlot> = fc.option(
  fc.record({ name: nameArb, cards: fc.shuffledSubarray([...DECKABLE], { minLength: 0, maxLength: DECK_SIZE }) }),
  { nil: null },
);

const BASE64URL_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".split("");

// ---------------------------------------------------------------------------------------------

describe("R339 — the round trip", () => {
  it("R339 decode(encode(trio)) is the same trio name and the same decks, slot by slot, empty slots included", () => {
    fc.assert(
      fc.property(nameArb, fc.tuple(slotArb, slotArb, slotArb), (name, slots) => {
        const decoded = expectOk(decodeTrioCode(encodeTrioCode(name, slots, catalog), catalog, collection));
        expect(decoded.name).toBe(name);
        expect(decoded.nameFellBack).toBe(false);
        decoded.slots.forEach((deck, slot) => {
          const sent = slots[slot] ?? null;
          if (sent === null) {
            expect(deck).toBeNull();
            return;
          }
          expect(deck?.name).toBe(sent.name);
          expect(deck?.cards).toEqual(sent.cards);
          expect(deck?.dropped).toEqual({ unknown: [], tokens: [], duplicates: [], overflow: [] });
        });
      }),
    );
  });

  it("R339 every code starts with JKT, the version and a dot, and is base64url after it", () => {
    const code = encodeTrioCode("My trio", FULL_TRIO, catalog);
    expect(code.startsWith(HEADER)).toBe(true);
    expect(/^[A-Za-z0-9_-]+$/u.test(code.slice(HEADER.length))).toBe(true);
  });

  it("R339 the longest trio, every name at the limit in four-byte characters, fits the input limit", () => {
    const longest = "𝄞".repeat(DECK_NAME_MAX_LENGTH);
    const code = encodeTrioCode(
      longest,
      FULL_TRIO.map((deck) => ({ name: longest, cards: deck?.cards ?? [] })),
      catalog,
    );
    expect(code.length).toBeLessThanOrEqual(TRIO_CODE_MAX_INPUT_LENGTH);
    const decoded = expectOk(decodeTrioCode(code, catalog, collection));
    expect(decoded.name).toBe(longest);
    expect(decoded.slots.map((deck) => deck?.name)).toEqual([longest, longest, longest]);
  });

  it("R339 an unusable trio name travels as the import fallback, and a deck's as the deck fallback", () => {
    const code = encodeTrioCode("   ", [{ name: "\u0007", cards: deckOf(0) }, null, null], catalog);
    const decoded = expectOk(decodeTrioCode(code, catalog, collection));
    expect(decoded.name).toBe(IMPORTED_TRIO_NAME);
    expect(decoded.slots[0]?.name).toBe(IMPORTED_DECK_NAME);
  });

  it("R339 a trio of three empty slots is a code too, and comes back empty", () => {
    const decoded = expectOk(decodeTrioCode(encodeTrioCode("Empty", [null, null, null], catalog), catalog, collection));
    expect(decoded.slots).toEqual([null, null, null]);
  });
});

describe("R339 — decoding never throws", () => {
  const settles = (input: unknown): boolean => {
    const result = decodeTrioCode(input, catalog, collection);
    return result.ok ? result.slots.length === 3 : typeof result.message === "string" && result.message.length > 0;
  };

  it("R339 on any string", () => {
    fc.assert(fc.property(fc.string({ unit: "binary", maxLength: TRIO_CODE_MAX_INPUT_LENGTH + 8 }), settles));
  });

  it("R339 on the right header over any base64url text, and over the base64url of any bytes", () => {
    fc.assert(
      fc.property(fc.string({ unit: fc.constantFrom(...BASE64URL_CHARS), maxLength: 600 }), (body) => settles(HEADER + body)),
    );
    fc.assert(fc.property(fc.uint8Array({ maxLength: 400 }), (bytes) => settles(HEADER + base64url(bytes))));
  });

  it("R339 on anything that is not a string", () => {
    for (const input of [undefined, null, 42, {}, [], () => HEADER]) {
      expect(decodeTrioCode(input, catalog, collection)).toEqual({ ok: false, message: TRIO_CODE_MESSAGES.notACode });
    }
  });
});

describe("R339 — refusals, each with its own sentence", () => {
  const code = encodeTrioCode("Refusals", FULL_TRIO, catalog);

  it("R339 input past TRIO_CODE_MAX_INPUT_LENGTH is refused unread", () => {
    const padded = code + " ".repeat(TRIO_CODE_MAX_INPUT_LENGTH - code.length + 1);
    expect(decodeTrioCode(padded, catalog, collection)).toEqual({ ok: false, message: TRIO_CODE_MESSAGES.tooLong });
    expect(decodeTrioCode(padded.slice(0, -1), catalog, collection).ok).toBe(true);
  });

  it("R339 whitespace is ignored, and an empty paste asks for a code", () => {
    const split = `\n ${code.slice(0, 9)} \n${code.slice(9)} `;
    expect(expectOk(decodeTrioCode(split, catalog, collection)).name).toBe("Refusals");
    expect(decodeTrioCode(" \n ", catalog, collection)).toEqual({ ok: false, message: TRIO_CODE_MESSAGES.empty });
  });

  it("R339 a deck code is sent to the deck import, and a trio code pasted there is sent here", () => {
    const deck = encodeDeckCode("Aggro", deckOf(0), catalog);
    expect(decodeTrioCode(deck, catalog, collection)).toEqual({ ok: false, message: TRIO_CODE_MESSAGES.deckCode });
    expect(decodeDeckCode(code, catalog, collection)).toEqual({ ok: false, message: DECK_CODE_MESSAGES.trioCode });
  });

  it("R339 a wrong prefix is not a trio code; a newer or older version says so", () => {
    for (const text of ["hello", `ABC1.${code.slice(HEADER.length)}`, "JKT.AAAA", "jkt1.AAAA"]) {
      expect(decodeTrioCode(text, catalog, collection)).toEqual({ ok: false, message: TRIO_CODE_MESSAGES.notACode });
    }
    const body = code.slice(HEADER.length);
    expect(decodeTrioCode(`${TRIO_CODE_PREFIX}${String(TRIO_CODE_VERSION + 1)}.${body}`, catalog, collection)).toEqual({
      ok: false,
      message: TRIO_CODE_MESSAGES.newer,
    });
    expect(decodeTrioCode(`${TRIO_CODE_PREFIX}${String(TRIO_CODE_VERSION - 1)}.${body}`, catalog, collection)).toEqual({
      ok: false,
      message: TRIO_CODE_MESSAGES.older,
    });
  });

  it("R339 a truncated code is incomplete; bytes left over, a bad slot bit or non-base64url are damage", () => {
    const bodyLength = code.length - HEADER.length;
    for (let cut = 1; cut < bodyLength - 1; cut += 1) {
      // A base64url body one character past a whole group carries no whole byte: that is damage.
      const expected = (bodyLength - cut) % 4 === 1 ? TRIO_CODE_MESSAGES.damaged : TRIO_CODE_MESSAGES.incomplete;
      expect(decodeTrioCode(code.slice(0, code.length - cut), catalog, collection)).toEqual({ ok: false, message: expected });
    }
    expect(decodeTrioCode(HEADER, catalog, collection)).toEqual({ ok: false, message: TRIO_CODE_MESSAGES.incomplete });
    expect(decodeTrioCode(rawTrio("T", 0b001, [deckBody("A", [1])], [9]), catalog, collection)).toEqual({
      ok: false,
      message: TRIO_CODE_MESSAGES.damaged,
    });
    expect(decodeTrioCode(rawTrio("T", 0b1001, [deckBody("A", [1])]), catalog, collection)).toEqual({
      ok: false,
      message: TRIO_CODE_MESSAGES.damaged,
    });
    expect(decodeTrioCode(`${HEADER}AB$D`, catalog, collection)).toEqual({ ok: false, message: TRIO_CODE_MESSAGES.damaged });
    // A slot the mask names whose deck is not there.
    expect(decodeTrioCode(rawTrio("T", 0b011, [deckBody("A", [1])]), catalog, collection)).toEqual({
      ok: false,
      message: TRIO_CODE_MESSAGES.incomplete,
    });
  });

  it("R339 a changed byte fails the checksum", () => {
    const bytes = [...Buffer.from(code.slice(HEADER.length), "base64url")];
    // Byte 1 is the trio name's first character: the structure still parses, only the sum is wrong.
    bytes[1] = (bytes[1] ?? 0) ^ 0x01;
    expect(decodeTrioCode(HEADER + base64url(bytes), catalog, collection)).toEqual({
      ok: false,
      message: TRIO_CODE_MESSAGES.checksum,
    });
  });
});

describe("R339 — each deck is read as a deck code's deck is", () => {
  it("R339 numbers the catalog does not know, Tokens and copies are dropped and listed, per deck", () => {
    const tokenNumber = Number(catalog.cards[TOKEN_ID]?.index);
    expect(Number.isInteger(tokenNumber)).toBe(false);
    const unknown = FIXTURE_CARD_COUNT + 50;
    const decoded = expectOk(
      decodeTrioCode(rawTrio("Drops", 0b101, [deckBody("One", [1, 1, unknown]), deckBody("Three", [2, 3])]), catalog, collection),
    );
    expect(decoded.slots[0]).toMatchObject({
      name: "One",
      cards: [fixtureCardId(1)],
      dropped: { unknown: [unknown], tokens: [], duplicates: [fixtureCardId(1)], overflow: [] },
    });
    expect(decoded.slots[1]).toBeNull();
    expect(decoded.slots[2]?.cards).toEqual([fixtureCardId(2), fixtureCardId(3)]);
  });

  it("R339 cards the player does not own are kept and flagged, deck by deck", () => {
    const owned: Collection = { ...collection, [fixtureCardId(2)]: 0 };
    const decoded = expectOk(decodeTrioCode(encodeTrioCode("Own", FULL_TRIO, catalog), catalog, owned));
    expect(decoded.slots[0]?.cards).toContain(fixtureCardId(2));
    expect(decoded.slots[0]?.unowned).toEqual([fixtureCardId(2)]);
    expect(decoded.slots[1]?.unowned).toEqual([]);
    expect(expectOk(decodeTrioCode(encodeTrioCode("Own", FULL_TRIO, catalog), catalog, null)).slots[0]?.unowned).toEqual([]);
  });

  it("R339 decks that share cards are carried as they are: sharing is the workshop's to flag", () => {
    const shared = deckOf(0).slice(0, 5);
    const decoded = expectOk(
      decodeTrioCode(
        encodeTrioCode("Shared", [{ name: "A", cards: shared }, { name: "B", cards: shared }, null], catalog),
        catalog,
        collection,
      ),
    );
    expect(decoded.slots[0]?.cards).toEqual(shared);
    expect(decoded.slots[1]?.cards).toEqual(shared);
  });
});
