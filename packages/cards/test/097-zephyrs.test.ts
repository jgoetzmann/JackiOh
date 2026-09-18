// #97 Zephyrs — SPEC §8.5, §10.7's scorer bullet, §6.3 Discover and Exile, R29.
// BUILD M4-T4 row 97: "Scorer deterministic; a lethal-enabling card ranks first when lethal
// exists; Discover offers the top 3 (R29); exiled; radiant picks are radiant".

import { describe, expect, it } from "vitest";
import type { GameState, PendingChoice } from "@jackioh/engine";
import { subsystems } from "@jackioh/engine";
import { scenario } from "./_harness";

const ZEPHYRS = "core-097";
/** #45 Deft Duelist, 4/3 Charge for 2: the one base face the scorer can read as "enables lethal". */
const CHARGER = "core-045";
/** #11 Tempo Timmy, 3/3: board damage that is already pointed at the hero. */
const BOARD = "core-011";

function open(state: GameState): PendingChoice {
  const pending = state.pending;
  if (pending === null) throw new Error("#97 opened no prompt");
  return pending;
}

/** A Discover's options are `mode` selections carrying catalog ids (§10.6). */
function optionIds(pending: PendingChoice): string[] {
  return pending.options.flatMap((option) =>
    option.selection.pick === "mode" ? [option.selection.option] : [],
  );
}

function sorted(ids: readonly string[]): string[] {
  return [...ids].sort();
}

describe("#97 Zephyrs — base", () => {
  it("R29 offers exactly the scorer's top 3 and nothing else", () => {
    const s = scenario({ seed: "zephyrs-top3", p1: { hand: [ZEPHYRS] } });
    s.play(ZEPHYRS);

    const pending = open(s.state);
    expect(pending.kind).toBe("discover");
    expect(pending.playerId).toBe("p1");
    expect(pending.min).toBe(1);
    expect(pending.max).toBe(1);
    expect(pending.options).toHaveLength(3);

    // The state the card read is this one: the spell is resolving and the prompt is open.
    const top = subsystems.topThree(s.state, "p1").map((scored) => scored.def.id);
    expect(sorted(optionIds(pending))).toEqual(sorted(top));
  });

  it("R29 never offers Zephyrs itself, and never offers a token (§5.1)", () => {
    const s = scenario({ seed: "zephyrs-self", p1: { hand: [ZEPHYRS] } });
    s.play(ZEPHYRS);

    const ids = optionIds(open(s.state));
    expect(ids).not.toContain(ZEPHYRS);
    for (const id of ids) {
      const def = subsystems.candidateDefs().find((candidate) => candidate.id === id);
      expect(def).toBeDefined();
      expect(def?.token).toBe(false);
      expect(def?.set).toBe("Core");
    }
  });

  it("§10.7 the ranking is deterministic: the same board offers the same 3 under any seed", () => {
    const board = { p1: { hand: [ZEPHYRS], field: [BOARD] }, p2: { field: [BOARD], health: 20 } };
    const a = scenario({ seed: "zephyrs-a", ...board });
    const b = scenario({ seed: "zephyrs-b", ...board });
    a.play(ZEPHYRS);
    b.play(ZEPHYRS);

    // The scorer takes no rng at all, so only the order the three are OFFERED in can differ.
    expect(sorted(optionIds(open(a.state)))).toEqual(sorted(optionIds(open(b.state))));
  });

  it("§10.7 'lethal available → max': a lethal-enabling card ranks first when lethal exists", () => {
    // p1's 3/3 can already swing at the hero for 3; #45 adds 4 with Charge on its summon turn, and
    // costs 2 of p1's 4 mana, so 3 + 4 ≥ p2's 7 health is lethal available this turn.
    const s = scenario({
      seed: "zephyrs-lethal",
      p1: { hand: [ZEPHYRS], field: [BOARD] },
      p2: { health: 7 },
    });
    s.play(ZEPHYRS);

    const ranked = subsystems.rank(s.state, "p1");
    expect(ranked[0]?.def.id).toBe(CHARGER);
    expect(ranked[0]?.priority).toBe("lethal");
    // …and the card offers it, which is the whole of what #97 contributes.
    expect(optionIds(open(s.state))).toContain(CHARGER);
  });

  it("§8.5 the pick goes to the caster's hand, not Radiant on the base face", () => {
    const s = scenario({ seed: "zephyrs-hand", p1: { hand: [ZEPHYRS] } });
    s.play(ZEPHYRS);
    const picked = optionIds(open(s.state))[0] ?? "";
    s.answer(picked);

    expect(s.state.pending).toBeNull();
    const held = s.hand("p1").filter((card) => card.defId === picked);
    expect(held).toHaveLength(1);
    expect(held[0]?.radiant).toBe(false);
    s.expectEvents("cardPlayed", "promptOpened", "addedToHand");
  });

  it("§8.5 'exile this': the spell reaches the exile pile, not the graveyard", () => {
    const s = scenario({ seed: "zephyrs-exile", p1: { hand: [ZEPHYRS] } });
    s.play(ZEPHYRS);
    s.answer(optionIds(open(s.state))[0] ?? "");

    s.expectInZone(ZEPHYRS, "exile");
    expect(s.pile("p1", "graveyard").map((card) => card.defId)).not.toContain(ZEPHYRS);
    expect(s.events.some((event) => event.type === "exiled")).toBe(true);
    // R55: an exile is one of Ceaseless Void's four game counters.
    expect(s.state.counters.exiled).toBeGreaterThanOrEqual(1);
  });

  it("§8.5 costs 0: it is castable with no mana at all", () => {
    const s = scenario({ seed: "zephyrs-free", p1: { hand: [ZEPHYRS], mana: 0 } });
    expect(() => s.play(ZEPHYRS)).not.toThrow();
    s.expectMana("p1", 0);
  });
});

