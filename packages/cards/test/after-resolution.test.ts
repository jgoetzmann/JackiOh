// §10.5 steps 6 and 7: an Echo repeat, the state check after a card's last resolution, and the traps
// that answer it (SPEC §4.5, §10.5, R17, R59, R61, R174). Found by the polish-4 edge-case hunt, round
// 3 (docs/polish/4-edge-cases.md, lenses L7 and the combat windows); every case here failed before
// its fix.
//
//  - §10.5 step 6 is "repeat step 5", and step 5 is the granted Combo parts (#38, #78) and then the
//    card's own script, so a repeat runs all three.
//  - §4.5, R59: the check runs after a card's whole Cry or spell, which is before step 7's
//    `cardResolved`, so #60 and #85 meet the board the card left.
//  - R174, R61: the traps answering one play fire one after another, and once an earlier one has
//    taken the played card off the field, the next one meets a play that is no longer in play.

import type { GameEvent, Selection } from "@jackioh/shared";
import type { CardInstance } from "@jackioh/engine";
import { describe, expect, it } from "vitest";
import { scenario, type Scenario } from "./_harness";

const RIGHT_HOUSE = "core-003";
const GARY = "core-004";
const STOCKPILE = "core-005";
const VANILLA = "core-008";
const TIMMY = "core-011";
const MR_TOKEN = "core-015";
const LUNAR_ECLIPSE = "core-035";
const QUICKSTRIKER = "core-038";
const BIG_FELINOR = "core-043";
const RENO = "core-053";
const HONEYPOT = "core-060";
const FULLSEND = "core-078";
const TWINSPELL = "core-079";
const UNLICENSED = "core-085";
const RUSH_TOKEN = "core-t-rush";
const LIBRARY = [VANILLA, VANILLA, VANILLA, VANILLA, VANILLA, VANILLA, VANILLA, VANILLA];

const at = (card: CardInstance): Selection[] => [{ pick: "instance", instanceId: card.id }];

function unitAt(g: Scenario, player: "p1" | "p2", lane: number): CardInstance {
  const card = g.unit(player, lane);
  if (card === null) throw new Error(`setup: ${player} should hold a unit in lane ${lane}`);
  return card;
}

function count(events: readonly GameEvent[], type: GameEvent["type"]): number {
  return events.filter((event) => event.type === type).length;
}

describe("§10.5 step 6: an Echo repeat is step 5 again, granted Combo parts included", () => {
  it("§10.5 Quickstriker's granted Combo hits once per resolution of an echoed Spell (§8 #38, R30)", () => {
    // Twinspell is the one card played earlier, so X = 1 on each of Stockpile's two resolutions.
    const g = scenario({
      p1: { hand: [TWINSPELL, STOCKPILE, RENO], backrow: [{ def: QUICKSTRIKER, lane: 2 }], mana: 8, library: [...LIBRARY] },
      p2: { hand: [RENO], library: [...LIBRARY] },
    });
    g.play(TWINSPELL, { zone: 1 });
    const before = g.hand("p1").length;

    g.play(STOCKPILE);

    // Stockpile's own text ran twice (draw 2, twice), and Quickstriker's Combo with it.
    expect(g.hand("p1")).toHaveLength(before - 1 + 4);
    const hits = g.lastEvents.filter((event) => event.type === "damage" && event.targetId === "hero-p2");
    expect(hits).toHaveLength(2);
    g.expectHealth("p2", 28);
  });

  it("§10.5 /fullsend's granted \"Combo: draw 1\" draws once per resolution of an echoed Spell (§8 #78, R30)", () => {
    // /fullsend and Twinspell were played earlier: each of Stockpile's two resolutions draws 1 for
    // the granted Combo and then 2 for Stockpile — 6 cards in all.
    const g = scenario({
      p1: { hand: [FULLSEND, TWINSPELL, STOCKPILE, RENO], mana: 8, library: [...LIBRARY] },
      p2: { hand: [RENO], library: [...LIBRARY] },
    });
    g.play(FULLSEND);
    g.play(TWINSPELL, { zone: 1 });
    const before = g.hand("p1").length;

    g.play(STOCKPILE);

    const drawn = g.lastEvents.filter((event) => event.type === "drawn" && event.player === "p1");
    expect(drawn).toHaveLength(6);
    expect(g.hand("p1")).toHaveLength(before - 1 + 6);
  });
});

