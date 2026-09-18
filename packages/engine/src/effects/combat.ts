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
import type { Effect, EffectContext } from "../script";
import { findInstance, type CardInstance, type GameState } from "../state";
import { playOutTurn } from "../subsystems/aiPolicy";
import { activeUnitsOf } from "../zones";
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
 * The one imprecision is honest and bounded: `ctx.events` is the sink's list for the whole action,
 * so a `summoned` event from something earlier in the same action is also in it. `defId` and the
 * side filter already narrow that, and a card that needs an exact per-script window would need the
 * engine to mark where its list began — reported, not faked here.
 */
function freshlySummoned(ctx: EffectContext): Set<string> {
  return new Set(
    ctx.events.flatMap((event) => (event.type === "summoned" ? [event.instanceId] : [])),
  );
}

/** #60 names its target by the instance id its trigger read off the event (R42-style ids). */
export type ForcedTarget = { instanceId: string } | { spec: TargetSpec };

function targetOf(ctx: EffectContext, target: ForcedTarget): AttackTarget | null {
  if ("instanceId" in target) {
    const found = findInstance(ctx.state, target.instanceId);
    return found === undefined ? null : { kind: "unit", instance: found };
  }
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

      forceAttacksOn(ctx, attackers, target);
    },
  };
}

/**
 * The attack §4.2 step 4's trap window is opened on. `GameState` does not carry this field yet —
 * see the gap note on `cancelAttack` — so it is read structurally through this narrow local type
 * rather than asserted into existence: the assertion below only adds an optional property to
 * `GameState`, introduces no `any` and no non-null assertion, and the `undefined` branch is the
 * only answer the engine gives today.
 */
type DeclaredAttack = { attackerId: string; targetId: string; cancelled?: boolean };
type WithDeclaredAttack = { declaredAttack?: DeclaredAttack };

function openDeclaredAttack(state: GameState): DeclaredAttack | null {
  return (state as GameState & WithDeclaredAttack).declaredAttack ?? null;
}

/**
 * §6.3 Cancel an attack and R44: inside §4.2 step 4's trap window, mark the open `declaredAttack`
 * cancelled so no combat resolves, and emit `attackCancelled` in its place. The attacker's
 * exertion was spent on the declaration, so the attack is gone either way — which is why nothing
 * here gives it back. The event names the card that cancelled, so a call with no `self` (nothing
 * for `byInstanceId` to be) fizzles silently rather than inventing a source.
 *
 * ENGINE GAP, and the reason the test for this verb is a known failure rather than a passing
 * tautology: `GameState` has no `declaredAttack` field, and `combat.declareAttack` calls
 * `resolveCombat` on the line after it pushes `attackDeclared`, so §4.2 step 4's window does not
 * exist — a trap sees the event only once the resolution loop dispatches it, which is after the
 * damage. The fix is three lines outside this file's ownership: add
 * `declaredAttack?: { attackerId, targetId, cancelled? }` to `GameState` (`src/state.ts`), and in
 * `declareAttack` (`src/combat.ts`) set it, hand `attackDeclared` to the traps with
 * `traps.fireTrapsFor(sink, event)`, then resolve combat only while `cancelled !== true` and clear
 * the field afterwards. Until then this verb is correct and inert.
 */
export function cancelAttack(): Effect {
  return {
    kind: "cancelAttack",
    apply(ctx): void {
      const self = ctx.self;
      if (self === null) return;
      const open = openDeclaredAttack(ctx.state);
      if (open === null || open.cancelled === true) return;

      open.cancelled = true;
      ctx.events.push({
        type: "attackCancelled",
        attackerId: open.attackerId,
        targetId: open.targetId,
        byInstanceId: self.id,
      });
    },
  };
}

/**
 * R44 and R84: "an AI plays the rest of their turn with random legal actions" (#96 My Pawn). Two
 * steps, both somebody else's code. `aiTurn` on that player's `PlayerState` is the lockout R44
 * describes — the client refuses to act while it is set, and only `turn.ts` clears it, at that
 * player's next turn start — and the turn itself goes to `playOutTurn`, whose uniform draw over
 * `legalActions` minus `AI_SKIPPED_ACTIONS` IS §10.7's policy, `concede`, `offerDraw` and
 * `answerDraw` included out. Nothing here re-implements the policy or decides an action.
 *
 * `playOutTurn` drives `reduce`, which hands back a fresh state that `adoptState` copies into the
 * sink's object field by field: `ctx.state` stays the same object, but every instance inside it is
 * new afterwards, so no effect after this one may hold a `CardInstance` it read before it — `#96`'s
 * list ends here for that reason.
 *
 * IMPORT CYCLE, deliberately static: this module → `../subsystems/aiPolicy` → `../reduce` →
 * `./playSteps` → `./effects` (the barrel) → this module. It is safe as written because the only
 * use of `playOutTurn` is inside `apply`, long after every module has evaluated, and because these
 * are hoisted function declarations under ESM live bindings. A lazy `import()` is not an option in
 * the first place: §9.3 and CLAUDE.md rule 4 ban a promise inside `reduce`.
 */
export function aiPlaysOutTurn(args: { player?: PlayerSpec } = {}): Effect {
  return {
    kind: "aiPlaysOutTurn",
    apply(ctx): void {
      const player = playerOf(ctx, args.player ?? "self");
      ctx.state.players[player].aiTurn = true;
      playOutTurn(ctx, player);
    },
  };
}
