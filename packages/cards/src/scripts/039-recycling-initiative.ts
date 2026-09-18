// #39 Recycling Initiative (SPEC §8.2): 0-cost Spell, "Exile this on play. End of turn: add a copy
// of every other card you played this turn to your hand", radiant "Copies cost 1 less". The radiant
// cell restates only what a copy costs, so the exile and the end-of-turn clause are kept unchanged
// (§8 Conventions).
//
// §8.2's Engine cell spells the mechanism out: "End-of-turn delayed effect: a fresh copy (radiant
// flag kept) of every card in `turnLog.playedIds` except this one, including cards played after it
// (R71); instances that no longer exist are skipped rather than fizzling (R86)."
//
//   - R71 is why the log is read when the delayed effect RUNS rather than when the Cry resolves: by
//     end of turn it has grown, so cards played AFTER this one are copied too. That is also why the
//     clause is a delayed effect and not an `endOfTurn` hook: the card is in exile by then, and
//     `turn.triggerOrder` only walks units and the backrow, so an `endOfTurn` hook would never be
//     reached. `turn.runDelayed`'s `findAnywhere` does search the exile pile, so the continuation
//     comes back to this script even though the card is gone from play (the same shape R76 gives
//     #50 Kpop Fanatic).
//   - R86 is the `findInstance` skip below: an id whose instance has ceased to exist (a unit token
//     that left the field, R11) drops out of the pool instead of fizzling on it. An id whose card
//     merely changed zone is still in the pool, which is why nothing here filters on `zone`.
//   - R57 is `addToHand`'s contract — a fresh instance carrying only the radiant flag — which is
//     exactly "a fresh copy (radiant flag kept)".
//   - "every OTHER card" excludes this card's own id. One copy per log entry, so a card played
//     twice in a turn (bounced and replayed, #24) is copied twice: the Engine cell says "every card
//     in `turnLog.playedIds`", and that list holds one entry per play.
//
// !! BLOCKED — MISSING VERB (reported; the signature is the one #50 Kpop Fanatic is written
// against, so ONE verb unblocks #23, #24, #31, #39, #50 and #78) !!
//     delay({ at: { phase: "start" | "end", player: "self" | "enemy" }, step: string,
//             data?: Record<string, unknown> }): Effect
// a thin wrapper over `modifiers.scheduleDelayed(ctx, ctx.controller, at, resumeSelf(ctx, step,
// data))`. `state.delayed`, `Resume`, `scheduleDelayed`, `prompts.resumeSelf` and `turn.runDelayed`
// all exist; `effects/index.ts` exposes no verb for any of it, and a card file may not build its own
// effect (CLAUDE.md rule 5). The call is written below so this card is correct the moment it lands.
//
// Two further engine notes, both reported:
//   - `turn.runDelayed` re-enters a continuation with `resolve.runHook`, which looks a hook up as
//     `script[name]`. A `Resume` built by `resumeSelf` names `hook: "resume"`, and `Script.resume`
//     is a TABLE of steps, not a `Hook` — so `runHook` would try to call an object. It has to go
//     through `prompts.runResume`, which is the function that understands a step table.
//   - `reduce.ts` moves a resolving Spell to the graveyard unconditionally after its Cry, which
//     drags this card straight back out of exile. "Exile this on play" is undone by the play
//     pipeline for #34, #39, #72 and #97 alike.
//
// !! BLOCKED — MISSING VERB ARGUMENT (reported; #7 Jewelosco Scarab asks for the same one) !!
//     addToHand(args: { defId; player?; radiant?; costOverride?; costMod?: number })
//       … if (args.costMod !== undefined) card.costMod += args.costMod;
// Radiant's "Copies cost 1 less" is R65's `costMod`, not a `costOverride`: an override REPLACES the
// printed cost, so it would make an X-cost copy free outright (R65: "a `costOverride` makes one
// free while X is still chosen") and erase an embiggen card's price choice. `setCostMod` cannot
// stand in for it either — the fresh copy does not exist until `addToHand` creates it, and
// `setCostMod`'s only way to name a card is a `TargetSpec`. So the −1 is passed as `costMod`,
// which R78 keeps in every zone.

import type { Effect, EffectContext, Hook, Script } from "@jackioh/engine";
import { findInstance, playedIdsThisTurn } from "@jackioh/engine";
import { addToHand, delay, exile } from "@jackioh/engine/effects";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-039");

/** Radiant: "Copies cost 1 less". */
const DISCOUNT = 1;

/** The step the end-of-turn delayed effect re-enters (§10.6: `script.resume[step]`). */
const COPY_STEP = "copies";

/** The one thing the continuation captures: which play was this card's own (R71's "every other"). */
const SELF_KEY = "selfId";

/** The captured id, narrowed rather than cast: `data` is JSON that crossed a phase boundary. */
function excludedId(ctx: EffectContext): string | undefined {
  const captured = ctx.data[SELF_KEY];
  if (typeof captured === "string") return captured;
  return ctx.self?.id;
}

/**
 * R71: the log is read here, when the delayed effect runs, so later plays are in it — through the
 * engine's read-only `playedIdsThisTurn` (engine/src/query.ts), which gives the ids in play order.
 * R86: an id whose instance no longer exists is skipped rather than fizzled on.
 */
function copiesOfOtherPlays(ctx: EffectContext, discount: number): Effect[] {
  const selfId = excludedId(ctx);
  const out: Effect[] = [];

  for (const id of playedIdsThisTurn(ctx.state, ctx.controller)) {
    if (id === selfId) continue;
    const card = findInstance(ctx.state, id);
    if (card === undefined) continue;

    out.push(
      addToHand({
        defId: card.defId,
        player: "self",
        // R57: a fresh copy carries the radiant flag and nothing else.
        radiant: card.radiant,
        ...(discount === 0 ? {} : { costMod: -discount }),
      }),
    );
  }

  return out;
}

/** The two faces differ only in what a copy costs. */
function recyclingInitiative(discount: number): Script {
  /**
   * R62's continuation, registered on BOTH keys on purpose. `delay` schedules it as
   * `hook: "delayed"`, and `turn.runDelayed` re-enters that through `resolve.runHook`, which does
   * `script[hook]` and CALLS it — so only a function on `delayed` is reachable from there. The
   * `resume` entry is what `prompts.runResume` reads, and it is the shape that survives the
   * `runDelayed` fix (one reader for both, see the report). Registering one named hook twice costs
   * nothing and is correct either way; registering it only under `resume` resolved to NOTHING at
   * all, silently, because `runHook` returns early when `script.delayed` is undefined.
   */
  const copyStep: Hook = (ctx) => copiesOfOtherPlays(ctx, discount);

  return {
    cry: (ctx) => [
      // Armed before the exile, so the continuation records this instance while it still exists.
      delay({
        at: { phase: "end", player: "self" },
        step: COPY_STEP,
        ...(ctx.self === null ? {} : { data: { [SELF_KEY]: ctx.self.id } }),
      }),
      // "Exile this on play."
      exile({ target: { of: "self" } }),
    ],
    delayed: copyStep,
    resume: { [COPY_STEP]: copyStep },
  };
}

export const base: Script = recyclingInitiative(0);

export const radiant: Script = recyclingInitiative(DISCOUNT);
