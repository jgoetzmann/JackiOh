// Make Radiant (SPEC §6.3, §5.2, BUILD M3-T1): the on-field layer swap without a Cry (R22), a card
// with no radiant form still setting the flag (R74), and R60's random picks. The fixture cards
// these tests need are registered here, so no shared fixture has to grow for them (BUILD §0).

import type { CardDef, GameEvent } from "@jackioh/shared";
import { describe, expect, it } from "vitest";
import { registerCatalog, registeredCatalog } from "../src/catalog";
import { HERO_HEALTH } from "../src/config";
import { damage } from "../src/effects/damage";
import { setRadiant, setRadiantRandom } from "../src/effects/radiant";
import { unitHas, unitView } from "../src/layers";
import { makeContext, type HookOptions } from "../src/resolve";
import type { CardScripts, Effect } from "../src/script";
import { registerScripts, registeredScripts } from "../src/scripts";
import { newInstance, type CardInstance, type GameState } from "../src/state";
import { placeOnField } from "../src/zones";
import { unitDef } from "./fixtures/catalog";
import { plain, stacker } from "./fixtures/combat";
import { eventsOfType, inHand, newGame, put, setLibrary, sinkFor, slot } from "./fixtures/harness";

/** A Cry that would be loud if making a card Radiant ever re-fired one (R22). */
const crier = unitDef(731, { id: "rd-crier", name: "Crier (fixture)", attack: 2, health: 2 });
/** A radiant face that adds Taunt to a base face with no keywords (§5.2). */
const glowUp: CardDef = {
  ...unitDef(732, { id: "rd-glow-up", name: "Glow Up (fixture)", attack: 2, health: 2 }),
  radiant: { attack: 4, health: 4, keywords: [{ kind: "Taunt" }], text: "radiant" },
};
/** R74: a card with no listed Radiant form is unchanged by it, but the flag still sets. */
const noForm: CardDef = {
  ...unitDef(733, { id: "rd-no-form", name: "No Radiant Form (fixture)", attack: 3, health: 3 }),
  radiant: { attack: 3, health: 3, keywords: [], text: "same" },
};

const SCRIPTS: Record<string, CardScripts> = {
  [crier.id]: {
    base: { cry: () => [damage({ to: { of: "enemyHero" }, amount: 5 })] },
    radiant: { cry: () => [damage({ to: { of: "enemyHero" }, amount: 9 })] },
  },
};

function game(seed = "radiant-test"): GameState {
  const state = newGame(seed);
  registerCatalog({
    ...registeredCatalog(),
    [crier.id]: crier,
    [glowUp.id]: glowUp,
    [noForm.id]: noForm,
  });
  registerScripts({ ...registeredScripts(), ...SCRIPTS });
  return state;
}

/** Apply one effect the way `resolve.ts` does, and hand back the events it emitted. */
function run(
  state: GameState,
  effect: Effect,
  options: HookOptions & { self?: CardInstance | null } = {},
): GameEvent[] {
  const { self = null, ...hook } = options;
  const sink = sinkFor(state);
  const ctx = makeContext(sink, self, hook);
  effect.apply(ctx);
  state.rngCursor = sink.rng.cursor;
  return sink.events;
}

const radiantIds = (events: readonly GameEvent[]): string[] =>
  eventsOfType(events, "radiantSet").map((e) => e.instanceId);

