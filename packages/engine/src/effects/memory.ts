// What a card remembers, on its own instance (§10.1): Carnivorous Cube's meal, Heroic Power's power.
//
// R174, R78: what is remembered is remembered by the card on the stay the run began with. A card an
// earlier effect of the same list took off the field has been reset (R78) — memory included — and
// what it remembered went with that stay, so a later part of the list writes nothing onto it: a
// fused Cube part does not write its meal onto a card its Silas part has bounced to a hand.
//
// R102: on a fused card each ingredient remembers under its own key (`work.partMemoryKey`), so two
// Carnivorous Cubes crafted into one card remember two meals, and each Death copies its own; a card
// reads back through `query.recalled`, which applies the same key. A card a Fuse keeps moves what its
// texts remembered to the path they run at in the new fusion (`work.rerootRemembered`, R77).

import type { Effect } from "../script";
import { rememberOn } from "../work";
import { selfOnItsStay } from "./targets";

export function remember(args: { key: string; value: unknown }): Effect {
  return {
    kind: "remember",
    apply(ctx): void {
      const self = selfOnItsStay(ctx);
      if (self === null) return;
      rememberOn(self.memory, ctx.data, args.key, args.value);
    },
  };
}

/** Remember one of `options`, drawn from the match rng so setup replays the same way (R43). */
export function rememberRandom(args: { key: string; options: readonly unknown[] }): Effect {
  return {
    kind: "rememberRandom",
    apply(ctx): void {
      const self = selfOnItsStay(ctx);
      if (self === null || args.options.length === 0) return;
      rememberOn(self.memory, ctx.data, args.key, ctx.rng.pick(args.options));
    },
  };
}
