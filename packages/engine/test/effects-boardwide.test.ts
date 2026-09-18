// The board-wide and adjacency verbs of the effects library (BUILD M3-T1 "every effect has its own
// test"; SPEC §6.3, §3.1, §3.2, §4.4, §4.5, R11, R12, R13, R16, R31, R46, R55, R59, R68, R78,
// §10.7). Eight verbs, all of them a thin walk over `cardsInScope` / `adjacentTo`:
//   destroyAll, destroyAdjacentTo   (effects/destroy.ts)  — #2, #16, #17, #43, #88
//   damageAll                       (effects/damage.ts)   — #13
//   bounceAll, exileAll, exileAdjacentTo, discardHand, exileHand
//                                   (effects/move.ts)     — #17, #34, #76, #78, #100
//
// What these tests are really pinning down is the difference between a sweep and a loop of
// single-target verbs: `destroyAll` only marks, so §4.5 collects the whole board under ONE state
// check (R59), and `damageAll` snapshots its targets, so one hit never changes who else is hit.
// The fixture defs live here rather than in a shared fixture, per CLAUDE.md and BUILD §0.

import type { CardDef, GameEvent, PlayerId, Selection } from "@jackioh/shared";
import { describe, expect, it } from "vitest";
import { registerCatalog, registeredCatalog } from "../src/catalog";
import { HAND_CAP, HERO_HEALTH } from "../src/config";
import { destroy, destroyAdjacentTo, destroyAll } from "../src/effects/destroy";
import { damageAll } from "../src/effects/damage";
import { bounceAll, discardHand, discardRandom, exileAdjacentTo, exileAll, exileHand } from "../src/effects/move";
import { makeContext, type EngineSink } from "../src/resolve";
import type { Effect } from "../src/script";
import { stateCheck } from "../src/stateCheck";
import { newInstance, type CardInstance, type GameState } from "../src/state";
import { cardAt, placeOnField } from "../src/zones";
import { tokenDef } from "./fixtures/catalog";
import { armoured, indestructible, plain, shielded } from "./fixtures/combat";
import { eventsOfType, inHand, newGame, put, sinkFor, slot } from "./fixtures/harness";

// ---------------------------------------------------------------------------
// Fixture cards: one tagged body per scope filter the eight call sites use.
// ---------------------------------------------------------------------------

let nextIndex = 1300;

