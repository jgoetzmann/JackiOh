// The Zephyrs scorer (SPEC §10.7's scorer bullet, R29, §8 #97; BUILD M3-T7).
//
// The candidate pool is pinned: this file registers its own small Core catalog, so every ranking
// below is a statement about a fixed state and a fixed pool, never about the weights' values
// (§10.7: "the weights are engine constants, tested against fixed states"). Tuning SCORER_WEIGHTS
// without changing the order of the priorities must leave this file green.

import type { CardDef, CardType, Keyword } from "@jackioh/shared";
import { describe, expect, it } from "vitest";
import { registerCatalog } from "../src/catalog";
import { cloneState, type GameState } from "../src/state";
import {
  candidateDefs,
  compareScored,
  projectedBoardDamage,
  rank,
  topThree,
  SCORER_LOW_HEALTH,
  ZEPHYRS_INDEX,
} from "../src/subsystems/scorer";
import { newGame, put, slot } from "./fixtures/harness";

// ---------------------------------------------------------------------------
// The pinned candidate pool.
// ---------------------------------------------------------------------------

type DefArgs = {
  index: string;
  cost?: number;
  type?: CardType;
  attack?: number;
  health?: number;
  keywords?: Keyword[];
  radiant?: { attack?: number; health?: number; keywords?: Keyword[] };
  token?: boolean;
  set?: CardDef["set"];
};

function def(name: string, args: DefArgs): CardDef {
  const { index, cost = 1, type = "Unit", attack, health, keywords = [] } = args;
  const base = type === "Unit" ? { attack, health, keywords, text: name } : { keywords, text: name };
  return {
    id: `sco-${name}`,
    index,
    name: `${name} (scorer)`,
    set: args.set ?? "Core",
    type,
    tags: [],
    rarity: "Common",
    token: args.token ?? false,
    cost,
    base,
    radiant:
      args.radiant === undefined
        ? base
        : {
            attack: args.radiant.attack ?? attack,
            health: args.radiant.health ?? health,
            keywords: args.radiant.keywords ?? keywords,
            text: `${name} radiant`,
          },
  };
}

/** Charge: the printed signal that a card can hit the hero on the turn it arrives (§6.1). */
const charger = def("charger", { index: "10", cost: 1, attack: 4, health: 4, keywords: [{ kind: "Charge" }] });
/** The best stats per mana in the pool, and the control case for every priority test. */
const bigBody = def("big-body", { index: "20", cost: 2, attack: 9, health: 9 });
/** Poisonous destroys any unit it damages, whatever its health (§6.1). */
const poisonSnake = def("poison", { index: "30", cost: 1, attack: 1, health: 1, keywords: [{ kind: "Poisonous" }] });
/** Lifesteal: the one heal printed on a card face (§6.1, §4.4 step 8). */
const healer = def("healer", { index: "40", cost: 1, attack: 3, health: 3, keywords: [{ kind: "Lifesteal" }] });
const vanilla = def("vanilla", { index: "50", cost: 1, attack: 2, health: 2 });
/** A spell prints no stats, and its text is not machine-readable, so it scores nothing. */
const cheapSpell = def("spell", { index: "60", cost: 0, type: "Spell" });
/** A backrow permanent keeps working after it lands (§3.2). */
const trapCard = def("trap", { index: "70", cost: 1, type: "Trap" });
/** Reborn is a second body from one card. */
const reborner = def("reborn", { index: "80", cost: 2, attack: 2, health: 2, keywords: [{ kind: "Reborn" }] });
/** Charge the viewer cannot afford in these states, so it never makes lethal available. */
const bigCharger = def("big-charger", { index: "90", cost: 5, attack: 9, health: 9, keywords: [{ kind: "Charge" }] });
/** #97 radiant: the picks are radiant, so a radiant-only body has to be scored on that face (§5.2). */
const sleeper = def("sleeper", { index: "85", cost: 1, attack: 0, health: 1, radiant: { attack: 20, health: 20 } });

/** R29: the scorer never offers Zephyrs itself. */
const zephyrs = def("zephyrs", { index: ZEPHYRS_INDEX, cost: 0, type: "Spell" });
/** §5.1: `query` never returns a token. */
const token = def("token", { index: "T-scorer", cost: 1, attack: 9, health: 9, token: true });
/** R29: Core only. */
const offSet = def("off-set", { index: "1", cost: 1, attack: 9, health: 9, set: "Classic" });

