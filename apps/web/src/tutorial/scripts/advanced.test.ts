// Lesson "advanced" (SPEC §9.10, R293): the coach's own line wins and shows every step, the lesson's
// tricks come up on it (the mulligan, The Coin, tribes and tokens, Radiant, Tribute, the yellow
// glow) without ever asking for more than two "Got it"s in a row, a beginner who plays only what the
// coach names wins, a beginner who ignores the coach still wins, here and on other deals of the same
// decks, a player who does anything at all never stalls or breaks the coach, and the whole game
// replays from its seed.
//
// Played through the REAL practice core (harness.ts): the engine, the card scripts and the AI.

import { beforeAll, describe, expect, it } from "vitest";

import { aiToAct } from "@jackioh/ai";
import { beginGame, createGame, fold, hashState, legalActions, reduce, viewFor, type GameState } from "@jackioh/engine";
import { AI_TUTORIAL, HERO_HEALTH } from "@jackioh/engine/config";
import { opponentOf, type Action, type CardView, type GameEvent, type PlayerId, type PlayerView } from "@jackioh/shared";

import { newEventsSince } from "../../game/animations.ts";
import { COACH_START, coachAck, coachDisplay, coachObserve, type CoachCtx } from "../coach.ts";
import { playLesson, type LessonRun } from "../harness.ts";
import { lessonById } from "../lessons.ts";
import { script } from "./advanced.ts";

const LESSON = "advanced";
/** The coach's line wins on the player's 6th turn; the lesson is meant to take 6 to 8. */
const COACH_TURNS_MAX = 8;
/** A beginner who plays only what the coach names plays the coach's line: the 6th turn too. */
const PASSIVE_TURNS_MAX = 8;
/** The autopilot wins on its 7th turn. */
const AUTOPILOT_TURNS_MAX = 9;
/**
 * "Comfortably": the lowest the player's hero goes on the lesson's seed, whoever plays it. The
 * coach's line bottoms out at 28 and the autopilot's at 24, so half the hero's health is margin.
 */
const HEALTH_FLOOR = HERO_HEALTH / 2;
/** The most "Got it" bubbles the coach shows in a row, with no move of the player's between them. */
const GOT_IT_RUN_MAX = 2;
/**
 * Other deals of the same two decks (seeds `<lesson seed>:deal:<n>`), for how forgiving the lesson's
 * decks are to a player whose game goes some other way: the autopilot, who reads nothing the coach
 * says, wins at least ALT_WINS_MIN of ALT_DEALS. Measured: 15 of 20. Most of the deals it loses are
 * ones where it plays Friend of Felinors on its first turn, and the Felinor Tokens filling its board
 * keep its real units in hand for turns.
 */
const ALT_DEALS = 20;
const ALT_WINS_MIN = 12;
/**
 * Policy seeds for the player who ignores the coach. The harness gives the AI a small budget under
 * the random policy, so each of these games costs a second or two.
 */
const RANDOM_RUNS = 12;
/** One lesson game through the real core takes about a second; generous, for a loaded machine. */
const LESSON_TIMEOUT_MS = 60_000;
/** The random policy's and the other deals' allowance, for all of their runs. */
const MANY_TIMEOUT_MS = 240_000;

const COIN = "core-t-coin";
const FELINOR_TOKEN = "core-t-felinor";
const FRIEND_OF_FELINORS = "core-062";
const FELINOR_FIENDER = "core-092";
const GLOWY_JELLY_BEAN = "core-026";
const THE_ROCK = "core-066";
const SEVEN_SEVEN = "core-025";
const RENO = "core-053";

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

