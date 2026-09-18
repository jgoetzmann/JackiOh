// The §6.3 combat verbs a card script needs: Forced attack (#9 Moths to the Flame, #60 Bear
// Honeypot), Cancel an attack (#96 My Pawn) and the AI turn behind it (§10.7, R44, R84).
//
// These effects are thin wrappers, so the tests here assert the wrapper's own decisions — who is
// compelled, in what order, against what target, and what the wrapper leaves alone — and lean on
// combat-resolution.test.ts for §4.3 and §4.4 themselves. Every assertion runs through a real
// `EffectContext`, and the one verb the engine cannot service yet is a marked failing test rather
// than a tautology.

import type { CardDef, GameEvent, PlayerId, Selection } from "@jackioh/shared";
import { describe, expect, it } from "vitest";
import { registerCatalog, registeredCatalog } from "../src/catalog";
import { declareAttack } from "../src/combat";
import { aiPlaysOutTurn, cancelAttack, forcedAttacks, forcedAttacksOn } from "../src/effects/combat";
import { summon } from "../src/effects/summon";
import { openPrompt } from "../src/prompts";
import { makeContext } from "../src/resolve";
import type { Effect } from "../src/script";
import type { CardInstance, GameState, PromptOption, Resume } from "../src/state";
import { cardAt } from "../src/zones";
import { bigBody, plain, taunter } from "./fixtures/combat";
import { eventsOfType, inHand, newGame, put, sinkFor, slot } from "./fixtures/harness";

// ---------------------------------------------------------------------------
// Fixture cards: the two bodies fixtures/combat.ts does not carry.
// ---------------------------------------------------------------------------

function defOfKind(name: string, index: string, type: CardDef["type"], overrides: Partial<CardDef> = {}): CardDef {
  return {
    id: `fc-${name}`,
    index,
    name: `${name} (forced combat)`,
    set: "Core",
    type,
    tags: [],
    rarity: "Common",
    token: false,
    cost: 1,
    base: { attack: 1, health: 1, keywords: [], text: name },
    radiant: { attack: 2, health: 2, keywords: [], text: `${name} radiant` },
    ...overrides,
  };
}

/** R53's "stops once the target has left the field": a 1/1 that dies to the first forced attack. */
const frail = defOfKind("frail", "941", "Unit");
/** A backrow card to be the `self` of a trap's script, the way #96 My Pawn is (§4.2 step 4). */
const ambush = defOfKind("ambush", "942", "Trap", {
  base: { keywords: [], text: "trap" },
  radiant: { keywords: [], text: "trap" },
});

/** §8 #9's body, from the shared combat fixtures: 1/14, so three forced attacks do not kill it. */
const MOTHS = "cb-moths";
/** §7's shared Rush Token: 3/3 Rush, which is what #60 summons and compels. */
const RUSH_TOKEN = "fx-token-rush";

const DEFS: CardDef[] = [frail, ambush];

function game(seed = "effects-combat"): GameState {
  const state = newGame(seed);
  registerCatalog({ ...registeredCatalog(), ...Object.fromEntries(DEFS.map((def) => [def.id, def])) });
  state.turn = 5;
  state.phase = "main";
  return state;
}

type RunOptions = { controller?: PlayerId; self?: CardInstance; targets?: Selection[] };

/** Apply a whole effect list the way a hook's list is applied: one context, one rng, in order. */
function runAll(state: GameState, effects: Effect[], options: RunOptions = {}): GameEvent[] {
  const sink = sinkFor(state);
  const ctx = makeContext(sink, options.self ?? null, {
    controller: options.controller ?? "p1",
    ...(options.targets === undefined ? {} : { targets: options.targets }),
  });
  for (const effect of effects) effect.apply(ctx);
  state.rngCursor = sink.rng.cursor;
  return sink.events;
}

function run(state: GameState, effect: Effect, options: RunOptions = {}): GameEvent[] {
  return runAll(state, [effect], options);
}

function declarations(events: readonly GameEvent[]): { attackerId: string; targetId: string; forced: boolean }[] {
  return eventsOfType(events, "attackDeclared").map((event) => ({
    attackerId: event.attackerId,
    targetId: event.targetId,
    forced: event.forced,
  }));
}

