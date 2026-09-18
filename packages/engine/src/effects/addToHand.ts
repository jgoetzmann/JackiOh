// Add to hand: creates a card or moves one into a hand; a full hand burns it (§2.4, R4).
//
// §6.3's Add to hand row is one verb with two halves — "Put a card into a hand | Creates **or
// moves** the card" — so there is no separate `moveToHand`. `addToHand({ defId })` creates a fresh
// instance; `addToHand({ instance })` moves a card that already exists (#51 KY's Private Tutor's
// revealed library card, #72 Reminisce's chosen graveyard card). Both routes end in `../draw`'s
// `addToHand`, so §2.4's hand cap and R4's burn apply once, in one place, and R11's unit-token card
// ceases to exist instead of reaching the graveyard.

import { defOf, query, type CatalogQueryArgs } from "../catalog";
import { addToHand as putInHand } from "../draw";
import type { Effect, EffectContext } from "../script";
import { newInstance, type CardInstance } from "../state";
import { instanceOf, playerOf, type PlayerSpec, type TargetSpec } from "./targets";

/**
 * The riders a card reaches a hand with. R65 starts the cost from `costOverride` IN PLACE OF the
 * printed cost, so a discount that must stack with other modifiers is a `costMod`, never a
 * `costOverride` — which is why both exist. #54 Straaza's "they cost 1" replaces the price outright
 * (`costOverride: 1`), while #7 Jewelosco Scarab's and #39 Recycling Initiative's "costs 1 less"
 * must survive alongside the next discount and the embiggen price it did not choose (`costMod: -1`).
 * R78 keeps all three of `costMod`, `costOverride` and `radiant` in every zone.
 */
type HandRiders = {
  player?: PlayerSpec;
  radiant?: boolean;
  costOverride?: number;
  costMod?: number;
};

/** `costMod` ADDS (R65 sums it); `costOverride` and `radiant` replace. */
function applyRiders(card: CardInstance, riders: HandRiders): void {
  if (riders.radiant === true) card.radiant = true;
  if (riders.costOverride !== undefined) card.costOverride = riders.costOverride;
  if (riders.costMod !== undefined) card.costMod += riders.costMod;
}

/**
 * The one creation path: a fresh card of `defId` with these riders, into that player's hand through
 * §2.4's pipeline. `addToHand` and `addRandomFromCatalog` differ only in where the def comes from,
 * so they share this rather than each growing their own cap and burn handling.
 */
function createInHand(ctx: EffectContext, defId: string, riders: HandRiders): void {
  const player = playerOf(ctx, riders.player ?? "self");
  const card = newInstance(ctx.state, defId, player, { z: "hand", player });
  applyRiders(card, riders);
  putInHand(ctx, card);
}

/**
 * §6.3 Add to hand. With `defId`, create a fresh card of that definition, keeping the radiant flag
 * when asked (R57). With `instance`, MOVE the card that `TargetSpec` names — `{ of: "chosen" }` for
 * a card a prompt just picked (#51's revealed library card, #72's graveyard card) — so its identity,
 * its radiant flag and its cost riders travel with it (R78). Nothing happens when the spec names no
 * card or names one that is already in a hand: the effect fizzles and the card still resolves (§6.3).
 *
 * A moved card goes to its OWNER's hand, never `player`'s: §3.2 rules that "off the field a card
 * always goes to its owner's hand, library, graveyard or exile", which is what `../draw`'s pipeline
 * does. `player` therefore names the hand only on the creation path.
 *
 * `bounce` is the neighbouring verb and deliberately not this one: it returns a card from the FIELD
 * and resets the instance (§6.3, R78), which would throw away exactly the riders this verb keeps.
 */
export function addToHand(args: {
  defId?: string;
  instance?: TargetSpec;
  player?: PlayerSpec;
  radiant?: boolean;
  costOverride?: number;
  costMod?: number;
}): Effect {
  return {
    kind: "addToHand",
    apply(ctx): void {
      if (args.instance !== undefined) {
        const card = instanceOf(ctx, args.instance);
        if (card === null || card.zone.z === "hand") return;
        applyRiders(card, args);
        putInHand(ctx, card);
        return;
      }
      if (args.defId === undefined) return;
      createInHand(ctx, args.defId, args);
    },
  };
}

/**
 * §5.1: "a random pool never offers the card that generated it". The same computation as
 * `discoverFromCatalog` in `choose.ts`, and the reason both read it off `ctx.self` rather than
 * trusting the caller: a Spell resolving its own Cry is still findable (§10.5 parks it in
 * `resolving`), so the generating def is known without the card file having to name its own index.
 */
function poolQuery(ctx: EffectContext, args: CatalogQueryArgs = {}): CatalogQueryArgs {
  const self = ctx.self;
  const excludeIndex = self === null ? undefined : defOf(ctx.state, self.defId).index;
  return { ...args, ...(excludeIndex === undefined ? {} : { excludeIndex }) };
}

/**
 * §6.3 Add to hand, N times, from a §10.7 catalog pool: #54 Straaza's "add 2 random Units costing 3
 * or 4", #57 Conjure KY's "add 3 random KY cards", #59 Unbiased Immigration's "add a random card".
 * It is an add-to-hand, not a Discover, so it shares `createInHand` with `addToHand` above and the
 * hand cap burns the overflow (§2.4, R4).
 *
 * REPEATS ARE ALLOWED, which is why this draws `count` times with `ctx.rng.pick` over the pool
 * instead of shuffling and slicing: R60 rules that "cards generated from the catalog may repeat
 * unless the card says 'different'", and #57's engine cell says "repeats allowed" outright.
 * `discoverFromCatalog` deliberately does the opposite — §6.3's Discover row draws its options
 * "without replacement", so it shuffles and slices and its three options are always different.
 *
 * An empty pool fizzles and the card still resolves (§6.3).
 */
export function addRandomFromCatalog(args: {
  query?: CatalogQueryArgs;
  count?: number;
  player?: PlayerSpec;
  radiant?: boolean;
  costOverride?: number;
  costMod?: number;
}): Effect {
  return {
    kind: "addRandomFromCatalog",
    apply(ctx): void {
      const pool = query(poolQuery(ctx, args.query));
      if (pool.length === 0) return;

      const count = Math.max(0, Math.trunc(args.count ?? 1));
      for (let i = 0; i < count; i += 1) {
        const def = ctx.rng.pick(pool);
        if (def === undefined) return;
        createInHand(ctx, def.id, args);
      }
    },
  };
}

/** Move a random card from your graveyard to your hand (#37 Gravedigger). */
export function addRandomFromGraveyard(args: { player?: PlayerSpec } = {}): Effect {
  return {
    kind: "addRandomFromGraveyard",
    apply(ctx): void {
      const player = playerOf(ctx, args.player ?? "self");
      const graveyard = ctx.state.players[player].graveyard;
      if (graveyard.length === 0) return;
      const card = ctx.rng.pick(graveyard);
      if (card === undefined) return;
      putInHand(ctx, card);
    },
  };
}
