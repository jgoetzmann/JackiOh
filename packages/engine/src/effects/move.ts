// Exile, Bounce, Discard and Counter: the moves that take a card off the field or out of a hand
// (SPEC §6.3, §3.2, §2.4, R11, R12, R16, R78). Every zone change goes through `zones.ts`.
//
// Each verb comes in a single-card form and a sweep — `exile`/`exileAll`/`exileAdjacentTo`,
// `bounce`/`bounceAll`, `discard`/`discardHand`, plus `exileHand` — and the sweeps are walks over
// `cardsInScope` or `adjacentTo` (§3.1, §3.2) down the same private per-card helper the
// single-card form uses. One implementation per move, so "bounce" can only ever mean one thing.

import { addToHand } from "../draw";
import type { Effect, EffectContext } from "../script";
import type { CardInstance } from "../state";
import { isUnitToken, moveToZone } from "../zones";
import {
  adjacentTo,
  cardsInScope,
  instanceOf,
  playerOf,
  type BoardScope,
  type PlayerSpec,
  type TargetSpec,
} from "./targets";

/**
 * One card to the exile pile: the whole of §6.3 Exile for a single card, so `exile`, `exileAll`,
 * `exileAdjacentTo` and `exileHand` are four ways of naming cards over ONE implementation. A card
 * that reaches the pile feeds the game exile counter (R55); a unit token ceases to exist instead
 * and never enters it (R11), so it is not counted, while the event still reports the card leaving.
 */
function exileCard(ctx: EffectContext, card: CardInstance): void {
  if (card.zone.z === "exile") return;

  const moved = moveToZone(ctx.state, card, "exile");
  if (moved === "moved") ctx.state.counters.exiled += 1;
  ctx.events.push({
    type: "exiled",
    instanceId: card.id,
    defId: card.defId,
    owner: card.owner,
  });
}

/**
 * One card back to its owner's hand: the whole of §6.3 Bounce for a single card, shared by
 * `bounce` and `bounceAll`. A unit token vanishes (R11), the hand cap applies so a full hand burns
 * it (§2.4), and the instance resets on the way out (R78).
 */
function bounceCard(ctx: EffectContext, card: CardInstance): void {
  if (card.zone.z === "hand") return;

  const token = isUnitToken(ctx.state, card);
  const event = {
    type: "bounced" as const,
    instanceId: card.id,
    defId: card.defId,
    owner: card.owner,
  };

  if (token) {
    // R11: it ceases to exist, so it never reaches a hand and the hand cap never sees it.
    moveToZone(ctx.state, card, "hand");
    ctx.events.push(event);
    return;
  }

  ctx.events.push(event);
  addToHand(ctx, card);
}

/** §6.3 Exile: to the exile pile from anywhere, with no Death trigger. */
export function exile(args: { target: TargetSpec }): Effect {
  return {
    kind: "exile",
    apply(ctx): void {
      const card = instanceOf(ctx, args.target);
      if (card === null) return;
      exileCard(ctx, card);
    },
  };
}

/**
 * §6.3 Exile over a scope: every card the scope names, in `cardsInScope` order, down the same path
 * a single exile takes (#100 Ceaseless Void, "Cry: exile all other permanents on both sides" —
 * `{ side: "any", rows: ["units", "backrow"], excludeSelf: true }`). `excludeSelf` is what leaves
 * the running card standing; without it the Void would exile itself mid-Cry.
 */
export function exileAll(args: BoardScope = {}): Effect {
  return {
    kind: "exileAll",
    apply(ctx): void {
      for (const card of cardsInScope(ctx, args)) exileCard(ctx, card);
    },
  };
}

/**
 * §3.1 Adjacent exile: lanes N-1 and N+1 on the target's own side and row (#34 Collateral Damage
 * radiant, "also the permanents adjacent to the target in its row"). Adjacency never crosses rows,
 * so "in its row" needs no argument of its own — a backrow target has backrow neighbours and a
 * unit has units. The card pairs this with a plain `exile` on the target itself.
 */
export function exileAdjacentTo(args: { target: TargetSpec } & BoardScope): Effect {
  return {
    kind: "exileAdjacentTo",
    apply(ctx): void {
      const { target, ...scope } = args;
      for (const card of adjacentTo(ctx, target, scope)) exileCard(ctx, card);
    },
  };
}

/** §6.3 Bounce: return the card to its owner's hand (R12). */
export function bounce(args: { target: TargetSpec }): Effect {
  return {
    kind: "bounce",
    apply(ctx): void {
      const card = instanceOf(ctx, args.target);
      if (card === null) return;
      bounceCard(ctx, card);
    },
  };
}

/**
 * §6.3 Bounce over a scope: every card the scope names, in `cardsInScope` order (#17 Flood,
 * "Bounce all units on both sides", which is `{ side: "any" }` — `BoardScope`'s default row is
 * `["units"]`). §3.2 spells out the token case for exactly this card: "Bounce all units" clears
 * unit tokens because they cease to exist rather than reaching a hand (R11).
 */
