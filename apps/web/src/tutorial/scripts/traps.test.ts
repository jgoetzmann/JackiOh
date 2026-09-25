// Lesson "traps" (SPEC §9.10, R293): the coach's own line wins and shows every step, the backrow's
// mechanics come up on it without ever asking for more than two "Got it"s in a row, a beginner who
// plays only what the coach names wins and meets the AI's trap too, a beginner who ignores the coach
// still wins (on the lesson's seed and on other seeds of the same decks), a player who does anything
// at all never stalls or breaks the coach, and the whole game replays from its seed.
//
// Played through the REAL practice core (harness.ts): the engine, the card scripts and the AI.

import { beforeAll, describe, expect, it } from "vitest";

import { aiToAct } from "@jackioh/ai";
import { beginGame, createGame, fold, hashState, legalActions, reduce, viewFor, type GameState } from "@jackioh/engine";
import { opponentOf, type Action, type GameEvent, type PlayerId, type PlayerView } from "@jackioh/shared";

import { newEventsSince } from "../../game/animations.ts";
import { COACH_START, coachAck, coachDisplay, coachObserve, type CoachCtx } from "../coach.ts";
import { playLesson, type LessonRun } from "../harness.ts";
import { lessonById } from "../lessons.ts";
import { script } from "./traps.ts";

const LESSON = "traps";
/** The coach's line wins on the player's 7th turn; this leaves one turn of slack. */
const COACH_TURNS_MAX = 8;
/**
 * A beginner who plays only what the coach names (and otherwise only attacks and ends the turn)
 * plays the coach's own line: from the mulligan on, the coach names every move, so this one wins on
 * the 7th turn too.
 */
const PASSIVE_TURNS_MAX = 8;
/** The autopilot wins on its 7th turn. */
const AUTOPILOT_TURNS_MAX = 8;
/** The most "Got it" bubbles the coach shows in a row, with no move of the player's between them. */
const GOT_IT_RUN_MAX = 2;
/**
 * Other seeds of the lesson's decks, `<seed>:alt:<n>`, that the autopilot wins too, which is how
 * forgiving the decks are rather than the seed. Measured: every one won, the player's hero on 15 or
 * more (7 to 12 turns); each costs well under 3 s.
 */
const ALT_SEEDS = 10;
/**
 * Policy seeds for the player who ignores the coach. The harness gives the AI a small budget under
 * the random policy, so each of these games costs a second or three.
 */
const RANDOM_RUNS = 15;
/** One lesson game through the real core takes a few seconds; generous, for a loaded machine. */
const LESSON_TIMEOUT_MS = 60_000;
/** The allowance for a test that plays many lesson games. */
const MANY_TIMEOUT_MS = 240_000;

const GOING_LONG = "core-084";
const HONEYPOT = "core-060";
const SHEEPISH = "core-041";
const FARM = "core-058";
const RUSH_TOKEN = "core-t-rush";
const SHEEP = "core-t-sheep";
const TEMPO_TIMMY = "core-011";

const lesson = lessonById(LESSON);
if (lesson === undefined) throw new Error(`no lesson "${LESSON}"`);

/** One accepted action of the game and everything it emitted, unredacted, with the states around it. */
type Step = { action: Action; events: GameEvent[]; before: GameState; after: GameState };

/** Fold the run's log one action at a time, keeping every event (the test may read what the page may not). */
function stepsOf(run: LessonRun): Step[] {
  const { seed, decks, handicaps, log } = run.debug;
  let state = beginGame(createGame({ seed, decks, handicaps })).state;
  const steps: Step[] = [];
  for (const action of log) {
    const result = reduce(state, action);
    if (result.error !== undefined) throw new Error(`the log does not fold: ${result.error}`);
    steps.push({ action, events: result.events, before: state, after: result.state });
    state = result.state;
  }
  return steps;
}

/**
 * Every run of "Got it" bubbles the coach showed on this line, in order: tips and info steps, with
 * no move of the player's and no step asking for one between them. Rebuilt by folding the run's
 * log and reading each snapshot the way the harness's coach did (the page's own reads: the human's
 * view, legal actions and whether the AI owes a move), which the tips it saw prove.
 */
