// Procedural sound effects (docs/polish/2-sound.md, "sfx.ts"; B14, B15, B16).
//
// One recipe per `SfxId`, in the sfxr tradition: an oscillator or a noise buffer, a filter and a
// gain envelope, plus two-operator FM for bells and chimes. No audio files ship for effects.
//
// The recipe contract every entry keeps:
//   - it schedules nothing before `at` and stops every source it starts by `at + returned`, and
//     `returned <= durationMs / 1000` (every time goes through `time()`, which clamps into the span);
//   - it connects only into `out`, never `ctx.destination`, and its peak output stays at or under 1;
//   - exponential ramps target a positive value (`FLOOR`), never 0;
//   - it uses only the permitted Web Audio subset (gain, oscillator, biquad, buffer source, buffer,
//     connect, start/stop and AudioParam automation), which is all the test fake implements.
//
// This file imports only `./types.ts` and `./constants.ts`, because the Cypress component spec
// imports it on its own and renders each recipe into an OfflineAudioContext.
//
// The frequencies and times below are each recipe's data, like keyframes in `animations.css`, and
// stay local to it (CLAUDE.md rule 9 names only the numbers another module reads).
//
// LEVELS (B57). The recipes use their headroom (each peaks well inside 1 on its own), and the gains
// in the SFX table set the mix against the voice lines, which sit at about -20 dBFS active RMS at
// the default settings: a maximum hit and the big moments (death, a trap springing, turn start,
// victory, defeat) within a few dB of a line, routine card and board sounds 5 to 9 dB under it, and
// the UI ticks quieter still but plainly audible. The component spec (audio-recipes.cy.tsx)
// renders every recipe through the real mix and holds these bands, so a retune cannot drift.

import { IMPACT_AMOUNT_CAP } from "./constants.ts";
import type { SfxId, SfxParams, SfxTimbre } from "./types.ts";

export const SFX_IDS: readonly SfxId[] = [
  "draw", "play", "summon", "attack", "impact", "shieldShatter", "heal", "buff", "debuff",
  "death", "burn", "trapSet", "trapSting", "spell", "mana", "turnStart", "victory",
  "defeat", "uiClick", "uiHover", "whoosh", "radiant", "lock", "poof", "notify", "drain",
  "cancel", "entrance",
];

/** Every card family a summon or spell may be given (types.ts SfxTimbre), for the tests. */
export const SFX_TIMBRES: readonly SfxTimbre[] = [
  "human", "felinor", "ky", "cn", "fruit", "chaos", "quickdraw", "token", "field",
];

/** Schedules one sound starting at `at` (context seconds) into `out`; returns its length in seconds. */
export type SfxRecipe = (ctx: BaseAudioContext, out: AudioNode, at: number, params: SfxParams) => number;
export type SfxSpec = { recipe: SfxRecipe; /** upper bound over all params */ durationMs: number; gain: number };

/* ------------------------------------------------------------------------------------------- *
 * Noise
 * ------------------------------------------------------------------------------------------- */

const NOISE_SEED = 0x4a41434b; // "JACK"
const noiseCache = new WeakMap<BaseAudioContext, AudioBuffer>();

function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 1 s of mono white noise, cached per context (WeakMap), filled from a fixed-seed mulberry32 so every run is identical. */
export function noiseBuffer(ctx: BaseAudioContext): AudioBuffer {
  const cached = noiseCache.get(ctx);
  if (cached !== undefined) return cached;
  const length = Math.round(ctx.sampleRate);
  const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
  const random = mulberry32(NOISE_SEED);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i += 1) data[i] = random() * 2 - 1;
  noiseCache.set(ctx, buffer);
  return buffer;
}

/* ------------------------------------------------------------------------------------------- *
 * Building blocks
 * ------------------------------------------------------------------------------------------- */

/** The quietest level an exponential ramp aims at: -80 dB, silent in practice and never 0. */
const FLOOR = 0.0001;
/** An offset past any recipe's end; `time()` clamps it to the end. */
const UNTIL_END = Number.POSITIVE_INFINITY;

/** One recipe run: its context, its output and its span [at, end]. */
type Kit = { ctx: BaseAudioContext; out: AudioNode; at: number; end: number };

function kit(ctx: BaseAudioContext, out: AudioNode, at: number, lengthS: number): Kit {
  return { ctx, out, at, end: at + lengthS };
}

