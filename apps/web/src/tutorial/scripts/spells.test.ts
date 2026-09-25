// Lesson "spells" (SPEC §9.10, R293): the coach's own line wins and shows every step, the lesson's
// mechanics come up on it without ever asking for more than two "Got it"s in a row, a beginner who
// plays only what the coach names wins, a beginner who ignores the coach still wins, a player who
// does anything at all never stalls or breaks the coach, and the whole game replays from its seed.
//
// Played through the REAL practice core (harness.ts): the engine, the card scripts and the AI.

import { beforeAll, describe, expect, it } from "vitest";

import { aiToAct } from "@jackioh/ai";
import { beginGame, createGame, findInstance, fold, hashState, legalActions, reduce, viewFor, type GameState } from "@jackioh/engine";
import { opponentOf, type Action, type GameEvent, type PlayerId, type PlayerView, type UnitView } from "@jackioh/shared";

import { newEventsSince } from "../../game/animations.ts";
import { COACH_START, coachAck, coachDisplay, coachObserve, type CoachCtx } from "../coach.ts";
import { playLesson, type LessonRun } from "../harness.ts";
import { lessonById } from "../lessons.ts";
import { script } from "./spells.ts";

const LESSON = "spells";
/** The coach's line wins on the player's 8th turn; the lesson is meant to take 6 to 9. */
const COACH_TURNS_MAX = 9;
/** The autopilot's line wins on its 9th turn. */
const AUTOPILOT_TURNS_MAX = 10;
/**
 * A beginner who plays only what the coach names (and otherwise only attacks and ends the turn)
 * wins on the 8th turn too: the coach names a move on every turn of this lesson.
 */
const PASSIVE_TURNS_MAX = 9;
/** The most "Got it" bubbles the coach shows in a row, with no move of the player's between them. */
const GOT_IT_RUN_MAX = 2;
/** Policy seeds for the player who ignores the coach (each game meets the harness's cheaper AI). */
const RANDOM_RUNS = 15;
/** One lesson game through the real core takes a few seconds; generous, for a loaded machine. */
const LESSON_TIMEOUT_MS = 60_000;
/** The random policy's allowance, for all of its runs. */
const RANDOM_TIMEOUT_MS = 240_000;

const VANILLA = "core-008";
const TIMMY = "core-011";
const LUNAR = "core-035";
const TRUE_STRIKE = "core-044";
const HIT_JOB = "core-016";
const SORCERER = "core-068";
const DUELIST = "core-045";
const BIG_D = "core-001";
const DEFENDER = "core-003";
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

function defIdOf(state: GameState, instanceId: string): string | undefined {
  return findInstance(state, instanceId)?.defId;
}

/** A unit as the human saw it in that state (keywords, Armor and position from the layers). */
function unitSeen(state: GameState, viewer: PlayerId, instanceId: string): UnitView | undefined {
  const view = viewFor(state, viewer);
  return [...view.you.units, ...view.opponent.units].find((unit): unit is UnitView => unit !== null && unit.instanceId === instanceId);
}

function hasKeyword(unit: UnitView | undefined, kind: string): boolean {
  return unit?.keywords.some((keyword) => keyword.kind === kind) === true;
}

/** The human's play of the card of this definition. */
function playOf(steps: readonly Step[], human: PlayerId, defId: string): Step | undefined {
  return steps.find((step) => step.action.playerId === human && step.action.type === "play" && defIdOf(step.before, step.action.instanceId) === defId);
}

/** The instance a play put on the field (its `summoned` event). */
function summonedBy(step: Step | undefined, defId: string): string | undefined {
  const event = step?.events.find((candidate) => candidate.type === "summoned" && candidate.defId === defId);
  return event?.type === "summoned" ? event.instanceId : undefined;
}

/** The single instance a play aimed at. */
function targetOf(step: Step | undefined): string | undefined {
  if (step?.action.type !== "play") return undefined;
  const [target] = step.action.targets ?? [];
  return target?.pick === "instance" ? target.instanceId : undefined;
}

