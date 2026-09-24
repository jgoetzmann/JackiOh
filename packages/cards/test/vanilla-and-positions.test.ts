// A Vanilla copy has no text at all, and R46's knock-down reports only a real switch (SPEC §6.3
// Vanilla, §6.2, R46, R49, R91, R115). Found by the polish-4 edge-case hunt
// (docs/polish/4-edge-cases.md, lens L3); every case here failed before its fix.
//
// #61 Prejudiced Postdoc summons a Vanilla copy (R57, R23). §6.3's Vanilla "clears printed keywords
// and scripts", and R115 says so of every hook, so the copy keeps none of the card's text: not Deft
// Duelist's second exertion, not Spikey Pillow's "cannot be in Defense Position", not Fed Fauci's
// on-damage trigger and not radiant Right-house defender's Death.
//
// Round 9, lens "keywords and layers": §6.1's keywords are a set, so a keyword two sources give — a
// printed one an aura grants again, a Taunt unit's own Taunt in Defense Position — is listed once in
// the view (§10.4, §10.8), Armor apart, which sums across its sources.

import type { Selection } from "@jackioh/shared";
import { legalActions, type CardInstance } from "@jackioh/engine";
import { describe, expect, it } from "vitest";
import { scenario, type Scenario } from "./_harness";

const RIGHT_HOUSE = "core-003";
const VANILLA = "core-008";
const HIT_JOB = "core-016";
const POINTMASTER = "core-020";
const HINDER = "core-021";
const TRUE_STRIKE = "core-044";
const DUELIST = "core-045";
const POSTDOC = "core-061";
const PILLOW = "core-065-1";
const ROCK = "core-066";
const FAUCI = "core-091";
const LIBRARY = [VANILLA, VANILLA, VANILLA, VANILLA];

const at = (card: CardInstance): Selection[] => [{ pick: "instance", instanceId: card.id }];

function unitAt(g: Scenario, player: "p1" | "p2", lane: number): CardInstance {
  const card = g.unit(player, lane);
  if (card === null) throw new Error(`setup: ${player} should hold a unit in lane ${lane}`);
  return card;
}

function offersSwitch(g: Scenario, card: CardInstance): boolean {
  const live = g.card(card);
  return legalActions(g.state, live.controller).some(
    (action) => action.type === "switchPosition" && action.instanceId === live.id,
  );
}

describe("R115: a Vanilla copy keeps none of the card's text", () => {
  it("R115 a Vanilla copy of Deft Duelist has one exertion, not two (§6.3 Vanilla, R49)", () => {
    const g = scenario({
      p1: { hand: [POSTDOC, HINDER], field: [{ def: DUELIST, lane: 1 }], library: LIBRARY },
      p2: { hand: [HINDER], field: [{ def: POINTMASTER, lane: 5 }], library: LIBRARY },
    });
    const duelist = g.card(DUELIST);
    g.play(POSTDOC, { zone: 2, targets: at(duelist) });
    const copy = unitAt(g, "p1", 3);
    expect(copy.defId).toBe(DUELIST);
    expect(copy.vanilla).toBe(true);

    g.endTurn().endTurn(); // p2's turn, then back to p1: the copy is no longer sick.
    expect(g.state.active).toBe("p1");

    g.attack(copy, "hero");
    // One exertion: having attacked, the plain copy cannot also switch (§4.1, R6).
    expect(offersSwitch(g, copy)).toBe(false);
    expect(() => g.switchPosition(copy)).toThrow(/already acted/);
    // The original keeps its text, so it still has both.
    g.attack(duelist, "hero");
    expect(offersSwitch(g, duelist)).toBe(true);
  });

  it("R115 a Vanilla copy of Spikey Pillow may enter Defense Position (§6.3 Vanilla, §7, §4.1)", () => {
    const g = scenario({
      p1: { hand: [{ def: POSTDOC, radiant: true }, HINDER], field: [{ def: PILLOW, lane: 1 }], library: LIBRARY },
      p2: { hand: [HINDER], library: LIBRARY },
    });
    const pillow = g.card(PILLOW);
    g.play(POSTDOC, { zone: 2, targets: at(pillow) });
    const copy = unitAt(g, "p1", 3);
    expect(copy.defId).toBe(PILLOW);
    expect(copy.vanilla).toBe(true);

    expect(offersSwitch(g, copy)).toBe(true);
    g.switchPosition(copy);
    expect(g.card(copy).position).toBe("DEF");
    // The Pillow itself still cannot.
    expect(offersSwitch(g, pillow)).toBe(false);
  });

  it("R115 a Vanilla copy of Fed Fauci gains no Plague Token when damaged (§6.3 Vanilla, §8 #91)", () => {
    const g = scenario({
      p1: { hand: [POSTDOC, TRUE_STRIKE, HINDER], field: [{ def: FAUCI, lane: 1 }], mana: 10, library: LIBRARY },
      p2: { library: LIBRARY },
    });
    g.play(POSTDOC, { zone: 2, targets: at(g.card(FAUCI)) });
    const copy = unitAt(g, "p1", 3);
    expect(copy.defId).toBe(FAUCI);
    expect(copy.vanilla).toBe(true);

    g.play(TRUE_STRIKE, { targets: at(copy) });
    expect(g.card(copy).damage).toBe(4);
    expect(g.card(copy).counters.plague ?? 0).toBe(0);
  });

  it("R115 a Vanilla copy of radiant Right-house defender fires no Death (§6.3 Vanilla, §6.2, R57)", () => {
    const g = scenario({
      p1: {
        hand: [POSTDOC, TRUE_STRIKE, HINDER],
        field: [{ def: RIGHT_HOUSE, radiant: true, lane: 1 }],
        mana: 10,
        library: LIBRARY,
      },
      p2: { library: LIBRARY },
    });
    g.play(POSTDOC, { zone: 2, targets: at(g.card(RIGHT_HOUSE)) });
    const copy = unitAt(g, "p1", 3);
    expect(copy.defId).toBe(RIGHT_HOUSE);
    expect(copy.vanilla).toBe(true);
    expect(copy.radiant).toBe(true);

    g.play(TRUE_STRIKE, { targets: at(copy) });
    g.expectInZone(copy, "graveyard");
    // Nothing came back into the copy's lane or anywhere else: only the original stands.
    const rightHouses = g.state.players.p1.units.flatMap((pile) => pile ?? []).filter((c) => c.defId === RIGHT_HOUSE);
    expect(rightHouses.map((c) => c.id)).toEqual([g.card(RIGHT_HOUSE).id]);
  });
});

