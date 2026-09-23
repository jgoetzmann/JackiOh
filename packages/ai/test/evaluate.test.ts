// The AI's board evaluation (SPEC §9.9 "Evaluation"; docs/polish/3-ai.md B13).
//
// The weights in AI_EVAL are tuning defaults the builder may change, so nothing here pins a number
// `evaluate` returns. What is pinned is the ordering the behaviour states: a won game over any
// unfinished one over a lost one; more own health, a bigger own board and a smaller enemy board
// each strictly better; and a Taunt blocker that absorbs a lethal board strictly better than none.
// `faceThreat` is pinned exactly where its surface text fixes the arithmetic.

import { describe, expect, it } from "vitest";
import type { PlayerId } from "@jackioh/shared";
import { AI_DIFFICULTY, HERO_HEALTH, type GameState } from "@jackioh/engine";
import { AI_EVAL, evaluate, faceThreat, unitWorth } from "../src/index";
import { AI, clone, scenario, type ScenarioOptions } from "./_support";

function board(opts: ScenarioOptions): GameState {
  return scenario({ seed: "evaluate", ...opts }).state;
}

function withHealth(state: GameState, player: PlayerId, health: number): GameState {
  const out = clone(state);
  out.players[player].hero.health = health;
  return out;
}

function finished(state: GameState, winner: PlayerId | "draw"): GameState {
  const out = clone(state);
  out.result = { winner, reason: winner === "draw" ? "turn-cap" : "hero-death" };
  out.phase = "over";
  return out;
}

const BASE: ScenarioOptions = {
  p1: { hand: ["core-008"], field: ["core-011"] },
  p2: { hand: ["core-005"], field: ["core-008"] },
};

