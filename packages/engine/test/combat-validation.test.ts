// Attack validation: §4.2 steps 1 to 3, §4.1, §6.1 and R5, R6, R7 (M2-T2).
// One test per refusal reason, plus the positive cases that give the refusals meaning.

import type { Action, ActionInput, PlayerId } from "@jackioh/shared";
import { describe, expect, it } from "vitest";
import { attackTargets, canAttack, whyCannotAttack, type AttackTarget } from "../src/combat";
import { LANE_RESTRICTED_ATTACKS } from "../src/config";
import { beginGame, legalActions, reduce } from "../src/reduce";
import { findInstance, newInstance, type CardInstance, type GameState } from "../src/state";
import { placeOnField } from "../src/zones";
import { eventsOfType, newGame, put, slot } from "./fixtures/harness";
import {
  bigDfender,
  charger,
  deftDuelist,
  pacifist,
  plain,
  rusher,
  stacker,
  taunter,
  zeroAttack,
} from "./fixtures/combat";

let nonce = 0;
function act(state: GameState, body: ActionInput): GameState {
  nonce += 1;
  const result = reduce(state, { ...body, nonce: `cv${nonce}` } as Action);
  if (result.error !== undefined) throw new Error(result.error);
  return result.state;
}

function attackVia(
  state: GameState,
  attackerId: string,
  targetId: string,
  player: PlayerId = "p1",
): ReturnType<typeof reduce> {
  nonce += 1;
  return reduce(state, { type: "attack", attackerId, targetId, playerId: player, nonce: `cv${nonce}` });
}

/** Past the mulligans, in the main phase of p1's first turn. */
function playing(seed = "attack-validation"): GameState {
  let state = beginGame(newGame(seed)).state;
  state = act(state, { type: "mulligan", keep: state.players.p1.hand.map((c) => c.id), playerId: "p1" });
  state = act(state, { type: "mulligan", keep: state.players.p2.hand.map((c) => c.id), playerId: "p2" });
  return state;
}

const onUnit = (instance: CardInstance): AttackTarget => ({ kind: "unit", instance });
const onHero = (player: PlayerId): AttackTarget => ({ kind: "hero", player });

/** §4.1: a unit that entered the field this turn is summoning sick. */
function makeSick(state: GameState, unit: CardInstance): CardInstance {
  unit.summonedTurn = state.turn;
  return unit;
}

function instance(state: GameState, id: string): CardInstance {
  const found = findInstance(state, id);
  if (found === undefined) throw new Error(`no instance ${id}`);
  return found;
}

function names(state: GameState, attacker: CardInstance): string[] {
  return attackTargets(state, attacker).map((t) => (t.kind === "unit" ? t.instance.id : `hero-${t.player}`));
}

