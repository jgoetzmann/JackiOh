// Transform and Vanilla (SPEC §6.3, BUILD M3-T1): replacement in place with no Cry (R1), the
// replaced card ceasing to exist (R35), Immutable refusing both (R23), and Vanilla clearing
// printed keywords only (§6.3, §10.4). The fixture cards these tests need are registered here, so
// no shared fixture has to grow for them (BUILD §0).

import type { CardDef, GameEvent } from "@jackioh/shared";
import { describe, expect, it } from "vitest";
import { registerCatalog, registeredCatalog } from "../src/catalog";
import { isSick } from "../src/combat";
import { HERO_HEALTH } from "../src/config";
import { transform, vanilla } from "../src/effects/transform";
import { damage } from "../src/effects/damage";
import { unitHas, unitView } from "../src/layers";
import { makeContext, type HookOptions } from "../src/resolve";
import type { CardScripts, Effect } from "../src/script";
import { registerScripts, registeredScripts } from "../src/scripts";
import { findInstance, newInstance, type CardInstance, type GameState } from "../src/state";
import { activeUnitsOf, cardAt, placeOnField } from "../src/zones";
import { spellDef, unitDef } from "./fixtures/catalog";
import { plain, stacker, taunter } from "./fixtures/combat";
import { eventsOfType, inHand, newGame, put, setLibrary, sinkFor, slot } from "./fixtures/harness";

/** A Cry that would be loud if a Transform ever fired one (R1). */
const crier = unitDef(721, { id: "tf-crier", name: "Crier (fixture)", attack: 2, health: 2 });
/** A Death that would be loud if the replaced card ever reached a graveyard (§6.2, R35). */
const mourner = unitDef(722, { id: "tf-mourner", name: "Mourner (fixture)", attack: 3, health: 3 });
/** #8 Mr. Vanilla: Immutable text (§6.1). */
const immutable = unitDef(723, {
  id: "tf-immutable",
  name: "Immutable (fixture)",
  attack: 4,
  health: 4,
  keywords: [{ kind: "Immutable" }],
});
/** #41's Sheep Token: what a Transform turns a played unit into. */
const sheep = unitDef(724, {
  id: "tf-sheep",
  name: "Sheep Token (fixture)",
  attack: 1,
  health: 1,
  token: true,
  rarity: "Token",
  tags: ["Token"],
});
const fieldSpell: CardDef = spellDef(725, {
  id: "tf-field",
  index: "725",
  name: "Field Spell (fixture)",
  type: "Field Spell",
});
const trapCard: CardDef = spellDef(726, {
  id: "tf-trap",
  index: "726",
  name: "Trap (fixture)",
  type: "Trap",
});
const oneShot: CardDef = spellDef(727, { id: "tf-spell", index: "727", name: "Spell (fixture)" });

const SCRIPTS: Record<string, CardScripts> = {
  [crier.id]: {
    base: { cry: () => [damage({ to: { of: "enemyHero" }, amount: 5 })] },
    radiant: { cry: () => [damage({ to: { of: "enemyHero" }, amount: 5 })] },
  },
  [mourner.id]: {
    base: { death: () => [damage({ to: { of: "enemyHero" }, amount: 7 })] },
    radiant: { death: () => [damage({ to: { of: "enemyHero" }, amount: 7 })] },
  },
};

