// The declaration kinds and filters a play's choices go through (SPEC §10.5 step 1, §10.6, R81,
// R90). `playChoices.test.ts` covers the refusals the M3 BLOCKER was about — a dormant card, the
// opponent's hand, the counts. This file drives the rest of the module: several declarations
// reading the flat `targets` list in order, the `type`, `tags` and `notTags` filters, the backrow,
// hero and zone kinds, `excludeSelf`, an ally-only side, and two mode declarations at once.

import type { Action, ActionInput, CardDef, Selection } from "@jackioh/shared";
import { describe, expect, it } from "vitest";
import { registerCatalog, registeredCatalog } from "../src/catalog";
import { MAX_CHOICE_COMBINATIONS } from "../src/config";
import { damage } from "../src/effects";
import {
  declaredModes,
  declaredTargets,
  legalSelectionsFor,
  playChoiceCombinations,
  whyChoicesRefused,
} from "../src/playChoices";
import { beginGame, legalActions, reduce } from "../src/reduce";
import type { CardScripts, Script } from "../src/script";
import { registerScripts, registeredScripts } from "../src/scripts";
import type { GameState } from "../src/state";
import { lockZone } from "../src/zones";
import { plain } from "./fixtures/combat";
import { inHand, newGame, put, slot } from "./fixtures/harness";

