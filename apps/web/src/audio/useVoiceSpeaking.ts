// Whether a voice line is holding the voice channel right now (the engine's `speaking()`), for the
// page's `data-speaking` mark: `Game` puts it on its root, and practice holds the AI's next step
// while any element carries it (SPEC §9.9, routes/practice.tsx `useVoiceHold`), so the AI never
// plays over a card that is still talking.

import { useSyncExternalStore } from "react";

import { getAudioEngine } from "./engine.ts";

const never = (): boolean => false;

export function useVoiceSpeaking(): boolean {
  const engine = getAudioEngine();
  return useSyncExternalStore(engine.subscribeSpeaking, engine.speaking, never);
}
