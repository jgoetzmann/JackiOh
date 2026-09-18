// The library-and-hand family of §6.3: Add to hand (create OR move), the catalog add, the two
// library exiles, and Discover with the library as the pool.
// SPEC §6.3 (Add to hand, Exile, Discover, Cost), §2.4, §3.2, §5.1, §10.6, §10.7, §10.8;
// R4, R11, R50, R57, R60, R65, R78.
//
// The fixture defs these tests need are registered here, on top of the shared fixture catalog, so
// no shared fixture has to grow for them (CLAUDE.md, BUILD §0).

import type { CardDef, GameEvent, PlayerId } from "@jackioh/shared";
import { describe, expect, it } from "vitest";
import { registerCatalog, registeredCatalog } from "../src/catalog";
import { HAND_CAP } from "../src/config";
import { addRandomFromCatalog, addToHand } from "../src/effects/addToHand";
import { discoverFromCatalog, discoverFromLibrary } from "../src/effects/choose";
import { exileBottomOfLibrary, exileRandomFromLibrary } from "../src/effects/library";
import { effectiveCost } from "../src/mana";
import { makeContext, type EngineSink } from "../src/resolve";
import type { Effect } from "../src/script";
import { newInstance, type CardInstance, type GameState } from "../src/state";
import { moveToZone } from "../src/zones";
import { eventsOfType, inHand, newGame, setLibrary, sinkFor } from "./fixtures/harness";

// ---------------------------------------------------------------------------
// Fixture cards.
// ---------------------------------------------------------------------------

let nextIndex = 1800;

function makeDef(name: string, overrides: Partial<CardDef> = {}): CardDef {
  nextIndex += 1;
  return {
    id: `lib-${name}`,
    index: String(nextIndex),
    name: `${name} (library)`,
    set: "Core",
    type: "Unit",
    tags: [],
    rarity: "Common",
    token: false,
    cost: 1,
    base: { attack: 2, health: 2, keywords: [], text: name },
    radiant: { attack: 4, health: 4, keywords: [], text: `${name} radiant` },
    ...overrides,
  };
}

/** Three plain cards, so "which instance moved" is answerable by def as well as by id. */
const alpha = makeDef("alpha");
const beta = makeDef("beta");
const gamma = makeDef("gamma");

/** Printed cost 4, so R65's "start from the override in place of the printed cost" is visible. */
const pricey = makeDef("pricey", { cost: 4 });

/** The card whose script is running in the catalog-pool tests: §5.1 must never offer it back. */
const generator = makeDef("generator", { type: "Spell", base: { keywords: [], text: "generator" }, radiant: { keywords: [], text: "generator" } });

/** R11: a unit-token card can sit in a library (#75, and the copies of §3.2). */
const unitToken = makeDef("token", {
  id: "lib-token",
  name: "Fixture Library Token",
  rarity: "Token",
  token: true,
});

// A pool of its own set, so `query({ set: "Boss" })` is exactly these three and nothing the shared
// fixture catalog happens to contain. Making `ctx.self` one OF the pool is what makes §5.1's "a
// random pool never offers the card that generated it" observable rather than vacuous.
const poolA = makeDef("pool-a", { set: "Boss" });
const poolB = makeDef("pool-b", { set: "Boss" });
const poolC = makeDef("pool-c", { set: "Boss" });

/** A pool of exactly one card: three draws from it prove repeats are allowed (R60). */
const solo = makeDef("solo", { set: "Boss-X" });

// The filter fixtures for `discoverFromLibrary` (#51's type options and cost brackets).
function nonUnit(name: string, type: CardDef["type"], cost: CardDef["cost"]): CardDef {
  return makeDef(name, { type, cost, base: { keywords: [], text: name }, radiant: { keywords: [], text: name } });
}

const spellTwo = nonUnit("spell-2", "Spell", 2);
const spellFive = nonUnit("spell-5", "Spell", 5);
const spellX = nonUnit("spell-x", "Spell", "X");
const trapTwo = nonUnit("trap-2", "Trap", 2);
const fieldTrapTwo = nonUnit("field-trap-2", "Field Trap", 2);
const fieldSpellTwo = nonUnit("field-spell-2", "Field Spell", 2);

const DEFS: CardDef[] = [
  alpha,
  beta,
  gamma,
  pricey,
  generator,
  unitToken,
  poolA,
  poolB,
  poolC,
  solo,
  spellTwo,
  spellFive,
  spellX,
  trapTwo,
  fieldTrapTwo,
  fieldSpellTwo,
];

