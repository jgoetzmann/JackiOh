// #86 "Miss" Mrow (SPEC §8.5, BUILD M4-T4 row 86): "Cannot attack; Death steals enemy units in
// lane order, each placed per R15, excess stay; radiant may attack". R275: the radiant face now
// prints Taunt ("Taunt. Death: steal all enemy units"), so it may attack and must be attacked first.

import { keywordsOf } from "@jackioh/engine";
import { describe, expect, it } from "vitest";
import { scenario } from "./_harness";

const MROW = "core-086";

// Field fixtures, chosen because every one of them has a Cry and nothing else: a unit placed by the
// harness's `field` setup never fires its Cry, so these are inert boards.
const GARY = "core-004"; // 1/1
const FELINORS = "core-012"; // 3/4, kills a 1/1 Mrow and survives the 1 back
const POSTDOC = "core-061"; // 2/4
const RENO = "core-053"; // 4/6
const SOURCERER = "core-068"; // 5/5, kills a radiant 2/2 Mrow
const STRAAZA = "core-054"; // 8/8
const MANA_WELL = "core-006"; // Field Spell; only a start-of-turn hook, so inert here

// §2.5: a turn with nothing but `endTurn` left auto-ends and cascades into the next turn's draw.
// One always-playable card in each hand keeps every scenario on the turn it started on.
const FILLER = "core-005";

const SEED = "mrow-86";

describe('#86 "Miss" Mrow — base', () => {
  it("cannot attack: the printed keyword is the catalog's, and combat refuses both targets", () => {
    const s = scenario({
      seed: SEED,
      p1: { hand: [FILLER], field: [MROW] },
      p2: { hand: [FILLER], field: [GARY] },
    });

    // §8 Conventions: `Can't attack` is printed on the base face, read as a §10.4 layer-1 keyword
    // by `combat.ts`, so the script contributes nothing to this clause.
    expect(keywordsOf(s.state, s.card(MROW))).toEqual([{ kind: "Can't attack" }]);
    expect(() => s.attack(MROW, "hero")).toThrow(/cannot attack/);
    expect(() => s.attack(MROW, GARY)).toThrow(/cannot attack/);
  });

  it("R15 Death steals enemy units in lane order into the same lane when it is free", () => {
    const s = scenario({
      seed: SEED,
      active: "p2",
      p1: { hand: [FILLER], field: [{ def: MROW, lane: 3 }] },
      p2: {
        hand: [FILLER],
        field: [
          { def: FELINORS, lane: 1 },
          { def: GARY, lane: 2 },
        ],
        backrow: [{ def: MANA_WELL, lane: 1 }],
      },
    });

    s.attack(FELINORS, MROW);

    s.expectInZone(MROW, "graveyard").expectEvents("destroyed", "controlChanged", "controlChanged");

    // R15: lane 1 and lane 2 were both free on p1's side, so each card kept its lane.
    expect(s.unit("p1", 1)?.defId).toBe(FELINORS);
    expect(s.unit("p1", 2)?.defId).toBe(GARY);
    expect(s.unit("p2", 1)).toBeNull();
    expect(s.unit("p2", 2)).toBeNull();

    // R12: a steal moves control, never ownership, so both cards still belong to p2.
    expect(s.unit("p1", 1)?.owner).toBe("p2");
    expect(s.unit("p1", 1)?.controller).toBe("p1");
    expect(s.unit("p1", 2)?.owner).toBe("p2");

    // R78: they never left the field, so the combat damage came along with them.
    expect(s.unit("p1", 1)?.damage).toBe(1);

    // The Death names the unit row, so p2's backrow is untouched.
    expect(s.backrow("p2", 1)?.defId).toBe(MANA_WELL);
    expect(s.backrow("p1", 1)).toBeNull();
  });

  it("R15 falls back to the first free zone, and the excess stay with their owner", () => {
    const s = scenario({
      seed: SEED,
      active: "p2",
      p1: {
        hand: [FILLER],
        field: [
          { def: MROW, lane: 1 },
          { def: RENO, lane: 2 },
          { def: STRAAZA, lane: 3 },
          { def: SOURCERER, lane: 4 },
          { def: GARY, lane: 5 },
        ],
      },
      p2: {
        hand: [FILLER],
        field: [
          { def: GARY, lane: 1 },
          { def: FELINORS, lane: 2 },
          { def: POSTDOC, lane: 3 },
        ],
      },
    });

    s.attack(FELINORS, MROW);

    // Mrow's own lane 1 is the only zone its death frees, and lane order gives it to p2's lane 1.
    expect(s.unit("p1", 1)?.defId).toBe(GARY);
    expect(s.unit("p1", 1)?.owner).toBe("p2");
    expect(s.unit("p2", 1)).toBeNull();

    // R15's "excess remain with the opponent": p1's lane 2 is taken and no zone is left free, so
    // the next two cards in lane order simply stay put, still controlled by p2.
    expect(s.unit("p2", 2)?.defId).toBe(FELINORS);
    expect(s.unit("p2", 2)?.controller).toBe("p2");
    expect(s.unit("p2", 3)?.defId).toBe(POSTDOC);
    expect(s.unit("p2", 3)?.controller).toBe("p2");

    // p1's own board is untouched: nothing was displaced to make room.
    expect(s.unit("p1", 2)?.defId).toBe(RENO);
    expect(s.unit("p1", 3)?.defId).toBe(STRAAZA);
    expect(s.unit("p1", 4)?.defId).toBe(SOURCERER);
    expect(s.unit("p1", 5)?.defId).toBe(GARY);
    expect(s.unit("p1", 5)?.owner).toBe("p1");
  });

  it("steals nothing when the enemy unit row is empty, and the death is otherwise ordinary", () => {
    const s = scenario({
      seed: SEED,
      active: "p2",
      p1: { hand: [FILLER], field: [{ def: MROW, lane: 1 }] },
      p2: { hand: [FILLER], field: [{ def: FELINORS, lane: 1 }] },
    });

    s.attack(FELINORS, MROW);

    // The only enemy unit is the killer itself, and p1's lane 1 is free, so it changes sides.
    expect(s.unit("p1", 1)?.defId).toBe(FELINORS);
    expect(s.unit("p2", 1)).toBeNull();
    s.expectInZone(MROW, "graveyard");
  });
});

