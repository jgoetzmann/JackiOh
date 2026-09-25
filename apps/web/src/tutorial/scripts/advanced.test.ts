// Lesson "advanced" (SPEC §9.10, R293): the coach's own line wins and shows every step, the lesson's
// tricks come up on it (the mulligan, The Coin, Radiant, tribes and tokens, Tribute), a beginner who
// ignores the coach still wins, a player who does anything at all never stalls the coach, and the
// whole game replays from its seed.
//
// Played through the REAL practice core (harness.ts): the engine, the card scripts and the AI.

import { beforeAll, describe, expect, it } from "vitest";

import { beginGame, createGame, fold, hashState, reduce, viewFor, type GameState } from "@jackioh/engine";
import type { Action, CardView, GameEvent, PlayerId, PlayerView } from "@jackioh/shared";

import { playLesson, type LessonRun } from "../harness.ts";
import { lessonById } from "../lessons.ts";
import { script } from "./advanced.ts";

const LESSON = "advanced";
/** The coach's line wins on the player's 8th turn; this leaves one turn of slack. */
const COACH_TURNS_MAX = 9;
/**
 * Policy seeds for the player who ignores the coach. A random player drags the game out to 10–14
 * of its turns; the harness gives the AI a small budget against it, so a dozen games stay cheap.
 */
const RANDOM_RUNS = 12;
/**
 * One lesson game through the real core takes a few seconds of CPU. The allowances are generous so
 * a loaded machine never fails them; a game that truly stalls is stopped by the harness's own cap.
 */
const LESSON_TIMEOUT_MS = 120_000;
/** The random policy's allowance, for all of its runs. */
const RANDOM_TIMEOUT_MS = 600_000;

const COIN = "core-t-coin";
const FELINOR_TOKEN = "core-t-felinor";
const FRIEND_OF_FELINORS = "core-062";
const FELINOR_FIENDER = "core-092";
const GLOWY_JELLY_BEAN = "core-026";
const THE_ROCK = "core-066";
const SEVEN_SEVEN = "core-025";

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

function handOf(view: PlayerView): CardView[] {
  return Array.isArray(view.you.hand) ? view.you.hand : [];
}

function playOf(step: Step): Extract<Action, { type: "play" }> | undefined {
  return step.action.type === "play" ? step.action : undefined;
}

