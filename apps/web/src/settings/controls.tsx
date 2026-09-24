// The panel's controls for the stores tasks 1 and 6 own (slots.ts mounts them). Each reads its own
// store and writes straight back, like the built-in switches, so a change applies at once: the
// animation runner reads the effects speed at every enqueue (R201), the effects layer re-renders on
// the intensity, and every card face on the foil switch.

import { useId, type ReactElement } from "react";

import { CARD_SETTINGS_FIELDS, useCardSettings, writeCardSettings } from "../cards/settings.ts";
import { FX_SPEED_STEPS } from "../fx/constants.ts";
import { useFxSettings, type FxIntensity } from "../fx/settings.ts";

/** Every intensity the effects layer knows, in the order the picker lists them. */
const INTENSITIES: readonly { value: FxIntensity; label: string }[] = [
  { value: "off", label: "Off" },
  { value: "low", label: "Low" },
  { value: "normal", label: "Normal" },
  { value: "high", label: "High" },
];

function speedLabel(speed: number): string {
  return `${String(speed)}×`;
}

/** A labelled native select: the platform's own picker on a phone, a 44 px row everywhere. */
function SelectRow(props: {
  label: string;
  hint: string;
  testId: string;
  value: string;
  options: readonly { value: string; label: string }[];
  onChange: (value: string) => void;
}): ReactElement {
  const id = useId();
  return (
    <div className="settings-row">
      <label className="settings-control" htmlFor={`${id}-select`}>
        <span className="settings-label">{props.label}</span>
        <select
          id={`${id}-select`}
          className="settings-select"
          data-testid={props.testId}
          value={props.value}
          aria-describedby={`${id}-hint`}
          onChange={(event) => {
            props.onChange(event.currentTarget.value);
          }}
        >
          {props.options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      <p className="settings-hint" id={`${id}-hint`}>
        {props.hint}
      </p>
    </div>
  );
}

/** Task 1's effects speed (R201) and intensity. */
export function FxControls(): ReactElement {
  const [settings, set] = useFxSettings();
  // A stored speed off the steps (a hand-edited value, still inside R201's range) is listed too,
  // so the select never shows a value it does not hold.
  const steps: readonly number[] = FX_SPEED_STEPS.includes(settings.speed as (typeof FX_SPEED_STEPS)[number])
    ? FX_SPEED_STEPS
    : [...FX_SPEED_STEPS, settings.speed].sort((a, b) => a - b);
  return (
    <>
      <SelectRow
        label="Effects speed"
        hint="How fast cards move, hit and die. Faster also shortens the pauses between them."
        testId="setting-fxSpeed"
        value={String(settings.speed)}
        options={steps.map((speed) => ({ value: String(speed), label: speedLabel(speed) }))}
        onChange={(value) => {
          set({ speed: Number(value) });
        }}
      />
      <SelectRow
        label="Effects intensity"
        hint="Fire, sparks, light rays and the board shake. Off keeps the card motion only."
        testId="setting-fxIntensity"
        value={settings.intensity}
        options={INTENSITIES}
        onChange={(value) => {
          const next = INTENSITIES.find((option) => option.value === value);
          if (next !== undefined) set({ intensity: next.value });
        }}
      />
    </>
  );
}

/** Task 6's words for its foil switch (cards/settings.ts), so the panel and the module agree. */
const FOIL_FIELD = CARD_SETTINGS_FIELDS.find((field) => field.key === "animatedFoil");

/** Task 6's animated foil on Mythic and Radiant faces. */
export function AnimatedFoilSwitch(): ReactElement {
  const settings = useCardSettings();
  const hintId = useId();
  return (
    <div className="settings-row">
      <label className="settings-control">
        <span className="settings-label">{FOIL_FIELD?.label ?? "Animated foil"}</span>
        <input
          type="checkbox"
          role="switch"
          className="settings-switch"
          data-testid="setting-animatedFoil"
          checked={settings.animatedFoil}
          aria-describedby={hintId}
          onChange={(event) => {
            writeCardSettings({ animatedFoil: event.currentTarget.checked });
          }}
        />
      </label>
      <p className="settings-hint" id={hintId}>
        {FOIL_FIELD?.description}
      </p>
    </div>
  );
}
