// The vocabulary lesson scripts are written in: reads of the human's view, and step factories for
// the things a coach asks for over and over (play this card, attack with that unit, end the turn,
// keep your hand).
//
// Every read here is a read of the `PlayerView` or of `legalActions`, never of the rules
// (CLAUDE.md rule 7): "can Mr. Vanilla attack the hero?" is answered by looking for that attack
// among the legal actions the engine handed the page, never by checking summoning sickness here.

import type { ActionBody, CardView, GameEvent, PlayerView, UnitView } from "@jackioh/shared";

import { sideView, type Side } from "../game/contract.ts";
import type { CoachAnchor, CoachCtx, CoachStep, CoachTip } from "./coach.ts";

// ---------------------------------------------------------------------------------------------
// reads of the view
// ---------------------------------------------------------------------------------------------

/** It is the human's turn. */
export function isMyTurn(view: PlayerView): boolean {
  return view.active === view.viewer;
}

/**
 * The human may act freely: their own main phase, no prompt open, the game not over, and the AI
 * owes nothing (a trap of the AI's resolving mid-turn owes the AI an answer first).
 */
export function myMain(ctx: CoachCtx): boolean {
  const { view } = ctx;
  return view.result === null && isMyTurn(view) && view.phase === "main" && view.pending === null && !ctx.aiToAct;
}

/** The AI's own turn, while the game is on. */
export function aiTurn(view: PlayerView): boolean {
  return view.result === null && !isMyTurn(view) && view.phase !== "mulligan" && view.phase !== "setup";
}

/**
 * A mulligan prompt is open for the human (§2.1 step 3). The one place the tutorial asks, so a
 * change to how the mulligan is offered is one change here.
 */
export function mulliganOpen(view: PlayerView): boolean {
  return view.pending !== null && view.pending.forYou && view.pending.kind === "mulligan";
}

/** A prompt of this kind (any kind when omitted) is open for the human. */
export function promptOpen(view: PlayerView, kind?: string): boolean {
  return view.pending !== null && view.pending.forYou && (kind === undefined || view.pending.kind === kind);
}

export function myHand(view: PlayerView): CardView[] {
  return Array.isArray(view.you.hand) ? view.you.hand : [];
}

export function inHand(view: PlayerView, defId: string): CardView | undefined {
  return myHand(view).find((card) => card.defId === defId);
}

export function unitsOf(view: PlayerView, side: Side): UnitView[] {
  return sideView(view, side).units.filter((unit): unit is UnitView => unit !== null);
}

/** The unit of this definition on that side of the field (a deck holds each card once, §2.6). */
export function unitOf(view: PlayerView, side: Side, defId: string): UnitView | undefined {
  return unitsOf(view, side).find((unit) => unit.defId === defId);
}

/** The human's own turn number: 1 on their first turn, 2 on their second, and so on. */
export function myTurnNumber(view: PlayerView): number {
  // p1 takes the odd player-turns and p2 the even ones (§2.1 step 5, §2.5's count).
  return view.viewer === "p1" ? Math.ceil(view.turn / 2) : Math.floor(view.turn / 2);
}

/** The attack `targetId` that names a hero (the engine's own spelling, reduce.ts). */
export function heroTargetId(view: PlayerView, side: Side): string {
  return `hero-${sideView(view, side).player}`;
}

/** The events on this view of one type. */
export function freshOf<T extends GameEvent["type"]>(ctx: CoachCtx, type: T): Extract<GameEvent, { type: T }>[] {
  return ctx.fresh.filter((event): event is Extract<GameEvent, { type: T }> => event.type === type);
}

// ---------------------------------------------------------------------------------------------
// reads of legalActions
// ---------------------------------------------------------------------------------------------

/** The human's legal plays of the hand card of this definition. */
export function legalPlays(ctx: CoachCtx, defId: string): Extract<ActionBody, { type: "play" }>[] {
  const card = inHand(ctx.view, defId);
  if (card === undefined) return [];
  return ctx.legal.filter(
    (action): action is Extract<ActionBody, { type: "play" }> => action.type === "play" && action.instanceId === card.instanceId,
  );
}

