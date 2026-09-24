// Polish task 2 (docs/polish/2-sound.md), behaviours B15 and B16: every procedural SFX recipe,
// rendered by a real browser's Web Audio implementation rather than jsdom's fake.
//
//   B15  In real Chrome, every recipe rendered alone in an OfflineAudioContext yields finite
//        samples with a peak in [0.01, 1.0], and a peak < 0.001 after its durationMs.
//   B16  In real Chrome, `impact` RMS strictly increases across amount 1 -> 4 -> 10, and amount 25
//        renders the same RMS as 10 within 1%.
//
// The jsdom suite (sfx.test.ts, B14) proves what a recipe SCHEDULES on a fake context. It cannot
// prove what comes out: whether filters ring past the end, whether a ramp clips, whether a sweep
// produces NaN. This spec renders the real thing, offline and faster than real time, and measures
// the samples.
//
// It imports `apps/web/src/audio/sfx.ts` and nothing else from the client — the Surface keeps
// sfx.ts free of anything but ./types.ts and ./constants.ts for exactly this reason — and it mounts
// nothing. Types come off sfx.ts's own exports so no second client module is pulled in.
//
// Each recipe renders into `new OfflineAudioContext(1, 44100 * (durationMs / 1000 + 0.25), 44100)`
// with `at = 0`, through a unity-gain node into the destination: the recipe contract is "connects
// only into `out` … its peak output is <= 1.0", so the recipe's own output is what is measured, not
// the engine's per-cue gain or buses on top of it. It runs once per params set B14 names ({},
// {amount: 1}, {amount: 25}, {mine: true}): `durationMs` is the Surface's "upper bound over all
// params", so the tail has to be silent for every one of them.
//
//   B57  At the default settings, through the real mix (mix.ts: buses and limiter), every effect
//        sits in its band against the shipped voice lines: the maximum hit and the big moments
//        within a few dB of a line, routine sounds 4 to 12 dB under it, the UI ticks under that but
//        audible, victory louder than defeat, and a dense scene under the limiter never clipping.
//        The reference is the mean active RMS of five real lines in five personas, decoded by
//        Chrome from the committed .m4a files with their persona trims.
//
// B15 and B16 measure a recipe alone, as described above. B57 measures what a player hears, so it
// also imports mix.ts, the default settings and voice-lines.json (for the persona trims).
//
// Run it with:
//   E2E_COMPONENT_PORT=5282 pnpm --dir e2e exec cypress run --component --browser chrome \
//     --spec cypress/component/audio-recipes.cy.tsx

import { buildMix } from "../../../apps/web/src/audio/mix.ts";
import { DEFAULT_AUDIO_SETTINGS } from "../../../apps/web/src/audio/settings.ts";
import { SFX, SFX_IDS, SFX_TIMBRES, type SfxRecipe } from "../../../apps/web/src/audio/sfx.ts";
import voiceLines from "../../../apps/web/src/audio/voice-lines.json";

type SfxId = (typeof SFX_IDS)[number];
type SfxParams = Parameters<SfxRecipe>[3];

const SAMPLE_RATE = 44_100;
/** Rendered past `durationMs`, so the tail after it can be measured (Tests section). */
const TAIL_S = 0.25;
/** An offline render of under two seconds of mono audio takes milliseconds; this is headroom. */
const RENDER_TIMEOUT_MS = 30_000;

/** B15's bounds. */
const MIN_PEAK = 0.01;
const MAX_PEAK = 1.0;
const SILENT = 0.001;
/** B16's tolerance. */
const RMS_TOLERANCE = 0.01;

/** The SfxId union from types.ts, in its order: SFX_IDS is "all 28, in the order of the union". */
const EXPECTED_IDS = [
  "draw", "play", "summon", "attack", "impact", "shieldShatter", "heal", "buff", "debuff",
  "death", "burn", "trapSet", "trapSting", "spell", "mana", "turnStart", "victory",
  "defeat", "uiClick", "uiHover", "whoosh", "radiant", "lock", "poof", "notify", "drain",
  "cancel", "entrance",
] as const;

/** The Surface's recipe table, `durationMs` column: the window each recipe must fall silent in. */
const DURATION_MS: Readonly<Record<(typeof EXPECTED_IDS)[number], number>> = {
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
  entrance: 1400,
};

