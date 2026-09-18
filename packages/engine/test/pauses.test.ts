// What survives a prompt (SPEC §9.3: "mid-action choices are state, not callbacks … identical in
// live play, replays and tests"), i.e. `src/work.ts`.
//
// A prompt ends the action and the answer arrives as a fresh action with a fresh event list, so
// any engine sequence that spans a prompt has to be resumable out of state alone. Two kinds of
// sequence do:
//
//  1. a card's own effect list — the effects after the one that opened the prompt are parked as a
//     `WorkItem` naming the same continuation plus the index to continue from, so the third of
//     three effects still runs after the answer and the list neither restarts nor drops its tail;
//  2. an engine sequence of named steps (the play pipeline of §10.5, the attack window of §4.2
//     step 4, the Death hooks of §4.5 step 3, the end of a turn of §2.2) — when one of its steps
//     pauses, and only then, it owes the steps after that one.
//
// Both go on the one `state.work`, which R113 orders with `state.workCursor`: the scope that
// noticed the prompt parks first and the scopes around it park behind it, so one pause cascade
// lands innermost-first and `drainWork` takes it from the front; taking an item resets the cursor,
// so a pause that happens *during* a resumption lands ahead of everything still owed. Every test
// here reads that queue as state: it pauses, asserts what is owed, answers, and checks that what
// was owed ran — and the round-trip and replay tests then prove the queue is plain JSON and
// identical on a second run.

import type { PlayerId, Selection } from "@jackioh/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { registerCatalog, registeredCatalog } from "../src/catalog";
import { chooseMode, damage } from "../src/effects";
import {
  closePrompt,
  openPrompt,
  resumeAt,
  runHookResumable,
  runResume,
} from "../src/prompts";
import { hashState } from "../src/replay";
import type { EngineSink } from "../src/resolve";
import type { CardScripts, Script } from "../src/script";
import { registerScripts, registeredScripts } from "../src/scripts";
import type { CardDef } from "@jackioh/shared";
import type { GameState, Resume, WorkItem } from "../src/state";
import { newInstance, type CardInstance } from "../src/state";
import {
  MAX_WORK_STEPS,
  drainWork,
  dropWork,
  hasWork,
  isOwed,
  owe,
  owedWork,
  parkWork,
  paused,
  pausedOf,
  peekWork,
  pushWork,
  registerDefaultWorkHandler,
  registerWorkHandler,
  runNextWork,
  runWorkItem,
  takeWork,
  unparkWork,
} from "../src/work";
import { eventsOfType, newGame, put, sinkFor, slot } from "./fixtures/harness";

// ---------------------------------------------------------------------------
// The handlers the engine registers, registered here too
// ---------------------------------------------------------------------------

/**
 * `prompts.ts` owns re-entering a card's own continuation, so it registers this as the handler for
 * every item no engine sequence claims. Registered here as well, so this file tests `work.ts`
 * against the same wiring whatever order the modules happen to load in.
 */
registerDefaultWorkHandler((sink, item) => {
  runResume(sink, item.resume, { controller: item.owner });
});

/** A fixture engine sequence: three steps, the middle one of which asks (see `driveSequence`). */
const SEQUENCE_HOOK = "__pausesTestSequence";
/** Where the fixture sequence's cursor sits inside `resume.data`, as a play run does (§10.5). */
const AT_KEY = "__at";

type SequenceRun = { at: number; owner: PlayerId };

function sequenceResume(run: SequenceRun): Resume {
  return resumeAt({
    defId: "",
    hook: SEQUENCE_HOOK,
    step: `step${run.at}`,
    data: { [AT_KEY]: run.at },
  });
}

function sequenceRunOf(item: WorkItem): SequenceRun {
  const at = item.resume.data[AT_KEY];
  return { at: typeof at === "number" ? at : 0, owner: item.owner };
}

