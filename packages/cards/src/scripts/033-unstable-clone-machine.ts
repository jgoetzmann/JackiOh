// #33 Unstable Clone Machine (SPEC §8.2 row 33): Field Spell, "After you play a card, shuffle 3
// copies of it into your library", radiant "One of the 3 is Radiant".
//
// The radiant cell restates only which copies are Radiant, so it is 2 copies carrying the played
// card's own flag plus 1 forced-Radiant copy — not 3 radiant copies (§8 Conventions).
//
// Rulings:
//   R34  token cards are copied too, spell tokens and unit-token cards alike, so there is no token
//        filter here. R11 lets a unit-token card sit in a library, which is where these go.
//   R57  a copy shuffled into a library is a fresh instance carrying only the radiant flag and
//        `statsOverride`. `shuffleInto` makes fresh instances and carries the flag; it cannot carry
//        `statsOverride` — see the ENGINE GAP note below.
//   R80  a library holds at most `LIBRARY_CAP` (60) cards and a copy that would overflow it is
//        never created. `shuffleIntoLibrary` (engine/src/draw.ts) already drops it, so a 60-card
//        library simply gains nothing and this file needs no cap check.
//   R70  a cast is a play and runs the same §10.5 steps, so Hinder and Call to Chaos casts reach
//        step 7 and are copied like any other play with no extra case here.
//   R17  "Unstable Clone Machine … fire[s] after the card resolves" (§10.5 step 7), so this answers
//        `cardResolved`, never step 4's `cardPlayed`: watching the play put the copies into the
//        library before the played card's own text ran, and a Stockpile could draw its own copies.
//        The event carries the face that resolved (`radiant`), because by step 7 the card may have
//        ceased to exist — #41 Sheepish transforms a played Unit at step 4 — and "copies of it" are
//        still copies of the Radiant card that was played (R34, R57).
//
// ENGINE GAP (reported): `shuffleInto({ defId, count, player, radiant })` has no `statsOverride`
// argument, so a played card whose stats were overridden (a Fused or Crafted body, #22's meal)
// copies at its printed stats instead of its overridden ones, which R57 says it should keep.
//
// R119: a permanent is on the field long before its own `cardResolved` event is emitted (the play
// places it at step 4), so the Clone Machine would otherwise answer its own play and shuffle 3
// copies of itself. A card that reacts to "a card played" starts counting from the next play.

import type { Effect, EffectContext, Script, TriggerDef } from "@jackioh/engine";
import { findInstance } from "@jackioh/engine";
import { shuffleInto } from "@jackioh/engine/effects";
import type { GameEvent } from "@jackioh/shared";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-033");

type ResolvedEvent = Extract<GameEvent, { type: "cardResolved" }>;

/**
 * The face the played card resolved with. The event says so (R34, R57); a card still somewhere the
 * instance table can reach is read as a fallback for an event that does not.
 */
function playedRadiantFlag(ctx: EffectContext, event: ResolvedEvent): boolean {
  return event.radiant ?? findInstance(ctx.state, event.instanceId)?.radiant ?? false;
}

/**
 * Whether this play is one of the copier's: "you play a card" is the controller's own plays, and
 * R33 lets a stolen Field Spell read "you" as its new controller, which is `ctx.controller`.
 * Proposed R82 excludes the play that put this Clone Machine onto the field.
 */
function answers(ctx: EffectContext, event: ResolvedEvent): boolean {
  const self = ctx.self;
  if (self === null) return false;
  if (event.player !== ctx.controller) return false;
  return event.instanceId !== self.id;
}

/** `oneRadiant` is the radiant face: 2 copies keep the played flag, the third is forced Radiant. */
function afterPlay(oneRadiant: boolean): TriggerDef {
  return {
    id: oneRadiant ? "33r-after-you-play-a-card" : "33-after-you-play-a-card",
    on: ["cardResolved"],
    run(ctx): Effect[] {
      const event = ctx.event;
      if (event.type !== "cardResolved" || !answers(ctx, event)) return [];
      const flag = playedRadiantFlag(ctx, event);
      if (!oneRadiant) return [shuffleInto({ defId: event.defId, count: 3, radiant: flag })];
      return [
        shuffleInto({ defId: event.defId, count: 2, radiant: flag }),
        shuffleInto({ defId: event.defId, count: 1, radiant: true }),
      ];
    },
  };
}

export const base: Script = { triggers: [afterPlay(false)] };

export const radiant: Script = { triggers: [afterPlay(true)] };
