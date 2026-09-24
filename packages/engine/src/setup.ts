// Shuffle, the opening draw table, Quickdraw, the mulligan and start-of-game effects
// (SPEC §2.1, R9, R43).

import type { PlayerId } from "@jackioh/shared";
import { PLAYER_IDS } from "@jackioh/shared";
import { OPENING_DRAW } from "./config";
import { draw } from "./draw";
import type { EngineSink } from "./resolve";
import { flagsOf } from "./scripts";
import { closePrompt, runStartOfGame } from "./prompts";
import { findInstance, newInstance, type CardInstance, type GameState, type PendingChoice, type WorkItem } from "./state";
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
 * §2.1 step 3's prompt. §10.1 allows one prompt at a time, and every caller opens it only once
 * nothing is waiting (a cast's question during setup owes the mulligan instead, `SETUP_WORK`).
 */
function openMulligan(sink: EngineSink, player: PlayerId): void {
  if (sink.state.pending !== null) return;
  const prompt = mulliganPrompt(sink, player);
  sink.state.nextId += 1;
  sink.state.pending = prompt;
  sink.state.phase = "mulligan";
  sink.events.push({ type: "promptOpened", player, choiceId: prompt.id, kind: "mulligan" });
}

/**
 * R113: the `resume.hook` of what setup still owes when a cast asks during it. §2.1's opening draw
 * and R9's replacement draws are draws, and a cast-on-draw card drawn there is cast (§2.4, R70) — a
 * whole play, which can ask its caster something (R81). The question is state until it is answered
 * (§9.3), and §10.1 allows one prompt at a time, so setup cannot open the next mulligan over it: it
 * owes the rest of itself — the other seats' opening draws, or the shuffle-back and the next
 * mulligan — and the answer's drain brings it back (R122). Registered at module scope below.
 */
export const SETUP_WORK = "@setup";

/**
 * Which part of setup is owed: the opening deal from a seat on, a seat's Quickdraw cards and then
 * the seats after it, or the end of one mulligan.
 */
const DEAL_STEP = "deal";
const QUICKDRAW_STEP = "quickdraw";
const MULLIGAN_STEP = "mulligan";
/** §2.1 step 4: the start-of-game clauses from a card on, then turn 1. */
const START_OF_GAME_STEP = "startOfGame";

/**
 * Shuffle both libraries with the match rng, move Quickdraw cards into the opening hand and draw
 * the rest of the opening hand, then open the first mulligan prompt (§2.1).
 */
export function beginSetup(sink: EngineSink): void {
  dealFrom(sink, 0);
}

function isQuickdraw(card: CardInstance): boolean {
  return flagsOf(card).quickdraw === true;
}

/**
 * §2.1 steps 1 and 2 for each seat from `seat` on, then the first mulligan.
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

    draw(sink, player, Math.max(0, openingDrawFor(player) - quickdraw.length));
    // A cast the opening draw made is asking (R158: the draw has owed its own remainder), so this
    // seat's Quickdraw cards, the seats after it and the mulligan wait behind it.
    if (paused(sink)) {
      if (state.result === null) oweSetup(sink, { step: QUICKDRAW_STEP, seat: at });
      return;
    }
    dealQuickdraw(sink, player);
  }

  openMulligan(sink, PLAYER_IDS[0] as PlayerId);
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
 * R9: the replacements are drawn first, then the returned cards are shuffled back, which is what
 * "without replacement" means. Moves on to the other player's mulligan, then starts the game.
 */
export function answerMulligan(sink: EngineSink, player: PlayerId, keep: readonly string[]): void {
  const state = sink.state;
  const side = state.players[player];
  const kept = new Set(keep);
  const returned = side.hand.filter((card) => !kept.has(card.id));

  for (const card of returned) {
    const at = side.hand.findIndex((c) => c.id === card.id);
    if (at >= 0) side.hand.splice(at, 1);
  }

  // The prompt is answered the moment its selection is read, and is closed here rather than after
  // the draw: §2.4's draw can fire a Cast on draw, which is a whole play and can ask something of
  // its own, and a sequence deciding whether to pause must not see the question it is answering
  // still standing. R9's order is untouched — the replacements are still drawn before the returned
  // cards are shuffled back. §10.6: the answer names the prompt it answers, as every other does.
  closePrompt(sink);

  draw(sink, player, returned.length);
  // A replacement's cast is asking: the shuffle-back and the next mulligan wait for the answer, and
  // the returned cards wait with them, in the owed item — they are in no pile until they go back.
  if (paused(sink)) {
    if (state.result === null) {
      oweSetup(sink, { step: MULLIGAN_STEP, player, returned: JSON.parse(JSON.stringify(returned)) as CardInstance[] });
    }
    return;
  }

  finishMulligan(sink, player, returned);
}

/** R9's second half — the returned cards shuffled back — then the next mulligan, or the game. */
function finishMulligan(sink: EngineSink, player: PlayerId, returned: readonly CardInstance[]): void {
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

  const next = PLAYER_IDS.find((p) => p !== player && !state.mulliganed.includes(p));
  if (next !== undefined) {
    openMulligan(sink, next);
    return;
  }

  finishSetup(sink);
}

type OwedSetup =
  | { step: typeof DEAL_STEP; seat: number }
  | { step: typeof QUICKDRAW_STEP; seat: number }
  | { step: typeof MULLIGAN_STEP; player: PlayerId; returned: CardInstance[] }
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
  const owed = raw as Partial<{ step: string; seat: number; player: PlayerId; returned: CardInstance[]; ids: unknown[] }>;
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
    finishMulligan(sink, owed.player, Array.isArray(owed.returned) ? owed.returned : []);
    return;
  }
  if (owed.step === START_OF_GAME_STEP) {
    const ids = Array.isArray(owed.ids) ? owed.ids.filter((id): id is string => typeof id === "string") : [];
    startOfGameFrom(sink, ids);
  }
}

registerWorkHandler(SETUP_WORK, runOwedSetup);

/** Start-of-game effects, then player 1 takes the first turn and draws (§2.1, R10). */
export function finishSetup(sink: EngineSink): void {
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
 * Setup is turn 0, which is no player's turn (§2.1): a Spell cast during it — by the opening deal
 * or a mulligan's replacement draw (§2.4, R70) — was played on no turn of its controller's, so the
 * return §10.5 step 7 flagged it for is over before turn 1, as a turn's cleanup ends it (R155).
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
