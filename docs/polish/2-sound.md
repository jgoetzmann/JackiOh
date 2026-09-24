# Polish task 2: sound design and voice lines

Branch `polish/2-sound`, worktree `.claude/worktrees/polish-2-sound`. Brief: `docs/polish/reference.md` §2
("More sound effects for cards. Voice lines on cry and death for cards."). SPEC range: new §10.11 and
§11 rows R203–R205 (this task uses R203 and R204). Ports: web 5172, server 8782, component 5282.

## Goal

Give JackiOh a Hearthstone-style soundscape without adding a single rule or a runtime dependency. The
client gets a small WebAudio engine in `apps/web/src/audio/`. It is created lazily and unlocked on the
first user gesture (iOS included), and it has master, sfx and voice buses. Every `GameEventType` has
a row in a total cue table, exactly as it has one in `ANIMATIONS`. A row names a procedurally
synthesized sound effect (no audio files), or it states why the event is silent. Each cue fires when
the animation runner starts that event's entry, so sound and motion land together. Every Unit in the
catalog, tokens included, speaks a play line and a death line, and every Spell, Field Spell, Trap and
Field Trap speaks a cast line: 109 entries and 152 short, funny, in-character lines. They are
pre-rendered with macOS `say` into mono AAC `.m4a` at about 32 kbps (1.53 MiB measured) by an
idempotent, committed script, and the browser's speech synthesis covers any file that is missing.
Sound reads only the viewer's `PlayerView`, so it reveals nothing the screen doesn't (R203). A mute
toggle sits on the game HUD, and a full `AudioControls` panel is exported for task 7 to mount.

## Research

**What Hearthstone does.**

