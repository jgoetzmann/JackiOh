// Summon, Recruit and "fill your board" (SPEC §6.3, §3.2, §7, R64, BUILD M3-T1).
// The fixture defs and scripts these tests need are registered here, on top of the shared fixture
// catalog, so no shared fixture has to grow for them (CLAUDE.md, BUILD §0).

import type { CardDef, GameEvent, PlayerId, Selection } from "@jackioh/shared";
import { describe, expect, it } from "vitest";
import { registerCatalog, registeredCatalog } from "../src/catalog";
import { HERO_HEALTH } from "../src/config";
import { damage } from "../src/effects";
import { fillBoard, recruit, summon } from "../src/effects/summon";
import { unitView } from "../src/layers";
import { makeContext } from "../src/resolve";
import type { CardScripts, Effect, Script } from "../src/script";
import { registerScripts, registeredScripts } from "../src/scripts";
import { newInstance, type CardInstance, type GameState } from "../src/state";
import { cardAt, lockZone, reserveZone } from "../src/zones";
import { tokenDef } from "./fixtures/catalog";
import { eventsOfType, newGame, put, setLibrary, sinkFor, slot } from "./fixtures/harness";

// ---------------------------------------------------------------------------
// Fixture cards.
// ---------------------------------------------------------------------------

let nextIndex = 700;

function defOfKind(name: string, type: CardDef["type"], overrides: Partial<CardDef> = {}): CardDef {
  nextIndex += 1;
  return {
    id: `sm-${name}`,
    index: String(nextIndex),
    name: `${name} (summon)`,
    set: "Core",
    type,
    tags: [],
    rarity: "Common",
    token: false,
    cost: 1,
    base: { attack: 2, health: 2, keywords: [], text: name },
    radiant: { attack: 4, health: 4, keywords: [], text: `${name} radiant` },
    ...overrides,
  };
}

/** #12-style: a Cry that pings the enemy hero, so "a summon fires no Cry" is observable (R1). */
const crier = defOfKind("crier", "Unit");
/** §3.2: a Trap enters the backrow face-down. */
const trap = defOfKind("trap", "Trap", { base: { keywords: [], text: "trap" }, radiant: { keywords: [], text: "trap" } });
/** §3.2: a Field Spell is public to both players. */
const fieldSpell = defOfKind("field-spell", "Field Spell", {
  base: { keywords: [], text: "field" },
  radiant: { keywords: [], text: "field" },
});
/** A Spell, which §5.1 never puts on the field. */
const spell = defOfKind("spell", "Spell", { base: { keywords: [], text: "spell" }, radiant: { keywords: [], text: "spell" } });
/** A tagged permanent for Recruit's filter. */
const felinor = defOfKind("felinor", "Unit", { tags: ["Felinor"] });
/** A cost-4 permanent, for the cost half of Recruit's filter (R65). */
const pricey = defOfKind("pricey", "Unit", { cost: 4 });

const rushToken = tokenDef("rush");

const DEFS: CardDef[] = [crier, trap, fieldSpell, spell, felinor, pricey];

function both(script: Script): CardScripts {
  return { base: script, radiant: script };
}

const SCRIPTS: Record<string, CardScripts> = {
  [crier.id]: both({ cry: () => [damage({ to: { of: "enemyHero" }, amount: 3 })] }),
};

/** A fresh game whose catalog and script registry also carry this file's fixtures. */
function game(seed = "effects-summon"): GameState {
  const state = newGame(seed);
  registerCatalog({ ...registeredCatalog(), ...Object.fromEntries(DEFS.map((def) => [def.id, def])) });
  registerScripts({ ...registeredScripts(), ...SCRIPTS });
  state.turn = 3;
  return state;
}

type RunOptions = { controller?: PlayerId; self?: CardInstance; targets?: Selection[] };

/** Apply one effect the way a script's hook would, and hand back the events it emitted. */
function run(state: GameState, effect: Effect, options: RunOptions = {}): GameEvent[] {
  const sink = sinkFor(state);
  const ctx = makeContext(sink, options.self ?? null, {
    controller: options.controller ?? "p1",
    ...(options.targets === undefined ? {} : { targets: options.targets }),
  });
  effect.apply(ctx);
  state.rngCursor = sink.rng.cursor;
  return sink.events;
}

function lanesOf(state: GameState, player: PlayerId, row: "units" | "backrow"): (string | null)[] {
  return [1, 2, 3, 4, 5].map((lane) => cardAt(state, slot(player, row, lane))?.defId ?? null);
}

