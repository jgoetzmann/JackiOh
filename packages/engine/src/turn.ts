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
import { DRAWS_PER_TURN, DRAW_OFFER_BLOCK_TURNS, TURN_CAP_PLAYER_TURNS } from "./config";
import { draw } from "./draw";
import { endGame } from "./gameOver";
import { NEXT_REFRESH_MODIFIER_ID, manaEvent, refreshMana } from "./mana";
import { dropDelayed, dueDelayed, expireModifiers } from "./modifiers";
import { runResume } from "./prompts";
import type { EngineSink, HookName } from "./resolve";
import { scriptOf } from "./scripts";
import { stateCheck } from "./stateCheck";
import {
  findInstance,
  handicapOf,
  type CardInstance,
  type GameState,
  type Resume,
  type WorkItem,
} from "./state";
import { endHandedOverTurn, runTrapWindow } from "./traps";
import { dispatchPending, queueHooksInTriggerOrder, settle } from "./triggers";
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
function runDelayed(sink: EngineSink, phase: "start" | "end", player: PlayerId, dueBefore: number): void {
  // R62, R68: the delayed effects due at this point are the ones that exist as it begins. One made
  // while the stage is resolving — by the answer to an earlier one's question, say — is due at the
  // next such point, as it is when nothing asks: `dueBefore` is the creation mark the stage began
  // at, which a pause carries to the step that picks the stage up (R113).
  for (const effect of dueDelayed(sink.state, phase, player).filter((due) => due.seq < dueBefore)) {
    // One entry at a time in R68's order: a prompt, or a game that has just ended, stops the run.
    if (isPaused(sink)) return;
    // R174: an earlier entry's resolution can end a later one — the state check after #50's first
    // steal kills a second steal's target, and `zones.forgetWatchers` drops the entry aimed at it
    // even if Reborn brings the card straight back. The list above was read before either ran, so
    // an entry is run only while `state.delayed` still holds it.
    if (!sink.state.delayed.some((due) => due.id === effect.id)) continue;
    dropDelayed(sink.state, effect.id);
    runResume(sink, effect.resume, { controller: effect.owner });
    // R59: the check runs after the whole delayed effect, never between its parts. One that asked
    // is not whole yet — the answer finishes it — so the check is owed to the step that picks the
    // boundary up after it (`checkBeforeDelayed`), before the next delayed effect runs (R174).
    if (isPaused(sink)) return;
    if (!checkAfterDelayed(sink)) return;
  }
}

/**
 * §10.3 after one whole delayed effect: its events go to the traps, which fire at once as responses
 * (a trap answering #50's first steal resolves before the second steal does), and then the state
 * check (R59). The other triggers they wake are queued and wait for the stage's own loop, in R68's
 * order behind every delayed effect due (`startOfTurnSettle`, `endOfTurnDelayedSettle`). False when a
 * trap's question or a Death hook's paused the stage, or the game ended.
 */
function checkAfterDelayed(sink: EngineSink): boolean {
  // The check's own events — the deaths it collects, their Death hooks, a Reborn body — are the
  // delayed effect's consequences too, so the traps answer them before the next delayed effect
  // resolves (§10.3: `settle` dispatches a check's events before anything else), and what those
  // traps did is checked in turn, until nothing more is said (§4.5, R59).
  for (;;) {
    dispatchPending(sink);
    if (isPaused(sink)) return false;
    const emitted = sink.events.length;
    stateCheck(sink);
    if (isPaused(sink)) return false;
    if (sink.events.length === emitted) return true;
  }
}

/**
 * The owed `delayed` step of either boundary: a delayed effect (or a trap answering one, or the trap
 * window before them) paused, and the answer has finished it by the time this runs, so the traps
 * still owed its events and then its state check come first (§10.3, R59) — a unit it killed has
 * died before the next delayed effect meets the board (R174: #50's steal fizzles on it). False when
 * a trap asked again, or that check ended the game or paused on a Death hook's prompt.
 */
