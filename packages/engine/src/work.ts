// Unfinished engine work: the resumable-work queue (SPEC §9.3, §10.3, §10.6, R113).
//
// Several engine sequences do one thing after another where any step can open a prompt: the play
// pipeline of §10.5, the attack window of §4.2 step 4, the Death hooks of §4.5 step 3, the Reborn
// returns of §4.5 step 4, the end-of-turn hooks of §2.2, and any card's own effect list. A prompt
// ends the action — "mid-action choices are state, not callbacks" (§9.3) — and the answer arrives
// as a fresh action with a fresh event list, so a sequence that kept its position in a local
// variable lost it and silently dropped the rest. That is the bug this module exists to prevent:
// any engine sequence that spans a prompt must be resumable through `state.work`.
//
// So a scope that has to stop parks what it still owes on `state.work` and returns, and the
// resolution loop of §10.3 drains it after the answer. Every owed item is plain data — a `Resume`
// naming the continuation, the step to pick up at and the payload it captured — so a paused state
// survives `JSON.parse(JSON.stringify(state))` and replays exactly (§9.3, §10.1). Holding the
// remaining `Effect[]` instead would be holding closures, which §9.3 forbids; a hook is a pure
// builder (CLAUDE.md rule 5), so re-entering it and skipping the effects that already ran
// continues the same sequence.
//
// R113, the order things resume in, is neither a queue nor a stack, because both are wrong. Take a
// Cry whose effect list is `[damage, chooseTarget, damage]`, paused inside play step 5:
//
//   - the Cry parks its tail (W1) and then the pipeline parks steps 6-8 (W2). W1 must run first:
//     step 6 comes *after* step 5, not inside it. A stack would bury the Spell before its own
//     effect finished.
//   - W1 then resumes and opens a second prompt, parking W3. W3 is still inside step 5, so it must
//     precede W2. A plain queue would run step 6 too early.
//
// So: `state.workCursor` is where the pause cascade that is running now parks its next item, and it
// advances with each park, which lands one cascade's items innermost-first; taking an item (or
// entering a drain, which is the boundary between one action's cascade and the next) resets the
// cursor to 0, so a pause that happens *during* a resumption is inserted ahead of everything still
// owed.
//
// Against R68 and R59: work is drained *before* the trigger queue moves (`triggers.settle` does
// this), because an interrupted sequence is the action still finishing rather than a fresh reaction
// to it — a queued trigger only ever starts once nothing is owed. The state check is the caller's
// (R59: it runs between whole effects and whole triggers, never between the hits of one), so this
// module never calls it — which is also what keeps `work` free of every import cycle: the code that
// knows how to run one kind of item registers a handler here, exactly as card scripts register
// themselves with `registerScripts`.

import type { PlayerId, Selection } from "@jackioh/shared";
import type { EngineSink } from "./resolve";
import type { Hook, Script } from "./script";
import { scriptsFor } from "./scripts";
import type { GameState, Resume, WorkItem } from "./state";

/**
 * How one owed item is run. The module that owns the sequence writes it, so the payload it reads
 * out of `item.resume.data` is its own and the queue itself stays ignorant of every sequence.
 */
export type WorkHandler = (sink: EngineSink, item: WorkItem) => void;

/**
 * Which sequence an item belongs to: `resume.hook`. An engine sequence uses a name no card
 * `Script` has (`playSteps.PLAY_WORK_KIND`), a card continuation uses the hook whose step runs
 * (`"resume"`, `"cry"`, `"delayed"`), and `resume.step` says where in it to pick up.
 */
export type WorkKind = string;

/**
 * A continuation plus whose sequence it is. `prompts.ResumePlan` is this type; the owner is the
 * controller the re-entered step runs as, which a `Resume` alone does not carry.
 */
export type WorkPlan = Resume & { owner: PlayerId };

/** A drain that keeps parking new work stops here rather than spinning (§2.5's cap spirit). */
export const MAX_WORK_STEPS = 500;

/** Where a parked effect list keeps its control block, so the rest of `data` stays the card's. */
export const PAUSE_KEY = "__paused";

