// A fused card's scripts are its own, whatever else the process has fused (R77, R179, §9.3).
//
// The script registry is the process's. A server runs many matches in one process, and the practice
// worker runs the AI's simulated worlds beside the real game, so two states can each fuse into the
// same `t-<n>` slot from different cards. R179's id names the ingredients, so those two fusions get
// two ids and two registry entries; and because the id names them, the engine rebuilds any of a
// state's fused scripts the registry lacks — a state that came through JSON into a process that never
// ran its Fuse, or a registry replaced wholesale — whenever it is entered through `reduce`,
// `legalActions` or `viewFor`.

import type { CardDef } from "@jackioh/shared";
import { describe, expect, it } from "vitest";
import { registerCatalog, registeredCatalog } from "../src/catalog";
import { fuseCards } from "../src/effects/fuse";
import { legalActions, reduce } from "../src/reduce";
import { applyEffects, makeContext } from "../src/resolve";
import type { Effect, Script } from "../src/script";
import { registerScripts, registeredScripts, scriptsFor } from "../src/scripts";
import type { GameState } from "../src/state";
import { fusedIngredients, syncFusedScripts } from "../src/subsystems/fuse";
import { viewFor } from "../src/viewFor";
import { newGame, sinkFor } from "./fixtures/harness";

let nextIndex = 1700;
function unit(name: string): CardDef {
  nextIndex += 1;
  return {
    id: `fr-${name}`,
    index: String(nextIndex),
    name: `${name} (fuse registry)`,
    set: "Core",
    type: "Unit",
    tags: [],
    rarity: "Common",
    token: false,
    cost: 1,
    base: { attack: 1, health: 1, keywords: [], text: name },
    radiant: { attack: 2, health: 2, keywords: [], text: `${name} radiant` },
  };
}

const CARDS = ["alpha", "beta", "gamma", "delta"].map(unit);

/** The markers the last Cry run applied, in order. */
const seen: string[] = [];

/** A Cry whose one effect records its card, so the concatenated hook shows its ingredients. */
function marked(name: string): Script {
  const effect: Effect = { kind: "marker", apply: () => void seen.push(`marker:${name}`) };
  return { cry: () => [effect] };
}

function setup(): void {
  registerCatalog({ ...registeredCatalog(), ...Object.fromEntries(CARDS.map((def) => [def.id, def])) });
  registerScripts({
    ...registeredScripts(),
    ...Object.fromEntries(CARDS.map((def) => [def.id, { base: marked(def.id), radiant: marked(def.id) }])),
  });
}

/** p1 crafts `defIds` into hand, in order: each call is the state's next fused definition. */
function craft(state: GameState, defIds: readonly string[]): void {
  const sink = sinkFor(state);
  applyEffects([fuseCards({ defIds: [...defIds], toHand: "self" })], makeContext(sink, null, { controller: "p1" }));
  state.rngCursor = sink.rng.cursor;
}

/**
 * Fresh matches on p1's turn 3. `newGame` registers the fixture catalog and scripts afresh, which
 * drops every fused entry, so every match a test needs is made before any of them fuses.
 */
function games(...seeds: readonly string[]): GameState[] {
  const states = seeds.map((seed) => {
    const state = newGame(seed);
    state.turn = 3;
    state.active = "p1";
    return state;
  });
  setup();
  return states;
}

/** A fresh match in which p1 crafts `first` + `second` into hand: the match's first fusion. */
function craftedGame(seed: string, first: CardDef, second: CardDef): GameState {
  const [state] = games(seed) as [GameState];
  craft(state, [first.id, second.id]);
  return state;
}

/** The state's only fused definition's id. */
function onlyFused(state: GameState): string {
  const ids = Object.keys(state.transientDefs);
  expect(ids).toHaveLength(1);
  return ids[0] as string;
}

/**
 * What the registry's entry for `defId` does right now: its Cry, run with no play behind it on a
 * copy of `state` and applied, as the markers its ingredients' Cries record. It reads the registry
 * directly, so no engine entry point gets to rebuild the entry first.
 */
function markers(state: GameState, defId: string): string[] {
  const cry = registeredScripts()[defId]?.base.cry;
  if (cry === undefined) return [];
  seen.length = 0;
  const ctx = makeContext(sinkFor(JSON.parse(JSON.stringify(state)) as GameState), null, { controller: "p1" });
  applyEffects(cry(ctx), ctx);
  return [...seen];
}

/** The registry without these entries, as a package re-registering its catalog scripts leaves it. */
function drop(...defIds: readonly string[]): void {
  const rest = { ...registeredScripts() };
  for (const defId of defIds) delete rest[defId];
  registerScripts(rest);
}

