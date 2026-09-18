// Steal (SPEC §6.3, BUILD M3-T1): R15's placement, R12's ownership, R33's face-down trap and
// #86's "steal all enemy units". The fixture Trap this file needs is registered here, so no shared
// fixture has to grow for it (BUILD §0).

import type { CardDef, GameEvent } from "@jackioh/shared";
import { describe, expect, it } from "vitest";
import { registerCatalog, registeredCatalog } from "../src/catalog";
import { steal, stealAll } from "../src/effects/steal";
import { unitView } from "../src/layers";
import { makeContext, type HookOptions } from "../src/resolve";
import type { Effect } from "../src/script";
import { newInstance, type CardInstance, type GameState } from "../src/state";
import { activeUnitsOf, cardAt, lockZone, moveToZone, placeOnField } from "../src/zones";
import { spellDef } from "./fixtures/catalog";
import { plain, stacker } from "./fixtures/combat";
import { eventsOfType, inHand, newGame, put, sinkFor, slot } from "./fixtures/harness";

/** A face-down Trap for R33; #36 radiant steals a backrow card. */
const trap: CardDef = spellDef(710, { id: "st-trap", index: "710", name: "Steal Trap (fixture)", type: "Trap" });

function game(): GameState {
  const state = newGame("steal-test");
  registerCatalog({ ...registeredCatalog(), [trap.id]: trap });
  return state;
}

/** Apply one effect the way `resolve.ts` does, and hand back the events it emitted. */
function run(state: GameState, effect: Effect, options: HookOptions = {}): GameEvent[] {
  const sink = sinkFor(state);
  const ctx = makeContext(sink, null, options);
  effect.apply(ctx);
  state.rngCursor = sink.rng.cursor;
  return sink.events;
}

const controls = (state: GameState, card: CardInstance): GameEvent[] => run(state, steal({ instanceId: card.id }), { controller: "p1" });

