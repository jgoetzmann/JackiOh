// Positions and exertion (SPEC §4.1, R6, R7, R20, R49; BUILD M2-T1).

import type { Action, ActionInput, GameEvent, PlayerId } from "@jackioh/shared";
import { hasKeyword } from "@jackioh/shared";
import { describe, expect, it } from "vitest";
import { attackTargets, declareAttack, hasExertion, switchPosition } from "../src/combat";
import { unitView } from "../src/layers";
import { beginGame, legalActions, reduce } from "../src/reduce";
import type { CardInstance, GameState } from "../src/state";
import { armoured, bigDfender, deftDuelist, plain, spikeyPillow, taunter } from "./fixtures/combat";
import { eventsOfType, inHand, newGame, put, sinkFor, slot } from "./fixtures/harness";

let nonce = 0;
function attempt(state: GameState, body: ActionInput): ReturnType<typeof reduce> {
  nonce += 1;
  return reduce(state, { ...body, nonce: `cp${nonce}` } as Action);
}

function act(state: GameState, body: ActionInput): GameState {
  const result = attempt(state, body);
  if (result.error !== undefined) throw new Error(result.error);
  return result.state;
}

/** Past the mulligans, in the main phase of turn 1. */
function playing(seed = "positions"): GameState {
  let state = beginGame(newGame(seed)).state;
  state = act(state, { type: "mulligan", keep: state.players.p1.hand.map((c) => c.id), playerId: "p1" });
  state = act(state, { type: "mulligan", keep: state.players.p2.hand.map((c) => c.id), playerId: "p2" });
  return state;
}

function endTurns(state: GameState, count: number): GameState {
  let next = state;
  for (let i = 0; i < count; i += 1) next = act(next, { type: "endTurn", playerId: next.active });
  return next;
}

/** `reduce` clones, so a unit is re-read from the state it lives in, by its lane. */
function unitAt(state: GameState, player: PlayerId, lane: number): CardInstance {
  const unit = state.players[player].units[lane - 1]?.[0];
  if (unit === undefined) throw new Error(`no unit in ${player} lane ${lane}`);
  return unit;
}

function handCard(state: GameState, defId: string, player: PlayerId): CardInstance {
  const card = inHand(state, defId, player)[0];
  if (card === undefined) throw new Error(`could not add ${defId} to ${player}'s hand`);
  return card;
}

/** The spell path of R20: a switch that is an effect, not the player's action. */
function switchByEffect(
  state: GameState,
  unit: CardInstance,
  to?: "ATK" | "DEF",
): { events: GameEvent[]; error?: string } {
  const events: GameEvent[] = [];
  const result = switchPosition(sinkFor(state, events), unit, {
    spendExertion: false,
    ...(to === undefined ? {} : { to }),
  });
  return { events, ...(result.error === undefined ? {} : { error: result.error }) };
}

