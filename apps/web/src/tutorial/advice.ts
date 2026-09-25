// The coach's advice when a lesson has nothing scripted for the moment: the next sensible move,
// read off the human's view and legal actions (SPEC §9.10, R292, R293).
//
// A lesson's scripted steps cover the moments it teaches; between and after them the player still
// has turns to play, and a new player left with a silent coach does nothing, loses, and learns
// nothing. So a lesson's quiet stretches end in `yourMove`, which always names one move: the enemy
// hero when the attacks on offer can finish it this turn; else the dearest legal card, never aimed at
// your own side; else a trade that destroys an enemy unit and leaves yours standing; else the enemy
// hero; else an attack that clears a Taunt out of the way, even at the attacker's cost; else the best
// dent in that Taunt; else End turn. It is advice, never a rule (CLAUDE.md rule 7): every
// move it names is one the engine already offered in `legalActions`, and it reads what the view
// shows of each unit — attack, health, Armor, keywords — the way a player reads the board.

import type { ActionBody, PlayerView, UnitView } from "@jackioh/shared";

import type { CoachAnchor, CoachCtx, CoachStep } from "./coach.ts";
import { heroTargetId, myMain, unitsOf } from "./steps.ts";

export type Attack = Extract<ActionBody, { type: "attack" }>;
export type Play = Extract<ActionBody, { type: "play" }>;

export type Trade = {
  action: Attack;
  attacker: UnitView;
  target: UnitView;
  dealt: number;
  taken: number;
  kills: boolean;
  survives: boolean;
};

export function legalAttacksOf(ctx: CoachCtx): Attack[] {
  return ctx.legal.filter((action): action is Attack => action.type === "attack");
}

export function myUnit(ctx: CoachCtx, instanceId: string): UnitView | undefined {
  return unitsOf(ctx.view, "you").find((unit) => unit.instanceId === instanceId);
}

export function enemyUnit(ctx: CoachCtx, instanceId: string): UnitView | undefined {
  return unitsOf(ctx.view, "opponent").find((unit) => unit.instanceId === instanceId);
}

export function hasKeyword(unit: UnitView, keyword: string): boolean {
  return unit.keywords.some((entry) => entry.kind === keyword);
}

/** One unit's blow on another, as the view shows them: its attack less the target's Armor, none into a shield. */
export function blow(from: UnitView, to: UnitView): number {
  if (hasKeyword(to, "Divine Shield")) return 0;
  return Math.max(0, from.attack - to.armor);
}

/** Every legal attack on an enemy unit, with what the view says it would do. */
export function trades(ctx: CoachCtx): Trade[] {
  const out: Trade[] = [];
  for (const action of legalAttacksOf(ctx)) {
    const attacker = myUnit(ctx, action.attackerId);
    const target = enemyUnit(ctx, action.targetId);
    if (attacker === undefined || target === undefined) continue;
    const dealt = blow(attacker, target);
    const kills = dealt >= target.health;
    const strikesFirst = hasKeyword(attacker, "First Strike") && !hasKeyword(target, "First Strike");
    const taken = kills && strikesFirst ? 0 : blow(target, attacker);
    out.push({ action, attacker, target, dealt, taken, kills, survives: taken < attacker.health });
  }
  return out;
}

const size = (unit: UnitView): number => unit.attack + unit.health;

/** A trade that destroys the enemy unit and leaves the attacker standing: the biggest target, the smallest attacker. */
export function goodTrade(ctx: CoachCtx): Trade | undefined {
  const good = trades(ctx).filter((trade) => trade.kills && trade.survives);
  good.sort((a, b) => size(b.target) - size(a.target) || size(a.attacker) - size(b.attacker));
  return good[0];
}

/** The strongest legal attack on the enemy hero. */
export function heroAttack(ctx: CoachCtx): { action: Attack; attacker: UnitView } | undefined {
  const hero = heroTargetId(ctx.view, "opponent");
  const options = legalAttacksOf(ctx)
    .filter((action) => action.targetId === hero)
    .map((action) => ({ action, attacker: myUnit(ctx, action.attackerId) }))
    .filter((entry): entry is { action: Attack; attacker: UnitView } => entry.attacker !== undefined);
  options.sort((a, b) => b.attacker.attack - a.attacker.attack);
  return options[0];
}

/**
 * When a Taunt keeps the hero out of reach and no attack on it destroys it, the hit that wears it
 * down most while the attacker survives: damage stays, so the next hit finishes it.
 */
