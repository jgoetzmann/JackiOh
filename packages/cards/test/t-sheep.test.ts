// T-sheep Sheep Token (SPEC §7; §3.2, §6.3, R11, R41, R74). BUILD M4-T4's token row: "Vanish on
// leaving the field; Sheep counts 2 toward Tribute; … none in random pools".
//
// §7 gives this token NO radiant form, so both `describe`s below prove the same behaviour, once on
// each face, and the data block proves the faces are one face (`def.radiant` equals `def.base`).
//
// The "worth 2 Tributes" rule is the play validator's, not this card's (see `src/scripts/t-sheep.ts`),
// so it is asserted through the engine's own `tributeValueOf`/`legalTributeUnits` (playChoices.ts).
// §6.3's second half — "a tribute written into a card's script is an ordinary Sacrifice … where the
// Sheep Token's 2 never applies" — is proved end to end with #22 Carnivorous Cube, the one shipped
// card that tributes from its own text (R41).

import { describe, expect, it } from "vitest";
import {
  findInstance,
  isUnitToken,
  keywordsOf,
  legalTributeUnits,
  moveToZone,
  query,
  tributeCostOf,
  tributeValueOf,
  type CardInstance,
} from "@jackioh/engine";
import { base, def, radiant } from "../src/scripts/t-sheep";
import { scenario } from "./_harness";

const SEED = "t-sheep";