describe("attack validation: the attacker (§4.2 step 1, M2-T2)", () => {
  it("lets a unit that has been on the field since last turn attack a unit or the hero", () => {
    const state = newGame("legal-attack");
    const attacker = put(state, plain.id, slot("p1", "units", 1));
    const defender = put(state, plain.id, slot("p2", "units", 1));

    expect(whyCannotAttack(state, attacker, onUnit(defender))).toBeNull();
    expect(whyCannotAttack(state, attacker, onHero("p2"))).toBeNull();
    expect(canAttack(state, attacker, onUnit(defender))).toBe(true);
    expect(canAttack(state, attacker, onHero("p2"))).toBe(true);
  });

  it("R6 refuses a unit that has already acted this turn, while Deft Duelist may still attack", () => {
    const state = newGame("exertion-spent");
    const attacked = put(state, plain.id, slot("p1", "units", 1));
    const switched = put(state, plain.id, slot("p1", "units", 2));
    const duelist = put(state, deftDuelist.id, slot("p1", "units", 3));
    const defender = put(state, plain.id, slot("p2", "units", 1));

    attacked.exertion.attacked = true;
    expect(whyCannotAttack(state, attacked, onUnit(defender))).toBe("that unit has already acted this turn");
    expect(whyCannotAttack(state, attacked, onHero("p2"))).toBe("that unit has already acted this turn");
    expect(attackTargets(state, attacked)).toEqual([]);

    // R6: switching to Attack Position spends the turn's exertion too.
    switched.exertion.switched = true;
    expect(whyCannotAttack(state, switched, onUnit(defender))).toBe("that unit has already acted this turn");

    // R49: Deft Duelist has two exertions, one attack and one switch.
    duelist.exertion.switched = true;
    expect(whyCannotAttack(state, duelist, onUnit(defender))).toBeNull();
    duelist.exertion.attacked = true;
    expect(whyCannotAttack(state, duelist, onUnit(defender))).toBe("that unit has already acted this turn");
  });

  it("R6 refuses a unit in Defense Position", () => {
    const state = newGame("defense-position");
    const attacker = put(state, plain.id, slot("p1", "units", 1));
    const defender = put(state, plain.id, slot("p2", "units", 1));

    attacker.position = "DEF";
    expect(whyCannotAttack(state, attacker, onUnit(defender))).toBe("only Attack-Position units may attack");
    expect(whyCannotAttack(state, attacker, onHero("p2"))).toBe("only Attack-Position units may attack");
    expect(attackTargets(state, attacker)).toEqual([]);

    attacker.position = "ATK";
    expect(whyCannotAttack(state, attacker, onUnit(defender))).toBeNull();
  });

  it("refuses a summoning-sick unit without Rush or Charge (§4.1)", () => {
    const state = newGame("summoning-sick");
    const sick = makeSick(state, put(state, plain.id, slot("p1", "units", 1)));
    const sickRusher = makeSick(state, put(state, rusher.id, slot("p1", "units", 2)));
    const sickCharger = makeSick(state, put(state, charger.id, slot("p1", "units", 3)));
    const granted = makeSick(state, put(state, plain.id, slot("p1", "units", 4)));
    const defender = put(state, plain.id, slot("p2", "units", 1));

    expect(whyCannotAttack(state, sick, onUnit(defender))).toBe("that unit is summoning sick");
    expect(whyCannotAttack(state, sick, onHero("p2"))).toBe("that unit is summoning sick");
    expect(attackTargets(state, sick)).toEqual([]);

    // §6.1: Rush lifts sickness for unit targets, Charge for units and the hero.
    expect(whyCannotAttack(state, sickRusher, onUnit(defender))).toBeNull();
    expect(whyCannotAttack(state, sickCharger, onUnit(defender))).toBeNull();

    // A granted keyword counts the same as a printed one (§10.4).
    granted.grantedKeywords.push({ kind: "Rush" });
    expect(whyCannotAttack(state, granted, onUnit(defender))).toBeNull();
  });

  it("R7 refuses a unit with 0 attack", () => {
    const state = newGame("zero-attack");
    const zero = put(state, zeroAttack.id, slot("p1", "units", 1));
    const drained = put(state, plain.id, slot("p1", "units", 2));
    const defender = put(state, plain.id, slot("p2", "units", 1));

    expect(whyCannotAttack(state, zero, onUnit(defender))).toBe("a unit with 0 attack cannot attack");
    expect(whyCannotAttack(state, zero, onHero("p2"))).toBe("a unit with 0 attack cannot attack");
    expect(attackTargets(state, zero)).toEqual([]);

    // A 3/3 whose attack was dragged to 0 is refused the same way (§10.4 layer 4).
    drained.buffs.attack = -3;
    expect(whyCannotAttack(state, drained, onUnit(defender))).toBe("a unit with 0 attack cannot attack");
    drained.buffs.attack = -2;
    expect(whyCannotAttack(state, drained, onUnit(defender))).toBeNull();
  });

  it("R7 never lets Big D-fender (0 attack) be an attacker", () => {
    const state = newGame("big-dfender");
    const bigD = put(state, bigDfender.id, slot("p1", "units", 1));
    const radiantBigD = put(state, bigDfender.id, slot("p1", "units", 2), { radiant: true });
    const defender = put(state, plain.id, slot("p2", "units", 1));

    for (const unit of [bigD, radiantBigD]) {
      expect(whyCannotAttack(state, unit, onUnit(defender))).toBe("a unit with 0 attack cannot attack");
      expect(whyCannotAttack(state, unit, onHero("p2"))).toBe("a unit with 0 attack cannot attack");
      expect(attackTargets(state, unit)).toEqual([]);

      // Not even with the sickness exemptions or a fresh turn's exertion.
      unit.grantedKeywords.push({ kind: "Rush" }, { kind: "Charge" });
      unit.exertion = { attacked: false, switched: false };
      expect(attackTargets(state, unit)).toEqual([]);
    }

    // And the action layer never offers it an attack.
    const game = playing("big-dfender-actions");
    const onBoard = put(game, bigDfender.id, slot("p1", "units", 1));
    put(game, plain.id, slot("p2", "units", 1));
    expect(legalActions(game, "p1").some((a) => a.type === "attack" && a.attackerId === onBoard.id)).toBe(false);
  });

  it("refuses a unit with Can't attack (§6.1)", () => {
    const state = newGame("cant-attack");
    const stuck = put(state, pacifist.id, slot("p1", "units", 1));
    const defender = put(state, plain.id, slot("p2", "units", 1));

    expect(whyCannotAttack(state, stuck, onUnit(defender))).toBe("that unit cannot attack");
    expect(whyCannotAttack(state, stuck, onHero("p2"))).toBe("that unit cannot attack");
    expect(attackTargets(state, stuck)).toEqual([]);

    // Granting it to a plain unit refuses that unit too.
    const granted = put(state, plain.id, slot("p1", "units", 2));
    expect(whyCannotAttack(state, granted, onUnit(defender))).toBeNull();
    granted.grantedKeywords.push({ kind: "Can't attack" });
    expect(whyCannotAttack(state, granted, onUnit(defender))).toBe("that unit cannot attack");
  });

  it("R13 refuses an attack by a card dormant under a Stack (§3.2)", () => {
    const state = newGame("stack-dormant");
    const under = put(state, plain.id, slot("p1", "units", 1));
    const defender = put(state, plain.id, slot("p2", "units", 1));
    expect(whyCannotAttack(state, under, onUnit(defender))).toBeNull();

    const top = newInstance(state, stacker.id, "p1", { z: "hand", player: "p1" });
    expect(placeOnField(state, top, slot("p1", "units", 1), { stack: true })).toBe(true);

    expect(whyCannotAttack(state, under, onUnit(defender))).toBe("that unit is not on the field");
    expect(whyCannotAttack(state, under, onHero("p2"))).toBe("that unit is not on the field");
    expect(attackTargets(state, under)).toEqual([]);

    // Only the top of the pile acts.
    expect(whyCannotAttack(state, top, onUnit(defender))).toBeNull();
  });
});

