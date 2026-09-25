// The lesson path at the top of `/practice` (SPEC §9.10): the tutorial's lessons in order, joined
// like a path, each with what it teaches and whether it is open (R294's unlock rule, progress.ts).
//
// Four across on a desktop, one under another on a phone (tutorial.css). A locked lesson's button
// stays focusable and says why it is locked (`aria-disabled`, not `disabled`), and does nothing.
// Once every lesson is done the path folds to its header, so a player who has finished the
// tutorial gets straight to practice; one button opens it again.
//
// R322: while a lesson is still to do, the header also offers "Hide tutorial", which folds the
// whole path to a single "Show tutorial" button in its place. The choice is the player's and is
// kept with their progress (progress.ts, and the account's copy, R321), so it holds on the next
// visit and whatever the progress: a path hidden before the last lesson stays hidden after it. A
// finished path offers no Hide, since it already folds to its header by itself. Focus follows the
// player's own press to the button that undoes it, so a keyboard is never left on nothing.

import { useEffect, useId, useRef, useState, type ReactElement } from "react";

import { TUTORIAL_LESSONS, type TutorialLesson } from "./lessons.ts";
import {
  isTutorialHidden,
  lessonStatus,
  nextLessonToPlay,
  setTutorialHidden,
  useTutorialProgress,
  type LessonStatus,
} from "./progress.ts";
import { tutorialTestid } from "./testids.ts";
import "./tutorial.css";
import "./path-visibility.css";

type TutorialPathProps = {
  /** Start (or replay) this lesson. Never called for a locked one. */
  onStart(lesson: TutorialLesson): void;
};

