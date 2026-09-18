// SPEC §10.4's stat and keyword layers (BUILD M3-T4). `unitView` is the only reader of a unit's
// totals — "compute a unit's view on every read, never store totals" — so every assertion here
// goes through it, one layer at a time, then as the ordered sequence §10.4 names, then over the
// keyword set. The last test proves nothing is written back into the state.
//
// Fixtures: `./fixtures/combat` already carries the aura and keyword bodies these tests want
// (Big D-fender's Defense-Position Armor, Spikey Pillow's attack drain, the printed-keyword
// bodies). The three cards §10.4 names that it does not carry get local defs below: Suppressive
// Aura (#46), Jlockeed's Weapons (#14) and Felinor Fiender (#92) with a Felinor for it to count.

import type { CardDef, GameEvent } from "@jackioh/shared";
import { armorOf, hasKeyword } from "@jackioh/shared";
import { describe, expect, it } from "vitest";
import { defOf, registerCatalog, registeredCatalog } from "../src/catalog";
import { faceOf, unitHas, unitView } from "../src/layers";
import type { AuraHook, CardScripts, Script, StatMod } from "../src/script";
import { registerScripts, registeredScripts } from "../src/scripts";
import { stateCheck } from "../src/stateCheck";
import { newInstance, type CardInstance, type GameState } from "../src/state";
import {
  activeUnitsOf,
  dormantUnitsOf,
  placeOnField,
  removeFromField,
  type ZoneSlot,
} from "../src/zones";
import {
  armoured,
  bigBody,
  bigDfender,
  indestructible,
  plain,
  poisonous,
  shielded,
  spikeyPillow,
  stacker,
  taunter,
  zeroAttack,
} from "./fixtures/combat";
import { eventsOfType, newGame, put, sinkFor, slot } from "./fixtures/harness";

// ---------------------------------------------------------------------------
// Local defs for the three §10.4 cards ./fixtures/combat does not carry. Indices start above 1200
// so they never collide with a fixture catalog or another test file's local defs.
// ---------------------------------------------------------------------------

let nextIndex = 1200;
function def(overrides: Partial<CardDef> & Pick<CardDef, "id" | "name">): CardDef {
  nextIndex += 1;
  return {
    index: String(nextIndex),
    set: "Core",
    type: "Unit",
    tags: [],
    rarity: "Common",
    token: false,
    cost: 1,
    base: { keywords: [], text: "" },
    radiant: { keywords: [], text: "" },
    ...overrides,
  };
}

/** A 2/2 with no keywords: the "2-health unit" Suppressive Aura takes to 0 (BUILD M3-T4). */
const smallBody = def({
  id: "ly-small-body",
  name: "Small Body (layers fixture)",
  base: { attack: 2, health: 2, keywords: [], text: "2/2, no keywords" },
  radiant: { attack: 4, health: 4, keywords: [], text: "4/4, no keywords" },
});

/** §8 #46 Suppressive Aura: a Field Spell whose aura is all units −2/−2; radiant, enemies −4/−4. */
const suppressiveAura = def({
  id: "ly-suppressive-aura",
  name: "Suppressive Aura (layers fixture)",
  type: "Field Spell",
  rarity: "Rare",
  cost: { base: 2, embiggen: 4 },
  base: { keywords: [], text: "Aura: all units -2/-2" },
  radiant: { keywords: [], text: "Aura: enemy units -4/-4" },
});

/** §8 #14 Jlockeed's Weapons: your units +4 attack, Rush and First Strike (+10 attack radiant). */
const jlockeedsWeapons = def({
  id: "ly-jlockeeds-weapons",
  name: "Jlockeed's Weapons (layers fixture)",
  type: "Field Spell",
  cost: 4,
  base: { keywords: [], text: "Aura: your units have +4 attack, Rush, First Strike" },
  radiant: { keywords: [], text: "Aura: your units have +10 attack, Rush, First Strike" },
});

