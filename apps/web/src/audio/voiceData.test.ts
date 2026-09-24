// Polish task 2 (docs/polish/2-sound.md), behaviours B41 to B43: the lookups in `voiceData.ts` that
// the engine, the cue table and the hook read, and the layout of `voice-lines.json`.
//
//   B41  `voiceKey` joins "<defId>-<line>" (defIds contain "-"), `voiceUrl` serves it from
//        BASE_URL's `audio/voice/`, and `lineFor` returns the line's text with the persona the card
//        speaks in, its own rate/pbas/pmod overrides applied, or null for the sentinel, an unknown
//        id or a line the card's kind does not have.
//   B42  `parseVoiceLines` accepts the shipped table unchanged and rejects a malformed one with
//        `voice-lines.json: <path>: <problem>`; it does not check word limits (B34 does).
//   B43  `voiceKeysForView` lists, deduped and in this order, the viewer's hand (unit -> play,
//        spell -> cast, traps none), every unit on both boards (death), and the viewer's own
//        face-up backrow traps (cast); a card it cannot name adds nothing.
//
// Plus the Surface's file layout: personas sorted by id, cards in catalog order, 2-space JSON and a
// trailing newline.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { PlayerView } from "@jackioh/shared";
import { beforeEach, describe, expect, it } from "vitest";

import { HIDDEN_DEF_ID } from "./constants.ts";
import type { VoiceLineTable } from "./types.ts";
import { VOICE_LINES, lineFor, parseVoiceLines, voiceKey, voiceKeysForView, voiceUrl } from "./voiceData.ts";
import { baseView, card, emptySide, faceDownBackrow, faceUpBackrow, resetIds, unit } from "../test/fixtures.ts";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, "../../../..");
const LINES_PATH = resolve(here, "voice-lines.json");
const CATALOG_PATH = resolve(REPO, "packages/cards/catalog.json");

function shippedJson(): Record<string, unknown> {
  return JSON.parse(readFileSync(LINES_PATH, "utf8")) as Record<string, unknown>;
}

type RawTable = {
  version: unknown;
  personas: Record<string, Record<string, unknown>>;
  cards: Record<string, Record<string, unknown>>;
};

/** A fresh copy of the shipped table, as raw JSON, for one malformed edit at a time. */
function rawTable(): RawTable {
  return shippedJson() as RawTable;
}

function parseError(raw: unknown): string {
  try {
    parseVoiceLines(raw);
  } catch (error) {
    return (error as Error).message;
  }
  return "(no error)";
}

beforeEach(() => {
  resetIds();
});

