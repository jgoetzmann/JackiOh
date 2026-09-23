// R171 and R172 at the verb level (SPEC §4.1, §11; docs/polish/4-edge-cases.md behaviours 7, 8 and
// 10 to 14). A change of control on the field is an entry: the card takes the current turn as its
// `summonedTurn` and a fresh exertion, on every path that changes control — Steal, Steal all, the
// board swap and a rotation across the centre line — and on nothing else. R172 is the other half
// the brief asked about: a stolen unit dies as its controller's.
//
// Engine fixtures only (the engine never depends on `packages/cards`). The real cards prove the
// same rows again in `packages/cards/test/control-change.test.ts`, and
// `control-change.property.test.ts` checks them over random boards.
//
// Every game here is past both mulligans, in p1's main phase (the `playing()` pattern of
// `rulings-b.test.ts`), so `legalActions` and `reduce` answer as they would in a match. The verbs
// are applied the way `effects-steal.test.ts` applies them: straight through `effect.apply` with
// the actor as the context's controller, which is also how an effect on the opponent's turn is
// written (behaviour 12).

import type { Action, ActionInput, CardDef, GameEvent, PlayerId } from "@jackioh/shared";
import { describe, expect, it } from "vitest";
import { registerCatalog, registeredCatalog } from "../src/catalog";
import { attackTargets, forceAttack, isSick, whyCannotAttack, type AttackTarget } from "../src/combat";
import { steal, stealAll } from "../src/effects/steal";
import { summon } from "../src/effects/summon";
import { swapBoard } from "../src/effects/swap";
import { unitView } from "../src/layers";
import { beginGame, legalActions, reduce } from "../src/reduce";
import { makeContext } from "../src/resolve";
import type { Effect } from "../src/script";
import { registerScripts, registeredScripts } from "../src/scripts";
import { newInstance, findInstance, type CardInstance, type GameState } from "../src/state";
import { stateCheck } from "../src/stateCheck";
import { rotateRings, type RotationDirection } from "../src/subsystems/rotation";
import { cardAt, placeOnField } from "../src/zones";
import { spellDef, tokenDef } from "./fixtures/catalog";
import { charger, plain, rusher, stacker } from "./fixtures/combat";
import { eventsOfType, newGame, put, sinkFor, slot } from "./fixtures/harness";

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

/** A face-down backrow card: the board swap moves the backrow row too (R73). */
const trap: CardDef = spellDef(730, { id: "cc-trap", index: "730", name: "Control Trap (fixture)", type: "Trap" });

/** The shared fixture unit token, which the Reborn fixture's Death summons for "you". */
const TOKEN_ID = tokenDef("rush").id;

/** R172: Reborn, and a Death that summons for its controller, so "you" is observable. */
const reborner: CardDef = {
  id: "cc-reborner",
  index: "731",
  name: "Reborn Summoner (control-change fixture)",
  set: "Core",
  type: "Unit",
  tags: [],
  rarity: "Common",
  token: false,
  cost: 1,
  base: { attack: 2, health: 2, keywords: [{ kind: "Reborn" }], text: "Reborn; Death: summon a token" },
  radiant: { attack: 4, health: 4, keywords: [{ kind: "Reborn" }], text: "Reborn; Death: summon a token" },
};

const rebornerScript = { death: (): Effect[] => [summon({ defId: TOKEN_ID })] };

let nonce = 0;

function act(state: GameState, body: ActionInput): GameState {
  nonce += 1;
  const result = reduce(state, { ...body, nonce: `cc${nonce}` } as Action);
  if (result.error !== undefined) throw new Error(`${body.type} refused: ${result.error}`);
  return result.state;
}