function checkBeforeDelayed(sink: EngineSink): boolean {
  return checkAfterDelayed(sink);
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
 * finish and owes everything after them; `settle` has had them and owes the loop their events wake
 * (§10.3), then the triggers and the draw; `triggers` has had its effects and owes the rest of the
 * trigger queue and then the draw; `main` has drawn and owes only the phase the turn opens in.
 */
const START_DELAYED_STEP = "delayed";
const START_SETTLE_STEP = "settle";
const START_TRIGGERS_STEP = "triggers";
const START_MAIN_STEP = "main";

/** Park the rest of the start of a turn (R113), exactly as `oweEndOfTurn` parks the rest of an end. */
function oweStartOfTurn(sink: EngineSink, player: PlayerId, step: string, dueBefore?: number): void {
  owe(sink, boundaryResume(START_OF_TURN_WORK, player, step, dueBefore));
}

/** A parked boundary's record: whose turn, and for a delayed stage the mark it began at. */
function boundaryResume(hook: string, player: PlayerId, step: string, dueBefore?: number): Resume {
  return {
    defId: "",
    hook,
    step,
    radiant: false,
    data: { player, ...(dueBefore === undefined ? {} : { dueBefore }) },
  };
}

/** The mark a parked delayed stage began at; a record without one owes every entry due (R68). */
function dueBeforeOf(data: Record<string, unknown>): number {
  const mark: unknown = data.dueBefore;
  return typeof mark === "number" ? mark : Number.POSITIVE_INFINITY;
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
  // "This turn" is this turn for both players (§6.2 Combo, #38's "cards you played earlier this
  // turn"): a card the other player casts during it (a cast on draw, R40, R70) counts from zero,
  // not on top of what they played on their own turn before. `unspentAtEnd` is the close of their
  // last turn (§2.2 cleanup) and stays.
  const other = state.players[opponentOf(player)];
  other.turnLog = {
    playedIds: [],
    cardsPlayed: 0,
    ...(other.turnLog.unspentAtEnd === undefined ? {} : { unspentAtEnd: other.turnLog.unspentAtEnd }),
  };
  // R152's backstop: the lockout ends at the cleanup of the turn it was set for, so by now it is
  // already false for the player whose turn My Pawn took. This clears one set on the other player.
  side.aiTurn = false;
  resetExertion(sink, player);

  sink.events.push({ type: "turnStarted", player, turn: state.turn });
  const rider = side.mana.nextTurnMod;
  refreshMana(side);
  sink.events.push(manaEvent(player, side));
  // R169: the refresh spends the rider (§6.3 Mana), and its badge goes with it.
  if (rider !== 0) sink.events.push({ type: "modifierChanged", player, modifierId: NEXT_REFRESH_MODIFIER_ID, added: false });

  startOfTurnDelayed(sink, player, state.nextSeq);
}

/** R62's first stage: the start-of-turn delayed effects, in creation order. */
function startOfTurnDelayed(sink: EngineSink, player: PlayerId, dueBefore: number): void {
  const state = sink.state;

  runDelayed(sink, "start", player, dueBefore);
  if (state.result !== null) return;
  if (state.pending !== null) {
    // The entries still due are in `state.delayed`, so the same step picks them up (R68's order).
    oweStartOfTurn(sink, player, START_DELAYED_STEP, dueBefore);
    return;
  }

  startOfTurnSettle(sink, player);
}

/**
 * §10.3 between R62's first two stages: the events the delayed effects emitted reach the traps and
 * the trigger queue, and what they wake resolves, before the start-of-turn triggers are queued —
 * §6.2's "Delayed effects first (Kpop Fanatic's steal), then the trigger queue in R68 order". Left to
 * the triggers' own loop, a trigger answering #50's steal was queued behind every start-of-turn hook,
 * a backrow one included.
 */
function startOfTurnSettle(sink: EngineSink, player: PlayerId): void {
  const state = sink.state;

  settle(sink);
  if (state.result !== null) return;
  if (state.pending !== null) {
    oweStartOfTurn(sink, player, START_SETTLE_STEP);
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
 *
 * R183: the draw is DRAWS_PER_TURN plus the seat's handicap `extraDrawsPerTurn`, made as one
 * "draw N". `draw` already makes N separate draws, each with its own cast-on-draw chain (R58), its
 * own fatigue step (R3) and R158's pause handling: a prompt opened inside the first parks the rest
 * on `state.work` ahead of the `main` step parked below, so the answer makes the owed draw and only
 * then opens the main phase (R113).
 */
function startOfTurnDraw(sink: EngineSink, player: PlayerId): void {
  const state = sink.state;

  draw(sink, player, DRAWS_PER_TURN + handicapOf(state.players[player]).extraDrawsPerTurn);
  // R59: after the draw as a whole. A cast-on-draw card whose cast is asking something is not
  // whole yet: the chain it owes runs the check once the answer has finished the cast (§2.4, R158).
  if (!isPaused(sink)) stateCheck(sink);
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
    const dueBefore = dueBeforeOf(item.resume.data);
    if (!checkBeforeDelayed(sink)) {
      if (sink.state.result === null) oweStartOfTurn(sink, player, START_DELAYED_STEP, dueBefore);
      return;
    }
    startOfTurnDelayed(sink, player, dueBefore);
    return;
  }

  if (item.resume.step === START_SETTLE_STEP) {
    startOfTurnSettle(sink, player);
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
export function clearReturnFlags(state: GameState): void {
  // The cards played this turn are exactly the ones step 7 could have flagged: it writes the flag on
  // the card it just landed, and step 4 logged that same card on its player's turn log. Both logs:
  // a Spell cast on the other player's turn (a cast on draw, R70) is flagged too, and §6.2 makes an
  // "End of turn" its controller's own turn end, which this is not — so its return is over with this
  // turn as well (R155). `startTurn` empties both logs, so these are still this turn's lists.
  for (const player of PLAYER_IDS) {
    for (const id of new Set(state.players[player].turnLog.playedIds)) {
      const card = findInstance(state, id);
      if (card?.returnToHandAtEndOfTurn === true) delete card.returnToHandAtEndOfTurn;
    }
  }
}

function cleanup(sink: EngineSink, player: PlayerId): void {
  expireModifiers(sink, player);
  const side = sink.state.players[player];
  side.turnLog.unspentAtEnd = side.mana.current;
  if (side.aiTurn) endHandedOverTurn(sink);
  side.aiTurn = false;
  clearReturnFlags(sink.state);
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
 * even emitted; `window` has had its trap window and owes the loop the window's events wake
 * (§10.3), then everything after; `delayed` owes the delayed effects still due; `cleanup` has had
 * them and owes the loop their events wake, then cleanup and everything after; `next` has had
 * cleanup and owes the loop its events wake, then the turn cap and the next turn.
 */
const END_TRIGGERS_STEP = "triggers";
const END_WINDOW_STEP = "window";
const END_DELAYED_STEP = "delayed";
const END_CLEANUP_STEP = "cleanup";
const END_NEXT_STEP = "next";

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
function oweEndOfTurn(sink: EngineSink, player: PlayerId, step: string, dueBefore?: number): void {
  owe(sink, boundaryResume(END_OF_TURN_WORK, player, step, dueBefore));
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
    oweEndOfTurn(sink, player, END_WINDOW_STEP);
    return;
  }

  endOfTurnWindowSettle(sink, player);
}

/**
 * §10.3 after the window: a trap's firing is an effect like any other, so the events it emitted
 * reach the traps and the trigger queue, and what they wake resolves, before R62 moves on to the
 * delayed effects — at this turn's end, not in the next turn's opening loop, behind that turn's own
 * start-of-turn hooks. A trigger answering Bread and Butter's token that finishes the opponent wins
 * the game at the end of this turn (§4.5 step 2).
 */
function endOfTurnWindowSettle(sink: EngineSink, player: PlayerId): void {
  const state = sink.state;

  settle(sink);
  if (state.result !== null) return;
  if (state.pending !== null) {
    oweEndOfTurn(sink, player, END_WINDOW_STEP);
    return;
  }

  endOfTurnAfterWindow(sink, player, state.nextSeq);
}

/** R62's tail: the end-of-turn delayed effects, then (`endOfTurnDelayedSettle`) the rest. */
function endOfTurnAfterWindow(sink: EngineSink, player: PlayerId, dueBefore: number): void {
  const state = sink.state;

  runDelayed(sink, "end", player, dueBefore);
  if (state.result !== null) return;
  if (state.pending !== null) {
    // The entries still due are in `state.delayed`, so the same step picks them up (R68's order).
    oweEndOfTurn(sink, player, END_DELAYED_STEP, dueBefore);
    return;
  }

  endOfTurnDelayedSettle(sink, player);
}

/** §10.3 after the delayed effects, as after the window; then cleanup, the turn cap, the next turn. */
function endOfTurnDelayedSettle(sink: EngineSink, player: PlayerId): void {
  const state = sink.state;

  settle(sink);
  if (state.result !== null) return;
  if (state.pending !== null) {
    oweEndOfTurn(sink, player, END_CLEANUP_STEP);
    return;
  }

  cleanup(sink, player);
  endOfTurnCleanupSettle(sink, player);
}

/**
 * §10.3 after cleanup, as after every other stage of the turn: cleanup's own events — My Pawn
 * reaching its owner's graveyard at the end of the turn it took (R152), the "this turn" modifiers
 * expiring — reach the traps and the trigger queue, and what they wake resolves, before the turn-cap
 * check and the next turn (R62's order: cleanup, then the cap, then the opponent's turn). Left to the
 * next turn's first loop, a trigger answering them resolved after that turn had begun, and at the
 * cap the game was drawn before it could.
 */
function endOfTurnCleanupSettle(sink: EngineSink, player: PlayerId): void {
  const state = sink.state;

  settle(sink);
  if (state.result !== null) return;
  if (state.pending !== null) {
    oweEndOfTurn(sink, player, END_NEXT_STEP);
    return;
  }

  // R155: a return Spell cast while cleanup's events were answered — a cast on draw a trigger's draw
  // made — was flagged by §10.5 step 7 after cleanup had cleared the flags. This turn's end-of-turn
  // triggers are over, so its return is over too, and it is cleared now, while this is still the
  // turn whose logs name it: `startTurn` empties them, and a flag no cleanup saw came back at the
  // end of its caster's next turn, one it was not played on.
  clearReturnFlags(state);

  if (state.turn >= TURN_CAP_PLAYER_TURNS) {
    endGame(sink, "draw", "turn-cap");
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

  if (item.resume.step === END_WINDOW_STEP) {
    endOfTurnWindowSettle(sink, player);
    return;
  }

  if (item.resume.step === END_CLEANUP_STEP) {
    endOfTurnDelayedSettle(sink, player);
    return;
  }

  if (item.resume.step === END_NEXT_STEP) {
    endOfTurnCleanupSettle(sink, player);
    return;
  }

  // `delayed`: a delayed effect asked, and the answer has finished it.
  const dueBefore = dueBeforeOf(item.resume.data);
  if (!checkBeforeDelayed(sink)) {
    if (sink.state.result === null) oweEndOfTurn(sink, player, END_DELAYED_STEP, dueBefore);
    return;
  }
  endOfTurnAfterWindow(sink, player, dueBefore);
}

registerWorkHandler(END_OF_TURN_WORK, runOwedEndOfTurn);

export function concede(sink: EngineSink, player: PlayerId): void {
  endGame(sink, opponentOf(player), "concede");
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

/**
 * R36: whether `player` has an offer to answer — the active opponent offered this turn and it has
 * not been answered yet. `legalActions` and the reducer both ask this, so a declined offer is gone
 * from both at once.
 *
 * R269: an offer lives for the rest of the turn it was made on. Nothing clears it when that turn
 * ends: the turn number moves on, so the offer simply stops standing — it lapses, and a lapsed
 * offer is not a declined one, so it blocks nothing (R36's block is a decline's).
 */
export function hasStandingDrawOffer(state: GameState, player: PlayerId): boolean {
  const offering = opponentOf(player);
  return state.active === offering && state.players[offering].drawOffer.offeredTurn === state.turn;
}

/**
 * R269: the player whose draw offer stands right now, or null. `viewFor` shows it to both seats —
 * the offer was a public action (`drawOffered`) — so a client can tell the offerer it is waiting
 * and the other seat that it has an offer to answer, and a reconnect shows the same.
 */
export function standingDrawOffer(state: GameState): PlayerId | null {
  // R216: nothing stands once the game is over, an offer included (a concede, the turn cap).
  if (state.result !== null) return null;
  return hasStandingDrawOffer(state, opponentOf(state.active)) ? state.active : null;
}

export function answerDraw(sink: EngineSink, player: PlayerId, accept: boolean): void {
  sink.events.push({ type: "drawAnswered", player, accept });
  const offering = opponentOf(player);
  // §2.5, R36: an offer is answered once; afterwards there is nothing standing to accept. The
  // once-per-turn limit does not need the record: a declined offer blocks its player's next
  // DRAW_OFFER_BLOCK_TURNS turns, this one included, and an accepted one ends the game.
  delete sink.state.players[offering].drawOffer.offeredTurn;
  if (accept) {
    endGame(sink, "draw", "draw-accepted");
    return;
  }
  // R36: the next DRAW_OFFER_BLOCK_TURNS turns of theirs are blocked, counting from the next one.
  const side = sink.state.players[offering];
  side.drawOffer.blockedUntil = side.turnsStarted + DRAW_OFFER_BLOCK_TURNS + 1;
}
