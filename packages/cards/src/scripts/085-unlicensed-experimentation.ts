// #85 Unlicensed Experimentation (SPEC §8.4 row 85): Trap, cost 1, Legendary.
//   Base:    "When the opponent plays a permanent whose type matches one you control: Fuse it onto
//             a random permanent of yours of that type"
//   Radiant: "Onto every such permanent" — the cell restates only which of your permanents receive
//            it, so everything else is the base clause (§8 Conventions), and R77 spells the radiant
//            case out: "fuses the played permanent onto each matching permanent separately, one
//            fusion at a time".
//
// ARMING vs FIRING (R61, and `traps.ts`'s own rule). `traps.ts`: "`run` returning `[]` is a trap
// that fired for nothing — it can never mean 'this event was not mine'", so every condition that
// must leave this trap armed and face-down lives in the `when` predicate, and `run` is reached only
// once the trap really is firing. R61 divides the two precisely:
//   - leaves it ARMED: your own play; a Spell; a token, a Recruit, a copy, a Reborn or a Transform
//     result; a permanent whose type matches nothing you control.
//   - FIRES it: the opponent playing or casting a permanent from hand whose type matches one you
//     control — and then "when no legal target of that type remains, the trap fires, is consumed
//     and does nothing, and the played permanent stays". An Immutable permanent of yours is still
//     "one you control" (so the trap fires) but is never chosen as the Fuse target (R23), which is
//     exactly how that last sentence happens. So `when` counts Immutable permanents and `run`
//     does not.
//
// WHICH EVENT (R17, R61, R70, §10.5). §10.5 step 7's `cardResolved`, not step 4's `cardPlayed`.
// Both name a play — `playSteps.ts` reports a play from hand and `resolve.castCard` a cast, which
// R70 makes a play "for every rule that counts or reacts to plays" — but R17 puts this trap at step
// 7, "after a played permanent's Cry", while step 4 is #41 Sheepish's moment, before it ("Sheepish
// fires on the `summoned`/`cardPlayed` pair emitted at step 4 … Bear Honeypot, Unstable Clone
// Machine and Unlicensed Experimentation fire on the events step 7 emits", `traps.ts`). Watching
// `cardPlayed` would fuse the played permanent away before its own Cry ever ran.
//
// A summon — Recruit, a copy, a token, Reborn, a Transform result — emits `summoned` and never
// either of these, so R61's exclusions are the event's own, with one exception this card has to
// make itself: a TOKEN CARD can be played from a hand (#75's Rush Token card, Combo-Fodder), and
// R61 says tokens never set this off. Hence the token check in `playedPermanent`.
//
// "PLAYED PERMANENTS ONLY" IS `event.permanent` (R61). Step 7 answers the question itself: the flag
// says whether the card is still in play at the moment it resolved, which is exactly what this trap
// needs and what a Spell can never be. It also settles the cases a board re-check would have to
// guess at — a Unit #41 Sheepish has already transformed away, a token that ceased to exist, R138's
// cast permanent that found no zone and went to its graveyard — all report false, so none of them
// arms this trap and nothing here reads a zone.
//
// FUSE, VIA THE EFFECTS BARREL (§6.3 Fuse, R77, R23, R61).
// `fuseCards({ instanceIds, targetInstanceIds, pick })` is the verb. The loop over the targets is
// inside it rather than here, and that is load-bearing: `subsystems/fuse.ts` has an ingredient
// cease to exist the moment a fusion is made (`removeFromAnyZone`, then `{ z: "gone" }`), so after
// the first fusion the played permanent is held by no pile and `findInstance` cannot reach it. An
// ingredient only ever contributes its DEFINITION, which is why the subsystem says a ceased-to-
// exist ingredient still fuses — but only something holding the resolved instance can honour that.
// So this card names its targets once and the verb keeps the ingredient across the fusions.
// The base face's "a random permanent of yours of that type" is `pick: "random"`, drawn with
// `ctx.rng` inside the effect so the draw stays in the reducer (§9.3, §10.7).
// and nothing else about this file changes.
//
// The rest is deliberately NOT here: `fireTrap` emits `trapFired`, runs the state check and
// consumes the trap (a Trap goes to its owner's graveyard, §3.2), and R33 keeps a face-down trap's
// identity in `viewFor`. R13 leaves a card dormant under a Stack off the field, so it is neither a
// match nor a target; `cardAt` reads the acting card per zone, which is that rule.

