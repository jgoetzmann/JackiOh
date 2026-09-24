// The sound director (SPEC §10.11 "Timing"): turns the view stream into cues, in step with the
// animation runner.
//
// A view arrives with §10.8's sliding window of events. The director remembers the events it has
// not voiced yet (`owed`), each with the view it was planned against, and sends an event's cues
// only when the runner STARTS the entry that animates it, so sound and motion land together.
// Whatever the runner never starts — every entry under reduced motion, `gameOver`'s zero-length
// entry, a queue drained at a game's end or a skip — is flushed once, condensed, when the runner
// goes idle.
//
// R203: the first view, and a view for a different seat (a hotseat hand-over), voices nothing and
// drops everything owed, so the arriving seat hears nothing its own view did not produce.
//
// WHICH EVENTS ARE NEW. Two windows overlap where the tail of the older one is the head of the newer
// one, but not always byte for byte: R97 judges a card by where it sits NOW, so when the opponent
// plays a card it drew earlier in the window, that older `drawn` (or `shuffledIn`, …) changes from
// the sentinel to the card's real id between the two views. `sameOccurrence` lets a redacted field
// match the value it later reveals (and the reverse), so only the new action's events are owed. The
// runner may still be handed the whole window again (task 1's `newEventsSince` compares exactly),
// and every event of a view the director has already seen and not owed stays silent when the runner
// starts it (`known`): old news does not speak twice.
//
// Events are matched by object identity: `newEventsSince` and `planEntries` both hand out the very
// objects in `view.events`, so the entry the runner starts carries the same objects the director
// owes.

import type { GameEvent, PlayerId, PlayerView, UnitView } from "@jackioh/shared";

import type { AnimationEntry } from "../game/animations.ts";
import { FLUSH_GAP_MS, FLUSH_MAX_SFX, HIDDEN_DEF_ID, PAIR_OFFSET_MS } from "./constants.ts";
import { cuesFor, type CueCard, type CueContext } from "./cues.ts";
import type { SoundCue, SoundSink, VoiceLineTable } from "./types.ts";
import { VOICE_LINES } from "./voiceData.ts";

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

type Owed = { event: GameEvent; view: PlayerView };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Two events are the same occurrence when every field is, except that R97's sentinel in either
 * one matches whatever the other names there: a card a later view may read, or no longer read.
 */
export function sameOccurrence(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "string" && typeof b === "string") return a === HIDDEN_DEF_ID || b === HIDDEN_DEF_ID;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => sameOccurrence(item, b[i]));
  }
  if (isRecord(a) && isRecord(b)) {
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every((key) => Object.hasOwn(b, key) && sameOccurrence(a[key], b[key]));
  }
  return false;
}

/**
 * The events in `next` that `prev` did not carry: everything after the longest tail of `prev` that
 * is also a head of `next`, comparing with `sameOccurrence`. No overlap at all means all of `next`.
 */
export function eventsAfterOverlap(prev: readonly GameEvent[], next: readonly GameEvent[]): GameEvent[] {
  if (prev.length === 0 || next.length === 0) return [...next];
  for (let overlap = Math.min(prev.length, next.length); overlap > 0; overlap -= 1) {
    const from = prev.length - overlap;
    let matches = true;
    for (let i = 0; i < overlap && matches; i += 1) matches = sameOccurrence(prev[from + i], next[i]);
    if (matches) return next.slice(overlap);
  }
  return [...next];
}

function findUnit(view: PlayerView | null, instanceId: string): UnitView | null {
  if (view === null) return null;
  for (const side of [view.you, view.opponent]) {
    for (const u of side.units) if (u !== null && u.instanceId === instanceId) return u;
  }
  return null;
}

function sideMana(view: PlayerView, player: PlayerId): number {
  if (view.you.player === player) return view.you.mana.current;
  if (view.opponent.player === player) return view.opponent.mana.current;
  return 0;
}

/**
 * `card` is the public catalog (`useGameAudio` reads the board's `CatalogContext`), asked only for
 * a defId the viewer can read; without it every card makes its type's plain sounds.
 */