function game(): GameState {
  const state = newGame("transform-test");
  registerCatalog({
    ...registeredCatalog(),
    [crier.id]: crier,
    [mourner.id]: mourner,
    [immutable.id]: immutable,
    [sheep.id]: sheep,
    [fieldSpell.id]: fieldSpell,
    [trapCard.id]: trapCard,
    [oneShot.id]: oneShot,
  });
  registerScripts({ ...registeredScripts(), ...SCRIPTS });
  state.turn = 4;
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

describe("transform (§6.3, R23, R35, M3-T1)", () => {
  it("replaces a card in place with a new instance of the new definition, and fires no Cry (R1)", () => {
    const state = game();
    const old = put(state, plain.id, slot("p1", "units", 3));
    old.position = "DEF";
    old.damage = 2;

    const events = run(state, transform({ instanceId: old.id, defId: crier.id }), { controller: "p1" });

    const now = cardAt(state, slot("p1", "units", 3));
    expect(now).not.toBeNull();
    expect(now?.id).not.toBe(old.id);
    expect(now?.defId).toBe(crier.id);
    expect(now?.owner).toBe("p1");
    expect(now?.controller).toBe("p1");
    expect(now?.position).toBe("DEF");
    expect(now?.zone).toEqual({ z: "field", player: "p1", row: "units", lane: 3 });
    // A fresh instance: the old card's damage does not come with it, and the new body is sick.
    expect(now?.damage).toBe(0);
    expect(now?.radiant).toBe(false);
    expect(isSick(state, now as CardInstance)).toBe(true);
    expect(unitView(state, now as CardInstance).attack).toBe(2);

    // R1: a Transform result never fires a Cry, so the enemy hero is untouched.
    expect(state.players.p2.hero.health).toBe(HERO_HEALTH);
    expect(events).toEqual([
      {
        type: "transformed",
        instanceId: old.id,
        fromDefId: plain.id,
        toDefId: crier.id,
        newInstanceId: now?.id,
      },
    ]);
  });

  it("R35 the replaced card ceases to exist: no graveyard, no exile and no Death", () => {
    const state = game();
    const old = put(state, mourner.id, slot("p1", "units", 1));

    const events = run(state, transform({ instanceId: old.id, defId: sheep.id }), { controller: "p1" });

    expect(findInstance(state, old.id)).toBeUndefined();
    expect(state.players.p1.graveyard).toHaveLength(0);
    expect(state.players.p1.exile).toHaveLength(0);
    expect(state.counters.destroyed).toBe(0);
    // §6.2: Death does not fire on a transform, so the enemy hero takes nothing.
    expect(state.players.p2.hero.health).toBe(HERO_HEALTH);
    expect(eventsOfType(events, "destroyed")).toHaveLength(0);
    expect(eventsOfType(events, "enteredGraveyard")).toHaveLength(0);
    expect(cardAt(state, slot("p1", "units", 1))?.defId).toBe(sheep.id);
  });

  it("R23 refuses a Transform on an Immutable card, printed or granted", () => {
    const state = game();
    const printed = put(state, immutable.id, slot("p1", "units", 1));
    const granted = put(state, plain.id, slot("p1", "units", 2));
    granted.grantedKeywords.push({ kind: "Immutable" });

    expect(run(state, transform({ instanceId: printed.id, defId: sheep.id }), { controller: "p1" })).toEqual([]);
    expect(run(state, transform({ instanceId: granted.id, defId: sheep.id }), { controller: "p1" })).toEqual([]);

    expect(cardAt(state, slot("p1", "units", 1))?.id).toBe(printed.id);
    expect(cardAt(state, slot("p1", "units", 2))?.id).toBe(granted.id);
    expect(printed.defId).toBe(immutable.id);
    expect(granted.defId).toBe(plain.id);

    // A unit with no Immutable in the same spot is replaced, so the refusal is the keyword's work.
    const open = put(state, plain.id, slot("p1", "units", 3));
    expect(run(state, transform({ instanceId: open.id, defId: sheep.id }), { controller: "p1" })).toHaveLength(1);
    expect(cardAt(state, slot("p1", "units", 3))?.defId).toBe(sheep.id);
  });

  it("§3.2 replaces a backrow card in its lane, a Field Spell face-up and a Trap face-down (R33)", () => {
    const state = game();
    const hidden = put(state, trapCard.id, slot("p2", "backrow", 2));

    run(state, transform({ instanceId: hidden.id, defId: fieldSpell.id }), { controller: "p2" });

    const public_ = cardAt(state, slot("p2", "backrow", 2));
    expect(public_?.defId).toBe(fieldSpell.id);
    expect(public_?.faceUp).toBe(true);

    // The other way round: a Trap replacement is hidden again until it fires.
    const spell = put(state, fieldSpell.id, slot("p1", "backrow", 5));
    spell.faceUp = true;
    run(state, transform({ instanceId: spell.id, defId: trapCard.id }), { controller: "p1" });

    const back = cardAt(state, slot("p1", "backrow", 5));
    expect(back?.defId).toBe(trapCard.id);
    expect(back?.faceUp).toBeUndefined();
  });

  it("R13 keeps a Stack pile: the replacement is the top and the dormant card stays beneath", () => {
    const state = game();
    const beneath = put(state, plain.id, slot("p1", "units", 2));
    const top = newInstance(state, stacker.id, "p1", { z: "hand", player: "p1" });
    expect(placeOnField(state, top, slot("p1", "units", 2), { stack: true })).toBe(true);

    run(state, transform({ instanceId: top.id, defId: sheep.id }), { controller: "p1" });

    const pile = state.players.p1.units[1];
    expect(pile?.map((card) => card.defId)).toEqual([sheep.id, plain.id]);
    expect(activeUnitsOf(state, "p1").map((card) => card.defId)).toEqual([sheep.id]);
    expect(findInstance(state, top.id)).toBeUndefined();
    expect(findInstance(state, beneath.id)?.id).toBe(beneath.id);
  });

  it("R35 replaces a hand card and keeps a library card at its index", () => {
    const state = game();
    const hand = inHand(state, plain.id, "p1", 3);

    run(state, transform({ instanceId: (hand[1] as CardInstance).id, defId: sheep.id }), { controller: "p1" });

    // "Same counts" per zone (R35): one card out, one card in.
    expect(state.players.p1.hand).toHaveLength(3);
    expect(findInstance(state, (hand[1] as CardInstance).id)).toBeUndefined();
    expect(state.players.p1.hand.filter((card) => card.defId === sheep.id)).toHaveLength(1);
    expect(state.players.p1.hand.filter((card) => card.defId === plain.id)).toHaveLength(2);

    const library = setLibrary(state, "p2", [plain.id, mourner.id, crier.id]);
    run(state, transform({ instanceId: (library[1] as CardInstance).id, defId: sheep.id }), { controller: "p2" });

    // A library is ordered top to bottom, so the replacement takes the replaced card's place.
    expect(state.players.p2.library.map((card) => card.defId)).toEqual([plain.id, sheep.id, crier.id]);
    expect(state.players.p2.library[1]?.zone).toEqual({ z: "library", player: "p2" });
  });

  it("§5.1 refuses a definition that cannot live in the zone the old card occupies", () => {
    const state = game();
    const unit = put(state, plain.id, slot("p1", "units", 1));

    // A Spell is never a permanent, and a Trap belongs to the backrow, not a unit zone.
    expect(run(state, transform({ instanceId: unit.id, defId: oneShot.id }), { controller: "p1" })).toEqual([]);
    expect(run(state, transform({ instanceId: unit.id, defId: trapCard.id }), { controller: "p1" })).toEqual([]);
    expect(cardAt(state, slot("p1", "units", 1))?.id).toBe(unit.id);
    expect(unit.defId).toBe(plain.id);
  });

  it("transforms nothing when no target was picked", () => {
    const state = game();
    const unit = put(state, plain.id, slot("p1", "units", 1));

    expect(run(state, transform({ defId: sheep.id }), { controller: "p1" })).toEqual([]);
    expect(cardAt(state, slot("p1", "units", 1))?.id).toBe(unit.id);
  });

  it("makes a Radiant replacement when the effect asks for one (§5.2)", () => {
    const state = game();
    const old = put(state, plain.id, slot("p1", "units", 1));

    run(state, transform({ instanceId: old.id, defId: crier.id, radiant: true }), { controller: "p1" });

    const now = cardAt(state, slot("p1", "units", 1)) as CardInstance;
    expect(now.radiant).toBe(true);
    // The radiant face of the fixture doubles the printed stats.
    expect(unitView(state, now).attack).toBe(4);
    expect(unitView(state, now).maxHealth).toBe(4);
  });
});

describe("vanilla (§6.3, R23, M3-T1)", () => {
  it("clears printed keywords while stats, buffs, damage and granted keywords stay", () => {
    const state = game();
    // The fixture Taunt unit is a 2/5 with Taunt.
    const unit = put(state, taunter.id, slot("p1", "units", 1));
    unit.buffs = { attack: 1, health: 1 };
    unit.damage = 2;
    unit.grantedKeywords.push({ kind: "Rush" });
    expect(unitHas(state, unit, "Taunt")).toBe(true);

    const events = run(state, vanilla({ instanceId: unit.id }), { controller: "p1" });

    expect(unit.vanilla).toBe(true);
    expect(unitHas(state, unit, "Taunt")).toBe(false);
    // A granted keyword is another layer and is not printed text, so it survives (§10.4).
    expect(unitHas(state, unit, "Rush")).toBe(true);
    const view = unitView(state, unit);
    expect(view.attack).toBe(3);
    expect(view.maxHealth).toBe(6);
    expect(view.health).toBe(4);
    expect(unit.defId).toBe(taunter.id);

    // No instance is created and no definition changes, so both sides name the same card.
    expect(events).toEqual([
      {
        type: "transformed",
        instanceId: unit.id,
        fromDefId: taunter.id,
        toDefId: taunter.id,
        newInstanceId: unit.id,
      },
    ]);
  });

  it("R23 refuses a Vanilla on an Immutable card, printed or granted", () => {
    const state = game();
    const printed = put(state, immutable.id, slot("p1", "units", 1));
    const granted = put(state, taunter.id, slot("p1", "units", 2));
    granted.grantedKeywords.push({ kind: "Immutable" });

    expect(run(state, vanilla({ instanceId: printed.id }), { controller: "p1" })).toEqual([]);
    expect(run(state, vanilla({ instanceId: granted.id }), { controller: "p1" })).toEqual([]);

    expect(printed.vanilla).toBe(false);
    expect(granted.vanilla).toBe(false);
    expect(unitHas(state, printed, "Immutable")).toBe(true);
    expect(unitHas(state, granted, "Taunt")).toBe(true);
  });

  it("does nothing to a card that is already Vanilla, and nothing with no target picked", () => {
    const state = game();
    const unit = put(state, taunter.id, slot("p1", "units", 1));

    expect(run(state, vanilla({ instanceId: unit.id }), { controller: "p1" })).toHaveLength(1);
    expect(run(state, vanilla({ instanceId: unit.id }), { controller: "p1" })).toEqual([]);
    expect(unit.vanilla).toBe(true);

    expect(run(state, vanilla(), { controller: "p1" })).toEqual([]);
  });

  it("clears the text of a card in hand too, so it is not a field-only flag (§6.3)", () => {
    const state = game();
    const [card] = inHand(state, taunter.id, "p1");
    const held = card as CardInstance;

    expect(run(state, vanilla({ instanceId: held.id }), { controller: "p1" })).toHaveLength(1);
    expect(held.vanilla).toBe(true);
    expect(unitHas(state, held, "Taunt")).toBe(false);
    expect(unitView(state, held).attack).toBe(2);
  });
});