describe("R46 and R91: the knock-down reports a switch only when there is one", () => {
  it("R91 R46 on an Indestructible unit already in Attack Position emits no positionSwitched", () => {
    const g = scenario({
      p1: { hand: [HIT_JOB, HINDER], library: LIBRARY },
      p2: { field: [{ def: ROCK, lane: 1, position: "ATK" }], library: LIBRARY },
    });
    const rock = g.card(ROCK);
    g.play(HIT_JOB, { targets: at(rock) });

    // R46 still happened: on the field, in Attack Position, its Taunt suppressed for the turn.
    g.expectInZone(rock, "field");
    expect(g.card(rock).position).toBe("ATK");
    expect(g.card(rock).tauntSuppressedTurn).toBe(g.state.turn);
    const switched = g.lastEvents.filter((event) => event.type === "positionSwitched" && event.instanceId === rock.id);
    expect(switched).toEqual([]);
  });

  it("R46 on an Indestructible unit in Defense Position still switches it, and says so", () => {
    const g = scenario({
      p1: { hand: [HIT_JOB, HINDER], library: LIBRARY },
      p2: { field: [{ def: ROCK, lane: 1, position: "DEF" }], library: LIBRARY },
    });
    const rock = g.card(ROCK);
    g.play(HIT_JOB, { targets: at(rock) });

    expect(g.card(rock).position).toBe("ATK");
    expect(g.lastEvents).toContainEqual({ type: "positionSwitched", instanceId: rock.id, position: "ATK" });
  });
});

// ---------------------------------------------------------------------------
// Round 9: a unit's keywords are a set (§6.1, §10.4, §10.8)
// ---------------------------------------------------------------------------

const TIMMY = "core-011"; // Unit, 1: Rush, First Strike
const WEAPONS = "core-014"; // Field Spell: your units have +4 attack, Rush, First Strike


describe("A unit's keywords are a set (§6.1, §10.4, §10.8)", () => {
  it("§6.1 the view lists each keyword a unit has once, however many sources give it: Tempo Timmy under Jlockeed's Weapons, a Taunt unit in Defense Position (§10.4, §10.8)", () => {
    const g = scenario({
      p1: {
        hand: [HINDER],
        field: [
          { def: TIMMY, lane: 1 },
          { def: RIGHT_HOUSE, lane: 2, position: "DEF" },
        ],
        backrow: [WEAPONS],
        library: LIBRARY,
      },
      p2: { hand: [HINDER], library: LIBRARY },
    });

    const units = g.view("p1").you.units;
    const kindsIn = (lane: number): string[] => {
      const unit = units[lane - 1];
      if (unit === null || unit === undefined) throw new Error(`no unit in lane ${lane}`);
      return unit.keywords.map((keyword) => keyword.kind).filter((kind) => kind !== "Armor");
    };

    // Timmy prints Rush and First Strike, and the Weapons aura grants both again: two keywords, not four.
    expect(kindsIn(1).sort()).toEqual(["First Strike", "Rush"]);
    // Right-house defender prints Taunt and Defense Position grants it: one Taunt among its keywords.
    expect(kindsIn(2).sort()).toEqual(["Divine Shield", "First Strike", "Reborn", "Rush", "Taunt"]);
  });
});