function gotItRuns(run: LessonRun): { runs: string[][]; tips: string[] } {
  const { seed, decks, handicaps, log } = run.debug;
  const human = run.humanSeat;
  const ai = opponentOf(human);
  let state = beginGame(createGame({ seed, decks, handicaps })).state;
  let coach = COACH_START;
  let previous: PlayerView | null = null;
  const runs: string[][] = [];
  const tips: string[] = [];
  let current: string[] = [];
  const close = (): void => {
    if (current.length > 0) runs.push(current);
    current = [];
  };
  const observe = (): void => {
    const view = viewFor(state, human);
    const ctx: CoachCtx = {
      view,
      legal: legalActions(state, human),
      fresh: previous === null ? [] : newEventsSince(previous.events, view.events),
      aiToAct: aiToAct(state, ai),
    };
    previous = view;
    coach = coachObserve(run.script, coach, ctx);
    let display = coachDisplay(run.script, coach, ctx);
    while (display.mode === "tip" || (display.mode === "step" && display.ack)) {
      current.push(display.id);
      if (display.mode === "tip") tips.push(display.id);
      coach = coachAck(run.script, coach, ctx);
      display = coachDisplay(run.script, coach, ctx);
    }
    if (display.mode === "step") close();
  };
  observe();
  for (const action of log) {
    if (action.playerId === human) close();
    state = reduce(state, action).state;
    observe();
  }
  close();
  return { runs, tips };
}

/** The player-turn number (the engine's `turn`) of the human's own turn `n` (p1 takes the odd ones). */
function gameTurnOf(seat: PlayerId, n: number): number {
  return seat === "p1" ? 2 * n - 1 : 2 * n;
}

/**
 * The backrow's mechanics, as they come up on a line that follows the coach: Quickdraw, a trap set
 * face-down that springs on the AI's turn and makes tokens, the Field Spells at work, and the AI's
 * own face-down card, tested with a cheap unit on the player's next turn, springing on that unit.
 */
function expectMechanics(run: LessonRun, steps: Step[]): void {
  const human = run.humanSeat;
  const ai = opponentOf(human);

  // Quickdraw: Going Long is in the human's very first hand.
  const opening = viewFor(beginGame(createGame({ seed: run.debug.seed, decks: run.debug.decks, handicaps: run.debug.handicaps })).state, human);
  expect(Array.isArray(opening.you.hand) ? opening.you.hand.map((card) => card.defId) : [], "Quickdraw: Going Long starts in the opening hand").toContain(GOING_LONG);

  // The backrow: the human sets a trap face-down, and the AI sees only a face-down card there.
  const set = steps.find((step) =>
    step.events.some((event) => event.type === "summoned" && event.player === human && event.row === "backrow" && event.defId === HONEYPOT),
  );
  expect(set, "the human sets Bear Honeypot in the backrow").toBeDefined();
  if (set !== undefined) {
    const aiSees = viewFor(set.after, ai).opponent.backrow;
    expect(aiSees.some((card) => card !== null && card.faceDown), "the AI sees the trap face-down").toBe(true);
  }

  // The human's trap springs on the AI's turn, and makes tokens.
  const mine = steps.find((step) => step.events.some((event) => event.type === "trapFired" && event.controller === human && event.defId === HONEYPOT));
  expect(mine, "the human's Bear Honeypot fires").toBeDefined();
  expect(mine?.action.playerId, "it fires during the AI's turn").toBe(ai);
  expect(
    mine?.events.filter((event) => event.type === "summoned" && event.player === human && event.defId === RUSH_TOKEN).length,
    "Tokens: it summons two Rush Tokens",
  ).toBe(2);

  // A Field Spell at work: Rush Token Farm summons a Rush Token at the start of the human's turn.
  const farmed = steps.find((step) => {
    const started = step.events.findIndex((event) => event.type === "turnStarted" && event.player === human);
    if (started < 0) return false;
    const drawn = step.events.findIndex((event, index) => index > started && event.type === "drawn");
    const window = step.events.slice(started, drawn < 0 ? undefined : drawn);
    return window.some((event) => event.type === "summoned" && event.player === human && event.defId === RUSH_TOKEN);
  });
  expect(farmed, "Rush Token Farm makes a Rush Token at the start of the human's turn").toBeDefined();
  if (farmed !== undefined) {
    expect(farmed.before.players[human].backrow.some((card) => card?.defId === FARM), "the farm is in the backrow").toBe(true);
  }

  // Going Long, a Field Spell, gives the human's hero Armor 2 once it is in play.
  const armored = steps.find((step) => viewFor(step.after, human).you.hero.armor === 2);
  expect(armored, "Going Long gives the hero Armor 2").toBeDefined();

  // The AI sets a face-down card of its own on its turn, and the human sees only its back.
  const aiSet = steps.find((step) =>
    step.events.some((event) => event.type === "summoned" && event.player === ai && event.row === "backrow" && event.defId === SHEEPISH),
  );
  expect(aiSet, "the AI sets Sheepish").toBeDefined();
  if (aiSet === undefined) return;
  expect(aiSet.action.playerId, "on its own turn").toBe(ai);
  // Rule 7: a bare face-down marker, with nothing that could name the card.
  const seen = viewFor(aiSet.after, human).opponent.backrow.filter((card) => card !== null);
  expect(seen, "the human sees only a face-down card").toContainEqual({ faceDown: true });

  // The AI's trap springs on the human's next turn, on the cheap unit the coach named as bait.
  const theirs = steps.find((step) => step.events.some((event) => event.type === "trapFired" && event.controller === ai && event.defId === SHEEPISH));
  expect(theirs, "the AI's Sheepish fires").toBeDefined();
  expect(theirs?.action.playerId, "during the human's turn, on the human's play").toBe(human);
  expect(theirs?.before.turn, "on the human's turn right after the AI set it").toBe(aiSet.before.turn + 1);
  expect(
    theirs?.events.some((event) => event.type === "transformed" && event.fromDefId === TEMPO_TIMMY && event.toDefId === SHEEP),
    "Sheepish turns the bait, Tempo Timmy, into a Sheep",
  ).toBe(true);
  const baitId = theirs?.action.type === "play" ? theirs.action.instanceId : undefined;
  const bait = run.humanActions.find((entry) => entry.action.type === "play" && entry.action.instanceId === baitId);
  expect(bait?.byCoach, "the coach named the bait").toBe(true);
  expect(run.shown.map((entry) => entry.id), "the coach asked for the bait").toContain("bait");
  expect(run.outcomes["bait"], "and the player gave it").toBe("done");

  // The coach explains the AI's moments as they happen.
  for (const id of ["honeypot-fired", "tokens", "armor", "enemy-facedown", "enemy-trap"]) {
    expect(run.tips, `tip ${id} shows`).toContain(id);
  }
}

