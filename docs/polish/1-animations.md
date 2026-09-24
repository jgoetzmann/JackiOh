# Polish 1: Animations and VFX

Design notes for `polish/1-animations` (brief: `docs/polish/reference.md`, section "1."). Other agents
build from this document without talking to each other, so the **Surface** section is the contract:
every exported name, type, file path, `data-*` hook and constant value below is binding. Anything this
document leaves open is the owning slice's choice, as long as the behaviours and the Surface hold.

Throughout, **D** is the duration the runner actually gave an entry (`entry.durationMs`, after the
speed setting and the burst budget), and **T** is `FX_MAX_TAIL_MS` (900 ms).

## Goal

Make JackiOh's board feel like Hearthstone without slowing it down. A new effects layer,
`apps/web/src/fx/`, decorates the event stream the animation table already plays: one pooled,
DPR-aware particle system on a `<canvas>` overlay (fire, embers, holy light, arcane motes, poison,
smoke, dust, shards, gold and confetti, all drawn from procedural radial-gradient sprites), plus short
CSS flourishes anchored to the `data-testid` rectangles the board already renders (Hearthstone damage
and heal splats, Legendary and Mythic light rays, a radiant sheen, buff arrows, card-draw ghosts, the
"Your turn" banner and the victory and defeat sequences), plus a trauma-based board shake scaled by
damage. The existing machinery stays exactly as it is: `ANIMATIONS` is still a total map over
`GameEventType` and gains an optional `fx` descriptor per row; the runner still plays one entry at a
time on the BUILD M5-T4 durations and still drains synchronously under `prefers-reduced-motion`; and
`data-animating` still means exactly what `cy.settled()` waits for. Effects start with the entry they
decorate, land inside it, trail off within T, never carry a `data-animating` of their own, never take a pointer event
and never delay the view swap (R200). A speed setting scales the table (R201), and effects read only
the redacted stream (R202). No image assets, no new runtime dependency, 60 fps on a mid phone.

## Research

### What Hearthstone does

