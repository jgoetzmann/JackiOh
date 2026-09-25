// #83 Transmogulate (SPEC §8.4 row 83; R11, R23, R35).
//
// BUILD M4-T4's must-pass row: "Zone counts preserved; board cards replaced by same-type
// Legendaries in place; pool is exactly #52, #85, #87, #92, #93, #95, and a Field Trap becomes
// Unlicensed Experimentation (R35); radiant gives radiant cards".
//
// The board fixture covers every permanent type at once: a Unit, an Immutable Unit (R23), a Field
// Spell, a Trap and a Field Trap. The pool is asserted as the six ids R35 names, so if `query`, the
// rarities or the exclusion of #83 ever drift, these tests name the card that appeared.
//
// One count to keep in mind: Transmogulate is a Spell, so it reaches its owner's graveyard AFTER
// its own script has run (§10.5). The graveyard therefore ends one card larger than it started —
// the replacement for what was there, plus Transmogulate itself, which was in `resolving` while the
// replacements happened and so was never replaced by one of them.

import { describe, expect, it } from "vitest";
import { scenario } from "./_harness";

const TRANSMOGULATE = "core-083";

/** R35's pool, written out: "the §8 Legendary-rarity cards except #83". */
const POOL = ["core-052", "core-085", "core-087", "core-092", "core-093", "core-095"];
/** The Legendary Units in the pool: #52 Silly Silas and #92 Felinor Fiender. */
const LEGENDARY_UNITS = ["core-052", "core-092"];
/** The only Legendary Field Spell: #93 Combo-Index. */
const LEGENDARY_FIELD_SPELL = "core-093";
/** The only Legendary Trap: #85 Unlicensed Experimentation — and "Field Trap counts as Trap". */
const LEGENDARY_TRAP = "core-085";

/** Board fixtures: #11 Tempo Timmy (Unit), #8 Mr. Vanilla (Immutable Unit), #73 (Field Spell),
 *  #41 Sheepish (Trap), #18 Bread and Butter (Field Trap). */
function board(radiantFace = false) {
  const s = scenario({
    seed: "transmogulate",
    p1: {
      hand: [TRANSMOGULATE, "core-056"],
      field: ["core-011", "core-008"],
      backrow: [
        { def: "core-073", lane: 1 },
        { def: "core-041", lane: 2 },
        { def: "core-018", lane: 3 },
      ],
      library: ["core-020", "core-025"],
      graveyard: ["core-056"],
      exile: ["core-011"],
    },
    p2: { field: ["core-011"], library: ["core-020"] },
  });
  // Stands in for a missing `{ def, radiant }` form on SideSetup.hand (harness request).
  if (radiantFace) s.card(TRANSMOGULATE).radiant = true;
  return s;
}

describe("#83 Transmogulate — base", () => {
  it("R35 board cards are replaced in place by a Legendary of the same type", () => {
    const s = board().play(TRANSMOGULATE);

    // A Unit becomes a Legendary Unit, in its own lane.
    expect(LEGENDARY_UNITS).toContain(s.unit("p1", 1)?.defId);
    // A Field Spell becomes the Legendary Field Spell; a Trap becomes the Legendary Trap.
    expect(s.backrow("p1", 1)?.defId).toBe(LEGENDARY_FIELD_SPELL);
    expect(s.backrow("p1", 2)?.defId).toBe(LEGENDARY_TRAP);
    s.expectEvents("cardPlayed", "transformed");
  });

  it("R35 'Field Trap counts as Trap': a Field Trap becomes Unlicensed Experimentation", () => {
    const s = board().play(TRANSMOGULATE);

    expect(s.backrow("p1", 3)?.defId).toBe(LEGENDARY_TRAP);
  });

  it("R23 an Immutable board card stays, since this is a Transform", () => {
    const s = board();
    const immutable = s.card("core-008").id;
    s.play(TRANSMOGULATE);

    expect(s.unit("p1", 2)?.id).toBe(immutable);
    expect(s.unit("p1", 2)?.defId).toBe("core-008");
  });

  it("R35 same counts per zone, in library, graveyard and exile", () => {
    const s = board();
    const before = {
      library: s.pile("p1", "library").length,
      graveyard: s.pile("p1", "graveyard").length,
      exile: s.pile("p1", "exile").length,
    };
    s.play(TRANSMOGULATE);

    expect(s.pile("p1", "library")).toHaveLength(before.library);
    expect(s.pile("p1", "exile")).toHaveLength(before.exile);
    // Plus Transmogulate itself, which was resolving while the replacements happened.
    expect(s.pile("p1", "graveyard")).toHaveLength(before.graveyard + 1);
    expect(s.pile("p1", "graveyard").map((card) => card.defId)).toContain(TRANSMOGULATE);
  });

  it("R35 the pool is exactly #52, #85, #87, #92, #93, #95 — never Transmogulate itself", () => {
    const s = board();
    const spell = s.card(TRANSMOGULATE).id;
    s.play(TRANSMOGULATE);

    const replaced = [
      ...s.pile("p1", "library"),
      ...s.pile("p1", "exile"),
      ...s.pile("p1", "graveyard").filter((card) => card.id !== spell),
      ...[1, 2, 3, 4, 5].flatMap((lane) => {
        const unit = s.unit("p1", lane);
        const back = s.backrow("p1", lane);
        return [...(unit === null ? [] : [unit]), ...(back === null ? [] : [back])];
      }),
    ];

    for (const card of replaced) {
      // Mr. Vanilla is the one card R23 left alone.
      if (card.defId === "core-008") continue;
      expect(POOL, `${card.defId} is not in R35's pool`).toContain(card.defId);
    }
  });

  it("R35 replaced cards cease to exist: they are in no pile at all", () => {
    const s = board();
    const oldUnit = s.card("core-011").id;
    const oldLibrary = s.pile("p1", "library").map((card) => card.id);
    const oldGraveyard = s.pile("p1", "graveyard").map((card) => card.id);
    s.play(TRANSMOGULATE);

    s.expectInZone(oldUnit, "gone");
    for (const id of [...oldLibrary, ...oldGraveyard]) s.expectInZone(id, "gone");
  });

  it("§8 the four zones are library, board, GY and exile: your hand is untouched", () => {
    const s = board();
    const spare = s.hand("p1").find((card) => card.defId === "core-056")?.id ?? "";
    s.play(TRANSMOGULATE);

    s.expectInZone(spare, "hand");
    expect(s.hand("p1").map((card) => card.defId)).toEqual(["core-056"]);
  });

  it("§8 'your' library and board: the opponent keeps everything", () => {
    const s = board().play(TRANSMOGULATE);

    expect(s.unit("p2", 1)?.defId).toBe("core-011");
    expect(s.pile("p2", "library").map((card) => card.defId)).toEqual(["core-020"]);
  });

  it("base gives non-Radiant cards", () => {
    const s = board().play(TRANSMOGULATE);

    expect(s.pile("p1", "library").map((card) => card.radiant)).toEqual([false, false]);
    expect(s.unit("p1", 1)?.radiant).toBe(false);
    expect(s.backrow("p1", 1)?.radiant).toBe(false);
  });

  it.todo(
    "R13 a card dormant under a Stack is not on your board — blocked on harness support for " +
      "seeding a Stack pile (SideSetup.field cannot put two cards in one lane)",
  );
});

