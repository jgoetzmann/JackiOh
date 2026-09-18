// T-rush Rush Token (SPEC §7; R11, R74; §3.2, §5.1, §10.4). BUILD M4-T4's token row: "Vanish on
// leaving the field; … none in random pools".
//
// §7 gives this token NO radiant form, so the two `describe`s below prove the same behaviour twice,
// once on each face, and the data block proves the two faces really are the same face
// (`def.radiant` equals `def.base`, BUILD M4-T1, and the radiant Script is the base Script).
//
// R11 has two halves and each gets its own case: a unit token leaving the FIELD, and a unit-token
// CARD leaving a hand or library other than by being drawn or played (#75 Infinite Reserves).

import { describe, expect, it } from "vitest";
import {
  applyEffects,
  createRng,
  defOf,
  faceOf,
  isUnitToken,
  keywordsOf,
  makeContext,
  moveToZone,
  query,
  unitHas,
  unitView,
  type CardInstance,
  type EngineSink,
} from "@jackioh/engine";
import { summon } from "@jackioh/engine/effects";
import { base, def, radiant } from "../src/scripts/t-rush";
import { scenario, type Scenario } from "./_harness";

const SEED = "t-rush";

/**
 * §7's "Stat overrides" bullet, driven the way #74 Adaptive UI and #95 Call to Chaos drive it: the
 * shipped token definition plus a `statsOverride` on the summon. Their scripts own that call, so
 * this reaches for the `summon` verb directly rather than for a card that is not this one; the
 * harness has no `statsOverride` in `FieldSetup`, which is reported as a harness request.
 */
function summonRushToken(
  s: Scenario,
  args: { statsOverride?: { attack: number; health: number }; radiant?: boolean } = {},
): CardInstance {
  const state = s.state;
  const sink: EngineSink = { state, events: [], rng: createRng(state.seed, state.rngCursor) };
  applyEffects([summon({ defId: def.id, player: "self", lane: 1, ...args })], makeContext(sink, null, { controller: "p1" }));
  state.rngCursor = sink.rng.cursor;
  const token = s.unit("p1", 1);
  expect(token, "the summon should have put a Rush Token in p1's lane 1").not.toBeNull();
  return token as CardInstance;
}

