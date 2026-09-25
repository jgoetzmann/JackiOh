// R255: deck codes. Encode and decode are proved against each other (a legal deck survives the
// round trip exactly) and decode is proved total (no input makes it throw). The byte-level cases
// build payloads by hand with `rawCode`, which carries its own copy of the format's checksum so a
// test can write exactly the bytes it means, including ones `encodeDeckCode` would never produce.

import { Buffer } from "node:buffer";

import type { CardDef } from "@jackioh/shared";
import { checkDeckDraft, normalizeName, type CatalogSnapshot, type Collection } from "@jackioh/validator";
import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  DECK_CODE_MAX_INPUT_LENGTH,
  DECK_CODE_VERSION,
  DECK_NAME_MAX_LENGTH,
} from "../../../../server/src/config.ts";
import {
  DECK_CODE_MESSAGES,
  DECK_CODE_PREFIX,
  IMPORTED_DECK_NAME,
  decodeDeckCode,
  encodeDeckCode,
  type DecodedDeck,
} from "./deckCode.ts";
import { DECK_SIZE, MAX_COPIES } from "./deckSize.ts";
import { FIXTURE_CARD_COUNT, TOKEN_ID, fixtureCardId, fixtureCatalog, fixtureCollection } from "./fixtures.ts";

const catalog: CatalogSnapshot = fixtureCatalog();
const collection: Collection = fixtureCollection();
const HEADER = `${DECK_CODE_PREFIX}${String(DECK_CODE_VERSION)}.`;

/** Every deckable fixture card, 1..FIXTURE_CARD_COUNT. */
const DECKABLE: readonly string[] = Array.from({ length: FIXTURE_CARD_COUNT }, (_unused, at) => fixtureCardId(at + 1));

/** A card number no fixture card carries. */
const UNKNOWN_NUMBER = FIXTURE_CARD_COUNT + 40;

/** A token printed with a whole number, which a v1 code can therefore name. */
const WHOLE_TOKEN_ID = "core-token-whole";
const WHOLE_TOKEN_NUMBER = FIXTURE_CARD_COUNT + 1;

function unitDef(id: string, index: string, token: boolean): CardDef {
  return {
    id,
    index,
    name: `Card ${index}`,
    set: "Core",
    type: "Unit",
    tags: token ? ["Token"] : ["Human"],
    rarity: token ? "Token" : "Common",
    token,
    cost: 1,
    base: { attack: 1, health: 1, keywords: [], text: "" },
    radiant: { attack: 2, health: 2, keywords: [], text: "" },
  };
}

const catalogWithToken: CatalogSnapshot = {
  version: catalog.version,
  cards: { ...catalog.cards, [WHOLE_TOKEN_ID]: unitDef(WHOLE_TOKEN_ID, String(WHOLE_TOKEN_NUMBER), true) },
};

// --- a hand-built payload, with its own copy of the checksum -------------------------------------

function fnv1a16(bytes: readonly number[]): number {
  let hash = 0x811c9dc5;
  for (const byte of bytes) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return ((hash >>> 16) ^ (hash & 0xffff)) & 0xffff;
}

function varint(value: number): number[] {
  const out: number[] = [];
  let rest = value;
  while (rest > 0x7f) {
    out.push((rest & 0x7f) | 0x80);
    rest = Math.floor(rest / 128);
  }
  out.push(rest);
  return out;
}

