// The turn loop of SPEC §2.2 in R62's order, cleanup, the turn cap and the ways a game ends
// (§2.5, R79). The sequence is fixed here; every part of it belongs to the module that owns it —
// the start-of-turn and end-of-turn hooks to `triggers.queueHooksInTriggerOrder` (R68's order,
// drained by `triggers.settle`), the end-of-turn trap window to `traps.runTrapWindow` (R62, R100),
// the delayed effects to `modifiers.dueDelayed` in creation order, and mana to `mana.ts`.
//
// Every one of those parts can pause, because a trigger, a trap or a delayed effect may ask its
// controller something (§9.3, §10.6). So BOTH turn boundaries are resumable sequences like any
// other: at the moment one pauses it parks what is left of R62's order on `state.work` through
// `work.owe` and returns, and `runOwedStartOfTurn` / `runOwedEndOfTurn` — each registered with
// `work.registerWorkHandler` at module scope below — pick it up when the answer drains the queue
// (R113, R117, R122). Walking on instead is what let a delayed effect resolve inside an unfinished
// trap window and `cleanup` close the turn log before the window's last traps had fired, and, at
// the other boundary, what had the turn's draw land inside an open start-of-turn prompt.
//
// The other half of §10.3 at a boundary is dispatch: a stage that emits events settles before the
// next one runs, so the draw's events — for a Cast on draw, a whole play (R58) — reach the traps
// and the trigger queue instead of sitting undispatched on the sink.

import type { GameEvent, PlayerId } from "@jackioh/shared";
import { PLAYER_IDS, opponentOf } from "@jackioh/shared";
import { DRAW_OFFER_BLOCK_TURNS, TURN_CAP_PLAYER_TURNS } from "./config";
import { draw } from "./draw";
import { manaEvent, refreshMana } from "./mana";
import { dropDelayed, dueDelayed, expireModifiers } from "./modifiers";
import { runResume } from "./prompts";
import type { EngineSink, HookName } from "./resolve";
import { scriptOf } from "./scripts";
import { stateCheck } from "./stateCheck";
import { findInstance, type CardInstance, type GameState, type Resume, type WorkItem } from "./state";
import { runTrapWindow } from "./traps";
import { queueHooksInTriggerOrder, settle } from "./triggers";
import { owe, paused as isPaused, registerWorkHandler } from "./work";
import { activeUnitsOf, cardAt, slotsOf } from "./zones";

/**
 * R68: the active player's cards first, then the opponent's; units by lane, then the backrow.
 * `only` narrows it to one controller, which is what start-of-turn and end-of-turn hooks need:
 * they fire on their controller's turn alone (§6.2, and #13 "not on the opponent's end").
 *
 * This is the field-and-backrow scan only, so it misses R68's hand and graveyard trigger holders;
 * the turn loop below therefore asks `triggers.queueHooksInTriggerOrder`, which covers all four
 * zones. Kept as the exported board-order helper the card files' comments point at.
 */
export function triggerOrder(sink: EngineSink, hook: HookName, only?: PlayerId): CardInstance[] {
  const sides: PlayerId[] = sink.state.active === "p1" ? ["p1", "p2"] : ["p2", "p1"];
  const order = only === undefined ? sides : [only];
  return order.flatMap((player) => {
    const units = activeUnitsOf(sink.state, player);
    const backrow = slotsOf(player, "backrow").flatMap((ref) => {
      const card = cardAt(sink.state, ref);
      return card === null ? [] : [card];
    });
    return [...units, ...backrow].filter((card) => scriptOf(card)[hook] !== undefined);
  });
}

/**
 * §2.2's two delayed-effect points, in R68's creation order (`modifiers.dueDelayed`). An entry is
 * dropped before it runs, so it can never fire twice.
 *
 * R126: a delayed continuation is re-entered exactly the way a prompt answer is. `resume.hook`
 * names a key of the card's `Script`, which may be a hook (`delayed`) or the step table (`resume`,
 * where `resume.step` picks the entry), and **one** reader resolves both shapes — which is why this
 * goes through `prompts.runResume` and not `resolve.runHook`. `runHook` resolves only the first
 * shape: it does `script[name]` and *calls* it, so `hook: "resume"` fetched the step-table object
 * and threw "not a function", and no card could keep its continuation where every other pause in
 * the engine keeps one.
 *
 * R127: an entry whose instance is gone still resolves, named by its stored def id. `runResume`
 * finds the instance itself and re-enters with `ctx.self === null`, the step reading what it needs
 * out of `resume.data` (§10.6, R76: #50 Kpop Fanatic's steal fires after Kpop Fanatic has died,
 * #39's exile after the card has exiled itself). The old `instanceId === undefined` skip dropped
 * that shape with no error at all, which is the silent loss of a sequence R113 forbids.
 *
 * A step that opens a prompt stops the run where it stands (§9.3): its own tail is parked by
 * `prompts.applyResumable`, the entries still due stay in `state.delayed`, and the caller parks the
 * rest of the turn boundary — which is what brings this function back for them.
 */