describe("T-rush Rush Token (SPEC §7)", () => {
  describe("card data (§7)", () => {
    it("§7 prints a 1-cost Unit Token with 3/3 and Rush", () => {
      expect(def.index).toBe("T-rush");
      expect(def.cost).toBe(1);
      expect(def.type).toBe("Unit");
      expect(def.token).toBe(true);
      expect(def.tags).toContain("Token");
      expect(def.base.attack).toBe(3);
      expect(def.base.health).toBe(3);
      expect(def.base.keywords).toEqual([{ kind: "Rush" }]);
    });

    it("§7 gives the Rush Token no radiant form, so def.radiant equals def.base (BUILD M4-T1)", () => {
      expect(def.radiant).toEqual(def.base);
    });

    it("§7 needs no script for either face, and the radiant Script is the base Script (R74)", () => {
      expect(base).toEqual({});
      expect(radiant).toBe(base);
    });
  });

  describe("base", () => {
    it("§7 a Rush Token summoned by #15 is a 3/3 whose Rush comes through unitView (§10.4 layer 1)", () => {
      const s = scenario({ seed: SEED, p1: { hand: ["core-015"] } });
      s.play("core-015");

      // #15 takes the leftmost free zone itself, so its Cry's token lands in lane 2 (R64).
      const token = s.unit("p1", 2);
      expect(token?.defId).toBe(def.id);
      s.expectStats(token as CardInstance, { attack: 3, health: 3, maxHealth: 3 });
      expect(unitView(s.state, token as CardInstance).keywords).toContainEqual({ kind: "Rush" });
      expect(unitHas(s.state, token as CardInstance, "Rush")).toBe(true);
      s.expectEvents("cardPlayed", "summoned");
    });

    it('§7 "Stat overrides": a Rush Token summoned as 5/5 (#95) shows 5/5 and keeps Rush and cost 1', () => {
      const s = scenario({ seed: SEED });
      const token = summonRushToken(s, { statsOverride: { attack: 5, health: 5 } });

      s.expectStats(token, { attack: 5, health: 5, maxHealth: 5 });
      // §10.4 layer 1 reads the override ahead of the printed face; the def is untouched.
      expect(faceOf(s.state, token)).toEqual({ attack: 5, health: 5, keywords: [{ kind: "Rush" }] });
      expect(def.base.attack).toBe(3);
      expect(unitHas(s.state, token, "Rush")).toBe(true);
      expect(defOf(s.state, token.defId).cost).toBe(1);
    });

    it("R11 a Rush Token that dies in combat ceases to exist and never reaches a graveyard or exile", () => {
      const s = scenario({ seed: SEED, p1: { field: ["core-t-rush"] }, p2: { field: ["core-025"] } });
      const token = s.unit("p1", 1) as CardInstance;
      expect(isUnitToken(s.state, token)).toBe(true);

      // 4-mana 7/7 with Armor 7: the token's 3 is absorbed (R63) and the 7 back kills it.
      s.attack(token, s.unit("p2", 1) as CardInstance);

      s.expectEvents("destroyed");
      s.expectInZone(token, "gone");
      expect(s.pile("p1", "graveyard")).toEqual([]);
      expect(s.pile("p1", "exile")).toEqual([]);
      expect(s.unit("p1", 1)).toBeNull();
    });

    it("R11 and §10.1 a vanished Rush Token is in no pile and its zone says so, tagged `gone`", () => {
      const s = scenario({ seed: SEED, p1: { field: ["core-t-rush"] } });
      const token = s.unit("p1", 1) as CardInstance;

      // `moveToZone` is called directly so the instance this test holds IS the one the engine
      // mutates (`reduce` clones the state, which would leave a stale snapshot behind).
      const result = moveToZone(s.state, token, "graveyard");

      expect(result).toBe("vanished");
      s.expectInZone(token, "gone");
      expect(s.pile("p1", "graveyard")).toEqual([]);
      // R11: "A card that has ceased to exist is in no pile and its zone says so, tagged `gone`
      // (§10.1)". `zones.ts` writes `{ z: "exile" }` instead, which is the engine gap this asserts.
      expect(token.zone.z).toBe("gone");
    });

    it("R11 a unit token never enters a graveyard, so a fixture may not put one there", () => {
      expect(() => scenario({ seed: SEED, p1: { graveyard: ["core-t-rush"] } })).toThrow(/unit token/);
      expect(() => scenario({ seed: SEED, p1: { exile: ["core-t-rush"] } })).toThrow(/unit token/);
    });

    it("R11 a Rush Token CARD sits in a library and a hand, and is drawn and played normally (#75)", () => {
      const s = scenario({ seed: SEED, p1: { hand: ["core-015"], library: ["core-t-rush"] } });
      const card = s.pile("p1", "library")[0] as CardInstance;
      s.expectInZone(card, "library");

      s.startTurn();
      s.expectInZone(card, "hand");

      s.play(card);
      s.expectInZone(card, "field");
      s.expectStats(card, { attack: 3, health: 3, maxHealth: 3 });
    });

    it("R11 a Rush Token card leaving a hand any other way ceases to exist, burning included", () => {
      const s = scenario({ seed: SEED, p1: { hand: ["core-t-rush"] } });
      const card = s.hand("p1")[0] as CardInstance;
      s.expectInZone(card, "hand");

      const result = moveToZone(s.state, card, "graveyard");

      expect(result).toBe("vanished");
      s.expectInZone(card, "gone");
      expect(s.pile("p1", "graveyard")).toEqual([]);
      expect(s.hand("p1")).toEqual([]);
    });

    it("§5.1 and §7 query never offers the Rush Token unless the pool names tokens", () => {
      const ids = (defs: { id: string }[]): string[] => defs.map((entry) => entry.id);

      expect(ids(query({ type: "Unit" }))).not.toContain(def.id);
      expect(ids(query({ cost: 1 }))).not.toContain(def.id);
      expect(ids(query({ token: true }))).toContain(def.id);
      expect(ids(query({ tags: ["Token"] }))).toContain(def.id);
      expect(ids(query({ index: "T-rush" }))).toEqual([def.id]);
    });
  });

  // §7's "Radiant form" column reads "none" for this token, so every case above holds unchanged
  // for a radiant instance: R74 sets the flag and the flag selects the same face and the same Script.
  describe("radiant (§7: none — the radiant face is the base face)", () => {
    it("R74 a radiant Rush Token still reads 3/3 with Rush, exactly as the base face does", () => {
      const s = scenario({ seed: SEED, p1: { field: [{ def: "core-t-rush", radiant: true }] } });
      const token = s.unit("p1", 1) as CardInstance;

      expect(token.radiant).toBe(true);
      s.expectStats(token, { attack: 3, health: 3, maxHealth: 3 });
      expect(faceOf(s.state, token)).toEqual(faceOf(s.state, { ...token, radiant: false }));
      expect(unitView(s.state, token).keywords).toContainEqual({ kind: "Rush" });
      expect(keywordsOf(s.state, token)).toEqual([{ kind: "Rush" }]);
    });

    it('§7 "Stat overrides" on the radiant face: a 5/5 radiant Rush Token shows 5/5 and keeps Rush', () => {
      const s = scenario({ seed: SEED });
      const token = summonRushToken(s, { radiant: true, statsOverride: { attack: 5, health: 5 } });

      expect(token.radiant).toBe(true);
      s.expectStats(token, { attack: 5, health: 5, maxHealth: 5 });
      expect(unitHas(s.state, token, "Rush")).toBe(true);
    });

    it("R11 a radiant Rush Token that dies in combat ceases to exist just as the base face does", () => {
      const s = scenario({
        seed: SEED,
        p1: { field: [{ def: "core-t-rush", radiant: true }] },
        p2: { field: ["core-025"] },
      });
      const token = s.unit("p1", 1) as CardInstance;

      s.attack(token, s.unit("p2", 1) as CardInstance);

      s.expectInZone(token, "gone");
      expect(s.pile("p1", "graveyard")).toEqual([]);
      expect(s.pile("p1", "exile")).toEqual([]);
    });

    it("R11 and §10.1 a vanished radiant Rush Token is in no pile and its zone says `gone`", () => {
      const s = scenario({ seed: SEED, p1: { field: [{ def: "core-t-rush", radiant: true }] } });
      const token = s.unit("p1", 1) as CardInstance;

      expect(moveToZone(s.state, token, "exile")).toBe("vanished");
      s.expectInZone(token, "gone");
      expect(s.pile("p1", "exile")).toEqual([]);
      expect(token.zone.z).toBe("gone");
    });
  });
});
