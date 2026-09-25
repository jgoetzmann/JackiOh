// Lesson "basics" (SPEC §9.10, R293): the coach's own line wins and shows every step, the lesson's
// mechanics come up on it without ever asking for more than two "Got it"s in a row, a beginner who
// plays only what the coach names wins, a beginner who ignores the coach still wins, a player who
// does anything at all never stalls or breaks the coach, and the whole game replays from its seed.
//
// Played through the REAL practice core (harness.ts): the engine, the card scripts and the AI.

import { beforeAll, describe, expect, it } from "vitest";

import { aiToAct } from "@jackioh/ai";
import { beginGame, createGame, fold, hashState, legalActions, reduce, viewFor, type GameState } from "@jackioh/engine";
import { AI_TUTORIAL, HERO_HEALTH } from "@jackioh/engine/config";
import { opponentOf, type Action, type GameEvent, type PlayerId, type PlayerView } from "@jackioh/shared";

import { newEventsSince } from "../../game/animations.ts";
import { COACH_START, coachAck, coachDisplay, coachObserve, type CoachCtx } from "../coach.ts";
import { playLesson, type LessonRun } from "../harness.ts";
import { lessonById } from "../lessons.ts";
import { script } from "./basics.ts";

const LESSON = "basics";
/** The coach's line wins on the player's 6th turn; the lesson is meant to take 6 to 8. */
const COACH_TURNS_MAX = 8;
/** The autopilot's line wins on its 6th turn too. */
const AUTOPILOT_TURNS_MAX = 8;
/**
 * A beginner who plays only what the coach names (and otherwise only attacks and ends the turn)
 * wins on the 6th turn too: from the trade on, the coach names every move.
 */
const PASSIVE_TURNS_MAX = 8;
/** The most "Got it" bubbles the coach shows in a row, with no move of the player's between them. */
const GOT_IT_RUN_MAX = 2;
/**
 * Policy seeds for the player who ignores the coach. The harness gives the AI a small budget under
 * the random policy, so each of these games costs a second or three.
 */
const RANDOM_RUNS = 15;
/** One lesson game through the real core takes a few seconds; generous, for a loaded machine. */
const LESSON_TIMEOUT_MS = 60_000;
/** The random policy's allowance, for all of its runs. */
const RANDOM_TIMEOUT_MS = 240_000;

const VANILLA = "core-008";
const COIN = "core-t-coin";

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