/** The control block of a parked effect list: all JSON, so the tail survives the answer. */
export type PausedStep = {
  /** Index into the innermost list the pause stood in to continue from. */
  from: number;
  targets: Selection[];
  modes: string[];
  /**
   * The parts of a composed list the pause stood inside (`Effect.expand`), outermost first: the
   * index of the part at each level. Absent for a pause in a card's own list. The continuation
   * builds those parts again, finishes the innermost list from `from`, and then goes on with each
   * enclosing list after the part it stood in (`prompts.applyResumable`, R102, R113).
   */
  part?: number[];
  /** What each part in `part` handed its rebuild (`EffectPart.memo`), level by level. */
  memo?: unknown[];
  /** R174: the field's departures when the list began (`EffectContext.exitsFrom`). */
  exitsFrom?: number;
  /**
   * R136: the units the list summoned before the pause (`EffectContext.summoned`), since the events
   * that say so belong to the action that paused and the tail resumes in a later one.
   */
  summoned?: string[];
};

/**
 * Where the continuation a prompt stores (`prompts.resumeSelf`) keeps what it carries of the run it
 * continues, apart from the card's own data: the answered step is the same run as the list that
 * asked (R113, §10.6), so it reads the stays that run began with (R174) and the units it summoned
 * (R136), whichever action it resumes in.
 */
export const RUN_MARKS_KEY = "__run";

/** What a continuation carries of the run it continues. All JSON. */
export type RunMarks = { exitsFrom?: number; summoned?: string[] };

/** The marks a continuation's data carries, or null when it carries none. */
export function runMarksOf(data: Record<string, unknown>): RunMarks | null {
  const block = data[RUN_MARKS_KEY];
  if (block === null || typeof block !== "object") return null;
  const marks = block as Partial<RunMarks>;
  return {
    ...(typeof marks.exitsFrom === "number" ? { exitsFrom: marks.exitsFrom } : {}),
    ...(Array.isArray(marks.summoned)
      ? { summoned: marks.summoned.filter((id): id is string => typeof id === "string") }
      : {}),
  };
}

const handlers = new Map<WorkKind, WorkHandler>();
let fallback: WorkHandler | undefined;

/**
 * Registered at module scope by the module that owns the sequence, like `registerScripts`: a
 * handler is code, so it never enters the state. Returns the handler it replaced, so a test can
 * put the old one back.
 */
export function registerWorkHandler(
  kind: WorkKind,
  handler: WorkHandler | undefined,
): WorkHandler | undefined {
  const previous = handlers.get(kind);
  if (handler === undefined) handlers.delete(kind);
  else handlers.set(kind, handler);
  return previous;
}

/**
 * The handler for an item whose hook is a card's own, which `prompts.ts` owns: it re-enters the
 * script step the `Resume` names. Returns the handler it replaced.
 */
export function registerDefaultWorkHandler(
  handler: WorkHandler | undefined,
): WorkHandler | undefined {
  const previous = fallback;
  fallback = handler;
  return previous;
}

/** Whether a scope must stop and park the rest: a prompt is open, or the game is over. */
export function paused(sink: EngineSink): boolean {
  return sink.state.pending !== null || sink.state.result !== null;
}

// ---------------------------------------------------------------------------
// The stored control block
// ---------------------------------------------------------------------------

export function pausedOf(data: Record<string, unknown>): PausedStep | null {
  const block = data[PAUSE_KEY];
  if (block === null || typeof block !== "object") return null;
  const step = block as Partial<PausedStep>;
  return {
    from: typeof step.from === "number" ? step.from : 0,
    targets: Array.isArray(step.targets) ? step.targets : [],
    modes: Array.isArray(step.modes) ? step.modes : [],
    ...(Array.isArray(step.part) ? { part: step.part.filter((at): at is number => typeof at === "number") } : {}),
    ...(Array.isArray(step.memo) ? { memo: step.memo } : {}),
    ...(typeof step.exitsFrom === "number" ? { exitsFrom: step.exitsFrom } : {}),
    ...(Array.isArray(step.summoned)
      ? { summoned: step.summoned.filter((id): id is string => typeof id === "string") }
      : {}),
  };
}