describe("positions and exertion (M2-T1)", () => {
  it("units enter the field in Attack Position (§4.1)", () => {
    const state = playing("enter-atk");
    const card = handCard(state, plain.id, "p1");
    const played = act(state, { type: "play", instanceId: card.id, zone: { row: "units", lane: 2 }, playerId: "p1" });

    const view = unitView(played, unitAt(played, "p1", 2));
    expect(view.position).toBe("ATK");
    expect(hasKeyword(view.keywords, "Taunt")).toBe(false);
    expect(view.armor).toBe(0);

    // A unit put on the field by anything else enters the same way.
    const summoned = put(played, plain.id, slot("p1", "units", 4));
    expect(unitView(played, summoned).position).toBe("ATK");
  });

  it("R6 a unit that switched position cannot attack that turn", () => {
    let state = playing("switch-then-attack");
    put(state, plain.id, slot("p1", "units", 1));

    state = act(state, { type: "switchPosition", instanceId: unitAt(state, "p1", 1).id, playerId: "p1" });
    let unit = unitAt(state, "p1", 1);
    expect(unitView(state, unit).position).toBe("DEF");
    expect(hasExertion(unit, "attack")).toBe(false);
    expect(attackTargets(state, unit)).toEqual([]);
    expect(attempt(state, { type: "attack", attackerId: unit.id, targetId: "hero-p2", playerId: "p1" }).error).toMatch(
      /already acted/,
    );

    // R6 proper: switching back to Attack Position also spends the turn's exertion.
    state = endTurns(state, 2); // p1's next turn, still in Defense
    unit = unitAt(state, "p1", 1);
    expect(unitView(state, unit).position).toBe("DEF");

    state = act(state, { type: "switchPosition", instanceId: unit.id, playerId: "p1" });
    unit = unitAt(state, "p1", 1);
    expect(unitView(state, unit).position).toBe("ATK");
    expect(hasExertion(unit, "attack")).toBe(false);
    expect(attackTargets(state, unit)).toEqual([]);
    expect(attempt(state, { type: "attack", attackerId: unit.id, targetId: "hero-p2", playerId: "p1" }).error).toMatch(
      /already acted/,
    );
    expect(state.players.p2.hero.health).toBe(30);
  });

  it("a unit that attacked cannot switch position that turn (§4.1)", () => {
    let state = playing("attack-then-switch");
    put(state, plain.id, slot("p1", "units", 1));

    state = act(state, {
      type: "attack",
      attackerId: unitAt(state, "p1", 1).id,
      targetId: "hero-p2",
      playerId: "p1",
    });
    expect(state.players.p2.hero.health).toBe(27);

    const unit = unitAt(state, "p1", 1);
    expect(unit.exertion.attacked).toBe(true);
    expect(hasExertion(unit, "switch")).toBe(false);
    expect(legalActions(state, "p1").some((a) => a.type === "switchPosition")).toBe(false);
    expect(attempt(state, { type: "switchPosition", instanceId: unit.id, playerId: "p1" }).error).toMatch(
      /already acted/,
    );
    expect(unitView(state, unit).position).toBe("ATK");
  });

  it("resets both exertions at the controller's next turn, not the opponent's (§4.1)", () => {
    let state = playing("exertion-reset");
    put(state, plain.id, slot("p1", "units", 1));
    put(state, plain.id, slot("p1", "units", 2));

    state = act(state, {
      type: "attack",
      attackerId: unitAt(state, "p1", 1).id,
      targetId: "hero-p2",
      playerId: "p1",
    });
    state = act(state, { type: "switchPosition", instanceId: unitAt(state, "p1", 2).id, playerId: "p1" });
    expect(unitAt(state, "p1", 1).exertion).toEqual({ attacked: true, switched: false });
    expect(unitAt(state, "p1", 2).exertion).toEqual({ attacked: false, switched: true });

    state = endTurns(state, 1); // the opponent's turn: p1's units stay spent
    expect(state.active).toBe("p2");
    expect(hasExertion(unitAt(state, "p1", 1), "switch")).toBe(false);
    expect(hasExertion(unitAt(state, "p1", 2), "attack")).toBe(false);

    state = endTurns(state, 1); // p1's own turn start resets both
    expect(state.active).toBe("p1");
    expect(unitAt(state, "p1", 1).exertion).toEqual({ attacked: false, switched: false });
    expect(unitAt(state, "p1", 2).exertion).toEqual({ attacked: false, switched: false });

    const attacker = unitAt(state, "p1", 1);
    expect(hasExertion(attacker, "attack")).toBe(true);
    expect(attackTargets(state, attacker).some((t) => t.kind === "hero")).toBe(true);
    state = act(state, { type: "attack", attackerId: attacker.id, targetId: "hero-p2", playerId: "p1" });
    expect(state.players.p2.hero.health).toBe(24);
    state = act(state, { type: "switchPosition", instanceId: unitAt(state, "p1", 2).id, playerId: "p1" });
    expect(unitView(state, unitAt(state, "p1", 2)).position).toBe("ATK");
  });

  it("R49 Deft Duelist attacks and switches in one turn", () => {
    let state = playing("deft-duelist");
    put(state, deftDuelist.id, slot("p1", "units", 1));
    put(state, plain.id, slot("p1", "units", 2));

    // The plain unit gets one exertion only; the Duelist gets both.
    state = act(state, {
      type: "attack",
      attackerId: unitAt(state, "p1", 1).id,
      targetId: "hero-p2",
      playerId: "p1",
    });
    expect(state.players.p2.hero.health).toBe(26);

    let duelist = unitAt(state, "p1", 1);
    expect(hasExertion(duelist, "switch")).toBe(true);
    expect(hasExertion(duelist, "attack")).toBe(false);

    state = act(state, { type: "switchPosition", instanceId: duelist.id, playerId: "p1" });
    duelist = unitAt(state, "p1", 1);
    expect(unitView(state, duelist).position).toBe("DEF");
    expect(duelist.exertion).toEqual({ attacked: true, switched: true });

    // Two of the same kind is still refused: one attack and one switch, not two switches.
    expect(hasExertion(duelist, "switch")).toBe(false);
    expect(attempt(state, { type: "switchPosition", instanceId: duelist.id, playerId: "p1" }).error).toMatch(
      /already acted/,
    );
    expect(
      attempt(state, { type: "attack", attackerId: duelist.id, targetId: "hero-p2", playerId: "p1" }).error,
    ).toMatch(/already acted/);
    expect(state.players.p2.hero.health).toBe(26);

    // R6 is lifted for the Duelist in the other order too: switch to Attack, then attack.
    state = endTurns(state, 2);
    duelist = unitAt(state, "p1", 1);
    expect(unitView(state, duelist).position).toBe("DEF");
    state = act(state, { type: "switchPosition", instanceId: duelist.id, playerId: "p1" });
    duelist = unitAt(state, "p1", 1);
    expect(unitView(state, duelist).position).toBe("ATK");
    state = act(state, { type: "attack", attackerId: duelist.id, targetId: "hero-p2", playerId: "p1" });
    expect(state.players.p2.hero.health).toBe(22);
  });

  it("R20 a unit switched by a spell keeps its exertion", () => {
    const state = playing("r20");
    const unit = put(state, plain.id, slot("p1", "units", 1));

    const toDefense = switchByEffect(state, unit);
    expect(toDefense.error).toBeUndefined();
    expect(unitView(state, unit).position).toBe("DEF");
    expect(unit.exertion).toEqual({ attacked: false, switched: false });
    expect(eventsOfType(toDefense.events, "positionSwitched")[0]).toMatchObject({
      instanceId: unit.id,
      position: "DEF",
    });

    // Switched back by a second effect, it can still take its own exertion this turn.
    expect(switchByEffect(state, unit, "ATK").error).toBeUndefined();
    expect(unitView(state, unit).position).toBe("ATK");
    expect(hasExertion(unit, "attack")).toBe(true);
    expect(hasExertion(unit, "switch")).toBe(true);

    const events: GameEvent[] = [];
    expect(declareAttack(sinkFor(state, events), unit, { kind: "hero", player: "p2" }).error).toBeUndefined();
    expect(state.players.p2.hero.health).toBe(27);
    expect(unit.exertion).toEqual({ attacked: true, switched: false });

    // And an effect may still flip a unit that has spent its exertion.
    expect(switchByEffect(state, unit).error).toBeUndefined();
    expect(unitView(state, unit).position).toBe("DEF");
    expect(unit.exertion).toEqual({ attacked: true, switched: false });
  });

  it("Defense Position grants Taunt (§4.1)", () => {
    const state = playing("defense-taunt");
    const attacker = put(state, plain.id, slot("p1", "units", 1));
    const open = put(state, plain.id, slot("p2", "units", 1));
    const defender = put(state, plain.id, slot("p2", "units", 2));

    expect(attackTargets(state, attacker)).toHaveLength(3); // both units and the hero

    switchByEffect(state, defender, "DEF");
    const view = unitView(state, defender);
    expect(view.position).toBe("DEF");
    expect(hasKeyword(view.keywords, "Taunt")).toBe(true);

    // The granted Taunt is the real thing: it is now the only legal target (§4.2 step 3).
    const targets = attackTargets(state, attacker);
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ kind: "unit" });
    expect(targets[0]?.kind === "unit" && targets[0].instance.id).toBe(defender.id);
    expect(hasKeyword(unitView(state, open).keywords, "Taunt")).toBe(false);

    // Back in Attack Position the Taunt is gone again.
    switchByEffect(state, defender, "ATK");
    expect(hasKeyword(unitView(state, defender).keywords, "Taunt")).toBe(false);
    expect(attackTargets(state, attacker)).toHaveLength(3);
  });

  it("Defense Armor +1 stacks with printed Armor and Big D-fender's aura (§4.1)", () => {
    const state = playing("defense-armor");
    const armour = put(state, armoured.id, slot("p1", "units", 1));
    const dfender = put(state, bigDfender.id, slot("p1", "units", 2));
    const enemy = put(state, armoured.id, slot("p2", "units", 1));

    // In Attack Position neither the position bonus nor the aura applies.
    expect(unitView(state, armour).armor).toBe(7);
    expect(unitView(state, dfender).armor).toBe(0);

    switchByEffect(state, armour, "DEF");
    expect(unitView(state, armour).armor).toBe(10); // 7 printed + 1 Defense + 2 aura
    expect(unitView(state, armour).keywords.filter((k) => k.kind === "Armor")).toHaveLength(3);

    // Big D-fender's own aura covers itself when it is in Defense.
    switchByEffect(state, dfender, "DEF");
    expect(unitView(state, dfender).armor).toBe(3); // 0 printed + 1 Defense + 2 aura

    // The aura is controller-scoped: the enemy's Defense unit gets the +1 only.
    switchByEffect(state, enemy, "DEF");
    expect(unitView(state, enemy).armor).toBe(8);

    // Radiant Big D-fender gives +4 instead.
    const radiantState = playing("defense-armor-radiant");
    const radiantArmour = put(radiantState, armoured.id, slot("p1", "units", 1));
    put(radiantState, bigDfender.id, slot("p1", "units", 2), { radiant: true });
    switchByEffect(radiantState, radiantArmour, "DEF");
    expect(unitView(radiantState, radiantArmour).armor).toBe(12); // 7 + 1 + 4
  });

  it("Spikey Pillow cannot be switched to Defense Position (§4.1)", () => {
    let state = playing("spikey-pillow");
    put(state, spikeyPillow.id, slot("p1", "units", 1));
    put(state, taunter.id, slot("p1", "units", 2));

    const pillow = unitAt(state, "p1", 1);
    expect(unitView(state, pillow).position).toBe("ATK");
    expect(legalActions(state, "p1").some((a) => a.type === "switchPosition" && a.instanceId === pillow.id)).toBe(false);
    expect(legalActions(state, "p1").some((a) => a.type === "switchPosition")).toBe(true); // the other unit may

    const refused = attempt(state, { type: "switchPosition", instanceId: pillow.id, playerId: "p1" });
    expect(refused.error).toMatch(/cannot be in Defense Position/);

    // The spell path (R20) cannot sneak it into Defense either.
    const byEffect = switchByEffect(state, pillow, "DEF");
    expect(byEffect.error).toMatch(/cannot be in Defense Position/);
    expect(eventsOfType(byEffect.events, "positionSwitched")).toHaveLength(0);

    const after = unitView(state, pillow);
    expect(after.position).toBe("ATK");
    expect(hasKeyword(after.keywords, "Taunt")).toBe(false);
    expect(after.armor).toBe(0);
    expect(pillow.exertion).toEqual({ attacked: false, switched: false });

    // The refusal costs nothing, so the unit's exertion is still there next action.
    state = act(state, { type: "switchPosition", instanceId: unitAt(state, "p1", 2).id, playerId: "p1" });
    expect(unitView(state, unitAt(state, "p1", 2)).position).toBe("DEF");
  });

  it("a summoning-sick unit may still switch to Defense (§4.1)", () => {
    let state = playing("sick-switch");
    const card = handCard(state, plain.id, "p1");
    state = act(state, { type: "play", instanceId: card.id, zone: { row: "units", lane: 1 }, playerId: "p1" });

    let unit = unitAt(state, "p1", 1);
    expect(unit.summonedTurn).toBe(state.turn);
    expect(attackTargets(state, unit)).toEqual([]);
    expect(attempt(state, { type: "attack", attackerId: unit.id, targetId: "hero-p2", playerId: "p1" }).error).toMatch(
      /summoning sick/,
    );

    expect(legalActions(state, "p1").some((a) => a.type === "switchPosition" && a.instanceId === unit.id)).toBe(true);
    state = act(state, { type: "switchPosition", instanceId: unit.id, playerId: "p1" });
    unit = unitAt(state, "p1", 1);
    const view = unitView(state, unit);
    expect(view.position).toBe("DEF");
    expect(hasKeyword(view.keywords, "Taunt")).toBe(true);
    expect(view.armor).toBe(1);
    expect(unit.exertion).toEqual({ attacked: false, switched: true });
  });
});