/** §8 #92 Felinor Fiender, 5/7 → 10/14: Stack, Human, and §10.4's layer-2 set-stat card. */
const felinorFiender = def({
  id: "ly-felinor-fiender",
  name: "Felinor Fiender (layers fixture)",
  tags: ["Human"],
  rarity: "Legendary",
  cost: 2,
  base: {
    attack: 5,
    health: 7,
    keywords: [{ kind: "Stack" }],
    text: "Stack. Stats = printed plus the combined stats of all your Felinors",
  },
  radiant: {
    attack: 10,
    health: 14,
    keywords: [{ kind: "Stack" }, { kind: "Charge" }],
    text: "Stack, Charge; same",
  },
});

/** A plain Felinor body for #92 to count. */
const felinor = def({
  id: "ly-felinor",
  name: "Felinor (layers fixture)",
  tags: ["Felinor"],
  base: { attack: 2, health: 3, keywords: [], text: "2/3 Felinor" },
  radiant: { attack: 4, health: 6, keywords: [], text: "4/6 Felinor" },
});

/** A layer-5 aura over units on one side of the field, or on both (§10.4 layer 5). */
function unitsAura(mod: StatMod, side: "all" | "ally" | "enemy"): AuraHook {
  return ({ self }) => [
    {
      applies: (unit) =>
        unit.zone.z === "field" &&
        unit.zone.row === "units" &&
        (side === "all" ||
          (side === "ally" ? unit.controller === self.controller : unit.controller !== self.controller)),
      mod,
    },
  ];
}

/**
 * §10.4 layer 2 and R39: Felinor Fiender's stats are its printed ones plus the combined layer-4
 * stats of its controller's Felinors, R13's dormant Stack cards included, never below printed.
 *
 * DISCREPANCY: src/layers.ts has no layer-2 step at all — the comment at its layer-2 slot reads
 * "Layer 2 (set-stat, Felinor Fiender) arrives with M3-T4; no Core card needs it before then" —
 * and `Script` (src/script.ts) declares no set-stat hook, so the only stat-contributing hook a
 * card has is `aura`, which §10.4 numbers as layer 5. The sum therefore rides on the aura hook
 * here. For a purely additive contribution the two are observably equal, but SPEC §10.4 orders
 * the set-stat *before* layer 4, so a later set-stat that had to be seen by a layer-4 buff (or
 * that replaced rather than added) would land in the wrong place.
 *
 * `applies` may never call back into `unitView` (it would recurse), so the sum reads `faceOf` plus
 * `buffs`, which is exactly what §10.4 means by "layer-4 stats".
 */
function felinorSetStat(): AuraHook {
  return ({ state, self }) => {
    const mine = [...activeUnitsOf(state, self.controller), ...dormantUnitsOf(state, self.controller)];
    let attack = 0;
    let health = 0;
    for (const unit of mine) {
      if (!defOf(state, unit.defId).tags.includes("Felinor")) continue;
      const face = faceOf(state, unit);
      attack += face.attack + unit.buffs.attack;
      health += face.health + unit.buffs.health;
    }
    // R39: "never below printed", so the contribution itself never goes negative.
    return [
      {
        applies: (unit) => unit.id === self.id,
        mod: { attack: Math.max(0, attack), maxHealth: Math.max(0, health) },
      },
    ];
  };
}

function both(script: Script): CardScripts {
  return { base: script, radiant: script };
}

const LAYER_DEFS: CardDef[] = [smallBody, suppressiveAura, jlockeedsWeapons, felinorFiender, felinor];

