// Shuffle, the opening draw table, Quickdraw, the mulligan, The Coin and start-of-game effects
// (SPEC §2.1, R9, R43, R244).
//
// The mulligan is concurrent (R265): once the opening deal is done both seats' prompts open at
// once, either seat may answer first, and an answer is sealed — it changes nothing until the other
// seat has answered too (R266). The second answer resolves both, always in seat order (player 1's
// replacement draws and shuffle-back, then player 2's), so the game that follows is the same
// whichever seat answered first, and the same one the sequential mulligan dealt before it.

import type { PlayerId } from "@jackioh/shared";
import { PLAYER_IDS } from "@jackioh/shared";
import { findDef } from "./catalog";
import { COIN_DEF_ID, OPENING_COINS, OPENING_DRAW } from "./config";
import { addToHand, draw } from "./draw";
import type { EngineSink } from "./resolve";
import { flagsOf } from "./scripts";
import { runStartOfGame } from "./prompts";
import {
  findInstance,
  handicapOf,
  newInstance,
  type CardInstance,
  type GameState,
  type MulliganSeat,
  type PendingChoice,
  type WorkItem,
} from "./state";
import { clearReturnFlags, startTurn } from "./turn";
import { owe, paused, registerWorkHandler } from "./work";
import { moveToZone } from "./zones";

function seatOf(player: PlayerId): number {
  return PLAYER_IDS.indexOf(player);
}

/** §2.1: the Nth seat draws N+2, so the table is the source of truth, not two constants. */
export function openingDrawFor(player: PlayerId): number {
  return OPENING_DRAW[seatOf(player)] ?? seatOf(player) + 3;
}

/**
 * §2.1, R182: the seat's opening-draw table entry plus its handicap's extra cards. Quickdraw cards
 * replace draws out of this total, so it is the size of the hand the mulligan sees. Hard carries
 * Medium's one extra card rather than a second one of its own.
 */
export function openingHandSize(state: GameState, player: PlayerId): number {
  return openingDrawFor(player) + handicapOf(state.players[player]).extraOpeningCards;
}

function mulliganPrompt(sink: EngineSink, player: PlayerId): PendingChoice {
  const hand = sink.state.players[player].hand;
  return {
    id: `q${sink.state.nextId}`,
    playerId: player,
    kind: "mulligan",
    prompt: "Choose the cards to keep; the rest are returned and redrawn",
    options: hand.map((card) => ({
      key: card.id,
      label: card.defId,
      selection: { pick: "instance", instanceId: card.id },
    })),
    min: 0,
    max: hand.length,
    resume: { defId: "", hook: "mulligan", step: "mulligan", radiant: false, data: { player } },
  };
}

/**
 * §2.1 step 3, R265: both seats' prompts, opened together in seat order once the opening deal is
 * done. They are not `state.pending`, which stays the one prompt §10.1 allows: every caller opens
 * them only once nothing is waiting (a cast's question during the deal owes them instead,
 * `SETUP_WORK`). Each prompt takes its id in seat order, so the ids are the ones the sequential
 * mulligan handed out.
 */
function openMulligans(sink: EngineSink): void {
  const state = sink.state;
  if (state.pending !== null || state.mulligan !== undefined) return;
  const open: Partial<Record<PlayerId, MulliganSeat>> = {};
  for (const player of PLAYER_IDS) {
    const prompt = mulliganPrompt(sink, player);
    state.nextId += 1;
    open[player] = { prompt, keep: null };
    sink.events.push({ type: "promptOpened", player, choiceId: prompt.id, kind: "mulligan" });
  }
  state.mulligan = open as Record<PlayerId, MulliganSeat>;
  state.phase = "mulligan";
}

/** R265: the seats whose mulligan is open and unanswered, in seat order. */
export function mulliganOwed(state: GameState): PlayerId[] {
  const open = state.mulligan;
  if (open === undefined) return [];
  return PLAYER_IDS.filter((player) => open[player].keep === null);
}

