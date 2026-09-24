// The audio module's public face (SPEC §10.11). `Game.tsx` imports the hook and the toggle from
// here, and task 7's settings panel imports `AudioControls` and the settings store.

export { useGameAudio } from "./useGameAudio.ts";
export { useVoiceSpeaking } from "./useVoiceSpeaking.ts";
export { default as AudioToggle } from "./AudioToggle.tsx";
export { default as AudioControls } from "./AudioControls.tsx";
export { getAudioEngine } from "./engine.ts";
export { DEFAULT_AUDIO_SETTINGS, readAudioSettings, subscribeAudioSettings, useAudioSettings, writeAudioSettings } from "./settings.ts";
export type { AudioSettings, AudioState, SfxId } from "./types.ts";
