// The heal effect (BUILD M3-T1): §6.3's three readings of Heal — "heal X", "heal to full" and
// "heal up to N" — over R19's target set, a unit capped at its max health and a hero uncapped (§3).

import type { PlayerId, Selection } from "@jackioh/shared";
import { describe, expect, it } from "vitest";
import { HERO_HEALTH } from "../src/config";
import { heal } from "../src/effects/heal";
import { unitView } from "../src/layers";
import type { EngineSink } from "../src/resolve";
import { makeContext } from "../src/resolve";
import type { Effect } from "../src/script";
import type { CardInstance } from "../src/state";
import { bigBody, plain } from "./fixtures/combat";
import { eventsOfType, newGame, put, sinkFor, slot } from "./fixtures/harness";

function run(
  sink: EngineSink,
  effect: Effect,
  options: { self?: CardInstance | null; controller?: PlayerId; targets?: Selection[] } = {},
): void {
  const { self = null, ...rest } = options;
  effect.apply(makeContext(sink, self, rest));
}

function onInstance(instance: CardInstance): Selection[] {
  return [{ pick: "instance", instanceId: instance.id }];
}

describe("heal X (§6.3, R19, M3-T1)", () => {
  it("R19: heal X takes damage off a unit and never past its max health", () => {
    const state = newGame("heal-unit");
    const unit = put(state, bigBody.id, slot("p2", "units", 1)); // 5/10
    unit.damage = 6;
    const sink = sinkFor(state);

    run(sink, heal({ target: { of: "chosen" }, amount: 4 }), { targets: onInstance(unit) });
    expect(unit.damage).toBe(2);
    expect(unitView(state, unit).health).toBe(8);

    // A bigger heal than there is damage stops at the max health and heals only what was missing.
    run(sink, heal({ target: { of: "chosen" }, amount: 99 }), { targets: onInstance(unit) });
    expect(unit.damage).toBe(0);
    expect(unitView(state, unit).health).toBe(10);
    expect(eventsOfType(sink.events, "healed")).toEqual([
      { type: "healed", targetId: unit.id, amount: 4 },
      { type: "healed", targetId: unit.id, amount: 2 },
    ]);

    // An undamaged unit heals nothing and emits nothing.
    run(sink, heal({ target: { of: "self" }, amount: 5 }), { self: unit });
    expect(eventsOfType(sink.events, "healed")).toHaveLength(2);
  });

  it("§10.4: the cap a unit heals to is its buffed max health, read through the layers", () => {
    const state = newGame("heal-buffed");
    const unit = put(state, bigBody.id, slot("p1", "units", 1)); // 5/10
    unit.buffs = { attack: 0, health: 5 }; // layer 4: max health 15
    unit.damage = 12;
    const sink = sinkFor(state);

    run(sink, heal({ target: { of: "self" }, amount: 20 }), { self: unit });

    expect(unit.damage).toBe(0);
    expect(unitView(state, unit).health).toBe(15);
    expect(eventsOfType(sink.events, "healed")).toEqual([
      { type: "healed", targetId: unit.id, amount: 12 },
    ]);
  });

  it("R19: heal X gives a hero health with no cap, on either side (#5, #47)", () => {
    const state = newGame("heal-hero");
    const sink = sinkFor(state);

    run(sink, heal({ target: { of: "selfHero" }, amount: 20 }), { controller: "p1" });
    expect(state.players.p1.hero.health).toBe(HERO_HEALTH + 20);

    state.players.p2.hero.health = 8;
    run(sink, heal({ target: { of: "enemyHero" }, amount: 50 }), { controller: "p1" });
    expect(state.players.p2.hero.health).toBe(58);

    run(sink, heal({ target: { of: "chosen" }, amount: 2 }), {
      targets: [{ pick: "hero", player: "p2" }],
    });
    expect(state.players.p2.hero.health).toBe(60);
    expect(eventsOfType(sink.events, "healed").map((e) => [e.targetId, e.amount])).toEqual([
      ["hero-p1", 20],
      ["hero-p2", 50],
      ["hero-p2", 2],
    ]);
  });

  it("heals nothing when there is no target, and a non-positive amount does nothing", () => {
    const state = newGame("heal-fizzle");
    const unit = put(state, bigBody.id, slot("p1", "units", 1));
    unit.damage = 3;
    const sink = sinkFor(state);

    run(sink, heal({ target: { of: "chosen" }, amount: 5 }), { targets: [] });
    run(sink, heal({ target: { of: "self" }, amount: 5 }), { self: null });
    run(sink, heal({ target: { of: "self" }, amount: 0 }), { self: unit });
    run(sink, heal({ target: { of: "selfHero" }, amount: -5 }), { controller: "p1" });

    expect(unit.damage).toBe(3);
    expect(state.players.p1.hero.health).toBe(HERO_HEALTH);
    expect(sink.events).toHaveLength(0);
  });
});

