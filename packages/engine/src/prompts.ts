// Prompts: `state.pending`, the ten kinds of SPEC §10.6, and the serializable continuation that
// makes answering one re-enter the script that asked (BUILD M3-T3).
//
// §9.3: "Mid-action choices are state, not callbacks." Nothing here ever puts a function in state.
// A paused sequence is named by two plain records instead:
//
//  1. `state.pending.resume` — script id, hook, step name, radiant face, instance and the data
//     the earlier steps captured. Answering re-enters exactly that step with the selection in
//     `ctx.targets`, which is where `effects/choose.ts` and its `chosenOptions` read it (§10.6).
//     Chained prompts are just a step that opens the next one: Private Tutor's three steps, Craft
//     a Card's two Discovers and radiant Masochism Mask's two picks are all this and nothing more.
//  2. `state.work` — the *remainder* of an effect list that a prompt interrupted, as a `WorkItem`
//     naming the same continuation plus the index to continue from, so a script that opens a
//     prompt in the middle of its list neither restarts nor drops the rest. `work.ts` owns that
//     queue: this module parks through `work.parkWork` and never touches `state.work` itself, so
//     one place decides the order a cascade resumes in (R113's cursor) and one place decides what
//     each owed item means. A card's own continuation is the default work handler, registered at
//     the bottom of this file the way a card registers a script.
//
// Both survive `JSON.parse(JSON.stringify(state))`, which is what makes a prompt identical in live
// play, in a replay and in a test. Option data lives only in `state.pending.options` and is
// mirrored nowhere else, so §10.8's `viewFor` has exactly one place to hide from the opponent.
//
// This module runs no state check and dispatches no trigger: `triggers.settle` owns the resolution
// loop of §10.3 and calls in here (R59). Answering does drain `state.work`, because continuing what
// the prompt interrupted is part of the answer rather than a later reaction to it (R113): §10.6's
// "`answer` re-invokes the script with the selection" is only true of the whole sequence if the
// remainder the pause parked runs too, and a caller that answers a prompt without going through
// `reduce` (the pipeline's own tests, a server that drives the engine directly) would otherwise
// leave a Spell short of its graveyard. The drain is `work.drainWork`, so the order is R113's and
// the queue is still the one `work.ts` owns; `settle` drains again and finds nothing left.

import type { ActionBody, PlayerId, PromptKind, Selection } from "@jackioh/shared";
import { makeContext, type EngineSink } from "./resolve";
import type { Effect, EffectContext, Hook, Script } from "./script";
import { scriptsFor } from "./scripts";
import { findInstance, type PendingChoice, type PromptOption, type Resume } from "./state";
import {
  cardData,
  drainWork,
  parkWork,
  pausedOf,
  registerDefaultWorkHandler,
  type WorkPlan,
} from "./work";

/** The ten kinds of §10.6. `x`, `embiggen`, `zone`, `tribute` and `direction` are play choices for
 * every Core card (R81) and stay here for later sets; nothing in this module reads the kind except
 * the mulligan, which §2.1 answers with its own action. */
export const PROMPT_KINDS: readonly PromptKind[] = [
  "discover",
  "target",
  "mode",
  "mulligan",
  "hand",
  "zone",
  "tribute",
  "direction",
  "x",
  "embiggen",
];

/** The `Script` key holding the step table a prompt answer re-enters (`resume: { picked: … }`). */
export const RESUME_HOOK = "resume";

/** Enumerating answers is bounded like `legalActions`'s other combinations (R90). */
export const MAX_PROMPT_ANSWERS = 256;

/**
 * `state.ts`'s `Resume` is the serializable continuation of §10.6 — "script id + step + captured
 * data", never a closure. Its `hook` names a key of the card's `Script`: a step table (`resume`,
 * so `step` picks the entry) or a hook of its own (`cry`, `delayed`, … , and then `step` only
 * labels the pause). Nothing in this module adds a field to it that a JSON round-trip would lose.
 *
 * A plan is that record plus the player whose sequence it is, which is what parking one needs:
 * `work.WorkPlan` under the name the effect side reads it by.
 */
export type ResumePlan = WorkPlan;

export type OpenPromptArgs = {
  player: PlayerId;
  kind: PromptKind;
  prompt: string;
  options: readonly PromptOption[];
  /** Defaults to one pick (§10.6). */
  min?: number;
  max?: number;
  resume: Resume;
};

/** The `answer` action of §10.2, without the parts the reducer has already checked. */
export type AnswerInput = {
  playerId: PlayerId;
  choiceId: string;
  selection: readonly Selection[];
};

