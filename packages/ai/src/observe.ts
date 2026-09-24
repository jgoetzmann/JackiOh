// What the AI's seat may know (R185, SPEC §9.9). This is the only module that reads a true
// `GameState`: `decide` calls `aiToAct` and `redact` on it and nothing else, and every later step
// works on the redacted copy or on a determinization of it (`determinize.ts`).
//
// `redact` follows docs/polish/3-ai.md's seven steps in order. What it keeps is kept on purpose:
// board cards (buried Stack cards included), damage and buffs, exertion, summoning turns, positions,
// graveyards, exiles, `resolving`, turn logs, modifiers, delayed effects, counters, hero health and
// armor, mana, draw offers and handicaps are public history the seat watched happen. Instance ids of
// hidden cards are kept too: they give away a deck-list position, which the AI cannot map to an
// identity.

import type { PlayerId } from "@jackioh/shared";
import { PLAYER_IDS, opponentOf } from "@jackioh/shared";
import { cloneState, findDef, handicapOf, subsystems, type CardInstance, type GameState } from "@jackioh/engine";

export const HIDDEN_DEF_ID = "ai:hidden";

/** Every card instance the state holds in a pile, a lane or a Stack, in a fixed order. */
function everyInstance(state: GameState): CardInstance[] {
  const out: CardInstance[] = [];
  for (const player of PLAYER_IDS) {
    const side = state.players[player];
    out.push(...side.hand, ...side.library, ...side.graveyard, ...side.exile, ...side.resolving);
    for (const pile of side.units) if (pile !== null) out.push(...pile);
    for (const card of side.backrow) if (card !== null) out.push(card);
  }
  return out;
}

/** `c17` → 17; anything that is not a minted instance id sorts after every one that is. */
function instanceNumber(id: string): number {
  const match = /^c(\d+)$/.exec(id);
  return match === null ? Number.POSITIVE_INFINITY : Number.parseInt(match[1] ?? "", 10);
}

