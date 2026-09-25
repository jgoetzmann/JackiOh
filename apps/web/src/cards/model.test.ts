// Polish 6, slice B: `faceModel`, tested pure against the real catalog (docs/polish/6-cards.md,
// Surface B `model.ts` and "Tone rules", behaviours B7–B9).
//
// "Printed" is the face being shown: `def.radiant` when radiant, else `def.base`, and an embiggen
// card's base price counts as its printed cost. A missing printed value always gives "base".

import { describe, expect, it } from "vitest";

import { CATALOG } from "@jackioh/cards";
import type { CardDef, CardFace } from "@jackioh/shared";

import { fusedDef } from "../test/fixtures.ts";
import { CONCEALED_TEXT, VANILLA_TEXT } from "./inPlay.ts";
import { faceModel, type FaceModel, type FaceSource } from "./model.ts";
import { markedText } from "./radiantDiff.ts";
import { termsIn } from "./rules.ts";

const DEFS: readonly CardDef[] = Object.values(CATALOG);
const UNKNOWN_ID = "core-999";

function def(id: string): CardDef {
  const found = CATALOG[id];
  if (found === undefined) throw new Error(`the catalog has no ${id}`);
  return found;
}

function face(id: string, radiant: boolean, extra: Partial<FaceSource> = {}): FaceModel {
  return faceModel({ defId: id, def: def(id), radiant, ...extra });
}

function live(attack: number, health: number, maxHealth: number): NonNullable<FaceSource["live"]> {
  return { attack, health, maxHealth, keywords: [] };
}

function printed(card: CardDef, radiant: boolean): CardFace {
  return radiant ? card.radiant : card.base;
}

/* ------------------------------------------------------------------------------------------ B7 */

