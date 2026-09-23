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
//  - §4.5, R118 (round 4, lens L2): step 4's loop, which lets a trap answer the play, runs no state
//    check before anything has resolved, so a card that arrives at 0 or less health still resolves
//    its Cry and dies in the check after it.
//  - R174 (round 7): the play follows the stay step 4 put the card on — a played unit a step-4 trap
//    killed, or one that died in its own resolution, and that is back through Reborn is a new
//    arrival with no Cry to resolve and not in play at step 7 (R1, R118, R61) — and its declared
//    targets the stays step 1 checked, so a target a step-4 trap destroyed is gone for step 5.

import type { CardDef, CardType, GameEvent, Keyword, PlayerId, Selection } from "@jackioh/shared";
import {
  findInstance,
  newInstance,
  placeOnField,
  registerScripts,
  registeredScripts,
  type CardInstance,
  type GameState,
  type Script,
} from "@jackioh/engine";
import { damage, destroy, destroyAll } from "@jackioh/engine/effects";
import { describe, expect, it } from "vitest";
import { scenario, type Scenario } from "./_harness";

const BIGOT = "core-002";
const RIGHT_HOUSE = "core-003";
const SEVEN_SEVEN = "core-025";
const SUPPRESSIVE_AURA = "core-046";
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

describe("§4.5, R118: a played unit that does not survive its own arrival still resolves its Cry", () => {
  it("R118 Bigot played under Suppressive Aura destroys its target before it dies (§10.5 steps 4-5, §4.5)", () => {
    const g = scenario({
      p1: { hand: [BIGOT, STOCKPILE], backrow: [{ def: SUPPRESSIVE_AURA, lane: 1 }], library: [...LIBRARY] },
      p2: { hand: [STOCKPILE], field: [{ def: SEVEN_SEVEN, lane: 1 }], library: [...LIBRARY] },
    });
    const prey = unitAt(g, "p2", 1);
    const bigot = g.card(BIGOT);

    // Bigot is 6/1 printed, 4/-1 under the aura. No trap answered it and nothing took it off the
    // field at step 4, so step 5 resolves its Cry (R118: the Cry is lost only where a trap has taken
    // the card off the field), and the check after the play collects it (§4.5).
    g.play(BIGOT, { targets: at(prey) });
    g.expectInZone(prey, "graveyard");
    g.expectInZone(bigot, "graveyard");
  });
});

// ---------------------------------------------------------------------------
// Round 7 (lenses L2, "combat windows" and "engine invariants"): the play follows the stay step 4
// put the card on, and its choices the stays step 1 checked them on (R174).
// ---------------------------------------------------------------------------

const POINTMASTER = "core-020";
const COLLATERAL_DAMAGE = "core-034";
const PLASTIC_SURGERY = "core-063";

/** A fixture card: a transient def in the match state and its script in the registry. */
function fixtureCard(
  state: GameState,
  id: string,
  type: CardType,
  script: Script,
  face: { attack?: number; health?: number; keywords?: Keyword[] } = {},
): void {
  const printed =
    type === "Unit"
      ? { attack: face.attack ?? 2, health: face.health ?? 2, keywords: face.keywords ?? [], text: id }
      : { keywords: face.keywords ?? [], text: id };
  const def: CardDef = {
    id,
    index: id,
    name: id,
    set: "Core",
    type,
    tags: [],
    rarity: "Common",
    token: false,
    cost: 0,
    base: { ...printed },
    radiant: { ...printed },
  };
  state.transientDefs[id] = def;
  registerScripts({ ...registeredScripts(), [id]: { base: script, radiant: script } });
}

function inHandOf(state: GameState, defId: string, player: PlayerId): CardInstance {
  const card = newInstance(state, defId, player, { z: "hand", player });
  state.players[player].hand.push(card);
  return card;
}

function faceDownTrap(state: GameState, defId: string, player: PlayerId, lane: number): CardInstance {
  const card = newInstance(state, defId, player, { z: "hand", player });
  if (!placeOnField(state, card, { player, row: "backrow", lane })) throw new Error(`could not place ${defId}`);
  card.faceUp = false;
  return card;
}

