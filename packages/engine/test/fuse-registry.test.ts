// A fused card's scripts are its own, whatever else the process has fused (R77, §9.3).
//
// A transient def's id, `t-<n>`, counts only that match's transient defs, but the script registry
// is the process's. A server runs many matches in one process, and the practice worker runs the
// AI's simulated worlds beside the real game, so two states can each hold a `t-1` built from
// different cards. The engine rebuilds a state's own fused scripts whenever it is entered through
// `reduce`, `legalActions` or `viewFor`, from the ingredient ids the def records.

import type { CardDef } from "@jackioh/shared";
import { describe, expect, it } from "vitest";
import { registerCatalog, registeredCatalog } from "../src/catalog";
import { fuseCards } from "../src/effects/fuse";
import { legalActions, reduce } from "../src/reduce";
import { applyEffects, makeContext } from "../src/resolve";
import type { Effect, Script } from "../src/script";
import { registerScripts, registeredScripts, scriptsFor } from "../src/scripts";
import type { GameState } from "../src/state";
import { syncFusedScripts } from "../src/subsystems/fuse";
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

/** A Cry that returns a marker naming its card, so the concatenated hook shows its ingredients. */
function marked(name: string): Script {
  return { cry: () => [{ kind: `marker:${name}` } as unknown as Effect] };
}

function setup(): void {
  registerCatalog({ ...registeredCatalog(), ...Object.fromEntries(CARDS.map((def) => [def.id, def])) });
  registerScripts({
    ...registeredScripts(),
    ...Object.fromEntries(CARDS.map((def) => [def.id, { base: marked(def.id), radiant: marked(def.id) }])),
  });
}

/** A fresh match in which p1 crafts `first` + `second` into hand: the match's `t-1`. */
function craftedGame(seed: string, first: CardDef, second: CardDef): GameState {
  const state = newGame(seed);
  // `newGame` registers the fixture catalog afresh, so these cards go in after it.
  setup();
  state.turn = 3;
  state.active = "p1";
  const sink = sinkFor(state);
  applyEffects([fuseCards({ defIds: [first.id, second.id], toHand: "self" })], makeContext(sink, null, { controller: "p1" }));
  state.rngCursor = sink.rng.cursor;
  return state;
}

/** What the registry's `t-1` Cry returns right now, as marker names. */
function t1Markers(): string[] {
  const cry = scriptsFor("t-1").base.cry;
  if (cry === undefined) return [];
  const effects = cry(undefined as never) as unknown as { kind: string }[];
  return effects.map((effect) => effect.kind);
}

describe("fused scripts belong to the state that fused them", () => {
  const [alpha, beta, gamma, delta] = CARDS as [CardDef, CardDef, CardDef, CardDef];

  it("R77 two matches in one process that each fuse a different t-1 run their own fused Cry", () => {
    setup();
    const first = craftedGame("fuse-registry-a", alpha, beta);
    const second = craftedGame("fuse-registry-b", gamma, delta);
    expect(Object.keys(first.transientDefs)).toEqual(["t-1"]);
    expect(Object.keys(second.transientDefs)).toEqual(["t-1"]);

    // The second fusion was the last to write the process's registry.
    expect(t1Markers()).toEqual([`marker:${gamma.id}`, `marker:${delta.id}`]);

    // Entering the engine with the first match puts its own t-1 back, through every entry point.
    legalActions(first, "p1");
    expect(t1Markers()).toEqual([`marker:${alpha.id}`, `marker:${beta.id}`]);

    viewFor(second, "p1");
    expect(t1Markers()).toEqual([`marker:${gamma.id}`, `marker:${delta.id}`]);

    reduce(first, { type: "endTurn", playerId: "p1", nonce: "fuse-registry" });
    expect(t1Markers()).toEqual([`marker:${alpha.id}`, `marker:${beta.id}`]);
  });

  it("R77 the ingredients travel in the state, so a JSON round trip still rebuilds the right scripts", () => {
    setup();
    const first = craftedGame("fuse-registry-json-a", alpha, beta);
    const copy = JSON.parse(JSON.stringify(first)) as GameState;
    craftedGame("fuse-registry-json-b", gamma, delta);

    expect(copy.transientDefs["t-1"]).toMatchObject({ fusedFrom: [alpha.id, beta.id] });
    syncFusedScripts(copy);
    expect(t1Markers()).toEqual([`marker:${alpha.id}`, `marker:${beta.id}`]);
  });

  it("R77 a registry replaced wholesale (registerScripts) is repaired on the next entry", () => {
    setup();
    const first = craftedGame("fuse-registry-reset", alpha, beta);
    // A package re-registering its catalog scripts drops every transient entry.
    const { "t-1": _dropped, ...rest } = registeredScripts();
    registerScripts(rest);
    expect(t1Markers()).toEqual([]);

    legalActions(first, "p1");
    expect(t1Markers()).toEqual([`marker:${alpha.id}`, `marker:${beta.id}`]);
  });
});
