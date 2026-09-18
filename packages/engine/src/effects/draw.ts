// Draw: takes the top card, with cast-on-draw, fatigue, the hand cap and R58's chain cap (§2.4),
// and the named-card form a script computes for itself (#30 Archivist, #94 Genn's Greed).

import { completeDraw, draw as drawCards } from "../draw";
import type { Effect } from "../script";
import { playerOf, type PlayerSpec } from "./targets";

export function draw(args: { count: number; player?: PlayerSpec }): Effect {
  return {
    kind: "draw",
    apply(ctx): void {
      drawCards(ctx, playerOf(ctx, args.player ?? "self"), args.count);
    },
  };
}

/**
 * §6.3 Draw of a card a script has NAMED, rather than of the top of the library: #30 Archivist's
 * "draw the highest-cost card in your library", #94 Genn's Greed's "draw every 2-cost card from your
 * library". Neither of the neighbouring verbs is this one — `draw({ count })` takes the top and
 * `addToHand({ defId })` creates a fresh card of a definition and leaves the original where it is,
 * which is a second copy and not a draw — so a card that names its own card out of a library needs
 * this, and the two halves of "it is a DRAW" fall out of sharing `../draw`'s pipeline: the card
 * really leaves the library, `state.counters.drawn` moves (R55), a `drawn` event fires for anything
 * watching, the hand cap burns the overflow (§2.4, R4) and a cast-on-draw card casts (R58).
 *
 * `instanceId` names one card; `defId` takes the first card of that definition from the top of the
 * library, which is the form a card that knows only what it wants can write. A spec that matches
 * nothing — an empty library, a card already drawn by an earlier effect in the same list — fizzles
 * and the card still resolves (§6.3). A script that wants several cards returns several of these,
 * one per card, so each is its own draw in its own order (R135's per-card rule for the exile half).
 */
export function drawFromLibrary(args: {
  instanceId?: string;
  defId?: string;
  player?: PlayerSpec;
}): Effect {
  return {
    kind: "drawFromLibrary",
    apply(ctx): void {
      if (args.instanceId === undefined && args.defId === undefined) return;

      const player = playerOf(ctx, args.player ?? "self");
      const library = ctx.state.players[player].library;
      const at = library.findIndex((card) =>
        args.instanceId === undefined ? card.defId === args.defId : card.id === args.instanceId,
      );
      if (at < 0) return;

      // Out of the pile first, exactly as `drawOne` does it, so a cast-on-draw card resolves against
      // a library that no longer holds it (§2.4, R58).
      const [card] = library.splice(at, 1);
      if (card === undefined) return;
      completeDraw(ctx, player, card);
    },
  };
}
