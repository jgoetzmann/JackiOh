// Combat resolution (BUILD M2-T4): the First Strike step, the simultaneous step, hero targets and
// forced attacks. SPEC §4.2's forced-attack paragraph, §4.3, §4.5, R53 and R59.

import type { GameEvent, PlayerId } from "@jackioh/shared";
import { describe, expect, it } from "vitest";
import {
  declareAttack,
  forceAttack,
  forceAttacksOn,
  hasExertion,
  isSick,
  switchPosition,
  whyCannotAttack,
  type AttackTarget,
} from "../src/combat";
import { unitView } from "../src/layers";
import type { CardInstance, GameState } from "../src/state";
import { activeUnitsOf } from "../src/zones";
import { bigBody, firstStriker, moths, plain, taunter } from "./fixtures/combat";
import { eventsOfType, newGame, put, sinkFor, slot } from "./fixtures/harness";

/** p1's main phase on turn 4, so nothing placed with `put` is summoning sick (§4.1). */
function board(seed: string): GameState {
  const state = newGame(seed);
  state.turn = 4;
  state.active = "p1";
  state.phase = "main";
  return state;
}

function onUnit(instance: CardInstance): AttackTarget {
  return { kind: "unit", instance };
}

function graveyardIds(state: GameState, player: PlayerId): string[] {
  return state.players[player].graveyard.map((card) => card.id);
}

function fieldIds(state: GameState, player: PlayerId): string[] {
  return activeUnitsOf(state, player).map((unit) => unit.id);
}

describe("combat resolution (M2-T4)", () => {
  it("a First Strike attacker survives a defender it kills (§4.3)", () => {
    const state = board("first-strike-kill");
    const attacker = put(state, firstStriker.id, slot("p1", "units", 1)); // 4/4 First Strike
    const defender = put(state, plain.id, slot("p2", "units", 1)); // 3/3

    const events: GameEvent[] = [];
    expect(declareAttack(sinkFor(state, events), attacker, onUnit(defender)).error).toBeUndefined();

    // "If D is destroyed here it deals nothing": the whole combat is one hit.
    const hits = eventsOfType(events, "damage");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ sourceId: attacker.id, targetId: defender.id, amount: 4, combat: true });

    expect(graveyardIds(state, "p2")).toEqual([defender.id]);
    expect(fieldIds(state, "p1")).toEqual([attacker.id]);
    expect(attacker.damage).toBe(0);
    expect(unitView(state, attacker).health).toBe(4);
  });

  it("two First Strikers strike simultaneously in step 1 and both die (§4.3)", () => {
    const state = board("first-strike-trade");
    const attacker = put(state, firstStriker.id, slot("p1", "units", 1));
    const defender = put(state, firstStriker.id, slot("p2", "units", 1));

    const events: GameEvent[] = [];
    expect(declareAttack(sinkFor(state, events), attacker, onUnit(defender)).error).toBeUndefined();

    expect(
      eventsOfType(events, "damage").map((hit) => ({
        source: hit.sourceId,
        target: hit.targetId,
        amount: hit.amount,
        combat: hit.combat,
      })),
    ).toEqual([
      { source: attacker.id, target: defender.id, amount: 4, combat: true },
      { source: defender.id, target: attacker.id, amount: 4, combat: true },
    ]);

    expect(graveyardIds(state, "p1")).toEqual([attacker.id]);
    expect(graveyardIds(state, "p2")).toEqual([defender.id]);
    expect(fieldIds(state, "p1")).toEqual([]);
    expect(fieldIds(state, "p2")).toEqual([]);
  });

  it("a defender in Defense Position strikes back at full attack (§4.3)", () => {
    const state = board("defense-strikes-back");
    const attacker = put(state, plain.id, slot("p1", "units", 1)); // 3/3
    const defender = put(state, bigBody.id, slot("p2", "units", 1)); // 5/10
    expect(switchPosition(sinkFor(state), defender, { spendExertion: false, to: "DEF" }).error).toBeUndefined();

    // Defense grants Taunt and Armor +1 but never lowers the attack it strikes back with (§4.1).
    const defenderView = unitView(state, defender);
    expect(defenderView.position).toBe("DEF");
    expect(defenderView.attack).toBe(5);
    expect(defenderView.armor).toBe(1);

    const events: GameEvent[] = [];
    expect(declareAttack(sinkFor(state, events), attacker, onUnit(defender)).error).toBeUndefined();

    const strikeBack = eventsOfType(events, "damage").find((hit) => hit.sourceId === defender.id);
    expect(strikeBack).toMatchObject({ targetId: attacker.id, amount: 5, combat: true });

    expect(defender.damage).toBe(2); // the attacker's 3 less the Defense Armor
    expect(graveyardIds(state, "p1")).toEqual([attacker.id]);
    expect(fieldIds(state, "p2")).toEqual([defender.id]);
  });

  it("a hero never strikes back (§4.3)", () => {
    const state = board("hero-target");
    const attacker = put(state, bigBody.id, slot("p1", "units", 1)); // 5/10
    const enemyHero = state.players.p2.hero.health;
    const ownHero = state.players.p1.hero.health;

    const events: GameEvent[] = [];
    expect(declareAttack(sinkFor(state, events), attacker, { kind: "hero", player: "p2" }).error).toBeUndefined();

    const hits = eventsOfType(events, "damage");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ sourceId: attacker.id, targetId: "hero-p2", amount: 5, combat: true });

    expect(state.players.p2.hero.health).toBe(enemyHero - 5);
    expect(state.players.p1.hero.health).toBe(ownHero);
    expect(attacker.damage).toBe(0);
    expect(fieldIds(state, "p1")).toEqual([attacker.id]);
  });

  it("R59 both units of one combat die together; the first death does not cancel the exchange", () => {
    const state = board("r59-mutual-kill");
    const attacker = put(state, plain.id, slot("p1", "units", 1)); // 3/3
    const defender = put(state, plain.id, slot("p2", "units", 1)); // 3/3

    const events: GameEvent[] = [];
    expect(declareAttack(sinkFor(state, events), attacker, onUnit(defender)).error).toBeUndefined();

    // The state check never runs between the two hits of one combat (§4.5, R59), so both deaths
    // land after both hits rather than the attacker's kill cancelling the strike back.
    expect(events.map((event) => event.type).filter((type) => type === "damage" || type === "destroyed")).toEqual([
      "damage",
      "damage",
      "destroyed",
      "destroyed",
    ]);
    expect(eventsOfType(events, "damage").map((hit) => hit.amount)).toEqual([3, 3]);

    expect(graveyardIds(state, "p1")).toEqual([attacker.id]);
    expect(graveyardIds(state, "p2")).toEqual([defender.id]);
  });
});

  it("a defender with First Strike hits first, and a surviving attacker strikes back (§4.3)", () => {
    const state = board("defender-first-strike");
    const attacker = put(state, bigBody.id, slot("p1", "units", 1)); // 5/10, no First Strike
    const defender = put(state, firstStriker.id, slot("p2", "units", 1)); // 4/4 First Strike

    const events: GameEvent[] = [];
    const sink = sinkFor(state, events);
    declareAttack(sink, attacker, { kind: "unit", instance: defender });

    // The defender struck first for 4; the attacker survived on 10 health and struck back for 5.
    const damage = eventsOfType(events, "damage");
    expect(damage.map((e) => e.amount)).toEqual([4, 5]);
    expect(damage[0]?.sourceId).toBe(defender.id);
    expect(damage[1]?.sourceId).toBe(attacker.id);
    expect(unitView(state, attacker).health).toBe(6);
    expect(state.players.p2.graveyard.map((c) => c.id)).toEqual([defender.id]);
  });

  it("a defender with First Strike that kills the attacker takes nothing back (§4.3)", () => {
    const state = board("defender-first-strike-kill");
    const attacker = put(state, plain.id, slot("p1", "units", 1)); // 3/3
    const defender = put(state, firstStriker.id, slot("p2", "units", 1)); // 4/4 First Strike

    const events: GameEvent[] = [];
    declareAttack(sinkFor(state, events), attacker, { kind: "unit", instance: defender });

    expect(eventsOfType(events, "damage").map((e) => e.amount)).toEqual([4]);
    expect(state.players.p1.graveyard.map((c) => c.id)).toEqual([attacker.id]);
    expect(unitView(state, defender).health).toBe(4);
  });

