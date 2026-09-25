// Forced attack, Cancel an attack and the AI turn, as card-script verbs (SPEC §6.3's "Forced
// attack" and "Cancel an attack" rows, §4.2, §4.5, §10.7's AI bullet, R44, R53, R84).
//
// WHY THIS FILE EXISTS. `effects/index.ts`'s header says these verbs "live outside it and are not
// part of the card-script surface", which was true while nothing needed them from a hook. It is
// not true any more: #9 Moths to the Flame forces attacks from `startOfTurn`, #60 Bear Honeypot
// from a trap trigger, and #96 My Pawn cancels an attack and hands the turn to the AI from another.
// A hook returns `Effect[]` and has no `EngineSink` of its own (CLAUDE.md rules 4 and 5), while
// `../combat`'s `forceAttack`/`forceAttacksOn` and `../subsystems/aiPolicy`'s `playOutTurn` all
// take a sink — so every verb here is a THIN wrapper and nothing here re-implements combat, R53's
// stop rule or §10.7's policy. `EffectContext` satisfies `EngineSink` structurally (`state`,
// `events`, `rng`), so `ctx` is passed straight through as the sink.
//
// NAMING. The card-facing spellings keep the "d" (`forcedAttacksOn`, `forcedAttacks`) where
// `../combat` spells them `forceAttacksOn`/`forceAttack`. That is deliberate: the effect returns an
// `Effect` and the engine function takes a sink, so one letter keeps a card file from importing the
// wrong one, and an import of both in this file reads unambiguously.

import { opponentOf } from "@jackioh/shared";
import { forceAttacksOn, type AttackTarget } from "../combat";
import { summonedSoFar } from "../prompts";
import type { Effect, EffectContext } from "../script";
import type { CardInstance } from "../state";
import { stateCheck } from "../stateCheck";
import { exitMark } from "../stays";
import { playOutTurn } from "../subsystems/aiPolicy";
import { SETTLE_PASS_CAP, dispatchPending, runQueuedTrigger, type SettleSink } from "../triggers";
import { paused } from "../work";
import { activeUnitsOf } from "../zones";
import { destroy } from "./destroy";
import { playerOf, resolveTarget, type PlayerSpec, type TargetSpec } from "./targets";

/** Which side's units are compelled. "any" is both, in R68's order (active side first). */
export type ForcedSide = PlayerSpec | "any";

/**
 * The units a forced attack may name, in lane order. `activeUnitsOf` is the lane-order walk §4.2's
 * last paragraph asks for, and it reports only the top card of a Stack pile, so a card dormant
 * underneath one neither attacks nor is hit (§3.2, R13).
 */
function attackersOf(ctx: EffectContext, side: ForcedSide): CardInstance[] {
  if (side !== "any") return activeUnitsOf(ctx.state, playerOf(ctx, side));
  const first = ctx.state.active;
  return [...activeUnitsOf(ctx.state, first), ...activeUnitsOf(ctx.state, opponentOf(first))];
}

/**
 * §6.3 Forced attack: "every enemy unit attacks this" (#9 Moths to the Flame). The named side's
 * active units attack the named target in lane order, and `forceAttacksOn` is the whole of R53 —
 * §4.2 steps 1 to 3 skipped (position, summoning sickness and Taunt all ignored), no exertion
 * spent, the target still striking back, each attack its own combat with its own state check, and
 * the run stopping as soon as the target has left the field. A target that resolves to nothing
 * fizzles silently and the card still resolves.
 */
export function forcedAttacksOn(args: { target: TargetSpec; attackers: ForcedSide }): Effect {
  return {
    kind: "forcedAttacksOn",
    apply(ctx): void {
      const target = resolveTarget(ctx, args.target);
      if (target === null) return;
      forceAttacksOn(ctx, attackersOf(ctx, args.attackers), target);
    },
  };
}

/** Which attackers #60 compels: a side, narrowed by definition and by "the ones I just made". */
export type ForcedAttackerFilter = {
  side?: ForcedSide;
  /** §7's token id, so "they" means the Rush Tokens rather than every unit on the side. */
  defId?: string;
  /** "the tokens THIS effect list just summoned" — see `freshlySummoned`. */
  summonedThisScript?: boolean;
};

