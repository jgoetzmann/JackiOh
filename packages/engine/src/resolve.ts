// Running a card's script: build a context, apply the effects it returns, then finish the card.
// The full play pipeline of §10.5 arrives with M3; this is the part M1's draw and turn loop need.

import type { GameEvent, PlayerId, Selection } from "@jackioh/shared";
import { defOf } from "./catalog";
import {
  castTailOf,
  castTailResume,
  landAfterResolution,
  queueEchoRepeats,
  type CastTailPlan,
} from "./echo";
import type { Rng } from "./rng";
import type { Effect, EffectContext, Hook, Script } from "./script";
import { scriptOf } from "./scripts";
import { findInstance, type CardInstance, type GameState, type WorkItem } from "./state";
import { owe, parkWork, registerWorkHandler } from "./work";
import { firstFreeZone, placeOnField, removeFromAnyZone } from "./zones";

export type EngineSink = { state: GameState; events: GameEvent[]; rng: Rng };

export type HookOptions = {
  controller?: PlayerId;
  targets?: Selection[];
  modes?: string[];
  data?: Record<string, unknown>;
};

export function makeContext(sink: EngineSink, self: CardInstance | null, options: HookOptions = {}): EffectContext {
  return {
    state: sink.state,
    rng: sink.rng,
    events: sink.events,
    // R136: this script's own event window opens where the sink's list stands right now. Every
    // context is built here, so this is the one place the mark has to be taken; a resumed
    // continuation calls back through here and therefore opens a fresh window, not the one its
    // first pass had.
    eventsFrom: sink.events.length,
    controller: options.controller ?? self?.controller ?? sink.state.active,
    self,
    radiant: self?.radiant ?? false,
    targets: options.targets ?? [],
    modes: options.modes ?? [],
    x: self?.x ?? 0,
    embiggened: self?.embiggened ?? false,
    data: options.data ?? {},
  };
}

export function applyEffects(effects: readonly Effect[], ctx: EffectContext): void {
  for (const effect of effects) effect.apply(ctx);
}

export type HookName =
  | "cry"
  | "death"
  | "startOfGame"
  | "startOfTurn"
  | "endOfTurn"
  | "activate"
  | "onPlayHook";

function hookOf(script: Script, name: HookName): Hook | undefined {
  return script[name];
}

/**
 * Run one of a card's hooks. `cry` is also a spell's on-resolve hook (§10.9).
 *
 * This is the *non-resumable* runner: the whole effect list is applied here and now, so it is only
 * ever right on a path where no effect can open a prompt — an arrival hook (`startOfGame`), or a
 * caller that has already established there is nothing to ask. Any path whose effects may ask
 * something uses `prompts.runHookResumable` (a trigger, a play's Cry, an activate) or, where this
 * file's own layering forbids importing that, `applyHookResumable` below (a cast's Cry).
 */
export function runHook(
  sink: EngineSink,
  instance: CardInstance,
  name: HookName,
  options: HookOptions = {},
): void {
  const hook = hookOf(scriptOf(instance), name);
  if (hook === undefined) return;
  const ctx = makeContext(sink, instance, options);
  applyEffects(hook(ctx), ctx);
}

/**
 * Apply an effect list so that a prompt in the middle of it pauses the list instead of being stepped
 * over: the effects after the one that opened the prompt are parked as the same continuation plus
 * the index to continue from, which `work.ts` hands back to `prompts.runResume` through the default
 * card-continuation handler. Returns true when the whole list ran.
 *
 * This is `prompts.applyResumable`, and it is here rather than imported because `prompts.ts` imports
 * *this* file: `resolve.ts` sits below it, which is the same layering that makes a cast hand its
 * Echo tail to `playSteps.ts` as an owed work item rather than calling into it (`echo.ts`'s header).
 * The contract is the one `work.ts` documents — a hook is a pure builder (CLAUDE.md rule 5), so
 * re-entering it and skipping the effects that already ran continues the same sequence, and nothing
 * but plain JSON is held across the pause (§9.3, R113).
 */
function applyHookResumable(
  sink: EngineSink,
  instance: CardInstance,
  hookName: HookName,
  ctx: EffectContext,
  effects: readonly Effect[],
): boolean {
  for (let index = 0; index < effects.length; index += 1) {
    const before = sink.state.pending;
    effects[index]?.apply(ctx);

    const pending = sink.state.pending;
    if (pending === null || pending === before) continue;

    if (index + 1 < effects.length) {
      parkWork(
        sink,
        {
          defId: instance.defId,
          hook: hookName,
          step: "",
          radiant: instance.radiant,
          instanceId: instance.id,
          data: {},
          owner: ctx.controller,
        },
        { from: index + 1, targets: [...ctx.targets], modes: [...ctx.modes] },
      );
    }
    return false;
  }
  return true;
}