/** R265: this seat's own mulligan prompt while it is open and the seat has not answered it. */
export function mulliganPromptFor(state: GameState, player: PlayerId): PendingChoice | null {
  const seat = state.mulligan?.[player];
  return seat === undefined || seat.keep !== null ? null : seat.prompt;
}

/**
 * R265, R266: why this seat's mulligan answer is refused, or null. The reducer asks this before it
 * answers, and `legalActions` offers the mulligan exactly when there is no reason to refuse it.
 */
export function whyMulliganRefused(state: GameState, player: PlayerId, keep: readonly string[]): string | null {
  if (state.pending !== null || state.mulligan === undefined) return "no mulligan is open";
  const prompt = mulliganPromptFor(state, player);
  if (prompt === null) return "you have already answered your mulligan";
  const offered = new Set(prompt.options.map((option) => option.key));
  for (const id of keep) if (!offered.has(id)) return `${id} is not in your hand`;
  return null;
}

/**
 * R113: the `resume.hook` of what setup still owes when a cast asks during it. §2.1's opening draw
 * and R9's replacement draws are draws, and a cast-on-draw card drawn there is cast (§2.4, R70) — a
 * whole play, which can ask its caster something (R81). The question is state until it is answered
 * (§9.3), and §10.1 allows one prompt at a time, so setup cannot open the mulligans over it, or go
 * on resolving them: it owes the rest of itself — the other seats' opening draws and the mulligans,
 * or the shuffle-back, the seats still to resolve and the game — and the answer's drain brings it
 * back (R122). Registered at module scope below.
 */
export const SETUP_WORK = "@setup";

/**
 * Which part of setup is owed: the opening deal from a seat on, a seat's Quickdraw cards and then
 * the seats after it, or the end of one seat's mulligan and the seats after it (R265).
 */
const DEAL_STEP = "deal";
const QUICKDRAW_STEP = "quickdraw";
const MULLIGAN_STEP = "mulligan";
/** §2.1 step 4: the start-of-game clauses from a card on, then turn 1. */
const START_OF_GAME_STEP = "startOfGame";

/**
 * Shuffle both libraries with the match rng, move Quickdraw cards into the opening hand and draw
 * the rest of the opening hand, then open both mulligans (§2.1, R265).
 */
export function beginSetup(sink: EngineSink): void {
  dealFrom(sink, 0);
}

function isQuickdraw(card: CardInstance): boolean {
  return flagsOf(card).quickdraw === true;
}

/**
 * §2.1 steps 1 and 2 for each seat from `seat` on, then both mulligans (R265).
 *
 * R225: each Quickdraw card "replaces one of these draws" (§2.1, §6.2) — the last ones. The seat
 * draws its other opening cards first, off the top of a library whose Quickdraw cards wait at the
 * bottom (the order among the rest is the shuffle's), and then each Quickdraw card goes to the hand
 * as the draw it replaces: counted by R55's draw counter and reported as a draw. So the opponent can
 * tell from none of it — #100's price, the deal's events, the hand and library counts while a cast
 * the opening draw made is asking (R224) — whether the opening hand holds one (§9.1).
 */
function dealFrom(sink: EngineSink, seat: number): void {
  const state = sink.state;

  for (let at = seat; at < PLAYER_IDS.length; at += 1) {
    const player = PLAYER_IDS[at] as PlayerId;
    const side = state.players[player];
    const shuffled = sink.rng.shuffle(side.library);
    const quickdraw = shuffled.filter(isQuickdraw);
    side.library = [...shuffled.filter((card) => !isQuickdraw(card)), ...quickdraw];

    // R182: a handicapped seat's extra opening cards are part of the same total Quickdraw replaces.
    draw(sink, player, Math.max(0, openingHandSize(state, player) - quickdraw.length));
    // A cast the opening draw made is asking (R158: the draw has owed its own remainder), so this
    // seat's Quickdraw cards, the seats after it and the mulligan wait behind it.
    if (paused(sink)) {
      if (state.result === null) oweSetup(sink, { step: QUICKDRAW_STEP, seat: at });
      return;
    }
    dealQuickdraw(sink, player);
  }

  openMulligans(sink);
}