/** B14's params sets, reused so the browser checks the same inputs the fake context does. */
const PARAM_SETS: readonly { label: string; params: SfxParams }[] = [
  { label: "{}", params: {} },
  { label: "{amount: 1}", params: { amount: 1 } },
  { label: "{amount: 25}", params: { amount: 25 } },
  { label: "{mine: true}", params: { mine: true } },
];

/** One params set's render of one recipe. */
type Render = { label: string; samples: Float32Array };

/** Render one recipe alone and hand back its only channel. */
async function render(id: SfxId, params: SfxParams): Promise<Float32Array> {
  const seconds = SFX[id].durationMs / 1000 + TAIL_S;
  const ctx = new OfflineAudioContext(1, Math.round(SAMPLE_RATE * seconds), SAMPLE_RATE);
  const out = ctx.createGain();
  out.gain.value = 1;
  out.connect(ctx.destination);
  SFX[id].recipe(ctx, out, 0, params);
  const buffer = await ctx.startRendering();
  return buffer.getChannelData(0);
}

function nonFiniteCount(samples: Float32Array): number {
  let count = 0;
  for (const sample of samples) if (!Number.isFinite(sample)) count += 1;
  return count;
}

/** max |x| over samples[from..]. */
function peak(samples: Float32Array, from = 0): number {
  let max = 0;
  for (let index = from; index < samples.length; index += 1) {
    const magnitude = Math.abs(samples[index] ?? 0);
    if (magnitude > max) max = magnitude;
  }
  return max;
}

/** Root mean square over the whole render (every `impact` render has the same length). */
function rms(samples: Float32Array): number {
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.sqrt(sum / samples.length);
}

