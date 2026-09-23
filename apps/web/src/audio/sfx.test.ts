// B14 (docs/polish/2-sound.md): every procedural recipe, run on the fake context with each of the
// four parameter sets, keeps the recipe contract: nothing scheduled before `at`, every source it
// starts stopped by `at + returned`, a returned length within `durationMs`, wiring only into `out`,
// and nothing outside the permitted Web Audio subset. What a recipe sounds like is B15 and B16, in
// real Chrome (tester B's component spec).

import { describe, expect, it } from "vitest";

import { SFX, SFX_IDS, noiseBuffer, type SfxRecipe, type SfxSpec } from "./sfx.ts";
import { FakeAudio, FakeNode, type FakeParam, type ParamEvent } from "./test/fakeAudio.ts";
import type { SfxId, SfxParams } from "./types.ts";

/** The SfxId union, in its declared order. */
const UNION_ORDER: SfxId[] = [
  "draw", "play", "summon", "attack", "impact", "shieldShatter", "heal", "buff", "debuff",
  "death", "burn", "trapSet", "trapSting", "spell", "mana", "turnStart", "victory",
  "defeat", "uiClick", "uiHover", "whoosh", "radiant", "lock", "poof", "notify", "drain",
  "cancel",
];

/** The design's durationMs column: each recipe's upper bound over all params. */
const DURATION_MS: Record<SfxId, number> = {
  draw: 180,
  play: 260,
  summon: 380,
  attack: 240,
  impact: 450,
  shieldShatter: 500,
  heal: 700,
  buff: 420,
  debuff: 420,
  death: 650,
  burn: 600,
  trapSet: 160,
  trapSting: 700,
  spell: 800,
  mana: 260,
  turnStart: 1200,
  victory: 1600,
  defeat: 1600,
  uiClick: 50,
  uiHover: 40,
  whoosh: 350,
  radiant: 900,
  lock: 400,
  poof: 450,
  notify: 300,
  drain: 600,
  cancel: 260,
};

const PARAM_SETS: readonly SfxParams[] = [{}, { amount: 1 }, { amount: 25 }, { mine: true }];

/** The recipe is asked to start here; `currentTime` is earlier, so "start now" is detectably early. */
const NOW = 1;
const AT = 1.5;
const EPS = 1e-9;

type Run = {
  label: string;
  audio: FakeAudio;
  out: FakeNode;
  at: number;
  durationMs: number;
  returned: unknown;
  threw: unknown;
  /** Nodes the recipe created. */
  made: FakeNode[];
  /** AudioParam calls the recipe made. */
  paramEvents: { param: FakeParam; event: ParamEvent }[];
};

function runRecipe(label: string, recipe: SfxRecipe, durationMs: number, params: SfxParams): Run {
  const audio = new FakeAudio({ state: "running", currentTime: NOW });
  const outProxy = audio.context.createGain();
  const out = audio.nodeOf(outProxy);
  const firstNode = audio.nodes.length;
  const firstParam = audio.paramLog.length;
  let returned: unknown;
  let threw: unknown = null;
  try {
    returned = recipe(audio.context, outProxy, AT, params);
  } catch (error) {
    threw = error;
  }
  return {
    label,
    audio,
    out,
    at: AT,
    durationMs,
    returned,
    threw,
    made: audio.nodes.slice(firstNode),
    paramEvents: audio.paramLog.slice(firstParam),
  };
}

/** One run per id of the union and parameter set. A missing spec becomes a run that threw, not a crash. */
function everyRun(): Run[] {
  const table = SFX as Partial<Record<SfxId, SfxSpec>>;
  const runs: Run[] = [];
  for (const id of UNION_ORDER) {
    const spec = table[id];
    const recipe: SfxRecipe =
      spec?.recipe ??
      (() => {
        throw new Error(`SFX has no spec for ${id}`);
      });
    for (const params of PARAM_SETS) {
      runs.push(runRecipe(`${id} ${JSON.stringify(params)}`, recipe, spec?.durationMs ?? DURATION_MS[id], params));
    }
  }
  return runs;
}

const returnedSeconds = (run: Run): number => (typeof run.returned === "number" ? run.returned : Number.NaN);

/* ----- the contract, one clause per checker; each returns its problems ----- */