function base64url(bytes: readonly number[] | Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function payloadBytes(nameBytes: readonly number[], numbers: readonly number[], trailing: readonly number[] = []): number[] {
  const body = [nameBytes.length, ...nameBytes, ...varint(numbers.length), ...numbers.flatMap(varint), ...trailing];
  const sum = fnv1a16(body);
  return [...body, sum >> 8, sum & 0xff];
}

function rawCode(name: string | readonly number[], numbers: readonly number[], trailing: readonly number[] = []): string {
  const nameBytes = typeof name === "string" ? [...new TextEncoder().encode(name)] : name;
  return HEADER + base64url(payloadBytes(nameBytes, numbers, trailing));
}

function bodyBytes(code: string): number[] {
  return [...Buffer.from(code.slice(code.indexOf(".") + 1), "base64url")];
}

function expectOk(result: DecodedDeck): Extract<DecodedDeck, { ok: true }> {
  if (!result.ok) throw new Error(`expected a deck, got: ${result.message}`);
  return result;
}

function passesD1(name: string): boolean {
  return !checkDeckDraft({ name, cards: [], isDeckable: () => true, nameMaxLength: DECK_NAME_MAX_LENGTH }).some(
    (issue) => issue.rule === "D1",
  );
}

/** Names a saved deck may carry, astral characters included, in their stored form. */
const nameArb = fc
  .string({ unit: "binary", minLength: 1, maxLength: DECK_NAME_MAX_LENGTH })
  .map(normalizeName)
  .filter((name) => passesD1(name) && new TextDecoder().decode(new TextEncoder().encode(name)) === name);

const deckArb = fc.shuffledSubarray([...DECKABLE], { minLength: 0, maxLength: DECK_SIZE });

const BASE64URL_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_".split("");

// ---------------------------------------------------------------------------------------------

describe("the round trip", () => {
  it("R255 decode(encode(name, cards)) is the same name and the same cards, in order, for any legal deck", () => {
    fc.assert(
      fc.property(nameArb, deckArb, (name, cards) => {
        const code = encodeDeckCode(name, cards, catalog);
        const decoded = expectOk(decodeDeckCode(code, catalog, collection));
        expect(decoded.name).toBe(name);
        expect(decoded.cards).toEqual(cards);
        expect(decoded.nameFellBack).toBe(false);
        expect(decoded.dropped).toEqual({ unknown: [], tokens: [], duplicates: [], overflow: [] });
        expect(decoded.unowned).toEqual([]);
      }),
    );
  });

  it("R255 every code starts with JKO, the version and a dot, and is base64url after it", () => {
    const code = encodeDeckCode("Midrange Humans", DECKABLE.slice(0, DECK_SIZE), catalog);
    expect(code.startsWith(HEADER)).toBe(true);
    expect(code.slice(HEADER.length)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("R255 a full deck with the longest name, in four-byte characters, fits the input limit", () => {
    const name = "🂡".repeat(DECK_NAME_MAX_LENGTH);
    expect(passesD1(name)).toBe(true);
    const code = encodeDeckCode(name, DECKABLE.slice(0, DECK_SIZE), catalog);
    expect(code.length).toBeLessThanOrEqual(DECK_CODE_MAX_INPUT_LENGTH);
    expect(expectOk(decodeDeckCode(code, catalog, collection)).name).toBe(name);
  });

  it("R255 a name is stored normalised and cut to DECK_NAME_MAX_LENGTH characters", () => {
    const long = `  ${"x".repeat(DECK_NAME_MAX_LENGTH + 5)}  `;
    const decoded = expectOk(decodeDeckCode(encodeDeckCode(long, [], catalog), catalog, collection));
    expect(decoded.name).toBe("x".repeat(DECK_NAME_MAX_LENGTH));
    const spaced = expectOk(decodeDeckCode(encodeDeckCode("  Fast   and  loose ", [], catalog), catalog, collection));
    expect(spaced.name).toBe("Fast and loose");
  });

  it("R255 encode writes an unusable name as the import fallback", () => {
    const decoded = expectOk(decodeDeckCode(encodeDeckCode("   ", [DECKABLE[0] ?? ""], catalog), catalog, collection));
    expect(decoded.name).toBe(IMPORTED_DECK_NAME);
  });

  it("R255 encode skips a card with no whole catalog number and an id the catalog does not know", () => {
    const first = DECKABLE[0] ?? "";
    const code = encodeDeckCode("Skips", [TOKEN_ID, "core-nope", first], catalog);
    expect(expectOk(decodeDeckCode(code, catalog, collection)).cards).toEqual([first]);
  });

  it("R255 the code carries catalog numbers, so it survives an id rename", () => {
    const renamed: CatalogSnapshot = {
      version: catalog.version,
      cards: Object.fromEntries(
        Object.values(catalog.cards).map((def) => [`renamed-${def.id}`, { ...def, id: `renamed-${def.id}` }]),
      ),
    };
    const code = encodeDeckCode("Renamed", [fixtureCardId(3), fixtureCardId(7)], catalog);
    expect(expectOk(decodeDeckCode(code, renamed, null)).cards).toEqual([
      `renamed-${fixtureCardId(3)}`,
      `renamed-${fixtureCardId(7)}`,
    ]);
  });
});

describe("decoding never throws", () => {
  const settles = (input: unknown): boolean => {
    const result = decodeDeckCode(input, catalog, collection);
    return result.ok ? Array.isArray(result.cards) : typeof result.message === "string" && result.message.length > 0;
  };

  it("R255 on any string", () => {
    fc.assert(fc.property(fc.string({ unit: "binary", maxLength: DECK_CODE_MAX_INPUT_LENGTH + 8 }), settles));
  });

  it("R255 on the right header over any base64url text", () => {
    fc.assert(
      fc.property(fc.string({ unit: fc.constantFrom(...BASE64URL_CHARS), maxLength: 300 }), (body) =>
        settles(HEADER + body),
      ),
    );
  });

  it("R255 on the right header over the base64url of any bytes", () => {
    fc.assert(fc.property(fc.uint8Array({ maxLength: 200 }), (bytes) => settles(HEADER + base64url(bytes))));
  });

  it("R255 on anything that is not a string", () => {
    for (const input of [undefined, null, 42, {}, [], Symbol("x"), () => HEADER]) {
      expect(decodeDeckCode(input, catalog, collection)).toEqual({ ok: false, message: DECK_CODE_MESSAGES.notACode });
    }
  });
});

describe("refusals", () => {
  const code = encodeDeckCode("Refusals", DECKABLE.slice(0, DECK_SIZE), catalog);

  it("R255 input past DECK_CODE_MAX_INPUT_LENGTH is refused unread, even when stripping would leave a valid code", () => {
    const padded = code + " ".repeat(DECK_CODE_MAX_INPUT_LENGTH - code.length + 1);
    expect(padded.length).toBe(DECK_CODE_MAX_INPUT_LENGTH + 1);
    expect(decodeDeckCode(padded, catalog, collection)).toEqual({ ok: false, message: DECK_CODE_MESSAGES.tooLong });
    // One character shorter is read.
    expect(decodeDeckCode(padded.slice(0, -1), catalog, collection).ok).toBe(true);
  });

  it("R255 whitespace around and inside a pasted code is ignored", () => {
    const split = `\n  ${code.slice(0, 7)} \n\t${code.slice(7, 20)}\r\n ${code.slice(20)}  \n`;
    expect(expectOk(decodeDeckCode(split, catalog, collection)).cards).toEqual(DECKABLE.slice(0, DECK_SIZE));
  });

  it("R255 an empty paste asks for a code", () => {
    expect(decodeDeckCode("  \n\t ", catalog, collection)).toEqual({ ok: false, message: DECK_CODE_MESSAGES.empty });
  });

  it("R255 a wrong prefix is not a JackiOh deck code", () => {
    for (const text of ["hello", `ABC1.${code.slice(HEADER.length)}`, "JKO.AAAA", "JKOx.AAAA", "JKO1", "jko1.AAAA"]) {
      expect(decodeDeckCode(text, catalog, collection)).toEqual({ ok: false, message: DECK_CODE_MESSAGES.notACode });
    }
  });

  it("R255 a newer version says so", () => {
    const newer = `${DECK_CODE_PREFIX}${String(DECK_CODE_VERSION + 1)}.${code.slice(HEADER.length)}`;
    const result = decodeDeckCode(newer, catalog, collection);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message.startsWith("This code was made by a newer version of JackiOh.")).toBe(true);
  });

  it("R255 an older or otherwise unknown version is refused with its own sentence", () => {
    const older = `${DECK_CODE_PREFIX}${String(DECK_CODE_VERSION - 1)}.${code.slice(HEADER.length)}`;
    expect(decodeDeckCode(older, catalog, collection)).toEqual({ ok: false, message: DECK_CODE_MESSAGES.older });
  });

  it("R255 characters outside base64url, or an impossible length, are damage", () => {
    for (const text of [`${HEADER}AB$D`, `${HEADER}AB+/`, `${HEADER}A`, `${HEADER}ABCDE`]) {
      expect(decodeDeckCode(text, catalog, collection)).toEqual({ ok: false, message: DECK_CODE_MESSAGES.damaged });
    }
  });

  it("R255 standard '=' padding is tolerated", () => {
    const unpadded = rawCode("Pad", [1]);
    const padding = "=".repeat((4 - ((unpadded.length - HEADER.length) % 4)) % 4);
    expect(padding.length).toBeGreaterThan(0);
    expect(expectOk(decodeDeckCode(unpadded + padding, catalog, collection)).name).toBe("Pad");
  });

  it("R255 a truncated code is incomplete", () => {
    for (const cut of [1, 3, 4, 8, code.length - HEADER.length - 2]) {
      expect(decodeDeckCode(code.slice(0, code.length - cut), catalog, collection)).toEqual({
        ok: false,
        message: DECK_CODE_MESSAGES.incomplete,
      });
    }
    expect(decodeDeckCode(HEADER, catalog, collection)).toEqual({ ok: false, message: DECK_CODE_MESSAGES.incomplete });
  });

  it("R255 bytes left over after the last card are damage", () => {
    expect(decodeDeckCode(rawCode("Extra", [1, 2], [7]), catalog, collection)).toEqual({
      ok: false,
      message: DECK_CODE_MESSAGES.damaged,
    });
  });

  it("R255 a changed byte fails the checksum", () => {
    const bytes = bodyBytes(code);
    // Byte 1 is the name's first character: the structure still parses, only the sum is wrong.
    bytes[1] = (bytes[1] ?? 0) ^ 0x01;
    expect(decodeDeckCode(HEADER + base64url(bytes), catalog, collection)).toEqual({
      ok: false,
      message: DECK_CODE_MESSAGES.checksum,
    });
  });

  it("R255 a card number too long for four varint bytes is damage", () => {
    // Name "A", one card, whose number runs five continuation-marked bytes.
    const body = [1, 0x41, 1, 0xff, 0xff, 0xff, 0xff, 0x01];
    const sum = fnv1a16(body);
    expect(decodeDeckCode(HEADER + base64url([...body, sum >> 8, sum & 0xff]), catalog, collection)).toEqual({
      ok: false,
      message: DECK_CODE_MESSAGES.damaged,
    });
  });
});

describe("the name", () => {
  it("R255 a name that fails D1 becomes 'Imported deck'", () => {
    const cases: (string | number[])[] = [
      "",
      "   ",
      "bad\u0001name",
      "y".repeat(DECK_NAME_MAX_LENGTH + 1),
      [0xff, 0xfe, 0x41],
    ];
    for (const name of cases) {
      const decoded = expectOk(decodeDeckCode(rawCode(name, [1, 2]), catalog, collection));
      expect(decoded.name).toBe(IMPORTED_DECK_NAME);
      expect(decoded.nameFellBack).toBe(true);
      expect(decoded.cards).toEqual([fixtureCardId(1), fixtureCardId(2)]);
    }
  });

  it("R255 a usable name comes back in its stored form", () => {
    const decoded = expectOk(decodeDeckCode(rawCode("  Tempo \t Felinors ", [1]), catalog, collection));
    expect(decoded.name).toBe("Tempo Felinors");
    expect(decoded.nameFellBack).toBe(false);
  });
});

describe("what an import drops, and what it flags", () => {
  it("R255 numbers the catalog does not know are dropped and listed", () => {
    const decoded = expectOk(decodeDeckCode(rawCode("Unknown", [1, UNKNOWN_NUMBER, 2, UNKNOWN_NUMBER + 1]), catalog, collection));
    expect(decoded.cards).toEqual([fixtureCardId(1), fixtureCardId(2)]);
    expect(decoded.dropped.unknown).toEqual([UNKNOWN_NUMBER, UNKNOWN_NUMBER + 1]);
  });

  it("R255 Tokens are dropped and listed", () => {
    const decoded = expectOk(decodeDeckCode(rawCode("Tokens", [1, WHOLE_TOKEN_NUMBER]), catalogWithToken, collection));
    expect(decoded.cards).toEqual([fixtureCardId(1)]);
    expect(decoded.dropped.tokens).toEqual([WHOLE_TOKEN_ID]);
  });

  it("R255 copies past MAX_COPIES are dropped, one entry per dropped copy", () => {
    const decoded = expectOk(decodeDeckCode(rawCode("Copies", [1, 1, 2, 1]), catalog, collection));
    expect(decoded.cards).toEqual([fixtureCardId(1), fixtureCardId(2)]);
    expect(decoded.dropped.duplicates).toHaveLength(3 - MAX_COPIES);
    expect(decoded.dropped.duplicates.every((id) => id === fixtureCardId(1))).toBe(true);
  });

  it("R255 cards past DECK_SIZE are dropped and listed in code order", () => {
    const numbers = Array.from({ length: DECK_SIZE + 3 }, (_unused, at) => at + 1);
    const decoded = expectOk(decodeDeckCode(rawCode("Overflow", numbers), catalog, collection));
    expect(decoded.cards).toEqual(numbers.slice(0, DECK_SIZE).map(fixtureCardId));
    expect(decoded.dropped.overflow).toEqual(numbers.slice(DECK_SIZE).map(fixtureCardId));
  });

  it("R255 an encode of an over-full, duplicated deck is cleaned up the same way on import", () => {
    const cards = [...DECKABLE.slice(0, DECK_SIZE), DECKABLE[0] ?? "", DECKABLE[DECK_SIZE] ?? ""];
    const decoded = expectOk(decodeDeckCode(encodeDeckCode("Messy", cards, catalog), catalog, collection));
    expect(decoded.cards).toEqual(DECKABLE.slice(0, DECK_SIZE));
    expect(decoded.dropped.duplicates).toEqual([DECKABLE[0]]);
    expect(decoded.dropped.overflow).toEqual([DECKABLE[DECK_SIZE]]);
  });

  it("R255 cards the player does not own are kept and flagged", () => {
    const partial: Collection = { [fixtureCardId(1)]: 1, [fixtureCardId(3)]: 0 };
    const decoded = expectOk(decodeDeckCode(rawCode("Unowned", [1, 2, 3]), catalog, partial));
    expect(decoded.cards).toEqual([fixtureCardId(1), fixtureCardId(2), fixtureCardId(3)]);
    expect(decoded.unowned).toEqual([fixtureCardId(2), fixtureCardId(3)]);
  });

  it("R255 with no collection, ownership is unknown and nothing is flagged", () => {
    const decoded = expectOk(decodeDeckCode(rawCode("No collection", [1, 2]), catalog, null));
    expect(decoded.unowned).toEqual([]);
  });
});
