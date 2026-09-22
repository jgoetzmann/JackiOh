// T-bread Bread Token (SPEC §7, R37; §4.5, §5.1, §10.4, R11, R52, R74). BUILD M4-T4's token row:
// "Vanish on leaving the field; … Bread is X/X with no text; none in random pools".
//
// §7 gives this token NO radiant form, so both `describe`s below prove the same behaviour, once on
// each face, and the data block proves the faces are one face (`def.radiant` equals `def.base`).
//
// R37 and §7's "Stat overrides" bullet are the card: printed 0/0, always summoned as X/X through
// `statsOverride`, so §10.4 layer 1 (`faceOf`) has to read the override rather than the printed
// face. The X itself belongs to #18 Bread and Butter (R52), not here.

import { describe, expect, it } from "vitest";
import {
  applyEffects,
  createRng,
  defOf,
  findInstance,
  faceOf,
  isUnitToken,
  keywordsOf,
  makeContext,
  moveToZone,
  query,
  statsWithBuffs,
  type CardInstance,
  type EngineSink,
} from "@jackioh/engine";
import { summon } from "@jackioh/engine/effects";
import { base, def, radiant } from "../src/scripts/t-bread";
import { scenario, type Scenario } from "./_harness";

const SEED = "t-bread";

/**
 * §7: "always summoned as X/X through `statsOverride`", driven the way #18 Bread and Butter will
 * drive it — the shipped definition plus a `statsOverride` on the summon. #18 has no script yet, so
 * this reaches for the `summon` verb itself rather than for a card that is not this one.
 */
function summonBreadToken(
  s: Scenario,
  args: {
    statsOverride?: { attack: number; health: number };
    radiant?: boolean;
    armorOverride?: number;
  } = {},
): CardInstance {
  const state = s.state;
  const sink: EngineSink = { state, events: [], rng: createRng(state.seed, state.rngCursor) };
  applyEffects(
    [summon({ defId: def.id, player: "self", lane: 1, ...args })],
    makeContext(sink, null, { controller: "p1" }),
  );
  state.rngCursor = sink.rng.cursor;
  return s.unit("p1", 1) as CardInstance;
}