describe("B41 voiceKey, voiceUrl and lineFor", () => {
  it("B41 voiceKey joins a defId and a line, including a defId that has dashes of its own", () => {
    expect(voiceKey("core-004", "play")).toBe("core-004-play");
    expect(voiceKey("core-051-1", "cast")).toBe("core-051-1-cast");
    expect(voiceKey("core-t-sheep", "death")).toBe("core-t-sheep-death");
  });

  it("B41 voiceUrl serves a key from audio/voice/ under the app's base URL", () => {
    expect(voiceUrl("core-004-play")).toBe(`${import.meta.env.BASE_URL}audio/voice/core-004-play.m4a`);
    expect(voiceUrl("core-051-1-cast")).toBe("/audio/voice/core-051-1-cast.m4a");
  });

  it("B41 lineFor gives a unit's play and death text in its persona's voice", () => {
    const entry = VOICE_LINES.cards["core-004"];
    if (entry?.kind !== "unit") throw new Error("core-004 should be a unit in the shipped table");
    const persona = VOICE_LINES.personas[entry.persona];

    expect(lineFor(VOICE_LINES, "core-004", "play")).toEqual({ text: entry.play, persona });
    expect(lineFor(VOICE_LINES, "core-004", "death")).toEqual({ text: entry.death, persona });
  });

  it("B41 lineFor applies a card's own rate and pbas over its persona's, and keeps the rest", () => {
    // docs/polish/2-sound.md, Personas: core-016 is the hustler with `rate 170, pbas 32`.
    const entry = VOICE_LINES.cards["core-016"];
    if (entry?.kind !== "spell") throw new Error("core-016 should be a spell in the shipped table");
    const base = VOICE_LINES.personas[entry.persona];
    if (base === undefined) throw new Error(`no persona ${entry.persona}`);

    const spoken = lineFor(VOICE_LINES, "core-016", "cast");

    expect(spoken?.text).toBe(entry.cast);
    expect(spoken?.persona).toEqual({ ...base, rate: 170, pbas: 32, pmod: base.pmod });
    expect(base.rate).not.toBe(170);
  });

  it("B41 lineFor applies every override field, pmod included, on a table of its own", () => {
    const lines: VoiceLineTable = {
      version: 1,
      personas: { p: { say: "Eddy (English (US))", rate: 180, pbas: 40, pmod: 30, web: { pitch: 1, rate: 1 }, gain: 1.5 } },
      cards: { "x-1": { kind: "unit", persona: "p", play: "Hello.", death: "Bye.", pmod: 5 } },
    };

    expect(lineFor(lines, "x-1", "death")).toEqual({
      text: "Bye.",
      persona: { say: "Eddy (English (US))", rate: 180, pbas: 40, pmod: 5, web: { pitch: 1, rate: 1 }, gain: 1.5 },
    });
  });

  it("B41 lineFor is null for the sentinel, an unknown id, and a line the card's kind does not have", () => {
    expect(lineFor(VOICE_LINES, HIDDEN_DEF_ID, "play")).toBeNull();
    expect(lineFor(VOICE_LINES, HIDDEN_DEF_ID, "cast")).toBeNull();
    expect(lineFor(VOICE_LINES, "core-999", "play")).toBeNull();
    expect(lineFor(VOICE_LINES, "toString", "play")).toBeNull();
    // A unit has no cast line; a spell and a trap have neither a play nor a death line.
    expect(lineFor(VOICE_LINES, "core-004", "cast")).toBeNull();
    expect(lineFor(VOICE_LINES, "core-005", "play")).toBeNull();
    expect(lineFor(VOICE_LINES, "core-005", "death")).toBeNull();
    expect(lineFor(VOICE_LINES, "core-041", "death")).toBeNull();
    expect(lineFor(VOICE_LINES, "core-041", "cast")).not.toBeNull();
  });
});

describe("B42 parseVoiceLines", () => {
  it("B42 accepts the shipped voice-lines.json and returns it unchanged", () => {
    expect(parseVoiceLines(shippedJson())).toEqual(shippedJson());
    expect(VOICE_LINES).toEqual(shippedJson());
  });

  it("B42 names the path and the problem of a malformed table", () => {
    const wrongVersion = { ...rawTable(), version: 2 };
    expect(parseError(wrongVersion)).toMatch(/^voice-lines\.json: version: /);

    expect(parseError([])).toMatch(/^voice-lines\.json: \(root\): /);

    const unknownPersona = rawTable();
    unknownPersona.cards["core-004"] = { ...unknownPersona.cards["core-004"], persona: "nobody" };
    expect(parseError(unknownPersona)).toMatch(/^voice-lines\.json: cards\.core-004\.persona: .*nobody/);

    const noDeath = rawTable();
    delete noDeath.cards["core-004"]?.death;
    expect(parseError(noDeath)).toMatch(/^voice-lines\.json: cards\.core-004\.death: /);

    const spellWithPlay = rawTable();
    spellWithPlay.cards["core-005"] = { ...spellWithPlay.cards["core-005"], play: "Hi." };
    expect(parseError(spellWithPlay)).toMatch(/^voice-lines\.json: cards\.core-005\.play: /);

    const badKind = rawTable();
    badKind.cards["core-004"] = { ...badKind.cards["core-004"], kind: "hero" };
    expect(parseError(badKind)).toMatch(/^voice-lines\.json: cards\.core-004\.kind: /);

    const slowGuard = rawTable();
    slowGuard.personas.guard = { ...slowGuard.personas.guard, rate: 12 };
    expect(parseError(slowGuard)).toMatch(/^voice-lines\.json: personas\.guard\.rate: /);

    const loudGuard = rawTable();
    loudGuard.personas.guard = { ...loudGuard.personas.guard, web: { pitch: 3, rate: 1 } };
    expect(parseError(loudGuard)).toMatch(/^voice-lines\.json: personas\.guard\.web\.pitch: /);

    const sentinel = rawTable();
    sentinel.cards[HIDDEN_DEF_ID] = { kind: "spell", persona: "guard", cast: "Guess who." };
    expect(parseError(sentinel)).toMatch(new RegExp(`^voice-lines\\.json: cards\\.${HIDDEN_DEF_ID}: `));
  });

  it("B42 leaves word limits to the content test", () => {
    const wordy = rawTable();
    const long = "one two three four five six seven eight nine ten eleven twelve";
    wordy.cards["core-005"] = { ...wordy.cards["core-005"], cast: long };

    expect(parseVoiceLines(wordy).cards["core-005"]).toMatchObject({ kind: "spell", cast: long });
  });
});

