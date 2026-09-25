// "Concede this game?": what the board's Concede control opens, in every mode (hotseat, online and
// practice all mount it through Game.tsx). A concede ends the game at once and cannot be taken
// back, and the control sits in the control bar beside End turn and Offer draw, one stray tap away,
// so it asks first. Only "Concede" sends the action; "Keep playing" is the default — it takes the
// focus, and Escape or a click outside the panel means the same.
//
// It decides nothing (CLAUDE.md rule 7): the caller dispatches `{ type: "concede" }` and the engine
// rules on it, as it rules on every other action.
//
// Accessibility: an `alertdialog`, modal, labelled by its question and described by its line of
// consequence. The focus moves in on open (to "Keep playing"), Tab and Shift+Tab stay between the
// two buttons, and the caller puts the focus back on the Concede control once it closes.

import { useEffect, useId, useRef, type KeyboardEvent, type ReactElement } from "react";

import { testid } from "./contract.ts";
import "./notices.css";

export type ConfirmConcedeProps = {
  /** "Concede": send the concede. */
  onConfirm(): void;
  /** "Keep playing", Escape or a click outside the panel. */
  onCancel(): void;
};

export const CONCEDE_TITLE = "Concede this game?";
export const CONCEDE_BODY = "Your opponent wins and the game ends here.";

export default function ConfirmConcede({ onConfirm, onCancel }: ConfirmConcedeProps): ReactElement {
  const titleId = useId();
  const bodyId = useId();
  const stay = useRef<HTMLButtonElement>(null);
  const concede = useRef<HTMLButtonElement>(null);

  // The safe choice has the focus from the start, so an Enter or a Space that was meant for
  // something else keeps the game going.
  useEffect(() => {
    stay.current?.focus({ preventScroll: true });
  }, []);

  // Escape anywhere means stay, even when a click on the scrim has taken the focus out of the panel.
  useEffect(() => {
    function onKey(event: globalThis.KeyboardEvent): void {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    }
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
    };
  }, [onCancel]);

  /** Tab and Shift+Tab go round the two buttons and never leave the dialog. */
  function trapTab(event: KeyboardEvent<HTMLElement>): void {
    if (event.key !== "Tab") return;
    const order = [stay.current, concede.current].filter((el): el is HTMLButtonElement => el !== null);
    if (order.length === 0) return;
    const at = order.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.shiftKey ? (at <= 0 ? order.length - 1 : at - 1) : at === order.length - 1 ? 0 : at + 1;
    event.preventDefault();
    order[next]?.focus();
  }

  return (
    <div
      className="concede-scrim"
      onClick={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <section
        className="concede-dialog"
        data-testid={testid.concedeDialog}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        onKeyDown={trapTab}
      >
        <h2 className="concede-dialog__title" id={titleId}>
          {CONCEDE_TITLE}
        </h2>
        <p className="concede-dialog__body" id={bodyId}>
          {CONCEDE_BODY}
        </p>
        <div className="concede-dialog__actions">
          <button
            ref={stay}
            type="button"
            className="concede-dialog__stay"
            data-testid={testid.concedeCancel}
            onClick={onCancel}
          >
            Keep playing
          </button>
          <button
            ref={concede}
            type="button"
            className="concede-dialog__concede"
            data-testid={testid.concedeConfirm}
            onClick={onConfirm}
          >
            Concede
          </button>
        </div>
      </section>
    </div>
  );
}
