// Deaths, their killers and Reborn bodies (SPEC §4.5, §6.1, §6.3 Sacrifice, R42, R78, R83, R89,
// R174). Found by the polish-4 edge-case hunt, round 2 (docs/polish/4-edge-cases.md, lenses L2, L3
// and L8); every case here failed before its fix.
//
//  - §4.5 step 1, R89: the units one check collects are read before any of them moves, so each dies
//    with the aura and the layer-2 stats it had — not with lane order deciding which it lost.
//  - R42, R89: the killer is the hit that took the unit to 0, credited as it lands, so a unit an
//    aura later starves has no killer.
//  - R174: what a card queued while it stood on the field, and a delayed effect aimed at it, end
//    with that stay, so a Reborn body is not acted on by either.
//  - Round 6, lens L2. §4.5 step 4, §10.1: Reborn returns a collected unit from the graveyard step 1
//    moved it to, and from nowhere else, so a Death hook of the same pass that moved it on (a later
//    set's "exile your graveyard", built here as a fixture) does not leave it in two zones.
//  - Round 9, lens "combat windows". R42, R89: a unit is killed once, by the first thing that dooms
//    it before the check collects it, and what lands on it afterwards changes nothing: a destroy after
//    the lethal hit, a Poisonous hit on a unit already at 0, a hit on a unit a Poisonous hit already
//    marked. The cards are fixtures (no Core Death deals damage, and no Core Cry both damages and
//    destroys; #99 crafting #68 with #2 is the Core shape of the first).

import type {
  CardDef,
  CardType,
  GameEvent,
  PlayerId,
  Row,
  Selection,
  Keyword,
  TargetDecl,
} from "@jackioh/shared";
import { PLAYER_IDS } from "@jackioh/shared";
import {
  newInstance,
  placeOnField,
  registerScripts,
  registeredScripts,
  type CardInstance,
  type GameState,
  type Script,
} from "@jackioh/engine";
import { exileMatching, damage, destroy } from "@jackioh/engine/effects";
import { describe, expect, it } from "vitest";
import { scenario, type Scenario } from "./_harness";

const BIG_D = "core-001";
const STOCKPILE = "core-005";
const VANILLA = "core-008";
const MOTHS = "core-009";
const TIMMY = "core-011";
const HIT_JOB = "core-016";
const HINDER = "core-021";
const PANTHER = "core-032";
const GRAVEDIGGER = "core-037";
const BIG_FELINOR = "core-043";
const TRUE_STRIKE = "core-044";
const SUPPRESSIVE = "core-046";
const KPOP = "core-050";
const SURGERY = "core-063";
const PILLOW = "core-065-1";
const CORPSE_EATER = "core-089";
const FAUCI = "core-091";
const FIENDER = "core-092";
const LIBRARY = [VANILLA, VANILLA, VANILLA, VANILLA, VANILLA, VANILLA, VANILLA, VANILLA, VANILLA, VANILLA];

/**
 * On this seed #63 Plastic Surgery's first random keyword is Reborn for a unit that already has
 * Rush (Fed Fauci) or has no keyword at all (Gravedigger): the pool order and the first rng draw are
 * the same in each scenario below (re-entry.test.ts uses it the same way).
 */
const REBORN_SEED = "re-entry-reborn-token-4";

const at = (card: CardInstance): Selection[] => [{ pick: "instance", instanceId: card.id }];

function unitAt(g: Scenario, player: "p1" | "p2", lane: number): CardInstance {
  const card = g.unit(player, lane);
  if (card === null) throw new Error(`setup: ${player} should hold a unit in lane ${lane}`);
  return card;
}

function keywordsOf(g: Scenario, card: CardInstance): string[] {
  return g.stats(card).keywords.map((k) => k.kind);
}

function destroyedOf(g: Scenario, card: CardInstance): Extract<GameEvent, { type: "destroyed" }> {
  const event = g.events.find(
    (e): e is Extract<GameEvent, { type: "destroyed" }> => e.type === "destroyed" && e.instanceId === card.id,
  );
  if (event === undefined) throw new Error(`no destroyed event for ${card.id}`);
  return event;
}

