// Cards buried under a Stack pile, and what Reborn brings back (SPEC §3.2, §4.5, §7, R13, R175).
// Found by the polish-4 edge-case hunt, round 3 (docs/polish/4-edge-cases.md, lenses L2, L3 and L4);
// every case here failed before its fix.
//
//  - §3.2, R13: a card dormant under a Stack is not on the field, so §4.5's check never collects it
//    there. The top shields it: an aura or a layer-2 Felinor that stops reaching it cannot kill it,
//    and it is judged when it resumes on top, with the board's auras reaching it again.
//  - R175: a token summoned X/X comes back through Reborn with that X/X, its printed face (§7), at
//    1 health — not as a printed 0/0 that dies again.
//  - Round 10 (lens "engine invariants"). R212, R119: a card that resumes as its pile's top did not
//    see what happened while it lay dormant (§3.2, R153), so it answers neither the death that
//    uncovered it nor the play that was resolving when it resumed.
//  - The review of round 10. R212: that is kept against the one removal that uncovered it, so a
//    later move of the card that left — exiled out of its graveyard — does not make the card that
//    resumed long before miss what its batch did first.

import {
  newInstance,
  placeOnField,
  registerScripts,
  registeredScripts,
  type CardInstance,
  type Script,
} from "@jackioh/engine";
import { damage, exileMatching, sacrifice } from "@jackioh/engine/effects";
import type { CardDef, GameEvent, Selection } from "@jackioh/shared";
import { describe, expect, it } from "vitest";
import { scenario, type Scenario } from "./_harness";

const VANILLA = "core-008";
const HIT_JOB = "core-016";
const BIG_FELINOR = "core-043";
const RUSH_TOKEN_FARM = "core-058";
const FIENDER = "core-092";
const RUSH_TOKEN = "core-t-rush";
const BREAD = "core-t-bread";
const LIBRARY = [VANILLA, VANILLA, VANILLA, VANILLA, VANILLA, VANILLA];

const at = (card: CardInstance): Selection[] => [{ pick: "instance", instanceId: card.id }];

function unitAt(g: Scenario, player: "p1" | "p2", lane: number): CardInstance {
  const card = g.unit(player, lane);
  if (card === null) throw new Error(`setup: ${player} lane ${lane} is empty`);
  return card;
}

/** Every instance a `destroyed` event has named since setup. */
function destroyedIds(g: Scenario): string[] {
  return g.events.flatMap((event) => (event.type === "destroyed" ? [event.instanceId] : []));
}

