// What a card remembers, on its own instance (§10.1): Carnivorous Cube's meal, Heroic Power's power.

import type { Effect } from "../script";

export function remember(args: { key: string; value: unknown }): Effect {
  return {
    kind: "remember",
    apply(ctx): void {
      if (ctx.self === null) return;
      ctx.self.memory[args.key] = args.value;
    },
  };
}

/** Remember one of `options`, drawn from the match rng so setup replays the same way (R43). */
export function rememberRandom(args: { key: string; options: readonly unknown[] }): Effect {
  return {
    kind: "rememberRandom",
    apply(ctx): void {
      if (ctx.self === null || args.options.length === 0) return;
      ctx.self.memory[args.key] = ctx.rng.pick(args.options);
    },
  };
}
