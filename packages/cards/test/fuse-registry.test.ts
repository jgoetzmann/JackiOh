// A fused card's scripts across matches in one process (SPEC §9.2, §9.3, R77, R102, R179). Found by
// the polish-4 edge-case hunt (docs/polish/4-edge-cases.md, lens L7); it failed before its fix.
//
// A fused definition is match state, but its scripts are code the process registers under the
// definition's id. A server runs every match in one process and folds a match's log to rebuild it,
// so two matches that fused different pairs into the same slot must not share an id: R179 has the id
// name its ingredients, so the later fusion can no longer replace the earlier match's scripts.

import { reduce, type CardInstance, type GameState } from "@jackioh/engine";
import { describe, expect, it } from "vitest";
import { scenario, type Scenario } from "./_harness";

const SHREDDER = "core-013";
const MENACE = "core-019";
const POINTMASTER = "core-020";
const SEVEN_SEVEN = "core-025";
const RENO = "core-053";
const UNLICENSED = "core-085";
const LIBRARY = [RENO, RENO, RENO, RENO, RENO, RENO];

function unitAt(g: Scenario, player: "p1" | "p2", lane: number): CardInstance {
  const card = g.unit(player, lane);
  if (card === null) throw new Error(`setup: ${player} should hold a unit in lane ${lane}`);
  return card;
}

/** p1 plays Pointmaster into p2's Unlicensed Experimentation, which fuses it onto p2's lane-1 unit. */
function fusedOnto(bigUnit: string): Scenario {
  const g = scenario({
    p1: { hand: [POINTMASTER, RENO, RENO], field: [{ def: SEVEN_SEVEN, lane: 5 }], library: [...LIBRARY] },
    p2: {
      hand: [RENO, RENO],
      field: [{ def: bigUnit, lane: 1 }],
      backrow: [{ def: UNLICENSED, lane: 1 }],
      library: [...LIBRARY],
    },
  });
  g.play(POINTMASTER);
  return g;
}

/** From a saved state: p1 ends the turn, then p2 does; p1's hero health after it. */
function heroAfterP2EndsTurn(saved: GameState): number {
  let state = JSON.parse(JSON.stringify(saved)) as GameState;
  for (const player of ["p1", "p2"] as const) {
    const result = reduce(state, { type: "endTurn", playerId: player, nonce: `fuse-${player}` });
    expect(result.error).toBeUndefined();
    state = result.state;
  }
  return state.players.p1.hero.health;
}

describe("R179: a fused definition's id names its ingredients", () => {
  it("R179 a fused card keeps its own scripts when another match in the same process fuses a different pair into the same slot (§9.3, R77)", () => {
    // Match A fuses Pointmaster onto Jlockeed Shredder-10 ("End of turn: deal 2 damage to each
    // enemy unit and the enemy hero"); only its JSON is kept, as a match actor keeps it (§9.3).
    const a = fusedOnto(SHREDDER);
    const fusedA = a.card(unitAt(a, "p2", 1)).defId;
    expect(a.state.transientDefs[fusedA]).toBeDefined();
    expect(fusedA).toBe(`t-1:${POINTMASTER}+${SHREDDER}`);
    const savedA = JSON.parse(JSON.stringify(a.state)) as GameState;
    expect(heroAfterP2EndsTurn(savedA)).toBe(28);

    // Match B, same process, same fusion slot, a different pair (Midrange Menace heals itself at the
    // end of the turn and deals no damage): a different id, so its scripts register beside A's.
    const b = fusedOnto(MENACE);
    const fusedB = b.card(unitAt(b, "p2", 1)).defId;
    expect(fusedB).toBe(`t-1:${POINTMASTER}+${MENACE}`);
    expect(fusedB).not.toBe(fusedA);

    // Back in A, from the very same saved state: nothing about A changed, so neither may the result.
    expect(heroAfterP2EndsTurn(savedA)).toBe(28);
  });
});