/** Past both mulligans, in p1's main phase, with an empty board and this file's fixtures. */
function playing(seed: string): GameState {
  const fresh = newGame(seed);
  registerCatalog({ ...registeredCatalog(), [trap.id]: trap, [reborner.id]: reborner });
  registerScripts({ ...registeredScripts(), [reborner.id]: { base: rebornerScript, radiant: rebornerScript } });
  let state = beginGame(fresh).state;
  state = act(state, { type: "mulligan", keep: state.players.p1.hand.map((c) => c.id), playerId: "p1" });
  state = act(state, { type: "mulligan", keep: state.players.p2.hand.map((c) => c.id), playerId: "p2" });
  expect(state.phase).toBe("main");
  expect(state.active).toBe("p1");
  expect(state.pending).toBeNull();
  return state;
}

/** Apply one effect for `actor`, in place, and hand back what it emitted. */
function run(state: GameState, effect: Effect, actor: PlayerId): GameEvent[] {
  const sink = sinkFor(state);
  effect.apply(makeContext(sink, null, { controller: actor }));
  state.rngCursor = sink.rng.cursor;
  return sink.events;
}

function rotate(state: GameState, direction: RotationDirection, radiant = false): GameEvent[] {
  const sink = sinkFor(state);
  rotateRings(sink, { direction, perspective: state.active, radiant });
  state.rngCursor = sink.rng.cursor;
  return sink.events;
}

/** A unit that entered on an earlier turn and has acted in every way it can. */
function exhausted(card: CardInstance, turn: number): CardInstance {
  card.summonedTurn = turn;
  card.exertion = { attacked: true, switched: true };
  return card;
}

/** A unit that entered on an earlier turn and has not acted. */
function ready(card: CardInstance, turn: number): CardInstance {
  card.summonedTurn = turn;
  card.exertion = { attacked: false, switched: false };
  return card;
}

const FRESH = { attacked: false, switched: false };

const hero = (player: PlayerId): AttackTarget => ({ kind: "hero", player });
const unit = (instance: CardInstance): AttackTarget => ({ kind: "unit", instance });

/** The attacks `legalActions` offers this unit, as target ids. */
function offeredAttacks(state: GameState, card: CardInstance): string[] {
  return legalActions(state, card.controller).flatMap((action) =>
    action.type === "attack" && action.attackerId === card.id ? [action.targetId] : [],
  );
}

function offersSwitch(state: GameState, card: CardInstance): boolean {
  return legalActions(state, card.controller).some(
    (action) => action.type === "switchPosition" && action.instanceId === card.id,
  );
}

function live(state: GameState, card: CardInstance): CardInstance {
  const found = findInstance(state, card.id);
  if (found === undefined) throw new Error(`${card.id} is gone`);
  return found;
}

// ---------------------------------------------------------------------------
// R171.
// ---------------------------------------------------------------------------