function byInstanceId(a: CardInstance, b: CardInstance): number {
  const na = instanceNumber(a.id);
  const nb = instanceNumber(b.id);
  if (na !== nb) return na < nb ? -1 : 1;
  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

/**
 * §10.8 and R33, as `viewFor` reads them: a backrow Trap or Field Trap is readable by its current
 * controller only until it flips face-up; a Field Spell is public. A placeholder is never readable.
 */
function backrowHiddenFrom(state: GameState, card: CardInstance, seat: PlayerId): boolean {
  if (card.controller === seat || card.faceUp === true) return false;
  const def = findDef(state, card.defId);
  if (def === undefined) return true;
  return def.type === "Trap" || def.type === "Field Trap";
}

/**
 * The instance ids `redact` hides from `seat` (step 2): the opponent's hand and library, every
 * backrow card the seat cannot read, and the cards in the seat's own library that were minted for
 * the opponent's opening deck (#87 Pocket Chaos's library swap, R73). A card the seat's own open
 * prompt offers as an option is shown to the seat by `viewFor` (§10.8), so it is not hidden.
 */
export function hiddenInstanceIds(state: GameState, seat: PlayerId): Set<string> {
  const opp = opponentOf(seat);
  const hidden = new Set<string>();

  for (const card of state.players[opp].hand) hidden.add(card.id);
  for (const card of state.players[opp].library) hidden.add(card.id);

  for (const player of PLAYER_IDS) {
    for (const card of state.players[player].backrow) {
      if (card !== null && backrowHiddenFrom(state, card, seat)) hidden.add(card.id);
    }
  }

  // createGame mints c1..c{n1} for p1's deck and c{n1+1}..c{n1+n2} for p2's (R184's deck sizes).
  const n1 = handicapOf(state.players.p1).deckSize;
  const n2 = handicapOf(state.players.p2).deckSize;
  const low = opp === "p1" ? 1 : n1 + 1;
  const high = opp === "p1" ? n1 : n1 + n2;
  for (const card of state.players[seat].library) {
    const n = instanceNumber(card.id);
    if (n >= low && n <= high) hidden.add(card.id);
  }

  const pending = state.pending;
  if (pending !== null && pending.playerId === seat) {
    for (const option of pending.options) {
      if (option.selection.pick === "instance") hidden.delete(option.selection.instanceId);
    }
  }

  return hidden;
}

/** Step 3: the card keeps its id, owner, controller, zone and backrow lane, and nothing else. */
function toPlaceholder(card: CardInstance): void {
  card.defId = HIDDEN_DEF_ID;
  card.radiant = false;
  card.costMod = 0;
  card.memory = {};
  card.counters = {};
  card.grantedKeywords = [];
  card.buffs = { attack: 0, health: 0 };
  card.damage = 0;
  delete card.costOverride;
  delete card.x;
  delete card.embiggened;
  delete card.returnToHandAtEndOfTurn;
}

type Loose = Record<string, unknown>;

function isHiddenId(value: unknown, hidden: ReadonlySet<string>): boolean {
  return typeof value === "string" && hidden.has(value);
}

/** Step 5: every `defId` that sits next to a hidden instance id becomes the placeholder id. */
function scrubEvent<T>(event: T, hidden: ReadonlySet<string>): T {
  if (event === null || typeof event !== "object") return event;
  const copy: Loose = { ...(event as Loose) };
  if (isHiddenId(copy.instanceId, hidden)) {
    if ("defId" in copy) copy.defId = HIDDEN_DEF_ID;
    if ("fromDefId" in copy) copy.fromDefId = HIDDEN_DEF_ID;
  }
  if (isHiddenId(copy.newInstanceId, hidden) && "toDefId" in copy) copy.toDefId = HIDDEN_DEF_ID;
  if (isHiddenId(copy.resultInstanceId, hidden) && "defId" in copy) copy.defId = HIDDEN_DEF_ID;
  return copy as T;
}

/** Whether a queue entry belongs to a hidden card, by its `instanceId` or its `resume.instanceId`. */
function belongsToHidden(entry: unknown, hidden: ReadonlySet<string>): boolean {
  const loose = entry as { instanceId?: unknown; resume?: { instanceId?: unknown } };
  return isHiddenId(loose.instanceId, hidden) || isHiddenId(loose.resume?.instanceId, hidden);
}

/**
 * A kept entry's captured event (a trigger's `resume.data.event`) is scrubbed like a dispatch event,
 * so a face-up card's trigger cannot carry a hidden card's identity through the queue.
 */
function scrubResume<T>(entry: T, hidden: ReadonlySet<string>): T {
  const loose = entry as { resume?: { data?: Loose } };
  const data = loose.resume?.data;
  if (data === undefined || data === null || typeof data.event !== "object" || data.event === null) return entry;
  return {
    ...(entry as Loose),
    resume: { ...(loose.resume as Loose), data: { ...data, event: scrubEvent(data.event, hidden) } },
  } as T;
}

/** R185: the state as `seat` may know it. Pure; the input is not mutated. */
export function redact(state: GameState, seat: PlayerId): GameState {
  const opp = opponentOf(seat);
  // Step 2 reads the true state: which cards are hidden is itself decided by public facts.
  const hidden = hiddenInstanceIds(state, seat);
  const next = cloneState(state);

  // Step 1: the seed, the cursor and the nonce log (which carries unredacted events).
  next.seed = "redacted";
  next.rngCursor = 0;
  next.applied = [];

  // Step 3: every hidden card becomes a placeholder.
  for (const card of everyInstance(next)) {
    if (hidden.has(card.id)) toPlaceholder(card);
  }

  // Step 4: erase the true order of the piles the seat cannot see into.
  next.players[opp].hand.sort(byInstanceId);
  next.players[opp].library.sort(byInstanceId);
  next.players[seat].library.sort(byInstanceId);

  // Step 5: queue entries of hidden cards go; events naming one lose the definition.
  next.triggerQueue = next.triggerQueue
    .filter((entry) => !belongsToHidden(entry, hidden))
    .map((entry) => scrubResume(entry, hidden));

  let cursor = next.workCursor;
  const keptWork: typeof next.work = [];
  next.work.forEach((item, index) => {
    if (belongsToHidden(item, hidden)) {
      if (index < next.workCursor) cursor -= 1;
      return;
    }
    keptWork.push(scrubResume(item, hidden));
  });
  next.work = keptWork;
  next.workCursor = Math.max(0, Math.min(cursor, keptWork.length));

  next.echoQueue = next.echoQueue.filter((entry) => !belongsToHidden(entry, hidden));
  next.delayed = next.delayed
    .filter((entry) => !belongsToHidden(entry, hidden))
    .map((entry) => scrubResume(entry, hidden));
  next.dispatch = next.dispatch.map((entry) => ({ ...entry, event: scrubEvent(entry.event, hidden) }));
  if (next.pending !== null) next.pending = scrubResume(next.pending, hidden);

  // Step 6: a transient definition only a hidden card uses would name that card.
  const referenced = new Set<string>();
  for (const card of everyInstance(next)) {
    if (!hidden.has(card.id)) referenced.add(card.defId);
  }
  // A kept fusion of a fusion names its older ingredient in its id (R179), so that ingredient's
  // definition stays too: the id already says what it is, and its faces are public, summed into
  // the kept def's own.
  const transient: Record<string, (typeof next.transientDefs)[string]> = {};
  const keep = [...referenced].filter((defId) => next.transientDefs[defId] !== undefined);
  while (keep.length > 0) {
    const defId = keep.pop() as string;
    const def = next.transientDefs[defId];
    if (def === undefined || transient[defId] !== undefined) continue;
    transient[defId] = def;
    for (const id of subsystems.fusedIngredients(defId) ?? []) {
      if (next.transientDefs[id] !== undefined) keep.push(id);
    }
  }
  next.transientDefs = Object.fromEntries(
    Object.keys(next.transientDefs)
      .filter((defId) => transient[defId] !== undefined)
      .map((defId) => [defId, transient[defId] as (typeof next.transientDefs)[string]]),
  );

  // Step 7: the opponent's prompt shows that it is open and whose it is, nothing more (R81).
  if (next.pending !== null && next.pending.playerId === opp) {
    next.pending = { ...next.pending, options: [] };
  }

  return next;
}

/** R188: the opponent offered a draw this turn and nobody has answered it yet. */
export function unansweredDrawOffer(state: GameState, seat: PlayerId): boolean {
  const off = opponentOf(seat);
  const side = state.players[off];
  const offer = side.drawOffer;
  return (
    state.active === off &&
    state.phase === "main" &&
    state.pending === null &&
    offer.offeredTurn === state.turn &&
    (offer.blockedUntil ?? 0) <= side.turnsStarted
  );
}

/** Whether `seat` owes an action: its prompt, its main phase, or an unanswered draw offer. */
export function aiToAct(state: GameState, seat: PlayerId): boolean {
  if (state.result !== null) return false;
  if (state.pending !== null && state.pending.playerId === seat) return true;
  if (state.pending === null && state.active === seat && state.phase === "main") return true;
  return unansweredDrawOffer(state, seat);
}
