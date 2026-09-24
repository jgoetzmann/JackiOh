// The page-wide half of sound (SPEC §10.11; B52): the gesture unlock and the UI click and hover
// ticks, installed once on the document for as long as anything holds them.
//
// Two holders exist. `main.tsx` takes one for the page's lifetime, so the landing page, the deck
// builder and the lobby tick like the board does, and the first tap anywhere unlocks the context
// before a game has even started. Every mounted `Game` takes one too (`useGameAudio`), so a Game
// rendered on its own (a unit test, the component harness) still unlocks and ticks. However many
// hold it, there is one set of listeners, so a click never ticks twice.
//
// The listeners find the engine through `getAudioEngine()` on every event rather than capturing
// one, so a test that swaps the singleton (`setAudioEngineForTests`) is heard.

import { getAudioEngine } from "./engine.ts";
import type { SfxId, SfxParams } from "./types.ts";
import { installUiSounds } from "./uiSounds.ts";
import { installAudioUnlock } from "./unlock.ts";

let holders = 0;
let remove: (() => void) | null = null;

function install(): () => void {
  const removeUnlock = installAudioUnlock({
    unlock: () => getAudioEngine().unlock(),
    state: () => getAudioEngine().state(),
  });
  const removeTicks = installUiSounds(
    { playSfx: (id: SfxId, params?: SfxParams, delayMs?: number) => getAudioEngine().playSfx(id, params, delayMs) },
    document,
  );
  return () => {
    removeUnlock();
    removeTicks();
  };
}

/** Holds the page-wide listeners, installing them for the first holder; returns the release. */
export function retainAppAudio(): () => void {
  holders += 1;
  remove ??= install();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holders -= 1;
    if (holders === 0 && remove !== null) {
      remove();
      remove = null;
    }
  };
}

/** How many holders there are (tests). */
export function appAudioHolders(): number {
  return holders;
}
