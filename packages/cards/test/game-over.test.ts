// Nothing happens after the game is over (SPEC §2.5, §4.5 step 2, R96, R216). Found by the polish-4
// edge-case hunt, round 4 (docs/polish/4-edge-cases.md, lens "engine invariants"), which checked
// seeded random games for a finished game that stays finished; every case here failed before its
// fix, and the fuzz monitor's I5 now checks the same thing in every random game.
//
// Round 5 (lens L1) found /fullsend's Combo draws drawing on, one per rider, after a cast inside the
// first had ended the game. Round 7 (lens "engine invariants") found a game conceded under an open
// Discover still holding the prompt, which nothing could answer.
//
// The check that finds a hero at 0 or less ends the game at once. Whatever was still to resolve then
// does not: the rest of the effect list the check ran inside, owed work, queued triggers, or a trap's
// consumption after the AI turn it handed over has ended the game.

import type { Action } from "@jackioh/shared";
import { legalActions, reduce, viewFor } from "@jackioh/engine";
import { describe, expect, it } from "vitest";
import { scenario } from "./_harness";

const STOCKPILE = "core-005";
const SHREDDER = "core-013";
const MENACE = "core-019";
const RENO = "core-053";
const CN_VIRUS = "core-090-1";
const MY_PAWN = "core-096";
const VANILLA = "core-008";
const HINDER = "core-021";
const FULLSEND = "core-078";
const SCARAB = "core-007";
const POINTMASTER = "core-020";

describe("R216: nothing happens after the game is over", () => {
  it("R216 #5 Stockpile's heal does not follow the CN-Virus cast that killed its hero (§2.5, §4.5, §2.4)", () => {
    // p1 at 1 health draws a CN-Virus off Stockpile's "draw 2": the cast deals p1 1 damage, and
    // §2.4's chain runs §4.5's check after that cast, which ends the game (§2.5). Stockpile's
    // "heal your hero 2" is the rest of a script whose game is already decided.
    const s = scenario({
      seed: "inv-r4-after-game-over",
      p1: { hand: [STOCKPILE], health: 1, library: [CN_VIRUS, RENO, MENACE] },
      p2: { hand: [RENO], field: [MENACE] },
    });
    s.play(STOCKPILE);

    expect(s.state.result).toEqual({ winner: "p2", reason: "hero-death" });
    const types = s.lastEvents.map((event) => event.type);
    // gameOver is the last thing that happens: no heal, draw or anything else after it.
    expect(types.slice(types.indexOf("gameOver") + 1)).toEqual([]);
    // The state that says p1 lost by hero death still shows p1's hero dead.
    expect(s.state.players.p1.hero.health).toBeLessThanOrEqual(0);
  });

  it("R216 #96 My Pawn is not consumed after the AI turn it handed over ended the game (§2.5, R152)", () => {
    // p2's Jlockeed Shredder swings for lethal at p1 (2 health); My Pawn cancels it and hands the
    // rest of p2's turn to the AI (R44), which has nothing left but to end it. Shredder's
    // end-of-turn 2 damage kills p1 and the game is over (§2.5) — and nothing then consumes the trap.
    const s = scenario({
      seed: "inv-r4-pawn-after-game-over",
      active: "p2",
      p1: { health: 2, backrow: [{ def: MY_PAWN, faceUp: false }], hand: [RENO] },
      p2: { field: [SHREDDER] },
    });
    s.attack(SHREDDER, "hero");

    expect(s.state.result).toEqual({ winner: "p2", reason: "hero-death" });
    const types = s.lastEvents.map((event) => event.type);
    expect(types).toContain("trapFired");
    expect(types.slice(types.indexOf("gameOver") + 1)).toEqual([]);
  });

  it("R216 /fullsend's Combo draws stop once a cast-on-draw draw inside them has ended the game (§2.5, §2.4, §10.5 step 5)", () => {
    // Two /fullsends make two "Combo: draw 1" riders. The Vanilla played after them owes two draws;
    // the first draws Hinder, which is cast (R70) and owes the same two draws of its own, both from an
    // empty library (fatigue 1, then 2), and the check after that cast finds p1 at 0 or less: the
    // game is over. The Vanilla's second Combo draw must not happen.
    const g = scenario({
      p1: { hand: [FULLSEND, FULLSEND, VANILLA], mana: 10, health: 2, library: [VANILLA, HINDER] },
      p2: { field: [{ def: VANILLA, lane: 1 }] },
    });
    g.play(FULLSEND);
    g.play(FULLSEND);
    g.play(VANILLA);

    const types = g.lastEvents.map((event) => event.type);
    const over = types.indexOf("gameOver");
    expect(over, types.join(", ")).toBeGreaterThanOrEqual(0);
    expect(types.slice(over + 1), types.join(", ")).toEqual([]);
    expect(g.state.players.p1.fatigueCount).toBe(2);
  });
});

describe("R216: a question still open when the game ends is closed with it", () => {
  it("R216 a game that ends while a prompt is open leaves no prompt open (§2.5, R211)", () => {
    const s = scenario({
      seed: "r7-concede-at-prompt",
      p1: { hand: [SCARAB], mana: 4 },
      p2: { field: [POINTMASTER] },
    });
    s.play(SCARAB);
    expect(s.view("p1").pending?.forYou).toBe(true);

    // R211: the other seat may concede while p1's Discover is open.
    const over = reduce(s.state, { type: "concede", playerId: "p2", nonce: "r7-concede" } as Action);
    expect(over.error).toBeUndefined();
    expect(over.state.result).toEqual({ winner: "p1", reason: "concede" });
    // Nothing can answer the Discover any more: legalActions offers nothing once the game is over...
    expect(legalActions(over.state, "p1")).toEqual([]);
    // ...so the finished game does not still hold it open, nor show it to either seat, and
    // `gameOver` is the action's last event.
    expect(over.state.pending).toBeNull();
    expect(viewFor(over.state, "p1").pending).toBeNull();
    expect(viewFor(over.state, "p2").pending).toBeNull();
    expect(over.events[over.events.length - 1]?.type).toBe("gameOver");
  });
});