/** R225: the seat's Quickdraw cards, each as the opening draw it replaces, in the library's order. */
function dealQuickdraw(sink: EngineSink, player: PlayerId): void {
  const state = sink.state;
  for (const card of state.players[player].library.filter(isQuickdraw)) {
    moveToZone(state, card, "hand");
    state.counters.drawn += 1;
    sink.events.push({ type: "drawn", player, instanceId: card.id, defId: card.defId });
    sink.events.push({ type: "addedToHand", player, instanceId: card.id, defId: card.defId });
  }
}

/**
 * R265, R266: a seat's answer is sealed — recorded, announced as answered, and read by nothing —
 * until the other seat has answered as well. The second answer resolves both.
 */
export function answerMulligan(sink: EngineSink, player: PlayerId, keep: readonly string[]): void {
  const state = sink.state;
  const seat = state.mulligan?.[player];
  if (seat === undefined || seat.keep !== null) return;
  seat.keep = [...new Set(keep)];
  // §10.6: the answer names the prompt it answers, as every other does. That a seat has answered is
  // public — the other seat is told it is ready — and what it kept is not (R266, §9.1).
  sink.events.push({ type: "promptAnswered", player, choiceId: seat.prompt.id });
  if (mulliganOwed(state).length > 0) return;
  resolveMulligans(sink);
}

/**
 * R267: what a sealed answer returns, read against the hand as it stands when that seat's turn to
 * resolve comes: the cards the prompt offered and the answer did not keep that are still there. A
 * card the other seat's resolution put in this hand was never offered, so it stays.
 */
type SealedMulligan = { player: PlayerId; offered: string[]; keep: string[] };

/** R265: both answers are in. The sealed record goes, and the seats resolve in seat order. */
function resolveMulligans(sink: EngineSink): void {
  const open = sink.state.mulligan;
  if (open === undefined) return;
  const sealed: SealedMulligan[] = PLAYER_IDS.map((player) => {
    const offered = open[player].prompt.options.map((option) => option.key);
    return { player, offered, keep: open[player].keep ?? offered };
  });
  delete sink.state.mulligan;
  resolveFrom(sink, sealed);
}

/**
 * R9: the replacements are drawn first, then the returned cards are shuffled back, which is what
 * "without replacement" means. One seat at a time, in seat order (R265), then the game.
 */
function resolveFrom(sink: EngineSink, sealed: readonly SealedMulligan[]): void {
  const [next, ...rest] = sealed;
  if (next === undefined) {
    finishSetup(sink);
    return;
  }
  const state = sink.state;
  const side = state.players[next.player];
  const offered = new Set(next.offered);
  const kept = new Set(next.keep);
  const returned = side.hand.filter((card) => offered.has(card.id) && !kept.has(card.id));

  for (const card of returned) {
    const at = side.hand.findIndex((c) => c.id === card.id);
    if (at >= 0) side.hand.splice(at, 1);
  }

  draw(sink, next.player, returned.length);
  // A replacement's cast is asking (§2.4, R70, R224): the shuffle-back, the seats after this one and
  // the game wait for the answer, and the returned cards wait with them, in the owed item — they are
  // in no pile until they go back.
  if (paused(sink)) {
    if (state.result === null) {
      oweSetup(sink, {
        step: MULLIGAN_STEP,
        player: next.player,
        returned: JSON.parse(JSON.stringify(returned)) as CardInstance[],
        rest: rest.map((seat) => ({ ...seat, offered: [...seat.offered], keep: [...seat.keep] })),
      });
    }
    return;
  }

  finishMulligan(sink, next.player, returned, rest);
}

