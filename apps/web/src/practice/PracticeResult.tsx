// The end of a practice game: Victory, Defeat or Draw, why, and what to do next (SPEC §9.9).
//
// It reads only the human's `PlayerView` result (CLAUDE.md rule 7), and it is the practice route's
// own screen: `Game.tsx`'s `result-overlay` still renders underneath, unchanged, for every other
// consumer of the board. "View the board" closes the dialog so the final position can be read; the
// HUD's outcome chip opens it again.

import { useEffect, useId, useRef, type CSSProperties, type ReactElement } from "react";

import type { Difficulty } from "@jackioh/engine/config";
import type { GameOverReason, PlayerId, PlayerView } from "@jackioh/shared";

import { PRACTICE_RESULT_PARTICLES } from "./config.ts";
import { practiceTestid } from "./testids.ts";
import { DIFFICULTY_LABEL, TierCrest } from "./Tier.tsx";
import "./practice.css";

export type PracticeOutcome = "win" | "loss" | "draw";

type Result = NonNullable<PlayerView["result"]>;

export function outcomeOf(result: Result, viewer: PlayerId): PracticeOutcome {
  if (result.winner === "draw") return "draw";
  return result.winner === viewer ? "win" : "loss";
}

export const OUTCOME_TITLE: Readonly<Record<PracticeOutcome, string>> = {
  win: "Victory",
  loss: "Defeat",
  draw: "Draw",
};

/** Why the game ended, from the human's side of the table. */
function reasonText(outcome: PracticeOutcome, reason: GameOverReason): string {
  switch (reason) {
    case "hero-death":
      return outcome === "win" ? "The AI's hero has fallen." : "Your hero has fallen.";
    case "both-heroes-dead":
      return "Both heroes fell together.";
    case "concede":
      return outcome === "win" ? "The AI conceded." : "You conceded.";
    case "turn-cap":
      return "The turn limit was reached.";
    case "draw-accepted":
      return "A draw was agreed.";
    case "disconnect":
    case "match-ceiling":
      return "The game has ended.";
  }
}

type PracticeResultProps = {
  result: Result;
  viewer: PlayerId;
  difficulty: Difficulty;
  onPlayAgain(): void;
  onChangeSetup(): void;
  onViewBoard(): void;
};

export function PracticeResult({
  result,
  viewer,
  difficulty,
  onPlayAgain,
  onChangeSetup,
  onViewBoard,
}: PracticeResultProps): ReactElement {
  const outcome = outcomeOf(result, viewer);
  const titleId = useId();
  const playAgain = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    playAgain.current?.focus();
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

  return (
    <div className="practice-result-scrim" data-outcome={outcome}>
      <section
        className="practice-result"
        data-testid={practiceTestid.result}
        data-outcome={outcome}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className="practice-result__emblem" aria-hidden="true">
          <span className="practice-result__rays" />
          {/* Sparks burst from the crest on a Victory; embers drift off it on a Defeat. Each particle
              reads its index as `--i`, and practice.css spreads them round the circle. */}
          {outcome === "draw" ? null : (
            <span className="practice-result__particles">
              {Array.from({ length: PRACTICE_RESULT_PARTICLES }, (_unused, index) => (
                <i key={index} style={{ "--i": index, "--n": PRACTICE_RESULT_PARTICLES } as CSSProperties} />
              ))}
            </span>
          )}
          <TierCrest tier={difficulty} size="lg" />
        </div>
        <h2 className="practice-result__title" id={titleId}>
          {OUTCOME_TITLE[outcome]}
        </h2>
        <p className="practice-result__reason">{reasonText(outcome, result.reason)}</p>
        <p className="practice-result__meta">Practice · {DIFFICULTY_LABEL[difficulty]}</p>
        <div className="practice-result__actions">
          <button
            ref={playAgain}
            type="button"
            className="practice-play"
            data-testid={practiceTestid.playAgain}
            onClick={onPlayAgain}
          >
            Play again
          </button>
          <button
            type="button"
            className="practice-result__secondary"
            data-testid={practiceTestid.changeSetup}
            onClick={onChangeSetup}
          >
            Change setup
          </button>
        </div>
        <button type="button" className="link-button practice-result__view" data-testid={practiceTestid.viewBoard} onClick={onViewBoard}>
          View the board
        </button>
      </section>
    </div>
  );
}
