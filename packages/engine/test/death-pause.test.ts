// A prompt opened by a Death hook of §4.5 step 3, and by the Cry of a cast (SPEC §4.5, §9.3,
// §10.5, §10.6; R59, R64, R78, R83, R89, R113, R117, R122, R127).
//
// §4.5 step 3 runs one Death hook per collected card, in R68's order, and §10.5's cast runs a Cry.
// Both are effect lists, so both can open a prompt, and the governing rule of this engine is that a
// sequence spanning a prompt must be resumable out of `state.work` alone: never an effect list, a
// closure, or a remaining-units array held across the pause (§9.3, R113). Both used to go through
// the non-resumable `resolve.runHook`, so the effects after the one that asked were applied over the
// open prompt, nothing was parked, and a second dying card's prompt was discarded in silence —
// `openPrompt` refuses to overwrite one that is already open.
//
// What is pinned here, by observable behaviour and not by reading the implementation:
//
//   * R113 and R117 — a Death hook that asks stops the pass where it stands and what is left is
//     *owed*: the rest of that hook's list, the cards after it in R68's order, and steps 4 and 5.
//     Each tail runs exactly once, in R68's order, and `state.work` is empty again at the end.
//   * §9.3 and §10.1 — the paused game survives `JSON.parse(JSON.stringify(state))` and resumes
//     identically from the round-tripped copy, which is what makes a prompt the same thing in live
//     play, in a replay and in a test.
//   * R78 and R89 — the resumed half of a Death hook still reads the snapshot taken just before the
//     card left the field, which the board cannot supply any more: the instance in the graveyard has
//     been reset. The buff each fixture unit carries is the visible difference.
//   * R64 and R83 — a Reborn unit collected in a pass that paused still comes back, at 1 health,
//     without Reborn and summoning sick, once the answer finishes the pass.
//   * R70 and R122 — a cast whose Cry asks does not land until the answer: §10.5's step 6 and step 7
//     are owed rather than run over the open prompt, and `cardResolved` is emitted exactly once.
//
// The control cases are the other half: with nothing asking, the same hooks run in the same order in
// one call and `state.work` never holds anything, so a green run here is not green by vacuity.
//
// Fixtures are this file's own: defs are prefixed `dp-` and indexed from 2600, so they cannot
// collide with another test file's catalog (BUILD §0).

import type { Action, ActionInput, CardDef, GameEvent } from "@jackioh/shared";
import { describe, expect, it } from "vitest";
import { registerCatalog, registeredCatalog } from "../src/catalog";
import { castTailOf } from "../src/echo";
import { openPrompt, resumeSelf } from "../src/prompts";
import { beginGame, reduce } from "../src/reduce";
import { CAST_CRY_WORK, castCard } from "../src/resolve";
import type { CardScripts, Effect, Script } from "../src/script";
import { registerScripts, registeredScripts } from "../src/scripts";
import { DEATHS_WORK, owedDeathsOf, stateCheck } from "../src/stateCheck";
import { newInstance, type CardInstance, type GameState } from "../src/state";
import { owedWork } from "../src/work";
import { cardAt } from "../src/zones";
import { eventsOfType, newGame, put, sinkFor, slot } from "./fixtures/harness";

// ---------------------------------------------------------------------------
// Fixtures.
// ---------------------------------------------------------------------------

let nextIndex = 2600;

function def(name: string, type: CardDef["type"], extra: Partial<CardDef> = {}): CardDef {
  nextIndex += 1;
  const face =
    type === "Unit"
      ? { attack: 1, health: 1, keywords: [], text: name }
      : { keywords: [], text: name };
  return {
    id: `dp-${name}`,
    index: String(nextIndex),
    name: `${name} (death pause)`,
    set: "Core",
    type,
    tags: [],
    rarity: "Common",
    token: false,
    cost: 0,
    base: { ...face },
    radiant: { ...face },
    ...extra,
  };
}

/** The note sink: a Field Spell parked in p1's backrow lane 5, whose memory records the order. */
const logCard = def("log", "Field Spell");
/** Two units whose Death hook asks their controller something before it finishes. */
const askOne = def("ask-one", "Unit");
const askTwo = def("ask-two", "Unit");
/** The same shape without the question, for the control and for R68's far side. */
const quietUnit = def("quiet", "Unit");
/** R64: a unit with Reborn whose Death hook asks, so step 4 is owed behind the pause too. */
const rebornAsker = def("reborn-asker", "Unit", {
  base: { attack: 2, health: 2, keywords: [{ kind: "Reborn" }], text: "reborn asker" },
  radiant: { attack: 2, health: 2, keywords: [{ kind: "Reborn" }], text: "reborn asker" },
});
/** A cast Spell whose Cry asks: #95's recast and §2.4's cast on draw both reach this shape (R58). */
const castAsker = def("cast-asker", "Spell");
/** The same cast without the question. */
const castQuiet = def("cast-quiet", "Spell");