describe("Make Radiant on a named card (§6.3, §5.2, R22, R74, M3-T1)", () => {
  it("R22 swaps the base-stat layer at once, keeps damage and buffs, and re-fires no Cry", () => {
    const state = game();
    // The fixture 2/2 has a 4/4 radiant face.
    const unit = put(state, crier.id, slot("p1", "units", 2));
    unit.damage = 1;
    unit.buffs = { attack: 1, health: 1 };
    expect(unitView(state, unit).attack).toBe(3);
    expect(unitView(state, unit).health).toBe(2);

    const events = run(state, setRadiant({ instanceId: unit.id }), { controller: "p1" });

    expect(unit.radiant).toBe(true);
    const view = unitView(state, unit);
    // Printed 2/2 becomes 4/4 and the layer-4 buff is still on top of it.
    expect(view.attack).toBe(5);
    expect(view.maxHealth).toBe(5);
    // Damage taken stays, so health is the new max minus the damage already on the card.
    expect(view.health).toBe(4);
    expect(unit.damage).toBe(1);
    expect(unit.buffs).toEqual({ attack: 1, health: 1 });

    // R22: the Cry does not re-fire, so the enemy hero takes nothing.
    expect(state.players.p2.hero.health).toBe(HERO_HEALTH);
    expect(events).toEqual([
      {
        type: "radiantSet",
        instanceId: unit.id,
        defId: crier.id,
        zone: { z: "field", player: "p1", row: "units", lane: 2 },
      },
    ]);
  });

  it("R22 applies a keyword the radiant face adds at once", () => {
    const state = game();
    const unit = put(state, glowUp.id, slot("p1", "units", 1));
    expect(unitHas(state, unit, "Taunt")).toBe(false);

    run(state, setRadiant({ instanceId: unit.id }), { controller: "p1" });

    expect(unitHas(state, unit, "Taunt")).toBe(true);
    expect(unitView(state, unit).attack).toBe(4);
  });

  it("R22 #81 targets the card whose script is running, so Radiant Saintess includes itself", () => {
    const state = game();
    const saintess = put(state, plain.id, slot("p1", "units", 4));

    const events = run(state, setRadiant({ target: { of: "self" } }), { self: saintess });

    expect(saintess.radiant).toBe(true);
    expect(radiantIds(events)).toEqual([saintess.id]);
    expect(unitView(state, saintess).attack).toBe(6);
  });

  it("§6.3 does nothing to a card that is already Radiant", () => {
    const state = game();
    const unit = put(state, plain.id, slot("p1", "units", 1), { radiant: true });

    expect(run(state, setRadiant({ instanceId: unit.id }), { controller: "p1" })).toEqual([]);
    expect(unit.radiant).toBe(true);
  });

  it("R74 sets the flag on a card whose radiant form is the same as its base", () => {
    const state = game();
    const unit = put(state, noForm.id, slot("p1", "units", 1));

    const events = run(state, setRadiant({ instanceId: unit.id }), { controller: "p1" });

    // The flag still sets, so counting effects behave, and the stats are unchanged.
    expect(unit.radiant).toBe(true);
    expect(radiantIds(events)).toEqual([unit.id]);
    expect(unitView(state, unit).attack).toBe(3);
    expect(unitView(state, unit).maxHealth).toBe(3);
  });

  it("§5.2 swaps a hand card's stats and text where it sits", () => {
    const state = game();
    const [card] = inHand(state, plain.id, "p1");
    const held = card as CardInstance;

    const events = run(state, setRadiant({ instanceId: held.id }), { controller: "p1" });

    expect(held.radiant).toBe(true);
    expect(held.zone).toEqual({ z: "hand", player: "p1" });
    expect(unitView(state, held).attack).toBe(6);
    expect(eventsOfType(events, "radiantSet")[0]?.zone).toEqual({ z: "hand", player: "p1" });
  });

  it("makes nothing Radiant when no target was picked", () => {
    const state = game();
    expect(run(state, setRadiant(), { controller: "p1" })).toEqual([]);
  });
});

