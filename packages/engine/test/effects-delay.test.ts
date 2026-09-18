// The two `modifiers.ts` verbs: `delay` and `addPlayerModifier`
// (SPEC §2.2, §2.3, §6.3 Cost/Mana, §10.1, §10.6; R30, R48, R62, R68, R76, R86; BUILD M3-T1/M3-T5).
//
// `test/modifiers.test.ts` already proves the SUBSYSTEM — `scheduleDelayed`, `dueDelayed`,
// `addModifier`, `expireModifiers` and R62's two points in the turn loop. This file proves the two
// EFFECTS in front of it: that what a card file writes lands as the record the subsystem expects,
// and that the record really comes back at the turn boundary running the card's own script.
//
// It also pins two gaps in `turn.ts`'s `runDelayed`, which is NOT part of this work. Both are
// marked `it.fails`, so vitest reports them green while they are broken and turns RED the moment
// either is fixed — which is the point: a known-failing test naming a real gap is worth more than a
// passing tautology, and it cannot be forgotten. Each carries the one-line fix in a comment.
//
// The fixture cards are registered here on top of the shared fixture catalog, so no shared fixture
// has to grow for them (CLAUDE.md, BUILD §0).

import type { Action, ActionInput, CardDef } from "@jackioh/shared";
import { describe, expect, it } from "vitest";
import { registerCatalog, registeredCatalog } from "../src/catalog";
import { HERO_HEALTH } from "../src/config";
import { damage } from "../src/effects/damage";
import { delay, DELAYED_HOOK } from "../src/effects/delay";
import { addPlayerModifier } from "../src/effects/playerMods";
import { effectiveCost, modifierIsLive } from "../src/mana";
import { dueDelayed, expireModifiers } from "../src/modifiers";
import { RESUME_HOOK } from "../src/prompts";
import { beginGame, reduce } from "../src/reduce";
import { applyEffects, makeContext } from "../src/resolve";
import type { CardScripts, Hook, Script } from "../src/script";
import { registerScripts, registeredScripts } from "../src/scripts";
import type { CardInstance, DelayedEffect, GameState, PlayerModifier } from "../src/state";
import { moveToZone } from "../src/zones";
import { indestructible } from "./fixtures/combat";
import { eventsOfType, inHand, newGame, put, sinkFor, slot } from "./fixtures/harness";

// ---------------------------------------------------------------------------
// Fixture cards. Indices start above 1500 so they never collide with another test file's locals.
// ---------------------------------------------------------------------------

let nextIndex = 1500;
function unitDefOf(name: string, overrides: Partial<CardDef> = {}): CardDef {
  nextIndex += 1;
  return {
    id: `dl-${name}`,
    index: String(nextIndex),
    name: `${name} (delay)`,
    set: "Core",
    type: "Unit",
    tags: [],
    rarity: "Common",
    token: false,
    cost: 1,
    base: { attack: 1, health: 9, keywords: [], text: name },
    radiant: { attack: 2, health: 18, keywords: [], text: `${name} radiant` },
    ...overrides,
  };
}

/** The step every delay below names (§10.6: "script id + step + captured data"). */
const BOLT_STEP = "bolt";

/** `data.amount` to the enemy hero, so the captured data is observable in hero health. */
const boltHook: Hook = (ctx) => [
  damage({ to: { of: "enemyHero" }, amount: Number(ctx.data.amount ?? 0) }),
];

/**
 * A body that registers the same continuation BOTH ways: as its own `delayed` hook (the shape
 * `turn.runDelayed` can re-enter today) and as an entry in its `resume` step table (the shape
 * `prompts.runResume` and `work.cardStepFor` understand). That is what lets one fixture prove the
 * first spelling works and the second does not, with nothing else different between the two tests.
 */
const boltScript: Script = { delayed: boltHook, resume: { [BOLT_STEP]: boltHook } };

const bolt = unitDefOf("bolt");

const DL_DEFS: CardDef[] = [bolt];
const DL_SCRIPTS: Record<string, CardScripts> = {
  [bolt.id]: { base: boltScript, radiant: boltScript },
};

