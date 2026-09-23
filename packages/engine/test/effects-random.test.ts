// The rng verbs and the two subsystem wrappers
// (SPEC §6.1 Lucky X, §6.3 Fuse/Rotate/Make Radiant, §3.1's rotation-topology ruling, §10.4, §10.7;
// R14, R32, R60, R77, R88, R102; BUILD M3-T1).
//
// Four verbs share this file because they share one question: does the verb delegate, and does it
// take exactly the draws it is supposed to?
//
//   * `flipCoins` (#4 Gary the Gambler) and `radiantChance` (#42 Eugenics) own randomness, so every
//     test here counts DRAWS as well as outcomes. §10.7 stores `rngCursor` in state, which makes
//     the cursor part of the match: a verb that took a draw only sometimes would make every later
//     draw in the game depend on the board at that moment, and §9.3's exact replay would be gone.
//     So "how many draws" is a rule, not an implementation detail, and it is asserted directly.
//   * `fuseCards` (#99 Craft a Card, #85 Unlicensed Experimentation) and `rotate` (#52 Silly Silas)
//     own nothing: R77 and R14 live in `subsystems/fuse.ts` and `subsystems/rotation.ts`, which
//     have their own test files. The tests here prove the wrapper reaches them — each one leans on
//     a rule ONLY the subsystem implements (the capped fused cost, the Locked-destination bounce),
//     so a wrapper that reimplemented the walk would fail them.
//
// The golden numbers are the coin and chance sequences of the named seeds at cursor 0. None of
// these tests call `beginGame`, so nothing has drawn before them and the cursor really is 0 (the
// same convention as `effects-radiant.test.ts`).

import type { CardDef, GameEvent } from "@jackioh/shared";
import { describe, expect, it } from "vitest";
import { registerCatalog, registeredCatalog } from "../src/catalog";
import { FUSE_COST_CAP } from "../src/config";
import { flipCoins } from "../src/effects/coins";
import { exile } from "../src/effects/move";
import { fuseCards } from "../src/effects/fuse";
import { radiantChance } from "../src/effects/radiant";
import { rotate } from "../src/effects/rotate";
import { unitView } from "../src/layers";
import { effectiveCost } from "../src/mana";
import { applyEffects, makeContext, type EngineSink } from "../src/resolve";
import type { Effect } from "../src/script";
import { findInstance, type CardInstance, type GameState } from "../src/state";
import { cardAt, lockZone } from "../src/zones";
import { eventsOfType, newGame, put, setLibrary, sinkFor, slot } from "./fixtures/harness";

// ---------------------------------------------------------------------------
// Fixture cards. Indices start above 1600 so they never collide with another test file's locals.
// ---------------------------------------------------------------------------

let nextIndex = 1600;
function unitDefOf(name: string, overrides: Partial<CardDef> = {}): CardDef {
  nextIndex += 1;
  return {
    id: `rn-${name}`,
    index: String(nextIndex),
    name: `${name} (random)`,
    set: "Core",
    type: "Unit",
    tags: [],
    rarity: "Common",
    token: false,
    cost: 1,
    base: { attack: 1, health: 1, keywords: [], text: name },
    radiant: { attack: 2, health: 2, keywords: [], text: `${name} radiant` },
    ...overrides,
  };
}

/** #4 Gary himself: a 1/1 whose radiant face is 2/2, so a coin buff is readable on top of it. */
const gary = unitDefOf("gary");
/** Plain bodies for the library pool and the rotation ring. */
const body = unitDefOf("body");

