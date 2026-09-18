// The effects library's cross-cutting acceptance items and the core verbs with no test file of
// their own (BUILD M3-T1, SPEC §6.3's verb table).
//
// M3-T1's acceptance list, verbatim: "every effect has its own test file; `grep -r
// \"state.players[\" packages/cards` returns nothing (scripts never touch state); `steal` places
// into the same lane if free else first free and leaves excess (R15); `summon` with no zone takes
// the leftmost free zone and skips zones reserved for Reborn (R64); `cast` counts as a play with
// cost paid 0 (R70); `fuse` follows R77; leaving the field resets an instance per R78 while
// `costMod`, `costOverride` and `radiant` persist; `bounce` returns to the owner's hand and drops
// buffs (§6.3); `transform` and `vanilla` are refused on Immutable (R23); `recruit` scans top-down
// and keeps library order."
//
// Who owns what. The per-effect files own their own verbs: `effects-steal` (R15), `effects-summon`
// (R64, recruit, fill your board), `effects-move` (bounce, exile, discard, counter),
// `effects-transform` (R23), and `fuse.test.ts` (R77). This file owns the two structural items, the
// two items no single effect file owns — R70's cast and R78's reset — and the modules of
// `src/effects` that have no test file of their own: draw, addToHand, shuffleInto, loseHealth,
// mana, memory and position. `targets` used to be on that list; it has `effects-targets.test.ts`
// of its own now that it carries the board scope the board-wide verbs are written in.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { GameEvent, PlayerId } from "@jackioh/shared";
import { describe, expect, it } from "vitest";
import { HAND_CAP, MAX_MANA } from "../src/config";
import {
  addRandomFromGraveyard,
  addToHand,
  damage,
  draw,
  gainMana,
  loseHealth,
  nextTurnMana,
  playerOf,
  remember,
  rememberRandom,
  shuffleCopiesOfSelf,
  shuffleInto,
  switchAllPositions,
  switchPositionOf,
} from "../src/effects";
import { resolveTarget } from "../src/effects/targets";
import { maxManaFor, refreshMana } from "../src/mana";
import { applyEffects, castCard, makeContext, type HookOptions } from "../src/resolve";
import type { CardDef } from "@jackioh/shared";
import { registerCatalog, registeredCatalog } from "../src/catalog";
import { damage as damageEffect } from "../src/effects";
import type { CardScripts, Effect, Script } from "../src/script";
import { registerScripts, registeredScripts } from "../src/scripts";
import type { CardInstance, GameState } from "../src/state";
import { moveToZone } from "../src/zones";
import { antiOneshot, stockpile } from "./fixtures/scripts";
import { plain, spikeyPillow, taunter } from "./fixtures/combat";
import { eventsOfType, inHand, newGame, put, setLibrary, sinkFor, slot } from "./fixtures/harness";

const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const effectsDir = join(repoRoot, "packages/engine/src/effects");
const engineTestDir = join(repoRoot, "packages/engine/test");
const cardsDir = join(repoRoot, "packages/cards");

// ---------------------------------------------------------------------------
// Fixtures: a Spell with a Cry, for R70's cast.
// ---------------------------------------------------------------------------

let nextIndex = 1700;

function def(name: string, type: CardDef["type"], extra: Partial<CardDef> = {}): CardDef {
  nextIndex += 1;
  return {
    id: `ec-${name}`,
    index: String(nextIndex),
    name: `${name} (effects-core)`,
    set: "Core",
    type,
    tags: [],
    rarity: "Common",
    token: false,
    cost: 1,
    base: { keywords: [], text: name },
    radiant: { keywords: [], text: name },
    ...extra,
  };
}

/** A 3-cost Spell that deals 2 to the enemy hero, so a cast's cost and its script are both visible. */
const castable = def("castable", "Spell", { cost: 3 });
const castableScript: Script = { cry: () => [damageEffect({ to: { of: "enemyHero" }, amount: 2 })] };
const SCRIPTS: Record<string, CardScripts> = {
  [castable.id]: { base: castableScript, radiant: castableScript },
};