describe("R13: the state check never reaches under a Stack pile", () => {
  it("R13 a damaged Rush Token that radiant Rush Token Farm keeps alive survives being buried under a Stack, and resumes when the top leaves (§3.2)", () => {
    const g = scenario({
      p1: {
        hand: [FIENDER, HIT_JOB],
        field: [{ def: RUSH_TOKEN, lane: 1, damage: 4 }],
        backrow: [{ def: RUSH_TOKEN_FARM, lane: 1, radiant: true }],
        library: [...LIBRARY],
      },
      p2: { hand: [VANILLA], library: [...LIBRARY] },
    });
    const token = unitAt(g, "p1", 1);
    // 3/3 printed, +3/+3 from the radiant Farm's aura, 4 damage taken: alive at 2.
    g.expectStats(token, { attack: 6, maxHealth: 6, health: 2 });

    // Felinor Fiender (Stack) goes on top of it: the token is dormant and the aura stops reaching
    // it, but nothing hit it and the check does not look under the pile.
    g.play(FIENDER, { zone: 1 });
    const fiender = unitAt(g, "p1", 1);
    expect(fiender.defId).toBe(FIENDER);
    expect(destroyedIds(g)).not.toContain(token.id);
    g.expectInZone(token, "field");

    // The top leaves; the token resumes on top of the zone, and the Farm's aura reaches it again.
    g.play(HIT_JOB, { targets: at(fiender) });
    expect(g.unit("p1", 1)?.id).toBe(token.id);
    g.expectStats(token, { attack: 6, maxHealth: 6, health: 2 });
  });

  it("R13 a Felinor Fiender buried under a second Fiender is not killed under the pile when the Felinor feeding it dies (§10.4 layer 2)", () => {
    const g = scenario({
      p1: {
        hand: [FIENDER, HIT_JOB],
        field: [{ def: FIENDER, lane: 1, damage: 10 }, { def: BIG_FELINOR, lane: 2 }],
        library: [...LIBRARY],
      },
      p2: { hand: [VANILLA], library: [...LIBRARY] },
    });
    const buried = unitAt(g, "p1", 1);
    const felinor = unitAt(g, "p1", 2);
    // 5/7 printed plus Big Felinor's 3/10, with 10 damage: alive at 7.
    g.expectStats(buried, { attack: 8, maxHealth: 17, health: 7 });

    g.play(FIENDER, { zone: 1 });
    expect(g.unit("p1", 1)?.id).not.toBe(buried.id);

    g.play(HIT_JOB, { targets: at(felinor) });
    g.expectInZone(felinor, "graveyard");
    expect(destroyedIds(g)).not.toContain(buried.id);
    g.expectInZone(buried, "field");
  });

  it("R13 a dormant Felinor Fiender with Reborn that a Felinor's death leaves at 0 never comes back on top of the card acting in its zone (§3.2, R47, R175)", () => {
    // Lane 1 is a pile: Fiender A on top of Fiender B. B took 10 damage while Big Felinor fed its
    // stats (8/17), and has Reborn. Hit Job on Big Felinor drops B to 5/7 under 10 damage.
    const g = scenario({
      p1: {
        hand: [HIT_JOB, VANILLA],
        field: [
          { def: FIENDER, lane: 1, damage: 10 },
          { def: BIG_FELINOR, lane: 2 },
          { def: FIENDER, lane: 1, stack: true },
        ],
        library: [...LIBRARY],
      },
      p2: { hand: [VANILLA], library: [...LIBRARY] },
    });
    const pile = g.state.players.p1.units[0] ?? [];
    const top = pile[0];
    const buried = pile[1];
    if (top === undefined || buried === undefined) throw new Error("setup: a two-card pile in lane 1");
    buried.grantedKeywords.push({ kind: "Reborn" });
    const felinor = unitAt(g, "p1", 2);

    g.play(HIT_JOB, { targets: at(felinor) });
    g.expectInZone(felinor, "graveyard");

    // B is not on the field, so it neither dies nor returns; A still acts for lane 1. R175 puts a
    // body back on top of a pile only when it died on top of it.
    expect(g.unit("p1", 1)?.id).toBe(top.id);
    expect(destroyedIds(g)).not.toContain(buried.id);
  });
});

describe("R175: a token summoned X/X comes back through Reborn as that X/X", () => {
  it("R175 a Bread Token given Reborn comes back at 1 health with its X/X, rather than as a 0/0 that dies again (§4.5 step 4, §7)", () => {
    const g = scenario({
      p1: {
        hand: [HIT_JOB, VANILLA],
        field: [{ def: BREAD, lane: 1, statsOverride: { attack: 3, health: 3 } }],
        library: [...LIBRARY],
      },
      p2: { hand: [VANILLA], library: [...LIBRARY] },
    });
    const bread = unitAt(g, "p1", 1);
    g.card(bread).grantedKeywords.push({ kind: "Reborn" });
    expect(g.stats(bread).maxHealth).toBe(3);

    g.play(HIT_JOB, { targets: at(bread) });

    // "Returns ... at 1 health without Reborn", a unit token included: 3/3 with 2 damage.
    expect(g.unit("p1", 1)?.id).toBe(bread.id);
    g.expectStats(bread, { attack: 3, maxHealth: 3, health: 1 });
    // It died once, to Hit Job, not a second time to its own printed 0/0.
    expect(g.events.filter((e) => e.type === "destroyed" && e.instanceId === bread.id)).toHaveLength(1);
  });
});

/**
 * A test-only unit on p1's side: a transient def in the match state and its script in the registry.
 * Its one trigger deals 1 damage to the enemy hero whenever an event of type `on` is dispatched, so
 * a firing is a `damage` event whose source is this card. No Core unit watches another card's event
 * from the field (#32 and #91 watch their own), which is why these cases need one.
 */
function placeWatcher(g: Scenario, id: string, lane: number, on: GameEvent["type"]): CardInstance {
  const script: Script = {
    triggers: [{ id: `${id}:on-${on}`, on: [on], run: () => [damage({ to: { of: "enemyHero" }, amount: 1 })] }],
  };
  const face = { attack: 1, health: 5, keywords: [], text: `On ${on}: deal 1 damage to the enemy hero` };
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
  g.state.transientDefs[id] = def;
  registerScripts({ ...registeredScripts(), [id]: { base: script, radiant: script } });
  const card = newInstance(g.state, id, "p1", { z: "hand", player: "p1" });
  if (!placeOnField(g.state, card, { player: "p1", row: "units", lane })) throw new Error("could not place the watcher");
  card.summonedTurn = 0;
  return card;
}