const LAYER_SCRIPTS: Record<string, CardScripts> = {
  [suppressiveAura.id]: {
    base: { aura: unitsAura({ attack: -2, maxHealth: -2 }, "all") },
    radiant: { aura: unitsAura({ attack: -4, maxHealth: -4 }, "enemy") },
  },
  [jlockeedsWeapons.id]: {
    base: {
      aura: unitsAura({ attack: 4, keywords: [{ kind: "Rush" }, { kind: "First Strike" }] }, "ally"),
    },
    radiant: {
      aura: unitsAura({ attack: 10, keywords: [{ kind: "Rush" }, { kind: "First Strike" }] }, "ally"),
    },
  },
  [felinorFiender.id]: both({ aura: felinorSetStat() }),
};

/** A fresh game with the local defs folded in; `newGame` resets the registry, so this runs after. */
function board(seed: string): GameState {
  const state = newGame(seed);
  registerCatalog({ ...registeredCatalog(), ...Object.fromEntries(LAYER_DEFS.map((d) => [d.id, d])) });
  registerScripts({ ...registeredScripts(), ...LAYER_SCRIPTS });
  return state;
}

/** `put` refuses an occupied zone; §3.2's Stack pile needs the `stack` flag. */
function stackOn(state: GameState, defId: string, ref: ZoneSlot): CardInstance {
  const card = newInstance(state, defId, ref.player, { z: "hand", player: ref.player });
  if (!placeOnField(state, card, ref, { stack: true })) {
    throw new Error(`could not stack ${defId} on ${ref.row} ${ref.lane}`);
  }
  return card;
}

const kindsOf = (card: CardInstance, state: GameState): string[] =>
  [...new Set(unitView(state, card).keywords.map((k) => k.kind))].sort();

