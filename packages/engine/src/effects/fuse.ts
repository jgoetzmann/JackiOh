// Fuse as a verb (SPEC §6.3 Fuse, R77, R102; §8.4 #85, §8.5 #99).
//
// `subsystems/fuse.ts` is R77 in full — the transient definition with both faces fused, the summed
// stats, the united keywords and tags, the concatenated scripts, `min(sum, FUSE_COST_CAP)`, the
// target instance kept with its zone, damage, exertion, counters and memory, the other ingredients
// ceasing to exist with no death, and Craft a Card's fresh `costOverride` 0 hand card. NONE of that
// is repeated here and none of it may be: it is eighteen kilobytes of rules with its own test file,
// and a second implementation is a second set of rules. This file exists only because `fuse` takes
// an `EngineSink` and mutates state, which a card script may not do (CLAUDE.md rule 5), and because
// `FuseArgs.ingredients` is `readonly CardInstance[]` while a Discover hands over catalog ids.
//
// AN INGREDIENT THAT WAS NEVER A CARD (§8.5 #99). Craft a Card's ingredients are Discovered
// DEFINITIONS: nobody ever saw them on a board, and R77 has them cease to exist the moment the
// fusion is made. An ingredient only ever contributes its definition to the fusion, so the
// cheapest faithful thing is an instance that sits in no pile at all: `{ z: "gone" }`, which
// `@jackioh/shared`'s `Zone` really does offer and which `subsystems/fuse.ts` itself uses for
// "ceased to exist" (R11, R86). No zone event fires for it, `findInstance` cannot reach it, and
// nothing in `viewFor` lists it, so the ingredient is invisible exactly as #99 requires.
//
// The `fused` event, `state.transientDefs` and the script registration are all the subsystem's and
// are deliberately untouched here.

import { fuse } from "../subsystems/fuse";
import type { Effect, EffectContext } from "../script";
import { findInstance, newInstance, type CardInstance } from "../state";
import { playerOf, type PlayerSpec } from "./targets";

/**
 * R77 and R86: an ingredient that is only a definition. It is created in `{ z: "gone" }` — in no
 * pile, so no zone event fires, nothing can target it and nothing can bring it back — which is the
 * same zone the subsystem moves a consumed ingredient to.
 */
function phantomIngredient(ctx: EffectContext, defId: string, owner: PlayerSpec | undefined): CardInstance {
  const player = owner === undefined ? ctx.controller : playerOf(ctx, owner);
  return newInstance(ctx.state, defId, player, { z: "gone", player });
}

/**
 * §6.3 Fuse per R77, wrapped. The ingredients are named in two ways, in this order: cards that
 * already exist (`instanceIds`, #85 Unlicensed Experimentation's played permanent) and then
 * definitions that never were cards (`defIds`, #99 Craft a Card's Discover picks). No Core card
 * passes both, so the order between the two groups is a convention rather than a rule; within a
 * group the caller's order is kept, because it is the order the fused name, text and scripts are
 * concatenated in.
 *
 * ONE FUSION AT A TIME, AND WHY THE LOOP IS IN HERE (R77, §8.4 #85 radiant). Radiant #85 fuses its
 * played permanent "onto each matching permanent separately", each fusion its own transient
 * definition. That CANNOT be a card emitting one `fuseCards` per target: the subsystem's
 * `ceaseToExist` calls `removeFromAnyZone`, so after the first fusion the played card is in
 * `{ z: "gone" }` and held by no pile — `findInstance` cannot reach it and its id cannot recover
 * it, so every later call would see one ingredient, fall below `FUSE_MIN_INGREDIENTS` and answer
 * `null`. The subsystem anticipates exactly this ("an ingredient that already ceased to exist in an
 * earlier fusion still fuses", because an ingredient only ever contributes its DEFINITION), and the
 * way to honour it is to resolve the ingredients ONCE and reuse those same objects across the
 * fusions — which only something holding them can do. Hence `targetInstanceIds` and the loop here.
 *
 * R86 is about POOLS, not about this: it drops ids whose cards are gone when the card said "a
 * random card you played this turn", so a pool degrades instead of fizzling at random. An
 * `instanceIds` entry is an instruction the caller named outright, so it is resolved once and then
 * kept — dropping it mid-loop would turn a deliberate second fusion into a silent no-op.
 *
 * It fizzles silently and the card still resolves (§6.3): an `instanceIds` entry that never
 * resolved at all drops out, an empty target list after filtering fuses nothing, and the subsystem
 * itself answers `null` — changing nothing — for fewer than `FUSE_MIN_INGREDIENTS`, for a target
 * that is off the field or Immutable (R23), and for a call that names neither a target nor a hand.
 */
export function fuseCards(args: {
  /** Ingredients that are definitions only: #99's Discover picks. */
  defIds?: readonly string[];
  /** Ingredients that already exist as cards: #85's played permanent. */
  instanceIds?: readonly string[];
  /** R77's kept instance: the on-field ingredient the result becomes. #99 never passes one. */
  targetInstanceId?: string;
  /**
   * Several kept instances, one fusion each in the order given (#85 radiant's "onto every such
   * permanent"). `targetInstanceId` is the one-target spelling of the same thing.
   */
  targetInstanceIds?: readonly string[];
  /**
   * #85 base is "a random permanent of yours of that type", so the draw is one `ctx.rng.pick` over
   * the candidates INSIDE apply — never at construction time, or the draw escapes the reducer
   * (§9.3, §10.7). Default "all", which is also the only behaviour a single target can have.
   */
  pick?: "random" | "all";
  /** R77's Craft a Card path: whose hand the fresh `costOverride` 0 result goes to. */
  toHand?: PlayerSpec;
}): Effect {
  return {
    kind: "fuseCards",
    apply(ctx): void {
      // Resolved ONCE, before any fusion: these objects are reused for every fusion below, so an
      // ingredient the first fusion consumed still contributes its definition to the second.
      const ingredients: CardInstance[] = [];
      for (const instanceId of args.instanceIds ?? []) {
        const found = findInstance(ctx.state, instanceId);
        if (found !== undefined) ingredients.push(found);
      }
      for (const defId of args.defIds ?? []) {
        ingredients.push(phantomIngredient(ctx, defId, args.toHand));
      }

      const targetIds =
        args.targetInstanceIds ??
        (args.targetInstanceId === undefined ? [] : [args.targetInstanceId]);
      const targets: CardInstance[] = [];
      for (const instanceId of targetIds) {
        const found = findInstance(ctx.state, instanceId);
        if (found !== undefined) targets.push(found);
      }

      const toHand = args.toHand === undefined ? {} : { toHand: playerOf(ctx, args.toHand) };

      // #99's path: no kept instance at all, so one fusion into a hand.
      if (targetIds.length === 0) {
        // `EffectContext` satisfies `EngineSink`, so the subsystem takes the context as it stands.
        fuse(ctx, { ingredients, ...toHand });
        return;
      }

      // Nothing left to fuse onto: the trap fired and did nothing (R61), taking no rng draw.
      if (targets.length === 0) return;

      const chosen =
        args.pick === "random" ? [ctx.rng.pick(targets)].flatMap((card) => card ?? []) : targets;

      // R77: each target is its own fusion, in order, each with its own transient definition.
      for (const target of chosen) {
        fuse(ctx, { ingredients, target, ...toHand });
      }
    },
  };
}