function runDelayed(sink: EngineSink, phase: "start" | "end", player: PlayerId): void {
  for (const effect of dueDelayed(sink.state, phase, player)) {
    // One entry at a time in R68's order: a prompt, or a game that has just ended, stops the run.
    if (isPaused(sink)) return;
    dropDelayed(sink.state, effect.id);
    runResume(sink, effect.resume, { controller: effect.owner });
    stateCheck(sink);
  }
}

/** Exertion and the once-per-turn flags reset at the controller's own turn start (§4.1). */
function resetExertion(sink: EngineSink, player: PlayerId): void {
  for (const pile of sink.state.players[player].units) {
    for (const card of pile ?? []) card.exertion = { attacked: false, switched: false };
  }
}

// ---------------------------------------------------------------------------
// The start of a turn, and the remainder it owes when something pauses (§2.2, R62, R113, R117)
// ---------------------------------------------------------------------------

/**
 * R113: the `resume.hook` of the work item the START of a turn parks, the twin of
 * `END_OF_TURN_WORK` below. It is an engine sequence and not a card's, so the name is one no
 * `Script` can hold, and `runOwedStartOfTurn` is registered for it at module scope.
 */
export const START_OF_TURN_WORK = "@startOfTurn";

/**
 * Which part of R62's opening is still owed: `delayed` still has start-of-turn delayed effects to
 * finish and owes everything after them; `triggers` has had its effects and owes the rest of the
 * trigger queue and then the draw; `main` has drawn and owes only the phase the turn opens in.
 */
const START_DELAYED_STEP = "delayed";
const START_TRIGGERS_STEP = "triggers";
const START_MAIN_STEP = "main";

/** Park the rest of the start of a turn (R113), exactly as `oweEndOfTurn` parks the rest of an end. */
function oweStartOfTurn(sink: EngineSink, player: PlayerId, step: string): void {
  const resume: Resume = {
    defId: "",
    hook: START_OF_TURN_WORK,
    step,
    radiant: false,
    data: { player },
  };
  owe(sink, resume);
}

/**
 * Start a turn (§2.2, R62): refresh, then the start-of-turn delayed effects, then the start-of-turn
 * triggers, then the draw.
 *
 * Every one of those stages can pause, exactly as the end of a turn can, so the start of one is a
 * resumable sequence in the same shape (R113, R117, R122): each stage stops at a pause, parks what
 * is still owed on `state.work` through `oweStartOfTurn` and returns, and `runOwedStartOfTurn`
 * picks it up when the answer drains the queue. Walking on instead is what had a start-of-turn
 * trigger's prompt open with the turn's draw landing *inside* it, where R62 puts the draw after the
 * triggers — the same bug the end of turn had.
 */
export function startTurn(sink: EngineSink, player: PlayerId): void {
  const state = sink.state;
  state.active = player;
  state.turn += 1;
  state.phase = "start";
  const side = state.players[player];
  side.turnsStarted += 1;
  side.turnLog = { playedIds: [], cardsPlayed: 0 };
  // R152's backstop: the lockout ends at the cleanup of the turn it was set for, so by now it is
  // already false for the player whose turn My Pawn took. This clears one set on the other player.
  side.aiTurn = false;
  resetExertion(sink, player);

  sink.events.push({ type: "turnStarted", player, turn: state.turn });
  refreshMana(side);
  sink.events.push(manaEvent(player, side));

  startOfTurnDelayed(sink, player);
}

/** R62's first stage: the start-of-turn delayed effects, in creation order. */
function startOfTurnDelayed(sink: EngineSink, player: PlayerId): void {
  const state = sink.state;

  runDelayed(sink, "start", player);
  if (state.result !== null) return;
  if (state.pending !== null) {
    // The entries still due are in `state.delayed`, so the same step picks them up (R68's order).
    oweStartOfTurn(sink, player, START_DELAYED_STEP);
    return;
  }

  startOfTurnTriggers(sink, player);
}

/**
 * R62's second stage: the start-of-turn triggers, and R68's four zones rather than the two on the
 * field — a hand or graveyard trigger holder carries a start-of-turn hook too, and queueing lets one
 * that prompts keep the rest in state.
 */
