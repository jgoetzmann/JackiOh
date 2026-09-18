// Combo-Index (SPEC §8 #93, R27): the grade counter, its end-of-turn threshold and the E→S cascade.
//
// The grade is state, not script: it lives in `instance.counters.grade` as 1..6 for E..S (§10.1),
// so a paused game, a replay and `viewFor` all read the same number, and the letter comes from
// `GRADES` here. At the end of its controller's turn — an ordinary end-of-turn trigger (§10.3,
// R62) — the card compares the cards that player has played this turn with the current grade: at
// `cardsPlayed >= grade` the grade rises by one and every step from E up to the new grade runs, in
// order (R27). Grade S is terminal, so at S the check does nothing at all, and the S step is "run
// E–A again", which is the one extra round the cascade ever does.
//
// The card file (M4) stays a list of effects: `endOfTurn: (ctx) => comboIndexEndOfTurn(ctx, ctx.self)`.
// Every step is an effect from `../effects`; the only direct state change here is the counter
// itself, because no effect in the library owns `counters.grade`. The radiant text ("Start of
// turn: add a Combo-Fodder to your hand", §8) is one `addToHand` on the card's own `startOfTurn`
// hook and waits for the catalog id of #93.1, so it lives in the card file, not here.

import type { PlayerId } from "@jackioh/shared";
import { opponentOf } from "@jackioh/shared";
import { addToHand, damage, exile, setCostMod, setRadiantRandom } from "../effects";
import type { EngineSink } from "../resolve";
import type { Effect, EffectContext } from "../script";
import { findInstance, type CardInstance, type GameState } from "../state";

/** §8 #93: the six grades, in the order the cascade runs them. */
export const GRADES = ["E", "D", "C", "B", "A", "S"] as const;

export type Grade = (typeof GRADES)[number];

/** E: where a Combo-Index starts (§8 #93). */
export const FIRST_GRADE = 1;
/** S: the terminal grade (R27). */
export const LAST_GRADE = GRADES.length;

/** Grade D: "2 different random hand cards cost 1 less" (§8 #93). */
export const GRADE_D_CARDS = 2;
export const GRADE_D_DISCOUNT = 1;
/** Grade A: "8 damage to the enemy hero with Lifesteal" (§8 #93). */
export const GRADE_A_DAMAGE = 8;

function clampGrade(grade: number): number {
  return Math.min(Math.max(Math.trunc(grade), FIRST_GRADE), LAST_GRADE);
}

/** The letter a grade number shows, for the card file and for `viewFor` (§10.8). */
export function gradeName(grade: number): Grade {
  return GRADES[clampGrade(grade) - 1] ?? "E";
}

/** The number a letter stands for, so a test or a tooltip can say "A" and mean 5. */
export function gradeValue(name: Grade): number {
  const at = GRADES.indexOf(name);
  return at < 0 ? FIRST_GRADE : at + 1;
}

/** §10.1: the counter is the whole model, and an instance that never set one is at E. */
export function gradeOf(instance: CardInstance): number {
  return clampGrade(instance.counters.grade ?? FIRST_GRADE);
}

export function gradeNameOf(instance: CardInstance): Grade {
  return gradeName(gradeOf(instance));
}

/** R27: "grade S is terminal", so at S nothing rises and no step runs. */
export function isTerminalGrade(grade: number): boolean {
  return clampGrade(grade) >= LAST_GRADE;
}

/** The bookkeeping §10.5 step 4 keeps; `startTurn` clears it, so it is this turn's count alone. */
export function playsThisTurn(state: GameState, player: PlayerId): number {
  return state.players[player].turnLog.cardsPlayed;
}

/**
 * The cards this player played this turn that a copy can still be made from. `turnLog.playedIds`
 * holds instance ids (§10.1), so a card that has ceased to exist — a unit token that left the
 * field (R11) — leaves nothing to copy.
 *
 * R86: such an id drops out of the pool instead of staying in it and making the E step fizzle at
 * random, following R60's shape for a random pick over existing cards ("or all of them if fewer
 * exist"): "a card you played this turn" is the card, not the object that card left behind.
 */
export function playedCardsThisTurn(state: GameState, player: PlayerId): CardInstance[] {
  return state.players[player].turnLog.playedIds.flatMap((id) => {
    const card = findInstance(state, id);
    return card === undefined ? [] : [card];
  });
}

/**
 * Whether this end of turn raises the grade: not at S (R27), and only at or above the threshold.
 * "Cards played this turn" is the controller's own `turnLog` (§10.1) — the only per-turn record
 * there is — so a card the opponent cast during this turn counts on their log, not on this one.
 */
export function gradeRises(state: GameState, instance: CardInstance): boolean {
  const grade = gradeOf(instance);
  if (isTerminalGrade(grade)) return false;
  return playsThisTurn(state, instance.controller) >= grade;
}

function writeGrade(ctx: EffectContext, card: CardInstance, next: number): void {
  const value = clampGrade(next);
  if (value === gradeOf(card) && card.counters.grade !== undefined) return;
  card.counters.grade = value;
  ctx.events.push({ type: "counterChanged", instanceId: card.id, counter: "grade", value });
}

function cardOf(ctx: EffectContext, instanceId?: string): CardInstance | null {
  if (instanceId === undefined) return ctx.self;
  return findInstance(ctx.state, instanceId) ?? null;
}

/**
 * "Grade counter, starts at E" (§8 #93): write the counter as the card arrives, so the client has
 * a grade to show before the first end of turn. Reading a Combo-Index that never ran this still
 * gives E, because `gradeOf` defaults to it.
 */