// ---------------------------------------------------------------------------
// Harness.
// ---------------------------------------------------------------------------

let nonce = 0;
function act(state: GameState, body: ActionInput): GameState {
  nonce += 1;
  const result = reduce(state, { ...body, nonce: `dl${nonce}` } as Action);
  if (result.error !== undefined) throw new Error(result.error);
  return result.state;
}

function endTurns(state: GameState, count: number): GameState {
  let next = state;
  for (let i = 0; i < count; i += 1) next = act(next, { type: "endTurn", playerId: next.active });
  return next;
}

/** Past the mulligans, in p1's main phase of turn 1, with the local defs folded in. */
function playing(seed: string): GameState {
  const fresh = newGame(seed);
  registerCatalog({ ...registeredCatalog(), ...Object.fromEntries(DL_DEFS.map((d) => [d.id, d])) });
  registerScripts({ ...registeredScripts(), ...DL_SCRIPTS });
  let state = beginGame(fresh).state;
  state = act(state, { type: "mulligan", keep: state.players.p1.hand.map((c) => c.id), playerId: "p1" });
  state = act(state, { type: "mulligan", keep: state.players.p2.hand.map((c) => c.id), playerId: "p2" });
  return state;
}

/** Apply effects the way `resolve.ts` does, straight onto `state`, and keep the events. */
function run(
  state: GameState,
  effects: Parameters<typeof applyEffects>[0],
  options: { self?: CardInstance | null; controller?: "p1" | "p2" } = {},
): ReturnType<typeof sinkFor> {
  const { self = null, ...rest } = options;
  const sink = sinkFor(state);
  applyEffects(effects, makeContext(sink, self, rest));
  state.rngCursor = sink.rng.cursor;
  return sink;
}

/** `noUncheckedIndexedAccess` makes every index a maybe; these two narrow it once. */
function only(entries: readonly DelayedEffect[]): DelayedEffect {
  const entry = entries[0];
  if (entry === undefined) throw new Error("expected one delayed effect");
  return entry;
}

function one(cards: readonly CardInstance[]): CardInstance {
  const card = cards[0];
  if (card === undefined) throw new Error("expected a card");
  return card;
}

// ---------------------------------------------------------------------------
// delay
// ---------------------------------------------------------------------------

describe("delay: scheduling (§10.1, §10.6, R62, R68)", () => {
  it("R62 stores one entry at the named phase and player, owned by the controller, carrying the captured data", () => {
    const state = playing("delay-schedule");
    const scribe = put(state, bolt.id, slot("p1", "units", 1));

    run(state, [delay({ at: { phase: "end", player: "self" }, step: BOLT_STEP, data: { amount: 3 } })], {
      self: scribe,
      controller: "p1",
    });

    expect(state.delayed).toHaveLength(1);
    expect(only(state.delayed)).toMatchObject({
      owner: "p1",
      at: { phase: "end", player: "p1" },
      resume: {
        defId: bolt.id,
        hook: DELAYED_HOOK,
        step: BOLT_STEP,
        radiant: false,
        instanceId: scribe.id,
        data: { amount: 3 },
      },
    });
    // §10.1 keeps the state JSON-only, so the stored continuation is data and not a closure.
    expect(JSON.parse(JSON.stringify(state.delayed))).toEqual(state.delayed);
  });

  it("§10.6 reads at.player as a PlayerSpec, so \"enemy\" waits for the opponent's boundary", () => {
    const state = playing("delay-enemy");
    const scribe = put(state, bolt.id, slot("p1", "units", 1));

    run(state, [delay({ at: { phase: "start", player: "enemy" }, step: BOLT_STEP })], {
      self: scribe,
      controller: "p1",
    });

    // The owner is still the scheduler — it is whose sequence resolves — but the boundary is p2's.
    expect(only(state.delayed)).toMatchObject({ owner: "p1", at: { phase: "start", player: "p2" } });
    expect(dueDelayed(state, "start", "p1")).toEqual([]);
    expect(dueDelayed(state, "start", "p2")).toHaveLength(1);
  });

  it("§5.2 records the face that is running, so a Radiant scheduler resumes its radiant text", () => {
    const state = playing("delay-radiant");
    const scribe = put(state, bolt.id, slot("p1", "units", 2), { radiant: true });

    run(state, [delay({ at: { phase: "end", player: "self" }, step: BOLT_STEP })], {
      self: scribe,
      controller: "p1",
    });

    expect(only(state.delayed).resume.radiant).toBe(true);
  });

  it("R68 keeps two delays scheduled in one effect list in creation order by seq", () => {
    const state = playing("delay-order");
    const scribe = put(state, bolt.id, slot("p1", "units", 1));

    run(
      state,
      [
        delay({ at: { phase: "end", player: "self" }, step: BOLT_STEP, data: { amount: 1 } }),
        delay({ at: { phase: "end", player: "self" }, step: BOLT_STEP, data: { amount: 4 } }),
      ],
      { self: scribe, controller: "p1" },
    );

    const [first, second] = state.delayed;
    expect(first?.seq).toBeLessThan(second?.seq ?? -1);
    expect(first?.id).not.toBe(second?.id);

    // R68 is "the order they were created", not the order the array happens to hold them in.
    state.delayed.reverse();
    expect(dueDelayed(state, "end", "p1").map((e) => e.resume.data.amount)).toEqual([1, 4]);
  });
});