| Hearthstone behaviour | Source |
|---|---|
| The board is meant to feel **physical**: "whenever the screen shakes when those 8/8 minions hit the board". Weight is sold by a shake proportional to the minion. | Ben Thompson (art director) in [Inven Global](https://www.invenglobal.com/articles/1554/how-hearthstones-art-director-ben-thompson-breathed-life-into-hearthstone); GDC 2014 [The Art of Hearthstone](https://www.gdcvault.com/play/1020615/The-Art-of-Hearthstone-Playing) |
| Effects are UI. They are "somewhat 'flashy' because it is a piece of user interface" that signals new information, but they must be "telling a story but not getting in the way of the game itself". | Same Inven Global interview |
| Speed beats spectacle on repeated effects. Minion trigger animations were cut from **0.8 s to 0.2 s** across the game (after Battlegrounds proved it) because long animations made players "burn rope". | [HearthstoneTopDecks, trigger speed-up](https://www.hearthstonetopdecks.com/minion-animations-triggers-will-be-sped-up-significantly-in-regular-game-too/) |
| Players complain that "animations playing out repeatedly would block later actions", yet "all cool Legendaries lose their coolness factor without animations". Keep the flourish, drop the wait. | [HearthstoneTopDecks, turning animations off](https://www.hearthstonetopdecks.com/should-we-finally-be-allowed-to-turn-off-animations-in-hearthstone/) |
| Legendary cards get **grand entrances**: VFX artists abstract elements from the card art into a whimsical entrance, consistent across hundreds of legendaries. | GDC 2025 session [VFX Storytelling: How Hearthstone Breathes Life into Hundreds of Cards](https://schedule.gdconf.com/session/vfx-storytelling-how-hearthstone-breathes-life-into-hundreds-of-cards/908026) (session abstract, seen through search; the page itself returns 403) |
| Divine Shield is "a translucent yellow cocoon" around the minion, and losing it is called **popping** it. | [Hearthstone Wiki: Divine Shield](https://hearthstone.wiki.gg/wiki/Divine_Shield), [Fandom: Divine Shield](https://hearthstone.fandom.com/wiki/Divine_Shield) |
| Secrets sit face-down, are revealed only when their condition fires, and each class's secret has its own colour. The reveal is a moment on its own: the card shows, with a coloured flash. | [Hearthstone Wiki: Secret](https://hearthstone.wiki.gg/wiki/Secret) |
| Golden cards are the premium face: animated and recoloured, most likely shader-driven sheens and glints rather than baked video. | [Austin Curzon, Golden Card Animations](https://austincurzon.com/hearthstone-golden-card-animations) |
| Observed in play (no written source): damage shows as a red starburst **splat** with a white "−N" that pops and holds about a second, and healing as a green "+N". Spells such as Fireball fly from the caster to the target with a trail and burst on impact. A dying minion cracks, falls apart and goes up in smoke. "YOUR TURN" is a large glowing centre banner. Mana crystals light up one by one. A drawn card flies from the deck to the hand. At game end the loser's portrait cracks and explodes, and a Victory or Defeat banner follows. | Gameplay observation |

### Game-feel references we borrow the maths from

| Reference | What we take |
|---|---|
| Squirrel Eiserloh, GDC 2016, [Juicing Your Cameras With Math](https://gdcvault.com/play/1023146/Math-for-Game-Programmers-Juicing) ([transcript](https://archive.org/stream/GDC2016Eiserloh/GDC2016-Eiserloh_djvu.txt)) | **Trauma shake.** Keep a trauma value in [0, 1]. Hits add to it and it decays linearly. The shake is `trauma²`: offset = `maxOffset · shake · noise`, angle = `maxAngle · shake · noise`. Use smooth noise rather than random, because it "feels better" and replays, and in 2D "Translational + Rotational = Awesome". |
| Martin Jonasson and Petri Purho, [Juice it or lose it](https://youtu.be/Fy0aCDmgnxg) (2012); Jan Willem Nijman, [The Art of Screenshake](https://youtu.be/AJdEqssNZ-U) (2013); both indexed with others at [russmatney.com/notes/juicy](https://russmatney.com/posts/notes/juicy/) | White impact flashes, particle debris on hit, landing dust, trails behind moving things, death animations that leave a mark, and text that pops and scales. |
| Nicolae Berbece, [Why Your Death Animation Sucks](https://www.youtube.com/watch?v=pmSAG51BybY) | A death needs its own beat: a crack and a burn-away, not only a fade. |
| MDN, [Optimizing canvas](https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API/Tutorial/Optimizing_canvas) | Pre-render sprites to an offscreen canvas; scale the backing store by `devicePixelRatio`; avoid `shadowBlur`; drive frames with `requestAnimationFrame`; redraw only while something changes. |
| MDN, [Page Visibility API](https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API) | Stop the frame loop while `document.hidden`. |

### Borrowed technique → JackiOh event

"Recipe" is the `fx` descriptor on the event's `ANIMATIONS` row (the full cue lists are in Surface §S7).

| Technique (source) | JackiOh `GameEvent` | Recipe | How it looks here |
|---|---|---|---|
| Weighted slam and board shake for big minions (Thompson) | `summoned` (and the collapsed `cardPlayed`+`summoned` pair) | `summon` | A dust ring and puff at the zone at 60% of D. Shake trauma grows with printed attack + health from 10 up. |
| Legendary grand entrance (GDC 2025) | `summoned` of a readable Legendary or Mythic unit | `summon` | Rotating light rays behind the zone (gold for Legendary, prismatic for Mythic) plus a gold or prismatic burst and extra trauma. |
| Damage splat and impact flash (play; Juice it or lose it) | `damage` | `impact` | A white-orange spark burst and a big red starburst "−N" over the target. Trauma is `0.1 × amount` from 3 damage up, capped at 0.8, and ×1.25 on a hero. |
| Spell projectile with a trail (play) | `damage` with `combat: false` and a locatable source | `impact` | A fire, arcane or poison head flies source → target over 55% of D leaving trail particles. The impact, splat and shake land on arrival. |
| Poison (Juice: debris colour codes the cause) | `damage` from a Poisonous unit; `counterChanged` plague; `keywordGranted` Poisonous | `impact`, `counter`, `keyword` | A green-violet cloud puff. |
| Healing splat and holy light (play) | `healed` | `heal` | A holy light column (rays), rising gold-white sparkles and a green "+N" splat. |
| Health loss (play: purple number) | `healthLost` | `drain` | Violet void wisps sink into the hero, with a violet "−N" splat. |
| Divine Shield pop (wiki) | `divineShieldLost`; `keywordGranted` Divine Shield; a persistent bubble | `shieldBreak`, `keyword`, CSS | Golden shards burst outward and a gold ring expands. A persistent translucent golden cocoon sits on every card that shows the Divine Shield keyword. |
| Death that leaves a mark (Berbece) | `destroyed` | `death` | A canvas crack across the card, embers burning away across its box, then smoke. The existing `jk-dissolve` keyframes gain a brightness flash. |
| Burn (brief: fire and burn-away) | `burned` | `burn` | Fire and embers rise from the hand region while the existing flip-and-burn keyframes play. |
| Secret reveal flash (wiki: class colour) | `trapFired` | `trap` | An arcane (violet) shock ring and mote burst at the trap's card or zone (R154), with a small punch shake. The flip keyframes gain a violet glow. |
| Golden sheen (Curzon) | `radiantSet` | `radiant` | A gold sheen sweeps across the card, with gold sparkles and soft rays on a field card. |
| Smoke puff (brief: transform and fuse) | `transformed`, `fused`, `bounced`, `attackCancelled` | `smoke`, `fuse`, `bounce`, `fizzle` | A grey smoke puff. Fuse also streams arcane motes from each ingredient into the survivor. |
| Card draw flight (play) | `drawn`, `shuffledIn`, `bounced`, `discarded` | `draw`, `shuffle`, `bounce`, `discard` | A card-back ghost flies between the piles and the hand region over D. |
| Mind control (play) | `controlChanged` | `mindControl` | Arcane motes stream from the card's old place to its new zone. |
| Buff arrows (brief) | `buffed` | `buff` | Green chevrons rise (net positive) or red chevrons fall (net negative). |
| Mana crystals lighting one by one (play) | `manaChanged` | `mana` | A sparkle on each crystal that fills, staggered left to right. |
| Landing and trails (Juice) | `attackDeclared` | `lunge` | A dust kick under the attacker as it lunges. |
| "YOUR TURN" banner (play) | `turnStarted`, `turnAutoEnded`, and a hot-seat hand-over | `banner` | A big gold "Your turn" with rays, a smaller steel "Opponent's turn", or a muted "No moves left". |
| Portrait explodes, Victory or Defeat (play) | the shown view's `result` turning non-null (`gameOver` is a zero-duration row the runner never plays) | `planResult` | The loser's hero cracks and bursts into shards and smoke. A full-screen Victory (rays and confetti), Defeat (dark vignette and embers) or Draw banner, gone within 3.2 s. |
| Fast triggers (HSTopDecks 0.8→0.2 s) | every row | the runner | Effects never extend an entry. The existing burst budget still squeezes long bursts, the CSS keyframes now follow the squeeze (`--anim-squeeze`), and a speed setting (R201) scales the whole table. |
| Trauma shake maths (Eiserloh) | `damage`, `summoned`, `trapFired`, the result | `fx/shake.ts` | trauma² with 1D value noise on x, y and angle, linear decay, applied through CSS `translate`/`rotate` on the board. |
| Canvas performance (MDN) | all | `fx/*` | Sprites cached per preset, colour and DPR; DPR clamped to 2; no `shadowBlur`; a rAF loop that stops when idle and while hidden; a particle cap that halves when frames run slow. |

## Surface

Every path is relative to the repo root. Relative imports inside `apps/web/src` use explicit `.ts` /
`.tsx` extensions, as `Game.tsx` does. Nothing here adds a dependency.

### S1. `apps/web/src/fx/types.ts` (the contract; owned by slice B, written exactly as below)

```ts
import type { GameEvent, PlayerId, Rarity, Row } from "@jackioh/shared";
import type { Side } from "../game/contract.ts";

/** A point inside a box as fractions of its width and height; {x:0.5,y:0.5} is the centre. */
export type FxPoint = { x: number; y: number };

/** A position in viewport CSS pixels. */
export type FxVec = { x: number; y: number };

/** A box in viewport CSS pixels (the space `getBoundingClientRect` reports). */
export type FxBox = { x: number; y: number; width: number; height: number };

/** Where a cue plays. Resolved to an `FxBox` by the director at the moment the cue fires. */
export type FxAnchor =
  | { kind: "testid"; testid: string; at?: FxPoint }
  | { kind: "crystal"; side: Side; index: number }
  | { kind: "viewport"; at: FxPoint };

export type FxPreset =
  | "fire"
  | "ember"
  | "holy"
  | "sparkle"
  | "arcane"
  | "poison"
  | "smoke"
  | "dust"
  | "shard"
  | "spark"
  | "gold"
  | "prismatic"
  | "void"
  | "confetti";

export type FxSpread = "point" | "area" | "ring";
export type FxSplatTone = "damage" | "heal" | "loss";
export type FxRayTone = "legendary" | "mythic" | "radiant" | "holy" | "victory";
export type FxBannerTone = "you" | "opponent" | "muted";
export type FxOutcome = "victory" | "defeat" | "draw";

export type FxBurstCue = { kind: "burst"; preset: FxPreset; at: FxAnchor; delayMs: number; count: number; spread: FxSpread; power: number };
/** `density` is the intensity scale: it multiplies the trail and the arrival burst, as `count` does a burst's. */
export type FxProjectileCue = { kind: "projectile"; preset: FxPreset; from: FxAnchor; to: FxAnchor; delayMs: number; flightMs: number; density: number };
export type FxCrackCue = { kind: "crack"; at: FxAnchor; delayMs: number; durationMs: number };
export type FxRingCue = { kind: "ring"; preset: FxPreset; at: FxAnchor; delayMs: number; durationMs: number };
export type FxShakeCue = { kind: "shake"; trauma: number; delayMs: number };
/** `amount` is the event's positive amount; the tone gives the sign ("−" for damage and loss, "+" for heal). */
export type FxSplatCue = { kind: "splat"; tone: FxSplatTone; amount: number; at: FxAnchor; delayMs: number; durationMs: number };
export type FxRaysCue = { kind: "rays"; tone: FxRayTone; at: FxAnchor; delayMs: number; durationMs: number };
export type FxSheenCue = { kind: "sheen"; at: FxAnchor; delayMs: number; durationMs: number };
/** A card BACK flying between two anchors. It never carries a card identity (R202). */
export type FxGhostCue = { kind: "ghost"; from: FxAnchor; to: FxAnchor; delayMs: number; durationMs: number };
export type FxArrowsCue = { kind: "arrows"; direction: "up" | "down"; at: FxAnchor; delayMs: number; durationMs: number };
export type FxBannerCue = { kind: "banner"; text: string; tone: FxBannerTone; delayMs: number; durationMs: number };
export type FxResultCue = { kind: "result"; outcome: FxOutcome; text: string; delayMs: number; durationMs: number };

/** Stage cues (B46–B48, planned by `stage.ts`): they act on the board's own elements. */
export type FxHoldCue = { kind: "hold"; from: FxAnchor | null; to: FxAnchor; delayMs: number; landMs: number; durationMs: number };
export type FxConcealCue = { kind: "conceal"; testid: string; mode: "now" | "after"; delayMs: number; durationMs: number };
export type FxLungeCue = { kind: "lunge"; attacker: string; target: string; delayMs: number; durationMs: number };

export type FxCanvasCue = FxBurstCue | FxProjectileCue | FxCrackCue | FxRingCue;
export type FxDomCue = FxSplatCue | FxRaysCue | FxSheenCue | FxGhostCue | FxArrowsCue | FxBannerCue | FxResultCue;
export type FxStageCue = FxHoldCue | FxConcealCue | FxLungeCue;
export type FxCue = FxCanvasCue | FxShakeCue | FxDomCue | FxStageCue;

export type FxRecipe =
  | "cast"
  | "summon"
  | "impact"
  | "drain"
  | "heal"
  | "shieldBreak"
  | "death"
  | "void"
  | "bounce"
  | "burn"
  | "discard"
  | "draw"
  | "handGlint"
  | "shuffle"
  | "buff"
  | "keyword"
  | "counter"
  | "glint"
  | "radiant"
  | "smoke"
  | "fuse"
  | "mindControl"
  | "lock"
  | "trap"
  | "lunge"
  | "fizzle"
  | "mana"
  | "banner";

/** The optional `fx` field of an `ANIMATIONS` row: which recipe decorates the event. Data only. */
export type FxDescriptor = { readonly recipe: FxRecipe };

/** Public catalog facts about a readable defId (base face). `undefined` for "hidden" or unknown ids. */
export type FxCardFacts = { rarity?: Rarity; attack?: number; health?: number };

export type FxTrapZone = { player: PlayerId; row: Row; lane: number };

/** What the planner remembers across entries of one mount (who cast what, where a trap fired). */
export type FxMemory = {
  /** Records `cardPlayed` (instanceId → player) and `trapFired` (instanceId → zone). Ignores "hidden" ids. */
  remember(events: readonly GameEvent[]): void;
  casterOf(instanceId: string): PlayerId | undefined;
  trapZoneOf(instanceId: string): FxTrapZone | undefined;
  clear(): void;
};

export type FxPlanEnv = {
  /** `FX_INTENSITY_SCALE[settings.intensity]`; multiplies burst counts and trauma; 0 plans nothing. */
  intensity: number;
  card: (defId: string) => FxCardFacts | undefined;
  memory: FxMemory;
};

export type FxFrameSource = { request(callback: (timestampMs: number) => void): number; cancel(handle: number): void };
export type FxVisibility = { hidden(): boolean; subscribe(listener: () => void): () => void };
export type FxShakeOffset = { x: number; y: number; angle: number };
/** Where the shake goes. The default writes CSS `translate`/`rotate` on the board (S8). */
export type FxShakeSink = { apply(offset: FxShakeOffset): void; clear(): void };
```

### S2. `apps/web/src/fx/constants.ts` (owned by slice B, values binding)

CLAUDE.md rule 9: every FX number is a named constant, here or in a named tuning table inside the
module that uses it. Particle counts per recipe live in a `TUNING` table in `cues.ts`, and preset
physics in `PARTICLE_PRESETS` in `presets.ts`.

```ts
export const FX_MAX_TAIL_MS = 900;            // T: nothing an entry starts outlives entry end + T
export const FX_MAX_PARTICLE_LIFE_MS = 900;   // every preset's max life, ≤ FX_MAX_TAIL_MS
export const FX_SPLAT_HOLD_MS = 650;          // splat duration = (D − delay) + hold
export const FX_RAYS_TAIL_MS = 600;           // rays duration  = (D − delay) + tail
export const FX_ARROWS_TAIL_MS = 300;
export const FX_CRACK_TAIL_MS = 400;
export const FX_BANNER_TAIL_MS = 900;         // entry banner duration = D + tail
export const FX_RING_MS = 500;                // ring duration = min(FX_RING_MS, D − delay + T)
export const FX_HANDOVER_BANNER_MS = 1400;
export const FX_RESULT_MS = 3200;             // every planResult cue ends by this
export const FX_PROJECTILE_FLIGHT_FRACTION = 0.55;
export const FX_MIND_CONTROL_FLIGHT_FRACTION = 0.7;
export const FX_FUSE_FLIGHT_FRACTION = 0.5;
export const FX_SLAM_AT = 0.6;
export const FX_HOLD_MAX_MS = 6000;           // a stage effect's safety cap; it normally ends when the board shows the next view (R200)
export const FX_CONCEAL_AT = 0.9;             // an "after" conceal is set at 0.9 D, while the card's own motion still runs
export const FX_LUNGE_STANDOFF = 0.55;        // the lunge stops this many combined half-extents short of the target's centre
export const FX_LUNGE_MIN_PX = 26;            // = animations.css --lunge-distance (BUILD: at least 20 px)
export const FX_LUNGE_MAX_PX = 520;
export const FX_LUNGE_CONTACT_AT = 0.7;       // the contact beat inside attackDeclared (jk-lunge's 70% keyframe)
export const FX_HEAL_SPLAT_AT = 0.2;
export const FX_DEATH_EMBER_AT = 0.3;
export const FX_DEATH_SMOKE_AT = 0.5;
export const FX_RADIANT_BURST_AT = 0.4;
export const FX_TRAP_BURST_AT = 0.2;
export const FX_BURN_AT = 0.25;
export const FX_MANA_STAGGER_MS = 40;
export const FX_MANA_MAX_SPARKS = 10;
export const FX_SHAKE_MIN_DAMAGE = 3;
export const FX_TRAUMA_PER_DAMAGE = 0.15;
export const FX_SHAKE_MAX_TRAUMA = 0.8;
export const FX_HERO_TRAUMA_MULT = 1.25;
export const FX_SLAM_STATS_MIN = 10;          // printed attack + health
export const FX_SLAM_TRAUMA_PER_STAT = 0.06;
export const FX_SLAM_MAX_TRAUMA = 0.5;
export const FX_LEGENDARY_TRAUMA = 0.5;
export const FX_TRAP_TRAUMA = 0.4;
export const FX_RESULT_TRAUMA = 0.9;
export const FX_LETHAL_LEAD_MAX_MS = 600;     // the killing blow replayed before the result plays in at most this (R200)
export const FX_SHAKE_MAX_PX = 18;
export const FX_SHAKE_MAX_DEG = 1.2;
export const FX_SHAKE_FREQ_HZ = 18;
export const FX_TRAUMA_DECAY = 1.2;           // trauma per second; a full shake (1) is spent in 833 ms, inside FX_MAX_TAIL_MS
export const FX_PARTICLE_CAP = 600;
export const FX_PARTICLE_CAP_MOBILE = 260;
export const FX_PARTICLE_CAP_MIN = 120;
export const FX_MOBILE_WIDTH = 600;           // CSS px
export const FX_MAX_DPR = 2;
export const FX_MAX_DT_MS = 50;
export const FX_ADAPT_WINDOW = 30;            // frames
export const FX_ADAPT_SLOW_MS = 24;           // the least mean raw frame time that counts as slow
export const FX_ADAPT_SLOW_FACTOR = 1.4;      // …and slow also means this many times the display's own frame interval
export const FX_ADAPT_DISPLAY_MAX_MS = 34;    // the slowest interval taken for a display's refresh (30 Hz); slower is load
export const FX_ADAPT_MIN_INTERVAL_MS = 4;    // shorter raw intervals are not a display's refresh
export const FX_ADAPT_RECOVER_WINDOWS = 3;    // healthy windows in a row that double a lowered cap back up
export const FX_DEFAULT_SEED = 0x5eed;
export const FX_MEMORY_LIMIT = 64;            // entries each FxMemory map keeps (oldest evicted)
export const FX_SPEED_MIN = 0.5;
export const FX_SPEED_MAX = 2;
export const FX_SPEED_DEFAULT = 1;
export const FX_SPEED_STEPS = [0.5, 1, 1.5, 2] as const;   // for task 7's panel
export const FX_INTENSITY_SCALE = { off: 0, low: 0.45, normal: 1, high: 1.6 } as const;
export const FX_SETTINGS_KEY = "jackioh.fx.v1";
export const FX_CENTER = { x: 0.5, y: 0.45 } as const;     // viewport anchor for banners and shuffles
export const FX_TEXT = {
  yourTurn: "Your turn",
  opponentTurn: "Opponent's turn",
  autoEnded: "No moves left",
  victory: "Victory",
  defeat: "Defeat",
  draw: "Draw",
} as const;
```

### S3. `apps/web/src/fx/settings.ts` (slice B). Task 7's panel mounts these at integration

```ts
export type FxIntensity = "off" | "low" | "normal" | "high";
export type FxMotion = "system" | "reduce";
export type FxSettings = { speed: number; intensity: FxIntensity; motion: FxMotion };

export const DEFAULT_FX_SETTINGS: FxSettings;          // { speed: 1, intensity: "normal", motion: "system" }
export function normalizeSpeed(speed: unknown): number; // non-finite → 1; clamps to [FX_SPEED_MIN, FX_SPEED_MAX]
export function normalizeFxSettings(raw: unknown): FxSettings; // field by field; unknown values → defaults
export function loadFxSettings(storage?: Storage | null): FxSettings;   // reads FX_SETTINGS_KEY in try/catch
export function getFxSettings(): FxSettings;           // the in-memory current value (loaded once, lazily)
export function setFxSettings(patch: Partial<FxSettings>): FxSettings; // normalizes, persists in try/catch, notifies
export function subscribeFxSettings(listener: (settings: FxSettings) => void): () => void;
export function useFxSettings(): readonly [FxSettings, (patch: Partial<FxSettings>) => void]; // useSyncExternalStore
/** Test seam: drops the in-memory value and listeners so the next read reloads storage. */
export function resetFxSettingsForTests(): void;
```

`localStorage` is only touched inside `try/catch`. A missing `window`, a throwing getter, a quota error
or unparsable JSON all fall back to the defaults without throwing. `setFxSettings` keeps working in
memory when storage is unavailable.

### S4. `apps/web/src/game/animations.ts` changes (slice B)

All existing exports keep their names, signatures and behaviour at default settings. The additions:

```ts
import type { FxDescriptor } from "../fx/types.ts";
import { getFxSettings, normalizeSpeed, type FxSettings } from "../fx/settings.ts";

export type AnimationSpec = {
  animation: string;
  durationMs: number;
  testid: string;
  /** The effect recipe that decorates this row (docs/polish/1-animations.md, S7). Absent: no effect. */
  fx?: FxDescriptor;
};

export type AnimationEntry = {
  events: readonly GameEvent[];
  type: GameEventType;
  durationMs: number;
  frames: ReadonlyMap<string, GameEventType>;
  /** The view this entry was planned against: the board as it stood before its events. */
  view: PlayerView;
};

export type RunnerSignal =
  | { kind: "start"; entry: AnimationEntry } // an entry went in flight (durationMs > 0 only)
  | { kind: "idle" }                         // emitted each time the pump fires onSettled
  | { kind: "drain"; entries: readonly AnimationEntry[] } // drain() ran; the in-flight entry, then the waiting ones, it cut short
  | { kind: "reset" };                       // reset() ran

export type AnimationQueue = {
  /* …every existing member unchanged… */
  /** Lifecycle signals for the effects layer. Synchronous; returns its own unsubscribe. */
  subscribeSignals(listener: (signal: RunnerSignal) => void): () => void;
};

export type AnimationQueueOptions = {
  /* …every existing option unchanged… */
  /** Read at every enqueue (R201). Defaults to `getFxSettings`. */
  settings?: () => Pick<FxSettings, "speed" | "motion">;
};

/** R201: 0 stays 0; s = 1 returns d unchanged; otherwise max(MIN_ENTRY_MS, round(d / normalizeSpeed(s))). */
export function scaleForSpeed(durationMs: number, speed: number): number;

/** `prefersReducedMotion()` OR the viewer's `motion: "reduce"` setting (`settings` defaults to `getFxSettings()`). */
export function reducedMotionNow(settings?: Pick<FxSettings, "motion">): boolean;
```

Runner semantics:

- `planEntries(events, view, reducedMotion)` sets `entry.view = view`. Durations are still `durationFor`.
- `enqueue(events, view)`:
  - Read `s = options.settings?.() ?? getFxSettings()`.
  - Reduced motion is `(options.reducedMotion ?? prefersReducedMotion() captured at construction) || s.motion === "reduce"`.
  - Plan with that flag, then map every entry through `scaleForSpeed(d, s.speed)`.
  - Run `fitBudget` against `burstBudgetMs / normalizeSpeed(s.speed)`, then `pump()`.
- In `pump`: when an entry becomes `current`, emit `start` right after `notify()`. When the queue runs dry and `settle()` fires `onSettled`, emit `idle` after it.
- `drain()` emits `drain` after its `notify`/`settle`. `reset()` emits `reset`.
- `schedule` is still called exactly once per non-zero entry. The FX layer never calls it.

Every `ANIMATIONS` row keeps its `animation`, `durationMs`, `testid` and `target` byte-for-byte and adds
`fx: { recipe }` exactly per this table (the other 11 rows carry no `fx`):

| Row | `fx.recipe` | Row | `fx.recipe` | Row | `fx.recipe` |
|---|---|---|---|---|---|
| `cardPlayed` | `cast` | `drawn` | `draw` | `fused` | `fuse` |
| `summoned` | `summon` | `addedToHand` | `handGlint` | `controlChanged` | `mindControl` |
| `damage` | `impact` | `shuffledIn` | `shuffle` | `locked` | `lock` |
| `healthLost` | `drain` | `buffed` | `buff` | `trapFired` | `trap` |
| `healed` | `heal` | `keywordGranted` | `keyword` | `attackDeclared` | `lunge` |
| `divineShieldLost` | `shieldBreak` | `counterChanged` | `counter` | `attackCancelled` | `fizzle` |
| `destroyed` | `death` | `costChanged` | `glint` | `manaChanged` | `mana` |
| `exiled` | `void` | `modifierChanged` | `glint` | `turnStarted` | `banner` |
| `bounced` | `bounce` | `radiantSet` | `radiant` | `turnAutoEnded` | `banner` |
| `burned` | `burn` | `transformed` | `smoke` | | |
| `discarded` | `discard` | | | | |

No `fx`: `cardResolved`, `enteredGraveyard`, `positionSwitched`, `rotated`, `swapped`, `turnEnded`,
`promptOpened`, `promptAnswered`, `drawOffered`, `drawAnswered`, `gameOver`. The `gameOver` row's
duration stays 0, so the runner never plays it. The result sequence runs off `view.result` instead
(S9).

### S5. Canvas engine: `apps/web/src/fx/{rng,presets,sprites,particles,canvasFx,surface,loop,shake}.ts` (slice A)

```ts
// rng.ts
export type FxRng = () => number;                          // uniform in [0, 1)
export function createRng(seed: number): FxRng;            // mulberry32
export function createNoise1D(seed: number): (tSeconds: number) => number; // smooth value noise in [-1, 1]

// presets.ts
export type ParticlePresetSpec = {
  life: readonly [number, number];      // ms, max ≤ FX_MAX_PARTICLE_LIFE_MS
  speed: readonly [number, number];     // CSS px per second
  size: readonly [number, number];      // CSS px diameter
  gravity: number;                      // px/s², negative rises
  drag: number;                         // fraction of velocity lost per second, 0..1
  spin: number;                         // max radians per second
  blend: "lighter" | "source-over";
  colors: readonly string[];            // CSS colours the sprites are drawn in
  shrink: boolean;                      // size eases to 0 over life
  stretch?: number;                     // streak length per 1000 px/s of speed (sparks, shards, embers)
  twirl?: boolean;                      // drawn turned by its rotation (confetti)
  flash?: FlashSpec;                    // a bloom at the origin of every burst of this preset
};
/** `scale` sizes the bloom against the anchor box's shorter side; `ms` ≤ FX_MAX_TAIL_MS. */
export type FlashSpec = { core: string; color: string; scale: number; ms: number };
export const PARTICLE_PRESETS: { readonly [P in FxPreset]: ParticlePresetSpec };

// sprites.ts
export type SpriteSurface = { canvas: CanvasImageSource; ctx: CanvasRenderingContext2D };
export type SpriteCanvasFactory = (sizePx: number) => SpriteSurface | null;
/** Real document canvases; returns a factory that yields null under jsdom (isHeadlessDom). */
export function domSpriteCanvas(doc?: Document): SpriteCanvasFactory;
export type SpriteCache = {
  /** A radial-gradient disc for (preset, colour index, dpr), drawn once and cached; null without a 2D context. */
  get(preset: FxPreset, colorIndex: number, dpr: number): CanvasImageSource | null;
  size(): number;
  clear(): void;
};
export function createSpriteCache(factory: SpriteCanvasFactory): SpriteCache;

// particles.ts
export type EmitOptions = { count: number; spread: FxSpread; box: FxBox; power: number };
export type ParticleSystem = {
  /** Emits at (x, y), or across `box` for "area" and around its ellipse for "ring". Returns how many. */
  emit(preset: FxPreset, x: number, y: number, options: EmitOptions): number;
  /** Moves by `dtMs` (clamped) and ages by `ageMs` (the real time that passed, default `dtMs`). */
  step(dtMs: number, ageMs?: number): void;
  /** Draws every live particle; a null sprite falls back to a filled arc in the preset colour. */
  draw(ctx: CanvasRenderingContext2D, dpr: number): void;
  alive(): number;
  capacity(): number;
  /** Lowers or raises the live cap; growing reallocates the pool, shrinking never does. */
  setCapacity(capacity: number): void;
  /** `allocations` counts pool (re)allocations: 1 after construction. */
  stats(): { allocations: number };
  /** Live particles in slot order, for tests. */
  inspect(): ReadonlyArray<{ preset: FxPreset; x: number; y: number; life: number }>;
  clear(): void;
};
/** `sprites` defaults to `createSpriteCache(domSpriteCanvas())`. */
export function createParticleSystem(options: { capacity: number; rng: FxRng; sprites?: SpriteCache }): ParticleSystem;

// canvasFx.ts: projectiles, cracks and rings (particles are ParticleSystem's). FxVec comes from types.ts.
export type CanvasFx = {
  /** A glowing head along a shallow quadratic arc, emitting `preset` trail particles each step; ends at flightMs.
   *  `density` (default 1, the intensity scale) multiplies the trail and the arrival burst. */
  projectile(preset: FxPreset, from: FxVec, to: FxVec, flightMs: number, density?: number): void;
  /** Jagged branching polyline from the box centre, white-hot fading to dark over durationMs. */
  crack(box: FxBox, durationMs: number): void;
  /** Expanding ellipse stroke from 0.6× to 1.4× the box, fading over durationMs. */
  ring(preset: FxPreset, box: FxBox, durationMs: number): void;
  /** The preset's `flash` bloom at `at`, sized by `box` and the burst's `count`; no-op without one. */
  flash(preset: FxPreset, at: FxVec, box: FxBox, count: number): void;
  /** Moves by `dtMs` (clamped; paces the trail) and ages by `ageMs` (real time, default `dtMs`). */
  step(dtMs: number, ageMs?: number): void;
  draw(ctx: CanvasRenderingContext2D): void;
  /** Projectiles, cracks and rings still running. */
  alive(): number;
  clear(): void;
};
export function createCanvasFx(options: { particles: ParticleSystem; rng: FxRng }): CanvasFx;

// surface.ts
export function isHeadlessDom(win?: Window): boolean;       // navigator.userAgent contains "jsdom"
export function effectiveDpr(devicePixelRatio: number | undefined): number; // clamp to [1, FX_MAX_DPR]; NaN/undefined → 1
export type FxSurface = {
  readonly canvas: HTMLCanvasElement;
  readonly ctx: CanvasRenderingContext2D;
  dpr(): number;
  width(): number;   // CSS px
  height(): number;  // CSS px
  /** Re-reads CSS size (rect, else window.inner*) and DPR; reallocates the backing store only on change. */
  resize(): void;
  /** Clears the whole store and sets the transform to scale(dpr). */
  clear(): void;
  dispose(): void;   // removes the resize listener / ResizeObserver
};
/** null under jsdom (never calls getContext there), or when getContext("2d") is null or throws. */
export function createSurface(canvas: HTMLCanvasElement, win?: Window): FxSurface | null;

// loop.ts
export type FxFrame = { dt: number; raw: number; now: number; first: boolean }; // dt = clamp(raw, 0, FX_MAX_DT_MS); first: the first frame after a wake
export type FrameLoop = { wake(): void; running(): boolean; dispose(): void };
export function createFrameLoop(options: {
  frames: FxFrameSource;
  visibility: FxVisibility;
  now: () => number;
  /** Return true while there is still work; false stops requesting frames until the next wake(). */
  onFrame: (frame: FxFrame) => boolean;
  /** Called when the page turns visible after being hidden. */
  onResume?: () => void;
}): FrameLoop;

// shake.ts
export type Shake = {
  add(trauma: number): void;           // trauma = min(1, trauma + max(0, t))
  step(dtMs: number): void;            // linear decay at decayPerSecond, floored at 0
  sample(nowMs: number): FxShakeOffset; // x,y = maxOffsetPx·trauma²·noise, angle = maxAngleDeg·trauma²·noise
  trauma(): number;
  active(): boolean;                   // trauma > 0
  reset(): void;
};
export function createShake(options?: { seed?: number; maxOffsetPx?: number; maxAngleDeg?: number; decayPerSecond?: number; frequencyHz?: number }): Shake;
```

`wake()` requests a frame only if none is pending and the page is not hidden. The first frame after a
wake gets `raw` measured from the wake time. When the page turns hidden, the pending frame is
cancelled. When it turns visible, `onResume` runs and nothing is requested until the next `wake()`.

### S6. `apps/web/src/fx/memory.ts` and `apps/web/src/fx/cues.ts` (slice C)

```ts
// memory.ts
export function createFxMemory(limit?: number): FxMemory; // default FX_MEMORY_LIMIT per map, oldest evicted

// cues.ts
/** Plans every event of one entry: each event's row recipe, in event order, concatenated. */
export function planFx(entry: AnimationEntry, view: PlayerView, env: FxPlanEnv): FxCue[];
/** The game-over sequence for a view with a result; [] when view.result is null. */
export function planResult(view: PlayerView, env: Pick<FxPlanEnv, "intensity">): FxCue[];
/** The "Your turn" banner on a hot-seat hand-over; [] unless active === viewer, phase ≠ "mulligan", no result. */
export function planHandover(view: PlayerView, env: Pick<FxPlanEnv, "intensity">): FxCue[];
/** The killing blow a drained game over never drew: the last of `entries` whose damage or health loss
 *  lands on a losing hero, planned again at min(its D, FX_LETHAL_LEAD_MAX_MS); `leadMs` is that D. */
export function planLethal(entries: readonly AnimationEntry[], view: PlayerView, env: FxPlanEnv): { cues: FxCue[]; leadMs: number };
/** The same cues, each `ms` later. */
export function delayCues(cues: readonly FxCue[], ms: number): FxCue[];
/** Where a non-combat damage source is: rendered instance → remembered trap zone → caster's hero → null. */
export function sourceAnchor(sourceId: string | null, view: PlayerView, memory: FxMemory): { anchor: FxAnchor; kind: "unit" | "backrow" | "hand" | "trap" | "hero" } | null;
```

```ts
// stage.ts (B46–B48)
/** The stage cues of one entry, in event order; [] at intensity 0. Pure, like planFx. */
export function planStage(entry: AnimationEntry, view: PlayerView, env: FxPlanEnv): FxCue[];
```

`planFx` is pure. It reads only its arguments and never touches the DOM. The FX layer calls
`env.memory.remember(entry.events)` **before** `planFx`, so a spell's own `cardPlayed` in the same
entry is already known. If `env.intensity <= 0`, `planFx`, `planResult` and `planHandover` all return
`[]`. Each burst `count` is `max(1, round(TUNING count × intensity))`. Each trauma is
`min(1, base × intensity)`, and a shake cue is only emitted when that is > 0. Every anchor is
`{ kind: "testid", testid }` built from `targetFor(event, view)` (called **tgt** below) unless stated
otherwise. A recipe whose tgt is `null` returns `[]`.

### S7. The recipe table (slice C implements it; tester 1 asserts it row by row)

Notation: `burst(preset, anchor, spread, delay)`; `ring(preset, anchor, delay)` with duration
`min(FX_RING_MS, D − delay + T)`; `rays(tone, anchor, delay)` with duration `D − delay + FX_RAYS_TAIL_MS`;
`splat(tone, amount, anchor, delay)` with duration `D − delay + FX_SPLAT_HOLD_MS`; `crack(anchor, delay)`
with duration `D − delay + FX_CRACK_TAIL_MS`; `sheen(anchor, 0)` and `ghost(from, to, 0)` with duration
`D`; `arrows(dir, anchor, 0)` with duration `D + FX_ARROWS_TAIL_MS`. Every `projectile` carries
`density: env.intensity`. `at(p)` sets the anchor's `at`
point. `side(x)` is `sideOf(view, x)`. Fractions such as `FX_SLAM_AT·D` are rounded.

| Recipe | Event | Cues |
|---|---|---|
| `cast` | `cardPlayed` | `[]` if the entry also holds a `summoned` with the same `instanceId`. If tgt is `hand-card-*` or `card-*`: `burst(arcane, tgt, area, 0)`, `ring(arcane, tgt, 0)`. Otherwise (the opponent's `hand-opponent`): `burst(arcane, tgt, point, 0)`. |
| `summon` | `summoned` | Let slam = `FX_SLAM_AT·D`. Backrow row, or `env.card(defId)` undefined: `burst(dust, tgt at(0.5,1), ring, slam)` only. Units row with readable facts: `ring(dust, tgt, slam)`, `burst(dust, tgt at(0.5,1), ring, slam)`. Legendary adds `rays(legendary, tgt, 0)` and `burst(gold, tgt, area, slam)`; Mythic adds `rays(mythic, tgt, 0)` and `burst(prismatic, tgt, area, slam)`. Then `shake(trauma, slam)` with trauma = slamTrauma + (Legendary or Mythic ? `FX_LEGENDARY_TRAUMA` : 0), where slamTrauma = stats ≥ `FX_SLAM_STATS_MIN` ? `min(FX_SLAM_MAX_TRAUMA, (stats − FX_SLAM_STATS_MIN + 1)·FX_SLAM_TRAUMA_PER_STAT)` : 0, and stats = attack + health (missing counts as 0). |
| `impact` | `damage` | Let src = `sourceAnchor(sourceId)`. If `combat` is false and src exists with a testid ≠ tgt's: `projectile(p, src → tgt, 0, flight = FX_PROJECTILE_FLIGHT_FRACTION·D)`, where p is `poison` for a Poisonous unit source, `arcane` for unit, backrow and trap sources, and `fire` for hand and hero sources. Then hit = flight, else hit = 0. Then `burst(spark, tgt, point, hit)`, `splat(damage, amount, tgt, hit)` (only when amount > 0), `burst(poison, tgt, area, hit)` if the source unit in `view` has Poisonous, and `shake(t, hit)` with t = amount < `FX_SHAKE_MIN_DAMAGE` ? 0 : `min(FX_SHAKE_MAX_TRAUMA, amount·FX_TRAUMA_PER_DAMAGE)`, ×`FX_HERO_TRAUMA_MULT` when tgt is `hero-*`. |
| `drain` | `healthLost` | `burst(void, tgt, area, 0)`, `splat(loss, amount, tgt, 0)` |
| `heal` | `healed` | `rays(holy, tgt, 0)`, `burst(holy, tgt, area, 0)`, `splat(heal, amount, tgt, FX_HEAL_SPLAT_AT·D)` |
| `shieldBreak` | `divineShieldLost` | `ring(gold, tgt, 0)`, `burst(shard, tgt, ring, 0)` |
| `death` | `destroyed` | tgt `card-*`: `crack(tgt, 0)`, `burst(ember, tgt, area, FX_DEATH_EMBER_AT·D)`, `burst(smoke, tgt, area, FX_DEATH_SMOKE_AT·D)`. Otherwise (a pile): `burst(smoke, tgt, point, 0)`. |
| `void` | `exiled` | `ring(void, tgt, 0)`, `burst(void, tgt, area, 0)` |
| `bounce` | `bounced` | `burst(smoke, tgt, area, 0)`, plus `ghost(tgt → hand-<side(owner)>, 0)` when tgt is `card-*` |
| `burn` | `burned` | `burst(fire, tgt, area, FX_BURN_AT·D)`, `burst(ember, tgt, area, FX_BURN_AT·D)` (tgt is `hand-<side(owner)>`) |
| `discard` | `discarded` | `ghost(tgt → graveyard-<side(owner)>, 0)`, `burst(ember, graveyard-<side(owner)>, point, D)` |
| `draw` | `drawn` | `ghost(library-<side(player)> → hand-<side(player)>, 0)`, `burst(sparkle, hand-<side(player)>, point, D)` |
| `handGlint` | `addedToHand` | `burst(sparkle, hand-<side(player)>, area, 0)` |
| `shuffle` | `shuffledIn` | `ghost({viewport, FX_CENTER} → library-<side(player)>, 0)`, `burst(arcane, library-<side(player)>, point, D)` |
| `buff` | `buffed` | attack + health > 0: `arrows(up, tgt, 0)`, `burst(sparkle, tgt, area, 0)`. < 0: `arrows(down, tgt, 0)`, `burst(void, tgt, area, 0)`. = 0: `[]`. |
| `keyword` | `keywordGranted` | Divine Shield: `ring(gold, tgt, 0)`, `burst(holy, tgt, ring, 0)`. Poisonous: `burst(poison, tgt, area, 0)`. Taunt: `ring(dust, tgt, 0)`. Any other: `burst(arcane, tgt, point, 0)`. |
| `counter` | `counterChanged` | plague: `burst(poison, tgt, area, 0)`. grade: `burst(sparkle, tgt, point, 0)`. |
| `glint` | `costChanged` | `burst(arcane, tgt, point, 0)` |
| `glint` | `modifierChanged` | `added`: `burst(arcane, tgt, point, 0)`. Removed: `[]`. |
| `radiant` | `radiantSet` | `sheen(tgt, 0)`, `burst(gold, tgt, area, FX_RADIANT_BURST_AT·D)`, plus `rays(radiant, tgt, 0)` when tgt is `card-*` |
| `smoke` | `transformed` | `burst(smoke, tgt, point, 0)`, `burst(arcane, tgt, point, 0)` (point, not area: the integration QA saw an area of puffs drift over the next lanes on a phone) |
| `fuse` | `fused` | Let f = `FX_FUSE_FLIGHT_FRACTION·D`. `burst(smoke, tgt, area, 0)`. For every other located `instanceIds` member o ≠ tgt: `burst(smoke, o, area, 0)` and `projectile(arcane, o → tgt, 0, f)`. Then `burst(arcane, tgt, area, f)`. |
| `mindControl` | `controlChanged` | Let from = `locateInstance(view, instanceId)` and f = `FX_MIND_CONTROL_FLIGHT_FRACTION·D`. With from: `projectile(arcane, from → tgt, 0, f)`, `burst(arcane, tgt, area, f)`. Without: `burst(arcane, tgt, area, 0)`. |
| `lock` | `locked` | `ring(dust, tgt, 0)`, `burst(dust, tgt, area, 0)` |
| `trap` | `trapFired` | Let b = `FX_TRAP_BURST_AT·D`. `ring(arcane, tgt, 0)`, `burst(arcane, tgt, ring, b)` (a tight ring on the trap's zone, not an area of motes: integration QA), `shake(FX_TRAP_TRAUMA, b)`. tgt is the card when the viewer reads it, else the zone (R154). |
| `lunge` | `attackDeclared` | `burst(dust, tgt at(0.5,1), point, 0)` |
| `fizzle` | `attackCancelled` | `burst(smoke, tgt, point, 0)` |
| `mana` | `manaChanged` | Let old = the planning view's `mana.current` for `side(player)`, and n = `min(event.current, old + FX_MANA_MAX_SPARKS) − old`. For i in 0…n−1: `burst(sparkle, {crystal, side(player), index: old+i}, point, min(D, i·min(FX_MANA_STAGGER_MS, floor(D / max(n,1)))))`. n ≤ 0: `[]`. |
| `banner` | `turnStarted` | player = viewer: `banner(FX_TEXT.yourTurn, "you", 0, D + FX_BANNER_TAIL_MS)`, `rays(victory, {viewport, FX_CENTER}, 0)`. Otherwise: `banner(FX_TEXT.opponentTurn, "opponent", 0, D + FX_BANNER_TAIL_MS)`. |
| `banner` | `turnAutoEnded` | `banner(FX_TEXT.autoEnded, "muted", 0, D + FX_BANNER_TAIL_MS)` |

`planResult(view)`: the outcome is victory when `result.winner === view.viewer`, draw when `"draw"`,
defeat otherwise. The loser's side is `opponent` for a victory and `you` for a defeat. Every cue ends by
`FX_RESULT_MS`. The literal 900, 200 and 300 below are entries of a named `RESULT_TUNING` table in
`cues.ts` (rule 9), not free numbers:
- victory: `result(victory, FX_TEXT.victory, 0, FX_RESULT_MS)`, `rays(victory, {viewport, FX_CENTER}, 0, FX_RESULT_MS)`, `burst(confetti, {viewport, FX_CENTER}, area, 0)`, `crack(hero-opponent, 0, 900)`, `burst(shard, hero-opponent, ring, 200)`, `burst(smoke, hero-opponent, area, 300)`, `shake(FX_RESULT_TRAUMA, 200)`
- defeat: `result(defeat, FX_TEXT.defeat, 0, FX_RESULT_MS)`, `crack(hero-you, 0, 900)`, `burst(shard, hero-you, ring, 200)`, `burst(smoke, hero-you, area, 300)`, `burst(ember, hero-you, area, 300)`, `shake(FX_RESULT_TRAUMA, 200)`
- draw: `result(draw, FX_TEXT.draw, 0, FX_RESULT_MS)`, `burst(dust, hero-you, area, 0)`, `burst(dust, hero-opponent, area, 0)`

`planHandover(view)`: `banner(FX_TEXT.yourTurn, "you", 0, FX_HANDOVER_BANNER_MS)`, `rays(victory, {viewport, FX_CENTER}, 0, FX_HANDOVER_BANNER_MS)`.

### S8. Director: `apps/web/src/fx/director.ts`, `apps/web/src/fx/anchors.ts` (slice D)

```ts
// anchors.ts
/** testid → the element's rect; crystal → the index-th `.mana-crystal` in `mana-<side>` (falling back to
 *  the tray's box); viewport → a zero-size box at (innerWidth·at.x, innerHeight·at.y). An element with a
 *  0×0 rect (not laid out, or jsdom) resolves to null. */
export function resolveAnchor(anchor: FxAnchor, doc?: Document, win?: Window): FxBox | null;
export function pointIn(box: FxBox, at?: FxPoint): FxVec;        // default at = centre
/** CSS `translate`/`rotate` on [data-testid="board"] while shaking; restores the prior inline values on clear(). */
export function boardShakeSink(doc?: Document): FxShakeSink;

// director.ts
export function capacityFor(viewportWidth: number): number; // < FX_MOBILE_WIDTH ? FX_PARTICLE_CAP_MOBILE : FX_PARTICLE_CAP
export type FxDirectorOptions = {
  surface: FxSurface | null;              // null: canvas cues (burst, projectile, crack, ring) are dropped
  domRoot: HTMLElement;                   // DOM cues mount here via mountDomEffect (S10)
  now: () => number;
  frames: FxFrameSource;
  visibility: FxVisibility;
  measure: (anchor: FxAnchor) => FxBox | null;
  shakeSink: FxShakeSink;
  seed: number;
  capacity: number;
  /** The board element a stage cue acts on, by testid. Defaults to a `document` query. */
  element?: (testid: string) => HTMLElement | null;
  /** Scroll and resize, so a parked stand-in follows its zone. Defaults to the window's events. */
  viewport?: { subscribe(listener: () => void): () => void };
};
export type FxDirector = {
  /** Schedules cues relative to now(); each fires on the first frame where now() ≥ playTime + delayMs. Dropped while hidden. */
  play(cues: readonly FxCue[]): void;
  /** Removes every pending cue, DOM effect, particle, projectile, crack and ring; resets the shake and calls shakeSink.clear(). */
  clear(): void;
  /** The board shows a newer view: undoes every stage effect (stand-ins, hidden cards, aimed lunges) and leaves the rest to finish. */
  release(): void;
  /** Pending cues + mounted DOM effects + stage effects + canvasFx.alive() + (shake active ? 1 : 0). */
  active(): number;
  particles(): number;
  capacity(): number;
  dispose(): void;
};
export function createFxDirector(options: FxDirectorOptions): FxDirector;
```

The director builds its own parts from the options: `createParticleSystem({ capacity, rng: createRng(seed) })`,
`createCanvasFx({ particles, rng: createRng(seed + 1) })`, `createShake({ seed })` and one
`createFrameLoop` over `frames`, `visibility` and `now`. `play()` calls `wake()` on that loop.

Frame work, in order:
1. Fire due cues, measuring anchors at fire time. A null box skips the cue. A burst also calls
   `canvasFx.flash(preset, origin, box, count)`, which blooms only for a preset with a `flash`. A
   stage cue due at once acts inside `play()` itself, so the hand card a stand-in replaces and the
   stand-in change in the same paint.
2. Move particles, canvasFx and the shake by `dt` and age them by `max(0, raw)`, so a stalled frame
   never keeps an effect alive past its wall-clock end (R200).
3. `shakeSink.apply(shake.sample(now))` while active, or `shakeSink.clear()` on the frame it goes idle.
4. While anything is alive on the canvas (and once more after), `surface.clear()` and draw the
   particles and canvasFx. An empty, already-clear canvas is left alone.
5. Remove every DOM effect whose `firedAt + durationMs ≤ now`, and undo every stage effect past its
   cap. A stand-in re-measures its zone only on a frame where the board moved (the shake ran this
   frame or the last) or the page scrolled or resized, and follows it by `translate` (no layout); a
   new size re-places it.
6. Adaptive quality (B34): the cap halves when a window runs slow against the display's own refresh,
   and doubles back after healthy windows.
7. Report work when anything is pending, mounted, alive or shaking, or a scroll is waiting to be
   followed. A parked stage effect needs no frame and keeps none running.

A new `banner` removes any banner still mounted, so two never read over each other.

`onResume` calls `clear()`. The director uses no `setTimeout`: all timing comes from the frame loop and
`now()`.

### S9. `apps/web/src/fx/FxLayer.tsx` and `apps/web/src/fx/index.ts` (slice D)

```ts
export type FxSeams = {
  now: () => number;
  frames: FxFrameSource;
  visibility: FxVisibility;
  measure: (anchor: FxAnchor) => FxBox | null;
  surface: (canvas: HTMLCanvasElement) => FxSurface | null;
  shakeSink: FxShakeSink;
  seed: number;
  /** Overrides the CatalogContext lookup. */
  catalog: (defId: string) => FxCardFacts | undefined;
  viewportWidth: () => number;
  /** The board element a stage cue acts on (stage.ts), by testid. */
  element: (testid: string) => HTMLElement | null;
};
export type FxLayerProps = {
  queue: AnimationQueue;
  /** The view the board is SHOWING (Game's `shown`), not the newest one. */
  view: PlayerView;
  /** Test seams; production passes none. */
  seams?: Partial<FxSeams>;
};
export default function FxLayer(props: FxLayerProps): ReactElement;
```

Defaults: `performance.now`, `requestAnimationFrame`, `document.hidden` + `visibilitychange`,
`resolveAnchor`, `createSurface`, `boardShakeSink(document)`, `FX_DEFAULT_SEED`, `window.innerWidth`.
The default `catalog` is built from `useContext(CatalogContext)`:
`defId === "hidden" ? undefined : lookup?.(defId, false)`, mapped to `{ rarity, attack, health }`.

Rendered DOM (always the root; the children only when enabled):

```html
<div class="fx-layer" data-testid="fx-layer" data-fx="on|off" aria-hidden="true">
  <canvas class="fx-canvas" data-testid="fx-canvas"></canvas>
  <div class="fx-dom" data-testid="fx-dom"></div>
</div>
```

- Enabled = `!reducedMotionNow(settings) && settings.intensity !== "off"`, read through
  `useFxSettings()`.
- `queue.subscribeSignals` is registered in a **layout** effect, so it is in place before `Game`'s
  enqueue layout effect runs (child effects run first).
- On `start`, whether enabled or not: write `--anim-squeeze` on `root.parentElement` as
  `(entry.durationMs / ANIMATIONS[entry.type].durationMs).toFixed(3)`. Then, if enabled,
  `memory.remember(entry.events)` and `director.play([...planFx(…), ...planStage(entry, entry.view, env)])`.
- On `idle`: remove `--anim-squeeze`. On `drain` or `reset`: remove it, `director.clear()` and
  `memory.clear()`. A `drain` also keeps the entries it cut short (with any started since the last
  `idle`) for the result below.
- The shown view changing (a layout effect, so it lands in the same paint as the new board) →
  `director.release()`.
- `view.result` going from null to set during the mount → remember the drained entries' events, then
  `director.play([...lethal.cues, ...delayCues(planResult(view, env), lethal.leadMs)])` with
  `lethal = planLethal(drained, view, env)`. A first render that already has a result plays nothing.
- While the viewer's `motion` setting is "reduce", `--anim-scale: 0` sits on `root.parentElement`,
  exactly what index.css does on `:root` under the media query.
- `view.viewer` changing after the first render → `director.play(planHandover(view, env))`.
- Nothing inside `fx-layer` ever carries a `data-animating` of its own (a stand-in's copy only echoes the one on the card it carries, B46), a `role`, focusable content or a text node.
- `index.ts` re-exports `FxLayer` (default and named), everything in `settings.ts`, and the types in
  `types.ts`.

### S10. DOM effects and CSS: `apps/web/src/fx/dom.ts`, `apps/web/src/fx/fx.css`, `apps/web/src/game/animations.css` (slice E)

```ts
export type DomEffectBoxes = { at?: FxBox | null; from?: FxBox | null; to?: FxBox | null };
export type DomEffect = { readonly el: HTMLElement; remove(): void };
/** Appends one element for the cue; null (nothing appended) when a box the kind needs is missing. */
export function mountDomEffect(root: HTMLElement, cue: FxDomCue, boxes: DomEffectBoxes): DomEffect | null;
```

| `cue.kind` | Needs | Element contract (all: `class="fx-<kind>"`, `data-fx="<kind>"`, `aria-hidden="true"`, no child text node) |
|---|---|---|
| `splat` | `at` | `data-tone`, `data-amount` = `` `-${amount}` `` for damage and loss, `` `+${amount}` `` for heal (ASCII hyphen-minus and plus); `--fx-x/--fx-y` = box centre, `--fx-w/--fx-h` = box size |
| `rays` | `at` | `data-tone`; centre and size as for splat |
| `sheen` | `at` | covers the box: `--fx-x/--fx-y` = top-left, `--fx-w/--fx-h` = size |
| `ghost` | `from`, `to` | `--fx-x/--fx-y` = from centre, `--fx-dx/--fx-dy` = to centre − from centre; a card back only |
| `arrows` | `at` | `data-direction`; covers the box |
| `banner` | none | `data-tone`, `data-text`; CSS centres it in the viewport |
| `result` | none | `data-outcome`, `data-text`; CSS fills the viewport |

Stand-ins (B46) mount through `mountHold(root, cue, { source, from, land, font })`: a `div.fx-hold`
(`data-fx="hold"`, `data-look="card|glow"`, `aria-hidden`, `inert`) holding `standInCopy(source)`, a
copy of the card with every testid, id, role, label, legality mark and text node stripped (words move
into `data-text`), or a card-shaped light. `landingBox(zone, source)` is its box in the zone. It
returns `place(box)` (re-place, a layout) and `shift(dx, dy)` (a `translate`, no layout).

Every element also gets `--fx-ms: <durationMs>ms`. Lengths are written as `<n>px`. Text reaches the
screen only through CSS `content: attr(data-amount)` or `content: attr(data-text)`, so no Cypress
`contains` can match an effect. `dom.ts` sets no timers; the director removes elements.

`fx.css` (imported by `FxLayer.tsx`) must provide:
- The layer: `.fx-layer { position: fixed; inset: 0; z-index: 38; pointer-events: none; overflow: hidden }`. `.fx-layer *` also has `pointer-events: none`. `.fx-canvas` fills the layer. Children of `.fx-dom` are `position: absolute`. z-index 38 puts the layer above the board and below the prompt scrim (40), and the animated cards (40, 45, 50) stay above it.
- One keyframe animation per kind, each running for `var(--fx-ms)`: `fx-splat-pop` (the red, green or violet starburst drawn with `clip-path`), `fx-rays-spin` (a `repeating-conic-gradient` masked by a radial gradient), `fx-sheen-sweep`, `fx-ghost-fly`, `fx-arrows-rise`, `fx-banner-in`, `fx-result-in`.
- The persistent Divine Shield cocoon, gated like every effect on the layer being on:
  `.game:has(> .fx-layer[data-fx="on"]) [data-testid^="card-"]:has([data-keyword="Divine Shield"])::after`,
  a golden radial bubble with a bright rim and a slow `fx-shield-pulse`, plus an outline shell past
  the card's edge (not on a `:focus-visible` card).
- Every `@keyframes` in both sheets animates only transform, opacity and filters that move no pixels
  (brightness, saturate, sepia, grayscale, hue-rotate), so every motion runs on the compositor. A glow
  is drawn once and faded by opacity. BUILD's own `jk-chain-close` is the one exception.
- The classic `turn-banner` is `visibility: hidden` while a layer banner is mounted.
- The classic numbers hidden while effects are on: `.game:has(> .fx-layer[data-fx="on"]) :is(.damage-pop, .heal-pop, .loss-pop) { visibility: hidden }`. They stay in the DOM, so BUILD's `.damage-pop` text assertions still hold.
- A `@media (prefers-reduced-motion: reduce)` block that sets `animation: none` on every `.fx-*` element and on the cocoon's pulse.

`animations.css` keeps every existing `@keyframes` name, every duration literal and the reduced-motion
block. It also makes `result-overlay` a panel fixed mid-screen (z-index 39) that outlasts the
game-over sequence, and hides the `turn-banner` once the overlay is up. Every `animation-duration: calc(<n>ms * var(--anim-scale))` becomes
`calc(<n>ms * var(--anim-scale) * var(--anim-squeeze, 1))`. Visual upgrades are allowed inside the
existing keyframes (a brightness flash in `jk-dissolve`, a violet `drop-shadow` in `jk-trap-flip`, a
gold flare in `jk-radiant-pulse`, a hotter palette in `jk-burn-away`). A
`[data-animating="manaChanged"] .mana-crystal[data-filled="true"]` glow is also allowed. `.mana-crystal`
and `data-filled` are e2e contracts, which is why they are safe to target.

### S11. Additive edits to shared files (slice D only)

- `apps/web/src/game/Game.tsx`: one import (`import FxLayer from "../fx/FxLayer.tsx";`) and one mount line, `<FxLayer queue={runner} view={shown} />`, placed immediately after `<Board … />`. Nothing else in `Game.tsx` changes.
- `apps/web/src/game/catalog.ts`: `CardInfo` gains an optional `rarity?: Rarity`, and `lookupFromDefs` sets `rarity: def.rarity`. Nothing else changes. If task 6 has already added the field, keep theirs.
- `SPEC.md`: a paragraph at the end of §10.10, and rows R200–R202 in §11, in numeric position (text in "SPEC changes").
- `BUILD.md` M5-T4: an `FX` column on the table (the recipe from S4 plus a few words, `—` for none) and one paragraph under it naming `docs/polish/1-animations.md` and R200–R202. Durations and acceptance cells are unchanged.
- `packages/engine/test/rulings.test.ts`: the header's "R1 to R170" becomes the current range. Add constants `WEB_FX_CUES_TEST = "../../../apps/web/src/fx/cues.test.ts"`, `WEB_FX_DIRECTOR_TEST = "../../../apps/web/src/fx/director.test.ts"`, `WEB_FX_LAYER_TEST = "../../../apps/web/src/fx/FxLayer.test.tsx"` and `WEB_ANIMATIONS_FX_TEST = "../../../apps/web/src/game/animations.fx.test.ts"`. Add `it("R200 …") → provenIn(200, WEB_FX_CUES_TEST, WEB_FX_DIRECTOR_TEST, WEB_FX_LAYER_TEST)`, `it("R201 …") → provenIn(201, WEB_ANIMATIONS_FX_TEST)` and `it("R202 …") → provenIn(202, WEB_FX_CUES_TEST)`, each in numeric position.
- `apps/web/README.md`: add the `fx/` files to the layout block.

### S12. What stays untouched (the e2e and runner contract)

- `e2e/support` waits with `cy.settled()`, which is `cy.get("[data-animating]").should("not.exist")` with
  `timeouts.animation` = 4 s. `cy.expectAnimating(type)` looks for `[data-animating="<type>"]`. FX add
  no `data-animating` anywhere, so neither command sees them. Tails and particles are invisible to both.
- Spec 04 reads `.damage-pop` text inside `card-<id>`. The classic pops stay rendered (only
  `visibility: hidden`), and FX splats live outside cards with class `fx-splat`.
- `animations.test.ts`, `animation-targets.test.tsx`, `Board.test.tsx` and its snapshot pass unmodified.
  `FxLayer` renders inside `Game`, not `Board`.
- The component spec `board-layout.cy.tsx` measures `scrollWidth`. The layer is `position: fixed; inset: 0; overflow: hidden`, so it adds no scrollable width.
- No `GameEvent` type is added. `packages/shared/src/events.ts` is not edited.

## Behaviors

Table and runner (slice B):

- **B1** `ANIMATIONS` keeps every row's `animation`, `durationMs`, `testid` and `target`, and exactly the 30 rows in S4 carry `fx: { recipe }` with that recipe. The other 11 carry none. *Observed:* `animations.fx.test.ts` compares the `type → recipe | null` map with S4's table.
- **B2** `subscribeSignals` gets `start` synchronously as each entry goes in flight, carrying its actual `durationMs` and its planning `view`. It gets `idle` each time the pump fires `onSettled`, `drain` from `drain()` and `reset` from `reset()`. A zero-duration entry emits no `start`. *Observed:* listener spy plus a fake `schedule`.
- **B3** At default settings the runner schedules exactly what it did before this task. *Observed:* `animations.test.ts` passes without modification.
- **B4** R201: at speed s, each non-zero entry becomes `max(MIN_ENTRY_MS, round(d / s))` and the burst budget becomes `BURST_BUDGET_MS / s`. s is clamped to [0.5, 2], and s = 1 changes nothing. *Observed:* the `schedule` spy with a `settings` option returning speeds 2, 0.5 and 5.
- **B5** The setting `motion: "reduce"` makes `enqueue` behave exactly like `prefers-reduced-motion`: no timer, a synchronous drain and one `onSettled`. *Observed:* the fake `schedule` is never called.

Settings (slice B):

- **B6** `loadFxSettings` returns `DEFAULT_FX_SETTINGS` for absent, throwing or unparsable storage and normalizes stored values: speed is clamped, an unknown intensity becomes "normal" and an unknown motion becomes "system". `setFxSettings` writes `jackioh.fx.v1` inside `try/catch` and never throws. *Observed:* `settings.test.ts` with a throwing `Storage` stub and with a real jsdom `localStorage`.
- **B7** `setFxSettings` notifies `subscribeFxSettings` listeners synchronously with the normalized value, and a component using `useFxSettings` re-renders with it. *Observed:* a listener spy and an RTL render.

Planner (slice C):

- **B8** R200: for every recipe sample and every D from `MIN_ENTRY_MS` to 1400 ms, each `planFx` cue has `0 ≤ delayMs ≤ D`, each projectile has `delayMs + flightMs ≤ D`, and each cue with a `durationMs` has `delayMs + durationMs ≤ D + FX_MAX_TAIL_MS`. *Observed:* a property loop in `cues.test.ts`.
- **B9** `planFx` multiplies every burst `count` and every shake `trauma` by `FX_INTENSITY_SCALE[intensity]`, so low < normal < high, and returns `[]` at intensity 0. *Observed:* counts compared across three envs.
- **B10** A non-combat `damage` whose source resolves to a different element than its target plans a `projectile` from source to target, and its spark burst, splat and shake all sit at `delayMs === flightMs`. Combat damage plans no projectile and impacts at 0. *Observed:* `cues.test.ts`.
- **B11** `damage` plans a `damage` splat with the event's amount at the target and a `spark` burst. The shake trauma is 0 below `FX_SHAKE_MIN_DAMAGE`, grows with the amount up to `FX_SHAKE_MAX_TRAUMA`, and is ×`FX_HERO_TRAUMA_MULT` on a hero. *Observed:* amounts 1, 3, 6 and 20 on a unit and on a hero.
- **B12** A `damage` whose source unit in the planning view has Poisonous adds a `poison` burst at the target and flies a `poison` projectile. *Observed:* `fullBoardView()`, whose second unit has every keyword.
- **B13** A non-combat damage source resolves in this order: a rendered instance, then the zone of a trap remembered from an earlier `trapFired`, then the hero of the player remembered from its `cardPlayed`, then nothing (no projectile). *Observed:* four cases with `createFxMemory`.
- **B14** `summoned` into units plans a dust `ring` and a `dust` burst at the zone. A readable Legendary or Mythic def adds `rays` in its tone, a `gold` or `prismatic` burst and `FX_LEGENDARY_TRAUMA`. Attack + health ≥ `FX_SLAM_STATS_MIN` adds slam trauma. A backrow set, or an unknown or `"hidden"` def, plans only the dust burst. *Observed:* `env.card` stubs per rarity.
- **B15** A `cardPlayed` paired with its own `summoned` in the same entry plans nothing itself. An unpaired `cardPlayed` plans an `arcane` burst at the played card for the viewer, or at `hand-opponent`. *Observed:* `cues.test.ts`.
- **B16** Each of `healed`, `healthLost`, `divineShieldLost`, `destroyed`, `exiled`, `burned`, `radiantSet`, `transformed`, `fused`, `trapFired`, `locked`, `attackDeclared`, `attackCancelled`, `keywordGranted` (per keyword), `counterChanged` (per counter), `costChanged`, `modifierChanged` (added and removed), `addedToHand` and `controlChanged` plans exactly the cue kinds, presets, anchors and delays that S7 lists. *Observed:* one `it` per row.
- **B17** `drawn` plans a `ghost` from `library-<side>` to `hand-<side>`. `bounced` plans smoke and a `ghost` from the card to the owner's hand. `discarded` plans a `ghost` from the hand card to `graveyard-<owner side>`. `shuffledIn` plans a `ghost` from the viewport centre to `library-<side>`. *Observed:* `cues.test.ts`.
- **B18** `buffed` plans `arrows` "up" when attack + health > 0, "down" when < 0, and nothing when 0. *Observed:* `cues.test.ts`.
- **B19** `manaChanged` plans one `sparkle` burst per crystal anchor, at indices from the planning view's current mana up to the event's current mana (at most `FX_MANA_MAX_SPARKS`), with delays that increase and stay ≤ D. It plans nothing when mana does not rise. *Observed:* `cues.test.ts`.
- **B20** `turnStarted` plans a `banner` "Your turn" (tone you) plus `rays` when the player is the viewer, and "Opponent's turn" (tone opponent) with no rays otherwise. `turnAutoEnded` plans a muted "No moves left" banner. *Observed:* `cues.test.ts`.
- **B21** R202: the planner reads only its arguments. An event whose ids or defIds are `"hidden"` plans deep-equal cues whatever its other hidden fields are. A `"hidden"` def never gets rarity rays. No cue type carries a defId or a card name. *Observed:* deep equality across varied hidden inputs, plus a check that every cue's keys belong to the S1 types.
- **B22** `planResult` plans the victory, defeat or draw sequence of S7 from `view.result` and `view.viewer`, with every cue ending by `FX_RESULT_MS`. `planHandover` plans the banner only when the active player is the viewer, the phase is not mulligan and there is no result. *Observed:* `cues.test.ts`.

Canvas engine (slice A):

- **B23** The particle system never holds more than its capacity. Emitting 9× capacity of one preset and then 1× capacity of another leaves `alive() === capacity()`, all of the second preset. *Observed:* `particles.test.ts` via `inspect()`.
- **B24** Particles are pooled: 10,000 emit and step cycles leave `stats().allocations === 1`. *Observed:* `particles.test.ts`.
- **B25** Every particle dies within `FX_MAX_PARTICLE_LIFE_MS`: after emitting every preset and stepping 900 ms, `alive() === 0`, and every preset's `life[1]` is ≤ `FX_MAX_PARTICLE_LIFE_MS`. *Observed:* `particles.test.ts`.
- **B26** The same seed, emits and steps give identical `inspect()` output, and a different seed gives different output. *Observed:* `particles.test.ts`.
- **B27** `SpriteCache.get` calls its factory once per (preset, colour, dpr) and returns the cached object afterwards. It returns null when the factory does. No file under `apps/web/src/fx` contains `new Image`, `url(` or an image file extension. *Observed:* `sprites.test.ts` with a counting factory, plus a source scan.
- **B28** `createSurface` sizes the backing store to CSS size × `effectiveDpr`, with `effectiveDpr` clamped to [1, 2], and reallocates only when size or DPR changes. It returns null under jsdom without calling `getContext`. *Observed:* `surface.test.ts` with a stub canvas and a `getContext` spy.
- **B29** The frame loop requests frames only while `onFrame` returns true, passes `dt` clamped to `FX_MAX_DT_MS`, requests nothing while hidden, and calls `onResume` when the page turns visible. *Observed:* `loop.test.ts` with fake frames and visibility.
- **B30** Shake: `add` clamps trauma to 1, and trauma decays linearly at `FX_TRAUMA_DECAY` per second. Each sample has `|x|, |y| ≤ FX_SHAKE_MAX_PX · trauma²` and `|angle| ≤ FX_SHAKE_MAX_DEG · trauma²`. Samples 1 ms apart differ by less than 10% of the maximum, and the output is deterministic per seed. *Observed:* `shake.test.ts`.
- **B31** `canvasFx.projectile` moves from `from` to `to` over `flightMs`, emitting trail particles into the given system. Cracks and rings end after their `durationMs`, and then `alive() === 0`. *Observed:* `canvasFx.test.ts` with a stub 2D context.

Director and layer (slice D):

- **B32** R200: the director fires each cue on the first frame where `now ≥ playTime + delayMs`, resolves anchors at fire time and skips a cue whose anchor is null. After `D + FX_MAX_TAIL_MS` of fake time with frames pumped, it reports `active() === 0` and `particles() === 0`, and the DOM root is empty. *Observed:* `director.test.ts` with fake `now`, frames, `measure` and surface.
- **B33** `clear()` removes every pending cue, DOM effect, particle and projectile at once and calls `shakeSink.clear()`. `play()` while hidden drops its cues, and turning visible again clears everything. *Observed:* `director.test.ts`.
- **B34** The director learns the display's refresh as the shortest raw interval of at least `FX_ADAPT_MIN_INTERVAL_MS` it has seen (the first frame after a wake, timed from the wake, counts for nothing), capped at `FX_ADAPT_DISPLAY_MAX_MS`. A window is slow once its raw frame times add up to more than `FX_ADAPT_WINDOW` frames at `max(FX_ADAPT_SLOW_MS, FX_ADAPT_SLOW_FACTOR × refresh)`, checked every frame so a stall trips it at once; the capacity then halves, never below `FX_PARTICLE_CAP_MIN`. `FX_ADAPT_RECOVER_WINDOWS` healthy windows in a row double a lowered capacity, never above the one it started at. A steady 30 Hz display is not slow. `capacityFor(390) === FX_PARTICLE_CAP_MOBILE` and `capacityFor(1280) === FX_PARTICLE_CAP`. *Observed:* `director.test.ts` with 16, 24, 25, 33.4, 40, 66.8 and 300 ms frames.
- **B35** The shake reaches the board only through the sink. `boardShakeSink` writes CSS `translate`/`rotate` on `[data-testid="board"]` while trauma > 0 and restores the prior inline values when the shake ends. *Observed:* a fake sink in `director.test.ts`; a real board's style in `fx-layer.cy.tsx`.
- **B36** R200: on each `start`, `FxLayer` writes `--anim-squeeze` (durationMs / table duration, 3 decimals) on its parent and removes it on `idle`, `drain` and `reset`. It plans `planFx(entry, entry.view, env)` after `memory.remember(entry.events)`. Mounting it changes no `schedule` call the runner makes. *Observed:* `FxLayer.test.tsx`, with a fake-scheduled queue compared against an identical queue that has no layer.
- **B37** Under reduced motion (the media query or the setting), or with intensity "off", `FxLayer` renders `fx-layer` with `data-fx="off"`, no canvas and no cues. Otherwise it renders `data-fx="on"` with `fx-canvas` and `fx-dom`. Nothing it renders carries a `data-animating` of its own, and rendering `Game` in jsdom logs no `console.error`. *Observed:* `FxLayer.test.tsx`.
- **B38** `FxLayer` plays `planResult` when the shown view's `result` goes from null to set during the mount, but not when it mounts already finished. It plays `planHandover` when `view.viewer` changes. *Observed:* `FxLayer.test.tsx` rerenders with a `measure` seam, counting `[data-fx="result"]` and `[data-fx="banner"]`.

DOM effects and CSS (slice E):

- **B39** `mountDomEffect` appends one `aria-hidden` element with `data-fx="<kind>"`, placed by `--fx-x/--fx-y/--fx-w/--fx-h`, timed by `--fx-ms` and flown by `--fx-dx/--fx-dy`. It contains no text node: numbers and words sit in `data-amount`/`data-text`. A cue that lacks a required box mounts nothing. *Observed:* `dom.test.ts`.
- **B40** `fx.css` makes `.fx-layer` and its descendants `pointer-events: none`, fixed at `inset: 0` with z-index 38. It defines one keyframe per DOM kind, the Divine Shield cocoon selector, the pop-hiding `:has` rule and a reduced-motion block. Every `animation-duration` in `animations.css` multiplies by `var(--anim-squeeze, 1)`, and every existing keyframe name survives. In a real browser, `elementFromPoint` at a damaged card's centre during its effect returns the card, a canvas pixel near the card lights up, and the board still fits the viewport. *Observed:* `css.test.ts` text checks and `fx-layer.cy.tsx`.

Visual pass 1 (added after looking at the running board at 1280×720, 390×844, 844×390 and 768×1024):

- **B41** A burst of a preset that has a `flash` (fire, holy, arcane, spark, gold, prismatic) also
  paints a short radial bloom with a thin horizontal flare at its origin, sized by the anchor box and
  the burst's count and clamped, and gone within `flash.ms` (≤ 300 ms, so inside T). A preset
  without one paints nothing extra. This is what gives a hit its white-hot pop, a trap its violet
  flare and a Legendary its gold flash. *Observed:* `canvasFx.test.ts` and `director.test.ts`.
- **B42** A projectile draws a radial-gradient head and a tapering comet tail through its last head
  positions, emits a dense jittered trail, and on arrival bursts `arrivalCount` particles of its
  preset at the target, so a Fireball explodes where it lands. *Observed:* `canvasFx.test.ts`.
- **B43** A preset with `stretch` draws each moving particle as a streak along its velocity (one
  sprite, under a rotation transform that is reset after the pass); a `twirl` preset (confetti) is
  drawn turned by its own rotation. *Observed:* `particles.test.ts`.
- **B44** A ring is a shock wave, not an outline: three strokes of one ellipse, widest and faintest
  first, in the preset's deep colour then its hot core (a painted ring such as dust keeps only the
  soft outer strokes). Its horizontal radius is clamped to `maxAspect` × its vertical one, so a
  ring about a wide lane zone circles the card in it. *Observed:* `canvasFx.test.ts`.
- **B45** A summon into an empty zone (the board still shows the view from before it) no longer
  scales the zone box: the zone glows (`jk-zone-landing`) and a card-sized silhouette of light drops
  into it on `jk-summon-scale`, delayed while a `cardPlayed` is in flight so it lands on the fx slam.
  A destroyed card holds, cracked, for a beat and then burns away from the bottom up (a mask that
  `jk-dissolve` slides). *Observed:* `css.test.ts`.

Visual pass 2 (stage effects), and the review that followed it:

- **B46** Stand-ins. A unit played from the viewer's hand gets a `hold` from its hand card to its
  zone, landing at `FX_SLAM_AT·D`, and a `conceal` "now" of the hand card; the opponent's unit flies
  from their hand of backs (a back, never a face, R202); a unit from nowhere the viewer can see drops
  in as a card-shaped light; a stolen unit flies from its old place over the mind-control flight and
  its old card is concealed. The stand-in is placed once; it moves only when the board moves under it
  (a shake, a scroll, a resize), by `translate`; a parked stand-in keeps no frame loop running. An
  effect aimed at the carried card lands on the stand-in, and the stand-in plays whatever
  `data-animating` the board puts on the card it carries (a Cry's buff, a transform), except
  `cardPlayed`. With the layer on, the B45 silhouette steps aside. `release()` (the shown view
  changed) removes every stand-in; `FX_HOLD_MAX_MS` caps one, checked on the layer's next frame or
  play. *Observed:* `stage.test.tsx`, `css.test.ts`.
- **B47** Hidden cards. A card the burst has taken away (a spell played from the viewer's hand, a
  destroyed, exiled or bounced board card, a discarded hand card) is concealed "after" at
  `FX_CONCEAL_AT·D`, which bites only once its own `data-animating` has gone, so its keyframes still
  play. A concealed card is transparent and takes no pointer event until `release()`. *Observed:*
  `stage.test.tsx`.
- **B48** Aimed lunges. `attackDeclared` writes `--fx-lunge-x/y` on the attacker, along the line to the
  defending card or hero, `FX_LUNGE_STANDOFF` of the combined half-extents short of its centre,
  clamped to [`FX_LUNGE_MIN_PX`, `FX_LUNGE_MAX_PX`], and throws a spark burst at the target at
  `FX_LUNGE_CONTACT_AT·D`. Without the layer, jk-lunge falls back to BUILD's straight lunge.
  *Observed:* `stage.test.tsx`.
- **B49** The killing blow. A finished view drains the runner, so the layer keeps the drained entries
  and plays `planLethal` before `planResult`, which waits `leadMs`. *Observed:* `cues.test.ts`,
  `FxLayer.test.tsx`.
- **B50** The game-over state stays: `result-overlay` is a fixed panel mid-screen and the
  `turn-banner` hides once it is up. While a layer banner is up the `turn-banner` hides too, and a
  new layer banner replaces one still fading. *Observed:* `css.test.ts`, `director.test.ts`.
- **B51** The reduce setting and intensity "off" draw nothing, the cocoon included, and the reduce
  setting zeroes `--anim-scale` on the game root. *Observed:* `FxLayer.test.tsx`, `css.test.ts`.
- **B52** The shake reads: `FX_SHAKE_MAX_PX` 18 and 0.15 trauma per damage point move the board
  several pixels for a third of a second on a 4 or 5 damage hit, and a full shake is spent inside
  `FX_MAX_TAIL_MS`. *Observed:* `constants.test.ts`, `cues.test.ts`.
- **B53** A hand anchor (`hand-you`, `hand-opponent`) resolves to its cards plus the next card's slot,
  inside the strip; an empty hand is the strip. *Observed:* `anchors.test.ts`.
- **B54** Particles and canvas shapes age by real time; a projectile's trail and arrival burst scale
  with its `density`. *Observed:* `particles.test.ts`, `canvasFx.test.ts`, `director.test.ts`.
- **B55** Every keyframe runs on the compositor (S10). *Observed:* `css.test.ts`.

Other look changes in the same pass, with no new behaviour: the ray fans are soft-edged, uneven
double fans (the victory and turn fans peak at 0.6 opacity so the board reads through them); the
holy light is a feathered shaft with a pool of light where it lands; splats are larger with a darker
rim; the turn banner and result word also cap by viewport height, so they fit a landscape phone;
dust, smoke and embers are larger and denser; cracks are finer and fade as the card burns; soft
sprites are denser; confetti is paper scraps.

## Tests

All vitest suites below run in the **web** project (`apps/web/vitest.config.ts`: jsdom, globals off,
setup `src/test/setup.ts`, include `src/**/*.test.{ts,tsx}`), except the rulings index, which runs in
the **engine** project. There is no engine or card change, so `packages/cards/test/_harness.ts`
`scenario()` is not used.

| Behaviours | New test file | Harness |
|---|---|---|
| B1–B5 | `apps/web/src/game/animations.fx.test.ts` | `fullBoardView()` from `src/test/fixtures.ts`; a local copy of `animations.test.ts`'s `fakeClock()` pattern (it is not exported); `setReducedMotion` from `src/test/setup.ts`; `settings` injected through the queue option. Names one test `it("R201 …")`. |
| B6–B7 | `apps/web/src/fx/settings.test.ts` | jsdom `localStorage` (cleared in `afterEach`), a throwing `Storage` stub, `resetFxSettingsForTests()`, `@testing-library/react` for the hook. |
| B8–B22 | `apps/web/src/fx/cues.test.ts` | `fullBoardView()`, `baseView()`, `withEvents()`, `unit()`, `card()`; entries built with `planEntries(events, view, false)` and then `{ ...entry, durationMs: D }`; `createFxMemory()`; `env.card` stubs. Names tests `it("R200 …")` (B8) and `it("R202 …")` (B21). |
| B23–B26 | `apps/web/src/fx/particles.test.ts` | `createRng(seed)`; no canvas needed. |
| B27 | `apps/web/src/fx/sprites.test.ts` | A counting `SpriteCanvasFactory` returning a stub ctx; `node:fs` scan of `apps/web/src/fx/*.ts` and `*.css`, the way `animations.test.ts` reads `animations.css`. |
| B28 | `apps/web/src/fx/surface.test.ts` | A stub canvas object (rect, width/height, `getContext` spy); a real jsdom `<canvas>` with a spy to prove `getContext` is never called. |
| B29 | `apps/web/src/fx/loop.test.ts` | A local `fakeFrames()` (a queue of callbacks run by hand) and `fakeVisibility()`. |
| B30 | `apps/web/src/fx/shake.test.ts` | Pure. |
| B31 | `apps/web/src/fx/canvasFx.test.ts` | `createParticleSystem` plus a stub `CanvasRenderingContext2D` that records calls. |
| B32–B35 | `apps/web/src/fx/director.test.ts` | Fake `now`/frames/visibility, a `measure` returning fixed boxes, a stub `FxSurface`, a recording `FxShakeSink`, and a jsdom `div` as `domRoot`. Names a test `it("R200 …")` (B32). |
| B36–B38 | `apps/web/src/fx/FxLayer.test.tsx` | `render(<div className="game"><FxLayer queue={q} view={v} seams={…} /></div>)` with `q = createAnimationQueue({ schedule: fake, reducedMotion: false })`; `rerender` for result and viewer changes; `setReducedMotion`; `setFxSettings`; a `console.error` spy around `render(<Game …/>)`. Names a test `it("R200 …")` (B36). |
| B39 | `apps/web/src/fx/dom.test.ts` | A jsdom `div` root; one cue per kind. |
| B40 (text) | `apps/web/src/fx/css.test.ts` | Reads `src/fx/fx.css` and `src/game/animations.css` with `node:fs` (vitest stubs CSS imports). |
| B41 | `apps/web/src/fx/canvasFx.test.ts`, `apps/web/src/fx/director.test.ts` | An argument-recording 2D context; the director harness. |
| B42, B44 | `apps/web/src/fx/canvasFx.test.ts` | `createParticleSystem` and the argument-recording context. |
| B43 | `apps/web/src/fx/particles.test.ts` | The recording context and a stub sprite cache. |
| B45 | `apps/web/src/fx/css.test.ts` | The same sheet parser. |
| B46–B48 | `apps/web/src/fx/stage.test.tsx` | `planStage` over `fullBoardView()`; the director with jsdom elements whose rects are stubbed, a fake frame source and a viewport seam the test fires; `FxLayer` over a fake-scheduled queue. Names tests `it("R200 …")`. |
| B49–B55 | `cues.test.ts`, `FxLayer.test.tsx`, `director.test.ts`, `css.test.ts`, `anchors.test.ts`, `particles.test.ts`, `canvasFx.test.ts`, `constants.test.ts` | As above. Names tests `it("R200 …")`. |
| B35, B40 (browser), B28 (real DPR) | `e2e/cypress/component/fx-layer.cy.tsx` | Cypress component, no server. It mounts `Game` inside `.app-shell.app-shell--wide`, as `board-layout.cy.tsx` does, with `fullBoardView()`, then rerenders with the same view plus appended events (a non-combat `damage` on an enemy unit, a `summoned`, a `turnStarted`). Assertions: the canvas's backing width equals CSS width × `min(devicePixelRatio, 2)`; a non-transparent canvas pixel near the target, retried by `should` with no `cy.wait`; `elementFromPoint` at the card centre is inside the card; `[data-fx="splat"]` exists; `[data-animating]` clears; the `fx-dom` root is empty afterwards; the board's inline `translate` is set during the shake and restored after; `documentElement.scrollWidth ≤ innerWidth` throughout. Run with `E2E_COMPONENT_PORT=5281 pnpm --dir e2e test:component --spec cypress/component/fx-layer.cy.tsx`. |
| R200–R202 index | `packages/engine/test/rulings.test.ts` (existing, edited by slice D) | `provenIn` pointing at the files above. |

Targeted runs: `pnpm vitest run --project web apps/web/src/fx`,
`pnpm vitest run --project web apps/web/src/game`, and
`pnpm vitest run --project engine packages/engine/test/rulings.test.ts`.

Regression gate for this task, beyond the full gate in the brief:
- `pnpm rulings:coverage`.
- The component specs (`board-layout.cy.tsx` and the new `fx-layer.cy.tsx`).
- The hotseat e2e specs that exercise animations: `01-hotseat-full-game`, `03-trap-opponent-turn`, `04-combat`, `07-my-pawn-ai`, `11-radiant` and `12-rotation-and-swaps`. Run them against `pnpm build:e2e` served with `vite preview --port 5171 --strictPort`.
- The networked specs are not affected (FX are client-only), but `05` and `06` render `Game` too. Run them if time allows, with the server on 8781.

## Out of scope

- Sound, voice lines and the audio mute toggle (task 2).
- The card faces: frames, rarity gems, the persistent Radiant golden foil and Mythic foil on the card face, art and hover or inspect (task 6). This task owns only the one-off `radiantSet` sheen and burst.
- The settings panel UI, drag to play, the targeting arrow, green and yellow highlights and the responsive board layout (task 7). This task only exposes `fx/settings.ts`.
- Bespoke per-card Legendary animations. Entrances are per rarity (Legendary and Mythic), not per card.
- Restyling the `draw-toast`, or changing `Board.tsx`, `Zone.tsx`, `Hand.tsx`, `Hero.tsx`, `Card.tsx`, `board.css` or `prompt.css`. FX sit over them and hook only e2e-contract attributes. (Review moved `result-overlay` into a fixed panel and hides the `turn-banner` when it contradicts the layer, both from this task's own sheets, B50.)
- New `GameEvent` types, engine or `viewFor` changes, and any change to BUILD M5-T4's durations or acceptance cells.
- WebGL, `OffscreenCanvas` workers, image or sprite-sheet assets, and new runtime dependencies.
- Following the OS reduced-motion preference live during a mounted game. The runner still captures it at construction, as before. The user's `motion: "reduce"` setting is read live.

## Slices

Each slice exclusively owns the files it lists. No two slices share a file, and no slice owns a test
file. Slices build blind against the Surface.

### Slice A: `canvas-engine`

- **Owns:** `apps/web/src/fx/rng.ts`, `apps/web/src/fx/presets.ts`, `apps/web/src/fx/sprites.ts`, `apps/web/src/fx/particles.ts`, `apps/web/src/fx/canvasFx.ts`, `apps/web/src/fx/surface.ts`, `apps/web/src/fx/loop.ts`, `apps/web/src/fx/shake.ts`
- **Behaviours:** B23–B31
- **Imports from other slices:** `fx/types.ts` and `fx/constants.ts` (slice B)
- **Shared-file edits:** none
- **Brief:** Build the canvas side exactly to S5.
  - A struct-of-arrays pool (`Float32Array` fields sized to capacity, plus a ring cursor that overwrites the oldest slot when full) and no per-particle objects.
  - Radial-gradient sprites drawn once per (preset, colour, dpr), with `lighter` blending for fire, holy, arcane, sparkle, gold, prismatic, spark and confetti, and `source-over` for the rest.
  - No `shadowBlur`, no text drawing and no `Math.random`: every random draw comes from an `FxRng`.
  - Projectiles on a quadratic arc with trails, branching cracks and expanding rings.
  - A DPR-aware surface that returns null under jsdom.
  - A rAF loop that stops when idle and while hidden.
  - Eiserloh trauma² shake over three 1D value-noise channels.

### Slice B: `runner-settings-contract`

- **Owns:** `apps/web/src/fx/types.ts`, `apps/web/src/fx/constants.ts`, `apps/web/src/fx/settings.ts`, `apps/web/src/game/animations.ts`
- **Behaviours:** B1–B7
- **Shared-file edits:** none
- **Brief:** Write `types.ts` and `constants.ts` verbatim from S1 and S2. They are the contract every other slice compiles against.
  - Build `settings.ts` to S3: `useSyncExternalStore`, with `localStorage` only inside `try/catch`.
  - Extend `animations.ts` to S4: the `fx` descriptor on the 30 rows, `entry.view`, `subscribeSignals` with the four signals, the live `settings` read at enqueue, `scaleForSpeed`, the budget divided by speed and `reducedMotionNow`.
  - At default settings nothing observable may change. `animations.test.ts` must stay green untouched.

### Slice C: `cue-planner`

- **Owns:** `apps/web/src/fx/cues.ts`, `apps/web/src/fx/memory.ts`
- **Behaviours:** B8–B22
- **Imports from other slices:** `ANIMATIONS`, `targetFor`, `locateInstance` and `AnimationEntry` from `animations.ts`; `sideOf` and `testid` from `contract.ts`; `hasKeyword` from `@jackioh/shared`; `fx/types.ts` and `fx/constants.ts`
- **Shared-file edits:** none
- **Brief:** Implement S6 and every row of S7 as pure functions over `(entry, view, env)`.
  - One recipe function per `FxRecipe`, dispatched through `ANIMATIONS[event.type].fx?.recipe`, with a `TUNING` table of base burst counts.
  - Every delay and duration is derived from `entry.durationMs` through the S2 constants, so the B8 bounds hold for any D ≥ `MIN_ENTRY_MS`.
  - `"hidden"` ids and defIds are never looked up.

### Slice D: `director-and-layer`

- **Owns:** `apps/web/src/fx/director.ts`, `apps/web/src/fx/anchors.ts`, `apps/web/src/fx/FxLayer.tsx`, `apps/web/src/fx/index.ts`
- **Behaviours:** B32–B38
- **Imports from other slices:** slices A, B and C; `mountDomEffect` from `fx/dom.ts` (slice E); `import "./fx.css"` in `FxLayer.tsx` (the file is slice E's)
- **Shared-file edits** (additive only, as S11 lists them): `apps/web/src/game/Game.tsx` (one import and one mount line), `apps/web/src/game/catalog.ts` (optional `rarity`), `SPEC.md` (§10.10 paragraph and R200–R202), `BUILD.md` (M5-T4 `FX` column and a paragraph), `packages/engine/test/rulings.test.ts` (R200–R202 index rows and four path constants), `apps/web/README.md` (layout lines)
- **Brief:** Build the director to S8 and the layer to S9.
  - One frame loop drives everything: cue firing, particles, canvasFx, the shake sink, DOM effect expiry and adaptive capacity. There is no `setTimeout`.
  - `FxLayer` subscribes to runner signals in a layout effect, keeps `--anim-squeeze` on its parent, clears on `drain`/`reset`, and plays `planResult`/`planHandover` from view changes.
  - Every browser API is guarded for jsdom (no `ResizeObserver`, no 2D context).

### Slice E: `dom-effects-and-css`

- **Owns:** `apps/web/src/fx/dom.ts`, `apps/web/src/fx/fx.css`, `apps/web/src/game/animations.css`
- **Behaviours:** B39–B40
- **Imports from other slices:** `fx/types.ts` (slice B)
- **Shared-file edits:** none
- **Brief:** Build `mountDomEffect` to S10 and the whole look in CSS.
  - The starburst splats, conic light rays, the sheen sweep, card-back ghosts, the chevron arrows, the "Your turn" banner (gold gradient text via `attr(data-text)`), the Victory/Defeat/Draw full-screen treatments and the Divine Shield cocoon.
  - Text only through `content: attr(…)`, and colours from the `index.css` tokens where they exist (`--radiant`, `--plague`, `--legal`, `--opponent`).
  - In `animations.css`, add `* var(--anim-squeeze, 1)` to every duration and enrich the existing keyframes without renaming any.

### Testers (in parallel with the builders)

- **Tester 1 (`unit`):** B1–B31. New files: `apps/web/src/game/animations.fx.test.ts`, `apps/web/src/fx/settings.test.ts`, `apps/web/src/fx/cues.test.ts`, `apps/web/src/fx/particles.test.ts`, `apps/web/src/fx/sprites.test.ts`, `apps/web/src/fx/surface.test.ts`, `apps/web/src/fx/loop.test.ts`, `apps/web/src/fx/shake.test.ts`, `apps/web/src/fx/canvasFx.test.ts`.
- **Tester 2 (`integration`):** B32–B40. New files: `apps/web/src/fx/director.test.ts`, `apps/web/src/fx/FxLayer.test.tsx`, `apps/web/src/fx/dom.test.ts`, `apps/web/src/fx/css.test.ts`, `e2e/cypress/component/fx-layer.cy.tsx`.

## SPEC changes

**§10.10 Client rendering.** Append this paragraph:

> The effects layer (`apps/web/src/fx`) decorates the same stream: a pooled particle system on one
> `<canvas>` overlay and short CSS flourishes anchored to the table's elements. It covers fire and
> embers, holy light, arcane motes, poison, smoke, impact flashes with a trauma-scaled board shake,
> damage and heal splats, spell projectiles, a summon slam with Legendary and Mythic light rays, the
> Divine Shield cocoon, buff arrows, the trap-reveal burst, the turn banner, mana sparkles, card-draw
> flight and the game-over sequence, which opens by replaying the killing blow. Because the board
> shows the view from before a burst until the burst ends, three stage effects act on the board's own
> elements while it plays: a stand-in carries a card the burst moves (a unit played or stolen) to the
> zone the next view shows it in, a card the burst has taken away stays hidden once its own motion
> ends, and an attacker's lunge is aimed at what it attacks. Each BUILD M5-T4 row names its effect in
> the FX column. The layer is presentation only and paces nothing (R200). Its speed setting scales the
> table (R201). It reads the redacted stream and nothing else (R202).

**§11 rows**, inserted in numeric position after the rows other tasks add below R200:

| # | Topic | Recommended ruling | Cards affected |
| --- | --- | --- | --- |
| R200 | The effects layer paces nothing | §10.10's table owns every duration the client waits on, and the effects layer (`apps/web/src/fx`) only decorates it. An effect starts with the table entry that carries its event. Anything it times, such as a projectile's arrival, an impact or a splat, lands inside that entry's duration, and whatever trails after it (particles, splats, rays, cracks, the board shake) is gone within `FX_MAX_TAIL_MS` of the entry's end, counted in real time even when frames stall. The layer's own elements never carry a `data-animating` of their own (a stand-in's copy echoes the one the board puts on the card it carries and drops it in the same task, so `cy.settled()` waits exactly as long), never take a pointer event and never delay the view swap, so a burst settles exactly when it would without effects and no click is blocked by one. The stage effects act on the board's own elements instead, and are bounded by the view swap rather than the tail: a stand-in that carries a moved card to its new zone and a card hidden because the burst has taken it away both last until the board shows the next view, which only the runner decides, and never longer than `FX_HOLD_MAX_MS`. A hidden card takes no pointer event, like any card mid-animation, since the view the board is about to show no longer has it. An aimed lunge ends with its entry and is never shorter than BUILD's lunge distance. Under `prefers-reduced-motion`, or the viewer's reduce setting, no effect is drawn at all (the Divine Shield cocoon included), and the setting stops the table's CSS motion exactly as the media query does. The game-over sequence and the hot-seat hand-over banner run off the shown view rather than an entry. The game-over sequence first replays the killing blow that the finished view's drain cut short, in at most `FX_LETHAL_LEAD_MAX_MS`, then runs within `FX_RESULT_MS`; the banner has its own constant; neither holds anything either | §10.10, BUILD M5-T4, BUILD M8 (`cy.settled()`) |
| R201 | The effects-speed setting scales the animation table | The viewer's effects speed `s` runs from `FX_SPEED_MIN` 0.5 to `FX_SPEED_MAX` 2 and defaults to 1. It divides every non-zero BUILD M5-T4 duration, never below `MIN_ENTRY_MS`, and divides the burst budget the same way. At `s = 1` the durations are exactly BUILD's. The CSS keyframes follow the duration the runner actually gives an entry (`--anim-squeeze`, covering both the speed and the burst budget), so a shortened entry plays its whole motion instead of being cut off. It is a per-viewer presentation setting: nothing in the engine, the view or the event stream changes, and the reduce setting and `prefers-reduced-motion` still collapse every duration to 0 | §10.10, BUILD M5-T4 |
| R202 | Effects draw from the redacted stream only | An effect is chosen from the event, the view the runner planned it against and the public catalog, and from nothing else, so it can never say more than §10.8 lets the viewer read. A card moving out of or into a hidden zone is drawn as a back. An id or `defId` redacted to `"hidden"` gets the same effect whatever card it hides. The rarity entrance plays only for a unit whose `defId` the viewer can read as it is summoned. A face-down trap's reveal is anchored to its zone (R154) and looks the same for every trap until the view names the card | §10.8, §10.10, R97, R154 |

**BUILD M5-T4:**
- An `FX` column on the event table: S4's recipe name and a few words, `—` for none.
- One paragraph under the table pointing here and at R200–R202.
- Durations and acceptance cells are unchanged.

## Risks

- **`Game.tsx` is shared** with tasks 2 (audio hook), 3 (reuse) and 7 (drag layer and gear). This task's edit is one import and one mount line, placed right after `<Board/>`. It never touches the runner construction, and the live settings read happens inside `createAnimationQueue` for that reason.
- **`catalog.ts` `rarity`** may also be added by task 6 for rarity gems. The edit is a two-line optional field. At integration, keep one.
- **The Divine Shield cocoon uses `:has()` and the card root's `::after`.** Browsers without `:has()` (Firefox before 121) simply show no cocoon. Task 6's new card or minion markup must keep the `card-<id>` root containing `[data-keyword]` chips (both e2e contracts) and leave `::after` free on that root. If it needs `::after`, move the cocoon to `::before` at integration.
- **Hiding the classic pops** relies on `:has()` as well. Without it, both the old pop and the new splat show: redundant, not broken. BUILD's `.damage-pop` text assertions are unaffected because `visibility: hidden` elements keep their text.
- **Board shake conflicts with layout transforms.** `boardShakeSink` writes the individual `translate`/`rotate` properties, which compose with `transform` keyframes (`rotated`, `swapped`) instead of fighting them. Task 7 must not position `[data-testid="board"]` itself with `translate` or `rotate`. The sink restores prior inline values, but a stylesheet value would be overridden while shaking.
- **CI cost.** The e2e run draws real particles in headless Chrome and Electron. The cap, the idle-stopping loop and adaptive capacity bound the cost, and no spec waits on FX. If e2e timing still regresses, the fallback is that specs seed `jackioh.fx.v1` with `intensity: "off"`, which needs no product change.
- **Global settings in the runner.** `createAnimationQueue` reads `getFxSettings()` by default, so a test that calls `setFxSettings` must restore it in `afterEach`, or it leaks speed or reduce into other tests in the same file. The `settings` option exists so runner tests inject rather than mutate.
- **jsdom.** `HTMLCanvasElement.getContext` logs "Not implemented" in jsdom. `createSurface` and `domSpriteCanvas` must check `isHeadlessDom()` before calling it. `ResizeObserver`, `element.animate` and `CSS.escape` are also absent there.
- **`rulings:coverage` scans every `.ts`/`.tsx` file for `R<n>`.** Code may cite R200–R202 (and existing rows) only. An identifier like `R2` in FX code would be read as a citation, so avoid `R<digits>` names.
- **Blind parallel build.** Slices compile only against `types.ts` and `constants.ts` as written in S1 and S2. Any drift, such as a renamed field or an optional where the doc says required, is caught at reconcile by `pnpm typecheck`. Slice B writes those two files first and verbatim.
- **Anchors are measured at fire time** from `getBoundingClientRect`. A board scrolled mid-effect leaves particles where the element was (the layer is `position: fixed`). This is harmless within the ≤ 0.9 s tails.
- **Hot-seat never animates `turnStarted`**, because a seat change drains the runner. That is why the hand-over banner is view-driven (S9). Online play and practice games (task 3) see the event-driven banner instead.