/** The human's legal attacks by the unit of this definition, at `target` when given. */
export function legalAttacks(
  ctx: CoachCtx,
  attacker: string,
  target?: AttackTarget,
): Extract<ActionBody, { type: "attack" }>[] {
  const unit = unitOf(ctx.view, "you", attacker);
  if (unit === undefined) return [];
  const targetId = target === undefined ? undefined : attackTargetId(ctx.view, target);
  return ctx.legal.filter(
    (action): action is Extract<ActionBody, { type: "attack" }> =>
      action.type === "attack" &&
      action.attackerId === unit.instanceId &&
      (targetId === undefined || action.targetId === targetId),
  );
}

/** What a coach may ask a unit to attack: the enemy hero, or the enemy unit of a definition. */
export type AttackTarget = "hero" | { defId: string };

export function attackTargetId(view: PlayerView, target: AttackTarget): string | undefined {
  if (target === "hero") return heroTargetId(view, "opponent");
  return unitOf(view, "opponent", target.defId)?.instanceId;
}

// ---------------------------------------------------------------------------------------------
// step factories
// ---------------------------------------------------------------------------------------------

type StepText = CoachStep["text"];

type Common = {
  id: string;
  title: string;
  text: StepText;
  /** Extra condition on top of the factory's own `when`. */
  when?: (ctx: CoachCtx) => boolean;
  anchor?: CoachStep["anchor"];
  holdAi?: boolean;
};

/** An `info` step: "Got it" moves on. */
export function info(options: Common & { done?: CoachStep["done"]; moot?: CoachStep["moot"]; final?: boolean }): CoachStep {
  return { kind: "info", ...options };
}

/** A reactive tip: shown once, the first time `when` holds. */
export function tip(options: CoachTip): CoachTip {
  return options;
}

/**
 * "Play this card." Shows on the human's main phase while the card is in hand and the engine
 * offers a play of it (so it waits for the mana); done once the card has left the hand; moot if it
 * is gone before the step ever showed. `lane` narrows what the tests play (a 1-based lane).
 */
export function playCard(options: Common & { defId: string; lane?: number }): CoachStep {
  const { defId, lane, when, ...rest } = options;
  return {
    kind: "act",
    anchor: { kind: "handCard", defId },
    ...rest,
    when: (ctx) => myMain(ctx) && legalPlays(ctx, defId).length > 0 && (when === undefined || when(ctx)),
    done: (ctx) => inHand(ctx.view, defId) === undefined,
    moot: (ctx, since) => since === null && inHand(ctx.view, defId) === undefined,
    expect: (action, ctx) => {
      const card = inHand(ctx.view, defId);
      if (card === undefined || action.type !== "play" || action.instanceId !== card.instanceId) return false;
      return lane === undefined || action.zone?.lane === lane;
    },
  };
}

/**
 * "Attack with this unit." Shows on the human's main phase while the engine offers that attack
 * (so it waits out summoning sickness and Taunt); done once the unit has declared an attack or has
 * left the field; moot if the turn it showed on ends without one, or if the unit is nowhere.
 */
export function attackWith(options: Common & { attacker: string; target?: AttackTarget }): CoachStep {
  const { attacker, target, when, ...rest } = options;
  const defaultAnchor = (): CoachAnchor | null => {
    if (target === undefined) return { kind: "unit", side: "you", defId: attacker };
    return target === "hero" ? { kind: "hero", side: "opponent" } : { kind: "unit", side: "opponent", defId: target.defId };
  };
  return {
    kind: "act",
    anchor: defaultAnchor,
    ...rest,
    when: (ctx) => myMain(ctx) && legalAttacks(ctx, attacker, target).length > 0 && (when === undefined || when(ctx)),
    done: (ctx) => {
      const unit = unitOf(ctx.view, "you", attacker);
      if (unit === undefined) return true;
      return freshOf(ctx, "attackDeclared").some((event) => event.attackerId === unit.instanceId && !event.forced);
    },
    moot: (ctx, since) => {
      if (since !== null) return ctx.view.turn !== since.turn;
      return unitOf(ctx.view, "you", attacker) === undefined && inHand(ctx.view, attacker) === undefined;
    },
    expect: (action, ctx) =>
      action.type === "attack" && legalAttacks(ctx, attacker, target).some((legal) => legal.targetId === action.targetId && legal.attackerId === action.attackerId),
  };
}