export function chip(ctx: CoachCtx): Trade | undefined {
  if (heroAttack(ctx) !== undefined) return undefined;
  const options = trades(ctx).filter((trade) => trade.survives && trade.dealt > 0);
  options.sort((a, b) => b.dealt - a.dealt || a.taken - b.taken);
  return options[0];
}

/** When a Taunt keeps the hero out of reach: an attack that destroys it, even if the attacker falls too. */
export function clearTaunt(ctx: CoachCtx): Trade | undefined {
  if (heroAttack(ctx) !== undefined) return undefined;
  const options = trades(ctx).filter((trade) => trade.kills && hasKeyword(trade.target, "Taunt"));
  options.sort((a, b) => Number(b.survives) - Number(a.survives) || size(a.attacker) - size(b.attacker));
  return options[0];
}

/**
 * The attacks on the enemy hero add up to its health this turn, reading what the view shows (the
 * attackers' attack less the hero's Armor, each hit its own). A plan, not a promise: a trap may
 * still answer (lesson 3 says so), which is the game.
 */
export function lethalOnBoard(ctx: CoachCtx): boolean {
  const hero = heroTargetId(ctx.view, "opponent");
  const armor = ctx.view.opponent.hero.armor;
  const attackers = new Set<string>();
  let damage = 0;
  for (const action of legalAttacksOf(ctx)) {
    if (action.targetId !== hero || attackers.has(action.attackerId)) continue;
    const attacker = myUnit(ctx, action.attackerId);
    if (attacker === undefined) continue;
    attackers.add(action.attackerId);
    damage += Math.max(0, attacker.attack - armor);
  }
  return attackers.size > 0 && damage >= ctx.view.opponent.hero.health;
}

/** A play aimed at one of the human's own cards or at their own hero. */
export function aimsAtOwnSide(ctx: CoachCtx, play: Play): boolean {
  const own = new Set<string>(unitsOf(ctx.view, "you").map((unit) => unit.instanceId));
  for (const card of ctx.view.you.backrow) if (card !== null && !card.faceDown) own.add(card.instanceId);
  return (play.targets ?? []).some(
    (target) =>
      (target.pick === "instance" && own.has(target.instanceId)) ||
      (target.pick === "hero" && target.player === ctx.view.viewer) ||
      (target.pick === "zone" && target.player === ctx.view.viewer && target.row === "backrow"),
  );
}

/** The dearest card the human can play now, aimed away from their own side. */
export function bestPlay(ctx: CoachCtx): Play | undefined {
  const hand = Array.isArray(ctx.view.you.hand) ? ctx.view.you.hand : [];
  const costOf = (instanceId: string): number => hand.find((card) => card.instanceId === instanceId)?.cost ?? 0;
  const plays = ctx.legal.filter((action): action is Play => action.type === "play" && !aimsAtOwnSide(ctx, action));
  plays.sort((a, b) => costOf(b.instanceId) - costOf(a.instanceId));
  return plays[0];
}

/** The move the coach suggests next. */
export type Move =
  | { kind: "play"; action: Play; defId: string }
  | { kind: "trade"; action: Attack; trade: Trade }
  | { kind: "hero"; action: Attack; attacker: UnitView; lethal: boolean }
  | { kind: "clear"; action: Attack; trade: Trade }
  | { kind: "chip"; action: Attack; trade: Trade }
  | { kind: "end"; action: ActionBody };

export function nextMove(ctx: CoachCtx): Move | undefined {
  if (lethalOnBoard(ctx)) {
    const hero = heroAttack(ctx);
    if (hero !== undefined) return { kind: "hero", action: hero.action, attacker: hero.attacker, lethal: true };
  }
  const play = bestPlay(ctx);
  if (play !== undefined) {
    const hand = Array.isArray(ctx.view.you.hand) ? ctx.view.you.hand : [];
    const card = hand.find((candidate) => candidate.instanceId === play.instanceId);
    return { kind: "play", action: play, defId: card?.defId ?? "" };
  }
  const trade = goodTrade(ctx);
  if (trade !== undefined) return { kind: "trade", action: trade.action, trade };
  const hero = heroAttack(ctx);
  if (hero !== undefined) return { kind: "hero", action: hero.action, attacker: hero.attacker, lethal: false };
  const clear = clearTaunt(ctx);
  if (clear !== undefined) return { kind: "clear", action: clear.action, trade: clear };
  const dent = chip(ctx);
  if (dent !== undefined) return { kind: "chip", action: dent.action, trade: dent };
  const end = ctx.legal.find((action) => action.type === "endTurn");
  return end === undefined ? undefined : { kind: "end", action: end };
}