describe("R171 a change of control is an entry (§4.1)", () => {
  it("R171 a stolen unit with neither Rush nor Charge is summoning sick for the rest of the turn", () => {
    const state = playing("cc-steal-sick");
    const turn = state.turn;
    const victim = ready(put(state, plain.id, slot("p2", "units", 3)), turn - 1);
    const bystander = ready(put(state, plain.id, slot("p2", "units", 5)), turn - 1);

    const events = run(state, steal({ instanceId: victim.id }), "p1");

    expect(eventsOfType(events, "controlChanged").map((e) => e.instanceId)).toEqual([victim.id]);
    expect(victim.controller).toBe("p1");
    expect(victim.summonedTurn).toBe(turn);
    expect(isSick(state, victim)).toBe(true);
    expect(whyCannotAttack(state, victim, hero("p2"))).toBe("that unit is summoning sick");
    expect(whyCannotAttack(state, victim, unit(bystander))).toBe("that unit is summoning sick");
    expect(attackTargets(state, victim)).toEqual([]);
    expect(offeredAttacks(state, victim)).toEqual([]);
    // §4.1: a sick unit may still switch position, and legalActions offers it.
    expect(offersSwitch(state, victim)).toBe(true);
  });

  it("R171 a stolen Rush unit may attack units but not the hero; a stolen Charge unit may attack both", () => {
    const state = playing("cc-steal-keywords");
    const turn = state.turn;
    const rush = ready(put(state, rusher.id, slot("p2", "units", 1)), turn - 1);
    const charge = ready(put(state, charger.id, slot("p2", "units", 2)), turn - 1);
    const bystander = ready(put(state, plain.id, slot("p2", "units", 5)), turn - 1);

    run(state, steal({ instanceId: rush.id }), "p1");
    run(state, steal({ instanceId: charge.id }), "p1");

    expect([rush.summonedTurn, charge.summonedTurn]).toEqual([turn, turn]);
    expect(whyCannotAttack(state, rush, hero("p2"))).toBe("Rush cannot hit the hero on its summon turn");
    expect(offeredAttacks(state, rush)).toEqual([bystander.id]);
    expect(offeredAttacks(state, charge)).toEqual([bystander.id, "hero-p2"]);
  });

  it("R171 the exertion is fresh: a unit that attacked or switched for the player it left may act again", () => {
    const state = playing("cc-steal-exertion");
    const turn = state.turn;
    const charge = exhausted(put(state, charger.id, slot("p2", "units", 1)), turn - 1);
    const switcher = exhausted(put(state, plain.id, slot("p2", "units", 2)), turn - 1);

    run(state, steal({ instanceId: charge.id }), "p1");
    run(state, steal({ instanceId: switcher.id }), "p1");

    expect(charge.exertion).toEqual(FRESH);
    expect(switcher.exertion).toEqual(FRESH);
    expect(offeredAttacks(state, charge)).toEqual(["hero-p2"]);
    expect(offersSwitch(state, switcher)).toBe(true);
  });

  it("R171 Steal all (#86) marks every unit it takes and nothing it leaves behind", () => {
    const state = playing("cc-steal-all");
    const turn = state.turn;
    for (let lane = 1; lane <= 3; lane += 1) ready(put(state, plain.id, slot("p1", "units", lane)), turn - 1);
    const taken = [1, 2].map((lane) => exhausted(put(state, plain.id, slot("p2", "units", lane)), turn - 1));
    const leftBehind = [3, 4, 5].map((lane) => exhausted(put(state, plain.id, slot("p2", "units", lane)), turn - 1));

    const events = run(state, stealAll(), "p1");

    expect(eventsOfType(events, "controlChanged").map((e) => e.instanceId)).toEqual(taken.map((c) => c.id));
    for (const card of taken) {
      expect(card.controller).toBe("p1");
      expect(card.summonedTurn).toBe(turn);
      expect(card.exertion).toEqual(FRESH);
    }
    // R15: no free zone, so these stay with their owner, untouched.
    for (const card of leftBehind) {
      expect(card.controller).toBe("p2");
      expect(card.summonedTurn).toBe(turn - 1);
      expect(card.exertion).toEqual({ attacked: true, switched: true });
    }
  });

  it("R171 the board swap (#87) marks every card that changes sides, dormant Stack cards and backrow cards included", () => {
    const state = playing("cc-swap-marks");
    const turn = state.turn;
    const mine = exhausted(put(state, plain.id, slot("p1", "units", 1)), turn - 1);
    const beneath = exhausted(put(state, plain.id, slot("p1", "units", 2)), turn - 2);
    const top = newInstance(state, stacker.id, "p1", { z: "hand", player: "p1" });
    expect(placeOnField(state, top, slot("p1", "units", 2), { stack: true })).toBe(true);
    exhausted(top, turn - 1);
    const myTrap = put(state, trap.id, slot("p1", "backrow", 3));
    myTrap.summonedTurn = turn - 1;
    const theirs = exhausted(put(state, plain.id, slot("p2", "units", 4)), turn - 1);
    const theirTrap = put(state, trap.id, slot("p2", "backrow", 5));
    theirTrap.summonedTurn = turn - 1;

    const events = run(state, swapBoard(), "p1");

    const moved = [mine, top, beneath, myTrap, theirs, theirTrap];
    expect(new Set(eventsOfType(events, "controlChanged").map((e) => e.instanceId))).toEqual(
      new Set(moved.map((card) => card.id)),
    );
    for (const card of moved) {
      expect(card.summonedTurn, card.id).toBe(turn);
      expect(card.exertion, card.id).toEqual(FRESH);
    }
    // The pile crossed whole, top still on top (§3.2), and the dormant card is marked too.
    expect(cardAt(state, slot("p2", "units", 2))?.id).toBe(top.id);
    expect(beneath.controller).toBe("p2");
  });

  it("R171 the board swap: units the caster receives are sick, units the opponent receives attack on its next turn", () => {
    let state = playing("cc-swap-turns");
    const turn = state.turn;
    ready(put(state, plain.id, slot("p1", "units", 1)), turn - 1);
    const theirPlain = ready(put(state, plain.id, slot("p2", "units", 3)), turn - 1);
    const theirCharge = ready(put(state, charger.id, slot("p2", "units", 4)), turn - 1);
    const theirRush = ready(put(state, rusher.id, slot("p2", "units", 5)), turn - 1);

    run(state, swapBoard(), "p1");

    // What p1 received entered this turn: sick, with Rush and Charge applying as usual.
    expect(attackTargets(state, theirPlain)).toEqual([]);
    expect(offeredAttacks(state, theirCharge)).toContain("hero-p2");
    expect(offeredAttacks(state, theirRush)).not.toContain("hero-p2");
    expect(offeredAttacks(state, theirRush).length).toBeGreaterThan(0);

    // What p2 received is free on p2's next turn, which is the next turn of the game.
    state = act(state, { type: "endTurn", playerId: "p1" });
    expect(state.active).toBe("p2");
    const received = cardAt(state, slot("p2", "units", 1));
    if (received === null) throw new Error("p2 should hold p1's old unit in lane 1");
    expect(isSick(state, received)).toBe(false);
    expect(offeredAttacks(state, received)).toContain("hero-p1");
  });

  it("R171 a rotation marks the cards that cross the centre line and nothing that moves along its own side", () => {
    const state = playing("cc-rotate");
    const turn = state.turn;
    // Rotating right from p1's seat: p1 lane n → n+1, p1 lane 5 → p2 lane 5, p2 lane 1 → p1 lane 1.
    const alongReady = ready(put(state, plain.id, slot("p1", "units", 2)), turn - 1);
    const alongSpent = put(state, plain.id, slot("p1", "units", 3));
    alongSpent.summonedTurn = turn - 1;
    alongSpent.exertion = { attacked: true, switched: false };
    const outbound = exhausted(put(state, plain.id, slot("p1", "units", 5)), turn - 1);
    const inbound = exhausted(put(state, plain.id, slot("p2", "units", 1)), turn - 1);

    const events = rotate(state, "right");

    expect(new Set(eventsOfType(events, "controlChanged").map((e) => e.instanceId))).toEqual(
      new Set([outbound.id, inbound.id]),
    );
    for (const card of [outbound, inbound]) {
      expect(card.summonedTurn, card.id).toBe(turn);
      expect(card.exertion, card.id).toEqual(FRESH);
    }
    expect(inbound.controller).toBe("p1");
    expect(attackTargets(state, inbound)).toEqual([]);

    // Along its own side a card has entered nothing: the ready one still attacks, the spent one
    // still cannot.
    expect(alongReady.summonedTurn).toBe(turn - 1);
    expect(alongReady.exertion).toEqual(FRESH);
    expect(offeredAttacks(state, alongReady)).toContain("hero-p2");
    expect(alongSpent.summonedTurn).toBe(turn - 1);
    expect(alongSpent.exertion).toEqual({ attacked: true, switched: false });
    expect(whyCannotAttack(state, alongSpent, hero("p2"))).toBe("that unit has already acted this turn");
  });

  it("R171 a radiant rotation crosses nothing and marks nothing", () => {
    const state = playing("cc-rotate-radiant");
    const turn = state.turn;
    const along = exhausted(put(state, plain.id, slot("p1", "units", 2)), turn - 1);
    const theirAlong = ready(put(state, plain.id, slot("p2", "units", 3)), turn - 1);
    put(state, plain.id, slot("p1", "units", 5));

    const events = rotate(state, "right", true);

    expect(eventsOfType(events, "controlChanged")).toEqual([]);
    expect(along.summonedTurn).toBe(turn - 1);
    expect(along.exertion).toEqual({ attacked: true, switched: true });
    expect(theirAlong.summonedTurn).toBe(turn - 1);
    expect(theirAlong.controller).toBe("p2");
  });

  it("R171 a round trip in one turn is two entries, so a ready unit that crosses away and back is sick again", () => {
    const state = playing("cc-round-trip");
    const turn = state.turn;
    // Right then left from p1's seat: p1 lane 5 → p2 lane 5 → p1 lane 5.
    const traveller = ready(put(state, plain.id, slot("p1", "units", 5)), turn - 1);
    expect(offeredAttacks(state, traveller)).toContain("hero-p2");

    rotate(state, "right");
    expect(traveller.controller).toBe("p2");
    rotate(state, "left");

    expect(traveller.controller).toBe("p1");
    expect(cardAt(state, slot("p1", "units", 5))?.id).toBe(traveller.id);
    expect(traveller.summonedTurn).toBe(turn);
    expect(attackTargets(state, traveller)).toEqual([]);
  });

  it("R171 a Charge unit that attacked and made the round trip may attack once more", () => {
    const state = playing("cc-round-trip-charge");
    const turn = state.turn;
    // Left then right from p1's seat: p1 lane 1 → p2 lane 1 → p1 lane 1.
    const charge = put(state, charger.id, slot("p1", "units", 1));
    charge.summonedTurn = turn - 1;
    charge.exertion = { attacked: true, switched: false };
    expect(offeredAttacks(state, charge)).toEqual([]);

    rotate(state, "left");
    expect(charge.controller).toBe("p2");
    rotate(state, "right");

    expect(charge.controller).toBe("p1");
    expect(charge.summonedTurn).toBe(turn);
    expect(charge.exertion).toEqual(FRESH);
    expect(offeredAttacks(state, charge)).toContain("hero-p2");
  });

  it("R171 a steal that does nothing touches neither summonedTurn nor exertion (R76, R15)", () => {
    const state = playing("cc-noop");
    const turn = state.turn;
    const mine = exhausted(put(state, plain.id, slot("p1", "units", 1)), turn - 1);
    for (let lane = 2; lane <= 5; lane += 1) put(state, plain.id, slot("p1", "units", lane));
    const theirs = exhausted(put(state, plain.id, slot("p2", "units", 3)), turn - 1);

    // R76: already yours. R15: no free zone on the thief's side.
    expect(run(state, steal({ instanceId: mine.id }), "p1")).toEqual([]);
    expect(run(state, steal({ instanceId: theirs.id }), "p1")).toEqual([]);

    for (const card of [mine, theirs]) {
      expect(card.summonedTurn).toBe(turn - 1);
      expect(card.exertion).toEqual({ attacked: true, switched: true });
    }
    expect(theirs.controller).toBe("p2");
  });

  it("R171 a change of control on the opponent's turn leaves the unit ready on its new controller's next turn", () => {
    let state = playing("cc-opponents-turn");
    const turn = state.turn;
    ready(put(state, plain.id, slot("p1", "units", 1)), turn - 1);
    const victim = exhausted(put(state, plain.id, slot("p1", "units", 2)), turn - 1);
    ready(put(state, plain.id, slot("p2", "units", 5)), turn - 1);

    // p1 is active, so this is the inactive player stealing: the unit enters p2's side on turn T.
    run(state, steal({ instanceId: victim.id }), "p2");
    expect(victim.controller).toBe("p2");
    expect(victim.summonedTurn).toBe(turn);

    state = act(state, { type: "endTurn", playerId: "p1" });

    expect(state.active).toBe("p2");
    expect(state.turn).toBe(turn + 1);
    const stolen = live(state, victim);
    expect(isSick(state, stolen)).toBe(false);
    expect(offeredAttacks(state, stolen)).toContain("hero-p1");
  });

  it("R171 forced attacks still ignore sickness and spend nothing (R53)", () => {
    const state = playing("cc-forced");
    const turn = state.turn;
    const victim = ready(put(state, plain.id, slot("p2", "units", 2)), turn - 1);
    victim.buffs = { attack: 0, health: 10 };
    const target = ready(put(state, plain.id, slot("p2", "units", 4)), turn - 1);
    target.buffs = { attack: 0, health: 10 };
    run(state, steal({ instanceId: victim.id }), "p1");
    expect(isSick(state, victim)).toBe(true);

    const sink = sinkFor(state);
    forceAttack(sink, victim, unit(target));

    expect(eventsOfType(sink.events, "attackDeclared")).toEqual([
      { type: "attackDeclared", attackerId: victim.id, targetId: target.id, forced: true },
    ]);
    expect(victim.exertion).toEqual(FRESH);
    expect(target.damage).toBe(unitView(state, victim).attack);
  });
});