describe("T-sheep Sheep Token (SPEC §7)", () => {
  describe("card data (§7)", () => {
    it("§7 prints a 1-cost Unit Token with 1/1, no keywords and the worth-2 reminder", () => {
      expect(def.index).toBe("T-sheep");
      expect(def.cost).toBe(1);
      expect(def.type).toBe("Unit");
      expect(def.token).toBe(true);
      expect(def.tags).toContain("Token");
      expect(def.base.attack).toBe(1);
      expect(def.base.health).toBe(1);
      expect(def.base.keywords).toEqual([]);
      expect(def.base.text).toMatch(/2 Tributes/);
    });

    it("§7 gives the Sheep Token no radiant form, so def.radiant equals def.base (BUILD M4-T1)", () => {
      expect(def.radiant).toEqual(def.base);
    });

    it("§7 needs no script for either face, and the radiant Script is the base Script (R74)", () => {
      expect(base).toEqual({});
      expect(radiant).toBe(base);
    });
  });

  describe("base", () => {
    it("§7 a Sheep Token on the field is a 1/1 with no keywords", () => {
      const s = scenario({ seed: SEED, p1: { field: ["core-t-sheep"] } });
      const sheep = s.unit("p1", 1) as CardInstance;

      expect(sheep.defId).toBe(def.id);
      s.expectStats(sheep, { attack: 1, health: 1, maxHealth: 1 });
      expect(keywordsOf(s.state, sheep)).toEqual([]);
    });

    it("§3.2 and §6.3 a Sheep Token on the field is worth 2 Tributes, every other unit 1", () => {
      const s = scenario({
        seed: SEED,
        p1: { field: ["core-t-sheep", "core-t-felinor", "core-025"] },
      });

      expect(tributeValueOf(s.state, s.unit("p1", 1) as CardInstance)).toBe(2);
      expect(tributeValueOf(s.state, s.unit("p1", 2) as CardInstance)).toBe(1);
      expect(tributeValueOf(s.state, s.unit("p1", 3) as CardInstance)).toBe(1);
    });

    it('§3.2 "while on the field": a Sheep Token card in hand is no Tribute candidate at all', () => {
      const s = scenario({
        seed: SEED,
        p1: { hand: ["core-022", "core-t-sheep"], field: ["core-t-sheep"] },
      });
      const cube = s.hand("p1")[0] as CardInstance;
      const onField = s.unit("p1", 1) as CardInstance;

      expect(legalTributeUnits(s.state, "p1", cube).map((unit) => unit.id)).toEqual([onField.id]);
    });

    it.todo(
      "§6.3 one Sheep Token alone pays #66 The Rock's Tribute 1 and two pay #55 Lava Golem's " +
        "Tribute 3 where three ordinary units would be needed — blocked on two things: no shipped " +
        "script declares a Tribute play cost yet (`core-055`/`core-066` are not in src/scripts), and " +
        "`reduce.ts`'s `playCard` neither calls `whyChoicesRefused` (playChoices.ts) nor sacrifices " +
        "`action.tributes`, so a Tribute cost is currently neither validated nor paid by a play",
    );

    it("§6.3 and R41 a script tribute (#22) sacrifices only the permanent it names; the 2 never applies", () => {
      const s = scenario({
        seed: SEED,
        p1: { hand: ["core-022"], field: ["core-t-sheep", "core-025"] },
      });
      const sheep = s.unit("p1", 1) as CardInstance;
      const other = s.unit("p1", 2) as CardInstance;

      // R81: the meal travels in the play action. #22's Cry is a plain `sacrifice` of that one
      // permanent, so being worth 2 Tributes buys the Sheep nothing here.
      s.play("core-022", { targets: [{ pick: "instance", instanceId: sheep.id }] });

      s.expectEvents("cardPlayed", "destroyed");
      // R11: sacrificed from the field, so it ceases to exist instead of reaching the graveyard.
      s.expectInZone(sheep, "gone");
      expect(s.pile("p1", "graveyard")).toEqual([]);
      // Exactly one permanent was eaten: the other unit and the Cube itself are untouched.
      s.expectInZone(other, "field");
      s.expectInZone("core-022", "field");
      // §6.3: the Cube's meal is not a Tribute *cost* — its declaration carries no `amount`, so the
      // play charged no Tribute and the Sheep's 2 never entered the arithmetic at all.
      expect(tributeCostOf(s.card("core-022"))).toBe(0);
    });

    it("R11 a Sheep Token that dies in combat ceases to exist and never reaches a graveyard", () => {
      const s = scenario({ seed: SEED, p1: { field: ["core-t-sheep"] }, p2: { field: ["core-025"] } });
      const sheep = s.unit("p1", 1) as CardInstance;
      expect(isUnitToken(s.state, sheep)).toBe(true);

      s.attack(sheep, s.unit("p2", 1) as CardInstance);

      s.expectEvents("destroyed");
      s.expectInZone(sheep, "gone");
      // R11: "nothing can reach it again" — the engine's own lookup no longer finds it. (The
      // instance this test holds is a pre-`reduce` snapshot, so its own `zone` is stale; the
      // `gone` tag is asserted below, where `moveToZone` mutates the live instance in place.)
      expect(findInstance(s.state, sheep.id)).toBeUndefined();
      expect(s.pile("p1", "graveyard")).toEqual([]);
      expect(s.pile("p1", "exile")).toEqual([]);
    });

    it("R11 a bounced Sheep Token ceases to exist rather than returning to a hand (§3.2)", () => {
      const s = scenario({ seed: SEED, p1: { field: ["core-t-sheep"] } });
      const sheep = s.unit("p1", 1) as CardInstance;

      // Called directly so this test holds the instance the engine mutates (`reduce` clones).
      expect(moveToZone(s.state, sheep, "hand")).toBe("vanished");

      s.expectInZone(sheep, "gone");
      expect(sheep.zone.z).toBe("gone");
      expect(s.hand("p1")).toEqual([]);
    });

    it("R11 a unit token never enters a graveyard or exile, so a fixture may not put one there", () => {
      expect(() => scenario({ seed: SEED, p1: { graveyard: ["core-t-sheep"] } })).toThrow(/unit token/);
      expect(() => scenario({ seed: SEED, p1: { exile: ["core-t-sheep"] } })).toThrow(/unit token/);
    });

    it("§5.1 and §7 query never offers the Sheep Token unless the pool names tokens", () => {
      const ids = (defs: { id: string }[]): string[] => defs.map((entry) => entry.id);

      expect(ids(query({ type: "Unit" }))).not.toContain(def.id);
      expect(ids(query({ cost: 1 }))).not.toContain(def.id);
      expect(ids(query({ token: true }))).toContain(def.id);
      expect(ids(query({ index: "T-sheep" }))).toEqual([def.id]);
    });
  });

  // §7's "Radiant form" column reads "none", so every case above holds for a radiant instance too:
  // R74 sets the flag, and the flag selects the same face and the same (empty) Script.
  describe("radiant (§7: none — the radiant face is the base face)", () => {
    it("R74 a radiant Sheep Token is still a 1/1 with no keywords", () => {
      const s = scenario({ seed: SEED, p1: { field: [{ def: "core-t-sheep", radiant: true }] } });
      const sheep = s.unit("p1", 1) as CardInstance;

      expect(sheep.radiant).toBe(true);
      s.expectStats(sheep, { attack: 1, health: 1, maxHealth: 1 });
      expect(keywordsOf(s.state, sheep)).toEqual([]);
    });

    it("§3.2 a radiant Sheep Token is worth 2 Tributes exactly as the base face is", () => {
      const s = scenario({
        seed: SEED,
        p1: { field: [{ def: "core-t-sheep", radiant: true }, { def: "core-t-felinor", radiant: true }] },
      });

      expect(tributeValueOf(s.state, s.unit("p1", 1) as CardInstance)).toBe(2);
      expect(tributeValueOf(s.state, s.unit("p1", 2) as CardInstance)).toBe(1);
    });

    it("R11 a radiant Sheep Token that leaves the field ceases to exist just as the base face does", () => {
      const s = scenario({ seed: SEED, p1: { field: [{ def: "core-t-sheep", radiant: true }] } });
      const sheep = s.unit("p1", 1) as CardInstance;

      expect(moveToZone(s.state, sheep, "graveyard")).toBe("vanished");

      s.expectInZone(sheep, "gone");
      expect(sheep.zone.z).toBe("gone");
      expect(s.pile("p1", "graveyard")).toEqual([]);
    });
  });
});