/** `at + offset`, clamped into the recipe's span, so nothing lands before `at` or after the end. */
function time(k: Kit, offset: number): number {
  return Math.min(k.end, k.at + Math.max(0, offset));
}

function chain(first: AudioNode, ...rest: AudioNode[]): void {
  let prev = first;
  for (const node of rest) {
    prev.connect(node);
    prev = node;
  }
}

function run(k: Kit, source: AudioScheduledSourceNode, start: number, stop: number): void {
  source.start(time(k, start));
  source.stop(time(k, stop));
}

function oscillator(k: Kit, type: OscillatorType, hz: number, start = 0): OscillatorNode {
  const osc = k.ctx.createOscillator();
  osc.type = type;
  osc.frequency.setValueAtTime(hz, time(k, start));
  return osc;
}

function noiseSource(k: Kit): AudioBufferSourceNode {
  const source = k.ctx.createBufferSource();
  source.buffer = noiseBuffer(k.ctx);
  source.loop = true;
  return source;
}

function biquad(k: Kit, type: BiquadFilterType, hz: number, q: number): BiquadFilterNode {
  const filter = k.ctx.createBiquadFilter();
  filter.type = type;
  filter.frequency.setValueAtTime(hz, k.at);
  filter.Q.setValueAtTime(q, k.at);
  return filter;
}

/** A fixed gain from `start` on. */
function level(k: Kit, value: number, start = 0): GainNode {
  const gain = k.ctx.createGain();
  gain.gain.setValueAtTime(value, time(k, start));
  return gain;
}

/** An exponential glide of `param` to `to`, landing at `offset`. */
function glide(k: Kit, param: AudioParam, to: number, offset: number): void {
  param.exponentialRampToValueAtTime(to, time(k, offset));
}

/** Silence until `start`, a linear rise to `peak` over `attack`, then an exponential fall to FLOOR at `stop`. */
function envelope(k: Kit, start: number, attack: number, peak: number, stop: number): GainNode {
  const gain = k.ctx.createGain();
  const top = time(k, start + attack);
  gain.gain.setValueAtTime(0, time(k, start));
  gain.gain.linearRampToValueAtTime(peak, top);
  gain.gain.exponentialRampToValueAtTime(FLOOR, Math.max(top, time(k, stop)));
  return gain;
}

/** Like `envelope`, but it eases from `peak` to `holdLevel` until `holdUntil` before it falls. */
function heldEnvelope(
  k: Kit,
  start: number,
  attack: number,
  peak: number,
  holdUntil: number,
  holdLevel: number,
  stop: number,
): GainNode {
  const gain = k.ctx.createGain();
  const top = time(k, start + attack);
  const hold = Math.max(top, time(k, holdUntil));
  gain.gain.setValueAtTime(0, time(k, start));
  gain.gain.linearRampToValueAtTime(peak, top);
  gain.gain.linearRampToValueAtTime(holdLevel, hold);
  gain.gain.exponentialRampToValueAtTime(FLOOR, Math.max(hold, time(k, stop)));
  return gain;
}

/**
 * A gain that an LFO swings between `base - depth` and `base + depth` for the whole recipe:
 * tremolo with a sine, flutter or crackle with a square.
 */
function modulatedGain(k: Kit, type: OscillatorType, rateHz: number, base: number, depth: number): GainNode {
  const gain = level(k, base);
  const lfo = oscillator(k, type, rateHz);
  const amount = level(k, depth);
  chain(lfo, amount);
  amount.connect(gain.gain);
  run(k, lfo, 0, UNTIL_END);
  return gain;
}

/** A sine tremolo that dips to `1 - 2 * depth` and never rises past 1. */
function tremolo(k: Kit, rateHz: number, depth: number): GainNode {
  return modulatedGain(k, "sine", rateHz, 1 - depth, depth);
}

/** A sine vibrato of ±`depthHz` on `param` between `start` and `stop`. */
function vibrato(k: Kit, param: AudioParam, rateHz: number, depthHz: number, start: number, stop: number): void {
  const lfo = oscillator(k, "sine", rateHz, start);
  const amount = level(k, depthHz, start);
  chain(lfo, amount);
  amount.connect(param);
  run(k, lfo, start, stop);
}

