// Destroy and Sacrifice (SPEC §6.3, §4.5, R11, R12, R46, R78, BUILD M3-T1).
// The fixture defs and scripts these tests need are registered here, on top of the shared fixture
// catalog, so no shared fixture has to grow for them (CLAUDE.md, BUILD §0).

import type { CardDef, GameEvent, PlayerId, Selection } from "@jackioh/shared";
import { describe, expect, it } from "vitest";
import { registerCatalog, registeredCatalog } from "../src/catalog";
import { HERO_HEALTH } from "../src/config";
import { damage } from "../src/effects";
import { destroy, sacrifice } from "../src/effects/destroy";
import { makeContext, type EngineSink } from "../src/resolve";
import type { CardScripts, Effect, Script } from "../src/script";
import { registerScripts, registeredScripts } from "../src/scripts";
import { stateCheck } from "../src/stateCheck";
import { newInstance, type CardInstance, type GameState } from "../src/state";
import { cardAt, placeOnField } from "../src/zones";
import { indestructible } from "./fixtures/combat";
import { tokenDef } from "./fixtures/catalog";
import { eventsOfType, newGame, put, sinkFor, slot } from "./fixtures/harness";

// ---------------------------------------------------------------------------
// Fixture cards.
// ---------------------------------------------------------------------------

let nextIndex = 750;