describe("delay: coming due (§2.2, R62, R76, R86)", () => {
  it("R62 the hook: \"delayed\" form round-trips a real end-of-turn boundary with its captured data", () => {
    const state = playing("delay-round-trip");
    const scribe = put(state, bolt.id, slot("p1", "units", 1));
    run(state, [delay({ at: { phase: "end", player: "self" }, step: BOLT_STEP, data: { amount: 3 } })], {
      self: scribe,
      controller: "p1",
    });
    expect(state.players.p2.hero.health).toBe(HERO_HEALTH);

    const ended = endTurns(state, 1);

    // The card's own `delayed` hook ran, reading the amount the continuation carried.
    expect(ended.players.p2.hero.health).toBe(HERO_HEALTH - 3);
    // R62/§10.1: the entry is dropped once it has resolved, so it never fires twice.
    expect(ended.delayed).toEqual([]);
  });

  it("R62 a start-of-turn delay fires at its own controller's next start, not the opponent's", () => {
    const state = playing("delay-start");
    const scribe = put(state, bolt.id, slot("p1", "units", 1));
    run(state, [delay({ at: { phase: "start", player: "self" }, step: BOLT_STEP, data: { amount: 2 } })], {
      self: scribe,
      controller: "p1",
    });

    // p1 ends; p2's whole turn passes with the entry still waiting.
    const afterP1 = endTurns(state, 1);
    expect(afterP1.active).toBe("p2");
    expect(afterP1.players.p2.hero.health).toBe(HERO_HEALTH);
    expect(afterP1.delayed).toHaveLength(1);

    const backToP1 = endTurns(afterP1, 1);
    expect(backToP1.active).toBe("p1");
    expect(backToP1.players.p2.hero.health).toBe(HERO_HEALTH - 2);
    expect(backToP1.delayed).toEqual([]);
  });

  it("R76 #50 still fires after its scheduler has died: the continuation is found in the graveyard", () => {
    const state = playing("delay-graveyard");
    const scribe = put(state, bolt.id, slot("p1", "units", 1));
    run(state, [delay({ at: { phase: "start", player: "self" }, step: BOLT_STEP, data: { amount: 5 } })], {
      self: scribe,
      controller: "p1",
    });

    // "Fires even if Kpop Fanatic died" (§8.2 #50, R76).
    moveToZone(state, scribe, "graveyard");
    expect(state.players.p1.graveyard.map((card) => card.id)).toContain(scribe.id);

    const backToP1 = endTurns(state, 2);
    expect(backToP1.players.p2.hero.health).toBe(HERO_HEALTH - 5);
    expect(backToP1.delayed).toEqual([]);
  });

  it("R86 #39 still fires after its scheduler has exiled itself in the same effect list", () => {
    const state = playing("delay-exile");
    const scribe = put(state, bolt.id, slot("p1", "units", 3));
    run(state, [delay({ at: { phase: "end", player: "self" }, step: BOLT_STEP, data: { amount: 6 } })], {
      self: scribe,
      controller: "p1",
    });

    // #39 Recycling Initiative arms the delay and then exiles itself, so the continuation has to
    // come back to a card in the exile pile.
    moveToZone(state, scribe, "exile");
    expect(state.players.p1.exile.map((card) => card.id)).toContain(scribe.id);

    const ended = endTurns(state, 1);
    expect(ended.players.p2.hero.health).toBe(HERO_HEALTH - 6);
    expect(ended.delayed).toEqual([]);
  });

  it("records a continuation with no instance when the scheduler has no ctx.self", () => {
    const state = playing("delay-no-self");

    run(state, [delay({ at: { phase: "end", player: "self" }, step: BOLT_STEP, data: { amount: 7 } })], {
      self: null,
      controller: "p1",
    });

    // §10.6: `resumeSelf` leaves `instanceId` out when there is no instance, which is the shape
    // R76 needs. `defId` is empty for the same reason — a null self cannot name its own script.
    const entry = only(state.delayed);
    expect(entry.resume.instanceId).toBeUndefined();
    expect(entry.resume.defId).toBe("");
    expect(entry.resume.data).toEqual({ amount: 7 });
    // The scheduling half is complete: it is stored, it is owned, and it is due.
    expect(dueDelayed(state, "end", "p1")).toHaveLength(1);
  });
});