// ---------------------------------------------------------------------------
// R172.
// ---------------------------------------------------------------------------

describe("R172 a stolen unit dies as its controller's", () => {
  it("R172 a stolen Reborn unit returns to the zone it reserved on the thief's side, owned by its owner and sick", () => {
    const state = playing("cc-reborn");
    const turn = state.turn;
    ready(put(state, plain.id, slot("p1", "units", 1)), turn - 1);
    const body = ready(put(state, reborner.id, slot("p2", "units", 3)), turn - 1);
    ready(put(state, plain.id, slot("p2", "units", 5)), turn - 1);
    run(state, steal({ instanceId: body.id }), "p1");
    expect(cardAt(state, slot("p1", "units", 3))?.id).toBe(body.id);

    body.damage = unitView(state, body).maxHealth;
    const events: GameEvent[] = [];
    stateCheck(sinkFor(state, events));

    // It died as p1's, went to its owner's pile on the way (R12), and came back where it died.
    expect(eventsOfType(events, "destroyed").map((e) => [e.instanceId, e.owner])).toEqual([[body.id, "p2"]]);
    const back = live(state, body);
    expect(cardAt(state, slot("p1", "units", 3))?.id).toBe(body.id);
    expect(back.controller).toBe("p1");
    expect(back.owner).toBe("p2");
    expect(state.players.p1.graveyard.map((c) => c.id)).not.toContain(body.id);
    expect(state.players.p2.graveyard.map((c) => c.id)).not.toContain(body.id);
    // R83: the return is an entry, so it is sick for the rest of the turn.
    expect(back.summonedTurn).toBe(turn);
    expect(attackTargets(state, back)).toEqual([]);
  });

  it("R172 a stolen unit's Death runs for the player who controlled it when it died", () => {
    const state = playing("cc-death");
    const turn = state.turn;
    const body = ready(put(state, reborner.id, slot("p2", "units", 2)), turn - 1);
    ready(put(state, plain.id, slot("p2", "units", 5)), turn - 1);
    run(state, steal({ instanceId: body.id }), "p1");

    body.damage = unitView(state, body).maxHealth;
    const events: GameEvent[] = [];
    stateCheck(sinkFor(state, events));

    // "Summon a token" for "you": p1, into p1's leftmost free zone, since the Reborn body holds lane 2.
    const summoned = eventsOfType(events, "summoned").filter((e) => e.defId === TOKEN_ID);
    expect(summoned.map((e) => [e.player, e.lane])).toEqual([["p1", 1]]);
    expect(cardAt(state, slot("p1", "units", 1))?.defId).toBe(TOKEN_ID);
    expect(cardAt(state, slot("p1", "units", 2))?.id).toBe(body.id);
    expect(cardAt(state, slot("p2", "units", 1))).toBeNull();
  });
});
