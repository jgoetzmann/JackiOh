// The mix bus (docs/polish/2-sound.md, "engine.ts"; B4, B51): the graph every cue plays through.
//
//   per-cue gain ─▶ sfx bus ──┐
//   persona gain ─▶ voice bus ┴─▶ master ─▶ limiter ─▶ destination
//
// The limiter is a DynamicsCompressor set as a peak catcher for the sum: a hard knee at LIMITER's
// threshold, so a lone sound passes through at one fixed gain and only a pile-up (a board wipe's
// hits under a death line) is held back. Left at the Web Audio default 30 dB knee, the same node
// squeezes everything from 36 dB under its threshold and takes a few dB off every single effect,
// which is how the mix came out quieter than its recipes.
//
// Measured in Chrome (audio-recipes.cy.tsx, B57): its compressor adds automatic makeup gain, the
// same for every sound, so a lower threshold lifts effects and lines alike and leaves their balance
// alone; a -6 dB threshold keeps the densest scene the director can play under full scale. The
// attack stays at 3 ms: at 1 ms Chrome's detector clips 4 to 6 dB off short transients (a hit, a
// card draw, a UI tick) that are nowhere near the threshold.
//
// This file imports only ./types.ts, like sfx.ts, so the Cypress component spec can render the
// real mix in an OfflineAudioContext and measure what a player hears at the default settings.

import type { AudioSettings } from "./types.ts";

/** The master limiter: catches a board wipe's pile-up before it clips, and leaves a lone cue alone. */
export const LIMITER = { thresholdDb: -6, kneeDb: 0, ratio: 20, attackS: 0.003, releaseS: 0.25 } as const;

export type Mix = { master: GainNode; sfx: GainNode; voice: GainNode; limiter: DynamicsCompressorNode };

/** Bus levels for a settings value: mute silences master, and voice lines off silence the voice bus. */
export function mixLevels(s: AudioSettings): { master: number; sfx: number; voice: number } {
  return { master: s.muted ? 0 : s.master, sfx: s.sfx, voice: s.voiceOn ? s.voice : 0 };
}

/** Builds the buses and the limiter into `ctx.destination`, at `settings`' levels. */
export function buildMix(ctx: BaseAudioContext, settings: AudioSettings): Mix {
  const master = ctx.createGain();
  const sfx = ctx.createGain();
  const voice = ctx.createGain();
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = LIMITER.thresholdDb;
  limiter.knee.value = LIMITER.kneeDb;
  limiter.ratio.value = LIMITER.ratio;
  limiter.attack.value = LIMITER.attackS;
  limiter.release.value = LIMITER.releaseS;
  sfx.connect(master);
  voice.connect(master);
  master.connect(limiter);
  limiter.connect(ctx.destination);
  const levels = mixLevels(settings);
  master.gain.value = levels.master;
  sfx.gain.value = levels.sfx;
  voice.gain.value = levels.voice;
  return { master, sfx, voice, limiter };
}