function game(seed: string): GameState {
  const state = newGame(seed);
  registerCatalog({ ...registeredCatalog(), [castable.id]: castable });
  registerScripts({ ...registeredScripts(), ...SCRIPTS });
  state.turn = 4;
  state.active = "p1";
  state.phase = "main";
  return state;
}

/** Apply effects outside any card, as the resolver does, and hand back the events (§10.3). */
function run(
  state: GameState,
  effects: Effect | Effect[],
  options: HookOptions & { self?: CardInstance } = {},
): GameEvent[] {
  const events: GameEvent[] = [];
  const sink = sinkFor(state, events);
  const ctx = makeContext(sink, options.self ?? null, options);
  applyEffects(Array.isArray(effects) ? effects : [effects], ctx);
  return events;
}

function context(state: GameState, options: HookOptions & { self?: CardInstance } = {}) {
  return makeContext(sinkFor(state), options.self ?? null, options);
}

function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`expected ${what}`);
  return value;
}

function filesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...filesUnder(path));
    else out.push(path);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The two structural acceptance items.
// ---------------------------------------------------------------------------

/** The modules of `src/effects` this file owns, because they have no test file of their own. */
const CORE_OWNED = [
  "addToHand",
  "draw",
  "loseHealth",
  "mana",
  "memory",
  "position",
  "shuffleInto",
] as const;

/**
 * Modules whose verbs are tested in a sibling file that is named for the FAMILY rather than for
 * the module, because one family spans several modules: the delayed-effect and player-modifier
 * verbs are one story, and so are the two rng verbs. M3-T1's acceptance is "every effect has its
 * own test file", and that is still what is checked — the named file has to exist, and it has to
 * be a real file, so a module can no more slip through here than through `CORE_OWNED`. What this
 * map buys is honesty: parking `coins` in `CORE_OWNED` would claim this file tests it, and it
 * does not.
 */
const TESTED_BY: Readonly<Record<string, string>> = {
  coins: "effects-random.test.ts",
  // `fuse` and `rotate` wrap a subsystem whole, so their tests sit beside the other wrappers in
  // the same file rather than in one of their own; `fuse.test.ts` and `rotation.test.ts` are the
  // SUBSYSTEMS' tests and do not cover these verbs.
  fuse: "effects-random.test.ts",
  rotate: "effects-random.test.ts",
  playerMods: "effects-delay.test.ts",
};

