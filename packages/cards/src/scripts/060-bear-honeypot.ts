// #60 Bear Honeypot (SPEC §8.3): Trap, cost 1, Epic. "When the opponent plays a card costing 1 or
// less: summon 2 Rush Tokens; if it was a Unit, they attack it" / radiant "Any card; fill your board
// with Rush Tokens; same". Engine cell: "Fires after the played card resolves (ruling), so the unit
// is on the field; forced attacks per 4.2 during the opponent's turn; cost = cost paid".
//
// §8 Conventions on the radiant cell: "Any card" restates the condition (so the cost threshold is
// gone), "fill your board with Rush Tokens" restates the summon (so it replaces the two tokens),
// and "same" keeps the unrestated clause — the tokens still attack a played Unit.
//
// What this card does NOT do, because §5.1, §10.3 and traps.ts own it: emit `trapFired`, run the
// post-trap state check, or send itself to the graveyard. `fireTrap` does all three, and because
// this is a Trap and not a Field Trap it is consumed by `consumeTrap` the moment it fires — once
// per game, whatever the effects achieved (R17, R61).
//
// THE CONDITION IS A `when`, NOT AN EARLY RETURN FROM `run`. traps.ts: "`run` returning `[]` is a
// trap that fired for nothing — it can never mean 'this event was not mine'. A condition that must
// leave the trap armed (Bear Honeypot's 'costing 1 or less' …) therefore belongs in a predicate".
// A 2-cost play must leave this trap face-down and armed, so the threshold lives in `when`.
//
// R56: "'Costing 1 or less' … uses the cost actually paid after modifiers", which is
// `event.costPaid`, not the printed cost. R70: "a cast is free and counts as a play … with cost
// paid 0", and names this card, so a cast card is always "costing 1 or less".
//
// R53 (all of it) is the forced attack: skip §4.2 steps 1-3, so position, summoning sickness and
// Taunt are ignored and no exertion is spent; the target still strikes back; the attackers go in
// lane order; each attack is its own combat followed by its own state check; and the next attacker
// attacks only if the target is still on the field. `forceAttacksOn` (engine/src/combat.ts) already
// implements exactly that — the gap is only its Effect wrapper (see below).
//
// TWO ENGINE GAPS this file is written against. Neither is faked here (CLAUDE.md rule 5):
//
// 1. THERE IS NO POST-RESOLUTION EVENT. R17 needs two trap moments on one play: #41 Sheepish before
//    the Cry, this card after the card has resolved. traps.ts says the second one fires "on the
//    events step 7 emits", but §10.5 step 7 emits nothing for a played Unit or Field Spell —
//    `reduce.ts`'s `playCard` emits `cardPlayed` + `summoned` and then runs the Cry, and for a Spell
//    `cardPlayed`, the Cry, then `enteredGraveyard`. `cardPlayed` is the step-4 event, so watching
//    it would fire this trap BEFORE the played unit's Cry, which is #41's timing and not this
//    card's. Proposed: a `cardResolved` event with `cardPlayed`'s exact payload
//    ({ player, instanceId, defId, costPaid, x?, embiggened? }), emitted at §10.5 step 7 after the
//    Cry and after the Echo repeats of step 6, added to the `GameEvent` union, to `GAME_EVENT_TYPES`
//    and to §10.3's list with BUILD M5-T4's animation row. #33 Unstable Clone Machine and #85
//    Unlicensed Experimentation need the same event. Until it exists — and until `reduce`'s play
//    pipeline calls `fireTrapsFor` at all, which it does not today — this trap cannot fire.
// 2. THERE IS NO FORCED-ATTACK EFFECT. `forceAttack`/`forceAttacksOn` take an `EngineSink` and are
//    not in the effects barrel, so no card can reach them. Proposed:
//      forcedAttacks({ attackers: { side: "self" | "enemy"; defId?: string; summonedThisScript?: boolean },
//                      target: { instanceId: string } | { of: TargetSpec } }): Effect
//    resolving the attacker list in lane order through `activeUnitsOf` and delegating to
//    `forceAttacksOn`, which already stops when the target has left the field (R53). #9 Moths to the
//    Flame wants the same verb from the other side (`{ side: "enemy" }`, target `{ of: "self" }`).
//    `summonedThisScript` is what makes "they attack it" mean the tokens THIS trap just summoned
//    rather than every Rush Token its controller happens to own; see the report.

