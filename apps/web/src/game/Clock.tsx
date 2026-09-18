// The match clock (BUILD M7-T1: `web/src/game/Clock.tsx`).
//
// PLACEHOLDER. The real component is owned by the clock task; this file exists so `match.tsx`
// can render it and typecheck. Replace the whole body, keep the default export and the props.

export type ClockProps = {
  /** `PlayerView.clockMs` for the viewer's own side, or null when no clock is running. */
  youMs: number | null;
  /** `PlayerView.clockMs` for the opponent. */
  opponentMs: number | null;
  /** Per-player disconnect grace remaining (§9.5), or null when nobody is away. */
  graceMs?: { you: number | null; opponent: number | null };
};

export default function Clock(_props: ClockProps) {
  return null;
}