describe("M3-T1 structural acceptance (BUILD M3-T1)", () => {
  it("M3-T1 every effect has its own test file, or is one this file owns", () => {
    const modules = readdirSync(effectsDir)
      .filter((name) => name.endsWith(".ts") && name !== "index.ts")
      .map((name) => name.replace(/\.ts$/, ""))
      .sort();
    expect(modules.length).toBeGreaterThan(0);

    const tests = new Set(readdirSync(engineTestDir).filter((name) => name.endsWith(".test.ts")));
    const owned = new Set<string>(CORE_OWNED);

    // Each module has exactly one home: its own file, this file, or a named family file.
    const homeless = modules.filter(
      (name) =>
        !tests.has(`effects-${name}.test.ts`) &&
        !owned.has(name) &&
        TESTED_BY[name] === undefined,
    );
    expect(homeless, "effect modules with no test file, no CORE_OWNED entry and no TESTED_BY entry").toEqual([]);

    // And the list above holds nothing stale: no module that has its own file, nothing that is not
    // a module at all, so a new effect cannot be quietly parked here.
    const doubled = [...owned].filter((name) => tests.has(`effects-${name}.test.ts`));
    expect(doubled, "modules listed here that already have their own test file").toEqual([]);
    expect([...owned].filter((name) => !modules.includes(name))).toEqual([]);

    // A `TESTED_BY` entry has to name a test file that exists, for a module that exists, and must
    // not cover a module that has its own file after all — otherwise it is a way to launder a
    // module past the gate rather than a way to describe where it really is tested.
    for (const [name, file] of Object.entries(TESTED_BY)) {
      expect(modules, `TESTED_BY names "${name}", which is not a module of src/effects`).toContain(name);
      expect(tests, `TESTED_BY sends "${name}" to "${file}", which does not exist`).toContain(file);
      expect(tests.has(`effects-${name}.test.ts`), `"${name}" has its own test file; drop its TESTED_BY entry`).toBe(false);
      expect(owned.has(name), `"${name}" is in both CORE_OWNED and TESTED_BY`).toBe(false);
    }
  });

  it("M3-T1 a card script never mutates state (CLAUDE.md rule 5, §10.9)", () => {
    // SPEC §10.9: "A card never mutates state directly." An assignment into `state.…` is what that
    // forbids, so this is the mutation half of the acceptance grep below.
    const scripts = filesUnder(join(cardsDir, "src")).filter((path) => path.endsWith(".ts"));
    const offenders = scripts.flatMap((path) => {
      const lines = readFileSync(path, "utf8").split("\n");
      return lines.flatMap((line, index) =>
        /\bstate\.[A-Za-z[\].?]*\s*(?:=[^=]|\+\+|--|\+=|-=)/.test(line)
          ? [`${path.slice(repoRoot.length)}:${index + 1}: ${line.trim()}`]
          : [],
      );
    });
    expect(offenders, "card scripts assigning into state").toEqual([]);
  });

  it("M3-T1 grep -r \"state.players[\" packages/cards returns nothing (scripts never touch state)", () => {
    // DISCREPANCY: BUILD M3-T1 requires this grep to be empty; `packages/cards/src/scripts` has
    // read-only uses of `ctx.state.players[…]` (computed costs, hand and library counts, hero
    // health). SPEC §10.9 only forbids a card *mutating* state, which the test above covers, so
    // either the scripts need a read helper on the effect/script surface or BUILD's line needs to
    // say "never writes state". Asserted as BUILD words it, scoped to the card scripts — the whole
    // package would also catch `test/_harness.ts`, which builds states on purpose.
    const scripts = filesUnder(join(cardsDir, "src")).filter((path) => path.endsWith(".ts"));
    const hits = scripts.flatMap((path) => {
      const lines = readFileSync(path, "utf8").split("\n");
      return lines.flatMap((line, index) =>
        line.includes("state.players[") ? [`${path.slice(repoRoot.length)}:${index + 1}`] : [],
      );
    });
    expect(hits, "card scripts reaching into state.players[…]").toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// R70's cast and R78's reset: the two acceptance items no per-effect file owns.
// ---------------------------------------------------------------------------

describe("R70 cast, R78 leaving the field (BUILD M3-T1)", () => {
  it("R70 a cast counts as a play with cost paid 0, and fires the card's script", () => {
    const state = game("r70-cast");
    const events: GameEvent[] = [];
    const sink = sinkFor(state, events);
    const card = must(inHand(state, castable.id, "p1")[0], "a castable Spell"); // printed cost 3
    state.players.p1.mana.current = 3;
    const playedBefore = state.counters.played;

    castCard(sink, card);

    // "A cast is free": no mana moved, and the event the whole game reads says costPaid 0.
    expect(state.players.p1.mana.current).toBe(3);
    const played = eventsOfType(events, "cardPlayed");
    expect(played).toHaveLength(1);
    expect(played[0]).toMatchObject({ player: "p1", instanceId: card.id, defId: castable.id, costPaid: 0 });

    // "Counts as a play for every rule that counts or reacts to plays": the Combo counter, the
    // played list and the game counter Ceaseless Void reads (R55).
    expect(state.players.p1.turnLog.cardsPlayed).toBe(1);
    expect(state.players.p1.turnLog.playedIds).toEqual([card.id]);
    expect(state.counters.played).toBe(playedBefore + 1);

    // "It fires the card's Cry or spell script", and the Spell then goes to the graveyard (§10.5).
    expect(state.players.p2.hero.health).toBe(30 - 2);
    expect(state.players.p1.graveyard.map((entry) => entry.id)).toEqual([card.id]);
    expect(state.players.p1.hand).toEqual([]);
  });

  it("R78 leaving the field resets the instance while costMod, costOverride and radiant persist", () => {
    const state = game("r78-reset");
    const unit = put(state, plain.id, slot("p1", "units", 1), { radiant: true });

    unit.damage = 2;
    unit.buffs = { attack: 3, health: 4 };
    unit.grantedKeywords = [{ kind: "Taunt" }];
    unit.vanilla = true;
    unit.counters = { plague: 2, grade: 3 };
    unit.memory = { meal: "felinor" };
    unit.exertion = { attacked: true, switched: true };
    unit.position = "DEF";
    unit.summonedTurn = state.turn;
    unit.statsOverride = { attack: 9, health: 9 };
    unit.tauntSuppressedTurn = state.turn;
    unit.controller = "p2";
    unit.divineShieldSpent = true;
    unit.markedDestroyed = true;
    unit.lastDamagedBy = "c77";
    unit.costMod = 2;
    unit.costOverride = 1;

    expect(moveToZone(state, unit, "graveyard")).toBe("moved");

    // Every field R78 names is back to its default.
    expect(unit.damage).toBe(0);
    expect(unit.buffs).toEqual({ attack: 0, health: 0 });
    expect(unit.grantedKeywords).toEqual([]);
    expect(unit.vanilla).toBe(false);
    expect(unit.counters).toEqual({});
    expect(unit.memory).toEqual({});
    expect(unit.exertion).toEqual({ attacked: false, switched: false });
    expect(unit.position).toBeUndefined();
    expect(unit.summonedTurn).toBeUndefined();
    expect(unit.statsOverride).toBeUndefined();
    expect(unit.tauntSuppressedTurn).toBeUndefined();
    expect(unit.divineShieldSpent).toBeUndefined();
    expect(unit.markedDestroyed).toBeUndefined();
    expect(unit.lastDamagedBy).toBeUndefined();
    // R12 and R78: control returns to the owner, which is where the card goes.
    expect(unit.controller).toBe("p1");
    expect(unit.zone).toEqual({ z: "graveyard", player: "p1" });

    // The three that persist in every zone.
    expect(unit.costMod).toBe(2);
    expect(unit.costOverride).toBe(1);
    expect(unit.radiant).toBe(true);
  });

  it("R78 a card that never was on the field keeps what it carries", () => {
    const state = game("r78-off-field");
    const card = must(inHand(state, plain.id, "p1")[0], "a hand card");
    card.memory = { note: "kept" };
    card.costMod = -1;

    // Hand to library is not "leaving the field", so nothing is reset (R78).
    expect(moveToZone(state, card, "library")).toBe("moved");
    expect(card.memory).toEqual({ note: "kept" });
    expect(card.costMod).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// targets.ts: the vocabulary every other verb is written in.
// ---------------------------------------------------------------------------

describe("§6.3 target and player specs (targets.ts, M3-T1)", () => {
  it("§6.3 playerOf reads self and enemy from the controller", () => {
    const state = game("targets-player");
    for (const controller of ["p1", "p2"] as PlayerId[]) {
      const ctx = context(state, { controller });
      expect(playerOf(ctx, "self")).toBe(controller);
      expect(playerOf(ctx, "enemy")).toBe(controller === "p1" ? "p2" : "p1");
    }
  });

  it("§6.3 resolveTarget reads self, both heroes and the chosen selections in order (R81)", () => {
    const state = game("targets-resolve");
    const self = put(state, plain.id, slot("p1", "units", 1));
    const first = put(state, plain.id, slot("p2", "units", 1));
    const second = put(state, taunter.id, slot("p2", "units", 2));

    const ctx = context(state, {
      controller: "p1",
      self,
      targets: [
        { pick: "instance", instanceId: first.id },
        { pick: "instance", instanceId: second.id },
      ],
    });

    expect(resolveTarget(ctx, { of: "self" })).toEqual({ kind: "unit", instance: self });
    expect(resolveTarget(ctx, { of: "selfHero" })).toEqual({ kind: "hero", player: "p1" });
    expect(resolveTarget(ctx, { of: "enemyHero" })).toEqual({ kind: "hero", player: "p2" });
    // "The n-th selection the play carried, default the first."
    expect(resolveTarget(ctx, { of: "chosen" })).toEqual({ kind: "unit", instance: first });
    expect(resolveTarget(ctx, { of: "chosen", index: 1 })).toEqual({ kind: "unit", instance: second });
    expect(resolveTarget(ctx, { of: "chosen", index: 2 })).toBeNull();
  });

  it("§6.3 resolveTarget returns nothing when the spec names nothing on the board", () => {
    const state = game("targets-empty");
    const bare = context(state, { controller: "p1" });
    expect(resolveTarget(bare, { of: "self" })).toBeNull();

    const hero = context(state, {
      controller: "p1",
      targets: [{ pick: "hero", player: "p2" }],
    });
    expect(resolveTarget(hero, { of: "chosen" })).toEqual({ kind: "hero", player: "p2" });

    const gone = context(state, {
      controller: "p1",
      targets: [{ pick: "instance", instanceId: "c9999" }, { pick: "none" }],
    });
    expect(resolveTarget(gone, { of: "chosen" })).toBeNull();
    expect(resolveTarget(gone, { of: "chosen", index: 1 })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// draw, addToHand, shuffleInto.
// ---------------------------------------------------------------------------

describe("§6.3 draw, add to hand, shuffle into (M3-T1)", () => {
  it("§6.3 draw takes the top cards for the player the effect names", () => {
    const state = game("draw-effect");
    setLibrary(state, "p1", [plain.id, taunter.id, plain.id]);
    setLibrary(state, "p2", [taunter.id, plain.id]);

    const mine = run(state, draw({ count: 2 }), { controller: "p1" });
    expect(state.players.p1.hand.map((card) => card.defId)).toEqual([plain.id, taunter.id]);
    expect(state.players.p1.library).toHaveLength(1);
    expect(eventsOfType(mine, "drawn").map((event) => event.player)).toEqual(["p1", "p1"]);

    const theirs = run(state, draw({ count: 1, player: "enemy" }), { controller: "p1" });
    expect(state.players.p2.hand.map((card) => card.defId)).toEqual([taunter.id]);
    expect(eventsOfType(theirs, "drawn").map((event) => event.player)).toEqual(["p2"]);

    // A count of 0 draws nothing.
    expect(run(state, draw({ count: 0 }), { controller: "p1" })).toEqual([]);
  });

  it("§6.3 add to hand creates a fresh card in the hand it names, Radiant or free when asked", () => {
    const state = game("add-to-hand");
    const events = run(
      state,
      [
        addToHand({ defId: plain.id }),
        addToHand({ defId: taunter.id, player: "enemy" }),
        addToHand({ defId: plain.id, radiant: true, costOverride: 0 }),
      ],
      { controller: "p1" },
    );

    expect(state.players.p1.hand.map((card) => card.defId)).toEqual([plain.id, plain.id]);
    expect(state.players.p2.hand.map((card) => card.defId)).toEqual([taunter.id]);
    const created = must(state.players.p1.hand[1], "the third card");
    expect(created.radiant).toBe(true);
    expect(created.costOverride).toBe(0);
    expect(created.owner).toBe("p1");
    expect(created.zone).toEqual({ z: "hand", player: "p1" });
    expect(eventsOfType(events, "addedToHand").map((event) => event.player)).toEqual(["p1", "p2", "p1"]);
  });

  it("§2.4 a card added to a full hand is burned instead (R4)", () => {
    const state = game("add-to-hand-full");
    inHand(state, plain.id, "p1", HAND_CAP);

    const events = run(state, addToHand({ defId: taunter.id }), { controller: "p1" });
    expect(state.players.p1.hand).toHaveLength(HAND_CAP);
    expect(eventsOfType(events, "burned")).toHaveLength(1);
    expect(state.players.p1.graveyard.map((card) => card.defId)).toEqual([taunter.id]);
  });

  it("#37 a random graveyard card moves to hand, drawn from the match rng", () => {
    const state = game("add-random-graveyard");
    const buried = [plain.id, taunter.id, stockpile.id].map((defId) => {
      const card = must(inHand(state, defId, "p1")[0], defId);
      moveToZone(state, card, "graveyard");
      return card;
    });

    run(state, addRandomFromGraveyard(), { controller: "p1" });
    expect(state.players.p1.hand).toHaveLength(1);
    const moved = must(state.players.p1.hand[0], "the returned card");
    // The same instance moved, rather than a copy being created (§6.3 Add to hand).
    expect(buried.map((card) => card.id)).toContain(moved.id);
    expect(state.players.p1.graveyard).toHaveLength(2);

    // Seeded: the same state and seed return the same card.
    const again = game("add-random-graveyard");
    const buriedAgain = [plain.id, taunter.id, stockpile.id].map((defId) => {
      const card = must(inHand(again, defId, "p1")[0], defId);
      moveToZone(again, card, "graveyard");
      return card;
    });
    run(again, addRandomFromGraveyard(), { controller: "p1" });
    const index = buried.findIndex((card) => card.id === moved.id);
    expect(must(again.players.p1.hand[0], "the returned card").id).toBe(
      must(buriedAgain[index], "the same slot").id,
    );

    // An empty graveyard gives nothing.
    const empty = game("add-random-empty");
    expect(run(empty, addRandomFromGraveyard(), { controller: "p1" })).toEqual([]);
    expect(empty.players.p1.hand).toEqual([]);
  });

  it("§6.3 shuffle into puts fresh copies in the library at rng positions", () => {
    const state = game("shuffle-into");
    setLibrary(state, "p1", [plain.id, plain.id]);

    const events = run(state, shuffleInto({ defId: taunter.id, count: 2 }), { controller: "p1" });
    expect(state.players.p1.library).toHaveLength(4);
    expect(state.players.p1.library.filter((card) => card.defId === taunter.id)).toHaveLength(2);
    const shuffled = eventsOfType(events, "shuffledIn");
    expect(shuffled).toHaveLength(2);
    for (const event of shuffled) {
      expect(event.player).toBe("p1");
      expect(event.position).toBeGreaterThanOrEqual(0);
    }

    // The enemy's library when the effect says so, and a Radiant copy when it asks for one (R57).
    run(state, shuffleInto({ defId: taunter.id, count: 1, player: "enemy", radiant: true }), {
      controller: "p1",
    });
    const theirs = must(
      state.players.p2.library.find((card) => card.defId === taunter.id),
      "the shuffled copy",
    );
    expect(theirs.radiant).toBe(true);
    expect(theirs.owner).toBe("p2");
  });

  it("#90.1 shuffle copies of self copies the running card's definition and its radiant flag", () => {
    const state = game("shuffle-copies");
    const self = must(inHand(state, taunter.id, "p1")[0], "the running card");
    self.radiant = true;

    run(state, shuffleCopiesOfSelf({ count: 3 }), { controller: "p1", self });
    const copies = state.players.p1.library.filter((card) => card.defId === taunter.id);
    expect(copies).toHaveLength(3);
    expect(copies.every((card) => card.radiant)).toBe(true);
    expect(copies.every((card) => card.id !== self.id)).toBe(true);

    // With no card running there is nothing to copy.
    const bare = game("shuffle-copies-bare");
    setLibrary(bare, "p1", []);
    expect(run(bare, shuffleCopiesOfSelf({ count: 2 }), { controller: "p1" })).toEqual([]);
    expect(bare.players.p1.library).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// loseHealth, mana, memory, position.
// ---------------------------------------------------------------------------

describe("§6.3 lose health (R18, M3-T1)", () => {
  it("R18 lose health lowers the hero directly: no Armor, no hero cap, no damage event", () => {
    const state = game("lose-health");
    state.players.p2.hero.armor = 5;
    put(state, antiOneshot.id, slot("p2", "backrow", 1)); // caps each damage instance at 5

    const events = run(state, loseHealth({ player: "enemy", amount: 12 }), { controller: "p1" });
    expect(state.players.p2.hero.health).toBe(30 - 12);
    expect(eventsOfType(events, "healthLost")).toEqual([{ type: "healthLost", player: "p2", amount: 12 }]);
    expect(eventsOfType(events, "damage")).toEqual([]);

    // Your own hero when the effect names itself (#98's draw power), and 0 does nothing.
    run(state, loseHealth({ player: "self", amount: 2 }), { controller: "p1" });
    expect(state.players.p1.hero.health).toBe(30 - 2);
    expect(run(state, loseHealth({ player: "self", amount: 0 }), { controller: "p1" })).toEqual([]);
  });
});

describe("§6.3 mana and next-turn mana (§2.3, M3-T1)", () => {
  it("§2.3 gain mana adds to current mana and may take it above max", () => {
    const state = game("gain-mana");
    state.players.p1.mana = { current: 1, max: 1, nextTurnMod: 0, permMod: 0 };

    const events = run(state, gainMana({ amount: 2 }), { controller: "p1" });
    expect(state.players.p1.mana.current).toBe(3);
    expect(state.players.p1.mana.max).toBe(1); // above max is allowed (§2.3)
    expect(eventsOfType(events, "manaChanged")).toEqual([
      { type: "manaChanged", player: "p1", current: 3, max: 1 },
    ]);

    // The enemy's mana when the effect names it, and a drain floors at 0.
    run(state, gainMana({ amount: 1, player: "enemy" }), { controller: "p1" });
    expect(state.players.p2.mana.current).toBe(1);
    run(state, gainMana({ amount: -5 }), { controller: "p1" });
    expect(state.players.p1.mana.current).toBe(0);
  });

  it("#21 next-turn mana changes the next refresh only, and the refresh floors at 0 (§2.3)", () => {
    const state = game("next-turn-mana");
    const side = state.players.p2;
    side.turnsStarted = 3;
    side.mana = { current: 3, max: 3, nextTurnMod: 0, permMod: 0 };

    const events = run(state, nextTurnMana({ amount: -1, player: "enemy" }), { controller: "p1" });
    expect(side.mana.nextTurnMod).toBe(-1);
    expect(side.mana.current).toBe(3); // this turn is untouched
    expect(eventsOfType(events, "modifierChanged")).toHaveLength(1);

    side.turnsStarted = 4;
    expect(maxManaFor(side)).toBe(MAX_MANA - 1);
    refreshMana(side);
    expect(side.mana).toMatchObject({ current: 3, max: 3 });
    // One refresh only: the modifier is spent.
    expect(side.mana.nextTurnMod).toBe(0);

    // A big penalty floors the refresh at 0 rather than going negative.
    run(state, nextTurnMana({ amount: -9, player: "enemy" }), { controller: "p1" });
    refreshMana(side);
    expect(side.mana).toMatchObject({ current: 0, max: 0 });
  });
});

describe("§10.1 memory: what a card remembers (R43, M3-T1)", () => {
  it("§10.1 remember stores a value on the card that is running, under the key it names", () => {
    const state = game("remember");
    const self = put(state, plain.id, slot("p1", "units", 1));

    run(state, remember({ key: "meal", value: { attack: 3, health: 3 } }), { controller: "p1", self });
    expect(self.memory.meal).toEqual({ attack: 3, health: 3 });

    // A second write replaces the first, and another key lives beside it.
    run(state, [remember({ key: "meal", value: "eaten" }), remember({ key: "grade", value: 2 })], {
      controller: "p1",
      self,
    });
    expect(self.memory).toEqual({ meal: "eaten", grade: 2 });

    // With no card running there is nowhere to remember anything.
    expect(run(state, remember({ key: "meal", value: 1 }), { controller: "p1" })).toEqual([]);
  });

  it("R43 rememberRandom picks from the match rng, so the same seed remembers the same option", () => {
    const options = ["alpha", "beta", "gamma", "delta", "epsilon", "zeta", "eta"];

    const pick = (seed: string): unknown => {
      const state = game(seed);
      const self = put(state, plain.id, slot("p1", "units", 1));
      run(state, rememberRandom({ key: "power", options }), { controller: "p1", self });
      return self.memory.power;
    };

    const first = pick("remember-random");
    expect(options).toContain(first);
    expect(pick("remember-random")).toBe(first);

    // An empty option list remembers nothing, and so does a call with no card running.
    const state = game("remember-random-empty");
    const self = put(state, plain.id, slot("p1", "units", 1));
    run(state, rememberRandom({ key: "power", options: [] }), { controller: "p1", self });
    expect(self.memory.power).toBeUndefined();
    expect(run(state, rememberRandom({ key: "power", options }), { controller: "p1" })).toEqual([]);
  });
});

describe("§6.3 switch position as an effect (R20, M3-T1)", () => {
  it("R20 switching a named unit spends no exertion, and flips or sets the position", () => {
    const state = game("switch-position");
    const unit = put(state, plain.id, slot("p2", "units", 1));

    const events = run(state, switchPositionOf({ target: { of: "chosen" } }), {
      controller: "p1",
      targets: [{ pick: "instance", instanceId: unit.id }],
    });
    expect(unit.position).toBe("DEF");
    // R20: an effect's switch is free, so the unit can still act on its own turn (§4.1).
    expect(unit.exertion).toEqual({ attacked: false, switched: false });
    expect(eventsOfType(events, "positionSwitched")).toEqual([
      { type: "positionSwitched", instanceId: unit.id, position: "DEF" },
    ]);

    // A named position rather than a flip, and naming the one it is already in changes nothing.
    run(state, switchPositionOf({ to: "ATK", target: { of: "chosen" } }), {
      controller: "p1",
      targets: [{ pick: "instance", instanceId: unit.id }],
    });
    expect(unit.position).toBe("ATK");
    expect(
      run(state, switchPositionOf({ to: "ATK", target: { of: "chosen" } }), {
        controller: "p1",
        targets: [{ pick: "instance", instanceId: unit.id }],
      }),
    ).toEqual([]);

    // The card running the effect may switch itself (§6.3), and a hero pick does nothing.
    const self = put(state, plain.id, slot("p1", "units", 1));
    run(state, switchPositionOf({ target: { of: "self" } }), { controller: "p1", self });
    expect(self.position).toBe("DEF");
    expect(
      run(state, switchPositionOf({ target: { of: "chosen" } }), {
        controller: "p1",
        targets: [{ pick: "hero", player: "p2" }],
      }),
    ).toEqual([]);
  });

  it("#48 switch all positions flips every unit, or one side's, and never puts Spikey Pillow in Defense", () => {
    const state = game("switch-all");
    const mine = put(state, plain.id, slot("p1", "units", 1));
    const alsoMine = put(state, taunter.id, slot("p1", "units", 2));
    const pillow = put(state, spikeyPillow.id, slot("p1", "units", 3)); // neverDefense (§4.1)
    const theirs = put(state, plain.id, slot("p2", "units", 1));
    alsoMine.position = "DEF";

    run(state, switchAllPositions({ side: "both" }), { controller: "p1" });
    expect(mine.position).toBe("DEF");
    expect(alsoMine.position).toBe("ATK");
    expect(theirs.position).toBe("DEF");
    // §4.1: Spikey Pillow cannot be switched to Defense, by an action or by an effect.
    expect(pillow.position).toBe("ATK");
    // R20 again: nothing spent anywhere.
    expect([mine, alsoMine, theirs].every((unit) => !unit.exertion.switched)).toBe(true);

    // One side only when the effect names it.
    run(state, switchAllPositions({ side: "enemy" }), { controller: "p1" });
    expect(theirs.position).toBe("ATK");
    expect(mine.position).toBe("DEF");

    run(state, switchAllPositions({ side: "self" }), { controller: "p1" });
    expect(mine.position).toBe("ATK");
    expect(theirs.position).toBe("ATK");
  });
});

// ---------------------------------------------------------------------------
// The effects a card script may see at all.
// ---------------------------------------------------------------------------

describe("§6.3 the effects barrel (M3-T1)", () => {
  it("§6.3 every verb a card script imports is a factory that returns an Effect", () => {
    const state = game("barrel");
    const built: Effect[] = [
      damage({ to: { of: "enemyHero" }, amount: 1 }),
      draw({ count: 1 }),
      addToHand({ defId: plain.id }),
      shuffleInto({ defId: plain.id, count: 1 }),
      loseHealth({ player: "self", amount: 1 }),
      gainMana({ amount: 1 }),
      nextTurnMana({ amount: 1 }),
      remember({ key: "k", value: 1 }),
      rememberRandom({ key: "k", options: [1] }),
      switchPositionOf({ target: { of: "self" } }),
      switchAllPositions({ side: "both" }),
    ];

    for (const effect of built) {
      expect(typeof effect.kind).toBe("string");
      expect(effect.kind.length).toBeGreaterThan(0);
      expect(typeof effect.apply).toBe("function");
    }
    // Each names itself, so an event log and a stack trace read as the verb list of §6.3.
    expect(new Set(built.map((effect) => effect.kind)).size).toBe(built.length);
    // Building an effect changes nothing until it is applied (CLAUDE.md rule 5).
    expect(state.players.p2.hero.health).toBe(30);
  });
});
