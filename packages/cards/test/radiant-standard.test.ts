// R275 and R276: the Radiant power standard (SPEC §5.2), catalog-wide.
//
// R275's standard has two halves. The stat half is mechanical, and this file holds every Unit face
// to it: a Radiant Unit's attack and health are each at least twice its base face's, a 0 staying 0
// (#1 Big D-fender, #65.1 Spikey Pillow), and a token summoned X/X (the Bread Token's printed 0/0)
// passing on its printed face because the card that summons it scales X itself. Any card allowed
// below it would be named in `STAT_EXCEPTIONS` with its reason; after the audit there is none. The
// effect half — 100–150% stronger, a broader scope, or an added rider — is a judgement, recorded
// card by card in docs/radiant-audit.md, and this file proves that document covers every entry.
//
// R276: every entry's Radiant face changes it, in its text, its stats or its keywords, so no Make
// Radiant is spent on a card that becoming Radiant leaves as it was.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { CardDef } from "@jackioh/shared";
import { CATALOG } from "../src/catalog-data";

const ENTRIES: readonly CardDef[] = Object.values(CATALOG);

/** R275: the factor a Radiant Unit's attack and health are held to. */
const STAT_FACTOR = 2;

/** R275's named exceptions to the stat half, by id, with the reason. None after the audit. */
const STAT_EXCEPTIONS: Readonly<Record<string, string>> = {};

const AUDIT = new URL("../../../docs/radiant-audit.md", import.meta.url);

describe("R275 the Radiant power standard (SPEC §5.2)", () => {
  it("R275 gives every Radiant Unit at least twice its base attack and health, a 0 staying 0", () => {
    const short: string[] = [];
    for (const card of ENTRIES) {
      if (card.type !== "Unit" || card.id in STAT_EXCEPTIONS) continue;
      const base = { attack: card.base.attack ?? 0, health: card.base.health ?? 0 };
      const radiant = { attack: card.radiant.attack ?? 0, health: card.radiant.health ?? 0 };
      for (const stat of ["attack", "health"] as const) {
        if (radiant[stat] < STAT_FACTOR * base[stat]) {
          short.push(`${card.id} ${card.name}: radiant ${stat} ${radiant[stat]} < ${STAT_FACTOR} × ${base[stat]}`);
        }
      }
    }
    expect(short).toEqual([]);
  });

  it("R275 names its exceptions, and each one is a Unit that really is below the stat half", () => {
    for (const [id, reason] of Object.entries(STAT_EXCEPTIONS)) {
      const card = CATALOG[id];
      expect(card?.type, `${id}: ${reason}`).toBe("Unit");
    }
    expect(Object.keys(STAT_EXCEPTIONS)).toEqual([]);
  });

  it("R275 is recorded card by card: docs/radiant-audit.md has one row for every catalog entry", () => {
    const audit = readFileSync(AUDIT, "utf8");
    const missing = ENTRIES.filter((card) => !audit.includes(`| ${card.index} | ${card.name} |`)).map(
      (card) => `#${card.index} ${card.name}`,
    );
    expect(missing).toEqual([]);
  });
});

describe("R276 every card has a Radiant face (SPEC §5.2)", () => {
  it("R276 changes every card by making it Radiant: text, stats or keywords differ", () => {
    const unchanged = ENTRIES.filter(
      (card) =>
        card.radiant.text === card.base.text &&
        card.radiant.attack === card.base.attack &&
        card.radiant.health === card.base.health &&
        JSON.stringify(card.radiant.keywords) === JSON.stringify(card.base.keywords),
    ).map((card) => `${card.id} ${card.name}`);
    expect(unchanged).toEqual([]);
  });

  it("R276 gives a Radiant text to every card whose base face has one", () => {
    const blank = ENTRIES.filter((card) => card.base.text !== "" && card.radiant.text === "").map((card) => card.id);
    expect(blank).toEqual([]);
  });
});
