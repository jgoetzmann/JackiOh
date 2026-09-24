// `state.pending`, the ten prompt kinds and the serializable continuation that makes answering one
// re-enter the script that asked (SPEC §10.6, BUILD M3-T3).
//
// What this file has to prove, in the words of the acceptance list: a state with an open prompt
// survives `JSON.parse(JSON.stringify(state))` and answering still works; the opponent's `viewFor`
// shows `pendingFor: playerId` and no options; an `answer` with an option not in `options` errors;
// `legalActions` lists every option. Around those: `resume` is a script id, a step name and
// captured data and never a closure (§9.3), chained prompts run to the end of the chain (Private
// Tutor's three steps, Craft a Card's two Discovers), a prompt in the middle of an effect list
// parks the tail rather than skipping it, R81's split between play choices and resolution choices,
// and R98's "a card that asks a question while it resolves is still itself".
//
// The fixture cards here have no Core counterpart yet (M4 builds the real ones), so they live in
// this file rather than in a shared fixture, as aiPolicy.test.ts does for its own (BUILD §0).

import type { Action, ActionInput, CardDef, PlayerId, PromptKind, Selection } from "@jackioh/shared";
import { describe, expect, it } from "vitest";
import { registerCatalog, registeredCatalog } from "../src/catalog";
import { HERO_HEALTH } from "../src/config";
import {
  addToHand,
  chooseFromHand,
  chooseMode,
  chooseTarget,
  chosenOptions,
  damage,
  discoverFromCatalog,
  discoverFromGraveyard,
  remember,
} from "../src/effects";
import {
  MAX_PROMPT_ANSWERS,
  PROMPT_KINDS,
  answerPrompt,
  openPrompt,
  promptAnswers,
  runHookResumable,
  whyAnswerRefused,
} from "../src/prompts";
import { beginGame, legalActions, reduce } from "../src/reduce";
import { makeContext, type EngineSink } from "../src/resolve";
import type { CardScripts, Effect, EffectContext, Script } from "../src/script";
import { registerScripts, registeredScripts } from "../src/scripts";
import {
  newInstance,
  type CardInstance,
  type GameState,
  type PendingChoice,
  type PromptOption,
  type Resume,
} from "../src/state";
import { viewFor } from "../src/viewFor";
import { canResume } from "../src/work";
import { plain } from "./fixtures/combat";
import { goingLong, xBolt } from "./fixtures/scripts";
import { inHand, newGame, put, sinkFor, slot } from "./fixtures/harness";

// ---------------------------------------------------------------------------
// Fixture definitions
// ---------------------------------------------------------------------------

