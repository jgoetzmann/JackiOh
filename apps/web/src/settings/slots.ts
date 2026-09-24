// The integration seam for settings other tasks own (docs/polish/7-mobile-ux.md S8).
//
// Task 1 keeps its effects speed and intensity in `apps/web/src/fx/settings.ts`, task 2 its audio
// controls in `apps/web/src/audio/settings.ts` and task 6 its animated-foil switch in
// `apps/web/src/cards/settings.ts`. Each store stays where its task put it; this list mounts one
// control per store in the section it belongs to, and the panel renders each after the built-in
// switches of that section. A section with no switches and no slots is not rendered at all.
//
// Two settings are one switch each, not two. Task 6's store also has a `hoverPreviews`, and task 1's
// a `motion`, but the panel's own "Hover previews" and "Reduce motion" switches are the player's
// only handles on them: the hover preview opens only while both stores allow it
// (cards/inspect/useInspectTrigger.tsx), and every motion check reads the panel's switch beside the
// OS preference (game/animations.ts `reducedMotionNow`). So neither is mounted again here.

import { createElement, type ReactNode } from "react";

import AudioControls from "../audio/AudioControls.tsx";
import { DEFAULT_AUDIO_SETTINGS, writeAudioSettings } from "../audio/settings.ts";
import { CARD_SETTINGS_DEFAULTS, writeCardSettings } from "../cards/settings.ts";
import { DEFAULT_FX_SETTINGS, setFxSettings } from "../fx/settings.ts";
import { AnimatedFoilSwitch, FxControls } from "./controls.tsx";

export type SettingsSectionId = "gameplay" | "visuals" | "audio";

export type SettingsSlot = {
  section: SettingsSectionId;
  /** Unique within the list: the React key and the slot wrapper's `data-settings-slot`. */
  id: string;
  render: () => ReactNode;
  /** What the panel's "Reset to defaults" does to this slot's store. Absent: nothing. */
  reset?: () => void;
};

/** Task 1's effects speed and intensity, task 6's animated foil and task 2's audio controls. */
export const SETTINGS_SLOTS: readonly SettingsSlot[] = [
  {
    section: "visuals",
    id: "fx",
    render: () => createElement(FxControls),
    reset: () => {
      setFxSettings({ ...DEFAULT_FX_SETTINGS });
    },
  },
  {
    section: "visuals",
    id: "card-foil",
    render: () => createElement(AnimatedFoilSwitch),
    reset: () => {
      writeCardSettings({ ...CARD_SETTINGS_DEFAULTS });
    },
  },
  {
    section: "audio",
    id: "audio",
    render: () => createElement(AudioControls, { className: "settings-audio" }),
    reset: () => {
      writeAudioSettings({ ...DEFAULT_AUDIO_SETTINGS });
    },
  },
];
