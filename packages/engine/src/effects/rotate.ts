// Rotate as a verb (SPEC §6.3 Rotate, §3.1's rotation-topology ruling, §3.2; R14, R88; §8.3 #52).
//
// `subsystems/rotation.ts` is that ruling in full: the two rings (the rotating player's lanes 1 to
// 5, then the opponent's 5 down to 1, and back), both turning together one step; the whole board
// read before anything is placed, so one rotation is atomic; a Stack pile travelling whole with its
// top card on top (§3.2, R13); `controller` changing only across the centre line while `owner`
// never does (R12); a Locked or Reborn-reserved destination bouncing the card to its OWNER's hand
// (R14, R88, with R4's hand cap and R11's vanishing token on the way); and #52's radiant face
// replacing crossing with that same bounce at `costOverride` 0 in either direction.
//
// None of that is here, and the ring walk in particular is never rewritten: the subsystem's
// `ringOrder`/`ringNeighbor` are the topology, and a second walk would be a second topology. This
// file is the wrapper the effects barrel was missing — the barrel's own header lists Rotate among
// the verbs living outside it — because `rotateRings` takes an `EngineSink` and mutates the board,
// which a card script may not do (CLAUDE.md rule 5).
//
// THE TWO DEFAULTS ARE THE WHOLE OF ITS CLEVERNESS. §3.1 reads "left" and "right" from the ROTATING
// player's seat, so `perspective` is the controller; and #52's two faces are one hook whose only
// difference is `ctx.radiant`, which `rotateRings` already honours through its own `radiant`
// argument. So `rotate({ direction })` is the complete call, and the radiant bounce comes from the
// running face rather than from anything the card has to pass.

import { rotateRings, type RotationDirection } from "../subsystems/rotation";
import type { Effect } from "../script";
import { playerOf, type PlayerSpec } from "./targets";

/**
 * §6.3 Rotate: every card on the field moves one step around its ring, in the direction the play
 * declared (R81 makes #52's direction a play choice, never a prompt).
 *
 * There is no fizzle case to write: a board with nothing on it rotates nothing, and the subsystem
 * still emits its one `rotated` event, which is what §10.10 animates.
 */
export function rotate(args: {
  direction: RotationDirection;
  /** Whose seat "left" and "right" are read from (§3.1). Default the controller. */
  perspective?: PlayerSpec;
  /** #52's radiant bounce. Default the face that is running (§5.2), which is what #52 wants. */
  radiant?: boolean;
}): Effect {
  return {
    kind: "rotate",
    apply(ctx): void {
      // `EffectContext` satisfies `EngineSink`, so the subsystem takes the context as it stands.
      rotateRings(ctx, {
        direction: args.direction,
        perspective: playerOf(ctx, args.perspective ?? "self"),
        radiant: args.radiant ?? ctx.radiant,
      });
    },
  };
}
