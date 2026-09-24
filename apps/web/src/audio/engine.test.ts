// The audio engine against a fake Web Audio context (docs/polish/2-sound.md, B1 and B3 to B11).
//
// Every clock the engine may read moves together through `elapse`/`tick`: the injected `now`, each
// fake context's `currentTime` (which fires `onended` as sources finish), and vitest's fake timers.
// So a test holds whichever of the three an implementation happens to use.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  GAIN_SMOOTHING_S,
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
} from "./constants.ts";
import { audibleSpan, createAudioEngine, getAudioEngine, setAudioEngineForTests, type AudioEngineOptions } from "./engine.ts";
import { LIMITER } from "./mix.ts";
import { resetAudioSettingsForTests, writeAudioSettings } from "./settings.ts";
import { SFX, SFX_IDS } from "./sfx.ts";
import {
  FakeClock,
  FakeFetch,
  fakeContextFactory,
  fakeSpeech,
  settle,
  type FakeAudio,
  type FakeContextFactory,
  type FakeNode,
  type FakeSpeech,
} from "./test/fakeAudio.ts";
import type { AudioEngine, PlayedCue, SfxId, VoiceKey, VoiceLineTable, VoiceManifest } from "./types.ts";

/* --------------------------------------------------------------------------------------------- *
 * Fixtures
 * --------------------------------------------------------------------------------------------- */

/** Distinct levels, so the sfx and voice buses can be told apart by their gain. */
const LEVELS = { master: 0.5, sfx: 0.3, voice: 0.7 } as const;

const LINES: VoiceLineTable = {
  version: 1,
  personas: {
    hustler: { say: "Rocko (English (US))", rate: 215, pbas: 50, pmod: 45, web: { pitch: 1.1, rate: 1.15 } },
    narrator: { say: "Eddy (English (UK))", rate: 185, pbas: 45, pmod: 35, web: { pitch: 0.9, rate: 0.95 } },
  },
  cards: {
    "core-004": { kind: "unit", persona: "hustler", play: "Double or nothing, baby!", death: "House always wins." },
    "core-005": { kind: "spell", persona: "narrator", cast: "Hoarding is self care." },
    "core-008": { kind: "unit", persona: "narrator", play: "Hello. I am very normal.", death: "Plain. Simple. Gone." },
  },
};

const FILE = { hash: "0123456789abcdef", bytes: 9_000 };

/** core-004 and core-008 have files; core-005's cast line does not, so it takes the speech path. */
const MANIFEST: VoiceManifest = {
  version: 1,
  format: "m4af aac@22050 mono 32000",
  files: {
    "core-004-play": FILE,
    "core-004-death": FILE,
    "core-008-play": FILE,
    "core-008-death": FILE,
  },
};

const PRELOAD_KEYS: VoiceKey[] = Array.from({ length: 30 }, (_, i) => `core-2${String(i).padStart(2, "0")}-play` as VoiceKey);
/** More keys than the decoded cache holds, for B51. */
const MANY_KEYS: VoiceKey[] = Array.from({ length: VOICE_DECODED_MAX + 4 }, (_, i) => `core-3${String(i).padStart(2, "0")}-play` as VoiceKey);

const PRELOAD_MANIFEST: VoiceManifest = {
  ...MANIFEST,
  files: { ...MANIFEST.files, ...Object.fromEntries(PRELOAD_KEYS.map((key) => [key, FILE])) },
};

const MANY_MANIFEST: VoiceManifest = {
  ...MANIFEST,
  files: { ...MANIFEST.files, ...Object.fromEntries(MANY_KEYS.map((key) => [key, FILE])) },
};

const url = (key: string): string => `/audio/voice/${key}.m4a`;

/* --------------------------------------------------------------------------------------------- *
 * The rig
 * --------------------------------------------------------------------------------------------- */

type Rig = {
  engine: AudioEngine;
  factory: FakeContextFactory;
  fetch: FakeFetch;
  speech: FakeSpeech;
  clock: FakeClock;
  page: { visibility: DocumentVisibilityState };
};

const engines: AudioEngine[] = [];

function rig(options: { factory?: FakeContextFactory; engine?: Partial<AudioEngineOptions> } = {}): Rig {
  const factory = options.factory ?? fakeContextFactory({ state: "suspended", resumeMode: "run" });
  const fetch = new FakeFetch();
  const speech = fakeSpeech();
  const clock = new FakeClock(10_000);
  const page: { visibility: DocumentVisibilityState } = { visibility: "visible" };
  const engine = createAudioEngine({
    createContext: factory.create,
    speech: speech.port,
    fetchBytes: fetch.fetchBytes,
    now: clock.now,
    visibility: () => page.visibility,
    lines: LINES,
    manifest: MANIFEST,
    ...options.engine,
  });
  engines.push(engine);
  return { engine, factory, fetch, speech, clock, page };
}

/** Unlocks and hands back the one context it built. */
function unlocked(r: Rig): FakeAudio {
  r.engine.unlock();
  return r.factory.last();
}

/** Moves every clock the engine can read, then lets settled promises run. */
async function elapse(r: Rig, ms: number): Promise<void> {
  r.clock.advance(ms);
  for (const audio of r.factory.made) audio.advance(ms / 1000);
  await vi.advanceTimersByTimeAsync(ms);
  await settle();
}

/** The synchronous `elapse`, for loops of SFX that need no promise to settle. */
function tick(r: Rig, ms: number): void {
  r.clock.advance(ms);
  for (const audio of r.factory.made) audio.advance(ms / 1000);
  vi.advanceTimersByTime(ms);
}

function must<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) throw new Error(`expected ${what}`);
  return value;
}

type Buses = { compressor: FakeNode; master: FakeNode; sfx: FakeNode; voice: FakeNode };

/** The graph unlock() builds: sfx and voice → master → compressor → destination. */
function buses(audio: FakeAudio): Buses {
  const compressors = audio.nodesOf("compressor");
  expect(compressors, "one DynamicsCompressor").toHaveLength(1);
  const compressor = must(compressors[0], "the compressor");
  const masters = audio.inputsOf(compressor).filter((n) => n.kind === "gain");
  expect(masters, "one master gain into the compressor").toHaveLength(1);
  const master = must(masters[0], "the master gain");
  const feeds = audio.inputsOf(master).filter((n) => n.kind === "gain");
  const near = (n: FakeNode, level: number): boolean => Math.abs(n.param("gain").settled() - level) < 1e-6;
  const sfx = feeds.filter((n) => near(n, LEVELS.sfx));
  const voice = feeds.filter((n) => near(n, LEVELS.voice));
  expect(sfx, "one sfx bus into master, at the sfx level").toHaveLength(1);
  expect(voice, "one voice bus into master, at the voice level").toHaveLength(1);
  return { compressor, master, sfx: must(sfx[0], "the sfx bus"), voice: must(voice[0], "the voice bus") };
}

type VoiceCue = Extract<PlayedCue, { kind: "voice" }>;

function voiceEntries(r: Rig): VoiceCue[] {
  return r.engine.log().filter((c): c is VoiceCue => c.kind === "voice");
}

function lastVoice(r: Rig): VoiceCue | undefined {
  return voiceEntries(r).at(-1);
}