function inGraveyard(state: GameState, defId: string, player: PlayerId): CardInstance {
  const card = newInstance(state, defId, player, { z: "graveyard", player });
  state.players[player].graveyard.push(card);
  return card;
}

// ---------------------------------------------------------------------------
// summon
// ---------------------------------------------------------------------------

describe("summon (§6.3, M3-T1)", () => {
  it("R64 takes the leftmost empty unlocked zone of its row with no zone named", () => {
    const state = game();
    put(state, "fx-1", slot("p1", "units", 1));
    put(state, "fx-2", slot("p1", "units", 3));

    run(state, summon({ defId: "fx-5" }));

    expect(lanesOf(state, "p1", "units")).toEqual(["fx-1", "fx-5", "fx-2", null, null]);
  });

  it("R64 skips a Locked zone and one reserved for a Reborn unit", () => {
    const state = game();
    lockZone(state, slot("p1", "units", 1));
    reserveZone(state, slot("p1", "units", 2));

    run(state, summon({ defId: "fx-5" }));

    expect(lanesOf(state, "p1", "units")).toEqual([null, null, "fx-5", null, null]);
  });

  it("§3.2 a summon into a full row fails silently and creates nothing", () => {
    const state = game();
    for (const lane of [1, 2, 3, 4, 5]) put(state, "fx-1", slot("p1", "units", lane));
    const ids = state.nextId;

    const events = run(state, summon({ defId: "fx-5" }));

    expect(eventsOfType(events, "summoned")).toEqual([]);
    expect(state.nextId).toBe(ids);
    expect(lanesOf(state, "p1", "units")).toEqual(["fx-1", "fx-1", "fx-1", "fx-1", "fx-1"]);
  });

  it("R47 a lane-named summon fizzles on an occupied or a Locked zone", () => {
    const state = game();
    put(state, "fx-1", slot("p1", "units", 2));
    lockZone(state, slot("p1", "units", 4));

    expect(eventsOfType(run(state, summon({ defId: "fx-5", lane: 2 })), "summoned")).toEqual([]);
    expect(eventsOfType(run(state, summon({ defId: "fx-5", lane: 4 })), "summoned")).toEqual([]);
    expect(eventsOfType(run(state, summon({ defId: "fx-5", lane: 5 })), "summoned")).toHaveLength(1);
    expect(lanesOf(state, "p1", "units")).toEqual([null, "fx-1", null, null, "fx-5"]);
  });

  it("emits summoned with the zone it landed in and gives the card summoning sickness", () => {
    const state = game();

    const events = run(state, summon({ defId: "fx-7", lane: 4 }));
    const card = cardAt(state, slot("p1", "units", 4));

    expect(card).not.toBeNull();
    expect(card?.summonedTurn).toBe(state.turn);
    expect(eventsOfType(events, "summoned")).toEqual([
      { type: "summoned", player: "p1", instanceId: card?.id, defId: "fx-7", row: "units", lane: 4 },
    ]);
  });

  it("§7 summons a token with a statsOverride, which the layers read", () => {
    const state = game();

    run(state, summon({ defId: rushToken.id, statsOverride: { attack: 5, health: 5 } }));
    const token = cardAt(state, slot("p1", "units", 1));

    expect(token?.defId).toBe(rushToken.id);
    expect(token?.statsOverride).toEqual({ attack: 5, health: 5 });
    expect(unitView(state, token as CardInstance).attack).toBe(5);
    expect(unitView(state, token as CardInstance).maxHealth).toBe(5);
  });

  it("R1 fires no Cry", () => {
    const state = game();

    const events = run(state, summon({ defId: crier.id }));

    expect(cardAt(state, slot("p1", "units", 1))?.defId).toBe(crier.id);
    expect(eventsOfType(events, "damage")).toEqual([]);
    expect(state.players.p2.hero.health).toBe(HERO_HEALTH);
  });

  it("§5.1 refuses to summon a Spell", () => {
    const state = game();

    const events = run(state, summon({ defId: spell.id }));

    expect(eventsOfType(events, "summoned")).toEqual([]);
    expect(lanesOf(state, "p1", "units")).toEqual([null, null, null, null, null]);
    expect(lanesOf(state, "p1", "backrow")).toEqual([null, null, null, null, null]);
  });

  it("R33 a summoned Trap enters the backrow face-down while a Field Spell is public", () => {
    const state = game();

    run(state, summon({ defId: trap.id }));
    run(state, summon({ defId: fieldSpell.id }));

    expect(lanesOf(state, "p1", "backrow")).toEqual([trap.id, fieldSpell.id, null, null, null]);
    expect(cardAt(state, slot("p1", "backrow", 1))?.faceUp).toBeUndefined();
    expect(cardAt(state, slot("p1", "backrow", 2))?.faceUp).toBe(true);
  });

  it("§3.2 a Stack summon enters an occupied unit zone and becomes the pile's top card", () => {
    const state = game();
    const under = put(state, "fx-1", slot("p1", "units", 1));
    under.damage = 2;

    const events = run(state, summon({ defId: "fx-5", lane: 1, stack: true }));

    expect(cardAt(state, slot("p1", "units", 1))?.defId).toBe("fx-5");
    expect(state.players.p1.units[0]?.map((c) => c.defId)).toEqual(["fx-5", "fx-1"]);
    expect(under.damage).toBe(2);
    expect(eventsOfType(events, "summoned").map((e) => e.lane)).toEqual([1]);
  });

  it("§6.3 moves a card that already exists from the graveyard onto the field", () => {
    const state = game();
    const dead = inGraveyard(state, "fx-9", "p1");

    const events = run(state, summon({ instance: { of: "chosen" } }), {
      targets: [{ pick: "instance", instanceId: dead.id }],
    });

    expect(state.players.p1.graveyard).toHaveLength(0);
    expect(cardAt(state, slot("p1", "units", 1))?.id).toBe(dead.id);
    expect(dead.zone).toEqual({ z: "field", player: "p1", row: "units", lane: 1 });
    expect(eventsOfType(events, "summoned").map((e) => e.instanceId)).toEqual([dead.id]);
  });

  it("R12 summoning an enemy-owned card puts it under the summoner's control, owner unchanged", () => {
    const state = game();
    const theirs = inGraveyard(state, "fx-9", "p2");

    run(state, summon({ instance: { of: "chosen" } }), {
      controller: "p1",
      targets: [{ pick: "instance", instanceId: theirs.id }],
    });

    expect(cardAt(state, slot("p1", "units", 1))?.id).toBe(theirs.id);
    expect(theirs.controller).toBe("p1");
    expect(theirs.owner).toBe("p2");
  });
});