describe("§10.4 stat layers", () => {
  it("§10.4 layer 1 is the printed face of the running form, with statsOverride ahead of both", () => {
    const state = board("layer-1");
    const base = put(state, plain.id, slot("p1", "units", 1));
    const radiant = put(state, plain.id, slot("p1", "units", 2), { radiant: true });
    const token = put(state, plain.id, slot("p1", "units", 3));
    // §10.4: "or `statsOverride` for tokens summoned with X/X" (Adaptive UI's Rush Token).
    token.statsOverride = { attack: 7, health: 5 };

    expect(unitView(state, base)).toMatchObject({ attack: 3, maxHealth: 3, health: 3 });
    expect(unitView(state, radiant)).toMatchObject({ attack: 6, maxHealth: 6, health: 6 });
    expect(unitView(state, token)).toMatchObject({ attack: 7, maxHealth: 5, health: 5 });
  });

  it("R39 layer 2 adds the sum of your Felinors' layer-4 stats, and R13 counts the ones under a Stack", () => {
    const state = board("layer-2");
    const fiender = put(state, felinorFiender.id, slot("p1", "units", 1));
    expect(unitView(state, fiender)).toMatchObject({ attack: 5, maxHealth: 7 });

    // One Felinor on the board: its layer-4 stats are its printed 2/3 plus its own +1/+1 buff.
    const ally = put(state, felinor.id, slot("p1", "units", 2));
    ally.buffs = { attack: 1, health: 1 };
    expect(unitView(state, fiender)).toMatchObject({ attack: 8, maxHealth: 11 });

    // R13: a card under a Stack is not on the field for anything else, and still counts here.
    const dormant = put(state, felinor.id, slot("p1", "units", 3));
    stackOn(state, stacker.id, slot("p1", "units", 3));
    expect(activeUnitsOf(state, "p1").map((u) => u.id)).not.toContain(dormant.id);
    expect(dormantUnitsOf(state, "p1").map((u) => u.id)).toContain(dormant.id);
    expect(unitView(state, fiender)).toMatchObject({ attack: 10, maxHealth: 14 });

    // "All *your* Felinors": the opponent's are not yours (§8 #92).
    put(state, felinor.id, slot("p2", "units", 1));
    expect(unitView(state, fiender)).toMatchObject({ attack: 10, maxHealth: 14 });
  });

  it("§10.4 layer 4 adds the instance's permanent buffs to both stats", () => {
    const state = board("layer-4");
    const unit = put(state, plain.id, slot("p1", "units", 1));
    expect(unitView(state, unit)).toMatchObject({ attack: 3, maxHealth: 3 });

    unit.buffs = { attack: 2, health: 4 };
    expect(unitView(state, unit)).toMatchObject({ attack: 5, maxHealth: 7, health: 7 });
  });

  it("§10.4 layer 5 auras apply while their source is in play and stop the moment it leaves (#14)", () => {
    const state = board("layer-5");
    const unit = put(state, plain.id, slot("p1", "units", 1));
    const weapons = put(state, jlockeedsWeapons.id, slot("p1", "backrow", 1));
    expect(unitView(state, unit).attack).toBe(7);

    // §8 #14: "removed when it leaves". Nothing was stored on the unit, so nothing has to be undone.
    removeFromField(state, weapons);
    expect(unitView(state, unit).attack).toBe(3);
    expect(unit.buffs).toEqual({ attack: 0, health: 0 });
  });

  it("R13 a dormant Stack card projects no aura", () => {
    const state = board("dormant-aura");
    const ally = put(state, plain.id, slot("p1", "units", 2));
    ally.position = "DEF";
    put(state, bigDfender.id, slot("p1", "units", 1));
    // Defense Position's own Armor +1 plus Big D-fender's +2 (§4.1, §8 #1).
    expect(unitView(state, ally).armor).toBe(3);

    // §3.2: only the top of a pile is on the field, so only it projects its aura.
    stackOn(state, stacker.id, slot("p1", "units", 1));
    expect(unitView(state, ally).armor).toBe(1);
  });

  it("§10.4 layer 5 floors attack at 0, and floors max health at nothing (Spikey Pillow)", () => {
    const state = board("attack-floor");
    const pillow = put(state, spikeyPillow.id, slot("p1", "units", 1));
    const small = put(state, poisonous.id, slot("p1", "units", 2));
    const big = put(state, plain.id, slot("p1", "units", 3));

    // 1 − 2 and 0 − 2 both floor at 0; 3 − 2 does not.
    expect(unitView(state, small).attack).toBe(0);
    expect(unitView(state, pillow).attack).toBe(0);
    expect(unitView(state, big).attack).toBe(1);
    // §10.4: only attack is floored — max health is left to fall, for the state check to read.
    expect(unitView(state, small).maxHealth).toBe(1);
  });

  it("§10.4 layer 6 reads current health as max health minus damage", () => {
    const state = board("layer-6");
    const unit = put(state, plain.id, slot("p1", "units", 1));
    unit.damage = 2;
    expect(unitView(state, unit)).toMatchObject({ maxHealth: 3, health: 1 });

    // The damage stays where it is; the health it leaves behind follows the new max.
    unit.buffs = { attack: 0, health: 5 };
    expect(unitView(state, unit)).toMatchObject({ maxHealth: 8, health: 6 });
  });

  it("§10.4 composes layers 1, 2, 4, 5 and 6 in that order", () => {
    const state = board("layer-order");
    const fiender = put(state, felinorFiender.id, slot("p1", "units", 2));
    // 1: the printed face.
    expect(unitView(state, fiender)).toMatchObject({ attack: 5, maxHealth: 7, health: 7 });

    // 2: the set-stat, reading the Felinor's layer-4 stats (printed 2/3 plus its +1/+1).
    const ally = put(state, felinor.id, slot("p1", "units", 3));
    ally.buffs = { attack: 1, health: 1 };
    expect(unitView(state, fiender)).toMatchObject({ attack: 8, maxHealth: 11 });

    // 4: the Fiender's own buffs, on top of the set-stat.
    fiender.buffs = { attack: 1, health: 2 };
    expect(unitView(state, fiender)).toMatchObject({ attack: 9, maxHealth: 13 });

    // 5: auras come last, and an aura never changes the layer-4 stats layer 2 summed.
    put(state, spikeyPillow.id, slot("p1", "units", 1));
    expect(unitView(state, ally)).toMatchObject({ attack: 1, maxHealth: 4 });
    expect(unitView(state, fiender)).toMatchObject({ attack: 7, maxHealth: 13 });

    // 6: current health is the last step, off the max the layers above settled on.
    fiender.damage = 3;
    expect(unitView(state, fiender)).toMatchObject({ attack: 7, maxHealth: 13, health: 10 });
  });

  it("§10.4 applies layer 4's buffs before layer 5's auras and floors attack once, at the end", () => {
    const state = board("floor-once");
    const unit = put(state, zeroAttack.id, slot("p1", "units", 2));
    unit.buffs = { attack: 3, health: 0 };
    put(state, spikeyPillow.id, slot("p1", "units", 1));

    // 0 + 3 − 2 = 1. A floor taken before the buff — max(0, 0 − 2) = 0, then +3 — would read 3,
    // so the order of layers 4 and 5 against the single final floor is observable here.
    expect(unitView(state, unit).attack).toBe(1);
  });

  it("#46 Suppressive Aura takes a 2-health unit's max health to 0 and the next state check kills it", () => {
    const state = board("suppressive-kill");
    const small = put(state, smallBody.id, slot("p1", "units", 1));
    put(state, suppressiveAura.id, slot("p1", "backrow", 1));
    expect(unitView(state, small)).toMatchObject({ attack: 0, maxHealth: 0, health: 0 });

    const events: GameEvent[] = [];
    stateCheck(sinkFor(state, events));
    expect(eventsOfType(events, "destroyed").map((e) => e.instanceId)).toEqual([small.id]);
    expect(state.players.p1.units[0]).toBeNull();
    expect(state.players.p1.graveyard.map((c) => c.id)).toContain(small.id);
  });

  it("#46 removing Suppressive Aura restores a surviving unit's max health", () => {
    const state = board("suppressive-restore");
    const unit = put(state, plain.id, slot("p1", "units", 1));
    const aura = put(state, suppressiveAura.id, slot("p1", "backrow", 1));
    expect(unitView(state, unit)).toMatchObject({ attack: 1, maxHealth: 1, health: 1 });

    // 1 health is still above 0, so the state check leaves it alone (§4.5 step 1).
    stateCheck(sinkFor(state));
    expect(state.players.p1.units[0]?.[0]?.id).toBe(unit.id);

    removeFromField(state, aura);
    expect(unitView(state, unit)).toMatchObject({ attack: 3, maxHealth: 3, health: 3 });
  });

  it("§10.4 layer 5 an aura picks its own side: radiant Suppressive Aura touches enemy units only", () => {
    const state = board("suppressive-radiant");
    const mine = put(state, bigBody.id, slot("p1", "units", 1));
    const theirs = put(state, bigBody.id, slot("p2", "units", 1));
    put(state, suppressiveAura.id, slot("p1", "backrow", 1), { radiant: true });

    expect(unitView(state, mine)).toMatchObject({ attack: 5, maxHealth: 10 });
    expect(unitView(state, theirs)).toMatchObject({ attack: 1, maxHealth: 6 });
  });
});

