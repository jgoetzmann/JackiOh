// #89 Corpse Eater (SPEC §8.5, BUILD M4-T4 row 89): "In hand it gains the dying unit's current
// attack and max health from either side, tokens excluded (R11); stats per R38; stops once on the
// field; radiant double".

import { describe, expect, it } from "vitest";
import { scenario } from "./_harness";
import { def } from "../src/scripts/089-corpse-eater";

const EATER = "core-089"; // 2/2 → 6/6, cost 4

// Inert fixtures: every unit below has a Cry and nothing else, and the harness's `field` setup
// never fires a Cry.
const GARY = "core-004"; // 1/1
const FELINORS = "core-012"; // 3/4
const RENO = "core-053"; // 4/6
const STRAAZA = "core-054"; // 8/8
const FELINOR_TOKEN = "core-t-felinor"; // 1/1 unit token (§7)

// §2.5: one always-playable card per hand keeps a scenario on the turn it started on.
const FILLER = "core-005";

const SEED = "eater-89";

describe("#89 Corpse Eater — printed faces (§8 Conventions)", () => {
  it("the radiant keyword cell lists no Plus, so Rush and Divine Shield are the complete list", () => {
    expect(def.base.keywords.map((keyword) => keyword.kind)).toEqual(["Rush"]);
    expect(def.radiant.keywords.map((keyword) => keyword.kind)).toEqual(["Rush", "Divine Shield"]);
  });
});

describe("#89 Corpse Eater — base", () => {
  it("R89 in hand it gains an ally unit's attack and max health when it dies", () => {
    const s = scenario({
      seed: SEED,
      active: "p2",
      p1: { hand: [EATER, FILLER], field: [{ def: GARY, lane: 1 }] },
      p2: { hand: [FILLER], field: [{ def: FELINORS, lane: 1 }] },
    });

    s.expectStats(EATER, { attack: 2, maxHealth: 2 });
    s.attack(FELINORS, GARY);

    // Gary was 1/1, so the Eater is 3/3 while still sitting in hand.
    s.expectStats(EATER, { attack: 3, maxHealth: 3 });
    expect(s.card(EATER).zone.z).toBe("hand");
    s.expectEvents("destroyed", "buffed");
  });

  it('"on either side": an enemy unit dying feeds it too', () => {
    const s = scenario({
      seed: SEED,
      p1: { hand: [EATER, FILLER], field: [{ def: FELINORS, lane: 1 }] },
      p2: { hand: [FILLER], field: [{ def: GARY, lane: 1 }] },
    });

    s.attack(FELINORS, GARY);

    s.expectStats(EATER, { attack: 3, maxHealth: 3 });
  });

  it("R38 counts the dying unit's current attack and MAX health, not its remaining health", () => {
    const s = scenario({
      seed: SEED,
      active: "p2",
      // Reno is 4/6 sitting on 5 damage, so its current health is 1 and its max health is 6.
      p1: { hand: [EATER, FILLER], field: [{ def: RENO, damage: 5, lane: 1 }] },
      p2: { hand: [FILLER], field: [{ def: STRAAZA, lane: 1 }] },
    });
    s.expectStats(RENO, { attack: 4, health: 1, maxHealth: 6 });

    s.attack(STRAAZA, RENO);

    // 2/2 + 4/6. Reading current health instead would have made it 6/3.
    s.expectStats(EATER, { attack: 6, maxHealth: 8 });
  });

  it("R89 counts the layers' numbers: two deaths in one state check both feed it", () => {
    const s = scenario({
      seed: SEED,
      active: "p2",
      // Gary (1/1) trades with Felinors' 3 attack and deals 1 back to a 1/1 attacker.
      p1: { hand: [EATER, FILLER], field: [{ def: GARY, lane: 1 }] },
      p2: { hand: [FILLER], field: [{ def: GARY, lane: 1 }] },
    });

    s.attack(s.unit("p2", 1) as never, s.unit("p1", 1) as never);

    // Both 1/1s die in the same check, so the Eater eats twice: 2/2 + 1/1 + 1/1.
    s.expectStats(EATER, { attack: 4, maxHealth: 4 });
  });

  it("R11 a unit token never reaches a graveyard, so it never feeds the Eater", () => {
    const s = scenario({
      seed: SEED,
      active: "p2",
      p1: { hand: [EATER, FILLER], field: [{ def: FELINOR_TOKEN, lane: 1 }] },
      p2: { hand: [FILLER], field: [{ def: FELINORS, lane: 1 }] },
    });
    const token = s.card(FELINOR_TOKEN);

    s.attack(FELINORS, token);

    // R11: the token ceased to exist — in no pile at all — and the Eater is untouched.
    s.expectInZone(token, "gone");
    s.expectStats(EATER, { attack: 2, maxHealth: 2 });
    expect(s.events.filter((event) => event.type === "buffed")).toHaveLength(0);
  });

  it("§8.5 a card reaching a graveyard from a hand never died, so a burn does not count (R4)", () => {
    const s = scenario({
      seed: SEED,
      // HAND_CAP is 10: the hand is already full, so the draw below is burned (§2.4, R4).
      p1: {
        hand: [EATER, FILLER, FILLER, FILLER, FILLER, FILLER, FILLER, FILLER, FILLER, FILLER],
        library: [GARY],
      },
      p2: { hand: [FILLER] },
    });

    s.startTurn();

    // The unit went from hand to graveyard: `burned`, never `destroyed`.
    s.expectEvents("drawn", "burned");
    expect(s.events.filter((event) => event.type === "destroyed")).toHaveLength(0);
    s.expectStats(EATER, { attack: 2, maxHealth: 2 });
  });

  it("stops once it is on the field: the hand trigger is not registered from a unit zone (§10.3)", () => {
    const s = scenario({
      seed: SEED,
      p1: { hand: [EATER, FILLER], field: [{ def: STRAAZA, lane: 2 }] },
      p2: { hand: [FILLER], field: [{ def: GARY, lane: 1 }] },
    });

    s.play(EATER);
    s.expectInZone(EATER, "field");

    s.attack(STRAAZA, GARY);

    // §10.3: a card on the field registers `triggers`, and this card declares none.
    s.expectStats(EATER, { attack: 2, maxHealth: 2 });
  });

  it("R78 the gain travels from hand onto the field: buffs are layer 4 on the instance", () => {
    const s = scenario({
      seed: SEED,
      active: "p2",
      p1: { hand: [EATER, FILLER], field: [{ def: GARY, lane: 1 }] },
      p2: { hand: [FILLER], field: [{ def: FELINORS, lane: 2 }] },
    });

    s.attack(FELINORS, GARY);
    s.expectStats(EATER, { attack: 3, maxHealth: 3 });

    // Back to p1's turn, then play the fattened Eater: entering the field resets nothing (R78
    // resets a card LEAVING the field), so it arrives at the stats it ate its way to.
    s.endTurn();
    s.play(EATER);

    s.expectInZone(EATER, "field");
    s.expectStats(EATER, { attack: 3, maxHealth: 3 });
  });
});

