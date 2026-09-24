// The full audio panel (SPEC §10.11 "Settings"): master, effects and voice volume, mute, and voice
// lines on or off. Task 7's settings panel mounts it at integration. Every control reads and writes
// the audio settings store, which is the only place these values live.
//
// A volume is set by ear (B54): moving the master or effects slider ticks at the new level (the
// engine's retrigger guard keeps a drag from rattling), and letting go of the voice slider speaks a
// sample line at the lowest priority, so it never talks over a card.

import { useId, type ChangeEvent, type ReactElement } from "react";

import { VOICE_PREVIEW_DEF_ID, VOICE_PRIORITY } from "./constants.ts";
import { getAudioEngine } from "./engine.ts";
import { useAudioSettings, writeAudioSettings } from "./settings.ts";
import type { AudioSettings } from "./types.ts";
import "./audio.css";

export type AudioControlsProps = { className?: string };

/** A volume slider runs 0–100 in steps of 5; the store holds the fraction. */
const RANGE_MAX = 100;
const RANGE_STEP = 5;

type VolumeKey = "master" | "sfx" | "voice";

function preview(key: VolumeKey): void {
  if (key === "voice") getAudioEngine().playVoice(VOICE_PREVIEW_DEF_ID, "play", 0, VOICE_PRIORITY.summon);
  else getAudioEngine().playSfx("uiClick");
}

const VOLUMES: readonly { key: VolumeKey; label: string; testid: string }[] = [
  { key: "master", label: "Master volume", testid: "audio-master" },
  { key: "sfx", label: "Effects volume", testid: "audio-sfx" },
  { key: "voice", label: "Voice volume", testid: "audio-voice" },
];

function percent(settings: AudioSettings, key: VolumeKey): number {
  return Math.round(settings[key] * RANGE_MAX);
}

export default function AudioControls({ className }: AudioControlsProps): ReactElement {
  const [settings] = useAudioSettings();
  const id = useId();

  return (
    <fieldset
      className={className === undefined || className === "" ? "audio-controls" : `audio-controls ${className}`}
      data-testid="audio-controls"
    >
      <legend>Audio</legend>

      {VOLUMES.map(({ key, label, testid }) => {
        const inputId = `${id}-${key}`;
        const value = percent(settings, key);
        return (
          <div className="audio-controls__row" key={key}>
            <label htmlFor={inputId}>{label}</label>
            <input
              id={inputId}
              type="range"
              min={0}
              max={RANGE_MAX}
              step={RANGE_STEP}
              value={value}
              data-testid={testid}
              onChange={(event: ChangeEvent<HTMLInputElement>) => {
                const patch: Partial<AudioSettings> = {};
                patch[key] = Number(event.currentTarget.value) / RANGE_MAX;
                writeAudioSettings(patch);
                if (key !== "voice") preview(key);
              }}
              onPointerUp={key === "voice" ? () => preview(key) : undefined}
              onKeyUp={key === "voice" ? () => preview(key) : undefined}
            />
            <output className="audio-controls__value" htmlFor={inputId} aria-hidden="true">
              {value}%
            </output>
          </div>
        );
      })}

      <div className="audio-controls__row audio-controls__row--check">
        <input
          id={`${id}-mute`}
          type="checkbox"
          checked={settings.muted}
          data-testid="audio-mute"
          onChange={(event: ChangeEvent<HTMLInputElement>) => {
            writeAudioSettings({ muted: event.currentTarget.checked });
          }}
        />
        <label htmlFor={`${id}-mute`}>Mute all sound</label>
      </div>

      <div className="audio-controls__row audio-controls__row--check">
        <input
          id={`${id}-voice-on`}
          type="checkbox"
          checked={settings.voiceOn}
          data-testid="audio-voice-on"
          onChange={(event: ChangeEvent<HTMLInputElement>) => {
            writeAudioSettings({ voiceOn: event.currentTarget.checked });
          }}
        />
        <label htmlFor={`${id}-voice-on`}>Voice lines</label>
      </div>
    </fieldset>
  );
}