describe("evaluate (B13)", () => {
  it("B13: a won game scores above any unfinished one, and a lost game below any", () => {
    const best = board({
      p1: { field: ["core-019", "core-025", "core-020", "core-011", "core-008"], hand: ["core-044"], health: HERO_HEALTH },
      p2: { health: 1 },
    });
    const worst = board({
      p1: { health: 1 },
      p2: { field: ["core-019", "core-025", "core-020", "core-011", "core-008"], hand: ["core-044", "core-035"] },
    });
    const middle = board(BASE);

    for (const unfinished of [best, worst, middle]) {
      expect(evaluate(finished(unfinished, AI), AI)).toBeGreaterThan(evaluate(best, AI));
      expect(evaluate(finished(unfinished, "p2"), AI)).toBeLessThan(evaluate(worst, AI));
    }
    expect(evaluate(best, AI)).toBeGreaterThan(evaluate(worst, AI));
  });

  it("B13: a drawn game scores AI_EVAL.drawn, between any win and any loss", () => {
    const base = board(BASE);
    const drawn = evaluate(finished(base, "draw"), AI);
    expect(drawn).toBe(AI_EVAL.drawn);
    expect(drawn).toBeLessThan(evaluate(finished(base, AI), AI));
    expect(drawn).toBeGreaterThan(evaluate(finished(base, "p2"), AI));
  });

  it("B13: a win the engine really reached scores above the state before it, from the winner's side only", () => {
    const s = scenario({ seed: "evaluate-kill", p1: { field: ["core-011"], hand: ["core-008"] }, p2: { health: 3, hand: ["core-005"] } });
    const before = s.state;
    s.attack("core-011", "hero");
    const after = s.state;

    expect(after.result?.winner).toBe(AI);
    expect(evaluate(after, AI)).toBeGreaterThan(evaluate(before, AI));
    expect(evaluate(after, "p2")).toBeLessThan(evaluate(before, "p2"));
  });

  it("B13: more own hero health strictly raises the score, at every health from 1 to 30", () => {
    const base = board(BASE);
    for (let health = 1; health < HERO_HEALTH; health += 1) {
      const lower = evaluate(withHealth(base, AI, health), AI);
      const higher = evaluate(withHealth(base, AI, health + 1), AI);
      expect(higher, `${health + 1} over ${health}`).toBeGreaterThan(lower);
    }
  });

  it("B13: less enemy hero health raises the score", () => {
    const base = board(BASE);
    expect(evaluate(withHealth(base, "p2", 10), AI)).toBeGreaterThan(evaluate(withHealth(base, "p2", 20), AI));
  });

  it("B13: a bigger own board strictly raises the score", () => {
    const empty = board({ p1: {}, p2: BASE.p2 });
    const one = board({ p1: { field: ["core-011"] }, p2: BASE.p2 });
    const two = board({ p1: { field: ["core-011", "core-020"] }, p2: BASE.p2 });
    expect(evaluate(one, AI)).toBeGreaterThan(evaluate(empty, AI));
    expect(evaluate(two, AI)).toBeGreaterThan(evaluate(one, AI));
  });

  it("B13: a smaller enemy board strictly raises the score", () => {
    const two = board({ p1: BASE.p1, p2: { field: ["core-008", "core-020"] } });
    const one = board({ p1: BASE.p1, p2: { field: ["core-008"] } });
    const none = board({ p1: BASE.p1, p2: {} });
    expect(evaluate(one, AI)).toBeGreaterThan(evaluate(two, AI));
    expect(evaluate(none, AI)).toBeGreaterThan(evaluate(one, AI));
  });

  it("B13: each unseen card in the enemy's hand lowers the score", () => {
    const none = board({ p1: BASE.p1, p2: { field: ["core-008"] } });
    const one = board({ p1: BASE.p1, p2: { field: ["core-008"], hand: ["core-005"] } });
    const three = board({ p1: BASE.p1, p2: { field: ["core-008"], hand: ["core-005", "core-044", "core-035"] } });
    expect(evaluate(one, AI)).toBeLessThan(evaluate(none, AI));
    expect(evaluate(three, AI)).toBeLessThan(evaluate(one, AI));
  });

  it("B13: a lethal enemy board scores lower than the same board plus our Taunt blocker that absorbs it", () => {
    const enemy = { field: ["core-011", "core-020"] } as const;
    const exposed = board({ p1: { health: 5 }, p2: enemy });
    const blocked = board({ p1: { health: 5, field: ["core-019"] }, p2: enemy });

    expect(faceThreat(exposed, "p2")).toBeGreaterThanOrEqual(5);
    expect(faceThreat(blocked, "p2")).toBeLessThan(5);
    expect(evaluate(blocked, AI)).toBeGreaterThan(evaluate(exposed, AI));
  });

  it("R180 B13: evaluate reads no handicap, so every tier scores a state alike", () => {
    const base = board(BASE);
    const hard = clone(base);
    hard.players.p1.handicap = { ...AI_DIFFICULTY.hard };
    const medium = clone(base);
    medium.players.p2.handicap = { ...AI_DIFFICULTY.medium };
    expect(evaluate(hard, AI)).toBe(evaluate(base, AI));
    expect(evaluate(medium, AI)).toBe(evaluate(base, AI));
  });

  it("B13: evaluate is pure: it neither mutates the state nor varies between calls", () => {
    const base = board(BASE);
    const before = JSON.stringify(base);
    const first = evaluate(base, AI);
    expect(evaluate(base, AI)).toBe(first);
    expect(JSON.stringify(base)).toBe(before);
  });
});