/** Two actions are the same move. */
export function sameMove(a: ActionBody, b: ActionBody | undefined): boolean {
  return b !== undefined && JSON.stringify(a) === JSON.stringify(b);
}

/** A unit's zone as an anchor: a side may hold two units of one card, and the zone names the one meant. */
export function zoneOf(ctx: CoachCtx, side: "you" | "opponent", instanceId: string): CoachAnchor | null {
  const units = side === "you" ? ctx.view.you.units : ctx.view.opponent.units;
  const index = units.findIndex((unit) => unit?.instanceId === instanceId);
  return index < 0 ? null : { kind: "zone", side, row: "units", lane: index + 1 };
}

/** What the coach points at for a move: the card to play, the unit to hit, the hero, or End turn. */
export function moveAnchor(ctx: CoachCtx, move: Move | undefined): CoachAnchor | null {
  if (move === undefined) return null;
  switch (move.kind) {
    case "play":
      return { kind: "handCard", defId: move.defId };
    case "trade":
    case "clear":
    case "chip":
      return zoneOf(ctx, "opponent", move.trade.target.instanceId);
    case "hero":
      return { kind: "hero", side: "opponent" };
    case "end":
      return { kind: "endTurn" };
  }
}

/** A card's name for the coach's words; the definition's id when the page has no catalog. */
export function cardName(ctx: CoachCtx, defId: string): string {
  return ctx.nameOf?.(defId) ?? defId;
}

/** The coach's line for a move, in a beginner's words. */
export function moveText(ctx: CoachCtx, move: Move | undefined): string {
  if (move === undefined) return "Watch the board: nothing to do right now.";
  switch (move.kind) {
    case "play":
      return `Play ${cardName(ctx, move.defId)}: spend your mana every turn you can.`;
    case "trade":
      return `Attack the enemy's ${cardName(ctx, move.trade.target.defId)} with your ${cardName(ctx, move.trade.attacker.defId)}: it destroys that unit and survives.`;
    case "hero":
      return move.lethal
        ? `Your attacks can finish the enemy hero this turn: attack it with your ${cardName(ctx, move.attacker.defId)}.`
        : `Attack the enemy hero with your ${cardName(ctx, move.attacker.defId)}: every point counts.`;
    case "clear":
      return move.trade.survives
        ? `A Taunt unit guards the hero: attack the enemy's ${cardName(ctx, move.trade.target.defId)} with your ${cardName(ctx, move.trade.attacker.defId)} to clear the way.`
        : `A Taunt unit guards the hero: attack the enemy's ${cardName(ctx, move.trade.target.defId)} with your ${cardName(ctx, move.trade.attacker.defId)}. Both fall, but the way is clear.`;
    case "chip":
      return `A Taunt unit guards the hero. Wear it down: attack it with your ${cardName(ctx, move.trade.attacker.defId)}. Damage stays.`;
    case "end":
      return "Nothing useful left this turn: press End turn.";
  }
}

/**
 * "Your move": the coach names the next sensible move (`nextMove`) and points at it, one move at a
 * time. `final` makes it the lesson's last step, done when the game ends; otherwise it covers the
 * rest of the turn it shows on and is done once that turn has passed (or when `until` holds).
 */
export function yourMove(options: {
  id: string;
  title: string;
  final?: boolean;
  when?: (ctx: CoachCtx) => boolean;
  until?: (ctx: CoachCtx, since: PlayerView) => boolean;
}): CoachStep {
  const { id, title, final, when, until } = options;
  return {
    id,
    title,
    kind: "act",
    text: (ctx) => moveText(ctx, nextMove(ctx)),
    anchor: (ctx) => moveAnchor(ctx, nextMove(ctx)),
    when: (ctx) => myMain(ctx) && nextMove(ctx) !== undefined && (when === undefined || when(ctx)),
    done: (ctx, since) => {
      if (until !== undefined && until(ctx, since)) return true;
      return final === true ? ctx.view.result !== null : ctx.view.turn !== since.turn;
    },
    expect: (action, ctx) => sameMove(action, nextMove(ctx)?.action),
    ...(final === true ? { final: true } : { turnBound: true }),
  };
}
