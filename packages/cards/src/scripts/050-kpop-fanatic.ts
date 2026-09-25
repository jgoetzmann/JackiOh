// #50 Kpop Fanatic (SPEC §8.2): a 1/1 → 2/2 Unit. Base "Cry: choose an enemy permanent; at the
// start of your next turn, steal it"; radiant "Divine Shield; Cry: choose an enemy permanent; at the
// start of your next turn, steal it; it becomes Radiant" (R275: the rider is the Radiant face's
// effect raise, the Divine Shield its keyword).
//
// Reading the radiant cell (§8 Conventions): "Divine Shield" is a keyword list without "Plus", so it
// is the radiant form's complete keyword list; it is printed in `catalog.json` (`radiant.keywords`)
// and §10.4 reads it off the face, so no script grants it. The Cry and the delay are the base face's
// ("same"); the radiant face differs only in the step the delay re-enters, which adds the rider.
//
// The choice is made at PLAY time, not during resolution, so it is a declared target travelling in
// the play action's `targets` (R81) rather than a `PendingChoice`. "Permanent" is §6.3's word — a
// Unit, Field Spell, Trap or Field Trap — so the declaration offers both enemy rows; R90 validates
// it, lets a face-down trap be named without being seen (§9.1) and offers only the top of a Stack
// pile (R13). An empty enemy board fizzles and the unit still enters (§8 Conventions).
//
// The delay is the §8.2 Engine cell: a `state.delayed` entry keyed to the TARGET's instance id.
// Keyed to the target and not to this unit is the point of R76 — "fires at your next start of turn
// even if Kpop Fanatic has died" — so the continuation carries the id in its own `data` and does not
// reach back through `ctx.self`, which may be null by then. `prompts.runResume` re-enters the step
// this card names in its `resume` table (§10.6: a continuation is "script id + step + captured
// data", never a closure), which is why the id is read back out of `ctx.data` defensively: `data`
// is a `Record<string, unknown>` that survived JSON, so it is narrowed, never cast.
//
// R76's fizzles are the engine's, and deliberately not re-checked here: a target that has left the
// field has no slot (`slotOf` is null), one dormant under a Stack pile is not the top of it (R13),
// and one already under this player's control is refused, all by `effects/steal.ts`'s
// `takeControl`; and a target that left the field and came back — bounced and replayed, or a Reborn
// body — has had this entry dropped as it left, because the delay `watch`es it (R174). R15 places
// the one that does land: the same lane on this side if free, else the first free zone of that row,
// and it stays with the opponent when the row is full.
//
// R62 fixes when it happens (refresh → start-of-turn delayed effects → start-of-turn triggers →
// draw), R68 the order among several (creation order), and `turn.runDelayed` owns both.
//
// THE RADIANT RIDER (R282). "It becomes Radiant" names the stolen permanent, so it lands only on a
// card the delayed steal actually took: not on a target that has left the field (R76, R174 — the
// delay is dropped then and never runs), one dormant under a Stack pile (R13), one already this
// player's, or one that stays with the opponent because the row is full (R15). Two reads decide it,
// both through the engine's read helpers and neither a write:
//   - before the steal, as the step builds its list: the card stands on top of its pile under the
//     OTHER player, so a steal could take it (`takeable`);
//   - after the steal, as the list reaches the rider: it now stands on top of its pile under THIS
//     player (`heldNow`). That second read has to wait for the steal to have run, which is what a
//     lazy part of the list is for: `forEachCard` reads its set when the list reaches it, so the
//     rider's set is the stolen card or nothing (engine/src/effects/each.ts, `Effect.expand`).
// Together they are "the steal took it"; either alone is not (a card already this player's passes
// the second, a row-full refusal the first). So a Make Radiant never reaches a card off the field —
// one in a hand the controller may not read above all — and `setRadiant` by id is aimed at the stay
// the run began on besides (R174).
//
// THE VERB AND WHERE ITS CONTINUATION LIVES (R126, R127). `delay` stores a `Resume` naming this
// script, the hook key, the step and the captured data, and `turn.runDelayed` re-enters it through
// the one reader — `prompts.runResume`, which resolves `resume.hook` against either a `Hook` on the
// script or a step table. So the step is registered ONCE, in the `resume` table, and `delay` is
// told so with `hook: RESUME_HOOK` (its default is the `delayed` hook). R126: "A card must never
// have to register one continuation under two keys." R127 is the other half and the reason this
// card carries the target id in `data`: the entry re-enters with `ctx.self === null` when Kpop
// Fanatic has died in between, which is exactly R76's case.