/** A prompt with two options whose answer does nothing: the pause itself is under test. */
function ask(sink: EngineSink, player: PlayerId): void {
  openPrompt(sink, {
    player,
    kind: "mode",
    prompt: "Choose one",
    options: [
      { key: "mode:a", label: "a", selection: { pick: "mode", option: "a" } },
      { key: "mode:b", label: "b", selection: { pick: "mode", option: "b" } },
    ],
    // Nothing is registered under this step, so the answer only closes the prompt (§10.6) and the
    // owed sequence is what carries on.
    resume: resumeAt({ defId: "", step: "none" }),
  });
}

const SEQUENCE_STEPS: ((sink: EngineSink, run: SequenceRun) => void)[] = [
  (sink) => {
    hit(sink, 1);
  },
  (sink, run) => {
    ask(sink, run.owner);
  },
  (sink) => {
    hit(sink, 2);
  },
];

/**
 * The §10.5 discipline (`playSteps.drive`): run the steps in order and owe the rest *only* when a
 * step actually pauses, never in advance. Two reasons, both R113's: while this loop is on the stack
 * the steps are its own, so a nested drain must not find them owed and run them a second time; and
 * the scope that noticed the prompt — the tail of the paused step's own effect list — has already
 * parked at the cursor, so parking here lands behind it and resumes after it. A paused step leaves
 * the tail owed and `drainWork` re-enters here at the cursor the item carries.
 */
function driveSequence(sink: EngineSink, run: SequenceRun): void {
  for (let at = run.at; at < SEQUENCE_STEPS.length; at += 1) {
    SEQUENCE_STEPS[at]?.(sink, run);
    if (!paused(sink)) continue;
    // Nothing to owe when the step that paused was the last one.
    if (at + 1 < SEQUENCE_STEPS.length) {
      pushWork(sink, sequenceResume({ ...run, at: at + 1 }), run.owner);
    }
    return;
  }
}

registerWorkHandler(SEQUENCE_HOOK, (sink, item) => {
  driveSequence(sink, sequenceRunOf(item));
});

// ---------------------------------------------------------------------------
// The cards
// ---------------------------------------------------------------------------

let nextIndex = 1400;
function def(name: string, type: CardDef["type"], extra: Partial<CardDef> = {}): CardDef {
  nextIndex += 1;
  return {
    id: `pz-${name}`,
    index: String(nextIndex),
    name,
    set: "Core",
    type,
    tags: [],
    rarity: "Common",
    token: false,
    cost: 1,
    base: { keywords: [], text: name },
    radiant: { keywords: [], text: name },
    ...extra,
  };
}

function both(script: Script): CardScripts {
  return { base: script, radiant: script };
}

const enemyHero = (amount: number) => damage({ to: { of: "enemyHero" }, amount });

/** Three effects, the middle one a prompt: the third is the one a lost tail would drop. */
const middleAsker = def("middle-asker", "Spell");
/** The same, with a chain: the answered step also asks in the middle of its own list. */
const chainAsker = def("chain-asker", "Spell");
/** A unit whose Cry asks in the middle, so a pause can be nested inside an owed sequence. */
const crier = def("crier", "Unit", {
  base: { attack: 1, health: 5, keywords: [], text: "asks" },
  radiant: { attack: 2, health: 10, keywords: [], text: "asks" },
});

const DEFS = [middleAsker, chainAsker, crier];

const SCRIPTS: Record<string, CardScripts> = {
  [middleAsker.id]: both({
    cry: () => [enemyHero(1), chooseMode({ options: ["a", "b"], step: "picked" }), enemyHero(2)],
    resume: { picked: () => [enemyHero(4)] },
  }),
  [chainAsker.id]: both({
    cry: () => [enemyHero(1), chooseMode({ options: ["a", "b"], step: "second" }), enemyHero(2)],
    resume: {
      second: () => [enemyHero(3), chooseMode({ options: ["a", "b"], step: "third" }), enemyHero(4)],
      third: () => [enemyHero(5)],
    },
  }),
  [crier.id]: both({
    cry: () => [enemyHero(8), chooseMode({ options: ["a", "b"], step: "cried" }), enemyHero(16)],
    resume: { cried: () => [] },
  }),
};