- **Every minion has its own set of sounds and lines.** HearthSFX catalogues "every play, attack,
  death, trigger, and entrance sound for each minion where applicable, including tokens and other
  non-collectible cards" ([Out of Games on HearthSFX](https://outof.games/realms/hearthstone/3xh/a-site-for-hearthstone-sounds-hearthsfx/),
  [HearthSFX](https://hearthsfx.github.io/), [Hearthstone Wiki: Minion sounds](https://hearthstone.fandom.com/wiki/Category:Minion_sounds)).
  The lines are a few words long, spoken in a strong character voice, and they are about who the
  minion is, never what its card text does. That is where the personality comes from.
- **Spells are designed around beats.** Blizzard's sound team says "spells have key beats: the cast,
  the hit", and that they practise *subjective* sound design ("what's the emotional impact of this
  card?"). Big sounds are layered from small ones, for example screech + hiss + rattle for Blightfang
  ([Blizzard: Meet the sound team behind Hearthstone](https://news.blizzard.com/en-us/article/23964694/inside-battle-net-meet-the-sound-team-behind-hearthstones-harmonic-design)).
- **Game-state stingers.** A chime for "your turn", a distinct sting when a secret is revealed,
  victory and defeat stingers, and quiet UI ticks on hover and click.

**What we borrow, and what we deliberately leave out.**

- **Play and death lines for every unit, cast lines for every spell and trap.** We leave out attack
  lines: they would double the asset count, and the attack-swing SFX already carries that beat.
- **Cast, then hit.** A card's `cardPlayed` plays the cast beat (the card whoosh, a spell shimmer, the
  line). Its consequences arrive as their own §10.3 events (`damage`, `healed`, `destroyed`, …) and
  play the hit beat, each in step with its own animation entry.
- **A trap reveal gets its own sting** (`trapSting`), like a secret reveal. A turn start rings a bell,
  brighter on your own turn. Victory and defeat get stingers.
- **Impacts scale with damage** (Hearthstone's small hit versus big hit): `impact` grows louder,
  darker and longer with `amount`, up to `IMPACT_AMOUNT_CAP`.
- **Only one voice speaks at a time**, so a board wipe does not become a choir. Lines carry a
  priority (review fix, B47 and B48): a death line or a firing trap's line cuts in on a play or cast
  line, and anything else waits briefly in a short queue.

**Prior art the implementation relies on.**

- **Autoplay.** Chrome keeps a Web Audio context suspended until a user gesture. `resume()` must follow
  an interaction ([Chrome: Web Audio, autoplay policy and games](https://developer.chrome.com/blog/web-audio-autoplay),
  [Chrome autoplay policy](https://developer.chrome.com/blog/autoplay)). The HTML standard's
  *activation-triggering input events* are `keydown`, `mousedown`, `pointerdown` (mouse only),
  `pointerup` (non-mouse) and `touchend` ([HTML: user activation](https://html.spec.whatwg.org/multipage/interaction.html),
  [whatwg/html#7341](https://github.com/whatwg/html/issues/7341), [WebKit: User Activation API](https://webkit.org/blog/13862/the-user-activation-api/)).
  So a touch `pointerdown` alone does not unlock iOS; `pointerup`/`touchend` does. On iOS the context
  must be `resume()`d, and a silent buffer played, inside the gesture
  ([Matt Montag: unlock Web Audio in Safari](https://www.mattmontag.com/web/unlock-web-audio-in-safari-for-ios-and-macos)).
  We listen to `pointerdown`, `pointerup`, `touchend`, `click` and `keydown`, and retry on every
  gesture until the context runs.
- **Procedural SFX.** sfxr/jsfxr build whole game-SFX palettes from an oscillator or noise, an
  envelope and a filter, with no audio files ([jsfxr](https://github.com/chr15m/jsfxr),
  [sfxr.me](https://sfxr.me/)). Our recipes are the Web Audio version of that: oscillators, a cached
  white-noise buffer, biquad filters and gain envelopes, plus two-operator FM for bells and chimes.
- **`say` embedded commands.** `[[rate n]]`, `[[pbas n]]` (pitch base) and `[[pmod n]]` (pitch
  modulation) vary each persona ([Apple: Techniques for Customizing Synthesized Speech](https://developer.apple.com/library/archive/documentation/UserExperience/Conceptual/SpeechSynthesisProgrammingGuide/FineTuning/FineTuning.html)).
  I measured this on this machine: `rate` changes duration on every voice tested, and `pbas` changes
  the output of both a legacy voice (Fred) and a modern one (Eddy). Legacy voices such as Fred are
  **not** byte-deterministic from run to run, while Eddy-family voices and `afconvert` are. So the
  script decides idempotency by an input hash, never by output bytes.
- **Encoding.** `afconvert -f m4af -d aac@22050 -c 1 -b 32000 in.aiff out.m4a` gives mono AAC in an
  MP4 container (`ftyp` brand `M4A `) at about 27–35 kbps effective. I generated the whole draft set
  of 152 lines below on this machine: 1,605,399 bytes (1.53 MiB), `du -sk` 1876, longest line 3.53 s,
  about 45 s of wall time.

## Surface

Everything below is a cross-slice boundary. Builders write against it blind, so they must not rename,
reshape or re-home anything here. All paths are repo-relative. Imports inside `apps/web/src` may use
`.ts`/`.tsx` extensions, as `Game.tsx` does.

### Files and ownership at a glance

```
apps/web/src/audio/
  types.ts            slice 1  shared types (below, verbatim)
  constants.ts        slice 1  every number another module or a test reads
  settings.ts         slice 1  settings store (localStorage key "jackioh.audio.v1")
  sfx.ts              slice 1  SFX_IDS, SFX table of procedural recipes, noiseBuffer
  engine.ts           slice 1  createAudioEngine, getAudioEngine, setAudioEngineForTests, browserSpeechPort
  unlock.ts           slice 1  installAudioUnlock, UNLOCK_EVENTS
  voiceData.ts        slice 1  VOICE_LINES, VOICE_MANIFEST, parseVoiceLines, voiceKey, voiceUrl, lineFor, voiceKeysForView
  cues.ts             slice 2  SOUND_CUES total map, cuesFor
  director.ts         slice 2  createSoundDirector
  useGameAudio.ts     slice 2  useGameAudio(runner, view)
  uiSounds.ts         slice 2  installUiSounds
  debug.ts            slice 2  exposeAudioDebug, window.__jackiohAudio
  AudioToggle.tsx     slice 2  the HUD mute button
  AudioControls.tsx   slice 2  the full panel task 7 mounts
  audio.css           slice 2
  index.ts            slice 2  the barrel Game.tsx imports
  voice-lines.json    slice 3  the lines and personas (content below)
  voice-manifest.json slice 3  generated by gen-voice.mjs
  test/fakeAudio.ts   tester A (test helper, not a test)
  *.test.ts(x)        testers A and B
apps/web/scripts/gen-voice.mjs          slice 3
apps/web/public/audio/voice/*.m4a       slice 3 (152 files; Vite serves public/ at /)
```

### `apps/web/src/audio/types.ts` (verbatim)

```ts
export type SfxId =
  | "draw" | "play" | "summon" | "attack" | "impact" | "shieldShatter" | "heal" | "buff" | "debuff"
  | "death" | "burn" | "trapSet" | "trapSting" | "spell" | "mana" | "turnStart" | "victory"
  | "defeat" | "uiClick" | "uiHover" | "whoosh" | "radiant" | "lock" | "poof" | "notify" | "drain"
  | "cancel";

export type SfxParams = {
  /** damage / heal / health-loss amount, or the mana gained; recipes clamp to [1, IMPACT_AMOUNT_CAP]. */
  amount?: number;
  /** true when the event is the viewer's own (turnStart, mana): a brighter variant. */
  mine?: boolean;
};

export type VoiceLineKind = "play" | "death" | "cast";
/** "<defId>-<line>", e.g. "core-004-play", "core-051-1-cast". Parse from the END: defIds contain "-". */
export type VoiceKey = `${string}-${VoiceLineKind}`;

export type Persona = {
  /** A `say -v` voice name, verbatim, e.g. "Reed (English (US))". */
  say: string;
  /** `[[rate]]` words per minute, 90–360. */
  rate: number;
  /** `[[pbas]]` pitch base, 0–127. */
  pbas: number;
  /** `[[pmod]]` pitch modulation, 0–127. */
  pmod: number;
  /** For the speechSynthesis fallback: SpeechSynthesisUtterance pitch (0–2) and rate (0.1–10). */
  web: { pitch: number; rate: number };
  /** Output trim applied at runtime to this persona's files, 0–2. Default 1. */
  gain?: number;
};

type Overrides = { rate?: number; pbas?: number; pmod?: number };
export type VoiceLineEntry =
  | ({ kind: "unit"; persona: string; play: string; death: string } & Overrides)
  | ({ kind: "spell" | "trap"; persona: string; cast: string } & Overrides);

export type VoiceLineTable = {
  version: 1;
  personas: Record<string, Persona>;
  /** Keyed by catalog id: exactly the 109 ids of packages/cards/catalog.json. */
  cards: Record<string, VoiceLineEntry>;
};

export type VoiceManifest = {
  version: 1;
  /** Informative: "m4af aac@22050 mono 32000". */
  format: string;
  /** Keyed by VoiceKey. `hash` = voiceHash(...) below; `bytes` = the file's size on disk. */
  files: Record<string, { hash: string; bytes: number }>;
};

export type SoundCue =
  | { kind: "sfx"; id: SfxId; params?: SfxParams; delayMs: number }
  | { kind: "voice"; defId: string; line: VoiceLineKind; delayMs: number };

export type AudioState = "unsupported" | "locked" | "running" | "suspended" | "closed";

export type VoiceOutcome = "pending" | "file" | "speech" | "late" | "failed";
export type PlayedCue =
  | { kind: "sfx"; id: SfxId; params?: SfxParams; delayMs: number; atMs: number }
  | { kind: "voice"; defId: string; line: VoiceLineKind; delayMs: number; atMs: number; outcome: VoiceOutcome };

export type AudioSettings = {
  master: number; // 0..1
  sfx: number; // 0..1
  voice: number; // 0..1
  muted: boolean;
  voiceOn: boolean;
};

/** What the director and the UI need from an engine. */
export type SoundSink = {
  /** true when accepted (and logged); false when refused. Never throws. */
  playSfx(id: SfxId, params?: SfxParams, delayMs?: number): boolean;
  playVoice(defId: string, line: VoiceLineKind, delayMs?: number): boolean;
};

export type AudioEngine = SoundSink & {
  state(): AudioState;
  /** Call synchronously inside a user gesture. Idempotent. */
  unlock(): void;
  preloadVoices(keys: readonly VoiceKey[]): void;
  /** Accepted cues, oldest first, at most LOG_LIMIT. */
  log(): readonly PlayedCue[];
  clearLog(): void;
  /** How many AudioContexts this engine has constructed (0 or 1). */
  contextsCreated(): number;
  dispose(): void;
};
```

### `apps/web/src/audio/constants.ts` (slice 1)

The numbers another module or a test reads (CLAUDE.md rule 9, applied to the client the way
`animations.ts` names its durations). The frequencies and envelope times inside a recipe are that
recipe's data, the way keyframes are `animations.css`'s data, and stay local to it.

```ts
export const AUDIO_SETTINGS_KEY = "jackioh.audio.v1";
export const LOG_LIMIT = 100;
export const SFX_MAX_VOICES = 12;        // concurrent sfx cues still sounding
export const SFX_RETRIGGER_MS = 40;      // same SfxId again within this window is refused
export const VOICE_LATE_MS = 600;        // a line not ready this long after its request is dropped
export const VOICE_SPEECH_MAX_MS = 4000; // speech fallback holds the voice channel at most this long
export const VOICE_PRELOAD_MAX = 24;     // new keys fetched per preloadVoices call
export const IMPACT_AMOUNT_CAP = 10;
export const GAIN_SMOOTHING_S = 0.015;   // setTargetAtTime time constant for bus changes
export const VOICE_DELAY_MS = 150;       // play/cast line after the card whoosh
export const DEATH_VOICE_DELAY_MS = 120;
export const PAIR_OFFSET_MS = 220;       // cues of the 2nd event of a collapsed cardPlayed+summoned entry
export const FLUSH_MAX_SFX = 4;
export const FLUSH_GAP_MS = 90;
export const UI_HOVER_THROTTLE_MS = 80;
export const VOICE_BUDGET_BYTES = 3 * 1024 * 1024;
export const VOICE_FILE_MAX_MS = 4000;   // longest rendered line (gen-voice.mjs MAX_SECONDS; B35)
export const VOICE_MAX_WORDS = { play: 8, death: 6, cast: 8 } as const;
// Added by the review fixes (B46–B54): VOICE_PRIORITY { summon: 0, play: 1, react: 2 },
// VOICE_QUEUE_MAX 2, VOICE_QUEUE_WAIT_MS 1500, VOICE_FADE_S 0.04, VOICE_TRIM_THRESHOLD 0.005,
// VOICE_TRIM_LEAD_S 0.02, VOICE_TRIM_TAIL_S 0.08, VOICE_PREVIEW_DEF_ID "core-008",
// VOICE_DECODED_MAX 32, VOICE_PREFETCH_DELAY_MS 2000, VOICE_PREFETCH_CONCURRENCY 2.
/** R97's sentinel as a redacted event carries it (packages/engine/src/viewFor.ts HIDDEN_ID). */
export const HIDDEN_DEF_ID = "hidden";
/** Rules vocabulary a line may not use (whole word, case-insensitive): lines are flavour, not text. */
export const BANNED_RULES_WORDS: readonly string[] = [
  "Taunt", "Divine Shield", "Reborn", "Lifesteal", "Poisonous", "First Strike", "Trample", "Cleave",
  "Immutable", "Indestructible", "Stack", "Echo", "Combo", "Discover", "Recruit", "Tribute",
  "Embiggen", "Radiant", "Armor", "Rush", "Charge", "Cry", "Deathrattle", "Battlecry", "mana",
  "damage", "summon", "exile", "fatigue", "backrow", "graveyard",
];
```

### `apps/web/src/audio/settings.ts` (slice 1)

```ts
export const DEFAULT_AUDIO_SETTINGS: Readonly<AudioSettings>; // { master: 0.8, sfx: 0.8, voice: 1, muted: false, voiceOn: true }
/** Total: any input → valid settings. Each field independently: a finite number is clamped to [0,1],
 *  anything else takes the default; a boolean field that is not a boolean takes the default. */
export function parseAudioSettings(raw: unknown): AudioSettings;
/** Cached after the first read. Reads localStorage[AUDIO_SETTINGS_KEY] inside try/catch. */
export function readAudioSettings(): AudioSettings;
/** Merges, parses (clamps), caches, persists as JSON inside try/catch, notifies each subscriber once. */
export function writeAudioSettings(patch: Partial<AudioSettings>): AudioSettings;
/** The first subscription also installs one window "storage" listener for AUDIO_SETTINGS_KEY that re-reads and notifies. */
export function subscribeAudioSettings(listener: (s: AudioSettings) => void): () => void;
/** useSyncExternalStore over the store; the snapshot object is referentially stable until a change. */
export function useAudioSettings(): readonly [AudioSettings, (patch: Partial<AudioSettings>) => void];
export function resetAudioSettingsForTests(): void; // drops cache + listeners
```

Stored JSON: `{"master":0.8,"sfx":0.8,"voice":1,"muted":false,"voiceOn":true}`. Task 7's settings
panel owns no audio keys. It mounts `AudioControls`, which reads and writes this store.

### `apps/web/src/audio/sfx.ts` (slice 1)

```ts
export const SFX_IDS: readonly SfxId[]; // all 27, in the order of the SfxId union
/** Schedules one sound starting at `at` (context seconds) into `out`; returns its length in seconds. */
export type SfxRecipe = (ctx: BaseAudioContext, out: AudioNode, at: number, params: SfxParams) => number;
export type SfxSpec = { recipe: SfxRecipe; /** upper bound over all params */ durationMs: number; gain: number };
export const SFX: { readonly [K in SfxId]: SfxSpec };
/** 1 s of mono white noise, cached per context (WeakMap), filled from a fixed-seed mulberry32 so every run is identical. */
export function noiseBuffer(ctx: BaseAudioContext): AudioBuffer;
```

`sfx.ts` imports only `./types.ts` and `./constants.ts`, because the Cypress component spec imports
it on its own. The recipe contract, which tests B14 and B15 check:

- a recipe schedules nothing before `at`, stops every source it starts by `at + returned`, and
  `returned ≤ durationMs / 1000`;
- it connects only into `out` (never `ctx.destination`) and its peak output is ≤ 1.0;
- `exponentialRampToValueAtTime` targets are > 0 (ramp to `0.0001`, not 0);
- it uses only the **permitted Web Audio subset**, which is all the fake context implements:
  `currentTime`, `sampleRate`, `destination`, `createGain`, `createOscillator` (type
  sine/square/sawtooth/triangle; `frequency`, `detune`), `createBiquadFilter` (lowpass, highpass,
  bandpass; `frequency`, `Q`, `gain`), `createBufferSource` (`buffer`, `playbackRate`, `loop`),
  `createBuffer`, `AudioNode.connect(node | AudioParam)`/`disconnect`, `start`/`stop`/`onended`,
  and `AudioParam` `value`, `setValueAtTime`, `linearRampToValueAtTime`,
  `exponentialRampToValueAtTime`, `setTargetAtTime` and `cancelScheduledValues`. The engine may also
  use `createDynamicsCompressor`, `decodeAudioData`, `resume`, `close` and `state`.

The recipe sketches below are the designer's intent; builders tune them by ear within `durationMs`.

| SfxId | durationMs | gain | sketch |
|---|---|---|---|
| draw | 180 | 0.5 | noise → bandpass sweeping 2.5k→5k Hz, Q 1.2; 10 ms attack, decay to 0 |
| play | 260 | 0.6 | noise → bandpass 600→2400 Hz whoosh + a 180 Hz sine blip at 200 ms |
| summon | 380 | 0.9 | sine 140→45 Hz exp over 250 ms (thud) + 60 ms lowpass-800 noise puff (dust) |
| attack | 240 | 0.7 | noise → bandpass 3000→700 Hz, Q 2, 20 ms attack (swing) |
| impact | 450 | 1.0 | t = (min(amount,10)−1)/9: noise → lowpass (5000−3800t) Hz + sine thump (110−50t) Hz; peak 0.35+0.65t; length 120+330t ms |
| shieldShatter | 500 | 0.6 | 5 sine partials 2.1k/3.3k/4.7k/5.9k/7.3k Hz, 15 ms staggers, 300–450 ms decays + 80 ms highpass-4k noise |
| heal | 700 | 0.5 | FM bells (mod ratio 2, index 300 Hz) on 1047/1319/1568 Hz, 90 ms apart, 500 ms decays |
| buff | 420 | 0.5 | sawtooth 220→440 Hz → lowpass 1200→3000 Hz |
| debuff | 420 | 0.5 | sawtooth 440→200 Hz → lowpass 2000→700 Hz |
| death | 650 | 0.8 | noise → lowpass 1200→200 Hz, amplitude fluttered by an 18 Hz square LFO into gain + sine 90→40 Hz |
| burn | 600 | 0.6 | highpass-1500 noise gated by a 23 Hz square LFO (crackle) + bandpass-800 hiss, decaying |
| trapSet | 160 | 0.5 | bandpass-1200 Q 3 noise slap + 220 Hz sine tick |
| trapSting | 700 | 0.8 | square 311 Hz + square 330 Hz (dissonant) → lowpass 3000→600 Hz + 1245 Hz sine ping |
| spell | 800 | 0.5 | FM chimes 1319/1760/2093/2637 Hz, 60 ms apart, 7 Hz tremolo |
| mana | 260 | 0.4 | sine pluck 660 Hz (mine) or 440 Hz (not mine) + octave harmonic, 10 ms attack |
| turnStart | 1200 | 0.7 | FM bell 392 Hz, plus a fifth at 587 Hz when `mine`; long decay |
| victory | 1600 | 0.8 | sawtooth arpeggio 523/659/784/1047 Hz → lowpass 2500 Hz, 150 ms apart, last held 700 ms |
| defeat | 1600 | 0.8 | triangle 392/370/349/311 Hz descending, 250 ms each, last with a 5 Hz vibrato |
| uiClick | 50 | 0.25 | sine 1800 Hz, 4 ms attack, 40 ms decay + a tiny noise tick |
| uiHover | 40 | 0.08 | sine 2600 Hz blip |
| whoosh | 350 | 0.5 | noise → bandpass 400→2000→500 Hz |
| radiant | 900 | 0.5 | 6 sine glints 2637–5274 Hz, 80 ms apart, short decays, shimmer tremolo |
| lock | 400 | 0.6 | square 180 Hz × square 270 Hz ring (gain modulation) → bandpass 1500 + noise click |
| poof | 450 | 0.6 | noise → lowpass 900→300 Hz, 40 ms soft attack |
| notify | 300 | 0.4 | sine blips 880 then 1175 Hz, 90 ms each |
| drain | 600 | 0.6 | sine 300→120 Hz with a 6 Hz ±15 Hz vibrato; peak scales with amount like impact |
| cancel | 260 | 0.5 | square 330→165 Hz → lowpass 1500 Hz |
| entrance | 1400 | 0.6 | (integration) FM gong 98 Hz + sawtooth fifth 196/294 Hz → lowpass opening 600→3000 Hz, then 3 high glints; `mythic`: 6 faster glints under a 9 Hz tremolo |

### `apps/web/src/audio/engine.ts` (slice 1)

```ts
export type SpeechPort = {
  speak(text: string, voice: { pitch: number; rate: number; volume: number }, onEnd: () => void): void;
  cancel(): void;
};
/** window.speechSynthesis + SpeechSynthesisUtterance (lang "en-US"), or null when either is missing (jsdom). */
export function browserSpeechPort(): SpeechPort | null;

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
export function createAudioEngine(options?: AudioEngineOptions): AudioEngine;
/** The module singleton every hook and component uses; created on first call with default options. */
export function getAudioEngine(): AudioEngine;
/** Replace (or with null, drop) the singleton. Tests only. */
export function setAudioEngineForTests(engine: AudioEngine | null): void;
```

Engine semantics, all observable through `state()`, `log()`, `contextsCreated()` and the fake context:

- **States.** `"unsupported"` when there is no factory. `"locked"` until the first `unlock()`, and no
  context is constructed before it. Afterwards, the context's own state, with Safari's
  `"interrupted"` read as `"suspended"`.
- **`unlock()`.** On the first call it constructs the context and builds the graph: sfx gain and
  voice gain → master gain → DynamicsCompressor (threshold −6 dB, ratio 12, attack 3 ms, release
  250 ms) → destination, with bus gains from the settings. On any call while the state is not
  `"running"`, it calls `resume()` (the rejection is swallowed) and starts a one-frame silent
  `AudioBufferSourceNode` connected to `destination` (the iOS unlock). While running it does nothing.
- **Gains.** master bus = `muted ? 0 : master`, sfx bus = `sfx`, voice bus = `voice`. A settings
  change is applied with `setTargetAtTime(value, currentTime, GAIN_SMOOTHING_S)`.
- **Acceptance gate** for both play calls: a context exists, its state is not `"closed"`, the
  settings are not muted, and `visibility()` is not `"hidden"`. Voice cues also need `voiceOn`.
  Refused cues return false and are not logged. A suspended (or interrupted) context accepts and
  logs cues, flagged (`suspended: true` on an sfx entry, outcome `"suspended"` on a line), so a
  headless browser with no audio device still logs, but **schedules nothing** (review fix, B46): its
  clock stands still, and everything scheduled on it would start at once when it resumed.
- **SFX.** A cue is refused if the same id was accepted less than `SFX_RETRIGGER_MS` ago, or if
  `SFX_MAX_VOICES` accepted cues are still sounding (end = accept time + delay + recipe length, by
  `now()`). Otherwise the engine creates a per-cue GainNode (`SFX[id].gain`) into the sfx bus and
  calls the recipe at `currentTime + delayMs / 1000`.
- **Voice.** One channel with priorities (review fix, B47–B49): `playVoice(defId, line, delayMs,
  priority = VOICE_PRIORITY.play)`. A request more important than the line holding the channel cuts
  in (a line still loading is logged `"dropped"`, one speaking fades out over `VOICE_FADE_S` or has
  its speech cancelled). Otherwise it waits in a queue of at most `VOICE_QUEUE_MAX` (displacing a
  less important waiting line, or refused); when the channel frees, the most important waiting line
  starts (oldest on a tie), and one that has waited over `VOICE_QUEUE_WAIT_MS` is logged `"late"`.
  An accepted request is logged with `outcome: "pending"`, and the entry is later replaced with its
  final outcome. A rendered line plays, and holds the channel, for its audible span only. Muting or
  turning voice lines off stops the line speaking and drops the queue (B50).
  - If the key is in the manifest, the engine fetches `voiceUrl(key)` once per key, decodes it, and
    caches the promise (a failed load is cached as failed). When it is ready it starts a buffer source
    through a persona-gain node into the voice bus at `max(currentTime, requestTime + delay)`, with
    outcome `"file"`, and holds the channel until the buffer ends.
  - If the buffer is not ready `VOICE_LATE_MS` after the request, the line never starts, its outcome
    is `"late"`, and the channel is freed.
  - If the key is not in the manifest, or the load failed, the engine waits `delayMs` (setTimeout) and
    calls `speech.speak(text, { pitch, rate } = persona.web, volume = master × voice)`, with outcome
    `"speech"`. It holds the channel until `onEnd` or `VOICE_SPEECH_MAX_MS`. With no speech port the
    outcome is `"failed"`.
- **`preloadVoices(keys)`.** Only after unlock; it decodes at most `VOICE_PRELOAD_MAX` manifest keys
  not already decoded per call (a decoded one is only marked recently used). Decoded lines are kept
  for the `VOICE_DECODED_MAX` most recently used keys, and every fetched file's bytes for the page's
  life; `VOICE_PREFETCH_DELAY_MS` after the first preload on a running context, every line's bytes
  are fetched in the background (review fix, B51). Neither runs during an animation burst or while
  voice cannot be heard (CI fix, B58: `setBusy`).

### `apps/web/src/audio/unlock.ts` (slice 1)

```ts
export const UNLOCK_EVENTS = ["pointerdown", "pointerup", "touchend", "click", "keydown"] as const;
/** Adds one capture-phase, passive listener per UNLOCK_EVENTS entry on window; each calls
 *  engine.unlock() synchronously when engine.state() is neither "running" nor "unsupported".
 *  Returns the remover. Listeners stay for the hook's lifetime (iOS can re-suspend). */
export function installAudioUnlock(engine: Pick<AudioEngine, "unlock" | "state">): () => void;
```

### `apps/web/src/audio/voiceData.ts` (slice 1)

```ts
export const VOICE_LINES: VoiceLineTable;     // import raw from "./voice-lines.json", passed through parseVoiceLines
export const VOICE_MANIFEST: VoiceManifest;   // import from "./voice-manifest.json"
/** Throws Error("voice-lines.json: <path>: <problem>") on a shape error. Does NOT check word limits (tests do). */
export function parseVoiceLines(raw: unknown): VoiceLineTable;
export function voiceKey(defId: string, line: VoiceLineKind): VoiceKey;       // `${defId}-${line}`
export function voiceUrl(key: VoiceKey): string;                              // `${import.meta.env.BASE_URL}audio/voice/${key}.m4a`
/** The text and effective persona (per-card rate/pbas/pmod overrides applied) or null. */
export function lineFor(lines: VoiceLineTable, defId: string, line: VoiceLineKind): { text: string; persona: Persona } | null;
/** Keys worth preloading for a view, deduped, in this order: the viewer's hand (unit → play, spell → cast;
 *  traps none), every unit on both boards (death), the viewer's own face-up backrow traps (cast). */
export function voiceKeysForView(view: PlayerView, lines: VoiceLineTable): VoiceKey[];
```

### `apps/web/src/audio/cues.ts` (slice 2)

```ts
export type CueContext = {
  /** The view the batch was planned against (pre-batch): `viewer` and seat orientation come from here. */
  view: PlayerView;
  lines: VoiceLineTable;
  /** Current mana this player had before this event, as the director tracks it. */
  manaBefore: (player: PlayerId) => number;
};
export type CueRow<K extends GameEventType> = {
  /** The row's headline SFX, or null for an explicit silence. */
  sfx: SfxId | null;
  /** Required and non-empty exactly when sfx is null. */
  silentBecause?: string;
  cues: (event: Extract<GameEvent, { type: K }>, ctx: CueContext) => readonly SoundCue[];
};
export const SOUND_CUES: { readonly [K in GameEventType]: CueRow<K> };
export function cuesFor(event: GameEvent, ctx: CueContext): readonly SoundCue[];
```

**The cue table.** "readable" means `defId !== HIDDEN_DEF_ID` and `ctx.lines.cards[defId]` exists.
`kind` is that entry's `kind`. Every `delayMs` not written below is 0.

| Event | sfx | Cues returned |
|---|---|---|
| cardPlayed | play | (every line here at `VOICE_PRIORITY.play`) unit, readable: `play` + voice `play` @VOICE_DELAY_MS. spell, readable: `play` + `spell`@60 + voice `cast` @VOICE_DELAY_MS. trap, readable (the viewer's own set): `trapSet` only. Otherwise (hidden, or not in the table): `play` only (R203, R204) |
| cardResolved | null | silent: the effects a card resolves into carry their own events |
| summoned | summon | `summon {amount: attack + health}` of the unit as the newest view shows it (none when it cannot be found), plus `radiant`@90 for a Radiant unit, plus its `play` line at `VOICE_PRIORITY.summon` when no `cardPlayed` of that instance has sounded (review fix, B56) |
| damage | impact | amount > 0: `impact {amount}`; else none |
| healthLost | drain | amount > 0: `drain {amount}`; else none |
| healed | heal | amount > 0: `heal {amount}`; else none |
| divineShieldLost | shieldShatter | `shieldShatter` |
| destroyed | death | `death`; plus voice `death` @DEATH_VOICE_DELAY_MS at `VOICE_PRIORITY.react` when readable and kind unit (R204) |
| enteredGraveyard | null | silent: the destroy, discard or resolve that sent it there already sounded |
| exiled | poof | `poof` |
| bounced | whoosh | `whoosh` |
| burned | burn | `burn` |
| discarded | draw | `draw` |
| drawn | draw | `draw` |
| addedToHand | draw | `draw` |
| shuffledIn | whoosh | `whoosh` |
| buffed | buff | attack + health ≥ 0: `buff`; else `debuff` |
| keywordGranted | buff | `buff` |
| counterChanged | uiClick | `uiClick` |
| costChanged | null | silent: the gem ticks visually, and a cost recomputed on every read (#100) would chatter |
| modifierChanged | notify | `added`: `notify`; removed: none |
| radiantSet | radiant | `radiant` |
| transformed | poof | `poof` |
| fused | poof | `poof` |
| positionSwitched | whoosh | `whoosh` |
| controlChanged | whoosh | `whoosh` |
| rotated | whoosh | `whoosh` |
| swapped | whoosh | `whoosh` |
| locked | lock | `lock` |
| trapFired | trapSting | `trapSting`; plus voice `cast` @VOICE_DELAY_MS at `VOICE_PRIORITY.react` only when readable (the controller's seat, R154, R203) |
| attackDeclared | attack | `attack` |
| attackCancelled | cancel | `cancel` |
| manaChanged | mana | `current > ctx.manaBefore(player)`: `mana {mine: player === view.viewer, amount: current − before}`; else none |
| turnStarted | turnStart | `turnStart {mine: player === view.viewer}` |
| turnEnded | null | silent: the end-turn click has its UI tick and the next turnStarted announces the change |
| turnAutoEnded | notify | `notify` |
| promptOpened | notify | `player === view.viewer`: `notify`; else none |
| promptAnswered | null | silent: the answering click already ticked |
| drawOffered | notify | `player !== view.viewer`: `notify`; else none |
| drawAnswered | notify | `notify` |
| gameOver | victory | winner === viewer: `victory`; winner === "draw": `notify`; else `defeat` |

### `apps/web/src/audio/director.ts` (slice 2)

```ts
import type { AnimationEntry } from "../game/animations.ts";
export type SoundDirector = {
  /** Feed every newest view (Game's props.view). */
  onView(view: PlayerView): void;
  /** The runner has just started this entry. */
  onEntryStart(entry: AnimationEntry): void;
  /** The runner is idle (inFlight() === null). */
  onIdle(): void;
  /** Events seen but not yet voiced (tests). */
  owedCount(): number;
};
export function createSoundDirector(sink: SoundSink, lines?: VoiceLineTable): SoundDirector;
```

The algorithm is binding, because tests B22 and B24–B27 pin it:

- **State.** `seen: PlayerView | null`; `owed: { event, view }[]` (in stream order); `voiced: WeakSet<GameEvent>`; `lastMana: Map<PlayerId, number>`.
- **`onView(v)`.**
  - If `v === seen`, return.
  - If `seen === null` or `seen.viewer !== v.viewer`, reset: `owed = []`, `lastMana.clear()`, `seen = v`, and return. Nothing is voiced, nothing is flushed.
  - Otherwise take `fresh = eventsAfterOverlap(seen.events, v.events)`, push `{ event, view: seen }` for each fresh event not in `voiced`, add every event of `v` to `known`, and set `seen = v`. (Review fix, B55: `eventsAfterOverlap` is `newEventsSince` with `sameOccurrence`, which lets R97's sentinel match the value it later reveals, so an un-redacted `drawn` does not make the whole window new.)
- **`onEntryStart(entry)`.**
  - Find `entry.events[0]` in `owed` by identity. If it is at index `i > 0`, flush `owed.splice(0, i)` first.
  - Then, for each `entry.events[k]`: let `view` be the owed item's view, or `seen` if the item is absent; resolve `cuesFor(event, ctx(view))` and send every cue at `cue.delayMs + (k > 0 ? PAIR_OFFSET_MS : 0)`; add the event to `voiced`; remove it from `owed`. An event in `known` that was not owed is old news the runner is replaying and sends nothing.
- **`onIdle()`.** If `owed` is non-empty, flush all of it.
- **flush(items).**
  - Resolve every item's cues in order and mark every item voiced.
  - SFX: keep the first cue of each `SfxId`. If a `gameOver` item produced a cue, remove it from that list and reserve it for the end. Take the first `FLUSH_MAX_SFX` (or `FLUSH_MAX_SFX − 1` when a gameOver cue is reserved), append the gameOver cue, and send cue `j` at `j × FLUSH_GAP_MS`, ignoring its own delay.
  - Voice: send only the most important voice cue (the first on a tie), at its own `delayMs`.
- **`ctx(view).manaBefore(p)`** is `lastMana.get(p)` ?? the `mana.current` of whichever side of `view` has `player === p`. After resolving any `manaChanged`, set `lastMana(p) = event.current`.
- **Identity.** Events are matched by object identity. `newEventsSince` and `planEntries` both hand out the very objects in `view.events`.

### `apps/web/src/audio/useGameAudio.ts` (slice 2)

```ts
import type { AnimationQueue } from "../game/animations.ts";
export function useGameAudio(runner: AnimationQueue, view: PlayerView): void;
```

In this order inside the hook:

1. **`director`**: a `useRef`, lazily `createSoundDirector(getAudioEngine())`.
2. **`useLayoutEffect(() => director.onView(view), [view])`.** It must run **before** Game's
   enqueue layout effect, which is why the call site is fixed below.
3. **`useLayoutEffect` subscribing to `runner`.** Keep `last = runner.inFlight()`. On each
   notification, read `e = runner.inFlight()`: if `e !== null && e !== last`, call
   `director.onEntryStart(e)`; if `e === null`, call `director.onIdle()`; then `last = e`. Unsubscribe
   on cleanup. The same notifications drive `engine.setBusy(e !== null)` (B58), set before the
   entry's cues and cleared after the idle flush's, and cleanup clears it.
4. **`useEffect(() => { if (runner.idle()) director.onIdle(); }, [view, runner])`.** It runs after
   every layout effect, which covers reduced motion, where the runner drains inside `enqueue`.
5. **`useEffect` on mount.** It runs `installAudioUnlock(engine)`, `installUiSounds(engine, document)`
   and `exposeAudioDebug(engine)`, and removes all three on unmount.
6. **`useEffect(() => { if (engine.state() === "running") engine.preloadVoices(voiceKeysForView(view, VOICE_LINES)); }, [view])`.**

The hook never throws. With no AudioContext (jsdom) every call inside it is a no-op.

### `apps/web/src/audio/uiSounds.ts`, `debug.ts` (slice 2)

```ts
export const UI_CLICK_SELECTOR = 'button:not(:disabled), [role="button"]:not([aria-disabled="true"]), [data-legal="true"]';
export const UI_HOVER_SELECTOR = 'button:not(:disabled), [data-legal="true"]';
/** "click" → closest(UI_CLICK_SELECTOR) → playSfx("uiClick"). "pointerover" with pointerType "mouse" →
 *  closest(UI_HOVER_SELECTOR) that differs from the last hovered one and is ≥ UI_HOVER_THROTTLE_MS after the
 *  last hover sound → playSfx("uiHover"). Returns the remover. */
export function installUiSounds(sink: Pick<SoundSink, "playSfx">, root: Document | HTMLElement, now?: () => number): () => void;
```

```ts
export type AudioDebugHandle = {
  state(): AudioState;
  log(): readonly PlayedCue[];
  clearLog(): void;
  contextsCreated(): number;
};
declare global {
  interface Window {
    /** Outside production builds only (like window.__jackioh). */
    __jackiohAudio?: AudioDebugHandle;
  }
}
/** Sets window.__jackiohAudio when import.meta.env.MODE !== "production"; the remover deletes it if it is still ours. */
export function exposeAudioDebug(engine: AudioEngine): () => void;
```

### Components (slice 2)

| Component | Props | Root | data-testids | Behaviour |
|---|---|---|---|---|
| `AudioToggle` (default export of `AudioToggle.tsx`) | `{ className?: string }` | `<button type="button" class="audio-toggle">` | `audio-toggle` | `aria-pressed={muted}`, `aria-label` "Mute sound" / "Unmute sound", `title` the same; inline SVG speaker (with waves / with a cross); click → `writeAudioSettings({ muted: !muted })` |
| `AudioControls` (default export of `AudioControls.tsx`) | `{ className?: string }` | `<fieldset class="audio-controls">` with `<legend>Audio</legend>` | `audio-controls`, `audio-master`, `audio-sfx`, `audio-voice` (`<input type="range" min=0 max=100 step=5>`, value = round(x×100)), `audio-mute`, `audio-voice-on` (`<input type="checkbox">`) | each input's `onChange` writes `value / 100` or the checked flag through `writeAudioSettings`; every input has a `<label>` |

`audio.css` (imported by `AudioToggle.tsx`) positions the toggle `position: fixed; top: calc(8px + env(safe-area-inset-top, 0px)); right: calc(8px + env(safe-area-inset-right, 0px)); width: 44px; height: 44px; z-index: 20` (below the prompt modal's 40 and the overlays), and uses only `index.css` tokens (`--bg-raised`, `--line`, `--text`). Task 7 may move it into its HUD at integration.

### `apps/web/src/audio/index.ts` (slice 2)

```ts
export { useGameAudio } from "./useGameAudio.ts";
export { default as AudioToggle } from "./AudioToggle.tsx";
export { default as AudioControls } from "./AudioControls.tsx";
export { getAudioEngine } from "./engine.ts";
export { DEFAULT_AUDIO_SETTINGS, readAudioSettings, subscribeAudioSettings, useAudioSettings, writeAudioSettings } from "./settings.ts";
export type { AudioSettings, AudioState, SfxId } from "./types.ts";
```

### The `Game.tsx` edit (slice 2, the whole of it)

These are three additive lines at fixed points, and nothing else in the file changes:

1. After the `import "./animations.css";` line:
   `import { AudioToggle, useGameAudio } from "../audio/index.ts";`
2. Directly after `const runner = queue.current;`, before any `useLayoutEffect`:
   `useGameAudio(runner, view); // before the layout effects below: it must see each view before the runner is fed (audio/useGameAudio.ts)`
3. Directly after the `animation-queue` span expression (`{inFlight === null ? null : (…)}`):
   `<AudioToggle />`

### `voice-lines.json` shape (slice 3; the content table follows)

```json
{
  "version": 1,
  "personas": {
    "guard": { "say": "Ralph", "rate": 175, "pbas": 38, "pmod": 20, "web": { "pitch": 0.8, "rate": 0.95 } }
  },
  "cards": {
    "core-004": { "kind": "unit", "persona": "hustler", "play": "Double or nothing, baby!", "death": "House always wins." },
    "core-005": { "kind": "spell", "persona": "narrator", "cast": "Hoarding is self care." },
    "core-016": { "kind": "spell", "persona": "hustler", "cast": "Nothing personal, pal.", "rate": 170, "pbas": 32 }
  }
}
```

Keys are sorted (personas by id, cards by catalog order), and the file is written with 2-space JSON
and a trailing newline.

### `voice-manifest.json` and `voiceHash` (slice 3 writes; slice 1 reads; tester B recomputes)

```json
{ "version": 1, "format": "m4af aac@22050 mono 32000", "files": { "core-004-play": { "hash": "0123456789abcdef", "bytes": 11698 } } }
```

`voiceHash = sha1(JSON.stringify({ v: 1, say, rate, pbas, pmod, text })).hex.slice(0, 16)`. The keys go
in exactly that order, and `rate/pbas/pmod` are the **effective** values (card override ?? persona).
Changing the encoding flags means bumping `v`.

### `apps/web/scripts/gen-voice.mjs` (slice 3)

```
node apps/web/scripts/gen-voice.mjs [--check] [--force] [--only <defId>] [--root <webDir>]
pnpm --filter @jackioh/web gen:voice          # the package.json script: "gen:voice": "node scripts/gen-voice.mjs"
```

- `--root` defaults to the script's parent (`apps/web`). It reads `<root>/src/audio/voice-lines.json`,
  writes `<root>/src/audio/voice-manifest.json` and `<root>/public/audio/voice/<key>.m4a`, and reads
  `packages/cards/catalog.json` relative to the repo, for the id check.
- **Generate** (the default; macOS only, otherwise it prints `gen-voice: needs macOS say and afconvert`
  and exits 2). For every expected key it computes `voiceHash`. It skips the key when the manifest
  hash matches and the file exists (unless `--force`). Otherwise it runs
  `say -v <persona.say> -o <tmp>/<key>.aiff "[[rate R]] [[pbas P]] [[pmod M]] <text>"`, then
  `afconvert -f m4af -d aac@22050 -c 1 -b 32000 <tmp>.aiff <root>/public/audio/voice/<key>.m4a`, and
  records `{ hash, bytes }`. The tmp dir comes from `fs.mkdtempSync(os.tmpdir())` and is removed at
  the end. It then deletes orphan files and manifest entries, writes the manifest (stable, sorted),
  prints `du -sk` of the voice dir, and exits 1 if Σ bytes > 3 MiB or any `afinfo` duration is
  > 4.0 s. A second run with no input change writes nothing (idempotent by hash).
- **`--check`** (any OS, no `say`). It exits 0 and prints `gen-voice: ok, <n> files, <bytes> bytes`
  when every expected key has a manifest entry whose hash matches and a file of that size, and there
  are no orphan files or entries and the total is within budget. Otherwise it prints one line per
  problem, each starting with the key (e.g. `core-004-play: stale hash`), and exits 1.
- It uses spawn with an argument array (voice names contain spaces and parentheses), and there is no
  new dependency.

### Personas (slice 3 writes these into `voice-lines.json`)

Voices come from `say -v "?"` on macOS 15 (Darwin 24.5) and were chosen for personality. Builders
may nudge rate by ±15 and pbas by ±10 per persona after listening, and record it in the JSON.

| persona | `say` voice | rate | pbas | pmod | web pitch / rate | character | used by |
|---|---|---|---|---|---|---|---|
| guard | Ralph | 175 | 38 | 20 | 0.8 / 0.95 | stoic defenders | #1, #3, #73, #84 |
| hero | Reed (English (US)) | 190 | 45 | 35 | 1.0 / 1.0 | earnest champions | #15, #20, #32, #44, #45, #69, #98 |
| hustler | Rocko (English (US)) | 215 | 50 | 45 | 1.0 / 1.15 | gamblers, dealers, salesmen | #4, #16, #24, #53, #75 |
| kid | Junior | 225 | 62 | 50 | 1.4 / 1.2 | hyperactive kids | #11, #48, Rush Token |
| robot | Zarvox | 185 | 40 | 10 | 0.6 / 1.0 | machines | #13, #14, #33, #56, #74 |
| brute | Fred | 165 | 28 | 15 | 0.5 / 0.9 | big simple bodies | #19, #22, #25, #55, #66, #95.1 |
| diva | Samantha | 185 | 55 | 60 | 1.2 / 1.0 | glamour | #54, #81, #90 |
| prof | Daniel | 180 | 42 | 30 | 0.9 / 1.0 | academics | #31, #42, #51, #57, #64, #77, #82 |
| crone | Grandma (English (US)) | 170 | 50 | 40 | 1.1 / 0.9 | grannies | #6, #18, #62, #92 |
| elder | Grandpa (English (UK)) | 165 | 35 | 30 | 0.8 / 0.9 | old hands | #58, #68, #91 |
| whisper | Whisper | 160 | 40 | 20 | 0.9 / 0.85 | arcane, dreams, pain | #23, #30, #35, #40, #46, #65, #70, #76, #79, #97 |
| alien | Trinoids | 170 | 45 | 20 | 0.5 / 0.9 | the unknowable | #88, #89, #100 |
| cat | Kathy | 210 | 70 | 70 | 1.8 / 1.2 | Felinors | #12, #43, #86, Felinor Token |
| sheep | Bahh | 180 | 55 | 40 | 1.5 / 1.0 | sheep | #41, Sheep Token |
| goof | Boing | 190 | 50 | 40 | 1.3 / 1.1 | slapstick | #7, #9, #21, #36, #52, #60, #65.1, #87, #90.1, #93.1, Bread Token |
| wobble | Wobble | 180 | 45 | 40 | 1.2 / 1.0 | jelly beans | #26, #27, #28 |
| zoomer | Flo (English (US)) | 205 | 55 | 50 | 1.3 / 1.15 | Gen Z | #39, #50, #51.1, #67, #71 |
| narrator | Eddy (English (UK)) | 185 | 45 | 35 | 1.0 / 1.0 | neutral caster | #5, #34, #59, #80, #99 |
| announcer | Superstar | 190 | 50 | 50 | 1.2 / 1.1 | hype | #10, #29, #38, #78, #83, #93, #95 |
| digger | Karen | 185 | 45 | 35 | 1.0 / 1.0 | cheerful gravedigger | #37 |
| storyteller | Moira | 180 | 50 | 40 | 1.1 / 0.95 | warm nostalgia | #47, #72 |
| bubbles | Bubbles | 180 | 45 | 30 | 1.0 / 1.0 | underwater | #17 |
| posh | Shelley (English (UK)) | 185 | 52 | 45 | 1.2 / 1.0 | posh | #49, #63 |
| snob | Albert | 170 | 40 | 30 | 0.8 / 0.9 | pompous | #2, #61, #85, #94, #96 |
| plain | Eddy (English (US)) | 170 | 40 | 0 | 1.0 / 0.9 | aggressively normal | #8 |

Per-card overrides: core-016 `rate 170, pbas 32` (mob-boss hustler), core-095-1 `pbas 20`,
core-100 `rate 150, pbas 25`. The singing novelty voices (Bad News, Good News, Bells, Cellos, Organ,
Jester) are **not** used: they measured 3.5–5.8 s for four words and ignore `[[rate]]`.

**Loudness trims** (`gain`, applied at runtime to a persona's files only; not part of `voiceHash`,
so changing one renders nothing). The `say` voices come out of `afconvert` up to 12.5 dB apart:
Boing, Zarvox, Fred and Trinoids quiet; Junior, Samantha and Karen loud. Measured on the
committed files with an approximate ITU-R BS.1770 gated, K-weighted loudness, each persona is trimmed
to the narrator's level (Eddy UK, about −21 LUFS). A trim is clamped to 0.5–2, capped so the persona's
loudest peak stays under −1 dBFS, and left out when under 1 dB. That leaves the personas within
1.3 dB of each other (goof, at the 2.0 cap, ends 1.3 dB under):

| persona | gain | persona | gain | persona | gain |
|---|---|---|---|---|---|
| goof | 2 | snob | 1.32 | zoomer | 0.87 |
| robot | 1.72 | wobble | 1.26 | posh | 0.84 |
| brute | 1.71 | hustler | 1.22 | cat | 0.83 |
| alien | 1.66 | plain | 1.16 | storyteller | 0.67 |
| elder | 1.56 | hero | 1.16 | digger | 0.62 |
| bubbles | 1.55 | sheep | 1.13 | diva | 0.61 |
| guard | 1.53 | | | kid | 0.55 |
| whisper | 1.46 (peak-capped) | | | | |

crone, announcer, narrator and prof need less than 1 dB and carry no `gain`. Re-measure after any
persona's voice, rate or pitch changes.

### Voice lines (slice 3 transcribes this table into `voice-lines.json` verbatim)

These are written in character from each card's name and §8 text. Play lines are at most 8 words,
death lines at most 6 and cast lines at most 8. No line restates rules text, and none uses
`BANNED_RULES_WORDS`. The draft was checked against the catalog, the word limits, the charset and the
banned list, and generated in full once on this machine (see Research). Cards with edgy names (#2,
#42, #59, #61, #90, #90.1, #91) lampoon the premise and never a group of people.

| defId | Card | kind | persona | play / cast line | death line |
| --- | --- | --- | --- | --- | --- |
| core-001 | Big D-fender | unit | guard | Stand behind me. Way behind. | Defense... offended. |
| core-002 | Bigot | unit | snob | Ugh. Not your kind again. | Tolerance wins. Again. |
| core-003 | Right-house defender | unit | guard | For the right house! | Be right back. |
| core-004 | Gary the Gambler | unit | hustler | Double or nothing, baby! | House always wins. |
| core-005 | Stockpile | spell | narrator | Hoarding is self care. |  |
| core-006 | Mana Well | spell | crone | Drink up, dearie. |  |
| core-007 | Jewelosco Scarab | unit | goof | Clean up on aisle you! | Price check... on death. |
| core-008 | Mr. Vanilla | unit | plain | Hello. I am very normal. | Plain. Simple. Gone. |
| core-009 | Moths to the Flame | unit | goof | Ooh! Pretty light! Pretty light! | Totally worth it. |
| core-010 | Rapid Replenish | spell | announcer | Restock, restock, restock! |  |
| core-011 | Tempo Timmy | unit | kid | Outta my way, slowpokes! | Too... slow... |
| core-012 | Duplicating Felinors | unit | cat | Meow. Meow again. | Both of us? |
| core-013 | Jlockeed Shredder-10 | unit | robot | Shredder online. Paperwork offline. | Warranty void. |
| core-014 | Jlockeed's Weapons | spell | robot | Defense contract approved. |  |
| core-015 | Me and Mr Token | unit | hero | Me and my buddy! | Tell Mister Token goodbye. |
| core-016 | Hit Job | spell | hustler (rate 170, pbas 32) | Nothing personal, pal. |  |
| core-017 | Flood | spell | bubbles | Surf's up! Everybody out! |  |
| core-018 | Bread and Butter | trap | crone | Waste not, want toast. |  |
| core-019 | Midrange Menace | unit | brute | Not too big. Not too small. | Should have gone aggro. |
| core-020 | Pointmaster | unit | hero | Allow me to make a point. | Pointless. |
| core-021 | Hinder | spell | goof | Oops! Did I trip you? |  |
| core-022 | Carnivorous Cube | unit | brute | Nom. Nom nom. Cube. | Indigestion... |
| core-023 | Reoccurring Dream | spell | whisper | Wait. Haven't we done this? |  |
| core-024 | Efficiency Dividend | spell | hustler | Synergy! Leverage! Profit! |  |
| core-025 | 4-mana 7/7 | unit | brute | Big. Honest. Boring. | Fair enough. |
| core-026 | Glowy Jelly Bean | spell | wobble | Taste the glow! |  |
| core-027 | Blood Ridden Glowy Jelly Bean | spell | wobble | Mmm. Tastes like pennies. |  |
| core-028 | Knockoff Temu Glowy Jelly Bean | spell | wobble | Ships in six to eight weeks. |  |
| core-029 | GIGA Glowy Jelly Bean | spell | announcer | Giga! Bean! Time! |  |
| core-030 | Archivist | unit | whisper | Shh. I'm filing. | Overdue. Forever. |
| core-031 | KY's Math Equation | spell | prof | Show your work! |  |
| core-032 | Prem Panther | unit | hero | Premium predator. No ads. | Subscription cancelled. |
| core-033 | Unstable Clone Machine | spell | robot | Copy that. Copy that. Copy that. |  |
| core-034 | Collateral Damage | spell | narrator | Oops. Also, oops. |  |
| core-035 | Lunar Eclipse | spell | whisper | Lights out, moon's up. |  |
| core-036 | Magic Jammed | spell | goof | Jammed it! Sorry, not sorry. |  |
| core-037 | Gravedigger | unit | digger | Finders keepers, dead folks. | Dig me a nice one. |
| core-038 | Quickstriker | spell | announcer | Faster! Faster! Faster! |  |
| core-039 | Recycling Initiative | spell | zoomer | Reduce, reuse, replay! |  |
| core-040 | Echoes of the Forgotten | spell | whisper | Remember us. Remember us. |  |
| core-041 | Sheepish | trap | sheep | Baa. Surprise. |  |
| core-042 | Eugenics | spell | prof | Science has gone too far. |  |
| core-043 | Big Felinor | unit | cat | Big cat. Bigger problems. | Landed on my back? |
| core-044 | True Strike | spell | hero | Bullseye, baby. |  |
| core-045 | Deft Duelist | unit | hero | En garde! And also, en garde! | Well played. Ow. |
| core-046 | Suppressive Aura | spell | whisper | Everybody calm down. Forever. |  |
| core-047 | Fig of Life | spell | storyteller | A fig a day! |  |
| core-048 | 5pek Controller | spell | kid | Reverse card! Everybody! |  |
| core-049 | Snom Bunny Mind Control | spell | posh | Hop along. You're mine now. |  |
| core-050 | Kpop Fanatic | unit | zoomer | Oppa! I'm your biggest fan! | Tell my bias goodbye. |
| core-051 | KY's Private Tutor | spell | prof | Pencils down. Pick one. |  |
| core-051-1 | KY's Empty Notebook | spell | zoomer | Blank page energy. |  |
| core-052 | Silly Silas | unit | goof | Round and round we go! | So... dizzy... |
| core-053 | Reno | unit | hustler | Reno's here! Party's saved! | Luck... ran out. |
| core-054 | Straaza | unit | diva | Shopping spree! On the house! | Out of stock. |
| core-055 | Lava Golem | unit | brute | Hot stuff. Coming through. | Cooling... off... |
| core-056 | Jilliax | unit | robot | Jilliax! Deluxe! Edition! | Recall notice issued. |
| core-057 | Conjure KY | spell | prof | Study group, assemble! |  |
| core-058 | Rush Token Farm | spell | elder | Fresh tokens, farm to table! |  |
| core-059 | Unbiased Immigration | spell | narrator | Welcome in, whoever you are! |  |
| core-060 | Bear Honeypot | trap | goof | Mmm, honey. Oh no. Bears. |  |
| core-061 | Prejudiced Postdoc | unit | snob | Peer review? Rejected. | My grant... expired. |
| core-062 | Friend of Felinors | spell | crone | Here kitty kitty kitty! |  |
| core-063 | Plastic Surgery | spell | posh | New face, who dis? |  |
| core-064 | Gifted Program | spell | prof | You're all special. Mostly you. |  |
| core-065 | Masochism Mask | spell | whisper | Hurts so good. |  |
| core-065-1 | Spikey Pillow | unit | goof | Hug me. I dare you. | Pop. |
| core-066 | The Rock | unit | brute | Rock solid. Rock steady. | Just gravel now. |
| core-067 | Zoomerbin Oomen | unit | zoomer | No cap, this lane's mine. | I'm literally dead. |
| core-068 | Twisted Sorcerer | unit | elder | Twist and shout! Mostly shout! | Untwisted... |
| core-069 | Call to Arms | spell | hero | Everybody grab a sword! |  |
| core-070 | Spiteful Stab | spell | whisper | This is for everything. |  |
| core-071 | Intern Stimmy | trap | zoomer | Unpaid, but motivated! |  |
| core-072 | Reminisce | spell | storyteller | Ah, the good old days. |  |
| core-073 | Anti-oneshot Armor | spell | guard | Nice try. Not today. |  |
| core-074 | Adaptive UI | spell | robot | Now responsive on all devices! |  |
| core-075 | Infinite Reserves | spell | hustler | There's always more in the back. |  |
| core-076 | Field of Dreams | spell | whisper | If you build it... |  |
| core-077 | Professor Curvature | unit | prof | Grading on a curve, people! | Class... dismissed. |
| core-078 | /fullsend | spell | announcer | Full send! No brakes! |  |
| core-079 | Twinspell | spell | whisper | Say it twice. Say it twice. |  |
| core-080 | Zao Gao | spell | narrator | Zao gao! Oh no, oh no! |  |
| core-081 | Radiant Saintess | unit | diva | Bask in my glow, darlings. | Shine on without me. |
| core-082 | KY's Trial | spell | prof | Pick a number. Any number. |  |
| core-083 | Transmogulate | spell | announcer | Abracadabra! Everything's fancy now! |  |
| core-084 | Going Long | spell | guard | Going long! Go deep! |  |
| core-085 | Unlicensed Experimentation | trap | snob | No license. No problem. |  |
| core-086 | "Miss" Mrow | unit | cat | Mrow. Don't touch me. | You're all mine now. |
| core-087 | Pocket Chaos | spell | goof | Chaos! Now pocket sized! |  |
| core-088 | Twisting Nether | spell | alien | Everybody. Into the void. |  |
| core-089 | Corpse Eater | unit | alien | Anyone gonna finish that? | Finally... full. |
| core-090 | CN-Viral Injection | spell | diva | Just a little pinch. |  |
| core-090-1 | CN-Virus | spell | goof | Achoo! Sorry. Achoo! |  |
| core-091 | Fed Fauci | unit | elder | Trust the science. Please. | Wash your hands. |
| core-092 | Felinor Fiender | unit | crone | Cats. I need more cats. | Who feeds them now? |
| core-093 | Combo-Index | spell | announcer | Style points! Grade me! |  |
| core-093-1 | Combo-Fodder | spell | goof | Just a little something. |  |
| core-094 | Genn's Greed | spell | snob | Greed is good. Mostly. |  |
| core-095 | Call to Chaos (Core Edition) | spell | announcer | Roll the dice! Pray nice! |  |
| core-095-1 | Chaos Golem | unit | brute (pbas 20) | Chaos golem! Smash everything! | Order... restored. |
| core-096 | My Pawn | trap | snob | Checkmate, puppet. |  |
| core-097 | Zephyrs | spell | whisper | I know exactly what you need. |  |
| core-098 | Heroic Power | spell | hero | With great power... whatever. |  |
| core-099 | Craft a Card | spell | narrator | Some assembly required. |  |
| core-100 | Ceaseless Void | unit | alien (rate 150, pbas 25) | Nothing lasts. Except me. | Even I... end. |
| core-t-rush | Rush Token | unit | kid | Go go go go! | Gone too fast. |
| core-t-sheep | Sheep Token | unit | sheep | Baa? | Baa... |
| core-t-felinor | Felinor Token | unit | cat | Mew! | Mew... |
| core-t-bread | Bread Token | unit | goof | I'm bread. Butter me up. | Crumbs. |

`kind` follows the catalog `type`: Unit → `unit`; Spell and Field Spell → `spell`; Trap and Field
Trap → `trap`. That gives 43 units × 2 + 66 × 1 = **152 files**.

### Other surfaces

- **Settings key:** `localStorage["jackioh.audio.v1"]`.
- **Window handle:** `window.__jackiohAudio` (non-production only).
- **data-testids:** `audio-toggle`, `audio-controls`, `audio-master`, `audio-sfx`, `audio-voice`,
  `audio-mute`, `audio-voice-on`.
- **URL:** `GET /audio/voice/<defId>-<play|death|cast>.m4a`.
- **Imported from task 1's file, read-only:** `newEventsSince`, `planEntries` and the types
  `AnimationEntry` and `AnimationQueue` from `apps/web/src/game/animations.ts`. They are used exactly
  as they exist at `fc60b67`. No new `GameEvent` types.

## Behaviors

1. **B1**: Before any gesture no AudioContext exists: after `createAudioEngine({ createContext: fake })` and any `playSfx`/`playVoice` calls, `contextsCreated()` is 0, `state()` is `"locked"`, both calls return false and `log()` is empty (engine.test.ts).
2. **B2**: With `installAudioUnlock`, the first `pointerdown`, `pointerup`, `touchend`, `click` or `keydown` dispatched on `window` synchronously constructs exactly one context, calls `resume()` and starts a one-frame silent buffer source inside that dispatch. Later gestures call `resume()` again only while the fake reports a state other than `"running"`, and `contextsCreated()` stays 1 (unlock.test.ts).
3. **B3**: With `createContext: null` (jsdom's default), `state()` is `"unsupported"`, `unlock()` and every play call are no-ops returning false, nothing throws, and `log()` stays empty (engine.test.ts).
4. **B4**: After unlock the fake records sfx gain and voice gain → master gain → DynamicsCompressor → destination, with gains `muted ? 0 : master`, `sfx` and `voice`, and a later `writeAudioSettings` reaches the live gains through `setTargetAtTime` (engine.test.ts).
5. **B5**: After unlock, `playSfx`/`playVoice` return false and log nothing while `muted` or while `visibility()` is `"hidden"`, and `playVoice` also while `voiceOn` is false. Otherwise they return true and append to `log()`, which keeps only the last `LOG_LIMIT` entries (engine.test.ts).
6. **B6**: A second `playSfx` of the same id within `SFX_RETRIGGER_MS` is refused, and with `SFX_MAX_VOICES` accepted cues still sounding by the injected clock, the next cue is refused (engine.test.ts).
7. **B7**: While a voice line is pending or sounding (until its audible span elapses, or until speech `onEnd` or `VOICE_SPEECH_MAX_MS`), a request of no higher priority waits, logged pending, and starts when the channel frees; with `VOICE_QUEUE_MAX` already waiting it is refused and not logged (engine.test.ts; revised by the review fixes).
8. **B8**: A manifest key is fetched once from `/audio/voice/<defId>-<line>.m4a`, decoded, and started on the voice bus at `currentTime + delayMs/1000`, with the log outcome becoming `"file"`. A second play of the same key makes no second fetch (engine.test.ts).
9. **B9**: A key absent from the manifest, or one whose fetch or decode rejects, is spoken through the speech port with the line text, the persona's `web` pitch and rate, and volume `master × voice`, with outcome `"speech"`. With no speech port the outcome is `"failed"` (engine.test.ts).
10. **B10**: A line whose buffer is not ready `VOICE_LATE_MS` after it takes the channel (its request, unless it waited in the queue) is never started, its outcome is `"late"`, and the next `playVoice` is accepted (engine.test.ts).
11. **B11**: `preloadVoices` does nothing before unlock, and after unlock it fetches at most `VOICE_PRELOAD_MAX` manifest keys not decoded before (engine.test.ts).
12. **B12**: `readAudioSettings()` returns `DEFAULT_AUDIO_SETTINGS` when storage is empty, holds invalid JSON, or throws. Each field is validated on its own: numbers are clamped to [0,1], non-finite numbers and non-booleans take the default (settings.test.ts).
13. **B13**: `writeAudioSettings(patch)` clamps, stores JSON under `jackioh.audio.v1` and notifies each subscriber once. It still updates in memory when `setItem` throws, and a `storage` event for the key re-reads it and notifies (settings.test.ts).
14. **B14**: For every `SFX_IDS` id and params `{}`, `{amount: 1}`, `{amount: 25}` and `{mine: true}`, the recipe, run on the fake context, schedules nothing before `at`, stops every source by `at + returned`, returns ≤ `durationMs/1000`, connects only into `out` and uses only the permitted subset (sfx.test.ts).
15. **B15**: In real Chrome, every recipe rendered alone in an `OfflineAudioContext` yields finite samples with a peak in [0.01, 1.0], and a peak < 0.001 after its `durationMs` (component spec).
16. **B16**: In real Chrome, `impact` RMS strictly increases across amount 1 → 4 → 10, and amount 25 renders the same RMS as 10 within 1% (component spec).
17. **B17**: `SOUND_CUES` has exactly one row per `GAME_EVENT_TYPES` member. A row with `sfx: null` has a non-empty `silentBecause`, and every cue id any row returns for the sample events is in `SFX_IDS` (cues.test.ts).
18. **B18**: R204 `cardPlayed`: a readable unit gives `play` plus its `play` line at `VOICE_DELAY_MS`; a readable Spell or Field Spell gives `play`, `spell` and its `cast` line; a defId not in the table gives `play` only (cues.test.ts).
19. **B19**: R204 `destroyed` of a readable unit gives `death` plus its `death` line at `DEATH_VOICE_DELAY_MS`; a non-unit gives `death` only; and `bounced`, `exiled`, `transformed` and `fused` never give a voice cue (cues.test.ts). A `summoned` speaks only as B56 says.
20. **B20**: R203: a `cardPlayed` or `destroyed` whose defId is `"hidden"` gives no voice cue, the viewer's own trap `cardPlayed` gives `trapSet` only, and `trapFired` gives `trapSting` plus the cast line when its defId is readable and `trapSting` alone when it is `"hidden"` (cues.test.ts).
21. **B21**: `damage`, `healed` and `healthLost` with amount 0 give nothing, and with amount n they give `impact`, `heal` or `drain` with `params.amount === n`. `buffed` gives `buff` when attack + health ≥ 0 and `debuff` otherwise (cues.test.ts).
22. **B22**: `manaChanged` gives `mana` (`mine` when the player is the viewer) only when `current` exceeds the baseline. The director's baseline starts at the planned view's `mana.current` for that player and then follows each resolved `manaChanged` (cues.test.ts, director.test.ts).
23. **B23**: `gameOver` gives `victory` to the winner's seat, `defeat` to the other and `notify` on a draw. `promptOpened` sounds only for its own player, `drawOffered` only for the other seat, and `turnStarted` carries `mine` (cues.test.ts).
24. **B24**: Cues play when an entry starts, not when a view arrives: `onView` sends nothing to the sink, `onEntryStart` sends exactly that entry's cues, and the second event of a collapsed `cardPlayed`+`summoned` entry (from `planEntries`) is offset by `PAIR_OFFSET_MS` (director.test.ts).
25. **B25**: Events the runner never started (a reduced-motion plan, `gameOver`'s 0 ms entry, a drain) are flushed once by `onIdle`: SFX deduped by id in stream order, at most `FLUSH_MAX_SFX`, `FLUSH_GAP_MS` apart, at most one voice cue (the most important, the first on a tie), and the `gameOver` cue always present and last (director.test.ts).
26. **B26**: No event is voiced twice, whether across overlapping event windows, the same view fed twice, an `onIdle` after an entry already voiced it, or two `onIdle` calls in a row (director.test.ts).
27. **B27**: R203: the first view, and any view whose `viewer` differs from the last, voice nothing and drop every owed event, so a later `onIdle` sends nothing (director.test.ts).
28. **B28**: `Game` renders in jsdom with no AudioContext, shows `audio-toggle`, and every pre-existing web test stays green. With a fake engine from `setAudioEngineForTests`, a new view carrying a unit `cardPlayed` reaches the fake's `playVoice(defId, "play")` only once fake timers start that entry, and under `setReducedMotion(true)` it arrives through the flush (ui.test.tsx).
29. **B29**: `audio-toggle` has `aria-pressed` equal to `muted` and the label "Mute sound" or "Unmute sound". A click flips `muted` and persists it, and a remounted toggle shows the stored value (ui.test.tsx).
30. **B30**: `AudioControls` renders `audio-master`, `audio-sfx` and `audio-voice` ranges (0–100, step 5) plus `audio-mute` and `audio-voice-on` checkboxes bound to the store. Changing a range writes `value/100`, and toggling a checkbox writes its flag (ui.test.tsx).
31. **B31**: A click on an enabled `button`, a `[role="button"]` or a `[data-legal="true"]` element plays `uiClick`, while a disabled button plays nothing. A mouse `pointerover` onto a new such element plays `uiHover` at most once per `UI_HOVER_THROTTLE_MS`, and a touch or pen `pointerover` plays nothing (ui.test.tsx).
32. **B32**: Outside production, mounting `Game` sets `window.__jackiohAudio` with `state`, `log`, `clearLog` and `contextsCreated` of the singleton engine, and unmounting removes it (ui.test.tsx).
33. **B33**: `voice-lines.json` holds exactly the 109 catalog ids, each `kind` matches the catalog type, units have `play` and `death` and nothing else has either, non-units have `cast`, and every referenced persona exists with a non-empty `say`, rate 90–360, pbas and pmod 0–127, web pitch 0–2 and web rate 0.1–10 (voice-lines.test.ts).
34. **B34**: Every line is non-empty, matches `^[A-Za-z ,.'!?-]+$`, has at most `VOICE_MAX_WORDS[line]` words (counting tokens that contain a letter), and contains no `BANNED_RULES_WORDS` entry as a whole word, case-insensitive (voice-lines.test.ts).
35. **B35**: The 152 expected files exist under `apps/web/public/audio/voice/`, each has `ftyp` at byte 4 and brand `M4A ` at byte 8, the manifest lists exactly those keys with each file's byte size and its recomputed `voiceHash`, the directory holds nothing else, and every file's MP4 header (`moov`/`mvhd`, priming frames included) puts it within `VOICE_FILE_MAX_MS` (voice-assets.test.ts).
36. **B36**: The voice set fits the budget: Σ ceil(bytes/4096) × 4096 ≤ `VOICE_BUDGET_BYTES` (voice-assets.test.ts).
37. **B37**: `node apps/web/scripts/gen-voice.mjs --check` exits 0 on the committed tree. Run with `--root` on a temp copy whose `core-004` play line was edited, it exits 1 and prints a line starting `core-004-play` (voice-assets.test.ts).
38. **B38**: In Cypress Chrome on `/dev/hotseat`, before any gesture `__jackiohAudio.contextsCreated()` is 0. After one click on the board it is 1 and `state()` is neither `"locked"` nor `"unsupported"`, and playing a unit from hand through the UI appends a `voice` log entry with that defId and `line: "play"` (15-audio.cy.ts).
39. **B39**: In Cypress Chrome, after clicking `audio-toggle` and reloading, the toggle is `aria-pressed="true"` and playing a card appends nothing to the log, and `GET /audio/voice/core-004-play.m4a` answers 200 with an `audio/*` content type (15-audio.cy.ts).
40. **B40**: SPEC §11 carries R203 and R204, `packages/engine/test/rulings.test.ts` indexes both in order and proves them in `apps/web/src/audio/cues.test.ts` (and, for R203, `director.test.ts`), and `pnpm rulings:coverage` exits 0 (the existing index test and script, and spec-rows.test.ts).

B41 to B45 were added at the cull, when these parts of the Surface turned out to have no test citing them.

41. **B41**: `voiceKey` joins `<defId>-<line>` (defIds contain `-`), `voiceUrl` serves it from `BASE_URL` + `audio/voice/`, and `lineFor` returns the line's text with its persona, the card's own `rate`/`pbas`/`pmod` overrides applied, or null for the sentinel, an unknown id or a line the card's kind does not have (voiceData.test.ts).
42. **B42**: `parseVoiceLines` accepts the shipped table unchanged and rejects a malformed one with `voice-lines.json: <path>: <problem>`, and it does not check word limits (voiceData.test.ts).
43. **B43**: `voiceKeysForView` lists, deduped and in this order, the viewer's hand (unit → play, spell → cast, traps none), every unit on both boards (death), and the viewer's own face-up backrow traps (cast); a card it cannot name adds nothing (voiceData.test.ts). The same file checks `voice-lines.json`'s layout (personas sorted, cards in catalog order, 2-space JSON, trailing newline).
44. **B44**: `Game` asks a running engine to `preloadVoices(voiceKeysForView(view))` for its first view and every new one, and never asks an engine that is locked, suspended or unsupported (`useGameAudio` step 6; ui.test.tsx).
45. **B45**: `gen-voice.mjs` without `--check` exits 2 with `gen-voice: needs macOS say and afconvert` when it cannot find `say`, `afconvert` or `afinfo`. On macOS it renders nothing and writes nothing on an unchanged tree, deletes an orphan file and an orphan manifest entry, and after one line is edited renders that key alone with its new hash (gen-voice.test.ts; the macOS cases skip elsewhere).

### Review fixes (B46 to B57)

Added after three independent reviews of the built branch. Each one is a finding that was checked
against the code and fixed, and each has a test.

46. **B46**: While the context is not running (`suspended`, or Safari's `interrupted`), `playSfx` and `playVoice` still accept and log (an sfx entry carries `suspended: true`, a line the outcome `"suspended"`), but build no node, fetch nothing and hold no voice channel; once it runs, new cues schedule and nothing requested while suspended ever starts (engine.test.ts).
47. **B47**: A line of higher priority than the one holding the channel cuts in: a line still loading is logged `"dropped"` and never starts, a playing file line's gain is faded to 0 and its source stopped within `VOICE_FADE_S`, a spoken line is cancelled; the new line then plays. A line of equal or lower priority never cuts in. With the real director and engine, #11 Tempo Timmy played into #41 Sheepish on its controller's seat logs Timmy's line cut short and Sheepish's heard (engine.test.ts, director.test.ts).
48. **B48**: When the channel frees, the most important waiting line starts, the oldest on a tie; one that has waited over `VOICE_QUEUE_WAIT_MS` is logged `"late"`; with the queue full, a more important request displaces the least important waiting line (`"dropped"`) (engine.test.ts).
49. **B49**: A rendered line plays `start(at, offset, duration)` over its audible span (samples above `VOICE_TRIM_THRESHOLD`, less `VOICE_TRIM_LEAD_S` before and plus `VOICE_TRIM_TAIL_S` after) and holds the channel for that span only; a buffer with no audible sample plays whole (engine.test.ts).
50. **B50**: Muting cancels a spoken fallback line and drops every waiting line; turning voice lines off stops a playing file line, and the voice bus is 0 while they are off (engine.test.ts).
51. **B51**: At most `VOICE_DECODED_MAX` lines stay decoded (least recently used evicted); an evicted line decodes again from its cached bytes with no second fetch. `VOICE_PREFETCH_DELAY_MS` after the first preload on a running context, every manifest line's bytes are fetched once, `VOICE_PREFETCH_CONCURRENCY` at a time; a context that is not running prefetches nothing (engine.test.ts).
52. **B52**: `retainAppAudio()` (held by `main.tsx` for the page's life and by every mounted `Game`) installs one set of unlock and UI-sound listeners however many hold it, removes them when the last holder releases, and reaches whichever engine is the singleton at each event: a click in a Game under the app root ticks and unlocks once, and a menu button outside any Game ticks (ui.test.tsx).
53. **B53**: Inside `.app-shell`, at 1280×720 and 390×844, the mute toggle computes to a 44 px circle (`border-radius: 50%`, `padding: 0`) with a 22 × 22 icon (audio-toggle.cy.tsx).
54. **B54**: Unmuting with the toggle plays `uiClick` once the store says unmuted, and muting plays nothing more; moving the master or effects slider ticks, and releasing the voice slider (pointer or key) speaks `VOICE_PREVIEW_DEF_ID`'s play line at `VOICE_PRIORITY.summon` (ui.test.tsx).
55. **B55**: `sameOccurrence` lets R97's sentinel match the value it later reveals (or hides), and nothing else; so when the opponent plays a card it drew earlier in the window, only the new action's events are owed, and when the runner replays the whole window (task 1's exact `newEventsSince`) only the new action sounds. Proved on fixture views and on real engine views, where the watcher hears exactly what a byte-identical window would give (director.test.ts).
56. **B56**: Every voice cue carries its `VOICE_PRIORITY` (play and cast lines on a play: `play`; death and trap lines: `react`). A unit summoned with no `cardPlayed` of its own that has sounded (a token, a Recruit, a Reborn, a copy) speaks its play line at `summon`, while a played unit's own `summoned` adds nothing; a summon's `amount` is the unit's attack plus health as the newest view shows it, and a Radiant unit adds the `radiant` glint (cues.test.ts, director.test.ts).
57. **B57**: In Chrome, through the real mix at the default settings, every effect sits in its band against the mean active RMS of five shipped voice lines: the maximum hit and the big moments within [−5, +1] dB, routine sounds within [−12, −4], `uiClick` within [−15, −9], `uiHover` within [−22, −15], victory within [−4, +3] and more than 1 dB louder than defeat, no effect peaking over 0.7, and a dense scene under the loudest persona's line never clipping (audio-recipes.cy.tsx).

R203 also gained a proof against the engine's own redaction (director.test.ts): a real #41 Sheepish
set and fired through `viewFor` speaks only on its controller's seat, the other seat hears the plain
play and the sting, and the fired event on that seat carries `HIDDEN_DEF_ID`.

### CI fix (B58)

Added after e2e spec 08 failed in CI on Chrome (every attempt) and once on Electron. p2's mulligan
answer produces one long burst: R82 auto-ends turns 1 to 4, 29 entries that `fitBudget` plays in
about 3.8 s against `cy.settled()`'s 4 s. `VOICE_PREFETCH_DELAY_MS` after p1's first view on the
running context, the prefetch's requests landed inside that burst. Each request is cheap, but
Cypress logs each one in a reporter that shares the page's main thread, so the runner's chained
timers slipped past 4 s. The runner is timed by main-thread timers, so any background work is
charged to the burst, and that holds for a slow phone as much as for Cypress.

58. **B58**: While `setBusy(true)` holds (useGameAudio sets it while the runner has an entry in flight, before that entry's cues, and clears it at idle after the flush's, and on unmount), the prefetch starts no new request (one already in flight finishes), and `preloadVoices` is held, the newest call only, and run when it clears. A line asked to play is fetched at once. While muted or with voice lines off, nothing is preloaded or prefetched, and turning voice lines back on resumes the prefetch. With the real engine inside `Game`, an R82-style burst that straddles the prefetch's due time makes no voice request until the board is still (engine.test.ts, ui.test.tsx).

## Tests

- **Vitest project `web`** (jsdom; `apps/web/vitest.config.ts`; include `src/**/*.test.{ts,tsx}`;
  setup `src/test/setup.ts`). Every new test lives in **`apps/web/src/audio/`**. Run one with
  `pnpm vitest run --project web apps/web/src/audio/<file>` and the lot with
  `pnpm vitest run --project web apps/web/src/audio`. The whole `web` project must stay green,
  because B28 is the regression check that the hook is a no-op without an AudioContext.
  - **Harnesses.**
    - `apps/web/src/test/fixtures.ts` provides `baseView`, `withEvents`, `unit`, `card`,
      `faceDownBackrow`, `faceUpBackrow` and `resetIds`, and every view a test needs comes from it.
    - `apps/web/src/test/setup.ts` provides `setReducedMotion`; reset it in `afterEach`.
    - `planEntries` and `createAnimationQueue` (with an injected `schedule`) come from
      `apps/web/src/game/animations.ts`, for director and runner timing.
    - `vi.useFakeTimers()` covers Game's real runner and the speech delay.
    - Tester A writes a helper, `apps/web/src/audio/test/fakeAudio.ts`. It implements exactly the
      permitted Web Audio subset, records nodes, connections, `start`/`stop` times and
      AudioParam calls, and throws on anything else. It also provides a controllable `state` and a
      `resume()` spy, plus a fake `SpeechPort`, a fake `fetchBytes` (resolve, reject or hang) and a
      settable clock.
  - **R-test titles** use double quotes and lead with the row, e.g. `it("R203 never speaks a hidden card", …)`,
    so `rulings.test.ts`'s `provenIn` finds them. Put R203 in `cues.test.ts` and `director.test.ts`,
    and R204 in `cues.test.ts`.
  - B37 spawns `process.execPath` with the script via `node:child_process`, copies into
    `fs.mkdtempSync(os.tmpdir())`, and deletes the temp dir in `afterAll`. B45 does the same for
    generate mode.
  - Added at the cull: `voiceData.test.ts` (B41–B43), `gen-voice.test.ts` (B45), `spec-rows.test.ts`
    (B40, run through the coverage script with `tsx`), and a B44 block in `ui.test.tsx`.
- **Vitest project `engine`**: `packages/engine/test/rulings.test.ts` (slice 4 edits it; no new file)
  and `pnpm rulings:coverage` prove B40.
- **The cards harness** (`packages/cards/test/_harness.ts` `scenario()`) is **not** used: nothing
  here changes the engine or a card.
- **Cypress component spec** (new) `e2e/cypress/component/audio-recipes.cy.tsx` proves B15 and B16. It
  imports only `apps/web/src/audio/sfx.ts` and renders into
  `new OfflineAudioContext(1, 44100 × (durationMs/1000 + 0.25), 44100)`. Run it with
  `E2E_COMPONENT_PORT=5282 pnpm --dir e2e exec cypress run --component --browser chrome --spec cypress/component/audio-recipes.cy.tsx`.
  Also rerun `board-layout.cy.tsx`, since the fixed toggle is new chrome on `Game`.
- **Cypress e2e spec** (new) `e2e/cypress/e2e/15-audio.cy.ts` proves B38 and B39. It keeps BUILD M8's
  house rules: a set seed, no fixed waits, selectors via `ts()`. It declares its own local type for
  `window.__jackiohAudio`, because `e2e/` does not import `apps/`. Run it with `pnpm build:e2e`, then
  `pnpm --dir apps/web exec vite preview --port 5172 --strictPort`, then
  `E2E_BASE_URL=http://localhost:5172 pnpm --dir e2e exec cypress run --browser chrome --spec cypress/e2e/15-audio.cy.ts`.
  Kill the preview server afterwards. No server is needed.
- **The branch gate** is reference.md's line, plus the component run and spec 01 (a full hotseat game,
  to prove sound never blocks the board).

## Out of scope

- Attack voice lines, emotes, hero voices, and a player-chosen voice pack.
- Music and ambient loops (tavern music, board ambience). (The UI ticks and the unlock do reach every
  screen since the review fixes, B52.)
- A bespoke sound per card: SFX are per event type, and personality comes from the voice lines. A
  summon is sized by the unit and a Radiant unit glints (B56); a rarity sting would need the rarity,
  which neither the view nor the client's card lookup carries.
- A separate Radiant line or voice for each card; a Radiant card speaks its base lines.
- Spatial panning by lane, sidechain ducking of SFX under voice, and reverb.
- The full settings panel and gear: task 7 mounts `AudioControls` at integration. This branch only
  mounts `AudioToggle`.
- Bypassing the iOS ringer or silent switch (Web Audio honours it), and haptics.
- Localized lines, recorded human voice actors, and any server or engine change.
- Any new `GameEvent` type, `PlayerView` field or rule. Audio reads the view as it is.

## Slices

Every slice writes blind against the Surface section. Test files are the testers' alone (see
below), and no slice creates anything under `apps/web/src/audio/test/` or any `*.test.*` / `*.cy.*` file.

### Slice 1: `audio-core` (engine, SFX, unlock, settings, voice data access)

- **Owns (all new):** `apps/web/src/audio/types.ts`, `constants.ts`, `settings.ts`, `sfx.ts`,
  `engine.ts`, `unlock.ts`, `voiceData.ts`.
- **Behaviours:** B1–B16.
- **Shared-file edits:** none. It imports `voice-lines.json` and `voice-manifest.json` (slice 3)
  with the shapes in Surface. Until slice 3 lands, a builder may keep a local stub, but it must not
  commit one.

### Slice 2: `audio-director-ui` (cue table, director, hook, UI, Game wiring)

- **Owns (all new):** `apps/web/src/audio/cues.ts`, `director.ts`, `useGameAudio.ts`,
  `uiSounds.ts`, `debug.ts`, `AudioToggle.tsx`, `AudioControls.tsx`, `audio.css`, `index.ts`.
- **Owns (existing):** `apps/web/src/game/Game.tsx`, limited to the three additive lines in Surface
  ("The `Game.tsx` edit").
- **Behaviours:** B17–B32, B38, B39.
- **Shared-file edits:** only `Game.tsx` as specified. It reads `apps/web/src/game/animations.ts`
  (task 1's) and never edits it.

### Slice 3: `voice-content` (lines, generator, assets)

- **Owns (new):** `apps/web/src/audio/voice-lines.json`, `apps/web/src/audio/voice-manifest.json`,
  `apps/web/scripts/gen-voice.mjs`, and `apps/web/public/audio/voice/` (the 152 `.m4a` files).
- **Owns (existing):** `apps/web/package.json`, limited to one added script line:
  `"gen:voice": "node scripts/gen-voice.mjs"`. No dependency changes.
- **Behaviours:** B33–B37.
- **Shared-file edits:** only that `package.json` line. It transcribes the Surface tables verbatim,
  runs the script on macOS, and commits the generated manifest and files.

### Slice 4: `spec-and-docs`

- **Owns (existing):**
  - `SPEC.md`: the new §10.11, and §11 rows R203 and R204 appended after the last row.
  - `packages/engine/test/rulings.test.ts`: two path constants, `WEB_AUDIO_CUES_TEST`
    (`"../../../apps/web/src/audio/cues.test.ts"`) and `WEB_AUDIO_DIRECTOR_TEST`
    (`"../../../apps/web/src/audio/director.test.ts"`), plus two index rows after R170:
    `it("R203 …", () => provenIn(203, WEB_AUDIO_CUES_TEST, WEB_AUDIO_DIRECTOR_TEST))` and
    `it("R204 …", () => provenIn(204, WEB_AUDIO_CUES_TEST))`, each with a comment naming the proofs.
  - `apps/web/README.md`: the Layout block gains `audio/` and `scripts/gen-voice.mjs`, plus one
    paragraph on regenerating voices.
  - `e2e/README.md`: one line each for `15-audio.cy.ts` and `audio-recipes.cy.tsx`.
- **Behaviours:** B40.
- **Shared-file edits:** exactly those. Rows go in numeric position; see Risks for the merge with
  the other tasks' rows.

### Testers

- **Tester A (runtime, jsdom).**
  - Behaviours: B1–B14, B17–B32, and B40, which it verifies by running the existing
    `rulings.test.ts` and `pnpm rulings:coverage` after slice 4.
  - New files: `apps/web/src/audio/test/fakeAudio.ts`, `engine.test.ts`, `unlock.test.ts`,
    `settings.test.ts`, `sfx.test.ts`, `cues.test.ts`, `director.test.ts` and `ui.test.tsx`, all
    under `apps/web/src/audio/`.
- **Tester B (content and browser).**
  - Behaviours: B15, B16 and B33–B39.
  - New files: `apps/web/src/audio/voice-lines.test.ts`, `apps/web/src/audio/voice-assets.test.ts`,
    `e2e/cypress/component/audio-recipes.cy.tsx` and `e2e/cypress/e2e/15-audio.cy.ts`.

## SPEC changes

**New §10.11 Audio** (insert after §10.10, before §11):

> ### 10.11 Audio
>
> The client plays sound from the same event stream it animates (§10.10), and none of it is a rule.
> Audio reads the viewer's `PlayerView` and nothing else (CLAUDE.md rule 7), so it can reveal no more
> than the screen does (R203).
>
> - **Cue table.** `apps/web/src/audio/cues.ts` keeps `SOUND_CUES`, a total map over §10.3's event
>   types like BUILD M5-T4's animation table. Each row names its sound effect or states why the event
>   is silent, so a new event type does not compile until it has a row.
> - **Timing.** A cue plays when the animation runner starts the entry for its event, so sound and
>   motion land together. Events the runner never plays (under reduced motion, the zero-length
>   `gameOver`, or a queue drained at a game's end) play once, condensed, when the runner goes idle.
>   A hotseat hand-over plays nothing.
> - **Sound effects** are synthesized at runtime from Web Audio oscillators, filters and noise, one
>   recipe per effect, with hits scaled by the amount of damage. The client ships no effect files.
> - **Voice lines.** Every Unit, tokens included, has a play line and a death line. Every Spell,
>   Field Spell, Trap and Field Trap has a cast line. R204 fixes the moment each is spoken. The lines
>   are flavour and never restate rules text. They are pre-rendered with macOS `say` to mono AAC at
>   about 32 kbps, 3 MB at most in total, and a missing file falls back to the browser's speech
>   synthesis. One line speaks at a time.
> - **Autoplay.** Nothing plays before the first user gesture. The audio context is created and
>   resumed inside that gesture, which is what iOS requires.
> - **Settings.** Master, effects and voice volume, mute, and voice on or off, stored per device.
>   They change nothing in the game.

**§11 rows** (append after the last row, in numeric position):

| # | Topic | Recommended ruling | Cards affected |
| --- | --- | --- | --- |
| R203 | What audio may reveal | Sound reads the viewer's `PlayerView` and nothing else, so it follows R97's and R154's redaction exactly: an event whose card is the sentinel plays a generic sound and never that card's voice line. Setting a Trap never speaks on either seat, because a line on the set would name a face-down card to anyone within earshot of the device: its owner hears the set sound every Trap shares, and the other seat, whose event carries the sentinel, hears the plain play sound of any card it cannot name. A Trap speaks when it fires, and only on its controller's seat, because R154 withholds its identity from the other seat at that moment. A hotseat hand-over plays nothing the arriving seat's view did not produce | #18, #41, #60, #71, #85, #96; §10.8, §10.11, R33, R97, R154 |
| R204 | Which moments speak | A Unit speaks its play line on its `cardPlayed`, whether played from hand or cast by an effect (the two moments R1 fires a Cry), and whether or not the Cry then resolves (#41, R17). A Unit an effect puts onto the field without playing it (a token, a copy, Recruit or Reborn) speaks that line on its `summoned` instead, at the lowest priority; a played Unit's own `summoned` adds nothing, and a Transform speaks nothing. It speaks its death line on its `destroyed`, whose `defId` R89 carries, tokens included, and never on a bounce, an exile or a Transform, which are not deaths. A Spell or Field Spell speaks its cast line on its `cardPlayed`, casts included (R70). A Trap or Field Trap speaks on its `trapFired`, per R203. One line speaks at a time. A death line or a firing trap's line cuts in on a play or cast line, because it answers something that has just happened: that is how R17's play-reactive traps (#41, #60, #85), whose `trapFired` comes in the same action as the play it answers, are heard over that play's line. Any other line waits briefly behind the one speaking and is dropped if it has waited too long. A fused transient definition (R77) has no lines | every card; §10.11, R1, R17, R70, R77, R89, R203 |

R205 stays unused.

## Risks

- **`Game.tsx` merge and hook order.** Tasks 1, 3 and 7 also edit `Game.tsx`, and task 1 is likely to
  add a hook next to `const runner = queue.current;`. Adjacent insertions conflict textually, so
  resolve by keeping every line. The one invariant is that `useGameAudio(runner, view)` stays
  **before** Game's first `useLayoutEffect`. If it moves below the enqueue effect, B24 still holds
  (unseen entries resolve against `seen`), but reduced-motion bursts can be flushed one view late.
  B28 guards this.
- **Task 1 owns `animations.ts`.** The director imports `newEventsSince`, `planEntries`,
  `AnimationEntry` and `AnimationQueue` (`subscribe`, `inFlight`, `idle`). The brief keeps the
  runner's architecture, but if task 1 renames or reshapes them, the integration branch adapts
  `director.ts` and `useGameAudio.ts`, and B24–B28 will flag it.
- **SPEC and index merges.** Tasks 1, 3, 4, 5, 6 and 7 all append §11 rows and `rulings.test.ts`
  index rows after R170, and task 1 also edits §10.10 right above the new §10.11. Integration
  reorders them numerically. The index completeness test demands ascending order.
- **`say` varies by machine.**
  - Voices differ across macOS versions.
  - Legacy voices (Fred, Ralph, Junior, Kathy, Albert, Zarvox, Trinoids, Whisper, Boing, Bahh,
    Bubbles, Wobble, Superstar) are not byte-deterministic between runs.
  - Idempotency is by input hash, so regenerating on another Mac rewrites only what changed.
  - CI never runs `say`. It runs only `--check` (B37) and the asset test (B35).
- **Budget.** The drafted set measured 1.53 MiB (du 1,876 KB). Longer lines or slower rates could
  approach 3 MB, and B36 fails first. The fallback is `-b 24000` with a `v: 2` hash bump.
- **AAC decoding.** Open-source Chromium builds and Firefox on Linux without system codecs may reject
  AAC in `decodeAudioData`. The engine then falls back to speech (B9), and e2e asserts the voice
  *request*, not the outcome, for this reason. Chrome, Safari, Edge and Electron decode it.
- **Headless CI audio.** Chrome in CI may keep the context `suspended` with no output device. The
  engine accepts and logs cues on a suspended context, so B38 does not depend on audible output.
  B38 only requires that the state has left `locked` and `unsupported`.
- **iOS.** The silent switch mutes Web Audio (out of scope). If Safari suspends the context again
  after a call or a backgrounding, the permanent unlock listeners (B2) resume it on the next tap.
- **One voice at a time still drops lines** during busy turns (board wipes, Call to Chaos chains):
  deaths of equal priority queue two deep and give up after `VOICE_QUEUE_WAIT_MS`. This is by
  design; the priorities make sure the line that is heard is the most important one. The flush
  keeps at most one line.
- **Taste.** Edgy card names (#2 Bigot, #42 Eugenics, #59 Unbiased Immigration, #61 Prejudiced
  Postdoc, #90/#90.1 CN-Virus, #91 Fed Fauci) have lines that mock the premise and never a group of
  people. A reviewer should read the table before merge.
- **Performance.** Each SFX cue builds a handful of nodes, capped by `SFX_MAX_VOICES`. The noise
  buffer is built once per context, the lines and manifest (about 30 KB) ride in the `Game` chunk,
  and voice files are fetched on demand and preloaded per view.

## Integration note: sound by card, the speaking mark and the mute's place

Task 6 put the catalog def on the client's `CardInfo`, so the integration branch gave the director
the board's `CatalogContext` (`useGameAudio` hands `createSoundDirector` a `card` lookup) and used it
for what this branch could not reach:

- **Families.** `timbreFor` maps a card to the card art's theme (`cards/art/themes.ts`: tags first,
  then Token, then a Field Spell's type), and `SfxParams.timbre` colours the summon thud with a short
  accent and the spell shimmer with its own four chimes. Levels are the plain recipe's; the component
  spec holds every family in the routine band.
- **The entrance.** A Legendary or Mythic Unit's `summoned` adds the new `entrance` sting (the
  table's 28th id) at the thud, where task 1 starts its light rays. It is one of the big moments in
  B57's loud band.
- **R203.** Only a Unit summoned to the field and a cast Spell vary. A defId behind the sentinel is
  never looked up, and a Trap's set and its backrow arrival sound like every Trap's. The R203 row and
  §10.11 say so.
- **`data-speaking`.** The engine's `speaking()` and `subscribeSpeaking` report whether a line holds
  the voice channel (loading included). `Game` marks its root `data-speaking` while it does, which is
  the attribute task 3's practice pacing already held the AI on.
- **The mute moved into the board's control bar**, beside the settings gear, where task 7's panel
  mounts `AudioControls`: fixed in the corner it covered the practice HUD's Menu and the match bar.
  On a phone held upright the bar is one row, so there the mute steps aside and the gear holds it.