/**
 * R102: which ingredient's text of a fused card is running, as the path of ingredient indices from
 * the outermost fusion in (a card fused from a fused card nests). `subsystems/fuse.ts` writes it into
 * the context each part of a combined hook builds and applies with, so what that text leaves behind
 * is that ingredient's own: the continuation a prompt of its stores (`prompts.resumeSelf` copies the
 * card's data) comes back to its step alone, and what it remembers stays apart from what another
 * ingredient remembers under the same name (`effects/memory`).
 */
export const PART_KEY = "__part";

/**
 * How much of `PART_KEY`'s path the combined hooks above the running one have used. A build-time
 * mark only: a stored continuation drops it (`cardData`), so a re-entry reads the path from the top.
 */
export const PART_DEPTH_KEY = "__partDepth";

/** The ingredient path a context's data names (`PART_KEY`), or null outside a fused card's part. */
export function partPathOf(data: Record<string, unknown>): number[] | null {
  const raw = data[PART_KEY];
  if (!Array.isArray(raw)) return null;
  const path = raw.filter((at): at is number => typeof at === "number");
  return path.length === 0 ? null : path;
}

/**
 * R102: the key a fused card's ingredient keeps a memory under — its own, so two Carnivorous Cubes'
 * meals stay two. Outside a fused card's part it is the key itself.
 */
export function partMemoryKey(data: Record<string, unknown>, key: string): string {
  const path = partPathOf(data);
  return path === null ? key : `${key}@${path.join(".")}`;
}

/** The card's own captured data, with the control blocks taken back out. */
export function cardData(data: Record<string, unknown>): Record<string, unknown> {
  const { [PAUSE_KEY]: _paused, [RUN_MARKS_KEY]: _run, [PART_DEPTH_KEY]: _depth, ...rest } = data;
  return rest;
}

// ---------------------------------------------------------------------------
// Parking (R113)
// ---------------------------------------------------------------------------

/**
 * Start a fresh pause cascade: the next park goes ahead of everything still owed (R113). Taking an
 * item and entering `drainWork` both do this, so a reducer that settles after every action gets it
 * for free; call it explicitly when a cascade begins somewhere else.
 */
export function beginWorkCascade(sink: EngineSink): void {
  sink.state.workCursor = 0;
}

function insertAt(state: GameState): number {
  return Math.max(0, Math.min(state.workCursor, state.work.length));
}

function place(state: GameState, item: WorkItem): WorkItem {
  const at = insertAt(state);
  state.work.splice(at, 0, item);
  state.workCursor = at + 1;
  return item;
}

/**
 * Park one owed continuation at the cursor and return the item. The id and `seq` come from
 * `state.nextSeq` (R68's creation order), which is in state, so the queue a replay builds is the
 * queue the live game had; `owner` defaults to the active player.
 */
export function pushWork(sink: EngineSink, resume: Resume, owner?: PlayerId): WorkItem {
  const state = sink.state;
  const item: WorkItem = {
    id: `w${state.nextSeq}`,
    seq: state.nextSeq,
    owner: owner ?? state.active,
    resume,
  };
  state.nextSeq += 1;
  return place(state, item);
}

/**
 * Park one owed continuation without taking a number: its id borrows `state.nextSeq` without moving
 * it. R177: for an item whose existence hangs on a card someone may not read — the end-of-turn trap
 * window's remainder exists only when a trap still to be offered the event watches it, and a
 * face-down trap is read by its controller alone (R33) — so the ids the counter hands the modifiers
 * next (R169) say nothing about it. Nothing orders or finds a work item by its `seq`.
 */
export function oweUnnumbered(sink: EngineSink, resume: Resume, owner?: PlayerId): WorkItem {
  const state = sink.state;
  const item: WorkItem = {
    id: `u${state.nextSeq}.${state.work.length}`,
    seq: state.nextSeq,
    owner: owner ?? state.active,
    resume,
  };
  return place(state, item);
}

/**
 * What a pause still owes. A `Resume` is parked as a new item; a whole `WorkItem` is parked again
 * as it stands, keeping its id and `seq`, which is what a handler that has to wait behind another
 * one needs.
 */
export function owe(sink: EngineSink, ...items: (Resume | WorkItem)[]): WorkItem[] {
  return items.map((item) =>
    "resume" in item ? place(sink.state, item) : pushWork(sink, item),
  );
}