function unitDefOf(name: string, overrides: Partial<CardDef> = {}): CardDef {
  nextIndex += 1;
  return {
    id: `ds-${name}`,
    index: String(nextIndex),
    name: `${name} (destroy)`,
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

/** A 2/2 whose Death trigger pings the enemy hero, so "counts as a death" is observable. */
const dier = unitDefOf("dier");
/** Indestructible with a Death trigger: Sacrifice bypasses the ward, so the ping still lands. */
const wardedDier = unitDefOf("warded-dier", {
  base: { attack: 4, health: 4, keywords: [{ kind: "Indestructible" }], text: "warded" },
  radiant: { attack: 8, health: 8, keywords: [{ kind: "Indestructible" }], text: "warded" },
});
/** #22-style: its Death hook reads what it remembered while on the field (R78). */
const rememberer = unitDefOf("rememberer");
/** §4.5 step 1: a backrow card is collected only when an effect marked it destroyed. */
const fieldSpell: CardDef = {
  ...unitDefOf("field-spell"),
  type: "Field Spell",
  base: { keywords: [], text: "field spell" },
  radiant: { keywords: [], text: "field spell" },
};

const rushToken = tokenDef("rush");

const DEFS: CardDef[] = [dier, wardedDier, rememberer, fieldSpell];

function both(script: Script): CardScripts {
  return { base: script, radiant: script };
}

const pingEnemyHero: Script = { death: () => [damage({ to: { of: "enemyHero" }, amount: 3 })] };

const SCRIPTS: Record<string, CardScripts> = {
  [dier.id]: both(pingEnemyHero),
  [wardedDier.id]: both(pingEnemyHero),
  // R78: the Death hook reads the memory this card held just before it left the field.
  [rememberer.id]: both({
    death: (ctx) => {
      const amount = ctx.self?.memory.meal;
      return typeof amount === "number" ? [damage({ to: { of: "enemyHero" }, amount })] : [];
    },
  }),
};

/** A fresh game whose catalog and script registry also carry this file's fixtures. */
function game(seed = "effects-destroy"): GameState {
  const state = newGame(seed);
  registerCatalog({ ...registeredCatalog(), ...Object.fromEntries(DEFS.map((def) => [def.id, def])) });
  registerScripts({ ...registeredScripts(), ...SCRIPTS });
  state.turn = 3;
  return state;
}

type RunOptions = { controller?: PlayerId; self?: CardInstance };

/** A sink plus `apply`, so one test can run an effect and then the state check on the same events. */
function runner(state: GameState): {
  sink: EngineSink;
  events: GameEvent[];
  apply: (effect: Effect, target?: CardInstance, options?: RunOptions) => void;
  check: () => void;
} {
  const sink = sinkFor(state);
  return {
    sink,
    events: sink.events,
    apply(effect, target, options = {}): void {
      const targets: Selection[] = target === undefined ? [] : [{ pick: "instance", instanceId: target.id }];
      const ctx = makeContext(sink, options.self ?? null, {
        controller: options.controller ?? "p1",
        targets,
      });
      effect.apply(ctx);
      state.rngCursor = sink.rng.cursor;
    },
    check(): void {
      stateCheck(sink);
    },
  };
}

const chosen = { of: "chosen" } as const;

// ---------------------------------------------------------------------------
// destroy
// ---------------------------------------------------------------------------

describe("destroy (§6.3, M3-T1)", () => {
  it("§6.3 marks the card and leaves it on the field until the state check moves it", () => {
    const state = game();
    const victim = put(state, dier.id, slot("p1", "units", 2));
    const run = runner(state);

    run.apply(destroy({ target: chosen }), victim);

    expect(victim.markedDestroyed).toBe(true);
    expect(cardAt(state, slot("p1", "units", 2))?.id).toBe(victim.id);
    expect(run.events).toEqual([]);

    run.check();

    expect(cardAt(state, slot("p1", "units", 2))).toBeNull();
    expect(state.players.p1.graveyard.map((c) => c.id)).toEqual([victim.id]);
    expect(eventsOfType(run.events, "destroyed").map((e) => e.instanceId)).toEqual([victim.id]);
    expect(eventsOfType(run.events, "enteredGraveyard").map((e) => e.instanceId)).toEqual([victim.id]);
  });

  it("§4.5 two cards marked by one effect die in the same state check (R59)", () => {
    const state = game();
    const first = put(state, "fx-1", slot("p1", "units", 1));
    const second = put(state, "fx-2", slot("p2", "units", 1));
    const run = runner(state);

    run.apply(destroy({ target: chosen }), first);
    run.apply(destroy({ target: chosen }), second);
    run.check();

    expect(eventsOfType(run.events, "destroyed").map((e) => e.instanceId)).toEqual([first.id, second.id]);
    expect(state.players.p1.graveyard).toHaveLength(1);
    expect(state.players.p2.graveyard).toHaveLength(1);
  });

  it("R46 an Indestructible unit ignores a destroy mark and stays on the field", () => {
    const state = game();
    const warded = put(state, indestructible.id, slot("p1", "units", 1));
    warded.position = "DEF";
    const run = runner(state);

    run.apply(destroy({ target: chosen }), warded);
    run.check();

    expect(cardAt(state, slot("p1", "units", 1))?.id).toBe(warded.id);
    expect(warded.markedDestroyed).toBe(false);
    expect(warded.position).toBe("ATK");
    expect(state.players.p1.graveyard).toHaveLength(0);
  });

  it("§4.5 marks a backrow card, which the state check collects too", () => {
    const state = game();
    const card = put(state, fieldSpell.id, slot("p1", "backrow", 3));
    const run = runner(state);

    run.apply(destroy({ target: chosen }), card);
    run.check();

    expect(cardAt(state, slot("p1", "backrow", 3))).toBeNull();
    expect(state.players.p1.graveyard.map((c) => c.id)).toEqual([card.id]);
  });

  it("R12 a stolen unit destroyed goes to its owner's graveyard", () => {
    const state = game();
    const theirs = newInstance(state, "fx-4", "p2", { z: "hand", player: "p2" });
    expect(placeOnField(state, theirs, slot("p1", "units", 1))).toBe(true);
    const run = runner(state);

    run.apply(destroy({ target: chosen }), theirs);
    run.check();

    expect(state.players.p2.graveyard.map((c) => c.id)).toEqual([theirs.id]);
    expect(state.players.p1.graveyard).toHaveLength(0);
  });

  it("R11 a destroyed unit token vanishes and reaches no graveyard", () => {
    const state = game();
    const token = put(state, rushToken.id, slot("p1", "units", 1));
    const run = runner(state);

    run.apply(destroy({ target: chosen }), token);
    run.check();

    expect(cardAt(state, slot("p1", "units", 1))).toBeNull();
    expect(state.players.p1.graveyard).toHaveLength(0);
    expect(eventsOfType(run.events, "enteredGraveyard")).toEqual([]);
  });

  it("§6.3 marks nothing for a card that is not on the field", () => {
    const state = game();
    const card = newInstance(state, "fx-1", "p1", { z: "hand", player: "p1" });
    state.players.p1.hand.push(card);
    const run = runner(state);

    run.apply(destroy({ target: chosen }), card);
    run.check();

    expect(card.markedDestroyed).toBeUndefined();
    expect(state.players.p1.hand.map((c) => c.id)).toEqual([card.id]);
  });
});

// ---------------------------------------------------------------------------
// sacrifice
// ---------------------------------------------------------------------------

describe("sacrifice (§6.3, M3-T1)", () => {
  it("§6.3 moves your own unit from the field to the graveyard at once, with no state check", () => {
    const state = game();
    const victim = put(state, "fx-1", slot("p1", "units", 2));
    const run = runner(state);

    run.apply(sacrifice({ target: chosen }), victim);

    expect(cardAt(state, slot("p1", "units", 2))).toBeNull();
    expect(state.players.p1.graveyard.map((c) => c.id)).toEqual([victim.id]);
    expect(eventsOfType(run.events, "destroyed").map((e) => e.instanceId)).toEqual([victim.id]);
    expect(eventsOfType(run.events, "enteredGraveyard").map((e) => e.instanceId)).toEqual([victim.id]);
  });

  it("§6.3 counts as a death: the destroyed counter rises and the Death trigger fires", () => {
    const state = game();
    const victim = put(state, dier.id, slot("p1", "units", 1));
    const run = runner(state);

    run.apply(sacrifice({ target: chosen }), victim);

    expect(state.counters.destroyed).toBe(1);
    expect(state.players.p2.hero.health).toBe(HERO_HEALTH - 3);
    expect(eventsOfType(run.events, "damage").map((e) => e.amount)).toEqual([3]);
  });

  it("§6.3 bypasses Indestructible, which a destroy mark cannot", () => {
    const state = game();
    const warded = put(state, wardedDier.id, slot("p1", "units", 1));
    const run = runner(state);

    run.apply(sacrifice({ target: chosen }), warded);

    expect(cardAt(state, slot("p1", "units", 1))).toBeNull();
    expect(state.players.p1.graveyard.map((c) => c.id)).toEqual([warded.id]);
    expect(state.players.p2.hero.health).toBe(HERO_HEALTH - 3);
  });

  it("R78 the Death hook reads the card as it was just before it left the field", () => {
    const state = game();
    const victim = put(state, rememberer.id, slot("p1", "units", 1));
    victim.memory.meal = 7;
    const run = runner(state);

    run.apply(sacrifice({ target: chosen }), victim);

    expect(state.players.p2.hero.health).toBe(HERO_HEALTH - 7);
    // R78: the instance itself is wiped on the way out, so the hook read a snapshot.
    expect(victim.memory).toEqual({});
  });

  it("R11 a sacrificed unit token vanishes and enters no graveyard", () => {
    const state = game();
    const token = put(state, rushToken.id, slot("p1", "units", 1));
    const run = runner(state);

    run.apply(sacrifice({ target: chosen }), token);

    expect(cardAt(state, slot("p1", "units", 1))).toBeNull();
    expect(state.players.p1.graveyard).toHaveLength(0);
    expect(state.players.p1.exile).toHaveLength(0);
    expect(eventsOfType(run.events, "destroyed").map((e) => e.instanceId)).toEqual([token.id]);
    expect(eventsOfType(run.events, "enteredGraveyard")).toEqual([]);
  });

  it("§6.3 refuses an enemy unit unless a Tribute allows it (#55)", () => {
    const state = game();
    const theirs = put(state, "fx-4", slot("p2", "units", 1));
    const run = runner(state);

    run.apply(sacrifice({ target: chosen }), theirs, { controller: "p1" });

    expect(cardAt(state, slot("p2", "units", 1))?.id).toBe(theirs.id);
    expect(run.events).toEqual([]);

    run.apply(sacrifice({ target: chosen, allowEnemy: true }), theirs, { controller: "p1" });

    expect(cardAt(state, slot("p2", "units", 1))).toBeNull();
    expect(state.players.p2.graveyard.map((c) => c.id)).toEqual([theirs.id]);
  });

  it("R12 a sacrificed stolen unit goes to its owner's graveyard", () => {
    const state = game();
    const theirs = newInstance(state, "fx-4", "p2", { z: "hand", player: "p2" });
    expect(placeOnField(state, theirs, slot("p1", "units", 1))).toBe(true);
    const run = runner(state);

    run.apply(sacrifice({ target: chosen }), theirs, { controller: "p1" });

    expect(state.players.p2.graveyard.map((c) => c.id)).toEqual([theirs.id]);
    expect(state.players.p1.graveyard).toHaveLength(0);
  });

  it("§6.3 does nothing for a card that is not on the field", () => {
    const state = game();
    const card = newInstance(state, dier.id, "p1", { z: "hand", player: "p1" });
    state.players.p1.hand.push(card);
    const run = runner(state);

    run.apply(sacrifice({ target: chosen }), card);

    expect(state.players.p1.hand.map((c) => c.id)).toEqual([card.id]);
    expect(state.counters.destroyed).toBe(0);
    expect(run.events).toEqual([]);
  });
});