function startOfTurnTriggers(sink: EngineSink, player: PlayerId): void {
  const state = sink.state;

  queueHooksInTriggerOrder(sink, "startOfTurn", player);
  settle(sink);
  if (state.result !== null) return;
  if (state.pending !== null) {
    // The queue is not empty yet, so what is owed is the queue's remainder and then the draw.
    oweStartOfTurn(sink, player, START_TRIGGERS_STEP);
    return;
  }

  startOfTurnDraw(sink, player);
}

/**
 * R62's last stage: the turn's draw, and then the main phase.
 *
 * The `settle` after the draw is §10.3 and not tidiness: the draw's own events have to be collected
 * into `state.dispatch` and offered to the traps and the trigger queue like any others. §2.4's Cast
 * on draw makes that a whole play at the start of a turn — `drawn`, `cardPlayed`, `cardResolved`,
 * `addedToHand` (R58) — and without this they were emitted and never dispatched, so a trap that
 * answers one of them (#60 Bear Honeypot's `cardResolved`) never saw it. It only ever showed on a
 * direct `startTurn` call, because `reduce` settles at the end of every action.
 */
function startOfTurnDraw(sink: EngineSink, player: PlayerId): void {
  const state = sink.state;

  draw(sink, player, 1);
  stateCheck(sink);
  settle(sink);
  if (state.result !== null) return;
  if (state.pending !== null) {
    // A trap or a cast-on-draw card asked something: the turn still owes its own opening.
    oweStartOfTurn(sink, player, START_MAIN_STEP);
    return;
  }

  state.phase = "main";
}

/**
 * `work.ts`'s handler for a parked start of turn: the same turn, continued where it stopped (R113).
 *
 * The `triggers` stage settles the queue itself, because the hooks are already queued and `work.ts`
 * is drained *ahead* of the trigger queue (`triggers.settle`), so the remainder has to finish the
 * queue rather than jump it. The `delayed` stage re-enters `runDelayed`, whose still-due entries are
 * in `state.delayed`, and the `main` step is the phase change a pause inside the draw held up.
 */
function runOwedStartOfTurn(sink: EngineSink, item: WorkItem): void {
  const player = turnPlayerOf(item.resume.data);
  if (player === null) return;

  if (item.resume.step === START_DELAYED_STEP) {
    startOfTurnDelayed(sink, player);
    return;
  }

  if (item.resume.step === START_TRIGGERS_STEP) {
    settle(sink);
    if (sink.state.result !== null) return;
    if (sink.state.pending !== null) {
      oweStartOfTurn(sink, player, START_TRIGGERS_STEP);
      return;
    }
    startOfTurnDraw(sink, player);
    return;
  }

  if (sink.state.result === null) sink.state.phase = "main";
}

registerWorkHandler(START_OF_TURN_WORK, runOwedStartOfTurn);

/**
 * Cleanup (§2.2): "this turn" modifiers expire, the turn log is closed and the AI lockout ends.
 *
 * R152: §8 #96 says the opponent's client is locked out "until end of turn", so the flag is cleared
 * HERE, at the end of the turn the effect took, and not at that player's next turn start — clearing
 * it later leaves them locked out of a turn that is no longer the one My Pawn took. `startTurn`
 * still clears it as a backstop, for a flag somehow set on the player who is not the active one.
 *
 * R155: §5.1's `returnToHandAtEndOfTurn` is cleared here for the same reason. §10.5 step 7 sets it
 * as the Spell lands in the graveyard and R68's end-of-turn queue — which has already run by the
 * time cleanup does — is what acts on it, so this is the end of the one turn the flag was ever
 * about. Leaving it set would make the card return from the graveyard on every later turn it
 * happened to be in one, including after it was merely discarded or milled (R153).
 */
function clearReturnFlags(state: GameState, player: PlayerId): void {
  // The cards this player played this turn are exactly the ones step 7 could have flagged: it
  // writes the flag on the card it just landed, and `countAsPlayed` logged that same card on this
  // player's turn log. `startTurn` empties the log, so this is still that list.
  for (const id of new Set(state.players[player].turnLog.playedIds)) {
    const card = findInstance(state, id);
    if (card?.returnToHandAtEndOfTurn === true) delete card.returnToHandAtEndOfTurn;
  }
}

function cleanup(sink: EngineSink, player: PlayerId): void {
  expireModifiers(sink, player);
  const side = sink.state.players[player];
  side.turnLog.unspentAtEnd = side.mana.current;
  side.aiTurn = false;
  clearReturnFlags(sink.state, player);
}

// ---------------------------------------------------------------------------
// The end of a turn, and the remainder it owes when something pauses (§2.2, R62, R113, R117)
// ---------------------------------------------------------------------------