export function createSoundDirector(
  sink: SoundSink,
  lines: VoiceLineTable = VOICE_LINES,
  card?: (defId: string) => CueCard | undefined,
): SoundDirector {
  let seen: PlayerView | null = null;
  let owed: Owed[] = [];
  const voiced = new WeakSet<GameEvent>();
  /** Every event object of every view fed in: one the director did not owe is old news. */
  const known = new WeakSet<GameEvent>();
  const lastMana = new Map<PlayerId, number>();
  /** Instances whose `cardPlayed` has sounded, so their `summoned` does not speak again (R204). */
  const played = new Set<string>();

  function ctx(view: PlayerView): CueContext {
    return {
      view,
      lines,
      manaBefore: (player) => lastMana.get(player) ?? sideMana(view, player),
      wasPlayed: (instanceId) => played.has(instanceId),
      unitNow: (instanceId) => findUnit(seen, instanceId) ?? findUnit(view, instanceId),
      ...(card === undefined ? {} : { card }),
    };
  }

  /** The event's cues against `view`, then the mana baseline and the played set move on (B22). */
  function resolve(event: GameEvent, view: PlayerView): readonly SoundCue[] {
    const cues = cuesFor(event, ctx(view));
    if (event.type === "manaChanged") lastMana.set(event.player, event.current);
    if (event.type === "cardPlayed" && event.instanceId !== HIDDEN_DEF_ID) played.add(event.instanceId);
    return cues;
  }

  function send(cue: SoundCue, delayMs: number): void {
    if (cue.kind === "sfx") sink.playSfx(cue.id, cue.params, delayMs);
    else sink.playVoice(cue.defId, cue.line, delayMs, cue.priority);
  }

  function isOwed(event: GameEvent): boolean {
    return owed.some((item) => item.event === event);
  }

  function flush(items: readonly Owed[]): void {
    const effects: SoundCue[] = [];
    let endCue: SoundCue | null = null;
    let line: SoundCue | null = null;

    for (const item of items) {
      voiced.add(item.event);
      for (const cue of resolve(item.event, item.view)) {
        if (cue.kind === "voice") {
          // The most important line of the burst, the first of those on a tie.
          if (line === null || (line.kind === "voice" && cue.priority > line.priority)) line = cue;
        } else if (item.event.type === "gameOver") {
          if (endCue === null) endCue = cue;
        } else {
          effects.push(cue);
        }
      }
    }

    // First cue of each SfxId, in stream order. The game-over stinger is held back for the end, so
    // a same-id cue earlier in the burst gives way to it.
    const ids = new Set<string>();
    if (endCue !== null && endCue.kind === "sfx") ids.add(endCue.id);
    const unique: SoundCue[] = [];
    for (const cue of effects) {
      if (cue.kind !== "sfx" || ids.has(cue.id)) continue;
      ids.add(cue.id);
      unique.push(cue);
    }
    const kept = unique.slice(0, endCue === null ? FLUSH_MAX_SFX : FLUSH_MAX_SFX - 1);
    if (endCue !== null) kept.push(endCue);
    kept.forEach((cue, j) => {
      send(cue, j * FLUSH_GAP_MS);
    });

    // One voice at a time: the burst's most important line, at its own delay.
    if (line !== null) send(line, line.delayMs);
  }

  return {
    onView(view) {
      if (view === seen) return;
      if (seen === null || seen.viewer !== view.viewer) {
        owed = [];
        lastMana.clear();
        played.clear();
        for (const event of view.events) known.add(event);
        seen = view;
        return;
      }
      const planned = seen;
      for (const event of eventsAfterOverlap(planned.events, view.events)) {
        if (voiced.has(event) || isOwed(event)) continue;
        owed.push({ event, view: planned });
      }
      for (const event of view.events) known.add(event);
      seen = view;
    },

    onEntryStart(entry) {
      const first = entry.events[0];
      if (first === undefined) return;
      const at = owed.findIndex((item) => item.event === first);
      if (at > 0) flush(owed.splice(0, at));

      entry.events.forEach((event, k) => {
        const index = owed.findIndex((item) => item.event === event);
        const item = index >= 0 ? owed[index] : undefined;
        if (index >= 0) owed.splice(index, 1);
        if (voiced.has(event)) return;
        // A view's event the director did not owe is old news the runner is replaying: silent.
        if (item === undefined && known.has(event)) return;
        voiced.add(event);
        const view = item?.view ?? seen;
        if (view === null) return;
        const offset = k > 0 ? PAIR_OFFSET_MS : 0;
        for (const cue of resolve(event, view)) send(cue, cue.delayMs + offset);
      });
    },

    onIdle() {
      if (owed.length === 0) return;
      flush(owed.splice(0, owed.length));
    },

    owedCount() {
      return owed.length;
    },
  };
}