/** Buffer sources that have been started and can be heard through the voice bus. */
function voiceSources(audio: FakeAudio, voiceBus: FakeNode): FakeNode[] {
  return audio.startedSources().filter((n) => n.kind === "bufferSource" && audio.reaches(n, voiceBus));
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  resetAudioSettingsForTests();
  writeAudioSettings({ ...LEVELS, muted: false, voiceOn: true });
});

afterEach(() => {
  for (const engine of engines.splice(0)) {
    try {
      engine.dispose();
    } catch {
      // A dispose that throws is not what these tests are about.
    }
  }
  setAudioEngineForTests(null);
  resetAudioSettingsForTests();
  localStorage.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/* --------------------------------------------------------------------------------------------- *
 * B1 and B3: before a gesture, and with no Web Audio at all
 * --------------------------------------------------------------------------------------------- */

describe("B1 nothing exists before the first gesture", () => {
  it("B1 builds no AudioContext, refuses every cue and logs nothing until unlock()", async () => {
    const r = rig();

    expect(r.engine.state()).toBe("locked");
    expect(r.engine.playSfx("draw")).toBe(false);
    expect(r.engine.playSfx("impact", { amount: 3 }, 100)).toBe(false);
    expect(r.engine.playVoice("core-004", "play")).toBe(false);
    expect(r.engine.playVoice("core-005", "cast", 150)).toBe(false);
    r.engine.preloadVoices(["core-004-play", "core-008-death"]);
    await elapse(r, 5_000);

    expect(r.factory.create).not.toHaveBeenCalled();
    expect(r.engine.contextsCreated()).toBe(0);
    expect(r.engine.state()).toBe("locked");
    expect(r.engine.log()).toEqual([]);
    expect(r.fetch.fetchBytes).not.toHaveBeenCalled();
    expect(r.speech.speak).not.toHaveBeenCalled();
  });

  it("B1 the first unlock() builds exactly one context and leaves the locked state", () => {
    const r = rig();
    r.engine.unlock();

    expect(r.factory.create).toHaveBeenCalledTimes(1);
    expect(r.engine.contextsCreated()).toBe(1);
    expect(r.engine.state()).not.toBe("locked");
    expect(r.engine.state()).not.toBe("unsupported");
  });
});

describe("B3 with no Web Audio every call is a refused no-op", () => {
  it("B3 createContext: null is unsupported, and unlock and every play call do nothing", async () => {
    const r = rig({ engine: { createContext: null } });

    expect(r.engine.state()).toBe("unsupported");
    expect(() => r.engine.unlock()).not.toThrow();
    expect(r.engine.state()).toBe("unsupported");
    expect(r.engine.playSfx("draw")).toBe(false);
    expect(r.engine.playSfx("victory", {}, 0)).toBe(false);
    expect(r.engine.playVoice("core-004", "play", 150)).toBe(false);
    expect(r.engine.playVoice("core-005", "cast")).toBe(false);
    expect(() => r.engine.preloadVoices(["core-004-play"])).not.toThrow();
    await elapse(r, 5_000);

    expect(r.engine.log()).toEqual([]);
    expect(r.engine.contextsCreated()).toBe(0);
    expect(r.fetch.fetchBytes).not.toHaveBeenCalled();
    expect(r.speech.speak).not.toHaveBeenCalled();
  });

  it("B3 jsdom has no AudioContext, so a default engine and the singleton are unsupported", () => {
    const w = window as Window & { AudioContext?: unknown; webkitAudioContext?: unknown };
    expect(w.AudioContext, "jsdom provides no AudioContext").toBeUndefined();
    expect(w.webkitAudioContext).toBeUndefined();

    const engine = createAudioEngine();
    engines.push(engine);
    expect(engine.state()).toBe("unsupported");
    expect(() => engine.unlock()).not.toThrow();
    expect(engine.playSfx("uiClick")).toBe(false);
    expect(engine.playVoice("core-004", "play")).toBe(false);
    expect(engine.log()).toEqual([]);

    setAudioEngineForTests(null);
    const single = getAudioEngine();
    expect(getAudioEngine()).toBe(single);
    expect(single.state()).toBe("unsupported");
    expect(single.contextsCreated()).toBe(0);
  });

  it("B3 setAudioEngineForTests replaces the singleton, and null drops it", () => {
    const r = rig();
    setAudioEngineForTests(r.engine);
    expect(getAudioEngine()).toBe(r.engine);

    setAudioEngineForTests(null);
    const fresh = getAudioEngine();
    expect(fresh).not.toBe(r.engine);
    expect(fresh.state()).toBe("unsupported");
  });
});

/* --------------------------------------------------------------------------------------------- *
 * B4: the graph and its gains
 * --------------------------------------------------------------------------------------------- */

describe("B4 the bus graph", () => {
  it("B4 unlock wires sfx and voice buses into master, master into a compressor, and that into the destination", () => {
    const r = rig();
    const audio = unlocked(r);
    const bus = buses(audio);

    expect(bus.compressor.connections).toContain(audio.destination);
    expect(bus.master.connections).toContain(bus.compressor);
    expect(bus.sfx.connections).toContain(bus.master);
    expect(bus.voice.connections).toContain(bus.master);
    expect(bus.master.param("gain").settled()).toBeCloseTo(LEVELS.master, 6);
    expect(bus.sfx.param("gain").settled()).toBeCloseTo(LEVELS.sfx, 6);
    expect(bus.voice.param("gain").settled()).toBeCloseTo(LEVELS.voice, 6);
    expect(audio.violations).toEqual([]);
  });

  it("B4 the master DynamicsCompressor is set as a hard-knee limiter (mix.ts LIMITER), not the default 30 dB knee", () => {
    const audio = unlocked(rig());
    const { compressor } = buses(audio);

    expect(compressor.param("threshold").settled()).toBeCloseTo(LIMITER.thresholdDb, 6);
    expect(compressor.param("knee").settled()).toBeCloseTo(LIMITER.kneeDb, 6);
    expect(compressor.param("ratio").settled()).toBeCloseTo(LIMITER.ratio, 6);
    expect(compressor.param("attack").settled()).toBeCloseTo(LIMITER.attackS, 6);
    expect(compressor.param("release").settled()).toBeCloseTo(LIMITER.releaseS, 6);
    expect(LIMITER.kneeDb, "a hard knee: a lone cue passes untouched").toBe(0);
  });

  it("B4 muted holds the master bus at 0 while the sfx and voice buses keep their levels", () => {
    writeAudioSettings({ muted: true });
    const audio = unlocked(rig());
    const bus = buses(audio);

    expect(bus.master.param("gain").settled()).toBe(0);
    expect(bus.sfx.param("gain").settled()).toBeCloseTo(LEVELS.sfx, 6);
    expect(bus.voice.param("gain").settled()).toBeCloseTo(LEVELS.voice, 6);
  });

  it("B4 a later writeAudioSettings reaches each live bus through setTargetAtTime", () => {
    const audio = unlocked(rig());
    const bus = buses(audio);
    audio.currentTime = 7.25;

    const lastTarget = (node: FakeNode) => node.param("gain").targets().at(-1);

    writeAudioSettings({ master: 0.2 });
    expect(lastTarget(bus.master)).toMatchObject({ time: 7.25, timeConstant: GAIN_SMOOTHING_S });
    expect(lastTarget(bus.master)?.value).toBeCloseTo(0.2, 6);

    writeAudioSettings({ sfx: 0.9 });
    expect(lastTarget(bus.sfx)).toMatchObject({ time: 7.25, timeConstant: GAIN_SMOOTHING_S });
    expect(lastTarget(bus.sfx)?.value).toBeCloseTo(0.9, 6);

    writeAudioSettings({ voice: 0.1 });
    expect(lastTarget(bus.voice)).toMatchObject({ time: 7.25, timeConstant: GAIN_SMOOTHING_S });
    expect(lastTarget(bus.voice)?.value).toBeCloseTo(0.1, 6);

    writeAudioSettings({ muted: true });
    expect(lastTarget(bus.master)).toMatchObject({ value: 0, time: 7.25, timeConstant: GAIN_SMOOTHING_S });

    writeAudioSettings({ muted: false });
    expect(lastTarget(bus.master)?.value).toBeCloseTo(0.2, 6);
    expect(audio.violations).toEqual([]);
  });
});

/* --------------------------------------------------------------------------------------------- *
 * B5: the acceptance gate and the log
 * --------------------------------------------------------------------------------------------- */

describe("B5 the acceptance gate", () => {
  it("B5 an accepted sfx returns true, is logged, and plays through the sfx bus from currentTime + delayMs/1000", () => {
    const r = rig();
    const audio = unlocked(r);
    const bus = buses(audio);
    audio.currentTime = 2;
    const before = audio.nodes.length;

    expect(r.engine.playSfx("impact", { amount: 4 }, 250)).toBe(true);

    expect(r.engine.log().at(-1)).toMatchObject({ kind: "sfx", id: "impact", params: { amount: 4 }, delayMs: 250 });
    const sources = audio.nodes.slice(before).filter((n) => n.started);
    expect(sources.length, "the recipe started at least one source").toBeGreaterThan(0);
    for (const source of sources) {
      expect(must(source.startTime, "a start time")).toBeGreaterThanOrEqual(2.25 - 1e-9);
      expect(audio.reaches(source, bus.sfx), `${source.kind} is heard through the sfx bus`).toBe(true);
      expect(audio.reaches(source, bus.voice), `${source.kind} stays off the voice bus`).toBe(false);
    }
    expect(audio.violations).toEqual([]);
  });

  it("B5 while muted playSfx and playVoice return false and log nothing", async () => {
    const r = rig();
    unlocked(r);
    writeAudioSettings({ muted: true });

    expect(r.engine.playSfx("draw")).toBe(false);
    expect(r.engine.playVoice("core-004", "play", 0)).toBe(false);
    expect(r.engine.playVoice("core-005", "cast", 0)).toBe(false);
    await elapse(r, 1_000);

    expect(r.engine.log()).toEqual([]);
    expect(r.fetch.fetchBytes).not.toHaveBeenCalled();
    expect(r.speech.speak).not.toHaveBeenCalled();
  });

  it("B5 while the page is hidden playSfx and playVoice return false and log nothing, and accept again once visible", () => {
    const r = rig();
    unlocked(r);
    r.page.visibility = "hidden";

    expect(r.engine.playSfx("draw")).toBe(false);
    expect(r.engine.playVoice("core-004", "play")).toBe(false);
    expect(r.engine.log()).toEqual([]);

    r.page.visibility = "visible";
    expect(r.engine.playSfx("draw")).toBe(true);
    expect(r.engine.log()).toHaveLength(1);
  });

  it("B5 voiceOn false refuses playVoice but still accepts playSfx", async () => {
    const r = rig();
    unlocked(r);
    writeAudioSettings({ voiceOn: false });

    expect(r.engine.playVoice("core-004", "play", 0)).toBe(false);
    expect(r.engine.playVoice("core-005", "cast", 0)).toBe(false);
    await elapse(r, 1_000);
    expect(voiceEntries(r)).toEqual([]);
    expect(r.speech.speak).not.toHaveBeenCalled();

    expect(r.engine.playSfx("summon")).toBe(true);
    expect(r.engine.log().map((c) => c.kind)).toEqual(["sfx"]);
  });

  it("B5 a closed context refuses every cue", () => {
    const r = rig();
    const audio = unlocked(r);
    audio.state = "closed";

    expect(r.engine.state()).toBe("closed");
    expect(r.engine.playSfx("draw")).toBe(false);
    expect(r.engine.playVoice("core-004", "play")).toBe(false);
    expect(r.engine.log()).toEqual([]);
  });

  it("B5 a suspended context still accepts and logs cues, so a device with no output still records them (B46)", () => {
    const r = rig({ factory: fakeContextFactory({ state: "suspended", resumeMode: "stay" }) });
    unlocked(r);

    expect(r.engine.state()).toBe("suspended");
    expect(r.engine.playSfx("attack")).toBe(true);
    expect(r.engine.playVoice("core-004", "play", 150)).toBe(true);
    expect(r.engine.log().map((c) => c.kind)).toEqual(["sfx", "voice"]);
  });

  it("B5 the log keeps only the last LOG_LIMIT accepted cues, oldest first", () => {
    const r = rig();
    unlocked(r);
    const total = LOG_LIMIT + 5;

    for (let i = 0; i < total; i += 1) {
      tick(r, 2_000);
      expect(r.engine.playSfx("uiClick", undefined, i), `cue ${String(i)}`).toBe(true);
    }

    const log = r.engine.log();
    expect(log).toHaveLength(LOG_LIMIT);
    expect(log.map((c) => c.delayMs)).toEqual(Array.from({ length: LOG_LIMIT }, (_, k) => k + 5));
  });

  it("B5 clearLog empties the log", () => {
    const r = rig();
    unlocked(r);
    r.engine.playSfx("draw");
    r.engine.clearLog();
    expect(r.engine.log()).toEqual([]);
  });
});

/* --------------------------------------------------------------------------------------------- *
 * B6: SFX retrigger and polyphony
 * --------------------------------------------------------------------------------------------- */

describe("B6 SFX limits", () => {
  it("B6 the same id again within SFX_RETRIGGER_MS is refused and not logged, while another id is accepted", () => {
    const r = rig();
    unlocked(r);

    expect(r.engine.playSfx("draw")).toBe(true);
    tick(r, SFX_RETRIGGER_MS - 1);
    expect(r.engine.playSfx("draw")).toBe(false);
    expect(r.engine.playSfx("draw", { amount: 2 }, 50)).toBe(false);
    expect(r.engine.playSfx("play")).toBe(true);

    expect(r.engine.log().map((c) => (c.kind === "sfx" ? c.id : c.defId))).toEqual(["draw", "play"]);
  });

  it("B6 the same id is accepted again once SFX_RETRIGGER_MS has passed", () => {
    const r = rig();
    unlocked(r);

    expect(r.engine.playSfx("draw")).toBe(true);
    tick(r, SFX_RETRIGGER_MS);
    expect(r.engine.playSfx("draw")).toBe(true);
    expect(r.engine.log()).toHaveLength(2);
  });

  it("B6 with SFX_MAX_VOICES cues still sounding the next cue is refused, and accepted once they end", () => {
    const r = rig();
    unlocked(r);
    const ids: SfxId[] = [...SFX_IDS].sort((a, b) => SFX[b].durationMs - SFX[a].durationMs).slice(0, SFX_MAX_VOICES + 1);
    const extra = must(ids.pop(), "one id beyond the cap");

    for (const id of ids) expect(r.engine.playSfx(id), id).toBe(true);
    expect(r.engine.playSfx(extra)).toBe(false);
    expect(r.engine.log()).toHaveLength(SFX_MAX_VOICES);

    tick(r, Math.max(...SFX_IDS.map((id) => SFX[id].durationMs)) + 50);
    expect(r.engine.playSfx(extra)).toBe(true);
    expect(r.engine.log()).toHaveLength(SFX_MAX_VOICES + 1);
  });

  it("B6 a cue's delay counts toward how long it is still sounding", () => {
    const r = rig();
    unlocked(r);
    const longest = Math.max(...SFX_IDS.map((id) => SFX[id].durationMs));
    const ids = SFX_IDS.slice(0, SFX_MAX_VOICES + 1);
    const extra = must(ids.at(-1), "one id beyond the cap");

    for (const id of ids.slice(0, SFX_MAX_VOICES)) expect(r.engine.playSfx(id, {}, 5_000), id).toBe(true);
    // Every recipe would have finished by now had it started at once; each was delayed by 5 s.
    tick(r, longest + 50);
    expect(r.engine.playSfx(extra)).toBe(false);

    tick(r, 5_000);
    expect(r.engine.playSfx(extra)).toBe(true);
  });
});

/* --------------------------------------------------------------------------------------------- *
 * B7 to B10: voice lines
 * --------------------------------------------------------------------------------------------- */

describe("B7 one voice at a time, and a short queue behind it", () => {
  it("B7 an equal-priority request while a line is pending waits, logged pending, and starts once the channel frees", async () => {
    const r = rig();
    unlocked(r);
    r.fetch.mode = "hang";

    expect(r.engine.playVoice("core-004", "play", 0)).toBe(true);
    await settle();
    expect(r.engine.playVoice("core-008", "play", 0)).toBe(true);
    expect(voiceEntries(r).map((e) => e.outcome)).toEqual(["pending", "pending"]);

    r.fetch.release();
    await settle();
    expect(voiceEntries(r).map((e) => e.outcome), "the first line starts; the second still waits").toEqual(["file", "pending"]);

    await elapse(r, 1_050);
    expect(voiceEntries(r).map((e) => e.outcome), "the first line ended and the waiting one took over").toEqual(["file", "file"]);
  });

  it("B7 at most VOICE_QUEUE_MAX lines wait; one more of no higher priority is refused and not logged", async () => {
    const r = rig();
    unlocked(r);
    r.fetch.mode = "hang";

    expect(r.engine.playVoice("core-004", "play", 0)).toBe(true);
    for (let i = 0; i < VOICE_QUEUE_MAX; i += 1) expect(r.engine.playVoice("core-008", "death", 0, VOICE_PRIORITY.play), `waiter ${String(i)}`).toBe(true);
    expect(r.engine.playVoice("core-005", "cast", 0)).toBe(false);
    expect(r.engine.playVoice("core-004", "death", 0, VOICE_PRIORITY.summon)).toBe(false);

    expect(voiceEntries(r)).toHaveLength(1 + VOICE_QUEUE_MAX);
  });

  it("B7 a file line holds the channel until its buffer has played", async () => {
    const r = rig();
    unlocked(r);

    expect(r.engine.playVoice("core-004", "play", 0)).toBe(true);
    await settle();
    expect(lastVoice(r)?.outcome).toBe("file");

    await elapse(r, 500);
    expect(r.engine.playVoice("core-008", "death", 0, VOICE_PRIORITY.play), "accepted into the queue").toBe(true);
    await settle();
    expect(lastVoice(r)?.outcome, "the 1 s line is still sounding, so it waits").toBe("pending");

    await elapse(r, 600);
    expect(lastVoice(r)?.outcome, "the line has ended and the waiting one plays").toBe("file");
  });

  it("B7 a spoken line holds the channel until the speech port reports its end", async () => {
    const r = rig();
    unlocked(r);

    expect(r.engine.playVoice("core-005", "cast", 0)).toBe(true);
    await elapse(r, 10);
    expect(r.speech.spoken).toHaveLength(1);
    expect(r.engine.playVoice("core-004", "play", 0)).toBe(true);
    await elapse(r, 1_000);
    expect(lastVoice(r)?.outcome, "still speaking, so it waits").toBe("pending");

    must(r.speech.spoken[0], "the spoken line").onEnd();
    await settle();
    expect(lastVoice(r)?.outcome).toBe("file");
  });

  it("B7 a spoken line that never ends frees the channel after VOICE_SPEECH_MAX_MS", async () => {
    const r = rig();
    unlocked(r);

    expect(r.engine.playVoice("core-005", "cast", 0)).toBe(true);
    await elapse(r, VOICE_SPEECH_MAX_MS - 100);
    expect(r.engine.playVoice("core-004", "play", 0)).toBe(true);
    await settle();
    expect(lastVoice(r)?.outcome).toBe("pending");

    await elapse(r, 200);
    expect(lastVoice(r)?.outcome).toBe("file");
  });
});

describe("B8 voice files", () => {
  it("B8 a manifest line is fetched from /audio/voice/<defId>-<line>.m4a, decoded, and started on the voice bus at currentTime + delayMs/1000", async () => {
    const r = rig();
    const audio = unlocked(r);
    const bus = buses(audio);
    audio.currentTime = 3;

    expect(r.engine.playVoice("core-004", "play", 150)).toBe(true);
    await settle();

    expect(r.fetch.urls()).toEqual([url("core-004-play")]);
    expect(audio.decodeCalls).toHaveLength(1);
    const started = voiceSources(audio, bus.voice);
    expect(started).toHaveLength(1);
    const line = must(started[0], "the line's buffer source");
    expect(line.startTime).toBeCloseTo(3.15, 6);
    expect(line.buffer?.duration).toBeCloseTo(1, 6);
    expect(audio.reaches(line, bus.sfx)).toBe(false);
    expect(lastVoice(r)).toMatchObject({ kind: "voice", defId: "core-004", line: "play", delayMs: 150, outcome: "file" });
    expect(r.speech.speak).not.toHaveBeenCalled();
    expect(audio.violations).toEqual([]);
  });

  it("B8 the log entry reads pending until the line starts, then file", async () => {
    const r = rig();
    unlocked(r);
    r.fetch.mode = "hang";

    expect(r.engine.playVoice("core-008", "death", 120)).toBe(true);
    await settle();
    expect(lastVoice(r)).toMatchObject({ kind: "voice", defId: "core-008", line: "death", delayMs: 120, outcome: "pending" });

    expect(r.fetch.release()).toBe(1);
    await settle();
    expect(lastVoice(r)?.outcome).toBe("file");
    expect(voiceEntries(r)).toHaveLength(1);
  });

  it("B8 a second play of the same key reuses the buffer and makes no second fetch", async () => {
    const r = rig();
    const audio = unlocked(r);
    const bus = buses(audio);

    expect(r.engine.playVoice("core-004", "play", 0)).toBe(true);
    await settle();
    await elapse(r, 1_500);
    expect(r.engine.playVoice("core-004", "play", 0)).toBe(true);
    await settle();

    expect(r.fetch.fetchBytes).toHaveBeenCalledTimes(1);
    expect(audio.decodeCalls).toHaveLength(1);
    expect(voiceSources(audio, bus.voice)).toHaveLength(2);
    expect(voiceEntries(r).map((e) => e.outcome)).toEqual(["file", "file"]);
  });
});

describe("B9 the speech fallback", () => {
  it("B9 a key missing from the manifest is spoken after its delay, with its text, the persona's web voice and master × voice volume", async () => {
    const r = rig();
    unlocked(r);

    expect(r.engine.playVoice("core-005", "cast", 150)).toBe(true);
    await settle();
    expect(r.speech.speak, "not before the delay").not.toHaveBeenCalled();

    await elapse(r, 150);
    expect(r.speech.spoken).toHaveLength(1);
    const said = must(r.speech.spoken[0], "a spoken line");
    expect(said.text).toBe("Hoarding is self care.");
    expect(said.voice.pitch).toBeCloseTo(0.9, 6);
    expect(said.voice.rate).toBeCloseTo(0.95, 6);
    expect(said.voice.volume).toBeCloseTo(LEVELS.master * LEVELS.voice, 6);
    expect(r.fetch.fetchBytes).not.toHaveBeenCalled();
    expect(lastVoice(r)).toMatchObject({ defId: "core-005", line: "cast", outcome: "speech" });
  });

  it("B9 a manifest key whose fetch rejects is spoken instead, and the failed load is not fetched again", async () => {
    const r = rig();
    unlocked(r);
    r.fetch.mode = "reject";

    expect(r.engine.playVoice("core-004", "play", 0)).toBe(true);
    await elapse(r, 10);
    expect(r.speech.spoken.map((s) => s.text)).toEqual(["Double or nothing, baby!"]);
    const said = must(r.speech.spoken[0], "a spoken line");
    expect(said.voice.pitch).toBeCloseTo(1.1, 6);
    expect(said.voice.rate).toBeCloseTo(1.15, 6);
    expect(said.voice.volume).toBeCloseTo(LEVELS.master * LEVELS.voice, 6);
    expect(lastVoice(r)?.outcome).toBe("speech");

    said.onEnd();
    await settle();
    expect(r.engine.playVoice("core-004", "play", 0)).toBe(true);
    await elapse(r, 10);
    expect(r.fetch.fetchBytes).toHaveBeenCalledTimes(1);
    expect(r.speech.spoken).toHaveLength(2);
  });

  it("B9 a manifest key whose decode rejects is spoken instead", async () => {
    const r = rig();
    const audio = unlocked(r);
    audio.decodeMode = "reject";

    expect(r.engine.playVoice("core-008", "death", 0)).toBe(true);
    await elapse(r, 10);

    expect(r.speech.spoken.map((s) => s.text)).toEqual(["Plain. Simple. Gone."]);
    expect(lastVoice(r)?.outcome).toBe("speech");
  });

  it("B9 with no speech port a line with no file ends failed, and nothing throws", async () => {
    const r = rig({ engine: { speech: null } });
    unlocked(r);

    expect(r.engine.playVoice("core-005", "cast", 150)).toBe(true);
    await elapse(r, 500);

    expect(lastVoice(r)).toMatchObject({ defId: "core-005", line: "cast", outcome: "failed" });
  });

  it("B9 with no speech port a file that fails to load ends failed", async () => {
    const r = rig({ engine: { speech: null } });
    unlocked(r);
    r.fetch.mode = "reject";

    expect(r.engine.playVoice("core-004", "death", 0)).toBe(true);
    await elapse(r, 500);

    expect(lastVoice(r)?.outcome).toBe("failed");
  });
});

describe("B10 late lines are dropped", () => {
  it("B10 a buffer not ready VOICE_LATE_MS after the request never starts, is logged late, and frees the channel", async () => {
    const r = rig();
    const audio = unlocked(r);
    const bus = buses(audio);
    r.fetch.mode = "hang";

    expect(r.engine.playVoice("core-004", "play", 0)).toBe(true);
    await elapse(r, VOICE_LATE_MS + 10);

    expect(lastVoice(r)).toMatchObject({ defId: "core-004", line: "play", outcome: "late" });
    expect(r.engine.playVoice("core-008", "play", 0), "the channel is free again").toBe(true);

    // The late file finally arrives: it still never plays.
    expect(r.fetch.release(url("core-004-play"))).toBe(1);
    await settle();
    expect(voiceSources(audio, bus.voice)).toEqual([]);
    expect(voiceEntries(r)[0]?.outcome).toBe("late");
  });

  it("B10 a buffer that arrives inside VOICE_LATE_MS still plays", async () => {
    const r = rig();
    const audio = unlocked(r);
    const bus = buses(audio);
    r.fetch.mode = "hang";

    expect(r.engine.playVoice("core-004", "play", 0)).toBe(true);
    await elapse(r, VOICE_LATE_MS - 200);
    r.fetch.release();
    await settle();

    expect(voiceSources(audio, bus.voice)).toHaveLength(1);
    expect(lastVoice(r)?.outcome).toBe("file");
  });
});

/* --------------------------------------------------------------------------------------------- *
 * B11: preloading
 * --------------------------------------------------------------------------------------------- */

describe("B11 preloadVoices", () => {
  it("B11 fetches nothing before unlock", async () => {
    const r = rig({ engine: { manifest: PRELOAD_MANIFEST } });

    r.engine.preloadVoices(PRELOAD_KEYS);
    await elapse(r, 1_000);

    expect(r.fetch.fetchBytes).not.toHaveBeenCalled();
    expect(r.factory.create).not.toHaveBeenCalled();
  });

  it("B11 after unlock it fetches at most VOICE_PRELOAD_MAX manifest keys per call, never one it requested before", async () => {
    const r = rig({ engine: { manifest: PRELOAD_MANIFEST } });
    unlocked(r);
    const outside: VoiceKey[] = ["core-005-cast", "core-999-play", "core-004-cast"];
    const keys = [...outside, ...PRELOAD_KEYS];

    r.engine.preloadVoices(keys);
    await settle();
    const first = r.fetch.urls();
    expect(first).toHaveLength(VOICE_PRELOAD_MAX);
    expect(new Set(first).size).toBe(VOICE_PRELOAD_MAX);
    for (const u of first) expect(PRELOAD_KEYS.map(url)).toContain(u);

    r.engine.preloadVoices(keys);
    await settle();
    const all = r.fetch.urls();
    expect(all).toHaveLength(PRELOAD_KEYS.length);
    expect(new Set(all)).toEqual(new Set(PRELOAD_KEYS.map(url)));

    r.engine.preloadVoices(keys);
    await settle();
    expect(r.fetch.urls()).toHaveLength(PRELOAD_KEYS.length);
  });

  it("B11 keys outside the manifest are never fetched", async () => {
    const r = rig();
    unlocked(r);

    r.engine.preloadVoices(["core-005-cast", "core-999-death", "hidden-play"]);
    await settle();

    expect(r.fetch.fetchBytes).not.toHaveBeenCalled();
  });

  it("B11 a key already played is not fetched again by a preload, and a preloaded key plays without a second fetch", async () => {
    const r = rig();
    unlocked(r);

    expect(r.engine.playVoice("core-004", "play", 0)).toBe(true);
    await settle();
    r.engine.preloadVoices(["core-004-play", "core-008-death"]);
    await settle();
    expect(r.fetch.urls()).toEqual([url("core-004-play"), url("core-008-death")]);

    await elapse(r, 1_500);
    expect(r.engine.playVoice("core-008", "death", 0)).toBe(true);
    await settle();
    expect(r.fetch.fetchBytes).toHaveBeenCalledTimes(2);
    expect(lastVoice(r)?.outcome).toBe("file");
  });
});

/* --------------------------------------------------------------------------------------------- *
 * B46: nothing is scheduled on a context that is not running
 * --------------------------------------------------------------------------------------------- */

describe("B46 a context that is not running schedules nothing", () => {
  for (const state of ["suspended", "interrupted"] as const) {
    it(`B46 while ${state}, cues are accepted and logged, flagged, but no node is built, nothing is fetched and no line holds the channel`, async () => {
      const r = rig({ factory: fakeContextFactory({ state, resumeMode: "stay" }) });
      const audio = unlocked(r);
      const nodesAfterUnlock = audio.nodes.length;

      for (let i = 0; i < 40; i += 1) {
        tick(r, 500);
        expect(r.engine.playSfx("impact", { amount: 5 }), `sfx ${String(i)}`).toBe(true);
        expect(r.engine.playVoice(i % 2 === 0 ? "core-004" : "core-008", "play", 150), `line ${String(i)}`).toBe(true);
      }
      await settle();

      expect(audio.nodes.length, "no node was built").toBe(nodesAfterUnlock);
      expect(r.fetch.fetchBytes).not.toHaveBeenCalled();
      const sfx = r.engine.log().filter((c) => c.kind === "sfx");
      expect(sfx).toHaveLength(40);
      expect(sfx.every((c) => c.kind === "sfx" && c.suspended === true)).toBe(true);
      expect(new Set(voiceEntries(r).map((e) => e.outcome))).toEqual(new Set(["suspended"]));
    });
  }

  it("B46 once the context runs, new cues schedule, and nothing requested while suspended ever starts", async () => {
    const r = rig({ factory: fakeContextFactory({ state: "suspended", resumeMode: "stay" }) });
    const audio = unlocked(r);
    const bus = buses(audio);
    expect(r.engine.playVoice("core-004", "play", 0)).toBe(true);
    expect(r.engine.playSfx("draw")).toBe(true);
    await settle();

    audio.state = "running";
    await elapse(r, 200);
    expect(voiceSources(audio, bus.voice), "the suspended line never starts").toEqual([]);

    expect(r.engine.playVoice("core-008", "play", 0)).toBe(true);
    await settle();
    expect(voiceSources(audio, bus.voice)).toHaveLength(1);
    expect(lastVoice(r)).toMatchObject({ defId: "core-008", outcome: "file" });
  });
});

/* --------------------------------------------------------------------------------------------- *
 * B47 and B48: priorities and the queue
 * --------------------------------------------------------------------------------------------- */

describe("B47 a more important line cuts in", () => {
  it("B47 a react line during a playing file line fades that line out and stops it within VOICE_FADE_S, then plays", async () => {
    const r = rig();
    const audio = unlocked(r);
    const bus = buses(audio);

    expect(r.engine.playVoice("core-004", "play", 0, VOICE_PRIORITY.play)).toBe(true);
    await settle();
    await elapse(r, 300);
    const [first] = voiceSources(audio, bus.voice);
    const firstSource = must(first, "the play line's source");
    const trim = must(firstSource.connections[0], "its persona gain");
    expect(trim).toBeInstanceOf(Object);

    const cutAt = audio.currentTime;
    expect(r.engine.playVoice("core-008", "death", 0, VOICE_PRIORITY.react)).toBe(true);
    await settle();

    const stop = must(firstSource.stopTime, "the cut line was stopped");
    expect(stop).toBeGreaterThanOrEqual(cutAt);
    expect(stop).toBeLessThanOrEqual(cutAt + VOICE_FADE_S + 1e-9);
    const fade = audio.paramLog.filter((p) => p.event.method === "setTargetAtTime" && p.event.value === 0 && p.param.node !== bus.voice && p.param.node !== bus.master);
    expect(fade.length, "the cut line's gain is faded to 0").toBeGreaterThan(0);
    expect(voiceSources(audio, bus.voice)).toHaveLength(2);
    expect(voiceEntries(r).map((e) => `${e.defId}-${e.line}:${e.outcome}`)).toEqual(["core-004-play:file", "core-008-death:file"]);
    expect(audio.violations).toEqual([]);
  });

  it("B47 a react line while a play line is still loading drops it: it never starts, even when its file arrives", async () => {
    const r = rig();
    const audio = unlocked(r);
    const bus = buses(audio);
    r.fetch.modes.set(url("core-004-play"), "hang");

    expect(r.engine.playVoice("core-004", "play", 0, VOICE_PRIORITY.play)).toBe(true);
    await settle();
    expect(r.engine.playVoice("core-008", "death", 0, VOICE_PRIORITY.react)).toBe(true);
    await settle();
    r.fetch.release(url("core-004-play"));
    await settle();

    expect(voiceEntries(r).map((e) => e.outcome)).toEqual(["dropped", "file"]);
    expect(voiceSources(audio, bus.voice)).toHaveLength(1);
  });

  it("B47 a react line during a spoken line cancels the speech", async () => {
    const r = rig();
    unlocked(r);

    expect(r.engine.playVoice("core-005", "cast", 0, VOICE_PRIORITY.play)).toBe(true);
    await elapse(r, 10);
    expect(r.speech.spoken).toHaveLength(1);
    expect(r.engine.playVoice("core-004", "death", 0, VOICE_PRIORITY.react)).toBe(true);
    await settle();

    expect(r.speech.cancel).toHaveBeenCalled();
    expect(lastVoice(r)?.outcome).toBe("file");
  });

  it("B47 a line of equal or lower priority never cuts in", async () => {
    const r = rig();
    const audio = unlocked(r);
    const bus = buses(audio);

    expect(r.engine.playVoice("core-004", "death", 0, VOICE_PRIORITY.react)).toBe(true);
    await settle();
    expect(r.engine.playVoice("core-008", "death", 0, VOICE_PRIORITY.react)).toBe(true);
    expect(r.engine.playVoice("core-008", "play", 0, VOICE_PRIORITY.summon)).toBe(true);
    await settle();

    const [first] = voiceSources(audio, bus.voice);
    expect(first?.stopTime ?? null).toBeNull();
    expect(voiceSources(audio, bus.voice)).toHaveLength(1);
  });

  it("B47 without a priority a line counts as a play line", async () => {
    const r = rig();
    unlocked(r);
    expect(r.engine.playVoice("core-004", "play")).toBe(true);
    expect(lastVoice(r)?.priority).toBe(VOICE_PRIORITY.play);
  });
});

describe("B48 the queue", () => {
  it("B48 when the channel frees, the most important waiting line starts first, the oldest on a tie", async () => {
    const r = rig();
    unlocked(r);

    expect(r.engine.playVoice("core-004", "death", 0, VOICE_PRIORITY.react)).toBe(true);
    await settle();
    expect(r.engine.playVoice("core-008", "play", 0, VOICE_PRIORITY.summon)).toBe(true);
    expect(r.engine.playVoice("core-008", "death", 0, VOICE_PRIORITY.react)).toBe(true);
    // Two steps, so the second line's own end timer is not swept up in the jump that ends the first.
    await elapse(r, 900);
    await elapse(r, 150);

    expect(voiceEntries(r).map((e) => `${e.defId}-${e.line}:${e.outcome}`)).toEqual([
      "core-004-death:file",
      "core-008-play:pending",
      "core-008-death:file",
    ]);
  });

  it("B48 a line that has waited longer than VOICE_QUEUE_WAIT_MS by the time the channel frees is dropped as late", async () => {
    const r = rig({ factory: fakeContextFactory({ state: "suspended", resumeMode: "run", decodedSeconds: 3 }) });
    const audio = unlocked(r);
    const bus = buses(audio);

    expect(r.engine.playVoice("core-004", "death", 0)).toBe(true);
    await settle();
    expect(r.engine.playVoice("core-008", "play", 0)).toBe(true);
    await elapse(r, VOICE_QUEUE_WAIT_MS + 1_600);

    expect(voiceEntries(r).map((e) => e.outcome)).toEqual(["file", "late"]);
    expect(voiceSources(audio, bus.voice)).toHaveLength(1);
  });

  it("B48 with the queue full, a more important line displaces the least important waiting one", async () => {
    const r = rig();
    unlocked(r);

    expect(r.engine.playVoice("core-004", "death", 0, VOICE_PRIORITY.react)).toBe(true);
    await settle();
    for (let i = 0; i < VOICE_QUEUE_MAX; i += 1) expect(r.engine.playVoice("core-008", "play", 0, VOICE_PRIORITY.summon)).toBe(true);
    expect(r.engine.playVoice("core-008", "death", 0, VOICE_PRIORITY.play)).toBe(true);

    const outcomes = voiceEntries(r).map((e) => `${e.line}!${String(e.priority)}:${e.outcome}`);
    expect(outcomes).toContain(`play!${String(VOICE_PRIORITY.summon)}:dropped`);
    expect(outcomes.filter((o) => o.endsWith(":pending"))).toHaveLength(VOICE_QUEUE_MAX);
  });
});

/* --------------------------------------------------------------------------------------------- *
 * B49: a rendered line plays and holds the channel for its audible span
 * --------------------------------------------------------------------------------------------- */

describe("B49 a rendered line's silent head and tail are skipped", () => {
  /** 2 s of silence with a tone from 0.30 s to 1.20 s. */
  const speechBetween = (samples: Float32Array, rate: number): void => {
    for (let i = Math.round(0.3 * rate); i < Math.round(1.2 * rate); i += 1) samples[i] = 0.25 * Math.sin(i / 7);
  };

  it("B49 start(at, offset, duration) covers the audible span, less VOICE_TRIM_LEAD_S before it and plus VOICE_TRIM_TAIL_S after", async () => {
    const r = rig({ factory: fakeContextFactory({ state: "suspended", resumeMode: "run", decodedSeconds: 2, decodedFill: speechBetween }) });
    const audio = unlocked(r);
    const bus = buses(audio);

    expect(r.engine.playVoice("core-004", "play", 0)).toBe(true);
    await settle();

    const line = must(voiceSources(audio, bus.voice)[0], "the line");
    expect(line.playDuration).not.toBeNull();
    const offset = 0.3 - VOICE_TRIM_LEAD_S;
    const length = 1.2 + VOICE_TRIM_TAIL_S - offset;
    expect(line.endTime() - must(line.startTime, "start")).toBeCloseTo(length, 2);
    expect(audibleSpan(must(line.buffer, "buffer").proxy)).toEqual({ offsetS: expect.closeTo(offset, 3) as number, lengthS: expect.closeTo(length, 2) as number });
  });

  it("B49 the channel frees at the end of the speech, not of the buffer", async () => {
    const r = rig({ factory: fakeContextFactory({ state: "suspended", resumeMode: "run", decodedSeconds: 2, decodedFill: speechBetween }) });
    unlocked(r);

    expect(r.engine.playVoice("core-004", "play", 0)).toBe(true);
    await settle();
    await elapse(r, 1_050);
    expect(r.engine.playVoice("core-008", "play", 0)).toBe(true);
    await settle();

    expect(lastVoice(r)?.outcome, "the channel was free well before the 2 s buffer ended").toBe("file");
  });

  it("B49 a buffer with no audible sample plays whole", async () => {
    const r = rig();
    const audio = unlocked(r);
    const bus = buses(audio);

    expect(r.engine.playVoice("core-004", "play", 0)).toBe(true);
    await settle();
    const line = must(voiceSources(audio, bus.voice)[0], "the line");
    expect(line.endTime() - must(line.startTime, "start")).toBeCloseTo(1, 6);
  });
});

/* --------------------------------------------------------------------------------------------- *
 * B50: mute and voice lines off stop the line that is speaking
 * --------------------------------------------------------------------------------------------- */

describe("B50 muting stops voice at once", () => {
  it("B50 muting cancels a spoken fallback line and drops every waiting line", async () => {
    const r = rig();
    unlocked(r);

    expect(r.engine.playVoice("core-005", "cast", 0)).toBe(true);
    await elapse(r, 10);
    expect(r.engine.playVoice("core-004", "play", 0)).toBe(true);
    writeAudioSettings({ muted: true });

    expect(r.speech.cancel).toHaveBeenCalled();
    expect(voiceEntries(r).map((e) => e.outcome)).toEqual(["speech", "dropped"]);
    writeAudioSettings({ muted: false });
    expect(r.engine.playVoice("core-008", "play", 0), "the channel is free").toBe(true);
    await settle();
    expect(lastVoice(r)?.outcome).toBe("file");
  });

  it("B50 turning voice lines off stops a playing file line and silences the voice bus", async () => {
    const r = rig();
    const audio = unlocked(r);
    const bus = buses(audio);

    expect(r.engine.playVoice("core-004", "play", 0)).toBe(true);
    await settle();
    const line = must(voiceSources(audio, bus.voice)[0], "the line");
    writeAudioSettings({ voiceOn: false });

    expect(line.stopTime).not.toBeNull();
    expect(bus.voice.param("gain").targets().at(-1)?.value).toBe(0);
    writeAudioSettings({ voiceOn: true });
    expect(bus.voice.param("gain").targets().at(-1)?.value).toBeCloseTo(LEVELS.voice, 6);
  });
});

/* --------------------------------------------------------------------------------------------- *
 * B51: the voice caches and the background prefetch
 * --------------------------------------------------------------------------------------------- */

describe("B51 caches and prefetch", () => {
  it("B51 at most VOICE_DECODED_MAX lines stay decoded; an evicted one decodes again from its bytes, with no second fetch", async () => {
    const r = rig({ engine: { manifest: MANY_MANIFEST } });
    const audio = unlocked(r);

    for (let i = 0; i < MANY_KEYS.length; i += VOICE_PRELOAD_MAX) r.engine.preloadVoices(MANY_KEYS.slice(i, i + VOICE_PRELOAD_MAX));
    await settle();
    expect(audio.decodeCalls).toHaveLength(MANY_KEYS.length);

    const evicted = must(MANY_KEYS[0], "the oldest key");
    const [defId] = [evicted.slice(0, -"-play".length)];
    expect(r.engine.playVoice(defId, "play", 0)).toBe(true);
    await settle();

    expect(audio.decodeCalls, "decoded again").toHaveLength(MANY_KEYS.length + 1);
    expect(r.fetch.urls().filter((u) => u === url(evicted)), "fetched once").toHaveLength(1);
    expect(lastVoice(r)?.outcome).toBe("file");

    const recent = must(MANY_KEYS.at(-1), "the newest key");
    expect(r.engine.playVoice(recent.slice(0, -"-play".length), "play", 0, VOICE_PRIORITY.react)).toBe(true);
    await settle();
    expect(audio.decodeCalls, "a recent key is still decoded").toHaveLength(MANY_KEYS.length + 1);
  });

  it("B51 VOICE_PREFETCH_DELAY_MS after the first preload on a running context, every line's bytes are fetched once, a few at a time", async () => {
    const r = rig({ engine: { manifest: PRELOAD_MANIFEST } });
    unlocked(r);
    r.fetch.mode = "hang";

    r.engine.preloadVoices(["core-004-play"]);
    await settle();
    expect(r.fetch.urls()).toEqual([url("core-004-play")]);

    await elapse(r, VOICE_PREFETCH_DELAY_MS);
    expect(r.fetch.urls(), "a few at a time").toHaveLength(1 + VOICE_PREFETCH_CONCURRENCY);
    for (let i = 0; i < 40; i += 1) {
      r.fetch.release();
      await settle();
    }

    const all = Object.keys(PRELOAD_MANIFEST.files).map((key) => url(key));
    expect(new Set(r.fetch.urls())).toEqual(new Set(all));
    expect(r.fetch.urls()).toHaveLength(all.length);
  });

  it("B51 a context that is not running prefetches nothing", async () => {
    const r = rig({ factory: fakeContextFactory({ state: "suspended", resumeMode: "stay" }), engine: { manifest: PRELOAD_MANIFEST } });
    unlocked(r);

    r.engine.preloadVoices(["core-004-play"]);
    await elapse(r, VOICE_PREFETCH_DELAY_MS + 1_000);

    expect(r.fetch.urls()).toEqual([url("core-004-play")]);
  });
});

/* --------------------------------------------------------------------------------------------- *
 * B58: no background voice work while the board animates
 * --------------------------------------------------------------------------------------------- */

describe("B58 background voice work waits while the engine is busy", () => {
  /** Resolves every hanging request, over and over, until nothing new is asked for. */
  async function drainFetches(r: Rig): Promise<void> {
    for (let i = 0; i < 60; i += 1) {
      r.fetch.release();
      await settle();
    }
  }

  it("B58 while busy the prefetch starts no request; when busy clears it resumes, a few at a time, and fetches each line once", async () => {
    const r = rig({ engine: { manifest: PRELOAD_MANIFEST } });
    unlocked(r);
    r.fetch.mode = "hang";
    r.engine.preloadVoices(["core-004-play"]);
    await settle();

    r.engine.setBusy(true);
    await elapse(r, VOICE_PREFETCH_DELAY_MS + 5_000);
    expect(r.fetch.urls(), "the prefetch came due mid-burst and waited").toEqual([url("core-004-play")]);

    r.engine.setBusy(false);
    await settle();
    expect(r.fetch.urls()).toHaveLength(1 + VOICE_PREFETCH_CONCURRENCY);

    // Requests already in flight when a burst starts finish, but start nothing after them.
    r.engine.setBusy(true);
    await drainFetches(r);
    expect(r.fetch.urls(), "nothing new while busy").toHaveLength(1 + VOICE_PREFETCH_CONCURRENCY);

    r.engine.setBusy(false);
    await settle();
    expect(r.fetch.urls()).toHaveLength(1 + 2 * VOICE_PREFETCH_CONCURRENCY);
    await drainFetches(r);
    const all = Object.keys(PRELOAD_MANIFEST.files).map((key) => url(key));
    expect(new Set(r.fetch.urls())).toEqual(new Set(all));
    expect(r.fetch.urls(), "each line once").toHaveLength(all.length);
  });

  it("B58 a preload asked for while busy is held, and only the newest one runs when busy clears", async () => {
    const r = rig({ engine: { manifest: PRELOAD_MANIFEST } });
    unlocked(r);

    r.engine.setBusy(true);
    r.engine.preloadVoices(["core-200-play"]);
    r.engine.preloadVoices(["core-201-play", "core-202-play"]);
    await settle();
    expect(r.fetch.fetchBytes).not.toHaveBeenCalled();

    r.engine.setBusy(false);
    await settle();
    expect(r.fetch.urls()).toEqual([url("core-201-play"), url("core-202-play")]);
    expect(r.factory.last().decodeCalls).toHaveLength(2);

    r.engine.setBusy(true);
    r.engine.setBusy(false);
    await settle();
    expect(r.fetch.urls(), "a held preload runs once").toHaveLength(2);
  });

  it("B58 a line asked to play while busy is fetched at once and heard", async () => {
    const r = rig();
    unlocked(r);
    r.engine.setBusy(true);

    expect(r.engine.playVoice("core-004", "play", 0)).toBe(true);
    expect(r.fetch.urls()).toEqual([url("core-004-play")]);
    await settle();

    expect(lastVoice(r)?.outcome).toBe("file");
  });

  it("B58 muted, or with voice lines off, nothing is preloaded or prefetched; voice lines back on resume the prefetch", async () => {
    const r = rig({ engine: { manifest: PRELOAD_MANIFEST } });
    unlocked(r);
    r.fetch.mode = "hang";
    r.engine.preloadVoices(["core-004-play"]);
    await settle();

    writeAudioSettings({ voiceOn: false });
    r.engine.preloadVoices(["core-200-play"]);
    await elapse(r, VOICE_PREFETCH_DELAY_MS + 1_000);
    expect(r.fetch.urls(), "voice lines off").toEqual([url("core-004-play")]);

    writeAudioSettings({ voiceOn: true });
    await settle();
    expect(r.fetch.urls()).toHaveLength(1 + VOICE_PREFETCH_CONCURRENCY);

    writeAudioSettings({ muted: true });
    r.engine.preloadVoices(["core-229-play"]);
    await drainFetches(r);
    expect(r.fetch.urls(), "muted").toHaveLength(1 + VOICE_PREFETCH_CONCURRENCY);
    expect(r.fetch.urls()).not.toContain(url("core-229-play"));

    writeAudioSettings({ muted: false });
    await settle();
    expect(r.fetch.urls()).toHaveLength(1 + 2 * VOICE_PREFETCH_CONCURRENCY);
  });
});
