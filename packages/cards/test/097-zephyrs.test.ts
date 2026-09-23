// #97 Zephyrs — SPEC §8.5, §10.7's scorer bullet, §6.3 Discover and Exile, R29.
// BUILD M4-T4 row 97: "Scorer deterministic; a lethal-enabling card ranks first when lethal
// exists; Discover offers the top 3 (R29); exiled; radiant picks are radiant". The polish-4 edge-case
// hunt, round 5 (lens "card by card"), found the scorer blind to card text: §10.7's dry run now plays
// each candidate on a copy of the state, so a burn spell, a board wipe and a heal count.

import { describe, expect, it } from "vitest";
import type { GameState, PendingChoice } from "@jackioh/engine";
import { subsystems } from "@jackioh/engine";
import { scenario, type Scenario } from "./_harness";

const ZEPHYRS = "core-097";
/** #45 Deft Duelist, 4/3 Charge for 2: the one base face the scorer can read as "enables lethal". */
const CHARGER = "core-045";
/** #11 Tempo Timmy, 3/3: board damage that is already pointed at the hero. */
const BOARD = "core-011";
/** #19 Midrange Menace, a second hand card, so no play empties the hand (R82). */
const MENACE_FILLER = "core-019";

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

// ---------------------------------------------------------------------------------------------
// §10.7's priorities for cards whose claim lives in their text.
// ---------------------------------------------------------------------------------------------

/** A Discover's options are `mode` selections carrying catalog ids (§10.6). */
function offeredIds(s: Scenario): string[] {
  return optionIds(open(s.state));
}

/**
 * Every Core card whose own text heals its controller's hero: #5 Stockpile ("heal your hero 2"),
 * #24 Efficiency Dividend ("heal a target 2X"), #47 Fig of Life ("Heal a target 20"), #53 Reno
 * ("set it to 30"), #56 Jilliax (Lifesteal), #74 Adaptive UI ("heal your hero X") and #95 Call to
 * Chaos (one roll heals 30). #19 Midrange Menace (heals itself) and #93 Combo-Index (grade A's
 * Lifesteal) are allowed too, so a scorer that reads "heals" more loosely still passes.
 */
const HEALERS = [
  "core-005", "core-024", "core-047", "core-053", "core-056", "core-074", "core-095", "core-019", "core-093",
];

/**
 * Every Core card whose own text removes a whole enemy board of ordinary units: #17 Flood ("bounce
 * all units"), #43 Big Felinor ("destroy all non-Felinor units"), #88 Twisting Nether ("destroy all
 * permanents") and #100 Ceaseless Void ("exile all other permanents"). #87 Pocket Chaos (swap boards
 * with an empty one) and #16 Hit Job (its radiant face takes the neighbours) are allowed too, and so
 * is #55 Lava Golem: its Tribute 3 may take enemy units (R101), so it is paid with the three 7/7s.
 */
const CLEARERS = ["core-017", "core-043", "core-088", "core-100", "core-087", "core-016", "core-055"];

/**
 * Every Core card that, played from p1's 4 mana, deals 3 or more to the enemy hero this turn:
 * #24 Efficiency Dividend (X damage to a target), #35 Lunar Eclipse (3 damage), #44 True Strike (4,
 * ignoring Armor), #45 Deft Duelist (a 4/3 with Charge), #68 Twisted Sorcerer (Cry: 4 damage) and
 * #74 Adaptive UI (X damage).
 */
const LETHAL_AT_3 = ["core-024", "core-035", "core-044", "core-045", "core-068", "core-074"];

describe("#97 Zephyrs — §10.7's dry run reads what a card's text does", () => {
  it("§10.7 'hero below 10 and card heals → high': at 5 health all three offers are cards that heal", () => {
    // Nothing is lethal (p2 is at 30 with no board on either side) and there is no enemy board to
    // clear, so the heal criterion is the highest one that applies. Seven Core cards heal their
    // controller's hero, so a scorer that ranks every one of them "high" offers three of them.
    const s = scenario({ seed: "r5-zephyrs-heal", p1: { hand: [ZEPHYRS, MENACE_FILLER], health: 5 } });
    s.play(ZEPHYRS);
    const offered = offeredIds(s);
    expect(offered).toHaveLength(3);
    expect(offered.filter((id) => !HEALERS.includes(id)), "offers that do not heal").toEqual([]);
  });

  it("§10.7 'can clear the enemy board → high': facing three 7/7s all three offers clear the board", () => {
    // Three #25 4-mana 7/7s (Armor 7): no unit in Core answers one alone, let alone three, while
    // Flood, Big Felinor, Twisting Nether and Ceaseless Void each remove the whole board by text.
    const s = scenario({
      seed: "r5-zephyrs-clear",
      p1: { hand: [ZEPHYRS, MENACE_FILLER] },
      p2: { field: ["core-025", "core-025", "core-025"] },
    });
    s.play(ZEPHYRS);
    const offered = offeredIds(s);
    expect(offered).toHaveLength(3);
    expect(offered.filter((id) => !CLEARERS.includes(id)), "offers that do not clear the board").toEqual([]);
  });

  it("§10.7 'lethal available → max': with the enemy hero at 3 all three offers deal the last 3", () => {
    // p1 has 4 mana (Zephyrs costs 0) and p2 has no board, so any card that puts 3 damage on the
    // enemy hero this turn is lethal: a burn spell as much as a Charge unit.
    const s = scenario({ seed: "r5-zephyrs-lethal", p1: { hand: [ZEPHYRS, MENACE_FILLER] }, p2: { health: 3 } });
    s.play(ZEPHYRS);
    const offered = offeredIds(s);
    expect(offered).toHaveLength(3);
    expect(offered.filter((id) => !LETHAL_AT_3.includes(id)), "offers that are not lethal").toEqual([]);
  });
});