/** A two-operator FM bell: a sine modulator at `ratio` × the carrier, its index decaying with the note. */
function fmBell(
  k: Kit,
  into: AudioNode,
  carrierHz: number,
  ratio: number,
  indexHz: number,
  start: number,
  attack: number,
  peak: number,
  stop: number,
): void {
  const carrier = oscillator(k, "sine", carrierHz, start);
  const modulator = oscillator(k, "sine", carrierHz * ratio, start);
  const index = level(k, indexHz, start);
  glide(k, index.gain, Math.max(1, indexHz * 0.05), stop);
  chain(modulator, index);
  index.connect(carrier.frequency);
  chain(carrier, envelope(k, start, attack, peak, stop), into);
  run(k, carrier, start, stop);
  run(k, modulator, start, stop);
}

/** A plain enveloped tone into `into`. */
function tone(
  k: Kit,
  into: AudioNode,
  type: OscillatorType,
  hz: number,
  start: number,
  attack: number,
  peak: number,
  stop: number,
): OscillatorNode {
  const osc = oscillator(k, type, hz, start);
  chain(osc, envelope(k, start, attack, peak, stop), into);
  run(k, osc, start, stop);
  return osc;
}

/** amount → t in [0, 1]: 1 (or none) is 0, IMPACT_AMOUNT_CAP and above is 1. */
function amountT(params: SfxParams): number {
  const clamped = Math.min(IMPACT_AMOUNT_CAP, Math.max(1, params.amount ?? 1));
  return (clamped - 1) / (IMPACT_AMOUNT_CAP - 1);
}

/* ------------------------------------------------------------------------------------------- *
 * Recipes
 * ------------------------------------------------------------------------------------------- */

/** A card slides off the deck: a bright rising noise flick. */
const draw: SfxRecipe = (ctx, out, at) => {
  const len = 0.17;
  const k = kit(ctx, out, at, len);
  const noise = noiseSource(k);
  const band = biquad(k, "bandpass", 2500, 1.2);
  glide(k, band.frequency, 5000, len);
  chain(noise, band, envelope(k, 0, 0.01, 1.6, len), out);
  run(k, noise, 0, len);
  return len;
};

/** A card thrown onto the table: a rising whoosh, then a soft blip as it lands. */
const play: SfxRecipe = (ctx, out, at) => {
  const len = 0.25;
  const k = kit(ctx, out, at, len);
  const noise = noiseSource(k);
  const band = biquad(k, "bandpass", 600, 1.5);
  glide(k, band.frequency, 2400, 0.2);
  chain(noise, band, envelope(k, 0, 0.03, 0.9, 0.22), out);
  run(k, noise, 0, 0.22);
  tone(k, out, "sine", 180, 0.2, 0.005, 0.4, len);
  return len;
};

/** When a summon's family accent starts: after the thud's attack, once its first boom has fallen. */
const ACCENT_AT = 0.05;

/**
 * The family's voice on top of a summon thud, quiet and short (it ends by 0.24 s, inside the
 * shortest thud), so the thud still carries the size of the unit and the accent only says what kind
 * of thing landed: armour for a Human, a chirp for a Felinor, a page's bell for KY, bubbles for CN,
 * a squelch for Fruit, a warble for Call to Chaos, a zip for Quickdraw, a pop for a token.
 */
function summonAccent(k: Kit, timbre: SfxTimbre | undefined): void {
  const t0 = ACCENT_AT;
  switch (timbre) {
    case "human":
      tone(k, k.out, "sine", 2350, t0, 0.002, 0.14, t0 + 0.15);
      tone(k, k.out, "sine", 3520, t0 + 0.01, 0.002, 0.09, t0 + 0.12);
      return;
    case "felinor": {
      const chirp = tone(k, k.out, "sine", 700, t0 + 0.01, 0.01, 0.16, t0 + 0.12);
      glide(k, chirp.frequency, 1400, t0 + 0.08);
      return;
    }
    case "ky":
      fmBell(k, k.out, 1568, 2, 150, t0, 0.004, 0.12, t0 + 0.19);
      return;
    case "cn":
      for (const start of [t0, t0 + 0.08]) {
        const bubble = tone(k, k.out, "sine", 300, start, 0.005, 0.14, start + 0.07);
        glide(k, bubble.frequency, 700, start + 0.06);
      }
      return;
    case "fruit": {
      const noise = noiseSource(k);
      const band = biquad(k, "bandpass", 1800, 4);
      glide(k, band.frequency, 400, t0 + 0.12);
      chain(noise, band, envelope(k, t0, 0.01, 0.35, t0 + 0.12), k.out);
      run(k, noise, t0, t0 + 0.12);
      return;
    }
    case "chaos":
      for (const hz of [523, 554]) tone(k, k.out, "triangle", hz, t0, 0.02, 0.08, t0 + 0.17);
      return;
    case "quickdraw": {
      const noise = noiseSource(k);
      const band = biquad(k, "bandpass", 2000, 3);
      glide(k, band.frequency, 6000, t0 + 0.08);
      chain(noise, band, envelope(k, t0, 0.005, 0.3, t0 + 0.08), k.out);
      run(k, noise, t0, t0 + 0.08);
      return;
    }
    case "token": {
      const pop = tone(k, k.out, "sine", 900, t0 - 0.02, 0.003, 0.14, t0 + 0.04);
      glide(k, pop.frequency, 500, t0 + 0.04);
      return;
    }
    case "field":
    case undefined:
      return;
  }
}

