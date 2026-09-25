// Spec 22 — tutorial lesson 1 played to a win in the browser, following the coach (SPEC §9.10,
// R290–R294).
//
// What it proves, against `pnpm build:e2e` + `vite preview` and NO server:
//
//   * `/practice?lesson=basics` starts lesson 1 at once, under the tutorial's HUD (it names
//     lesson 1), and the coach's first step is on screen before the player has done anything;
//   * a player who does what the coach says wins: every "Got it" is pressed, every action the
//     coach's showing step asks for (`window.__jackiohTutorial.suggested`) is made through the UI —
//     the mulligan's toggles and Confirm, a hand card and then its zone or target, an attacker and
//     then its target, End turn — and when the coach asks for nothing the player attacks the enemy
//     hero or ends the turn. Nothing is dispatched through a dev handle (support/tutorial.ts);
//   * the step counter only moves forward, and it moves;
//   * no `action-error` ever appears (a recorder installed before the page boots would see one that
//     came and went between two of Cypress's looks);
//   * the lesson ends in `tutorial-result` with `data-outcome="win"`, which offers the next lesson,
//     and `localStorage["jackioh.tutorial.v1"]` now lists "basics" (R294);
//   * the log the browser played folds in Node, with the tutorial handicap the page reports, to the
//     browser's own hash (`cy.task("replayHash")`, R187, R290).
//
// Screenshots (the evidence folder): the first coach step, a play in flight (its hand card picked
// up, the zones it may go to lit), and the result, at the default 1280x720 viewport.
//
// House rules (BUILD M8): the lesson's seed is its own (a `?seed=` never overrides it, which is
// the point of a lesson), every wait is a retried assertion (`support/tutorial.ts` waitForMoment:
// the board settled, the coach caught up, a move for the human), and every selector comes from
// support/testids.ts.
//
// REDUCED MOTION, ON PURPOSE. The page is told `prefers-reduced-motion: reduce` before it boots
// (as spec 13's Hard game is). The board then draws every view as it arrives instead of holding it
// behind its animations, so the coach is never stale for long and the whole lesson runs in a
// fraction of the time; and what is under test here is the coach's line through a lesson, not the
// animations, which specs 01–04 and 17 cover. Nothing about the game changes: the AI's pacing is
// `?pace=fast` either way.
//
// The line is followed generically: the spec never names a card or a step of the lesson, so the
// lesson's content can change under it as long as following the coach still wins.

import { TUTORIAL_PROGRESS_KEY, TUTORIAL_PROGRESS_VERSION, timeouts } from "../../support/config.ts";
import {
  ACTION_ERROR,
  COACH,
  TUTORIAL_HUD,
  TUTORIAL_NEXT,
  TUTORIAL_RESULT,
  TUTORIAL_STEP,
  ts,
} from "../../support/testids.ts";
import type { TutorialData } from "../../support/tasks/lessons.ts";
import {
  TUTORIAL_BOOT_TIMEOUT,
  debugSnapshot,
  lessonUrl,
  storedProgress,
  takeMoment,
  tutorialHandle,
  visitTutorial,
  waitForMoment,
  type Moment,
  type StepCounter,
  type Taken,
} from "../../support/tutorial.ts";

/** Lesson 1, the one every player may start (R294). */
const LESSON_ID = "basics";

/**
 * The most moments (a "Got it", an action) the lesson may take before the spec calls it stuck.
 * Following the coach wins lesson 1 in well under half of this.
 */
const MOVE_BUDGET = 400;

type Recorder = { errors: string[] };
type RecorderWindow = { __tutorialRecorder?: Recorder };

/**
 * Record every `action-error` the page ever shows, from before its first script runs: a refusal
 * that comes and goes between two of Cypress's looks is still a refusal.
 */
function installRecorder(win: Cypress.AUTWindow): void {
  const recorder: Recorder = { errors: [] };
  (win as unknown as RecorderWindow).__tutorialRecorder = recorder;
  new win.MutationObserver(() => {
    const error = win.document.querySelector(ts(ACTION_ERROR));
    const text = error?.textContent ?? null;
    if (text !== null && recorder.errors.at(-1) !== text) recorder.errors.push(text);
  }).observe(win.document, { subtree: true, childList: true, characterData: true });
}

function recordedErrors(): Cypress.Chainable<string[]> {
  return cy.window({ log: false }).then((win) => {
    const recorder = (win as unknown as RecorderWindow).__tutorialRecorder;
    expect(recorder, "the recorder installed in onBeforeLoad").to.not.eq(undefined);
    return recorder?.errors ?? [];
  });
}

type Run = {
  counters: StepCounter[];
  taken: Record<Taken, number>;
  /** The first play gets a screenshot mid-flight. */
  playShot: boolean;
  outcome: string | null;
};

/** Follow the coach until the lesson ends, one moment at a time. */
function followCoach(run: Run, remaining: number): void {
  waitForMoment().then((moment: Moment) => {
    if (moment.kind === "over") {
      run.outcome = moment.outcome;
      return;
    }
    if (moment.counter !== null) run.counters.push(moment.counter);
    expect(remaining, `lesson 1 ends within ${String(MOVE_BUDGET)} moments`).to.be.greaterThan(0);
    takeMoment(moment, {
      afterPickUp: () => {
        if (run.playShot) return;
        run.playShot = true;
        cy.screenshot("22-tutorial-lesson-one/2-a-play-in-flight", { capture: "viewport" });
      },
    }).then((taken) => {
      run.taken[taken] += 1;
    });
    followCoach(run, remaining - 1);
  });
}

