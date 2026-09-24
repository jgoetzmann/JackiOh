// "Leave this game?": what "New game" and "Menu" ask while a practice game is still being played.
//
// A game against the AI costs nothing to abandon, but it is still minutes of play one stray tap
// from gone, and "New game" sits in the HUD beside the board. Staying is the default: it has the
// focus, and Escape or a click outside the panel means stay.

import { useEffect, useId, useRef, type ReactElement } from "react";

import { practiceTestid } from "./testids.ts";
import "./practice.css";

/** Where leaving goes: back to the setup ("New game") or out to the main menu ("Menu"). */
export type PracticeLeaveTo = "setup" | "menu";

type PracticeLeaveProps = {
  to: PracticeLeaveTo;
  onStay(): void;
  onLeave(): void;
};

const LEAVE_BODY: Record<PracticeLeaveTo, string> = {
  setup: "It ends here and you go back to choosing a difficulty and a deck.",
  menu: "It ends here and you go back to the main menu.",
};

export function PracticeLeave({ to, onStay, onLeave }: PracticeLeaveProps): ReactElement {
  const titleId = useId();
  const stay = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    stay.current?.focus();
  }, []);

  useEffect(() => {
    function onKey(event: KeyboardEvent): void {
      if (event.key === "Escape") onStay();
    }
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [onStay]);

  return (
    <div
      className="practice-leave-scrim"
      onClick={(event) => {
        if (event.target === event.currentTarget) onStay();
      }}
    >
      <section
        className="practice-leave"
        data-testid={practiceTestid.leave}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <h2 className="practice-leave__title" id={titleId}>
          Leave this game?
        </h2>
        <p className="practice-leave__body">{LEAVE_BODY[to]}</p>
        <div className="practice-leave__actions">
          <button
            ref={stay}
            type="button"
            className="practice-play"
            data-testid={practiceTestid.leaveStay}
            onClick={onStay}
          >
            Keep playing
          </button>
          <button
            type="button"
            className="practice-result__secondary"
            data-testid={practiceTestid.leaveConfirm}
            onClick={onLeave}
          >
            Leave game
          </button>
        </div>
      </section>
    </div>
  );
}
