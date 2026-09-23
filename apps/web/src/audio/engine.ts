// The Web Audio engine (docs/polish/2-sound.md, "engine.ts"; B1–B11, B46–B53).
//
// Lazily built: no AudioContext exists until the first `unlock()`, which the unlock listeners call
// inside a user gesture (autoplay policy, and iOS's resume-plus-silent-buffer rule). The graph is
//
//   per-cue gain ─▶ sfx bus ──┐
//   persona gain ─▶ voice bus ┴─▶ master ─▶ limiter ─▶ destination
//
// with bus gains read from the settings store and smoothed on change (mix.ts builds it). Both play
// calls go through one acceptance gate and never throw.
//
// NOTHING IS SCHEDULED ON A CONTEXT THAT IS NOT RUNNING. A suspended (or Safari "interrupted")
// context's clock stands still, so everything scheduled on it would start together the moment it
// resumed: every queued line at once. Such a cue is still accepted and logged, flagged, so a
// headless browser with no output device can be observed, but it builds no nodes.
//
// SFX are polyphonic up to SFX_MAX_VOICES with a per-id retrigger guard. Voice is one channel with
// priorities (VOICE_PRIORITY): a more important line cuts in, fading the one it replaces; an equal
// or less important one waits in a short queue and is dropped if it has waited too long by the
// time the channel frees. A rendered line holds the channel for its audible span only (its silent
// head and tail are skipped), and a line not ready VOICE_LATE_MS after it takes the channel is
// dropped rather than spoken out of step. A line with no file falls back to the browser's speech
// synthesis. Muting, or turning voice lines off, stops the line that is speaking and clears the
// queue.
//
// Voice files are cached twice: the compressed bytes of every line fetched (1.6 MB for the whole
// set, fetched in the background once the context runs, so an opponent's first card is not late)
// and the decoded buffers of the VOICE_DECODED_MAX most recently used lines (a decoded line is
// about 20 times its file).
//
// BACKGROUND VOICE WORK NEVER RUNS DURING AN ANIMATION BURST (B58). The runner times each entry
// with a main-thread setTimeout, so a burst takes as long as the page's busiest moment lets it: the
// prefetch's stream of requests (and, under Cypress, the command log entry each one adds) landing
// in an R82 auto-ended turn run pushed a 3.8 s burst past 4 s. `useGameAudio` calls
// `setBusy(true)` while the runner has an entry in flight. Until it clears, the prefetch starts no
// new request and a preload is held (the newest one, run when it clears). A line asked to play is
// never held. With sound muted or voice lines off, neither the prefetch nor a preload runs at all.
//
// Every accepted cue is logged (at most LOG_LIMIT), which is how tests and the e2e debug handle
// observe the engine in a headless browser with no audio device.

import {
  GAIN_SMOOTHING_S,
  HIDDEN_DEF_ID,
  LOG_LIMIT,
  SFX_MAX_VOICES,
  SFX_RETRIGGER_MS,
  VOICE_DECODED_MAX,
  VOICE_FADE_S,
  VOICE_LATE_MS,
  VOICE_PREFETCH_CONCURRENCY,
  VOICE_PREFETCH_DELAY_MS,
  VOICE_PRELOAD_MAX,
  VOICE_PRIORITY,
  VOICE_QUEUE_MAX,
  VOICE_QUEUE_WAIT_MS,
  VOICE_SPEECH_MAX_MS,
  VOICE_TRIM_LEAD_S,
  VOICE_TRIM_TAIL_S,
  VOICE_TRIM_THRESHOLD,
} from "./constants.ts";
import { buildMix, mixLevels, type Mix } from "./mix.ts";
import { readAudioSettings, subscribeAudioSettings } from "./settings.ts";
import { SFX } from "./sfx.ts";
import type {
  AudioEngine,
  AudioSettings,
  AudioState,
  Persona,
  PlayedCue,
  SfxId,
  SfxParams,
  VoiceKey,
  VoiceLineKind,
  VoiceLineTable,
  VoiceManifest,
  VoiceOutcome,
  VoicePriority,
} from "./types.ts";
import { VOICE_LINES, VOICE_MANIFEST, lineFor, voiceKey, voiceUrl } from "./voiceData.ts";

