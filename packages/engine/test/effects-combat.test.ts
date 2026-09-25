// The §6.3 combat verbs a card script needs: Forced attack (#9 Moths to the Flame, #60 Bear
// Honeypot), Cancel an attack (#96 My Pawn) and the AI turn behind it (§10.7, R44, R84).
//
// These effects are thin wrappers, so the tests here assert the wrapper's own decisions — who is
// compelled, in what order, against what target, and what the wrapper leaves alone — and lean on
// combat-resolution.test.ts for §4.3 and §4.4 themselves. Every assertion runs through a real
// `EffectContext`, and the one verb the engine cannot service yet is a marked failing test rather
// than a tautology.

import type { Action, CardDef, GameEvent, PlayerId, Selection } from "@jackioh/shared";
import { describe, expect, it } from "vitest";
import { registerCatalog, registeredCatalog } from "../src/catalog";
import { declareAttack, forceAttack } from "../src/combat";
import { aiPlaysOutTurn, cancelAttack, forcedAttacks, forcedAttacksOn } from "../src/effects/combat";
import { summon } from "../src/effects/summon";
import { openPrompt } from "../src/prompts";
import { reduce } from "../src/reduce";
import { makeContext } from "../src/resolve";
import type { CardScripts, Effect } from "../src/script";
import { registerScripts, registeredScripts } from "../src/scripts";
import { cloneState, type CardInstance, type GameState, type PromptOption, type Resume } from "../src/state";
import { settle } from "../src/triggers";
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
/**
 * A Field Trap that answers every declaration and does nothing with it (R61's "fired, consumed,
 * did nothing"). It is a FIELD Trap on purpose: §5.1 leaves one on the field after it fires, so a
 * second offer of the same declaration would fire it a second time, which is what R100 forbids and
 * what the `attackDeclared` event reaching both the window and §10.3's immediate check would do.
 */
const watcher = defOfKind("watcher", "943", "Field Trap", {
  base: { keywords: [], text: "field trap" },
  radiant: { keywords: [], text: "field trap" },
});
/** A Trap whose whole body is §6.3's Cancel an attack, the way #96 My Pawn's first clause is. */
const canceller = defOfKind("canceller", "944", "Trap", {
  base: { keywords: [], text: "trap" },
  radiant: { keywords: [], text: "trap" },
});
/** A Trap that asks its controller something inside the window, so the window has to pause. */
const asker = defOfKind("asker", "945", "Trap", {
  base: { keywords: [], text: "trap" },
  radiant: { keywords: [], text: "trap" },
});
/** A Trap shaped like #96 itself: cancel the declaration, then hand the turn to the AI policy. */
const pawn = defOfKind("pawn", "946", "Trap", {
  base: { keywords: [], text: "trap" },
  radiant: { keywords: [], text: "trap" },
});
/** A Field Trap that answers every `manaChanged`, so a second dispatch of one is countable. */
const meter = defOfKind("meter", "947", "Field Trap", {
  base: { keywords: [], text: "field trap" },
  radiant: { keywords: [], text: "field trap" },
});

/** §8 #9's body, from the shared combat fixtures: 1/14, so three forced attacks do not kill it. */
const MOTHS = "cb-moths";
/** §7's shared Rush Token: 3/3 Rush, which is what #60 summons and compels. */
const RUSH_TOKEN = "fx-token-rush";

const DEFS: CardDef[] = [frail, ambush, watcher, canceller, asker, pawn, meter];

/** A resume nothing can service: answering the prompt just clears it (§10.6). */
const inertResume: Resume = { defId: "fc-no-script", hook: "resume", step: "none", radiant: false, data: {} };

function modeOptions(options: string[]): PromptOption[] {
  return options.map((option) => ({ key: `mode:${option}`, label: option, selection: { pick: "mode", option } }));
}

/** An effect that opens a prompt for the resolving controller and nothing else (§9.3, §10.6). */
const ask: Effect = {
  kind: "fc:ask",
  apply(ctx): void {
    openPrompt(ctx, {
      player: ctx.controller,
      kind: "mode",
      prompt: "the window pauses here",
      options: modeOptions(["a", "b"]),
      resume: inertResume,
    });
  },
};

/**
 * The trap scripts the window tests need. Each watches `attackDeclared` with no `when`, so it
 * answers every declaration it is offered (R99) — which is what makes a second offer visible.
 */
function trapScript(on: GameEvent["type"], run: () => Effect[]): CardScripts {
  const script = { triggers: [{ id: `fc-${on}`, on: [on], run }] };
  return { base: script, radiant: script };
}

