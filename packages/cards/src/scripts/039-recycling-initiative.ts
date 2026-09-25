// #39 Recycling Initiative (SPEC §8.2; R4, R57, R65, R71, R78, R86, R126, R127, R133, R215, R275).
// Spell, cost 0.
//   Base:    "Exile this on play. End of turn: add a copy of every other card you played this
//            turn to your hand"
//   Radiant: "Exile this on play. End of turn: add a Radiant copy of every other card you played
//            this turn to your hand; the copies cost 1 less" — §8's cell "Copies are Radiant and
//            cost 1 less" (R275's raise: the copies' face and their price). The cell restates only
//            what a copy is and costs, so the exile and the end-of-turn clause are kept unchanged
//            (§8 Conventions).
//
// §8.2's Engine cell spells the mechanism out: "End-of-turn delayed effect: a fresh copy (radiant
// flag kept) of every card in `turnLog.playedIds` except this one, including cards played after it
// (R71); instances that no longer exist are skipped rather than fizzling (R86)."
//
//   - R71 is why the log is read when the delayed effect RUNS rather than when the Cry resolves: by
//     end of turn it has grown, so cards played AFTER this one are copied too. That is also why the
//     clause is a delayed effect and not an `endOfTurn` hook: the card is in exile by then, and
//     `turn.triggerOrder` only walks units and the backrow, so an `endOfTurn` hook would never be
//     reached. A delayed continuation names its script by stored def id, so it comes back to this
//     script even though the card is gone from play (R127, the same shape R76 gives #50 Kpop
//     Fanatic) — with `ctx.self` whatever `findInstance` makes of it, exile pile included.
//   - R86 is the `findInstance` skip below: an id whose instance has ceased to exist (a unit token
//     that left the field, R11) drops out of the pool instead of fizzling on it. An id whose card
//     merely changed zone is still in the pool, which is why nothing here filters on `zone`.
//   - R57 is `addToHand`'s contract — a fresh instance carrying only the radiant flag — which is
//     exactly "a fresh copy (radiant flag kept)" on the base face. The radiant face's copies are
//     Radiant whatever the played card was: a flag that is only ever set (§5.2), never taken away.
//   - "every OTHER card" excludes this card's own id, and it is the set of cards played, not the
//     list of plays (R133). `turnLog.playedIds` holds one entry per play, so a card played, bounced
//     and replayed in one turn (#24) is two entries and one card, and it is copied ONCE: the loop
//     below skips an id it has already seen, ahead of R86's skip.
//
// WHERE THE CONTINUATION LIVES (R126, R127). `delay` stores a `Resume` — "script id + step +
// captured data", never a closure — and `turn.runDelayed` re-enters it through the one reader,
// `prompts.runResume`, which resolves `resume.hook` against either shape: a `Hook` on the script or
// a step table (`resume`, where `resume.step` picks the entry). So this card registers its
// continuation ONCE, in the `resume` table that every other pause in the repo uses, and says so by
// passing `hook: RESUME_HOOK` to `delay` (whose default is the `delayed` hook). R126: "A card must
// never have to register one continuation under two keys". R127 covers the rest: the entry is named
// by stored def id, so it re-enters with `ctx.self === null` once this card is in exile, which is
// why the id it needs travels in `data`.
//
// THE DISCOUNT. Radiant's "the copies cost 1 less" is R65's `costMod`, not a `costOverride`: an
// override REPLACES the printed cost, so it would make an X-cost copy free outright (R65: "a
// `costOverride` makes one free while X is still chosen") and erase an embiggen card's price choice.
// `setCostMod` cannot stand in for it either — the fresh copy does not exist until `addToHand`
// creates it, and `setCostMod`'s only way to name a card is a `TargetSpec`. So the −1 is passed as
// `addToHand`'s `costMod`, which R78 keeps in every zone. It is a price in the hand, so it lands
// only on a copy that reaches one: a copy a full hand burns reaches the graveyard with its radiant
// flag and without the discount (§2.4, R4, R215).

import type { Effect, EffectContext, Hook, Script } from "@jackioh/engine";
import { findInstance, playedIdsThisTurn, RESUME_HOOK } from "@jackioh/engine";
import { addToHand, delay, exile } from "@jackioh/engine/effects";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-039");

/** Radiant: "the copies cost 1 less". */
const DISCOUNT = 1;

/** What a face does to each copy: the discount, and whether the copy is Radiant regardless. */
type CopyTerms = { discount: number; radiant: boolean };

/** Base: a plain copy at its printed price, radiant flag kept (R57). */
const BASE_TERMS: CopyTerms = { discount: 0, radiant: false };

/** Radiant: a Radiant copy, one cheaper. */
const RADIANT_TERMS: CopyTerms = { discount: DISCOUNT, radiant: true };

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
 * R133: the log holds one entry per play, so a card played, bounced and replayed is two entries and
 * one card. "Every other card you played this turn" is the set of cards, not the list of plays, so
 * each id yields one copy; deduping by id leaves R86's skip untouched.
 */
function copiesOfOtherPlays(ctx: EffectContext, terms: CopyTerms): Effect[] {
  const selfId = excludedId(ctx);
  const out: Effect[] = [];
  const seen = new Set<string>();

  for (const id of playedIdsThisTurn(ctx.state, ctx.controller)) {
    if (id === selfId) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    const card = findInstance(ctx.state, id);
    if (card === undefined) continue;

    out.push(
      addToHand({
        defId: card.defId,
        player: "self",
        // R57: a fresh copy carries the radiant flag and nothing else; the radiant face sets it.
        radiant: terms.radiant || card.radiant,
        ...(terms.discount === 0 ? {} : { costMod: -terms.discount }),
      }),
    );
  }

  return out;
}

/** The two faces differ only in what a copy is and costs. */
function recyclingInitiative(terms: CopyTerms): Script {
  /** R62's continuation, registered once: the `resume` step table the `delay` below names. */
  const copyStep: Hook = (ctx) => copiesOfOtherPlays(ctx, terms);

  return {
    cry: (ctx) => [
      // Armed before the exile, so the continuation records this instance while it still exists.
      delay({
        at: { phase: "end", player: "self" },
        step: COPY_STEP,
        hook: RESUME_HOOK,
        ...(ctx.self === null ? {} : { data: { [SELF_KEY]: ctx.self.id } }),
      }),
      // "Exile this on play."
      exile({ target: { of: "self" } }),
    ],
    resume: { [COPY_STEP]: copyStep },
  };
}

export const base: Script = recyclingInitiative(BASE_TERMS);

export const radiant: Script = recyclingInitiative(RADIANT_TERMS);