const DEFS = [logCard, askOne, askTwo, quietUnit, rebornAsker, castAsker, castQuiet];

// ---------------------------------------------------------------------------
// The note log: what ran, in the order it ran.
// ---------------------------------------------------------------------------

const NOTE_LANE = 5;

function logOf(state: GameState): CardInstance | null {
  return state.players.p1.backrow[NOTE_LANE - 1] ?? null;
}

function write(state: GameState, entry: string): void {
  const log = logOf(state);
  if (log === null) return;
  const steps = Array.isArray(log.memory.steps) ? (log.memory.steps as string[]) : [];
  log.memory.steps = [...steps, entry];
}

function notes(state: GameState): string[] {
  const log = logOf(state);
  return Array.isArray(log?.memory.steps) ? (log.memory.steps as string[]) : [];
}

function note(entry: string): Effect {
  return {
    kind: "dp:note",
    apply(ctx): void {
      write(ctx.state, entry);
    },
  };
}

/**
 * R78 and R89: a note carrying what `ctx.self` says the card's attack buff is. On the field and in
 * the snapshot a Death hook reads it is 3; the instance the board holds after the move has been
 * reset to 0, so this is the one visible difference between reading the snapshot and re-deriving
 * `ctx.self` from the board — which is exactly what a resumed continuation cannot do.
 */
function noteBuff(label: string): Effect {
  return {
    kind: "dp:noteBuff",
    apply(ctx): void {
      write(ctx.state, `${label}:${ctx.self === null ? "none" : String(ctx.self.buffs.attack)}`);
    },
  };
}

/** §10.6: a prompt for the card's own controller, with one answer, so answering is trivial. */
function askController(): Effect {
  return {
    kind: "dp:ask",
    apply(ctx): void {
      openPrompt(ctx, {
        player: ctx.controller,
        kind: "target",
        prompt: "the dying card asks its owner",
        options: [{ key: "none", label: "nothing", selection: { pick: "none" } }],
        resume: resumeSelf(ctx, "asked"),
      });
    },
  };
}

function both(script: Script): CardScripts {
  return { base: script, radiant: script };
}

/** The shape under test: note, ask, and a tail that must run once and only after the answer. */
function asking(name: string): CardScripts {
  return both({
    death: () => [note(`ask:${name}`), askController(), noteBuff(`tail:${name}`)],
    resume: { asked: () => [note(`answered:${name}`)] },
  });
}

const SCRIPTS: Record<string, CardScripts> = {
  [askOne.id]: asking("one"),
  [askTwo.id]: asking("two"),
  [quietUnit.id]: both({ death: () => [note("quiet:before"), noteBuff("quiet:tail")] }),
  [rebornAsker.id]: asking("reborn"),
  [castAsker.id]: both({
    cry: () => [note("cast:ask"), askController(), noteBuff("cast:tail")],
    resume: { asked: () => [note("cast:answered")] },
  }),
  [castQuiet.id]: both({ cry: () => [note("cast:quiet")] }),
};

// ---------------------------------------------------------------------------
// Harness.
// ---------------------------------------------------------------------------

function game(seed: string): GameState {
  const state = newGame(seed);
  registerCatalog({ ...registeredCatalog(), ...Object.fromEntries(DEFS.map((d) => [d.id, d])) });
  registerScripts({ ...registeredScripts(), ...SCRIPTS });
  return state;
}

let nonce = 0;

function actResult(state: GameState, body: ActionInput): ReturnType<typeof reduce> {
  nonce += 1;
  return reduce(state, { ...body, nonce: `dp${nonce}` } as Action);
}

function act(state: GameState, body: ActionInput): GameState {
  const result = actResult(state, body);
  if (result.error !== undefined) throw new Error(result.error);
  return result.state;
}

