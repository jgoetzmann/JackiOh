// The board's game-over state (BUILD M5-T4 `gameOver`: "overlay text Win / Loss / Draw").
//
// It used to be a small box printing `result.reason` as the engine spells it ("hero-death",
// "concede") over an undimmed board, with no way on. Now the reason reads as a sentence from the
// viewer's side of the table, and the overlay comes in two forms:
//
//  - `panel`: a dimmed board and a panel in the middle of the screen with the outcome, why, and the
//    route's own ways on (`actions`: hotseat's Play again and Back, the match's Back to lobby),
//    plus "View the board", which folds it to the chip;
//  - `chip`: one line at the foot of the screen, over nothing that matters once the game is done,
//    with "Result" to open the panel again. Practice asks for this form from the start, because
//    its own result dialog (PracticeResult) is the panel there.
//
// Both wait for the effects layer's Victory / Defeat sequence (`revealMs`) instead of sitting under
// its word, and neither is a rule (CLAUDE.md rule 7): it reads `PlayerView.result` and nothing else.
// `data-reason` keeps the engine's own reason for tests and tools.

import { useEffect, useRef, useState, type CSSProperties, type ReactElement, type ReactNode } from "react";

import type { GameOverReason, PlayerId, PlayerView } from "@jackioh/shared";

import { prefersReducedMotion } from "./animations.ts";
import { testid } from "./contract.ts";
import { FX_LETHAL_LEAD_MAX_MS, FX_RESULT_MS } from "../fx/constants.ts";
import { getFxSettings } from "../fx/settings.ts";
import { readSettings } from "../settings/index.ts";

type Result = NonNullable<PlayerView["result"]>;

export type ResultOutcome = "win" | "loss" | "draw";
export type ResultForm = "panel" | "chip";

export function outcomeFor(result: Result, viewer: PlayerId): ResultOutcome {
  if (result.winner === "draw") return "draw";
  return result.winner === viewer ? "win" : "loss";
}

/** BUILD M5-T4's overlay words, which e2e reads (`cy.expectResult`). */
export const RESULT_WORD: Readonly<Record<ResultOutcome, string>> = { win: "Win", loss: "Loss", draw: "Draw" };

/** Why the game ended, as the viewer would say it. Every `GameOverReason` has a sentence. */
export function resultReason(outcome: ResultOutcome, reason: GameOverReason): string {
  switch (reason) {
    case "hero-death":
      return outcome === "win" ? "The opposing hero has fallen." : "Your hero has fallen.";
    case "both-heroes-dead":
      return "Both heroes fell together.";
    case "concede":
      return outcome === "win" ? "Your opponent conceded." : "You conceded.";
    case "draw-accepted":
      return "Game drawn by agreement.";
    case "turn-cap":
      return "The turn limit was reached.";
    case "disconnect":
      return outcome === "win" ? "Your opponent left the match." : "You left the match.";
    case "match-ceiling":
      return "The match reached its time limit.";
  }
}

/**
 * How long the result waits: the effects layer replays the killing blow in at most
 * FX_LETHAL_LEAD_MAX_MS and then plays Victory / Defeat in FX_RESULT_MS. With no effects to watch
 * (reduced motion, the setting or the OS's, or effects off) it shows at once.
 */
export function resultRevealMs(): number {
  let reduced = prefersReducedMotion();
  try {
    reduced ||= readSettings().reduceMotion;
  } catch {
    // Unreadable settings are the defaults: motion on.
  }
  if (reduced || getFxSettings().intensity === "off") return 0;
  return FX_LETHAL_LEAD_MAX_MS + FX_RESULT_MS;
}

type GameResultProps = {
  result: Result;
  viewer: PlayerId;
  form: ResultForm;
  /** The route's ways on, shown in the panel form. */
  actions?: ReactNode;
  /** The animation-runner marker the overlay has always carried (BUILD M5-T4). */
  animating?: string;
};

export function GameResult({ result, viewer, form, actions, animating }: GameResultProps): ReactElement {
  const outcome = outcomeFor(result, viewer);
  // The panel folds to the chip ("View the board") and opens again ("Result"). Only the first
  // appearance waits for the effects layer; a fold or an unfold is immediate.
  const [open, setOpen] = useState(form === "panel");
  const [toggled, setToggled] = useState(false);
  const [revealMs] = useState(resultRevealMs);
  // Until it has come in, it is transparent and takes no pointer, so nothing under it is blocked.
  const [revealed, setRevealed] = useState(revealMs === 0);
  useEffect(() => {
    if (revealed) return undefined;
    const timer = window.setTimeout(() => {
      setRevealed(true);
    }, revealMs);
    return () => {
      window.clearTimeout(timer);
    };
  }, [revealed, revealMs]);
  const shownForm: ResultForm = form === "panel" && open ? "panel" : "chip";
  const delay: CSSProperties | undefined =
    toggled || revealMs === 0 ? undefined : { animationDelay: `${String(revealMs)}ms` };
  const revealedAttr = revealed ? "true" : "false";

  // The panel takes focus as it comes in (and again when "Result" reopens it), on its first way on,
  // as PracticeResult does with Play again: a keyboard is where the next move is.
  const firstAction = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (shownForm !== "panel" || !revealed) return;
    firstAction.current?.querySelector<HTMLElement>("button, a")?.focus({ preventScroll: true });
  }, [shownForm, revealed]);

  return (
    <>
      {shownForm === "panel" ? (
        <div className="result-scrim" style={delay} aria-hidden="true" />
      ) : null}
      <div
        className="result-overlay"
        data-testid={testid.result}
        data-animating={animating}
        data-form={shownForm}
        data-outcome={outcome}
        data-reason={result.reason}
        data-revealed={revealedAttr}
        role="status"
        style={delay}
      >
        <strong className="result-overlay__word">{RESULT_WORD[outcome]}</strong>
        <span className="result-overlay__reason">{resultReason(outcome, result.reason)}</span>
        {shownForm === "panel" ? (
          <div className="result-overlay__actions" ref={firstAction}>
            {actions}
            <button
              type="button"
              className="result-overlay__view"
              data-testid="result-view-board"
              onClick={() => {
                setToggled(true);
                setOpen(false);
              }}
            >
              View the board
            </button>
          </div>
        ) : form === "panel" ? (
          <button
            type="button"
            className="result-overlay__reopen"
            data-testid="result-reopen"
            onClick={() => {
              setToggled(true);
              setOpen(true);
            }}
          >
            Result
          </button>
        ) : null}
      </div>
    </>
  );
}
