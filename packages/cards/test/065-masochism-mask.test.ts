// #65 Masochism Mask — SPEC §8.3, §10.6, BUILD M4-T4 row 65.
//
// Must-pass: "In opening hand (Quickdraw); start-of-turn mode prompt; 'lose 3' ignores armor;
// radiant two picks including 'nothing'."

import { describe, expect, it } from "vitest";
import type { CardInstance } from "@jackioh/engine";
import type { PlayerId } from "@jackioh/shared";
import { base, radiant } from "../src/scripts/065-masochism-mask";
import { scenario, type Scenario } from "./_harness";

const MASK = "core-065"; // Field Spell, 2, Quickdraw
const PILLOW = "core-065-1"; // #65.1, the token the third option summons
const MENACE = "core-019"; // library filler: the top card, so the start-of-turn draw is known
const TIMMY = "core-011";
const POSTDOC = "core-061"; // the bottom card of the library in the exile test

// The prompt options as §8.3's two cells word them. They travel to the client in
// `state.pending.options` (a prompt, not a declared mode, R81), so this is where they are pinned.
const EXILE_BOTTOM = "exile bottom";
const LOSE_THREE = "lose 3";
const SUMMON_PILLOW = "summon Spikey Pillow";
const NOTHING = "nothing";

/** A library whose top is #19 and whose BOTTOM is #61 (`library[0]` is the top). */
const LIBRARY = [MENACE, TIMMY, POSTDOC];

function unitAt(s: Scenario, player: PlayerId, lane: number): CardInstance {
  const found = s.unit(player, lane);
  if (found === null) throw new Error(`expected a unit in ${player} lane ${lane}, found none`);
  return found;
}

function optionLabels(s: Scenario): string[] {
  return (s.state.pending?.options ?? []).map((option) => option.label);
}

function maskScenario(faceRadiant: boolean): Scenario {
  return scenario({
    p1: { backrow: [{ def: MASK, radiant: faceRadiant }], library: LIBRARY, armor: 5 },
    p2: { hand: [MENACE], field: [MENACE] },
  });
}

describe("#65 Masochism Mask", () => {
  it("§6.2 Quickdraw: both faces carry the flag that starts the card in the opening hand", () => {
    // `setup.ts` reads the flag and swaps one opening draw for it; that placement is the engine's
    // own setup test. What this card owes is the flag, on both faces.
    expect(base.staticFlags?.quickdraw).toBe(true);
    expect(radiant.staticFlags?.quickdraw).toBe(true);
  });

  it("§10.6 the start of your turn opens a mode prompt with the three options", () => {
    const s = maskScenario(false).startTurn();

    const pending = s.state.pending;
    expect(pending).not.toBeNull();
    expect(pending?.kind).toBe("mode");
    expect(pending?.playerId).toBe("p1");
    expect(pending?.min).toBe(1);
    expect(pending?.max).toBe(1);
    expect(optionLabels(s)).toEqual([EXILE_BOTTOM, LOSE_THREE, SUMMON_PILLOW]);
    s.expectEvents("turnStarted", "promptOpened");
  });

  it("§6.2 it does not ask on the opponent's turn", () => {
    const s = scenario({
      active: "p2",
      p1: { backrow: [MASK], library: LIBRARY },
      p2: { library: LIBRARY, field: [MENACE] },
    }).startTurn();

    expect(s.state.pending).toBeNull();
  });

  it("R18 losing 3 health is not damage, so Armor does not reduce it", () => {
    const s = maskScenario(false).startTurn().answer(LOSE_THREE);

    s.expectHealth("p1", 27);
    // The Armor is still there: nothing was spent on a non-damage loss.
    expect(s.state.players.p1.hero.armor).toBe(5);
    s.expectEvents("promptAnswered", "healthLost");
    expect(s.events.map((event) => event.type)).not.toContain("damaged");
  });

  it("exiles the bottom card of your library", () => {
    const s = maskScenario(false).startTurn().answer(EXILE_BOTTOM);

    s.expectInZone(POSTDOC, "exile");
    // The draw took the top card, so the two are never the same card.
    s.expectInZone(MENACE, "hand");
    expect(s.pile("p1", "library").map((card) => card.defId)).not.toContain(POSTDOC);
  });

  it("summons a Spikey Pillow", () => {
    const s = maskScenario(false).startTurn().answer(SUMMON_PILLOW);

    expect(unitAt(s, "p1", 1).defId).toBe(PILLOW);
    s.expectStats(unitAt(s, "p1", 1), { attack: 0, maxHealth: 2 });
  });

  it("§10.6 radiant asks twice, with 'nothing' among the four options", () => {
    const s = maskScenario(true).startTurn();

    expect(optionLabels(s)).toEqual([NOTHING, EXILE_BOTTOM, LOSE_THREE, SUMMON_PILLOW]);

    s.answer(NOTHING);

    // The first step opened the second prompt, so a second pick is pending.
    expect(s.state.pending).not.toBeNull();
    expect(optionLabels(s)).toEqual([NOTHING, EXILE_BOTTOM, LOSE_THREE, SUMMON_PILLOW]);

    s.answer(NOTHING);

    expect(s.state.pending).toBeNull();
    s.expectHealth("p1", 30);
    expect(s.unit("p1", 1)).toBeNull();
    s.expectInZone(POSTDOC, "library");
  });

  it("§10.6 radiant may pick the same option twice: two Spikey Pillows", () => {
    const s = maskScenario(true).startTurn().answer(SUMMON_PILLOW).answer(SUMMON_PILLOW);

    expect(s.state.pending).toBeNull();
    expect(unitAt(s, "p1", 1).defId).toBe(PILLOW);
    expect(unitAt(s, "p1", 2).defId).toBe(PILLOW);
  });

  it("§10.6 radiant may pick the same option twice: 6 health", () => {
    const s = maskScenario(true).startTurn().answer(LOSE_THREE).answer(LOSE_THREE);

    s.expectHealth("p1", 24);
    expect(s.state.players.p1.hero.armor).toBe(5);
  });

  it("§10.6 radiant resumes the chain: the first pick resolves before the second prompt opens", () => {
    const s = maskScenario(true).startTurn().answer(LOSE_THREE);

    // The step applied its own effect and then opened the next prompt, in that order.
    s.expectHealth("p1", 27);
    expect(s.state.pending).not.toBeNull();

    s.answer(SUMMON_PILLOW);

    s.expectHealth("p1", 27);
    expect(unitAt(s, "p1", 1).defId).toBe(PILLOW);
    s.expectEvents("promptOpened", "healthLost", "promptOpened", "summoned");
  });

  it("§10.6 radiant's two picks may differ in the other order too", () => {
    const s = maskScenario(true).startTurn().answer(EXILE_BOTTOM).answer(LOSE_THREE);

    s.expectInZone(POSTDOC, "exile");
    s.expectHealth("p1", 27);
  });
});