function unitDefOf(name: string, overrides: Partial<CardDef> = {}): CardDef {
  nextIndex += 1;
  return {
    id: `bw-${name}`,
    index: String(nextIndex),
    name: `${name} (boardwide)`,
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

/** #2 Bigot's radiant destroys every *non-Human* enemy unit, so the scope needs both halves. */
const human = unitDefOf("human", { tags: ["Human"] });
/** #43 Big Felinor spares Felinors, its own token included (t-felinor). */
const felinor = unitDefOf("felinor", { tags: ["Felinor"] });
/** An untagged body: what `notTags` keeps and `tags` rejects. */
const beast = unitDefOf("beast");
/** #88 Twisting Nether and #100 Ceaseless Void reach the backrow, which has no unit stats. */
const fieldSpell: CardDef = {
  ...unitDefOf("field-spell"),
  type: "Field Spell",
  base: { keywords: [], text: "field spell" },
  radiant: { keywords: [], text: "field spell" },
};

const rushToken = tokenDef("rush");

const DEFS: CardDef[] = [human, felinor, beast, fieldSpell];

/** A fresh game whose catalog also carries this file's fixtures; p1 is active and resolving. */
function game(seed: string): GameState {
  const state = newGame(seed);
  registerCatalog({ ...registeredCatalog(), ...Object.fromEntries(DEFS.map((def) => [def.id, def])) });
  state.turn = 3;
  state.active = "p1";
  state.phase = "main";
  return state;
}

type RunOptions = { controller?: PlayerId; self?: CardInstance };

/** A sink plus `apply`, so one test can run a sweep and then the state check on the same events. */
function runner(state: GameState): {
  sink: EngineSink;
  events: GameEvent[];
  apply: (effect: Effect, target?: CardInstance, options?: RunOptions) => void;
  applyAll: (effects: Effect[], target?: CardInstance, options?: RunOptions) => void;
  check: () => void;
} {
  const sink = sinkFor(state);
  function contextFor(target: CardInstance | undefined, options: RunOptions): ReturnType<typeof makeContext> {
    const targets: Selection[] = target === undefined ? [] : [{ pick: "instance", instanceId: target.id }];
    return makeContext(sink, options.self ?? null, { controller: options.controller ?? "p1", targets });
  }
  return {
    sink,
    events: sink.events,
    apply(effect, target, options = {}): void {
      const ctx = contextFor(target, options);
      effect.apply(ctx);
      state.rngCursor = sink.rng.cursor;
    },
    // #16 Hit Job and #34 Collateral Damage pair a single-target verb with an adjacency verb in one
    // effect list, which must resolve against one context and one state check (R59).
    applyAll(effects, target, options = {}): void {
      const ctx = contextFor(target, options);
      for (const effect of effects) effect.apply(ctx);
      state.rngCursor = sink.rng.cursor;
    },
    check(): void {
      stateCheck(sink);
    },
  };
}

const chosen = { of: "chosen" } as const;

/** The one card a single-card fixture call made, without an optional chain in the assertion. */
function only(cards: CardInstance[]): CardInstance {
  const card = cards[0];
  if (card === undefined || cards.length !== 1) throw new Error("expected exactly one fixture card");
  return card;
}

/** A card owned by one player but standing on the other's field, for R12's "owner's graveyard". */
function stolenOnto(state: GameState, defId: string, owner: PlayerId, ref: ReturnType<typeof slot>): CardInstance {
  const card = newInstance(state, defId, owner, { z: "hand", player: owner });
  if (!placeOnField(state, card, ref)) throw new Error("could not place the stolen fixture");
  return card;
}

// ---------------------------------------------------------------------------
// destroyAll
// ---------------------------------------------------------------------------

describe("destroyAll (§6.3, §4.5, R46, R59, M3-T1)", () => {
  it("§6.3 marks every matching enemy unit, leaves allies and other tags standing, and one state check buries them in their owners' graveyards (R12, R59)", () => {
    const state = game("destroyAll-scope");
    const ally = put(state, beast.id, slot("p1", "units", 1));
    const allyHuman = put(state, human.id, slot("p1", "units", 2));
    const enemyOne = put(state, beast.id, slot("p2", "units", 1));
    const enemyHuman = put(state, human.id, slot("p2", "units", 2));
    const enemyTwo = put(state, felinor.id, slot("p2", "units", 3));
    // R12: owned by p1, standing on p2's side, so the sweep's scope is by side and the graveyard
    // is by owner. These are two different questions and this card answers both at once.
    const stolen = stolenOnto(state, beast.id, "p1", slot("p2", "units", 4));
    const run = runner(state);

    run.apply(destroyAll({ side: "enemy", rows: ["units"], notTags: ["Human"] }));

    // Only marks: §4.5 step 1 has not run, so nothing has moved and nothing has been announced.
    expect([enemyOne, enemyTwo, stolen].map((c) => c.markedDestroyed)).toEqual([true, true, true]);
    expect(enemyHuman.markedDestroyed).toBeUndefined();
    expect(ally.markedDestroyed).toBeUndefined();
    expect(allyHuman.markedDestroyed).toBeUndefined();
    expect(cardAt(state, slot("p2", "units", 1))?.id).toBe(enemyOne.id);
    expect(cardAt(state, slot("p2", "units", 3))?.id).toBe(enemyTwo.id);
    expect(state.players.p1.graveyard).toHaveLength(0);
    expect(state.players.p2.graveyard).toHaveLength(0);
    expect(run.events).toEqual([]);

    run.check();

    expect(cardAt(state, slot("p2", "units", 1))).toBeNull();
    expect(cardAt(state, slot("p2", "units", 3))).toBeNull();
    expect(cardAt(state, slot("p2", "units", 4))).toBeNull();
    expect(cardAt(state, slot("p2", "units", 2))?.id).toBe(enemyHuman.id);
    expect(cardAt(state, slot("p1", "units", 1))?.id).toBe(ally.id);
    expect(cardAt(state, slot("p1", "units", 2))?.id).toBe(allyHuman.id);
    // R12: the two p2-owned bodies to p2's graveyard, the stolen p1-owned one to p1's.
    expect(state.players.p2.graveyard.map((c) => c.id).sort()).toEqual([enemyOne.id, enemyTwo.id].sort());
    expect(state.players.p1.graveyard.map((c) => c.id)).toEqual([stolen.id]);
    // R59: one state check collected all three, so there are exactly three deaths from one pass.
    expect(eventsOfType(run.events, "destroyed")).toHaveLength(3);
  });

  it('§6.3 rows: ["units", "backrow"] marks a backrow card too (#88 Twisting Nether)', () => {
    const state = game("destroyAll-backrow");
    const allyUnit = put(state, beast.id, slot("p1", "units", 1));
    const allyBackrow = put(state, fieldSpell.id, slot("p1", "backrow", 1));
    const enemyUnit = put(state, beast.id, slot("p2", "units", 2));
    const enemyBackrow = put(state, fieldSpell.id, slot("p2", "backrow", 3));
    const run = runner(state);

    run.apply(destroyAll({ side: "any", rows: ["units", "backrow"] }));

    expect([allyUnit, allyBackrow, enemyUnit, enemyBackrow].map((c) => c.markedDestroyed)).toEqual([
      true,
      true,
      true,
      true,
    ]);

    run.check();

    expect(cardAt(state, slot("p1", "backrow", 1))).toBeNull();
    expect(cardAt(state, slot("p2", "backrow", 3))).toBeNull();
    expect(state.players.p1.graveyard.map((c) => c.id).sort()).toEqual([allyUnit.id, allyBackrow.id].sort());
    expect(state.players.p2.graveyard.map((c) => c.id).sort()).toEqual([enemyUnit.id, enemyBackrow.id].sort());
  });

  it("§3.2 defaults to the unit row, so a backrow card is untouched (#2, #17, #43)", () => {
    const state = game("destroyAll-default-rows");
    const enemyUnit = put(state, beast.id, slot("p2", "units", 1));
    const enemyBackrow = put(state, fieldSpell.id, slot("p2", "backrow", 1));
    const run = runner(state);

    run.apply(destroyAll({ side: "enemy" }));

    expect(enemyUnit.markedDestroyed).toBe(true);
    expect(enemyBackrow.markedDestroyed).toBeUndefined();

    run.check();

    expect(cardAt(state, slot("p2", "backrow", 1))?.id).toBe(enemyBackrow.id);
  });

  it("R46 does not skip an Indestructible unit: the mark lands, and §4.5 is what spares it, flattens it to Attack Position and drops its Taunt", () => {
    const state = game("destroyAll-indestructible");
    const warded = put(state, indestructible.id, slot("p2", "units", 1));
    warded.position = "DEF";
    const mortal = put(state, beast.id, slot("p2", "units", 2));
    const run = runner(state);

    run.apply(destroyAll({ side: "enemy" }));

    // The whole point: the scope does NOT pre-filter Indestructible. Were the mark never set,
    // R46's Attack-Position switch and Taunt suppression below would silently never happen.
    expect(warded.markedDestroyed).toBe(true);
    expect(mortal.markedDestroyed).toBe(true);

    run.check();

    expect(cardAt(state, slot("p2", "units", 1))?.id).toBe(warded.id);
    expect(warded.markedDestroyed).toBe(false);
    expect(warded.position).toBe("ATK");
    expect(warded.tauntSuppressedTurn).toBe(state.turn);
    expect(state.players.p2.graveyard.map((c) => c.id)).toEqual([mortal.id]);
  });

  it("§3.2 marks only the top of a Stack pile, never the dormant card underneath (R13)", () => {
    const state = game("destroyAll-stack");
    const dormant = put(state, beast.id, slot("p2", "units", 1));
    const top = newInstance(state, beast.id, "p2", { z: "hand", player: "p2" });
    expect(placeOnField(state, top, slot("p2", "units", 1), { stack: true })).toBe(true);
    const run = runner(state);

    run.apply(destroyAll({ side: "enemy" }));

    expect(top.markedDestroyed).toBe(true);
    expect(dormant.markedDestroyed).toBeUndefined();

    run.check();

    // The top card left; the card beneath resumes acting rather than dying with it.
    expect(state.players.p2.graveyard.map((c) => c.id)).toEqual([top.id]);
    expect(cardAt(state, slot("p2", "units", 1))?.id).toBe(dormant.id);
  });
});

// ---------------------------------------------------------------------------
// destroyAdjacentTo
// ---------------------------------------------------------------------------

describe("destroyAdjacentTo (§3.1, M3-T1)", () => {
  it("§3.1 marks lanes N-1 and N+1 on the target's side and row: never lane N, never across sides, never across rows (#16 Hit Job)", () => {
    const state = game("destroyAdjacent-scope");
    const left = put(state, beast.id, slot("p2", "units", 2));
    const target = put(state, beast.id, slot("p2", "units", 3));
    const right = put(state, beast.id, slot("p2", "units", 4));
    const acrossSide = put(state, beast.id, slot("p1", "units", 2));
    const sameLaneOtherSide = put(state, beast.id, slot("p1", "units", 3));
    const acrossRow = put(state, fieldSpell.id, slot("p2", "backrow", 2));
    const run = runner(state);

    run.apply(destroyAdjacentTo({ target: chosen }), target);

    expect(left.markedDestroyed).toBe(true);
    expect(right.markedDestroyed).toBe(true);
    // Lane N itself: #16 marks it with its own `destroy`, not with this verb.
    expect(target.markedDestroyed).toBeUndefined();
    expect(acrossSide.markedDestroyed).toBeUndefined();
    expect(sameLaneOtherSide.markedDestroyed).toBeUndefined();
    expect(acrossRow.markedDestroyed).toBeUndefined();
  });

  it("§3.1 an edge lane has one neighbour, and #16's pairing kills the target with it in one state check (R59)", () => {
    const state = game("destroyAdjacent-edge");
    const target = put(state, beast.id, slot("p2", "units", 1));
    const right = put(state, beast.id, slot("p2", "units", 2));
    const far = put(state, beast.id, slot("p2", "units", 3));
    const run = runner(state);

    // Exactly what 016-hit-job.ts returns from its radiant Cry.
    run.applyAll([destroy({ target: chosen }), destroyAdjacentTo({ target: chosen })], target);

    expect([target.markedDestroyed, right.markedDestroyed]).toEqual([true, true]);
    expect(far.markedDestroyed).toBeUndefined();

    run.check();

    expect(state.players.p2.graveyard.map((c) => c.id).sort()).toEqual([target.id, right.id].sort());
    expect(eventsOfType(run.events, "destroyed")).toHaveLength(2);
    expect(cardAt(state, slot("p2", "units", 3))?.id).toBe(far.id);
  });

  it("§3.1 fizzles silently when the target is not on the field, and the card still resolves", () => {
    const state = game("destroyAdjacent-fizzle");
    const inHandCard = only(inHand(state, beast.id, "p1", 1));
    const neighbour = put(state, beast.id, slot("p1", "units", 1));
    const run = runner(state);

    run.apply(destroyAdjacentTo({ target: chosen }), inHandCard);

    expect(neighbour.markedDestroyed).toBeUndefined();
    expect(run.events).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// damageAll
// ---------------------------------------------------------------------------

describe("damageAll (§6.3, §4.4, R59, M3-T1)", () => {
  it("§4.4 deals one instance to each enemy unit and, with heroes, to the enemy hero, leaving allies untouched (#13 Jlockeed Shredder-10)", () => {
    const state = game("damageAll-enemies");
    const self = put(state, plain.id, slot("p1", "units", 1));
    const ally = put(state, beast.id, slot("p1", "units", 2));
    const first = put(state, beast.id, slot("p2", "units", 1));
    const second = put(state, beast.id, slot("p2", "units", 2));
    const third = put(state, beast.id, slot("p2", "units", 3));
    const run = runner(state);

    run.apply(damageAll({ side: "enemy", amount: 2, heroes: true }), undefined, { self });

    expect([first.damage, second.damage, third.damage]).toEqual([2, 2, 2]);
    expect(ally.damage).toBe(0);
    expect(self.damage).toBe(0);
    expect(state.players.p2.hero.health).toBe(HERO_HEALTH - 2);
    expect(state.players.p1.hero.health).toBe(HERO_HEALTH);
    // Units in lane order first, then the hero of the scoped side.
    expect(eventsOfType(run.events, "damage").map((e) => e.targetId)).toEqual([
      first.id,
      second.id,
      third.id,
      "hero-p2",
    ]);
    expect(eventsOfType(run.events, "damage").every((e) => e.sourceId === self.id)).toBe(true);
  });

  it("§4.4 snapshots its targets before the first hit: one damage event per unit present when the sweep began, and no unit hit twice (R59)", () => {
    const state = game("damageAll-snapshot");
    const self = put(state, plain.id, slot("p1", "units", 1));
    const present = [1, 2, 3].map((lane) => put(state, beast.id, slot("p2", "units", lane)));
    const run = runner(state);

    // 2 damage on 2-health bodies: every one of them is at 0 health by the second hit, and §4.5
    // never runs between the hits of one effect (R59), so all three are still standing here.
    run.apply(damageAll({ side: "enemy", amount: 2 }), undefined, { self });

    const hits = eventsOfType(run.events, "damage").map((e) => e.targetId);
    expect(hits).toHaveLength(present.length);
    expect(hits).toEqual(present.map((c) => c.id));
    expect(new Set(hits).size).toBe(present.length);
    expect(present.map((c) => c.damage)).toEqual([2, 2, 2]);

    // The list belongs to the apply that read it: a unit that joins the board afterwards took
    // nothing from the first sweep and is hit by the next one. No engine verb can move a card off
    // the field from inside `dealDamage`, so the snapshot's other half — a unit that dies mid-sweep
    // not changing who else is hit — is asserted above as "each target hit exactly once, in
    // `cardsInScope` order", which a per-hit re-read of the row could not promise.
    const latecomer = put(state, beast.id, slot("p2", "units", 4));
    expect(eventsOfType(run.events, "damage")).toHaveLength(present.length);

    run.apply(damageAll({ side: "enemy", amount: 1 }), undefined, { self });

    expect(latecomer.damage).toBe(1);
    expect(eventsOfType(run.events, "damage")).toHaveLength(present.length + present.length + 1);
  });

  it("§4.4 puts every hit through the whole pipeline: Divine Shield eats one, Armor soaks one, Indestructible takes none, and the sweep carries on", () => {
    const state = game("damageAll-pipeline");
    const self = put(state, plain.id, slot("p1", "units", 1));
    const shield = put(state, shielded.id, slot("p2", "units", 1));
    const armor = put(state, armoured.id, slot("p2", "units", 2));
    const warded = put(state, indestructible.id, slot("p2", "units", 3));
    const soft = put(state, beast.id, slot("p2", "units", 4));
    const run = runner(state);

    run.apply(damageAll({ side: "enemy", amount: 3 }), undefined, { self });

    expect(shield.damage).toBe(0);
    expect(shield.divineShieldSpent).toBe(true);
    expect(armor.damage).toBe(0);
    expect(warded.damage).toBe(0);
    expect(soft.damage).toBe(3);
    expect(eventsOfType(run.events, "divineShieldLost").map((e) => e.instanceId)).toEqual([shield.id]);
    expect(eventsOfType(run.events, "damage").map((e) => e.targetId)).toEqual([soft.id]);
  });

  it("§4.4 ignoreArmor reaches the same Armor 7 body the plain sweep could not (True Strike, §4.4 step 2)", () => {
    const state = game("damageAll-true-strike");
    const self = put(state, plain.id, slot("p1", "units", 1));
    const armor = put(state, armoured.id, slot("p2", "units", 1));
    const run = runner(state);

    run.apply(damageAll({ side: "enemy", amount: 3, ignoreArmor: true }), undefined, { self });

    expect(armor.damage).toBe(3);
    expect(eventsOfType(run.events, "damage").map((e) => e.targetId)).toEqual([armor.id]);
  });

  it('R68 heroes follows the scope\'s sides: side "any" hits both heroes, the active player\'s first', () => {
    const state = game("damageAll-both-heroes");
    const self = put(state, plain.id, slot("p1", "units", 1));
    const run = runner(state);

    run.apply(damageAll({ side: "any", amount: 1, heroes: true }), undefined, { self });

    expect(state.players.p1.hero.health).toBe(HERO_HEALTH - 1);
    expect(state.players.p2.hero.health).toBe(HERO_HEALTH - 1);
    expect(eventsOfType(run.events, "damage").map((e) => e.targetId)).toEqual([
      self.id,
      "hero-p1",
      "hero-p2",
    ]);
  });

  it("§6.3 a sweep over an empty board still hits the scoped hero", () => {
    const state = game("damageAll-empty-board");
    const run = runner(state);

    run.apply(damageAll({ side: "enemy", amount: 4, heroes: true }));

    expect(state.players.p2.hero.health).toBe(HERO_HEALTH - 4);
    expect(eventsOfType(run.events, "damage").map((e) => e.targetId)).toEqual(["hero-p2"]);
  });
});

// ---------------------------------------------------------------------------
// bounceAll
// ---------------------------------------------------------------------------

describe("bounceAll (§6.3, §3.2, R11, R12, R78, M3-T1)", () => {
  it("R12 returns real cards to their owners' hands and R11 makes a unit token cease to exist (#17 Flood)", () => {
    const state = game("bounceAll-owners");
    const mine = put(state, beast.id, slot("p1", "units", 1));
    mine.damage = 1;
    mine.buffs = { attack: 3, health: 3 };
    const token = put(state, rushToken.id, slot("p1", "units", 2));
    const theirs = put(state, beast.id, slot("p2", "units", 1));
    // R12: p1 owns it, p2 is standing it up; a bounce sends it to p1's hand, not p2's.
    const stolen = stolenOnto(state, beast.id, "p1", slot("p2", "units", 2));
    const run = runner(state);

    run.apply(bounceAll({ side: "any" }));

    expect(state.players.p1.hand.map((c) => c.id)).toEqual([mine.id, stolen.id]);
    expect(state.players.p2.hand.map((c) => c.id)).toEqual([theirs.id]);
    // R11: the token reached no hand at all and is not in either player's pile.
    expect(token.zone.z).toBe("gone");
    expect(state.players.p1.hand.map((c) => c.id)).not.toContain(token.id);
    expect(state.players.p1.graveyard).toHaveLength(0);
    // R78: the instance reset on the way off the field.
    expect(mine.damage).toBe(0);
    expect(mine.buffs).toEqual({ attack: 0, health: 0 });
    expect(eventsOfType(run.events, "bounced").map((e) => e.instanceId)).toEqual([
      mine.id,
      token.id,
      theirs.id,
      stolen.id,
    ]);
    for (const lane of [1, 2]) {
      expect(cardAt(state, slot("p1", "units", lane))).toBeNull();
      expect(cardAt(state, slot("p2", "units", lane))).toBeNull();
    }
  });

  it("§2.4 the hand cap applies inside the sweep, so a real card is burned to the graveyard", () => {
    const state = game("bounceAll-hand-cap");
    inHand(state, beast.id, "p1", HAND_CAP);
    const mine = put(state, beast.id, slot("p1", "units", 1));
    const run = runner(state);

    run.apply(bounceAll({ side: "self" }));

    expect(state.players.p1.hand).toHaveLength(HAND_CAP);
    expect(state.players.p1.hand.map((c) => c.id)).not.toContain(mine.id);
    expect(state.players.p1.graveyard.map((c) => c.id)).toEqual([mine.id]);
    expect(eventsOfType(run.events, "burned").map((e) => e.instanceId)).toEqual([mine.id]);
  });

  it('§3.2 defaults to the unit row: "Bounce all units" leaves the backrow in place', () => {
    const state = game("bounceAll-default-rows");
    const unit = put(state, beast.id, slot("p2", "units", 1));
    const backrow = put(state, fieldSpell.id, slot("p2", "backrow", 1));
    const run = runner(state);

    run.apply(bounceAll({ side: "enemy" }));

    expect(state.players.p2.hand.map((c) => c.id)).toEqual([unit.id]);
    expect(cardAt(state, slot("p2", "backrow", 1))?.id).toBe(backrow.id);
  });
});

// ---------------------------------------------------------------------------
// exileAll
// ---------------------------------------------------------------------------

describe("exileAll (§6.3, R11, R55, M3-T1)", () => {
  it("§6.3 exiles every permanent on both sides but the running card, and bumps counters.exiled once per card that reached the pile (#100 Ceaseless Void)", () => {
    const state = game("exileAll-void");
    const self = put(state, beast.id, slot("p1", "units", 1));
    const myOther = put(state, beast.id, slot("p1", "units", 2));
    const myToken = put(state, rushToken.id, slot("p1", "units", 3));
    const myBackrow = put(state, fieldSpell.id, slot("p1", "backrow", 1));
    const theirUnit = put(state, beast.id, slot("p2", "units", 1));
    const theirBackrow = put(state, fieldSpell.id, slot("p2", "backrow", 2));
    const run = runner(state);

    run.apply(exileAll({ side: "any", rows: ["units", "backrow"], excludeSelf: true }), undefined, { self });

    // excludeSelf: the Void is still standing after its own Cry.
    expect(cardAt(state, slot("p1", "units", 1))?.id).toBe(self.id);
    expect(state.players.p1.exile.map((c) => c.id)).toEqual([myOther.id, myBackrow.id]);
    expect(state.players.p2.exile.map((c) => c.id)).toEqual([theirUnit.id, theirBackrow.id]);
    // R11: the token ceased to exist instead of reaching a pile, so it is not counted (R55)...
    expect(myToken.zone.z).toBe("gone");
    expect(state.counters.exiled).toBe(4);
    // ... while the event still reports it leaving.
    expect(eventsOfType(run.events, "exiled").map((e) => e.instanceId)).toEqual([
      myOther.id,
      myToken.id,
      myBackrow.id,
      theirUnit.id,
      theirBackrow.id,
    ]);
    expect(cardAt(state, slot("p2", "backrow", 2))).toBeNull();
  });

  it("§6.3 without excludeSelf the sweep takes the running card too", () => {
    const state = game("exileAll-includes-self");
    const self = put(state, beast.id, slot("p1", "units", 1));
    const run = runner(state);

    run.apply(exileAll({ side: "self" }), undefined, { self });

    expect(cardAt(state, slot("p1", "units", 1))).toBeNull();
    expect(state.players.p1.exile.map((c) => c.id)).toEqual([self.id]);
    expect(state.counters.exiled).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// exileAdjacentTo
// ---------------------------------------------------------------------------

describe("exileAdjacentTo (§3.1, M3-T1)", () => {
  it("§3.1 exiles the neighbours in the target's row and leaves the other row and the target alone (#34 Collateral Damage)", () => {
    const state = game("exileAdjacent-row");
    const left = put(state, fieldSpell.id, slot("p2", "backrow", 2));
    const target = put(state, fieldSpell.id, slot("p2", "backrow", 3));
    const right = put(state, fieldSpell.id, slot("p2", "backrow", 4));
    const unitBeside = put(state, beast.id, slot("p2", "units", 2));
    const unitBehind = put(state, beast.id, slot("p2", "units", 3));
    const run = runner(state);

    run.apply(exileAdjacentTo({ target: chosen }), target);

    expect(state.players.p2.exile.map((c) => c.id)).toEqual([left.id, right.id]);
    expect(state.counters.exiled).toBe(2);
    // Adjacency never crosses rows, so "in its row" needs no argument of its own.
    expect(cardAt(state, slot("p2", "backrow", 3))?.id).toBe(target.id);
    expect(cardAt(state, slot("p2", "units", 2))?.id).toBe(unitBeside.id);
    expect(cardAt(state, slot("p2", "units", 3))?.id).toBe(unitBehind.id);
  });

  it("§3.1 an empty neighbouring lane contributes nothing and the effect still resolves", () => {
    const state = game("exileAdjacent-gap");
    const target = put(state, beast.id, slot("p2", "units", 3));
    const right = put(state, beast.id, slot("p2", "units", 4));
    const run = runner(state);

    run.apply(exileAdjacentTo({ target: chosen }), target);

    expect(state.players.p2.exile.map((c) => c.id)).toEqual([right.id]);
    expect(cardAt(state, slot("p2", "units", 3))?.id).toBe(target.id);
  });
});

// ---------------------------------------------------------------------------
// discardHand
// ---------------------------------------------------------------------------

describe("discardHand (§6.3, R16, R31, §10.7, M3-T1)", () => {
  it("R31 empties the hand into the graveyard in hand order (#76 Field of Dreams)", () => {
    const state = game("discardHand-order");
    const cards = inHand(state, beast.id, "p1", 3);
    const run = runner(state);

    run.apply(discardHand({ player: "self" }));

    expect(state.players.p1.hand).toHaveLength(0);
    expect(state.players.p1.graveyard.map((c) => c.id)).toEqual(cards.map((c) => c.id));
    expect(eventsOfType(run.events, "discarded").map((e) => e.instanceId)).toEqual(cards.map((c) => c.id));
    expect(eventsOfType(run.events, "enteredGraveyard").map((e) => e.instanceId)).toEqual(cards.map((c) => c.id));
  });

  it("§10.7 draws nothing from the rng, so rngCursor and every downstream replay hash are unchanged", () => {
    const state = game("discardHand-rng");
    inHand(state, beast.id, "p1", 3);
    const run = runner(state);
    const before = run.sink.rng.cursor;

    run.apply(discardHand({ player: "self" }));

    expect(state.players.p1.hand).toHaveLength(0);
    expect(run.sink.rng.cursor).toBe(before);
    expect(state.rngCursor).toBe(before);

    // Not a vacuous assertion: the random form of the same sweep does move the cursor, which is
    // exactly why a whole-hand discard must not be written as `discardRandom({ count: n })`.
    inHand(state, beast.id, "p1", 3);
    run.apply(discardRandom({ count: 3, player: "self" }));
    expect(run.sink.rng.cursor).toBeGreaterThan(before);
  });

  it("R11 a unit-token card in hand ceases to exist rather than reaching the graveyard", () => {
    const state = game("discardHand-token");
    const real = only(inHand(state, beast.id, "p1", 1));
    const token = only(inHand(state, rushToken.id, "p1", 1));
    const run = runner(state);

    run.apply(discardHand({ player: "self" }));

    expect(state.players.p1.hand).toHaveLength(0);
    expect(state.players.p1.graveyard.map((c) => c.id)).toEqual([real.id]);
    expect(token.zone.z).toBe("gone");
    expect(eventsOfType(run.events, "discarded")).toHaveLength(2);
    expect(eventsOfType(run.events, "enteredGraveyard").map((e) => e.instanceId)).toEqual([real.id]);
  });

  it('§6.3 player: "enemy" empties the opponent\'s hand and leaves the controller\'s alone', () => {
    const state = game("discardHand-enemy");
    const mine = inHand(state, beast.id, "p1", 2);
    const theirs = inHand(state, beast.id, "p2", 2);
    const run = runner(state);

    run.apply(discardHand({ player: "enemy" }));

    expect(state.players.p1.hand.map((c) => c.id)).toEqual(mine.map((c) => c.id));
    expect(state.players.p2.hand).toHaveLength(0);
    expect(state.players.p2.graveyard.map((c) => c.id)).toEqual(theirs.map((c) => c.id));
  });
});

// ---------------------------------------------------------------------------
// exileHand
// ---------------------------------------------------------------------------

describe("exileHand (§6.3, R11, R55, §10.7, M3-T1)", () => {
  it("§6.3 empties the hand into the exile pile and bumps counters.exiled once per card that got there (#78 /fullsend)", () => {
    const state = game("exileHand-sweep");
    const cards = inHand(state, beast.id, "p1", 3);
    const token = only(inHand(state, rushToken.id, "p1", 1));
    const run = runner(state);
    const before = run.sink.rng.cursor;

    run.apply(exileHand({ player: "self" }));

    expect(state.players.p1.hand).toHaveLength(0);
    expect(state.players.p1.exile.map((c) => c.id)).toEqual(cards.map((c) => c.id));
    // R11: the unit-token card ceased to exist, so it is not in the pile and not counted (R55).
    expect(token.zone.z).toBe("gone");
    expect(state.counters.exiled).toBe(3);
    expect(eventsOfType(run.events, "exiled")).toHaveLength(4);
    expect(state.players.p1.graveyard).toHaveLength(0);
    // The same determinism as `discardHand`: no choice, so no rng draw (§10.7).
    expect(run.sink.rng.cursor).toBe(before);
  });

  it("§6.3 does nothing to an empty hand, and the card still resolves", () => {
    const state = game("exileHand-empty");
    const run = runner(state);

    run.apply(exileHand({ player: "self" }));

    expect(state.counters.exiled).toBe(0);
    expect(run.events).toEqual([]);
  });
});
