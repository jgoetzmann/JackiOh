// #81 Radiant Saintess (SPEC §8.4 row 81): Unit, Human, cost 1, Epic, 2/2 → 4/4.
//   Base:    "Cry and Death: all your units become Radiant"
//   Radiant: "Reborn; same"
//
// THE RADIANT FACE HAS NO EXTRA CODE. §8's Conventions: a radiant cell that lists keywords without
// "Plus" gives the radiant form's complete keyword list, and "same" says the text is unchanged.
// Reborn is PRINTED on the radiant face (`catalog.json` core-081 `radiant.keywords`), which
// `layers.faceOf` already reads off the instance's radiant flag, so the radiant script below is the
// base script. Nothing here restates a stat, a cost or a keyword (the `def` above is the only
// source of those).
//
// R22 "Radiant on the field": "Base layer swaps, damage and buffs stay, Cry does not re-fire;
// Saintess includes itself". `setRadiant` is exactly that — it sets the instance's `radiant` flag
// and nothing else (`effects/radiant.ts`), so §10.4's printed-stat layer swaps on the next read
// while layer 4's buffs and the instance's damage are untouched, and no card re-enters the field,
// so no Cry fires again. Two consequences the row's Engine cell spells out:
//   - "Includes itself on Cry (ruling), so it is 4/4 Reborn immediately": the Cry radiates `self`.
//     §10.5 puts the unit on the field at step 4 and runs the Cry at step 5, so `self` is already
//     one of `activeUnitsOf`; naming it anyway is what R22 asks the card to be explicit about, and
//     the duplicate is free because `setRadiant` skips a card that is already Radiant (§6.3).
//   - "its Reborn body fires Death again": that is R8 ("Death fires on both deaths") plus §4.5
//     step 4, both the state check's, not this file's.
//
// R78 is why Death does NOT name `self`. Leaving the field resets an instance and "effects that
// react to a card leaving read its last-known state from just before it left": `stateCheck` moves
// the dying unit to the graveyard at step 1 and runs the Death hook at step 3 off a SNAPSHOT of the
// instance, so `ctx.self` is a detached copy of a card that is no longer a unit on the field and
// `ctx.controller` is the controller it had as it died. "All your units" is therefore the units
// still standing, which is what `activeUnitsOf(state, ctx.controller)` returns. The radiant flag
// persists in every zone (R78), so a Reborn body comes back already Radiant and needs no help.
//
// R13 "Stack dormancy": cards under a Stack are not on the field, so they are not "your units".
// `activeUnitsOf` reads the top of each pile only, which is the same rule (§3.2), and R23 leaves
// Make Radiant legal on an Immutable unit, so no keyword filter belongs here either.
//
// R64 (a Reborn unit reserves its zone) and R83 (the Reborn body takes the current turn as its
// `summonedTurn`, so it is summoning sick) are both the engine's; this card only sets flags.

import type { Effect, EffectContext, Hook, Script } from "@jackioh/engine";
import { activeUnitsOf } from "@jackioh/engine";
import { setRadiant } from "@jackioh/engine/effects";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-081");

/**
 * "All your units become Radiant", as one `setRadiant` per unit named by instance id — nobody chose
 * these cards, so there is no `TargetSpec` to resolve (R81). `includeSelf` is R22's ruling for the
 * Cry; the ids are de-duplicated so the effect list has one entry per card even when `self` is
 * already standing in a unit zone.
 */
function radiateYourUnits(ctx: EffectContext, includeSelf: boolean): Effect[] {
  const self = ctx.self;
  const ids = [
    ...(includeSelf && self !== null ? [self.id] : []),
    ...activeUnitsOf(ctx.state, ctx.controller).map((unit) => unit.id),
  ];
  return [...new Set(ids)].map((instanceId) => setRadiant({ instanceId }));
}

/**
 * R78: by the time Death runs she is in the graveyard, so "your OTHER units" — which is what
 * the card now says — is simply everyone left standing. The `false` below is that word.
 *
 * THERE IS NO CRY. She had "Cry and Death" and the Cry was cut for burst: playing her turned the
 * board Radiant the instant she landed, including herself (she arrived 4/4 with Reborn for one
 * mana). On Death alone the same effect has to be paid for with her body, which is the cost the
 * card was missing. `includeSelf` stays a parameter because Death is the only caller and passing
 * `false` at the one call site is what R78 is about.
 */
const death: Hook = (ctx) => radiateYourUnits(ctx, false);

export const base: Script = { death };

/** "Reborn; same": Reborn is printed on the radiant face, so the text — and the code — is the base. */
export const radiant: Script = { death };