/**
 * Park the effects after the one that opened a prompt: the same continuation, plus the index to
 * continue from and the selections the step was running with (`prompts.applyResumable`).
 */
export function parkWork(sink: EngineSink, plan: WorkPlan, step: PausedStep): WorkItem {
  const resume: Resume = {
    defId: plan.defId,
    hook: plan.hook,
    step: plan.step,
    radiant: plan.radiant,
    ...(plan.instanceId === undefined ? {} : { instanceId: plan.instanceId }),
    data: { ...cardData(plan.data), [PAUSE_KEY]: { ...step } },
  };
  return pushWork(sink, resume, plan.owner);
}

// ---------------------------------------------------------------------------
// Reading and taking
// ---------------------------------------------------------------------------

export function hasWork(state: GameState): boolean {
  return state.work.length > 0;
}

/** The next item without taking it. */
export function peekWork(state: GameState): WorkItem | undefined {
  return state.work[0];
}

/** Every owed item, or only the ones belonging to one sequence. */
export function owedWork(state: GameState, kind?: WorkKind): WorkItem[] {
  return kind === undefined ? [...state.work] : state.work.filter((item) => item.resume.hook === kind);
}

export function isOwed(state: GameState, kind: WorkKind): boolean {
  return state.work.some((item) => item.resume.hook === kind);
}

/**
 * Take the next owed item, or `undefined` when nothing is owed. Taking one ends the cascade that
 * parked it, so the cursor resets: whatever the resumed item parks goes ahead of the rest (R113).
 */
export function takeWork(state: GameState): WorkItem | undefined {
  const item = state.work.shift();
  state.workCursor = 0;
  return item;
}

/**
 * Drop the owed items a predicate names and return them — for a sequence that has caught up with
 * a tail it parked, which would otherwise run twice. The cursor follows the items it loses.
 */
export function dropWork(state: GameState, match: (item: WorkItem) => boolean): WorkItem[] {
  const dropped: WorkItem[] = [];
  const kept: WorkItem[] = [];
  let cursor = state.workCursor;
  state.work.forEach((item, index) => {
    if (!match(item)) {
      kept.push(item);
      return;
    }
    dropped.push(item);
    if (index < state.workCursor) cursor -= 1;
  });
  if (dropped.length === 0) return dropped;
  state.work = kept;
  state.workCursor = Math.max(0, Math.min(cursor, kept.length));
  return dropped;
}

/** `dropWork` by id: the tail a step parked before it turned out not to need it. */
export function unparkWork(state: GameState, id: string): WorkItem | undefined {
  return dropWork(state, (item) => item.id === id)[0];
}

// ---------------------------------------------------------------------------
// Running
// ---------------------------------------------------------------------------

/** Where a continuation of an event trigger keeps the event it answers (`triggers.queueTrigger`). */
export const EVENT_KEY = "event";

/**
 * An event trigger's own list, re-entered by its id (R113). A `TriggerDef` lives in an array
 * (`triggers`, `handTriggers`), not under a `Script` key, so a trigger or a trap whose list asks
 * mid-list parks its tail under the trigger's id, and the tail is rebuilt here from the event the
 * continuation carries in its data.
 */
function triggerStepFor(script: Script, resume: Resume): Hook | undefined {
  const def = [...(script.triggers ?? []), ...(script.handTriggers ?? [])].find(
    (candidate) => candidate.id === resume.hook,
  );
  if (def === undefined) return undefined;
  return (ctx) => {
    const event: unknown = ctx.data[EVENT_KEY];
    if (event === null || typeof event !== "object" || typeof (event as { type?: unknown }).type !== "string") {
      return [];
    }
    return def.run({ ...ctx, event: event as Parameters<typeof def.run>[0]["event"] });
  };
}

/**
 * The step a script registers for a continuation: a hook of its own (`cry`, `delayed`), an entry
 * in its step table (`resume: { picked: … }`), or an event trigger named by its id. `prompts.ts`
 * re-enters a continuation through this, and `canResume` asks it, so the two cannot disagree.
 */