describe("polish 2 — SFX recipes rendered by a real browser", () => {
  it("B15 renders all 28 SfxIds, each with a recipe and the Surface's durationMs", () => {
    expect([...SFX_IDS], "SFX_IDS, in the order of the SfxId union").to.deep.eq([...EXPECTED_IDS]);
    for (const id of EXPECTED_IDS) {
      const spec = SFX[id];
      expect(spec, `SFX.${id}`).to.be.an("object");
      expect(spec.recipe, `SFX.${id}.recipe`).to.be.a("function");
      expect(spec.durationMs, `SFX.${id}.durationMs`).to.eq(DURATION_MS[id]);
    }
  });

  for (const id of EXPECTED_IDS) {
    it(`B15 ${id}: finite samples, peak within [${MIN_PEAK}, ${MAX_PEAK}], silent after durationMs`, () => {
      const durationMs = DURATION_MS[id];
      const tailFrom = Math.ceil((SAMPLE_RATE * durationMs) / 1000);
      const renders: Promise<Render[]> = Promise.all(
        PARAM_SETS.map(async ({ label, params }) => ({ label, samples: await render(id, params) })),
      );

      cy.wrap<Promise<Render[]>, Render[]>(renders, { timeout: RENDER_TIMEOUT_MS, log: false }).then((results) => {
        expect(results, `${id}: one render per params set`).to.have.length(PARAM_SETS.length);
        for (const { label, samples } of results) {
          const where = `${id} ${label}`;
          expect(samples.length, `${where}: rendered past durationMs`).to.be.greaterThan(tailFrom);
          expect(nonFiniteCount(samples), `${where}: every sample is finite`).to.eq(0);
          const loudest = peak(samples);
          expect(loudest, `${where}: peak is audible`).to.be.at.least(MIN_PEAK);
          expect(loudest, `${where}: peak never clips`).to.be.at.most(MAX_PEAK);
          expect(peak(samples, tailFrom), `${where}: silent after ${durationMs} ms`).to.be.below(SILENT);
        }
      });
    });
  }

  // Integration: every card family's summon and spell, and the Mythic entrance, keep B15's bounds.
  it("B15 every card family's summon and spell, and the Mythic entrance: finite, unclipped, silent after durationMs", () => {
    const cases: { id: SfxId; params: SfxParams }[] = [
      ...SFX_TIMBRES.flatMap((timbre): { id: SfxId; params: SfxParams }[] => [
        { id: "summon", params: { timbre } },
        { id: "summon", params: { amount: 25, timbre } },
        { id: "spell", params: { timbre } },
      ]),
      { id: "entrance", params: { mythic: true } },
    ];
    const renders = Promise.all(cases.map(async ({ id, params }) => ({ id, params, samples: await render(id, params) })));
    cy.wrap(renders, { timeout: RENDER_TIMEOUT_MS, log: false }).then((results) => {
      for (const { id, params, samples } of results as { id: SfxId; params: SfxParams; samples: Float32Array }[]) {
        const where = `${id} ${JSON.stringify(params)}`;
        const tailFrom = Math.ceil((SAMPLE_RATE * DURATION_MS[id]) / 1000);
        expect(nonFiniteCount(samples), `${where}: every sample is finite`).to.eq(0);
        expect(peak(samples), `${where}: peak is audible`).to.be.at.least(MIN_PEAK);
        expect(peak(samples), `${where}: peak never clips`).to.be.at.most(MAX_PEAK);
        expect(peak(samples, tailFrom), `${where}: silent after durationMs`).to.be.below(SILENT);
      }
    });
  });

  it("B16 impact RMS strictly increases across amount 1, 4 and 10", () => {
    const amounts = [1, 4, 10] as const;
    const renders = Promise.all(amounts.map((amount) => render("impact", { amount })));

    cy.wrap<Promise<Float32Array[]>, Float32Array[]>(renders, { timeout: RENDER_TIMEOUT_MS, log: false }).then((results) => {
      const [one, four, ten] = results.map((samples) => rms(samples));
      expect(one, "impact {amount: 1} is audible").to.be.greaterThan(0);
      expect(four, "impact {amount: 4} is louder than {amount: 1}").to.be.greaterThan(one ?? Infinity);
      expect(ten, "impact {amount: 10} is louder than {amount: 4}").to.be.greaterThan(four ?? Infinity);
    });
  });

  it("B16 impact at amount 25 renders the RMS of amount 10 within 1% (IMPACT_AMOUNT_CAP)", () => {
    const renders = Promise.all([render("impact", { amount: 10 }), render("impact", { amount: 25 })]);

    type Pair = [Float32Array, Float32Array];
    cy.wrap<Promise<Pair>, Pair>(renders, { timeout: RENDER_TIMEOUT_MS, log: false }).then(([atCap, beyondCap]) => {
      const cap = rms(atCap);
      const beyond = rms(beyondCap);
      expect(cap, "impact {amount: 10} is audible").to.be.greaterThan(0);
      expect(Math.abs(beyond - cap) / cap, `RMS ${beyond} at 25 vs ${cap} at 10`).to.be.at.most(RMS_TOLERANCE);
    });
  });
});

/* --------------------------------------------------------------------------------------------- *
 * B57: the mix at the default settings
 * --------------------------------------------------------------------------------------------- */

/** Five shipped lines in five personas (robot, kid, narrator, diva, goof): the dialogue level. */
const REFERENCE_LINES = ["core-013-play", "core-011-play", "core-005-cast", "core-081-play", "core-009-death"] as const;
const MIX_LEAD_S = 0.01;
const MIX_TAIL_S = 0.3;
/** Active RMS: 10 ms windows, keeping those within 20 dB of the loudest (a sound's body, not its tail). */
const WINDOW_S = 0.01;
const GATE = 100; // power ratio: 20 dB

type Level = { activeDb: number; peak: number };

function level(samples: Float32Array): Level {
  const win = Math.round(SAMPLE_RATE * WINDOW_S);
  const powers: number[] = [];
  let loudest = 0;
  for (let i = 0; i + win <= samples.length; i += win) {
    let sum = 0;
    for (let j = i; j < i + win; j += 1) {
      const x = samples[j] ?? 0;
      sum += x * x;
      loudest = Math.max(loudest, Math.abs(x));
    }
    powers.push(sum / win);
  }
  const top = Math.max(...powers);
  const kept = powers.filter((p) => p >= top / GATE);
  const mean = kept.reduce((a, b) => a + b, 0) / kept.length;
  return { activeDb: 10 * Math.log10(mean), peak: loudest };
}

type Cue = { id: SfxId; params: SfxParams; at?: number };