export type SpeechPort = {
  speak(text: string, voice: { pitch: number; rate: number; volume: number }, onEnd: () => void): void;
  cancel(): void;
};

/** window.speechSynthesis + SpeechSynthesisUtterance (lang "en-US"), or null when either is missing (jsdom). */
export function browserSpeechPort(): SpeechPort | null {
  const w = window as unknown as {
    speechSynthesis?: SpeechSynthesis;
    SpeechSynthesisUtterance?: typeof SpeechSynthesisUtterance;
  };
  const synth = w.speechSynthesis;
  const Utterance = w.SpeechSynthesisUtterance;
  if (synth === undefined || Utterance === undefined) return null;
  return {
    speak(text, voice, onEnd) {
      let ended = false;
      const end = (): void => {
        if (ended) return;
        ended = true;
        onEnd();
      };
      try {
        const utterance = new Utterance(text);
        utterance.lang = "en-US";
        utterance.pitch = voice.pitch;
        utterance.rate = voice.rate;
        utterance.volume = voice.volume;
        utterance.onend = end;
        utterance.onerror = end;
        synth.speak(utterance);
      } catch {
        end();
      }
    },
    cancel() {
      try {
        synth.cancel();
      } catch {
        // Nothing to stop.
      }
    },
  };
}

export type AudioEngineOptions = {
  /** null = unsupported. Default: window.AudioContext ?? window.webkitAudioContext, else null. */
  createContext?: (() => AudioContext) | null;
  speech?: SpeechPort | null;                          // default browserSpeechPort()
  fetchBytes?: (url: string) => Promise<ArrayBuffer>;  // default fetch; rejects on !ok
  now?: () => number;                                  // ms; default performance.now()
  visibility?: () => DocumentVisibilityState;          // default document.visibilityState ("visible" without a document)
  lines?: VoiceLineTable;                              // default VOICE_LINES
  manifest?: VoiceManifest;                            // default VOICE_MANIFEST
};

/* ------------------------------------------------------------------------------------------- *
 * Defaults
 * ------------------------------------------------------------------------------------------- */

/** How long after a cue's last sample its gain node is disconnected. */
const DISCONNECT_GRACE_MS = 250;

function defaultContextFactory(): (() => AudioContext) | null {
  const w = window as unknown as {
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
  };
  const Ctor = w.AudioContext ?? w.webkitAudioContext;
  if (Ctor === undefined) return null;
  return () => new Ctor();
}

async function defaultFetchBytes(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`audio: GET ${url} answered ${response.status}`);
  return response.arrayBuffer();
}

function defaultNow(): number {
  return performance.now();
}

function defaultVisibility(): DocumentVisibilityState {
  return document.visibilityState;
}

/* ------------------------------------------------------------------------------------------- *
 * A rendered line's audible span
 * ------------------------------------------------------------------------------------------- */

type Span = { offsetS: number; lengthS: number };

const spans = new WeakMap<AudioBuffer, Span>();

/**
 * Where the speech in a rendered line starts and ends. `say` pads a line with silence (a third of a
 * second at the end on average) and AAC adds encoder priming at the start; played whole, that
 * silence holds the one voice channel and delays the next line for nothing. A buffer with no sample
 * above the threshold is played whole.
 */
export function audibleSpan(buffer: AudioBuffer): Span {
  const cached = spans.get(buffer);
  if (cached !== undefined) return cached;
  const whole: Span = { offsetS: 0, lengthS: buffer.duration };
  let span = whole;
  try {
    const data = buffer.getChannelData(0);
    let first = -1;
    let last = -1;
    for (let i = 0; i < data.length; i += 1) {
      if (Math.abs(data[i] ?? 0) > VOICE_TRIM_THRESHOLD) {
        if (first < 0) first = i;
        last = i;
      }
    }
    if (first >= 0) {
      const rate = buffer.sampleRate;
      const offsetS = Math.max(0, first / rate - VOICE_TRIM_LEAD_S);
      const endS = Math.min(buffer.duration, (last + 1) / rate + VOICE_TRIM_TAIL_S);
      if (endS > offsetS) span = { offsetS, lengthS: endS - offsetS };
    }
  } catch {
    span = whole;
  }
  spans.set(buffer, span);
  return span;
}