/**
 * A unit lands: a falling sine thud and a puff of dust, sized by the unit (`amount` is its attack
 * plus health): a 1/1 taps the table high and short, a 7/7 lands low, long and loud. A unit the
 * viewer can name adds its family's accent (`timbre`).
 */
const summon: SfxRecipe = (ctx, out, at, params) => {
  const t = amountT(params);
  const len = 0.25 + 0.12 * t;
  const peak = 0.45 + 0.45 * t;
  const k = kit(ctx, out, at, len);
  const fromHz = 170 - 60 * t;
  const thud = tone(k, out, "sine", fromHz, 0, 0.005, peak, len);
  glide(k, thud.frequency, 60 - 25 * t, len * 0.7);
  const noise = noiseSource(k);
  const dust = 0.05 + 0.05 * t;
  chain(noise, biquad(k, "lowpass", 900 - 300 * t, 0), envelope(k, 0, 0.005, peak, dust), out);
  run(k, noise, 0, dust);
  summonAccent(k, params.timbre);
  return len;
};

/** An attack swing: a falling band of noise. */
const attack: SfxRecipe = (ctx, out, at) => {
  const len = 0.23;
  const k = kit(ctx, out, at, len);
  const noise = noiseSource(k);
  const band = biquad(k, "bandpass", 3000, 2);
  glide(k, band.frequency, 700, 0.2);
  chain(noise, band, envelope(k, 0, 0.02, 1.6, len), out);
  run(k, noise, 0, len);
  return len;
};

/** A hit that grows louder, darker and longer with the amount, up to IMPACT_AMOUNT_CAP. */
const impact: SfxRecipe = (ctx, out, at, params) => {
  const t = amountT(params);
  const len = 0.12 + 0.33 * t;
  const peak = 0.5 + 0.5 * t;
  const k = kit(ctx, out, at, len);
  const noise = noiseSource(k);
  chain(noise, biquad(k, "lowpass", 5000 - 3800 * t, 0), envelope(k, 0, 0.004, 1.1 * peak, len), out);
  run(k, noise, 0, len);
  const thumpHz = 110 - 50 * t;
  const thump = tone(k, out, "sine", thumpHz, 0, 0.004, 0.75 * peak, len);
  glide(k, thump.frequency, thumpHz * 0.6, len);
  return len;
};

/** A Divine Shield breaks: five glassy partials and a hiss of shards. */
const shieldShatter: SfxRecipe = (ctx, out, at) => {
  const len = 0.48;
  const k = kit(ctx, out, at, len);
  const partials = [2100, 3300, 4700, 5900, 7300];
  partials.forEach((hz, i) => {
    const start = 0.015 * i;
    tone(k, out, "sine", hz, start, 0.003, 0.18, start + 0.3 + 0.03 * i);
  });
  const noise = noiseSource(k);
  chain(noise, biquad(k, "highpass", 4000, 0), envelope(k, 0, 0.002, 0.45, 0.08), out);
  run(k, noise, 0, 0.08);
  return len;
};

/** A heal: three FM bells rising through a major triad. */
const heal: SfxRecipe = (ctx, out, at) => {
  const len = 0.68;
  const k = kit(ctx, out, at, len);
  [1047, 1319, 1568].forEach((hz, i) => {
    const start = 0.09 * i;
    fmBell(k, out, hz, 2, 300, start, 0.005, 0.3, start + 0.5);
  });
  return len;
};