describe("evaluate: the strength pass's terms", () => {
  it("every point of damage on the enemy hero is worth at least AI_EVAL.enemyHealth", () => {
    const state = board(BASE);
    for (const health of [30, 20, 10, 2]) {
      const gain = evaluate(withHealth(state, "p2", health - 1), AI) - evaluate(withHealth(state, "p2", health), AI);
      expect(gain, `from ${health}`).toBeGreaterThanOrEqual(AI_EVAL.enemyHealth);
    }
  });

  it("scored where the seat moves first, the enemy's threat counts only its answerable share", () => {
    // Mr. Vanilla threatens 3 into an empty board at 30 health: no lethal either way, and p1 has no
    // attacker, so the frames differ only in the threat term.
    const state = board({ p1: {}, p2: { field: ["core-008"] } });
    expect(faceThreat(state, "p2")).toBe(3);
    expect(faceThreat(state, AI)).toBe(0);
    const threat = AI_EVAL.threatPerDamage * 3;
    expect(evaluate(state, AI, "seat") - evaluate(state, AI, "enemy")).toBeCloseTo(
      (1 - AI_EVAL.answerableThreat) * threat,
      10,
    );
  });

  it("Defense Position's Taunt and Armor add no worth of their own: the unit loses only its attack share", () => {
    const attack = board({ p1: { field: ["core-008"] } });
    const defense = board({ p1: { field: [{ def: "core-008", position: "DEF" }] } });
    const unitIn = (state: GameState) => state.players[AI].units[0]?.[0];
    const atk = unitIn(attack);
    const def = unitIn(defense);
    if (atk === undefined || def === undefined) throw new Error("Mr. Vanilla is not on p1's field");
    // Mr. Vanilla is 3/3 with no printed Taunt or Armor.
    const lost = (1 - AI_EVAL.defenseAttackShare) * AI_EVAL.attack * 3;
    const kept = AI_EVAL.positionGrants * (AI_EVAL.keyword.Taunt + AI_EVAL.armorPoint);
    expect(unitWorth(attack, atk) - unitWorth(defense, def)).toBeCloseTo(lost - kept, 10);
  });
});

describe("faceThreat (B13)", () => {
  const enemy = ["core-011", "core-020"] as const; // 3 and 7 attack, both in Attack Position

  it("B13: sums the enemy's attackers into our face when nothing blocks", () => {
    expect(faceThreat(board({ p1: {}, p2: { field: [...enemy] } }), "p2")).toBe(10);
    expect(faceThreat(board({ p1: {}, p2: {} }), "p2")).toBe(0);
  });

  it("B13: hero Armor is subtracted from each hit, not from the total", () => {
    expect(faceThreat(board({ p1: { armor: 2 }, p2: { field: [...enemy] } }), "p2")).toBe(6);
  });

  it("B13: a unit in Defense Position is not an attacker", () => {
    const state = board({ p1: {}, p2: { field: ["core-011", { def: "core-020", position: "DEF" }] } });
    expect(faceThreat(state, "p2")).toBe(3);
  });

  it("B13: a big Taunt soaks up every attacker that its health covers, smallest first", () => {
    expect(faceThreat(board({ p1: { field: ["core-019"] }, p2: { field: [...enemy] } }), "p2")).toBe(0);
  });

  it("B13: a small Taunt with Divine Shield soaks the smallest attacker plus one more, and the rest get through", () => {
    // Jilliax (3/2 Taunt, Divine Shield) against 3, 3 and 7: the two 3s are spent on it, 7 reaches us.
    const state = board({ p1: { field: ["core-056"] }, p2: { field: ["core-011", "core-008", "core-020"] } });
    expect(faceThreat(state, "p2")).toBe(7);
  });

  it("B13: attack is read through the layers: a 0-attack unit threatens nothing, and its aura drains the rest", () => {
    // #65.1 Spikey Pillow (0/2, "your units have −2 attack") beside Tempo Timmy (3): only 1 gets through.
    const state = board({ p1: {}, p2: { field: ["core-065-1", "core-011"] } });
    expect(faceThreat(state, "p2")).toBe(1);
    expect(faceThreat(board({ p1: {}, p2: { field: ["core-065-1"] } }), "p2")).toBe(0);
  });

  it("B13: the Anti-oneshot cap applies to each hit, not to the total", () => {
    // #73 Anti-oneshot Armor caps each hit on p1's hero at 5: 7 becomes 5, 3 stays 3.
    const state = board({ p1: { backrow: ["core-073"] }, p2: { field: [...enemy] } });
    expect(faceThreat(state, "p2")).toBe(8);
  });

  it("B13: our own board's threat is read the same way in the other direction", () => {
    const state = board({ p1: { field: [...enemy] }, p2: {} });
    expect(faceThreat(state, AI)).toBe(10);
    expect(faceThreat(state, "p2")).toBe(0);
  });
});