export type ResumeOptions = {
  /** The answering player for a prompt, the owner for parked work. */
  controller?: PlayerId;
  targets?: readonly Selection[];
  modes?: readonly string[];
};

// ---------------------------------------------------------------------------
// The stored records
// ---------------------------------------------------------------------------

/**
 * The continuation a `PendingChoice`, `WorkItem`, `QueuedTrigger` or `DelayedEffect` carries, with
 * the defaults a hand-built or older record may be missing filled in, so every reader of a stored
 * resume sees the same shape (`playSteps` reads its own payload out of `data`).
 */
export function resumeOf(holder: { resume: Resume }): Resume {
  const raw = holder.resume;
  return {
    defId: raw.defId ?? "",
    hook: raw.hook ?? RESUME_HOOK,
    step: String(raw.step ?? ""),
    radiant: raw.radiant === true,
    ...(raw.instanceId === undefined ? {} : { instanceId: raw.instanceId }),
    data: raw.data ?? {},
  };
}

/** §10.6: a step names itself, so a card file says `step: "picked"` and nothing more. */
export function resumeAt(args: {
  defId: string;
  step: string;
  hook?: string;
  radiant?: boolean;
  instanceId?: string;
  data?: Record<string, unknown>;
}): Resume {
  return {
    defId: args.defId,
    hook: args.hook ?? RESUME_HOOK,
    step: args.step,
    radiant: args.radiant === true,
    ...(args.instanceId === undefined ? {} : { instanceId: args.instanceId }),
    data: cardData(args.data ?? {}),
  };
}

/**
 * The continuation of the script that is running now: the same card, the same face, and the data
 * this chain has captured so far plus whatever this step adds. A Spell resolving with no instance
 * (`ctx.self === null`) still names its definition's script.
 */
export function resumeSelf(
  ctx: EffectContext,
  step: string,
  data: Record<string, unknown> = {},
): Resume {
  const self = ctx.self;
  return resumeAt({
    defId: self?.defId ?? "",
    step,
    radiant: ctx.radiant,
    ...(self === null ? {} : { instanceId: self.id }),
    data: { ...cardData(ctx.data), ...data },
  });
}

// ---------------------------------------------------------------------------
// Opening and closing
// ---------------------------------------------------------------------------

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value));
}

/**
 * Open the one prompt §10.1 allows. Returns the choice, or null when there is nothing to ask:
 * no options (the effect fizzles and the card still resolves, §6.3) or a prompt already open, so a
 * second ask can never overwrite an unanswered one — a script that asks twice chains steps.
 */
export function openPrompt(sink: EngineSink, args: OpenPromptArgs): PendingChoice | null {
  const state = sink.state;
  if (state.pending !== null) return null;
  if (args.options.length === 0) return null;

  const max = clamp(args.max ?? 1, 0, args.options.length);
  const pending: PendingChoice = {
    id: `q${state.nextId}`,
    playerId: args.player,
    kind: args.kind,
    prompt: args.prompt,
    options: args.options.map((option) => ({ ...option })),
    min: clamp(args.min ?? 1, 0, max),
    max,
    resume: args.resume,
  };

  state.nextId += 1;
  state.pending = pending;
  sink.events.push({
    type: "promptOpened",
    player: args.player,
    choiceId: pending.id,
    kind: args.kind,
  });
  return pending;
}

/** Clear the open prompt and say so (§10.10 animates `promptAnswered`). */
export function closePrompt(sink: EngineSink): PendingChoice | null {
  const pending = sink.state.pending;
  if (pending === null) return null;
  sink.state.pending = null;
  sink.events.push({ type: "promptAnswered", player: pending.playerId, choiceId: pending.id });
  return pending;
}

// ---------------------------------------------------------------------------
// Answering
// ---------------------------------------------------------------------------

function sameSelection(a: Selection, b: Selection): boolean {
  switch (a.pick) {
    case "instance":
      return b.pick === "instance" && a.instanceId === b.instanceId;
    case "hero":
      return b.pick === "hero" && a.player === b.player;
    case "mode":
      return b.pick === "mode" && a.option === b.option;
    case "zone":
      return b.pick === "zone" && a.player === b.player && a.row === b.row && a.lane === b.lane;
    case "none":
      return b.pick === "none";
    default:
      return false;
  }
}

