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
// WHICH EVENT (R61, R70, §10.5). `cardPlayed` is the only event that names a play: `reduce.ts`
// emits it for a play from hand and `resolve.castCard` emits it for a cast, which R70 makes a play
// "for every rule that counts or reacts to plays". A summon — Recruit, a copy, a token, Reborn, a
// Transform result — emits `summoned` and never `cardPlayed`, so R61's exclusions are the event's
// own, with one exception this card has to make itself: a TOKEN CARD can be played from a hand
// (#75's Rush Token card, Combo-Fodder), which would emit `cardPlayed`, and R61 says tokens never
// set this off. Hence the token check in `playedPermanent`.
//
// !! ENGINE GAP 1 — TIMING (reported) !!
// R17 and §10.5 put this trap at step 7, "after a played permanent's Cry", while `cardPlayed` is
// emitted at step 4, before the Cry — that is the very timing #41 Sheepish relies on ("Sheepish
// fires on the `summoned`/`cardPlayed` pair emitted at step 4, before the Cry of step 5; Bear
// Honeypot, Unstable Clone Machine and Unlicensed Experimentation fire on the events step 7 emits",
// `traps.ts`). One event cannot be both, and no event in `@jackioh/shared`'s union marks the end of
// a resolution, so the two moments are indistinguishable to a trap today. The engine needs one of:
//   (a) a new event, emitted by §10.5 step 7 for a played or cast permanent, which this card then
//       watches instead of `cardPlayed`:
//           | { type: "cardResolved"; player: PlayerId; instanceId: string; defId: string }
//   (b) or a timing field on the trap trigger, with `traps.ts` filtering matches by it at each of
//       §10.5's two dispatch points:
//           timing?: "onPlay" | "afterResolution"    // default "onPlay" (#41's step 4)
// (a) is the smaller change and is the one §10.5's wording implies. Until then this card watches
// `cardPlayed` and therefore fires one step early: the played permanent's Cry has not run yet.
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

type PlayEvent = Extract<GameEvent, { type: "cardPlayed" }>;

/** §5.1: every type but Spell is a permanent. */
function isPermanent(type: CardType): boolean {
  return type !== "Spell";
}

/** R61 and §5.1: "Field Trap counts as Trap", in both directions, so both read as one key. */
function typeKey(type: CardType): CardType {
  return type === "Field Trap" ? "Trap" : type;
}

/**
 * The permanent this play put on the opponent's field, or null when the event is not one this trap
 * answers: the controller's own play, a Spell, a token (R61), or a card that is no longer there
 * (an earlier trap transformed it, or its own Cry killed it).
 */
function playedPermanent(ctx: EffectContext, event: PlayEvent): CardInstance | null {
  // §8: "the opponent plays". A trap never answers its own controller's play.
  if (event.player === ctx.controller) return null;
  const card = findInstance(ctx.state, event.instanceId);
  if (card === undefined || card.zone.z !== "field") return null;

  const played = defOf(ctx.state, card.defId);
  if (!isPermanent(played.type)) return null;
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
    on: ["cardPlayed"],
    when: (ctx) => {
      const event = ctx.event;
      if (event.type !== "cardPlayed") return false;
      const played = playedPermanent(ctx, event);
      if (played === null) return false;
      // §8: "whose type matches one you control". R61 counts an Immutable permanent of yours here,
      // so the trap fires and is consumed even though nothing can be fused onto it.
      return matchingPermanents(ctx, defOf(ctx.state, played.defId).type).length > 0;
    },
    run: (ctx) => {
      const event = ctx.event;
      if (event.type !== "cardPlayed") return [];
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
