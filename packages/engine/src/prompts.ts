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
import { findInstance, type CardInstance, type PendingChoice, type PromptOption, type Resume } from "./state";
import { exitMark } from "./stays";
import {
  RUN_MARKS_KEY,
  beginWorkCascade,
  cardData,
  drainWork,
  parkWork,
  pausedOf,
  registerDefaultWorkHandler,
  runMarksOf,
  scriptStepFor,
  type PausedStep,
  type RunMarks,
  type WorkPlan,
} from "./work";

/**
 * Where a Death hook's context keeps the snapshot of the unit as it died (R89), so a continuation
 * built from that context — a prompt's answered step, re-entered in a later action — reads the same
 * card the hook did rather than the instance R78 has reset since.
 */
export const SELF_KEY = "__self";

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
  /** R174, §10.6: when `targets` were picked — an answer's picks, as its prompt offered them. */
  chosenFrom?: number;
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
 * this chain has captured so far plus whatever this step adds. A step resolving with no instance
 * (`ctx.self === null`: its card has ceased to exist, R127) still names its definition's script,
 * which the context it was re-entered with carries (`EffectContext.defId`), so the answer to a
 * prompt it opens comes back to the same script rather than to none (R113).
 */
export function resumeSelf(
  ctx: EffectContext,
  step: string,
  data: Record<string, unknown> = {},
): Resume {
  const self = ctx.self;
  const built = resumeAt({
    defId: self?.defId ?? ctx.defId ?? "",
    step,
    radiant: ctx.radiant,
    ...(self === null ? {} : { instanceId: self.id }),
    data: { ...cardData(ctx.data), ...data },
  });
  // R113, §10.6: the answer re-invokes the same script, so the step it re-enters is the same run —
  // it reads the stays the run began with (R174) and counts the units it summoned (R136), whichever
  // action it resumes in. A delayed effect is not the run continued and drops this (`effects/delay`).
  return { ...built, data: { ...built.data, [RUN_MARKS_KEY]: runMarks(ctx) } };
}

/** R136: the units a run has summoned so far — those of earlier actions, then this action's. */
export function summonedSoFar(ctx: EffectContext): string[] {
  const now = ctx.events
    .slice(ctx.eventsFrom)
    .flatMap((event) => (event.type === "summoned" ? [event.instanceId] : []));
  return [...(ctx.summoned ?? []), ...now];
}

/** What a continuation of this run carries of it (`work.RunMarks`). */
function runMarks(ctx: EffectContext): RunMarks {
  const summoned = summonedSoFar(ctx);
  return {
    exitsFrom: ctx.exitsFrom ?? exitMark(ctx.state),
    ...(summoned.length === 0 ? {} : { summoned }),
  };
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
  // R113, R122: answering re-enters the step the prompt paused, which is taking that step up again —
  // so the cursor resets, and a pause inside it parks its own tail ahead of everything still owed,
  // not behind it at whatever place the action before this one left the cursor.
  beginWorkCascade(sink);
  runResume(sink, resumeOf(pending), {
    controller: pending.playerId,
    targets: inOfferedOrder(pending, answer.selection),
    // R174, §10.6: the picks are cards as the prompt offered them, on the stays they stand on now —
    // whatever the list that asked did to the board before it asked.
    chosenFrom: exitMark(sink.state),
  });
  drainWork(sink);
  return null;
}

/**
 * R221: an answer's picks are a set (R60's "N different cards"), taken in the order the prompt offered
 * them. `legalActions` offers each set once, in that order, and `reduce` accepts any listing of it —
 * so the listing must not change what the answer does, or a listing no offered answer makes would
 * mean something else: #80 Zao Gao discards its picks in turn, and the graveyard's order is public.
 */