function nameOf(selection: Selection): string {
  switch (selection.pick) {
    case "instance":
      return selection.instanceId;
    case "hero":
      return `${selection.player}'s hero`;
    case "mode":
      return selection.option;
    case "zone":
      return `${selection.player} ${selection.row} ${selection.lane}`;
    case "none":
      return "nothing";
    default:
      return "that selection";
  }
}

/**
 * Why an `answer` is not a legal answer to the open prompt, or null when it is. Only what
 * `options` offered may be picked, each option at most once, and the count must sit inside
 * `min`/`max` (M3-T3: "an `answer` with an option not in `options` errors"; R60: N picks are N
 * different cards).
 */
export function whyAnswerRefused(pending: PendingChoice, answer: AnswerInput): string | null {
  if (pending.kind === "mulligan") return "a mulligan is answered with the mulligan action (§2.1)";
  if (answer.choiceId !== pending.id) return `no prompt ${answer.choiceId} is open`;
  if (pending.playerId !== answer.playerId) return "that prompt belongs to the other player";

  const picks = answer.selection;
  if (picks.length < pending.min || picks.length > pending.max) {
    return pending.min === pending.max
      ? `that prompt takes exactly ${pending.min} pick${pending.min === 1 ? "" : "s"}, got ${picks.length}`
      : `that prompt takes ${pending.min} to ${pending.max} picks, got ${picks.length}`;
  }

  const used = new Set<number>();
  for (const pick of picks) {
    const matches = pending.options.flatMap((option, index) =>
      sameSelection(option.selection, pick) ? [index] : [],
    );
    if (matches.length === 0) return `${nameOf(pick)} is not one of the options offered`;
    const free = matches.find((index) => !used.has(index));
    if (free === undefined) return `${nameOf(pick)} is picked twice`;
    used.add(free);
  }
  return null;
}

/**
 * §10.6: "`answer` re-invokes the script with the selection." Validate, close the prompt and
 * re-enter the step its `resume` names with the selection in `ctx.targets`. Returns an error
 * message for the reducer, or null.
 *
 * It runs that one step and then continues what the prompt interrupted: the remainder parked in
 * `state.work` is drained in R113's order (innermost first, and a pause inside this step lands
 * ahead of everything older), so one answer finishes one sequence. Draining stops at the next
 * prompt, which parks its own tail, so the rest keeps waiting in state. The state check and the
 * trigger queue stay with `triggers.settle`, which drains again and finds nothing owed (R59).
 */
export function answerPrompt(sink: EngineSink, answer: AnswerInput): string | null {
  const pending = sink.state.pending;
  if (pending === null) return "no prompt is open";

  const refused = whyAnswerRefused(pending, answer);
  if (refused !== null) return refused;

  closePrompt(sink);
  runResume(sink, resumeOf(pending), {
    controller: pending.playerId,
    targets: [...answer.selection],
  });
  drainWork(sink);
  return null;
}

/**
 * Every answer the open prompt would accept, for `legalActions` and the §10.7 policy that draws
 * from it (M3-T3: "`legalActions` lists every option"). Options are taken in the order they were
 * offered, so the list is the same on every machine; a mulligan has its own action and is not
 * enumerated here.
 */