/**
 * R113: the `resume.hook` of the one work item this module parks — the rest of an end of turn. It
 * is an engine sequence and not a card's, so the name is one no `Script` can hold, and
 * `runOwedEndOfTurn` below is registered for it at module scope: `work.runWorkItem` raises on a
 * hook nothing knows, and an end of turn that cannot be resumed is exactly the lost sequence that
 * rule exists to prevent. Registered here in the module that owns the sequence and never from a
 * test — a handler wired up by a test is a handler production does not have.
 */
export const END_OF_TURN_WORK = "@endOfTurn";

/**
 * Which part of R62's order is still owed, named so a reader of `state.work` can see it:
 * `triggers` still has the end-of-turn trigger queue to finish before the `turnEnded` event is
 * even emitted; `delayed` has had its window and owes the delayed effects, cleanup, the turn cap
 * and the next turn.
 */
const END_TRIGGERS_STEP = "triggers";
const END_DELAYED_STEP = "delayed";

/**
 * Whose turn a parked boundary belongs to — the one ending, or the one starting — read back
 * defensively, because the item came through JSON (§10.1). Both handlers park `{ player }`.
 */
function turnPlayerOf(data: Record<string, unknown>): PlayerId | null {
  const player: unknown = data.player;
  return PLAYER_IDS.find((id) => id === player) ?? null;
}

/**
 * Park the rest of the end of turn (R113). `work.ts` owns `state.work`, so this only ever calls
 * `owe`: the item lands at `state.workCursor`, which the pausing scope has just advanced past its
 * own item, so it sits *behind* the remainder of whatever paused — the trap window's owed traps
 * first, then this — and R62's order survives the pause. Nothing is held but plain JSON.
 *
 * R117: every caller calls this at the moment it actually pauses and never in advance. While
 * `endTurn` is on the stack the steps after the pause point are `endTurn`'s alone, so a `settle`
 * running inside one of them — a trap's or a trigger's own effects can start one — can neither
 * take nor re-run the steps it is standing in. Pre-parking a sequence's continuation is what made
 * a played card's Cry fire twice (§10.5's driver, R1).
 */
function oweEndOfTurn(sink: EngineSink, player: PlayerId, step: string): void {
  const resume: Resume = {
    defId: "",
    hook: END_OF_TURN_WORK,
    step,
    radiant: false,
    data: { player },
  };
  owe(sink, resume);
}

/**
 * End the active player's turn and start the next, unless the cap ends the game (§2.5, R2).
 *
 * R62's order is the whole point: end-of-turn triggers, then the end-of-turn trap window (the
 * ending player's traps first, then the opponent's), then the end-of-turn delayed effects, then
 * cleanup, then the turn-cap check.
 *
 * Every step of that order can pause, because a trigger, a trap or a delayed effect may ask its
 * controller something (§9.3, §10.6). So each stage below stops at a pause and owes what is left
 * to `state.work` instead of walking on: a delayed effect that resolved *inside* an unfinished trap
 * window, and a `cleanup` that closed the turn log before the window's last traps had fired, were
 * both R62's order broken on the pause path.
 */
export function endTurn(sink: EngineSink): void {
  const state = sink.state;
  const player = state.active;
  state.phase = "end";

  // R68: the hand and graveyard holders too (the `returnToHandAtEndOfTurn` spells of §5.1).
  queueHooksInTriggerOrder(sink, "endOfTurn", player);
  settle(sink);
  if (state.result !== null) return;
  if (state.pending !== null) {
    // The trigger queue is not empty yet, so what is owed is the whole rest of R62's order.
    oweEndOfTurn(sink, player, END_TRIGGERS_STEP);
    return;
  }

  endOfTurnAfterTriggers(sink, player);
}

/**
 * R62 from the `turnEnded` event on: the trap window, then everything after it.
 *
 * `turnEnded` is emitted *before* the window rather than after it, because the window's traps read
 * it: #18 Bread and Butter answers `event.unspentMana`, which is the mana the player still holds
 * before `cleanup` closes the turn log. R100 keeps the event out of the immediate trap check —
 * `traps.TRAP_WINDOW_EVENTS` withholds `turnEnded` from `fireTrapsFor`, so the window below is the
 * only place a `turnEnded` trap fires, exactly once per turn end. Ordinary (non-trap) triggers on
 * `turnEnded` still queue the usual way when `triggers.settle` reaches the event.
 */