describe("steal (§6.3, R15, M3-T1)", () => {
  it("R15 takes the same lane when it is free, and moves control only", () => {
    const state = game();
    const victim = put(state, plain.id, slot("p2", "units", 3));
    victim.damage = 1;
    victim.buffs = { attack: 2, health: 0 };
    victim.position = "DEF";
    victim.counters = { plague: 2 };
    victim.exertion = { attacked: true, switched: false };

    const events = controls(state, victim);

    expect(cardAt(state, slot("p1", "units", 3))?.id).toBe(victim.id);
    expect(cardAt(state, slot("p2", "units", 3))).toBeNull();
    expect(victim.controller).toBe("p1");
    // R12: ownership never moves.
    expect(victim.owner).toBe("p2");
    expect(victim.zone).toEqual({ z: "field", player: "p1", row: "units", lane: 3 });

    // The card never left the field, so R78's reset does not apply: everything on it stays.
    expect(victim.damage).toBe(1);
    expect(victim.buffs).toEqual({ attack: 2, health: 0 });
    expect(victim.position).toBe("DEF");
    expect(victim.counters).toEqual({ plague: 2 });
    expect(victim.exertion).toEqual({ attacked: true, switched: false });
    expect(unitView(state, victim).attack).toBe(5);

    expect(eventsOfType(events, "controlChanged")).toEqual([
      { type: "controlChanged", instanceId: victim.id, controller: "p1", row: "units", lane: 3 },
    ]);
  });

  it("R15 falls back to the first free zone when the same lane is taken or Locked", () => {
    const state = game();
    put(state, plain.id, slot("p1", "units", 1));
    put(state, plain.id, slot("p1", "units", 3));
    const victim = put(state, plain.id, slot("p2", "units", 3));

    const events = controls(state, victim);

    expect(cardAt(state, slot("p1", "units", 2))?.id).toBe(victim.id);
    expect(eventsOfType(events, "controlChanged")[0]?.lane).toBe(2);

    // An empty but Locked same lane is not free either, so the fallback applies again (§3.2).
    const locked = game();
    const other = put(locked, plain.id, slot("p2", "units", 4));
    lockZone(locked, slot("p1", "units", 4));

    expect(eventsOfType(controls(locked, other), "controlChanged")[0]?.lane).toBe(1);
    expect(cardAt(locked, slot("p1", "units", 1))?.id).toBe(other.id);
  });

  it("R15 leaves a card with nowhere to go with its owner", () => {
    const state = game();
    for (let lane = 1; lane <= 5; lane += 1) put(state, plain.id, slot("p1", "units", lane));
    const victim = put(state, plain.id, slot("p2", "units", 2));

    const events = controls(state, victim);

    expect(cardAt(state, slot("p2", "units", 2))?.id).toBe(victim.id);
    expect(victim.controller).toBe("p2");
    expect(events).toHaveLength(0);
  });

  it("R12 keeps the owner, so a stolen unit that dies goes to its owner's graveyard", () => {
    const state = game();
    const victim = put(state, plain.id, slot("p2", "units", 1));
    controls(state, victim);
    expect(victim.controller).toBe("p1");

    moveToZone(state, victim, "graveyard");

    expect(state.players.p2.graveyard.map((card) => card.id)).toEqual([victim.id]);
    expect(state.players.p1.graveyard).toHaveLength(0);
    // R78: leaving the field hands control back to the owner.
    expect(victim.controller).toBe("p2");
  });

  it("R33 leaves a stolen face-down trap face-down, under its new controller", () => {
    const state = game();
    const hidden = put(state, trap.id, slot("p2", "backrow", 4));
    expect(hidden.faceUp).toBeUndefined();

    const events = controls(state, hidden);

    expect(cardAt(state, slot("p1", "backrow", 4))?.id).toBe(hidden.id);
    expect(hidden.controller).toBe("p1");
    expect(hidden.owner).toBe("p2");
    // The steal never flips the card: `controller` is what decides who may read it (R33).
    expect(hidden.faceUp).toBeUndefined();
    expect(eventsOfType(events, "controlChanged")).toEqual([
      { type: "controlChanged", instanceId: hidden.id, controller: "p1", row: "backrow", lane: 4 },
    ]);
  });

  it("R13 steals the top of a Stack pile and leaves the card beneath to resume", () => {
    const state = game();
    const beneath = put(state, plain.id, slot("p2", "units", 2));
    const top = newInstance(state, stacker.id, "p2", { z: "hand", player: "p2" });
    expect(placeOnField(state, top, slot("p2", "units", 2), { stack: true })).toBe(true);

    controls(state, top);

    expect(cardAt(state, slot("p1", "units", 2))?.id).toBe(top.id);
    expect(cardAt(state, slot("p2", "units", 2))?.id).toBe(beneath.id);
    expect(activeUnitsOf(state, "p2").map((card) => card.id)).toEqual([beneath.id]);
    expect(state.players.p1.units[1]).toHaveLength(1);
  });

  it("R15 #86 steals every enemy unit in lane order and leaves the excess with its owner", () => {
    const state = game();
    put(state, plain.id, slot("p1", "units", 1));
    put(state, plain.id, slot("p1", "units", 2));
    const enemies = [1, 2, 3, 4, 5].map((lane) => put(state, plain.id, slot("p2", "units", lane)));

    const events = run(state, stealAll(), { controller: "p1" });

    // Lane 1 and 2 are taken, so the first two land in lanes 3 and 4; the third takes lane 5 and
    // the last two find nothing free.
    expect(cardAt(state, slot("p1", "units", 3))?.id).toBe(enemies[0]?.id);
    expect(cardAt(state, slot("p1", "units", 4))?.id).toBe(enemies[1]?.id);
    expect(cardAt(state, slot("p1", "units", 5))?.id).toBe(enemies[2]?.id);
    expect(cardAt(state, slot("p2", "units", 4))?.id).toBe(enemies[3]?.id);
    expect(cardAt(state, slot("p2", "units", 5))?.id).toBe(enemies[4]?.id);
    expect(enemies.map((card) => card.controller)).toEqual(["p1", "p1", "p1", "p2", "p2"]);
    expect(eventsOfType(events, "controlChanged").map((e) => [e.instanceId, e.lane])).toEqual([
      [enemies[0]?.id, 3],
      [enemies[1]?.id, 4],
      [enemies[2]?.id, 5],
    ]);
  });

  it("steals nothing off the field, nothing already yours, and nothing when no target was picked", () => {
    const state = game();
    const [inYourHand] = inHand(state, plain.id, "p2");
    const mine = put(state, plain.id, slot("p1", "units", 1));
    const theirs = put(state, plain.id, slot("p2", "units", 2));

    // Off the field control means nothing, so a hand card is untouched (R12).
    expect(controls(state, inYourHand as CardInstance)).toHaveLength(0);
    expect((inYourHand as CardInstance).controller).toBe("p2");
    expect(state.players.p2.hand.map((card) => card.id)).toEqual([(inYourHand as CardInstance).id]);

    // R76: a card already under your control is not stolen again, and nothing moves lane.
    expect(controls(state, mine)).toHaveLength(0);
    expect(cardAt(state, slot("p1", "units", 1))?.id).toBe(mine.id);

    // An empty `targets` list fizzles rather than picking something (§8 conventions).
    expect(run(state, steal(), { controller: "p1" })).toHaveLength(0);
    expect(theirs.controller).toBe("p2");
  });
});