export function promptAnswers(pending: PendingChoice): Extract<ActionBody, { type: "answer" }>[] {
  if (pending.kind === "mulligan") return [];

  const out: Extract<ActionBody, { type: "answer" }>[] = [];
  const emit = (options: PromptOption[]): boolean => {
    out.push({
      type: "answer",
      choiceId: pending.id,
      selection: options.map((option) => option.selection),
    });
    return out.length < MAX_PROMPT_ANSWERS;
  };

  const walk = (start: number, chosen: PromptOption[], size: number): boolean => {
    if (chosen.length === size) return emit(chosen);
    for (let index = start; index < pending.options.length; index += 1) {
      const option = pending.options[index];
      if (option === undefined) continue;
      if (!walk(index + 1, [...chosen, option], size)) return false;
    }
    return true;
  };

  for (let size = pending.min; size <= pending.max; size += 1) {
    if (!walk(0, [], size)) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Re-entering a script
// ---------------------------------------------------------------------------

function faceOf(defId: string, radiant: boolean): Script {
  const scripts = scriptsFor(defId);
  return radiant ? scripts.radiant : scripts.base;
}

/**
 * The hook a continuation names: a step out of a table (`resume: { picked: … }`) or a hook of the
 * card's own (`cry`, `delayed`). Nothing registered is not an error — the answer just closed the
 * prompt (§10.6) — so this returns undefined rather than throwing.
 */
function hookFor(script: Script, resume: Resume): Hook | undefined {
  const entry: unknown = (script as unknown as Record<string, unknown>)[resume.hook];
  if (typeof entry === "function") return entry as Hook;
  if (entry === null || typeof entry !== "object") return undefined;
  const step: unknown = (entry as Record<string, unknown>)[resume.step];
  return typeof step === "function" ? (step as Hook) : undefined;
}

/**
 * Apply an effect list so that a prompt in the middle of it pauses the list instead of being
 * stepped over: the effects after the one that opened the prompt are parked as a work item naming
 * this same continuation and the index to continue from. Returns true when the whole list ran.
 *
 * A hook is a pure builder (CLAUDE.md rule 5), so re-entering it and skipping the effects that
 * already ran continues the sequence exactly; the alternative — holding the remaining `Effect[]`
 * in state — would be holding closures, which §9.3 forbids.
 */
export function applyResumable(
  sink: EngineSink,
  ctx: EffectContext,
  plan: ResumePlan,
  effects: readonly Effect[],
  from = 0,
): boolean {
  for (let index = Math.max(0, from); index < effects.length; index += 1) {
    const before = sink.state.pending;
    effects[index]?.apply(ctx);

    const pending = sink.state.pending;
    if (pending === null || pending === before) continue;

    if (index + 1 < effects.length) {
      parkWork(sink, plan, {
        from: index + 1,
        targets: [...ctx.targets],
        modes: [...ctx.modes],
      });
    }
    return false;
  }
  return true;
}

/**
 * Re-enter the continuation a `Resume` names and apply what its step returns: the answered step of
 * a prompt, a delayed effect at its R62 point, a queued trigger, or a parked tail. Returns true
 * when the step ran to the end, false when a prompt paused it again.
 *
 * The face is the one the pause recorded (§5.2), not whatever the instance is now, so a chain of
 * steps runs the text that started it. An instance that has ceased to exist resumes with
 * `ctx.self === null`, which is why a step carries what it needs in `data`.
 */
export function runResume(
  sink: EngineSink,
  resume: Resume,
  options: ResumeOptions = {},
): boolean {
  const paused = pausedOf(resume.data);
  const data = cardData(resume.data);
  const instance =
    resume.instanceId === undefined ? null : findInstance(sink.state, resume.instanceId) ?? null;

  const hook = hookFor(faceOf(resume.defId, resume.radiant), resume);
  if (hook === undefined) return true;

  const ctx: EffectContext = {
    ...makeContext(sink, instance, {
      controller: options.controller ?? instance?.controller,
      targets: [...(options.targets ?? paused?.targets ?? [])],
      modes: [...(options.modes ?? paused?.modes ?? [])],
      data,
    }),
    radiant: resume.radiant,
  };

  const plan: ResumePlan = { ...resume, data, owner: ctx.controller };
  return applyResumable(sink, ctx, plan, hook(ctx), paused?.from ?? 0);
}

/**
 * Run one of a card's own hooks the resumable way: the drop-in for `resolve.runHook` on any path
 * whose effects may open a prompt (a Cry, a trigger, an activate). Returns true when the whole
 * hook ran.
 */
export function runHookResumable(
  sink: EngineSink,
  instance: { id: string; defId: string; controller: PlayerId; radiant: boolean },
  hookName: string,
  options: { controller?: PlayerId; targets?: readonly Selection[]; modes?: readonly string[]; data?: Record<string, unknown> } = {},
): boolean {
  return runResume(
    sink,
    resumeAt({
      defId: instance.defId,
      hook: hookName,
      step: "",
      radiant: instance.radiant,
      instanceId: instance.id,
      data: options.data ?? {},
    }),
    {
      controller: options.controller ?? instance.controller,
      ...(options.targets === undefined ? {} : { targets: options.targets }),
      ...(options.modes === undefined ? {} : { modes: options.modes }),
    },
  );
}

/**
 * A card's own continuation, registered at module scope the way a card registers a script and the
 * way `playSteps` registers the `"play"` sequence: `work.ts` sends it every owed item no engine
 * sequence claims, and the step it names is re-entered with the data the pause captured.
 *
 * Without this, `applyResumable`'s parked tail — whose `hook` is the card's own (`cry`, `death`, a
 * trigger's), which no engine sequence ever claims — has nobody to run it, and R113's "must never
 * be dropped in silence" turns every such pause into a raise. So the registration is not a
 * convenience: it is the other half of `work.ts`'s refusal to drop a sequence.
 */
registerDefaultWorkHandler((sink, item) => {
  runResume(sink, item.resume, { controller: item.owner });
});