export function bounceAll(args: BoardScope = {}): Effect {
  return {
    kind: "bounceAll",
    apply(ctx): void {
      for (const card of cardsInScope(ctx, args)) bounceCard(ctx, card);
    },
  };
}

/** Hand to GY for one named card, with the events §10.3 gives a discard. */
function discardCard(ctx: EffectContext, card: CardInstance): void {
  if (card.zone.z !== "hand") return;

  const moved = moveToZone(ctx.state, card, "graveyard");
  ctx.events.push({
    type: "discarded",
    instanceId: card.id,
    defId: card.defId,
    owner: card.owner,
  });
  // R11: a unit-token card leaving a hand ceases to exist and reaches no graveyard.
  if (moved === "moved") {
    ctx.events.push({
      type: "enteredGraveyard",
      instanceId: card.id,
      defId: card.defId,
      owner: card.owner,
    });
  }
}

/**
 * §6.3 Discard of a named card: R16 makes the discard the player's choice, so the choice arrives
 * here as a selection the script already prompted for (`{ of: "chosen" }`).
 */
export function discard(args: { target?: TargetSpec } = {}): Effect {
  return {
    kind: "discard",
    apply(ctx): void {
      const card = instanceOf(ctx, args.target ?? { of: "chosen" });
      if (card === null) return;
      discardCard(ctx, card);
    },
  };
}

/** §6.3 Discard at random (R16: only when the card says "random"), drawn from the match rng. */
export function discardRandom(args: { count?: number; player?: PlayerSpec } = {}): Effect {
  return {
    kind: "discardRandom",
    apply(ctx): void {
      const player = playerOf(ctx, args.player ?? "self");
      const count = Math.max(0, Math.trunc(args.count ?? 1));
      for (let i = 0; i < count; i += 1) {
        const hand = ctx.state.players[player].hand;
        if (hand.length === 0) return;
        const card = ctx.rng.pick(hand);
        if (card === undefined) return;
        discardCard(ctx, card);
      }
    },
  };
}

/**
 * §6.3 Discard of a whole hand: every card in the hand to the graveyard, in hand order (#76 Field
 * of Dreams, "Replace your hand with the same number of Reminisce" — R31 sends the replaced cards
 * to the graveyard, which is how a later Reminisce can find them there).
 *
 * Deterministic, and drawing NOTHING from `ctx.rng`, for two reasons:
 *   - A whole-hand sweep involves no choice at all, so R16's "the player chooses unless random is
 *     stated" does not arise. There is nothing to prompt for: every card goes.
 *   - `discardRandom({ count: hand.length })` would reach the same end state while burning
 *     `hand.length` rng draws. §10.7 makes `rngCursor` part of state, so those draws would advance
 *     it and change every downstream replay hash — a different shuffle, a different Discover, a
 *     different fuzz game — for no reason a rule asks for.
 */
export function discardHand(args: { player?: PlayerSpec } = {}): Effect {
  return {
    kind: "discardHand",
    apply(ctx): void {
      const player = playerOf(ctx, args.player ?? "self");
      // A snapshot: `discardCard` splices the hand, so iterating it live would skip cards.
      for (const card of [...ctx.state.players[player].hand]) discardCard(ctx, card);
    },
  };
}

/**
 * §6.3 Exile of a whole hand: the same sweep, to the exile pile (#78 /fullsend, "at end of turn,
 * exile your hand"). Each card that reaches the pile bumps `counters.exiled` (R55) and emits one
 * `exiled` event; a unit-token card ceases to exist instead of reaching the pile and is not
 * counted (R11, §3.2). No choice and no rng draw, for the reasons on `discardHand`.
 */
export function exileHand(args: { player?: PlayerSpec } = {}): Effect {
  return {
    kind: "exileHand",
    apply(ctx): void {
      const player = playerOf(ctx, args.player ?? "self");
      for (const card of [...ctx.state.players[player].hand]) exileCard(ctx, card);
    },
  };
}

/**
 * §6.3 Counter: cancel a card as it is played. It goes to the graveyard with no Cry and no Death,
 * and is treated as never played, so the play counters this card added are rolled back (R55).
 */
export function counter(args: { target?: TargetSpec } = {}): Effect {
  return {
    kind: "counter",
    apply(ctx): void {
      const card = instanceOf(ctx, args.target ?? { of: "chosen" });
      if (card === null || card.zone.z === "graveyard") return;

      const side = ctx.state.players[card.controller];
      const at = side.turnLog.playedIds.lastIndexOf(card.id);
      if (at >= 0) {
        side.turnLog.playedIds.splice(at, 1);
        side.turnLog.cardsPlayed = Math.max(0, side.turnLog.cardsPlayed - 1);
        ctx.state.counters.played = Math.max(0, ctx.state.counters.played - 1);
      }

      const moved = moveToZone(ctx.state, card, "graveyard");
      if (moved === "moved") {
        ctx.events.push({
          type: "enteredGraveyard",
          instanceId: card.id,
          defId: card.defId,
          owner: card.owner,
        });
      }
    },
  };
}