describe("R212, R119: a card that resumes on top of its pile did not see what uncovered it (§3.2, R153)", () => {
  // Found while teaching the probe's stay shadow §3.2's resume: when the top of a Stack pile leaves,
  // the card beneath starts acting in that same step with no event of its own, and the resolution
  // loop then offered it the very event that uncovered it — R212 read the moves the events after it
  // recorded, and a resume records none (`stays.noteUncovered` keeps it now).
  it("R212 a card dormant under a Stack does not answer the death that uncovers it (§3.2, R153)", () => {
    const g = scenario({
      p1: { hand: [FIENDER, HIT_JOB], mana: 4 },
      p2: { field: ["core-011"], health: 20 },
    });
    // "Whenever a unit dies, deal 1 damage to the enemy hero", in p1's lane 1.
    const watcher = placeWatcher(g, "fixture:r10-death-watcher", 1, "destroyed");
    const fiender = g.card(FIENDER);

    // #92 Felinor Fiender has Stack (§6.2): played onto lane 1, it buries the watcher (§3.2, R13).
    g.play(fiender, { zone: 1 });
    expect(g.state.players.p1.units[0]?.map((c) => c.id)).toEqual([fiender.id, watcher.id]);

    // #16 Hit Job destroys the Fiender, and the watcher resumes as its pile's top (§3.2). When the
    // Fiender died the watcher was dormant — "not on the field for effects" (§3.2), registering
    // nothing (R153) — and R212 answers an event "as the board stood when it happened": it comes
    // back into play because of that death, as a Reborn body does, and R212 has a Reborn body not
    // answer the hit that killed its unit. Hearthstone agrees: a minion that enters play because a
    // minion died does not see that death.
    g.play(HIT_JOB, { targets: at(fiender) });
    expect(g.unit("p1", 1)?.id).toBe(watcher.id);
    const hits = g.lastEvents.filter((e) => e.type === "damage" && e.sourceId === watcher.id);
    expect(hits, JSON.stringify(g.lastEvents)).toEqual([]);
    expect(g.state.players.p2.hero.health).toBe(20);
  });

  it("R119 a card a play uncovers in its Stack pile does not answer that play's cardResolved (§3.2, R153)", () => {
    const g = scenario({
      p1: { hand: [FIENDER, HIT_JOB], mana: 4 },
      p2: { field: ["core-011"], health: 20 },
    });
    // "Whenever a card finishes resolving, deal 1 damage to the enemy hero", in p1's lane 1.
    const watcher = placeWatcher(g, "fixture:r10-resolve-watcher", 1, "cardResolved");
    const fiender = g.card(FIENDER);
    g.play(fiender, { zone: 1 });
    // Step 4 buried the watcher before the Fiender's own play reached step 7, so it answered nothing.
    expect(g.state.players.p2.hero.health).toBe(20);

    // Hit Job kills the Fiender inside its own resolution, so the watcher resumes before step 7's
    // `cardResolved`: it lay dormant as the play began and registered nothing then (R153), and R119
    // counts it with the arrivals the play's `cardResolved` names, as it does a Reborn body.
    g.play(HIT_JOB, { targets: at(fiender) });
    expect(g.unit("p1", 1)?.id).toBe(watcher.id);
    const hits = g.lastEvents.filter((e) => e.type === "damage" && e.sourceId === watcher.id);
    expect(hits, JSON.stringify(g.lastEvents)).toEqual([]);
    expect(g.state.players.p2.hero.health).toBe(20);
  });
});

/**
 * A test-only unit on p1's side that deals 1 damage to the enemy hero whenever another source deals
 * damage, so a firing is a `damage` event whose source is this card (and it never answers its own).
 */
function placeHitWatcher(g: Scenario, id: string, lane: number): CardInstance {
  const script: Script = {
    triggers: [
      {
        id: `${id}:on-damage`,
        on: ["damage"],
        run: (ctx) =>
          ctx.event.type === "damage" && ctx.event.sourceId !== ctx.self?.id
            ? [damage({ to: { of: "enemyHero" }, amount: 1 })]
            : [],
      },
    ],
  };
  const face = { attack: 1, health: 5, keywords: [], text: "Whenever another source deals damage, deal 1 to the enemy hero" };
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
  g.state.transientDefs[id] = def;
  registerScripts({ ...registeredScripts(), [id]: { base: script, radiant: script } });
  const card = newInstance(g.state, id, "p1", { z: "hand", player: "p1" });
  if (!placeOnField(g.state, card, { player: "p1", row: "units", lane })) throw new Error("could not place the watcher");
  card.summonedTurn = 0;
  return card;
}