/** `runHook` for a hook whose effects may ask something. Returns true when the whole hook ran. */
function runHookPausable(
  sink: EngineSink,
  instance: CardInstance,
  name: HookName,
  options: HookOptions = {},
): boolean {
  const hook = hookOf(scriptOf(instance), name);
  if (hook === undefined) return true;
  const ctx = makeContext(sink, instance, options);
  return applyHookResumable(sink, instance, name, ctx, hook(ctx));
}

/** Counters and the event every play and cast shares (§10.5 step 4, R70). */
function countAsPlayed(sink: EngineSink, instance: CardInstance, costPaid: number): void {
  const side = sink.state.players[instance.controller];
  side.turnLog.playedIds.push(instance.id);
  side.turnLog.cardsPlayed += 1;
  sink.state.counters.played += 1;
  sink.events.push({
    type: "cardPlayed",
    player: instance.controller,
    instanceId: instance.id,
    defId: instance.defId,
    costPaid,
    ...(instance.x === undefined ? {} : { x: instance.x }),
    ...(instance.embiggened === undefined ? {} : { embiggened: instance.embiggened }),
  });
}

/**
 * §10.5 step 4 for a cast: "Move the card to the field (Units, Field Spells, Traps) or to a
 * resolving state (Spells)". A cast permanent therefore goes where its type sends it (§6.3's Cast
 * row) — the leftmost empty unlocked zone of its row, as a play that names none does (R64) — and
 * emits `summoned` with the `cardPlayed` of a play, because it did enter the field.
 *
 * A Spell, and a permanent with no room to land, wait in `resolving`, where `findInstance` can
 * still see them (R98) and where step 7 picks them up.
 */
function placeCast(sink: EngineSink, instance: CardInstance): void {
  const state = sink.state;
  const player = instance.controller;
  const def = defOf(state, instance.defId);

  // It leaves wherever it was first — a hand for a cast from hand, nowhere for one an effect made
  // (Call to Chaos) or drew (§2.4) — so it is never in two piles at once. Not `moveToZone`: that
  // resets the instance (R78) and a cast is a play, which does not.
  removeFromAnyZone(state, instance);

  const zone =
    def.type === "Spell"
      ? null
      : firstFreeZone(state, player, def.type === "Unit" ? "units" : "backrow");

  if (zone !== null && placeOnField(state, instance, zone)) {
    instance.summonedTurn = state.turn;
    return;
  }

  instance.zone = { z: "resolving", player };
  state.players[player].resolving.push(instance);
}

function summonedEvent(sink: EngineSink, instance: CardInstance): void {
  const zone = instance.zone;
  if (zone.z !== "field") return;
  sink.events.push({
    type: "summoned",
    player: zone.player,
    instanceId: instance.id,
    defId: instance.defId,
    row: zone.row,
    lane: zone.lane,
  });
}

/**
 * R70: a cast is free, counts as a play for everything that counts or reacts to plays, fires the
 * card's script, and then the card goes where its type sends it. Used by Cast on draw (§2.4) and by
 * Call to Chaos.
 *
 * The tail of a cast is §10.5's tail: step 6's Echo repeats — "a cast never uses a cost discount,
 * since it pays nothing, but a cast Spell does use Twinspell's Echo" (R70) — and only then step 7's
 * landing. `castTail` below is that tail, and there are two ways to reach it, because the Cry itself
 * can ask: a cast that resolves straight through falls into it here, while one whose Cry opens a
 * prompt owes it as a `CAST_CRY_WORK` item and the answer's drain runs it (R113, R122). Running it
 * over an open prompt is what this used to do, and it is the same class of bug as a sequence that
 * keeps its place in a local variable: step 6 queued the repeats and step 7 landed the card in its
 * graveyard while the caster was still being asked what the Cry should do (§9.3).
 *
 * What this does *not* do is run the resolution loop: `triggers.settle` lives above `prompts.ts`,
 * which imports this file, so a cast's own events are dispatched by whichever `settle` comes next,
 * exactly as they were before. A play dispatches its step 4 events inside step 4 (R17's trap
 * window); a cast leaves them on the sink for the caller's loop.
 */
export function castCard(sink: EngineSink, instance: CardInstance, options: HookOptions = {}): void {
  placeCast(sink, instance);
  countAsPlayed(sink, instance, 0);
  summonedEvent(sink, instance);

  const plan: CastTailPlan = {
    instanceId: instance.id,
    defId: instance.defId,
    controller: instance.controller,
    targets: [...(options.targets ?? [])],
    modes: [...(options.modes ?? [])],
  };

  // §10.6 and R81: a cast's script asks its own questions — Call to Chaos's recast (#95) and §2.4's
  // cast on draw (R58) both reach cards whose Cry prompts — so the Cry is resumable, and what
  // follows it is owed at the moment it pauses and never before (R113, R117).
  if (!runHookPausable(sink, instance, "cry", options)) {
    if (sink.state.result === null) oweCastTail(sink, plan);
    return;
  }

  castTail(sink, plan, instance);
}