import type { CardInstance, EffectContext, Script, TrapTrigger } from "@jackioh/engine";
import { cardAt, defOf, findInstance, slotsOf, unitHas } from "@jackioh/engine";
import { fuseCards } from "@jackioh/engine/effects";
import type { CardType, GameEvent } from "@jackioh/shared";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-085");

/** §10.5 step 7's event: a play or a cast that has finished resolving (R17, R70). */
type ResolvedEvent = Extract<GameEvent, { type: "cardResolved" }>;

/** R61 and §5.1: "Field Trap counts as Trap", in both directions, so both read as one key. */
function typeKey(type: CardType): CardType {
  return type === "Field Trap" ? "Trap" : type;
}

/**
 * The permanent this play put on the opponent's field, or null when the event is not one this trap
 * answers: the controller's own play, a Spell or anything else that is no longer in play (R61's
 * `permanent`), a token (R61), or a card the instance table can no longer name.
 */
function playedPermanent(ctx: EffectContext, event: ResolvedEvent): CardInstance | null {
  // §8: "the opponent plays". A trap never answers its own controller's play.
  if (event.player === ctx.controller) return null;
  // R61: "played permanents only". Step 7 read this as it landed, so no board check is needed and
  // a Spell, or a Unit an earlier trap has already taken off the field, is out by the same test.
  if (!event.permanent) return null;

  const card = findInstance(ctx.state, event.instanceId);
  if (card === undefined) return null;

  const played = defOf(ctx.state, card.defId);
  // R61: "tokens … never set it off", including a token card played from a hand.
  if (played.token || played.tags.includes("Token")) return null;
  return card;
}

/**
 * "a permanent of yours of that type" (§8), which R61 narrows twice: the firing trap is "neither
 * matched nor fused onto", and R13 leaves a card dormant under a Stack off the field.
 */
function matchingPermanents(ctx: EffectContext, type: CardType): CardInstance[] {
  const wanted = typeKey(type);
  return (["units", "backrow"] as const).flatMap((row) =>
    slotsOf(ctx.controller, row).flatMap((ref) => {
      const card = cardAt(ctx.state, ref);
      if (card === null || card.id === ctx.self?.id) return [];
      return typeKey(defOf(ctx.state, card.defId).type) === wanted ? [card] : [];
    }),
  );
}

/** `onAll` is the radiant face: R77's "onto each matching permanent separately". */
function experimentation(onAll: boolean): TrapTrigger {
  return {
    id: onAll ? "85r-unlicensed-experimentation" : "85-unlicensed-experimentation",
    on: ["cardResolved"],
    when: (ctx) => {
      const event = ctx.event;
      if (event.type !== "cardResolved") return false;
      const played = playedPermanent(ctx, event);
      if (played === null) return false;
      // §8: "whose type matches one you control". R61 counts an Immutable permanent of yours here,
      // so the trap fires and is consumed even though nothing can be fused onto it.
      return matchingPermanents(ctx, defOf(ctx.state, played.defId).type).length > 0;
    },
    run: (ctx) => {
      const event = ctx.event;
      if (event.type !== "cardResolved") return [];
      const played = playedPermanent(ctx, event);
      if (played === null) return [];

      // R23: "Immutable permanents are never chosen" as the Fuse target.
      const targetIds = matchingPermanents(ctx, defOf(ctx.state, played.defId).type)
        .filter((card) => !unitHas(ctx.state, card, "Immutable"))
        .map((card) => card.id);

      // R61: with no legal target the trap fires, is consumed and does nothing, and the played
      // permanent stays — which is an empty effect list, and `fireTrap` does the rest.
      if (targetIds.length === 0) return [];

      // R77: one fusion per target, each its own transient definition, the played permanent
      // contributing its definition to every one of them. `fuseCards` holds the resolved
      // ingredient across the loop, which is why `targetInstanceIds` is one effect and not one
      // effect per target — after the first fusion the played card is in `{ z: "gone" }` and no id
      // can reach it again. The random pick of the base face is `ctx.rng` INSIDE that effect.
      return [
        fuseCards({
          instanceIds: [played.id],
          targetInstanceIds: targetIds,
          pick: onAll ? "all" : "random",
        }),
      ];
    },
  };
}

export const base: Script = { triggers: [experimentation(false)] };

/** "Onto every such permanent" (R77: one fusion at a time, each target keeping its own instance). */
export const radiant: Script = { triggers: [experimentation(true)] };