/** A fresh game whose catalog also carries this file's fixtures. */
function game(seed = "effects-library"): GameState {
  const state = newGame(seed);
  registerCatalog({ ...registeredCatalog(), ...Object.fromEntries(DEFS.map((def) => [def.id, def])) });
  state.turn = 3;
  return state;
}

/** An off-board instance to be `ctx.self`: a resolving Spell, which is what #51 and #57 are. */
function resolvingSelf(state: GameState, defId: string, player: PlayerId = "p1"): CardInstance {
  const card = newInstance(state, defId, player, { z: "resolving", player });
  state.players[player].resolving.push(card);
  return card;
}

function run(
  state: GameState,
  effects: Effect | Effect[],
  options: { controller?: PlayerId; self?: CardInstance } = {},
): GameEvent[] {
  const events: GameEvent[] = [];
  const sink: EngineSink = sinkFor(state, events);
  const ctx = makeContext(sink, options.self ?? null, options);
  for (const effect of Array.isArray(effects) ? effects : [effects]) effect.apply(ctx);
  return events;
}

function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`expected ${what}`);
  return value;
}

function handDefs(state: GameState, player: PlayerId): string[] {
  return state.players[player].hand.map((card) => card.defId);
}

function ids(cards: readonly CardInstance[]): string[] {
  return cards.map((card) => card.id);
}

// ---------------------------------------------------------------------------
// §6.3 Add to hand: "Creates OR MOVES the card"
// ---------------------------------------------------------------------------