/* ------------------------------------------------------------------------------------------- *
 * The engine
 * ------------------------------------------------------------------------------------------- */

type VoiceEntry = Extract<PlayedCue, { kind: "voice" }>;
type Spoken = { text: string; persona: Persona } | null;

/** One accepted line, from its request until it has finished or been given up on. */
type VoiceLine = {
  entry: VoiceEntry;
  key: VoiceKey;
  spoken: Spoken;
  hasFile: boolean;
  priority: VoicePriority;
  /** now() at the request, in ms. */
  requestedAt: number;
  /** The context's clock at the request, in seconds. */
  requestCtxTime: number;
  delayMs: number;
};

/** The line holding the one voice channel. */
type VoiceChannel = {
  line: VoiceLine;
  phase: "loading" | "waiting" | "playing" | "speaking";
  /** now() when it took the channel, in ms. */
  since: number;
  /** now() at which the channel frees itself, once the line's length is known. */
  until: number | null;
  /** Cuts the line short (fades and stops its source, or cancels the speech). */
  stop: (() => void) | null;
};

export function createAudioEngine(options: AudioEngineOptions = {}): AudioEngine {
  const factory = options.createContext === undefined ? defaultContextFactory() : options.createContext;
  const speech = options.speech === undefined ? browserSpeechPort() : options.speech;
  const fetchBytes = options.fetchBytes ?? defaultFetchBytes;
  const now = options.now ?? defaultNow;
  const visibility = options.visibility ?? defaultVisibility;
  const lines = options.lines ?? VOICE_LINES;
  const manifest = options.manifest ?? VOICE_MANIFEST;

  let ctx: AudioContext | null = null;
  let buses: Mix | null = null;
  let created = 0;
  let broken = false;
  let disposed = false;
  let unsubscribe: (() => void) | null = null;

  let entries: PlayedCue[] = [];
  const lastSfxAt = new Map<SfxId, number>();
  let sfxEnds: number[] = [];
  /** Compressed bytes per key, for the page's lifetime (a failed fetch is kept as null). */
  const bytes = new Map<VoiceKey, Promise<ArrayBuffer | null>>();
  /** Decoded buffers per key, least recently used first, at most VOICE_DECODED_MAX. */
  const decoded = new Map<VoiceKey, Promise<AudioBuffer | null>>();
  let channel: VoiceChannel | null = null;
  let waiting: VoiceLine[] = [];
  let prefetchScheduled = false;
  /** The keys the prefetch has still to fetch: null until VOICE_PREFETCH_DELAY_MS after it was scheduled. */
  let prefetchRest: VoiceKey[] | null = null;
  let prefetchInFlight = 0;
  /** The board is animating (setBusy): background voice work waits. */
  let busy = false;
  /** The newest preload asked for while busy, run when it clears. */
  let heldPreload: VoiceKey[] | null = null;
  const timers = new Set<ReturnType<typeof setTimeout>>();

  function later(ms: number, fn: () => void): void {
    const id = setTimeout(() => {
      timers.delete(id);
      try {
        fn();
      } catch {
        // A timer callback must never surface an error into the page.
      }
    }, Math.max(0, ms));
    timers.add(id);
  }

  /* ----- state ----- */

  function state(): AudioState {
    if (factory === null || broken) return "unsupported";
    if (disposed) return "closed";
    if (ctx === null) return "locked";
    const s: string = ctx.state;
    if (s === "running" || s === "suspended" || s === "closed") return s;
    // Safari's "interrupted", or anything newer: not playing, and a gesture may resume it.
    return "suspended";
  }

  /** Only a running context advances its clock, so only then may anything be scheduled on it. */
  function running(): boolean {
    return ctx !== null && ctx.state === "running";
  }

  /* ----- graph ----- */

  function applySettings(s: AudioSettings): void {
    if (ctx === null || buses === null || disposed) return;
    const levels = mixLevels(s);
    const t = ctx.currentTime;
    buses.master.gain.setTargetAtTime(levels.master, t, GAIN_SMOOTHING_S);
    buses.sfx.gain.setTargetAtTime(levels.sfx, t, GAIN_SMOOTHING_S);
    buses.voice.gain.setTargetAtTime(levels.voice, t, GAIN_SMOOTHING_S);
    // A line already speaking stops with the setting, speech fallback included: the bus gain
    // cannot reach the browser's speech synthesis.
    if (s.muted || !s.voiceOn) silenceVoice();
    // Voice lines back on: the prefetch picks up where it paused.
    else pumpPrefetch();
  }

  /** iOS only counts a context as unlocked once a sound has started inside the gesture. */
  function playSilentFrame(c: AudioContext): void {
    const buffer = c.createBuffer(1, 1, c.sampleRate);
    const source = c.createBufferSource();
    source.buffer = buffer;
    source.connect(c.destination);
    source.onended = () => {
      try {
        source.disconnect();
      } catch {
        // Already gone.
      }
    };
    source.start(0);
  }

  function unlock(): void {
    if (factory === null || broken || disposed) return;
    if (ctx === null) {
      try {
        ctx = factory();
      } catch {
        broken = true;
        return;
      }
      created += 1;
      buses = buildMix(ctx, readAudioSettings());
      unsubscribe = subscribeAudioSettings(applySettings);
    }
    if (ctx.state === "running") return;
    try {
      void ctx.resume().catch(() => {});
    } catch {
      // resume() on a closed context throws in some browsers; the gesture carries on.
    }
    playSilentFrame(ctx);
  }

  /* ----- log ----- */

  function pushLog(entry: PlayedCue): void {
    entries.push(entry);
    if (entries.length > LOG_LIMIT) entries.splice(0, entries.length - LOG_LIMIT);
  }

  function setOutcome(line: VoiceLine, outcome: VoiceOutcome): void {
    const next: VoiceEntry = { ...line.entry, outcome };
    const index = entries.indexOf(line.entry);
    if (index >= 0) entries[index] = next;
    line.entry = next;
  }

  /* ----- gate ----- */

  function accepting(): boolean {
    if (ctx === null || buses === null || disposed) return false;
    if (ctx.state === "closed") return false;
    if (readAudioSettings().muted) return false;
    if (visibility() === "hidden") return false;
    return true;
  }

  /* ----- sfx ----- */

  function playSfx(id: SfxId, params?: SfxParams, delayMs?: number): boolean {
    try {
      if (!accepting() || ctx === null || buses === null) return false;
      const spec = SFX[id];
      const t = now();
      const delay = delayMs ?? 0;
      const logged = (): Extract<PlayedCue, { kind: "sfx" }> =>
        params === undefined
          ? { kind: "sfx", id, delayMs: delay, atMs: t }
          : { kind: "sfx", id, params: { ...params }, delayMs: delay, atMs: t };

      if (!running()) {
        pushLog({ ...logged(), suspended: true });
        return true;
      }

      const last = lastSfxAt.get(id);
      if (last !== undefined && t - last < SFX_RETRIGGER_MS) return false;
      sfxEnds = sfxEnds.filter((end) => end > t);
      if (sfxEnds.length >= SFX_MAX_VOICES) return false;

      const cue = ctx.createGain();
      cue.gain.value = spec.gain;
      cue.connect(buses.sfx);
      const lengthMs = spec.recipe(ctx, cue, ctx.currentTime + delay / 1000, params ?? {}) * 1000;

      lastSfxAt.set(id, t);
      sfxEnds.push(t + delay + lengthMs);
      later(delay + lengthMs + DISCONNECT_GRACE_MS, () => cue.disconnect());
      pushLog(logged());
      return true;
    } catch {
      return false;
    }
  }

  /* ----- voice files ----- */

  function fetchCached(key: VoiceKey): Promise<ArrayBuffer | null> {
    const cached = bytes.get(key);
    if (cached !== undefined) return cached;
    const pending = (async (): Promise<ArrayBuffer | null> => {
      try {
        return await fetchBytes(voiceUrl(key));
      } catch {
        return null;
      }
    })();
    bytes.set(key, pending);
    return pending;
  }

  /** The decoded line, from the cache (and moved to its most recent end) or fetched and decoded. */
  function load(key: VoiceKey): Promise<AudioBuffer | null> {
    const cached = decoded.get(key);
    if (cached !== undefined) {
      decoded.delete(key);
      decoded.set(key, cached);
      return cached;
    }
    const c = ctx;
    const pending = (async (): Promise<AudioBuffer | null> => {
      try {
        const raw = await fetchCached(key);
        if (c === null || raw === null) return null;
        // decodeAudioData detaches what it is given, and the bytes stay cached for a re-decode.
        return await c.decodeAudioData(raw.slice(0));
      } catch {
        return null;
      }
    })();
    decoded.set(key, pending);
    while (decoded.size > VOICE_DECODED_MAX) {
      const oldest = decoded.keys().next().value;
      if (oldest === undefined) break;
      decoded.delete(oldest);
    }
    return pending;
  }

  /** Whether a voice line could be heard at all: no point loading one otherwise. */
  function voiceWanted(): boolean {
    const s = readAudioSettings();
    return !s.muted && s.voiceOn;
  }

  /** Background loading (the prefetch and preloads) runs only between bursts, and only for voice that can be heard (B58). */
  function backgroundFree(): boolean {
    return !busy && !disposed && voiceWanted();
  }

  /** Starts prefetch requests up to VOICE_PREFETCH_CONCURRENCY while background work may run. */
  function pumpPrefetch(): void {
    const rest = prefetchRest;
    if (rest === null) return;
    while (prefetchInFlight < VOICE_PREFETCH_CONCURRENCY && backgroundFree()) {
      const key = rest.shift();
      if (key === undefined) return;
      if (bytes.has(key)) continue;
      prefetchInFlight += 1;
      // fetchCached never rejects (a failed fetch is cached as null).
      void fetchCached(key).then(() => {
        prefetchInFlight -= 1;
        pumpPrefetch();
      });
    }
  }

  /** Once the context runs: every line's bytes, a few at a time, so no first line waits on the network. */
  function schedulePrefetch(): void {
    if (prefetchScheduled) return;
    prefetchScheduled = true;
    later(VOICE_PREFETCH_DELAY_MS, () => {
      prefetchRest = (Object.keys(manifest.files) as VoiceKey[]).filter((key) => !bytes.has(key));
      pumpPrefetch();
    });
  }

  /* ----- voice channel ----- */

  function voiceBusy(): boolean {
    if (channel === null) return false;
    if (channel.until !== null && now() >= channel.until) {
      channel = null;
      return false;
    }
    return true;
  }

  /** Frees the channel if `ch` still holds it, and hands it to the next waiting line. */
  function release(ch: VoiceChannel): void {
    if (channel !== ch) return;
    channel = null;
    startNext();
  }

  function finish(ch: VoiceChannel, outcome: VoiceOutcome): void {
    setOutcome(ch.line, outcome);
    release(ch);
  }

  /** Takes the channel from its line: a line that had not started yet is dropped, one speaking fades out. */
  function cut(ch: VoiceChannel): void {
    if (channel !== ch) return;
    channel = null;
    if (ch.phase === "loading" || ch.phase === "waiting") setOutcome(ch.line, "dropped");
    try {
      ch.stop?.();
    } catch {
      // Already stopped.
    }
  }

  /** Mute or voice lines off: nothing speaks and nothing waits. */
  function silenceVoice(): void {
    if (channel !== null) cut(channel);
    for (const line of waiting) setOutcome(line, "dropped");
    waiting = [];
  }

  /** The waiting line to start next: the most important, then the oldest; stale ones are dropped. */
  function startNext(): void {
    if (channel !== null || waiting.length === 0) return;
    const t = now();
    const fresh: VoiceLine[] = [];
    for (const line of waiting) {
      if (t - line.requestedAt > VOICE_QUEUE_WAIT_MS) setOutcome(line, "late");
      else fresh.push(line);
    }
    let best: VoiceLine | undefined;
    for (const line of fresh) if (best === undefined || line.priority > best.priority) best = line;
    waiting = fresh.filter((line) => line !== best);
    if (best !== undefined) begin(best);
  }

  function speakNow(ch: VoiceChannel): void {
    if (channel !== ch || disposed) return;
    const settings = readAudioSettings();
    const spoken = ch.line.spoken;
    if (spoken === null || speech === null || settings.muted || !settings.voiceOn) {
      finish(ch, "failed");
      return;
    }
    ch.phase = "speaking";
    ch.until = now() + VOICE_SPEECH_MAX_MS;
    ch.stop = () => {
      speech.cancel();
    };
    setOutcome(ch.line, "speech");
    later(VOICE_SPEECH_MAX_MS, () => release(ch));
    const volume = Math.min(1, Math.max(0, settings.master * settings.voice));
    try {
      speech.speak(
        spoken.text,
        { pitch: spoken.persona.web.pitch, rate: spoken.persona.web.rate, volume },
        () => release(ch),
      );
    } catch {
      finish(ch, "failed");
    }
  }

  function speakAfter(ch: VoiceChannel, waitMs: number): void {
    ch.phase = "waiting";
    if (waitMs <= 0) speakNow(ch);
    else later(waitMs, () => speakNow(ch));
  }

  function startFile(ch: VoiceChannel, buffer: AudioBuffer): void {
    const c = ctx;
    const b = buses;
    if (c === null || b === null) {
      finish(ch, "failed");
      return;
    }
    const line = ch.line;
    const source = c.createBufferSource();
    source.buffer = buffer;
    const trim = c.createGain();
    trim.gain.value = line.spoken?.persona.gain ?? 1;
    source.connect(trim);
    trim.connect(b.voice);
    const span = audibleSpan(buffer);
    const startAt = Math.max(c.currentTime, line.requestCtxTime + line.delayMs / 1000);
    const lengthMs = Math.max(0, (startAt - c.currentTime) * 1000) + span.lengthS * 1000;
    ch.phase = "playing";
    ch.until = now() + lengthMs;
    ch.stop = () => {
      const t = c.currentTime;
      trim.gain.cancelScheduledValues(t);
      trim.gain.setTargetAtTime(0, t, VOICE_FADE_S / 3);
      source.stop(Math.max(startAt, t) + VOICE_FADE_S);
    };
    source.onended = () => {
      release(ch);
      try {
        trim.disconnect();
      } catch {
        // Already gone.
      }
    };
    source.start(startAt, span.offsetS, span.lengthS);
    setOutcome(line, "file");
    later(lengthMs, () => release(ch));
  }

  function onLoaded(ch: VoiceChannel, buffer: AudioBuffer | null): void {
    if (channel !== ch || ch.phase !== "loading" || disposed) return;
    const elapsed = now() - ch.since;
    if (elapsed > VOICE_LATE_MS) {
      finish(ch, "late");
      return;
    }
    if (buffer === null) {
      speakAfter(ch, ch.line.requestedAt + ch.line.delayMs - now());
      return;
    }
    startFile(ch, buffer);
  }

  /** Gives the channel to `line`. */
  function begin(line: VoiceLine): void {
    const ch: VoiceChannel = {
      line,
      phase: line.hasFile ? "loading" : "waiting",
      since: now(),
      until: null,
      stop: null,
    };
    channel = ch;
    if (line.hasFile) {
      later(VOICE_LATE_MS, () => {
        if (channel === ch && ch.phase === "loading") finish(ch, "late");
      });
      void load(line.key).then((buffer) => onLoaded(ch, buffer));
    } else {
      speakAfter(ch, line.requestedAt + line.delayMs - now());
    }
  }

  function playVoice(defId: string, lineKind: VoiceLineKind, delayMs?: number, priority?: VoicePriority): boolean {
    try {
      if (!accepting() || ctx === null) return false;
      if (!readAudioSettings().voiceOn) return false;
      if (defId === HIDDEN_DEF_ID) return false;
      const key = voiceKey(defId, lineKind);
      const hasFile = Object.hasOwn(manifest.files, key);
      const spoken = lineFor(lines, defId, lineKind);
      if (!hasFile && spoken === null) return false;

      const t = now();
      const delay = delayMs ?? 0;
      const rank = priority ?? VOICE_PRIORITY.play;
      const entry = (outcome: VoiceOutcome): VoiceEntry => ({
        kind: "voice",
        defId,
        line: lineKind,
        delayMs: delay,
        atMs: t,
        outcome,
        priority: rank,
      });

      if (!running()) {
        pushLog(entry("suspended"));
        return true;
      }

      // Where the line goes: the free channel, over a less important line, or into the queue.
      const busy = voiceBusy();
      let displaced: VoiceLine | undefined;
      if (busy && channel !== null && rank <= channel.line.priority && waiting.length >= VOICE_QUEUE_MAX) {
        for (const w of waiting) if (displaced === undefined || w.priority < displaced.priority) displaced = w;
        if (displaced === undefined || displaced.priority >= rank) return false;
      }

      const line: VoiceLine = {
        entry: entry("pending"),
        key,
        spoken,
        hasFile,
        priority: rank,
        requestedAt: t,
        requestCtxTime: ctx.currentTime,
        delayMs: delay,
      };
      pushLog(line.entry);
      // Start fetching now, so a line that waits in the queue is decoded by its turn.
      if (hasFile) void load(key);

      if (!busy) {
        begin(line);
      } else if (channel !== null && rank > channel.line.priority) {
        cut(channel);
        begin(line);
      } else {
        if (displaced !== undefined) {
          setOutcome(displaced, "dropped");
          waiting = waiting.filter((w) => w !== displaced);
        }
        waiting.push(line);
      }
      return true;
    } catch {
      return false;
    }
  }

  function preloadVoices(keys: readonly VoiceKey[]): void {
    try {
      if (ctx === null || disposed) return;
      if (!voiceWanted()) return;
      if (busy) {
        heldPreload = [...keys];
        return;
      }
      let started = 0;
      for (const key of keys) {
        if (!Object.hasOwn(manifest.files, key)) continue;
        if (decoded.has(key)) {
          load(key); // a cache hit: only marks it recently used
          continue;
        }
        if (started >= VOICE_PRELOAD_MAX) continue;
        void load(key);
        started += 1;
      }
      if (running()) schedulePrefetch();
    } catch {
      // Preloading is best effort.
    }
  }

  function setBusy(next: boolean): void {
    try {
      if (busy === next) return;
      busy = next;
      if (busy || disposed) return;
      const held = heldPreload;
      heldPreload = null;
      if (held !== null) preloadVoices(held);
      pumpPrefetch();
    } catch {
      // Background loading is best effort.
    }
  }

  /* ----- lifetime ----- */

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    for (const id of timers) clearTimeout(id);
    timers.clear();
    unsubscribe?.();
    unsubscribe = null;
    if (channel?.phase === "speaking") {
      try {
        speech?.cancel();
      } catch {
        // Nothing to stop.
      }
    }
    channel = null;
    waiting = [];
    heldPreload = null;
    prefetchRest = null;
    if (ctx !== null) {
      try {
        void ctx.close().catch(() => {});
      } catch {
        // Already closed.
      }
    }
  }

  return {
    state,
    unlock,
    playSfx,
    playVoice,
    preloadVoices,
    setBusy,
    log: () => entries.slice(),
    clearLog: () => {
      entries = [];
    },
    contextsCreated: () => created,
    dispose,
  };
}

/* ------------------------------------------------------------------------------------------- *
 * The singleton
 * ------------------------------------------------------------------------------------------- */

let singleton: AudioEngine | null = null;

/** The module singleton every hook and component uses; created on first call with default options. */
export function getAudioEngine(): AudioEngine {
  if (singleton === null) singleton = createAudioEngine();
  return singleton;
}

/** Replace (or with null, drop) the singleton. Tests only. */
export function setAudioEngineForTests(engine: AudioEngine | null): void {
  singleton = engine;
}