// ---------------------------------------------------------------------------
// recruit
// ---------------------------------------------------------------------------

describe("recruit (§6.3, M3-T1)", () => {
  it("§6.3 takes the first permanent from the top and leaves the rest of the library in order", () => {
    const state = game();
    // setLibrary hands back the library array itself, so the ids are snapshotted before the move.
    const ids = setLibrary(state, "p1", ["fx-1", "fx-2", "fx-3"]).map((card) => card.id);

    const events = run(state, recruit());

    expect(cardAt(state, slot("p1", "units", 1))?.id).toBe(ids[0]);
    expect(state.players.p1.library.map((c) => c.id)).toEqual([ids[1], ids[2]]);
    expect(eventsOfType(events, "summoned").map((e) => e.defId)).toEqual(["fx-1"]);
  });

  it("§6.3 skips Spells and every permanent the filter rejects, keeping the library's order", () => {
    const state = game();
    const ids = setLibrary(state, "p1", [spell.id, "fx-1", felinor.id, "fx-2"]).map((card) => card.id);

    run(state, recruit({ filter: { tags: ["Felinor"] } }));

    expect(cardAt(state, slot("p1", "units", 1))?.defId).toBe(felinor.id);
    expect(state.players.p1.library.map((c) => c.id)).toEqual([ids[0], ids[1], ids[3]]);
  });

  it("R65 filters on the printed cost and stops at the first match", () => {
    const state = game();
    setLibrary(state, "p1", ["fx-1", pricey.id, "fx-2"]);

    run(state, recruit({ filter: { cost: 4 } }));

    expect(cardAt(state, slot("p1", "units", 1))?.defId).toBe(pricey.id);
    expect(state.players.p1.library.map((c) => c.defId)).toEqual(["fx-1", "fx-2"]);
  });

  it("§6.3 a recruited Trap enters the backrow face-down", () => {
    const state = game();
    setLibrary(state, "p1", ["fx-1", trap.id]);

    run(state, recruit({ filter: { type: "Trap" } }));

    expect(cardAt(state, slot("p1", "backrow", 1))?.defId).toBe(trap.id);
    expect(cardAt(state, slot("p1", "backrow", 1))?.faceUp).toBeUndefined();
    expect(state.players.p1.library.map((c) => c.defId)).toEqual(["fx-1"]);
  });

  it("R227 a recruited Trap takes a fresh id as it goes face-down, and its summoned event names the old one", () => {
    const state = game();
    const [, held] = setLibrary(state, "p1", ["fx-1", trap.id]).map((card) => card.id);
    const next = `c${state.nextId}`;

    const events = run(state, recruit({ filter: { type: "Trap" } }));

    const set = cardAt(state, slot("p1", "backrow", 1));
    expect(set?.defId).toBe(trap.id);
    expect(set?.id).toBe(next);
    expect(set?.id).not.toBe(held);
    expect(eventsOfType(events, "summoned")).toEqual([
      { type: "summoned", player: "p1", instanceId: next, defId: trap.id, row: "backrow", lane: 1, formerId: held },
    ]);
  });

  it("R227 a recruited Unit or Field Spell keeps its id: only a card going face-down takes a fresh one", () => {
    const state = game();
    const [unitId, fieldId] = setLibrary(state, "p1", ["fx-1", fieldSpell.id]).map((card) => card.id);

    const events = [...run(state, recruit()), ...run(state, recruit({ filter: { type: "Field Spell" } }))];

    expect(cardAt(state, slot("p1", "units", 1))?.id).toBe(unitId);
    expect(cardAt(state, slot("p1", "backrow", 1))?.id).toBe(fieldId);
    expect(eventsOfType(events, "summoned").some((e) => e.formerId !== undefined)).toBe(false);
  });

  it("§3.2 summons nothing when no permanent matches, and nothing leaves the library", () => {
    const state = game();
    setLibrary(state, "p1", [spell.id, spell.id]);

    const events = run(state, recruit());

    expect(eventsOfType(events, "summoned")).toEqual([]);
    expect(state.players.p1.library).toHaveLength(2);
  });

  it("§3.2 a recruit into a full row fizzles and the card stays in the library", () => {
    const state = game();
    for (const lane of [1, 2, 3, 4, 5]) put(state, "fx-20", slot("p1", "units", lane));
    setLibrary(state, "p1", ["fx-1"]);

    const events = run(state, recruit());

    expect(eventsOfType(events, "summoned")).toEqual([]);
    expect(state.players.p1.library.map((c) => c.defId)).toEqual(["fx-1"]);
  });
});

