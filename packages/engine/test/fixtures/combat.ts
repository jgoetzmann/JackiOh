// Combat, damage and keyword fixtures for the M2-M3 engine tests (BUILD §0): one plain CardDef per
// keyword or statline the tests need, so a test reads `put(state, taunter.id, ...)` rather than
// building a def inline. The real cards, with their own tests, arrive in M4.
//
// Each def echoes the §8 card named in its doc comment, trimmed to the one property its name
// promises; the stats are the ones the importing tests assert (SPEC §6.1 keywords, §4.1 to §4.5
// combat, §10.4 layers). A fixture named for a keyword carries that keyword on *both* faces, so
// `{ radiant: true }` never silently changes what the fixture means; the exceptions are the four
// defs that mirror a specific card's radiant text (Big D-fender, Moths, Deft Duelist, Spikey
// Pillow), which SPEC §8 pins.

import type { CardDef, CardDefs } from "@jackioh/shared";
import type { AuraHook, CardScripts } from "../../src/script";

function def(overrides: Partial<CardDef> & Pick<CardDef, "id" | "index" | "name">): CardDef {
  return {
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

// ---------------------------------------------------------------------------
// Bodies with no keywords.
// ---------------------------------------------------------------------------

/** The vanilla 3/3 every test attacks with, trades and targets. No keywords at all (§6.1). */
export const plain = def({
  id: "cb-plain",
  index: "910",
  name: "Plain Body (combat fixture)",
  base: { attack: 3, health: 3, keywords: [], text: "3/3, no keywords" },
  radiant: { attack: 6, health: 6, keywords: [], text: "6/6, no keywords" },
});

/** A 5/10 that survives what it trades with, so a strike back can be read on its own (§4.3). */
export const bigBody = def({
  id: "cb-big-body",
  index: "911",
  name: "Big Body (combat fixture)",
  cost: 3,
  base: { attack: 5, health: 10, keywords: [], text: "5/10, no keywords" },
  radiant: { attack: 10, health: 20, keywords: [], text: "10/20, no keywords" },
});

/** R7: a 0-attack body with no aura, so "0 attack cannot attack" can be tested without #1. */
export const zeroAttack = def({
  id: "cb-zero-attack",
  index: "912",
  name: "Zero Attack (combat fixture)",
  cost: 2,
  base: { attack: 0, health: 8, keywords: [], text: "0/8, no keywords" },
  radiant: { attack: 0, health: 16, keywords: [], text: "0/16, no keywords" },
});

// ---------------------------------------------------------------------------
// One keyword each (§6.1).
// ---------------------------------------------------------------------------

/** §8 #19's keyword: Taunt on a 2/5. */
export const taunter = def({
  id: "cb-taunter",
  index: "913",
  name: "Taunt Wall (combat fixture)",
  cost: 2,
  base: { attack: 2, health: 5, keywords: [{ kind: "Taunt" }], text: "2/5 Taunt" },
  radiant: { attack: 4, health: 10, keywords: [{ kind: "Taunt" }], text: "4/10 Taunt" },
});

/** The Rush Token's keyword (§6.1): may attack units, never the hero, on its summon turn. */
export const rusher = def({
  id: "cb-rusher",
  index: "914",
  name: "Rusher (combat fixture)",
  base: { attack: 3, health: 3, keywords: [{ kind: "Rush" }], text: "3/3 Rush" },
  radiant: { attack: 6, health: 6, keywords: [{ kind: "Rush" }], text: "6/6 Rush" },
});

/** §8 #11r's keyword: the full sickness exemption, units and the hero alike (§6.1). */
export const charger = def({
  id: "cb-charger",
  index: "915",
  name: "Charger (combat fixture)",
  base: { attack: 3, health: 3, keywords: [{ kind: "Charge" }], text: "3/3 Charge" },
  radiant: { attack: 6, health: 6, keywords: [{ kind: "Charge" }], text: "6/6 Charge" },
});

/** §8 #20's keyword on a 4/4, so First Strike's step 1 kills a 3/3 outright (§4.3). */
export const firstStriker = def({
  id: "cb-first-striker",
  index: "916",
  name: "First Striker (combat fixture)",
  cost: 2,
  base: { attack: 4, health: 4, keywords: [{ kind: "First Strike" }], text: "4/4 First Strike" },
  radiant: { attack: 8, health: 8, keywords: [{ kind: "First Strike" }], text: "8/8 First Strike" },
});

/** §8 #3's keyword: Divine Shield on a 2/2, so a negated hit is bigger than the body (§4.4 step 1). */
export const shielded = def({
  id: "cb-shielded",
  index: "917",
  name: "Shielded (combat fixture)",
  base: { attack: 2, health: 2, keywords: [{ kind: "Divine Shield" }], text: "2/2 Divine Shield" },
  radiant: { attack: 4, health: 4, keywords: [{ kind: "Divine Shield" }], text: "4/4 Divine Shield" },
});

/**
 * §8 #25 (the 4-mana 7/7), trimmed to its Armor: 7/7 with Armor 7 (§4.4 step 2). #25's radiant text
 * swaps the Armor for Indestructible; the fixture keeps Armor on both faces so `armoured` always
 * means "Armor 7" and `indestructible` is the fixture that means Indestructible.
 */
export const armoured = def({
  id: "cb-armoured",
  index: "918",
  name: "Armoured (combat fixture)",
  cost: 4,
  base: { attack: 7, health: 7, keywords: [{ kind: "Armor", n: 7 }], text: "7/7 Armor 7" },
  radiant: { attack: 7, health: 7, keywords: [{ kind: "Armor", n: 7 }], text: "7/7 Armor 7" },
});

/** §8 #66's keyword: Indestructible on a 4/4 (§4.4 step 4, §4.5 step 1, R46, R69). */
export const indestructible = def({
  id: "cb-indestructible",
  index: "919",
  name: "Indestructible (combat fixture)",
  cost: 4,
  base: { attack: 4, health: 4, keywords: [{ kind: "Indestructible" }], text: "4/4 Indestructible" },
  radiant: { attack: 8, health: 8, keywords: [{ kind: "Indestructible" }], text: "8/8 Indestructible" },
});

/** Poisonous is pool-only in §8 (R21), so this small body carries it for §4.4 step 7. */
export const poisonous = def({
  id: "cb-poisonous",
  index: "920",
  name: "Poisonous (combat fixture)",
  base: { attack: 1, health: 1, keywords: [{ kind: "Poisonous" }], text: "1/1 Poisonous" },
  radiant: { attack: 2, health: 2, keywords: [{ kind: "Poisonous" }], text: "2/2 Poisonous" },
});

/** §8 #56's Lifesteal alone, so step 8 heals without a Taunt or a shield in the way. */
export const lifestealer = def({
  id: "cb-lifestealer",
  index: "921",
  name: "Lifestealer (combat fixture)",
  cost: 2,
  base: { attack: 3, health: 3, keywords: [{ kind: "Lifesteal" }], text: "3/3 Lifesteal" },
  radiant: { attack: 6, health: 6, keywords: [{ kind: "Lifesteal" }], text: "6/6 Lifesteal" },
});

/** Trample is pool-only in §8 (R21): a 6/4, so 6 into a 3-health unit leaves 3 to trample (R63). */
export const trampler = def({
  id: "cb-trampler",
  index: "922",
  name: "Trampler (combat fixture)",
  cost: 3,
  base: { attack: 6, health: 4, keywords: [{ kind: "Trample" }], text: "6/4 Trample" },
  radiant: { attack: 12, health: 8, keywords: [{ kind: "Trample" }], text: "12/8 Trample" },
});

/** Both halves of R63's last clause: Trample and Lifesteal on one body, so the heal is one total. */
export const trampleLifesteal = def({
  id: "cb-trample-lifesteal",
  index: "923",
  name: "Draining Trampler (combat fixture)",
  cost: 3,
  base: {
    attack: 6,
    health: 4,
    keywords: [{ kind: "Trample" }, { kind: "Lifesteal" }],
    text: "6/4 Trample, Lifesteal",
  },
  radiant: {
    attack: 12,
    health: 8,
    keywords: [{ kind: "Trample" }, { kind: "Lifesteal" }],
    text: "12/8 Trample, Lifesteal",
  },
});

/**
 * §8 #32r's Cleave (§4.4 step 10). Attack 3 and health 8: the three cleaved hits read as 3 each and
 * the body outlives the 5 a Big Body strikes back with.
 */
export const cleaver = def({
  id: "cb-cleaver",
  index: "924",
  name: "Cleaver (combat fixture)",
  cost: 2,
  base: { attack: 3, health: 8, keywords: [{ kind: "Cleave" }], text: "3/8 Cleave" },
  radiant: { attack: 6, health: 16, keywords: [{ kind: "Cleave" }], text: "6/16 Cleave" },
});

/** §8 #86's keyword: Can't attack, the attack-validator flag of §6.1. */
export const pacifist = def({
  id: "cb-pacifist",
  index: "925",
  name: "Pacifist (combat fixture)",
  base: { attack: 1, health: 1, keywords: [{ kind: "Can't attack" }], text: "1/1 Can't attack" },
  radiant: { attack: 2, health: 2, keywords: [{ kind: "Can't attack" }], text: "2/2 Can't attack" },
});

/**
 * §8 #92's Stack keyword (§3.2, R13), without Felinor Fiender's set-stat layer. `placeOnField`
 * takes `{ stack: true }`, so the keyword is here for the view and the validator to read.
 */
export const stacker = def({
  id: "cb-stacker",
  index: "926",
  name: "Stacker (combat fixture)",
  cost: 2,
  base: { attack: 5, health: 7, keywords: [{ kind: "Stack" }], text: "5/7 Stack" },
  radiant: { attack: 10, health: 14, keywords: [{ kind: "Stack" }], text: "10/14 Stack" },
});

// ---------------------------------------------------------------------------
// The three §8 cards whose rules text the tests exercise, scripts included.
// ---------------------------------------------------------------------------

/**
 * §8 #9 Moths to the Flame, 1/14 (2/28 with Armor 1 radiant). The forced-attack tests call
 * `forceAttack`/`forceAttacksOn` directly, so this is the body they aim at and it needs no script;
 * the start-of-turn half of #9's text is the real card's job in M4 (R53).
 */
export const moths = def({
  id: "cb-moths",
  index: "9",
  name: "Moths to the Flame (combat fixture)",
  rarity: "Rare",
  cost: 2,
  base: { attack: 1, health: 14, keywords: [], text: "1/14; start of turn every enemy unit attacks this" },
  radiant: { attack: 2, health: 28, keywords: [{ kind: "Armor", n: 1 }], text: "2/28 Armor 1; same" },
});

/**
 * §8 #1 Big D-fender, 0/8 → 0/16: 0 attack so it never attacks (R7), plus the §10.4 layer-5 aura
 * that gives its controller's Defense-Position units Armor +2, or +4 radiant.
 */
export const bigDfender = def({
  id: "cb-big-dfender",
  index: "1",
  name: "Big D-fender (combat fixture)",
  tags: ["Human"],
  cost: 2,
  base: { attack: 0, health: 8, keywords: [], text: "Aura: your units in Defense Position have +2 Armor" },
  radiant: { attack: 0, health: 16, keywords: [], text: "Aura: +4 Armor instead" },
});

/** Armor +n to the controller's units that are in Defense Position on the field (§4.1, §10.4). */
function defenseArmorAura(n: number): AuraHook {
  return ({ self }) => [
    {
      applies: (unit) =>
        unit.controller === self.controller &&
        unit.zone.z === "field" &&
        unit.zone.row === "units" &&
        (unit.position ?? "ATK") === "DEF",
      mod: { keywords: [{ kind: "Armor", n }] },
    },
  ];
}

const bigDfenderScripts: CardScripts = {
  base: { aura: defenseArmorAura(2) },
  radiant: { aura: defenseArmorAura(4) },
};

/**
 * §8 #45 Deft Duelist, 4/3 → 8/6 with Charge (radiant adds Armor 1). R49: two exertions, one attack
 * and one switch per turn, which the engine reads off the `deftDuelist` static flag (BUILD M2-T1).
 */
export const deftDuelist = def({
  id: "cb-deft-duelist",
  index: "45",
  name: "Deft Duelist (combat fixture)",
  tags: ["Human"],
  rarity: "Rare",
  cost: 2,
  base: {
    attack: 4,
    health: 3,
    keywords: [{ kind: "Charge" }],
    text: "Charge; may attack and switch position in the same turn",
  },
  radiant: {
    attack: 8,
    health: 6,
    keywords: [{ kind: "Charge" }, { kind: "Armor", n: 1 }],
    text: "Charge, Armor 1; same",
  },
});

const deftDuelistScripts: CardScripts = {
  base: { staticFlags: { deftDuelist: true } },
  radiant: { staticFlags: { deftDuelist: true } },
};

/**
 * §8 token 65.1 Spikey Pillow, 0/2 → 0/4: the `neverDefense` flag of §4.1 plus the layer-5 aura
 * that takes 2 attack off your units, floored at 0 (§10.4). The radiant aura spares other Spikey
 * Pillows.
 */
export const spikeyPillow = def({
  id: "cb-spikey-pillow",
  index: "65.1",
  name: "Spikey Pillow (combat fixture)",
  tags: ["Token"],
  rarity: "Token",
  token: true,
  base: {
    attack: 0,
    health: 2,
    keywords: [],
    text: "Cannot be in Defense Position. Aura: your units have -2 attack",
  },
  radiant: {
    attack: 0,
    health: 4,
    keywords: [],
    text: "Cannot be in Defense Position. Aura: your non-Spikey-Pillow units have -2 attack",
  },
});

/** −2 attack to the controller's units on the field; `sparesOwnKind` is 65.1's radiant text. */
function attackDrainAura(sparesOwnKind: boolean): AuraHook {
  return ({ self }) => [
    {
      applies: (unit) =>
        unit.controller === self.controller &&
        unit.zone.z === "field" &&
        unit.zone.row === "units" &&
        !(sparesOwnKind && unit.defId === self.defId),
      mod: { attack: -2 },
    },
  ];
}

const spikeyPillowScripts: CardScripts = {
  base: { staticFlags: { neverDefense: true }, aura: attackDrainAura(false) },
  radiant: { staticFlags: { neverDefense: true }, aura: attackDrainAura(true) },
};

// ---------------------------------------------------------------------------
// Registration. `setupCatalog` in ./harness.ts must fold both of these in, the way it already
// folds in ./scripts.ts's `fixtureCatalog` and `FIXTURE_SCRIPTS`.
// ---------------------------------------------------------------------------

export const COMBAT_DEFS: CardDef[] = [
  plain,
  bigBody,
  zeroAttack,
  taunter,
  rusher,
  charger,
  firstStriker,
  shielded,
  armoured,
  indestructible,
  poisonous,
  lifestealer,
  trampler,
  trampleLifesteal,
  cleaver,
  pacifist,
  stacker,
  moths,
  bigDfender,
  deftDuelist,
  spikeyPillow,
];

export const COMBAT_SCRIPTS: Record<string, CardScripts> = {
  [bigDfender.id]: bigDfenderScripts,
  [deftDuelist.id]: deftDuelistScripts,
  [spikeyPillow.id]: spikeyPillowScripts,
};

/** Every combat fixture on top of `base`, mirroring `fixtureCatalog` in ./scripts.ts. */
export function combatCatalog(base: CardDefs = {}): CardDefs {
  const defs: Record<string, CardDef> = { ...base };
  for (const entry of COMBAT_DEFS) defs[entry.id] = entry;
  return defs;
}