describe("delay: engine gaps in turn.runDelayed (not part of this work)", () => {
  /**
   * !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
   * GAP 1 — `turn.runDelayed` CANNOT RE-ENTER A `resume` STEP TABLE.
   *
   * `packages/engine/src/turn.ts`, in `runDelayed`:
   *     runHook(sink, card, effect.resume.hook as HookName, { data: …, controller: … });
   * and `resolve.runHook` does `script[name]` and then CALLS the result. `Script.resume` is a
   * RECORD of steps, not a function, so `hook: "resume"` throws "hook is not a function" instead
   * of looking `resume.step` up in the table. `work.ts`'s `cardStepFor` already handles both
   * shapes, and `prompts.runResume` is the public function built on it.
   *
   * THE ONE-LINE FIX, in `packages/engine/src/turn.ts`'s `runDelayed`: replace the
   * `findAnywhere` + `runHook` pair with
   *     runResume(sink, effect.resume, { controller: effect.owner });
   * (import from `./prompts`). That fixes GAP 2 below at the same time, makes a delayed effect
   * resumable when its step opens a prompt (§9.3), and drops `findAnywhere` entirely, since
   * `runResume` finds the instance itself with `findInstance` and resumes with `ctx.self === null`
   * when it is gone.
   *
   * THIS TEST IS `it.fails`: it passes while the gap is open and turns RED when it is closed —
   * delete the `.fails` then. #39 Recycling Initiative and #50 Kpop Fanatic both keep their
   * continuation in `resume`, so until this is fixed they must pass `hook: DELAYED_HOOK` (the
   * default) and put the step in a `delayed` hook instead.
   * !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
   */
  it.fails("GAP §10.6: a delay whose hook is the resume step table never re-enters it", () => {
    const state = playing("delay-step-table");
    const scribe = put(state, bolt.id, slot("p1", "units", 1));
    run(
      state,
      [
        delay({
          at: { phase: "end", player: "self" },
          step: BOLT_STEP,
          hook: RESUME_HOOK,
          data: { amount: 4 },
        }),
      ],
      { self: scribe, controller: "p1" },
    );
    expect(only(state.delayed).resume.hook).toBe(RESUME_HOOK);

    // The fixture's `resume` table holds exactly this step, so a reader that understood the table
    // would run it. `runHook` calls the table itself instead.
    const ended = endTurns(state, 1);
    expect(ended.players.p2.hero.health).toBe(HERO_HEALTH - 4);
  });

  /**
   * !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
   * GAP 2 — `turn.runDelayed` DROPS EVERY DELAY WITH NO `resume.instanceId`.
   *
   * `packages/engine/src/turn.ts`, in `runDelayed`:
   *     const instance = effect.resume.instanceId;
   *     …
   *     if (instance === undefined) continue;        // <-- silently never fires
   * So a delay scheduled by a script with no `ctx.self` is stored, comes due, is dropped from
   * `state.delayed` and never runs — the one shape §10.6 and R76 explicitly allow ("an instance
   * that has ceased to exist resumes with `ctx.self === null`, which is why a step carries what it
   * needs in `data`").
   *
   * THE ONE-LINE FIX is GAP 1's: `runResume(sink, effect.resume, { controller: effect.owner })`
   * resumes a continuation with no instance perfectly well.
   *
   * A SECOND HALF, IN THIS DIRECTORY, IF ANY CARD EVER NEEDS IT: `prompts.resumeSelf` can only
   * name the def id through `ctx.self`, so with a null self it stores `defId: ""` and there is no
   * script to re-enter either. `delay` would then need a `defId` option. No Core card is in that
   * position — every card that delays is on the field or parked in `resolving` when it does — so
   * this is reported, not built.
   *
   * THIS TEST IS `it.fails` for both halves together; the assertion above it (the passing
   * "records a continuation with no instance" test) pins the scheduling half separately.
   * !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!
   */
  it.fails("GAP R76: a delay scheduled with no ctx.self comes due and is dropped without firing", () => {
    const state = playing("delay-no-self-fires");
    run(state, [delay({ at: { phase: "end", player: "self" }, step: BOLT_STEP, data: { amount: 7 } })], {
      self: null,
      controller: "p1",
    });

    const ended = endTurns(state, 1);
    expect(ended.players.p2.hero.health).toBe(HERO_HEALTH - 7);
  });
});