/** Past the mulligans, in p1's main phase, with the note log parked in p1's backrow lane 5. */
function playing(seed: string): GameState {
  let state = beginGame(game(seed)).state;
  state = act(state, { type: "mulligan", keep: state.players.p1.hand.map((c) => c.id), playerId: "p1" });
  state = act(state, { type: "mulligan", keep: state.players.p2.hand.map((c) => c.id), playerId: "p2" });
  put(state, logCard.id, slot("p1", "backrow", NOTE_LANE));
  return state;
}

function only<T>(items: readonly T[]): T {
  const first = items[0];
  if (first === undefined) throw new Error("expected exactly one item");
  return first;
}

/** Answer the one open prompt, whoever it belongs to. */
function answer(state: GameState): ReturnType<typeof reduce> {
  const pending = state.pending;
  if (pending === null) throw new Error("expected a prompt to be open");
  const result = actResult(state, {
    type: "answer",
    choiceId: pending.id,
    selection: [{ pick: "none" }],
    playerId: pending.playerId,
  });
  if (result.error !== undefined) throw new Error(result.error);
  return result;
}

const roundTrip = (state: GameState): GameState =>
  JSON.parse(JSON.stringify(state)) as GameState;

/**
 * Put a unit on the board with the buff R78 will strip as it leaves, and mark it for the check.
 * A destroy mark is §4.5 step 1's other way in, so the fixture needs no damage arithmetic (§6.3).
 */
function doomed(state: GameState, defId: string, player: "p1" | "p2", lane: number): CardInstance {
  const card = put(state, defId, slot(player, "units", lane));
  card.buffs = { attack: 3, health: 0 };
  card.markedDestroyed = true;
  return card;
}

function inGraveyard(state: GameState, card: CardInstance): boolean {
  return state.players[card.owner].graveyard.some((held) => held.id === card.id);
}

// ---------------------------------------------------------------------------