describe("B43 voiceKeysForView", () => {
  function viewWith(): PlayerView {
    return baseView({
      you: emptySide("p1", {
        hand: [
          card({ defId: "core-004" }), // unit: play
          card({ defId: "core-005" }), // spell: cast
          card({ defId: "core-018" }), // Field Trap: nothing, a set never speaks (R203)
          card({ defId: "core-004" }), // a second copy: deduped
          card({ defId: "core-006" }), // Field Spell: cast
        ],
        units: [unit("p1", { defId: "core-012" }), null, unit("p1", { defId: "core-t-sheep" }), null, null],
        backrow: [
          faceUpBackrow("p1", { defId: "core-041", type: "Trap" }), // own face-up trap: cast
          faceUpBackrow("p1", { defId: "core-006", type: "Field Spell" }), // not a trap: nothing more
          faceDownBackrow, // cannot be named
          faceUpBackrow("p1", { defId: "core-071", type: "Field Trap" }), // own face-up trap: cast
          null,
        ],
      }),
      opponent: emptySide("p2", {
        hand: { count: 5 },
        units: [unit("p2", { defId: "core-004" }), unit("p2", { defId: HIDDEN_DEF_ID }), unit("p2", { defId: "core-012" }), null, null],
        backrow: [faceUpBackrow("p2", { defId: "core-060", type: "Trap" }), faceDownBackrow, null, null, null],
      }),
    });
  }

  it("B43 lists the hand, then every unit's death line, then the viewer's own face-up traps, each key once", () => {
    expect(voiceKeysForView(viewWith(), VOICE_LINES)).toEqual([
      "core-004-play",
      "core-005-cast",
      "core-006-cast",
      "core-012-death",
      "core-t-sheep-death",
      "core-004-death",
      "core-041-cast",
      "core-071-cast",
    ]);
  });

  it("B43 an empty board and hand want nothing preloaded", () => {
    expect(voiceKeysForView(baseView(), VOICE_LINES)).toEqual([]);
  });

  it("B43 reads only the table it is given", () => {
    const lines: VoiceLineTable = { version: 1, personas: VOICE_LINES.personas, cards: {} };
    expect(voiceKeysForView(viewWith(), lines)).toEqual([]);
  });
});

describe("voice-lines.json layout (docs/polish/2-sound.md, voice-lines.json shape)", () => {
  it("keeps personas sorted by id, cards in catalog order, 2-space JSON and a trailing newline", () => {
    const text = readFileSync(LINES_PATH, "utf8");
    const table = JSON.parse(text) as { personas: Record<string, unknown>; cards: Record<string, unknown> };
    const catalog = JSON.parse(readFileSync(CATALOG_PATH, "utf8")) as Record<string, unknown>;

    expect(Object.keys(table.personas)).toEqual(Object.keys(table.personas).sort());
    expect(Object.keys(table.cards)).toEqual(Object.keys(catalog));
    expect(text).toBe(`${JSON.stringify(table, null, 2)}\n`);
  });
});