/** A 12-health body for the enemy board: only Poisonous answers it from printed data (§6.1). */
const wall = def("wall", { index: "95", cost: 1, attack: 2, health: 12 });

const POOL = [charger, bigBody, poisonSnake, healer, vanilla, cheapSpell, trapCard, reborner, bigCharger, sleeper];
const DEFS = [...POOL, zephyrs, token, offSet];

/** A fresh game whose catalog is exactly this file's pool, so a ranking is fully pinned. */
function game(seed: string, extra: CardDef[] = []): GameState {
  const state = newGame(seed);
  registerCatalog(Object.fromEntries([...DEFS, ...extra].map((entry) => [entry.id, entry])));
  state.turn = 3;
  state.active = "p1";
  return state;
}

const ids = (scored: { def: CardDef }[]): string[] => scored.map((entry) => entry.def.id);

describe("the Zephyrs scorer (R29, M3-T7)", () => {
  it("R29 ranks every non-token Core definition except #97 itself", () => {
    const state = game("scorer-pool");

    expect(candidateDefs().map((entry) => entry.id).sort()).toEqual(POOL.map((entry) => entry.id).sort());
    const ranked = rank(state, "p1");
    expect(ranked).toHaveLength(POOL.length);
    expect(ids(ranked)).not.toContain(zephyrs.id);
    expect(ids(ranked)).not.toContain(token.id);
    expect(ids(ranked)).not.toContain(offSet.id);
  });

  it("R29 is deterministic: the same state always produces the same order", () => {
    const state = game("scorer-determinism");
    put(state, bigBody.id, slot("p2", "units", 3));
    state.players.p1.hero.health = 7;
    state.players.p1.mana.current = 3;

    const first = ids(rank(state, "p1"));
    expect(ids(rank(state, "p1"))).toEqual(first);
    expect(ids(rank(state, "p1"))).toEqual(first);
    // §9.3: the state is JSON, so a round-tripped copy is the same state and ranks the same.
    expect(ids(rank(cloneState(state), "p1"))).toEqual(first);
    // A total order is a property of the pool, not of the seat that asked.
    expect(ids(rank(state, "p2"))).toHaveLength(POOL.length);
  });

  it("R29 returns a total order: no two candidates tie, whatever the weights are", () => {
    const state = game("scorer-total-order");
    const ranked = rank(state, "p1");

    expect(new Set(ids(ranked)).size).toBe(ranked.length);
    for (let i = 1; i < ranked.length; i += 1) {
      const before = ranked[i - 1];
      const after = ranked[i];
      expect(before).toBeDefined();
      expect(after).toBeDefined();
      if (before === undefined || after === undefined) continue;
      expect(before.score).toBeGreaterThanOrEqual(after.score);
      expect(compareScored(before, after)).toBeLessThan(0);
      expect(compareScored(after, before)).toBeGreaterThan(0);
    }

    // The order comes from the comparator, not from the order the catalog handed the pool over.
    const shuffled = [...ranked].reverse().sort(compareScored);
    expect(ids(shuffled)).toEqual(ids(ranked));
  });

  it("R29 ranks a card that enables lethal first, and only while the viewer can pay for it", () => {
    const state = game("scorer-lethal");
    // 2 damage on the board, 6 health on the enemy hero: the 4-attack Charge body closes the gap.
    put(state, vanilla.id, slot("p1", "units", 1));
    state.players.p2.hero.health = 6;
    state.players.p1.mana.current = 4;

    expect(projectedBoardDamage(state, "p1")).toBe(2);

    const ranked = rank(state, "p1");
    expect(ranked[0]?.def.id).toBe(charger.id);
    expect(ranked[0]?.priority).toBe("lethal");
    // The 5-cost Charge body would also be lethal, but 4 mana cannot pay for it.
    expect(ranked.filter((entry) => entry.priority === "lethal").map((entry) => entry.def.id)).toEqual([charger.id]);
    expect(topThree(state, "p1")[0]?.def.id).toBe(charger.id);

    // With no mana nothing is lethal, and the pool falls back to stats per mana.
    state.players.p1.mana.current = 0;
    const broke = rank(state, "p1");
    expect(broke.every((entry) => entry.priority !== "lethal")).toBe(true);
    expect(broke[0]?.def.id).toBe(bigBody.id);

    // Armor on the enemy hero takes the swing back out of lethal range (§4.4 step 2, R44).
    state.players.p1.mana.current = 4;
    state.players.p2.hero.armor = 2;
    expect(projectedBoardDamage(state, "p1")).toBe(0);
    expect(rank(state, "p1").every((entry) => entry.priority !== "lethal")).toBe(true);
  });

  it("R29 ranks clearing the enemy board above stats per mana", () => {
    const state = game("scorer-clear", [wall]);
    put(state, wall.id, slot("p2", "units", 2));

    const ranked = rank(state, "p1");
    expect(ranked[0]?.def.id).toBe(poisonSnake.id);
    expect(ranked[0]?.priority).toBe("clear");
    // The biggest body in the pool cannot answer a 12-health unit, so it is back on the fallback.
    const big = ranked.find((entry) => entry.def.id === bigBody.id);
    expect(big?.priority).toBe("value");
    expect(ids(ranked).indexOf(poisonSnake.id)).toBeLessThan(ids(ranked).indexOf(bigBody.id));
  });

  it("R29 gives partial credit when a card answers only part of the enemy board", () => {
    const state = game("scorer-partial-clear", [wall]);
    put(state, wall.id, slot("p2", "units", 2));
    put(state, wall.id, slot("p2", "units", 3));

    const ranked = rank(state, "p1");
    const poison = ranked.find((entry) => entry.def.id === poisonSnake.id);
    const plain = ranked.find((entry) => entry.def.id === vanilla.id);

    // One kill out of two is not a clear, but it still beats a body that answers nothing.
    expect(poison?.priority).toBe("value");
    expect(poison?.parts.kills).toBeGreaterThan(0);
    expect(poison?.parts.clear).toBe(0);
    expect(plain?.parts.kills).toBe(0);
    expect(ids(ranked).indexOf(poisonSnake.id)).toBeLessThan(ids(ranked).indexOf(vanilla.id));
  });

  it("R29 ranks a heal first only while the viewer's hero is below 10", () => {
    const state = game("scorer-heal");
    state.players.p1.hero.health = SCORER_LOW_HEALTH - 1;

    const low = rank(state, "p1");
    expect(low[0]?.def.id).toBe(healer.id);
    expect(low[0]?.priority).toBe("heal");

    // At exactly 10 the hero is not below 10, so the heal is worth no more than its body.
    state.players.p1.hero.health = SCORER_LOW_HEALTH;
    const fine = rank(state, "p1");
    expect(fine.every((entry) => entry.priority !== "heal")).toBe(true);
    expect(fine[0]?.def.id).toBe(bigBody.id);
  });

  it("R29 falls back to stats per mana plus draw value, and the Discover offers the top 3", () => {
    const state = game("scorer-top-three");
    const ranked = rank(state, "p1");

    // A fixed, empty state: nothing is lethal, there is no enemy board and the hero is at full.
    expect(ranked.every((entry) => entry.priority === "value")).toBe(true);
    expect(ids(ranked)).toEqual([
      bigBody.id, // 18 stats for 2 mana
      charger.id, // 8 stats for 1 mana
      healer.id, // 6 stats for 1 mana
      reborner.id, // 4 stats for 2 mana, plus a second body
      vanilla.id, // 4 stats for 1 mana
      bigCharger.id, // 18 stats for 5 mana
      poisonSnake.id, // 2 stats for 1 mana
      trapCard.id, // no stats, but it stays on the board
      sleeper.id, // 1 stat for 1 mana on its base face
      cheapSpell.id, // no stats, and its text is not machine-readable
    ]);

    const three = topThree(state, "p1");
    expect(three).toHaveLength(3);
    expect(ids(three)).toEqual([bigBody.id, charger.id, healer.id]);
    expect(ids(three)).toEqual(ids(ranked.slice(0, 3)));
  });

  it("§8 #97 radiant scores the radiant face of each candidate", () => {
    const state = game("scorer-radiant");

    expect(rank(state, "p1")[0]?.def.id).toBe(bigBody.id);
    // The sleeper is a 0/1 that prints a 20/20 radiant face, so radiant picks put it first (§5.2).
    expect(rank(state, "p1", { radiant: true })[0]?.def.id).toBe(sleeper.id);
    expect(ids(topThree(state, "p1", { radiant: true }))).toEqual([sleeper.id, bigBody.id, charger.id]);
  });
});