describe("attack validation: the target (§4.2 steps 2 and 3, M2-T2)", () => {
  it("refuses a target that is not an enemy", () => {
    const state = newGame("not-an-enemy");
    const attacker = put(state, plain.id, slot("p1", "units", 1));
    const friend = put(state, plain.id, slot("p1", "units", 2));
    const defender = put(state, plain.id, slot("p2", "units", 1));

    expect(whyCannotAttack(state, attacker, onUnit(friend))).toBe("that target is not an enemy");
    expect(whyCannotAttack(state, attacker, onHero("p1"))).toBe("that target is not an enemy");
    expect(whyCannotAttack(state, attacker, onUnit(attacker))).toBe("that target is not an enemy");
    expect(whyCannotAttack(state, attacker, onUnit(defender))).toBeNull();
    expect(names(state, attacker)).toEqual([defender.id, "hero-p2"]);
  });

  it("refuses Rush against the hero on its summon turn, while Charge may hit it (§6.1)", () => {
    const state = newGame("rush-vs-charge");
    const sickRusher = makeSick(state, put(state, rusher.id, slot("p1", "units", 1)));
    const sickCharger = makeSick(state, put(state, charger.id, slot("p1", "units", 2)));
    const defender = put(state, plain.id, slot("p2", "units", 1));

    expect(whyCannotAttack(state, sickRusher, onHero("p2"))).toBe("Rush cannot hit the hero on its summon turn");
    expect(whyCannotAttack(state, sickRusher, onUnit(defender))).toBeNull();
    expect(names(state, sickRusher)).toEqual([defender.id]);

    expect(whyCannotAttack(state, sickCharger, onHero("p2"))).toBeNull();
    expect(names(state, sickCharger)).toEqual([defender.id, "hero-p2"]);

    // The next turn the Rush unit is no longer sick and may go face.
    delete sickRusher.summonedTurn;
    expect(whyCannotAttack(state, sickRusher, onHero("p2"))).toBeNull();
  });

  it("requires a Taunt unit to be attacked first, printed or granted (§4.2 step 3)", () => {
    const state = newGame("taunt-filter");
    const attacker = put(state, plain.id, slot("p1", "units", 1));
    const bystander = put(state, plain.id, slot("p2", "units", 1));
    const wall = put(state, taunter.id, slot("p2", "units", 2));

    expect(whyCannotAttack(state, attacker, onUnit(bystander))).toBe("a Taunt unit must be attacked first");
    expect(whyCannotAttack(state, attacker, onHero("p2"))).toBe("a Taunt unit must be attacked first");
    expect(whyCannotAttack(state, attacker, onUnit(wall))).toBeNull();
    expect(names(state, attacker)).toEqual([wall.id]);

    // A granted Taunt filters exactly the same way, and a Taunt on your own side does not.
    const own = put(state, plain.id, slot("p1", "units", 2));
    own.grantedKeywords.push({ kind: "Taunt" });
    bystander.grantedKeywords.push({ kind: "Taunt" });
    expect(names(state, attacker).sort()).toEqual([bystander.id, wall.id].sort());
  });

  it("makes a Defense-Position enemy force the target even with no printed Taunt (§4.1)", () => {
    const state = newGame("defense-taunt");
    expect(plain.base.keywords).toEqual([]);

    const attacker = put(state, plain.id, slot("p1", "units", 1));
    const bystander = put(state, plain.id, slot("p2", "units", 1));
    const defending = put(state, plain.id, slot("p2", "units", 2));
    defending.position = "DEF";

    expect(whyCannotAttack(state, attacker, onUnit(bystander))).toBe("a Taunt unit must be attacked first");
    expect(whyCannotAttack(state, attacker, onHero("p2"))).toBe("a Taunt unit must be attacked first");
    expect(whyCannotAttack(state, attacker, onUnit(defending))).toBeNull();
    expect(names(state, attacker)).toEqual([defending.id]);

    // Back to Attack Position and the board opens up again.
    defending.position = "ATK";
    expect(names(state, attacker)).toEqual([bystander.id, defending.id, "hero-p2"]);
  });

  it("R5 lets a lane-1 unit attack an enemy in lane 5, since attacks are not lane-restricted", () => {
    expect(LANE_RESTRICTED_ATTACKS).toBe(false);

    const state = newGame("no-lane-restriction");
    const attacker = put(state, plain.id, slot("p1", "units", 1));
    const far = put(state, plain.id, slot("p2", "units", 5));

    expect(whyCannotAttack(state, attacker, onUnit(far))).toBeNull();
    expect(names(state, attacker)).toEqual([far.id, "hero-p2"]);
  });

  it("attackTargets lists exactly the legal targets (§4.2)", () => {
    const state = newGame("attack-targets");
    const attacker = put(state, plain.id, slot("p1", "units", 1));
    const first = put(state, plain.id, slot("p2", "units", 1));
    const third = put(state, plain.id, slot("p2", "units", 3));

    expect(names(state, attacker)).toEqual([first.id, third.id, "hero-p2"]);

    third.grantedKeywords.push({ kind: "Taunt" });
    expect(names(state, attacker)).toEqual([third.id]);

    attacker.exertion.attacked = true;
    expect(attackTargets(state, attacker)).toEqual([]);
  });
});

  it("R13 refuses a dormant card under a Stack as a target too (§3.2)", () => {
    const state = playing("dormant-target");
    const attacker = put(state, plain.id, slot("p1", "units", 1));
    const buried = put(state, plain.id, slot("p2", "units", 1));
    const top = newInstance(state, stacker.id, "p2", { z: "hand", player: "p2" });
    expect(placeOnField(state, top, slot("p2", "units", 1), { stack: true })).toBe(true);

    // The pile's top is a legal target; the card underneath is not (§3.2 "not targetable").
    expect(whyCannotAttack(state, attacker, { kind: "unit", instance: top })).toBeNull();
    expect(whyCannotAttack(state, attacker, { kind: "unit", instance: buried })).toBe(
      "that unit is not on the field",
    );
    expect(attackTargets(state, attacker).some((t) => t.kind === "unit" && t.instance.id === buried.id)).toBe(false);
  });