/** A buff: a sawtooth rising an octave through an opening filter. */
const buff: SfxRecipe = (ctx, out, at) => {
  const len = 0.4;
  const k = kit(ctx, out, at, len);
  const saw = oscillator(k, "sawtooth", 220);
  glide(k, saw.frequency, 440, 0.35);
  const filter = biquad(k, "lowpass", 1200, 0);
  glide(k, filter.frequency, 3000, 0.35);
  chain(saw, filter, envelope(k, 0, 0.02, 0.53, len), out);
  run(k, saw, 0, len);
  return len;
};

/** A debuff: the buff in reverse, falling and closing. */
const debuff: SfxRecipe = (ctx, out, at) => {
  const len = 0.4;
  const k = kit(ctx, out, at, len);
  const saw = oscillator(k, "sawtooth", 440);
  glide(k, saw.frequency, 200, 0.35);
  const filter = biquad(k, "lowpass", 2000, 0);
  glide(k, filter.frequency, 700, 0.35);
  chain(saw, filter, envelope(k, 0, 0.02, 0.53, len), out);
  run(k, saw, 0, len);
  return len;
};

/** A unit crumbles: fluttering, darkening rubble over a sinking groan. */
const death: SfxRecipe = (ctx, out, at) => {
  const len = 0.62;
  const k = kit(ctx, out, at, len);
  const noise = noiseSource(k);
  const filter = biquad(k, "lowpass", 1200, 0);
  glide(k, filter.frequency, 200, 0.6);
  const flutter = modulatedGain(k, "square", 18, 0.5, 0.5);
  chain(noise, filter, flutter, envelope(k, 0, 0.01, 1.08, len), out);
  run(k, noise, 0, len);
  const groan = tone(k, out, "sine", 90, 0, 0.01, 0.54, len);
  glide(k, groan.frequency, 40, 0.6);
  return len;
};

/** A card burns: gated crackle over a low hiss. */
const burn: SfxRecipe = (ctx, out, at) => {
  const len = 0.58;
  const k = kit(ctx, out, at, len);
  const noise = noiseSource(k);
  const crackle = modulatedGain(k, "square", 23, 0.5, 0.5);
  chain(noise, biquad(k, "highpass", 1500, 0), crackle, envelope(k, 0, 0.01, 0.6, len), out);
  chain(noise, biquad(k, "bandpass", 800, 1), envelope(k, 0, 0.05, 0.66, len), out);
  run(k, noise, 0, len);
  return len;
};

/** A trap is set face-down: a papery slap and a small tick. */
const trapSet: SfxRecipe = (ctx, out, at) => {
  const len = 0.15;
  const k = kit(ctx, out, at, len);
  const noise = noiseSource(k);
  chain(noise, biquad(k, "bandpass", 1200, 3), envelope(k, 0, 0.003, 1.45, 0.09), out);
  run(k, noise, 0, 0.09);
  tone(k, out, "sine", 220, 0, 0.003, 0.58, len);
  return len;
};

/** A trap springs: a dissonant square pair closing down, with a high ping on top. */
const trapSting: SfxRecipe = (ctx, out, at) => {
  const len = 0.66;
  const k = kit(ctx, out, at, len);
  const filter = biquad(k, "lowpass", 3000, 0);
  glide(k, filter.frequency, 600, 0.6);
  const env = envelope(k, 0, 0.01, 0.31, len);
  chain(filter, env, out);
  for (const hz of [311, 330]) {
    const sq = oscillator(k, "square", hz);
    chain(sq, filter);
    run(k, sq, 0, len);
  }
  tone(k, out, "sine", 1245, 0, 0.003, 0.43, 0.5);
  return len;
};

/**
 * Each family's four chimes, their FM ratio and their spacing (the default is the plain spell): a
 * Field Spell rings an octave lower and warmer, Call to Chaos clashes in semitones, KY climbs a
 * major arpeggio, CN sours on a tritone, a Quickdraw spell runs its notes twice as fast. The peak
 * and the span are the plain spell's, so a family changes the colour and never the level.
 */