/** A test-only 0-cost Spell in p1's hand whose Cry is `cry`. */
function spellInHand(g: Scenario, id: string, cry: Script["cry"]): CardInstance {
  const face = { keywords: [], text: id };
  const def: CardDef = {
    id,
    index: id,
    name: id,
    set: "Core",
    type: "Spell",
    tags: [],
    rarity: "Common",
    token: false,
    cost: 0,
    base: { ...face },
    radiant: { ...face },
  };
  g.state.transientDefs[id] = def;
  const script: Script = cry === undefined ? {} : { cry };
  registerScripts({ ...registeredScripts(), [id]: { base: script, radiant: script } });
  const card = newInstance(g.state, id, "p1", { z: "hand", player: "p1" });
  g.state.players.p1.hand.push(card);
  return card;
}

describe("R212: a resume is kept against the removal that caused it, and no later move (§3.2, R153)", () => {
  // Review of round 10: the note a pile top's removal leaves (`stays.noteUncovered`) was kept until
  // that card next left the field, so every later move of the card that left — exiled out of its
  // graveyard, discarded, shuffled back — read as the removal again, and the card that had resumed
  // long before was taken for one that resumed after whatever the same batch did first.
  it("R212 a card that resumed under a Stack answers a later hit even when the same list then exiles the card that uncovered it from the graveyard", () => {
    const g = scenario({
      p1: { hand: [FIENDER, HIT_JOB], mana: 4 },
      p2: { field: ["core-011"], health: 20 },
    });
    const watcher = placeHitWatcher(g, "fixture:r11-hit-watcher", 1);
    const fiender = g.card(FIENDER);
    g.play(fiender, { zone: 1 });
    g.play(HIT_JOB, { targets: at(fiender) });
    // The Fiender died on top of the watcher, which resumed then and answered nothing of it.
    expect(g.unit("p1", 1)?.id).toBe(watcher.id);
    expect(g.state.players.p2.hero.health).toBe(20);

    // A later action: a Spell hits p2's hero, then exiles p1's graveyard, the Fiender with it. The
    // watcher has stood on top since the last action, so it saw the hit; the exile is a move out of a
    // graveyard, not the death that uncovered it.
    const spell = spellInHand(g, "fixture:r11-hit-then-exile", () => [
      damage({ to: { of: "enemyHero" }, amount: 1 }),
      exileMatching({ zones: ["graveyard"] }),
    ]);
    g.play(spell);
    expect(g.lastEvents.some((e) => e.type === "exiled" && e.instanceId === fiender.id)).toBe(true);
    const hits = g.lastEvents.filter((e) => e.type === "damage" && e.sourceId === watcher.id);
    expect(hits, JSON.stringify(g.lastEvents)).toHaveLength(1);
    expect(g.state.players.p2.hero.health).toBe(18);
  });

  it("R212 a card still dormant when a hit landed does not answer it, though the same list then kills the card above it and exiles that card from the graveyard", () => {
    const g = scenario({
      p1: { hand: [FIENDER], mana: 4 },
      p2: { field: ["core-011"], health: 20 },
    });
    const watcher = placeHitWatcher(g, "fixture:r11-dormant-watcher", 1);
    const fiender = g.card(FIENDER);
    g.play(fiender, { zone: 1 });

    // The hit lands while the watcher lies under the Fiender; the sacrifice uncovers it, and the
    // exile then takes the Fiender on out of the graveyard before the loop reaches the hit. The
    // watcher resumed after the hit, so it did not see it — the later exile changes nothing.
    const spell = spellInHand(g, "fixture:r11-hit-sacrifice-exile", () => [
      damage({ to: { of: "enemyHero" }, amount: 1 }),
      sacrifice({ target: { of: "instance", instanceId: fiender.id } }),
      exileMatching({ zones: ["graveyard"] }),
    ]);
    g.play(spell);
    expect(g.unit("p1", 1)?.id).toBe(watcher.id);
    expect(g.lastEvents.some((e) => e.type === "exiled" && e.instanceId === fiender.id)).toBe(true);
    const hits = g.lastEvents.filter((e) => e.type === "damage" && e.sourceId === watcher.id);
    expect(hits, JSON.stringify(g.lastEvents)).toEqual([]);
    expect(g.state.players.p2.hero.health).toBe(19);
  });
});