const SCRIPTS: Record<string, CardScripts> = {
  [watcher.id]: trapScript("attackDeclared", () => []),
  [canceller.id]: trapScript("attackDeclared", () => [cancelAttack()]),
  [asker.id]: trapScript("attackDeclared", () => [ask]),
  // #96's own body, in its order (§8.5): cancel, then hand the rest of the turn to §10.7's policy.
  [pawn.id]: trapScript("attackDeclared", () => [cancelAttack(), aiPlaysOutTurn({ player: "enemy" })]),
  [meter.id]: trapScript("manaChanged", () => []),
};

function game(seed = "effects-combat"): GameState {
  const state = newGame(seed);
  registerCatalog({ ...registeredCatalog(), ...Object.fromEntries(DEFS.map((def) => [def.id, def])) });
  registerScripts({ ...registeredScripts(), ...SCRIPTS });
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
    // R152: the lockout lasts "until end of turn" (§8 #96), so `turn.ts`'s cleanup clears it as the
    // turn the AI just played out closes — a player is never locked out of a turn that is no longer
    // the one the effect took. `startTurn` keeps its own clear only as a backstop.
    expect(state.players.p1.aiTurn).toBe(false);
  });

  // `subsystems/aiPolicy.playOutTurn` drives a NESTED `reduce` per action of the playout, and each
  // of those settles its own events to completion (§10.3) before the playout copies them onto the
  // caller's event list, so the client is told about them (R168). The caller's resolution loop must
  // not offer them to the traps and the trigger queue again: `triggers.markDispatched` gives each of
  // those events a per-event "already dispatched" mark, the one shape that covers a range in the
  // MIDDLE of the window's own events (`trapFired`, `attackCancelled`, the playout, then
  // `enteredGraveyard`), which a cursor cannot skip. Below: one Field Trap firing per `manaChanged`.
  it(
    "§10.3 an AI turn's events are dispatched once, not again by the caller's own loop",
    () => {
      const { state, attacker, backrow } = swing("ai-redispatch", [pawn.id, meter.id]);
      state.players.p2.mana = { current: 4, max: 4, nextTurnMod: 0, permMod: 0 };
      const field = backrow[1] as CardInstance;

      const result = reduce(state, attackAction(attacker.id, "hero-p1", "n1"));
      expect(result.error).toBeUndefined();

      const manaChanges = eventsOfType(result.events, "manaChanged").length;
      const answered = eventsOfType(result.events, "trapFired").filter(
        (event) => event.instanceId === field.id,
      ).length;
      expect(manaChanges).toBeGreaterThan(0);
      expect(answered).toBe(manaChanges);
    },
  );

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

  // R283, R59: Radiant #96 destroys the attacker it stopped and then hands the turn over, and the
  // destroyed attacker is collected "before the AI takes the turn". `destroy` only marks, so the
  // effect's `settleFirst` runs the state check between the lockout and the AI's first action.
  // Another player's open prompt stops the playout before it acts (§9.3), which leaves exactly the
  // check to observe.
  function markedBoard(seed: string): { state: GameState; sink: ReturnType<typeof sinkFor>; marked: CardInstance } {
    const state = busyBoard(seed);
    const marked = cardAt(state, slot("p1", "units", 1)) as CardInstance;
    marked.markedDestroyed = true;
    const sink = sinkFor(state);
    openPrompt(sink, {
      player: "p2",
      kind: "target",
      prompt: "not yours",
      options: modeOptions(["x", "y"]),
      resume: inertResume,
    });
    return { state, sink, marked };
  }

  it("R283 settleFirst collects a marked unit before the AI's first action; the default leaves it for that action", () => {
    const settled = markedBoard("ai-settle-first");
    aiPlaysOutTurn({ player: "enemy", settleFirst: true }).apply(makeContext(settled.sink, null, { controller: "p2" }));

    expect(settled.state.players.p1.aiTurn).toBe(true);
    expect(cardAt(settled.state, slot("p1", "units", 1))).toBeNull();
    expect(settled.state.players.p1.graveyard.map((card) => card.id)).toContain(settled.marked.id);
    expect(eventsOfType(settled.sink.events, "destroyed").map((event) => event.instanceId)).toEqual([settled.marked.id]);
    expect(eventsOfType(settled.sink.events, "cardPlayed")).toEqual([]);

    const plainRun = markedBoard("ai-settle-first");
    aiPlaysOutTurn({ player: "enemy" }).apply(makeContext(plainRun.sink, null, { controller: "p2" }));

    // Off by default: the mark is still waiting for the next check, which the AI's own first
    // action would have run.
    expect(cardAt(plainRun.state, slot("p1", "units", 1))?.id).toBe(plainRun.marked.id);
    expect(eventsOfType(plainRun.sink.events, "destroyed")).toEqual([]);
  });

  it("R283 settleFirst ends the effect when its check ends the game: the AI takes no action", () => {
    const state = busyBoard("ai-settle-first-over");
    state.players.p2.hero.health = 0;
    const events: GameEvent[] = [];
    const sink = sinkFor(state, events);

    aiPlaysOutTurn({ player: "self", settleFirst: true }).apply(makeContext(sink, null, { controller: "p1" }));

    expect(state.result).toEqual({ winner: "p1", reason: "hero-death" });
    expect(eventsOfType(events, "cardPlayed")).toEqual([]);
    expect(eventsOfType(events, "turnEnded")).toEqual([]);
  });

  it("R283 settleFirst: false is the default, and a board with nothing to collect plays out the same either way", () => {
    const runs = [undefined, false, true].map((settleFirst) => {
      const state = busyBoard("ai-settle-first-same");
      const events: GameEvent[] = [];
      const effect = settleFirst === undefined ? aiPlaysOutTurn({ player: "self" }) : aiPlaysOutTurn({ player: "self", settleFirst });
      effect.apply(makeContext(sinkFor(state, events), null, { controller: "p1" }));
      return JSON.stringify({ state, events });
    });

    expect(runs[1]).toBe(runs[0]);
    expect(runs[2]).toBe(runs[0]);
  });
});