describe("§6.3 Add to hand moves an existing card (#51, #72)", () => {
  it("§6.3 moves a library card and a graveyard card into the hand, leaving no copy behind", () => {
    const state = game("move-to-hand");
    const [fromLibrary] = setLibrary(state, "p1", [alpha.id, beta.id]);
    const library = must(fromLibrary, "the library card");

    const buried = must(inHand(state, gamma.id, "p1")[0], "the graveyard card");
    moveToZone(state, buried, "graveyard");

    // §10.6: a Discover's pick arrives in `ctx.targets`, which is what `{ of: "chosen" }` reads.
    const first = run(state, addToHand({ instance: { of: "chosen" } }), {
      controller: "p1",
      self: resolvingSelf(state, generator.id),
    });
    expect(state.players.p1.hand).toHaveLength(0);
    expect(eventsOfType(first, "addedToHand")).toHaveLength(0);

    const moved = run(
      state,
      [addToHand({ instance: { of: "instance", instanceId: library.id } }), addToHand({ instance: { of: "instance", instanceId: buried.id } })],
      { controller: "p1" },
    );

    // One instance each, in the hand and nowhere else: a move, not a copy.
    expect(ids(state.players.p1.hand)).toEqual([library.id, buried.id]);
    expect(ids(state.players.p1.library)).toEqual([must(state.players.p1.library[0], "the untouched library card").id]);
    expect(state.players.p1.library).toHaveLength(1);
    expect(state.players.p1.graveyard).toHaveLength(0);
    expect(library.zone).toEqual({ z: "hand", player: "p1" });
    expect(buried.zone).toEqual({ z: "hand", player: "p1" });
    expect(eventsOfType(moved, "addedToHand").map((event) => event.instanceId)).toEqual([
      library.id,
      buried.id,
    ]);
  });

  it("§6.3 does nothing when the instance it names is already in a hand", () => {
    const state = game("already-in-hand");
    const held = must(inHand(state, alpha.id, "p1")[0], "the held card");

    const events = run(state, addToHand({ instance: { of: "instance", instanceId: held.id } }), {
      controller: "p1",
    });

    expect(ids(state.players.p1.hand)).toEqual([held.id]);
    expect(eventsOfType(events, "addedToHand")).toHaveLength(0);
    expect(eventsOfType(events, "burned")).toHaveLength(0);
  });

  it("R65 costMod adds to the instance's costMod while costOverride replaces the printed cost", () => {
    const state = game("cost-riders");
    const [libraryCard] = setLibrary(state, "p1", [pricey.id]);
    const carried = must(libraryCard, "the library card");
    // Something already discounted this card; the verb must stack with it, not clobber it.
    carried.costMod = -2;

    run(
      state,
      [
        addToHand({ instance: { of: "instance", instanceId: carried.id }, costMod: -1 }),
        addToHand({ defId: pricey.id, costMod: -1 }),
        addToHand({ defId: pricey.id, costOverride: 1 }),
      ],
      { controller: "p1" },
    );

    const [moved, modded, overridden] = state.players.p1.hand;
    const stacked = must(moved, "the moved card");
    expect(stacked.id).toBe(carried.id);
    expect(stacked.costMod).toBe(-3);
    expect(stacked.costOverride).toBeUndefined();
    expect(effectiveCost(state, stacked)).toBe(1); // printed 4, then -3.

    // A costMod starts from the printed cost; an override stands IN PLACE of it. Both exist because
    // only the first can stack with another discount.
    const discounted = must(modded, "the discounted card");
    expect(discounted.costMod).toBe(-1);
    expect(discounted.costOverride).toBeUndefined();
    expect(effectiveCost(state, discounted)).toBe(3);

    const priced = must(overridden, "the overridden card");
    expect(priced.costMod).toBe(0);
    expect(priced.costOverride).toBe(1);
    expect(effectiveCost(state, priced)).toBe(1);
  });

  it("§2.4 a moved card added to a full hand is burned instead (R4)", () => {
    const state = game("move-into-full-hand");
    const [libraryCard] = setLibrary(state, "p1", [alpha.id]);
    const card = must(libraryCard, "the library card");
    inHand(state, beta.id, "p1", HAND_CAP);

    const events = run(state, addToHand({ instance: { of: "instance", instanceId: card.id } }), {
      controller: "p1",
    });

    expect(state.players.p1.hand).toHaveLength(HAND_CAP);
    expect(state.players.p1.library).toHaveLength(0);
    expect(ids(state.players.p1.graveyard)).toEqual([card.id]);
    expect(eventsOfType(events, "burned").map((event) => event.instanceId)).toEqual([card.id]);
    expect(eventsOfType(events, "addedToHand")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// §5.1 / §10.7 the catalog add (#54, #57, #59)
// ---------------------------------------------------------------------------

describe("§6.3 addRandomFromCatalog (#54, #57, #59)", () => {
  it("§5.1 never offers the card that generated the pool", () => {
    const state = game("pool-excludes-self");

    // Four draws from a three-card pool minus the generator: only the other two can ever come up.
    run(state, addRandomFromCatalog({ query: { set: "Boss" }, count: 4 }), {
      controller: "p1",
      self: resolvingSelf(state, poolA.id),
    });
    expect(handDefs(state, "p1")).toHaveLength(4);
    expect(handDefs(state, "p1")).not.toContain(poolA.id);
    for (const defId of handDefs(state, "p1")) expect([poolB.id, poolC.id]).toContain(defId);

    // The exclusion follows `ctx.self`, not a constant: a different generator is the excluded one.
    const other = game("pool-excludes-self-b");
    run(other, addRandomFromCatalog({ query: { set: "Boss" }, count: 4 }), {
      controller: "p1",
      self: resolvingSelf(other, poolB.id),
    });
    expect(handDefs(other, "p1")).toHaveLength(4);
    expect(handDefs(other, "p1")).not.toContain(poolB.id);
  });

  it("R60 allows repeats, unlike Discover which draws without replacement", () => {
    const state = game("pool-repeats");
    const self = resolvingSelf(state, generator.id);

    // A one-card pool drawn three times gives three cards: with replacement, per #57's engine cell.
    run(state, addRandomFromCatalog({ query: { set: "Boss-X" }, count: 3 }), {
      controller: "p1",
      self,
    });
    expect(handDefs(state, "p1")).toEqual([solo.id, solo.id, solo.id]);

    // The same pool through §6.3's Discover row offers one option, not three: without replacement.
    const events = run(state, discoverFromCatalog({ step: "pick", query: { set: "Boss-X" }, count: 3 }), {
      controller: "p1",
      self,
    });
    expect(must(state.pending, "the discover prompt").options).toHaveLength(1);
    expect(eventsOfType(events, "promptOpened")).toHaveLength(1);
  });

  it("§6.3 carries the radiant flag and the cost riders onto every card it creates (#54, #59)", () => {
    const state = game("pool-riders");
    run(state, addRandomFromCatalog({ query: { set: "Boss-X" }, count: 2, radiant: true, costOverride: 0 }), {
      controller: "p1",
      self: resolvingSelf(state, generator.id),
    });

    expect(state.players.p1.hand).toHaveLength(2);
    for (const card of state.players.p1.hand) {
      expect(card.defId).toBe(solo.id);
      expect(card.radiant).toBe(true);
      expect(card.costOverride).toBe(0);
    }
  });

  it("§6.3 an empty pool fizzles and the card still resolves", () => {
    const state = game("pool-empty");
    const events = run(state, addRandomFromCatalog({ query: { set: "Classic" }, count: 3 }), {
      controller: "p1",
      self: resolvingSelf(state, generator.id),
    });
    expect(state.players.p1.hand).toHaveLength(0);
    expect(events).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// §6.3 Exile out of a library (#34, #40, #42, #65)
// ---------------------------------------------------------------------------

describe("§6.3 exileRandomFromLibrary (#34, #42)", () => {
  it("R60 exiles exactly count DISTINCT library cards", () => {
    const state = game("exile-random");
    // `setLibrary` hands back the live pile, so the original ids are snapshotted before the move.
    const before = ids(setLibrary(state, "p1", [alpha.id, alpha.id, beta.id, beta.id, gamma.id]));

    const events = run(state, exileRandomFromLibrary({ count: 3 }), { controller: "p1" });

    const exiled = ids(state.players.p1.exile);
    expect(exiled).toHaveLength(3);
    expect(new Set(exiled).size).toBe(3);
    expect(state.players.p1.library).toHaveLength(2);
    // Nothing was exiled twice and nothing is in both piles.
    for (const id of ids(state.players.p1.library)) expect(exiled).not.toContain(id);
    for (const id of exiled) expect(before).toContain(id);
    expect(state.counters.exiled).toBe(3);
    expect(eventsOfType(events, "exiled").map((event) => event.instanceId).sort()).toEqual([...exiled].sort());
  });

  it("#34 exiles from the library the player argument names", () => {
    const state = game("exile-random-enemy");
    setLibrary(state, "p1", [alpha.id, beta.id]);
    setLibrary(state, "p2", [gamma.id, gamma.id]);

    run(state, exileRandomFromLibrary({ count: 1, player: "enemy" }), { controller: "p1" });

    expect(state.players.p1.exile).toHaveLength(0);
    expect(state.players.p1.library).toHaveLength(2);
    expect(state.players.p2.exile).toHaveLength(1);
    expect(state.players.p2.library).toHaveLength(1);
  });

  it("#42 fewer than count in the library exiles all of them", () => {
    const state = game("exile-random-short");
    setLibrary(state, "p1", [alpha.id, beta.id]);

    run(state, exileRandomFromLibrary({ count: 8 }), { controller: "p1" });

    expect(state.players.p1.library).toHaveLength(0);
    expect(state.players.p1.exile).toHaveLength(2);
    expect(state.counters.exiled).toBe(2);

    // An empty library fizzles rather than throwing, and the card still resolves (§6.3).
    const again = run(state, exileRandomFromLibrary({ count: 8 }), { controller: "p1" });
    expect(again).toEqual([]);
    expect(state.counters.exiled).toBe(2);
  });

  it("R11 a unit-token library card ceases to exist instead of reaching the exile pile", () => {
    const state = game("exile-random-token");
    const library = setLibrary(state, "p1", [unitToken.id, alpha.id, beta.id]);
    const token = must(library[0], "the token card");

    const events = run(state, exileRandomFromLibrary({ count: 3 }), { controller: "p1" });

    expect(state.players.p1.library).toHaveLength(0);
    // R11/R86: it is in no pile and its zone says so.
    expect(token.zone).toEqual({ z: "gone", player: "p1" });
    expect(ids(state.players.p1.exile)).not.toContain(token.id);
    expect(state.players.p1.exile).toHaveLength(2);
    // The counter counts only the cards that actually got there.
    expect(state.counters.exiled).toBe(2);
    // The event still reports every card leaving, so §10.10 can animate all three.
    expect(eventsOfType(events, "exiled")).toHaveLength(3);
  });
});

describe("§6.3 exileBottomOfLibrary (#40, #65)", () => {
  it("#40 takes the BOTTOM card of the library, not the top", () => {
    const state = game("exile-bottom");
    const library = setLibrary(state, "p1", [alpha.id, beta.id, gamma.id]);
    const [top, middle, bottom] = library;

    // `drawOne` takes library[0], so index 0 is the top and the last element is the bottom.
    const events = run(state, exileBottomOfLibrary({ player: "self" }), { controller: "p1" });
    expect(ids(state.players.p1.exile)).toEqual([must(bottom, "the bottom card").id]);
    expect(ids(state.players.p1.library)).toEqual([must(top, "the top card").id, must(middle, "the middle card").id]);
    expect(eventsOfType(events, "exiled").map((event) => event.instanceId)).toEqual([
      must(bottom, "the bottom card").id,
    ]);

    // Again: bottom-upward, so the new bottom goes next and the top is still untouched.
    run(state, exileBottomOfLibrary({ player: "self" }), { controller: "p1" });
    expect(ids(state.players.p1.exile)).toEqual([must(bottom, "the bottom card").id, must(middle, "the middle card").id]);
    expect(ids(state.players.p1.library)).toEqual([must(top, "the top card").id]);
    expect(state.counters.exiled).toBe(2);
  });

  it("#40 an empty library exiles nothing and causes NO fatigue", () => {
    const state = game("exile-bottom-empty");
    setLibrary(state, "p1", []);
    const before = state.players.p1.fatigueCount;
    const health = state.players.p1.hero.health;

    const events = run(state, exileBottomOfLibrary({ player: "self" }), { controller: "p1" });

    expect(events).toEqual([]);
    expect(state.players.p1.exile).toHaveLength(0);
    expect(state.counters.exiled).toBe(0);
    // Fatigue is the price of a DRAW from an empty library; this verb never reaches `draw.ts`.
    expect(state.players.p1.fatigueCount).toBe(before);
    expect(state.players.p1.hero.health).toBe(health);
    expect(eventsOfType(events, "damage")).toHaveLength(0);
  });

  it("R11 a unit-token card at the bottom ceases to exist rather than being exiled", () => {
    const state = game("exile-bottom-token");
    const library = setLibrary(state, "p1", [alpha.id, unitToken.id]);
    const token = must(library[1], "the token at the bottom");

    run(state, exileBottomOfLibrary({ player: "self" }), { controller: "p1" });

    expect(token.zone).toEqual({ z: "gone", player: "p1" });
    expect(state.players.p1.exile).toHaveLength(0);
    expect(state.counters.exiled).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// §6.3 Discover with the library as the pool (#51)
// ---------------------------------------------------------------------------

describe("§6.3 discoverFromLibrary (#51 KY's Private Tutor)", () => {
  /** #51's library: one match per bracket, plus the cards the filter must leave alone. */
  function tutorLibrary(state: GameState): CardInstance[] {
    return setLibrary(state, "p1", [
      spellTwo.id,
      spellFive.id,
      spellX.id,
      trapTwo.id,
      fieldTrapTwo.id,
      fieldSpellTwo.id,
      alpha.id,
    ]);
  }

  function offeredIds(state: GameState): string[] {
    return must(state.pending, "the discover prompt").options.map((option) => {
      const selection = option.selection;
      return selection.pick === "instance" ? selection.instanceId : selection.pick;
    });
  }

  it("§10.6 offers exactly the matching library instances and resumes at the step it was given", () => {
    const state = game("discover-library");
    const library = tutorLibrary(state);
    const self = resolvingSelf(state, generator.id);
    const before = ids(state.players.p1.library);

    const events = run(
      state,
      discoverFromLibrary({
        step: "take",
        count: 3,
        player: "self",
        filter: { type: ["Spell"], costRange: { min: 2, max: 2 } },
        prompt: "Reveal 3 cards from your library; choose one to add to your hand",
      }),
      { controller: "p1", self },
    );

    const pending = must(state.pending, "the discover prompt");
    expect(pending.kind).toBe("discover");
    expect(pending.playerId).toBe("p1");
    expect(pending.prompt).toBe("Reveal 3 cards from your library; choose one to add to your hand");
    // Only the cost-2 Spell matches: the cost-5 Spell is out of the bracket, the X Spell reads 0
    // (R65), and no Trap, Field Trap, Field Spell or Unit is a Spell.
    expect(offeredIds(state)).toEqual([must(library[0], "the cost-2 spell").id]);
    expect(pending.min).toBe(1);
    expect(pending.max).toBe(1);
    expect(pending.resume.step).toBe("take");
    expect(pending.resume.defId).toBe(generator.id);
    expect(pending.resume.instanceId).toBe(self.id);
    expect(eventsOfType(events, "promptOpened")).toHaveLength(1);
    // §10.8: revealing is the prompt, not a move — the library is untouched until the pick resolves.
    expect(ids(state.players.p1.library)).toEqual(before);
  });

  it("R65 the cost bracket reads an X-cost library card as 0 and honours an open-ended 4+", () => {
    const zeroBracket = game("discover-library-x");
    const library = tutorLibrary(zeroBracket);
    run(
      zeroBracket,
      discoverFromLibrary({ step: "take", filter: { type: "Spell", costRange: { min: 0, max: 1 } } }),
      { controller: "p1", self: resolvingSelf(zeroBracket, generator.id) },
    );
    expect(offeredIds(zeroBracket)).toEqual([must(library[2], "the X-cost spell").id]);

    const highBracket = game("discover-library-4plus");
    const other = tutorLibrary(highBracket);
    run(
      highBracket,
      discoverFromLibrary({ step: "take", filter: { type: "Spell", costRange: { min: 4 } } }),
      { controller: "p1", self: resolvingSelf(highBracket, generator.id) },
    );
    expect(offeredIds(highBracket)).toEqual([must(other[1], "the cost-5 spell").id]);
  });

  it("#51 a Field Trap counts as a Trap for type matching", () => {
    const state = game("discover-library-field-trap");
    const library = tutorLibrary(state);

    run(state, discoverFromLibrary({ step: "take", count: 3, filter: { type: "Trap" } }), {
      controller: "p1",
      self: resolvingSelf(state, generator.id),
    });

    const trap = must(library[3], "the trap");
    const fieldTrap = must(library[4], "the field trap");
    expect(offeredIds(state).sort()).toEqual([trap.id, fieldTrap.id].sort());
    // The reverse does not hold: "Field Trap" names Field Traps only.
    const narrow = game("discover-library-field-trap-only");
    const narrowLibrary = tutorLibrary(narrow);
    run(narrow, discoverFromLibrary({ step: "take", count: 3, filter: { type: "Field Trap" } }), {
      controller: "p1",
      self: resolvingSelf(narrow, generator.id),
    });
    expect(offeredIds(narrow)).toEqual([must(narrowLibrary[4], "the field trap").id]);
  });

  it("R60 reveals count DIFFERENT cards, drawn without replacement", () => {
    const state = game("discover-library-distinct");
    setLibrary(state, "p1", [alpha.id, alpha.id, beta.id, beta.id, gamma.id]);

    run(state, discoverFromLibrary({ step: "take", count: 3, filter: { type: "Unit" } }), {
      controller: "p1",
      self: resolvingSelf(state, generator.id),
    });

    const offered = offeredIds(state);
    expect(offered).toHaveLength(3);
    expect(new Set(offered).size).toBe(3);
    for (const id of offered) expect(ids(state.players.p1.library)).toContain(id);
  });

  it("§6.3 opens no prompt when nothing matches: the effect fizzles and the card still resolves", () => {
    const state = game("discover-library-no-match");
    setLibrary(state, "p1", [spellTwo.id, trapTwo.id]);

    const events = run(state, discoverFromLibrary({ step: "take", filter: { type: "Field Spell" } }), {
      controller: "p1",
      self: resolvingSelf(state, generator.id),
    });

    expect(state.pending).toBeNull();
    expect(eventsOfType(events, "promptOpened")).toHaveLength(0);
    expect(events).toEqual([]);

    // An empty library is the same fizzle, which is the branch #51 answers with its Notebook.
    setLibrary(state, "p1", []);
    expect(run(state, discoverFromLibrary({ step: "take" }), { controller: "p1" })).toEqual([]);
    expect(state.pending).toBeNull();
  });

  it("§10.8 the prompt belongs to the chooser even when the pool is the other player's library", () => {
    const state = game("discover-library-enemy-pool");
    const theirs = setLibrary(state, "p2", [spellTwo.id]);
    setLibrary(state, "p1", [alpha.id]);

    run(state, discoverFromLibrary({ step: "take", player: "enemy", filter: { type: "Spell" } }), {
      controller: "p1",
      self: resolvingSelf(state, generator.id),
    });

    const pending = must(state.pending, "the discover prompt");
    expect(pending.playerId).toBe("p1");
    expect(offeredIds(state)).toEqual([must(theirs[0], "their spell").id]);
  });
});