export function startGrade(args: { instanceId?: string } = {}): Effect {
  return {
    kind: "comboIndexStartGrade",
    apply(ctx): void {
      const card = cardOf(ctx, args.instanceId);
      if (card === null) return;
      writeGrade(ctx, card, FIRST_GRADE);
    },
  };
}

/**
 * The one direct state change this subsystem owns: the grade counter itself (§10.1). Nothing else
 * in the effects library writes `counters.grade`, and R27 caps it at S.
 */
export function raiseGrade(args: { instanceId?: string; to?: number } = {}): Effect {
  return {
    kind: "comboIndexRaiseGrade",
    apply(ctx): void {
      const card = cardOf(ctx, args.instanceId);
      if (card === null) return;
      const grade = gradeOf(card);
      if (isTerminalGrade(grade)) return;
      writeGrade(ctx, card, args.to ?? grade + 1);
    },
  };
}

/**
 * Name one existing card for an effects-library `TargetSpec`. The library resolves `{ of: "chosen" }`
 * against `ctx.targets` (R81), so a random pick this subsystem made is handed over as the selection
 * it would have been if a player had picked it, and the library effect does the work (CLAUDE.md
 * rule 5: nothing here duplicates an effect that already exists).
 */
function naming(ctx: EffectContext, card: CardInstance): EffectContext {
  return { ...ctx, targets: [{ pick: "instance", instanceId: card.id }] };
}

/**
 * Grade E: "add a copy of a random card played this turn to your hand". R27 makes it a fresh copy
 * with the radiant flag kept, which is exactly what `addToHand` builds (R57: a fresh instance
 * carrying only the radiant flag). The pick happens when the step runs, so the second E of an S
 * cascade re-reads the turn log.
 */
export function stepE(): Effect {
  return {
    kind: "comboIndexStepE",
    apply(ctx): void {
      const played = playedCardsThisTurn(ctx.state, ctx.controller);
      const card = ctx.rng.pick(played);
      if (card === undefined) return;
      addToHand({ defId: card.defId, player: "self", radiant: card.radiant }).apply(ctx);
    },
  };
}

/**
 * Grade D: "2 different random hand cards cost 1 less". R27 says the two are different and R60
 * gives all of them when fewer exist, which is what a shuffle-and-take does. The discount is a
 * `costMod` on the instance, so it travels with the card between zones (R78) and R65 applies it.
 */
export function stepD(): Effect {
  return {
    kind: "comboIndexStepD",
    apply(ctx): void {
      const hand = ctx.state.players[ctx.controller].hand;
      if (hand.length === 0) return;
      for (const card of ctx.rng.shuffle(hand).slice(0, GRADE_D_CARDS)) {
        setCostMod({ target: { of: "chosen" }, amount: -GRADE_D_DISCOUNT }).apply(naming(ctx, card));
      }
    },
  };
}

/**
 * Grade C: "the opponent exiles a random hand card". Random, so it is never a prompt (§10.6, R16's
 * shape for a discard), and the exile goes through the library effect, counters included (R55).
 */
export function stepC(): Effect {
  return {
    kind: "comboIndexStepC",
    apply(ctx): void {
      const hand = ctx.state.players[opponentOf(ctx.controller)].hand;
      const card = ctx.rng.pick(hand);
      if (card === undefined) return;
      exile({ target: { of: "chosen" } }).apply(naming(ctx, card));
    },
  };
}

/**
 * Grade B: "a random hand card becomes Radiant". R60 narrows the pool to the non-Radiant cards and
 * does nothing when none are left, which `setRadiantRandom` already implements.
 */
export function stepB(): Effect {
  return setRadiantRandom({ zones: "hand", count: 1, player: "self" });
}

/**
 * Grade A: "8 damage to the enemy hero with Lifesteal". §4.4 step 8 keys Lifesteal off the source's
 * keywords and #93 prints none, so the effect states it instead (R85): the pipeline heals the
 * controller by the amount that actually landed, after Armor and the Anti-oneshot cap (§4.4 steps 2
 * and 3), and by nothing at all when the hit was reduced to 0 (R63).
 */
export function stepA(): Effect {
  return damage({ to: { of: "enemyHero" }, amount: GRADE_A_DAMAGE, lifesteal: true });
}

/** The steps E–A, in cascade order; S is "run E–A again", so it is these five once more. */
const STEPS: readonly (() => Effect)[] = [stepE, stepD, stepC, stepB, stepA];

/** One grade's step (§8 #93). S runs E–A again and never itself, so this recursion is one deep. */
export function gradeStepEffects(grade: number): Effect[] {
  const value = clampGrade(grade);
  if (value === LAST_GRADE) return STEPS.map((step) => step());
  const step = STEPS[value - 1];
  return step === undefined ? [] : [step()];
}

/** R27: "steps run E→new grade in order". */
export function cascadeEffects(upTo: number): Effect[] {
  const top = clampGrade(upTo);
  const out: Effect[] = [];
  for (let grade = FIRST_GRADE; grade <= top; grade += 1) out.push(...gradeStepEffects(grade));
  return out;
}

/**
 * The card's end-of-turn hook (§2.2, R62): nothing at S (R27), nothing below the threshold, and
 * otherwise the rise followed by every step from E up to the new grade. The list is returned rather
 * than applied, so the whole cascade is one effect list to the resolution loop (§10.3, R59) and the
 * card file stays pure (CLAUDE.md rule 5).
 */
export function comboIndexEndOfTurn(sink: EngineSink, instance: CardInstance): Effect[] {
  if (!gradeRises(sink.state, instance)) return [];
  const next = gradeOf(instance) + 1;
  return [raiseGrade({ instanceId: instance.id, to: next }), ...cascadeEffects(next)];
}