/** R9's second half — the returned cards shuffled back — then the next seat's mulligan, or the game. */
function finishMulligan(
  sink: EngineSink,
  player: PlayerId,
  returned: readonly CardInstance[],
  rest: readonly SealedMulligan[],
): void {
  const state = sink.state;
  const side = state.players[player];

  for (const card of returned) {
    const position = sink.rng.int(side.library.length + 1);
    moveToZone(state, card, "library", { position });
    sink.events.push({
      type: "shuffledIn",
      player,
      instanceId: card.id,
      defId: card.defId,
      position,
    });
  }

  if (!state.mulliganed.includes(player)) state.mulliganed.push(player);
  resolveFrom(sink, rest);
}

type OwedSetup =
  | { step: typeof DEAL_STEP; seat: number }
  | { step: typeof QUICKDRAW_STEP; seat: number }
  | { step: typeof MULLIGAN_STEP; player: PlayerId; returned: CardInstance[]; rest: SealedMulligan[] }
  | { step: typeof START_OF_GAME_STEP; ids: string[] };

/**
 * R224, §9.1: the cards a mulligan returned that wait, in the owed item, for their shuffle-back while
 * a replacement draw's cast is asking. They are in no pile, so `findInstance` does not see them, and
 * §10.8 reads them as the library cards they are about to be: nobody reads them (§3), their owner
 * included, exactly as once they are back (`viewFor`).
 */
export function returnedAwaitingShuffle(state: GameState): string[] {
  return state.work.flatMap((item) => {
    if (item.resume.hook !== SETUP_WORK || item.resume.step !== MULLIGAN_STEP) return [];
    const owed: unknown = item.resume.data.owed;
    if (owed === null || typeof owed !== "object") return [];
    const returned = (owed as { returned?: unknown }).returned;
    if (!Array.isArray(returned)) return [];
    return returned.flatMap((card: unknown) => {
      const id = card !== null && typeof card === "object" ? (card as { id?: unknown }).id : undefined;
      return typeof id === "string" ? [id] : [];
    });
  });
}

function oweSetup(sink: EngineSink, owed: OwedSetup): void {
  owe(sink, { defId: "", hook: SETUP_WORK, step: owed.step, radiant: false, data: { owed } });
}

/** `work.ts`'s handler: setup, continued where a cast's question stopped it (R113, R122). */
function runOwedSetup(sink: EngineSink, item: WorkItem): void {
  const raw: unknown = item.resume.data.owed;
  if (raw === null || typeof raw !== "object") return;
  const owed = raw as Partial<{
    step: string;
    seat: number;
    player: PlayerId;
    returned: CardInstance[];
    rest: unknown[];
    ids: unknown[];
  }>;
  if (owed.step === DEAL_STEP && typeof owed.seat === "number") {
    dealFrom(sink, owed.seat);
    return;
  }
  if (owed.step === QUICKDRAW_STEP && typeof owed.seat === "number") {
    const player = PLAYER_IDS[owed.seat];
    if (player !== undefined) dealQuickdraw(sink, player);
    dealFrom(sink, owed.seat + 1);
    return;
  }
  if (owed.step === MULLIGAN_STEP && (owed.player === "p1" || owed.player === "p2")) {
    finishMulligan(sink, owed.player, Array.isArray(owed.returned) ? owed.returned : [], sealedIn(owed.rest));
    return;
  }
  if (owed.step === START_OF_GAME_STEP) {
    const ids = Array.isArray(owed.ids) ? owed.ids.filter((id): id is string => typeof id === "string") : [];
    startOfGameFrom(sink, ids);
  }
}

/** The seats still to resolve, read back out of an owed item's JSON (R113). */
function sealedIn(raw: unknown): SealedMulligan[] {
  if (!Array.isArray(raw)) return [];
  const ids = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
  return raw.flatMap((entry: unknown) => {
    if (entry === null || typeof entry !== "object") return [];
    const seat = entry as { player?: unknown; offered?: unknown; keep?: unknown };
    if (seat.player !== "p1" && seat.player !== "p2") return [];
    return [{ player: seat.player, offered: ids(seat.offered), keep: ids(seat.keep) }];
  });
}