// ---------------------------------------------------------------------------
// fillBoard
// ---------------------------------------------------------------------------

describe("fill your board (R64, §7, M3-T1)", () => {
  it("R64 summons a token into every empty unlocked unit zone, left to right", () => {
    const state = game();
    put(state, "fx-1", slot("p1", "units", 2));
    lockZone(state, slot("p1", "units", 4));

    const events = run(state, fillBoard({ defId: rushToken.id }));

    expect(lanesOf(state, "p1", "units")).toEqual([rushToken.id, "fx-1", rushToken.id, null, rushToken.id]);
    expect(eventsOfType(events, "summoned").map((e) => e.lane)).toEqual([1, 3, 5]);
  });

  it("§7 gives every token it makes the same statsOverride", () => {
    const state = game();

    run(state, fillBoard({ defId: rushToken.id, statsOverride: { attack: 5, health: 5 } }));

    const stats = [1, 2, 3, 4, 5].map((lane) => {
      const card = cardAt(state, slot("p1", "units", lane)) as CardInstance;
      return [unitView(state, card).attack, unitView(state, card).maxHealth];
    });
    expect(stats).toEqual([[5, 5], [5, 5], [5, 5], [5, 5], [5, 5]]);
  });

  it("R64 fills nothing when the unit row is full", () => {
    const state = game();
    for (const lane of [1, 2, 3, 4, 5]) put(state, "fx-1", slot("p1", "units", lane));
    const ids = state.nextId;

    const events = run(state, fillBoard({ defId: rushToken.id }));

    expect(eventsOfType(events, "summoned")).toEqual([]);
    expect(state.nextId).toBe(ids);
  });

  it("§7 fills the summoner's own row, so the opponent's board is untouched", () => {
    const state = game();

    run(state, fillBoard({ defId: rushToken.id }), { controller: "p2" });

    expect(lanesOf(state, "p2", "units").every((defId) => defId === rushToken.id)).toBe(true);
    expect(lanesOf(state, "p1", "units")).toEqual([null, null, null, null, null]);
  });
});
