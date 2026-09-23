// Hand-built puzzles P1–P14 (docs/polish/3-ai.md B17–B19, the puzzle table).
//
// Every puzzle is a `scenario({ active: "p1", turn: 9, … })` with the AI as p1, p2 at 30 health
// unless stated and every p1 unit not summoning sick (the harness default). The AI plays one whole
// turn through `playAiTurn` at AI_BUDGET, the budget the browser plays at, and each puzzle holds
// its stated assertion. The gate is at least 12 of the 14 passing: all 14 are written, and a
// puzzle may be removed at reconcile only with a written reason in this file.
//
//   B17 lethal   P1–P6: the enemy hero is dead at the end of the AI's turn, and the AI's first
//                decision already says "lethal".
//   B18 tactics  P7–P10, P12, P13: no bad trade; survive a scripted all-out attack next turn;
//                spend the mana on the stronger play; spend removal on the biggest threat.
//   B19 prompts  P11 discovers True Strike off Reminisce and casts it for lethal; P14 answers
//                Masochism Mask's start-of-turn prompt at 3 health without losing health or
//                summoning the Spikey Pillow, through the search (reason "prompt").

import { describe, expect, it } from "vitest";
import { createRng, type GameState } from "@jackioh/engine";
import { AI_BUDGET, decide, playAiTurn } from "../src/index";
import {
  AI,
  HUMAN,
  act,
  allOutAttack,
  cardById,
  inGraveyard,
  onField,
  runPuzzle,
  scenario,
  trace,
  type PuzzleRun,
} from "./_support";

const PUZZLE_TIMEOUT = 120_000;

function expectEnemyDead(run: PuzzleRun): void {
  expect(run.end.result?.winner, trace(run.turn)).toBe(AI);
  expect(run.end.players.p2.hero.health, trace(run.turn)).toBeLessThanOrEqual(0);
}

function expectFirstReasonLethal(run: PuzzleRun): void {
  expect(run.turn.decisions.length, trace(run.turn)).toBeGreaterThan(0);
  expect(run.turn.decisions[0]?.reason, trace(run.turn)).toBe("lethal");
}

/** After the AI's turn, p2 swings with everything; p1 must still be standing. */
function expectSurvivesAllOut(run: PuzzleRun): GameState {
  expect(run.end.result, trace(run.turn)).toBeNull();
  const after = allOutAttack(run.end, HUMAN);
  expect(after.result?.winner ?? null, trace(run.turn)).not.toBe(HUMAN);
  expect(after.players.p1.hero.health, trace(run.turn)).toBeGreaterThan(0);
  return after;
}

// ---------------------------------------------------------------------------------------------
// B17: lethal
// ---------------------------------------------------------------------------------------------

describe("lethal (B17)", () => {
  it("B17 P1: two attackers into an empty board finish a 6-health hero, lethal from the first decision", { timeout: PUZZLE_TIMEOUT }, () => {
    const run = runPuzzle("P1", {
      p1: { field: ["core-011", "core-008"] },
      p2: { health: 6 },
    });
    expectEnemyDead(run);
    expectFirstReasonLethal(run);
  });

  it("B17 P2: Pointmaster clears the Defense-Position blocker and the rest go face for 6", { timeout: PUZZLE_TIMEOUT }, () => {
    const run = runPuzzle("P2", {
      p1: { field: ["core-020", "core-011", "core-008"] },
      p2: { field: [{ def: "core-008", position: "DEF" }], health: 6 },
    });
    expectEnemyDead(run);
    expectFirstReasonLethal(run);
  });

  it("B17 P3: Plastic Surgery on Tempo Timmy, then the attack, for 6", { timeout: PUZZLE_TIMEOUT }, () => {
    const run = runPuzzle("P3", {
      p1: { hand: ["core-063"], mana: 1, field: ["core-011"] },
      p2: { health: 6 },
    });
    expectEnemyDead(run);
    expectFirstReasonLethal(run);
    expect(run.turn.decisions[0]?.action.type, trace(run.turn)).toBe("play");
  });

  it("B17 P4: True Strike to the face past a Taunt the attacker cannot get through", { timeout: PUZZLE_TIMEOUT }, () => {
    const run = runPuzzle("P4", {
      p1: { hand: ["core-044"], mana: 1, field: ["core-011"] },
      p2: { field: ["core-019"], health: 4 },
    });
    expectEnemyDead(run);
    expectFirstReasonLethal(run);
  });

  it("B17 P5: Deft Duelist's Charge from hand into an empty board for 4", { timeout: PUZZLE_TIMEOUT }, () => {
    const run = runPuzzle("P5", {
      p1: { hand: ["core-045"], mana: 2 },
      p2: { health: 4 },
    });
    expectEnemyDead(run);
    expectFirstReasonLethal(run);
  });

  it("B17 P6: Lunar Eclipse to the face plus Tempo Timmy's attack for 6", { timeout: PUZZLE_TIMEOUT }, () => {
    const run = runPuzzle("P6", {
      p1: { hand: ["core-035"], mana: 1, field: ["core-011"] },
      p2: { health: 6 },
    });
    expectEnemyDead(run);
    expectFirstReasonLethal(run);
  });
});

// ---------------------------------------------------------------------------------------------
// B18: tactics
// ---------------------------------------------------------------------------------------------

