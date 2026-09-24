// The moves the search considers, in the order it considers them. `legalActions` is the only source
// (so the AI can never offer what the reducer refuses), minus R84's skipped actions (R188: the AI
// never concedes, offers or accepts a draw) and minus the mulligan, which `decide` answers itself.

import type { ActionBody, PlayerId } from "@jackioh/shared";
import { hasKeyword, opponentOf } from "@jackioh/shared";
import {
  effectiveCost,
  findInstance,
  legalActions,
  subsystems,
  unitView,
  type CardInstance,
  type GameState,
} from "@jackioh/engine";
import { AI_SEARCH } from "./config";

/** Sorts an object's keys for JSON.stringify; arrays and scalars pass through. */
function sortedKeys(_key: string, value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return Object.fromEntries(entries);
}

/** Canonical JSON of an action body (keys sorted), for equality across determinizations. */
export function actionKey(action: ActionBody): string {
  return JSON.stringify(action, sortedKeys);
}

type Play = Extract<ActionBody, { type: "play" }>;

/** The play with its lane blanked: two plays with the same key differ only in where they land. */
function zoneGroupKey(play: Play): string {
  if (play.zone === undefined) return actionKey(play);
  return actionKey({ ...play, zone: { row: play.zone.row, lane: -1 } });
}

/**
 * AI_SEARCH.zoneVariants: per otherwise-identical play, keep the lowest and the highest lane (or only
 * the lowest when one variant is asked for). Everything else keeps legalActions order.
 */
function collapseZones(actions: readonly ActionBody[]): ActionBody[] {
  const lanes = new Map<string, number[]>();
  for (const action of actions) {
    if (action.type !== "play" || action.zone === undefined) continue;
    const key = zoneGroupKey(action);
    const list = lanes.get(key) ?? [];
    list.push(action.zone.lane);
    lanes.set(key, list);
  }
  return actions.filter((action) => {
    if (action.type !== "play" || action.zone === undefined) return true;
    const list = lanes.get(zoneGroupKey(action)) ?? [];
    const low = Math.min(...list);
    const high = Math.max(...list);
    if (action.zone.lane === low) return true;
    return AI_SEARCH.zoneVariants >= 2 && action.zone.lane === high;
  });
}

/**
 * Tier 1: an attack on a unit it kills and survives, read from the layers. Divine Shield or
 * Indestructible on the target means no kill.
 */
function killsAndSurvives(state: GameState, attacker: CardInstance, target: CardInstance): boolean {
  const a = unitView(state, attacker);
  const t = unitView(state, target);
  if (hasKeyword(t.keywords, "Divine Shield") || hasKeyword(t.keywords, "Indestructible")) return false;
  const dealt = Math.max(0, a.attack - t.armor);
  if (dealt <= 0) return false;
  const kills = dealt >= t.health || hasKeyword(a.keywords, "Poisonous");
  if (!kills) return false;
  if (hasKeyword(a.keywords, "First Strike") && !hasKeyword(t.keywords, "First Strike")) return true;
  if (hasKeyword(a.keywords, "Divine Shield") || hasKeyword(a.keywords, "Indestructible")) return true;
  const taken = Math.max(0, t.attack - a.armor);
  if (taken <= 0) return true;
  if (hasKeyword(t.keywords, "Poisonous")) return false;
  return taken < a.health;
}

function attackTier(state: GameState, seat: PlayerId, action: Extract<ActionBody, { type: "attack" }>): number {
  if (action.targetId === `hero-${opponentOf(seat)}`) return 0;
  const attacker = findInstance(state, action.attackerId);
  const target = findInstance(state, action.targetId);
  if (attacker !== undefined && target !== undefined && killsAndSurvives(state, attacker, target)) return 1;
  return 4;
}

/** What a play or a power costs right now, for tier 2's ordering. */
function sourceCost(state: GameState, action: ActionBody): number {
  if (action.type !== "play" && action.type !== "activatePower") return 0;
  const card = findInstance(state, action.instanceId);
  if (card === undefined) return 0;
  return action.type === "play" ? effectiveCost(state, card) : subsystems.powerCostOf(card);
}

/**
 * Tier 2: round-robin across source instances — every source's first variant, then every source's
 * second, … — each round by current cost, highest first (ties keep legalActions order).
 */
function roundRobin(state: GameState, actions: readonly ActionBody[]): ActionBody[] {
  const sources: { id: string; cost: number; variants: ActionBody[] }[] = [];
  const byId = new Map<string, { id: string; cost: number; variants: ActionBody[] }>();
  for (const action of actions) {
    if (action.type !== "play" && action.type !== "activatePower") continue;
    let source = byId.get(action.instanceId);
    if (source === undefined) {
      source = { id: action.instanceId, cost: sourceCost(state, action), variants: [] };
      byId.set(action.instanceId, source);
      sources.push(source);
    }
    source.variants.push(action);
  }
  const ordered = sources
    .map((source, index) => ({ source, index }))
    .sort((a, b) => b.source.cost - a.source.cost || a.index - b.index)
    .map((entry) => entry.source);
  const rounds = ordered.reduce((max, source) => Math.max(max, source.variants.length), 0);
  const out: ActionBody[] = [];
  for (let round = 0; round < rounds; round += 1) {
    for (const source of ordered) {
      const variant = source.variants[round];
      if (variant !== undefined) out.push(variant);
    }
  }
  return out;
}

/**
 * legalActions(state, seat) minus AI_SKIPPED_ACTIONS (R84's concede/offerDraw/answerDraw) and minus
 * `mulligan`, with `play` zone variants collapsed (per otherwise-identical play keep the lowest and
 * the highest `zone.lane`, AI_SEARCH.zoneVariants), in move order. endTurn, when legal, is last.
 */
export function candidateActions(state: GameState, seat: PlayerId): ActionBody[] {
  const skipped = subsystems.AI_SKIPPED_ACTIONS;
  const legal = legalActions(state, seat).filter(
    (action) => !skipped.includes(action.type) && action.type !== "mulligan",
  );
  const actions = collapseZones(legal);

  const heroAttacks: ActionBody[] = [];
  const goodTrades: ActionBody[] = [];
  const plays: ActionBody[] = [];
  const answers: ActionBody[] = [];
  const otherAttacks: ActionBody[] = [];
  const switches: ActionBody[] = [];
  const ends: ActionBody[] = [];

  for (const action of actions) {
    switch (action.type) {
      case "attack": {
        const tier = attackTier(state, seat, action);
        if (tier === 0) heroAttacks.push(action);
        else if (tier === 1) goodTrades.push(action);
        else otherAttacks.push(action);
        break;
      }
      case "play":
      case "activatePower":
        plays.push(action);
        break;
      case "answer":
        answers.push(action);
        break;
      case "endTurn":
        ends.push(action);
        break;
      default:
        switches.push(action);
        break;
    }
  }

  return [
    ...heroAttacks,
    ...goodTrades,
    ...roundRobin(state, plays),
    ...answers,
    ...otherAttacks,
    ...switches,
    ...ends,
  ];
}
