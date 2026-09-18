// #91 Fed Fauci (SPEC §8.4, BUILD M4-T4 row 91: "One Plague Token per damage instance; +1 mana per
// token at start of turn (radiant +2); counters reset on leaving").
//
// Fixtures. Fauci is 1/6 → 2/12, so a 2-attack unit can hit it twice without killing it:
// #61 Prejudiced Postdoc is a 2/4 with no keywords, and its Cry never fires because the harness
// places it rather than playing it (R1). #68 Twisted Sourcerer (5/5) is the finisher for the R78
// test and #4 Gary the Gambler (1/1) the 1-attack striker for R63's zero rule.
//
// Every test that crosses a turn boundary gives BOTH sides a card in hand: the engine auto-ends a
// turn with nothing meaningful left on it (R82), which would otherwise cascade several turns
// forward and fire the start-of-turn hook more than once.

import { describe, expect, it } from "vitest";
import type { CardInstance } from "@jackioh/engine";
import type { GameEvent, Keyword, PlayerId } from "@jackioh/shared";
import { scenario, type Scenario } from "./_harness";

const FAUCI = "core-091";
const POSTDOC = "core-061"; // 2/4
const SOURCERER = "core-068"; // 5/5
const GARY = "core-004"; // 1/1

/** The token count the `plague` effect keeps on the instance (§10.1). */
function plagueOn(s: Scenario, card: CardInstance): number {
  return s.card(card).counters.plague ?? 0;
}

function damageEventsOn(events: readonly GameEvent[], id: string): GameEvent[] {
  return events.filter((event) => event.type === "damage" && event.targetId === id);
}

/** The keywords §10.4 computes for a lane, as the client sees them (§10.8). */
function keywordsInLane(s: Scenario, player: PlayerId, lane: number): Keyword[] {
  const view = player === "p1" ? s.view("p1").you : s.view("p1").opponent;
  return view.units[lane - 1]?.keywords ?? [];
}

function mustUnit(s: Scenario, player: PlayerId, lane: number): CardInstance {
  const card = s.unit(player, lane);
  if (card === null) throw new Error(`no unit in ${player} lane ${lane}`);
  return card;
}

/** A board where p2 can attack p1's Fauci, with nothing that could auto-end either turn (R82). */
function board(opts: { radiant?: boolean; enemies: string[] }): Scenario {
  return scenario({
    active: "p2",
    p1: {
      field: [{ def: FAUCI, ...(opts.radiant === true ? { radiant: true } : {}) }],
      hand: [GARY],
      library: [GARY, GARY],
    },
    p2: { field: opts.enemies, hand: [GARY], library: [GARY] },
  });
}