function game(seed: string): GameState {
  const state = newGame(seed);
  registerCatalog({ ...registeredCatalog(), ...Object.fromEntries(DEFS.map((d) => [d.id, d])) });
  registerScripts({ ...registeredScripts(), ...SCRIPTS });
  state.turn = 3;
  state.active = "p1";
  state.phase = "main";
  return state;
}

/** A Spell mid-resolution, as §10.5 step 4 leaves one: its continuation still finds it (R98). */
function resolving(state: GameState, defId: string): CardInstance {
  const card = newInstance(state, defId, "p1", { z: "resolving", player: "p1" });
  state.players.p1.resolving.push(card);
  return card;
}

function hit(sink: EngineSink, amount: number): void {
  const ctx = { ...sinkFor(sink.state, sink.events), controller: "p1" as PlayerId };
  enemyHero(amount).apply({
    state: ctx.state,
    rng: ctx.rng,
    events: sink.events,
    controller: "p1",
    self: null,
    radiant: false,
    targets: [],
    modes: [],
    x: 0,
    embiggened: false,
    data: {},
  });
}

/**
 * One action's worth of work, with its own event list, as `reduce` gives each action (§9.3): run
 * `body`, then drain whatever a pause owed.
 */
function act(state: GameState, body: (sink: EngineSink) => void): EngineSink {
  const sink = sinkFor(state);
  body(sink);
  drainWork(sink);
  return sink;
}

/**
 * The `answer` action of §10.6, spelled out the way `prompts.answerPrompt` spells it: close the
 * prompt, re-enter the step it named with the selection, then continue what it interrupted.
 */
function answer(state: GameState, option: string): EngineSink {
  const pending = state.pending;
  expect(pending).not.toBeNull();
  if (pending === null) throw new Error("no prompt is open");
  const selection: Selection[] = [{ pick: "mode", option }];
  return act(state, (sink) => {
    closePrompt(sink);
    runResume(sink, pending.resume, { controller: pending.playerId, targets: selection });
  });
}

const amounts = (sink: EngineSink): number[] => eventsOfType(sink.events, "damage").map((e) => e.amount);
const enemyHealth = (state: GameState): number => state.players.p2.hero.health;

/** Anything in the state that is not JSON: a closure would come back from a round-trip missing. */
function unserializable(value: unknown, path = "state"): string[] {
  if (typeof value === "function") return [path];
  if (typeof value !== "object" || value === null) return [];
  if (Array.isArray(value)) return value.flatMap((entry, i) => unserializable(entry, `${path}[${i}]`));
  return Object.entries(value).flatMap(([key, entry]) => unserializable(entry, `${path}.${key}`));
}

// ---------------------------------------------------------------------------
// A card's own effect list
// ---------------------------------------------------------------------------