describe("T-bread Bread Token (SPEC §7, R37)", () => {
  describe("card data (§7, R37)", () => {
    it("R37 names the unnamed X/X token, gives it cost 0, printed 0/0 and no text or keywords", () => {
      expect(def.index).toBe("T-bread");
      expect(def.name).toBe("Bread Token");
      expect(def.cost).toBe(0);
      expect(def.type).toBe("Unit");
      expect(def.token).toBe(true);
      expect(def.tags).toContain("Token");
      expect(def.base.attack).toBe(0);
      expect(def.base.health).toBe(0);
      expect(def.base.keywords).toEqual([]);
      expect(def.base.text).toBe("");
    });

    it("§7 gives the Bread Token a Radiant face: X/X with Armor X (BUILD M4-T1)", () => {
      // Its X/X is a `statsOverride`, so BOTH printed faces stay 0/0; the radiant one differs by
      // printing Armor, whose `n` is a placeholder the summon fills in for the same reason.
      expect(def.radiant.attack).toBe(0);
      expect(def.radiant.keywords).toEqual([{ kind: "Armor", n: 0 }]);
      expect(def.base.keywords, "the base face prints nothing").toEqual([]);
    });

    it("§7 needs no script for either face, and the radiant Script is the base Script (R74)", () => {
      expect(base).toEqual({});
      expect(radiant).toBe(base);
    });
  });

  describe("base", () => {
    it("R37 a Bread Token summoned with statsOverride is an X/X while its printed face stays 0/0", () => {
      const s = scenario({ seed: SEED });
      const token = summonBreadToken(s, { statsOverride: { attack: 4, health: 4 } });

      expect(token.defId).toBe(def.id);
      // §10.4 layer 1 reads the override ahead of the printed face, and no later layer touches it.
      s.expectStats(token, { attack: 4, health: 4, maxHealth: 4 });
      expect(faceOf(s.state, token)).toEqual({ attack: 4, health: 4, keywords: [] });
      expect(statsWithBuffs(s.state, token)).toEqual({ attack: 4, maxHealth: 4 });
      // The definition is untouched: the X lives on the instance (§10.1), not on the card.
      expect(defOf(s.state, token.defId).base.attack).toBe(0);
      expect(defOf(s.state, token.defId).base.health).toBe(0);
    });

    it("R37 a Bread Token has no keywords and no text of its own, at any X", () => {
      const s = scenario({ seed: SEED, p1: { field: [{ def: "core-t-bread", statsOverride: { attack: 9, health: 9 } }] } });
      const token = s.unit("p1", 1) as CardInstance;

      s.expectStats(token, { attack: 9, health: 9, maxHealth: 9 });
      expect(keywordsOf(s.state, token)).toEqual([]);
      expect(defOf(s.state, token.defId).base.text).toBe("");
      expect(defOf(s.state, token.defId).radiant.text, "the radiant face does").toBe("Armor X");
    });

    it("§7 and §4.5 with no override a Bread Token is its printed 0/0, so it dies at the state check", () => {
      // The harness settles the board once after setup (§4.5), exactly as play would.
      const s = scenario({ seed: SEED, p1: { field: ["core-t-bread"] } });

      expect(s.unit("p1", 1)).toBeNull();
      // R11: it died as a unit token, so it is in no pile.
      expect(s.pile("p1", "graveyard")).toEqual([]);
      expect(s.pile("p1", "exile")).toEqual([]);
    });

    it("R11 a Bread Token that dies in combat ceases to exist and never reaches a graveyard", () => {
      const s = scenario({
        seed: SEED,
        p1: { field: [{ def: "core-t-bread", statsOverride: { attack: 3, health: 3 } }] },
        p2: { field: ["core-025"] },
      });
      const token = s.unit("p1", 1) as CardInstance;
      expect(isUnitToken(s.state, token)).toBe(true);

      s.attack(token, s.unit("p2", 1) as CardInstance);

      s.expectEvents("destroyed");
      s.expectInZone(token, "gone");
      // R11: "nothing can reach it again" — the engine's own lookup no longer finds it. (The
      // instance this test holds is a pre-`reduce` snapshot, so its own `zone` is stale; the
      // `gone` tag is asserted below, where `moveToZone` mutates the live instance in place.)
      expect(findInstance(s.state, token.id)).toBeUndefined();
      expect(s.pile("p1", "graveyard")).toEqual([]);
      expect(s.pile("p1", "exile")).toEqual([]);
    });

    it("R11 an exiled Bread Token ceases to exist rather than entering the exile pile", () => {
      const s = scenario({ seed: SEED });
      const token = summonBreadToken(s, { statsOverride: { attack: 2, health: 2 } });

      // Called directly so this test holds the instance the engine mutates (`reduce` clones).
      expect(moveToZone(s.state, token, "exile")).toBe("vanished");

      s.expectInZone(token, "gone");
      expect(token.zone.z).toBe("gone");
      expect(s.pile("p1", "exile")).toEqual([]);
    });

    it("R11 a unit token never enters a graveyard or exile, so a fixture may not put one there", () => {
      expect(() => scenario({ seed: SEED, p1: { graveyard: ["core-t-bread"] } })).toThrow(/unit token/);
      expect(() => scenario({ seed: SEED, p1: { exile: ["core-t-bread"] } })).toThrow(/unit token/);
    });

    it("§5.1 and R37 the Bread Token counts as a Token for every filter, so query hides it", () => {
      const ids = (defs: { id: string }[]): string[] => defs.map((entry) => entry.id);

      expect(ids(query({ type: "Unit" }))).not.toContain(def.id);
      expect(ids(query({ cost: 0 }))).not.toContain(def.id);
      expect(ids(query({ costRange: { min: 0, max: 0 } }))).not.toContain(def.id);
      expect(ids(query({ token: true }))).toContain(def.id);
      expect(ids(query({ index: "T-bread" }))).toEqual([def.id]);
    });

    it.todo(
      "§7, R52 and R62 #18 Bread and Butter summons this token as X/X for the TRAP's controller at " +
        "either player's end of turn with unspent mana, X = that mana (radiant 3X), and X = 0 " +
        "summons nothing — blocked on `core-018`'s script, which is not in src/scripts yet; the " +
        "`statsOverride` summon it needs is the one exercised above",
    );
  });

  // §7's "Radiant form" column reads "none", so every case above holds for a radiant instance too:
  // R74 sets the flag, and the flag selects the same face and the same (empty) Script.
  describe("radiant (§7: X/X, Armor X)", () => {
    it("§7 a radiant Bread Token summoned as X/X carries Armor X — the same X", () => {
      const s = scenario({ seed: SEED });
      const token = summonBreadToken(s, {
        radiant: true,
        statsOverride: { attack: 6, health: 6 },
        armorOverride: 6,
      });

      expect(token.radiant).toBe(true);
      s.expectStats(token, { attack: 6, health: 6, maxHealth: 6 });
      expect(faceOf(s.state, token)).toEqual({
        attack: 6,
        health: 6,
        keywords: [{ kind: "Armor", n: 6 }],
      });
      expect(keywordsOf(s.state, token)).toEqual([{ kind: "Armor", n: 6 }]);
    });

    /** Without the override the printed placeholder stands, which is Armor 0 — not Armor X. */
    it("§7 a radiant Bread Token with no armor override reads the printed Armor 0", () => {
      const s = scenario({ seed: SEED });
      const token = summonBreadToken(s, { radiant: true, statsOverride: { attack: 6, health: 6 } });

      expect(keywordsOf(s.state, token)).toEqual([{ kind: "Armor", n: 0 }]);
    });

    it("§7 a radiant Bread Token with no override is the same printed 0/0 and dies at the state check", () => {
      const s = scenario({ seed: SEED, p1: { field: [{ def: "core-t-bread", radiant: true }] } });

      expect(s.unit("p1", 1)).toBeNull();
      expect(s.pile("p1", "graveyard")).toEqual([]);
    });

    it("R11 a radiant Bread Token that leaves the field ceases to exist just as the base face does", () => {
      const s = scenario({
        seed: SEED,
        p1: { field: [{ def: "core-t-bread", radiant: true, statsOverride: { attack: 2, health: 2 } }] },
      });
      const token = s.unit("p1", 1) as CardInstance;

      expect(moveToZone(s.state, token, "graveyard")).toBe("vanished");

      s.expectInZone(token, "gone");
      expect(token.zone.z).toBe("gone");
      expect(s.pile("p1", "graveyard")).toEqual([]);
    });
  });
});