/** Renders cues (and, optionally, decoded lines) through the real mix at the default settings. */
async function renderMix(cues: readonly Cue[], lines: readonly { buffer: AudioBuffer; gain: number; at: number }[] = []): Promise<Float32Array> {
  const ends = [
    ...cues.map((c) => (c.at ?? 0) + SFX[c.id].durationMs / 1000),
    ...lines.map((l) => l.at + l.buffer.duration),
  ];
  const ctx = new OfflineAudioContext(1, Math.round(SAMPLE_RATE * (MIX_LEAD_S + Math.max(...ends) + MIX_TAIL_S)), SAMPLE_RATE);
  const mix = buildMix(ctx, DEFAULT_AUDIO_SETTINGS);
  for (const cue of cues) {
    const gain = ctx.createGain();
    gain.gain.value = SFX[cue.id].gain;
    gain.connect(mix.sfx);
    SFX[cue.id].recipe(ctx, gain, MIX_LEAD_S + (cue.at ?? 0), cue.params);
  }
  for (const line of lines) {
    const source = ctx.createBufferSource();
    source.buffer = line.buffer;
    const trim = ctx.createGain();
    trim.gain.value = line.gain;
    source.connect(trim);
    trim.connect(mix.voice);
    source.start(MIX_LEAD_S + line.at);
  }
  return (await ctx.startRendering()).getChannelData(0);
}

function personaGain(key: string): number {
  const defId = key.slice(0, key.lastIndexOf("-"));
  const table = voiceLines as unknown as { personas: Record<string, { gain?: number }>; cards: Record<string, { persona: string }> };
  const persona = table.cards[defId]?.persona ?? "";
  return table.personas[persona]?.gain ?? 1;
}

async function decode(b64: string): Promise<AudioBuffer> {
  const text = atob(b64);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) bytes[i] = text.charCodeAt(i);
  return new OfflineAudioContext(1, SAMPLE_RATE, SAMPLE_RATE).decodeAudioData(bytes.buffer);
}

/** Bands in dB against the reference line level. */
const LOUD: readonly Cue[] = [
  { id: "impact", params: { amount: 10 } },
  { id: "death", params: {} },
  { id: "trapSting", params: {} },
  { id: "turnStart", params: { mine: true } },
  { id: "defeat", params: {} },
  { id: "drain", params: { amount: 10 } },
  { id: "summon", params: { amount: 14 } },
  // Integration: a Legendary or Mythic unit's entrance is one of the big moments.
  { id: "entrance", params: {} },
  { id: "entrance", params: { mythic: true } },
];
const LOUD_BAND = [-5, 1] as const;
const ROUTINE: readonly Cue[] = [
  ...(["draw", "play", "summon", "attack", "shieldShatter", "heal", "buff", "debuff", "burn", "trapSet", "spell", "whoosh", "radiant", "lock", "poof", "notify", "cancel"] as const).map(
    (id): Cue => ({ id, params: {} }),
  ),
  { id: "mana", params: { mine: true } },
  { id: "impact", params: { amount: 1 } },
  { id: "drain", params: { amount: 1 } },
];
const ROUTINE_BAND = [-12, -4] as const;
const UI_BANDS: Readonly<Record<"uiClick" | "uiHover", readonly [number, number]>> = { uiClick: [-15, -9], uiHover: [-22, -15] };
const VICTORY_BAND = [-4, 3] as const;
/** No single effect comes near full scale on its own. */
const EFFECT_PEAK_MAX = 0.7;