/** A trap that destroys the Unit its controller's opponent plays, at §10.5 step 4 as Sheepish answers it. */
const SLAY_ON_PLAY: Script = {
  triggers: [
    {
      id: "edge-r7-slay",
      on: ["cardPlayed"],
      when: (ctx) => ctx.event.type === "cardPlayed" && ctx.event.player !== ctx.controller,
      run: (ctx) =>
        ctx.event.type === "cardPlayed" ? [destroy({ target: { of: "instance", instanceId: ctx.event.instanceId } })] : [],
    },
  ],
};

/** A Field Trap that answers every play of the opponent's by destroying every unit (step 4, R17). */
const WIPE_ON_PLAY: Script = {
  triggers: [
    {
      id: "edge-r7-wipe-on-play",
      on: ["cardPlayed"],
      when: (ctx) => ctx.event.type === "cardPlayed" && ctx.event.player !== ctx.controller,
      run: () => [destroyAll({})],
    },
  ],
};

describe("R174, R118, R61: the play follows the stay step 4 put the card on, not a Reborn body", () => {
  it("R174 a played Reborn unit a step-4 trap kills comes back through Reborn, and neither its Cry nor Unlicensed Experimentation treats the body as the card being played (R118, R61, §4.5 step 4)", () => {
    const g = scenario({
      p1: { hand: [STOCKPILE], mana: 4 },
      p2: { hand: [STOCKPILE], field: [{ def: GARY, lane: 1 }], backrow: [{ def: UNLICENSED, lane: 2 }] },
    });
    // A Unit with Reborn whose Cry deals 3 to the enemy hero, and a trap that destroys a Unit the
    // opponent plays. No Core trap removes a played unit and lets it come back, so both are fixtures.
    fixtureCard(g.state, "edge-r7-reborn-cry", "Unit", { cry: () => [damage({ to: { of: "enemyHero" }, amount: 3 })] }, {
      keywords: [{ kind: "Reborn" }],
    });
    fixtureCard(g.state, "edge-r7-slay", "Trap", SLAY_ON_PLAY);
    faceDownTrap(g.state, "edge-r7-slay", "p2", 1);
    const unit = inHandOf(g.state, "edge-r7-reborn-cry", "p1");

    g.play(unit, { zone: 3 });

    // The trap killed the played unit at step 4 and its Reborn brought it straight back (§4.5 step 4):
    // a reset instance that has entered the field again (R78, R83), whose "Cry does not fire". R118
    // and R17: the trap took the played card off the field, so the Cry is lost. And R61: a Reborn
    // result never sets #85 off, which meets the play as no longer in play (R174), so the body is
    // still the fixture on p1's side rather than fused away onto p2's Gary.
    const body = findInstance(g.state, unit.id);
    const died = g.events.some((event) => event.type === "destroyed" && event.instanceId === unit.id);
    expect({
      died,
      body: body === undefined ? "gone" : `${body.zone.z}:${body.defId}:${body.rebornSpent === true ? "reborn" : "first"}`,
      p2Health: g.state.players.p2.hero.health,
      fused: g.events.some((event) => event.type === "fused"),
    }).toEqual({ died: true, body: "field:edge-r7-reborn-cry:reborn", p2Health: 30, fused: false });
  });

  it("R174 Bear Honeypot's tokens do not attack the Reborn body of a played unit that died in its own resolution (R53, R83, §10.5 step 7)", () => {
    // p1 plays a 0-cost Reborn unit whose Cry kills itself. Step 6's check collects it and Reborn
    // brings a new arrival back at 1 health (§4.5 step 4, R83) before step 7. p2's Bear Honeypot
    // answers the play: "if it was a Unit, they attack it" — but the unit that was played has left
    // the field, so the tokens attack nothing and the Reborn body is left standing.
    const s = scenario({
      seed: "edge-r7-honeypot-martyr",
      p1: { hand: [STOCKPILE], library: [...LIBRARY] },
      p2: { backrow: [{ def: HONEYPOT, faceUp: false }], hand: [STOCKPILE], library: [...LIBRARY] },
    });
    fixtureCard(s.state, "edge-r7-martyr", "Unit", { cry: () => [damage({ to: { of: "self" }, amount: 9 })] }, {
      attack: 3,
      health: 3,
      keywords: [{ kind: "Reborn" }],
    });
    const martyr = inHandOf(s.state, "edge-r7-martyr", "p1");

    s.play(martyr, { zone: 3 });

    // The play died and came back: the Reborn body stands in lane 3.
    expect(s.events.some((event) => event.type === "destroyed" && event.instanceId === martyr.id)).toBe(true);
    expect(s.events.some((event) => event.type === "trapFired" && event.defId === HONEYPOT)).toBe(true);
    const forced = s.events.filter((event) => event.type === "attackDeclared" && event.forced);
    expect(forced).toEqual([]);
    expect(s.unit("p1", 3)?.id).toBe(martyr.id);
    expect(s.card(martyr).rebornSpent).toBe(true);
  });
});