describe("forced attacks (R53, M2-T4)", () => {
  it("R53 Moths pulls a summoning-sick enemy into an attack without spending its exertion", () => {
    const state = board("moths-sick");
    const flame = put(state, moths.id, slot("p1", "units", 1)); // 1/14
    const sick = put(state, plain.id, slot("p2", "units", 1)); // 3/3
    sick.summonedTurn = state.turn;

    expect(isSick(state, sick)).toBe(true);
    expect(whyCannotAttack(state, sick, onUnit(flame))).toBe("that unit is summoning sick");

    const events: GameEvent[] = [];
    forceAttack(sinkFor(state, events), sick, onUnit(flame));

    expect(eventsOfType(events, "attackDeclared")).toEqual([
      { type: "attackDeclared", attackerId: sick.id, targetId: flame.id, forced: true },
    ]);
    expect(flame.damage).toBe(3);
    expect(sick.damage).toBe(1);

    // No exertion spent: the unit is still free to act on its own turn (§4.2, R53).
    expect(sick.exertion).toEqual({ attacked: false, switched: false });
    expect(hasExertion(sick, "attack")).toBe(true);
  });

  it("R53 a forced attack ignores position, sickness and the Taunt rule", () => {
    const state = board("forced-ignores-rules");
    const guard = put(state, taunter.id, slot("p1", "units", 1)); // 2/5 Taunt
    const flame = put(state, moths.id, slot("p1", "units", 2)); // 1/14
    const defending = put(state, plain.id, slot("p2", "units", 1));
    const sick = put(state, plain.id, slot("p2", "units", 2));
    const blocked = put(state, plain.id, slot("p2", "units", 3));
    expect(switchPosition(sinkFor(state), defending, { spendExertion: false, to: "DEF" }).error).toBeUndefined();
    sick.summonedTurn = state.turn;

    // Every one of the three is refused by §4.2 steps 1 to 3.
    expect(unitView(state, guard).keywords.some((keyword) => keyword.kind === "Taunt")).toBe(true);
    expect(whyCannotAttack(state, defending, onUnit(flame))).toBe("only Attack-Position units may attack");
    expect(whyCannotAttack(state, sick, onUnit(flame))).toBe("that unit is summoning sick");
    expect(whyCannotAttack(state, blocked, onUnit(flame))).toBe("a Taunt unit must be attacked first");

    const events: GameEvent[] = [];
    const sink = sinkFor(state, events);
    forceAttack(sink, defending, onUnit(flame));
    forceAttack(sink, sick, onUnit(flame));
    forceAttack(sink, blocked, onUnit(flame));

    const declared = eventsOfType(events, "attackDeclared");
    expect(declared.map((event) => event.attackerId)).toEqual([defending.id, sick.id, blocked.id]);
    expect(declared.every((event) => event.forced)).toBe(true);

    // All three struck for their full 3, the Defense-Position one included.
    expect(flame.damage).toBe(9);
    expect(defending.damage).toBe(0); // Moths' 1 is eaten by the Defense Armor
    expect(sick.damage).toBe(1);
    expect(blocked.damage).toBe(1);
  });

  it("R53 an ordinary attack spends the attacker's exertion and a forced one does not", () => {
    const state = board("forced-exertion");
    const ordinary = put(state, bigBody.id, slot("p1", "units", 1)); // 5/10
    const forced = put(state, bigBody.id, slot("p1", "units", 2)); // 5/10
    const first = put(state, plain.id, slot("p2", "units", 1));
    const second = put(state, plain.id, slot("p2", "units", 2));
    const third = put(state, plain.id, slot("p2", "units", 3));

    const sink = sinkFor(state);
    expect(declareAttack(sink, ordinary, onUnit(first)).error).toBeUndefined();
    expect(ordinary.exertion.attacked).toBe(true);
    expect(hasExertion(ordinary, "attack")).toBe(false);
    expect(declareAttack(sink, ordinary, onUnit(second)).error).toBe("that unit has already acted this turn");

    forceAttack(sink, forced, onUnit(second));
    expect(forced.exertion).toEqual({ attacked: false, switched: false });
    expect(hasExertion(forced, "attack")).toBe(true);

    // The exertion is still there, so the same unit can still make its own attack this turn.
    expect(declareAttack(sink, forced, onUnit(third)).error).toBeUndefined();
    expect(forced.exertion.attacked).toBe(true);
    expect(graveyardIds(state, "p2")).toEqual([first.id, second.id, third.id]);
  });

  it("R53 each forced attack is its own combat followed by its own state check", () => {
    const state = board("forced-own-combat");
    const target = put(state, bigBody.id, slot("p1", "units", 1)); // 5/10
    const first = put(state, plain.id, slot("p2", "units", 1)); // 3/3
    const second = put(state, plain.id, slot("p2", "units", 2)); // 3/3

    const events: GameEvent[] = [];
    forceAttacksOn(sinkFor(state, events), [first, second], onUnit(target));

    // A state check between the two combats, so the first attacker is already dead and buried
    // when the second attack is declared (§4.5, R53).
    expect(
      events.map((event) => event.type).filter((type) => type === "attackDeclared" || type === "destroyed"),
    ).toEqual(["attackDeclared", "destroyed", "attackDeclared", "destroyed"]);

    expect(graveyardIds(state, "p2")).toEqual([first.id, second.id]);
    expect(target.damage).toBe(6);
    expect(unitView(state, target).health).toBe(4);
  });

  it("R53 a sequence of forced attackers stops once the target is gone", () => {
    const state = board("forced-stops-when-gone");
    const target = put(state, taunter.id, slot("p1", "units", 1)); // 2/5
    const first = put(state, plain.id, slot("p2", "units", 1));
    const second = put(state, plain.id, slot("p2", "units", 2));
    const third = put(state, plain.id, slot("p2", "units", 3));

    const events: GameEvent[] = [];
    forceAttacksOn(sinkFor(state, events), activeUnitsOf(state, "p2"), onUnit(target));

    // Two 3-attack hits finish a 5-health target, so the third attacker is never pulled in.
    expect(eventsOfType(events, "attackDeclared").map((event) => event.attackerId)).toEqual([first.id, second.id]);
    expect(graveyardIds(state, "p1")).toEqual([target.id]);
    expect(third.damage).toBe(0);
    expect(fieldIds(state, "p2")).toEqual([first.id, second.id, third.id]);
    expect([first.damage, second.damage]).toEqual([2, 2]);
  });
});