describe("R293 lesson spells", () => {
  let coach: LessonRun;
  let steps: Step[];
  const human: PlayerId = lesson.humanSeat;
  const ai: PlayerId = opponentOf(human);
  const heroId = `hero-${ai}`;

  beforeAll(() => {
    coach = playLesson(LESSON, { policy: "coach" });
    steps = stepsOf(coach);
  }, LESSON_TIMEOUT_MS);

  it("R293 spells: following the coach wins the lesson, and every step shows and is done", () => {
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

  it("R293 spells: the lesson's mechanics come up on the coach line", () => {
    const mine = steps.filter((step) => step.action.playerId === human);

    // Spells: Lunar Eclipse and True Strike are cast at an enemy unit, each hurts it, and each is
    // spent: Lunar Eclipse to the graveyard, True Strike to exile (its own text).
    for (const [defId, name, pile] of [
      [LUNAR, "Lunar Eclipse", "graveyard"],
      [TRUE_STRIKE, "True Strike", "exile"],
    ] as const) {
      const cast = playOf(mine, human, defId);
      const target = targetOf(cast);
      expect(target, `targeted spell: ${name} is cast at an enemy unit`).toBeDefined();
      const enemies = cast === undefined ? [] : viewFor(cast.before, human).opponent.units;
      expect(enemies.some((unit) => unit !== null && unit.instanceId === target), `${name}'s target is the AI's`).toBe(true);
      expect(
        cast?.events.some((event) => event.type === "damage" && event.targetId === target && event.amount > 0),
        `targeted spell: ${name} damages its target`,
      ).toBe(true);
      const spent = cast?.after.players[human][pile].some((card) => card.defId === defId);
      expect(spent, `a spell is one-shot: ${name} ends in the ${pile}`).toBe(true);
    }

    // Removal: Hit Job destroys its target outright.
    const hitJob = playOf(mine, human, HIT_JOB);
    const hitTarget = targetOf(hitJob);
    expect(hitTarget, "removal: Hit Job is cast at an enemy unit").toBeDefined();
    expect(hitJob?.events.some((event) => event.type === "destroyed" && event.instanceId === hitTarget), "removal: Hit Job destroys it").toBe(true);

    // Cry with a target: Twisted Sorcerer's 4 damage lands as it is played, on the unit the play picked.
    const sorcerer = playOf(mine, human, SORCERER);
    const sorcererId = summonedBy(sorcerer, SORCERER);
    const cryTarget = targetOf(sorcerer);
    expect(cryTarget, "Cry: Twisted Sorcerer is played with a target").toBeDefined();
    expect(
      sorcerer?.events.some((event) => event.type === "damage" && event.sourceId === sorcererId && event.targetId === cryTarget && event.amount > 0),
      "Cry: its damage lands on that target as it is played",
    ).toBe(true);

    // Taunt: Mr. Vanilla attacks Right-house defender, and while it stood no attack could reach the hero.
    const attacks = mine.filter((step) => step.action.type === "attack");
    const intoTaunt = attacks.find((step) => {
      if (step.action.type !== "attack") return false;
      return hasKeyword(unitSeen(step.before, human, step.action.targetId), "Taunt");
    });
    expect(intoTaunt, "Taunt: the player attacks into a Taunt unit").toBeDefined();
    if (intoTaunt !== undefined) {
      const offered = legalActions(intoTaunt.before, human).filter((action) => action.type === "attack");
      expect(offered.length).toBeGreaterThan(0);
      expect(
        offered.every((action) => action.type === "attack" && hasKeyword(unitSeen(intoTaunt.before, human, action.targetId), "Taunt")),
        "Taunt: every attack on offer is at a Taunt unit",
      ).toBe(true);
    }

    // Divine Shield: an attack on the defender breaks its shield and does no damage.
    const shieldBreak = attacks.find(
      (step) =>
        step.action.type === "attack" &&
        step.events.some((event) => event.type === "divineShieldLost" && step.action.type === "attack" && event.instanceId === step.action.targetId),
    );
    expect(shieldBreak, "Divine Shield: a player's attack breaks an enemy shield").toBeDefined();
    if (shieldBreak?.action.type === "attack") {
      const target = shieldBreak.action.targetId;
      expect(
        shieldBreak.events.some((event) => event.type === "damage" && event.targetId === target && event.amount > 0),
        "Divine Shield: the hit that breaks it does no damage",
      ).toBe(false);
    }

    // Reborn: Right-house defender dies to the player and comes straight back.
    const reborn = mine.find((step) =>
      step.events.some(
        (event) =>
          event.type === "destroyed" &&
          event.defId === DEFENDER &&
          step.events.some((back) => back.type === "summoned" && back.instanceId === event.instanceId),
      ),
    );
    expect(reborn, "Reborn: the defender dies and comes back").toBeDefined();

    // Rush: Tempo Timmy attacks a unit the turn it arrives, though it may not attack the hero then.
    const timmyPlay = playOf(mine, human, TIMMY);
    const timmy = summonedBy(timmyPlay, TIMMY);
    const rush = attacks.find((step) => step.action.type === "attack" && step.action.attackerId === timmy && step.before.turn === timmyPlay?.before.turn);
    expect(rush, "Rush: Tempo Timmy attacks on the turn it arrives").toBeDefined();
    if (rush !== undefined) {
      expect(
        legalActions(rush.before, human).some((action) => action.type === "attack" && action.attackerId === timmy && action.targetId === heroId),
        "Rush: not the hero on its first turn",
      ).toBe(false);
    }

    // Charge: Deft Duelist attacks the enemy hero the turn it arrives.
    const duelistPlay = playOf(mine, human, DUELIST);
    const duelist = summonedBy(duelistPlay, DUELIST);
    const charge = attacks.find(
      (step) =>
        step.action.type === "attack" &&
        step.action.attackerId === duelist &&
        step.action.targetId === heroId &&
        step.before.turn === duelistPlay?.before.turn,
    );
    expect(charge, "Charge: Deft Duelist hits the enemy hero the turn it arrives").toBeDefined();
    expect(charge?.events.some((event) => event.type === "damage" && event.targetId === heroId && event.amount > 0)).toBe(true);

    // First Strike: Tempo Timmy kills a unit and takes no damage back.
    const firstStrike = attacks.find((step) => {
      if (step.action.type !== "attack" || step.action.attackerId !== timmy) return false;
      const { attackerId, targetId } = step.action;
      return (
        step.events.some((event) => event.type === "destroyed" && event.instanceId === targetId) &&
        !step.events.some((event) => event.type === "damage" && event.targetId === attackerId)
      );
    });
    expect(firstStrike, "First Strike: Tempo Timmy kills its target and takes nothing back").toBeDefined();

    // Defense Position: Big D-fender switches to Defense and gains Taunt and Armor.
    const guard = summonedBy(playOf(mine, human, BIG_D), BIG_D);
    const switched = mine.find((step) => step.action.type === "switchPosition" && step.action.instanceId === guard);
    expect(switched, "Defense Position: the player switches Big D-fender").toBeDefined();
    expect(switched?.events.some((event) => event.type === "positionSwitched" && event.position === "DEF")).toBe(true);
    if (switched !== undefined && guard !== undefined) {
      const after = unitSeen(switched.after, human, guard);
      expect(after?.position, "Defense Position: it is in Defense").toBe("DEF");
      expect(hasKeyword(after, "Taunt"), "Defense Position: it gains Taunt").toBe(true);
      expect(after?.armor ?? 0, "Defense Position: it gains Armor").toBeGreaterThan(unitSeen(switched.before, human, guard)?.armor ?? 0);
    }

    // The AI goes second and plays The Coin; the coach explains the keywords the AI shows.
    expect(
      steps.some((step) => step.events.some((event) => event.type === "cardPlayed" && event.player === ai && event.defId === COIN)),
      "the AI plays The Coin",
    ).toBe(true);
    for (const id of ["coin", "taunt", "shield", "reborn", "spent", "ai-defense", "defense-back"]) {
      expect(coach.tips, `the coach shows the "${id}" tip`).toContain(id);
    }
    expect(coach.shown.map((entry) => entry.id), "the coach tells the player to read cards").toContain("read-cards");

    // Mr. Vanilla opens on turn 1 and is the one that attacks into the Taunt.
    const vanilla = summonedBy(playOf(mine, human, VANILLA), VANILLA);
    expect(intoTaunt?.action.type === "attack" ? intoTaunt.action.attackerId : "").toBe(vanilla);

    // Winning: the enemy hero reaches 0.
    const over = steps.flatMap((step) => step.events).find((event) => event.type === "gameOver");
    expect(over?.type === "gameOver" ? over.winner : null, "the player wins").toBe(human);
    expect(steps.at(-1)?.after.players[ai].hero.health ?? 1, "the enemy hero is at 0").toBeLessThanOrEqual(0);
  });

  it("R293 spells: the coach never shows more than two \"Got it\"s in a row on its line", () => {
    const { runs, tips } = gotItRuns(coach);
    // The fold reads the same snapshots the harness's coach read.
    expect(tips, "the rebuilt line shows the tips the coach showed").toEqual(coach.tips);
    for (const run of runs) expect(run.length, `"Got it" ${run.join(" -> ")}`).toBeLessThanOrEqual(GOT_IT_RUN_MAX);
  });

  it(
    "R293 spells: a beginner who plays only what the coach names still wins",
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
    "R293 spells: a sensible beginner who ignores the coach still wins",
    () => {
      const run = playLesson(LESSON, { policy: "autopilot" });
      expect(run.winner).toBe(human);
      expect(run.humanTurns).toBeLessThanOrEqual(AUTOPILOT_TURNS_MAX);
      expect(run.coach.finished).toBe(true);
    },
    LESSON_TIMEOUT_MS,
  );

  it(
    "R293 spells: a player who ignores the coach never stalls or breaks it",
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
    "R293 spells: the lesson replays from its seed, decks and handicaps",
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
