// The card a drop has just played, while the board catches up (docs/polish/7-mobile-ux.md S9).
//
// A drop sends its `play` at once, but the board keeps showing the view from before it until the
// animation runner has played the play's events over that view (BUILD M5-T4, Game.tsx), roughly
// three quarters of a second. Without this the card went straight back into the fan for that time
// and only then appeared on the field, which read as a refused play. So DragLayer names the card
// here when a drop sends a play, draws it where it was dropped, and clears the name once the board
// shows a newer view. Hand.tsx reads the name to take that card out of the fan meanwhile.
//
// Module state, like the settings store, because DragLayer and Hand are siblings under Game and
// neither owns the other. It is view state only: nothing here is sent or decides a rule.

import { useSyncExternalStore } from "react";

let landing: string | null = null;
const listeners = new Set<() => void>();

/** The instance id of the card a drop has just played, or null. */
export function currentLanding(): string | null {
  return landing;
}

/** Name the card a drop has just played, or clear it with null. Notifies only on a change. */
export function setLanding(instanceId: string | null): void {
  if (landing === instanceId) return;
  landing = instanceId;
  for (const listener of [...listeners]) listener();
}

export function subscribeLanding(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The card a drop has just played, re-rendering the caller when it changes. */
export function useLanding(): string | null {
  return useSyncExternalStore(subscribeLanding, currentLanding, currentLanding);
}
