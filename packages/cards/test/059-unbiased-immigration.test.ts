// #59 Unbiased Immigration (SPEC §8.3, BUILD M4-T4 row 59: "Random non-token card each start of
// turn; paid 4 → cost 0; radiant gives a radiant card"). Engine cell: "Non-token Core pool
// excluding #59".
//
// Rulings proved here: R65 (the chosen embiggen price is the cost, and `costOverride` starts the
// calculation), R81 (embiggen travels in the `play` action and opens no prompt), R62 and §6.2 (the
// controller's turn only, trigger before the draw), R60 and §5.1 (the pool: no tokens, never #59),
// R74 (the added card is Radiant by flag).

import { describe, expect, it } from "vitest";
import { pool } from "../src/query";
import { scenario, type Scenario } from "./_harness";

/** The harness's own instance type, so a test file imports nothing from the engine. */
type Instance = ReturnType<Scenario["card"]>;

/**
 * The card the Field Spell ADDED, told apart from the card the same start of turn DREW: a draw also
 * goes through `addToHand` and so emits `addedToHand` too, but only after its own `drawn` event
 * (engine/src/draw.ts).
 */
function addedCards(g: Scenario): Instance[] {
  const drawn = new Set(
    g.lastEvents.flatMap((event) => (event.type === "drawn" ? [event.instanceId] : [])),
  );
  return g.lastEvents.flatMap((event) =>
    event.type === "addedToHand" && !drawn.has(event.instanceId) ? [g.card(event.instanceId)] : [],
  );
}

function onlyAdded(g: Scenario): Instance {
  const added = addedCards(g);
  expect(added).toHaveLength(1);
  const card = added[0];
  if (card === undefined) throw new Error("no card was added this step");
  return card;
}

/** Keeps a side's turn open past a play (R82's auto-end) and gives the start-of-turn draw a card. */
const BUSY = { field: [{ def: "core-008", lane: 1 }], library: ["core-011", "core-016"] };

const CORE_POOL = pool("59", { set: "Core" }).map((def) => def.id);

describe("#59 Unbiased Immigration — the pool", () => {
  it("§5.1 the pool is the 99 non-token Core cards, without #59", () => {
    expect(CORE_POOL).toHaveLength(99);
    expect(CORE_POOL).not.toContain("core-059");
    expect(CORE_POOL).not.toContain("core-t-rush");
    expect(CORE_POOL).not.toContain("core-051-1");
  });
});

