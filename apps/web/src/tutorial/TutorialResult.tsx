// The end of a lesson (SPEC §9.10): what it means for the path, and what to do next. It replaces
// practice's result dialog for a lesson game and keeps its pattern: a modal over a scrim, focus on
// the first way on, Escape or "View the board" to read the final board, the HUD's outcome chip to
// open it again.
//
//  - A win completes the lesson on this device (progress.ts, R294). The route records it the
//    moment the view says so, whether or not this dialog is ever seen; the dialog records it too,
//    which is a no-op by then. It names what the win opened and offers the next lesson, or, after
//    the last one, a practice game.
//  - A loss or a draw is "Not quite", the lesson's own tip, and Retry: the same lesson, the same
//    seed, the same hands.
//
// It reads only the human's `PlayerView` result (CLAUDE.md rule 7).

import { useEffect, useId, useRef, type CSSProperties, type ReactElement } from "react";

import type { PlayerId, PlayerView } from "@jackioh/shared";

import { PRACTICE_RESULT_PARTICLES } from "../practice/config.ts";
import { outcomeOf } from "../practice/PracticeResult.tsx";
import type { TutorialLesson } from "./lessons.ts";
import { markLessonComplete } from "./progress.ts";
import { tutorialTestid } from "./testids.ts";
import "../practice/practice.css";
import "./tutorial.css";

type Result = NonNullable<PlayerView["result"]>;

type TutorialResultProps = {
  result: Result;
  viewer: PlayerId;
  lesson: TutorialLesson;
  /** The lesson after this one on the path; undefined after the last. */
  next: TutorialLesson | undefined;
  /** The next lesson was still locked when this one started, so this win is what opened it. */
  unlockedNow: boolean;
  onNext(): void;
  onRetry(): void;
  onBack(): void;
  onPlayPractice(): void;
  onViewBoard(): void;
};

function Emblem({ won, number }: { won: boolean; number: number }): ReactElement {
  return (
    <div className="practice-result__emblem tutorial-result__emblem" aria-hidden="true">
      <span className="practice-result__rays" />
      {won ? (
        <span className="practice-result__particles">
          {Array.from({ length: PRACTICE_RESULT_PARTICLES }, (_unused, index) => (
            <i key={index} style={{ "--i": index, "--n": PRACTICE_RESULT_PARTICLES } as CSSProperties} />
          ))}
        </span>
      ) : null}
      <svg className="tutorial-result__seal" viewBox="0 0 64 64" role="presentation">
        <circle className="tutorial-result__seal-ring" cx="32" cy="32" r="28" />
        {won ? (
          <path className="tutorial-result__seal-mark" d="M20 33 l8 8 l16 -18" />
        ) : (
          <text className="tutorial-result__seal-number" x="32" y="33" textAnchor="middle" dominantBaseline="central">
            {number}
          </text>
        )}
      </svg>
    </div>
  );
}

/** Why a lesson was not won, from the player's side of the table. */
function notQuiteLine(outcome: "loss" | "draw" | "win", reason: Result["reason"]): string {
  if (outcome === "draw") return reason === "turn-cap" ? "The turn limit was reached: a draw." : "The lesson ended in a draw.";
  switch (reason) {
    case "hero-death":
    case "both-heroes-dead":
      return "Your hero has fallen this time.";
    case "concede":
      return "You conceded this one.";
    default:
      return "The lesson has ended.";
  }
}

export function TutorialResult({
  result,
  viewer,
  lesson,
  next,
  unlockedNow,
  onNext,
  onRetry,
  onBack,
  onPlayPractice,
  onViewBoard,
}: TutorialResultProps): ReactElement {
  const outcome = outcomeOf(result, viewer);
  const won = outcome === "win";
  const titleId = useId();
  const primary = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (won) markLessonComplete(lesson.id);
  }, [won, lesson.id]);

  useEffect(() => {
    primary.current?.focus();
  }, []);

  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if (event.key === "Escape") onViewBoard();
    }
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [onViewBoard]);

  let title: string;
  let line: string;
  let primaryButton: ReactElement;
  if (!won) {
    title = "Not quite";
    line = notQuiteLine(outcome, result.reason);
    primaryButton = (
      <button ref={primary} type="button" className="practice-play" data-testid={tutorialTestid.retry} onClick={onRetry}>
        Retry
      </button>
    );
  } else if (next === undefined) {
    title = "Tutorial complete";
    line = "You have finished every lesson. The whole game is yours: try it against the AI.";
    primaryButton = (
      <button
        ref={primary}
        type="button"
        className="practice-play"
        data-testid={tutorialTestid.playPractice}
        onClick={onPlayPractice}
      >
        Play a practice game
      </button>
    );
  } else {
    title = "Lesson complete";
    line = unlockedNow
      ? `Lesson ${String(next.number)}: ${next.title} is unlocked.`
      : `Next up: Lesson ${String(next.number)}: ${next.title}.`;
    primaryButton = (
      <button ref={primary} type="button" className="practice-play" data-testid={tutorialTestid.next} onClick={onNext}>
        Next lesson
      </button>
    );
  }

  return (
    <div className="practice-result-scrim tutorial-result-scrim" data-outcome={outcome}>
      <section
        className="practice-result tutorial-result"
        data-testid={tutorialTestid.result}
        data-outcome={outcome}
        data-lesson={lesson.id}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <Emblem won={won} number={lesson.number} />
        <h2 className="practice-result__title tutorial-result__title" id={titleId}>
          {title}
        </h2>
        <p className="practice-result__reason">{line}</p>
        {won ? null : <p className="tutorial-result__tip">Tip: {lesson.retryTip}</p>}
        <p className="practice-result__meta">
          Tutorial · Lesson {lesson.number}: {lesson.title}
        </p>
        <div className="practice-result__actions">
          {primaryButton}
          <button
            type="button"
            className="practice-result__secondary"
            data-testid={tutorialTestid.back}
            onClick={onBack}
          >
            Back to lessons
          </button>
        </div>
        <button
          type="button"
          className="link-button practice-result__view"
          data-testid={tutorialTestid.viewBoard}
          onClick={onViewBoard}
        >
          View the board
        </button>
      </section>
    </div>
  );
}