describe('#86 "Miss" Mrow — radiant', () => {
  it("R275 may attack: the radiant face prints Taunt and not `Can't attack`", () => {
    const s = scenario({
      seed: SEED,
      p1: { hand: [FILLER], field: [{ def: MROW, radiant: true }] },
      p2: { hand: [FILLER], field: [GARY] },
    });

    // §8 Conventions: a radiant cell listing keywords without "Plus" gives the COMPLETE list, and
    // #86's radiant face lists Taunt alone — so the base face's `Can't attack` is gone.
    expect(keywordsOf(s.state, s.card(MROW))).toEqual([{ kind: "Taunt" }]);
    s.expectStats(MROW, { attack: 2, maxHealth: 2 });
    s.attack(MROW, "hero");
    s.expectHealth("p2", 28).expectEvents("attackDeclared", "damage");
  });

  it("R275 Taunt: an enemy attack must target the radiant Mrow first (§4.2 step 3)", () => {
    const s = scenario({
      seed: SEED,
      active: "p2",
      p1: { hand: [FILLER], field: [{ def: MROW, radiant: true, lane: 1 }, { def: GARY, lane: 2 }] },
      p2: { hand: [FILLER], field: [{ def: FELINORS, lane: 1 }] },
    });

    // The wall: neither the hero nor the other unit may be the target while Mrow stands.
    expect(() => s.attack(FELINORS, "hero")).toThrow(/Taunt/);
    expect(() => s.attack(FELINORS, s.unit("p1", 2)!)).toThrow(/Taunt/);

    // Mrow is the legal target; the 3/4 kills the 2/2 and her Death steals it.
    s.attack(FELINORS, MROW);
    s.expectInZone(MROW, "graveyard");
    expect(s.unit("p1", 1)?.defId).toBe(FELINORS);
    expect(s.unit("p1", 1)?.owner).toBe("p2");
  });

  it("the base face has no Taunt: an enemy attack may go past it to the hero", () => {
    const s = scenario({
      seed: SEED,
      active: "p2",
      p1: { hand: [FILLER], field: [{ def: MROW, lane: 1 }] },
      p2: { hand: [FILLER], field: [{ def: FELINORS, lane: 1 }] },
    });

    s.attack(FELINORS, "hero");
    s.expectHealth("p1", 27);
  });

  it('"same": the radiant Death steals every enemy unit in lane order too', () => {
    const s = scenario({
      seed: SEED,
      p1: { hand: [FILLER], field: [{ def: MROW, radiant: true, lane: 1 }] },
      p2: {
        hand: [FILLER],
        field: [
          { def: SOURCERER, lane: 1 },
          { def: GARY, lane: 2 },
        ],
      },
    });

    // The radiant 2/2 attacks a 5/5: it deals 2, takes 5 and dies, which runs its Death.
    s.attack(MROW, SOURCERER);

    s.expectInZone(MROW, "graveyard");
    expect(s.unit("p1", 1)?.defId).toBe(SOURCERER);
    expect(s.unit("p1", 1)?.damage).toBe(2);
    expect(s.unit("p1", 2)?.defId).toBe(GARY);
    expect(s.unit("p2", 1)).toBeNull();
    expect(s.unit("p2", 2)).toBeNull();
    expect(s.unit("p1", 1)?.owner).toBe("p2");
  });
});