describe("R89: §4.5 step 1 collects at once, so every unit dies as it stood", () => {
  it("R89 a unit that dies beside the Spikey Pillow draining it dies with the Pillow's −2 attack (R38)", () => {
    const g = scenario({
      p1: { hand: [{ def: HIT_JOB, radiant: true }, CORPSE_EATER, HINDER], library: LIBRARY },
      p2: { hand: [HINDER], field: [{ def: PILLOW, lane: 1 }, { def: VANILLA, lane: 2 }], library: LIBRARY },
    });
    const vanilla = unitAt(g, "p2", 2);
    expect(vanilla.defId).toBe(VANILLA);
    // Before: the Pillow's aura drains p2's Mr. Vanilla to 1 attack (§10.4 layer 5).
    expect(g.stats(vanilla).attack).toBe(1);
    expect(g.stats(vanilla).maxHealth).toBe(3);

    // Radiant Hit Job on the Vanilla also destroys the Pillow beside it: both are collected in one
    // pass and moved "all … at once" (§4.5 step 1).
    g.play(HIT_JOB, { targets: at(vanilla) });
    g.expectInZone(vanilla, "graveyard");

    // R89: the event carries what the unit was as it died — with the Pillow still beside it.
    const died = destroyedOf(g, vanilla);
    expect(died.attack).toBe(1);
    expect(died.maxHealth).toBe(3);
    // R38: Corpse Eater gains the dying unit's current attack and max health (the Pillow is a
    // token and never feeds it, R11).
    expect(g.card(CORPSE_EATER).buffs).toEqual({ attack: 1, health: 3 });
  });

  it("R89 Felinor Fiender dying with a Felinor beside it dies with that Felinor's stats in its own (§10.4 layer 2, R38)", () => {
    const g = scenario({
      p1: { hand: [{ def: HIT_JOB, radiant: true }, CORPSE_EATER, HINDER], library: LIBRARY },
      p2: { hand: [HINDER], field: [{ def: BIG_FELINOR, lane: 1 }, { def: FIENDER, lane: 2 }], library: LIBRARY },
    });
    const fiender = unitAt(g, "p2", 2);
    expect(fiender.defId).toBe(FIENDER);
    // 5/7 printed, plus Big Felinor's 3/10.
    expect(g.stats(fiender).attack).toBe(8);
    expect(g.stats(fiender).maxHealth).toBe(17);

    g.play(HIT_JOB, { targets: at(fiender) });
    g.expectInZone(fiender, "graveyard");
    g.expectInZone(g.card(BIG_FELINOR), "graveyard");

    const died = destroyedOf(g, fiender);
    expect(died.attack).toBe(8);
    expect(died.maxHealth).toBe(17);
    // Big Felinor's 3/10 plus the Fiender's 8/17.
    expect(g.card(CORPSE_EATER).buffs).toEqual({ attack: 11, health: 27 });
  });
});

describe("R42: the killer is the hit that took the unit to 0", () => {
  it("R42 a unit Prem Panther hit earlier that an aura later kills was not destroyed by the Panther (R89)", () => {
    // 5 damage on a 0/8 Big D-fender leaves it at 3. Radiant Suppressive Aura paid 2 then gives
    // enemy units -4/-4: max health 4 under 5 damage, so it dies — to the aura, which is no damage
    // instance, not to a hit that left it standing.
    const s = scenario({
      seed: "hunt-cw2-panther-aura",
      p1: { field: [PANTHER], hand: [{ def: SUPPRESSIVE, radiant: true }, STOCKPILE], library: [TIMMY, TIMMY, TIMMY] },
      p2: { field: [BIG_D], hand: [STOCKPILE] },
    });
    const dfender = s.card(BIG_D);

    s.attack(PANTHER, dfender);
    s.expectStats(dfender, { health: 3 });
    const handBefore = s.hand("p1").length;

    s.play(SUPPRESSIVE, { embiggen: false });

    s.expectInZone(dfender, "graveyard");
    const destroyed = s.lastEvents.find((event) => event.type === "destroyed" && event.instanceId === dfender.id);
    expect(destroyed).toMatchObject({ killerId: null });
    // §8 #32: "whenever this destroys a unit, draw 2" — it did not, so nothing was drawn.
    expect(s.hand("p1")).toHaveLength(handBefore - 1);
  });
});