function subsetProblems(run: Run): string[] {
  const problems = run.audio.violations.map((v) => `${run.label}: ${v}`);
  if (run.threw !== null) problems.push(`${run.label}: threw ${String(run.threw)}`);
  return problems;
}

function lengthProblems(run: Run): string[] {
  const seconds = returnedSeconds(run);
  if (!Number.isFinite(seconds)) return [`${run.label}: returned ${String(run.returned)}, not a finite number of seconds`];
  if (seconds <= 0) return [`${run.label}: returned ${String(seconds)} s, not a positive length`];
  if (seconds > run.durationMs / 1000 + EPS) return [`${run.label}: returned ${String(seconds)} s > durationMs ${String(run.durationMs)}`];
  return [];
}

function scheduleProblems(run: Run): string[] {
  const problems: string[] = [];
  const started = run.made.filter((n) => n.started);
  if (started.length === 0) problems.push(`${run.label}: starts no source, so it schedules no sound`);
  for (const node of started) {
    if ((node.startTime ?? 0) < run.at - EPS) problems.push(`${run.label}: ${node.kind} starts at ${String(node.startTime)} < at ${String(run.at)}`);
    if (node.stopTime !== null && node.stopTime < run.at - EPS) {
      problems.push(`${run.label}: ${node.kind} stops at ${String(node.stopTime)} < at ${String(run.at)}`);
    }
  }
  for (const { param, event } of run.paramEvents) {
    if (event.method === "value" || event.method === "cancelScheduledValues") continue;
    if (event.time < run.at - EPS) {
      problems.push(`${run.label}: ${param.node.kind}.${param.name}.${event.method} at ${String(event.time)} < at ${String(run.at)}`);
    }
  }
  return problems;
}

function stopProblems(run: Run): string[] {
  const problems: string[] = [];
  const end = run.at + returnedSeconds(run);
  for (const node of run.made.filter((n) => n.started)) {
    if (node.stopTime === null) {
      problems.push(`${run.label}: a ${node.kind} it starts is never stopped`);
    } else if (!(node.stopTime <= end + EPS)) {
      problems.push(`${run.label}: a ${node.kind} stops at ${String(node.stopTime)}, after at + returned = ${String(end)}`);
    }
  }
  return problems;
}

function wiringProblems(run: Run): string[] {
  const problems: string[] = [];
  const own = new Set(run.made);
  for (const node of run.made) {
    for (const target of node.connections) {
      if (target instanceof FakeNode) {
        if (target === run.audio.destination) problems.push(`${run.label}: ${node.kind} connects to ctx.destination`);
        else if (target !== run.out && !own.has(target)) problems.push(`${run.label}: ${node.kind} connects to a node it did not make`);
      } else if (!own.has(target.node)) {
        problems.push(`${run.label}: ${node.kind} modulates ${target.node.kind}.${target.name}, which it did not make`);
      }
    }
  }
  if (!run.made.some((n) => n.connections.includes(run.out))) problems.push(`${run.label}: nothing connects into out`);
  if (run.out.connections.length > 0) problems.push(`${run.label}: connects out onward (out is the engine's)`);
  return problems;
}

function rampProblems(run: Run): string[] {
  return run.paramEvents
    .filter(({ event }) => event.method === "exponentialRampToValueAtTime" && !(event.value > 0))
    .map(({ param }) => `${run.label}: exponential ramp on ${param.node.kind}.${param.name} targets a value <= 0`);
}

/* --------------------------------------------------------------------------------------------- *
 * B14
 * --------------------------------------------------------------------------------------------- */

describe("B14 the SFX table", () => {
  it("B14 SFX_IDS lists all 27 ids, in the order of the SfxId union", () => {
    expect([...SFX_IDS]).toEqual(UNION_ORDER);
  });

  it("B14 SFX has exactly one spec per id, with the design's durationMs and a gain in (0, 1]", () => {
    expect(Object.keys(SFX).sort()).toEqual([...UNION_ORDER].sort());
    for (const id of UNION_ORDER) {
      const spec = SFX[id];
      expect(typeof spec.recipe, id).toBe("function");
      expect(spec.durationMs, id).toBe(DURATION_MS[id]);
      expect(spec.gain, id).toBeGreaterThan(0);
      expect(spec.gain, id).toBeLessThanOrEqual(1);
    }
  });
});