export function inOfferedOrder(pending: PendingChoice, selection: readonly Selection[]): Selection[] {
  const used = new Set<number>();
  const placed = selection.map((pick) => {
    const at = pending.options.findIndex((option, index) => !used.has(index) && sameSelection(option.selection, pick));
    if (at >= 0) used.add(at);
    return { pick, at: at < 0 ? Number.MAX_SAFE_INTEGER : at };
  });
  return placed.sort((a, b) => a.at - b.at).map((entry) => entry.pick);
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
 * The hook a continuation names: a step out of a table (`resume: { picked: … }`), a hook of the
 * card's own (`cry`, `delayed`), or an event trigger by its id (`work.scriptStepFor`). Nothing
 * registered is not an error — the answer just closed the prompt (§10.6) — so this returns
 * undefined rather than throwing.
 */
function hookFor(script: Script, resume: Resume): Hook | undefined {
  return scriptStepFor(script, resume);
}

/**
 * R89: the card a continuation re-enters as, when the step was paused by a Death hook. R78 has
 * reset the instance on the board by then (or a Reborn body stands under the same id), so the hook
 * reads the snapshot taken as the unit died, which the Death pass puts in its context's data
 * (`stateCheck.runDeathPass`) and every continuation built from that context carries on.
 */
function selfSnapshotOf(data: Record<string, unknown>): CardInstance | null {
  const raw = data[SELF_KEY];
  if (raw === null || typeof raw !== "object") return null;
  const card = raw as Partial<CardInstance>;
  return typeof card.id === "string" && typeof card.defId === "string" ? (raw as CardInstance) : null;
}

/**
 * How an effect list ended: whole (`done`); stopped by a prompt with what was left of it parked on
 * `state.work` (`parked`); stopped by a prompt at its very last effect, so nothing was left to park
 * (`asked`); or cut short because the game ended inside it (`over`, R216).
 */
export type ListStatus = "done" | "parked" | "asked" | "over";

/** One list of the walk: a composed list's part is a list inside the list that holds it. */
type Frame = { effects: readonly Effect[]; at: number };

/**
 * Apply an effect list so that a prompt in the middle of it pauses the list instead of being
 * stepped over: the effects after the one that opened the prompt are parked as a work item naming
 * this same continuation and where to continue from (§9.3, R113). Returns true when the whole list
 * ran.
 *
 * A hook is a pure builder (CLAUDE.md rule 5), so re-entering it and skipping the effects that
 * already ran continues the sequence exactly; the alternative — holding the remaining `Effect[]`
 * in state — would be holding closures, which §9.3 forbids.
 *
 * A composed list (a fused hook, R102) is a list of parts, each built when the walk reaches it
 * (`Effect.expand`), so an ingredient's list reads the board the ones before it left. The walk is a
 * stack of lists, and a pause parks ONE item for all of it: the parts it stood inside and the place
 * in the innermost one (`PausedStep.part`, `from`), so the continuation finishes that part and then
 * goes on with every part after it, level by level. Parking once per level instead would owe a
 * Death pass's remainder twice (`stateCheck.runDeathPass` continues the pass after its hook).
 */
export function applyResumable(
  sink: EngineSink,
  ctx: EffectContext,
  plan: ResumePlan,
  effects: readonly Effect[],
  paused: PausedStep | null = null,
): boolean {
  return runResumableList(sink, ctx, plan, effects, paused) === "done";
}

/** `applyResumable`, saying how the list ended (`ListStatus`). */
export function runResumableList(
  sink: EngineSink,
  ctx: EffectContext,
  plan: ResumePlan,
  effects: readonly Effect[],
  paused: PausedStep | null = null,
): ListStatus {
  const stack: Frame[] = [];
  const memos: unknown[] = [];
  let list = effects;
  // A resumed walk builds again the parts the pause stood inside, and only those: each part was
  // built as the walk reached it, and the ones before it have run.
  for (const [level, at] of (paused?.part ?? []).entries()) {
    stack.push({ effects: list, at });
    const part = list[at]?.expand;
    const built = part === undefined ? { effects: [] } : part(ctx, paused?.memo?.[level]);
    memos.push(built.memo);
    list = built.effects;
  }
  stack.push({ effects: list, at: Math.max(0, paused?.from ?? 0) });

  for (;;) {
    const top = stack[stack.length - 1];
    if (top === undefined) return "done";
    if (top.at >= top.effects.length) {
      // A part is done: the list that holds it goes on after it.
      stack.pop();
      memos.pop();
      const parent = stack[stack.length - 1];
      if (parent === undefined) return "done";
      parent.at += 1;
      continue;
    }
    // R216: the game ended inside this list (a state check a draw's cast ran), so the rest of it
    // never resolves, and nothing is parked for a game that is over.
    if (sink.state.result !== null) return "over";

    const effect = top.effects[top.at];
    if (effect?.expand !== undefined) {
      const built = effect.expand(ctx, undefined);
      memos.push(built.memo);
      stack.push({ effects: built.effects, at: 0 });
      continue;
    }

    const before = sink.state.pending;
    effect?.apply(ctx);
    top.at += 1;
    const pending = sink.state.pending;
    if (pending === null || pending === before) continue;

    const left = stack.some((frame, level) =>
      level === stack.length - 1 ? frame.at < frame.effects.length : frame.at + 1 < frame.effects.length,
    );
    if (!left) return "asked";
    const marks = runMarks(ctx);
    parkWork(sink, plan, {
      from: top.at,
      targets: [...ctx.targets],
      modes: [...ctx.modes],
      ...(stack.length > 1 ? { part: stack.slice(0, -1).map((frame) => frame.at), memo: [...memos] } : {}),
      ...marks,
      ...(ctx.chosenFrom === undefined ? {} : { chosenFrom: ctx.chosenFrom }),
    });
    return "parked";
  }
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
  // R113: an answered step (`resumeSelf`) and a parked tail (`PausedStep`) are the run continued.
  const run = runMarksOf(resume.data);
  const exitsFrom = paused?.exitsFrom ?? run?.exitsFrom;
  // The picks a tail carries were chosen when its list's were; fresh picks, when the answer made them.
  const chosenFrom = options.targets === undefined ? paused?.chosenFrom : options.chosenFrom;
  const summoned = paused?.summoned ?? run?.summoned;
  const data = cardData(resume.data);
  const instance =
    selfSnapshotOf(data) ??
    (resume.instanceId === undefined ? null : findInstance(sink.state, resume.instanceId) ?? null);

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
    // R127: the script this continuation named, which a step with no instance still asks again in.
    defId: resume.defId,
    // R174, R113: a paused list is the same run continued, so it keeps the mark it began with.
    ...(exitsFrom === undefined ? {} : { exitsFrom }),
    ...(chosenFrom === undefined ? {} : { chosenFrom }),
    // R136: and it reads the units its head summoned, in whichever action that happened.
    ...(summoned === undefined || summoned.length === 0 ? {} : { summoned }),
  };

  const plan: ResumePlan = { ...resume, data, owner: ctx.controller };
  // A composed list (a fused hook, R102) continues in the part it stood in, then the rest.
  return applyResumable(sink, ctx, plan, hook(ctx), paused);
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
  options: {
    controller?: PlayerId;
    targets?: readonly Selection[];
    modes?: readonly string[];
    data?: Record<string, unknown>;
    /**
     * R174: the stays the hook's choices were made against, when they were made before the hook
     * runs — a play's declared targets, checked at §10.5 step 1 — so a card taken off the field
     * between the choice and the hook (a Tribute at step 2, a trap at step 4) is gone for it.
     */
    exitsFrom?: number;
  } = {},
): boolean {
  const resume = resumeAt({
    defId: instance.defId,
    hook: hookName,
    step: "",
    radiant: instance.radiant,
    instanceId: instance.id,
    data: options.data ?? {},
  });
  const marks: RunMarks | null = options.exitsFrom === undefined ? null : { exitsFrom: options.exitsFrom };
  return runResume(
    sink,
    marks === null ? resume : { ...resume, data: { ...resume.data, [RUN_MARKS_KEY]: marks } },
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