describe("B7: faceModel copies the def and picks the face", () => {
  it("B7 a base unit face: name, type, tags, rarity, printed stats, keywords, and no radiant clause", () => {
    const f = face("core-020", false);
    expect(f).toMatchObject({
      defId: "core-020",
      known: true,
      name: "Pointmaster",
      type: "Unit",
      tags: ["Human"],
      rarity: "Common",
      index: "20",
      set: "Core",
      radiant: false,
    });
    expect(f.stats).toEqual({ attack: 7, health: 2, maxHealth: 2, attackTone: "base", healthTone: "base" });
    expect(f.keywords).toEqual([{ kind: "First Strike" }]);
    expect(f.text).toEqual({ full: "First Strike", marks: [] });
  });

  it("B7 a radiant face takes stats and keywords from def.radiant, and its keyword list replaces the base one", () => {
    const f = face("core-011", true);
    expect(f.radiant).toBe(true);
    expect(f.stats).toEqual({
      attack: 6,
      health: 6,
      maxHealth: 6,
      attackTone: "base",
      healthTone: "base",
      grew: { attack: true, health: true },
    });
    expect(f.keywords).toEqual([{ kind: "Charge" }, { kind: "First Strike" }]);
    // The catalog prints the radiant face whole, so base's Rush is not printed on it (R277).
    expect(f.text.full).toBe("Charge, First Strike");
    expect(markedText(f.text.full, f.text.marks)).toEqual(["Charge"]);
  });

  it("B7 a base face prints its base text and marks nothing, even when the radiant text differs", () => {
    const f = face("core-002", false);
    expect(def("core-002").radiant.text).not.toBe(def("core-002").base.text);
    expect(f.text).toEqual({ full: "Cry: destroy target enemy non-Human unit", marks: [] });
  });

  it("R277 a radiant face that adds a keyword marks just the keyword (core-008)", () => {
    const f = face("core-008", true);
    expect(f.text.full).toBe("Immutable, Divine Shield");
    expect(markedText(f.text.full, f.text.marks)).toEqual(["Divine Shield"]);
    // Stats still come from the radiant face.
    expect(f.stats?.attack).toBe(7);
    expect(f.stats?.maxHealth).toBe(7);
  });

  it("R277 a face whose base text is empty marks the whole radiant text (core-t-felinor, core-t-bread)", () => {
    const f = face("core-t-felinor", true);
    expect(f.text).toEqual({ full: "Rush", marks: [{ start: 0, end: 4 }] });
    expect(f.stats).toEqual({
      attack: 2,
      health: 2,
      maxHealth: 2,
      attackTone: "base",
      healthTone: "base",
      grew: { attack: true, health: true },
    });
    expect(face("core-t-bread", true).text).toEqual({ full: "Armor X", marks: [{ start: 0, end: 7 }] });
    expect(face("core-t-bread", false).text).toEqual({ full: "", marks: [] });
  });

  it("B7 every catalog card, both faces: identity copied from the def, keywords and stats from the printed face", () => {
    for (const card of DEFS) {
      for (const radiant of [false, true]) {
        const where = `${card.id} radiant=${String(radiant)}`;
        const f = face(card.id, radiant);
        const shown = printed(card, radiant);

        expect(f.defId, where).toBe(card.id);
        expect(f.known, where).toBe(true);
        expect(f.name, where).toBe(card.name);
        expect(f.type, where).toBe(card.type);
        expect(f.tags, where).toEqual(card.tags);
        expect(f.rarity, where).toBe(card.rarity);
        expect(f.index, where).toBe(card.index);
        expect(f.set, where).toBe(card.set);
        expect(f.radiant, where).toBe(radiant);
        expect(f.keywords, where).toEqual(shown.keywords);
        // Each face prints its own catalog text whole; only a radiant face marks anything (R277).
        expect(f.text.full, where).toBe(shown.text);
        if (!radiant) expect(f.text.marks, where).toEqual([]);

        if (card.type === "Unit") {
          expect(f.stats, where).toEqual({
            attack: shown.attack,
            health: shown.health,
            maxHealth: shown.health,
            attackTone: "base",
            healthTone: "base",
            ...(radiant
              ? {
                  grew: {
                    attack: (card.radiant.attack ?? 0) > (card.base.attack ?? 0),
                    health: (card.radiant.health ?? 0) > (card.base.health ?? 0),
                  },
                }
              : {}),
          });
        } else {
          expect(f.stats, where).toBeNull();
        }
      }
    }
  });

  it("B7 non-units have null stats: Spell, Field Spell, Trap, Field Trap", () => {
    for (const id of ["core-005", "core-006", "core-041", "core-018"]) {
      expect(face(id, false).stats, id).toBeNull();
      expect(face(id, true).stats, id).toBeNull();
    }
  });

  it("B7 live stats and live keywords replace the printed ones", () => {
    const f = face("core-011", false, {
      live: { attack: 9, health: 4, maxHealth: 5, keywords: [{ kind: "Taunt" }, { kind: "Armor", n: 2 }] },
    });
    expect(f.stats?.attack).toBe(9);
    expect(f.stats?.health).toBe(4);
    expect(f.stats?.maxHealth).toBe(5);
    expect(f.keywords).toEqual([{ kind: "Taunt" }, { kind: "Armor", n: 2 }]);
  });

  it("B7 live keywords that are empty clear the printed keywords", () => {
    const f = face("core-056", false, { live: live(3, 2, 2) });
    expect(def("core-056").base.keywords).not.toHaveLength(0);
    expect(f.keywords).toEqual([]);
  });

  it("B7 with no def: known is false, the fallback name and type are used, rarity, index and set are null", () => {
    const f = faceModel({ defId: UNKNOWN_ID, name: "Mystery", type: "Trap", radiant: false });
    expect(f.defId).toBe(UNKNOWN_ID);
    expect(f.known).toBe(false);
    expect(f.name).toBe("Mystery");
    expect(f.type).toBe("Trap");
    expect(f.rarity).toBeNull();
    expect(f.index).toBeNull();
    expect(f.set).toBeNull();
    expect(f.stats).toBeNull();
    expect(f.keywords).toEqual([]);
    expect(f.text).toEqual({ full: "", marks: [] });
  });

  it("B7 with a def present, the def's name wins over the CardInfo name fallback", () => {
    const f = faceModel({ defId: "core-002", def: def("core-002"), name: "Wrong", radiant: false });
    expect(f.name).toBe("Bigot");
    expect(f.known).toBe(true);
  });
});