describe("attack validation through the action layer (§9.3, M2-T2)", () => {
  it("surfaces each refusal as the error of an attack action", () => {
    const state = playing("attack-action-errors");
    const spent = put(state, plain.id, slot("p1", "units", 1));
    const defending = put(state, plain.id, slot("p1", "units", 2));
    const stuck = put(state, pacifist.id, slot("p1", "units", 3));
    const zero = put(state, zeroAttack.id, slot("p1", "units", 4));
    const sick = makeSick(state, put(state, plain.id, slot("p1", "units", 5)));
    const enemy = put(state, plain.id, slot("p2", "units", 1));

    spent.exertion.attacked = true;
    defending.position = "DEF";

    const cases: [CardInstance, string][] = [
      [spent, enemy.id],
      [defending, enemy.id],
      [stuck, enemy.id],
      [zero, enemy.id],
      [sick, enemy.id],
      [sick, "hero-p2"],
    ];
    for (const [attacker, targetId] of cases) {
      const target: AttackTarget = targetId === "hero-p2" ? onHero("p2") : onUnit(enemy);
      const expected = whyCannotAttack(state, attacker, target);
      expect(expected).not.toBeNull();
      expect(attackVia(state, attacker.id, targetId).error).toBe(expected);
    }

    // The Taunt filter, through the same action.
    const other = playing("attack-action-taunt");
    const free = put(other, plain.id, slot("p1", "units", 1));
    const bystander = put(other, plain.id, slot("p2", "units", 1));
    put(other, taunter.id, slot("p2", "units", 2));
    expect(whyCannotAttack(other, free, onUnit(bystander))).toBe("a Taunt unit must be attacked first");
    expect(attackVia(other, free.id, bystander.id).error).toBe("a Taunt unit must be attacked first");

    // A friendly target never reaches the validator: the action layer looks it up among the
    // enemy's units and the enemy hero only.
    expect(attackVia(other, free.id, "hero-p1").error).toBe("no target hero-p1");
    expect(attackVia(other, free.id, free.id).error).toBe(`no target ${free.id}`);
  });

  it("resolves a legal attack and refuses the same attacker twice (§4.2, §4.1)", () => {
    const state = playing("attack-action-legal");
    const attacker = put(state, plain.id, slot("p1", "units", 1));
    const enemy = put(state, plain.id, slot("p2", "units", 1));

    // The hero never strikes back (§4.3), so the attacker is still there for the second attempt.
    const first = attackVia(state, attacker.id, "hero-p2");
    expect(first.error).toBeUndefined();
    expect(eventsOfType(first.events, "attackDeclared")).toHaveLength(1);
    expect(eventsOfType(first.events, "attackDeclared")[0]?.forced).toBe(false);

    const again = attackVia(first.state, attacker.id, enemy.id);
    expect(again.error).toBe("that unit has already acted this turn");
  });

  it("never lists an attack that whyCannotAttack refuses, and lists every one it allows", () => {
    const state = playing("legal-actions-agree");
    const fresh = put(state, plain.id, slot("p1", "units", 1));
    makeSick(state, put(state, rusher.id, slot("p1", "units", 2)));
    put(state, pacifist.id, slot("p1", "units", 3));
    put(state, zeroAttack.id, slot("p1", "units", 4));
    const defending = put(state, plain.id, slot("p1", "units", 5));
    defending.position = "DEF";

    put(state, plain.id, slot("p2", "units", 1));
    put(state, taunter.id, slot("p2", "units", 2));
    const enemyDefending = put(state, plain.id, slot("p2", "units", 3));
    enemyDefending.position = "DEF";

    const listed = legalActions(state, "p1").flatMap((a) => (a.type === "attack" ? [a] : []));
    expect(listed.length).toBeGreaterThan(0);

    for (const action of listed) {
      const target: AttackTarget =
        action.targetId === "hero-p2" ? onHero("p2") : onUnit(instance(state, action.targetId));
      expect(whyCannotAttack(state, instance(state, action.attackerId), target)).toBeNull();
    }

    // The other direction: every pair the validator allows is offered.
    const attackers = [1, 2, 3, 4, 5].flatMap((lane) => {
      const unit = state.players.p1.units[lane - 1]?.[0];
      return unit === undefined ? [] : [unit];
    });
    const targets: AttackTarget[] = [
      ...[1, 2, 3, 4, 5].flatMap((lane) => {
        const unit = state.players.p2.units[lane - 1]?.[0];
        return unit === undefined ? [] : [onUnit(unit)];
      }),
      onHero("p2"),
    ];
    const allowed = attackers.flatMap((attacker) =>
      targets
        .filter((target) => canAttack(state, attacker, target))
        .map((target) => `${attacker.id}->${target.kind === "unit" ? target.instance.id : `hero-${target.player}`}`),
    );
    expect(listed.map((a) => `${a.attackerId}->${a.targetId}`).sort()).toEqual(allowed.sort());

    // Only the Taunt units, and the sick Rush unit is among the attackers offered.
    expect(new Set(listed.map((a) => a.targetId)).size).toBe(2);
    expect(listed.some((a) => a.attackerId === fresh.id)).toBe(true);
  });
});