describe("R174: what was queued for a card's old stay does not act on its Reborn body", () => {
  it("R174 Fed Fauci's Plague Token for the hit that killed it does not land on its Reborn body (R78)", () => {
    const g = scenario({
      seed: REBORN_SEED,
      p1: {
        hand: [SURGERY, TRUE_STRIKE, VANILLA],
        field: [{ def: FAUCI, lane: 1, damage: 5 }],
        library: [...LIBRARY],
      },
      p2: { hand: [VANILLA], library: [...LIBRARY] },
    });
    const fauci = g.card(FAUCI);
    g.play(SURGERY, { targets: at(fauci) });
    expect(keywordsOf(g, fauci)).toContain("Reborn");

    // A 4/9 with 5 damage: True Strike's 4 is lethal, and Reborn brings the same instance back.
    g.play(TRUE_STRIKE, { targets: at(fauci) });
    expect(g.events.some((e) => e.type === "destroyed" && e.instanceId === fauci.id)).toBe(true);
    g.expectInZone(fauci, "field");
    expect(g.card(fauci).rebornSpent).toBe(true);
    // R78: counters reset as it left, and the body that came back has taken no damage.
    expect(g.card(fauci).counters.plague ?? 0).toBe(0);
  });

  it("R174 a Gravedigger that dies to Cleave during Moths' run and comes back takes no card from its start-of-turn hook (R83)", () => {
    const g = scenario({
      seed: REBORN_SEED,
      p1: {
        hand: [SURGERY, VANILLA],
        field: [{ def: MOTHS, lane: 1 }, { def: GRAVEDIGGER, lane: 2 }],
        graveyard: [VANILLA],
        library: [...LIBRARY],
      },
      p2: { hand: [VANILLA], field: [{ def: PANTHER, radiant: true, lane: 1 }], library: [...LIBRARY] },
    });
    const digger = g.card(GRAVEDIGGER);
    g.play(SURGERY, { targets: at(digger) });
    expect(keywordsOf(g, digger)).toContain("Reborn");
    g.endTurn(); // p2's turn
    g.endTurn(); // p1's start of turn: Moths (lane 1) then Gravedigger (lane 2) are queued (R68)
    expect(g.state.active).toBe("p1");

    // Moths forced the radiant Panther to attack it; its Cleave killed Gravedigger in lane 2, and
    // Gravedigger came back through Reborn before its own queued hook popped.
    expect(g.events.some((e) => e.type === "destroyed" && e.instanceId === digger.id)).toBe(true);
    g.expectInZone(digger, "field");
    // The body entered after the turn started (R83), so the start of turn was not its to answer:
    // nothing leaves p1's graveyard.
    expect(g.pile("p1", "graveyard").map((c) => c.defId).sort()).toEqual([SURGERY, VANILLA].sort());
  });

  it("R174 a delayed steal whose target died and came back through Reborn during an earlier delayed effect fizzles (R76)", () => {
    // p1 plays two Kpop Fanatics on turn 9: A on p2's Big Felinor, then B on p2's Felinor Fiender,
    // which has Reborn and 10 damage and stands at 8/17 only because Big Felinor feeds its stats
    // (§8 #92, R116). At p1's next start of turn A steals Big Felinor first (R68's creation order),
    // the Fiender drops to 5/7 and dies, and Reborn brings it straight back at 1 health. B's target
    // left the field in between, so B fizzles (R76) and the Reborn body stays p2's.
    const g = scenario({
      p1: { hand: [KPOP, KPOP, VANILLA], library: [...LIBRARY] },
      p2: {
        hand: [VANILLA],
        field: [
          { def: FIENDER, lane: 1, damage: 10 },
          { def: BIG_FELINOR, lane: 2 },
        ],
        library: [...LIBRARY],
      },
    });
    const fiender = unitAt(g, "p2", 1);
    const felinor = unitAt(g, "p2", 2);
    g.state.players.p2.units[0]?.[0]?.grantedKeywords.push({ kind: "Reborn" });
    expect(g.stats(fiender).health).toBe(7);

    const [kpopA, kpopB] = g.hand("p1").filter((card) => card.defId === KPOP);
    if (kpopA === undefined || kpopB === undefined) throw new Error("setup: two Kpop Fanatics in hand");
    g.play(kpopA, { targets: [{ pick: "instance", instanceId: felinor.id }] });
    g.play(kpopB, { targets: [{ pick: "instance", instanceId: fiender.id }] });
    g.endTurn();
    expect(g.state.active).toBe("p2");
    g.endTurn();
    expect(g.state.active).toBe("p1");

    // A landed; the Fiender died and came back.
    expect(g.card(felinor).controller).toBe("p1");
    expect(g.events.some((event) => event.type === "destroyed" && event.instanceId === fiender.id)).toBe(true);
    g.expectInZone(fiender, "field");
    expect(g.card(fiender).rebornSpent).toBe(true);

    // B fizzled: the body that came back is still p2's.
    expect(g.card(fiender).controller).toBe("p2");
  });
});

