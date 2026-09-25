// The settings dialog (docs/polish/7-mobile-ux.md S8, B23–B24): a centred modal on desktop and a
// bottom sheet on phones (settings.css). `SettingsButton` renders it through a portal while open;
// tests and integration can also render it directly.
//
// Every switch reads the store and writes straight back to it, so there is no local draft and no
// "save": a change applies at once, including to a board rendered behind the scrim.

import {
  useEffect,
  useId,
  useRef,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
} from "react";

import { SETTINGS_SLOTS, type SettingsSectionId, type SettingsSlot } from "./slots.ts";
import {
  resetSettings,
  useSettings,
  writeSettings,
  type SettingKey,
  type Settings,
} from "./store.ts";
import "./settings.css";

export type SettingsPanelProps = {
  onClose: () => void;
  /** The controls other tasks mount. Defaults to `SETTINGS_SLOTS`. */
  slots?: readonly SettingsSlot[];
};

type SectionSpec = {
  id: SettingsSectionId;
  title: string;
  /** The built-in switches, rendered before the section's slots. */
  controls: readonly SettingKey[];
};

const SECTIONS: readonly SectionSpec[] = [
  { id: "gameplay", title: "Gameplay", controls: ["dragToPlay", "confirmEndTurn", "autoEndTurn", "hoverPreviews"] },
  { id: "visuals", title: "Visuals", controls: ["reduceMotion"] },
  { id: "audio", title: "Audio", controls: [] },
];

/** The label is the switch's whole accessible name; the hint is its description. */
const CONTROLS: Readonly<Record<SettingKey, { label: string; hint: string }>> = {
  dragToPlay: {
    label: "Drag to play",
    hint: "Drag a card onto the board, or a unit onto an enemy. Off: tap to select, then choose.",
  },
  confirmEndTurn: {
    label: "Confirm end turn",
    hint: "Ask again before ending the turn while you can still play or attack.",
  },
  autoEndTurn: {
    label: "End turn automatically",
    hint: "End your turn by itself when there is nothing left to play or attack with. Off: press End turn yourself.",
  },
  // One switch for both hover behaviours: task 7's hand lift and task 6's enlarged preview, which
  // opens only while this is on (cards/inspect/useInspectTrigger.tsx).
  hoverPreviews: {
    label: "Hover previews",
    hint: "Lift a card in your hand, and show any card enlarged, when the mouse rests on it.",
  },
  reduceMotion: {
    label: "Reduce motion",
    hint: "Turn animations off, whatever your system setting says.",
  },
};

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

function SettingSwitch({ setting, checked }: { setting: SettingKey; checked: boolean }): ReactElement {
  const hintId = useId();
  const { label, hint } = CONTROLS[setting];
  return (
    <div className="settings-row">
      <label className="settings-control">
        <span className="settings-label">{label}</span>
        <input
          type="checkbox"
          role="switch"
          className="settings-switch"
          data-testid={`setting-${setting}`}
          checked={checked}
          aria-describedby={hintId}
          onChange={(event) => {
            const patch: Partial<Settings> = {};
            patch[setting] = event.currentTarget.checked;
            writeSettings(patch);
          }}
        />
      </label>
      <p className="settings-hint" id={hintId}>
        {hint}
      </p>
    </div>
  );
}

export default function SettingsPanel({
  onClose,
  slots = SETTINGS_SLOTS,
}: SettingsPanelProps): ReactElement {
  const settings = useSettings();
  const panelRef = useRef<HTMLDivElement>(null);

  // Focus the first switch on open, so a keyboard or screen-reader user lands inside the dialog.
  useEffect(() => {
    const panel = panelRef.current;
    if (panel === null) return;
    const first = panel.querySelector<HTMLElement>('input[role="switch"]') ?? panel;
    first.focus({ preventScroll: true });
  }, []);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Escape") {
      // Stopped so the board's own Escape (cancel a selection or a drag) does not also fire.
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    // aria-modal: Tab and Shift+Tab cycle inside the dialog instead of walking off into the board.
    const panel = panelRef.current;
    if (panel === null) return;
    const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
    const first = items[0];
    const last = items[items.length - 1];
    if (first === undefined || last === undefined) return;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === panel)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      className="settings-scrim"
      data-testid="settings-scrim"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        className="settings-panel"
        data-testid="settings-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <header className="settings-head">
          <h1 className="settings-title">Settings</h1>
          <button
            type="button"
            className="settings-close"
            data-testid="settings-close"
            aria-label="Close settings"
            onClick={onClose}
          >
            <span aria-hidden="true">✕</span>
          </button>
        </header>
        <div className="settings-body">
          {SECTIONS.map((section) => {
            const sectionSlots = slots.filter((slot) => slot.section === section.id);
            if (section.controls.length === 0 && sectionSlots.length === 0) return null;
            return (
              <section
                key={section.id}
                className="settings-section"
                data-testid={`settings-section-${section.id}`}
              >
                <h2>{section.title}</h2>
                {section.controls.map((setting) => (
                  <SettingSwitch key={setting} setting={setting} checked={settings[setting]} />
                ))}
                {sectionSlots.map((slot) => (
                  <div key={slot.id} className="settings-slot" data-settings-slot={slot.id}>
                    {slot.render()}
                  </div>
                ))}
              </section>
            );
          })}
        </div>
        <footer className="settings-foot">
          <button
            type="button"
            className="settings-reset"
            data-testid="settings-reset"
            onClick={() => {
              resetSettings();
              // Every store the panel shows goes back to its defaults, not only this module's.
              for (const slot of slots) slot.reset?.();
            }}
          >
            Reset to defaults
          </button>
        </footer>
      </div>
    </div>
  );
}
