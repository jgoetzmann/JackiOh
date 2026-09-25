// The bar above a lesson's board (SPEC §9.10): which lesson this is, how far through its steps the
// player is, the practice HUD's live status (modifiers, "AI is thinking…", the outcome), and Exit
// tutorial, which nothing the coach draws is ever placed over. There is no Skip step (R314): a step
// moves on when it is done, by "Got it", or by itself (coach.ts).
//
// It replaces the practice HUD for a lesson and wears its look (`practice-hud`), so the board below
// is laid out exactly as in any practice game.

import { useSyncExternalStore, type CSSProperties, type ReactElement } from "react";

import type { PlayerId, PlayerView } from "@jackioh/shared";

import { ModifierList } from "../practice/ModifierList.tsx";
import { OUTCOME_TITLE, type PracticeOutcome } from "../practice/PracticeResult.tsx";
import { ThinkIndicator } from "../practice/ThinkIndicator.tsx";
import type { TutorialLesson } from "./lessons.ts";
import { tutorialTestid } from "./testids.ts";
import type { CoachTracker } from "./tracker.ts";
import "./tutorial.css";

type TutorialHudProps = {
  lesson: TutorialLesson;
  tracker: CoachTracker;
  view: PlayerView;
  humanSeat: PlayerId;
  aiSeat: PlayerId | null;
  thinking: boolean;
  /** The lesson's outcome once it is over; null while it is played. */
  outcome: PracticeOutcome | null;
  onShowResult(): void;
  /** Mid-lesson this opens "Leave this game?"; once it is over it leaves at once. */
  onExit(): void;
};

export function TutorialHud({
  lesson,
  tracker,
  view,
  humanSeat,
  aiSeat,
  thinking,
  outcome,
  onShowResult,
  onExit,
}: TutorialHudProps): ReactElement {
  const coach = useSyncExternalStore(tracker.subscribe, tracker.getState, tracker.getState);
  const display = coach.display;
  const over = outcome !== null;
  const counting = display.mode !== "finished";
  const stepNumber = counting ? display.stepNumber : 0;
  const stepCount = counting ? display.stepCount : 0;

  return (
    <header
      className="practice-hud tutorial-hud"
      data-testid={tutorialTestid.hud}
      data-lesson={lesson.id}
      data-human-seat={humanSeat}
      data-ai-seat={aiSeat ?? ""}
      data-thinking={thinking ? "true" : "false"}
    >
      <span className="tutorial-hud__lesson">
        <span className="tutorial-hud__badge" aria-hidden="true">
          {lesson.number}
        </span>
        <span className="tutorial-hud__label">
          <span className="practice-hud__mode tutorial-hud__mode">Tutorial ·</span>
          <strong className="tutorial-hud__title">
            Lesson {lesson.number}: {lesson.title}
          </strong>
        </span>
      </span>
      {counting && !over ? (
        <span className="tutorial-hud__step" data-testid={tutorialTestid.step}>
          <span className="tutorial-hud__step-text">
            <span className="tutorial-hud__step-long">
              Step {stepNumber} of {stepCount}
            </span>
            <span className="tutorial-hud__step-short" aria-hidden="true">
              {stepNumber}/{stepCount}
            </span>
          </span>
          <span
            className="tutorial-hud__meter"
            aria-hidden="true"
            style={{ "--done": stepCount === 0 ? 0 : (stepNumber - 1) / stepCount } as CSSProperties}
          />
        </span>
      ) : null}
      <span className="practice-hud__status">
        <ModifierList view={view} />
        <ThinkIndicator thinking={thinking} />
        {outcome === null ? null : (
          <button
            type="button"
            className="practice-hud__outcome"
            data-testid={tutorialTestid.outcome}
            data-outcome={outcome}
            onClick={onShowResult}
          >
            {OUTCOME_TITLE[outcome]}
          </button>
        )}
      </span>
      <button
        type="button"
        className="tutorial-hud__exit"
        data-testid={tutorialTestid.exit}
        aria-haspopup={over ? undefined : "dialog"}
        aria-label="Exit tutorial"
        onClick={onExit}
      >
        <span className="tutorial-hud__long">Exit tutorial</span>
        <span className="tutorial-hud__short" aria-hidden="true">
          Exit
        </span>
      </button>
    </header>
  );
}