/** "End your turn." Shows on the human's main phase; done once the turn has passed. */
export function endTurn(options: Common): CoachStep {
  const { when, ...rest } = options;
  return {
    kind: "act",
    anchor: { kind: "endTurn" },
    ...rest,
    when: (ctx) => myMain(ctx) && (when === undefined || when(ctx)),
    done: (ctx, since) => ctx.view.turn !== since.turn,
    expect: (action) => action.type === "endTurn",
  };
}

/** "Keep your hand": the mulligan kept whole. Done once the mulligan is answered. */
export function keepHand(options: Common): CoachStep {
  const { when, ...rest } = options;
  return {
    kind: "act",
    anchor: { kind: "prompt" },
    ...rest,
    when: (ctx) => mulliganOpen(ctx.view) && (when === undefined || when(ctx)),
    done: (ctx, since) => since !== ctx.view && !mulliganOpen(ctx.view),
    moot: (ctx, since) => since === null && ctx.view.phase !== "mulligan" && ctx.view.phase !== "setup",
    expect: (action, ctx) => {
      const pending = ctx.view.pending;
      if (action.type !== "mulligan" || pending === null || !pending.forYou) return false;
      return action.keep.length === pending.options.length;
    },
  };
}

/**
 * "Send these cards back": the mulligan with the named cards returned and the rest kept. Done
 * once the mulligan is answered, whatever the player chose.
 */
export function mulliganAway(options: Common & { defIds: readonly string[] }): CoachStep {
  const { defIds, when, ...rest } = options;
  return {
    kind: "act",
    anchor: { kind: "prompt" },
    ...rest,
    when: (ctx) => mulliganOpen(ctx.view) && (when === undefined || when(ctx)),
    done: (ctx, since) => since !== ctx.view && !mulliganOpen(ctx.view),
    moot: (ctx, since) => since === null && ctx.view.phase !== "mulligan" && ctx.view.phase !== "setup",
    expect: (action, ctx) => {
      const pending = ctx.view.pending;
      if (action.type !== "mulligan" || pending === null || !pending.forYou) return false;
      const returned = new Set(pending.options.filter((option) => defIds.includes(option.defId ?? "")).map((option) => option.key));
      const kept = pending.options.map((option) => option.key).filter((key) => !returned.has(key));
      return action.keep.length === kept.length && kept.every((key) => action.keep.includes(key));
    },
  };
}

/** "Switch this unit's position." Done once it has switched (or left the field). */
export function switchPosition(options: Common & { defId: string; to: "ATK" | "DEF" }): CoachStep {
  const { defId, to, when, ...rest } = options;
  const legalSwitch = (ctx: CoachCtx): boolean => {
    const unit = unitOf(ctx.view, "you", defId);
    return unit !== undefined && unit.position !== to && ctx.legal.some((action) => action.type === "switchPosition" && action.instanceId === unit.instanceId);
  };
  return {
    kind: "act",
    anchor: { kind: "unit", side: "you", defId },
    ...rest,
    when: (ctx) => myMain(ctx) && legalSwitch(ctx) && (when === undefined || when(ctx)),
    done: (ctx) => {
      const unit = unitOf(ctx.view, "you", defId);
      return unit === undefined || unit.position === to;
    },
    moot: (ctx, since) => since !== null && ctx.view.turn !== since.turn,
    expect: (action, ctx) => {
      const unit = unitOf(ctx.view, "you", defId);
      return unit !== undefined && action.type === "switchPosition" && action.instanceId === unit.instanceId;
    },
  };
}