let nextIndex = 1400;
function def(name: string, type: CardDef["type"], extra: Partial<CardDef> = {}): CardDef {
  nextIndex += 1;
  return {
    id: `pr-${name}`,
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

function unit(name: string, extra: Partial<CardDef> = {}): CardDef {
  return def(name, "Unit", {
    base: { attack: 2, health: 2, keywords: [], text: name },
    radiant: { attack: 4, health: 4, keywords: [], text: name },
    ...extra,
  });
}

/** #26 KY's Private Tutor's shape: three chained steps, each one carrying the last one's pick. */
const tutor = def("tutor", "Spell");
/** #66 Craft a Card's shape: two Discovers, the first one's pick carried into the second. */
const crafter = def("crafter", "Spell");
/** A prompt in the middle of an effect list, so the tail has to be parked (§9.3). */
const midList = def("mid-list", "Spell");
/** R98: a card that asks a question while it resolves. */
const asker = def("asker", "Spell");
/** R81: a card whose direction travels in the play action (#52 Silly Silas's shape). */
const director = def("director", "Spell");
/** R81: a card that pays a Tribute, which is also a play choice. */
const tributer = unit("tributer", { cost: 2 });
/** What the chain hands over when every step's pick arrived, and what it hands over otherwise. */
const prize = unit("prize");
const decoy = unit("decoy");

const DEFS: CardDef[] = [tutor, crafter, midList, asker, director, tributer, prize, decoy];

// ---------------------------------------------------------------------------
// Fixture scripts
// ---------------------------------------------------------------------------

/** The picks every step of a chain has made so far, oldest first (§10.6's "captured data"). */
function pickedSoFar(ctx: EffectContext): string[] {
  const held = ctx.data.picked;
  const before = Array.isArray(held) ? held.filter((value): value is string => typeof value === "string") : [];
  return [...before, ...chosenOptions(ctx)];
}

const tutorScript: Script = {
  cry: () => [chooseMode({ options: ["tutor-a", "tutor-b"], step: "two", prompt: "Private Tutor 1" })],
  resume: {
    two: (ctx) => [
      chooseMode({
        options: ["tutor-c", "tutor-d"],
        step: "three",
        prompt: "Private Tutor 2",
        data: { picked: pickedSoFar(ctx) },
      }),
    ],
    three: (ctx) => [
      chooseMode({
        options: ["tutor-e", "tutor-f"],
        step: "done",
        prompt: "Private Tutor 3",
        data: { picked: pickedSoFar(ctx) },
      }),
    ],
    // The prize proves that all three picks reached the last step, in the order they were made.
    done: (ctx) => {
      const all = pickedSoFar(ctx);
      const asExpected = all.join("+") === "tutor-b+tutor-c+tutor-f";
      return [
        addToHand({ defId: asExpected ? prize.id : decoy.id }),
        damage({ to: { of: "enemyHero" }, amount: all.length }),
      ];
    },
  },
};

const crafterScript: Script = {
  cry: () => [discoverFromCatalog({ step: "second", query: { type: "Unit" }, prompt: "Craft 1" })],
  resume: {
    second: (ctx) => [
      discoverFromCatalog({
        step: "made",
        query: { type: "Spell" },
        prompt: "Craft 2",
        data: { first: chosenOptions(ctx)[0] ?? "" },
      }),
    ],
    made: (ctx) => [
      addToHand({ defId: String(ctx.data.first ?? "") }),
      addToHand({ defId: chosenOptions(ctx)[0] ?? "" }),
    ],
  },
};

const midListScript: Script = {
  cry: () => [
    damage({ to: { of: "enemyHero" }, amount: 1 }),
    chooseMode({ options: ["left", "right"], step: "after", prompt: "mid-list" }),
    // The tail: it must run after the answer, not before it and not never.
    damage({ to: { of: "enemyHero" }, amount: 2 }),
  ],
  resume: { after: () => [damage({ to: { of: "enemyHero" }, amount: 4 })] },
};

/** R98: `remember` writes on `ctx.self`, so it writes nothing at all when the card is gone. */
function askerScript(face: "base" | "radiant"): Script {
  return {
    cry: (ctx) => [
      chooseMode({
        options: ["ask-a", "ask-b"],
        step: "check",
        prompt: "asked while resolving",
        data: { carried: ctx.x },
      }),
    ],
    resume: {
      check: (ctx) => [
        remember({
          key: "sawSelf",
          value: { id: ctx.self?.id ?? null, x: ctx.x, grade: ctx.self?.counters.grade ?? null, face },
        }),
        damage({ to: { of: "enemyHero" }, amount: Number(ctx.data.carried ?? 0) }),
      ],
    },
  };
}

const directorScript: Script = {
  modes: [{ kind: "direction", options: ["left", "right"] }],
  cry: (ctx) => [damage({ to: { of: "enemyHero" }, amount: ctx.modes[0] === "right" ? 3 : 1 })],
};

const tributerScript: Script = {
  staticFlags: { tribute: 1 },
  targets: [{ kind: "tribute", min: 1, max: 1, filter: { side: "ally", of: ["unit"] }, amount: 1 }],
};

function both(script: Script): CardScripts {
  return { base: script, radiant: script };
}

const SCRIPTS: Record<string, CardScripts> = {
  [tutor.id]: both(tutorScript),
  [crafter.id]: both(crafterScript),
  [midList.id]: both(midListScript),
  [asker.id]: { base: askerScript("base"), radiant: askerScript("radiant") },
  [director.id]: both(directorScript),
  [tributer.id]: both(tributerScript),
};

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function register(): void {
  registerCatalog({ ...registeredCatalog(), ...Object.fromEntries(DEFS.map((d) => [d.id, d])) });
  registerScripts({ ...registeredScripts(), ...SCRIPTS });
}

/** p1's main phase on turn 3 with 4 mana; `newGame` re-registers the fixtures, so `register` is after. */
function board(seed: string): GameState {
  const state = newGame(seed);
  register();
  state.turn = 3;
  state.active = "p1";
  state.phase = "main";
  state.players.p1.mana = { current: 4, max: 4, nextTurnMod: 0, permMod: 0 };
  return state;
}

let seq = 0;
function act(state: GameState, body: ActionInput): ReturnType<typeof reduce> {
  seq += 1;
  return reduce(state, { ...body, nonce: `pr${seq}` } as Action);
}

/** Past both mulligans, in p1's main phase, the way playChoices-filters.test.ts sets up. */
function playing(seed: string): GameState {
  let state = beginGame(newGame(seed)).state;
  state = act(state, { type: "mulligan", keep: state.players.p1.hand.map((c) => c.id), playerId: "p1" }).state;
  state = act(state, { type: "mulligan", keep: state.players.p2.hand.map((c) => c.id), playerId: "p2" }).state;
  register();
  state.players.p1.mana = { current: 4, max: 4, nextTurnMod: 0, permMod: 0 };
  return state;
}

/** §10.5 step 4: a Spell between its play and its graveyard, which is where a Cry's prompt opens. */
function resolvingCard(
  state: GameState,
  defId: string,
  options: { player?: PlayerId; radiant?: boolean; x?: number; grade?: number } = {},
): CardInstance {
  const player = options.player ?? "p1";
  const card = newInstance(state, defId, player, { z: "resolving", player });
  if (options.radiant === true) card.radiant = true;
  if (options.x !== undefined) card.x = options.x;
  if (options.grade !== undefined) card.counters.grade = options.grade;
  state.players[player].resolving.push(card);
  return card;
}

function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`expected ${what}`);
  return value;
}