describe("R293 lesson advanced", () => {
  let coach: LessonRun;
  let steps: Step[];
  const human: PlayerId = lesson.humanSeat;

  /** The step whose human action played the card of this definition. */
  const playedStep = (defId: string): Step | undefined =>
    steps.find(
      (step) =>
        step.action.playerId === human &&
        step.events.some((event) => event.type === "cardPlayed" && event.player === human && event.defId === defId),
    );

  beforeAll(() => {
    coach = playLesson(LESSON, { policy: "coach" });
    steps = stepsOf(coach);
  }, LESSON_TIMEOUT_MS);

  it("R293 advanced: following the coach wins the lesson, and every step shows and is done", () => {
    expect(coach.winner).toBe(human);
    const shown = coach.shown.map((entry) => entry.id);
    for (const step of script.steps) {
      expect(shown, `step ${step.id} shows`).toContain(step.id);
      expect(coach.outcomes[step.id], `step ${step.id} is done`).toBe("done");
    }
    expect(coach.humanTurns).toBeLessThanOrEqual(COACH_TURNS_MAX);
    expect(coach.humanActions.filter((entry) => entry.refused !== null)).toEqual([]);
  });

  it("R293 advanced: the lesson's mechanics come up on the coach line", () => {
    // The mulligan: the human sends the 4-mana 7/7 back, draws a replacement, and the 7/7 is
    // shuffled into the library (§2.1 step 3).
    const mulligan = steps.find((step) => step.action.playerId === human && step.action.type === "mulligan");
    expect(mulligan, "the human answers the mulligan").toBeDefined();
    if (mulligan !== undefined && mulligan.action.type === "mulligan") {
      const opening = handOf(viewFor(mulligan.before, human));
      expect(mulligan.action.keep.length, "Mulligan: one card goes back").toBe(opening.length - 1);
      expect(
        mulligan.events.some((event) => event.type === "shuffledIn" && event.player === human && event.defId === SEVEN_SEVEN),
        "Mulligan: the 4-mana 7/7 is shuffled into the library",
      ).toBe(true);
      expect(
        mulligan.events.some((event) => event.type === "drawn" && event.player === human),
        "Mulligan: a replacement is drawn",
      ).toBe(true);
    }

    // The Coin: the human, going second, is dealt it after the mulligans, plays it on their first
    // turn, and spends the extra mana on a 2-cost card that same turn (R244, R245).
    const dealt = steps.find((step) =>
      step.events.some((event) => event.type === "addedToHand" && event.player === human && event.defId === COIN),
    );
    expect(dealt, "The Coin: the human is dealt The Coin").toBeDefined();
    const coinPlay = playedStep(COIN);
    expect(coinPlay, "The Coin: the human plays it").toBeDefined();
    const fienderPlay = playedStep(FELINOR_FIENDER);
    expect(fienderPlay?.before.turn, "The Coin: Felinor Fiender comes down on the same turn").toBe(coinPlay?.before.turn);
    if (fienderPlay !== undefined) {
      expect(fienderPlay.before.players[human].mana.max, "The Coin: it is the human's first turn, 1 mana crystal").toBe(1);
      expect(
        fienderPlay.events.some((event) => event.type === "cardPlayed" && event.defId === FELINOR_FIENDER && event.costPaid === 2),
        "The Coin: a 2-cost card played with the extra mana",
      ).toBe(true);
    }

    // Tokens and tribes: Friend of Felinors fills the board with Felinor Tokens, and Felinor Fiender
    // counts them (§7, #62, #92).
    const friendPlay = playedStep(FRIEND_OF_FELINORS);
    expect(friendPlay, "Tokens: the human plays Friend of Felinors").toBeDefined();
    if (friendPlay !== undefined) {
      const tokens = friendPlay.events.filter((event) => event.type === "summoned" && event.player === human && event.defId === FELINOR_TOKEN);
      expect(tokens.length, "Tokens: Felinor Tokens fill the empty zones").toBeGreaterThan(1);
      const fienderBefore = viewFor(friendPlay.before, human).you.units.find((unit) => unit?.defId === FELINOR_FIENDER);
      const fienderAfter = viewFor(friendPlay.after, human).you.units.find((unit) => unit?.defId === FELINOR_FIENDER);
      expect(fienderBefore, "Tribes: Felinor Fiender is on the field").toBeDefined();
      expect(fienderAfter?.attack ?? 0, "Tribes: Felinor Fiender grows with the Felinors").toBeGreaterThan(fienderBefore?.attack ?? 0);
      expect(fienderAfter?.health ?? 0, "Tribes: its health grows too").toBeGreaterThan(fienderBefore?.health ?? 0);
    }

    // Radiant: Glowy Jelly Bean makes The Rock in hand Radiant, and its face gets stronger (§5.2, #26).
    const beanPlay = playedStep(GLOWY_JELLY_BEAN);
    expect(beanPlay, "Radiant: the human plays Glowy Jelly Bean").toBeDefined();
    if (beanPlay !== undefined) {
      expect(
        beanPlay.events.some((event) => event.type === "radiantSet" && event.defId === THE_ROCK && event.zone.z === "hand"),
        "Radiant: The Rock becomes Radiant in hand",
      ).toBe(true);
      const rockBefore = handOf(viewFor(beanPlay.before, human)).find((card) => card.defId === THE_ROCK);
      const rockAfter = handOf(viewFor(beanPlay.after, human)).find((card) => card.defId === THE_ROCK);
      expect(rockBefore?.radiant, "Radiant: The Rock was not Radiant before").toBe(false);
      expect(rockAfter?.radiant, "Radiant: and is after").toBe(true);
      expect(rockAfter?.attack ?? 0, "Radiant: stronger stats").toBeGreaterThan(rockBefore?.attack ?? 0);
    }

    // Tribute: The Rock is played with a Felinor Token as its Tribute, which is sacrificed (§6.3, #66).
    const rockPlay = playedStep(THE_ROCK);
    expect(rockPlay, "Tribute: the human plays The Rock").toBeDefined();
    if (rockPlay !== undefined) {
      const tributes = playOf(rockPlay)?.tributes ?? [];
      expect(tributes.length, "Tribute: one unit is tributed").toBe(1);
      const tributed = viewFor(rockPlay.before, human).you.units.find((unit) => unit?.instanceId === tributes[0]);
      expect(tributed?.defId, "Tribute: the tribute is a Felinor Token").toBe(FELINOR_TOKEN);
      expect(
        rockPlay.events.some((event) => event.type === "destroyed" && event.instanceId === tributes[0]),
        "Tribute: the token is sacrificed",
      ).toBe(true);
      expect(viewFor(rockPlay.after, human).you.units.find((unit) => unit?.defId === THE_ROCK)?.radiant, "The Radiant Rock is on the field").toBe(
        true,
      );
    }

    // The yellow glow: a card in the human's hand glowed on the coach line (R195), and the coach said so.
    expect(
      steps.some((step) => handOf(viewFor(step.after, human)).some((card) => card.conditionActive === true)),
      "Yellow glow: a hand card's condition was met",
    ).toBe(true);
    for (const id of ["fewer-felinors", "yellow-glow"]) {
      expect(coach.tips, `tip ${id} shows`).toContain(id);
    }
  });

  it("R293 advanced: a sensible beginner who ignores the coach still wins", { timeout: LESSON_TIMEOUT_MS }, () => {
    const run = playLesson(LESSON, { policy: "autopilot" });
    expect(run.winner).toBe(human);
  });

  it("R293 advanced: a player who ignores the coach never stalls or breaks it", { timeout: RANDOM_TIMEOUT_MS }, () => {
    for (let n = 1; n <= RANDOM_RUNS; n += 1) {
      const run = playLesson(LESSON, { policy: "random", policySeed: `${LESSON}:random:${String(n)}` });
      expect(run.view.result, `random run ${String(n)} reaches a result`).not.toBeNull();
      expect(run.coach.finished, `random run ${String(n)}: the coach finishes`).toBe(true);
    }
  });

  it("R293 advanced: the lesson replays from its seed, decks and handicaps", { timeout: LESSON_TIMEOUT_MS }, () => {
    const { seed, decks, handicaps, log, hash } = coach.debug;
    const folded = fold({ seed, decks, handicaps, log });
    expect(folded.errors).toEqual([]);
    expect(hashState(folded.state)).toBe(hash);

    const again = playLesson(LESSON, { policy: "coach" });
    expect(again.debug.log).toEqual(log);
    expect(again.debug.hash).toBe(hash);
  });
});