registerWorkHandler(SETUP_WORK, runOwedSetup);

/**
 * §2.1 step 3's close, R244: once both mulligans are answered, each seat is dealt its
 * `OPENING_COINS` copies of The Coin — the seat going second one, the first none — as the last cards
 * of its hand. After the mulligan, so a Coin is never returned, redrawn or shuffled in (R9); and
 * whatever the seat's handicap, whose extra opening card the mulligan has already seen (R182).
 *
 * It is §6.3's add to hand, not a draw: `draw.addToHand` puts it in, or burns it into the graveyard
 * off a full hand (§2.4, R4, which no Core opening hand reaches), and it emits `addedToHand` alone,
 * leaving #100's draw counter where it was (R55). It takes the next instance id and no rng draw, so
 * `(seed, decks, handicaps, log)` still folds exactly (§9.3, R187).
 *
 * A registered catalog without The Coin deals none. The shipped catalog always holds it (the cards
 * package's catalog tests and `validate-catalog.ts` count it); the engine's own tests register
 * partial fixture catalogs, and a rule that threw on them would make every one of those catalogs
 * carry a card none of their tests is about.
 */
export function dealCoins(sink: EngineSink): void {
  if (sink.state.result !== null) return;
  if (findDef(sink.state, COIN_DEF_ID) === undefined) return;
  PLAYER_IDS.forEach((player, seat) => {
    const count = OPENING_COINS[seat] ?? 0;
    for (let dealt = 0; dealt < count; dealt += 1) {
      addToHand(sink, newInstance(sink.state, COIN_DEF_ID, player, { z: "hand", player }));
    }
  });
}

/** R244's Coin, the start-of-game effects, then player 1 takes the first turn and draws (§2.1, R10). */
export function finishSetup(sink: EngineSink): void {
  dealCoins(sink);
  const cards = PLAYER_IDS.flatMap((player) => {
    const side = sink.state.players[player];
    return [...side.hand, ...side.library].map((card) => card.id);
  });
  startOfGameFrom(sink, cards);
}

/**
 * §2.1 step 4 over the cards from `ids` on, then turn 1. A clause that asks pauses it (§9.3,
 * `prompts.runStartOfGame`): the clauses after it and the first turn are owed behind its tail
 * (`START_OF_GAME_STEP`, R113, R117), so turn 1 never begins with a question of setup's still open.
 *
 * Setup is turn 0 (BUILD M1-T1), which is no player's turn (§2.1 step 5): a Spell cast during it
 * — by the opening deal or a mulligan's replacement draw (§2.4, R70) — was played on no turn of its
 * controller's, so the return §10.5 step 7 flagged it for is over before turn 1, as a turn's cleanup
 * ends it (R155).
 * `startTurn` empties the turn logs that cleanup reads, so setup clears it first.
 */
function startOfGameFrom(sink: EngineSink, ids: readonly string[]): void {
  for (let at = 0; at < ids.length; at += 1) {
    const card = findInstance(sink.state, ids[at] ?? "");
    if (card === undefined) continue;
    const zone = card.zone;
    const player = zone.z === "hand" || zone.z === "library" ? zone.player : card.owner;
    runStartOfGame(sink, card, player);
    if (paused(sink)) {
      if (sink.state.result === null) oweSetup(sink, { step: START_OF_GAME_STEP, ids: ids.slice(at + 1) });
      return;
    }
  }
  clearReturnFlags(sink.state);
  startTurn(sink, PLAYER_IDS[0] as PlayerId);
}

/** A fresh instance of `defId` in a player's hand, for setup-time card creation. */
export function createInHand(sink: EngineSink, player: PlayerId, defId: string): CardInstance {
  const card = newInstance(sink.state, defId, player, { z: "hand", player });
  sink.state.players[player].hand.push(card);
  return card;
}
