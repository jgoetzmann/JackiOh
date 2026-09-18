// The three summon verbs that make a card out of something other than a fixed def id:
// R21's random keywords on a summon (#80 Zao Gao), §10.7's copy semantics (#12 Duplicating
// Felinors, #61 Prejudiced Postdoc, R57) and §10.7's random pool (#67 Zoomerbin Oomen, §5.1).
//
// The fixture defs and scripts live here, on top of the shared fixture catalog, so no shared
// fixture has to grow for them (CLAUDE.md, BUILD §0). Every assertion runs through a real
// `EffectContext` built by `makeContext`, the way a hook's effects are applied.

import type { CardDef, GameEvent, PlayerId, Selection } from "@jackioh/shared";
import { describe, expect, it } from "vitest";
import { registerCatalog, registeredCatalog } from "../src/catalog";
import { RANDOM_KEYWORD_POOL } from "../src/config";
import { damage } from "../src/effects";
import { summon, summonCopy, summonRandom } from "../src/effects/summon";
import { unitView } from "../src/layers";
import { makeContext, runHook } from "../src/resolve";
import type { CardScripts, Effect, Script } from "../src/script";
import { registerScripts, registeredScripts } from "../src/scripts";
import type { CardInstance, GameState } from "../src/state";
import { cardAt, lockZone } from "../src/zones";
import { eventsOfType, newGame, put, sinkFor, slot } from "./fixtures/harness";

// ---------------------------------------------------------------------------
// Fixture cards.
// ---------------------------------------------------------------------------

let nextIndex = 760;