/** #99's two Discover picks: distinct costs, stats, keywords and tags, so every R77 sum shows. */
const alpha = unitDefOf("alpha", {
  cost: 3,
  tags: ["Human"],
  rarity: "Rare",
  base: { attack: 2, health: 3, keywords: [{ kind: "Taunt" }], text: "alpha" },
  radiant: { attack: 4, health: 6, keywords: [{ kind: "Taunt" }], text: "alpha radiant" },
});
const beta = unitDefOf("beta", {
  cost: 2,
  tags: ["Felinor"],
  base: { attack: 1, health: 1, keywords: [{ kind: "Rush" }], text: "beta" },
  radiant: { attack: 2, health: 2, keywords: [{ kind: "Rush" }], text: "beta radiant" },
});

const RN_DEFS: CardDef[] = [gary, body, alpha, beta];

function game(seed: string): GameState {
  const state = newGame(seed);
  registerCatalog({ ...registeredCatalog(), ...Object.fromEntries(RN_DEFS.map((d) => [d.id, d])) });
  state.turn = 3;
  state.active = "p1";
  return state;
}

/**
 * Apply effects the way `resolve.ts` does and hand back the sink, so a test can read both the
 * events and the rng cursor the run left behind.
 */
function run(
  state: GameState,
  effects: readonly Effect[],
  options: { self?: CardInstance | null; controller?: "p1" | "p2"; radiant?: boolean } = {},
): EngineSink {
  const { self = null, radiant, ...rest } = options;
  const sink = sinkFor(state);
  const ctx = makeContext(sink, self, rest);
  applyEffects(effects, radiant === undefined ? ctx : { ...ctx, radiant });
  state.rngCursor = sink.rng.cursor;
  return sink;
}

/** Draws taken by one run, which is the only honest way to say "this verb rolled N times". */
function draws(sink: EngineSink): number {
  return sink.rng.cursor;
}

// ---------------------------------------------------------------------------
// flipCoins (#4 Gary the Gambler)
// ---------------------------------------------------------------------------