describe("heal to full and heal up to N (§6.3, M3-T1)", () => {
  it("#19: heal to full removes all of a unit's damage", () => {
    const state = newGame("heal-full");
    const unit = put(state, bigBody.id, slot("p1", "units", 1)); // 5/10
    unit.damage = 9;
    const sink = sinkFor(state);

    run(sink, heal({ target: { of: "self" }, toFull: true }), { self: unit });

    expect(unit.damage).toBe(0);
    expect(unitView(state, unit).health).toBe(10);
    expect(eventsOfType(sink.events, "healed")).toEqual([
      { type: "healed", targetId: unit.id, amount: 9 },
    ]);

    // Already at full: nothing to remove, nothing emitted.
    run(sink, heal({ target: { of: "self" }, toFull: true }), { self: unit });
    expect(eventsOfType(sink.events, "healed")).toHaveLength(1);
  });

  it("§3: a hero has no maximum health, so heal to full leaves it alone", () => {
    const state = newGame("heal-full-hero");
    state.players.p1.hero.health = 4;
    const sink = sinkFor(state);

    run(sink, heal({ target: { of: "selfHero" }, toFull: true }), { controller: "p1" });

    expect(state.players.p1.hero.health).toBe(4);
    expect(sink.events).toHaveLength(0);
  });

  it("§6.3: heal up to N raises a hero to N and never lowers one already above it", () => {
    const state = newGame("heal-upto-hero");
    state.players.p1.hero.health = 12;
    const sink = sinkFor(state);

    run(sink, heal({ target: { of: "selfHero" }, upTo: 30 }), { controller: "p1" });
    expect(state.players.p1.hero.health).toBe(30);
    expect(eventsOfType(sink.events, "healed")).toEqual([
      { type: "healed", targetId: "hero-p1", amount: 18 },
    ]);

    run(sink, heal({ target: { of: "selfHero" }, upTo: 30 }), { controller: "p1" });
    expect(state.players.p1.hero.health).toBe(30);
    expect(eventsOfType(sink.events, "healed")).toHaveLength(1);

    state.players.p2.hero.health = 45;
    run(sink, heal({ target: { of: "enemyHero" }, upTo: 30 }), { controller: "p1" });
    expect(state.players.p2.hero.health).toBe(45);
  });

  it("§6.3: heal up to N on a unit stops at N, and at the unit's max health", () => {
    const state = newGame("heal-upto-unit");
    const unit = put(state, bigBody.id, slot("p1", "units", 1)); // 5/10
    unit.damage = 8; // health 2
    const other = put(state, plain.id, slot("p1", "units", 2)); // 3/3
    other.damage = 2;
    const sink = sinkFor(state);

    run(sink, heal({ target: { of: "self" }, upTo: 6 }), { self: unit });
    expect(unitView(state, unit).health).toBe(6);
    expect(unit.damage).toBe(4);

    // Past the max health, the heal removes only the damage that is left (§6.3).
    run(sink, heal({ target: { of: "self" }, upTo: 30 }), { self: unit });
    expect(unit.damage).toBe(0);
    expect(unitView(state, unit).health).toBe(10);

    // A unit already at or above N is untouched.
    run(sink, heal({ target: { of: "chosen" }, upTo: 1 }), { targets: onInstance(other) });
    expect(other.damage).toBe(2);
    expect(eventsOfType(sink.events, "healed").map((e) => e.amount)).toEqual([4, 4]);
  });
});