describe("R174: a target a trap answering the play took off the field is gone for the play's step 5", () => {
  it("R174 #63 Plastic Surgery does not buff or grant a keyword to its target in the graveyard after a step-4 trap destroyed it (§8 Conventions, R78)", () => {
    const s = scenario({
      seed: "r7-surgery-on-the-dead",
      p1: { hand: [PLASTIC_SURGERY], mana: 4 },
      p2: { field: [POINTMASTER] },
    });
    fixtureCard(s.state, "edge-r7-wipe", "Field Trap", WIPE_ON_PLAY);
    faceDownTrap(s.state, "edge-r7-wipe", "p2", 5);
    const target = unitAt(s, "p2", 1);

    s.play(PLASTIC_SURGERY, { targets: at(target) });

    // The trap fired at step 4 and its check collected the Pointmaster (§4.5, R17).
    expect(s.lastEvents.some((event) => event.type === "destroyed" && event.instanceId === target.id)).toBe(true);
    expect(s.pile("p2", "graveyard").map((card) => card.id)).toContain(target.id);
    // §8 Conventions: the spell's target is gone, so its text fizzles on it; R78: a card in a
    // graveyard is the printed card, with no buffs and no granted keywords.
    const dead = s.card(target.id);
    expect(dead.buffs).toEqual({ attack: 0, health: 0 });
    expect(dead.grantedKeywords).toEqual([]);
    expect(
      s.lastEvents.filter(
        (event) => (event.type === "buffed" || event.type === "keywordGranted") && event.instanceId === target.id,
      ),
    ).toEqual([]);
  });

  it("R174 #34 Collateral Damage does not exile its target out of the graveyard after a step-4 trap destroyed it (§8 Conventions, R55)", () => {
    const s = scenario({
      seed: "r7-collateral-on-the-dead",
      p1: { hand: [COLLATERAL_DAMAGE], mana: 4 },
      p2: { field: [POINTMASTER], library: [TIMMY, TIMMY] },
    });
    fixtureCard(s.state, "edge-r7-wipe", "Field Trap", WIPE_ON_PLAY);
    faceDownTrap(s.state, "edge-r7-wipe", "p2", 5);
    const target = unitAt(s, "p2", 1);

    s.play(COLLATERAL_DAMAGE, { targets: at(target) });

    // The trap's wipe put the Pointmaster in its owner's graveyard (§4.5, R17), and there it stays:
    // the permanent the spell named is gone, so only the library half of its text resolves.
    expect(s.lastEvents.some((event) => event.type === "destroyed" && event.instanceId === target.id)).toBe(true);
    expect(s.pile("p2", "exile").map((card) => card.id)).not.toContain(target.id);
    expect(s.pile("p2", "graveyard").map((card) => card.id)).toContain(target.id);
  });
});