function at<T>(list: readonly T[], index: number): T {
  const value = list[index];
  if (value === undefined) throw new Error(`nothing at index ${index}`);
  return value;
}

function modeOption(option: string): PromptOption {
  return { key: `mode:${option}`, label: option, selection: { pick: "mode", option } };
}

/** A continuation no script services: answering such a prompt just closes it (§10.6). */
const inertResume: Resume = { defId: "pr-nothing", hook: "resume", step: "none", radiant: false, data: {} };

/** Answer the open prompt by option key, the way a client would send back what it was offered. */
function answer(sink: EngineSink, pending: PendingChoice, ...keys: readonly string[]): string | null {
  const selection = keys.map((key) => {
    const option = pending.options.find((o) => o.key === key);
    if (option === undefined) throw new Error(`"${pending.prompt}" never offered ${key}`);
    return option.selection;
  });
  return answerPrompt(sink, { playerId: pending.playerId, choiceId: pending.id, selection });
}

/** Apply one effect outside a card, the way `resolve.ts` does. */
function run(state: GameState, effect: Effect, controller: PlayerId = "p1"): void {
  const sink = sinkFor(state);
  effect.apply(makeContext(sink, null, { controller }));
  state.rngCursor = sink.rng.cursor;
}

/** Every value reachable from a state fragment, so "nothing here is a function" can be asserted. */
function deepValues(value: unknown, out: unknown[] = []): unknown[] {
  out.push(value);
  if (Array.isArray(value)) {
    for (const item of value) deepValues(item, out);
  } else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) deepValues(item, out);
  }
  return out;
}

// ---------------------------------------------------------------------------