import type { CardInstance, Effect, EffectContext, GameState, Hook, Script } from "@jackioh/engine";
import { cardAt, findInstance, RESUME_HOOK, slotOf } from "@jackioh/engine";
import { delay, forEachCard, setRadiant, steal } from "@jackioh/engine/effects";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-050");

/** The step `state.delayed` re-enters at the start of this player's next turn (§10.6, R62). */
const STEAL_STEP = "steal";

/** The one thing the continuation captures: which permanent was chosen (§8.2 Engine cell). */
const TARGET_KEY = "targetId";

/** The play-time pick (R81), read straight off the context — reading state is not mutating it. */
function chosenInstanceId(ctx: EffectContext): string | null {
  const chosen = ctx.targets[0];
  if (chosen === undefined || chosen.pick !== "instance") return null;
  return chosen.instanceId;
}

/** The captured id, narrowed rather than cast: `data` is JSON that crossed a turn boundary. */
function capturedTargetId(ctx: EffectContext): string | null {
  const id = ctx.data[TARGET_KEY];
  return typeof id === "string" ? id : null;
}

/**
 * R13: a card on the field on top of its pile — the only card a steal can take. A backrow zone holds
 * one card, so for a Field Spell or a Trap this is "on the field"; in a unit zone it leaves out a
 * card dormant under a Stack pile (§3.2).
 */
function onTopOfItsPile(state: GameState, card: CardInstance): boolean {
  const at = slotOf(state, card);
  return at !== null && cardAt(state, at)?.id === card.id;
}

/** R282, before the steal: the card stands on the field under the other player, so it can be taken. */
function takeable(ctx: EffectContext, id: string): boolean {
  const card = findInstance(ctx.state, id);
  return card !== undefined && onTopOfItsPile(ctx.state, card) && card.controller !== ctx.controller;
}

/** R282, after the steal: the card stands on the field under this player. */
function heldNow(ctx: EffectContext, id: string): boolean {
  const card = findInstance(ctx.state, id);
  return card !== undefined && onTopOfItsPile(ctx.state, card) && card.controller === ctx.controller;
}

/**
 * R62's continuation, registered once in the `resume` table (R126). R76's fizzles are steal's own
 * no-ops: a target gone from the field, or one already yours.
 */
const stealStep: Hook = (ctx) => {
  const targetId = capturedTargetId(ctx);
  if (targetId === null) return [];
  return [steal({ instanceId: targetId })];
};

/**
 * The radiant face's step: the same steal, then R282's rider — "it becomes Radiant" for the card the
 * steal took and for nothing else. `takeable` is read as the list is built, before the steal runs;
 * the rider's set is read when the list reaches it, after (see the header).
 */
const radiantStealStep: Hook = (ctx) => {
  const targetId = capturedTargetId(ctx);
  if (targetId === null) return [];
  const effects: Effect[] = [steal({ instanceId: targetId })];
  if (!takeable(ctx, targetId)) return effects;
  effects.push(
    forEachCard({
      cards: (now) => (heldNow(now, targetId) ? [targetId] : []),
      each: (instanceId) => setRadiant({ instanceId }),
    }),
  );
  return effects;
};

/** The Cry both faces share: choose the enemy permanent and arm the steal (§8.2 Engine cell). */
function kpopFanatic(step: Hook): Script {
  return {
    // §6.3: a permanent is a Unit, Field Spell, Trap or Field Trap, so both enemy rows are offered.
    targets: [{ kind: "target", min: 1, max: 1, filter: { side: "enemy", of: ["unit", "backrow"] } }],
    cry: (ctx) => {
      const targetId = chosenInstanceId(ctx);
      if (targetId === null) return [];
      return [
        delay({
          at: { phase: "start", player: "self" },
          step: STEAL_STEP,
          hook: RESUME_HOOK,
          data: { [TARGET_KEY]: targetId },
          // R174: a target that leaves the field before the steal fires is gone for good, even if the
          // same card is back by then (bounced and replayed, or a Reborn body) — R76's fizzle.
          watch: targetId,
        }),
      ];
    },
    resume: { [STEAL_STEP]: step },
  };
}

export const base: Script = kpopFanatic(stealStep);

/** "Divine Shield" is printed in the catalog; the step adds R282's rider. */
export const radiant: Script = kpopFanatic(radiantStealStep);