describe("a prompt inside §4.5 step 3's Death hooks (R89, R113, R117, R122)", () => {
  it("R113 owes the rest of the pass when a Death hook asks, and both tails run once, in R68's order", () => {
    const state = playing("deaths-owe-remainder");
    // R68: the active player's cards first, by lane, then the opponent's.
    const first = doomed(state, askOne.id, "p1", 1);
    const second = doomed(state, askTwo.id, "p1", 2);
    const far = doomed(state, quietUnit.id, "p2", 1);

    const events: GameEvent[] = [];
    stateCheck(sinkFor(state, events));

    // Step 1 collected all three at once and step 3 got exactly as far as the first question.
    expect(notes(state)).toEqual(["ask:one"]);
    expect(state.pending?.playerId).toBe("p1");
    expect(eventsOfType(events, "destroyed").map((e) => e.instanceId)).toEqual([
      first.id,
      second.id,
      far.id,
    ]);
    // Step 5 has not run either: nothing is reported as having entered a graveyard yet.
    expect(eventsOfType(events, "enteredGraveyard")).toEqual([]);

    // R113 and R117: the pass parked what it still owes — the asking card (mid-list) and the two
    // cards after it, in R68's order. This is the whole fix; without it they are lost.
    const parked = only(owedWork(state, DEATHS_WORK));
    expect(owedDeathsOf(parked.resume)?.owed.map((card) => card.id)).toEqual([
      first.id,
      second.id,
      far.id,
    ]);
    // §9.3: plain data, so no effect list, closure or live unit array is held across the prompt.
    expect(JSON.parse(JSON.stringify(parked))).toEqual(parked);

    // §10.1: the paused game survives a round trip and resumes from the round-tripped copy.
    const round = roundTrip(state);
    expect(owedDeathsOf(only(owedWork(round, DEATHS_WORK)).resume)?.owed.map((c) => c.id)).toEqual([
      first.id,
      second.id,
      far.id,
    ]);

    // The first answer finishes the first hook and runs straight into the second card's question.
    const once = answer(round);
    expect(notes(once.state)).toEqual(["ask:one", "answered:one", "tail:one:3", "ask:two"]);
    expect(once.state.pending?.playerId).toBe("p1");
    expect(owedDeathsOf(only(owedWork(once.state, DEATHS_WORK)).resume)?.owed.map((c) => c.id)).toEqual(
      [second.id, far.id],
    );

    // And the second finishes the pass: the far side's hook, then steps 4 and 5.
    const twice = answer(once.state);
    const done = twice.state;
    expect(notes(done)).toEqual([
      "ask:one",
      "answered:one",
      "tail:one:3",
      "ask:two",
      "answered:two",
      "tail:two:3",
      "quiet:before",
      "quiet:tail:3",
    ]);
    expect(done.pending).toBeNull();
    expect(done.work).toEqual([]);
    expect(owedWork(done, DEATHS_WORK)).toEqual([]);

    // Step 5 reported all three, once each, and all three are in their owners' graveyards.
    expect(eventsOfType(twice.events, "enteredGraveyard").map((e) => e.instanceId)).toEqual([
      first.id,
      second.id,
      far.id,
    ]);
    expect([first, second, far].map((card) => inGraveyard(done, card))).toEqual([true, true, true]);
  });

  it("R89 gives the resumed half of a Death hook the snapshot, which the board no longer holds", () => {
    const state = playing("deaths-snapshot");
    const dying = doomed(state, askOne.id, "p1", 1);

    stateCheck(sinkFor(state));
    // R78 has already reset the instance on the board, so the buff is gone from every zone.
    expect(state.players.p1.graveyard.find((c) => c.id === dying.id)?.buffs).toEqual({
      attack: 0,
      health: 0,
    });
    // And the parked pass carries the snapshot instead, which is where the tail's `ctx.self` comes
    // from: `findInstance` would hand back the reset card above (R89, R127).
    const snapshot = only(owedDeathsOf(only(owedWork(state, DEATHS_WORK)).resume)?.owed ?? []);
    expect(snapshot.buffs).toEqual({ attack: 3, health: 0 });

    const done = answer(roundTrip(state)).state;
    // "tail:one:3", not "tail:one:0": the effects after the question still read the card as it died.
    expect(notes(done)).toEqual(["ask:one", "answered:one", "tail:one:3"]);
  });

  it("R64/R83 still brings a Reborn unit back once the answer finishes the pass it paused", () => {
    const state = playing("deaths-reborn");
    const dying = doomed(state, rebornAsker.id, "p1", 3);

    stateCheck(sinkFor(state));
    // Step 4 is behind the pause, so the zone is reserved and still empty (R64).
    expect(state.pending).not.toBeNull();
    expect(cardAt(state, slot("p1", "units", 3))).toBeNull();
    expect(state.reserved).toContainEqual({ player: "p1", row: "units", lane: 3 });

    const done = answer(roundTrip(state)).state;
    expect(notes(done)).toEqual(["ask:reborn", "answered:reborn", "tail:reborn:3"]);

    const back = cardAt(done, slot("p1", "units", 3));
    expect(back?.id).toBe(dying.id);
    // At 1 health, without Reborn, and summoning sick because it entered the field again (R83).
    expect(back === null ? null : back.damage).toBe(1);
    expect(back?.grantedKeywords).toEqual([]);
    expect(back?.rebornSpent).toBe(true);
    expect(back?.summonedTurn).toBe(done.turn);
    expect(done.reserved).toEqual([]);
    expect(done.work).toEqual([]);
    // It never stayed in the graveyard, so step 5 did not report it (R47).
    expect(inGraveyard(done, dying)).toBe(false);
  });

  it("runs the same hooks in the same order with nothing to ask, owing nothing at all", () => {
    const state = playing("deaths-control");
    const first = doomed(state, quietUnit.id, "p1", 1);
    const second = doomed(state, quietUnit.id, "p1", 2);
    const far = doomed(state, quietUnit.id, "p2", 1);

    const events: GameEvent[] = [];
    stateCheck(sinkFor(state, events));

    // Every hook ran, in R68's order, inside the one call — and each read its own snapshot.
    expect(notes(state)).toEqual([
      "quiet:before",
      "quiet:tail:3",
      "quiet:before",
      "quiet:tail:3",
      "quiet:before",
      "quiet:tail:3",
    ]);
    expect(state.pending).toBeNull();
    // Nothing was parked: the machinery only engages at a pause (R117), so this is not the pause
    // path passing by accident.
    expect(state.work).toEqual([]);
    expect(eventsOfType(events, "enteredGraveyard").map((e) => e.instanceId)).toEqual([
      first.id,
      second.id,
      far.id,
    ]);
  });
});