describe("22 — tutorial lesson 1, played to a win by following the coach (§9.10, R293)", () => {
  it("R293 the coach's line wins lesson 1 through the UI, saves the lesson and replays in Node", () => {
    cy.task<TutorialData>("tutorialLessons", undefined, { timeout: timeouts.task }).then((data) => {
      const lesson = data.lessons.find((candidate) => candidate.id === LESSON_ID);
      expect(lesson, `lessons.ts has lesson "${LESSON_ID}"`).to.not.eq(undefined);
      expect(lesson?.number, "basics is lesson 1").to.eq(1);
      if (lesson === undefined) return;

      visitTutorial(lessonUrl(LESSON_ID), {
        progress: null,
        reducedMotion: true,
        onBeforeLoad: installRecorder,
      });

      // The HUD names lesson 1, and the coach's first step is up before anything is done.
      cy.get(ts(TUTORIAL_HUD), { timeout: TUTORIAL_BOOT_TIMEOUT })
        .should("have.attr", "data-lesson", LESSON_ID)
        .and("have.attr", "data-human-seat", lesson.humanSeat)
        .and("contain.text", `Lesson ${String(lesson.number)}`)
        .and("contain.text", lesson.title);
      cy.get(ts(COACH), { timeout: TUTORIAL_BOOT_TIMEOUT })
        .should("be.visible")
        .and("have.attr", "data-coach-mode", "step")
        .and("not.have.attr", "data-stale");
      cy.get(ts(COACH)).invoke("attr", "data-coach-step").should("be.a", "string").and("not.be.empty");
      cy.get(ts(TUTORIAL_STEP)).should("contain.text", "Step 1 of");
      tutorialHandle().then((handle) => {
        expect(handle.lessonId).to.eq(LESSON_ID);
        expect(handle.display.mode, "the coach opens on a step").to.eq("step");
        expect(handle.display.stepNumber, "the coach opens on step 1").to.eq(1);
      });
      debugSnapshot().then((debug) => {
        expect(
          debug.log.filter((action) => action.playerId === lesson.humanSeat),
          "nothing has been done yet",
        ).to.deep.eq([]);
      });
      cy.screenshot("22-tutorial-lesson-one/1-first-coach-step", { capture: "viewport" });

      // Follow the coach to the end.
      const run: Run = { counters: [], taken: { ack: 0, coach: 0, fallback: 0 }, playShot: false, outcome: null };
      followCoach(run, MOVE_BUDGET);

      cy.get(ts(TUTORIAL_RESULT), { timeout: timeouts.view })
        .should("be.visible")
        .and("have.attr", "data-outcome", "win")
        .and("have.attr", "data-lesson", LESSON_ID);
      cy.get(ts(TUTORIAL_NEXT)).should("be.visible");
      cy.screenshot("22-tutorial-lesson-one/3-result", { capture: "viewport" });

      cy.then(() => {
        expect(run.outcome, "the lesson's outcome").to.eq("win");
        expect(run.playShot, "the coach asked for at least one play").to.eq(true);
        expect(run.taken.coach, "actions made because the coach asked for them").to.be.greaterThan(0);
        expect(run.taken.ack, "bubbles read with Got it").to.be.greaterThan(0);
        // The counter never goes back, and it moves.
        const steps = run.counters.map((counter) => counter.step);
        steps.forEach((step, at) => {
          if (at > 0) expect(step, `the step counter never goes back (moment ${String(at)})`).to.be.at.least(steps[at - 1] ?? 0);
        });
        expect(new Set(run.counters.map((counter) => counter.of)).size, "one step count for the whole lesson").to.eq(1);
        expect(Math.max(...steps), "the step counter advanced past step 1").to.be.greaterThan(1);
        cy.task("log", `[22] lesson 1 won: ${JSON.stringify(run.taken)}; steps seen ${JSON.stringify([...new Set(steps)])} of ${String(run.counters[0]?.of ?? 0)}`);
      });

      // Never refused, not even for a moment.
      cy.get(ts(ACTION_ERROR)).should("not.exist");
      recordedErrors().then((errors) => {
        expect(errors, "action-error never appeared").to.deep.eq([]);
      });

      // R294: the win is kept on this device.
      storedProgress().then((stored) => {
        expect(stored, `localStorage["${TUTORIAL_PROGRESS_KEY}"]`).to.deep.include({ v: TUTORIAL_PROGRESS_VERSION });
        expect((stored as { completed?: unknown }).completed, "the completed lessons").to.include(LESSON_ID);
      });

      // R187, R290: the browser's game folds in Node, the tutorial handicap included, to its own hash.
      debugSnapshot().then((debug) => {
        expect(debug.lesson, "the debug record names the lesson").to.eq(LESSON_ID);
        expect(debug.seed, "the lesson's own seed").to.eq(lesson.seed);
        expect(debug.humanSeat).to.eq(lesson.humanSeat);
        const aiSeat = lesson.humanSeat === "p1" ? "p2" : "p1";
        expect(debug.handicaps[aiSeat], "the AI seat plays with the tutorial handicap (R290)").to.deep.eq(data.aiTutorial);
        expect(debug.log.some((action) => action.playerId === aiSeat), "the AI acted").to.eq(true);

        cy.task<{ replayHash: string; browserHash: string; errors: unknown[] }>(
          "replayHash",
          {
            label: "22-tutorial-lesson-one",
            seed: debug.seed,
            decks: debug.decks,
            log: debug.log,
            state: debug.state,
            handicaps: debug.handicaps,
          },
          { timeout: timeouts.task },
        ).then((result) => {
          expect(result.errors, "the lesson's log replays with no rejected action").to.deep.eq([]);
          expect(result.browserHash, "hashState of the page's final state is the page's own hash").to.eq(debug.hash);
          expect(result.replayHash, "the Node fold, tutorial handicap included, reaches the browser's state").to.eq(
            result.browserHash,
          );
        });
      });
    });
  });
});