describe("§4.5: the check after a card's whole Cry or spell, before step 7's traps", () => {
  it("§4.5 radiant Bear Honeypot fills the zones Big Felinor's Cry has just emptied (R59, §10.5 step 7)", () => {
    const g = scenario({
      p1: { hand: [BIG_FELINOR, STOCKPILE], library: [...LIBRARY] },
      p2: {
        hand: [STOCKPILE],
        field: [{ def: VANILLA, lane: 1 }, { def: VANILLA, lane: 2 }],
        backrow: [{ def: HONEYPOT, radiant: true, faceUp: false }],
        library: [...LIBRARY],
      },
    });

    // Big Felinor's Cry destroys every non-Felinor unit, and the check after the whole Cry collects
    // both Mr. Vanillas; only then does `cardResolved` reach the trap, whose "fill your board" finds
    // all five of p2's unit zones empty.
    g.play(BIG_FELINOR, { zone: 1 });

    const tokens = g.events.filter((e) => e.type === "summoned" && e.defId === RUSH_TOKEN && e.player === "p2");
    expect(tokens).toHaveLength(5);
  });

  it("§4.5 Unlicensed Experimentation does not fuse Big Felinor onto a unit its Cry has already destroyed (R61, R99)", () => {
    const g = scenario({
      p1: { hand: [BIG_FELINOR, STOCKPILE], library: [...LIBRARY] },
      p2: {
        hand: [STOCKPILE],
        field: [{ def: TIMMY, lane: 1 }],
        backrow: [{ def: UNLICENSED, faceUp: false }],
        library: [...LIBRARY],
      },
    });
    const timmy = unitAt(g, "p2", 1);

    g.play(BIG_FELINOR, { zone: 1 });

    // Timmy died with the Cry, so p2 controls no Unit when the trap is asked, and it stays armed.
    g.expectInZone(timmy, "graveyard");
    expect(count(g.events, "trapFired")).toBe(0);
    expect(g.unit("p1", 1)?.defId).toBe(BIG_FELINOR);
  });

  it("§4.5 base Bear Honeypot summons into the zone Lunar Eclipse's spell has just emptied (R59, R64)", () => {
    const g = scenario({
      p1: { hand: [LUNAR_ECLIPSE, STOCKPILE], library: [...LIBRARY] },
      p2: {
        hand: [STOCKPILE],
        field: [VANILLA, VANILLA, VANILLA, VANILLA, VANILLA],
        backrow: [{ def: HONEYPOT, faceUp: false }],
        library: [...LIBRARY],
      },
    });
    const victim = unitAt(g, "p2", 3);

    // 3 damage kills the lane-3 Mr. Vanilla as the spell ends, so its zone is empty by step 7:
    // "summon 2 Rush Tokens" takes that one zone and the second summon fails in silence (§3.2).
    g.play(LUNAR_ECLIPSE, { targets: at(victim) });

    g.expectInZone(victim, "graveyard");
    expect(count(g.events, "trapFired")).toBe(1);
    expect(g.unit("p2", 3)?.defId).toBe(RUSH_TOKEN);
  });
});

describe("R174: a trap after Bear Honeypot's run meets the played unit the run killed as gone", () => {
  it("R174 Unlicensed Experimentation does not fuse a played unit Bear Honeypot's tokens already killed out of the graveyard (R61)", () => {
    const g = scenario({
      active: "p1",
      p1: { hand: [MR_TOKEN, STOCKPILE], library: [...LIBRARY] },
      p2: {
        hand: [STOCKPILE],
        field: [{ def: GARY, lane: 5 }],
        backrow: [
          { def: HONEYPOT, faceUp: false, lane: 1 },
          { def: UNLICENSED, faceUp: false, lane: 2 },
        ],
        library: [...LIBRARY],
      },
    });

    // Me and Mr Token (1/1, cost 1) resolves; step 7's `cardResolved` reaches p2's traps in lane
    // order (R68). Bear Honeypot's first Rush Token kills it, so when Unlicensed Experimentation is
    // asked, the play it would fuse onto p2's side is in p1's graveyard.
    g.play(MR_TOKEN, { zone: 1 });

    expect(g.pile("p1", "graveyard").some((card) => card.defId === MR_TOKEN)).toBe(true);
    expect(count(g.events, "fused")).toBe(0);
  });

  it("R174 a second Bear Honeypot's tokens do not attack the Reborn body of the unit the first one's run killed (R83)", () => {
    const g = scenario({
      active: "p1",
      p1: { hand: [RIGHT_HOUSE, STOCKPILE], library: [...LIBRARY] },
      p2: {
        hand: [STOCKPILE],
        backrow: [
          { def: HONEYPOT, faceUp: false, lane: 1 },
          { def: HONEYPOT, faceUp: false, lane: 2 },
        ],
        library: [...LIBRARY],
      },
    });

    // Right-house defender (1/1, Taunt, Divine Shield, Reborn): the first trap's first token takes
    // its shield and the second kills it, and Reborn brings it straight back. The second trap still
    // fires — the play cost 1 — but "they attack it" named that play's stay, which has ended.
    g.play(RIGHT_HOUSE, { zone: 1 });

    expect(count(g.events, "trapFired")).toBe(2);
    expect(count(g.events, "attackDeclared")).toBe(2);
    g.expectInZone(g.card(RIGHT_HOUSE), "field");
  });
});