/* ------------------------------------------------------------------------------ Radiant text */

// R277: the catalog carries each Radiant face's whole text (§8's cell read by its Conventions and
// written out), and a radiant face prints it as it stands, marking the stretches the base face's
// text does not have (radiantDiff.ts). These pin the reading on real cards; radiantDiff.test.ts
// proves the diff itself.

function marksOf(id: string): string[] {
  const f = face(id, true);
  return markedText(f.text.full, f.text.marks);
}

describe("R277: a Radiant face prints its whole text and marks what differs from the base", () => {
  it("R277 a changed number is the only mark (core-044, core-053, core-013, core-047)", () => {
    expect(face("core-044", true).text.full).toBe("Deal 9 damage to a target, ignoring Armor; exile this");
    expect(marksOf("core-044")).toEqual(["9"]);
    expect(marksOf("core-053")).toEqual(["60", "60"]);
    expect(marksOf("core-013")).toEqual(["5"]);
    expect(marksOf("core-047")).toEqual(["50"]);
  });

  it("R277 a keyword line prints the radiant form's whole list and marks what it adds (core-056, core-055, core-019)", () => {
    const jilliax = face("core-056", true);
    expect(jilliax.text.full).toBe("Charge, Taunt, Lifesteal, Indestructible");
    expect(jilliax.text.full).not.toMatch(/Rush|Divine Shield/);
    expect(marksOf("core-056")).toEqual(["Charge", "Indestructible"]);
    expect(marksOf("core-055")).toEqual(["Indestructible"]);
    expect(marksOf("core-019")).toEqual(["Immutable"]);
  });

  it("R277 an added clause is marked as one phrase (core-003, core-016, core-093)", () => {
    expect(marksOf("core-003")).toEqual(["Death: summon a base Right-house defender"]);
    expect(marksOf("core-016")).toEqual(["and the units adjacent to it on its side"]);
    expect(marksOf("core-093")).toEqual(["Start of turn: add a Combo-Fodder to your hand"]);
  });

  it("R277 a word the radiant face drops is simply absent, and case alone marks nothing (core-067, core-017)", () => {
    expect(face("core-067", true).text.full).not.toContain("1-cost");
    expect(marksOf("core-067")).toEqual(["Radiant"]);
    // "Bounce all units on both sides" reappears lower-case inside the radiant Choose one.
    expect(marksOf("core-017").join(" | ")).not.toContain("bounce all units on both sides");
  });

  it("R277 every catalog radiant face prints its catalog text and marks at least one stretch the base text lacks", () => {
    for (const card of DEFS) {
      const f = face(card.id, true);
      expect(f.text.full, card.id).toBe(card.radiant.text);
      if (card.radiant.text === card.base.text) {
        expect(f.text.marks, card.id).toEqual([]);
        continue;
      }
      expect(f.text.marks.length, `${card.id} marks nothing`).toBeGreaterThan(0);
      // Every radiant keyword is printed somewhere on the face.
      const printed = termsIn(f.text.full);
      for (const keyword of card.radiant.keywords) {
        expect(printed, `${card.id} never prints its radiant keyword ${keyword.kind}`).toContain(keyword.kind);
      }
    }
  });
});

/* ------------------------------------------------------------------------------------------ B8 */