describe("flipCoins (§8.1 #4, §10.4 layer 4, §10.7, R32)", () => {
  it("§8.1 takes exactly `coins` draws and buffs +1 attack per heads, +1 max health per tails", () => {
    const state = game("coins-known");
    const unit = put(state, gary.id, slot("p1", "units", 1));
    expect(unitView(state, unit)).toMatchObject({ attack: 1, maxHealth: 1 });

    const sink = run(
      state,
      [flipCoins({ target: { of: "self" }, coins: 5, perHeads: { attack: 1 }, perTails: { health: 1 } })],
      { self: unit },
    );

    // Five flips, no more and no fewer: the cursor is state, so this is a rule (§10.7).
    expect(draws(sink)).toBe(5);
    // "coins-known" at cursor 0 flips T H H H H: four heads, one tail.
    expect(unit.buffs).toEqual({ attack: 4, health: 1 });
    // Heads and tails always account for every flip.
    expect(unit.buffs.attack + unit.buffs.health).toBe(5);
    // §10.4: the buff is layer 4, so the totals are computed on read, on top of the printed 1/1.
    expect(unitView(state, unit)).toMatchObject({ attack: 5, maxHealth: 2 });
    // One `buffed` event carrying the whole result (§10.10 animates it).
    expect(eventsOfType(sink.events, "buffed")).toEqual([
      { type: "buffed", instanceId: unit.id, attack: 4, health: 1 },
    ]);
  });

  it("§8.1 the radiant face is the same flip at 7 coins and 2 a side", () => {
    const state = game("coins-known");
    const unit = put(state, gary.id, slot("p1", "units", 1), { radiant: true });

    const sink = run(
      state,
      [flipCoins({ target: { of: "self" }, coins: 7, perHeads: { attack: 2 }, perTails: { health: 2 } })],
      { self: unit },
    );

    // "coins-known" at cursor 0 flips T H H H H H T: five heads, two tails.
    expect(draws(sink)).toBe(7);
    expect(unit.buffs).toEqual({ attack: 10, health: 4 });
    // On the 2/2 radiant face (§5.2), read through the layers.
    expect(unitView(state, unit)).toMatchObject({ attack: 12, maxHealth: 6 });
  });

  it("§10.7 takes NO draws at all when the target is missing, so the cursor is untouched", () => {
    const state = game("coins-known");
    expect(state.rngCursor).toBe(0);

    // `{ of: "self" }` with no self, and `{ of: "chosen" }` with nothing chosen: both fizzle.
    const noSelf = run(
      state,
      [flipCoins({ target: { of: "self" }, coins: 5, perHeads: { attack: 1 } })],
      { self: null, controller: "p1" },
    );
    expect(draws(noSelf)).toBe(0);
    expect(noSelf.events).toEqual([]);

    const noPick = run(
      state,
      [flipCoins({ target: { of: "chosen" }, coins: 7, perTails: { health: 2 } })],
      { controller: "p1" },
    );
    expect(draws(noPick)).toBe(0);
    expect(state.rngCursor).toBe(0);

    // And a fizzle really is total: a unit that arrives afterwards gets the draws that were saved.
    const unit = put(state, gary.id, slot("p1", "units", 1));
    run(state, [flipCoins({ target: { of: "self" }, coins: 5, perHeads: { attack: 1 }, perTails: { health: 1 } })], {
      self: unit,
    });
    expect(unit.buffs).toEqual({ attack: 4, health: 1 });
  });

  it("§9.3 the same seed and cursor give the same flips twice, and another seed does not", () => {
    const flips = (seed: string, cursor = 0): { attack: number; health: number } => {
      const state = game(seed);
      state.rngCursor = cursor;
      const unit = put(state, gary.id, slot("p1", "units", 1));
      run(state, [flipCoins({ target: { of: "self" }, coins: 5, perHeads: { attack: 1 }, perTails: { health: 1 } })], {
        self: unit,
      });
      return unit.buffs;
    };

    expect(flips("coins-a")).toEqual(flips("coins-a"));
    expect(flips("coins-a")).not.toEqual(flips("coins-b"));
    // The cursor is the other half of the pair: the same seed further along reads other draws.
    // ("coins-a" flips H H T T T from cursor 0 and T H H T H from cursor 5.)
    expect(flips("coins-a", 0)).toEqual({ attack: 2, health: 3 });
    expect(flips("coins-a", 5)).toEqual({ attack: 3, health: 2 });
  });

  it("§6.3 a card that pays nothing for a side of the coin still flips it", () => {
    const state = game("coins-a");
    const unit = put(state, gary.id, slot("p1", "units", 1));

    // Heads only: "coins-a" flips H H T T T, so two heads and three ignored tails.
    const sink = run(state, [flipCoins({ target: { of: "self" }, coins: 5, perHeads: { attack: 1 } })], {
      self: unit,
    });

    expect(draws(sink)).toBe(5);
    expect(unit.buffs).toEqual({ attack: 2, health: 0 });
  });
});

// ---------------------------------------------------------------------------
// radiantChance (#42 Eugenics)
// ---------------------------------------------------------------------------

/** The library cards that came out Radiant, by index in the library as it was set up. */
function radiantAt(cards: readonly CardInstance[]): number[] {
  return cards.flatMap((card, at) => (card.radiant ? [at] : []));
}