const SPELL_CHIMES: Readonly<Record<SfxTimbre | "plain", { hz: readonly number[]; ratio: number; step: number }>> = {
  plain: { hz: [1319, 1760, 2093, 2637], ratio: 3.5, step: 0.06 },
  field: { hz: [659, 880, 1047, 1319], ratio: 2, step: 0.06 },
  chaos: { hz: [1319, 1397, 1976, 2093], ratio: 3.5, step: 0.06 },
  ky: { hz: [1047, 1319, 1568, 2093], ratio: 2, step: 0.06 },
  cn: { hz: [1245, 1319, 1760, 1865], ratio: 3.5, step: 0.06 },
  quickdraw: { hz: [1319, 1760, 2093, 2637], ratio: 3.5, step: 0.03 },
  felinor: { hz: [1568, 2093, 2349, 3136], ratio: 3.5, step: 0.06 },
  fruit: { hz: [1175, 1480, 1760, 2349], ratio: 3.5, step: 0.06 },
  human: { hz: [1047, 1568, 2093, 2637], ratio: 2, step: 0.06 },
  token: { hz: [1319, 1760, 2093, 2637], ratio: 3.5, step: 0.06 },
};

/** A spell is cast: four FM chimes with a shimmering tremolo, in its family's colour. */
const spell: SfxRecipe = (ctx, out, at, params) => {
  const len = 0.78;
  const k = kit(ctx, out, at, len);
  const shimmer = tremolo(k, 7, 0.15);
  chain(shimmer, out);
  const chimes = SPELL_CHIMES[params.timbre ?? "plain"];
  chimes.hz.forEach((hz, i) => {
    const start = chimes.step * i;
    fmBell(k, shimmer, hz, chimes.ratio, 200, start, 0.004, 0.22, 0.6 + start);
  });
  return len;
};

/** A mana crystal fills: a pluck and its octave, higher on your own side. */
const mana: SfxRecipe = (ctx, out, at, params) => {
  const len = 0.25;
  const k = kit(ctx, out, at, len);
  const hz = params.mine === true ? 660 : 440;
  tone(k, out, "sine", hz, 0, 0.01, 0.5, len);
  tone(k, out, "sine", hz * 2, 0, 0.01, 0.2, 0.18);
  return len;
};

/** A turn begins: one bell, or a bell and its fifth when the turn is yours. */
const turnStart: SfxRecipe = (ctx, out, at, params) => {
  const len = 1.15;
  const k = kit(ctx, out, at, len);
  fmBell(k, out, 392, 2, 250, 0, 0.005, 0.5, len);
  if (params.mine === true) fmBell(k, out, 587, 2, 200, 0.06, 0.005, 0.35, len);
  return len;
};

/**
 * Victory: a rising brass arpeggio that lands on a full C major chord over a low root, held and
 * left to ring: the fanfare has to sound bigger than anything the game played before it.
 */
const victory: SfxRecipe = (ctx, out, at) => {
  const len = 1.55;
  const k = kit(ctx, out, at, len);
  const filter = biquad(k, "lowpass", 3200, 0);
  chain(filter, out);
  [523, 659, 784].forEach((hz, i) => {
    const start = 0.12 * i;
    tone(k, filter, "sawtooth", hz, start, 0.01, 0.18, start + 0.26);
  });
  const land = 0.36;
  for (const [hz, peak] of [[523, 0.1], [659, 0.085], [784, 0.085], [1047, 0.1]] as const) {
    const note = oscillator(k, "sawtooth", hz, land);
    chain(note, heldEnvelope(k, land, 0.02, peak, 1.1, peak * 0.75, len), filter);
    run(k, note, land, len);
  }
  const root = oscillator(k, "triangle", 262, land);
  chain(root, heldEnvelope(k, land, 0.03, 0.21, 1.1, 0.17, len), out);
  run(k, root, land, len);
  const sub = oscillator(k, "sine", 131, land);
  chain(sub, heldEnvelope(k, land, 0.04, 0.18, 1.1, 0.13, len), out);
  run(k, sub, land, len);
  return len;
};

/** Defeat: four falling triangle notes, the last one wavering. */
const defeat: SfxRecipe = (ctx, out, at) => {
  const len = 1.55;
  const k = kit(ctx, out, at, len);
  [392, 370, 349].forEach((hz, i) => {
    const start = 0.25 * i;
    tone(k, out, "triangle", hz, start, 0.02, 0.4, start + 0.28);
  });
  const last = oscillator(k, "triangle", 311, 0.75);
  vibrato(k, last.frequency, 5, 6, 0.75, len);
  chain(last, heldEnvelope(k, 0.75, 0.02, 0.45, 1.25, 0.35, len), out);
  run(k, last, 0.75, len);
  return len;
};