function CheckIcon(): ReactElement {
  return (
    <svg className="tutorial-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3.5 8.5 L6.5 11.5 L12.5 4.5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function LockIcon(): ReactElement {
  return (
    <svg className="tutorial-icon" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="3.5" y="7" width="9" height="7" rx="1.5" fill="currentColor" />
      <path d="M5.5 7 V5.2 a2.5 2.5 0 0 1 5 0 V7" fill="none" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

function statusText(status: LessonStatus, lesson: TutorialLesson, isNext: boolean): string {
  switch (status) {
    case "completed":
      return "Completed";
    case "locked":
      return `Finish lesson ${String(lesson.number - 1)} first`;
    case "unlocked":
      return isNext ? "Up next" : "Open";
  }
}

function buttonLabel(status: LessonStatus): string {
  switch (status) {
    case "completed":
      return "Replay";
    case "locked":
      return "Locked";
    case "unlocked":
      return "Start";
  }
}

function LessonNode({
  lesson,
  status,
  isNext,
  onStart,
}: {
  lesson: TutorialLesson;
  status: LessonStatus;
  isNext: boolean;
  onStart(lesson: TutorialLesson): void;
}): ReactElement {
  const statusId = useId();
  const locked = status === "locked";
  const label = buttonLabel(status);
  return (
    <li
      className="tutorial-lesson"
      data-testid={tutorialTestid.lesson(lesson.id)}
      data-status={status}
      data-next={isNext ? "true" : undefined}
    >
      <span className="tutorial-lesson__node" aria-hidden="true">
        {status === "completed" ? <CheckIcon /> : status === "locked" ? <LockIcon /> : lesson.number}
      </span>
      <div className="tutorial-lesson__card">
        <p className="tutorial-lesson__kicker">
          Lesson {lesson.number}
          {isNext ? <span className="tutorial-lesson__next"> · Up next</span> : null}
        </p>
        <h3 className="tutorial-lesson__title">{lesson.title}</h3>
        <p className="tutorial-lesson__summary">{lesson.summary}</p>
        <ul className="tutorial-lesson__chips" aria-label="What it teaches">
          {lesson.mechanics.map((mechanic) => (
            <li key={mechanic} className="tutorial-lesson__chip">
              {mechanic}
            </li>
          ))}
        </ul>
        <div className="tutorial-lesson__foot">
          {/* An open lesson's kicker already says "Up next"; its status is there for a screen reader. */}
          <span
            className={status === "unlocked" ? "tutorial-lesson__status tutorial-sr-only" : "tutorial-lesson__status"}
            id={statusId}
          >
            {status === "completed" ? <CheckIcon /> : null}
            {statusText(status, lesson, isNext)}
          </span>
          <button
            type="button"
            className={`tutorial-lesson__button tutorial-lesson__button--${status}${isNext ? " tutorial-lesson__button--next" : ""}`}
            data-testid={tutorialTestid.lessonStart(lesson.id)}
            aria-disabled={locked ? "true" : undefined}
            aria-label={`${label}: lesson ${String(lesson.number)}, ${lesson.title}`}
            aria-describedby={statusId}
            onClick={() => {
              if (!locked) onStart(lesson);
            }}
          >
            {locked ? <LockIcon /> : null}
            {label}
          </button>
        </div>
      </div>
    </li>
  );
}

export function TutorialPath({ onStart }: TutorialPathProps): ReactElement {
  const progress = useTutorialProgress();
  const headingId = useId();
  const listId = useId();
  const total = TUTORIAL_LESSONS.length;
  const done = TUTORIAL_LESSONS.filter((lesson) => lessonStatus(progress, lesson) === "completed").length;
  const allDone = done === total;
  const next = nextLessonToPlay(progress);
  /** The player's own choice to show or fold the path; unset, it is open until every lesson is done. */
  const [openChoice, setOpenChoice] = useState<boolean | null>(null);
  const open = openChoice ?? !allDone;

  // R322: hidden by the player's own choice, stored with the progress.
  const hidden = isTutorialHidden(progress);
  /** Where focus goes once this component's own Hide or Show has re-rendered it; null otherwise. */
  const focusAfter = useRef<"show" | "reveal" | null>(null);
  const showButton = useRef<HTMLButtonElement>(null);
  const hideButton = useRef<HTMLButtonElement>(null);
  const toggleButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const wanted = focusAfter.current;
    if (wanted === null) return;
    focusAfter.current = null;
    // After Show, the Hide button — or, on a finished path, which offers none, its Show lessons.
    const target = wanted === "show" ? showButton.current : (hideButton.current ?? toggleButton.current);
    target?.focus();
  }, [hidden]);

  if (hidden) {
    return (
      <section
        className="tutorial-path-hidden"
        data-testid={tutorialTestid.hidden}
        data-complete={allDone ? "true" : "false"}
        aria-labelledby={headingId}
      >
        <p className="tutorial-path-hidden__text">
          <span className="tutorial-path-hidden__title" id={headingId}>
            Tutorial hidden
          </span>
          <span className="tutorial-path-hidden__progress">
            {done} of {total} lessons complete
          </span>
        </p>
        <button
          ref={showButton}
          type="button"
          className="tutorial-path-hidden__show"
          data-testid={tutorialTestid.show}
          onClick={() => {
            focusAfter.current = "reveal";
            setTutorialHidden(false);
          }}
        >
          Show tutorial
        </button>
      </section>
    );
  }

  return (
    <section
      className="tutorial-path"
      data-testid={tutorialTestid.path}
      data-complete={allDone ? "true" : "false"}
      aria-labelledby={headingId}
    >
      <div className="tutorial-path__head">
        <div className="tutorial-path__heading">
          <p className="tutorial-path__eyebrow">{allDone ? "Tutorial complete" : "New to JackiOh?"}</p>
          <h2 className="tutorial-path__title" id={headingId}>
            Learn to play
          </h2>
          <p className="tutorial-path__intro">
            {allDone
              ? "Every lesson is done. Replay any of them whenever you like."
              : "Short guided games against a gentle AI. Finish one to open the next."}
          </p>
        </div>
        <div className="tutorial-path__summary">
          <p className="tutorial-path__progress">
            <span className="tutorial-path__meter" aria-hidden="true">
              {TUTORIAL_LESSONS.map((lesson) => (
                <i key={lesson.id} data-done={lessonStatus(progress, lesson) === "completed" ? "true" : "false"} />
              ))}
            </span>
            {done} of {total} lessons complete
          </p>
          {next !== undefined && done > 0 ? (
            <button
              type="button"
              className="tutorial-path__continue"
              data-testid={tutorialTestid.continue}
              onClick={() => {
                onStart(next);
              }}
            >
              Continue: Lesson {next.number}
            </button>
          ) : null}
          {!allDone ? (
            <button
              ref={hideButton}
              type="button"
              className="tutorial-path__toggle tutorial-path__hide"
              data-testid={tutorialTestid.hide}
              onClick={() => {
                focusAfter.current = "show";
                setTutorialHidden(true);
              }}
            >
              Hide tutorial
            </button>
          ) : null}
          {allDone ? (
            <button
              ref={toggleButton}
              type="button"
              className="tutorial-path__toggle"
              data-testid={tutorialTestid.pathToggle}
              aria-expanded={open}
              aria-controls={listId}
              onClick={() => {
                setOpenChoice(!open);
              }}
            >
              {open ? "Hide lessons" : "Show lessons"}
            </button>
          ) : null}
        </div>
      </div>
      <ol className="tutorial-path__lessons" id={listId} hidden={!open}>
        {TUTORIAL_LESSONS.map((lesson) => (
          <LessonNode
            key={lesson.id}
            lesson={lesson}
            status={lessonStatus(progress, lesson)}
            isNext={next?.id === lesson.id}
            onStart={onStart}
          />
        ))}
      </ol>
    </section>
  );
}