describe("polish 2 — B57 the mix at the default settings", () => {
  let reference = 0;
  const buffers: Record<string, AudioBuffer> = {};

  before(() => {
    for (const key of REFERENCE_LINES) {
      cy.readFile(`../apps/web/public/audio/voice/${key}.m4a`, "base64", { log: false }).then((b64) => {
        cy.wrap(decode(b64 as string), { log: false }).then((buffer) => {
          buffers[key] = buffer as AudioBuffer;
        });
      });
    }
    cy.then(() => {
      const levels = Promise.all(
        REFERENCE_LINES.map(async (key) => level(await renderMix([], [{ buffer: buffers[key] as AudioBuffer, gain: personaGain(key), at: 0 }]))),
      );
      cy.wrap(levels, { timeout: RENDER_TIMEOUT_MS, log: false }).then((all) => {
        const list = all as Level[];
        reference = list.reduce((sum, l) => sum + l.activeDb, 0) / list.length;
        cy.task("layout:report", { b57: "reference", activeDb: Number(reference.toFixed(1)), lines: list.map((l) => Number(l.activeDb.toFixed(1))) }, { log: false });
      });
    });
  });

  const check = (label: string, cues: readonly Cue[], band: readonly [number, number]) => {
    it(`B57 ${label}: every one within [${String(band[0])}, ${String(band[1])}] dB of a voice line, and none near full scale`, () => {
      const renders = Promise.all(cues.map(async (cue) => ({ cue, level: level(await renderMix([cue])) })));
      cy.wrap(renders, { timeout: RENDER_TIMEOUT_MS, log: false }).then((results) => {
        const rows = (results as { cue: Cue; level: Level }[]).map(({ cue, level: l }) => ({
          sfx: `${cue.id} ${JSON.stringify(cue.params)}`,
          relDb: Number((l.activeDb - reference).toFixed(1)),
          peak: Number(l.peak.toFixed(3)),
        }));
        cy.task("layout:report", { b57: label, rows }, { log: false });
        for (const row of rows) {
          expect(row.relDb, `${row.sfx} against the voice lines`).to.be.within(band[0], band[1]);
          expect(row.peak, `${row.sfx} peak through the mix`).to.be.at.most(EFFECT_PEAK_MAX);
        }
      });
    });
  };

  check("the maximum hit and the big moments", LOUD, LOUD_BAND);
  check("routine card and board sounds", ROUTINE, ROUTINE_BAND);
  check("uiClick", [{ id: "uiClick", params: {} }], UI_BANDS.uiClick);
  check("uiHover", [{ id: "uiHover", params: {} }], UI_BANDS.uiHover);
  check("victory", [{ id: "victory", params: {} }], VICTORY_BAND);
  // Integration: a card's family changes a summon's accent and a spell's chimes, never its level.
  check(
    "summon and spell in every card family",
    SFX_TIMBRES.flatMap((timbre): Cue[] => [
      { id: "summon", params: { timbre } },
      { id: "spell", params: { timbre } },
    ]),
    ROUTINE_BAND,
  );

  it("B57 victory plays louder than defeat", () => {
    const renders = Promise.all([renderMix([{ id: "victory", params: {} }]), renderMix([{ id: "defeat", params: {} }])]);
    cy.wrap(renders, { timeout: RENDER_TIMEOUT_MS, log: false }).then((pair) => {
      const [win, lose] = (pair as Float32Array[]).map((samples) => level(samples).activeDb);
      expect(win, `victory ${String(win)} dB vs defeat ${String(lose)} dB`).to.be.greaterThan((lose ?? 0) + 1);
    });
  });

  // Every effect in it at once, each id once (the engine refuses an id again within
  // SFX_RETRIGGER_MS), under the loudest persona's line: denser than any turn the director plays.
  it("B57 a dense scene (a trade under a death line and a trap) stays under full scale through the limiter", () => {
    const scene: Cue[] = [
      { id: "attack", params: {} },
      { id: "impact", params: { amount: 10 }, at: 0.05 },
      { id: "shieldShatter", params: {}, at: 0.07 },
      { id: "death", params: {}, at: 0.1 },
      { id: "trapSting", params: {}, at: 0.1 },
      { id: "burn", params: {}, at: 0.12 },
      { id: "summon", params: { amount: 14 }, at: 0.12 },
      { id: "entrance", params: { mythic: true }, at: 0.12 },
    ];
    const loudest = REFERENCE_LINES.reduce((a, b) => (personaGain(a) >= personaGain(b) ? a : b));
    const render = renderMix(scene, [{ buffer: buffers[loudest] as AudioBuffer, gain: personaGain(loudest), at: 0.1 }]);
    cy.wrap(render, { timeout: RENDER_TIMEOUT_MS, log: false }).then((samples) => {
      const s = samples as Float32Array;
      expect(nonFiniteCount(s)).to.eq(0);
      expect(peak(s), "the sum never clips").to.be.at.most(1);
    });
  });
});