describe("#83 Transmogulate — radiant", () => {
  it("'Random Radiant Legendaries': every replacement is Radiant, in every zone", () => {
    const s = board(true);
    const spell = s.card(TRANSMOGULATE).id;
    s.play(TRANSMOGULATE);

    expect(s.unit("p1", 1)?.radiant).toBe(true);
    expect(s.backrow("p1", 1)?.radiant).toBe(true);
    expect(s.backrow("p1", 2)?.radiant).toBe(true);
    expect(s.backrow("p1", 3)?.radiant).toBe(true);
    expect(s.pile("p1", "library").map((card) => card.radiant)).toEqual([true, true]);
    expect(s.pile("p1", "exile").map((card) => card.radiant)).toEqual([true]);
    expect(
      s.pile("p1", "graveyard").filter((card) => card.id !== spell).map((card) => card.radiant),
    ).toEqual([true]);
  });

  it("the radiant face keeps R35's pool and its same-type board rule", () => {
    const s = board(true).play(TRANSMOGULATE);

    expect(LEGENDARY_UNITS).toContain(s.unit("p1", 1)?.defId);
    expect(s.backrow("p1", 1)?.defId).toBe(LEGENDARY_FIELD_SPELL);
    expect(s.backrow("p1", 3)?.defId).toBe(LEGENDARY_TRAP);
    for (const card of s.pile("p1", "library")) expect(POOL).toContain(card.defId);
  });

  it("R23 an Immutable board card still stays on the radiant face", () => {
    const s = board(true).play(TRANSMOGULATE);

    expect(s.unit("p1", 2)?.defId).toBe("core-008");
    // Not made Radiant either: a refused Transform changes nothing about the card.
    expect(s.unit("p1", 2)?.radiant).toBe(false);
  });
});

describe("#83 Transmogulate — R312 the owner's library list", () => {
  it("R312 every library replacement is a card its owner was never shown, so the list counts them unknown", () => {
    const s = board();
    // Before: p1's own two cards, by printed cost (R310): Pointmaster (2), then the 7/7 (4).
    expect(s.view("p1").you.ownLibrary).toEqual({
      cards: [
        { defId: "core-020", radiant: false, count: 1 },
        { defId: "core-025", radiant: false, count: 1 },
      ],
      unknown: 0,
    });

    s.play(TRANSMOGULATE);

    // The same count, none of it named: the Legendaries it rolled stay unread, even by p1.
    expect(s.view("p1").you.ownLibrary).toEqual({ cards: [], unknown: 2 });
    const mine = JSON.stringify(s.view("p1"));
    for (const card of s.pile("p1", "library")) expect(mine).not.toContain(`"${card.id}"`);
    // p2's library is untouched and still fully known to p2.
    expect(s.view("p2").you.ownLibrary).toEqual({ cards: [{ defId: "core-020", radiant: false, count: 1 }], unknown: 0 });
  });
});