describe("B14 every recipe keeps the recipe contract on the fake context", () => {
  const runs = everyRun();

  it("B14 covers every id with {}, {amount: 1}, {amount: 25} and {mine: true}", () => {
    expect(runs).toHaveLength(UNION_ORDER.length * PARAM_SETS.length);
  });

  it("B14 no recipe throws or reaches outside the permitted Web Audio subset", () => {
    expect(runs.flatMap(subsetProblems)).toEqual([]);
  });

  it("B14 every recipe returns a length in (0, durationMs / 1000]", () => {
    expect(runs.flatMap(lengthProblems)).toEqual([]);
  });

  it("B14 every recipe starts a source, and schedules no start, stop or automation before at", () => {
    expect(runs.flatMap(scheduleProblems)).toEqual([]);
  });

  it("B14 every source a recipe starts is stopped by at + its returned length", () => {
    expect(runs.flatMap(stopProblems)).toEqual([]);
  });

  it("B14 every recipe connects into out, and only into out or its own nodes, never the destination", () => {
    expect(runs.flatMap(wiringProblems)).toEqual([]);
  });

  it("B14 exponential ramps always target a value above 0", () => {
    expect(runs.flatMap(rampProblems)).toEqual([]);
  });

  it("B14 the checks reject a recipe that breaks each clause", () => {
    const bad: SfxRecipe = (ctx, out, at) => {
      const early = ctx.createOscillator();
      early.connect(ctx.destination); // wiring: straight to the speakers
      early.start(); // schedule: "now", before at
      const unstopped = ctx.createOscillator();
      unstopped.connect(out);
      unstopped.start(at); // stop: never stopped
      const late = ctx.createOscillator();
      late.connect(out);
      late.start(at);
      late.stop(at + 30); // stop: long after at + returned
      try {
        ctx.createConvolver(); // subset: not permitted
      } catch {
        // The fake throws; the violation is recorded anyway.
      }
      return 9; // length: longer than its durationMs
    };
    const run = runRecipe("bad", bad, 100, {});

    expect(subsetProblems(run)).not.toEqual([]);
    expect(lengthProblems(run)).not.toEqual([]);
    expect(scheduleProblems(run)).not.toEqual([]);
    expect(stopProblems(run)).not.toEqual([]);
    expect(wiringProblems(run)).not.toEqual([]);
  });

  it("B14 the fake refuses an exponential ramp to 0, as Web Audio does", () => {
    const zeroRamp: SfxRecipe = (ctx, out, at) => {
      const gain = ctx.createGain();
      gain.connect(out);
      gain.gain.exponentialRampToValueAtTime(0, at + 0.1);
      return 0.1;
    };
    const run = runRecipe("zero-ramp", zeroRamp, 100, {});

    expect(run.threw).toBeInstanceOf(RangeError);
    expect(subsetProblems(run)).not.toEqual([]);
  });
});

describe("B14 the shared noise buffer", () => {
  it("B14 noiseBuffer is one second of mono noise, cached per context", () => {
    for (const sampleRate of [44_100, 48_000]) {
      const audio = new FakeAudio({ sampleRate });
      const noise = noiseBuffer(audio.context);

      expect(noiseBuffer(audio.context), "the same buffer for the same context").toBe(noise);
      expect(noise.numberOfChannels).toBe(1);
      expect(noise.length).toBe(sampleRate);
      const data = audio.bufferOf(noise).channel(0);
      expect(data.every((x) => Number.isFinite(x) && x >= -1 && x <= 1)).toBe(true);
      expect(data.some((x) => x !== 0), "not silence").toBe(true);
      expect(audio.violations).toEqual([]);
    }
  });

  it("B14 noiseBuffer fills every context with the same samples (a fixed seed)", () => {
    const a = new FakeAudio();
    const b = new FakeAudio();
    const first = noiseBuffer(a.context);
    const second = noiseBuffer(b.context);

    expect(second).not.toBe(first);
    const da = a.bufferOf(first).channel(0);
    const db = b.bufferOf(second).channel(0);
    expect(da.length).toBe(db.length);
    expect(da.findIndex((x, i) => x !== db[i])).toBe(-1);
  });
});
