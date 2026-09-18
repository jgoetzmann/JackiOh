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
// attacks only if the target is still on the field. `forceAttacksOn` (engine/src/combat.ts) is
// exactly that, and `forcedAttacks` in the effects barrel is its Effect wrapper.
//
// WHICH EVENT, AND WHY NOT `cardPlayed` (R17, §10.5 steps 4 and 7). R17 gives one play two trap
// moments: #41 Sheepish at step 4, on the `cardPlayed`/`summoned` pair, before the Cry — and this
// card at step 7, "after the card resolves", which is `cardResolved` (`echo.landAfterResolution`
// emits it once per play or cast, after step 6 has drained every Echo repeat). Watching `cardPlayed`
// would be wrong and not merely early: the Engine cell requires the played unit to be on the field
// with its Cry already resolved, which is what makes "they attack it" reach anything.
//
// `cardResolved` also carries `costPaid` for R89's sake — a trigger answering an event reads what
// it needs OFF the event, because step 7's instance may have been reset since step 4 — so the R56
// threshold below never re-derives a cost from the board.
//
// `summonedThisScript` on the forced-attack filter is what makes "they attack it" mean the tokens
// THIS trap just summoned rather than every Rush Token its controller happens to own.

import type { GameEvent } from "@jackioh/shared";
import type { Effect, EffectContext, Script, TrapTrigger } from "@jackioh/engine";
import { defOf } from "@jackioh/engine";
import { fillBoard, forcedAttacks, summon } from "@jackioh/engine/effects";
import { cardDef } from "../catalog-data";

export const def = cardDef("core-060");

/** §7's shared Rush Token, 3/3 with Rush. */
const RUSH_TOKEN = "core-t-rush";

/** §10.5 step 7's event: the play this trap answers, with the cost R56 reads. */
type ResolvedPlay = Extract<GameEvent, { type: "cardResolved" }>;

/**
 * "When the opponent plays a card costing 1 or less" (radiant: any card). Returns the play when the
 * trap answers this event and null when it must stay armed.
 */
function match(ctx: EffectContext & { event: GameEvent }, anyCost: boolean): ResolvedPlay | null {
  const played = ctx.event;
  if (played.type !== "cardResolved") return null;
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

/**
 * One face's trigger. `TrapTrigger` is `TriggerDef` plus the `when` predicate traps.ts reads, and
 * the whole condition lives in that predicate (R99, R61): `run` is reached only once the trap
 * really is firing, so the `null` branch below is narrowing and never a decision — a 2-cost play
 * has already been declined by `when` and left the trap armed and face-down.
 */
function honeypot(anyCost: boolean, fill: boolean): TrapTrigger {
  return {
    id: "bear-honeypot",
    on: ["cardResolved"],
    when: (ctx) => match(ctx, anyCost) !== null,
    run: (ctx) => {
      const played = match(ctx, anyCost);
      return played === null ? [] : tokensAndAttack(ctx, played, fill);
    },
  };
}

export const base: Script = { triggers: [honeypot(false, false)] };

export const radiant: Script = { triggers: [honeypot(true, true)] };
