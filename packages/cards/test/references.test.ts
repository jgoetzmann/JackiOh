// R279: a card's text links the cards and tokens it names. The catalog lists them per card
// (`refs`, by id), and this file proves the list against the texts both ways, from the catalog
// alone: every card or token a text names is in that card's `refs`, and every id in `refs` is named
// in one of the card's two texts. It also proves that every token is named by some card, except The
// Coin, which §2.1's setup deals rather than a card (R244).
//
// What "names" means is written once, here, and the client's renderer (apps/web/src/cards/refs.ts)
// reads the same rule: a card's name, or its name before a parenthesis ("Call to Chaos (Core
// Edition)" is named as "Call to Chaos"), alone or with a plural "s", standing as whole words — the
// characters either side are not letters, digits, an apostrophe or a hyphen, so "CN-Viral" does not
// name "CN-Virus" and "Mr. Vanilla" is not named by #61's "Vanilla copy".

import { describe, expect, it } from "vitest";
import type { CardDef } from "@jackioh/shared";
import { CATALOG } from "../src/catalog-data";

const ENTRIES: readonly CardDef[] = Object.values(CATALOG);

/** §2.1, R244: dealt by a rule, so no card's text names it. */
const DEALT_BY_A_RULE: readonly string[] = ["core-t-coin"];

/** The names a text may call a card by: its name, and its name before a parenthesis. */
function namesOf(def: CardDef): string[] {
  const bare = def.name.replace(/\s*\(.*\)\s*$/, "");
  return bare === def.name ? [def.name] : [def.name, bare];
}

const WORD = /[A-Za-z0-9'-]/;

/** Whether `text` names `name` as whole words, alone or plural. */
function names(text: string, name: string): boolean {
  let from = 0;
  for (;;) {
    const at = text.indexOf(name, from);
    if (at < 0) return false;
    const before = text[at - 1];
    let end = at + name.length;
    if (text[end] === "s") end += 1;
    const after = text[end];
    if ((before === undefined || !WORD.test(before)) && (after === undefined || !WORD.test(after))) return true;
    from = at + 1;
  }
}

/** Every catalog id a card's base or Radiant text names, in catalog order. */
function namedBy(card: CardDef): string[] {
  const texts = [card.base.text, card.radiant.text];
  return ENTRIES.filter((other) => namesOf(other).some((name) => texts.some((text) => names(text, name)))).map(
    (other) => other.id,
  );
}

describe("R279 the reference map (SPEC §5, §7, §10.10)", () => {
  it("R279 lists in every card's refs exactly the cards and tokens its texts name", () => {
    const wrong: string[] = [];
    for (const card of ENTRIES) {
      const expected = [...namedBy(card)].sort();
      const listed = [...(card.refs ?? [])].sort();
      if (JSON.stringify(expected) !== JSON.stringify(listed)) {
        wrong.push(`${card.id} ${card.name}: texts name [${expected.join(", ")}], refs list [${listed.join(", ")}]`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("R279 has every token named by at least one card, except The Coin, which a rule deals", () => {
    const named = new Set(ENTRIES.flatMap((card) => card.refs ?? []));
    const unnamed = ENTRIES.filter((card) => card.token && !named.has(card.id)).map((card) => card.id);
    expect(unnamed).toEqual(DEALT_BY_A_RULE);
  });

  it("R279 names a card by its name before a parenthesis, and never by a longer word", () => {
    const chaos = CATALOG["core-095"];
    expect(chaos?.refs).toContain("core-095");
    expect(names("Shuffle a CN-Viral Injection", "CN-Virus")).toBe(false);
    expect(names("summon a Vanilla copy", "Mr. Vanilla")).toBe(false);
    expect(names("fill your board with Rush Tokens; if", "Rush Token")).toBe(true);
    expect(names("your units other than Spikey Pillows have", "Spikey Pillow")).toBe(true);
  });

  it("R279 keeps an empty list out of the catalog: a card that names nothing has no refs", () => {
    const empty = ENTRIES.filter((card) => card.refs !== undefined && card.refs.length === 0).map((card) => card.id);
    expect(empty).toEqual([]);
  });
});