const RENO = "core-053";
const RADIANT_SAINTESS = "core-081";
const TWISTING_NETHER = "core-088";

function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`missing: ${what}`);
  return value;
}

/** A fixture card: a transient def in the match state and its script in the registry. */
function fixture(s: Scenario, id: string, type: CardType, script: Script, stats = { attack: 2, health: 2 }): void {
  const face = type === "Unit" ? { ...stats, keywords: [], text: id } : { keywords: [], text: id };
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
    base: { ...face },
    radiant: { ...face },
  };
  s.state.transientDefs[id] = def;
  registerScripts({ ...registeredScripts(), [id]: { base: script, radiant: script } });
}

function placeFixture(s: Scenario, defId: string, player: PlayerId, row: Row, lane: number): CardInstance {
  const card = newInstance(s.state, defId, player, { z: "hand", player });
  if (!placeOnField(s.state, card, { player, row, lane })) throw new Error(`could not place ${defId}`);
  card.summonedTurn = s.state.turn - 1;
  return card;
}

/** Every pile of the state that holds this instance id (§10.1: a card is in one zone at a time). */
function pilesHolding(state: GameState, id: string): string[] {
  const out: string[] = [];
  for (const player of PLAYER_IDS) {
    const side = state.players[player];
    for (const zone of ["hand", "library", "graveyard", "exile", "resolving"] as const) {
      if (side[zone].some((card) => card.id === id)) out.push(`${player}.${zone}`);
    }
    side.units.forEach((pile, at) => {
      if ((pile ?? []).some((card) => card.id === id)) out.push(`${player}.units.${at + 1}`);
    });
    side.backrow.forEach((card, at) => {
      if (card?.id === id) out.push(`${player}.backrow.${at + 1}`);
    });
  }
  return out;
}

describe("§4.5 step 4, §10.1: Reborn never leaves one card in two zones", () => {
  it("§4.5 a Reborn unit a Death hook exiled out of the graveyard is not also put back on the field (R78, R127)", () => {
    const g = scenario({
      p1: { hand: [TWISTING_NETHER, STOCKPILE], field: [{ def: RADIANT_SAINTESS, lane: 1 }] },
      p2: { hand: [STOCKPILE], field: [{ def: RENO, lane: 1 }] },
    });
    // "Death: exile your graveyard", the way a later set's grave-robber would print it.
    fixture(g, "edge-r6-grave-robber", "Unit", { death: () => [exileMatching({ zones: ["graveyard"] })] });
    placeFixture(g, "edge-r6-grave-robber", "p1", "units", 2);
    const saintess = must(g.unit("p1", 1), "Radiant Saintess");

    // Twisting Nether destroys both. §4.5 step 3 runs the grave-robber's Death in lane order after
    // the Saintess's, and it exiles her from the graveyard she was collected to, where step 4 would
    // have found her.
    g.play(TWISTING_NETHER);

    // Wherever she ends up — back on the field or left in exile — she is one card in one zone, and
    // her `zone` says which.
    const zone = g.card(saintess).zone;
    const where = zone.z === "field" ? `${zone.player}.${zone.row}.${zone.lane}` : `${zone.player}.${zone.z}`;
    expect(pilesHolding(g.state, saintess.id)).toEqual([where]);
  });
});