describe("#91 Fed Fauci — base", () => {
  it("§8 prints Rush and 1/6, and the script grants nothing", () => {
    const s = scenario({ p1: { field: [FAUCI] } });
    s.expectStats(FAUCI, { attack: 1, health: 6, maxHealth: 6 });
    expect(keywordsInLane(s, "p1", 1).map((k) => k.kind)).toEqual(["Rush"]);
  });

  it("makes one Plague Token per damage instance", () => {
    const s = board({ enemies: [POSTDOC] });
    const fauci = s.card(FAUCI);

    s.attack(mustUnit(s, "p2", 1), fauci);

    expect(plagueOn(s, fauci)).toBe(1);
    s.expectStats(fauci, { attack: 1, health: 4, maxHealth: 6 }).expectEvents(
      "damage",
      "counterChanged",
    );
  });

  it("counts instances, not attackers: two separate hits are two tokens", () => {
    const s = board({ enemies: [POSTDOC, POSTDOC] });
    const fauci = s.card(FAUCI);

    s.attack(mustUnit(s, "p2", 1), fauci);
    expect(plagueOn(s, fauci)).toBe(1);

    s.attack(mustUnit(s, "p2", 2), fauci);
    expect(plagueOn(s, fauci)).toBe(2);
    // 2 + 2 damage on a 6-health body: still alive, so the second hit really was its own instance.
    s.expectStats(fauci, { attack: 1, health: 2, maxHealth: 6 });
  });

  it("R63 a hit reduced to 0 emits no damage event, so it makes no token", () => {
    // Defense Position grants Armor +1 (§4.1), so a 1-attack striker is reduced to 0 at §4.4 step 2.
    const s = scenario({
      active: "p2",
      p1: { field: [{ def: FAUCI, position: "DEF" }], hand: [GARY] },
      p2: { field: [GARY], hand: [GARY] },
    });
    const fauci = s.card(FAUCI);

    s.attack(mustUnit(s, "p2", 1), fauci);

    expect(damageEventsOn(s.events, fauci.id)).toHaveLength(0);
    expect(plagueOn(s, fauci)).toBe(0);
    s.expectStats(fauci, { attack: 1, health: 6, maxHealth: 6 });
  });

  it('"whenever THIS takes damage": a hit it dealt is not a hit it took', () => {
    const s = board({ enemies: [POSTDOC] });
    const fauci = s.card(FAUCI);
    const postdoc = mustUnit(s, "p2", 1);

    s.attack(postdoc, fauci);

    // Fauci struck back for 1, which is a damage event on the Postdoc, and gave no second token.
    expect(damageEventsOn(s.events, postdoc.id)).toHaveLength(1);
    expect(plagueOn(s, fauci)).toBe(1);
  });

  it("start of turn: +1 mana per Plague Token", () => {
    const s = board({ enemies: [POSTDOC, POSTDOC] });
    const fauci = s.card(FAUCI);

    s.attack(mustUnit(s, "p2", 1), fauci).attack(mustUnit(s, "p2", 2), fauci);
    expect(plagueOn(s, fauci)).toBe(2);

    // p2 ends; p1's turn starts, so §2.3's refresh runs and then the hook adds 1 per token (R62).
    s.endTurn();

    // turn 9 with p2 active gives p1 four started turns; this start is its fifth, so MAX_MANA 4.
    s.expectMana("p1", 4 + 2);
  });

  it("no tokens is no mana and no change at all", () => {
    const s = board({ enemies: [POSTDOC] });
    s.endTurn();
    s.expectMana("p1", 4);
  });

  it("R78 counters reset when it leaves the field", () => {
    const s = board({ enemies: [POSTDOC, SOURCERER] });
    const fauci = s.card(FAUCI);

    s.attack(mustUnit(s, "p2", 1), fauci);
    expect(plagueOn(s, fauci)).toBe(1);

    // 2 + 5 on a 6-health body kills it; R78 resets counters on the way to the graveyard.
    s.attack(mustUnit(s, "p2", 2), fauci);

    s.expectInZone(fauci, "graveyard");
    expect(plagueOn(s, fauci)).toBe(0);
  });
});

describe("#91 Fed Fauci — radiant", () => {
  it("§8 prints Rush and 2/12 on the radiant face", () => {
    const s = scenario({ p1: { field: [{ def: FAUCI, radiant: true }] } });
    s.expectStats(FAUCI, { attack: 2, health: 12, maxHealth: 12 });
    // §8 Conventions: the cell lists "Rush" without "Plus", so that is the complete list.
    expect(keywordsInLane(s, "p1", 1).map((k) => k.kind)).toEqual(["Rush"]);
  });

  it("§8 Conventions: the damage→token clause the radiant cell does not restate is kept", () => {
    const s = board({ radiant: true, enemies: [POSTDOC] });
    const fauci = s.card(FAUCI);

    s.attack(mustUnit(s, "p2", 1), fauci);

    expect(plagueOn(s, fauci)).toBe(1);
  });

  it("start of turn: +2 mana per Plague Token", () => {
    const s = board({ radiant: true, enemies: [POSTDOC, POSTDOC] });
    const fauci = s.card(FAUCI);

    s.attack(mustUnit(s, "p2", 1), fauci).attack(mustUnit(s, "p2", 2), fauci);
    expect(plagueOn(s, fauci)).toBe(2);

    s.endTurn();

    s.expectMana("p1", 4 + 2 * 2);
  });

  it("R63 still holds on the radiant face: a 0 hit makes no token", () => {
    const s = scenario({
      active: "p2",
      p1: { field: [{ def: FAUCI, radiant: true, position: "DEF" }], hand: [GARY] },
      p2: { field: [GARY], hand: [GARY] },
    });
    const fauci = s.card(FAUCI);

    s.attack(mustUnit(s, "p2", 1), fauci);

    expect(damageEventsOn(s.events, fauci.id)).toHaveLength(0);
    expect(plagueOn(s, fauci)).toBe(0);
  });
});