describe("a prompt in the middle of an effect list (§9.3, §10.6)", () => {
  it("§9.3 runs the third of three effects after the answer, having parked it, not dropped it", () => {
    const state = game("list-pause");
    const card = resolving(state, middleAsker.id);

    const played = act(state, (sink) => {
      runHookResumable(sink, card, "cry");
    });

    // Paused on the second effect: the first has landed, the third has not, and it is owed.
    expect(state.pending).not.toBeNull();
    expect(amounts(played)).toEqual([1]);
    expect(enemyHealth(state)).toBe(29);
    expect(state.work).toHaveLength(1);
    const owed = state.work[0];
    expect(owed?.resume).toMatchObject({ defId: middleAsker.id, hook: "cry", instanceId: card.id });
    expect(owed?.owner).toBe("p1");
    // The continuation names where to pick up — the effect after the one that asked — and nothing
    // else: the remaining effects themselves are closures and never enter the state (§9.3).
    expect(pausedOf(owed?.resume.data ?? {})?.from).toBe(2);

    const answered = answer(state, "a");

    // The answered step ran first, then the parked tail: 4 from `resume.picked`, then the 2 the
    // list still owed. Nothing is left owed and no prompt is open.
    expect(amounts(answered)).toEqual([4, 2]);
    expect(enemyHealth(state)).toBe(23);
    expect(state.work).toEqual([]);
    expect(state.pending).toBeNull();
  });

  it("§10.6 chains a second prompt inside the answer and finishes both tails, innermost first", () => {
    const state = game("list-chain");
    const card = resolving(state, chainAsker.id);

    const played = act(state, (sink) => {
      runHookResumable(sink, card, "cry");
    });
    expect(amounts(played)).toEqual([1]);
    expect(owedWork(state)).toHaveLength(1);

    // The answered step asks again in the middle of its own list, so now two tails are owed: the
    // Cry's, and the step's. The step's pause happened *during* a resumption, so R113 puts it in
    // front of the Cry's tail rather than behind it: the cursor was reset when the Cry's tail was
    // taken (`""` is the Cry hook's own step label).
    const first = answer(state, "a");
    expect(amounts(first)).toEqual([3]);
    expect(state.pending).not.toBeNull();
    expect(state.work).toHaveLength(2);
    expect(state.work.map((item) => item.resume.step)).toEqual(["second", ""]);
    expect(peekWork(state)?.resume.step).toBe("second");

    const second = answer(state, "b");

    // 5 from the last step, then the inner tail's 4, then the outer tail's 2: each list carries on
    // where it stopped, innermost first, and none of the five effects is lost or repeated.
    expect(amounts(second)).toEqual([5, 4, 2]);
    expect(enemyHealth(state)).toBe(30 - (1 + 3 + 5 + 4 + 2));
    expect(state.work).toEqual([]);
    expect(state.pending).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// An engine sequence of named steps
// ---------------------------------------------------------------------------

describe("a prompt in the middle of an engine sequence (§10.3, §10.5)", () => {
  it("§9.3 resumes a three-step sequence at the step after the one that asked", () => {
    const state = game("sequence-pause");

    const started = act(state, (sink) => {
      driveSequence(sink, { at: 0, owner: "p1" });
    });

    // Step 2 asked, so step 3 is owed as a work item naming the sequence and its cursor.
    expect(amounts(started)).toEqual([1]);
    expect(isOwed(state, SEQUENCE_HOOK)).toBe(true);
    expect(state.work).toHaveLength(1);
    expect(peekWork(state)?.resume.data.__at).toBe(2);

    const answered = answer(state, "a");

    expect(amounts(answered)).toEqual([2]);
    expect(state.work).toEqual([]);
    expect(enemyHealth(state)).toBe(27);
  });

  it("§9.3 finishes a pause nested inside an owed sequence before the sequence's own tail", () => {
    const state = game("sequence-nested");
    const unit = put(state, crier.id, slot("p1", "units", 1));

    // The sequence pauses first, so its tail is owed while the board does something else.
    act(state, (sink) => {
      driveSequence(sink, { at: 0, owner: "p1" });
    });
    expect(state.work).toHaveLength(1);

    // A trigger fires inside the open prompt's answer — the case §10.3 describes, a response
    // resolving to completion inside an action — and its own Cry asks in the middle of its list, so
    // its tail is parked while the sequence's own tail is still owed. Nothing is registered under
    // the answered step, so closing the prompt is the whole of that answer (§10.6).
    const answered = act(state, (sink) => {
      closePrompt(sink);
      runHookResumable(sink, unit, "cry");
    });
    expect(amounts(answered)).toEqual([8]);
    expect(state.pending).not.toBeNull();
    // The Cry's pause happened during the answer, so R113 puts its tail in front of the sequence's.
    expect(state.work.map((item) => item.resume.hook)).toEqual(["cry", SEQUENCE_HOOK]);

    const last = answer(state, "b");

    // The Cry's tail (16) runs before the sequence's remaining step (2): the newer pause happened
    // inside the older one, so it is the innermost thing owed.
    expect(amounts(last)).toEqual([16, 2]);
    expect(state.work).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Serializable, and the same on a replay
// ---------------------------------------------------------------------------

describe("a paused state is plain data (§9.3, §10.1)", () => {
  it("§9.3 survives JSON.parse(JSON.stringify(state)) with work owed, and answers the same way", () => {
    const state = game("round-trip");
    const card = resolving(state, middleAsker.id);
    act(state, (sink) => {
      runHookResumable(sink, card, "cry");
    });
    expect(hasWork(state)).toBe(true);

    const round = JSON.parse(JSON.stringify(state)) as GameState;
    expect(round).toEqual(state);
    expect(round.work).toEqual(state.work);
    // Nothing owed is a closure or a class instance, anywhere in the state (§10.1).
    expect(unserializable(state)).toEqual([]);
    expect(hashState(round)).toBe(hashState(state));

    // And the revived state answers to the same place: the parked tail still runs.
    const live = answer(state, "a");
    const revived = answer(round, "a");
    expect(amounts(revived)).toEqual(amounts(live));
    expect(enemyHealth(round)).toBe(enemyHealth(state));
    expect(hashState(round)).toBe(hashState(state));
    expect(round.work).toEqual([]);
  });

  it("§9.3 replaying the same steps reaches an identical state hash, queue included", () => {
    const run = (seed: string): { paused: string; done: string; owed: WorkItem[] } => {
      const state = game(seed);
      const card = resolving(state, chainAsker.id);
      act(state, (sink) => {
        runHookResumable(sink, card, "cry");
      });
      answer(state, "a");
      const owed = owedWork(state);
      const pausedHash = hashState(state);
      answer(state, "b");
      return { paused: pausedHash, done: hashState(state), owed };
    };

    const first = run("replay-work");
    const second = run("replay-work");

    // The same actions on the same seed: the same state, twice over, at the pause and at the end.
    expect(second.paused).toBe(first.paused);
    expect(second.done).toBe(first.done);
    // Including the queue itself: the ids and `seq`s come from state (R68), not from a counter in
    // the run, so a replay builds the queue the live game had.
    expect(second.owed).toEqual(first.owed);
    expect(first.owed).toHaveLength(2);
    // The queue is inside the hash, so a state with work owed is not the state that finished it.
    expect(first.paused).not.toBe(first.done);
  });
});

// ---------------------------------------------------------------------------
// The queue itself
// ---------------------------------------------------------------------------

describe("the work queue (§9.3, R68)", () => {
  let state: GameState;
  let sink: EngineSink;

  beforeEach(() => {
    state = game("queue");
    sink = sinkFor(state);
  });

  const stub = (step: string): Resume => resumeAt({ defId: "", step });

  it("R68 pushes in creation order, ids and `seq` from state, and takes the innermost first", () => {
    const seqBefore = state.nextSeq;
    // One pause cascade, parked the way R113 says a cascade parks: the innermost scope is the one
    // that noticed the prompt, so it parks first, and the scope around it parks behind it at the
    // cursor. Taking from the front therefore takes the innermost.
    const inner = pushWork(sink, stub("inner"));
    const outer = pushWork(sink, stub("outer"), "p2");

    expect([inner.id, outer.id]).toEqual([`w${seqBefore}`, `w${seqBefore + 1}`]);
    expect([inner.seq, outer.seq]).toEqual([seqBefore, seqBefore + 1]);
    expect(state.nextSeq).toBe(seqBefore + 2);
    // The owner defaults to the active player and is otherwise the one given.
    expect(inner.owner).toBe("p1");
    expect(outer.owner).toBe("p2");

    expect(state.work.map((item) => item.id)).toEqual([inner.id, outer.id]);
    expect(peekWork(state)).toBe(inner);
    expect(takeWork(state)).toBe(inner);
    expect(takeWork(state)).toBe(outer);
    expect(takeWork(state)).toBeUndefined();
    expect(hasWork(state)).toBe(false);
  });

  it("§9.3 re-queues a whole item unchanged, so a handler can wait behind another one", () => {
    const item = pushWork(sink, stub("waits"));
    const taken = takeWork(state);
    expect(taken).toBe(item);

    owe(sink, item);
    expect(state.work).toEqual([item]);
    // Same id and same `seq`: re-queueing is not a new piece of work (R68's order is kept).
    expect(state.work[0]?.id).toBe(item.id);
    expect(state.nextSeq).toBe(item.seq + 1);
  });

  it("§9.3 parks the tail of a list with the index and selections it was running with", () => {
    const item = parkWork(
      sink,
      { ...stub("picked"), hook: "cry", owner: "p2", data: { seen: 1 } },
      { from: 3, targets: [{ pick: "mode", option: "a" }], modes: ["left"] },
    );

    expect(item.owner).toBe("p2");
    expect(item.resume.hook).toBe("cry");
    expect(pausedOf(item.resume.data)).toEqual({
      from: 3,
      targets: [{ pick: "mode", option: "a" }],
      modes: ["left"],
    });
    // The card's own captured data is still its own, beside the control block.
    expect(item.resume.data.seen).toBe(1);
    expect(unserializable(item)).toEqual([]);
  });

  it("§10.5 drops the tail a step parked once the step has run without asking", () => {
    const kept = pushWork(sink, stub("kept"));
    const parked = pushWork(sink, stub("parked"));

    expect(unparkWork(state, parked.id)).toBe(parked);
    expect(state.work).toEqual([kept]);
    expect(unparkWork(state, parked.id)).toBeUndefined();

    pushWork(sink, { ...stub("other"), hook: SEQUENCE_HOOK });
    expect(owedWork(state, SEQUENCE_HOOK)).toHaveLength(1);
    expect(dropWork(state, (item) => item.resume.hook === SEQUENCE_HOOK)).toHaveLength(1);
    expect(isOwed(state, SEQUENCE_HOOK)).toBe(false);
    expect(state.work).toEqual([kept]);
  });

  it("§9.3 runs nothing while a prompt is open: the answer is another action", () => {
    pushWork(sink, { ...stub("later"), hook: SEQUENCE_HOOK, data: { [AT_KEY]: 2 } });
    ask(sink, "p1");

    expect(paused(sink)).toBe(true);
    expect(runNextWork(sink)).toBe(false);
    expect(drainWork(sink)).toBe(false);
    expect(state.work).toHaveLength(1);

    // Nor after the game has ended: what was owed stays owed and nothing resolves into a result.
    closePrompt(sink);
    state.result = { winner: "p1", reason: "concede" };
    expect(paused(sink)).toBe(true);
    expect(runNextWork(sink)).toBe(false);
    expect(state.work).toHaveLength(1);
  });

  it("§9.3 throws rather than drop work whose sequence registered no handler", () => {
    const item = pushWork(sink, { ...stub("orphan"), hook: "__noSuchSequence" });
    // Cleared for this test only: `prompts.ts` registers the default handler in the engine, and a
    // card continuation with no matching step is a no-op rather than an error (§10.6).
    const previous = registerDefaultWorkHandler(undefined);
    try {
      expect(() => runWorkItem(sink, item)).toThrow(/no handler for owed work "__noSuchSequence"/);
    } finally {
      registerDefaultWorkHandler(previous);
    }
  });

  it("§9.3 stops a sequence that keeps owing work instead of spinning", () => {
    const loop = "__pausesTestLoop";
    const previous = registerWorkHandler(loop, (inner, item) => {
      owe(inner, item.resume);
    });
    try {
      pushWork(sink, { ...stub("again"), hook: loop });
      expect(() => drainWork(sink)).toThrow(new RegExp(`did not drain in ${MAX_WORK_STEPS} steps`));
    } finally {
      registerWorkHandler(loop, previous);
    }
  });
});