// ---------------------------------------------------------------------------
// cancelAttack — §6.3 Cancel an attack, §4.2 step 4, R44
// ---------------------------------------------------------------------------

/** p2 swings a 3/3 into p1's 5/10, with whatever traps the case puts in p1's backrow. */
function swing(seed: string, traps: string[]): {
  state: GameState;
  attacker: CardInstance;
  defender: CardInstance;
  backrow: CardInstance[];
} {
  const state = game(seed);
  state.active = "p2";
  const attacker = put(state, plain.id, slot("p2", "units", 1));
  // A second body, so `reduce`'s §2.5 auto-end does not close the turn under the assertions.
  put(state, plain.id, slot("p2", "units", 2));
  const defender = put(state, bigBody.id, slot("p1", "units", 1));
  const backrow = traps.map((defId, index) => put(state, defId, slot("p1", "backrow", index + 1)));
  return { state, attacker, defender, backrow };
}

function attackAction(attackerId: string, targetId: string, nonce: string): Action {
  return { type: "attack", attackerId, targetId, playerId: "p2", nonce };
}

function typesOf(events: readonly GameEvent[]): string[] {
  return events.map((event) => event.type);
}

describe("cancelAttack (§6.3 Cancel an attack, §4.2 step 4, R44, #96)", () => {
  it("R44 a cancelled attack resolves no combat and emits attackCancelled", () => {
    const { state, attacker, defender, backrow } = swing("cancel", [canceller.id]);
    const trap = backrow[0] as CardInstance;
    const sink = sinkFor(state);

    // §4.2 step 4's window belongs inside this call, before any damage: the trap fires there.
    declareAttack(sink, attacker, { kind: "unit", instance: defender });

    expect(eventsOfType(sink.events, "attackCancelled")).toEqual([
      { type: "attackCancelled", attackerId: attacker.id, targetId: defender.id, byInstanceId: trap.id },
    ]);
    // R44: no combat resolved, and the exertion is gone either way.
    expect(eventsOfType(sink.events, "damage")).toEqual([]);
    expect(defender.damage).toBe(0);
    expect(attacker.damage).toBe(0);
    expect(attacker.exertion.attacked).toBe(true);
    // §4.2 step 5 has had its answer, so the window is shut again.
    expect(state.declaredAttack).toBeNull();
    // §3.2: the trap is spent whatever its effects achieved (R61), and the attacker is untouched.
    expect(trap.zone.z).toBe("graveyard");
    expect(cardAt(state, slot("p2", "units", 1))?.id).toBe(attacker.id);
  });

  it("§4.2 step 4 the window opens between the declaration and the damage, not after it", () => {
    const { state, attacker, defender } = swing("window-order", [watcher.id]);
    const sink = sinkFor(state);

    declareAttack(sink, attacker, { kind: "unit", instance: defender });

    const order = typesOf(sink.events);
    expect(order.indexOf("attackDeclared")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("trapFired")).toBeGreaterThan(order.indexOf("attackDeclared"));
    expect(order.indexOf("damage")).toBeGreaterThan(order.indexOf("trapFired"));
    // R61: the trap fired and did nothing, so the combat is the ordinary one — the 3/3 hits the
    // 5/10 for 3 and is struck back for 5, which kills it and takes it off the field (§4.5, R78).
    expect(defender.damage).toBe(3);
    expect(eventsOfType(sink.events, "damage").map((event) => event.amount)).toEqual([3, 5]);
    expect(cardAt(state, slot("p2", "units", 1))).toBeNull();
  });

  it("R100 the declaration reaches the traps once: the window's event is not offered again", () => {
    // A Field Trap stays on the field after firing (§5.1, R33), so a second offer of the same
    // declaration — §10.3's immediate check taking the event off the frontier after the window has
    // already delivered it — would show up here as a second `trapFired`.
    const { state, attacker, defender, backrow } = swing("window-once", [watcher.id]);
    const field = backrow[0] as CardInstance;
    const result = reduce(state, attackAction(attacker.id, defender.id, "n1"));

    expect(result.error).toBeUndefined();
    expect(eventsOfType(result.events, "trapFired").map((event) => event.instanceId)).toEqual([field.id]);
    expect(result.state.declaredAttack).toBeNull();
  });

  it("R113, R117 a trap that prompts parks the combat, and the answer finishes the window first", () => {
    // R68 within a side is lane order, so the asker is offered the declaration first and the
    // canceller is still owed it when the prompt stops the window.
    const { state, attacker, defender, backrow } = swing("window-pause", [asker.id, canceller.id]);
    const cancelling = backrow[1] as CardInstance;

    const paused = reduce(state, attackAction(attacker.id, defender.id, "n1"));
    expect(paused.error).toBeUndefined();

    // The window stopped where it stood: the prompt is state, the declaration is still open, and
    // the combat is owed rather than resolved or dropped (§9.3, R113).
    const pending = paused.state.pending;
    expect(pending?.playerId).toBe("p1");
    expect(paused.state.declaredAttack).toEqual({
      id: expect.any(String) as unknown as string,
      attackerId: attacker.id,
      targetId: defender.id,
      cancelled: false,
      // R220: whose attack it is, and the stays it was declared on.
      by: attacker.controller,
      exitsFrom: expect.any(Number) as unknown as number,
    });
    // R113, §10.3: the asking trap's own end first — consumed, and its check, once the answer has
    // finished its list — then the traps the window still owes, then the combat.
    expect(paused.state.work.map((item) => item.resume.hook)).toEqual(["@trapFiring", "@trapWindow", "@attackWindow"]);
    expect(eventsOfType(paused.events, "damage")).toEqual([]);

    // §10.1: everything owed is plain JSON, so the paused attack survives a clone round trip.
    expect(cloneState(paused.state).declaredAttack).toEqual(paused.state.declaredAttack);
    expect(cloneState(paused.state).work).toEqual(paused.state.work);

    const answered = reduce(paused.state, {
      type: "answer",
      choiceId: pending?.id ?? "",
      selection: [{ pick: "mode", option: "a" }],
      playerId: "p1",
      nonce: "n2",
    });
    expect(answered.error).toBeUndefined();

    // The traps the window still owed ran before the combat it precedes, so the second trap's
    // cancel still lands and no damage is ever dealt.
    expect(eventsOfType(answered.events, "attackCancelled").map((event) => event.byInstanceId)).toEqual([
      cancelling.id,
    ]);
    expect(eventsOfType(answered.events, "damage")).toEqual([]);
    expect(cardAt(answered.state, slot("p1", "units", 1))?.damage).toBe(0);
    expect(answered.state.declaredAttack).toBeNull();
    expect(answered.state.work).toEqual([]);
  });

  it("R121 a forced attack opens no window, so nothing can cancel it", () => {
    const { state, attacker, defender, backrow } = swing("forced-window", [canceller.id]);
    const trap = backrow[0] as CardInstance;
    const sink = sinkFor(state);

    // §4.2's last paragraph: the compelling effect declares this, so there is no open declaration
    // at any point — and R53's combat and state check happen inside the call, as before.
    forceAttack(sink, attacker, { kind: "unit", instance: defender });
    expect(state.declaredAttack).toBeNull();
    expect(defender.damage).toBe(3);
    expect(attacker.exertion.attacked).toBe(false);

    // The forced declaration still reaches the traps, through §10.3's immediate check — it is only
    // the window that a forced attack skips — and `cancelAttack` there has nothing to mark.
    settle(sink);
    expect(eventsOfType(sink.events, "trapFired").map((event) => event.instanceId)).toEqual([trap.id]);
    expect(eventsOfType(sink.events, "attackCancelled")).toEqual([]);
  });

  it("§6.3 fizzles silently with no open declaration, so the card still resolves", () => {
    const state = game("cancel-nothing");
    const trap = put(state, ambush.id, slot("p1", "backrow", 1));

    expect(run(state, cancelAttack(), { self: trap })).toEqual([]);
  });
});
