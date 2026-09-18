// #52 Silly Silas (SPEC §8.3, §3.1's rotation-topology ruling, §3.2, §6.3 Rotate; R4, R11, R12,
// R14, R33, R78, R81, R88). Unit 4/4 → 8/8, Human, cost 3, Legendary. BUILD wave 3 (rotation).
//   Base:    "Cry: choose left or right; rotate every card on the field one step around its ring
//            (3.1); cards crossing sides change control"
//   Radiant: "Cards that would move to the opponent are bounced to their owner's hand costing 0
//            instead" — §8 Conventions: the cell restates only what happens to a crossing card, so
//            the direction choice and the rotation itself are kept.
//
// THE DIRECTION IS A PLAY-TIME CHOICE, NOT A PROMPT. R81 names this card: "a declared `direction`
// pick [travels] in `modes`, so … Silly Silas's direction [is] chosen with the play and never
// pause[s] resolution", and §10.6 adds that no Core card ever opens a `direction` prompt. So the
// script DECLARES `modes: [{ kind: "direction", options: ["left", "right"] }]`, `legalActions`
// enumerates both, and the answer arrives in `ctx.modes` — which is the second half of
// `chosenOptions(ctx)` (engine/src/effects/choose.ts), the one reader for a declared mode and a
// prompt-mode answer alike.
//
// THE ROTATION IS THE SUBSYSTEM'S, NOT THIS FILE'S. `subsystems/rotation.ts` implements R14 in full
// and is deliberately not in the effects barrel, so the card cannot call it and stay pure
// (CLAUDE.md rule 5: `rotateRings` takes an `EngineSink` and mutates the board). What it already
// does, so that nothing here needs re-reading or re-deciding:
//   * two rings, `ringOrder`/`ringNeighbor` (§3.1): the rotating player's lanes 1→5, then the
//     opponent's 5→1, and back; "right" is one step forward along that order, "left" one back;
//     the unit ring and the backrow ring turn together, and "left"/"right" are read from the
//     rotating player's seat, which is why the wrapper must pass `perspective: ctx.controller`;
//   * the whole board is read before anything is placed, so one rotation is atomic and a full ring
//     keeps every card;
//   * a Stack pile travels whole and keeps its top card on top (§3.2, R13);
//   * Silas is already on the field when his Cry resolves (§10.5 step 4 precedes step 5), so he is
//     in the snapshot and rotates with everything else — the Engine cell's "Silas rotates too";
//   * a card never leaves the field, so R78's reset never runs: damage, buffs, granted keywords,
//     counters, position, exertion and `summonedTurn` all travel with it (R14);
//   * `controller` changes only when the destination is on the other side of the centre line, and
//     `owner` never changes (R12), so a crossed card still leaves to its OWNER's piles later; a
//     face-down trap that crosses is read by its new controller alone, which follows from
//     `controller` and is why `faceUp` is untouched (R33);
//   * a Locked or Reborn-reserved destination bounces the card to its owner's hand instead (R14,
//     R88), where the hand cap applies (R4) and a unit token ceases to exist on the way (R11);
//   * `radiant: true` replaces crossing with that same bounce at `costOverride: 0`, in either
//     direction, so no card changes control at all on the radiant face (R14, R65).
//
// BASE AND RADIANT SHARE ONE HOOK. The only difference between the faces is `ctx.radiant`, which
// `rotateRings` already honours through its own `radiant` argument — so the wrapper passes
// `radiant: ctx.radiant` and there is exactly one rotation implementation in the game.
//
// BLOCKED (reported, not worked around): the effects barrel has no Rotate verb — the §6.3 Rotate
// row is implemented in `subsystems/rotation.ts` and the barrel's own header lists Rotate among the
// verbs "[that] live outside it and are not part of the card-script surface". The wrapper this file
// is written against, to be added to engine/src/effects (and re-exported by the barrel):
//
//   rotate({ direction: "left" | "right" }): Effect
//
// whose `apply(ctx)` is one call, `rotateRings(ctx, { direction: args.direction, perspective:
// ctx.controller, radiant: ctx.radiant })` — an `EffectContext` already satisfies `EngineSink`
// (`state`, `events`, `rng`), so the wrapper is the whole of it and no rotation logic moves.

import type { EffectContext, Hook, Script } from "@jackioh/engine";
import { chosenOptions, rotate } from "@jackioh/engine/effects";
import type { ModeDecl } from "@jackioh/shared";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-052");

/** R81: the declared direction, enumerated by `legalActions` and answered in the `play` action. */
const DIRECTIONS = ["left", "right"] as const;
type Direction = (typeof DIRECTIONS)[number];

const DIRECTION_DECL: ModeDecl = { kind: "direction", options: [...DIRECTIONS] };

/**
 * The declared pick, narrowed rather than cast. `chosenOptions(ctx)` reads a prompt answer's mode
 * first and `ctx.modes` second, so one reader covers both an ordinary play and an Echo repeat of
 * this Cry. R90 keeps the play legal with the answers that exist, so a play that carried no
 * direction fizzles here instead of guessing a side for the whole board.
 */
function directionOf(ctx: EffectContext): Direction | null {
  const picked = chosenOptions(ctx)[0];
  return DIRECTIONS.find((direction) => direction === picked) ?? null;
}

/** §8: one step around each ring, in the direction the play declared. */
const silas: Hook = (ctx) => {
  const direction = directionOf(ctx);
  return direction === null ? [] : [rotate({ direction })];
};

export const base: Script = { modes: [DIRECTION_DECL], cry: silas };

/**
 * The same declaration and the same hook: the radiant difference is `ctx.radiant`, which the
 * rotation subsystem reads for itself (R14's "radiant bounces go to the card's owner's hand").
 */
export const radiant: Script = { modes: [DIRECTION_DECL], cry: silas };