describe("a prompt inside a cast's Cry (§10.5, R70, R113, R122)", () => {
  it("R113 owes §10.5 steps 6 and 7 when a cast's Cry asks, so the card lands only on the answer", () => {
    const state = playing("cast-owe-tail");
    const card = newInstance(state, castAsker.id, "p1", { z: "resolving", player: "p1" });

    const events: GameEvent[] = [];
    castCard(sinkFor(state, events), card);

    // The Cry stopped at its question, and the effects after it have not run.
    expect(notes(state)).toEqual(["cast:ask"]);
    expect(state.pending?.playerId).toBe("p1");
    // R70: it counted as a play immediately, but §10.5 step 7 has not happened — the card is still
    // resolving and nothing has announced it resolved. Running the tail over the open prompt is the
    // bug this pins: it used to land the Spell in the graveyard while the caster was still asked.
    expect(eventsOfType(events, "cardPlayed").map((e) => e.instanceId)).toEqual([card.id]);
    expect(eventsOfType(events, "cardResolved")).toEqual([]);
    expect(inGraveyard(state, card)).toBe(false);

    // R113: the tail is owed, as plain data, and survives a round trip (§9.3, §10.1).
    const parked = only(owedWork(state, CAST_CRY_WORK));
    expect(castTailOf(parked.resume)?.instanceId).toBe(card.id);
    expect(JSON.parse(JSON.stringify(parked))).toEqual(parked);

    const done = answer(roundTrip(state));
    // The rest of the Cry runs first — still reading its own card — and only then step 7 (R113).
    expect(notes(done.state)).toEqual(["cast:ask", "cast:answered", "cast:tail:0"]);
    expect(eventsOfType(done.events, "cardResolved").map((e) => e.instanceId)).toEqual([card.id]);
    expect(inGraveyard(done.state, card)).toBe(true);
    expect(done.state.pending).toBeNull();
    expect(done.state.work).toEqual([]);
  });

  it("lands a cast whose Cry asks nothing in the same call, owing nothing at all", () => {
    const state = playing("cast-control");
    const card = newInstance(state, castQuiet.id, "p1", { z: "resolving", player: "p1" });

    const events: GameEvent[] = [];
    castCard(sinkFor(state, events), card);

    expect(notes(state)).toEqual(["cast:quiet"]);
    expect(state.pending).toBeNull();
    expect(state.work).toEqual([]);
    expect(eventsOfType(events, "cardResolved").map((e) => e.instanceId)).toEqual([card.id]);
    expect(inGraveyard(state, card)).toBe(true);
  });
});

describe("a state check that begins while a prompt is already open (§4.5, R113, R117, R156)", () => {
  it("R156 owes step 3 in full rather than firing a Death hook into an open prompt", () => {
    const state = playing("deaths-prompt-already-open");
    const dying = doomed(state, quietUnit.id, "p1", 1);

    // Something else asked first — a trap, an earlier card, the play that killed this one. R156's
    // case is the board settling while that question is still unanswered.
    const events: GameEvent[] = [];
    const sink = sinkFor(state, events);
    openPrompt(sink, {
      player: "p1",
      kind: "target",
      prompt: "an earlier question, still unanswered",
      options: [{ key: "none", label: "nothing", selection: { pick: "none" } }],
      resume: { defId: "", hook: "resume", step: "none", radiant: false, data: {} },
    });
    expect(state.pending).not.toBeNull();

    stateCheck(sink);

    // Steps 1 and 2 still run: those are the board settling, not a choice. The card really moved.
    expect(inGraveyard(state, dying)).toBe(true);
    expect(eventsOfType(events, "destroyed").map((event) => event.instanceId)).toEqual([dying.id]);

    // Step 3 fired nothing. Without R156 the hook runs into the open prompt and whatever it asks is
    // discarded in silence, because `openPrompt` will not overwrite a question already standing.
    expect(notes(state)).toEqual([]);

    // The whole of step 3 is owed instead, in R68's order, as plain data (§9.3).
    const parked = only(owedWork(state, DEATHS_WORK));
    expect(owedDeathsOf(parked.resume)?.owed.map((card) => card.id)).toEqual([dying.id]);
    expect(JSON.parse(JSON.stringify(parked))).toEqual(parked);

    // The prompt that was standing is untouched: the pass waited for it rather than stepping on it.
    expect(state.pending?.prompt).toBe("an earlier question, still unanswered");
  });

  it("the same death fires at once with no prompt open, so the case above is about the prompt", () => {
    const state = playing("deaths-no-prompt-open");
    const dying = doomed(state, quietUnit.id, "p1", 1);

    const events: GameEvent[] = [];
    stateCheck(sinkFor(state, events));

    expect(state.pending).toBeNull();
    expect(notes(state)).toEqual(["quiet:before", "quiet:tail:3"]);
    expect(inGraveyard(state, dying)).toBe(true);
    expect(owedWork(state, DEATHS_WORK)).toEqual([]);
  });
});
