// #91 Fed Fauci (SPEC §8.4, BUILD M4-T4 row 91, R63, R78).
//
// Base: "Rush. Whenever this takes damage, +1 Plague Token. Start of turn: +1 mana per Plague
// Token". Radiant: "Rush; +2 mana per token". The radiant cell lists Rush without "Plus", so Rush
// is the radiant face's COMPLETE keyword list (§8 Conventions) — which is what the catalog prints
// on both faces, so nothing here grants it (§10.4 layer 1 reads it off the def). The cell restates
// only the mana number, so the damage→token clause is kept exactly as the base writes it.
//
// The token count is `counters.plague` on the instance (§10.1) and the `plague` effect is the only
// thing that writes it; this file reads it and nothing else (CLAUDE.md rule 5).
//
// Two rulings do the work the card text leaves out, and neither is implemented here:
//   R63 — "a hit whose amount is 0 before step 1 is not a damage instance" and "a hit that is 0
//         after Armor and the cap emits no `damage` event and triggers nothing". `dealDamage`
//         (`engine/src/damage.ts`) returns before pushing the event in both cases, so a hit Armor
//         or the Anti-oneshot cap swallowed makes NO token. That is why this trigger counts
//         `damage` EVENTS rather than attacks: one event is one damage instance is one token.
//   R78 — "leaving the field resets an instance's … counters", so the tokens are gone the moment it
//         leaves and it comes back at zero. `resetInstance` (`engine/src/zones.ts`) does that; the
//         card neither implements nor helps it, and the test only asserts it.
//
// The condition is written twice, once as R99's `when` predicate and once as a guard inside `run`,
// and both call the same function. `when` is the declaration R99 asks for; the guard is there
// because `runQueuedTrigger` (`triggers.ts`) matches on `on` alone and never consults `when` — only
// the trap path does (`traps.ts`) — so a unit trigger that put its condition only in `when` would
// make a token off every hit anywhere on the board. Reported with this card; the guard stays
// correct either way, since a non-trap trigger is not spent by returning nothing.

import type { EffectContext, Hook, Script, TriggerDef } from "@jackioh/engine";
import type { GameEvent } from "@jackioh/shared";
import { gainMana, plague } from "@jackioh/engine/effects";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-091");

/** §8: "+1 Plague Token" — one per damage instance. */
const TOKENS_PER_DAMAGE = 1;

/** §8: base "+1 mana per Plague Token"; radiant "+2 mana per token". */
const MANA_PER_TOKEN = { base: 1, radiant: 2 } as const;

/**
 * "Whenever THIS takes damage": the event carries the target, so a hit this card DEALT — its own
 * strike-back, its Trample overflow — is not a hit it took.
 */
function isHitOnSelf(ctx: EffectContext & { event: GameEvent }): boolean {
  const self = ctx.self;
  if (self === null || ctx.event.type !== "damage") return false;
  return ctx.event.targetId === self.id;
}

/** "+1 Plague Token". `plague` defaults its target to `{ of: "self" }`, which is this card. */
const takesDamage: TriggerDef = {
  id: "fed-fauci-plague",
  on: ["damage"],
  when: isHitOnSelf,
  run: (ctx) => (isHitOnSelf(ctx) ? [plague({ amount: TOKENS_PER_DAMAGE })] : []),
};

/**
 * "Start of turn: +N mana per Plague Token" (§2.2, R62: after the refresh, before the draw). With
 * no tokens the card gains nothing and returns no effect at all, so it emits no `manaChanged` for a
 * change of zero.
 */
function manaFromTokens(perToken: number): Hook {
  return (ctx) => {
    const tokens = ctx.self?.counters.plague ?? 0;
    return tokens <= 0 ? [] : [gainMana({ amount: tokens * perToken })];
  };
}

export const base: Script = {
  triggers: [takesDamage],
  startOfTurn: manaFromTokens(MANA_PER_TOKEN.base),
};

export const radiant: Script = {
  triggers: [takesDamage],
  startOfTurn: manaFromTokens(MANA_PER_TOKEN.radiant),
};
