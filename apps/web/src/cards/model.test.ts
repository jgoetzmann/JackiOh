// Polish 6, slice B: `faceModel`, tested pure against the real catalog (docs/polish/6-cards.md,
// Surface B `model.ts` and "Tone rules", behaviours B7–B9).
//
// "Printed" is the face being shown: `def.radiant` when radiant, else `def.base`, and an embiggen
// card's base price counts as its printed cost. A missing printed value always gives "base".

import { describe, expect, it } from "vitest";

import { CATALOG } from "@jackioh/cards";
import { KEYWORD_KINDS, type CardDef, type CardFace } from "@jackioh/shared";

import { faceModel, type FaceModel, type FaceSource } from "./model.ts";
import { splitKeywordLine } from "./radiantText.ts";
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
    expect(f.text).toEqual({ base: "First Strike", radiant: null });
  });

  it("B7 a radiant face takes stats and keywords from def.radiant, and its keyword list replaces the base one", () => {
    const f = face("core-011", true);
    expect(f.radiant).toBe(true);
    expect(f.stats).toEqual({ attack: 6, health: 6, maxHealth: 6, attackTone: "base", healthTone: "base" });
    expect(f.keywords).toEqual([{ kind: "Charge" }, { kind: "First Strike" }]);
    // §8: "a cell that lists keywords without 'Plus' gives the radiant form's complete keyword
    // list", so base's Rush is not printed on the radiant face.
    expect(f.text).toEqual({ base: "Charge, First Strike", radiant: null });
  });

  it("B7 a base face never carries a radiant clause, even when the radiant cell differs", () => {
    const f = face("core-002", false);
    expect(def("core-002").radiant.text).not.toBe(def("core-002").base.text);
    expect(f.text).toEqual({ base: "Cry: destroy target enemy non-Human unit", radiant: null });
  });

  it("B7 the radiant clause is null when the radiant cell equals the base text (core-008)", () => {
    const f = face("core-008", true);
    expect(f.text).toEqual({ base: "Immutable", radiant: null });
    // Stats still come from the radiant face.
    expect(f.stats?.attack).toBe(7);
    expect(f.stats?.maxHealth).toBe(7);
  });

  it("B7 the radiant clause is null when the radiant cell is empty (core-t-felinor)", () => {
    const f = face("core-t-felinor", true);
    expect(f.text).toEqual({ base: "", radiant: null });
    expect(f.stats).toEqual({ attack: 2, health: 2, maxHealth: 2, attackTone: "base", healthTone: "base" });
  });

  it("B7 an empty base text does not suppress a non-empty radiant cell (core-t-bread)", () => {
    // The cell is a keyword line, so it prints as the radiant form's keyword line.
    expect(face("core-t-bread", true).text).toEqual({ base: "Armor X", radiant: null });
    expect(face("core-t-bread", false).text).toEqual({ base: "", radiant: null });
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
        // A base face prints its text; a radiant face's reading is the "Radiant text" block below.
        if (!radiant) expect(f.text, where).toEqual({ base: card.base.text, radiant: null });
        const unchanged = card.radiant.text === "" || card.radiant.text === card.base.text;
        if (radiant && unchanged) expect(f.text, where).toEqual({ base: card.base.text, radiant: null });

        if (card.type === "Unit") {
          expect(f.stats, where).toEqual({
            attack: shown.attack,
            health: shown.health,
            maxHealth: shown.health,
            attackTone: "base",
            healthTone: "base",
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
    expect(f.text.radiant).toBeNull();
  });

  it("B7 with a def present, the def's name wins over the CardInfo name fallback", () => {
    const f = faceModel({ defId: "core-002", def: def("core-002"), name: "Wrong", radiant: false });
    expect(f.name).toBe("Bigot");
    expect(f.known).toBe(true);
  });
});

/* ------------------------------------------------------------------------------ Radiant text */

// SPEC §8's reading rule for a Radiant cell: "a cell that lists keywords without 'Plus' gives the
// radiant form's complete keyword list; 'Plus X' adds keyword X to the base keywords; a cell that
// names no keywords keeps the base keywords. A clause the cell restates replaces the base version
// and every base clause it does not restate is kept". A radiant face prints that reading, never
// the base text and the whole cell one after the other.

/** Everything a face prints in its rules box, as one string. */
function printedText(f: FaceModel): string {
  return f.text.radiant === null ? f.text.base : `${f.text.base} ${f.text.radiant}`;
}

/** The §6.1 keyword kinds a text's opening keyword line names ("Charge, Taunt; …" → Charge, Taunt). */
function keywordLineKinds(text: string): string[] {
  return splitKeywordLine(text)
    .terms.map((term) => term.term)
    .filter((term) => (KEYWORD_KINDS as readonly string[]).includes(term));
}

describe("B7: a Radiant face reads its cell by SPEC §8's rule", () => {
  it("B7 a keyword list without Plus is the complete list: base keywords it drops are not printed (core-056, core-025, core-011)", () => {
    const jilliax = face("core-056", true);
    expect(jilliax.text).toEqual({ base: "Charge, Taunt, Lifesteal, Indestructible", radiant: null });
    expect(printedText(jilliax)).not.toMatch(/Rush|Divine Shield/);
    expect(face("core-025", true).text).toEqual({ base: "Indestructible", radiant: null });
    expect(printedText(face("core-025", true))).not.toContain("Armor 7");
    expect(face("core-011", true).text).toEqual({ base: "Charge, First Strike", radiant: null });
  });

  it("B7 a keyword line with more to say keeps the base clauses after it (core-019, core-045, core-092, core-009, core-050)", () => {
    expect(face("core-019", true).text).toEqual({ base: "Taunt, Immutable; End of turn: heal to full", radiant: null });
    expect(face("core-045", true).text).toEqual({
      base: "Charge, Armor 1; may attack and switch position in the same turn",
      radiant: null,
    });
    expect(face("core-092", true).text.base).toMatch(/^Stack, Charge\. Stats = printed plus/);
    // A base text with no keyword line gains one at the front.
    expect(face("core-009", true).text).toEqual({ base: "Armor 1. Start of turn: every enemy unit attacks this", radiant: null });
    expect(face("core-050", true).text.base).toMatch(/^Divine Shield\. Cry: choose an enemy permanent/);
  });

  it("B7 Plus adds to the base keywords (core-055, core-066, core-100)", () => {
    expect(face("core-055", true).text).toEqual({ base: "Tribute 3, Armor 3, Taunt, Indestructible; may tribute enemy units", radiant: null });
    expect(face("core-066", true).text).toEqual({ base: "Tribute 1, Indestructible, Immutable", radiant: null });
    expect(face("core-100", true).text.base).toMatch(/^Charge\. Cry: exile all other permanents/);
    expect(face("core-100", true).text.radiant).toBeNull();
  });

  it("B7 a cell that names no keywords drops a base keyword the radiant form lacks (core-086's Can't attack)", () => {
    expect(def("core-086").radiant.keywords).toEqual([]);
    const f = face("core-086", true);
    expect(f.text).toEqual({ base: "Death: steal all enemy units", radiant: "Can attack" });
    expect(printedText(f)).not.toContain("Can't attack");
  });

  it("B7 a restated clause replaces the base version (core-002, core-015, core-046, core-010, core-030, core-007)", () => {
    expect(face("core-002", true).text).toEqual({ base: "", radiant: "Cry: destroy all enemy non-Human units" });
    // Three Rush Tokens, not one and then three more.
    expect(face("core-015", true).text).toEqual({ base: "", radiant: "Cry: summon 3 Rush Tokens" });
    // §8 #46: the radiant form hits enemy units only.
    expect(face("core-046", true).text).toEqual({ base: "", radiant: "Aura: enemy units −4/−4 (paid 4: −10/−10)" });
    expect(printedText(face("core-046", true))).not.toContain("all units");
    expect(face("core-010", true).text).toEqual({ base: "", radiant: "Combo 3: draw 6" });
    expect(face("core-030", true).text).toEqual({ base: "", radiant: "Cry: draw both" });
    expect(face("core-007", true).text).toEqual({ base: "", radiant: "Cry: Discover a 3-cost card; it costs 1 less" });
  });

  it("B7 a restated clause replaces only its own sentence; the others are kept (core-022, core-065-1)", () => {
    expect(face("core-022", true).text).toEqual({
      base: "Cry: Tribute one of your other permanents and remember it.",
      radiant: "Death: fill your board with copies",
    });
    expect(face("core-065-1", true).text).toEqual({
      base: "Cannot be in Defense Position.",
      radiant: "Aura: your non-Spikey-Pillow units have −2 attack",
    });
  });

  it("B7 a new clause or a changed number follows the base text (core-003, core-004, core-058, core-093)", () => {
    expect(face("core-003", true).text).toEqual({
      base: "Taunt, Divine Shield, Reborn",
      radiant: "Death: summon a base Right-house defender",
    });
    expect(face("core-004", true).text).toEqual({
      base: def("core-004").base.text,
      radiant: "7 coins; +2 per heads, +2 per tails",
    });
    // "same" only says the rest is kept, so it is not printed.
    expect(face("core-058", true).text).toEqual({ base: "Start of turn: summon a Rush Token", radiant: "Aura: your Rush Tokens +3/+3" });
    expect(face("core-093", true).text.radiant).toBe("Start of turn: add a Combo-Fodder to your hand");
    expect(face("core-093", true).text.base).toBe(def("core-093").base.text);
  });

  it("B7 a cell that is only a number changes only that number: the clause restated with it, never a stray number (core-028, core-044, core-047, core-053)", () => {
    // Integration QA: radiant Reno printed "set it to 30", a gold rule, and then just "60".
    expect(face("core-053", true).text).toEqual({ base: "", radiant: "Cry: if your hero is below 60, set it to 60" });
    expect(face("core-044", true).text).toEqual({ base: "", radiant: "Deal 9 damage to a target, ignoring Armor; exile this" });
    expect(face("core-047", true).text).toEqual({ base: "", radiant: "Heal a target 50" });
    expect(face("core-028", true).text).toEqual({
      base: "",
      radiant: "5 random cards among your library, hand and field become Radiant",
    });
    for (const id of ["core-028", "core-044", "core-047", "core-053"]) {
      expect(face(id, true).text.radiant, id).not.toMatch(/^\d+$/);
    }
  });

  it("B7 'Same' alone prints the base text once (core-012), and a re-spelled token line prints once (core-t-rush)", () => {
    expect(face("core-012", true).text).toEqual({ base: "Cry: summon a copy of this unit", radiant: null });
    expect(face("core-t-rush", true).text).toEqual({ base: "Rush", radiant: null });
  });

  it("B7 every catalog radiant face: its keyword line names only the radiant form's keywords, and every radiant keyword is printed", () => {
    for (const card of DEFS) {
      const f = face(card.id, true);
      const radiantKinds = card.radiant.keywords.map((keyword) => keyword.kind);
      for (const kind of keywordLineKinds(f.text.base)) {
        expect(radiantKinds, `${card.id} prints ${kind} in its keyword line`).toContain(kind);
      }
      const printed = termsIn(printedText(f));
      for (const kind of radiantKinds) {
        expect(printed, `${card.id} never prints its radiant keyword ${kind}`).toContain(kind);
      }
      // A keyword only the base form has is never in the radiant face's keyword line.
      for (const keyword of card.base.keywords) {
        if (radiantKinds.includes(keyword.kind)) continue;
        expect(keywordLineKinds(f.text.base), `${card.id} keeps base ${keyword.kind}`).not.toContain(keyword.kind);
      }
    }
  });

  it("B7 every catalog radiant face: no clause is printed twice, and a trigger the cell restates is printed once", () => {
    for (const card of DEFS) {
      const f = face(card.id, true);
      if (f.text.radiant === null) continue;
      expect(f.text.base, card.id).not.toContain(f.text.radiant);
      const trigger = /^(Cry|Death|Aura|Combo \d+|Start of turn|End of turn):/.exec(f.text.radiant)?.[0];
      if (trigger === undefined) continue;
      expect(f.text.base.includes(trigger), `${card.id} prints ${trigger} in both parts`).toBe(false);
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
    expect(f.stats).toEqual({ attack: 8, health: 12, maxHealth: 12, attackTone: "base", healthTone: "base" });
  });
});