let nextIndex = 1100;
function def(name: string, type: CardDef["type"], extra: Partial<CardDef> = {}): CardDef {
  nextIndex += 1;
  return {
    id: `pf-${name}`,
    index: String(nextIndex),
    name,
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

function unit(name: string, extra: Partial<CardDef> = {}): CardDef {
  return def(name, "Unit", {
    base: { attack: 2, health: 2, keywords: [], text: name },
    radiant: { attack: 4, health: 4, keywords: [], text: name },
    ...extra,
  });
}

/** #24's shape: two declarations, an enemy unit then one of yours, read in that order (R90). */
const twoStep = def("two-step", "Spell");
/** A fixed pick plus an "up to 3": the last declaration takes the remainder (R90). */
const remainder = def("remainder", "Spell");
/** #26's hand pick, narrowed to Spells (the `type` filter as a single value). */
const handSpells = def("hand-spells", "Spell");
/** A backrow pick narrowed to traps (the `type` filter as a list, on the `backrow` kind). */
const backrowTraps = def("backrow-traps", "Spell");
/** A hand pick that wants every tag it names and none it excludes. */
const tagged = def("tagged", "Spell");
/** A declared `hero` pick on the enemy side only. */
const heroHitter = def("hero-hitter", "Spell");
/** A declared `zone` pick with no `of`, on your own side (§10.6's `zone` kind). */
const zoneNamer = def("zone-namer", "Spell");
/** A unit that buffs one of your *other* units: `excludeSelf` on a unit pick. */
const selfless = unit("selfless");
/** The same flag on a backrow pick. */
const backrowSelfless = def("backrow-selfless", "Field Spell");
/** Two mode declarations, as #59 and Silly Silas's direction would combine (R81). */
const twoModes = def("two-modes", "Spell");
/** A hand pick whose filter says `side: "any"`: §9.1 still allows only your own hand. */
const anyHand = def("any-hand", "Spell");
/** A bare `target` declaration: no filter at all, which §10.6 reads as a unit on either side. */
const bareTarget = def("bare-target", "Spell");
/** A unit pick narrowed by tag, so the tag filter runs on the unit kind too. */
const tribalHitter = def("tribal-hitter", "Spell");
/** "Choose 2 or 3": a wide board makes this the enumeration bound of §10.2 (R90). */
const upToThree = def("up-to-three", "Spell");

/** Hand candidates for the filters. */
const spellCandidate = def("spell-candidate", "Spell");
const felinorKy = unit("felinor-ky", { tags: ["Felinor", "KY"] });
const felinorOnly = unit("felinor-only", { tags: ["Felinor"] });
const felinorCn = unit("felinor-cn", { tags: ["Felinor", "KY", "CN"] });
/** Backrow candidates. */
const trapCard = def("trap", "Trap");
const fieldSpellCard = def("field-spell", "Field Spell");

function both(script: Script): CardScripts {
  return { base: script, radiant: script };
}

const SCRIPTS: Record<string, CardScripts> = {
  [twoStep.id]: both({
    targets: [
      { kind: "target", min: 1, max: 1, filter: { side: "enemy", of: ["unit"] } },
      { kind: "target", min: 1, max: 1, filter: { side: "ally", of: ["unit"] } },
    ],
    // Which declaration a selection belongs to is observable: 2 on the enemy, 1 on your own.
    cry: () => [
      damage({ to: { of: "chosen", index: 0 }, amount: 2 }),
      damage({ to: { of: "chosen", index: 1 }, amount: 1 }),
    ],
  }),
  [remainder.id]: both({
    targets: [
      { kind: "target", min: 1, max: 1, filter: { side: "enemy", of: ["unit"] } },
      { kind: "target", min: 1, max: 3, filter: { side: "any", of: ["unit"] } },
    ],
    cry: () => [],
  }),
  [handSpells.id]: both({
    targets: [{ kind: "hand", min: 1, max: 1, filter: { of: ["hand"], type: "Spell" } }],
    cry: () => [],
  }),
  [backrowTraps.id]: both({
    targets: [
      { kind: "target", min: 1, max: 1, filter: { side: "any", of: ["backrow"], type: ["Trap", "Field Trap"] } },
    ],
    cry: () => [],
  }),
  [tagged.id]: both({
    targets: [
      { kind: "hand", min: 1, max: 1, filter: { of: ["hand"], tags: ["Felinor", "KY"], notTags: ["CN"] } },
    ],
    cry: () => [],
  }),
  [heroHitter.id]: both({
    targets: [{ kind: "target", min: 1, max: 1, filter: { side: "enemy", of: ["hero"] } }],
    cry: () => [damage({ to: { of: "chosen" }, amount: 3 })],
  }),
  [zoneNamer.id]: both({
    targets: [{ kind: "zone", min: 1, max: 1, filter: { side: "ally" } }],
    cry: () => [],
  }),
  [selfless.id]: both({
    targets: [{ kind: "target", min: 1, max: 1, filter: { side: "ally", of: ["unit"], excludeSelf: true } }],
    cry: () => [],
  }),
  [backrowSelfless.id]: both({
    targets: [{ kind: "target", min: 1, max: 1, filter: { side: "ally", of: ["backrow"], excludeSelf: true } }],
    cry: () => [],
  }),
  [twoModes.id]: both({
    modes: [
      { kind: "mode", options: ["burn", "freeze"] },
      { kind: "direction", options: ["left", "right"] },
    ],
    cry: () => [],
  }),
  [anyHand.id]: both({
    targets: [{ kind: "hand", min: 1, max: 1, filter: { of: ["hand"], side: "any" } }],
    cry: () => [],
  }),
  [bareTarget.id]: both({
    targets: [{ kind: "target", min: 1, max: 1 }],
    cry: () => [damage({ to: { of: "chosen" }, amount: 1 })],
  }),
  [tribalHitter.id]: both({
    targets: [{ kind: "target", min: 1, max: 1, filter: { side: "ally", of: ["unit"], tags: ["Felinor"] } }],
    cry: () => [],
  }),
  [upToThree.id]: both({
    targets: [{ kind: "target", min: 2, max: 3, filter: { side: "any", of: ["unit"] } }],
    cry: () => [],
  }),
};

const DEFS = [
  twoStep,
  remainder,
  handSpells,
  backrowTraps,
  tagged,
  heroHitter,
  zoneNamer,
  selfless,
  backrowSelfless,
  twoModes,
  anyHand,
  bareTarget,
  tribalHitter,
  upToThree,
  spellCandidate,
  felinorKy,
  felinorOnly,
  felinorCn,
  trapCard,
  fieldSpellCard,
];

let seq = 0;
function act(state: GameState, body: ActionInput): ReturnType<typeof reduce> {
  seq += 1;
  return reduce(state, { ...body, nonce: `pf${seq}` } as Action);
}

/** Past the mulligans, in p1's main phase, with the fixtures registered and 4 mana. */
function playing(seed: string): GameState {
  let state = beginGame(newGame(seed)).state;
  state = act(state, { type: "mulligan", keep: state.players.p1.hand.map((c) => c.id), playerId: "p1" }).state;
  state = act(state, { type: "mulligan", keep: state.players.p2.hand.map((c) => c.id), playerId: "p2" }).state;
  registerCatalog({ ...registeredCatalog(), ...Object.fromEntries(DEFS.map((d) => [d.id, d])) });
  registerScripts({ ...registeredScripts(), ...SCRIPTS });
  state.players.p1.mana = { current: 4, max: 4, nextTurnMod: 0, permMod: 0 };
  return state;
}

const onInstance = (id: string): Selection => ({ pick: "instance", instanceId: id });
const onZone = (player: "p1" | "p2", row: "units" | "backrow", lane: number): Selection => ({
  pick: "zone",
  player,
  row,
  lane,
});
const ids = (selections: Selection[]): string[] =>
  selections.flatMap((s) => (s.pick === "instance" ? [s.instanceId] : []));

describe("play-choice declarations and filters (§10.6, R81, R90)", () => {
  it("R90 reads two declarations off the flat targets list in order, and refuses the swapped order", () => {
    const state = playing("two-declarations");
    const theirs = put(state, plain.id, slot("p2", "units", 1));
    const mine = put(state, plain.id, slot("p1", "units", 1));
    const card = inHand(state, twoStep.id, "p1")[0];
    expect(card).toBeDefined();
    if (card === undefined) return;

    // Declaration 1 takes the first selection (an enemy unit), declaration 2 the second (an ally).
    const played = act(state, {
      type: "play",
      instanceId: card.id,
      playerId: "p1",
      targets: [onInstance(theirs.id), onInstance(mine.id)],
    });
    expect(played.error).toBeUndefined();
    expect(played.state.players.p2.units[0]?.[0]?.damage).toBe(2);
    expect(played.state.players.p1.units[0]?.[0]?.damage).toBe(1);

    // The same two selections in the other order are refused: each declaration reads its own slot.
    const swapped = act(state, {
      type: "play",
      instanceId: card.id,
      playerId: "p1",
      targets: [onInstance(mine.id), onInstance(theirs.id)],
    });
    expect(swapped.error).toMatch(/not a legal target/);
    expect(swapped.state).toBe(state);

    // One selection does not feed two declarations: the second one is still owed its minimum.
    const short = act(state, {
      type: "play",
      instanceId: card.id,
      playerId: "p1",
      targets: [onInstance(theirs.id)],
    });
    expect(short.error).toMatch(/needs 1 target/);
  });

  it("R90 enumerates a declaration pair as a cross product, and both may name the same card", () => {
    const state = playing("declaration-pairs");
    const enemyA = put(state, plain.id, slot("p2", "units", 1));
    const enemyB = put(state, plain.id, slot("p2", "units", 2));
    const allyA = put(state, plain.id, slot("p1", "units", 1));
    const allyB = put(state, plain.id, slot("p1", "units", 2));
    const card = inHand(state, twoStep.id, "p1")[0];
    expect(card).toBeDefined();
    if (card === undefined) return;

    const combos = playChoiceCombinations(state, "p1", card);
    expect(combos.map((combo) => ids(combo.targets ?? []))).toEqual([
      [enemyA.id, allyA.id],
      [enemyA.id, allyB.id],
      [enemyB.id, allyA.id],
      [enemyB.id, allyB.id],
    ]);
    expect(combos.length).toBeLessThanOrEqual(MAX_CHOICE_COMBINATIONS);
    for (const combo of combos) {
      expect(
        whyChoicesRefused(state, "p1", card, { type: "play", instanceId: card.id, ...combo }),
      ).toBeNull();
    }

    // R90: "each declaration is checked on its own, so two different declarations may both name the
    // same card" — here the same-side declaration cannot reach the enemy unit, so the pair that
    // proves it is the "up to 3" card, whose second declaration sees both sides.
    const wide = inHand(state, remainder.id, "p1")[0];
    expect(wide).toBeDefined();
    if (wide === undefined) return;
    expect(
      whyChoicesRefused(state, "p1", wide, {
        type: "play",
        instanceId: wide.id,
        targets: [onInstance(enemyA.id), onInstance(enemyA.id)],
      }),
    ).toBeNull();
    // Inside one declaration the same card twice is still refused.
    expect(
      whyChoicesRefused(state, "p1", wide, {
        type: "play",
        instanceId: wide.id,
        targets: [onInstance(enemyA.id), onInstance(allyA.id), onInstance(allyA.id)],
      }),
    ).toMatch(/same target twice/);
  });

  it("R90 gives the last declaration the remainder, and refuses more than its own max", () => {
    const state = playing("remainder-split");
    const enemyA = put(state, plain.id, slot("p2", "units", 1));
    const enemyB = put(state, plain.id, slot("p2", "units", 2));
    const allyA = put(state, plain.id, slot("p1", "units", 1));
    const allyB = put(state, plain.id, slot("p1", "units", 2));
    const allyC = put(state, plain.id, slot("p1", "units", 3));
    const card = inHand(state, remainder.id, "p1")[0];
    expect(card).toBeDefined();
    if (card === undefined) return;

    // 1 for the fixed declaration, then 3 for the "up to 3": four selections in one flat list.
    const played = act(state, {
      type: "play",
      instanceId: card.id,
      playerId: "p1",
      targets: [onInstance(enemyA.id), onInstance(allyA.id), onInstance(allyB.id), onInstance(allyC.id)],
    });
    expect(played.error).toBeUndefined();

    // A fifth selection lands on the last declaration too, which takes at most three.
    const tooMany = act(state, {
      type: "play",
      instanceId: card.id,
      playerId: "p1",
      targets: [
        onInstance(enemyA.id),
        onInstance(allyA.id),
        onInstance(allyB.id),
        onInstance(allyC.id),
        onInstance(enemyB.id),
      ],
    });
    expect(tooMany.error).toMatch(/at most 3/);

    // The first declaration still reads the first selection only: an ally there is not enemy-side.
    const wrongFirst = act(state, {
      type: "play",
      instanceId: card.id,
      playerId: "p1",
      targets: [onInstance(allyA.id), onInstance(enemyA.id)],
    });
    expect(wrongFirst.error).toMatch(/not a legal target/);
  });

  it("R81 filters a hand declaration by the card type it names (§10.6)", () => {
    const state = playing("hand-type-filter");
    const aSpell = inHand(state, spellCandidate.id, "p1")[0];
    const aUnit = inHand(state, felinorKy.id, "p1")[0];
    const card = inHand(state, handSpells.id, "p1")[0];
    expect(card).toBeDefined();
    if (card === undefined || aSpell === undefined || aUnit === undefined) return;

    const decl = declaredTargets(card)[0];
    expect(decl).toBeDefined();
    if (decl === undefined) return;
    const offered = ids(legalSelectionsFor(state, "p1", card, decl));
    expect(offered).toContain(aSpell.id);
    expect(offered).not.toContain(aUnit.id);
    expect(offered).not.toContain(card.id); // never the card that is leaving the hand
    // The opening hand is fixture units, so the type filter removes every one of them.
    for (const held of state.players.p1.hand) {
      if (held.id === aSpell.id || held.id === card.id) continue;
      if (held.defId === handSpells.id) continue;
      expect(offered).not.toContain(held.id);
    }

    expect(
      act(state, { type: "play", instanceId: card.id, playerId: "p1", targets: [onInstance(aSpell.id)] }).error,
    ).toBeUndefined();
    expect(
      act(state, { type: "play", instanceId: card.id, playerId: "p1", targets: [onInstance(aUnit.id)] }).error,
    ).toMatch(/not a legal target/);
  });

  it("R81 offers a backrow declaration both backrows, filtered by the list of types it names", () => {
    const state = playing("backrow-type-filter");
    const theirTrap = put(state, trapCard.id, slot("p2", "backrow", 1));
    const myTrap = put(state, trapCard.id, slot("p1", "backrow", 2));
    const notATrap = put(state, fieldSpellCard.id, slot("p1", "backrow", 1));
    const card = inHand(state, backrowTraps.id, "p1")[0];
    expect(card).toBeDefined();
    if (card === undefined) return;

    const decl = declaredTargets(card)[0];
    expect(decl).toBeDefined();
    if (decl === undefined) return;
    // Both sides, lane order within each: the ally side comes first (the chooser's own side).
    expect(ids(legalSelectionsFor(state, "p1", card, decl))).toEqual([myTrap.id, theirTrap.id]);

    expect(
      act(state, { type: "play", instanceId: card.id, playerId: "p1", targets: [onInstance(theirTrap.id)] }).error,
    ).toBeUndefined();
    expect(
      act(state, { type: "play", instanceId: card.id, playerId: "p1", targets: [onInstance(notATrap.id)] }).error,
    ).toMatch(/not a legal target/);
  });

  it("R81 requires every tag a filter names and none of the tags it excludes (§10.6)", () => {
    const state = playing("tag-filter");
    const wanted = inHand(state, felinorKy.id, "p1")[0];
    const halfMatch = inHand(state, felinorOnly.id, "p1")[0];
    const excluded = inHand(state, felinorCn.id, "p1")[0];
    const card = inHand(state, tagged.id, "p1")[0];
    expect(card).toBeDefined();
    if (card === undefined || wanted === undefined || halfMatch === undefined || excluded === undefined) return;

    const decl = declaredTargets(card)[0];
    expect(decl).toBeDefined();
    if (decl === undefined) return;
    const offered = ids(legalSelectionsFor(state, "p1", card, decl));
    expect(offered).toEqual([wanted.id]); // every tag matches, and the excluded tag is absent

    expect(
      act(state, { type: "play", instanceId: card.id, playerId: "p1", targets: [onInstance(wanted.id)] }).error,
    ).toBeUndefined();
    // "Felinor" alone does not satisfy ["Felinor", "KY"]: every tag must match.
    expect(
      act(state, { type: "play", instanceId: card.id, playerId: "p1", targets: [onInstance(halfMatch.id)] }).error,
    ).toMatch(/not a legal target/);
    // And one excluded tag is enough to drop a card that matches both wanted tags.
    expect(
      act(state, { type: "play", instanceId: card.id, playerId: "p1", targets: [onInstance(excluded.id)] }).error,
    ).toMatch(/not a legal target/);
  });

  it("R81 offers a hero declaration only on the side its filter names (§10.6)", () => {
    const state = playing("hero-kind");
    const theirs = put(state, plain.id, slot("p2", "units", 1));
    const card = inHand(state, heroHitter.id, "p1")[0];
    expect(card).toBeDefined();
    if (card === undefined) return;

    const decl = declaredTargets(card)[0];
    expect(decl).toBeDefined();
    if (decl === undefined) return;
    expect(legalSelectionsFor(state, "p1", card, decl)).toEqual([{ pick: "hero", player: "p2" }]);

    const played = act(state, {
      type: "play",
      instanceId: card.id,
      playerId: "p1",
      targets: [{ pick: "hero", player: "p2" }],
    });
    expect(played.error).toBeUndefined();
    expect(played.state.players.p2.hero.health).toBe(27);

    // Your own hero is a hero, but not the hero this declaration allows.
    const ownHero = act(state, {
      type: "play",
      instanceId: card.id,
      playerId: "p1",
      targets: [{ pick: "hero", player: "p1" }],
    });
    expect(ownHero.error).toMatch(/not a legal target/);
    expect(ownHero.state).toBe(state);
    // A unit is not a hero either, even an enemy one.
    expect(
      act(state, { type: "play", instanceId: card.id, playerId: "p1", targets: [onInstance(theirs.id)] }).error,
    ).toMatch(/not a legal target/);
  });

  it("R81 offers a zone declaration only your own open zones, never a Locked one (§3.2)", () => {
    const state = playing("zone-kind");
    put(state, plain.id, slot("p1", "units", 1)); // occupied: not open
    lockZone(state, slot("p1", "units", 2)); // Locked: never offered
    put(state, plain.id, slot("p2", "units", 1)); // the enemy side is not offered at all
    const card = inHand(state, zoneNamer.id, "p1")[0];
    expect(card).toBeDefined();
    if (card === undefined) return;

    const decl = declaredTargets(card)[0];
    expect(decl).toBeDefined();
    if (decl === undefined) return;
    const offered = legalSelectionsFor(state, "p1", card, decl);
    // Three open unit lanes and five open backrow lanes, all on the ally side.
    expect(offered).toHaveLength(8);
    expect(offered.every((s) => s.pick === "zone" && s.player === "p1")).toBe(true);
    expect(offered).toContainEqual(onZone("p1", "units", 3));
    expect(offered).not.toContainEqual(onZone("p1", "units", 1));
    expect(offered).not.toContainEqual(onZone("p1", "units", 2));
    expect(offered).not.toContainEqual(onZone("p2", "units", 2));

    expect(
      act(state, { type: "play", instanceId: card.id, playerId: "p1", targets: [onZone("p1", "backrow", 2)] }).error,
    ).toBeUndefined();
    // The Locked lane, the occupied lane, the enemy's lane and a lane out of range are all refused.
    for (const zone of [
      onZone("p1", "units", 2),
      onZone("p1", "units", 1),
      onZone("p2", "backrow", 2),
      onZone("p1", "units", 9),
    ]) {
      expect(
        act(state, { type: "play", instanceId: card.id, playerId: "p1", targets: [zone] }).error,
      ).toMatch(/not a legal target/);
    }
  });

  it("R81 excludeSelf drops the declaring card from its own unit and backrow picks", () => {
    const state = playing("exclude-self");
    const self = put(state, selfless.id, slot("p1", "units", 1));
    const other = put(state, plain.id, slot("p1", "units", 2));

    const decl = declaredTargets(self)[0];
    expect(decl).toBeDefined();
    if (decl === undefined) return;
    expect(legalSelectionsFor(state, "p1", self, decl)).toEqual([onInstance(other.id)]);
    // The same board without the flag offers both, which is what makes the exclusion visible.
    expect(
      ids(
        legalSelectionsFor(state, "p1", self, {
          kind: "target",
          min: 1,
          max: 1,
          filter: { side: "ally", of: ["unit"] },
        }),
      ),
    ).toEqual([self.id, other.id]);

    const back = put(state, backrowSelfless.id, slot("p1", "backrow", 1));
    const otherBack = put(state, fieldSpellCard.id, slot("p1", "backrow", 2));
    const backDecl = declaredTargets(back)[0];
    expect(backDecl).toBeDefined();
    if (backDecl === undefined) return;
    expect(legalSelectionsFor(state, "p1", back, backDecl)).toEqual([onInstance(otherBack.id)]);
  });

  it("R81 enumerates every combination of two mode declarations and needs an answer to each (§10.6)", () => {
    const state = playing("two-modes");
    const card = inHand(state, twoModes.id, "p1")[0];
    expect(card).toBeDefined();
    if (card === undefined) return;

    expect(declaredModes(card)).toHaveLength(2);
    expect(declaredTargets(card)).toEqual([]);

    const combos = playChoiceCombinations(state, "p1", card);
    expect(combos.map((combo) => combo.modes)).toEqual([
      ["burn", "left"],
      ["burn", "right"],
      ["freeze", "left"],
      ["freeze", "right"],
    ]);
    expect(combos.every((combo) => combo.targets === undefined)).toBe(true);
    expect(combos.length).toBeLessThanOrEqual(MAX_CHOICE_COMBINATIONS);

    // Every combination really is playable, and `legalActions` offers exactly those four plays.
    for (const combo of combos) {
      expect(act(state, { type: "play", instanceId: card.id, playerId: "p1", ...combo }).error).toBeUndefined();
    }
    const plays = legalActions(state, "p1").filter(
      (action) => action.type === "play" && action.instanceId === card.id,
    );
    expect(plays.map((play) => (play.type === "play" ? play.modes : []))).toEqual(
      combos.map((combo) => combo.modes),
    );

    // One answer for two declarations, three answers for two, and an option the second one
    // does not have are all refused.
    expect(act(state, { type: "play", instanceId: card.id, playerId: "p1", modes: ["burn"] }).error).toMatch(
      /needs a mode choice/,
    );
    expect(
      act(state, { type: "play", instanceId: card.id, playerId: "p1", modes: ["burn", "left", "left"] }).error,
    ).toMatch(/takes 2 mode choices/);
    expect(
      act(state, { type: "play", instanceId: card.id, playerId: "p1", modes: ["burn", "burn"] }).error,
    ).toMatch(/is not a mode of/);
    // The first declaration's option in the second slot is wrong too, so the order is checked.
    expect(
      act(state, { type: "play", instanceId: card.id, playerId: "p1", modes: ["left", "left"] }).error,
    ).toMatch(/is not a mode of/);
  });

  it("§9.1 offers a hand declaration only the chooser's own hand, even with side 'any'", () => {
    const state = playing("hand-side-any");
    const mine = inHand(state, spellCandidate.id, "p1")[0];
    const theirs = inHand(state, spellCandidate.id, "p2")[0];
    const card = inHand(state, anyHand.id, "p1")[0];
    expect(card).toBeDefined();
    if (card === undefined || mine === undefined || theirs === undefined) return;

    const decl = declaredTargets(card)[0];
    expect(decl).toBeDefined();
    if (decl === undefined) return;
    const offered = ids(legalSelectionsFor(state, "p1", card, decl));
    expect(offered).toContain(mine.id);
    for (const held of state.players.p2.hand) expect(offered).not.toContain(held.id);

    expect(
      act(state, { type: "play", instanceId: card.id, playerId: "p1", targets: [onInstance(mine.id)] }).error,
    ).toBeUndefined();
    expect(
      act(state, { type: "play", instanceId: card.id, playerId: "p1", targets: [onInstance(theirs.id)] }).error,
    ).toMatch(/not a legal target/);
  });

  it("R90 refuses a mode pick or an empty pick where a card or a zone is declared (§10.6)", () => {
    const state = playing("pick-kinds");
    put(state, plain.id, slot("p2", "units", 1));
    const hitter = inHand(state, heroHitter.id, "p1")[0];
    const zoner = inHand(state, zoneNamer.id, "p1")[0];
    expect(hitter).toBeDefined();
    if (hitter === undefined || zoner === undefined) return;

    // A selection of the wrong kind never matches an offered one, whatever it carries.
    for (const pick of [{ pick: "mode", option: "burn" } as Selection, { pick: "none" } as Selection]) {
      expect(
        act(state, { type: "play", instanceId: hitter.id, playerId: "p1", targets: [pick] }).error,
      ).toMatch(/not a legal target/);
      expect(
        act(state, { type: "play", instanceId: zoner.id, playerId: "p1", targets: [pick] }).error,
      ).toMatch(/not a legal target/);
    }
    // A zone where a hero is declared, and a hero where a zone is declared, are refused too.
    expect(
      act(state, { type: "play", instanceId: hitter.id, playerId: "p1", targets: [onZone("p1", "units", 1)] }).error,
    ).toMatch(/not a legal target/);
    expect(
      act(state, { type: "play", instanceId: zoner.id, playerId: "p1", targets: [{ pick: "hero", player: "p1" }] })
        .error,
    ).toMatch(/not a legal target/);
  });

  it("R81 reads a bare target declaration as a unit on either side, and filters units by tag (§10.6)", () => {
    const state = playing("bare-and-tribal");
    const mine = put(state, plain.id, slot("p1", "units", 1));
    const felinor = put(state, felinorKy.id, slot("p1", "units", 2));
    const theirs = put(state, plain.id, slot("p2", "units", 1));
    const bare = inHand(state, bareTarget.id, "p1")[0];
    const tribal = inHand(state, tribalHitter.id, "p1")[0];
    expect(bare).toBeDefined();
    expect(tribal).toBeDefined();
    if (bare === undefined || tribal === undefined) return;

    // No filter at all: every active unit, the chooser's side first, in lane order.
    const bareDecl = declaredTargets(bare)[0];
    const tribalDecl = declaredTargets(tribal)[0];
    expect(bareDecl).toBeDefined();
    expect(tribalDecl).toBeDefined();
    if (bareDecl === undefined || tribalDecl === undefined) return;
    expect(ids(legalSelectionsFor(state, "p1", bare, bareDecl))).toEqual([mine.id, felinor.id, theirs.id]);
    // A tag filter narrows the unit kind the same way it narrows a hand or backrow pick.
    expect(ids(legalSelectionsFor(state, "p1", tribal, tribalDecl))).toEqual([felinor.id]);

    const played = act(state, {
      type: "play",
      instanceId: bare.id,
      playerId: "p1",
      targets: [onInstance(theirs.id)],
    });
    expect(played.error).toBeUndefined();
    expect(played.state.players.p2.units[0]?.[0]?.damage).toBe(1);
    // A hero is not a unit, so a bare declaration does not reach one.
    expect(
      act(state, { type: "play", instanceId: bare.id, playerId: "p1", targets: [{ pick: "hero", player: "p2" }] })
        .error,
    ).toMatch(/not a legal target/);
    expect(
      act(state, { type: "play", instanceId: tribal.id, playerId: "p1", targets: [onInstance(mine.id)] }).error,
    ).toMatch(/not a legal target/);
  });

  it("R90 bounds a 'choose 2 or 3' enumeration at MAX_CHOICE_COMBINATIONS on a wide board (§10.2)", () => {
    const state = playing("wide-board");
    for (const lane of [1, 2, 3, 4, 5]) put(state, plain.id, slot("p1", "units", lane));
    for (const lane of [1, 2, 3, 4, 5]) put(state, plain.id, slot("p2", "units", lane));
    const card = inHand(state, upToThree.id, "p1")[0];
    expect(card).toBeDefined();
    if (card === undefined) return;

    // Ten units, so 45 pairs and 120 triples: the enumeration stops at the cap instead.
    const combos = playChoiceCombinations(state, "p1", card);
    expect(combos).toHaveLength(MAX_CHOICE_COMBINATIONS);
    for (const combo of combos) {
      const picked = combo.targets ?? [];
      expect(picked.length).toBeGreaterThanOrEqual(2);
      expect(picked.length).toBeLessThanOrEqual(3);
      expect(new Set(ids(picked)).size).toBe(picked.length);
      expect(
        whyChoicesRefused(state, "p1", card, { type: "play", instanceId: card.id, ...combo }),
      ).toBeNull();
    }

    // The refusal names the plural minimum the declaration asks for.
    const units = state.players.p1.units.flatMap((pile) => pile ?? []);
    const first = units[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    expect(
      act(state, { type: "play", instanceId: card.id, playerId: "p1", targets: [onInstance(first.id)] }).error,
    ).toMatch(/needs 2 targets/);
  });
});