export function scriptStepFor(script: Script, resume: Resume): Hook | undefined {
  const entry: unknown = (script as unknown as Record<string, unknown>)[resume.hook];
  if (typeof entry === "function") return entry as Hook;
  if (entry !== null && typeof entry === "object" && !Array.isArray(entry)) {
    const step: unknown = (entry as Record<string, unknown>)[resume.step];
    if (typeof step === "function") return step as Hook;
  }
  return triggerStepFor(script, resume);
}

/** The step a card's script registers for this continuation, on the face the pause recorded. */
function cardStepFor(resume: Resume): Hook | undefined {
  const scripts = scriptsFor(resume.defId);
  const script: Script = resume.radiant ? scripts.radiant : scripts.base;
  return scriptStepFor(script, resume);
}

/** Whether anything at all knows how to resume this item (R113). */
export function canResume(resume: Resume): boolean {
  if (handlers.has(resume.hook)) return true;
  return fallback !== undefined && cardStepFor(resume) !== undefined;
}

/**
 * Run one owed item: the handler its sequence registered, or the card-continuation handler when the
 * card's own script has that step (R113). When neither knows the hook this raises, because a work
 * item that cannot be resumed is a lost sequence — a Spell that never reaches the graveyard, an
 * Echo repeat that never happens — and must never be dropped in silence.
 */
export function runWorkItem(sink: EngineSink, item: WorkItem): void {
  const handler = handlers.get(item.resume.hook);
  if (handler !== undefined) {
    handler(sink, item);
    return;
  }
  if (fallback !== undefined && cardStepFor(item.resume) !== undefined) {
    fallback(sink, item);
    return;
  }
  throw new Error(
    `no handler for owed work "${item.resume.hook}" step "${item.resume.step}"` +
      `${item.resume.defId === "" ? "" : ` of ${item.resume.defId}`} (R113)`,
  );
}

/**
 * Run the next owed item, if any, and report whether one ran, so a resolution loop can keep going
 * until nothing is left. Nothing runs while a prompt is open or the game is over: the answer is
 * another action, and what to do with the pause is the caller's decision.
 */
export function runNextWork(sink: EngineSink): boolean {
  if (paused(sink)) return false;
  const drain = sink as DrainSink;
  const head = sink.state.work[0];
  if (head === undefined || drain.owedBehind?.has(head.id) === true) return false;
  const next = takeWork(sink.state);
  if (next === undefined) return false;
  // R117: what is owed behind this item is the enclosing sequences', and a resolution loop running
  // inside it — a play's step-4 loop, a turn stage's settle — can neither take nor re-run it. The
  // items this one parks go ahead of them (R113), so they stay the queue's tail; only the drain that
  // took this item comes back for them, once the item is done.
  const outer = drain.owedBehind;
  drain.owedBehind = new Set(sink.state.work.map((item) => item.id));
  try {
    runWorkItem(sink, next);
  } finally {
    drain.owedBehind = outer;
  }
  return true;
}

/**
 * A sink a drain is running on. `owedBehind` names the items owed behind the one that is running,
 * which a drain nested inside it must leave to the drain that took it (R117). Transient, like the
 * sink: at rest every owed item is in `state.work`.
 */
type DrainSink = EngineSink & { owedBehind?: ReadonlySet<string> };

/**
 * Continue the sequences a prompt interrupted, in R113's order, until they are all done or one of
 * them opens a prompt of its own — which parks its own tail, so the rest keeps waiting in state.
 * Returns whether the queue is empty. The state check and the trigger queue are the caller's
 * (§10.3, R59); `triggers.settle` drains here first and only then pops a trigger.
 */
export function drainWork(sink: EngineSink): boolean {
  // Entering a drain is the boundary between the cascade that parked this work and the next one.
  beginWorkCascade(sink);
  for (let step = 0; step < MAX_WORK_STEPS; step += 1) {
    if (paused(sink)) return !hasWork(sink.state);
    if (!runNextWork(sink)) return true;
  }
  throw new Error(`owed work did not drain in ${MAX_WORK_STEPS} steps (§9.3)`);
}

/** `drainWork` for a caller that does not read the result. */
export function runWork(sink: EngineSink): void {
  drainWork(sink);
}
