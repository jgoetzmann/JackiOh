// Shuffle into a library at a uniformly random position, stopping at the library cap (§6.3, R80).

import { shuffleIntoLibrary } from "../draw";
import type { Effect } from "../script";
import { newInstance } from "../state";
import { playerOf, type PlayerSpec } from "./targets";

/** Shuffle fresh copies of a definition into a library (CN-Virus, Unstable Clone Machine). */
export function shuffleInto(args: {
  defId: string;
  count: number;
  player?: PlayerSpec;
  radiant?: boolean;
}): Effect {
  return {
    kind: "shuffleInto",
    apply(ctx): void {
      const player = playerOf(ctx, args.player ?? "self");
      for (let i = 0; i < args.count; i += 1) {
        const card = newInstance(ctx.state, args.defId, player, { z: "library", player });
        if (args.radiant === true) card.radiant = true;
        shuffleIntoLibrary(ctx, card, false);
      }
    },
  };
}

/** Shuffle copies of the card that is resolving (CN-Virus's own copies). */
export function shuffleCopiesOfSelf(args: { count: number; player?: PlayerSpec }): Effect {
  return {
    kind: "shuffleCopiesOfSelf",
    apply(ctx): void {
      if (ctx.self === null) return;
      const player = playerOf(ctx, args.player ?? "self");
      for (let i = 0; i < args.count; i += 1) {
        const card = newInstance(ctx.state, ctx.self.defId, player, { z: "library", player });
        card.radiant = ctx.self.radiant;
        shuffleIntoLibrary(ctx, card, false);
      }
    },
  };
}