/** A UI click: a short high sine and a tick of noise. */
const uiClick: SfxRecipe = (ctx, out, at) => {
  const len = 0.045;
  const k = kit(ctx, out, at, len);
  tone(k, out, "sine", 1800, 0, 0.004, 0.6, 0.044);
  const noise = noiseSource(k);
  chain(noise, biquad(k, "highpass", 3000, 0), envelope(k, 0, 0.001, 0.25, 0.01), out);
  run(k, noise, 0, 0.01);
  return len;
};

/** A UI hover: the smallest blip. */
const uiHover: SfxRecipe = (ctx, out, at) => {
  const len = 0.035;
  const k = kit(ctx, out, at, len);
  tone(k, out, "sine", 2600, 0, 0.003, 0.5, len);
  return len;
};

/** Something moves past: a noise band that sweeps up and back down. */
const whoosh: SfxRecipe = (ctx, out, at) => {
  const len = 0.33;
  const k = kit(ctx, out, at, len);
  const noise = noiseSource(k);
  const band = biquad(k, "bandpass", 400, 1.2);
  glide(k, band.frequency, 2000, 0.15);
  glide(k, band.frequency, 500, len);
  chain(noise, band, envelope(k, 0, 0.14, 0.9, len), out);
  run(k, noise, 0, len);
  return len;
};

/** A card turns Radiant: six high glints under a fast shimmer. */
const radiant: SfxRecipe = (ctx, out, at) => {
  const len = 0.72;
  const k = kit(ctx, out, at, len);
  const shimmer = tremolo(k, 11, 0.2);
  chain(shimmer, out);
  [2637, 3136, 3520, 3951, 4699, 5274].forEach((hz, i) => {
    const start = 0.08 * i;
    tone(k, shimmer, "sine", hz, start, 0.003, 0.3, start + 0.32);
  });
  return len;
};

/** A zone locks: a ring-modulated clank and a click. */
const lock: SfxRecipe = (ctx, out, at) => {
  const len = 0.36;
  const k = kit(ctx, out, at, len);
  const ring = level(k, 0);
  const carrier = oscillator(k, "square", 180);
  const modulator = oscillator(k, "square", 270);
  chain(carrier, ring);
  modulator.connect(ring.gain);
  chain(ring, biquad(k, "bandpass", 1500, 1), envelope(k, 0, 0.005, 1.1, len), out);
  run(k, carrier, 0, len);
  run(k, modulator, 0, len);
  const noise = noiseSource(k);
  chain(noise, biquad(k, "highpass", 2000, 0), envelope(k, 0, 0.001, 0.88, 0.02), out);
  run(k, noise, 0, 0.02);
  return len;
};

/** A card vanishes (exile, transform, fuse): a soft dark puff. */
const poof: SfxRecipe = (ctx, out, at) => {
  const len = 0.43;
  const k = kit(ctx, out, at, len);
  const noise = noiseSource(k);
  const filter = biquad(k, "lowpass", 900, 0);
  glide(k, filter.frequency, 300, len);
  chain(noise, filter, envelope(k, 0, 0.04, 1.43, len), out);
  run(k, noise, 0, len);
  return len;
};

/**
 * A notice: two rising blips. An `urgent` one — a question the viewer has to answer, the other
 * seat's draw offer — is a doorbell instead: a bright bell struck twice, a falling major third
 * apart, so it is never taken for the routine blips.
 */
const notify: SfxRecipe = (ctx, out, at, params) => {
  if (params.urgent === true) {
    const len = 0.29;
    const k = kit(ctx, out, at, len);
    fmBell(k, out, 1319, 3.5, 260, 0, 0.004, 0.34, 0.2);
    fmBell(k, out, 1047, 3.5, 260, 0.11, 0.004, 0.38, len);
    return len;
  }
  const len = 0.28;
  const k = kit(ctx, out, at, len);
  tone(k, out, "sine", 880, 0, 0.005, 0.4, 0.14);
  tone(k, out, "sine", 1175, 0.09, 0.005, 0.4, len);
  return len;
};