describe("#59 Unbiased Immigration — base", () => {
  it("§6.2 adds a random card to your hand at your start of turn", () => {
    const g = scenario({
      p1: { ...BUSY, backrow: [{ def: "core-059", lane: 1 }] },
      p2: { ...BUSY },
    });

    g.startTurn();

    const added = onlyAdded(g);
    expect(CORE_POOL).toContain(added.defId);
    expect(added.radiant).toBe(false);
  });

  it("R62 and §6.2: nothing is added on the opponent's turn", () => {
    const g = scenario({
      p1: { ...BUSY, backrow: [{ def: "core-059", lane: 1 }], hand: ["core-005"] },
      p2: { ...BUSY, hand: ["core-005"] },
    });

    g.startTurn();
    const afterMine = g.hand("p1").length;

    g.endTurn();
    expect(g.hand("p1")).toHaveLength(afterMine);
    expect(addedCards(g)).toHaveLength(0);

    g.endTurn();
    expect(g.hand("p1").length).toBeGreaterThan(afterMine);
  });

  it("R65 paid 2: the added card keeps its own cost", () => {
    const g = scenario({
      p1: { ...BUSY, hand: ["core-059", "core-005"] },
      p2: { ...BUSY },
    });

    g.play("core-059", { zone: 1 }).expectMana("p1", 2);
    g.startTurn();

    const added = onlyAdded(g);
    expect(added.costOverride).toBeUndefined();
  });

  it("R65 paid 4: the added card costs 0", () => {
    const g = scenario({
      p1: { ...BUSY, hand: ["core-059", "core-005"] },
      p2: { ...BUSY },
    });

    // R81: the embiggen price travels in the `play` action; §10.6 says no Core card prompts for it.
    g.play("core-059", { zone: 1, embiggen: true }).expectMana("p1", 0);
    g.startTurn();

    const added = onlyAdded(g);
    expect(added.costOverride).toBe(0);
  });

  it("R65 the 0 is the cost the view shows, whatever the card was printed at", () => {
    const g = scenario({
      p1: { ...BUSY, hand: ["core-059", "core-005"] },
      p2: { ...BUSY },
    });

    g.play("core-059", { zone: 1, embiggen: true });
    g.startTurn();

    const added = onlyAdded(g);
    const hand = g.view("p1").you.hand;
    expect(Array.isArray(hand)).toBe(true);
    if (!Array.isArray(hand)) return;
    const shown = hand.find((card) => card.instanceId === added.id);
    expect(shown?.cost).toBe(0);
  });

  it("R65 the embiggen price is remembered turns later, not just on the play", () => {
    const g = scenario({
      p1: { ...BUSY, hand: ["core-059", "core-005"] },
      p2: { ...BUSY, hand: ["core-005"] },
    });

    g.play("core-059", { zone: 1, embiggen: true });
    g.startTurn();
    g.endTurn().endTurn();

    // Every card this Field Spell has added is free, on this turn and on the ones after it.
    for (const card of addedCards(g)) expect(card.costOverride).toBe(0);
  });

  it("§9.3 the pick is seeded: the same seed adds the same card", () => {
    const build = (seed: string): string => {
      const g = scenario({
        seed,
        p1: { ...BUSY, backrow: [{ def: "core-059", lane: 1 }] },
        p2: { ...BUSY },
      });
      g.startTurn();
      return onlyAdded(g).defId;
    };

    expect(build("seed-a")).toBe(build("seed-a"));
  });

  it("R60 and §5.1: every card it can add is a non-token Core card that is not itself", () => {
    const seeds = ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"];

    for (const seed of seeds) {
      const g = scenario({
        seed,
        p1: { ...BUSY, backrow: [{ def: "core-059", lane: 1 }] },
        p2: { ...BUSY },
      });
      g.startTurn();
      expect(CORE_POOL).toContain(onlyAdded(g).defId);
    }
  });
});

describe("#59 Unbiased Immigration — radiant", () => {
  it("R74 adds a random Radiant card", () => {
    const g = scenario({
      p1: { ...BUSY, backrow: [{ def: "core-059", radiant: true, lane: 1 }] },
      p2: { ...BUSY },
    });

    g.startTurn();

    const added = onlyAdded(g);
    expect(added.radiant).toBe(true);
    expect(CORE_POOL).toContain(added.defId);
  });

  it("§8 Conventions: the restated clause replaces the base one — one card, not two", () => {
    const g = scenario({
      p1: { ...BUSY, backrow: [{ def: "core-059", radiant: true, lane: 1 }] },
      p2: { ...BUSY },
    });

    g.startTurn();

    expect(addedCards(g)).toHaveLength(1);
  });

  it("R65 paid 4 on the radiant face: Radiant and costing 0", () => {
    const g = scenario({
      p1: { ...BUSY, hand: ["core-059", "core-005"] },
      p2: { ...BUSY },
    });

    // The setup builder takes `radiant` on the field and the backrow only, so a radiant card that
    // has to be PLAYED is flagged on the hand instance (reported as a harness gap).
    g.card("core-059").radiant = true;
    g.play("core-059", { zone: 1, embiggen: true });
    g.startTurn();

    const added = onlyAdded(g);
    expect(added.radiant).toBe(true);
    expect(added.costOverride).toBe(0);
  });

  it("R62 the radiant face is just as silent on the opponent's turn", () => {
    const g = scenario({
      p1: { ...BUSY, backrow: [{ def: "core-059", radiant: true, lane: 1 }], hand: ["core-005"] },
      p2: { ...BUSY, hand: ["core-005"] },
    });

    g.startTurn();
    g.endTurn();

    expect(addedCards(g)).toHaveLength(0);
  });
});
