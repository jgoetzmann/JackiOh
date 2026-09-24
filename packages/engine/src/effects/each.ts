// One effect for each card of a set a clause reads off the board (R113, R66).
//
// A hook is a pure builder, so a list a prompt split is continued by building it again and skipping
// what already ran (`prompts.runResume`). That is exact for a list whose shape does not hang on the
// board — and wrong for one that does, when its own head has moved the cards it was built from:
// #94 Genn's Greed's "draw every 2-cost card" built one draw per card, a drawn card that was cast and
// asked had left the library by the answer, and the rebuilt list, one draw shorter, skipped a Bigot
// by index. So a clause over such a set is a part of the list (`resolve.lazyPart`): it reads its set
// once, as the list reaches it, and keeps the ids as the part's memo, which a continuation hands
// back to its rebuild — so a pause inside it resumes over the very set it began with.

import { lazyPart } from "../resolve";
import type { Effect, EffectContext } from "../script";
import type { CardInstance } from "../state";

/**
 * `each(id)` for every card `cards` names, read once as the list reaches the clause and never again,
 * so a prompt inside one of them resumes over the same set in the same order (R113). A card's list
 * whose length depends on the board — a draw per matching library card (#94), a draw of each of two
 * named cards (#30 radiant) — writes that part with this rather than spreading a `.map` into the list.
 */
export function forEachCard(args: {
  cards: (ctx: EffectContext) => readonly (CardInstance | string)[];
  each: (instanceId: string) => Effect;
}): Effect {
  return lazyPart("forEachCard", (ctx, memo) => {
    const ids = Array.isArray(memo)
      ? memo.filter((id): id is string => typeof id === "string")
      : args.cards(ctx).map((card) => (typeof card === "string" ? card : card.id));
    return { effects: ids.map((id) => args.each(id)), memo: ids };
  });
}
