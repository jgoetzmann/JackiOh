// Running a card's script: build a context, apply the effects it returns, then finish the card.
// The full play pipeline of §10.5 arrives with M3; this is the part M1's draw and turn loop need.

import type { GameEvent, PlayerId, Selection } from "@jackioh/shared";
import { defOf } from "./catalog";
import type { Rng } from "./rng";
import type { Effect, EffectContext, EffectPart, Hook, Script } from "./script";
import { scriptOf } from "./scripts";
import { findInstance, type CardInstance, type GameState } from "./state";
import { exitMark } from "./stays";

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
    // R174: the stay every card on the field has as this script begins.
    exitsFrom: exitMark(sink.state),
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

/**
 * Apply an effect list in order. R216: once a state check inside the list has ended the game — a
 * cast on draw that killed its own hero, halfway through #5 Stockpile's "draw 2; heal your hero 2" —
 * the rest of the list does not resolve: the game is over (§2.5), and nothing happens after it.
 */
export function applyEffects(effects: readonly Effect[], ctx: EffectContext): void {
  for (const effect of effects) {
    if (ctx.state.result !== null) return;
    effect.apply(ctx);
  }
}

/**
 * A part of a composed list (`Effect.expand`), built when the list reaches it rather than when the
 * list is made (R102). Applied on its own it builds and applies its effects in one go; inside
 * `prompts.applyResumable` it runs as a nested list a prompt can pause.
 */
export function lazyPart(kind: string, expand: (ctx: EffectContext, memo: unknown) => EffectPart): Effect {
  return {
    kind,
    expand,
    apply(ctx): void {
      applyEffects(expand(ctx, undefined).effects, ctx);
    },
  };
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
 * something uses `prompts.runHookResumable` (a trigger, a play's or a cast's Cry, an activate).
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
 * The play pipeline, as a cast enters it (R70). `playSteps.ts` owns §10.5 and registers this at
 * module scope, like a work handler (`work.registerWorkHandler`) or a card script
 * (`scripts.registerScripts`): it sits above `prompts.ts`, which imports this file, so the layering
 * forbids calling it directly.
 */
export type CastDriver = (sink: EngineSink, instance: CardInstance, options: HookOptions) => void;

let castDriver: CastDriver | undefined;

/** Registered by `playSteps.ts` at module scope. Returns the driver it replaced. */
export function registerCastDriver(driver: CastDriver | undefined): CastDriver | undefined {
  const previous = castDriver;
  castDriver = driver;
  return previous;
}

/**
 * R70: "a cast is free and counts as a play for every rule that counts or reacts to plays, with
 * cost paid 0", fires the card's script, and "a cast Spell does use Twinspell's Echo". So a cast IS
 * §10.5's pipeline, entered after the two steps a cast skips — step 1 has nothing to validate, since
 * the effect chose the card, and step 2 pays nothing — and run through the same named steps as a
 * play from hand: step 3's Gifted Program hook (#64), step 4's placement, counters and `cardPlayed`
 * with the Echo gained as it is played (R178), step 5's Quickstriker (#38) and /fullsend Combo draw
 * (#78) before the card's own script, step 6's repeats and step 7's landing and `cardResolved`.
 *
 * Its own path used to stop short of that: it skipped steps 3 and 5's granted parts outright, and
 * owed steps 6 and 7 to `state.work` even when nothing had paused (against R117), so a cast-on-draw
 * Spell's Echo repeat resolved after the draw had already repeated (§2.4). The one difference from a
 * play is where the resolution loop runs: a cast happens inside some other effect — §2.4's draw,
 * #95's recursion — so it settles nothing itself and leaves its events to that effect's loop, and
 * §2.4's chain runs the state check after each cast-on-draw cast (§4.5, R59).
 *
 * Used by Cast on draw (§2.4) and by Call to Chaos.
 */
export function castCard(sink: EngineSink, instance: CardInstance, options: HookOptions = {}): void {
  if (castDriver === undefined) {
    throw new Error("no cast driver is registered: import the play pipeline (§10.5, R70)");
  }
  castDriver(sink, instance, options);
}

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