describe("R293 lesson basics", () => {
  let coach: LessonRun;
  let steps: Step[];
  const human: PlayerId = lesson.humanSeat;
  const ai: PlayerId = opponentOf(human);

  beforeAll(() => {
    coach = playLesson(LESSON, { policy: "coach" });
    steps = stepsOf(coach);
  }, LESSON_TIMEOUT_MS);

  it("R293 basics: following the coach wins the lesson, and every step shows and is done", () => {
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

    // The coach asked for every move the player made, and the engine took each one.
    expect(coach.humanActions.filter((entry) => !entry.byCoach).map((entry) => entry.action.type)).toEqual([]);
    expect(coach.humanActions.filter((entry) => entry.refused !== null)).toEqual([]);
  });

  it("R293 basics: the lesson's mechanics come up on the coach line", () => {
    const mine = steps.filter((step) => step.action.playerId === human);
    const eventsOn = (turn: number): GameEvent[] => steps.filter((step) => step.before.turn === turn).flatMap((step) => step.events);

    // Hero health: 30 for the player, 20 for the tutorial's enemy hero.
    const start = beginGame(createGame({ seed: coach.debug.seed, decks: coach.debug.decks, handicaps: coach.debug.handicaps })).state;
    expect(start.players[human].hero.health, "the player's hero starts at 30").toBe(HERO_HEALTH);
    expect(start.players[ai].hero.health, "the enemy hero starts at 20").toBe(AI_TUTORIAL.heroHealth);

    // The opening hand is kept whole.
    const [first] = mine;
    expect(first?.action.type, "the mulligan comes first").toBe("mulligan");
    if (first?.action.type === "mulligan") expect(first.action.keep.length, "the whole hand is kept").toBe(first.before.players[human].hand.length);

    // Mana: one crystal more each turn, and a card of every cost from 1 to 4 on turns 1 to 4.
    for (let n = 1; n <= 4; n += 1) {
      const turn = gameTurnOf(human, n);
      const refill = eventsOn(turn - 1)
        .concat(eventsOn(turn))
        .filter((event): event is Extract<GameEvent, { type: "manaChanged" }> => event.type === "manaChanged" && event.player === human);
      expect(refill.map((event) => event.max), `mana: ${String(n)} crystals on turn ${String(n)}`).toContain(n);
      const paid = eventsOn(turn).filter((event) => event.type === "cardPlayed" && event.player === human);
      expect(
        paid.map((event) => (event.type === "cardPlayed" ? event.costPaid : -1)),
        `mana: a ${String(n)}-cost card is played on turn ${String(n)}`,
      ).toContain(n);
    }

    // A card is drawn at the start of each of the player's turns.
    for (let n = 1; n <= 4; n += 1) {
      expect(
        eventsOn(gameTurnOf(human, n) - 1).some((event) => event.type === "drawn" && event.player === human),
        `a card is drawn at the start of turn ${String(n)}`,
      ).toBe(true);
    }

    // Playing units: they go into the unit zones, in lanes.
    const summoned = mine.flatMap((step) => step.events).filter((event) => event.type === "summoned" && event.player === human);
    expect(summoned.length, "units are played").toBeGreaterThanOrEqual(4);
    for (const event of summoned) if (event.type === "summoned") expect(event.row).toBe("units");

    // Summoning sickness: Mr. Vanilla cannot attack on the turn it arrives, and does on the next.
    const vanillaPlay = mine.find((step) => step.events.some((event) => event.type === "summoned" && event.defId === VANILLA));
    expect(vanillaPlay?.before.turn, "Mr. Vanilla arrives on turn 1").toBe(gameTurnOf(human, 1));
    const vanillaId = vanillaPlay?.events.find((event) => event.type === "summoned" && event.defId === VANILLA);
    const vanilla = vanillaId?.type === "summoned" ? vanillaId.instanceId : "";
    if (vanillaPlay === undefined) throw new Error("Mr. Vanilla never arrived");
    expect(
      legalActions(vanillaPlay.after, human).some((action) => action.type === "attack" && action.attackerId === vanilla),
      "summoning sickness: no attack on the turn it arrives",
    ).toBe(false);

    // Attacking the hero: Mr. Vanilla hits the enemy hero on turn 2.
    const heroId = `hero-${ai}`;
    const heroHit = mine.find(
      (step) =>
        step.action.type === "attack" &&
        step.action.targetId === heroId &&
        step.events.some((event) => event.type === "damage" && event.targetId === heroId && event.amount > 0),
    );
    expect(heroHit, "attacking the hero").toBeDefined();
    expect(heroHit?.before.turn, "on turn 2, with Mr. Vanilla").toBe(gameTurnOf(human, 2));
    expect(heroHit?.action.type === "attack" ? heroHit.action.attackerId : "").toBe(vanilla);

    // Trading: a unit attacks an enemy unit, both take damage, the enemy unit is destroyed and goes to
    // the graveyard, and the attacker lives on with its damage.
    const trade = mine.find((step) => {
      if (step.action.type !== "attack" || step.action.targetId === heroId) return false;
      const { attackerId, targetId } = step.action;
      const hurt = (id: string): boolean => step.events.some((event) => event.type === "damage" && event.targetId === id && event.amount > 0);
      return (
        hurt(attackerId) &&
        hurt(targetId) &&
        step.events.some((event) => event.type === "destroyed" && event.instanceId === targetId) &&
        !step.events.some((event) => event.type === "destroyed" && event.instanceId === attackerId)
      );
    });
    expect(trade, "a trade the attacker survives").toBeDefined();
    if (trade?.action.type === "attack") {
      const { targetId } = trade.action;
      expect(trade.after.players[ai].graveyard.some((card) => card.id === targetId), "the destroyed unit is in the graveyard").toBe(true);
    }

    // The enemy goes second, so it gets The Coin, and the coach explains it.
    expect(
      steps.some((step) => step.events.some((event) => event.type === "cardPlayed" && event.player === ai && event.defId === COIN)),
      "the AI plays The Coin",
    ).toBe(true);
    expect(coach.tips, "the coach explains The Coin").toContain("coin");
    expect(coach.tips, "and the enemy's first unit").toContain("enemy-unit");

    // Winning: the enemy hero reaches 0.
    const over = steps.flatMap((step) => step.events).find((event) => event.type === "gameOver");
    expect(over?.type === "gameOver" ? over.winner : null, "the player wins").toBe(human);
    expect(steps.at(-1)?.after.players[ai].hero.health ?? 1, "the enemy hero is at 0").toBeLessThanOrEqual(0);
  });

  it("R293 basics: the coach never shows more than two \"Got it\"s in a row on its line", () => {
    const { runs, tips } = gotItRuns(coach);
    // The fold reads the same snapshots the harness's coach read.
    expect(tips, "the rebuilt line shows the tips the coach showed").toEqual(coach.tips);
    for (const run of runs) expect(run.length, `"Got it" ${run.join(" -> ")}`).toBeLessThanOrEqual(GOT_IT_RUN_MAX);
    // The AI's second turn (an attack that costs a unit, then Defense Position) is the busiest moment,
    // and the Postdoc's copy waits for the player's own turn.
    expect(runs, "the attack and the loss are one tip").toContainEqual(["enemy-attacks", "defense"]);
    expect(coach.tips, "the Postdoc's copy is explained").toContain("postdoc");
  });

  it(
    "R293 basics: a beginner who plays only what the coach names still wins",
    () => {
      const run = playLesson(LESSON, { policy: "coach-passive" });
      expect(run.winner, "the human wins").toBe(human);
      expect(run.view.result?.reason).toBe("hero-death");
      expect(run.humanTurns, "within the lesson's turns").toBeLessThanOrEqual(PASSIVE_TURNS_MAX);
      expect(run.coach.finished).toBe(true);
      // Every card this beginner played, the coach named.
      expect(run.humanActions.filter((entry) => entry.action.type === "play" && !entry.byCoach)).toEqual([]);
      expect(run.humanActions.filter((entry) => entry.refused !== null)).toEqual([]);
    },
    LESSON_TIMEOUT_MS,
  );

  it(
    "R293 basics: a sensible beginner who ignores the coach still wins",
    () => {
      const run = playLesson(LESSON, { policy: "autopilot" });
      expect(run.winner).toBe(human);
      expect(run.humanTurns).toBeLessThanOrEqual(AUTOPILOT_TURNS_MAX);
      expect(run.coach.finished).toBe(true);
    },
    LESSON_TIMEOUT_MS,
  );

  it(
    "R293 basics: a player who ignores the coach never stalls or breaks it",
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
    RANDOM_TIMEOUT_MS,
  );

  it(
    "R293 basics: the lesson replays from its seed, decks and handicaps",
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