/**
 * "summon 2 Rush Tokens; if it was a Unit, they attack it" (#60 Bear Honeypot). "They" is the
 * tokens this same effect list just summoned, not every Rush Token the controller happens to own.
 *
 * Nothing in state records that, and nothing needs to: the `summoned` events those summons pushed
 * are already in `ctx.events`, because an effect list appends to the sink's event array as it
 * applies and this effect runs after them. Reading the ids back out of `ctx.events` is therefore
 * pure, deterministic and replay-stable — the event list is the same on every fold of the log — and
 * it needs no new `GameState` field, no callback and no mutable scratch on the context.
 *
 * R136 closes the window `ctx.events` alone leaves open: the sink's list is the whole action's, so
 * a `summoned` event from something earlier in it — a second copy of a card, or a trap that fired
 * mid-action — would read as this script's own. `ctx.eventsFrom` is where this script's events
 * begin, set by `resolve.makeContext` when the context was built, so the walk starts there and a
 * card reads only what it did itself. A context that carries no mark — only a hand-built literal in
 * a test — falls back to 0, the whole action, which is what this read did before R136.
 */
function freshlySummoned(ctx: EffectContext): Set<string> {
  // A list a prompt split resumes in a later action, whose event list begins after the pause, so
  // what its head summoned comes with the continuation (`prompts.summonedSoFar`, R113).
  return new Set(summonedSoFar(ctx));
}

/** #60 names its target by the instance id its trigger read off the event (R42-style ids). */
export type ForcedTarget = { instanceId: string } | { spec: TargetSpec };

function targetOf(ctx: EffectContext, target: ForcedTarget): AttackTarget | null {
  // R174: the played unit #60 names by the id its trigger read is aimed at its stay as the run
  // began, so a unit the list took off the field before this effect is gone, Reborn body or not.
  if ("instanceId" in target) return resolveTarget(ctx, { of: "instance", instanceId: target.instanceId });
  return resolveTarget(ctx, target.spec);
}

/**
 * §6.3 Forced attack with a filtered attacker list (#60 Bear Honeypot). Same delegation as
 * `forcedAttacksOn`: this only decides who is named, and `forceAttacksOn` is all of R53. A target
 * that has already died during its own resolution simply is not on the field, so the run finds
 * nothing to attack and the tokens are left standing.
 */
export function forcedAttacks(args: { attackers: ForcedAttackerFilter; target: ForcedTarget }): Effect {
  return {
    kind: "forcedAttacks",
    apply(ctx): void {
      const target = targetOf(ctx, args.target);
      if (target === null) return;

      const fresh = args.attackers.summonedThisScript === true ? freshlySummoned(ctx) : null;
      const attackers = attackersOf(ctx, args.attackers.side ?? "self").filter((unit) => {
        if (args.attackers.defId !== undefined && unit.defId !== args.attackers.defId) return false;
        return fresh === null || fresh.has(unit.id);
      });

      // R174, R53: the run is the list's, so its stays are the ones the list began with — the tokens
      // it summoned are on them, and a target it took off the field is gone (`forceAttacksOn`).
      forceAttacksOn(ctx, attackers, target, ctx.exitsFrom ?? exitMark(ctx.state));
    },
  };
}

/**
 * §6.3 Cancel an attack and R44: inside §4.2 step 4's trap window, mark the open `declaredAttack`
 * cancelled so no combat resolves, and emit `attackCancelled` in its place. The attacker's
 * exertion was spent on the declaration, so the attack is gone either way — which is why nothing
 * here gives it back. The event names the card that cancelled, so a call with no `self` (nothing
 * for `byInstanceId` to be) fizzles silently rather than inventing a source.
 *
 * Marking the record is the whole of the verb: `combat.declareAttack` reads it back when the window
 * closes and skips step 5 (`resolveDeclaredAttack`). The window is the only moment there is
 * anything to mark — §6.3 says so, "call off an attack already declared, before any damage" — so
 * outside one this fizzles, which is also what keeps a trap that fires on some later dispatch of
 * the same declaration from cancelling a combat that has already happened.
 *
 * R121: a forced attack opens no window and writes no `declaredAttack`, so this can never cancel
 * one. That is the rule, not an omission (see `combat.forceAttack`).
 *
 * `destroyAttacker` (R283, Radiant #96) destroys the attacker of the attack this cancels, as part of
 * the cancel: an ordinary §6.3 destroy of the unit the declaration names, on the stay it declared
 * from (R174), so an Indestructible attacker is knocked down at the next check (R46) and a Reborn
 * one comes back. Tied to the cancel, it happens only where the cancel does — inside the window, on
 * an attack not yet cancelled — so a My Pawn fused onto a My Pawn, whose second half runs once the
 * first has played the turn out and the window has closed (R102), destroys nothing a second time.
 */
export function cancelAttack(args: { destroyAttacker?: boolean } = {}): Effect {
  return {
    kind: "cancelAttack",
    apply(ctx): void {
      const self = ctx.self;
      if (self === null) return;
      const open = ctx.state.declaredAttack;
      if (open === null || open.cancelled) return;

      open.cancelled = true;
      ctx.events.push({
        type: "attackCancelled",
        attackerId: open.attackerId,
        targetId: open.targetId,
        byInstanceId: self.id,
      });
      if (args.destroyAttacker === true) destroy({ target: { of: "instance", instanceId: open.attackerId } }).apply(ctx);
    },
  };
}