describe("§10.4 keyword set", () => {
  it("§10.4 the keyword set is the union of printed, granted, aura and position sources", () => {
    const state = board("keyword-union");
    const unit = put(state, taunter.id, slot("p1", "units", 1));
    unit.grantedKeywords = [{ kind: "Lifesteal" }];
    unit.position = "DEF";
    put(state, jlockeedsWeapons.id, slot("p1", "backrow", 1));

    // Printed Taunt, granted Lifesteal, the aura's Rush and First Strike, Defense Position's Armor.
    expect(kindsOf(unit, state)).toEqual(["Armor", "First Strike", "Lifesteal", "Rush", "Taunt"]);
    expect(unitView(state, unit).armor).toBe(1);
  });

  it("§6.3 Vanilla strips printed keywords but not grantedKeywords, and keeps stats, buffs and damage", () => {
    const state = board("vanilla");
    const unit = put(state, taunter.id, slot("p1", "units", 1));
    unit.buffs = { attack: 1, health: 1 };
    unit.damage = 2;
    unit.grantedKeywords = [{ kind: "Rush" }];
    expect(kindsOf(unit, state)).toEqual(["Rush", "Taunt"]);

    unit.vanilla = true;
    const view = unitView(state, unit);
    expect(view.keywords.map((k) => k.kind)).toEqual(["Rush"]);
    // §6.1 Vanilla: "Clears printed keywords and scripts; keeps stats, buffs and damage".
    expect(view).toMatchObject({ attack: 3, maxHealth: 6, health: 4 });

    // An aura is the board's text, not the unit's, so a Vanilla unit still takes aura grants.
    put(state, jlockeedsWeapons.id, slot("p1", "backrow", 1));
    expect(kindsOf(unit, state)).toEqual(["First Strike", "Rush"]);
    expect(unitView(state, unit).attack).toBe(7);
  });

  it("§6.3 a Vanilla unit's own aura stops applying, because Vanilla clears its scripts", () => {
    const state = board("vanilla-aura");
    const dfender = put(state, bigDfender.id, slot("p1", "units", 1));
    const ally = put(state, plain.id, slot("p1", "units", 2));
    ally.position = "DEF";
    expect(unitView(state, ally).armor).toBe(3);

    dfender.vanilla = true;
    // DISCREPANCY: src/layers.ts does A; SPEC §6.1/§6.3 say B.
    //   A: `auraSources`/`auraMods` read `scriptOf(source).aura` and never look at the source's
    //      `vanilla` flag, so a Vanilla'd Big D-fender keeps projecting its Armor aura (armor 3).
    //   B: Vanilla "clears printed keywords and scripts" (§6.1) — "the card's text stops applying
    //      — its printed keywords and its scripts" (src/effects/transform.ts's own doc comment) —
    //      and `aura` is part of a card's Script (§10.9), so only Defense Position's own Armor +1
    //      should be left.
    expect(unitView(state, ally).armor).toBe(1);
  });

  it("§4.1 a unit in Defense Position gains Taunt and Armor +1", () => {
    const state = board("defense-position");
    const unit = put(state, plain.id, slot("p1", "units", 1));
    expect(unitView(state, unit)).toMatchObject({ position: "ATK", armor: 0 });
    expect(unitHas(state, unit, "Taunt")).toBe(false);

    unit.position = "DEF";
    const view = unitView(state, unit);
    expect(view.position).toBe("DEF");
    expect(hasKeyword(view.keywords, "Taunt")).toBe(true);
    expect(view.armor).toBe(1);
    // The grant is positional, not a stored keyword: nothing was written onto the instance.
    expect(unit.grantedKeywords).toEqual([]);
  });

  it("§10.4 Armor is summed across every source: printed, granted, Defense Position and auras", () => {
    const state = board("armor-sum");
    const unit = put(state, armoured.id, slot("p1", "units", 2));
    expect(unitView(state, unit).armor).toBe(7);

    unit.grantedKeywords = [{ kind: "Armor", n: 2 }];
    expect(unitView(state, unit).armor).toBe(9);

    unit.position = "DEF";
    expect(unitView(state, unit).armor).toBe(10);

    // §4.1: Big D-fender's aura stacks with printed Armor and with Defense Position's own +1.
    put(state, bigDfender.id, slot("p1", "units", 1));
    const view = unitView(state, unit);
    expect(view.armor).toBe(12);
    expect(armorOf(view.keywords)).toBe(12);
  });

  it("R46 a marked Indestructible unit loses Taunt for that turn only", () => {
    const state = board("taunt-suppression");
    state.turn = 4;
    const unit = put(state, indestructible.id, slot("p1", "units", 1));
    unit.grantedKeywords = [{ kind: "Taunt" }];
    unit.position = "DEF";
    expect(unitHas(state, unit, "Taunt")).toBe(true);

    // R46: a would-destroy on an Indestructible unit switches it to Attack and stamps the turn.
    unit.markedDestroyed = true;
    stateCheck(sinkFor(state));
    expect(unit.tauntSuppressedTurn).toBe(4);
    expect(unitView(state, unit).position).toBe("ATK");
    expect(unitHas(state, unit, "Taunt")).toBe(false);
    // Still granted: the suppression is a read-time subtraction, not a removal (§10.4).
    expect(unit.grantedKeywords).toEqual([{ kind: "Taunt" }]);

    // "This turn" and no longer: the next turn hands it straight back.
    state.turn = 5;
    expect(unitHas(state, unit, "Taunt")).toBe(true);
    // And a stamp from an earlier turn suppresses nothing.
    state.turn = 6;
    unit.tauntSuppressedTurn = 5;
    expect(unitHas(state, unit, "Taunt")).toBe(true);

    // While the stamp does name this turn, even Defense Position's Taunt goes; its Armor stays.
    state.turn = 5;
    unit.position = "DEF";
    expect(unitHas(state, unit, "Taunt")).toBe(false);
    expect(unitView(state, unit).armor).toBe(1);
  });

  it("§6.1 a spent Divine Shield and a used Reborn are gone until they are granted again", () => {
    const state = board("spent-keywords");
    const shield = put(state, shielded.id, slot("p1", "units", 1));
    expect(unitHas(state, shield, "Divine Shield")).toBe(true);

    // §6.1: "Negate the first damage instance, then lose it" (§10.1's `divineShieldSpent`).
    shield.divineShieldSpent = true;
    expect(unitHas(state, shield, "Divine Shield")).toBe(false);

    // §10.1: "gone until granted again". A grant clears the flag (src/effects/buff.ts `grantTo`),
    // and the layers hand the keyword back the moment it is clear.
    shield.grantedKeywords = [{ kind: "Divine Shield" }];
    delete shield.divineShieldSpent;
    expect(unitHas(state, shield, "Divine Shield")).toBe(true);

    const reborn = put(state, plain.id, slot("p1", "units", 2));
    reborn.grantedKeywords = [{ kind: "Reborn" }];
    expect(unitHas(state, reborn, "Reborn")).toBe(true);
    // §4.5 step 4: a Reborn body comes back without Reborn.
    reborn.rebornSpent = true;
    expect(unitHas(state, reborn, "Reborn")).toBe(false);
  });
});