describe("Make Radiant at random (R60, M3-T1)", () => {
  it("R60 chooses only among non-Radiant cards", () => {
    const state = game();
    const hand = inHand(state, plain.id, "p1", 3);
    (hand[0] as CardInstance).radiant = true;
    (hand[2] as CardInstance).radiant = true;

    const events = run(state, setRadiantRandom({ zones: "hand", count: 3 }), { controller: "p1" });

    // Only one card was eligible, so only it changes: a pick never lands on a Radiant card.
    expect(hand.map((card) => (card as CardInstance).radiant)).toEqual([true, true, true]);
    // R177: the two picks R60 could not make are cued on the hand's Radiant cards, in hand order,
    // so the other seat's stream holds three cues whatever the hidden hand held.
    expect(radiantIds(events)).toEqual([hand[1], hand[0], hand[2]].map((card) => (card as CardInstance).id));
  });

  it("R60 changes no card and draws nothing when no non-Radiant card is left, though the hidden hand is cued (R177, R129)", () => {
    const state = game();
    const hand = inHand(state, plain.id, "p1", 2);
    for (const card of hand) (card as CardInstance).radiant = true;
    const cursor = state.rngCursor;

    const events = run(state, setRadiantRandom({ zones: "hand", count: 2 }), { controller: "p1" });
    // Nothing changes and no random number is drawn (R129)...
    expect(state.rngCursor).toBe(cursor);
    expect(hand.every((card) => (card as CardInstance).radiant)).toBe(true);
    // ...and the hidden hand is cued as a pick of two would cue it (R177).
    expect(radiantIds(events)).toEqual(hand.map((card) => (card as CardInstance).id));
  });

  it("R60 #28 picks N different cards from the union of hand, library and field", () => {
    const state = game();
    const hand = inHand(state, plain.id, "p1", 2);
    const library = setLibrary(state, "p1", [plain.id, crier.id]);
    const onField = put(state, plain.id, slot("p1", "units", 1));
    const pool = [...hand, ...library, onField];

    const events = run(state, setRadiantRandom({ zones: ["hand", "library", "field"], count: 4 }), {
      controller: "p1",
    });

    const picked = radiantIds(events);
    expect(picked).toHaveLength(4);
    expect(new Set(picked).size).toBe(4);
    expect(picked.every((id) => pool.some((card) => card.id === id))).toBe(true);
    expect(pool.filter((card) => card.radiant)).toHaveLength(4);

    // More than the pool holds takes all of it (R60).
    const all = game();
    const allHand = inHand(all, plain.id, "p1", 2);
    const allField = put(all, plain.id, slot("p1", "units", 1));
    const everything = run(all, setRadiantRandom({ zones: ["hand", "field"], count: 9 }), {
      controller: "p1",
    });
    expect(new Set(radiantIds(everything))).toEqual(new Set([...allHand, allField].map((card) => card.id)));
  });

  it("R13 offers only the top of a Stack pile, never the dormant card beneath", () => {
    const state = game();
    const beneath = put(state, plain.id, slot("p1", "units", 3));
    const top = newInstance(state, stacker.id, "p1", { z: "hand", player: "p1" });
    expect(placeOnField(state, top, slot("p1", "units", 3), { stack: true })).toBe(true);

    const events = run(state, setRadiantRandom({ zones: "field", count: 5 }), { controller: "p1" });

    expect(radiantIds(events)).toEqual([top.id]);
    expect(beneath.radiant).toBe(false);
  });

  it("reads the enemy's zone when the effect names it", () => {
    const state = game();
    const [mine] = inHand(state, plain.id, "p1");
    const [theirs] = inHand(state, plain.id, "p2");

    const events = run(state, setRadiantRandom({ zones: "hand", player: "enemy", count: 1 }), {
      controller: "p1",
    });

    expect(radiantIds(events)).toEqual([(theirs as CardInstance).id]);
    expect((mine as CardInstance).radiant).toBe(false);
  });

  it("draws from the match rng, so the same seed picks the same cards and another seed does not", () => {
    const picks = (seed: string): string[] => {
      const state = game(seed);
      inHand(state, plain.id, "p1", 6);
      return radiantIds(run(state, setRadiantRandom({ zones: "hand", count: 2 }), { controller: "p1" }));
    };

    expect(picks("radiant-seed-a")).toEqual(picks("radiant-seed-a"));
    expect(picks("radiant-seed-a")).not.toEqual(picks("radiant-seed-b"));
    // The pick also moves the cursor on, so nothing draws the same numbers twice.
    const state = game();
    inHand(state, plain.id, "p1", 6);
    expect(state.rngCursor).toBe(0);
    run(state, setRadiantRandom({ zones: "hand", count: 2 }), { controller: "p1" });
    expect(state.rngCursor).toBeGreaterThan(0);
  });
});
