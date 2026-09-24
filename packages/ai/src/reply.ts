// The opponent's reply (SPEC §9.9, docs/polish/3-ai.md "The opponent's reply"). A line that passes
// the turn is worth what is left of it after the opponent answers, so `decide` scores its best lines
// one turn deeper: on the determinization, the opponent plays its turn by a fixed rule and ends it,
// and the line is scored at the seat's next decision.
//
// The rule, one step at a time:
//   1. A card the line itself put in the opponent's hand (a Pocket Chaos it was handed, the units a
//      Flood bounced) is no guess: the seat watched it arrive. The opponent plays the one whose
//      result its own evaluation likes best, if that beats standing still.
//   2. Otherwise it is a static trader: of every attack it may declare, it takes the one with the
//      best value read off the layers (lethal, a kill it survives, a trade up, the face).
//   3. When neither is worth doing it ends its turn.
// It plays none of the cards it held unseen, because those are samples: a guessed hand would add
// noise, not information. Every step is a real `reduce` (one node each), so the engine decides what
// actually happens: traps, First Strike, Divine Shield, Taunt, Lifesteal, end-of-turn damage and the
// seat's own start of turn. Nothing here recurses.

import type { Action, ActionBody, PlayerId } from "@jackioh/shared";
import { hasKeyword, opponentOf } from "@jackioh/shared";
import {
  findInstance,
  legalActions,
  reduce,
  subsystems,
  unitView,
  type CardInstance,
  type GameState,
  type UnitView,
} from "@jackioh/engine";
import { AI_EVAL, AI_REPLY } from "./config";
import { evaluate, unitWorth } from "./evaluate";
import { candidateActions } from "./candidates";
import { lineStatus, simulate, staticScore } from "./simulate";
import type { NodeCounter } from "./types";

type Side = {
  view: UnitView;
  shield: boolean;
  indestructible: boolean;
  firstStrike: boolean;
  poisonous: boolean;
};

function sideOf(view: UnitView): Side {
  return {
    view,
    shield: hasKeyword(view.keywords, "Divine Shield"),
    indestructible: hasKeyword(view.keywords, "Indestructible"),
    firstStrike: hasKeyword(view.keywords, "First Strike"),
    poisonous: hasKeyword(view.keywords, "Poisonous"),
  };
}

/** §4.4 steps 1, 2, 4 and 7 for one blow: what `from` deals to `to`, and whether it kills. */
function blow(from: Side, to: Side): { dealt: number; kills: boolean; popsShield: boolean } {
  const amount = from.view.attack;
  if (amount <= 0) return { dealt: 0, kills: false, popsShield: false };
  if (to.shield) return { dealt: 0, kills: false, popsShield: true };
  if (to.indestructible) return { dealt: 0, kills: false, popsShield: false };
  const dealt = Math.max(0, amount - to.view.armor);
  const kills = dealt >= to.view.health || (from.poisonous && dealt > 0);
  return { dealt, kills, popsShield: false };
}

/**
 * The opponent's static value of `attacker` hitting `target` (§4.3): the unit it kills, less its own
 * body when that dies too, with First Strike deciding who strikes first. A hit that kills nothing is
 * worth a little per point dealt, so a second attacker can finish what the first one started.
 */
function tradeValue(state: GameState, attacker: CardInstance, targetId: string): number {
  const target = findInstance(state, targetId);
  if (target === undefined) return Number.NEGATIVE_INFINITY;
  const a = sideOf(unitView(state, attacker));
  const t = sideOf(unitView(state, target));
  const out = blow(a, t);
  const back = blow(t, a);
  let kills = out.kills;
  let dies = back.kills;
  if (a.firstStrike && !t.firstStrike && kills) dies = false;
  if (t.firstStrike && !a.firstStrike && dies) kills = false;

  let value = kills ? unitWorth(state, target) : AI_REPLY.chipPerDamage * Math.min(out.dealt, t.view.health);
  if (out.popsShield) value += AI_EVAL.keyword["Divine Shield"];
  if (dies) value -= unitWorth(state, attacker);
  return value;
}

/** The opponent's attacks worth making, best static value first (ties keep legalActions order). */
function rankedAttacks(state: GameState, seat: PlayerId): ActionBody[] {
  const opp = opponentOf(seat);
  const hero = `hero-${seat}`;
  const health = state.players[seat].hero.health;
  const ranked: { action: ActionBody; value: number }[] = [];
  for (const action of legalActions(state, opp)) {
    if (action.type !== "attack") continue;
    const attacker = findInstance(state, action.attackerId);
    if (attacker === undefined) continue;
    let value: number;
    if (action.targetId === hero) {
      const damage = subsystems.projectedHeroDamage(state, seat, unitView(state, attacker).attack);
      value = damage >= health ? AI_EVAL.win : AI_REPLY.facePerDamage * damage;
    } else {
      value = tradeValue(state, attacker, action.targetId);
    }
    if (value > 0) ranked.push({ action, value });
  }
  return ranked.sort((a, b) => b.value - a.value).map((entry) => entry.action);
}

