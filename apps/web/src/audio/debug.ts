// `window.__jackiohAudio`: a read-only window onto the audio engine for Cypress (spec 15), outside
// production builds only, like `window.__jackioh`. It reports what the engine accepted, never what
// the speakers did, because a headless browser has no output device.

import type { AudioEngine, AudioState, PlayedCue } from "./types.ts";

export type AudioDebugHandle = {
  state(): AudioState;
  log(): readonly PlayedCue[];
  clearLog(): void;
  contextsCreated(): number;
};

declare global {
  interface Window {
    /** Outside production builds only (like window.__jackioh). */
    __jackiohAudio?: AudioDebugHandle;
  }
}

/** Sets window.__jackiohAudio when import.meta.env.MODE !== "production"; the remover deletes it if it is still ours. */
export function exposeAudioDebug(engine: AudioEngine): () => void {
  if (import.meta.env.MODE === "production") return () => {};
  const handle: AudioDebugHandle = {
    state: () => engine.state(),
    log: () => engine.log(),
    clearLog: () => {
      engine.clearLog();
    },
    contextsCreated: () => engine.contextsCreated(),
  };
  window.__jackiohAudio = handle;
  return () => {
    if (window.__jackiohAudio === handle) delete window.__jackiohAudio;
  };
}