describe("B8: faceModel cost", () => {
  it("B8 a live cost below the printed price is down, above is up, equal is base", () => {
    expect(face("core-004", false, { liveCost: 0 }).cost).toEqual({ text: "0", value: "0", tone: "down", alt: null });
    expect(face("core-004", false, { liveCost: 3 }).cost).toEqual({ text: "3", value: "3", tone: "up", alt: null });
    expect(face("core-004", false, { liveCost: 1 }).cost).toEqual({ text: "1", value: "1", tone: "base", alt: null });
  });

  it("B8 with no live cost the gem shows the printed price, tone base, and value equals text", () => {
    const cost = face("core-054", false).cost;
    expect(cost).toEqual({ text: "4", value: "4", tone: "base", alt: null });
  });

  it("B8 an X card shows X while value carries the live number, and its tone is always base", () => {
    for (const liveCost of [0, 1, 5, 12]) {
      expect(face("core-024", false, { liveCost }).cost, `X at ${liveCost}`).toEqual({
        text: "X",
        value: String(liveCost),
        tone: "base",
        alt: null,
      });
    }
    // Radiant faces and other X cards alike.
    expect(face("core-074", true, { liveCost: 3 }).cost.tone).toBe("base");
    expect(face("core-098", false, { liveCost: 2 }).cost.text).toBe("X");
  });

  it("B8 an X card with no live cost has text and value X", () => {
    expect(face("core-024", false).cost).toEqual({ text: "X", value: "X", tone: "base", alt: null });
  });

  it("B8 an embiggen card shows its base price, with alt set to the embiggen price", () => {
    expect(face("core-046", false).cost).toEqual({ text: "2", value: "2", tone: "base", alt: "4" });
    expect(face("core-046", false, { liveCost: 2 }).cost).toEqual({ text: "2", value: "2", tone: "base", alt: "4" });
    expect(face("core-084", true).cost.alt).toBe("4");
  });

  it("B8 an embiggen card's gem shows the view's live number, toned against its base price, and drops the embiggen price", () => {
    // /fullsend's "your cards cost 1 less" makes one cost 1 in hand: the gem says 1, not 2.
    expect(face("core-059", false, { liveCost: 1 }).cost).toEqual({ text: "1", value: "1", tone: "down", alt: null });
    expect(face("core-059", false, { liveCost: 3 }).cost).toEqual({ text: "3", value: "3", tone: "up", alt: null });
    expect(face("core-084", false, { liveCost: 0 }).cost).toEqual({ text: "0", value: "0", tone: "down", alt: null });
  });

  it("B8 an embiggen card on the field that was paid its embiggen price shows that price, neutral", () => {
    // Played at 4 into the backrow, CardView.cost is 4: the gem says 4 in the base tone, never a red 2.
    expect(face("core-046", false, { liveCost: 4 }).cost).toEqual({ text: "4", value: "4", tone: "base", alt: null });
    expect(face("core-059", true, { liveCost: 4 }).cost).toEqual({ text: "4", value: "4", tone: "base", alt: null });
  });

  it("B8 whenever there is a live cost the gem shows it, for every catalog card that is not X", () => {
    for (const card of DEFS) {
      if (card.cost === "X") continue;
      for (const liveCost of [0, 1, 4, 7]) {
        expect(face(card.id, false, { liveCost }).cost.text, `${card.id} at ${String(liveCost)}`).toBe(String(liveCost));
      }
    }
  });

  it("B8 a card that is neither X nor embiggen has no alt", () => {
    for (const id of ["core-004", "core-024", "core-100", "core-t-bread"]) {
      expect(face(id, false, { liveCost: 0 }).cost.alt, id).toBeNull();
    }
  });

  it("B8 the radiant face keeps the printed cost", () => {
    expect(face("core-019", true, { liveCost: 3 }).cost.tone).toBe("base");
    expect(face("core-019", true, { liveCost: 2 }).cost.tone).toBe("down");
    expect(face("core-019", true).cost.text).toBe("3");
  });

  it("B8 Ceaseless Void at 0 against its printed 100 is down", () => {
    expect(face("core-100", false, { liveCost: 0 }).cost).toEqual({ text: "0", value: "0", tone: "down", alt: null });
    expect(face("core-100", false).cost.text).toBe("100");
  });

  it("B8 an unknown card's cost tone is always base", () => {
    const cost = faceModel({ defId: UNKNOWN_ID, radiant: false, liveCost: 7 }).cost;
    expect(cost.tone).toBe("base");
    expect(cost.value).toBe("7");
    expect(cost.text).toBe("7");
    expect(cost.alt).toBeNull();
  });
});