describe("#89 Corpse Eater — radiant", () => {
  it("gains double: the radiant 6/6 takes twice the dying unit's attack and max health", () => {
    const s = scenario({
      seed: SEED,
      active: "p2",
      p1: { hand: [{ def: EATER, radiant: true }, FILLER], field: [{ def: GARY, lane: 1 }] },
      p2: { hand: [FILLER], field: [{ def: FELINORS, lane: 1 }] },
    });

    s.expectStats(EATER, { attack: 6, maxHealth: 6 });
    s.attack(FELINORS, GARY);

    // 6/6 + 2 × 1/1.
    s.expectStats(EATER, { attack: 8, maxHealth: 8 });
  });

  it("R38 doubles the current attack and max health, from either side", () => {
    const s = scenario({
      seed: SEED,
      active: "p2",
      p1: { hand: [{ def: EATER, radiant: true }, FILLER], field: [{ def: RENO, damage: 5, lane: 1 }] },
      p2: { hand: [FILLER], field: [{ def: STRAAZA, lane: 1 }] },
    });

    s.attack(STRAAZA, RENO);

    // 6/6 + 2 × 4/6.
    s.expectStats(EATER, { attack: 14, maxHealth: 18 });
  });

  it("R11 the radiant face excludes tokens too", () => {
    const s = scenario({
      seed: SEED,
      active: "p2",
      p1: { hand: [{ def: EATER, radiant: true }, FILLER], field: [{ def: FELINOR_TOKEN, lane: 1 }] },
      p2: { hand: [FILLER], field: [{ def: FELINORS, lane: 1 }] },
    });
    const token = s.card(FELINOR_TOKEN);

    s.attack(FELINORS, token);

    s.expectInZone(token, "gone");
    s.expectStats(EATER, { attack: 6, maxHealth: 6 });
  });

  it("stops once on the field, and its printed Divine Shield is the catalog's, not a grant", () => {
    const s = scenario({
      seed: SEED,
      p1: { hand: [{ def: EATER, radiant: true }, FILLER], field: [{ def: STRAAZA, lane: 2 }] },
      p2: { hand: [FILLER], field: [{ def: GARY, lane: 1 }] },
    });

    s.play(EATER);
    expect(s.stats(EATER).keywords.map((keyword) => keyword.kind)).toEqual(["Rush", "Divine Shield"]);
    expect(s.card(EATER).grantedKeywords).toEqual([]);

    s.attack(STRAAZA, GARY);

    s.expectStats(EATER, { attack: 6, maxHealth: 6 });
  });
});