import type { GameEvent, PlayerId } from "@jackioh/shared";
import type { Effect, EffectContext, Script, TrapTrigger } from "@jackioh/engine";
import { defOf } from "@jackioh/engine";
import { fillBoard, forcedAttacks, summon } from "@jackioh/engine/effects";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-060");

/** §7's shared Rush Token, 3/3 with Rush. */
const RUSH_TOKEN = "core-t-rush";

/**
 * Gap 1 above: the §10.5 step 7 event this trap must watch. The cast is the one place this file is
 * ahead of the engine — delete it and write `on: ["cardResolved"]` once `shared/src/events.ts`
 * carries the member. Watching `cardPlayed` instead would be wrong, not merely early: the Engine
 * cell requires the played unit to be on the field with its Cry already resolved.
 */
const CARD_RESOLVED = "cardResolved" as GameEvent["type"];

/** The fields the step-7 event carries; identical to `cardPlayed`'s, which is why it is the same shape. */
type ResolvedPlay = { player: PlayerId; instanceId: string; defId: string; costPaid: number };

/**
 * Read the play off the event. `"costPaid" in event` is the narrowing that works for both the
 * `cardPlayed` member the union has today and the `cardResolved` member it needs, so nothing here
 * asserts a shape the engine has not published.
 */
function resolvedPlay(event: GameEvent): ResolvedPlay | null {
  return "costPaid" in event ? event : null;
}

/**
 * "When the opponent plays a card costing 1 or less" (radiant: any card). Returns the play when the
 * trap answers this event and null when it must stay armed.
 */
function match(ctx: EffectContext & { event: GameEvent }, anyCost: boolean): ResolvedPlay | null {
  const played = resolvedPlay(ctx.event);
  if (played === null) return null;
  // "the opponent plays": the trap's own controller setting off their own trap is not the trigger.
  if (played.player === ctx.controller) return null;
  // R56 and R70: the cost actually paid, so a cast (0) is always "1 or less".
  if (!anyCost && played.costPaid > 1) return null;
  return played;
}

/**
 * "summon 2 Rush Tokens" / "fill your board with Rush Tokens"; then "if it was a Unit, they attack
 * it". A played Spell, Field Spell, Trap or Field Trap leaves the tokens standing and attacks
 * nothing. The Unit test reads the def rather than the board, so a played unit that died during its
 * own resolution still counts as a Unit and the forced-attack run simply finds it gone (R53).
 */
function tokensAndAttack(ctx: EffectContext, played: ResolvedPlay, fill: boolean): Effect[] {
  const tokens: Effect[] = fill
    ? [fillBoard({ defId: RUSH_TOKEN })]
    : [summon({ defId: RUSH_TOKEN }), summon({ defId: RUSH_TOKEN })];

  if (defOf(ctx.state, played.defId).type !== "Unit") return tokens;
  return [
    ...tokens,
    forcedAttacks({
      attackers: { side: "self", defId: RUSH_TOKEN, summonedThisScript: true },
      target: { instanceId: played.instanceId },
    }),
  ];
}

/** One face's trigger. `TrapTrigger` is `TriggerDef` plus the `when` predicate traps.ts reads. */
function honeypot(anyCost: boolean, fill: boolean): TrapTrigger {
  return {
    id: "bear-honeypot",
    on: [CARD_RESOLVED],
    when: (ctx) => match(ctx, anyCost) !== null,
    run: (ctx) => {
      const played = match(ctx, anyCost);
      return played === null ? [] : tokensAndAttack(ctx, played, fill);
    },
  };
}

export const base: Script = { triggers: [honeypot(false, false)] };

export const radiant: Script = { triggers: [honeypot(true, true)] };
