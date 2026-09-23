// The integration seam for settings other tasks own (docs/polish/7-mobile-ux.md S8).
//
// Task 1 keeps its effects speed and intensity in `apps/web/src/fx/settings.ts` and task 2 its
// audio controls in `apps/web/src/audio/settings.ts`. Neither exists on this branch, so the list
// is empty here; the integration branch appends one slot per control and the panel renders each
// after the built-in switches of its section. A section with no switches and no slots is not
// rendered at all, which is why `audio` does not appear until task 2's slot arrives.

import type { ReactNode } from "react";

export type SettingsSectionId = "gameplay" | "visuals" | "audio";

export type SettingsSlot = {
  section: SettingsSectionId;
  /** Unique within the list: the React key and the slot wrapper's `data-settings-slot`. */
  id: string;
  render: () => ReactNode;
};

/** Empty on this branch. Integration appends task 1's fx speed and intensity (visuals) and task 2's audio controls (audio). */
export const SETTINGS_SLOTS: readonly SettingsSlot[] = [];
