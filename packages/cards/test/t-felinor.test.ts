// T-felinor Felinor Token (SPEC §7; §3.2, §5.1, R11, R64, R74). BUILD M4-T4's token row: "Vanish on
// leaving the field; … none in random pools".
//
// §7 gives this token a Radiant face that is data only: 2/2 with Rush (R275: double the stats, and
// a keyword-only unit — here a unit with none — adds a keyword). The radiant Script is still the
// base Script, so both `describe`s below prove the shared behaviour on each face, and the radiant
// one adds Rush's.
//
// The token's whole point beyond its 1/1 is the Felinor TAG, so the tag is proved twice: as catalog
// data, and through #43 Big Felinor, whose "destroy all non-Felinor units" has to spare it (the same
// tag is what #92 Felinor Fiender's `setStat` counts, R39).

import { describe, expect, it } from "vitest";
import {
  applyEffects,
  createRng,
  defOf,
  findInstance,
  isUnitToken,
  keywordsOf,
  makeContext,
  moveToZone,
  query,
  type CardInstance,
  type EngineSink,
} from "@jackioh/engine";
import { summon } from "@jackioh/engine/effects";
import { base, def, radiant } from "../src/scripts/t-felinor";
import { scenario, type Scenario } from "./_harness";

const SEED = "t-felinor";
const LANES = [1, 2, 3, 4, 5];

/**
 * A Felinor Token summoned into p1's lane 1 this turn, the way #62 and #98 summon it — through the
 * `summon` verb — so it is summoning sick (§4.1). The radiant face comes from the flag on the
 * summon, which no Core card sets for this token, so the verb is reached directly (t-rush.test.ts
 * does the same for its stat overrides).
 */
function summonFelinorToken(s: Scenario, radiantFace: boolean): CardInstance {
  const state = s.state;
  const sink: EngineSink = { state, events: [], rng: createRng(state.seed, state.rngCursor) };
  applyEffects(
    [summon({ defId: def.id, player: "self", lane: 1, radiant: radiantFace })],
    makeContext(sink, null, { controller: "p1" }),
  );
  state.rngCursor = sink.rng.cursor;
  const token = s.unit("p1", 1);
  expect(token, "the summon should have put a Felinor Token in p1's lane 1").not.toBeNull();
  return token as CardInstance;
}