/* ------------------------------------------------------------------------------------------ B9 */

describe("B9: faceModel stat tones", () => {
  // core-013 Jlockeed Shredder-10 prints 8/10 on its base face and 16/20 on its radiant one.
  const ID = "core-013";

  it("B9 attack above the printed face is buffed, below is reduced, equal is base", () => {
    expect(face(ID, false, { live: live(9, 10, 10) }).stats?.attackTone).toBe("buffed");
    expect(face(ID, false, { live: live(7, 10, 10) }).stats?.attackTone).toBe("reduced");
    expect(face(ID, false, { live: live(8, 10, 10) }).stats?.attackTone).toBe("base");
    expect(face(ID, false, { live: live(0, 10, 10) }).stats?.attackTone).toBe("reduced");
  });

  it("B9 at full health, max health above the printed health is buffed, below is reduced, equal is base", () => {
    expect(face(ID, false, { live: live(8, 12, 12) }).stats?.healthTone).toBe("buffed");
    expect(face(ID, false, { live: live(8, 9, 9) }).stats?.healthTone).toBe("reduced");
    expect(face(ID, false, { live: live(8, 10, 10) }).stats?.healthTone).toBe("base");
  });

  it("B9 health below max health is damaged, whatever max health is", () => {
    expect(face(ID, false, { live: live(8, 9, 10) }).stats?.healthTone).toBe("damaged");
    expect(face(ID, false, { live: live(8, 11, 12) }).stats?.healthTone).toBe("damaged");
    expect(face(ID, false, { live: live(8, 3, 9) }).stats?.healthTone).toBe("damaged");
    expect(face(ID, false, { live: live(8, 0, 10) }).stats?.healthTone).toBe("damaged");
  });

  it("B9 live stats are what the stats carry", () => {
    expect(face(ID, false, { live: live(3, 2, 5) }).stats).toEqual({
      attack: 3,
      health: 2,
      maxHealth: 5,
      attackTone: "reduced",
      healthTone: "damaged",
    });
  });

  it("B9 a radiant card's tones compare with the radiant face", () => {
    // 16/20 is the radiant face exactly, and would be buffed against the base 8/10.
    expect(face(ID, true, { live: live(16, 20, 20) }).stats).toMatchObject({ attackTone: "base", healthTone: "base" });
    expect(face(ID, false, { live: live(16, 20, 20) }).stats).toMatchObject({ attackTone: "buffed", healthTone: "buffed" });
    // 8/10 is the base face exactly, and is reduced against the radiant 16/20.
    expect(face(ID, true, { live: live(8, 10, 10) }).stats).toMatchObject({ attackTone: "reduced", healthTone: "reduced" });
  });

  it("B9 with no def (an unknown card) both tones are base", () => {
    const f = faceModel({ defId: UNKNOWN_ID, type: "Unit", radiant: false, live: live(5, 9, 9) });
    expect(f.known).toBe(false);
    expect(f.stats).toEqual({ attack: 5, health: 9, maxHealth: 9, attackTone: "base", healthTone: "base" });
  });

  it("B9 a printed face with no stats gives base for both tones", () => {
    const bare: CardDef = {
      ...def(ID),
      base: { keywords: [], text: "" },
      radiant: { keywords: [], text: "" },
    };
    const f = faceModel({ defId: bare.id, def: bare, radiant: false, live: live(3, 5, 5) });
    expect(f.stats).toEqual({ attack: 3, health: 5, maxHealth: 5, attackTone: "base", healthTone: "base" });
  });

  it("B9 printed stats with no live numbers give base tones and health equal to max health", () => {
    const f = face("core-022", true);
    // R277: a printed radiant face also says which stats it raised over the base face's.
    expect(f.stats).toEqual({
      attack: 8,
      health: 12,
      maxHealth: 12,
      attackTone: "base",
      healthTone: "base",
      grew: { attack: true, health: true },
    });
  });
});