/**
 * R113: the `resume.hook` of the work item a cast parks when its own Cry pauses — §10.5 step 6 and
 * what follows it, for a cast whose script stopped to ask. It is an engine sequence and not a
 * card's, so the name is one no `Script` can hold, and `runOwedCastTail` is registered for it at
 * module scope, in the module that owns the sequence and never from a test.
 *
 * It is not `echo.CAST_TAIL_WORK`: that item means "the repeats are already on `state.echoQueue`",
 * which `castCard` only knows once the Cry has finished, since `queueEchoRepeats` is step 6 and
 * consumes R30's grant exactly once.
 */
export const CAST_CRY_WORK = "@castCry";

const CAST_CRY_STEP = "tail";

function oweCastTail(sink: EngineSink, plan: CastTailPlan): void {
  owe(sink, { ...castTailResume(plan), hook: CAST_CRY_WORK, step: CAST_CRY_STEP });
}

/**
 * The tail of a cast: §10.5's step 6 (the Echo repeats R70 gives a cast Spell) and then step 7's
 * landing. A repeat can open prompts (§10.6, R81), which no sequence may span in a local variable
 * (§9.3), so when there are repeats to run the rest is owed to `state.work` and the play pipeline's
 * driver finishes it (R113; `echo.ts` explains why the hand-over is a work item rather than a call).
 * With nothing owed — the common case, since a repeat needs a printed `Echo X` or a Twinspell grant
 * waiting — the card lands here and the cast is over when this returns.
 *
 * R127: a cast resumed after a pause names its card by the plan's stored ids, so a Cry that unmade
 * its own card still lands the resolution: the `cardResolved` of step 7 names what resolved whether
 * or not the instance is still there to be found.
 */
function castTail(sink: EngineSink, plan: CastTailPlan, instance?: CardInstance): void {
  const card = instance ?? findInstance(sink.state, plan.instanceId);

  if (card !== undefined && queueEchoRepeats(sink, card, plan.controller) > 0) {
    owe(sink, castTailResume(plan));
    return;
  }

  landAfterResolution(sink, {
    instanceId: plan.instanceId,
    defId: plan.defId,
    player: plan.controller,
    // R70: "a cast is free … with cost paid 0" — the same 0 `countAsPlayed` gave `cardPlayed`
    // above, so #60 Bear Honeypot's "costing 1 or less" admits every cast card (R56).
    costPaid: 0,
  });
  // R70: a cast "counts as a play for everything that counts or reacts to plays", and §5.1's flag
  // is one of those. A cast with Echo repeats owed parks instead and is flagged by the play
  // pipeline's own step 7, which is the driver that finishes that tail.
  flagReturnToHandAtEndOfTurn(sink.state, plan.instanceId);
}

/** `work.ts`'s handler for a cast whose Cry paused: the same cast, continued where it stopped. */
function runOwedCastTail(sink: EngineSink, item: WorkItem): void {
  const plan = castTailOf(item.resume);
  if (plan === null) return;
  castTail(sink, plan);
}

registerWorkHandler(CAST_CRY_WORK, runOwedCastTail);

/**
 * §5.1 and R155: "Spells with 'End of turn: add this back to your hand' are flagged
 * `returnToHandAtEndOfTurn` when played and return from the graveyard at the end of that turn".
 * This is that flag, written at the one moment §10.5 describes — step 7, as the Spell lands in the
 * graveyard — so the card carries its own answer and nothing has to infer it later.
 *
 * The three conditions are step 7's own sentence, in order. It must be a Spell: a Unit with an
 * `endOfTurn` hook (#13 Jlockeed Shredder-10) that was played and died on the turn it was played is
 * in the graveyard too, and it must not return from there (R153). Its resolving face must declare
 * an end-of-turn return, which for a Spell is exactly an `endOfTurn` hook — #23 Reoccurring Dream,
 * #24 Efficiency Dividend and #31 KY's Math Equation are the only three in Core, and the only
 * `endOfTurn` a Spell can have, since R153 gives a graveyard no other hook. And it must have
 * reached the **graveyard**: a Spell that says "exile this on play" (#39 Recycling Initiative) is
 * not in the graveyard when step 7 is done, so it is never flagged and never comes back.
 *
 * `turn.cleanup` clears it at the end of that turn, which is what makes the flag mean "this turn"
 * rather than "for ever" — a flagged card that returns to hand and is later discarded into the
 * graveyard must stay there (R153).
 */
export function flagReturnToHandAtEndOfTurn(state: GameState, instanceId: string): void {
  const card = findInstance(state, instanceId);
  if (card === undefined) return;
  if (card.zone.z !== "graveyard") return;
  if (defOf(state, card.defId).type !== "Spell") return;
  if (scriptOf(card).endOfTurn === undefined) return;
  card.returnToHandAtEndOfTurn = true;
}