describe("tactics (B18)", () => {
  it("B18 P7: Mr. Vanilla does not throw itself into the 7/7 with Armor 7", { timeout: PUZZLE_TIMEOUT }, () => {
    const run = runPuzzle("P7", {
      p1: { field: ["core-008"] },
      p2: { field: ["core-025"] },
    });
    expect(onField(run.end, AI, "core-008"), trace(run.turn)).toBe(true);
  });

  it("B18 P8: at 8 health against 7 + 3 on board, the 7/7 deals with the threat and p1 survives the swing back", { timeout: PUZZLE_TIMEOUT }, () => {
    const run = runPuzzle("P8", {
      p1: { health: 8, field: ["core-025"] },
      p2: { field: ["core-020", "core-011"] },
    });
    expectSurvivesAllOut(run);
  });

  it("B18 P9: at 5 health with an empty board, Jilliax goes down to block 4 + 3 and p1 survives the swing back", { timeout: PUZZLE_TIMEOUT }, () => {
    const run = runPuzzle("P9", {
      p1: { health: 5, hand: ["core-056"], mana: 2 },
      p2: { field: ["core-045", "core-011"] },
    });
    expectSurvivesAllOut(run);
  });

  it("B18 P10: at 3 health facing Tempo Timmy, Fig of Life heals and p1 survives the swing back", { timeout: PUZZLE_TIMEOUT }, () => {
    const run = runPuzzle("P10", {
      p1: { health: 3, hand: ["core-047"], mana: 3 },
      p2: { field: ["core-011"] },
    });
    expectSurvivesAllOut(run);
  });

  it("B18 P12: with 4 mana on empty boards the AI plays the 4-mana 7/7, not the 1-drop", { timeout: PUZZLE_TIMEOUT }, () => {
    const run = runPuzzle("P12", {
      p1: { hand: ["core-025", "core-011"], mana: 4 },
      p2: {},
    });
    expect(onField(run.end, AI, "core-025"), trace(run.turn)).toBe(true);
  });

  it("B18 P13: Hit Job goes on Midrange Menace, the biggest threat", { timeout: PUZZLE_TIMEOUT }, () => {
    const run = runPuzzle("P13", {
      p1: { hand: ["core-016"], mana: 2, field: ["core-011"] },
      p2: { field: ["core-019", "core-008"] },
    });
    expect(inGraveyard(run.end, HUMAN, "core-019"), trace(run.turn)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// B19: prompts through the search
// ---------------------------------------------------------------------------------------------

describe("prompts through the search (B19)", () => {
  it("B19 P11: Reminisce discovers True Strike from the graveyard, and True Strike finishes the hero", { timeout: PUZZLE_TIMEOUT }, () => {
    const s = scenario({
      seed: "puzzle-P11",
      active: AI,
      turn: 9,
      p1: { hand: ["core-072"], mana: 1, graveyard: ["core-044", "core-008", "core-005"] },
      p2: { health: 4, field: ["core-019"] },
    });
    const trueStrike = s.pile(AI, "graveyard").find((card) => card.defId === "core-044");
    if (trueStrike === undefined) throw new Error("True Strike is not in p1's graveyard");

    const turn = playAiTurn(s.state, AI, { rng: createRng("puzzle:P11"), budget: AI_BUDGET });
    const run: PuzzleRun = { start: s.state, turn, end: turn.state };
    expectEnemyDead(run);

    const discover = turn.decisions.find((decision) => decision.action.type === "answer");
    expect(discover, trace(turn)).toBeDefined();
    const selection = discover?.action.type === "answer" ? discover.action.selection : [];
    expect(selection, trace(turn)).toEqual([{ pick: "instance", instanceId: trueStrike.id }]);
    // The discovered True Strike is the card the AI then played.
    expect(
      turn.actions.some((action) => action.type === "play" && action.instanceId === trueStrike.id),
      trace(turn),
    ).toBe(true);
    expect(cardById(turn.state, trueStrike.id)?.zone.z, trace(turn)).not.toBe("hand");
  });

  it("B19 P14: at 3 health the AI answers Masochism Mask with neither 'lose 3' nor the Spikey Pillow, through the search", { timeout: PUZZLE_TIMEOUT }, () => {
    // The table gives p1 "a card in hand and in library". The hand card is a unit, so the Pillow's
    // aura (−2 attack to your units) is a cost the search can see; the library holds two cards so
    // that exiling its bottom card can never leave the turn's draw to fatigue, in either order.
    const s = scenario({
      seed: "puzzle-P14",
      active: HUMAN,
      turn: 10,
      p1: { health: 3, backrow: ["core-065"], hand: ["core-019"], library: ["core-008", "core-011"] },
      p2: { hand: ["core-005"] },
    });
    s.endTurn();
    const state = s.state;
    expect(state.active).toBe(AI);
    expect(state.pending?.playerId, "Masochism Mask asks at the start of p1's turn").toBe(AI);
    expect(state.pending?.kind).toBe("mode");
    expect(state.players.p1.hero.health).toBe(3);

    const decision = decide(state, AI, { rng: createRng("puzzle:P14"), budget: AI_BUDGET });
    expect(decision?.reason).toBe("prompt");
    expect(decision?.action.type).toBe("answer");

    const after = act(state, AI, (decision as NonNullable<typeof decision>).action);
    expect(after.result).toBeNull();
    expect(after.players.p1.hero.health).toBe(3);
    expect(onField(after, AI, "core-065-1")).toBe(false);
  });
});