describe("§10.4 recomputation", () => {
  it("§10.4 recomputes the view on every read and stores no total in the state", () => {
    const state = board("no-cache");
    const unit = put(state, plain.id, slot("p1", "units", 2));
    const first = unitView(state, unit);
    expect(first).toMatchObject({ attack: 3, maxHealth: 3, health: 3 });

    // Reading writes nothing: §10.1 keeps the state JSON-only, so a round-trip compares exactly.
    const snapshot = JSON.stringify(state);
    unitView(state, unit);
    unitView(state, unit);
    expect(JSON.stringify(state)).toBe(snapshot);

    // The instance carries the inputs, never the totals ("never store totals", §10.4).
    const fields = Object.keys(unit);
    expect(fields).not.toContain("attack");
    expect(fields).not.toContain("maxHealth");
    expect(fields).not.toContain("health");
    expect(fields).not.toContain("keywords");
    expect(fields).not.toContain("armor");

    // A second read around a mutation sees the new board, and the first view is untouched by it.
    put(state, spikeyPillow.id, slot("p1", "units", 1));
    unit.buffs = { attack: 1, health: 1 };
    unit.damage = 1;
    expect(unitView(state, unit)).toMatchObject({ attack: 2, maxHealth: 4, health: 3 });
    expect(first).toMatchObject({ attack: 3, maxHealth: 3, health: 3 });
  });
});