describe("prompts (§10.6, M3-T3)", () => {
  it("§10.6 a state with an open prompt survives a JSON round-trip and still answers", () => {
    const state = board("round-trip");
    const sink = sinkFor(state);
    const card = resolvingCard(state, tutor.id);
    runHookResumable(sink, card, "cry");
    const pending = must(state.pending, "Private Tutor's first prompt");
    expect(pending.prompt).toBe("Private Tutor 1");

    // §10.1 keeps the state JSON-only, so the round trip is lossless.
    const clone = JSON.parse(JSON.stringify(state)) as GameState;
    expect(clone).toEqual(state);
    expect(clone.pending).toEqual(pending);

    // And the clone still answers: the continuation was data, so nothing was left behind.
    const cloneSink = sinkFor(clone);
    const clonePending = must(clone.pending, "the round-tripped prompt");
    expect(answer(cloneSink, clonePending, "mode:tutor-b")).toBeNull();
    expect(must(clone.pending, "the next prompt").prompt).toBe("Private Tutor 2");

    // Answering the clone left the original alone, which is what makes a replay reproducible.
    expect(must(state.pending, "the original prompt").prompt).toBe("Private Tutor 1");
  });

  it("§10.6 resume is a script id, a step and captured data, and never a closure (§9.3)", () => {
    const state = board("no-closures");
    const sink = sinkFor(state);
    const card = resolvingCard(state, midList.id);
    runHookResumable(sink, card, "cry");
    const pending = must(state.pending, "the mid-list prompt");

    // The prompt, its options and its continuation are all plain data.
    for (const value of deepValues(pending)) expect(typeof value).not.toBe("function");
    // So is the parked tail the prompt interrupted.
    expect(state.work).toHaveLength(1);
    for (const value of deepValues(state.work)) expect(typeof value).not.toBe("function");

    // "script id + step + captured data" (§10.6), and nothing else at all.
    expect(pending.resume).toMatchObject({
      defId: midList.id,
      hook: "resume",
      step: "after",
      radiant: false,
      instanceId: card.id,
    });
    expect(Object.keys(pending.resume).sort()).toEqual(["data", "defId", "hook", "instanceId", "radiant", "step"]);
    expect(typeof pending.resume.step).toBe("string");
    expect(pending.resume.data).toBeTypeOf("object");
  });

  it("M3-T3 an answer naming an option the prompt did not offer is refused, and the prompt stays open", () => {
    const state = board("refusals");
    const sink = sinkFor(state);
    const pending = must(
      openPrompt(sink, {
        player: "p1",
        kind: "mode",
        prompt: "Choose one",
        options: [modeOption("burn"), modeOption("freeze")],
        resume: inertResume,
      }),
      "the mode prompt",
    );
    const offered = at(pending.options, 0).selection;
    const notOffered: Selection = { pick: "mode", option: "never-offered" };

    expect(
      whyAnswerRefused(pending, { playerId: "p1", choiceId: pending.id, selection: [notOffered] }),
    ).toMatch(/not one of the options offered/);
    expect(
      answerPrompt(sink, { playerId: "p1", choiceId: pending.id, selection: [notOffered] }),
    ).toMatch(/not one of the options offered/);
    // A refused answer changes nothing: the prompt is still there to answer.
    expect(state.pending).toBe(pending);

    // A selection of another kind is not an option either, whatever it carries.
    expect(
      whyAnswerRefused(pending, {
        playerId: "p1",
        choiceId: pending.id,
        selection: [{ pick: "instance", instanceId: "c1" }],
      }),
    ).toMatch(/not one of the options offered/);

    // The wrong player, a stale choice id and the wrong number of picks are all refused (§10.6).
    expect(whyAnswerRefused(pending, { playerId: "p2", choiceId: pending.id, selection: [offered] })).toMatch(
      /belongs to the other player/,
    );
    expect(whyAnswerRefused(pending, { playerId: "p1", choiceId: "q999", selection: [offered] })).toMatch(
      /no prompt q999 is open/,
    );
    expect(whyAnswerRefused(pending, { playerId: "p1", choiceId: pending.id, selection: [] })).toMatch(
      /exactly 1 pick/,
    );
    expect(
      whyAnswerRefused(pending, {
        playerId: "p1",
        choiceId: pending.id,
        selection: [offered, at(pending.options, 1).selection],
      }),
    ).toMatch(/exactly 1 pick/);

    // The option the prompt did offer is accepted, and the prompt closes.
    expect(answerPrompt(sink, { playerId: "p1", choiceId: pending.id, selection: [offered] })).toBeNull();
    expect(state.pending).toBeNull();
  });

  it("R60 a prompt that takes two picks refuses the same option twice", () => {
    const state = board("two-picks");
    const hand = inHand(state, plain.id, "p1", 3);
    const sink = sinkFor(state);
    run(state, chooseFromHand({ step: "none", count: 2, prompt: "Choose two" }));
    const pending = must(state.pending, "the two-card hand prompt");
    expect(pending.kind).toBe("hand");
    expect(pending.min).toBe(2);
    expect(pending.max).toBe(2);

    const first: Selection = { pick: "instance", instanceId: at(hand, 0).id };
    expect(whyAnswerRefused(pending, { playerId: "p1", choiceId: pending.id, selection: [first, first] })).toMatch(
      /picked twice/,
    );
    expect(
      whyAnswerRefused(pending, {
        playerId: "p1",
        choiceId: pending.id,
        selection: [first, { pick: "instance", instanceId: at(hand, 1).id }],
      }),
    ).toBeNull();
    expect(state.pending).toBe(pending);
    expect(sink.state).toBe(state);
  });

  it("M3-T3 promptAnswers enumerates every option, in the order they were offered", () => {
    const state = board("enumeration");
    const sink = sinkFor(state);
    const one = must(
      openPrompt(sink, {
        player: "p1",
        kind: "mode",
        prompt: "one of three",
        options: [modeOption("a"), modeOption("b"), modeOption("c")],
        resume: inertResume,
      }),
      "the one-of-three prompt",
    );
    expect(promptAnswers(one).map((action) => action.selection)).toEqual([
      [{ pick: "mode", option: "a" }],
      [{ pick: "mode", option: "b" }],
      [{ pick: "mode", option: "c" }],
    ]);
    expect(promptAnswers(one).every((action) => action.choiceId === one.id)).toBe(true);

    // "Choose 1 or 2": the singles first, then the pairs, each pair in offered order.
    state.pending = null;
    const upToTwo = must(
      openPrompt(sink, {
        player: "p1",
        kind: "target",
        prompt: "one or two",
        options: [modeOption("a"), modeOption("b"), modeOption("c")],
        min: 1,
        max: 2,
        resume: inertResume,
      }),
      "the one-or-two prompt",
    );
    expect(promptAnswers(upToTwo).map((action) => action.selection.map((s) => (s.pick === "mode" ? s.option : "")))).toEqual(
      [["a"], ["b"], ["c"], ["a", "b"], ["a", "c"], ["b", "c"]],
    );
    expect(promptAnswers(upToTwo).length).toBeLessThanOrEqual(MAX_PROMPT_ANSWERS);

    // §2.1: a mulligan has its own action, so it is not enumerated as an `answer`.
    const mulligan = must(beginGame(newGame("enumeration-mulligan")).state.pending, "the mulligan prompt");
    expect(mulligan.kind).toBe("mulligan");
    expect(promptAnswers(mulligan)).toEqual([]);
  });

  it("R211 legalActions lists every option of the open prompt, and concede for both seats besides (M3-T3)", () => {
    const state = board("legal-actions");
    const sink = sinkFor(state);
    const pending = must(
      openPrompt(sink, {
        player: "p1",
        kind: "mode",
        prompt: "Choose one",
        options: [modeOption("a"), modeOption("b"), modeOption("c")],
        resume: inertResume,
      }),
      "the mode prompt",
    );

    // §10.7: with a prompt open the policy draws from that prompt's answers alone, which is what
    // BUILD M3-T3's "legalActions lists every option" and R44's uniform answering both rest on.
    // R211: `reduce` accepts a concede from either seat while the prompt is open, so both are
    // offered it too — and the policy never takes it (R84).
    expect(legalActions(state, "p1")).toEqual([...promptAnswers(pending), { type: "concede" }]);
    expect(legalActions(state, "p1").filter((action) => action.type === "answer")).toHaveLength(
      pending.options.length,
    );
    expect(legalActions(state, "p2")).toEqual([{ type: "concede" }]);
  });

  it("§10.8 the opponent's view shows pendingFor and none of the options", () => {
    const state = board("pending-for");
    openPrompt(sinkFor(state), {
      player: "p1",
      kind: "discover",
      prompt: "Discover a card",
      options: [modeOption("first"), modeOption("second"), modeOption("third")],
      resume: inertResume,
    });

    expect(viewFor(state, "p2").pending).toEqual({ forYou: false, pendingFor: "p1" });
    const theirs = JSON.stringify(viewFor(state, "p2"));
    for (const option of ["first", "second", "third", "Discover a card"]) {
      expect(theirs).not.toContain(option);
    }
    // The chooser gets the whole prompt, which is the half that makes the hiding meaningful.
    const mine = viewFor(state, "p1").pending;
    expect(mine).toMatchObject({ forYou: true, kind: "discover", min: 1, max: 1 });
  });

  it("§10.6 chains Private Tutor's three steps, each step carrying the picks before it", () => {
    const state = board("three-steps");
    const sink = sinkFor(state);
    const card = resolvingCard(state, tutor.id);
    const handBefore = state.players.p1.hand.length;

    runHookResumable(sink, card, "cry");
    const first = must(state.pending, "step 1");
    expect(first.kind).toBe("mode");
    expect(first.playerId).toBe("p1");
    expect(first.options.map((option) => option.key)).toEqual(["mode:tutor-a", "mode:tutor-b"]);

    expect(answer(sink, first, "mode:tutor-b")).toBeNull();
    const second = must(state.pending, "step 2");
    expect(second.prompt).toBe("Private Tutor 2");
    expect(second.id).not.toBe(first.id);

    expect(answer(sink, second, "mode:tutor-c")).toBeNull();
    const third = must(state.pending, "step 3");
    expect(third.prompt).toBe("Private Tutor 3");

    expect(answer(sink, third, "mode:tutor-f")).toBeNull();
    // The chain is done: no prompt, no parked work, and the last step ran.
    expect(state.pending).toBeNull();
    expect(state.work).toEqual([]);
    // The prize, not the decoy: all three picks reached the last step, in the order they were made.
    expect(state.players.p1.hand.map((held) => held.defId)).toContain(prize.id);
    expect(state.players.p1.hand.map((held) => held.defId)).not.toContain(decoy.id);
    expect(state.players.p1.hand).toHaveLength(handBefore + 1);
    expect(state.players.p2.hero.health).toBe(HERO_HEALTH - 3);
  });

  it("§10.6 chains Craft a Card's two Discovers, each drawing from its own pool", () => {
    const state = board("two-discovers");
    const sink = sinkFor(state);
    const card = resolvingCard(state, crafter.id);

    runHookResumable(sink, card, "cry");
    const first = must(state.pending, "the first Discover");
    expect(first.kind).toBe("discover");
    expect(first.options).toHaveLength(3);
    const firstIds = first.options.flatMap((option) =>
      option.selection.pick === "mode" ? [option.selection.option] : [],
    );
    expect(firstIds).toHaveLength(3);

    expect(answer(sink, first, at(first.options, 0).key)).toBeNull();
    const second = must(state.pending, "the second Discover");
    expect(second.kind).toBe("discover");
    expect(second.options).toHaveLength(3);
    const secondIds = second.options.flatMap((option) =>
      option.selection.pick === "mode" ? [option.selection.option] : [],
    );
    // A different pool: the first Discover offered Units, the second Spells (§5.1's query).
    expect(secondIds.some((id) => firstIds.includes(id))).toBe(false);

    expect(answer(sink, second, at(second.options, 1).key)).toBeNull();
    expect(state.pending).toBeNull();
    // Both picks landed: the first came out of `resume.data`, the second out of the answer.
    const hand = state.players.p1.hand.map((held) => held.defId);
    expect(hand).toContain(at(firstIds, 0));
    expect(hand).toContain(at(secondIds, 1));
  });

  it("§9.3 a prompt in the middle of an effect list parks the tail and the answer runs it", () => {
    const state = board("parked-tail");
    const sink = sinkFor(state);
    const card = resolvingCard(state, midList.id);

    runHookResumable(sink, card, "cry");
    // The first effect ran, the second opened the prompt, and the third is waiting in state.
    expect(state.players.p2.hero.health).toBe(HERO_HEALTH - 1);
    const pending = must(state.pending, "the mid-list prompt");
    expect(state.work).toHaveLength(1);
    expect(at(state.work, 0).resume).toMatchObject({ defId: midList.id, hook: "cry", instanceId: card.id });

    expect(answer(sink, pending, "mode:left")).toBeNull();
    // The answered step ran, then the parked tail: 1 + 4 + 2, and nothing ran twice. The tail runs
    // because answering continues what the prompt interrupted (R113) — nothing else drains here.
    expect(state.players.p2.hero.health).toBe(HERO_HEALTH - 7);
    expect(state.pending).toBeNull();
    expect(state.work).toEqual([]);
  });

  it("R113 registers the card-continuation work handler, so a parked tail always has an owner", () => {
    const state = board("tail-has-an-owner");
    const sink = sinkFor(state);
    const card = resolvingCard(state, midList.id);

    runHookResumable(sink, card, "cry");
    const owed = at(state.work, 0);

    // The parked tail's hook is the card's own (`cry`), which no engine sequence claims, so the
    // only thing that can run it is the handler `prompts.ts` registers for itself. This file
    // registers none — unlike `pauses.test.ts`, which supplies that wiring on the module's behalf
    // and so cannot notice it missing. R113 raises rather than dropping an item nobody can resume,
    // so a dropped registration turns every mid-list prompt into an error: assert the wiring, not
    // just the behaviour.
    expect(canResume(owed.resume)).toBe(true);
    expect(canResume({ ...owed.resume, hook: "__noSuchHook" })).toBe(false);
  });

  it("R98 a card that asks a question while it resolves is still itself", () => {
    const state = board("r98-self");
    const sink = sinkFor(state);
    // §10.5 step 4 parks a resolving card in `resolving`, which `findInstance` searches (R98).
    const card = resolvingCard(state, asker.id, { radiant: true, x: 3, grade: 2 });

    runHookResumable(sink, card, "cry");
    const pending = must(state.pending, "the resolving card's prompt");
    expect(answer(sink, pending, "mode:ask-a")).toBeNull();

    // The resumed step found the card, with its counters, its X and its radiant face.
    expect(card.memory.sawSelf).toEqual({ id: card.id, x: 3, grade: 2, face: "radiant" });
    expect(state.players.p2.hero.health).toBe(HERO_HEALTH - 3);
  });

  it("R98 a card that has left the resolving zone resumes with no self, from its captured data", () => {
    const state = board("r98-gone");
    const sink = sinkFor(state);
    const card = resolvingCard(state, asker.id, { x: 2 });

    runHookResumable(sink, card, "cry");
    const pending = must(state.pending, "the resolving card's prompt");

    // The card ceases to exist before its own question is answered (R11's `gone`).
    state.players.p1.resolving = state.players.p1.resolving.filter((held) => held.id !== card.id);
    expect(answer(sink, pending, "mode:ask-b")).toBeNull();

    // `remember` writes on `ctx.self`, so an empty memory is the proof that self was null.
    expect(card.memory.sawSelf).toBeUndefined();
    // The step still ran, on what the Cry captured in `resume.data` rather than on the instance.
    expect(state.players.p2.hero.health).toBe(HERO_HEALTH - 2);
    expect(state.pending).toBeNull();
  });

  it("§10.1 a second ask never overwrites an unanswered prompt, and no options is no prompt", () => {
    const state = board("one-prompt");
    const sink = sinkFor(state);
    const first = must(
      openPrompt(sink, {
        player: "p1",
        kind: "mode",
        prompt: "first",
        options: [modeOption("a")],
        resume: inertResume,
      }),
      "the first prompt",
    );
    expect(
      openPrompt(sink, {
        player: "p2",
        kind: "mode",
        prompt: "second",
        options: [modeOption("b")],
        resume: inertResume,
      }),
    ).toBeNull();
    expect(state.pending).toBe(first);

    // §6.3: with nothing to offer the effect fizzles and no prompt opens at all.
    const empty = board("no-options");
    expect(
      openPrompt(sinkFor(empty), {
        player: "p1",
        kind: "target",
        prompt: "nothing to pick",
        options: [],
        resume: inertResume,
      }),
    ).toBeNull();
    expect(empty.pending).toBeNull();
    // The same through the effects library: an empty board offers no target (§6.3, §10.6).
    run(empty, chooseTarget({ step: "none", scope: { side: "any", of: ["unit"] } }));
    expect(empty.pending).toBeNull();
  });

  it("R81 opens discover, target, mode and hand prompts, and never one of the five play choices", () => {
    // §10.6 lists ten kinds; the module names all ten, since the five play choices stay for later sets.
    expect([...PROMPT_KINDS].sort()).toEqual([
      "direction",
      "discover",
      "embiggen",
      "hand",
      "mode",
      "mulligan",
      "target",
      "tribute",
      "x",
      "zone",
    ]);

    const openers: { name: string; effect: Effect }[] = [
      { name: "chooseMode", effect: chooseMode({ options: ["a", "b"], step: "none" }) },
      { name: "chooseTarget", effect: chooseTarget({ step: "none", scope: { side: "any", of: ["unit", "hero"] } }) },
      { name: "chooseFromHand", effect: chooseFromHand({ step: "none" }) },
      { name: "discoverFromCatalog", effect: discoverFromCatalog({ step: "none", query: { type: "Unit" } }) },
      { name: "discoverFromGraveyard", effect: discoverFromGraveyard({ step: "none" }) },
    ];

    const kinds = new Set<PromptKind>();
    for (const { name, effect } of openers) {
      const state = board(`kind-${name}`);
      inHand(state, plain.id, "p1", 2);
      put(state, plain.id, slot("p1", "units", 1));
      put(state, plain.id, slot("p2", "units", 1));
      state.players.p1.graveyard.push(newInstance(state, plain.id, "p1", { z: "graveyard", player: "p1" }));
      run(state, effect);
      kinds.add(must(state.pending, `${name}'s prompt`).kind);
    }
    // Every kind the effects library can open, plus the mulligan §2.1 opens for itself.
    expect([...kinds].sort()).toEqual(["discover", "hand", "mode", "target"]);
    expect(must(beginGame(newGame("kind-mulligan")).state.pending, "the mulligan").kind).toBe("mulligan");

    // R81: "No Core card opens an `x`, `embiggen`, `zone`, `tribute` or `direction` prompt, since
    // all five are play choices." Nothing in the effects library can, so nothing built from it can.
    for (const kind of ["x", "embiggen", "zone", "tribute", "direction"] as const) {
      expect([...kinds]).not.toContain(kind);
    }
  });

  it("R81 carries X, embiggen, the zone, the Tribute and the direction in the play action, opening no prompt", () => {
    // X: the value travels in `play.x` and is the cost, never a prompt (R65).
    const xState = playing("r81-x");
    const bolt = at(inHand(xState, xBolt.id, "p1"), 0);
    const xPlayed = act(xState, { type: "play", instanceId: bolt.id, x: 2, playerId: "p1" });
    expect(xPlayed.error).toBeUndefined();
    expect(xPlayed.state.pending).toBeNull();
    expect(xPlayed.state.players.p2.hero.health).toBe(HERO_HEALTH - 2);

    // Embiggen: the price travels in `play.embiggen`.
    const bigState = playing("r81-embiggen");
    const long = at(inHand(bigState, goingLong.id, "p1"), 0);
    const bigPlayed = act(bigState, { type: "play", instanceId: long.id, embiggen: true, playerId: "p1" });
    expect(bigPlayed.error).toBeUndefined();
    expect(bigPlayed.state.pending).toBeNull();
    expect(bigPlayed.state.players.p1.mana.current).toBe(0);

    // Zone: the lane travels in `play.zone`.
    const zoneState = playing("r81-zone");
    const body = at(inHand(zoneState, plain.id, "p1"), 0);
    const zonePlayed = act(zoneState, {
      type: "play",
      instanceId: body.id,
      zone: { row: "units", lane: 4 },
      playerId: "p1",
    });
    expect(zonePlayed.error).toBeUndefined();
    expect(zonePlayed.state.pending).toBeNull();
    expect(zonePlayed.state.players.p1.units[3]?.[0]?.id).toBe(body.id);

    // Direction: a declared `direction` pick travels in `play.modes` (R81's second sentence).
    const dirState = playing("r81-direction");
    const silas = at(inHand(dirState, director.id, "p1"), 0);
    const dirPlayed = act(dirState, { type: "play", instanceId: silas.id, modes: ["right"], playerId: "p1" });
    expect(dirPlayed.error).toBeUndefined();
    expect(dirPlayed.state.pending).toBeNull();
    expect(dirPlayed.state.players.p2.hero.health).toBe(HERO_HEALTH - 3);

    // Tribute: the units sacrificed travel in `play.tributes`, and the declaration that names them
    // is answered in `targets` like every other declared pick (#22's meal is read off `ctx.targets`
    // that way). The sacrifice itself is the play validator's (§10.5 step 2, R90); what R81 says
    // here is that neither half pauses the play with a prompt — this is the same action shape
    // `legalActions` enumerates for the card.
    const tribState = playing("r81-tribute");
    const fodder = put(tribState, plain.id, slot("p1", "units", 1));
    const summoner = at(inHand(tribState, tributer.id, "p1"), 0);
    const tribPlayed = act(tribState, {
      type: "play",
      instanceId: summoner.id,
      tributes: [fodder.id],
      targets: [{ pick: "instance", instanceId: fodder.id }],
      playerId: "p1",
    });
    expect(tribPlayed.error).toBeUndefined();
    expect(tribPlayed.state.pending).toBeNull();
    // And it really was a Tribute: the unit that paid it is off the field.
    expect(tribPlayed.state.players.p1.units.flatMap((pile) => pile ?? [])).not.toContainEqual(
      expect.objectContaining({ id: fodder.id }),
    );
  });

  it("§10.2 the reducer answers the open prompt and refuses an option it did not offer", () => {
    const state = playing("reducer-answer");
    const card = at(inHand(state, tutor.id, "p1"), 0);
    const played = act(state, { type: "play", instanceId: card.id, playerId: "p1" });
    expect(played.error).toBeUndefined();
    const pending = must(played.state.pending, "the prompt the Cry opened");
    expect(pending.prompt).toBe("Private Tutor 1");

    // §10.2's `answer {choiceId, selection}`: an option the prompt never offered comes back as an
    // error on the result, with the state untouched.
    // DISCREPANCY: src/reduce.ts answers `answer` with "prompts arrive with M3" instead of routing
    // it to `prompts.answerPrompt`, which already validates and resumes. The wiring is the
    // reducer's half of M3-T3; `prompts.ts` holds up its end.
    const bad = act(played.state, {
      type: "answer",
      choiceId: pending.id,
      selection: [{ pick: "mode", option: "never-offered" }],
      playerId: "p1",
    });
    expect(bad.error).toMatch(/not one of the options offered/);
    expect(bad.state).toBe(played.state);

    // A prompt blocks every other action while it is open (§9.3).
    expect(act(played.state, { type: "endTurn", playerId: "p1" }).error).toMatch(/a prompt is open/);
    // And it is answerable only by its own player (§10.6).
    expect(
      act(played.state, {
        type: "answer",
        choiceId: pending.id,
        selection: [at(pending.options, 0).selection],
        playerId: "p2",
      }).error,
    ).toMatch(/belongs to the other player/);

    // A legal answer re-invokes the script, which opens the next step of the chain.
    const good = act(played.state, {
      type: "answer",
      choiceId: pending.id,
      selection: [at(pending.options, 1).selection],
      playerId: "p1",
    });
    expect(good.error).toBeUndefined();
    expect(must(good.state.pending, "step 2").prompt).toBe("Private Tutor 2");
  });
});