describe("R293 lesson traps", () => {
  let coach: LessonRun;
  let steps: Step[];
  const human: PlayerId = lesson.humanSeat;

  beforeAll(() => {
    coach = playLesson(LESSON, { policy: "coach" });
    steps = stepsOf(coach);
  }, LESSON_TIMEOUT_MS);

  it("R293 traps: following the coach wins the lesson, and every step shows and is done", () => {
    expect(coach.winner, "the human wins").toBe(human);
    expect(coach.view.result?.reason).toBe("hero-death");
    expect(coach.humanTurns, "within the lesson's turns").toBeLessThanOrEqual(COACH_TURNS_MAX);
    expect(coach.coach.finished).toBe(true);

    const shown = coach.shown.map((entry) => entry.id);
    for (const step of script.steps) {
      expect(shown, `${step.id} shows`).toContain(step.id);
      // The last step ends with the game, so the coach never retires it: the game ends on it.
      if (step.final === true) expect(coach.outcomes[step.id], `${step.id} is still up when the game ends`).toBeUndefined();
      else expect(coach.outcomes[step.id], `${step.id} is done`).toBe("done");
    }
    expect(shown, "every step shows in the script's order").toEqual(script.steps.map((step) => step.id));

    // Every turn of the player's ends in the coach's advice, so the coach is never silent on it.
    for (const [id, n] of [["move-2", 2], ["move-3", 3], ["move-4", 4]] as const) {
      expect(coach.shown.find((entry) => entry.id === id)?.turn, `${id} covers the rest of turn ${String(n)}`).toBe(gameTurnOf(human, n));
    }

    // The coach asked for every move the player made, and the engine took each one.
    expect(coach.humanActions.filter((entry) => !entry.byCoach).map((entry) => entry.action.type)).toEqual([]);
    expect(coach.humanActions.filter((entry) => entry.refused !== null)).toEqual([]);
  });

  it("R293 traps: the lesson's mechanics come up on the coach line", () => {
    expectMechanics(coach, steps);
  });

  it('R293 traps: the coach never shows more than two "Got it"s in a row on its line', () => {
    const { runs, tips } = gotItRuns(coach);
    // The fold reads the same snapshots the harness's coach read.
    expect(tips, "the rebuilt line shows the tips the coach showed").toEqual(coach.tips);
    for (const run of runs) expect(run.length, `"Got it" ${run.join(" -> ")}`).toBeLessThanOrEqual(GOT_IT_RUN_MAX);
    // The AI's turns are the busy moments: the hidden trap and its springing, then the Armor and the
    // AI's face-down card. The tokens wait for the player's own turn.
    expect(runs, "the hidden trap, then the trap springing").toContainEqual(["trap-waits", "honeypot-fired"]);
    expect(runs, "the Armor, then the AI's face-down card").toContainEqual(["armor", "enemy-facedown"]);
  });

  it(
    "R293 traps: a beginner who plays only what the coach names still wins",
    () => {
      const run = playLesson(LESSON, { policy: "coach-passive" });
      expect(run.winner, "the human wins").toBe(human);
      expect(run.view.result?.reason).toBe("hero-death");
      expect(run.humanTurns, "within the lesson's turns").toBeLessThanOrEqual(PASSIVE_TURNS_MAX);
      expect(run.coach.finished).toBe(true);
      // The coach named every move this beginner made, and the engine took each one.
      expect(run.humanActions.filter((entry) => !entry.byCoach).map((entry) => entry.action.type)).toEqual([]);
      expect(run.humanActions.filter((entry) => entry.refused !== null)).toEqual([]);
      // The AI sets its trap on this line too, and the beginner tests it with the bait.
      expectMechanics(run, stepsOf(run));
    },
    LESSON_TIMEOUT_MS,
  );

  it(
    "R293 traps: a sensible beginner who ignores the coach still wins",
    () => {
      const run = playLesson(LESSON, { policy: "autopilot" });
      expect(run.winner).toBe(human);
      expect(run.humanTurns).toBeLessThanOrEqual(AUTOPILOT_TURNS_MAX);
      expect(run.coach.finished).toBe(true);
    },
    LESSON_TIMEOUT_MS,
  );

  it(
    "R293 traps: a sensible beginner who ignores the coach wins on other seeds of the same decks too",
    () => {
      for (let n = 1; n <= ALT_SEEDS; n += 1) {
        const seed = `${lesson.seed}:alt:${String(n)}`;
        const run = playLesson(LESSON, { policy: "autopilot", seed });
        expect(run.winner, `seed ${seed}`).toBe(human);
        expect(run.coach.finished, `seed ${seed}: the coach is finished`).toBe(true);
      }
    },
    MANY_TIMEOUT_MS,
  );

  it(
    "R293 traps: a player who ignores the coach never stalls or breaks it",
    () => {
      for (let n = 1; n <= RANDOM_RUNS; n += 1) {
        const run = playLesson(LESSON, { policy: "random", policySeed: `${LESSON}:random:${String(n)}` });
        expect(run.view.result, `policy seed ${String(n)} reaches a result`).not.toBeNull();
        expect(run.coach.finished, `policy seed ${String(n)}: the coach is finished`).toBe(true);
        for (const step of script.steps) {
          const outcome = run.outcomes[step.id];
          if (outcome !== undefined) expect(["done", "skipped", "moot", "expired"]).toContain(outcome);
        }
      }
    },
    MANY_TIMEOUT_MS,
  );

  it(
    "R293 traps: the lesson replays from its seed, decks and handicaps",
    () => {
      const { seed, decks, handicaps, log, hash } = coach.debug;
      expect(seed).toBe(lesson.seed);
      const replayed = fold({ seed, decks, handicaps, log });
      expect(replayed.errors).toEqual([]);
      expect(hashState(replayed.state)).toBe(hash);

      const again = playLesson(LESSON, { policy: "coach" });
      expect(again.debug.log).toEqual(log);
      expect(again.debug.hash).toBe(hash);
      expect(again.shown).toEqual(coach.shown);
      expect(again.tips).toEqual(coach.tips);
    },
    LESSON_TIMEOUT_MS,
  );
});
