// Shuffle, the opening draw table, Quickdraw, the mulligan and start-of-game effects
// (SPEC §2.1, R9, R43).

import type { PlayerId } from "@jackioh/shared";
import { PLAYER_IDS } from "@jackioh/shared";
import { OPENING_DRAW } from "./config";
import { draw } from "./draw";
import { runHook, type EngineSink } from "./resolve";
import { flagsOf } from "./scripts";
import { newInstance, type CardInstance, type PendingChoice } from "./state";
import { startTurn } from "./turn";
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

function openMulligan(sink: EngineSink, player: PlayerId): void {
  const prompt = mulliganPrompt(sink, player);
  sink.state.nextId += 1;
  sink.state.pending = prompt;
  sink.state.phase = "mulligan";
  sink.events.push({ type: "promptOpened", player, choiceId: prompt.id, kind: "mulligan" });
}

/**
 * Shuffle both libraries with the match rng, move Quickdraw cards into the opening hand and draw
 * the rest of the opening hand, then open the first mulligan prompt (§2.1).
 */
export function beginSetup(sink: EngineSink): void {
  const state = sink.state;

  for (const player of PLAYER_IDS) {
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

  // The prompt is answered the moment its selection is read, and is cleared here rather than after
  // the draw: §2.4's draw can fire a Cast on draw, which is a whole play and can ask something of
  // its own, and a sequence deciding whether to pause must not see the question it is answering
  // still standing. R9's order is untouched — the replacements are still drawn before the returned
  // cards are shuffled back; only the flag moves, so no event moves with it.
  state.pending = null;

  draw(sink, player, returned.length);

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

  sink.events.push({ type: "promptAnswered", player, choiceId: "mulligan" });

  if (!state.mulliganed.includes(player)) state.mulliganed.push(player);

  const next = PLAYER_IDS.find((p) => p !== player && !state.mulliganed.includes(p));
  if (next !== undefined) {
    openMulligan(sink, next);
    return;
  }

  finishSetup(sink);
}

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
