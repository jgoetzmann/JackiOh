// Every audio number another module or a test reads (CLAUDE.md rule 9, applied to the client the way
// `animations.ts` names its durations). The frequencies and envelope times inside one SFX recipe are
// that recipe's data and stay local to `sfx.ts`, the way keyframes are `animations.css`'s data.

export const AUDIO_SETTINGS_KEY = "jackioh.audio.v1";
export const LOG_LIMIT = 100;
export const SFX_MAX_VOICES = 12;        // concurrent sfx cues still sounding
export const SFX_RETRIGGER_MS = 40;      // same SfxId again within this window is refused
export const VOICE_LATE_MS = 600;        // a line not ready this long after it takes the channel is dropped
/**
 * A line's claim on the one voice channel. A higher number cuts in on a lower one; an equal or
 * lower one waits in the queue. A death line and a firing trap's line ("react") answer something
 * that just happened and would be meaningless a second later, so they take the channel from a play
 * or cast line; a unit an effect summons ("summon") speaks only if nothing else is talking.
 */
export const VOICE_PRIORITY = { summon: 0, play: 1, react: 2 } as const;
export const VOICE_QUEUE_MAX = 2;        // lines waiting behind the one speaking
export const VOICE_QUEUE_WAIT_MS = 1500; // a waiting line older than this when the channel frees is dropped
export const VOICE_FADE_S = 0.04;        // how fast a line that is cut in on fades out
/** A rendered line's audible span: samples at or under this magnitude at either end are silence. */
export const VOICE_TRIM_THRESHOLD = 0.005;
export const VOICE_TRIM_LEAD_S = 0.02;   // kept before the first audible sample
export const VOICE_TRIM_TAIL_S = 0.08;   // kept after the last audible sample, for the decay
/** The voice volume slider's sample line: #8 Mr. Vanilla, "Hello. I am very normal." */
export const VOICE_PREVIEW_DEF_ID = "core-008";
export const VOICE_DECODED_MAX = 32;     // decoded lines kept in memory, least recently used evicted
export const VOICE_PREFETCH_DELAY_MS = 2000; // after the first running preload, fetch every line's bytes
export const VOICE_PREFETCH_CONCURRENCY = 2;
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
/** R97's sentinel as a redacted event carries it (packages/engine/src/viewFor.ts HIDDEN_ID). */
export const HIDDEN_DEF_ID = "hidden";
/** Rules vocabulary a line may not use (whole word, case-insensitive): lines are flavour, not text. */
export const BANNED_RULES_WORDS: readonly string[] = [
  "Taunt", "Divine Shield", "Reborn", "Lifesteal", "Poisonous", "First Strike", "Trample", "Cleave",
  "Immutable", "Indestructible", "Stack", "Echo", "Combo", "Discover", "Recruit", "Tribute",
  "Embiggen", "Radiant", "Armor", "Rush", "Charge", "Cry", "Deathrattle", "Battlecry", "mana",
  "damage", "summon", "exile", "fatigue", "backrow", "graveyard",
];
