// The sound table (SPEC §10.11): one row per member of `GameEventType`, like `ANIMATIONS` in
// `game/animations.ts`. A row names its headline sound effect, or states why the event is silent,
// and resolves an event into the cues to play. `SOUND_CUES` is typed as a total map, so a new event
// type does not compile until it has a row here.
//
// No rule lives here (CLAUDE.md rule 7). The table reads the event and the viewer's `PlayerView`
// and nothing else, so it can say no more than the screen does (R203): a card whose `defId` is the
// sentinel never speaks, and a trap set speaks on no seat. R204 fixes which moments speak: a unit
// on its `cardPlayed` (or, when an effect put it there without a play, its `summoned`) and its
// `destroyed`, a spell on its `cardPlayed`, a trap on its `trapFired`. Each line carries its
// VOICE_PRIORITY: a death or a firing trap answers something that just happened and takes the
// channel from a play or cast line, and a summoned unit speaks only when nothing else is talking.

import type { GameEvent, GameEventType, PlayerId, PlayerView, UnitView } from "@jackioh/shared";

import { DEATH_VOICE_DELAY_MS, VOICE_DELAY_MS, VOICE_PRIORITY } from "./constants.ts";
import type { SfxId, SfxParams, SoundCue, VoiceLineKind, VoiceLineTable, VoicePriority } from "./types.ts";
import { entryFor } from "./voiceData.ts";

export type CueContext = {
  /** The view the batch was planned against (pre-batch): `viewer` and seat orientation come from here. */
  view: PlayerView;
  lines: VoiceLineTable;
  /** Current mana this player had before this event, as the director tracks it. */
  manaBefore: (player: PlayerId) => number;
  /**
   * True when this instance's own `cardPlayed` has already sounded, so its `summoned` is that play
   * arriving and its line has been spoken. Absent: no play has sounded.
   */
  wasPlayed?: (instanceId: string) => boolean;
  /** The unit as the newest view shows it (its size and Radiance), or null. Absent: unknown. */
  unitNow?: (instanceId: string) => UnitView | null;
};

export type CueRow<K extends GameEventType> = {
  /** The row's headline SFX, or null for an explicit silence. */
  sfx: SfxId | null;
  /** Required and non-empty exactly when sfx is null. */
  silentBecause?: string;
  cues: (event: Extract<GameEvent, { type: K }>, ctx: CueContext) => readonly SoundCue[];
};

/** A spell's shimmer lands just after the card whoosh, under its cast line (the cast beat). */
const SPELL_SHIMMER_DELAY_MS = 60;
/** A Radiant unit's golden glint lands on top of its summon thud. */
const RADIANT_GLINT_DELAY_MS = 90;

const NONE: readonly SoundCue[] = [];

function sfx(id: SfxId, params?: SfxParams, delayMs = 0): SoundCue {
  return params === undefined ? { kind: "sfx", id, delayMs } : { kind: "sfx", id, params, delayMs };
}

function voice(defId: string, line: VoiceLineKind, delayMs: number, priority: VoicePriority): SoundCue {
  return { kind: "voice", defId, line, delayMs, priority };
}

/**
 * A unit arriving: a thud sized by the unit (attack plus health, so a 1/1 Sheep taps the table and a
 * 7/7 shakes it), a golden glint when it is Radiant, and, when no play of it has sounded (a token, a
 * Recruit, a Reborn, a copy), its play line at the lowest priority.
 */
function summonCues(event: Extract<GameEvent, { type: "summoned" }>, ctx: CueContext): readonly SoundCue[] {
  const unit = ctx.unitNow?.(event.instanceId) ?? null;
  const cues: SoundCue[] = [sfx("summon", unit === null ? undefined : { amount: unit.attack + unit.health })];
  if (unit?.radiant === true) cues.push(sfx("radiant", undefined, RADIANT_GLINT_DELAY_MS));
  const played = ctx.wasPlayed?.(event.instanceId) ?? false;
  if (!played && entryFor(ctx.lines, event.defId)?.kind === "unit") {
    cues.push(voice(event.defId, "play", VOICE_DELAY_MS, VOICE_PRIORITY.summon));
  }
  return cues;
}

function silent(because: string): { sfx: null; silentBecause: string; cues: () => readonly SoundCue[] } {
  return { sfx: null, silentBecause: because, cues: () => NONE };
}

