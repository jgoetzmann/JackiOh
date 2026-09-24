// "AI is thinking…": shown while the controller is pacing the AI's actions (SPEC §9.9). It renders
// nothing at all otherwise, so `practice-thinking` exists exactly while the AI owes an action.
//
// The orb is decoration (aria-hidden); the status text is the whole accessible content, so a
// screen reader hears "AI is thinking…" and nothing else.

import type { ReactElement } from "react";

import { practiceTestid } from "./testids.ts";
import "./practice.css";

type ThinkIndicatorProps = { thinking: boolean };

export function ThinkIndicator({ thinking }: ThinkIndicatorProps): ReactElement | null {
  if (!thinking) return null;
  return (
    <span className="practice-thinking" data-testid={practiceTestid.thinking} role="status">
      <span className="practice-thinking__orb" aria-hidden="true">
        <span className="practice-thinking__core" />
      </span>
      <span className="practice-thinking__text">AI is thinking…</span>
    </span>
  );
}
