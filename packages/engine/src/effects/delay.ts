// Delayed effects (SPEC §2.2's turn loop, §10.1, §10.6, R62, R68, R76).
//
// "At the start of your next turn …" and "End of turn: …" are not triggers. §2.2 gives them their
// own two points in the turn — after the mana refresh and before the start-of-turn triggers, and
// after the end-of-turn trap window and before cleanup — and R62 fixes that order. `state.delayed`
// is where one waits, `modifiers.scheduleDelayed` puts it there, `modifiers.dueDelayed` picks the
// ones due in R68's creation order and `turn.runDelayed` re-enters them. All of that already
// exists; this file is only the missing verb in front of it, because a card script may not write
// state itself (CLAUDE.md rule 5) and `effects/index.ts` is the whole card-script vocabulary.
//
// WHAT IS STORED IS A `Resume`, NEVER A CLOSURE (§9.3, §10.6). `prompts.resumeSelf` builds it out
// of the running context — this script's def id, the face that is running (§5.2) and the instance
// when it still exists — plus the data this step captures, so the continuation survives a JSON
// round-trip and a replay re-enters the same step with the same data. `instanceId` is deliberately
// optional: R76 has #50 Kpop Fanatic's steal fire "even if Kpop Fanatic died", so the continuation
// must be able to outlive its card, which is why a card carries what it needs in `data` rather
// than reaching back through `ctx.self`.

import { scheduleDelayed } from "../modifiers";
import { SELF_KEY, resumeSelf } from "../prompts";
import type { Effect } from "../script";
import type { DelayedEffect } from "../state";
import { playerOf, standsSinceScriptBegan, type PlayerSpec } from "./targets";

/**
 * The `Script` key a delayed continuation lands on unless the card names another. `script.ts`
 * documents `delayed` as "a delayed effect this card scheduled, resolved at its R62 point", and it
 * is a `Hook` — a function — which is the only shape `turn.runDelayed` can re-enter today (it goes
 * through `resolve.runHook`, which calls `script[hook]`). A card whose continuation is an entry in
 * its `resume` step table passes `hook: prompts.RESUME_HOOK`; see the gap noted in
 * `test/effects-delay.test.ts`, which `turn.ts` must fix before that spelling works.
 */
export const DELAYED_HOOK = "delayed";

/** When a delayed effect comes due, in the vocabulary a card file writes: §2.2's two points. */
export type DelayAt = { phase: DelayedEffect["at"]["phase"]; player: PlayerSpec };

/**
 * §6.2's "at the start of your next turn" and "end of turn" as one verb (#39 Recycling Initiative,
 * #50 Kpop Fanatic, #78 /fullsend). `at.player` says whose turn boundary it waits for, relative to
 * the controller like every other `PlayerSpec`; `owner` is the controller, which is both who the
 * continuation runs as and, through R68's creation `seq`, where it sits among several due at once.
 *
 * Scheduling never fizzles: a delay can be armed by a card that is about to exile or sacrifice
 * itself in the same effect list, which is exactly what #39 does, and the entry stays whatever
 * happens to the card afterwards (R76, R86).
 */
export function delay(args: {
  at: DelayAt;
  /** The step the continuation re-enters (§10.6: "script id + step + captured data"). */
  step: string;
  /** The `Script` key that step lives under; `DELAYED_HOOK` unless the card says otherwise. */
  hook?: string;
  /** What the continuation carries across the boundary — the only place it may keep anything. */
  data?: Record<string, unknown>;
  /**
   * R174: the card on the field this effect is aimed at, if any. The effect is forgotten the moment
   * that card leaves the field, so it never lands on a card that left and came back (#50).
   */
  watch?: string;
}): Effect {
  return {
    kind: "delay",
    apply(ctx): void {
      // R174, R76: an effect aimed at a card on the field is aimed at that stay. A target an earlier
      // effect of the same list has already taken off the field — a fused card's other part bounced
      // it (#52) or sacrificed it (#22) — has no stay left to watch, so the delayed effect fizzles
      // now rather than waiting for whatever later stands under the same id (R78, R83).
      if (args.watch !== undefined && !standsSinceScriptBegan(ctx, args.watch)) return;
      // `resumeSelf` is the one builder for the def id, the face and the instance id, so a delay
      // and a prompt store the same shape; only the hook differs, and only when a card says so.
      const built = resumeSelf(ctx, args.step, args.data ?? {});
      // R127: a delayed effect re-enters as whatever is left of its card then, so a Death hook's
      // snapshot (R89) is not carried past the hook that read it.
      const { [SELF_KEY]: _snapshot, ...data } = built.data;
      const resume = { ...built, data, hook: args.hook ?? DELAYED_HOOK };
      scheduleDelayed(
        ctx,
        ctx.controller,
        { phase: args.at.phase, player: playerOf(ctx, args.at.player) },
        resume,
        args.watch,
      );
    },
  };
}