/**
 * R44 and R84: "an AI plays the rest of their turn with random legal actions" (#96 My Pawn). Two
 * steps, both somebody else's code. `aiTurn` on that player's `PlayerState` is the lockout R44
 * describes — the client refuses to act while it is set, and `turn.cleanup` clears it at the end of
 * the turn it was set for (R152; `startTurn` keeps a backstop clear) — and the turn itself goes to
 * `playOutTurn`, whose uniform draw over
 * `legalActions` minus `AI_SKIPPED_ACTIONS` IS §10.7's policy, `concede`, `offerDraw` and
 * `answerDraw` included out. Nothing here re-implements the policy or decides an action.
 *
 * `playOutTurn` drives `reduce`, which hands back a fresh state that `adoptState` copies into the
 * sink's object field by field: `ctx.state` stays the same object, but every instance inside it is
 * new afterwards, so no effect after this one may hold a `CardInstance` it read before it — `#96`'s
 * list ends here for that reason.
 *
 * `settleFirst` (R283, R59) settles the board once the lockout is set and before the AI's first
 * action. `destroy` only marks (§6.3), and the check that collects a mark runs after each whole
 * effect (R59) — which, for a list that ends in this effect, is inside the playout's first
 * `reduce`, after the AI has already chosen from a board that still holds the marked unit. Radiant
 * #96 destroys the attacker it stopped and then hands the turn over, and R283 has the AI take over a
 * settled board, so its face asks for `settleBeforePlayout` here: the check collects the attacker,
 * the traps answer what it said, and the ordinary triggers it woke resolve — a #89 Corpse Eater in
 * the AI's hand eats the attacker before the AI can play it (R212 would have it answer nothing
 * once it has moved). The destroy before this effect is whole, so this is R59's check between two
 * effects, never one between the hits of one. A check that ends the game ends the effect with it,
 * and a question it opens leaves the AI turn to `playOutTurn`, which owes it behind the answer.
 * Off by default, so every other list, base #96's included, plays out exactly as before.
 *
 * IMPORT CYCLE, deliberately static: this module → `../subsystems/aiPolicy` → `../reduce` →
 * `./playSteps` → `./effects` (the barrel) → this module. It is safe as written because the only
 * use of `playOutTurn` is inside `apply`, long after every module has evaluated, and because these
 * are hoisted function declarations under ESM live bindings. A lazy `import()` is not an option in
 * the first place: §9.3 and CLAUDE.md rule 4 ban a promise inside `reduce`. `../stateCheck` is
 * imported the same way `./destroy` imports it.
 */
export function aiPlaysOutTurn(args: { player?: PlayerSpec; settleFirst?: boolean } = {}): Effect {
  return {
    kind: "aiPlaysOutTurn",
    apply(ctx): void {
      const player = playerOf(ctx, args.player ?? "self");
      // "The rest of their turn": with no turn of theirs running there is nothing to hand over. A
      // #96 fused onto a #96 runs its second half after its first has played that turn out (R102),
      // and a lockout set then would fall on the other player's turn, which no My Pawn took (R152).
      if (ctx.state.active !== player || ctx.state.result !== null) return;
      ctx.state.players[player].aiTurn = true;
      if (args.settleFirst === true) {
        settleBeforePlayout(ctx);
        if (ctx.state.result !== null) return;
      }
      playOutTurn(ctx, player);
    },
  };
}

/**
 * R283: what the list before an AI turn has done, settled before the AI acts — the state check, the
 * traps' answers to its events, and the ordinary triggers those events woke, each followed by the
 * check again (§10.3, §4.5, R59) — as the loop settles between two actions of a turn, which the AI's
 * are. Only the triggers woken here run: whatever the enclosing action had queued before this list
 * keeps its place and waits for that action's own loop (R117). Stops at a question or a result.
 */
function settleBeforePlayout(ctx: EffectContext): void {
  const sink: SettleSink = ctx;
  const waiting = new Set(ctx.state.triggerQueue.map((entry) => entry.id));
  for (let pass = 0; pass < SETTLE_PASS_CAP; pass += 1) {
    stateCheck(sink);
    if (ctx.state.result !== null || paused(sink)) return;
    dispatchPending(sink);
    if (ctx.state.result !== null || paused(sink)) return;
    const at = ctx.state.triggerQueue.findIndex((entry) => !waiting.has(entry.id));
    if (at < 0) return;
    const [woken] = ctx.state.triggerQueue.splice(at, 1);
    if (woken !== undefined) runQueuedTrigger(sink, woken);
  }
  throw new Error(`the board before the AI turn did not settle in ${SETTLE_PASS_CAP} passes (R283)`);
}