/** Life drains away: a sinking, wavering sine that grows with the amount, like impact. */
const drain: SfxRecipe = (ctx, out, at, params) => {
  const len = 0.58;
  const k = kit(ctx, out, at, len);
  const peak = (0.5 + 0.5 * amountT(params)) * 0.8;
  const osc = oscillator(k, "sine", 300);
  glide(k, osc.frequency, 120, 0.55);
  vibrato(k, osc.frequency, 6, 15, 0, len);
  chain(osc, envelope(k, 0, 0.02, peak, len), out);
  run(k, osc, 0, len);
  return len;
};

/** An attack is called off: a square falling an octave. */
const cancel: SfxRecipe = (ctx, out, at) => {
  const len = 0.24;
  const k = kit(ctx, out, at, len);
  const sq = oscillator(k, "square", 330);
  glide(k, sq.frequency, 165, 0.2);
  chain(sq, biquad(k, "lowpass", 1500, 0), envelope(k, 0, 0.005, 0.42, len), out);
  run(k, sq, 0, len);
  return len;
};

/**
 * A Legendary or Mythic unit enters (cues.ts, with the effects layer's light rays): a low gong under
 * a brass fifth that swells open, and a run of high glints once it has risen. A Mythic's glints are
 * a longer, faster, shimmering climb.
 */
const entrance: SfxRecipe = (ctx, out, at, params) => {
  const len = 1.3;
  const k = kit(ctx, out, at, len);
  fmBell(k, out, 98, 1.4, 200, 0, 0.01, 0.35, len);
  const brass = biquad(k, "lowpass", 600, 0);
  glide(k, brass.frequency, 3000, 0.5);
  chain(brass, heldEnvelope(k, 0, 0.25, 0.32, 0.9, 0.24, len), out);
  for (const hz of [196, 294]) {
    const note = oscillator(k, "sawtooth", hz);
    chain(note, brass);
    run(k, note, 0, len);
  }
  const mythic = params.mythic === true;
  const glints = mythic ? [2093, 2637, 3136, 3520, 4186, 5274] : [1568, 2093, 2637];
  const shimmer = mythic ? tremolo(k, 9, 0.2) : level(k, 1);
  chain(shimmer, out);
  glints.forEach((hz, i) => {
    const start = 0.25 + (mythic ? 0.06 : 0.08) * i;
    tone(k, shimmer, "sine", hz, start, 0.003, 0.1, start + 0.45);
  });
  return len;
};

export const SFX: { readonly [K in SfxId]: SfxSpec } = {
  draw: { recipe: draw, durationMs: 180, gain: 1 },
  play: { recipe: play, durationMs: 260, gain: 0.82 },
  summon: { recipe: summon, durationMs: 380, gain: 1 },
  attack: { recipe: attack, durationMs: 240, gain: 1 },
  impact: { recipe: impact, durationMs: 450, gain: 1 },
  shieldShatter: { recipe: shieldShatter, durationMs: 500, gain: 1 },
  heal: { recipe: heal, durationMs: 700, gain: 0.66 },
  buff: { recipe: buff, durationMs: 420, gain: 1 },
  debuff: { recipe: debuff, durationMs: 420, gain: 1 },
  death: { recipe: death, durationMs: 650, gain: 1 },
  burn: { recipe: burn, durationMs: 600, gain: 1 },
  trapSet: { recipe: trapSet, durationMs: 160, gain: 1 },
  trapSting: { recipe: trapSting, durationMs: 700, gain: 1 },
  spell: { recipe: spell, durationMs: 800, gain: 0.89 },
  mana: { recipe: mana, durationMs: 260, gain: 0.76 },
  turnStart: { recipe: turnStart, durationMs: 1200, gain: 0.78 },
  victory: { recipe: victory, durationMs: 1600, gain: 1 },
  defeat: { recipe: defeat, durationMs: 1600, gain: 0.6 },
  uiClick: { recipe: uiClick, durationMs: 50, gain: 0.79 },
  uiHover: { recipe: uiHover, durationMs: 40, gain: 0.4 },
  whoosh: { recipe: whoosh, durationMs: 350, gain: 0.76 },
  radiant: { recipe: radiant, durationMs: 900, gain: 0.78 },
  lock: { recipe: lock, durationMs: 400, gain: 1 },
  poof: { recipe: poof, durationMs: 450, gain: 1 },
  notify: { recipe: notify, durationMs: 300, gain: 0.6 },
  drain: { recipe: drain, durationMs: 600, gain: 0.69 },
  cancel: { recipe: cancel, durationMs: 260, gain: 1 },
  entrance: { recipe: entrance, durationMs: 1400, gain: 0.6 },
};
