// Every number the effects layer uses (CLAUDE.md rule 9; docs/polish/1-animations.md, Surface S2).
// Particle counts per recipe live in `TUNING` in `cues.ts`, and preset physics in
// `PARTICLE_PRESETS` in `presets.ts`. The values below are binding: other slices compile and test
// against them.

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
export const FX_LUNGE_STANDOFF = 0.55;        // the lunge stops this many combined half-extents short of the target's centre (< 1: they overlap)
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
export const FX_ADAPT_MIN_INTERVAL_MS = 4;    // shorter raw intervals are not a display's refresh (240 Hz is 4.2 ms)
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