// ---------------------------------------------------------------------------
// Round 9: a unit already killed is not killed again (R42, R89, §4.4 step 7)
// ---------------------------------------------------------------------------

/** A fixture unit with a face of its own: a transient def in the match state and its script in the registry. */
function fixtureUnit(s: Scenario, id: string, script: Script, stats: { attack: number; health: number }, keywords: Keyword[] = []): void {
  const face = { ...stats, keywords, text: id };
  const def: CardDef = {
    id,
    index: id,
    name: id,
    set: "Core",
    type: "Unit",
    tags: [],
    rarity: "Common",
    token: false,
    cost: 0,
    base: { ...face },
    radiant: { ...face },
  };
  s.state.transientDefs[id] = def;
  registerScripts({ ...registeredScripts(), [id]: { base: script, radiant: script } });
}

function inHand(s: Scenario, defId: string, player: PlayerId): CardInstance {
  const card = newInstance(s.state, defId, player, { z: "hand", player });
  s.state.players[player].hand.push(card);
  return card;
}

function placeUnit(s: Scenario, defId: string, player: PlayerId, lane: number): CardInstance {
  const card = newInstance(s.state, defId, player, { z: "hand", player });
  if (!placeOnField(s.state, card, { player, row: "units", lane })) throw new Error(`could not place ${defId}`);
  card.position = "ATK";
  return card;
}

function killerOf(s: Scenario, card: CardInstance): string | null | undefined {
  return s.events.find(
    (event): event is Extract<GameEvent, { type: "destroyed" }> => event.type === "destroyed" && event.instanceId === card.id,
  )?.killerId;
}

const ONE_UNIT: TargetDecl[] = [{ kind: "target", min: 1, max: 1, filter: { side: "any", of: ["unit"] } }];

/**
 * A board for one Death pass: p1's 3/3 Mr. Vanilla in lane 3, and p1 holding a radiant Hit Job that
 * destroys p2's lane-1 unit and the lane-2 unit beside it, so both of their Deaths run in that one
 * pass, lane 1 first (R68), with no state check between them (§4.5 step 3).
 */
function deathPassBoard(): { s: Scenario; vanilla: CardInstance } {
  const s = scenario({
    p1: { hand: [{ def: HIT_JOB, radiant: true }, RENO], field: [{ def: VANILLA, lane: 3 }], library: [...LIBRARY] },
    p2: { hand: [RENO], library: [...LIBRARY] },
  });
  return { s, vanilla: must(s.unit("p1", 3), "p1's Mr. Vanilla") };
}

/** "Death: deal `amount` damage to p1's Mr. Vanilla." */
function hitsVanilla(vanilla: CardInstance, amount: number): Script {
  return { death: () => [damage({ to: { of: "instance", instanceId: vanilla.id }, amount })] };
}