describe("radiantChance (§8.2 #42, §6.1 Lucky X, §10.7, R32, R60)", () => {
  it("§8.2 rolls once per non-Radiant library card and flags the ones that hit", () => {
    const state = game("eug-b");
    const library = setLibrary(state, "p1", Array.from({ length: 6 }, () => body.id));

    const sink = run(state, [radiantChance({ zone: "library", chance: 0.3 })], { controller: "p1" });

    // One independent roll per card in the pool: six cards, six draws (§10.7).
    expect(draws(sink)).toBe(6);
    // "eug-b" at cursor 0 puts three of its first six draws under 0.3, at library indices 1, 3, 4.
    expect(radiantAt(library)).toEqual([1, 3, 4]);
    expect(eventsOfType(sink.events, "radiantSet").map((e) => e.instanceId)).toEqual(
      [1, 3, 4].map((at) => library[at]?.id),
    );
  });

  it("R60 never re-rolls a card that is already Radiant, so the draw count is the non-Radiant count", () => {
    const state = game("eug-b");
    const library = setLibrary(state, "p1", Array.from({ length: 6 }, () => body.id));
    // Flag two of them up front; nothing may unset the flag, so they are out of the pool (§6.3).
    const alreadyRadiant = [0, 2];
    for (const at of alreadyRadiant) {
      const card = library[at];
      if (card !== undefined) card.radiant = true;
    }

    const sink = run(state, [radiantChance({ zone: "library", chance: 1 })], { controller: "p1" });

    // Four rolls for the four non-Radiant cards, not six.
    expect(draws(sink)).toBe(4);
    // At chance 1 every rolled card hits, so all six are Radiant — but only four events fired.
    expect(library.every((card) => card.radiant)).toBe(true);
    expect(eventsOfType(sink.events, "radiantSet")).toHaveLength(4);
    expect(
      eventsOfType(sink.events, "radiantSet").every(
        (event) => !alreadyRadiant.some((at) => library[at]?.id === event.instanceId),
      ),
    ).toBe(true);
  });

  it("§6.1 Lucky 1 takes two rolls a card and keeps the success, so #42's radiant face flags more", () => {
    const plain = (): { sink: EngineSink; library: CardInstance[] } => {
      const state = game("eug-b");
      const library = setLibrary(state, "p1", Array.from({ length: 6 }, () => body.id));
      return { sink: run(state, [radiantChance({ zone: "library", chance: 0.3 })], { controller: "p1" }), library };
    };
    const lucky = (): { sink: EngineSink; library: CardInstance[] } => {
      const state = game("eug-b");
      const library = setLibrary(state, "p1", Array.from({ length: 6 }, () => body.id));
      return {
        sink: run(state, [radiantChance({ zone: "library", chance: 0.4, lucky: 1 })], { controller: "p1" }),
        library,
      };
    };

    const base = plain();
    const face = lucky();

    // The draw count is the hard property: (lucky + 1) rolls per card, so twice as many.
    expect(draws(base.sink)).toBe(6);
    expect(draws(face.sink)).toBe(12);

    // On this seed #42's radiant face ("Lucky 1 at 40%") really does flag strictly more than its
    // base face ("30%"): 5 cards against 3. That is a per-seed fact, not a theorem — the two faces
    // read different draws off the same stream, so no seed-independent ordering exists to assert.
    expect(radiantAt(base.library)).toEqual([1, 3, 4]);
    expect(radiantAt(face.library)).toEqual([0, 1, 2, 3, 4]);
    expect(radiantAt(face.library).length).toBeGreaterThan(radiantAt(base.library).length);
  });

  it("§6.1 Lucky takes its extra rolls but never invents a success", () => {
    const state = game("eug-c");
    const library = setLibrary(state, "p1", Array.from({ length: 4 }, () => body.id));

    // Nothing can hit at chance 0, however many rolls are kept — and the rolls still happen.
    const sink = run(state, [radiantChance({ zone: "library", chance: 0, lucky: 10 })], {
      controller: "p1",
    });

    expect(draws(sink)).toBe(4 * 11);
    expect(library.some((card) => card.radiant)).toBe(false);
    expect(sink.events).toEqual([]);
  });

  it("§8.2 a card an earlier effect in the same list exiled is never rolled", () => {
    const state = game("eug-b");
    const library = setLibrary(state, "p1", Array.from({ length: 6 }, () => body.id));
    const doomed = library[2];
    if (doomed === undefined) throw new Error("expected a third library card");

    // #42's own order: the exile runs first and the chance rolls over what is LEFT. §4.5 and R59
    // put the state check after the whole list, never between two of its effects.
    const sink = run(
      state,
      [
        exile({ target: { of: "instance", instanceId: doomed.id } }),
        radiantChance({ zone: "library", chance: 1 }),
      ],
      { controller: "p1" },
    );

    expect(doomed.zone).toEqual({ z: "exile", player: "p1" });
    // Five cards left, so five rolls: the exiled card cost the pool a draw as well as a flag.
    expect(draws(sink)).toBe(5);
    expect(doomed.radiant).toBe(false);
    expect(state.players.p1.library.every((card) => card.radiant)).toBe(true);
    expect(eventsOfType(sink.events, "radiantSet").map((e) => e.instanceId)).not.toContain(doomed.id);
  });

  it("§8.2 nothing is rolled and no draw is taken when the zone holds no non-Radiant card", () => {
    const state = game("eug-d");
    setLibrary(state, "p1", []);

    const sink = run(state, [radiantChance({ zone: "library", chance: 0.4, lucky: 1 })], {
      controller: "p1",
    });

    expect(draws(sink)).toBe(0);
    expect(sink.events).toEqual([]);
  });

  it("reads the player the effect names, so \"enemy\" rolls the opponent's library", () => {
    const state = game("eug-b");
    const mine = setLibrary(state, "p1", Array.from({ length: 3 }, () => body.id));
    const theirs = setLibrary(state, "p2", Array.from({ length: 3 }, () => body.id));

    run(state, [radiantChance({ zone: "library", chance: 1, player: "enemy" })], { controller: "p1" });

    expect(theirs.every((card) => card.radiant)).toBe(true);
    expect(mine.some((card) => card.radiant)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// fuseCards (#99 Craft a Card, #85 Unlicensed Experimentation)
// ---------------------------------------------------------------------------

/** The events a zone change makes; a phantom ingredient must produce none of them. */
const ZONE_EVENTS: GameEvent["type"][] = [
  "addedToHand",
  "enteredGraveyard",
  "exiled",
  "burned",
  "bounced",
  "summoned",
  "destroyed",
];

describe("fuseCards (§6.3 Fuse, §8.5 #99, §8.4 #85, R77, R102)", () => {
  it("R77 #85 radiant fuses one ingredient onto EVERY target, one fusion at a time", () => {
    const state = game("fuse-each");
    // #85's played permanent, plus two of the controller's matching permanents.
    const played = put(state, alpha.id, slot("p1", "units", 1));
    const first = put(state, beta.id, slot("p1", "units", 2));
    const second = put(state, beta.id, slot("p1", "units", 3));

    run(
      state,
      [fuseCards({ instanceIds: [played.id], targetInstanceIds: [first.id, second.id] })],
      { controller: "p1" },
    );

    // R77: each target is its own fusion with its own transient definition. The second fusion is
    // the whole point — the played card ceased to exist in the first one, and an ingredient only
    // ever contributes its DEFINITION, so it still fuses. Re-resolving it by id would have found
    // nothing, dropped below FUSE_MIN_INGREDIENTS and silently changed nothing.
    expect(Object.keys(state.transientDefs).sort()).toEqual(["t-1:rn-alpha+rn-beta", "t-2:rn-alpha+rn-beta"]);

    // Both targets survived as the fused cards, in their own lanes (R77 keeps the instance).
    const keptFirst = cardAt(state, slot("p1", "units", 2));
    const keptSecond = cardAt(state, slot("p1", "units", 3));
    expect(keptFirst?.id).toBe(first.id);
    expect(keptSecond?.id).toBe(second.id);
    // Each kept card now IS a fused card, and the two fusions are distinct definitions.
    expect(keptFirst?.defId).not.toBe(beta.id);
    expect(keptSecond?.defId).not.toBe(beta.id);
    expect(keptFirst?.defId).not.toBe(keptSecond?.defId);

    // Both fusions summed alpha onto beta, so both read the same R77 total (2+1 / 3+1).
    for (const kept of [keptFirst, keptSecond]) {
      if (kept == null) throw new Error("expected a kept instance");
      const view = unitView(state, kept);
      expect(view.attack).toBe(3);
      expect(view.maxHealth).toBe(4);
    }

    // The played permanent is gone exactly once, with no death (R77).
    expect(findInstance(state, played.id)).toBeUndefined();
    expect(eventsOfType(run(state, [], { controller: "p1" }).events, "destroyed")).toEqual([]);
  });

  it("§8.4 #85 base picks ONE target at random, taking exactly one draw inside apply", () => {
    const state = game("fuse-random");
    const played = put(state, alpha.id, slot("p1", "units", 1));
    const first = put(state, beta.id, slot("p1", "units", 2));
    const second = put(state, beta.id, slot("p1", "units", 3));

    // Building the effect must take no draw: the pick belongs inside apply (§9.3, §10.7).
    const effect = fuseCards({
      instanceIds: [played.id],
      targetInstanceIds: [first.id, second.id],
      pick: "random",
    });
    expect(state.rngCursor).toBe(0);

    const sink = run(state, [effect], { controller: "p1" });

    expect(draws(sink)).toBe(1);
    // Exactly ONE fusion happened, so exactly one target was consumed into a fused card.
    expect(Object.keys(state.transientDefs)).toEqual(["t-1:rn-alpha+rn-beta"]);
    const fusedCount = [first, second].filter((card) => card.defId !== beta.id).length;
    expect(fusedCount).toBe(1);
  });

  it("§6.3 takes no draw and fuses nothing when every named target has left the field", () => {
    const state = game("fuse-none");
    const played = put(state, alpha.id, slot("p1", "units", 1));
    const victim = put(state, beta.id, slot("p1", "units", 2));
    const goneId = victim.id;
    // The target leaves before the fusion resolves (R61: the trap fired and did nothing).
    state.players.p1.units[1] = null;
    victim.zone = { z: "gone", player: "p1" };

    const sink = run(
      state,
      [fuseCards({ instanceIds: [played.id], targetInstanceIds: [goneId], pick: "random" })],
      { controller: "p1" },
    );

    expect(draws(sink)).toBe(0);
    expect(state.transientDefs).toEqual({});
    // The ingredient is untouched: nothing was consumed for a fusion that never happened.
    expect(findInstance(state, played.id)?.defId).toBe(alpha.id);
  });

  it("R77 #99 crafts the fused definition from two defIds and lands it in the named hand at cost 0", () => {
    const state = game("fuse-craft");

    const sink = run(state, [fuseCards({ defIds: [alpha.id, beta.id], toHand: "self" })], {
      controller: "p1",
    });

    // The transient definition is the subsystem's, in match state where `defOf` finds it (§10.1).
    const ids = Object.keys(state.transientDefs);
    expect(ids).toEqual(["t-1:rn-alpha+rn-beta"]);
    const fused = state.transientDefs["t-1:rn-alpha+rn-beta"];
    if (fused === undefined) throw new Error("expected a transient def");

    // R77's sums, on BOTH faces, so Make Radiant still works on the result (§5.2).
    expect(fused.base).toMatchObject({ attack: 3, health: 4 });
    expect(fused.radiant).toMatchObject({ attack: 6, health: 8 });
    expect(fused.base.keywords.map((k) => k.kind).sort()).toEqual(["Rush", "Taunt"]);
    expect(fused.tags.sort()).toEqual(["Felinor", "Human"]);
    // R77's cap: 3 + 2 is 5, which is more than FUSE_COST_CAP, so the definition costs 4.
    expect(fused.cost).toBe(FUSE_COST_CAP);

    // "the result costs 0 and goes to your hand": a fresh, non-Radiant instance with an override,
    // so the printed 4 stands on the definition and R65 reads 0 off the card.
    expect(state.players.p1.hand).toHaveLength(1);
    const result = state.players.p1.hand[0];
    if (result === undefined) throw new Error("expected the crafted card in hand");
    expect(result.defId).toBe("t-1:rn-alpha+rn-beta");
    expect(result.radiant).toBe(false);
    expect(result.costOverride).toBe(0);
    expect(effectiveCost(state, result)).toBe(0);
    expect(state.players.p2.hand).toEqual([]);

    // One `fused` event, naming the ingredients and the result, and nothing else the wrapper made.
    expect(eventsOfType(sink.events, "fused")).toEqual([
      {
        type: "fused",
        instanceIds: expect.any(Array) as string[],
        resultInstanceId: result.id,
        defId: "t-1:rn-alpha+rn-beta",
      },
    ]);
  });

  it("R86 #99's defId ingredients sit in no pile, so no zone event fires and nothing can reach them", () => {
    const state = game("fuse-phantom");

    const sink = run(state, [fuseCards({ defIds: [alpha.id, beta.id], toHand: "self" })], {
      controller: "p1",
    });

    const fusedEvent = eventsOfType(sink.events, "fused")[0];
    if (fusedEvent === undefined) throw new Error("expected a fused event");
    const result = state.players.p1.hand[0];
    const phantoms = fusedEvent.instanceIds.filter((id) => id !== result?.id);
    expect(phantoms).toHaveLength(2);

    // `{ z: "gone" }` is in no pile, so `findInstance` cannot reach one (R11, R86).
    for (const id of phantoms) expect(findInstance(state, id)).toBeUndefined();

    // And no zone event names one: the only card that entered a zone is the crafted result.
    const zoneEvents = sink.events.filter((event) => ZONE_EVENTS.includes(event.type));
    expect(eventsOfType(zoneEvents, "addedToHand").map((e) => e.instanceId)).toEqual([result?.id]);
    for (const event of zoneEvents) {
      const named: unknown = (event as { instanceId?: unknown }).instanceId;
      expect(phantoms).not.toContain(named);
    }
  });

  it("R77 #85 keeps the target's instance when the ingredients are cards on the field", () => {
    const state = game("fuse-onto");
    const victim = put(state, alpha.id, slot("p1", "units", 1));
    const played = put(state, beta.id, slot("p1", "units", 2));
    victim.damage = 1;

    run(
      state,
      [fuseCards({ instanceIds: [played.id], targetInstanceId: victim.id })],
      { controller: "p1" },
    );

    // R77: the fused card IS the target, in its own zone, with its damage intact.
    expect(victim.defId).toBe("t-1:rn-beta+rn-alpha");
    expect(victim.zone).toEqual({ z: "field", player: "p1", row: "units", lane: 1 });
    expect(victim.damage).toBe(1);
    expect(unitView(state, victim)).toMatchObject({ attack: 3, maxHealth: 4, health: 3 });
    // The other ingredient ceased to exist: no graveyard, no death, no pile.
    expect(cardAt(state, slot("p1", "units", 2))).toBeNull();
    expect(findInstance(state, played.id)).toBeUndefined();
    expect(state.players.p1.graveyard).toEqual([]);
  });

  it("§6.3 fizzles and changes nothing when the subsystem refuses the fusion", () => {
    const state = game("fuse-fizzle");

    // R77: "Fewer is not a fusion", and a call with no target and no hand has nowhere to put one.
    const tooFew = run(state, [fuseCards({ defIds: [alpha.id], toHand: "self" })], { controller: "p1" });
    const nowhere = run(state, [fuseCards({ defIds: [alpha.id, beta.id] })], { controller: "p1" });

    expect(state.transientDefs).toEqual({});
    expect(state.players.p1.hand).toEqual([]);
    expect(eventsOfType(tooFew.events, "fused")).toEqual([]);
    expect(eventsOfType(nowhere.events, "fused")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// rotate (#52 Silly Silas)
// ---------------------------------------------------------------------------

/** Where a card sits now, as "p2 units 5", for readable assertions. */
function whereIs(state: GameState, card: CardInstance): string {
  const zone = findInstance(state, card.id)?.zone;
  if (zone === undefined) return "gone";
  return zone.z === "field" ? `${zone.player} ${zone.row} ${zone.lane}` : zone.z;
}

describe("rotate (§6.3 Rotate, §3.1's rotation topology, §8.3 #52, R14, R88)", () => {
  it("§3.1 moves every card one step around its ring, control changing on the crossing", () => {
    const state = game("rotate-verb");
    const lane1 = put(state, body.id, slot("p1", "units", 1));
    const lane5 = put(state, body.id, slot("p1", "units", 5));
    const trap = put(state, body.id, slot("p1", "backrow", 5));

    const sink = run(state, [rotate({ direction: "right" })], { controller: "p1" });

    // The ring is the controller's lanes 1→5, then the opponent's 5→1, and back (§3.1).
    expect(whereIs(state, lane1)).toBe("p1 units 2");
    expect(whereIs(state, lane5)).toBe("p2 units 5");
    expect(lane1.controller).toBe("p1");
    expect(lane5.controller).toBe("p2");
    // R14: both rings turn together, so the backrow moved too.
    expect(whereIs(state, trap)).toBe("p2 backrow 5");

    expect(eventsOfType(sink.events, "rotated")).toEqual([{ type: "rotated", direction: "right" }]);
    expect(eventsOfType(sink.events, "controlChanged").map((e) => e.instanceId).sort()).toEqual(
      [lane5.id, trap.id].sort(),
    );
  });

  it("§3.1 reads left and right from the rotating player's seat, which is the controller", () => {
    const state = game("rotate-seat");
    const mine = put(state, body.id, slot("p1", "units", 1));

    // p1 rotating right sends lane 1 to lane 2; p2 rotating right sends p1's lane 1 the other way,
    // because the ring is written from the rotating player's seat.
    run(state, [rotate({ direction: "right" })], { controller: "p1" });
    expect(whereIs(state, mine)).toBe("p1 units 2");

    run(state, [rotate({ direction: "right" })], { controller: "p2" });
    expect(whereIs(state, mine)).toBe("p1 units 1");
  });

  it("R14/R88 delegates the Locked-destination bounce rather than walking the ring itself", () => {
    const state = game("rotate-locked");
    const blocked = put(state, body.id, slot("p1", "units", 1));
    lockZone(state, slot("p1", "units", 2));

    const sink = run(state, [rotate({ direction: "right" })], { controller: "p1" });

    // A rule only `subsystems/rotation.ts` implements: the card goes to its OWNER's hand (R12).
    expect(whereIs(state, blocked)).toBe("hand");
    expect(state.players.p1.hand.map((card) => card.id)).toEqual([blocked.id]);
    expect(eventsOfType(sink.events, "bounced").map((e) => e.instanceId)).toEqual([blocked.id]);
  });

  it("§8.3 #52 picks the radiant bounce up from the running face, with nothing passed for it", () => {
    const state = game("rotate-radiant");
    const crosser = put(state, body.id, slot("p1", "units", 5));
    const stayer = put(state, body.id, slot("p1", "units", 1));

    // The card's two faces share one hook and pass only the direction, so the radiant behaviour
    // has to come from `ctx.radiant`.
    const sink = run(state, [rotate({ direction: "right" })], { controller: "p1", radiant: true });

    // "Cards that would move to the opponent are bounced to their owner's hand costing 0 instead."
    expect(whereIs(state, crosser)).toBe("hand");
    expect(crosser.costOverride).toBe(0);
    expect(crosser.controller).toBe("p1");
    expect(eventsOfType(sink.events, "controlChanged")).toEqual([]);
    // The card that stayed on this side still rotated.
    expect(whereIs(state, stayer)).toBe("p1 units 2");
  });
});