describe("fused scripts belong to the state that fused them", () => {
  const [alpha, beta, gamma, delta] = CARDS as [CardDef, CardDef, CardDef, CardDef];

  it("R179 two matches in one process that fuse different pairs into the same slot keep two ids and their own Cry", () => {
    const [first, second] = games("fuse-registry-a", "fuse-registry-b") as [GameState, GameState];
    craft(first, [alpha.id, beta.id]);
    craft(second, [gamma.id, delta.id]);
    const firstId = onlyFused(first);
    const secondId = onlyFused(second);
    expect(firstId).toBe(`t-1:${alpha.id}+${beta.id}`);
    expect(secondId).toBe(`t-1:${gamma.id}+${delta.id}`);

    // The second fusion wrote beside the first, not over it.
    expect(markers(first, firstId)).toEqual([`marker:${alpha.id}`, `marker:${beta.id}`]);
    expect(markers(second, secondId)).toEqual([`marker:${gamma.id}`, `marker:${delta.id}`]);

    // Entering the engine with either match, through every entry point, leaves both as they were.
    legalActions(first, "p1");
    viewFor(second, "p1");
    reduce(first, { type: "endTurn", playerId: "p1", nonce: "fuse-registry" });
    expect(markers(first, firstId)).toEqual([`marker:${alpha.id}`, `marker:${beta.id}`]);
    expect(markers(second, secondId)).toEqual([`marker:${gamma.id}`, `marker:${delta.id}`]);
  });

  it("R179 the id alone rebuilds the scripts, so a state that came through JSON runs its own fusion", () => {
    const first = craftedGame("fuse-registry-json", alpha, beta);
    const copy = JSON.parse(JSON.stringify(first)) as GameState;
    const id = onlyFused(copy);
    // The def carries nothing but a card's fields: the id is what names the ingredients.
    expect(Object.keys(copy.transientDefs[id] ?? {}).sort()).toEqual(
      ["base", "cost", "id", "index", "name", "radiant", "rarity", "set", "tags", "token", "type"].sort(),
    );
    expect(fusedIngredients(id)).toEqual([alpha.id, beta.id]);

    // A process that never ran this Fuse.
    drop(id);
    expect(markers(copy, id)).toEqual([]);
    syncFusedScripts(copy);
    expect(markers(copy, id)).toEqual([`marker:${alpha.id}`, `marker:${beta.id}`]);
  });

  it("R179 a registry replaced wholesale (registerScripts) is repaired on the next entry", () => {
    const first = craftedGame("fuse-registry-reset", alpha, beta);
    const id = onlyFused(first);
    drop(id);
    expect(markers(first, id)).toEqual([]);

    legalActions(first, "p1");
    expect(markers(first, id)).toEqual([`marker:${alpha.id}`, `marker:${beta.id}`]);
  });

  it("R179 a fusion of a fusion writes its older ingredient in parentheses and rebuilds the whole chain", () => {
    const state = craftedGame("fuse-registry-chain", alpha, beta);
    const inner = onlyFused(state);
    craft(state, [inner, gamma.id]);
    const outer = Object.keys(state.transientDefs).find((id) => id !== inner) as string;
    expect(outer).toBe(`t-2:(${inner})+${gamma.id}`);
    expect(fusedIngredients(outer)).toEqual([inner, gamma.id]);
    expect(scriptsFor(outer).base.cry).toBeDefined();

    drop(inner, outer);
    viewFor(state, "p1");
    expect(markers(state, inner)).toEqual([`marker:${alpha.id}`, `marker:${beta.id}`]);
    expect(markers(state, outer)).toEqual([`marker:${alpha.id}`, `marker:${beta.id}`, `marker:${gamma.id}`]);
  });

  it("R179 reads a fused id back one way: the parentheses keep a nested ingredient whole", () => {
    // `t-1:a+b` fused with c and d, and `t-1:a+b+c` fused with d, are two different cards.
    expect(fusedIngredients("t-2:(t-1:a+b)+c+d")).toEqual(["t-1:a+b", "c", "d"]);
    expect(fusedIngredients("t-2:(t-1:a+b+c)+d")).toEqual(["t-1:a+b+c", "d"]);
    expect(fusedIngredients("t-3:(t-2:(t-1:a+b)+c)+(t-1:d+e)")).toEqual(["t-2:(t-1:a+b)+c", "t-1:d+e"]);
    // Nothing a Fuse did not mint: a catalog id, a bare count, a single ingredient.
    expect(fusedIngredients("core-085")).toBeNull();
    expect(fusedIngredients("t-1")).toBeNull();
    expect(fusedIngredients("t-1:a")).toBeNull();
  });
});