/** One opponent action through the reducer; null when it throws or is refused. */
function reduceFor(state: GameState, actor: PlayerId, action: ActionBody, counter: NodeCounter): GameState | null {
  try {
    const next = reduce(state, { ...action, playerId: actor, nonce: `reply:${counter.used}` } as Action);
    return next.error === undefined ? next.state : null;
  } catch {
    return null;
  }
}

/**
 * Step 1: the best play of a card the opponent holds that is not in `hidden`, by the opponent's own
 * evaluation, when it beats standing still. `undefined` when no such play is worth making; null
 * when the counter refused a node.
 */
function knownPlay(
  state: GameState,
  seat: PlayerId,
  hidden: ReadonlySet<string>,
  counter: NodeCounter,
): GameState | null | undefined {
  const opp = opponentOf(seat);
  const plays = candidateActions(state, opp)
    .filter((action) => action.type === "play" && !hidden.has(action.instanceId))
    .slice(0, AI_REPLY.knownPlays);
  if (plays.length === 0) return undefined;
  let best: GameState | undefined;
  let bestValue = evaluate(state, opp);
  for (const play of plays) {
    const step = simulate(state, opp, play, counter);
    if (step === null) return null;
    if (!step.ok) continue;
    if (step.state.result !== null && step.state.result.winner === opp) return step.state;
    const value = evaluate(step.state, opp);
    // Strictly greater, so ties keep move order.
    if (value > bestValue) {
      bestValue = value;
      best = step.state;
    }
  }
  return best;
}

/** The ids of the cards the opponent holds unseen: its hand and its library, as sampled. */
export function hiddenCardIds(state: GameState, seat: PlayerId): Set<string> {
  const side = state.players[opponentOf(seat)];
  return new Set([...side.hand, ...side.library].map((card) => card.id));
}

/**
 * The opponent's reply to a line that handed it the turn: from `state` (the opponent's main phase,
 * or a prompt on the way there) it plays by the rule in this file's header and ends its turn.
 * Prompts on either side are answered with their first legal answer. `hidden` holds the ids of the
 * cards the opponent held unseen when the decision began (`hiddenCardIds` of the decision's
 * determinization); any other card in its hand is one it may play. Returns the state at the seat's
 * next main phase or prompt, or where the game ended; null when the counter refused a node.
 */
export function simulateReply(
  state: GameState,
  seat: PlayerId,
  counter: NodeCounter,
  hidden: ReadonlySet<string> = hiddenCardIds(state, seat),
): GameState | null {
  const opp = opponentOf(seat);
  let current = state;
  for (let step = 0; step < AI_REPLY.maxSteps; step += 1) {
    if (current.result !== null) return current;
    const pending = current.pending;
    if (pending !== null) {
      // The seat's own prompt at its next turn start is where its next decision begins.
      if (pending.playerId === seat && current.active === seat) return current;
      const answer = legalActions(current, pending.playerId)[0];
      if (answer === undefined) return current;
      if (!counter.take()) return null;
      const next = reduceFor(current, pending.playerId, answer, counter);
      if (next === null) return current;
      current = next;
      continue;
    }
    if (current.active !== opp) return current;

    const played = knownPlay(current, seat, hidden, counter);
    if (played === null) return null;
    if (played !== undefined) {
      current = played;
      continue;
    }

    const attack = rankedAttacks(current, seat)[0];
    if (!counter.take()) return null;
    const next = reduceFor(current, opp, attack ?? { type: "endTurn" }, counter);
    if (next !== null) {
      current = next;
      continue;
    }
    // A refused attack ends the turn instead; a refused endTurn ends the reply where it stands.
    if (attack === undefined || !counter.take()) return attack === undefined ? current : null;
    const ended = reduceFor(current, opp, { type: "endTurn" }, counter);
    if (ended === null) return current;
    current = ended;
  }
  return current;
}

/**
 * A closed line's value after the opponent's reply: `end` is where the line stopped. A line that
 * handed the opponent the turn is scored at the seat's next decision, where the seat swings first,
 * less the crystals it left unspent; a line that ended the game, or stopped on the seat's own
 * prompt, keeps its static score. `hidden` is as for `simulateReply`. null when the counter ran out.
 */
export function replyScore(
  end: GameState,
  seat: PlayerId,
  rootTurn: number,
  counter: NodeCounter,
  hidden: ReadonlySet<string> = hiddenCardIds(end, seat),
): number | null {
  const status = lineStatus(end, seat, rootTurn);
  if (status === "over" || status === "open") return staticScore(end, seat, rootTurn);
  const unspent = status === "passed" ? (end.players[seat].turnLog.unspentAtEnd ?? 0) : 0;
  const after = simulateReply(end, seat, counter, hidden);
  if (after === null) return null;
  const next = after.active === seat ? "seat" : "enemy";
  return evaluate(after, seat, next) - AI_EVAL.unspentMana * unspent;
}
