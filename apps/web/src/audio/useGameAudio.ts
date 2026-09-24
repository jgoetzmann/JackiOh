// The one hook `Game` calls for sound (SPEC §10.11). It feeds the director every view, tells it
// (and the engine) when the animation runner starts an entry or goes idle, installs the gesture
// unlock, the UI ticks and the debug handle for the component's lifetime, and preloads the voice
// lines the view makes likely.
//
// ORDER MATTERS. `Game` calls this directly after `const runner = queue.current;`, before its own
// layout effects, so the director's `onView` runs before Game's enqueue layout effect: the events
// of a view are owed by the time the runner starts their first entry, and a reduced-motion burst
// (which drains inside `enqueue`) is flushed with the view that carried it.
//
// It never throws. With no AudioContext (jsdom) every call inside it is a no-op, and a failure in
// the sound path is swallowed rather than taking the board down with it.

import { useContext, useEffect, useLayoutEffect, useRef } from "react";

import type { PlayerView } from "@jackioh/shared";

import type { AnimationQueue } from "../game/animations.ts";
import { CatalogContext, type CardLookup } from "../game/catalog.ts";
import type { CueCard } from "./cues.ts";
import { retainAppAudio } from "./appAudio.ts";
import { exposeAudioDebug } from "./debug.ts";
import { createSoundDirector, type SoundDirector } from "./director.ts";
import { getAudioEngine } from "./engine.ts";
import { VOICE_LINES, voiceKeysForView } from "./voiceData.ts";

function quietly(run: () => void): void {
  try {
    run();
  } catch {
    // Sound is never a rule and never worth an error boundary: drop the cue, keep the game.
  }
}

/** The catalog facts a cue may use, from the board's lookup (base face; "hidden" never reaches it). */
function cueCard(lookup: CardLookup | null, defId: string): CueCard | undefined {
  const info = lookup?.(defId, false);
  if (info === undefined) return undefined;
  return info.rarity === undefined
    ? { type: info.type, tags: info.tags }
    : { type: info.type, tags: info.tags, rarity: info.rarity };
}

export function useGameAudio(runner: AnimationQueue, view: PlayerView): void {
  // 0. The public catalog the board renders with (routes put `CatalogContext` above Game), read
  //    through a ref so the director made once still sees a catalog that arrives later.
  const lookup = useContext(CatalogContext);
  const lookupRef = useRef(lookup);
  lookupRef.current = lookup;

  // 1. The director, created once per mounted Game against the singleton engine.
  const directorRef = useRef<SoundDirector | null>(null);
  directorRef.current ??= createSoundDirector(getAudioEngine(), VOICE_LINES, (defId) => cueCard(lookupRef.current, defId));
  const director = directorRef.current;

  // 2. Every view, before Game's enqueue layout effect sees it.
  useLayoutEffect(() => {
    quietly(() => director.onView(view));
  }, [director, view]);

  // 3. Entry starts and idles, straight from the runner's notifications. The engine is busy while
  //    an entry is in flight, so no background voice work competes with the runner's timers (B58):
  //    busy before the entry's cues, free after the idle flush's, so a line the flush asks for is
  //    fetched ahead of the held preload and the prefetch. A Game unmounted mid-burst frees it.
  useLayoutEffect(() => {
    const engine = getAudioEngine();
    let last = runner.inFlight();
    quietly(() => engine.setBusy(last !== null));
    const stop = runner.subscribe(() => {
      const entry = runner.inFlight();
      if (entry !== null) {
        quietly(() => engine.setBusy(true));
        if (entry !== last) quietly(() => director.onEntryStart(entry));
      } else {
        quietly(() => director.onIdle());
        quietly(() => engine.setBusy(false));
      }
      last = entry;
    });
    return () => {
      stop();
      quietly(() => engine.setBusy(false));
    };
  }, [director, runner]);

  // 4. After every layout effect: covers a view that produced no entry the runner could start.
  useEffect(() => {
    if (runner.idle()) quietly(() => director.onIdle());
  }, [director, view, runner]);

  // 5. Gesture unlock and UI ticks (shared with the app root, appAudio.ts) and the debug handle,
  //    for the component's lifetime.
  useEffect(() => {
    const engine = getAudioEngine();
    const removers = [retainAppAudio(), exposeAudioDebug(engine)];
    return () => {
      for (const remove of removers) remove();
    };
  }, []);

  // 6. Preload the lines this view makes likely, once the context runs. A view that starts a burst
  //    reaches here with the engine already busy, so the engine holds it until the burst is over.
  useEffect(() => {
    quietly(() => {
      const engine = getAudioEngine();
      if (engine.state() === "running") engine.preloadVoices(voiceKeysForView(view, VOICE_LINES));
    });
  }, [view]);
}