export const SOUND_CUES: { readonly [K in GameEventType]: CueRow<K> } = {
  // R204: a unit's play line and a spell's cast line ride its `cardPlayed`, casts included. R203:
  // the viewer's own trap set makes the set sound and says nothing; a hidden card is a plain whoosh.
  cardPlayed: {
    sfx: "play",
    cues: (event, ctx) => {
      const kind = entryFor(ctx.lines, event.defId)?.kind;
      if (kind === "unit") return [sfx("play"), voice(event.defId, "play", VOICE_DELAY_MS, VOICE_PRIORITY.play)];
      if (kind === "spell") {
        return [
          sfx("play"),
          sfx("spell", undefined, SPELL_SHIMMER_DELAY_MS),
          voice(event.defId, "cast", VOICE_DELAY_MS, VOICE_PRIORITY.play),
        ];
      }
      if (kind === "trap") return [sfx("trapSet")];
      return [sfx("play")];
    },
  },
  cardResolved: silent("the effects a card resolves into carry their own events"),
  // R204: a unit an effect puts onto the field without playing it speaks its play line here.
  summoned: { sfx: "summon", cues: summonCues },
  damage: {
    sfx: "impact",
    cues: (event) => (event.amount > 0 ? [sfx("impact", { amount: event.amount })] : NONE),
  },
  healthLost: {
    sfx: "drain",
    cues: (event) => (event.amount > 0 ? [sfx("drain", { amount: event.amount })] : NONE),
  },
  healed: {
    sfx: "heal",
    cues: (event) => (event.amount > 0 ? [sfx("heal", { amount: event.amount })] : NONE),
  },
  divineShieldLost: { sfx: "shieldShatter", cues: () => [sfx("shieldShatter")] },
  // R204: a death line on `destroyed` (R89 carries the defId), tokens included; never on a bounce,
  // an exile or a transform, whose rows below have no voice. It takes the channel from a play line.
  destroyed: {
    sfx: "death",
    cues: (event, ctx) =>
      entryFor(ctx.lines, event.defId)?.kind === "unit"
        ? [sfx("death"), voice(event.defId, "death", DEATH_VOICE_DELAY_MS, VOICE_PRIORITY.react)]
        : [sfx("death")],
  },
  enteredGraveyard: silent("the destroy, discard or resolve that sent it there already sounded"),
  exiled: { sfx: "poof", cues: () => [sfx("poof")] },
  bounced: { sfx: "whoosh", cues: () => [sfx("whoosh")] },
  burned: { sfx: "burn", cues: () => [sfx("burn")] },
  discarded: { sfx: "draw", cues: () => [sfx("draw")] },
  drawn: { sfx: "draw", cues: () => [sfx("draw")] },
  addedToHand: { sfx: "draw", cues: () => [sfx("draw")] },
  shuffledIn: { sfx: "whoosh", cues: () => [sfx("whoosh")] },
  buffed: {
    sfx: "buff",
    cues: (event) => (event.attack + event.health >= 0 ? [sfx("buff")] : [sfx("debuff")]),
  },
  keywordGranted: { sfx: "buff", cues: () => [sfx("buff")] },
  counterChanged: { sfx: "uiClick", cues: () => [sfx("uiClick")] },
  costChanged: silent("the gem ticks visually, and a cost recomputed on every read (#100) would chatter"),
  modifierChanged: {
    sfx: "notify",
    cues: (event) => (event.added ? [sfx("notify")] : NONE),
  },
  radiantSet: { sfx: "radiant", cues: () => [sfx("radiant")] },
  transformed: { sfx: "poof", cues: () => [sfx("poof")] },
  fused: { sfx: "poof", cues: () => [sfx("poof")] },
  positionSwitched: { sfx: "whoosh", cues: () => [sfx("whoosh")] },
  controlChanged: { sfx: "whoosh", cues: () => [sfx("whoosh")] },
  rotated: { sfx: "whoosh", cues: () => [sfx("whoosh")] },
  swapped: { sfx: "whoosh", cues: () => [sfx("whoosh")] },
  locked: { sfx: "lock", cues: () => [sfx("lock")] },
  // R203 + R154: only the controller's seat reads the trap, so only it hears the cast line. R17's
  // play-reactive traps fire on the very play they answer, so the line cuts in on that play's line.
  trapFired: {
    sfx: "trapSting",
    cues: (event, ctx) =>
      entryFor(ctx.lines, event.defId) === null
        ? [sfx("trapSting")]
        : [sfx("trapSting"), voice(event.defId, "cast", VOICE_DELAY_MS, VOICE_PRIORITY.react)],
  },
  attackDeclared: { sfx: "attack", cues: () => [sfx("attack")] },
  attackCancelled: { sfx: "cancel", cues: () => [sfx("cancel")] },
  manaChanged: {
    sfx: "mana",
    cues: (event, ctx) => {
      const before = ctx.manaBefore(event.player);
      if (event.current <= before) return NONE;
      return [sfx("mana", { mine: event.player === ctx.view.viewer, amount: event.current - before })];
    },
  },
  turnStarted: {
    sfx: "turnStart",
    cues: (event, ctx) => [sfx("turnStart", { mine: event.player === ctx.view.viewer })],
  },
  turnEnded: silent("the end-turn click has its UI tick and the next turnStarted announces the change"),
  turnAutoEnded: { sfx: "notify", cues: () => [sfx("notify")] },
  promptOpened: {
    sfx: "notify",
    cues: (event, ctx) => (event.player === ctx.view.viewer ? [sfx("notify")] : NONE),
  },
  promptAnswered: silent("the answering click already ticked"),
  drawOffered: {
    sfx: "notify",
    cues: (event, ctx) => (event.player !== ctx.view.viewer ? [sfx("notify")] : NONE),
  },
  drawAnswered: { sfx: "notify", cues: () => [sfx("notify")] },
  gameOver: {
    sfx: "victory",
    cues: (event, ctx) => {
      if (event.winner === "draw") return [sfx("notify")];
      return event.winner === ctx.view.viewer ? [sfx("victory")] : [sfx("defeat")];
    },
  },
};

/** The cues for one event. */
export function cuesFor(event: GameEvent, ctx: CueContext): readonly SoundCue[] {
  const row = SOUND_CUES[event.type] as { cues: (e: GameEvent, c: CueContext) => readonly SoundCue[] };
  return row.cues(event, ctx);
}
