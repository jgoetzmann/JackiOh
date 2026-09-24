// The autoplay unlock (docs/polish/2-sound.md, "unlock.ts"; B2).
//
// Browsers keep Web Audio silent until a user gesture, and iOS wants the context resumed and a
// sound started inside that gesture. The HTML standard's activation-triggering events are
// keydown, mousedown, pointerdown (mouse only), pointerup (non-mouse) and touchend, so a touch
// pointerdown alone does not unlock iOS; listening to all of these covers every platform. The
// listeners stay for the hook's lifetime because iOS can suspend the context again after a call
// or a backgrounding, and the next tap has to resume it.

import type { AudioEngine } from "./types.ts";

export const UNLOCK_EVENTS = ["pointerdown", "pointerup", "touchend", "click", "keydown"] as const;

/** Adds one capture-phase, passive listener per UNLOCK_EVENTS entry on window; each calls
 *  engine.unlock() synchronously when engine.state() is neither "running" nor "unsupported".
 *  Returns the remover. Listeners stay for the hook's lifetime (iOS can re-suspend). */
export function installAudioUnlock(engine: Pick<AudioEngine, "unlock" | "state">): () => void {
  const onGesture = (): void => {
    try {
      const state = engine.state();
      if (state !== "running" && state !== "unsupported") engine.unlock();
    } catch {
      // Sound must never break input handling.
    }
  };

  for (const type of UNLOCK_EVENTS) window.addEventListener(type, onGesture, { capture: true, passive: true });
  return () => {
    for (const type of UNLOCK_EVENTS) window.removeEventListener(type, onGesture, { capture: true });
  };
}
