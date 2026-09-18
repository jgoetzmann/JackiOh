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
  /** Index into the step's effect list to continue from. */
  from: number;
  targets: Selection[];
  modes: string[];
};

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
  };
}

/** The card's own captured data, with the control block taken back out. */
export function cardData(data: Record<string, unknown>): Record<string, unknown> {
  const { [PAUSE_KEY]: _paused, ...rest } = data;
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

/**
 * The step a card's script registers for this continuation: a hook of its own (`cry`, `delayed`)
 * or an entry in its step table (`resume: { picked: … }`), which is how `prompts.ts` re-enters one.
 */
function cardStepFor(resume: Resume): Hook | undefined {
  const scripts = scriptsFor(resume.defId);
  const script: Script = resume.radiant ? scripts.radiant : scripts.base;
  const entry: unknown = (script as unknown as Record<string, unknown>)[resume.hook];
  if (typeof entry === "function") return entry as Hook;
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return undefined;
  const step: unknown = (entry as Record<string, unknown>)[resume.step];
  return typeof step === "function" ? (step as Hook) : undefined;
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
  const next = takeWork(sink.state);
  if (next === undefined) return false;
  runWorkItem(sink, next);
  return true;
}

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
