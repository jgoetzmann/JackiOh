// Shared audio types (docs/polish/2-sound.md, Surface). Every audio module and test reads these, so
// they are a cross-slice boundary: do not rename or reshape them.

export type SfxId =
  | "draw" | "play" | "summon" | "attack" | "impact" | "shieldShatter" | "heal" | "buff" | "debuff"
  | "death" | "burn" | "trapSet" | "trapSting" | "spell" | "mana" | "turnStart" | "victory"
  | "defeat" | "uiClick" | "uiHover" | "whoosh" | "radiant" | "lock" | "poof" | "notify" | "drain"
  | "cancel" | "entrance";

/**
 * A card's sound family, from its public tags and type (cues.ts `timbreFor`, which follows the
 * card art's theme order): the summon thud gains the family's accent and the spell shimmer its
 * chimes. Absent: the plain recipe, which is all a card the viewer cannot name ever gets (R203).
 */
export type SfxTimbre = "human" | "felinor" | "ky" | "cn" | "fruit" | "chaos" | "quickdraw" | "token" | "field";

export type SfxParams = {
  /** damage / heal / health-loss amount, or the mana gained; recipes clamp to [1, IMPACT_AMOUNT_CAP]. */
  amount?: number;
  /** true when the event is the viewer's own (turnStart, mana): a brighter variant. */
  mine?: boolean;
  /** summon and spell: the card's family (see SfxTimbre). */
  timbre?: SfxTimbre;
  /** entrance: a Mythic's prismatic sting rather than a Legendary's brass. */
  mythic?: boolean;
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
  /** Keyed by catalog id: exactly the 110 ids of packages/cards/catalog.json. */
  cards: Record<string, VoiceLineEntry>;
};

export type VoiceManifest = {
  version: 1;
  /** Informative: "m4af aac@22050 mono 32000". */
  format: string;
  /** Keyed by VoiceKey. `hash` = voiceHash(...) below; `bytes` = the file's size on disk. */
  files: Record<string, { hash: string; bytes: number }>;
};

/**
 * How much a line matters when another is already speaking (constants.ts VOICE_PRIORITY): a line
 * cuts in on one of lower priority and waits briefly behind one of equal or higher priority.
 */
export type VoicePriority = number;

export type SoundCue =
  | { kind: "sfx"; id: SfxId; params?: SfxParams; delayMs: number }
  | { kind: "voice"; defId: string; line: VoiceLineKind; delayMs: number; priority: VoicePriority };

export type AudioState = "unsupported" | "locked" | "running" | "suspended" | "closed";

/**
 * "pending" until the line starts or is given up on. "dropped": it never started, because a more
 * important line took its place in the queue or the channel, or sound was muted or voice lines
 * turned off first. "suspended": accepted while the context was not running, so nothing was
 * scheduled (a suspended context would otherwise release every queued sound at once on resume).
 */
export type VoiceOutcome = "pending" | "file" | "speech" | "late" | "failed" | "dropped" | "suspended";
export type PlayedCue =
  | {
      kind: "sfx";
      id: SfxId;
      params?: SfxParams;
      delayMs: number;
      atMs: number;
      /** Present when the cue was accepted while the context was not running, so nothing was scheduled. */
      suspended?: true;
    }
  | {
      kind: "voice";
      defId: string;
      line: VoiceLineKind;
      delayMs: number;
      atMs: number;
      outcome: VoiceOutcome;
      priority: VoicePriority;
    };

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
  /** `priority` defaults to VOICE_PRIORITY.play. */
  playVoice(defId: string, line: VoiceLineKind, delayMs?: number, priority?: VoicePriority): boolean;
};

export type AudioEngine = SoundSink & {
  state(): AudioState;
  /** Call synchronously inside a user gesture. Idempotent. */
  unlock(): void;
  /** Held while busy (the newest call only) and skipped while muted or with voice lines off. */
  preloadVoices(keys: readonly VoiceKey[]): void;
  /**
   * true while the board animates (useGameAudio: the runner has an entry in flight). Background
   * voice work (the prefetch and preloads) waits until it is false again; a line asked to play
   * never does (B58).
   */
  setBusy(busy: boolean): void;
  /** Accepted cues, oldest first, at most LOG_LIMIT. */
  log(): readonly PlayedCue[];
  clearLog(): void;
  /** How many AudioContexts this engine has constructed (0 or 1). */
  contextsCreated(): number;
  /**
   * true while a voice line holds the one voice channel: from the moment it takes the channel
   * (loading its file included) until it ends, is cut or is given up on. Practice holds the AI's
   * next step on it through the page's `data-speaking` mark (SPEC §9.9, `useVoiceSpeaking`).
   */
  speaking(): boolean;
  /** Called after every change of `speaking()`, never for a non-change. Returns the unsubscribe. */
  subscribeSpeaking(listener: () => void): () => void;
  dispose(): void;
};