/** The lowest the human's hero health went in the run. */
function lowestHealth(run: LessonRun): number {
  const { seed, decks, handicaps } = run.debug;
  const start = beginGame(createGame({ seed, decks, handicaps })).state.players[run.humanSeat].hero.health;
  return Math.min(start, ...stepsOf(run).map((step) => step.after.players[run.humanSeat].hero.health));
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
  const ai: PlayerId = opponentOf(human);

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
    expect(coach.winner, "the human wins").toBe(human);
    expect(coach.view.result?.reason).toBe("hero-death");
    expect(coach.humanTurns, "within the lesson's turns").toBeLessThanOrEqual(COACH_TURNS_MAX);
    expect(lowestHealth(coach), "comfortably").toBeGreaterThanOrEqual(HEALTH_FLOOR);
    expect(coach.coach.finished).toBe(true);

    const shown = coach.shown.map((entry) => entry.id);
    for (const step of script.steps) {
      expect(shown, `${step.id} shows`).toContain(step.id);
      // The last step ends with the game, so the coach never retires it: the game ends on it.
      if (step.final === true) expect(coach.outcomes[step.id], `${step.id} is still up when the game ends`).toBeUndefined();
      else expect(coach.outcomes[step.id], `${step.id} is done`).toBe("done");
    }
    expect(shown, "every step shows in the script's order").toEqual(script.steps.map((step) => step.id));

    // The coach asked for every move the player made, and the engine took each one.
    expect(coach.humanActions.filter((entry) => !entry.byCoach).map((entry) => entry.action.type)).toEqual([]);
    expect(coach.humanActions.filter((entry) => entry.refused !== null)).toEqual([]);
  });

  it("R293 advanced: the lesson's mechanics come up on the coach line", () => {
    // Hero health: 30 for the player, 20 for the tutorial's enemy hero.
    const start = beginGame(createGame({ seed: coach.debug.seed, decks: coach.debug.decks, handicaps: coach.debug.handicaps })).state;
    expect(start.players[human].hero.health, "the player's hero starts at 30").toBe(HERO_HEALTH);
    expect(start.players[ai].hero.health, "the enemy hero starts at 20").toBe(AI_TUTORIAL.heroHealth);

    // The mulligan: the human sends the 4-mana 7/7 back, draws a replacement, and the 7/7 is
    // shuffled into the library (§2.1 step 3).
    const mulligan = steps.find((step) => step.action.playerId === human && step.action.type === "mulligan");
    expect(mulligan, "the human answers the mulligan").toBeDefined();
    if (mulligan !== undefined && mulligan.action.type === "mulligan") {
      const opening = handOf(viewFor(mulligan.before, human));
      expect(mulligan.action.keep.length, "Mulligan: one card goes back").toBe(opening.length - 1);
      const resolved = steps.slice(steps.indexOf(mulligan)).find((step) => step.events.some((event) => event.type === "shuffledIn"));
      expect(
        resolved?.events.some((event) => event.type === "shuffledIn" && event.player === human && event.defId === SEVEN_SEVEN),
        "Mulligan: the 4-mana 7/7 is shuffled into the library",
      ).toBe(true);
      expect(
        resolved?.events.some((event) => event.type === "drawn" && event.player === human),
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

    // The yellow glow: Reno glows in hand while the hero is hurt (R195), the coach asks for it on a
    // turn the mana allows, and its Cry sets the hero back to 30 (#53).
    const renoPlay = playedStep(RENO);
    expect(renoPlay, "Yellow glow: the human plays Reno").toBeDefined();
    if (renoPlay !== undefined) {
      expect(handOf(viewFor(renoPlay.before, human)).find((card) => card.defId === RENO)?.conditionActive, "Yellow glow: Reno glows").toBe(true);
      expect(renoPlay.before.players[human].hero.health, "Yellow glow: the hero is hurt").toBeLessThan(HERO_HEALTH);
      expect(renoPlay.after.players[human].hero.health, "Yellow glow: Reno's Cry sets it back to 30").toBe(HERO_HEALTH);
    }
    expect(coach.outcomes["play-reno"], "Yellow glow: the coach asked for Reno").toBe("done");

    // A token dies, and the coach says Felinor Fiender shrank with it.
    expect(coach.tips, "tip fewer-felinors shows").toContain("fewer-felinors");
  });

  it('R293 advanced: the coach never shows more than two "Got it"s in a row on its line', () => {
    const { runs, tips } = gotItRuns(coach);
    // The fold reads the same snapshots the harness's coach read.
    expect(tips, "the rebuilt line shows the tips the coach showed").toEqual(coach.tips);
    for (const run of runs) expect(run.length, `"Got it" ${run.join(" -> ")}`).toBeLessThanOrEqual(GOT_IT_RUN_MAX);
    // The lesson ends on the coach's next-move advice, not on a bubble to dismiss.
    expect(script.steps.at(-1)?.kind, "the last step asks for moves").toBe("act");
  });

  it(
    "R293 advanced: a beginner who plays only what the coach names still wins",
    () => {
      const run = playLesson(LESSON, { policy: "coach-passive" });
      expect(run.winner, "the human wins").toBe(human);
      expect(run.view.result?.reason).toBe("hero-death");
      expect(run.humanTurns, "within the lesson's turns").toBeLessThanOrEqual(PASSIVE_TURNS_MAX);
      expect(lowestHealth(run), "comfortably").toBeGreaterThanOrEqual(HEALTH_FLOOR);
      expect(run.coach.finished).toBe(true);
      // Every card this beginner played, the coach named.
      expect(run.humanActions.filter((entry) => entry.action.type === "play" && !entry.byCoach)).toEqual([]);
      expect(run.humanActions.filter((entry) => entry.refused !== null)).toEqual([]);
    },
    LESSON_TIMEOUT_MS,
  );

  it(
    "R293 advanced: a sensible beginner who ignores the coach still wins",
    () => {
      const run = playLesson(LESSON, { policy: "autopilot" });
      expect(run.winner, "the human wins").toBe(human);
      expect(run.humanTurns).toBeLessThanOrEqual(AUTOPILOT_TURNS_MAX);
      expect(lowestHealth(run), "comfortably").toBeGreaterThanOrEqual(HEALTH_FLOOR);
      expect(run.coach.finished).toBe(true);
    },
    LESSON_TIMEOUT_MS,
  );

  it(
    "R293 advanced: the lesson's decks forgive a game that goes another way: the autopilot wins most other deals",
    () => {
      const results: string[] = [];
      for (let n = 1; n <= ALT_DEALS; n += 1) {
        const run = playLesson(LESSON, { policy: "autopilot", seed: `${lesson.seed}:deal:${String(n)}` });
        results.push(run.winner === human ? "win" : "loss");
      }
      expect(results.filter((result) => result === "win").length, results.join(" ")).toBeGreaterThanOrEqual(ALT_WINS_MIN);
    },
    MANY_TIMEOUT_MS,
  );

  it(
    "R293 advanced: a player who ignores the coach never stalls or breaks it",
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
    "R293 advanced: the lesson replays from its seed, decks and handicaps",
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