function attackerIds(events: readonly GameEvent[]): string[] {
  return declarations(events).map((event) => event.attackerId);
}

// ---------------------------------------------------------------------------
// forcedAttacksOn — #9 Moths to the Flame
// ---------------------------------------------------------------------------

describe("forcedAttacksOn (§6.3 Forced attack, §4.2, R53, #9)", () => {
  it("R53 every enemy unit attacks the target in lane order, ignoring position, sickness and Taunt", () => {
    const state = game("moths");
    state.active = "p2";
    const target = put(state, MOTHS, slot("p1", "units", 1));
    // §4.2 step 3 would force the attacks onto this unit; a forced attack skips the step entirely.
    const wall = put(state, taunter.id, slot("p1", "units", 2));

    const defending = put(state, plain.id, slot("p2", "units", 1));
    defending.position = "DEF";
    const sick = put(state, plain.id, slot("p2", "units", 2));
    sick.summonedTurn = state.turn;
    const ready = put(state, plain.id, slot("p2", "units", 3));

    const events = run(state, forcedAttacksOn({ target: { of: "self" }, attackers: "enemy" }), {
      self: target,
      controller: "p1",
    });

    // One declaration per attacker, in lane order, all marked forced and all aimed at Moths.
    expect(declarations(events)).toEqual([
      { attackerId: defending.id, targetId: target.id, forced: true },
      { attackerId: sick.id, targetId: target.id, forced: true },
      { attackerId: ready.id, targetId: target.id, forced: true },
    ]);
    expect(target.damage).toBe(9);
    expect(wall.damage).toBe(0);

    // No exertion is spent, so each attacker may still take its own attack on its own turn.
    for (const attacker of [defending, sick, ready]) {
      expect(attacker.exertion).toEqual({ attacked: false, switched: false });
    }
    // Position is ignored but not changed: the Defense-Position unit still has its Armor +1, so
    // Moths' 1 attack strikes it for 0 while the two Attack-Position units take 1 each (§4.1).
    expect(defending.position).toBe("DEF");
    expect([defending.damage, sick.damage, ready.damage]).toEqual([0, 1, 1]);
  });

  it("R53 stops once the target has left the field, so the later attackers never attack", () => {
    const state = game("moths-dies");
    state.active = "p2";
    const target = put(state, frail.id, slot("p1", "units", 1));
    const first = put(state, plain.id, slot("p2", "units", 1));
    const second = put(state, plain.id, slot("p2", "units", 2));
    const third = put(state, plain.id, slot("p2", "units", 3));

    const events = run(state, forcedAttacksOn({ target: { of: "self" }, attackers: "enemy" }), {
      self: target,
      controller: "p1",
    });

    expect(attackerIds(events)).toEqual([first.id]);
    // §4.5: each forced attack is its own combat followed by its own state check, so the target is
    // already off the field when the second attacker's turn in the loop comes up.
    expect(cardAt(state, slot("p1", "units", 1))).toBeNull();
    expect(eventsOfType(events, "destroyed").map((event) => event.instanceId)).toEqual([target.id]);
    expect([second.damage, third.damage]).toEqual([0, 0]);
    for (const attacker of [first, second, third]) {
      expect(attacker.exertion).toEqual({ attacked: false, switched: false });
    }
  });

  it("§6.3 fizzles silently when the target resolves to nothing", () => {
    const state = game("moths-no-target");
    put(state, plain.id, slot("p2", "units", 1));

    // No `self`, so `{ of: "self" }` names nothing and no attack is declared.
    expect(run(state, forcedAttacksOn({ target: { of: "self" }, attackers: "enemy" }))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// forcedAttacks — #60 Bear Honeypot
// ---------------------------------------------------------------------------

describe("forcedAttacks (§6.3 Forced attack, R53, #60)", () => {
  it("R53 compels only the attackers the defId names", () => {
    const state = game("honeypot-defid");
    const victim = put(state, bigBody.id, slot("p2", "units", 1));
    const token = put(state, RUSH_TOKEN, slot("p1", "units", 1));
    const bystander = put(state, plain.id, slot("p1", "units", 2));

    const events = run(
      state,
      forcedAttacks({
        attackers: { side: "self", defId: RUSH_TOKEN },
        target: { instanceId: victim.id },
      }),
    );

    expect(attackerIds(events)).toEqual([token.id]);
    expect(victim.damage).toBe(3);
    expect(bystander.damage).toBe(0);
    expect(bystander.exertion).toEqual({ attacked: false, switched: false });
  });

  it("#60 summonedThisScript compels only the tokens this effect list just summoned", () => {
    const state = game("honeypot-fresh");
    const victim = put(state, bigBody.id, slot("p2", "units", 1));
    // An unrelated Rush Token the controller already had: same defId, not summoned by this list.
    const older = put(state, RUSH_TOKEN, slot("p1", "units", 1));

    const events = runAll(state, [
      summon({ defId: RUSH_TOKEN }),
      summon({ defId: RUSH_TOKEN }),
      forcedAttacks({
        attackers: { side: "self", defId: RUSH_TOKEN, summonedThisScript: true },
        target: { instanceId: victim.id },
      }),
    ]);

    const summoned = eventsOfType(events, "summoned").map((event) => event.instanceId);
    expect(summoned).toHaveLength(2);
    expect(summoned).not.toContain(older.id);
    // Exactly the two fresh tokens, in lane order, and nothing else on the side.
    expect(attackerIds(events)).toEqual(summoned);
    expect(victim.damage).toBe(6);
    expect(older.damage).toBe(0);
    expect(older.exertion).toEqual({ attacked: false, switched: false });
  });

  it("§6.3 fizzles silently when the named target is already gone", () => {
    const state = game("honeypot-gone");
    put(state, RUSH_TOKEN, slot("p1", "units", 1));

    const events = run(
      state,
      forcedAttacks({ attackers: { side: "self" }, target: { instanceId: "c-not-a-card" } }),
    );

    expect(events).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// aiPlaysOutTurn — §10.7's policy behind #96 My Pawn
// ---------------------------------------------------------------------------

/** A board with something to do, as aiPolicy.test.ts's `busyBoard` builds one (§10.7). */
function busyBoard(seed: string): GameState {
  const state = game(seed);
  state.turn = 4;
  state.active = "p1";
  state.phase = "main";
  state.players.p1.mana.current = 4;
  state.players.p1.mana.max = 4;
  inHand(state, "fx-1", "p1", 2);
  inHand(state, "fx-2", "p1", 2);
  put(state, bigBody.id, slot("p1", "units", 1));
  put(state, plain.id, slot("p2", "units", 1));
  return state;
}

/** A resume nothing can service: answering the prompt just clears it (§10.6). */
const inertResume: Resume = { defId: "fc-no-script", hook: "resume", step: "none", radiant: false, data: {} };

function modeOptions(options: string[]): PromptOption[] {
  return options.map((option) => ({ key: `mode:${option}`, label: option, selection: { pick: "mode", option } }));
}

describe("aiPlaysOutTurn (§10.7, R44, R84, #96)", () => {
  it("R44 sets aiTurn on the named player and takes no action while another player's prompt is open", () => {
    const state = busyBoard("ai-flag");
    const sink = sinkFor(state);
    // §9.3: somebody else's open prompt blocks every action, so the playout stops at once and the
    // only thing left to observe is the lockout flag this verb sets before handing over.
    openPrompt(sink, {
      player: "p2",
      kind: "target",
      prompt: "not yours",
      options: modeOptions(["x", "y"]),
      resume: inertResume,
    });

    // The trap's controller is p2 (#96 is the defender's card), so "enemy" is the attacker, p1.
    aiPlaysOutTurn({ player: "enemy" }).apply(makeContext(sink, null, { controller: "p2" }));

    expect(state.players.p1.aiTurn).toBe(true);
    expect(state.players.p2.aiTurn).toBe(false);
    expect(eventsOfType(sink.events, "cardPlayed")).toEqual([]);
    expect(state.active).toBe("p1");
  });

  it("R84 hands the rest of the turn to §10.7's policy, which plays it out and never concedes", () => {
    const state = busyBoard("ai-playout");
    const events: GameEvent[] = [];
    const sink = sinkFor(state, events);

    aiPlaysOutTurn({ player: "enemy" }).apply(makeContext(sink, null, { controller: "p2" }));

    // The turn really was played out and ended, on the caller's own state object.
    expect(eventsOfType(events, "turnEnded").map((event) => event.player)).toEqual(["p1"]);
    expect(sink.state).toBe(state);
    expect(state.active).toBe("p2");
    // R84: the policy never picks `concede`, so the game is still running.
    expect(state.result).toBeNull();
    expect(events.length).toBeGreaterThan(1);
    // R44: the lockout is only cleared by `turn.ts`, at that player's own next turn start.
    expect(state.players.p1.aiTurn).toBe(true);
  });

  it("R44 is deterministic from the seed: the same board plays out the same way twice", () => {
    const first = busyBoard("ai-replay");
    const second = busyBoard("ai-replay");
    const firstEvents: GameEvent[] = [];
    const secondEvents: GameEvent[] = [];

    aiPlaysOutTurn({ player: "self" }).apply(
      makeContext(sinkFor(first, firstEvents), null, { controller: "p1" }),
    );
    aiPlaysOutTurn({ player: "self" }).apply(
      makeContext(sinkFor(second, secondEvents), null, { controller: "p1" }),
    );

    expect(JSON.stringify(secondEvents)).toBe(JSON.stringify(firstEvents));
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});

// ---------------------------------------------------------------------------
// cancelAttack — §6.3 Cancel an attack, §4.2 step 4, R44
// ---------------------------------------------------------------------------

describe("cancelAttack (§6.3 Cancel an attack, §4.2 step 4, R44, #96)", () => {
  // ###################################################################################
  // KNOWN FAILING TEST — it names a real engine gap and must stay until the gap is shut.
  //
  // §4.2 step 4 ("Trap window: My Pawn checks whether the hit would be lethal and, if so,
  // cancels the attack") has no implementation to hook into:
  //   1. `GameState` (packages/engine/src/state.ts) has no `declaredAttack` field, so there is
  //      no open declaration for `cancelAttack` to mark, and the verb correctly fizzles.
  //   2. `combat.declareAttack` (packages/engine/src/combat.ts:304) calls `resolveCombat` on the
  //      line after it pushes `attackDeclared`, so the damage is already dealt before any trap
  //      can see the event — the window does not exist in time, not merely in state.
  //
  // THE FIX (one field and three lines, both files outside this agent's ownership):
  //   * src/state.ts:   add `declaredAttack?: { attackerId: string; targetId: string;
  //                     cancelled?: boolean }` to `GameState`.
  //   * src/combat.ts:  in `declareAttack`, after spending the exertion and pushing the event,
  //                     set `state.declaredAttack`, call `traps.fireTrapsFor(sink, event)`, then
  //                     `if (state.declaredAttack?.cancelled !== true) resolveCombat(...)`, and
  //                     clear the field before returning.
  // `cancelAttack` itself needs no change once that lands; this test then passes as written and
  // `it.fails` becomes `it`.
  // ###################################################################################
  it.fails(
    "R44 a cancelled attack resolves no combat and emits attackCancelled [KNOWN GAP: no declaredAttack field and declareAttack resolves combat immediately — see the block comment above]",
    () => {
      const state = game("cancel");
      state.active = "p2";
      const attacker = put(state, plain.id, slot("p2", "units", 1));
      const defender = put(state, bigBody.id, slot("p1", "units", 1));
      // The trap that cancels: `self` of the script, and the `byInstanceId` of the event.
      const trap = put(state, ambush.id, slot("p1", "backrow", 1));
      const sink = sinkFor(state);

      // The trap window of §4.2 step 4 belongs inside this call, before any damage.
      declareAttack(sink, attacker, { kind: "unit", instance: defender });
      cancelAttack().apply(makeContext(sink, trap, { controller: "p1" }));

      expect(eventsOfType(sink.events, "attackCancelled")).toEqual([
        { type: "attackCancelled", attackerId: attacker.id, targetId: defender.id, byInstanceId: trap.id },
      ]);
      // R44: no combat resolved, and the exertion is gone either way.
      expect(defender.damage).toBe(0);
      expect(attacker.damage).toBe(0);
      expect(attacker.exertion.attacked).toBe(true);
    },
  );

  it("§6.3 fizzles silently with no open declaration, so the card still resolves", () => {
    const state = game("cancel-nothing");
    const trap = put(state, ambush.id, slot("p1", "backrow", 1));

    expect(run(state, cancelAttack(), { self: trap })).toEqual([]);
  });
});