function endOfTurnAfterTriggers(sink: EngineSink, player: PlayerId): void {
  const state = sink.state;
  const side = state.players[player];
  const ended: GameEvent = {
    type: "turnEnded",
    player,
    turn: state.turn,
    unspentMana: side.mana.current,
  };
  sink.events.push(ended);

  // §2.2's end-of-turn trap window, at R62's scheduled point: after the triggers, before the
  // delayed effects. A prompt a trap opens pauses the rest of the window in state (§9.3), and
  // `traps.runTrapWindow` parks the traps it never reached; the steps after the window are this
  // module's, so they are parked here, behind them.
  runTrapWindow(sink, ended);
  if (state.result !== null) return;
  if (state.pending !== null) {
    oweEndOfTurn(sink, player, END_DELAYED_STEP);
    return;
  }

  endOfTurnAfterWindow(sink, player);
}

/** R62's tail: the end-of-turn delayed effects, cleanup, the turn cap, the next turn. */
function endOfTurnAfterWindow(sink: EngineSink, player: PlayerId): void {
  const state = sink.state;

  runDelayed(sink, "end", player);
  if (state.result !== null) return;
  if (state.pending !== null) {
    // The entries still due are in `state.delayed`, so the same step picks them up (R68's order).
    oweEndOfTurn(sink, player, END_DELAYED_STEP);
    return;
  }

  cleanup(sink, player);

  if (state.turn >= TURN_CAP_PLAYER_TURNS) {
    state.result = { winner: "draw", reason: "turn-cap" };
    state.phase = "over";
    sink.events.push({ type: "gameOver", winner: "draw", reason: "turn-cap" });
    return;
  }

  startTurn(sink, opponentOf(player));
}

/**
 * `work.ts`'s handler for a parked end of turn: the same turn, continued where it stopped (R113).
 *
 * The `triggers` stage finishes the trigger queue first, because R62 puts the end-of-turn triggers
 * before the window and `work.ts` is drained *ahead* of the queue (`triggers.settle`) — so the
 * remainder has to settle the queue itself rather than jump it. The item is off the queue by the
 * time this runs (`work.takeWork`), so that `settle` can neither take nor re-run this item.
 */
function runOwedEndOfTurn(sink: EngineSink, item: WorkItem): void {
  const player = turnPlayerOf(item.resume.data);
  if (player === null) return;

  if (item.resume.step === END_TRIGGERS_STEP) {
    settle(sink);
    if (sink.state.result !== null) return;
    if (sink.state.pending !== null) {
      oweEndOfTurn(sink, player, END_TRIGGERS_STEP);
      return;
    }
    endOfTurnAfterTriggers(sink, player);
    return;
  }

  // The only other step this module parks: §2.2's tail, whose window has already had its event.
  endOfTurnAfterWindow(sink, player);
}

registerWorkHandler(END_OF_TURN_WORK, runOwedEndOfTurn);

export function concede(sink: EngineSink, player: PlayerId): void {
  const winner = opponentOf(player);
  sink.state.result = { winner, reason: "concede" };
  sink.state.phase = "over";
  sink.events.push({ type: "gameOver", winner, reason: "concede" });
}

/** R36: only the active player offers, once per turn, and a declined offer blocks 3 of their turns. */
export function canOfferDraw(state: GameState, player: PlayerId): boolean {
  if (state.active !== player || state.phase !== "main") return false;
  const offer = state.players[player].drawOffer;
  if (offer.offeredTurn === state.turn) return false;
  const blockedUntil = offer.blockedUntil ?? 0;
  return state.players[player].turnsStarted >= blockedUntil;
}

export function offerDraw(sink: EngineSink, player: PlayerId): void {
  sink.state.players[player].drawOffer.offeredTurn = sink.state.turn;
  sink.events.push({ type: "drawOffered", player });
}

export function answerDraw(sink: EngineSink, player: PlayerId, accept: boolean): void {
  sink.events.push({ type: "drawAnswered", player, accept });
  const offering = opponentOf(player);
  if (accept) {
    sink.state.result = { winner: "draw", reason: "draw-accepted" };
    sink.state.phase = "over";
    sink.events.push({ type: "gameOver", winner: "draw", reason: "draw-accepted" });
    return;
  }
  // R36: the next DRAW_OFFER_BLOCK_TURNS turns of theirs are blocked, counting from the next one.
  const side = sink.state.players[offering];
  side.drawOffer.blockedUntil = side.turnsStarted + DRAW_OFFER_BLOCK_TURNS + 1;
}

export function pendingDrawOffer(sink: EngineSink): PlayerId | null {
  for (const player of PLAYER_IDS) {
    if (sink.state.players[player].drawOffer.offeredTurn === sink.state.turn && sink.state.active === player) {
      return player;
    }
  }
  return null;
}