describe("T-felinor Felinor Token (SPEC §7)", () => {
  describe("card data (§7)", () => {
    it("§7 prints a 1-cost Unit/Felinor Token with 1/1, no keywords and no text", () => {
      expect(def.index).toBe("T-felinor");
      expect(def.cost).toBe(1);
      expect(def.type).toBe("Unit");
      expect(def.token).toBe(true);
      expect(def.tags).toContain("Felinor");
      expect(def.tags).toContain("Token");
      expect(def.base.attack).toBe(1);
      expect(def.base.health).toBe(1);
      expect(def.base.keywords).toEqual([]);
      expect(def.base.text).toBe("");
    });

    it("§7 R275 gives the Felinor Token a Radiant face: 2/2 with Rush (BUILD M4-T1)", () => {
      expect(def.radiant.attack).toBe(2);
      expect(def.radiant.health).toBe(2);
      expect(def.radiant.keywords).toEqual([{ kind: "Rush" }]);
      expect(def.base.attack, "and the base face is untouched at 1/1").toBe(1);
      expect(def.base.keywords, "with no keywords").toEqual([]);
    });

    it("§7 needs no script for either face, and the radiant Script is the base Script (R74)", () => {
      expect(base).toEqual({});
      expect(radiant).toBe(base);
    });
  });

  describe("base", () => {
    it("§7 and R64 #62 fills every empty unit zone with 1/1 Felinor Tokens", () => {
      const s = scenario({ seed: SEED, p1: { hand: ["core-062"] } });

      s.play("core-062");

      for (const lane of LANES) {
        const token = s.unit("p1", lane);
        expect(token?.defId, `lane ${lane} should hold a Felinor Token`).toBe(def.id);
        s.expectStats(token as CardInstance, { attack: 1, health: 1, maxHealth: 1 });
        expect(keywordsOf(s.state, token as CardInstance)).toEqual([]);
      }
    });

    it("§7 the Felinor Token carries the Felinor tag, so #43's non-Felinor sweep spares it", () => {
      const s = scenario({
        seed: SEED,
        p1: { hand: ["core-043"], field: ["core-t-felinor", "core-025"] },
        p2: { field: ["core-025"] },
      });
      const token = s.unit("p1", 1) as CardInstance;
      const ally = s.unit("p1", 2) as CardInstance;
      const enemy = s.unit("p2", 1) as CardInstance;
      expect(defOf(s.state, token.defId).tags).toContain("Felinor");

      // Base #43: "Cry: destroy all non-Felinor units on both sides".
      s.play("core-043");

      s.expectInZone(token, "field");
      s.expectStats(token, { attack: 1, health: 1, maxHealth: 1 });
      s.expectInZone(ally, "graveyard");
      s.expectInZone(enemy, "graveyard");
      s.expectInZone("core-043", "field");
    });

    it("R11 a Felinor Token that dies in combat ceases to exist and never reaches a graveyard", () => {
      const s = scenario({ seed: SEED, p1: { field: ["core-t-felinor"] }, p2: { field: ["core-025"] } });
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

    it('R11 and §3.2 "Bounce all units clears them": a bounced Felinor Token reaches no hand', () => {
      const s = scenario({ seed: SEED, p1: { field: ["core-t-felinor"] } });
      const token = s.unit("p1", 1) as CardInstance;

      // Called directly so this test holds the instance the engine mutates (`reduce` clones).
      expect(moveToZone(s.state, token, "hand")).toBe("vanished");

      s.expectInZone(token, "gone");
      expect(token.zone.z).toBe("gone");
      expect(s.hand("p1")).toEqual([]);
      expect(s.unit("p1", 1)).toBeNull();
    });

    it("R11 a unit token never enters a graveyard or exile, so a fixture may not put one there", () => {
      expect(() => scenario({ seed: SEED, p1: { graveyard: ["core-t-felinor"] } })).toThrow(/unit token/);
      expect(() => scenario({ seed: SEED, p1: { exile: ["core-t-felinor"] } })).toThrow(/unit token/);
    });

    it("§5.1 and §7 a Felinor pool never offers the token unless it also asks for tokens", () => {
      const ids = (defs: { id: string }[]): string[] => defs.map((entry) => entry.id);

      expect(ids(query({ tags: ["Felinor"] }))).not.toContain(def.id);
      expect(ids(query({ type: "Unit" }))).not.toContain(def.id);
      expect(ids(query({ tags: ["Felinor", "Token"] }))).toContain(def.id);
      expect(ids(query({ token: true }))).toContain(def.id);
      expect(ids(query({ index: "T-felinor" }))).toEqual([def.id]);
    });
  });

  // §7's radiant face is data: R74 sets the flag, and the flag selects the 2/2 Rush face and the same
  // (empty) Script. Every base case holds for a radiant instance, and Rush is added.
  describe("radiant (§7: 2/2, Rush)", () => {
    it("R74 R275 a radiant Felinor Token is a 2/2 with Rush, and keeps the Felinor tag", () => {
      const s = scenario({ seed: SEED, p1: { field: [{ def: "core-t-felinor", radiant: true }] } });
      const token = s.unit("p1", 1) as CardInstance;

      expect(token.radiant).toBe(true);
      s.expectStats(token, { attack: 2, health: 2, maxHealth: 2 });
      expect(keywordsOf(s.state, token)).toEqual([{ kind: "Rush" }]);
      expect(defOf(s.state, token.defId).tags).toContain("Felinor");
    });

    it("R275 Rush (§6.1): summoned this turn, a radiant Felinor Token may attack a unit but not the hero", () => {
      // #4 Gary is a 1/1 with a Cry and nothing else: inert on a `field` setup.
      const s = scenario({ seed: SEED, p1: { hand: ["core-005"] }, p2: { field: ["core-004"], hand: ["core-005"] } });
      const token = summonFelinorToken(s, true);
      const gary = s.unit("p2", 1) as CardInstance;

      expect(() => s.attack(token, "hero")).toThrow();
      s.attack(token, gary);
      s.expectInZone(gary, "graveyard");
      s.expectStats(token, { health: 1 });
    });

    it("§4.1 the base face has no Rush: summoned this turn, it may attack nothing", () => {
      const s = scenario({ seed: SEED, p1: { hand: ["core-005"] }, p2: { field: ["core-004"], hand: ["core-005"] } });
      const token = summonFelinorToken(s, false);

      expect(() => s.attack(token, s.unit("p2", 1) as CardInstance)).toThrow();
      expect(() => s.attack(token, "hero")).toThrow();
    });

    it("§7 a radiant Felinor Token is spared by #43's non-Felinor sweep exactly as the base face is", () => {
      const s = scenario({
        seed: SEED,
        p1: { hand: ["core-043"], field: [{ def: "core-t-felinor", radiant: true }, { def: "core-025" }] },
      });
      const token = s.unit("p1", 1) as CardInstance;
      const ally = s.unit("p1", 2) as CardInstance;

      s.play("core-043");

      s.expectInZone(token, "field");
      s.expectInZone(ally, "graveyard");
    });

    it("R11 a radiant Felinor Token that leaves the field ceases to exist just as the base face does", () => {
      const s = scenario({ seed: SEED, p1: { field: [{ def: "core-t-felinor", radiant: true }] } });
      const token = s.unit("p1", 1) as CardInstance;

      expect(moveToZone(s.state, token, "exile")).toBe("vanished");

      s.expectInZone(token, "gone");
      expect(token.zone.z).toBe("gone");
      expect(s.pile("p1", "exile")).toEqual([]);
    });
  });
});