/* --------------------------------------------------------------------- faces in play (§10.10) */

describe("a face in play is the card as the view says it stands; the collection's is the card as printed", () => {
  it("a face with no `inPlay` is the collection's: printed text, no marks, nothing held beside it", () => {
    const f = face("core-089", false);
    expect(f).toMatchObject({ inPlay: false, vanilla: false, gained: [], printed: null, values: [] });
    expect(f.text.full).toBe(def("core-089").base.text);
  });

  it("R243 a hand Corpse Eater shows the stats it has grown to, toned as a buff (#89)", () => {
    const f = face("core-089", false, { liveCost: 4, inPlay: { handStats: { attack: 9, health: 11 } } });
    expect(f.stats).toEqual({ attack: 9, health: 11, maxHealth: 11, attackTone: "buffed", healthTone: "buffed" });
    // Its text and keywords are still the card's own: a meal changes numbers, not words.
    expect(f.text.full).toBe(def("core-089").base.text);
    expect(f.keywords).toEqual(def("core-089").base.keywords);
    expect(f.printed).toBeNull();
    // The collection's Corpse Eater is the printed 2/2.
    expect(face("core-089", false).stats).toMatchObject({ attack: 2, health: 2 });
  });

  it("R243 a hand Unit at its printed stats reads base, on the radiant face too", () => {
    const f = face("core-089", true, { inPlay: { handStats: { attack: 6, health: 6 } } });
    expect(f.stats).toMatchObject({ attackTone: "base", healthTone: "base" });
  });

  it("R43 a Heroic Power in play prints only the power it rolled, with its X on the gem", () => {
    const f = face("core-098", false, { liveCost: 3, inPlay: { power: { name: "recruit", x: 3 } } });
    expect(f.text).toEqual({
      full: "Indestructible. Once per turn, spend 3: Recruit a permanent. Playing it activates it once",
      marks: [],
    });
    expect(f.cost).toEqual({ text: "3", value: "3", tone: "base", alt: null });
    for (const other of ["7 random powers", "Felinor Token", "Discover a Unit", "lose 2 health"]) {
      expect(f.text.full).not.toContain(other);
    }
    // The printed list of seven is held beside it for the inspect overlays.
    expect(f.printed).toEqual({ full: def("core-098").base.text, marks: [] });
  });

  it("R43 a radiant Heroic Power prints its rolled power's radiant clause", () => {
    const f = face("core-098", true, { liveCost: 1, inPlay: { power: { name: "felinor", x: 1 } } });
    expect(f.text.full).toBe("Indestructible. Once per turn, spend 1: Summon two Felinor Tokens. Playing it activates it once");
    // R277: the rolled power is marked against the same power's base words.
    expect(markedText(f.text.full, f.text.marks)).toEqual(["two", "Tokens"]);
    expect(f.printed?.full).toBe(def("core-098").radiant.text);
  });

  it("a Heroic Power in the collection keeps the list of seven and the X on its gem", () => {
    const f = face("core-098", false);
    expect(f.text.full).toContain("gain one of 7 random powers");
    expect(f.cost.text).toBe("X");
    // In play with no power named (one that has not rolled, R43), it prints the card as printed.
    expect(face("core-098", false, { inPlay: {} }).text.full).toContain("gain one of 7 random powers");
  });

  it("Call to Chaos reads ??? in play on both faces, and keeps no printed text beside it", () => {
    for (const radiant of [false, true]) {
      const f = face("core-095", radiant, { liveCost: 4, inPlay: {} });
      expect(f.text, `radiant ${String(radiant)}`).toEqual({ full: CONCEALED_TEXT, marks: [] });
      expect(f.printed).toBeNull();
      // Everything else about it is the card's: its name, tags, rarity and cost.
      expect(f).toMatchObject({ name: "Call to Chaos (Core Edition)", tags: ["Call to Chaos"], rarity: "Legendary" });
    }
  });

  it("Call to Chaos in the collection prints its real text, both faces", () => {
    expect(face("core-095", false).text.full).toBe(def("core-095").base.text);
    expect(face("core-095", true).text.full).toContain("cast a random Call to Chaos");
  });

  it("R243 a Vanilla unit says its text is gone, and prints the keywords it still has as gained", () => {
    // #61's copy of #91 Fed Fauci: its printed Rush is gone; a granted Taunt stays (§6.3 Vanilla).
    const f = face("core-091", false, {
      live: { attack: 1, health: 6, maxHealth: 6, keywords: [{ kind: "Taunt" }] },
      inPlay: { vanilla: true },
    });
    expect(f.vanilla).toBe(true);
    expect(f.text).toEqual({ full: VANILLA_TEXT, marks: [] });
    expect(f.gained).toEqual([{ kind: "Taunt" }]);
    expect(f.printed).toEqual({ full: def("core-091").base.text, marks: [] });
  });

  it("a unit in play prints the keywords it has gained since it was printed, and only those", () => {
    // Pointmaster (First Strike) after a Plastic Surgery's Poisonous, in Defense Position (Taunt, Armor 1).
    const f = face("core-020", false, {
      live: {
        attack: 10,
        health: 5,
        maxHealth: 5,
        keywords: [{ kind: "First Strike" }, { kind: "Poisonous" }, { kind: "Taunt" }, { kind: "Armor", n: 1 }],
      },
      inPlay: {},
    });
    expect(f.gained).toEqual([{ kind: "Poisonous" }, { kind: "Taunt" }, { kind: "Armor", n: 1 }]);
    expect(f.text.full).toBe("First Strike");
    expect(f.printed).toBeNull();
  });

  it("R243 a fused definition prints its own name, tags, keywords, stats and a line of text per ingredient", () => {
    const fused = fusedDef([def("core-011"), def("core-089")]);
    const f = faceModel({ defId: fused.id, def: fused, radiant: false, liveCost: 4, inPlay: {} });
    expect(f).toMatchObject({ known: true, name: "Tempo Timmy + Corpse Eater", type: "Unit", tags: ["Human"] });
    expect(f.text.full).toBe(`${def("core-011").base.text}\n${def("core-089").base.text}`);
    expect(f.keywords.map((keyword) => keyword.kind)).toEqual(["Rush", "First Strike"]);
    expect(f.stats).toMatchObject({ attack: 5, health: 5 });
  });

  it("R102 R277 a radiant fused face marks each ingredient's radiant line against its own base line", () => {
    const fused = fusedDef([def("core-011"), def("core-002")]);
    const f = faceModel({ defId: fused.id, def: fused, radiant: true, inPlay: {} });
    expect(f.text.full.split("\n")).toEqual([def("core-011").radiant.text, def("core-002").radiant.text]);
    // Tempo Timmy's Charge, and Bigot's "all … units", each against its own base line.
    expect(markedText(f.text.full, f.text.marks)).toEqual(["Charge", "all", "units"]);
  });

  it("R280 a face in play carries the values its view names; the collection's carries none", () => {
    const preview = [{ label: "Fib(cost+1)", value: 2 }];
    expect(face("core-031", false, { liveCost: 2, inPlay: { preview } }).values).toEqual(preview);
    expect(face("core-031", false).values).toEqual([]);
    // A card whose words in play are not its printed ones prints no value for a formula it hides.
    expect(face("core-095", false, { inPlay: { preview } }).values).toEqual([]);
  });

  it("R279 a face lists the cards its definition names, in the collection and in play", () => {
    expect(face("core-090", true).refs).toEqual(["core-090-1"]);
    expect(face("core-041", false, { inPlay: {} }).refs).toEqual(["core-t-sheep", "core-055"]);
    expect(face("core-002", false).refs).toEqual([]);
  });
});