describe("#97 Zephyrs — radiant", () => {
  it("§8.5 'A perfect Radiant card': the pick arrives Radiant", () => {
    const s = scenario({ seed: "zephyrs-radiant", p1: { hand: [ZEPHYRS] } });
    // Stands in for a missing `{ def, radiant }` form on `SideSetup.hand`; §5.2 makes the flag the
    // whole model, so setting it on the fixture is a legitimate starting state.
    s.card(ZEPHYRS).radiant = true;
    s.play(ZEPHYRS);

    const picked = optionIds(open(s.state))[0] ?? "";
    s.answer(picked);

    const held = s.hand("p1").filter((card) => card.defId === picked);
    expect(held).toHaveLength(1);
    expect(held[0]?.radiant).toBe(true);
    s.expectEvents("cardPlayed", "promptOpened", "addedToHand");
  });

  it("§5.2 the radiant face ranks the radiant faces, so the top 3 is the radiant top 3", () => {
    const s = scenario({
      seed: "zephyrs-radiant-rank",
      p1: { hand: [ZEPHYRS], field: [BOARD] },
      p2: { field: [BOARD], health: 20 },
    });
    s.card(ZEPHYRS).radiant = true;
    s.play(ZEPHYRS);

    const top = subsystems.topThree(s.state, "p1", { radiant: true }).map((scored) => scored.def.id);
    expect(sorted(optionIds(open(s.state)))).toEqual(sorted(top));
  });

  it("§8.5 'exile this' is kept: the radiant cell restates only which card is Discovered", () => {
    const s = scenario({ seed: "zephyrs-radiant-exile", p1: { hand: [ZEPHYRS] } });
    s.card(ZEPHYRS).radiant = true;
    s.play(ZEPHYRS);
    s.answer(optionIds(open(s.state))[0] ?? "");

    s.expectInZone(ZEPHYRS, "exile");
  });
});