describe("R42, R89: a unit already killed is not killed again", () => {
  it("R42 a destroy that lands after this unit's lethal hit leaves the kill with this unit, so its Prem Panther text draws 2 (R89)", () => {
    const s = scenario({
      p1: { hand: [RENO], library: [...LIBRARY] },
      p2: { field: [{ def: VANILLA, lane: 1 }], hand: [RENO], library: [...LIBRARY] },
    });
    // "Cry: deal 5 damage to a target unit; destroy it", carrying #32's "whenever this destroys a
    // unit, draw 2" — a #99 Craft a Card of #68 and #2 with #32's text, as one card.
    const panther = must(registeredScripts()[PANTHER], "#32's script");
    fixtureUnit(
      s,
      "edge-r9-maul",
      {
        targets: ONE_UNIT,
        triggers: panther.base.triggers ?? [],
        cry: () => [damage({ to: { of: "chosen" }, amount: 5 }), destroy({ target: { of: "chosen" } })],
      },
      { attack: 2, health: 2 },
    );
    const maul = inHand(s, "edge-r9-maul", "p1");
    const vanilla = must(s.unit("p2", 1), "p2's Mr. Vanilla");
    const hand = s.hand("p1").length;

    s.play(maul, { targets: [{ pick: "instance", instanceId: vanilla.id }] });

    // The 5 took the 3/3 to -2: that hit was the lethal damage instance, and the destroy that
    // followed it found a unit already dead (§4.5 step 1 collects it on either count).
    s.expectInZone(vanilla, "graveyard");
    expect(killerOf(s, vanilla)).toBe(maul.id);
    // The maul left the hand and its kill drew 2.
    expect(s.hand("p1")).toHaveLength(hand - 1 + 2);
  });

  it("R42 a Poisonous hit on a unit an earlier hit already took to 0 does not take the kill from that hit (R89, §4.4 step 7)", () => {
    const { s, vanilla } = deathPassBoard();
    // Two p2 units whose Deaths hit p1's 3/3: lane 1's Death deals 5, then (R68 order) lane 2's,
    // a Poisonous unit's, deals 1 — both in the one Death pass, with no check between (§4.5 step 3).
    fixtureUnit(s, "edge-r9-hammer", hitsVanilla(vanilla, 5), { attack: 1, health: 1 });
    fixtureUnit(s, "edge-r9-sting", hitsVanilla(vanilla, 1), { attack: 1, health: 1 }, [{ kind: "Poisonous" }]);
    const hammer = placeUnit(s, "edge-r9-hammer", "p2", 1);
    const sting = placeUnit(s, "edge-r9-sting", "p2", 2);

    // Radiant Hit Job destroys the hammer and the sting beside it.
    s.play(HIT_JOB, { targets: [{ pick: "instance", instanceId: hammer.id }] });

    expect(s.events).toContainEqual(expect.objectContaining({ type: "damage", sourceId: hammer.id, targetId: vanilla.id, amount: 5 }));
    expect(s.events).toContainEqual(expect.objectContaining({ type: "damage", sourceId: sting.id, targetId: vanilla.id, amount: 1 }));
    s.expectInZone(vanilla, "graveyard");
    // The hammer's 5 took it from 3 to -2; the sting hit a unit that was already dead.
    expect(killerOf(s, vanilla)).toBe(hammer.id);
  });

  it("R42 a hit that takes a unit a Poisonous hit already marked destroyed to 0 does not take the kill from the Poisonous unit (R89, §4.4 step 7)", () => {
    const { s, vanilla } = deathPassBoard();
    // The same pass the other way round: lane 1's Poisonous Death deals 1 (3/3 → 2 health, marked
    // destroyed), then lane 2's deals 5 to a unit that step 7 has already destroyed.
    fixtureUnit(s, "edge-r9-sting", hitsVanilla(vanilla, 1), { attack: 1, health: 1 }, [{ kind: "Poisonous" }]);
    fixtureUnit(s, "edge-r9-hammer", hitsVanilla(vanilla, 5), { attack: 1, health: 1 });
    const sting = placeUnit(s, "edge-r9-sting", "p2", 1);
    const hammer = placeUnit(s, "edge-r9-hammer", "p2", 2);

    s.play(HIT_JOB, { targets: [{ pick: "instance", instanceId: sting.id }] });

    expect(s.events).toContainEqual(expect.objectContaining({ type: "damage", sourceId: sting.id, targetId: vanilla.id, amount: 1 }));
    expect(s.events).toContainEqual(expect.objectContaining({ type: "damage", sourceId: hammer.id, targetId: vanilla.id, amount: 5 }));
    s.expectInZone(vanilla, "graveyard");
    // "The Poisonous hit is the one that destroys it, whatever health it left" (damage.ts, R42):
    // the sting's hit killed it, and the hammer's 5 landed on a unit already destroyed.
    expect(killerOf(s, vanilla)).toBe(sting.id);
  });
});
