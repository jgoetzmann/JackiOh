// What the showcase holds up, decided from the redacted event stream alone (CLAUDE.md rule 7,
// R97, R202). Pure: it reads its arguments and returns data, so every rule about what may be shown
// is tested here without a DOM.
//
// The trigger is the opponent's `cardPlayed`: Hearthstone shows the card the other player has just
// played, big, for a moment, so it can be read before the game moves on. The viewer's own plays
// are never shown (they chose them), and neither is anything the view does not name: a `cardPlayed`
// the view redacts — a Trap or Field Trap set face down (R227), or any card that has since gone
// somewhere this viewer may not read — carries the sentinel for its definition and becomes a card
// back with a caption, never a face.
//
// Which events are new. `view.events` is §10.8's sliding window, and R97 re-judges its redaction on
// every view by where each card sits NOW: the opponent's `drawn` reads as the sentinel while the card
// is in their hand and names the card once it has been played. So two windows that share their
// events do not share their JSON, and a plain comparison finds no overlap and calls the whole window
// new, which would hold up every card the opponent played in the last thirty-odd events again. The
// overlap here is found with `sameOccurrence`, which lets a redacted field match a revealed one.

import type { GameEvent, PlayerId, PlayerView } from "@jackioh/shared";

import { sideOf } from "../contract.ts";
import { HIDDEN_CARD, cardInView } from "../faces.ts";

/** One card the showcase holds up. `defId` is null exactly when the view hides the card. */
export type ShowcasePlay = {
  player: PlayerId;
  /** The card's definition, or null for a card the view redacts: it is drawn as a back. */
  defId: string | null;
  /** The face that was played, as far as the view says (its resolution, else where it stands now). */
  radiant: boolean;
  /** A hidden play that put a card face down into a backrow: "set a card" rather than "played a card". */
  set: boolean;
};

/** The fields a redacted event keeps as they are (R97): who, and where. Everything else may be the sentinel's. */
const SEAT_FIELDS = ["player", "owner", "controller", "row", "lane", "turn"] as const;

function mentionsSentinel(event: GameEvent): boolean {
  for (const value of Object.values(event)) {
    if (value === HIDDEN_CARD) return true;
    if (Array.isArray(value) && value.includes(HIDDEN_CARD)) return true;
  }
  return false;
}

function seatKey(event: GameEvent): string {
  const record = event as Record<string, unknown>;
  return JSON.stringify([event.type, ...SEAT_FIELDS.map((field) => record[field] ?? null)]);
}

/**
 * Whether two events are the same occurrence as seen in two views. Identical events are. So are two
 * of the same type about the same seats when either one carries the sentinel: R97 redacts an
 * event's card fields (and the numbers that would name the card, R177) and leaves its seats alone,
 * and a later view may read a card an earlier one could not.
 */
export function sameOccurrence(a: GameEvent | undefined, b: GameEvent | undefined): boolean {
  if (a === undefined || b === undefined || a.type !== b.type) return false;
  if (JSON.stringify(a) === JSON.stringify(b)) return true;
  return (mentionsSentinel(a) || mentionsSentinel(b)) && seatKey(a) === seatKey(b);
}

/**
 * The events of `next` that `prev` did not have: everything after the longest suffix of `prev`
 * that is a prefix of `next`. Two windows with nothing in common (a view that is more than a window
 * of events behind) make all of `next` new, which is the honest answer.
 */
export function eventsSince(prev: readonly GameEvent[], next: readonly GameEvent[]): GameEvent[] {
  if (prev.length === 0 || next.length === 0) return [...next];
  for (let overlap = Math.min(prev.length, next.length); overlap > 0; overlap -= 1) {
    const from = prev.length - overlap;
    let matches = true;
    for (let i = 0; i < overlap && matches; i += 1) matches = sameOccurrence(prev[from + i], next[i]);
    if (matches) return next.slice(overlap);
  }
  return [...next];
}

type Played = Extract<GameEvent, { type: "cardPlayed" }>;

/** The face the card resolved with (`cardResolved.radiant`), else the one the view shows it with now. */
function radiantOf(play: Played, fresh: readonly GameEvent[], view: PlayerView): boolean {
  const resolved = fresh.find(
    (event): event is Extract<GameEvent, { type: "cardResolved" }> =>
      event.type === "cardResolved" && event.instanceId === play.instanceId,
  );
  if (resolved?.radiant !== undefined) return resolved.radiant;
  return cardInView(view, play.instanceId)?.radiant ?? false;
}

/** A hidden play whose own `summoned` put it into a backrow: the view says a card was set there, no more. */
function wasSet(play: Played, at: number, fresh: readonly GameEvent[]): boolean {
  for (let i = at + 1; i < fresh.length; i += 1) {
    const event = fresh[i];
    if (event === undefined) continue;
    if (event.type === "cardPlayed") return false;
    if (event.type === "summoned" && event.player === play.player && event.instanceId === HIDDEN_CARD) {
      return event.row === "backrow";
    }
  }
  return false;
}

/** The opponent's plays among `fresh`, in order, each as the view lets the viewer see it. */
export function opponentPlays(fresh: readonly GameEvent[], view: PlayerView): ShowcasePlay[] {
  const plays: ShowcasePlay[] = [];
  fresh.forEach((event, at) => {
    if (event.type !== "cardPlayed" || sideOf(view, event.player) !== "opponent") return;
    const hidden = event.defId === HIDDEN_CARD || event.instanceId === HIDDEN_CARD;
    plays.push(
      hidden
        ? { player: event.player, defId: null, radiant: false, set: wasSet(event, at, fresh) }
        : { player: event.player, defId: event.defId, radiant: radiantOf(event, fresh, view), set: false },
    );
  });
  return plays;
}

/**
 * Keeps the queue to the newest `max` plays. A hotseat hand-over can bring a whole turn's plays at
 * once; the ones that fall off are in the log.
 */
export function capQueue<T>(queue: readonly T[], max: number): T[] {
  return queue.length <= max ? [...queue] : queue.slice(queue.length - max);
}