// ---------------------------------------------------------------------------
// addPlayerModifier
// ---------------------------------------------------------------------------

/** The five shapes the Core cards really pass, each named by the card that passes it. */
function fiveRealShapes(turn: number): Parameters<typeof applyEffects>[0] {
  return [
    // #35 Lunar Eclipse: "the next Spell you play this turn costs 1 less".
    addPlayerModifier({
      player: "self",
      mod: {
        kind: "costDiscount",
        amount: 1,
        onlyType: "Spell",
        oncePerTurn: true,
        expiry: { until: "thisTurn", turn },
      },
    }),
    // #77 Professor Curvature: "your 4-cost cards cost 1 less through your next turn" (R48).
    addPlayerModifier({
      player: "self",
      mod: {
        kind: "costDiscount",
        amount: 1,
        onlyCurrentCost: 4,
        expiry: { until: "nextTurnOf", player: "p1", fromTurn: turn },
      },
    }),
    // #78 /fullsend: "your cards cost 1 less this turn" and "gain Combo: draw 1".
    addPlayerModifier({
      player: "self",
      mod: { kind: "costDiscount", amount: 1, expiry: { until: "thisTurn", turn } },
    }),
    addPlayerModifier({
      player: "self",
      mod: { kind: "comboDraw", amount: 1, expiry: { until: "thisTurn", turn } },
    }),
    // #79 Twinspell: "your next spell resolves one more time" — not turn-scoped (§2.2).
    addPlayerModifier({
      player: "self",
      mod: { kind: "echoNextSpell", amount: 1, sourceId: "c-twinspell", expiry: { until: "used" } },
    }),
  ];
}

