// Shuffle, the opening draw table, Quickdraw, the mulligan and start-of-game effects
// (SPEC §2.1, R9, R43).

import type { PlayerId } from "@jackioh/shared";
import { PLAYER_IDS } from "@jackioh/shared";
import { OPENING_DRAW } from "./config";
import { draw } from "./draw";
import { runHook, type EngineSink } from "./resolve";
import { flagsOf } from "./scripts";
import { closePrompt } from "./prompts";
import { newInstance, type CardInstance, type PendingChoice, type WorkItem } from "./state";
import { startTurn } from "./turn";
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

/** Which part of setup is owed: the opening deal from a seat on, or the end of one mulligan. */
const DEAL_STEP = "deal";
const MULLIGAN_STEP = "mulligan";

/**
 * Shuffle both libraries with the match rng, move Quickdraw cards into the opening hand and draw
 * the rest of the opening hand, then open the first mulligan prompt (§2.1).
 */
export function beginSetup(sink: EngineSink): void {
  dealFrom(sink, 0);
}

/** §2.1 steps 1 and 2 for each seat from `seat` on, then the first mulligan. */
function dealFrom(sink: EngineSink, seat: number): void {
  const state = sink.state;

  for (let at = seat; at < PLAYER_IDS.length; at += 1) {
    const player = PLAYER_IDS[at] as PlayerId;
    const side = state.players[player];
    side.library = sink.rng.shuffle(side.library);

    // Quickdraw cards start in hand and each replaces one of the opening draws (§6.2).
    const quickdraw = side.library.filter((card) => flagsOf(card).quickdraw === true);
    for (const card of quickdraw) {
      moveToZone(state, card, "hand");
      sink.events.push({
        type: "addedToHand",
        player,
        instanceId: card.id,
        defId: card.defId,
      });
    }

    const remaining = Math.max(0, openingDrawFor(player) - quickdraw.length);
    draw(sink, player, remaining);
    // A cast the opening draw made is asking (R158: the draw has owed its own remainder), so the
    // seats after this one and the mulligan wait behind it.
    if (paused(sink)) {
      if (state.result === null) oweSetup(sink, { step: DEAL_STEP, seat: at + 1 });
      return;
    }
  }

  openMulligan(sink, PLAYER_IDS[0] as PlayerId);
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
  | { step: typeof MULLIGAN_STEP; player: PlayerId; returned: CardInstance[] };

function oweSetup(sink: EngineSink, owed: OwedSetup): void {
  owe(sink, { defId: "", hook: SETUP_WORK, step: owed.step, radiant: false, data: { owed } });
}

/** `work.ts`'s handler: setup, continued where a cast's question stopped it (R113, R122). */
function runOwedSetup(sink: EngineSink, item: WorkItem): void {
  const raw: unknown = item.resume.data.owed;
  if (raw === null || typeof raw !== "object") return;
  const owed = raw as Partial<{ step: string; seat: number; player: PlayerId; returned: CardInstance[] }>;
  if (owed.step === DEAL_STEP && typeof owed.seat === "number") {
    dealFrom(sink, owed.seat);
    return;
  }
  if (owed.step === MULLIGAN_STEP && (owed.player === "p1" || owed.player === "p2")) {
    finishMulligan(sink, owed.player, Array.isArray(owed.returned) ? owed.returned : []);
  }
}

registerWorkHandler(SETUP_WORK, runOwedSetup);

/** Start-of-game effects, then player 1 takes the first turn and draws (§2.1, R10). */
export function finishSetup(sink: EngineSink): void {
  for (const player of PLAYER_IDS) {
    const side = sink.state.players[player];
    for (const card of [...side.hand, ...side.library]) {
      runHook(sink, card, "startOfGame", { controller: player });
    }
  }
  startTurn(sink, PLAYER_IDS[0] as PlayerId);
}

/** A fresh instance of `defId` in a player's hand, for setup-time card creation. */
export function createInHand(sink: EngineSink, player: PlayerId, defId: string): CardInstance {
  const card = newInstance(sink.state, defId, player, { z: "hand", player });
  sink.state.players[player].hand.push(card);
  return card;
}
