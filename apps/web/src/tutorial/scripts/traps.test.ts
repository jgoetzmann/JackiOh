// Lesson "traps" (SPEC §9.10, R293): the coach's own line wins and shows every step, the backrow's
// mechanics come up on it, a beginner who ignores the coach still wins, a player who does anything
// at all never stalls the coach, and the whole game replays from its seed.
//
// Played through the REAL practice core (harness.ts): the engine, the card scripts and the AI.

import { beforeAll, describe, expect, it } from "vitest";

import { beginGame, createGame, fold, hashState, reduce, viewFor, type GameState } from "@jackioh/engine";
import { opponentOf, type Action, type GameEvent, type PlayerId } from "@jackioh/shared";

import { playLesson, type LessonRun } from "../harness.ts";
import { lessonById } from "../lessons.ts";
import { script } from "./traps.ts";

const LESSON = "traps";
/** The coach's line wins on the player's 7th turn; this leaves one turn of slack. */
const COACH_TURNS_MAX = 8;
/**
 * Policy seeds for the player who ignores the coach. A random player fills the board and drags the
 * game out to 9–11 of its turns, so each game costs the AI's search 3–7 s of CPU; eight keep the
 * file near a minute.
 */
const RANDOM_RUNS = 8;
/**
 * One lesson game through the real core takes a few seconds of CPU. The allowances are generous so
 * a loaded machine never fails them; a game that truly stalls is stopped by the harness's own cap.
 */
const LESSON_TIMEOUT_MS = 120_000;
/** The random policy's allowance, for all of its runs. */
const RANDOM_TIMEOUT_MS = 600_000;

const GOING_LONG = "core-084";
const HONEYPOT = "core-060";
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

describe("R293 lesson traps", () => {
  let coach: LessonRun;
  let steps: Step[];
  const human: PlayerId = lesson.humanSeat;
  const ai: PlayerId = opponentOf(lesson.humanSeat);

  beforeAll(() => {
    coach = playLesson(LESSON, { policy: "coach" });
    steps = stepsOf(coach);
  }, LESSON_TIMEOUT_MS);

  it("R293 traps: following the coach wins the lesson, and every step shows and is done", () => {
    expect(coach.winner).toBe(human);
    const shown = coach.shown.map((entry) => entry.id);
    for (const step of script.steps) {
      expect(shown, `step ${step.id} shows`).toContain(step.id);
      expect(coach.outcomes[step.id], `step ${step.id} is done`).toBe("done");
    }
    expect(coach.humanTurns).toBeLessThanOrEqual(COACH_TURNS_MAX);
    expect(coach.humanActions.filter((entry) => entry.refused !== null)).toEqual([]);
  });

  it("R293 traps: the lesson's mechanics come up on the coach line", () => {
    // Quickdraw: Going Long is in the human's very first hand.
    const opening = viewFor(beginGame(createGame({ seed: coach.debug.seed, decks: coach.debug.decks, handicaps: coach.debug.handicaps })).state, human);
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

    // The AI sets a face-down card of its own, and the human sees only its back.
    const aiSet = steps.find((step) =>
      step.events.some((event) => event.type === "summoned" && event.player === ai && event.row === "backrow"),
    );
    expect(aiSet, "the AI sets a face-down card").toBeDefined();
    if (aiSet !== undefined) {
      // Rule 7: a bare face-down marker, with nothing that could name the card.
      const seen = viewFor(aiSet.after, human).opponent.backrow.filter((card) => card !== null);
      expect(seen, "the human sees only a face-down card").toContainEqual({ faceDown: true });
    }

    // The AI's trap springs on the human: Sheepish turns the human's played unit into a Sheep.
    const theirs = steps.find((step) => step.events.some((event) => event.type === "trapFired" && event.controller === ai));
    expect(theirs, "the AI's trap fires").toBeDefined();
    expect(theirs?.action.playerId, "it fires during the human's turn, on the human's play").toBe(human);
    expect(
      theirs?.events.some((event) => event.type === "transformed" && event.fromDefId === TEMPO_TIMMY && event.toDefId === SHEEP),
      "the AI's Sheepish turns the bait, Tempo Timmy, into a Sheep",
    ).toBe(true);

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

    // The coach explains the AI's moments as they happen.
    for (const id of ["honeypot-fired", "tokens", "armor", "enemy-facedown", "enemy-trap"]) {
      expect(coach.tips, `tip ${id} shows`).toContain(id);
    }
  });

  it("R293 traps: a sensible beginner who ignores the coach still wins", { timeout: LESSON_TIMEOUT_MS }, () => {
    const run = playLesson(LESSON, { policy: "autopilot" });
    expect(run.winner).toBe(human);
  });

  it("R293 traps: a player who ignores the coach never stalls or breaks it", { timeout: RANDOM_TIMEOUT_MS }, () => {
    for (let n = 1; n <= RANDOM_RUNS; n += 1) {
      const run = playLesson(LESSON, { policy: "random", policySeed: `${LESSON}:random:${String(n)}` });
      expect(run.view.result, `random run ${String(n)} reaches a result`).not.toBeNull();
      expect(run.coach.finished, `random run ${String(n)}: the coach finishes`).toBe(true);
    }
  });

  it("R293 traps: the lesson replays from its seed, decks and handicaps", { timeout: LESSON_TIMEOUT_MS }, () => {
    const { seed, decks, handicaps, log, hash } = coach.debug;
    const folded = fold({ seed, decks, handicaps, log });
    expect(folded.errors).toEqual([]);
    expect(hashState(folded.state)).toBe(hash);

    const again = playLesson(LESSON, { policy: "coach" });
    expect(again.debug.log).toEqual(log);
    expect(again.debug.hash).toBe(hash);
  });
});