describe("addPlayerModifier (§2.2, §2.3, §6.3 Cost, R30, R48, R65)", () => {
  it("§10.1 puts each of the five real card shapes on the named player with an id and a modifierChanged event", () => {
    const state = playing("player-mods");
    const sink = run(state, fiveRealShapes(state.turn), { controller: "p1" });

    const mods = state.players.p1.mods;
    expect(mods).toHaveLength(5);
    // Nothing lands on the opponent: `playerOf` resolved "self" against the controller.
    expect(state.players.p2.mods).toEqual([]);

    // `modifiers.addModifier` assigns the id, so every modifier has a distinct one (§9.3: it is
    // derived from `nextSeq`, which makes it deterministic under replay).
    const ids = mods.map((mod) => mod.id);
    expect(new Set(ids).size).toBe(5);
    expect(ids.every((id) => id.length > 0)).toBe(true);

    // One `modifierChanged` per modifier, in the order the effect list applied them (§10.3).
    expect(eventsOfType(sink.events, "modifierChanged")).toEqual(
      ids.map((id) => ({ type: "modifierChanged", player: "p1", modifierId: id, added: true })),
    );

    // The shapes survive as written, `id` apart, so `mana.ts` reads back what the card meant.
    expect(mods.map((mod) => mod.kind)).toEqual([
      "costDiscount",
      "costDiscount",
      "costDiscount",
      "comboDraw",
      "echoNextSpell",
    ]);
    // R48: every shape is live now except Curvature's, which covers the controller's NEXT turn.
    expect(mods.map((mod) => modifierIsLive(state, mod))).toEqual([true, false, true, true, true]);
  });

  it("§6.3 Cost the discount it installs really discounts, and \"enemy\" installs it on the opponent", () => {
    const state = playing("player-mods-cost");
    const mine = one(inHand(state, indestructible.id, "p1"));
    const theirs = one(inHand(state, indestructible.id, "p2"));
    expect(effectiveCost(state, mine)).toBe(4);

    run(
      state,
      [
        addPlayerModifier({
          player: "self",
          mod: { kind: "costDiscount", amount: 1, expiry: { until: "thisTurn", turn: state.turn } },
        }),
      ],
      { controller: "p1" },
    );

    // R65: a player discount is part of `effectiveCost`, which is the only place cost is computed.
    expect(effectiveCost(state, mine)).toBe(3);
    expect(effectiveCost(state, theirs)).toBe(4);

    run(
      state,
      [
        addPlayerModifier({
          player: "enemy",
          mod: { kind: "costDiscount", amount: 2, expiry: { until: "thisTurn", turn: state.turn } },
        }),
      ],
      { controller: "p1" },
    );

    expect(state.players.p2.mods).toHaveLength(1);
    expect(effectiveCost(state, theirs)).toBe(2);
    expect(effectiveCost(state, mine)).toBe(3);
  });

  it("§2.2 cleanup takes the thisTurn modifiers at that player's own turn end and leaves until: \"used\" standing", () => {
    const state = playing("player-mods-expiry");
    const sink = run(state, fiveRealShapes(state.turn), { controller: "p1" });
    const before: PlayerModifier[] = [...state.players.p1.mods];

    // §2.2's cleanup, which `turn.ts` runs at the end of this player's turn.
    expireModifiers(sink, "p1");

    const kinds = state.players.p1.mods.map((mod) => mod.kind);
    // The three `thisTurn` modifiers are gone: two costDiscounts and the comboDraw.
    expect(kinds).toEqual(["costDiscount", "echoNextSpell"]);
    // R48: the next-turn discount survives the turn it was created on.
    const survivor = state.players.p1.mods.find((mod) => mod.kind === "costDiscount");
    expect(survivor?.expiry).toEqual({ until: "nextTurnOf", player: "p1", fromTurn: state.turn });
    // §2.2: "Twinspell's pending Echo is not turn-scoped and survives cleanup."
    expect(state.players.p1.mods.find((mod) => mod.kind === "echoNextSpell")?.expiry).toEqual({
      until: "used",
    });

    // One removal event per modifier taken, naming exactly the three that went.
    const removed = eventsOfType(sink.events, "modifierChanged")
      .filter((event) => event.added === false)
      .map((event) => event.modifierId);
    const gone = before
      .filter((mod) => !state.players.p1.mods.some((kept) => kept.id === mod.id))
      .map((mod) => mod.id);
    expect(removed).toEqual(gone);
    expect(gone).toHaveLength(3);
  });
});