function defOfKind(name: string, type: CardDef["type"], overrides: Partial<CardDef> = {}): CardDef {
  nextIndex += 1;
  return {
    id: `cp-${name}`,
    index: String(nextIndex),
    name: `${name} (copies)`,
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

/** The body every copy test duplicates: a plain 2/2 with nothing of its own. */
const body = defOfKind("body", "Unit");
/** #12-style: a Cry that pings the enemy hero, so "a copy fires no Cry" is observable (§6.2, R1). */
const crier = defOfKind("crier", "Unit");
/** Two defs that can share a `summonRandom` pool, so the draw has something to choose between. */
const poolA = defOfKind("pool-a", "Unit");
const poolB = defOfKind("pool-b", "Unit");
/** §3.2: a Trap enters the backrow face-down, even when a random pool put it there (R33). */
const poolTrap = defOfKind("pool-trap", "Trap", {
  base: { keywords: [], text: "trap" },
  radiant: { keywords: [], text: "trap" },
});

/** §7's shared Rush Token from the fixture catalog: printed Rush, so R21 draws from the other ten. */
const RUSH_TOKEN = "fx-token-rush";

const DEFS: CardDef[] = [body, crier, poolA, poolB, poolTrap];

function both(script: Script): CardScripts {
  return { base: script, radiant: script };
}

const SCRIPTS: Record<string, CardScripts> = {
  [crier.id]: both({ cry: () => [damage({ to: { of: "enemyHero" }, amount: 3 })] }),
};

/** A fresh game whose catalog and script registry also carry this file's fixtures. */
function game(seed = "effects-summon-copies"): GameState {
  const state = newGame(seed);
  registerCatalog({ ...registeredCatalog(), ...Object.fromEntries(DEFS.map((def) => [def.id, def])) });
  registerScripts({ ...registeredScripts(), ...SCRIPTS });
  state.turn = 3;
  return state;
}

type RunOptions = { controller?: PlayerId; self?: CardInstance; targets?: Selection[] };

/** Apply a whole effect list the way a hook's list is applied: one context, one rng, in order. */
function runAll(state: GameState, effects: Effect[], options: RunOptions = {}): GameEvent[] {
  const sink = sinkFor(state);
  const ctx = makeContext(sink, options.self ?? null, {
    controller: options.controller ?? "p1",
    ...(options.targets === undefined ? {} : { targets: options.targets }),
  });
  for (const effect of effects) effect.apply(ctx);
  state.rngCursor = sink.rng.cursor;
  return sink.events;
}

function run(state: GameState, effect: Effect, options: RunOptions = {}): GameEvent[] {
  return runAll(state, [effect], options);
}

function unitAt(state: GameState, lane: number, player: PlayerId = "p1"): CardInstance | null {
  return cardAt(state, slot(player, "units", lane));
}

function keywordKindsAt(state: GameState, lane: number): string[] {
  return (unitAt(state, lane)?.grantedKeywords ?? []).map((keyword) => keyword.kind);
}

// ---------------------------------------------------------------------------
// summon({ randomKeywords }) — R21, #80 Zao Gao
// ---------------------------------------------------------------------------

describe("summon with randomKeywords (R21, §7, #80)", () => {
  it("R21 gives the summoned token exactly 2 distinct keywords from the pool", () => {
    const state = game("kw-one");

    run(state, summon({ defId: RUSH_TOKEN, randomKeywords: 2 }));

    const token = unitAt(state, 1);
    expect(token?.defId).toBe(RUSH_TOKEN);
    const kinds = keywordKindsAt(state, 1);
    expect(kinds).toHaveLength(2);
    expect(new Set(kinds).size).toBe(2);
    // R21's pool, and never Rush, which the Rush Token already has.
    for (const kind of kinds) {
      expect(RANDOM_KEYWORD_POOL.some((entry) => entry.startsWith(kind))).toBe(true);
      expect(kind).not.toBe("Rush");
    }
    // The layers really see them (§10.4), so the grant landed on the summoned instance.
    const view = unitView(state, token as CardInstance);
    expect(view.keywords.length).toBeGreaterThanOrEqual(3);
  });

  it("R21 rolls each token's keywords independently, so two tokens in one list can differ", () => {
    const pairs = Array.from({ length: 12 }, (_unused, seed) => {
      const state = game(`kw-pair-${seed}`);
      runAll(state, [
        summon({ defId: RUSH_TOKEN, randomKeywords: 2 }),
        summon({ defId: RUSH_TOKEN, randomKeywords: 2 }),
      ]);
      return [keywordKindsAt(state, 1), keywordKindsAt(state, 2)] as const;
    });

    for (const [first, second] of pairs) {
      expect(new Set(first).size).toBe(2);
      expect(new Set(second).size).toBe(2);
    }
    // Independent rolls, so on some seed the two tokens are not the same pair of keywords.
    expect(pairs.some(([first, second]) => first.join("|") !== second.join("|"))).toBe(true);
  });

  it("R21 grants nothing when the summon fizzled, and takes no draw for it", () => {
    const state = game("kw-fizzle");
    for (const lane of [1, 2, 3, 4, 5]) put(state, body.id, slot("p1", "units", lane));
    const cursorBefore = state.rngCursor;

    const events = run(state, summon({ defId: RUSH_TOKEN, randomKeywords: 2 }));

    expect(eventsOfType(events, "summoned")).toEqual([]);
    expect(eventsOfType(events, "keywordGranted")).toEqual([]);
    expect(state.rngCursor).toBe(cursorBefore);
  });
});

// ---------------------------------------------------------------------------
// summonCopy — §10.7, R57, #12 and #61
// ---------------------------------------------------------------------------

describe("summonCopy (§10.7 copy semantics, R57, #12, #61)", () => {
  it("R57 keeps the radiant flag, the buffs, the granted keywords, Vanilla and statsOverride", () => {
    const state = game("copy-keeps");
    const source = put(state, body.id, slot("p1", "units", 2), { radiant: true });
    source.buffs = { attack: 2, health: 3 };
    source.grantedKeywords = [{ kind: "Taunt" }, { kind: "Armor", n: 1 }];
    source.statsOverride = { attack: 7, health: 9 };
    source.vanilla = true;

    const events = run(state, summonCopy({ of: { of: "instance", instanceId: source.id } }));

    // R64: the leftmost free zone, and one `summoned` event for it.
    expect(eventsOfType(events, "summoned").map((event) => event.lane)).toEqual([1]);
    const copy = unitAt(state, 1) as CardInstance;
    expect(copy.id).not.toBe(source.id);
    expect(copy.defId).toBe(source.defId);
    expect(copy.owner).toBe("p1");
    expect(copy.radiant).toBe(true);
    expect(copy.vanilla).toBe(true);
    expect(copy.buffs).toEqual({ attack: 2, health: 3 });
    expect(copy.statsOverride).toEqual({ attack: 7, health: 9 });
    expect(copy.grantedKeywords.map((keyword) => keyword.kind)).toEqual(["Taunt", "Armor"]);

    // The copy's state is its own: writing the source afterwards does not reach it.
    expect(copy.buffs).not.toBe(source.buffs);
    expect(copy.statsOverride).not.toBe(source.statsOverride);
    expect(copy.grantedKeywords).not.toBe(source.grantedKeywords);

    // §10.4 reads the copy through the same layers: the override is the base face, buffs on top.
    const view = unitView(state, copy);
    expect(view.attack).toBe(9);
    expect(view.maxHealth).toBe(12);
  });

  it("R57 resets damage, exertion, counters and summonedTurn on the copy", () => {
    const state = game("copy-resets");
    const source = put(state, body.id, slot("p1", "units", 2));
    source.damage = 4;
    source.exertion = { attacked: true, switched: true };
    source.counters = { plague: 2, grade: 1 };
    source.memory = { seen: 7 };
    source.summonedTurn = 1;
    source.position = "DEF";

    run(state, summonCopy({ of: { of: "instance", instanceId: source.id } }));

    const copy = unitAt(state, 1) as CardInstance;
    expect(copy.damage).toBe(0);
    expect(copy.exertion).toEqual({ attacked: false, switched: false });
    expect(copy.counters).toEqual({});
    expect(copy.memory).toEqual({});
    // §4.1: a new body enters in Attack Position and is summoning sick for this turn.
    expect(copy.position).toBe("ATK");
    expect(copy.summonedTurn).toBe(state.turn);
    // The source is untouched by its own copy.
    expect(source.damage).toBe(4);
    expect(source.counters).toEqual({ plague: 2, grade: 1 });
  });

  it("§8.3 #61 vanilla: true and grantedKeywords: false keep the buffs and the radiant flag", () => {
    const state = game("copy-postdoc");
    const source = put(state, body.id, slot("p1", "units", 2), { radiant: true });
    source.buffs = { attack: 1, health: 1 };
    source.grantedKeywords = [{ kind: "Taunt" }];
    source.damage = 2;

    run(state, summonCopy({ of: { of: "chosen" }, vanilla: true, grantedKeywords: false }), {
      targets: [{ pick: "instance", instanceId: source.id }],
    });

    const copy = unitAt(state, 1) as CardInstance;
    expect(copy.vanilla).toBe(true);
    expect(copy.grantedKeywords).toEqual([]);
    expect(copy.buffs).toEqual({ attack: 1, health: 1 });
    expect(copy.radiant).toBe(true);
    expect(copy.damage).toBe(0);
    // The source keeps its own text and its own keyword: only the copy is textless (R23).
    expect(source.vanilla).toBe(false);
    expect(source.grantedKeywords.map((keyword) => keyword.kind)).toEqual(["Taunt"]);
  });

  it("§6.2 the copy fires no Cry, where the source's own Cry is observable", () => {
    const state = game("copy-no-cry");
    const source = put(state, crier.id, slot("p1", "units", 1));
    const before = state.players.p2.hero.health;

    const events = run(state, summonCopy({ of: { of: "self" }, player: "self" }), { self: source });

    expect(unitAt(state, 2)?.defId).toBe(crier.id);
    expect(eventsOfType(events, "damage")).toEqual([]);
    expect(state.players.p2.hero.health).toBe(before);

    // The fixture's Cry really does ping the enemy hero, so the assertion above means something.
    const sink = sinkFor(state);
    runHook(sink, source, "cry", { controller: "p1" });
    expect(eventsOfType(sink.events, "damage")).toHaveLength(1);
    expect(state.players.p2.hero.health).toBe(before - 3);
  });

  it("R64 fizzles silently with a full row, creating nothing", () => {
    const state = game("copy-full");
    const source = put(state, body.id, slot("p1", "units", 1));
    for (const lane of [2, 3, 4, 5]) put(state, body.id, slot("p1", "units", lane));
    const idsBefore = state.nextId;

    const events = run(state, summonCopy({ of: { of: "instance", instanceId: source.id } }));

    expect(eventsOfType(events, "summoned")).toEqual([]);
    expect(state.nextId).toBe(idsBefore);
  });

  it("§6.3 fizzles silently when the target resolves to nothing", () => {
    const state = game("copy-no-target");
    const idsBefore = state.nextId;

    // No selection carried, so `{ of: "chosen" }` names nothing; `{ of: "self" }` with no self too.
    const events = [
      ...run(state, summonCopy({ of: { of: "chosen" } })),
      ...run(state, summonCopy({ of: { of: "self" } })),
      ...run(state, summonCopy({ of: { of: "selfHero" } })),
    ];

    expect(events).toEqual([]);
    expect(state.nextId).toBe(idsBefore);
    expect(unitAt(state, 1)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// summonRandom — §5.1, §10.7, R60, #67 Zoomerbin Oomen
// ---------------------------------------------------------------------------

describe("summonRandom (§5.1, §10.7, R60, #67)", () => {
  const pool = { defId: [poolA.id, poolB.id] };

  it("§10.7 draws one def from the query pool and summons it per R64", () => {
    const picks = Array.from({ length: 12 }, (_unused, seed) => {
      const state = game(`random-pool-${seed}`);
      const events = run(state, summonRandom({ query: pool }));
      expect(eventsOfType(events, "summoned")).toHaveLength(1);
      return unitAt(state, 1)?.defId ?? null;
    });

    for (const pick of picks) expect([poolA.id, poolB.id]).toContain(pick);
    // A draw, not the first entry of the pool: both members come up across the seeds.
    expect(new Set(picks).size).toBe(2);
  });

  it("§5.1 never summons the requesting card's own definition", () => {
    for (let seed = 0; seed < 12; seed += 1) {
      const state = game(`random-exclude-${seed}`);
      const self = put(state, poolA.id, slot("p1", "units", 5));

      run(state, summonRandom({ query: pool }), { self });

      expect(unitAt(state, 1)?.defId).toBe(poolB.id);
    }
  });

  it("R33 summons a Trap into the named backrow lane, face-down", () => {
    const state = game("random-trap");

    const events = run(state, summonRandom({ query: { defId: [poolTrap.id] }, lane: 2 }));

    expect(eventsOfType(events, "summoned").map((event) => [event.row, event.lane])).toEqual([
      ["backrow", 2],
    ]);
    const trap = cardAt(state, slot("p1", "backrow", 2));
    expect(trap?.defId).toBe(poolTrap.id);
    expect(trap?.faceUp).toBeUndefined();
  });

  it("R47 fizzles on an occupied or a Locked backrow lane", () => {
    const occupied = game("random-occupied");
    put(occupied, poolTrap.id, slot("p1", "backrow", 2));
    const before = occupied.nextId;
    expect(run(occupied, summonRandom({ query: { defId: [poolTrap.id] }, lane: 2 }))).toEqual([]);
    expect(occupied.nextId).toBe(before);

    const locked = game("random-locked");
    lockZone(locked, slot("p1", "backrow", 2));
    expect(run(locked, summonRandom({ query: { defId: [poolTrap.id] }, lane: 2 }))).toEqual([]);
    expect(cardAt(locked, slot("p1", "backrow", 2))).toBeNull();
  });

  it("§9.3 takes its rng draw inside apply, and the same cursor gives the same pick", () => {
    const state = game("random-cursor");
    const sink = sinkFor(state);

    // Building the effect touches no rng at all: a draw here would escape the reducer.
    const effect = summonRandom({ query: pool });
    expect(sink.rng.cursor).toBe(state.rngCursor);

    effect.apply(makeContext(sink, null, { controller: "p1" }));
    expect(sink.rng.cursor).toBeGreaterThan(state.rngCursor);

    // Two contexts built at the same (seed, cursor) draw the same def (§9.3, R60).
    const first = game("random-same");
    const second = game("random-same");
    run(first, summonRandom({ query: pool }));
    run(second, summonRandom({ query: pool }));
    expect(unitAt(second, 1)?.defId).toBe(unitAt(first, 1)?.defId);
  });

  it("§5.1 fizzles silently when the pool is empty, taking no draw", () => {
    const state = game("random-empty");
    const cursorBefore = state.rngCursor;

    const events = run(state, summonRandom({ query: { defId: ["cp-does-not-exist"] } }));

    expect(events).toEqual([]);
    expect(state.rngCursor).toBe(cursorBefore);
  });
});
