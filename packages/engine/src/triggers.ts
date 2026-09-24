// The trigger registry, the trigger queue and the resolution loop of SPEC §10.3, in R68's order
// (BUILD M3-T2). Three parts, read in the order the §10.3 diagram reads:
//
//  1. The registry — which cards can answer right now, keyed by hook and by the zone each card
//     sits in. R153 is the whole of that second key: a card registers only the triggers its zone
//     allows. On the field or in the backrow it answers `script.triggers` plus its `startOfTurn`,
//     `endOfTurn`, `aura`, `setStat` and `onPlayHook` hooks; in a hand only `script.handTriggers`
//     (#89 Corpse Eater); in a graveyard only the end-of-turn return of a `returnToHandAtEndOfTurn`
//     spell of §5.1, which is how #23, #24 and #31 come back at the end of the turn (R68); and in a
//     library, in exile, in the resolving zone or dormant under a Stack, nothing at all (§3.2, R13).
//     `aura` and `setStat` are not queued here at all — `layers.ts` reads them off the field
//     directly — but they are field-only for the same reason the hooks are.
//  2. The two queues in state. `state.dispatch` is §10.3's frontier: every event emitted but not
//     yet offered to the traps and the registry, so an interrupted dispatch owes the rest in state
//     rather than on the sink that dies with the action (§9.3). `state.triggerQueue` holds what the
//     dispatch queued: an entry names the card and the trigger id and carries the event it answers,
//     all plain JSON, so it survives an open prompt, a save and a replay — and R89 falls out of it,
//     since every trigger but the Death hook runs after R78 has reset the instance, off the event it
//     captured. Queue order is R68's: the active player's cards, then the opponent's; within a side
//     unit lanes 1–5, then backrow 1–5, then hand, then graveyard. Traps are not queued at all —
//     `traps.ts` fires them the moment the event is dispatched, which is what "a trap fires before a
//     queued trigger" means (§10.3, BUILD M3-T2), and R100 keeps the end-of-turn window's events out
//     of that immediate check so a `turnEnded` trap fires once per turn end. Either dispatch owes
//     what a prompt stopped it from delivering, and neither drops it (R113): an immediate one parks
//     an `OWED_TO_TRAPS` entry in front of every queued card trigger, because a trap is a response,
//     while the scheduled end-of-turn window parks its remainder as `traps.TRAP_WINDOW_WORK` on
//     `state.work`, which `settle` drains before the trigger queue moves at all. Delayed effects are
//     never queued here: they resolve at their R62 point, which `turn.ts` owns through
//     `modifiers.dueDelayed`, in creation order.
//  3. The loop — `settle`. Collect the new events, run whatever work is owed, dispatch one event,
//     run the state check, then pop one trigger and apply it whole; repeat until both queues are
//     empty and no prompt is open. R59 holds by construction: the check runs between whole effects
//     and whole triggers, never between the hits of one, and never in the middle of one batch of
//     emitted events.
//
// A trigger that opens a prompt stops the loop where it stands, and everything still owed is state:
// `state.pending`, `state.work` (the interrupted sequence, R113), `state.dispatch` (the events not
// yet offered) and `state.triggerQueue` (each entry with the event it captured). So the action
// returns paused and the `answer` action finishes the job by calling `prompts.answerPrompt` and then
// `settle` again (§9.3, §10.6). Nothing owed lives on the transient sink, which is the hole the M3
// review's B-2 and B-3 found.

import type { GameEvent, GameEventType, PlayerId } from "@jackioh/shared";
import { PLAYER_IDS } from "@jackioh/shared";
import { defOf } from "./catalog";
import { BACKROW_ZONES, CAST_ON_DRAW_CHAIN_CAP, LIBRARY_CAP, UNIT_ZONES } from "./config";
import { applyResumable, runHookResumable } from "./prompts";
import type { EngineSink, HookName } from "./resolve";
import { makeContext } from "./resolve";
import type { Script, TriggerDef } from "./script";
import { scriptOf } from "./scripts";
import { stateCheck } from "./stateCheck";
import { eventMark, exitMark, movesIn, uncoveredBy, type LaterMoves } from "./stays";
import {
  findInstance,
  type CardInstance,
  type GameState,
  type QueuedTrigger,
  type Resume,
} from "./state";
import {
  arrivedDuringPlay,
  isTrapWindowEvent,
  offerEventToTraps,
  resumeEventToTraps,
  trapControllersOf,
  type ImmediateDispatch,
  type TrapControllers,
} from "./traps";
import { RUN_MARKS_KEY, cardData, drainWork, runMarksOf, type RunMarks } from "./work";
import { activeUnitsOf, cardAt, slotsOf } from "./zones";

/** The zones a card can hold a trigger from (§10.3). */
export type TriggerZone = "field" | "backrow" | "hand" | "graveyard";

/** One card that can answer, with the triggers its current zone registers. */
export type TriggerHolder = {
  card: CardInstance;
  /** The side the card sits on: a stolen trap answers for its new controller (R33). */
  controller: PlayerId;
  zone: TriggerZone;
  /** A Trap or Field Trap in the backrow: a response, fired by `traps.ts`, never queued (§10.3). */
  isTrap: boolean;
  /** The event triggers this zone registers; empty for a card whose script has none. */
  triggers: readonly TriggerDef[];
  /** The face that is running, for the hook registry (§5.2). */
  script: Script;
};

/** Every hook a script can register, in the registry's key order (BUILD M3-T2). */
export const TRIGGER_HOOKS = [
  "cry",
  "death",
  "startOfGame",
  "startOfTurn",
  "endOfTurn",
  "activate",
  "onPlayHook",
] as const satisfies readonly HookName[];

/** The `hook` of the one queue entry that is not a card's trigger: an event owed to the traps. */
export const OWED_TO_TRAPS = "@traps";

/**
 * How many times `settle` may go round before the board is called stuck (§10.3). Each pass resolves
 * something — a dispatch, owed work, a check or one queued trigger — so the cap has to hold every
 * trigger one legal action can set off, and R58 bounds that from the rules: "draw your whole
 * library" (#95) draws up to LIBRARY_CAP cards, each draw casts up to CAST_ON_DRAW_CHAIN_CAP cast-on-
 * draw cards, and each cast is a play (R70) every permanent on either side may answer (#33 Unstable
 * Clone Machine). A flat 1,000 threw on a Call to Chaos drawing 55 CN-Viruses beside a #33, a play
 * the rules bound at about 1,100 triggers. A board still going past this is a loop, not a game.
 */
export const SETTLE_PASS_CAP =
  LIBRARY_CAP * CAST_ON_DRAW_CHAIN_CAP * (UNIT_ZONES + BACKROW_ZONES) * PLAYER_IDS.length;

const NO_TRIGGERS: readonly TriggerDef[] = [];

// ---------------------------------------------------------------------------
// 1. The registry.
// ---------------------------------------------------------------------------

function isTrapCard(state: GameState, card: CardInstance): boolean {
  const type = defOf(state, card.defId).type;
  return type === "Trap" || type === "Field Trap";
}

/** §10.3: which list a card's zone registers. A graveyard card answers hooks only (R68). */
function registeredTriggers(script: Script, zone: TriggerZone): readonly TriggerDef[] {
  if (zone === "hand") return script.handTriggers ?? NO_TRIGGERS;
  if (zone === "graveyard") return NO_TRIGGERS;
  return script.triggers ?? NO_TRIGGERS;
}

/** The one hook a graveyard card can still answer (R153): §5.1's end-of-turn return, nothing else. */
const GRAVEYARD_HOOK: HookName = "endOfTurn";

/**
 * §5.1 and R68: a spell whose text is "End of turn: add this back to your hand" is flagged
 * `returnToHandAtEndOfTurn` when it is played and answers its `endOfTurn` hook from the graveyard on
 * that turn alone (#23 Reoccurring Dream, #24 Efficiency Dividend, #31 KY's Math Equation).
 *
 * R155 now sets that flag: §10.5 step 7 writes it as it sends to the graveyard a Spell whose
 * resolving face declares the return, and `cleanup` clears it at the end of the turn. So the flag
 * alone is the gate, and the turn-log fallback this used to carry is gone — it was strictly less
 * correct, because the log cannot tell a Spell that asked to return from a Unit with an end-of-turn
 * hook (#13 Jlockeed Shredder-10) that merely died on the turn it was played, nor from a Spell that
 * left the graveyard mid-resolution and was discarded back into it the same turn.
 *
 * Everything else in a graveyard registers nothing: a spell left over from an earlier turn, and a
 * copy that arrived by being discarded or milled and was never played at all (R153).
 */
function flaggedForReturn(card: CardInstance): boolean {
  return card.returnToHandAtEndOfTurn === true;
}

/**
 * R153: whether a holder's zone lets it register this hook at all. A card registers only the
 * triggers its zone allows — on the field or in the backrow its `triggers` plus every hook it
 * carries; in a hand only its `handTriggers`, so no hook; in a graveyard only the end-of-turn return
 * above. A library, exile or resolving card and a card dormant under a Stack never reach here:
 * `triggerHoldersOf` and `triggerHolderFor` give them no holder at all (§3.2, R13).
 *
 * Without this a Field Spell fired its `startOfTurn` from a HAND (#58 Rush Token Farm summoning a
 * Rush Token onto a board it was never on) and #64 Gifted Program made a play Radiant from a hand —
 * neither an error, both a different game.
 */
function zoneRegistersHook(state: GameState, holder: TriggerHolder, hook: HookName): boolean {
  if (holder.zone === "hand") return false;
  if (holder.zone === "graveyard") {
    return hook === GRAVEYARD_HOOK && flaggedForReturn(holder.card);
  }
  return true;
}

function holderOf(
  state: GameState,
  card: CardInstance,
  zone: TriggerZone,
  controller: PlayerId,
): TriggerHolder {
  const script = scriptOf(card);
  return {
    card,
    controller,
    zone,
    isTrap: zone === "backrow" && isTrapCard(state, card),
    triggers: registeredTriggers(script, zone),
    script,
  };
}

/** One side's holders in R68's within-a-side order: unit lanes, backrow lanes, hand, graveyard. */
export function triggerHoldersOf(state: GameState, player: PlayerId): TriggerHolder[] {
  const side = state.players[player];
  const units = activeUnitsOf(state, player).map((card) => holderOf(state, card, "field", player));
  const backrow = slotsOf(player, "backrow").flatMap((ref) => {
    const card = cardAt(state, ref);
    return card === null ? [] : [holderOf(state, card, "backrow", player)];
  });
  const hand = side.hand.map((card) => holderOf(state, card, "hand", player));
  const graveyard = side.graveyard.map((card) => holderOf(state, card, "graveyard", player));
  return [...units, ...backrow, ...hand, ...graveyard];
}

/**
 * Every card that could answer, in R68's order: the active player's side first, then the
 * opponent's. Unfiltered — a card with no script keeps its place, so a caller can read the order
 * itself — so filter with `triggersOnEvent` or `triggerHoldersWithHook`.
 */
export function cardsInTriggerOrder(state: GameState): TriggerHolder[] {
  const sides: PlayerId[] = state.active === "p1" ? ["p1", "p2"] : ["p2", "p1"];
  return sides.flatMap((player) => triggerHoldersOf(state, player));
}

/**
 * The holder a card is right now, or null when its zone registers nothing: a library, exile or
 * resolving card, and a card dormant under a Stack, which does not act (§3.2, R13).
 */
export function triggerHolderFor(state: GameState, card: CardInstance): TriggerHolder | null {
  const zone = card.zone;
  if (zone.z === "hand") return holderOf(state, card, "hand", zone.player);
  if (zone.z === "graveyard") return holderOf(state, card, "graveyard", zone.player);
  if (zone.z !== "field") return null;
  if (zone.row === "backrow") return holderOf(state, card, "backrow", zone.player);
  const top = cardAt(state, { player: zone.player, row: zone.row, lane: zone.lane });
  if (top === null || top.id !== card.id) return null;
  return holderOf(state, card, "field", zone.player);
}

/** The holder's triggers that wake on this event type. */
export function triggersOnEvent(holder: TriggerHolder, type: GameEventType): readonly TriggerDef[] {
  return holder.triggers.filter((def) => def.on.includes(type));
}

/** Every card that answers this event type, in R68's order. Traps included: they fire first. */
export function triggerHoldersForEvent(state: GameState, type: GameEventType): TriggerHolder[] {
  return cardsInTriggerOrder(state).filter((holder) => triggersOnEvent(holder, type).length > 0);
}

/**
 * The registry keyed by hook: every card whose zone lets it carry that hook, in R68's order. `only`
 * narrows it to one controller, which is what start-of-turn and end-of-turn hooks need — they fire
 * on their own controller's turn alone (§6.2).
 *
 * R153 is the filter. This walk reaches the graveyard, which is how the `returnToHandAtEndOfTurn`
 * spells are found (R68) — but carrying a hook is not the same as being allowed to answer it, so a
 * card in a hand answers none and a card in a graveyard answers only that one return. Reading the
 * hook off the script alone was the bug: it let a Field Spell in a hand act on the board.
 */
export function triggerHoldersWithHook(
  state: GameState,
  hook: HookName,
  only?: PlayerId,
): TriggerHolder[] {
  const holders = only === undefined ? cardsInTriggerOrder(state) : triggerHoldersOf(state, only);
  return holders.filter(
    (holder) => holder.script[hook] !== undefined && zoneRegistersHook(state, holder, hook),
  );
}

// ---------------------------------------------------------------------------
// 2. The queue.
// ---------------------------------------------------------------------------

/**
 * The `step` a queued entry's resume carries. An entry is re-entered by trigger id or hook name,
 * never by step, so nothing reads this; writing it through `Resume["step"]` keeps the file out of
 * §10.6's decision on whether a step is a number or a named one.
 */
const TRIGGER_STEP = "trigger" as unknown as Resume["step"];

/**
 * `state.nextSeq` numbers a queue entry, as it numbers a modifier, a delayed effect and a parked
 * work item, so R68's creation order is one counter and ids stay deterministic under replay. The
 * `t` prefix keeps them apart from `prompts.ts`'s `q…` choice ids, which count on `nextId`.
 *
 * R177: except the entry of a card in a hand. The counter also numbers the modifiers, whose ids both
 * seats read (R169), so a number a hidden card took would show in them: #89 Corpse Eater answers
 * every death from its owner's hand, even one it gains nothing from (a token's, R11), and the next
 * modifier's id would then tell the opponent the hand holds one. Nothing orders or finds a queue
 * entry by its number, so a hand card's entry borrows the counter's current value without moving it,
 * told apart by the queue's length.
 */
function nextEntryId(state: GameState, hidden = false, prefix = "h"): { id: string; seq: number } {
  const seq = state.nextSeq;
  if (hidden) return { id: `${prefix}${seq}.${state.triggerQueue.length}`, seq };
  state.nextSeq += 1;
  return { id: `t${seq}`, seq };
}

/** The event a queue entry captured, or null for a hook entry, which answers no event. */
export function eventOfQueued(entry: QueuedTrigger): GameEvent | null {
  const captured: unknown = entry.resume.data.event;
  if (typeof captured !== "object" || captured === null) return null;
  const type: unknown = (captured as { type?: unknown }).type;
  return typeof type === "string" ? (captured as GameEvent) : null;
}

function owedTrapsOf(entry: QueuedTrigger): string[] {
  const owed: unknown = entry.resume.data.owed;
  return Array.isArray(owed) ? owed.filter((id): id is string => typeof id === "string") : [];
}

/** The field's departures when the dispatch an owed entry finishes began (`stays.exitMark`). */
function owedMarkOf(state: GameState, entry: QueuedTrigger): number {
  const mark: unknown = entry.resume.data.exitsFrom;
  return typeof mark === "number" ? mark : exitMark(state);
}

/**
 * Append one of a card's triggers to the queue, behind everything already waiting (R68).
 *
 * R174, R212: the entry carries the stays its event happened on — the mark a play's event was
 * emitted at (`stays.eventMark`), or the field's departures now, as it is dispatched — and the
 * trigger runs with that mark whenever it pops (`runQueuedTrigger`). A trigger aimed at the card its
 * event names, by the id it reads off the event, is aimed at that card's stay: an earlier trigger
 * on the same event that killed it, and the check between the two that let Reborn put a body back
 * (R59), leave the later one nothing to land on (R83).
 */
export function queueTrigger(
  sink: EngineSink,
  holder: TriggerHolder,
  def: TriggerDef,
  event: GameEvent,
): QueuedTrigger {
  const { id, seq } = nextEntryId(sink.state, holder.zone === "hand");
  const marks: RunMarks = { exitsFrom: eventMark(event) ?? exitMark(sink.state) };
  const entry: QueuedTrigger = {
    id,
    seq,
    instanceId: holder.card.id,
    hook: def.id,
    resume: {
      defId: holder.card.defId,
      hook: def.id,
      step: TRIGGER_STEP,
      radiant: holder.card.radiant,
      instanceId: holder.card.id,
      data: { event, zone: holder.zone, controller: holder.controller, [RUN_MARKS_KEY]: marks },
    },
  };
  sink.state.triggerQueue.push(entry);
  return entry;
}

/**
 * Append one of a card's hooks to the queue. §6.2 and R62 resolve start-of-turn and end-of-turn
 * hooks "in queue order", so queueing them gives them what an event trigger gets for free: a state
 * check between each two (R59), and a pause that keeps the rest of them in state.
 */
export function queueHook(sink: EngineSink, holder: TriggerHolder, hook: HookName): QueuedTrigger {
  const { id, seq } = nextEntryId(sink.state);
  const entry: QueuedTrigger = {
    id,
    seq,
    instanceId: holder.card.id,
    hook,
    resume: {
      defId: holder.card.defId,
      hook,
      step: TRIGGER_STEP,
      radiant: holder.card.radiant,
      instanceId: holder.card.id,
      data: { zone: holder.zone, controller: holder.controller },
    },
  };
  sink.state.triggerQueue.push(entry);
  return entry;
}

/**
 * Queue one hook across the board in R68's order (§6.2, R62). The caller runs `settle` to drain it,
 * which is what puts a state check between each two hooks and lets one that prompts pause the rest.
 */
export function queueHooksInTriggerOrder(
  sink: EngineSink,
  hook: HookName,
  only?: PlayerId,
): QueuedTrigger[] {
  return triggerHoldersWithHook(sink.state, hook, only).map((holder) =>
    queueHook(sink, holder, hook),
  );
}

/** Queue one hook across the board and resolve it, in R68's order (§6.2, R62, R59). */
export function runHooksInTriggerOrder(sink: SettleSink, hook: HookName, only?: PlayerId): void {
  queueHooksInTriggerOrder(sink, hook, only);
  settle(sink);
}

/**
 * Park an event the traps have not finished answering. `owed` names the traps that still have to
 * see it, so a resume neither re-fires one that already fired nor wakes a Field Trap twice (§5.1).
 * It goes in front of every queued card trigger, because a trap is a response (§10.3).
 */
function owedToTraps(sink: EngineSink, event: GameEvent, run: ImmediateDispatch): QueuedTrigger | null {
  const owed = run.owed;
  if (owed.length === 0) return null;
  const controllers: TrapControllers = {};
  for (const id of owed) {
    const player = run.controllers[id];
    if (player !== undefined) controllers[id] = player;
  }
  const state = sink.state;
  // R177: whether this entry exists at all hangs on which traps are still owed the event, and a
  // face-down one is read by its controller alone (R33) — a second #96 watches a declaration where
  // a Sheepish does not — so it takes no number from the counter the modifiers' ids come from.
  const { id, seq } = nextEntryId(state, true, "o");
  const entry: QueuedTrigger = {
    id,
    seq,
    instanceId: "",
    hook: OWED_TO_TRAPS,
    resume: {
      defId: "",
      hook: OWED_TO_TRAPS,
      step: TRIGGER_STEP,
      radiant: false,
      data: { event, owed: [...owed], exitsFrom: run.mark, controllers },
    },
  };
  const at = state.triggerQueue.findIndex((queued) => queued.hook !== OWED_TO_TRAPS);
  if (at < 0) state.triggerQueue.push(entry);
  else state.triggerQueue.splice(at, 0, entry);
  return entry;
}

/**
 * §10.3 step C: the traps see the event first and fire immediately, to completion. A prompt for a
 * trap's owner stops that dispatch — "pauses the opponent's action until answered" (BUILD M3-T2) —
 * so whatever the other traps are still owed is parked in state for the answer to finish: exactly
 * the traps the dispatch never reached (`traps.offerEventToTraps`), in its order. One that met the
 * event and declined it has had its look (R99), and is not owed it again.
 * R62's end-of-turn window is not an immediate dispatch at all: `turn.ts` fires those traps with
 * `traps.runTrapWindow` at the scheduled point, so `turnEnded` is passed over here.
 */
function offerToTraps(sink: EngineSink, event: GameEvent): QueuedTrigger | null {
  if (isTrapWindowEvent(event)) return null;
  // R212: the board the event happened on, read off the events owed behind it.
  const run = offerEventToTraps(sink, event, () => movesIn(eventsAfterDispatched(sink), sink.state));
  if (sink.state.result !== null) return null;
  if (sink.state.pending === null) return null;
  return owedToTraps(sink, event, run);
}

/**
 * Finish a trap dispatch a prompt interrupted, and park again if another trap prompts. Each trap
 * meets the event as the board now stands (`traps.standingEvent`, R174): a played card the answer to
 * an earlier trap's question killed is no longer in play for the next one, even though it died in a
 * later action than the dispatch began in (#85 fuses nothing out of a graveyard, R61).
 */
function runOwedTraps(sink: EngineSink, event: GameEvent, entry: QueuedTrigger): void {
  const run = resumeEventToTraps(
    sink,
    event,
    owedTrapsOf(entry),
    owedMarkOf(sink.state, entry),
    trapControllersOf(entry.resume.data.controllers),
  );
  if (sink.state.result !== null || sink.state.pending === null) return;
  owedToTraps(sink, event, run);
}

/**
 * R212: the events that happened after the one being dispatched — the rest of the frontier, and
 * whatever the traps that answered it have emitted since and the frontier has not collected yet. A
 * sink that never collected anything (a caller dispatching by hand) has nothing uncollected.
 */
function eventsAfterDispatched(sink: EngineSink): GameEvent[] {
  const upTo = (sink as SettleSink).dispatched ?? sink.events.length;
  // An event a loop on another sink over the same list has taken is in `state.dispatch` already, or
  // was dispatched before this one (`collected`).
  const uncollected = sink.events.slice(upTo).filter((event) => !collected.has(event));
  return [...sink.state.dispatch.map((item) => item.event), ...uncollected];
}

/**
 * Offer one event to the traps and then queue every other trigger that wakes on it, in R68's order
 * (§10.3 steps C and D). Queueing only reads the board, so this can never pause halfway through the
 * queueing itself — which is what makes the frontier safe to flush into state the instant a prompt
 * opens somewhere else.
 *
 * R212: the board an event is offered to is the board as it stood when the event happened, and the
 * events owed behind it say how the board has moved since. The loop dispatches an event after
 * whatever ran first — the state check a combat, an Echo repeat or a whole Cry is followed by (§4.5,
 * §10.3), and the Death hooks and Reborn inside it — so a card that has moved zones since the event
 * happened is on a stay that did not see it: a Reborn body does not answer the hit that killed the
 * unit or the kill its last stay made (R174), and a card drawn since answers no death from before it
 * reached the hand (§8 #89). A card whose controller has changed since answers for the player who
 * controlled it then: #32 Prem Panther's kill is its controller's as the kill happens, even when the
 * victim's Death then steals the Panther (#86).
 */
export function dispatchEvent(sink: EngineSink, event: GameEvent): QueuedTrigger[] {
  // R240, R63: a hit of 0 is a report (an absorbed fatigue draw), not a damage instance, and nothing
  // — no trap, no trigger — answers it.
  if (event.type === "damage" && event.amount <= 0) return [];
  const queued: QueuedTrigger[] = [];
  const owed = offerToTraps(sink, event);
  if (owed !== null) queued.push(owed);

  let later: LaterMoves | null = null;
  let uncovered: readonly string[] | null = null;
  for (const holder of cardsInTriggerOrder(sink.state)) {
    // §10.3: the traps have already had this event; queueing them too would fire them twice.
    if (holder.isTrap) continue;
    const defs = triggersOnEvent(holder, event.type);
    if (defs.length === 0) continue;
    later ??= movesIn(eventsAfterDispatched(sink), sink.state);
    if (later.moved.has(holder.card.id)) continue;
    // §3.2, R153: nor does the card the event's own removal uncovered in its Stack pile — dormant
    // when it happened, it resumed because of it, as a Reborn body returns because of a death.
    uncovered ??= uncoveredBy(sink.state, event);
    if (uncovered.includes(holder.card.id)) continue;
    // R119: a permanent that arrived on the field while the play resolved does not answer that play.
    if (arrivedDuringPlay(event).includes(holder.card.id)) continue;
    const controller = later.controllerBefore.get(holder.card.id) ?? holder.controller;
    for (const def of defs) {
      queued.push(queueTrigger(sink, { ...holder, controller }, def, event));
    }
  }
  return queued;
}

// ---------------------------------------------------------------------------
// 3. The loop.
// ---------------------------------------------------------------------------

/**
 * Apply one queued entry whole (§10.3 step A). The card is found again now rather than trusted
 * from queue time: it may have died, been played or moved while it waited, and a trigger its
 * current zone no longer registers fizzles instead of firing from the wrong zone (R78, R89).
 */
export function runQueuedTrigger(sink: EngineSink, entry: QueuedTrigger): void {
  const event = eventOfQueued(entry);
  if (entry.hook === OWED_TO_TRAPS) {
    if (event !== null) runOwedTraps(sink, event, entry);
    return;
  }

  const card = findInstance(sink.state, entry.instanceId);
  if (card === undefined) return;
  const holder = triggerHolderFor(sink.state, card);
  if (holder === null) return;

  if (event === null) {
    // A hook entry: §6.2's start-of-turn and end-of-turn triggers, queued in R68's order.
    const hook = TRIGGER_HOOKS.find((name) => name === entry.hook);
    if (hook === undefined || holder.script[hook] === undefined) return;
    // R153, and the same re-reading as a trigger above: a card the queue caught on the field and
    // that is in a hand or a graveyard by the time its entry pops no longer registers this hook.
    if (!zoneRegistersHook(sink.state, holder, hook)) return;
    // §6.2: a start- or end-of-turn hook is its CONTROLLER's, on its controller's own turn — which
    // is why the queue was built for one player (`triggerHoldersWithHook`'s `only`). A card that
    // changed sides while its entry waited (a Death earlier in the same queue stole it) is now the
    // other player's, on a turn that is not theirs, so the entry fizzles rather than firing for them.
    const queuedFor: unknown = entry.resume.data.controller;
    if (typeof queuedFor === "string" && holder.controller !== queuedFor) return;
    runHookResumable(sink, card, hook, { controller: holder.controller });
    return;
  }

  const def = queuedTriggerDef(holder, entry);
  if (def === undefined || !def.on.includes(event.type)) return;
  // R212: an event trigger answers for the player who controlled its card when the event happened,
  // which is what its entry captured — a change of control since does not hand the answer over.
  const queuedFor: unknown = entry.resume.data.controller;
  const controller = PLAYER_IDS.find((player) => player === queuedFor) ?? holder.controller;
  // R174, R212: the stays the event happened on, which the entry captured as it was queued.
  const marks = runMarksOf(entry.resume.data);
  const ctx = {
    ...makeContext(sink, card, { controller, data: cardData(entry.resume.data) }),
    ...(marks?.exitsFrom === undefined ? {} : { exitsFrom: marks.exitsFrom }),
    event,
  };
  // Resumable, so a prompt inside the list stops the list there instead of being stepped over. The
  // parked tail names the trigger's id as its hook, and `work.scriptStepFor` re-enters a trigger by
  // its id, rebuilding its list from the event the entry captured (R113); the answer itself goes to
  // the card's `resume` table, where every §6.3 choose effect sends it.
  //
  // §5.2, R113: the list is the face the card wears NOW (the context and `holder.triggers` read it),
  // and a paused list goes on in the list it began, so its tail is rebuilt from that same face and
  // definition — not the ones the entry recorded when it was queued, which an earlier trigger in the
  // same queue can have made Radiant since.
  const plan = { ...entry.resume, hook: def.id, defId: card.defId, radiant: card.radiant, owner: controller };
  applyResumable(sink, ctx, plan, def.run(ctx));
}

/**
 * The trigger a queue entry names, on the card as it stands now. R77 keeps the instance a Fuse
 * lands on — same card, same stay (`stays.movesIn` counts it as unmoved) — and R102 keeps its text,
 * but the fused definition namespaces each ingredient's trigger ids (`<ingredientDefId>:<id>`), so
 * an entry the card queued before the Fuse, under its old definition, is found under that
 * definition's namespace: Fed Fauci hit by the Cry that Unlicensed Experimentation then fused onto
 * it still owes its Plague Token (R212).
 */
function queuedTriggerDef(holder: TriggerHolder, entry: QueuedTrigger): TriggerDef | undefined {
  const exact = holder.triggers.find((candidate) => candidate.id === entry.hook);
  if (exact !== undefined) return exact;
  const namespaced = `${entry.resume.defId}:${entry.hook}`;
  return holder.triggers.find((candidate) => candidate.id === namespaced);
}

/**
 * §10.3 steps B to D without step G: the events emitted so far reach the traps, which fire at once
 * and to completion, and every other trigger they wake is queued — but nothing queued is popped, and
 * no owed work is drained. A trap's remainder a prompt left owed (`OWED_TO_TRAPS`) is a response, so
 * it is finished here, in front of everything. This is what a stage made of several whole effects in
 * a row needs between two of them: R62's delayed effects are each a whole effect (R59), and a trap
 * answering the first responds before the second resolves, while the triggers they wake wait for the
 * stage's own loop (R68). A cast's §10.5 step 4 is the same kind of point inside the effect that cast
 * it (R70): Sheepish answers a cast Unit there, before its Cry, and the effect's own loop keeps the
 * rest. Stops at a prompt, leaving the rest owed in state.
 */
export function dispatchPending(sink: SettleSink): void {
  for (let pass = 0; pass < SETTLE_PASS_CAP; pass += 1) {
    dispatchNewEvents(sink);
    if (sink.state.pending !== null || sink.state.result !== null) return;
    // An unfinished trap dispatch is the only thing that holds the frontier back, and its entry is at
    // the head of the queue (`owedToTraps`); anything else there waits for the stage's loop.
    const head = sink.state.triggerQueue[0];
    if (head === undefined || head.hook !== OWED_TO_TRAPS) return;
    sink.state.triggerQueue.shift();
    runQueuedTrigger(sink, head);
  }
  throw new Error(`the trap dispatch did not settle in ${SETTLE_PASS_CAP} passes (§10.3)`);
}

/**
 * The sink the loop runs on. `dispatched` counts how many of this action's `events` have been taken
 * into `state.dispatch`: a copy position in the sink's own array, and nothing more. What is *owed*
 * is the frontier in state, never this number — an action that returns paused has already handed
 * every event it emitted to `state.dispatch`, so the answer action finishes the dispatch (§9.3,
 * §10.1, R122). Keeping the frontier itself here was the hole the M3 review's B-2 and B-3 found.
 */
export type SettleSink = EngineSink & { dispatched?: number };

/**
 * Events some other resolution loop has already dispatched, by object identity. #96 My Pawn's AI turn
 * drives `reduce` once per action, and each of those settles its own events before the playout
 * copies them onto the enclosing action's list so the client is told about them (R168); the
 * enclosing loop must not hand them to the traps and the trigger queue again (§10.3: an event is
 * offered once), or every trigger of the AI turn fires twice. A `WeakSet` holds no game state and
 * outlives nothing it names: the events are the enclosing action's own objects, collected within
 * that same action.
 */
const dispatchedElsewhere = new WeakSet<GameEvent>();

/** Mark events a nested `reduce` has already dispatched (see `dispatchedElsewhere`). */
export function markDispatched(events: readonly GameEvent[]): void {
  for (const event of events) dispatchedElsewhere.add(event);
}

/**
 * Events already taken into `state.dispatch`, by object identity. `dispatched` is a position in one
 * sink's copy of the list, and a loop can run on a sink other than the action's own over the same
 * array: a cast's §10.5 step-4 window (R70) runs inside an effect, whose context is the only sink it
 * has (`effects/draw`, #95), and that context has no position of its own. An event is taken into
 * the frontier once, whichever sink reaches it first. Like `dispatchedElsewhere`, it holds no game
 * state: the events are the running action's own objects.
 */
const collected = new WeakSet<GameEvent>();

/**
 * §10.1: an emitted event joins the frontier — "events still owed to the traps and the trigger
 * queue" — in emission order, with an id and `seq` from `state.nextSeq` (R68's one counter), so the
 * frontier a replay builds is the frontier the live game had.
 */
function collectEvents(sink: SettleSink): void {
  const state = sink.state;
  for (let at = sink.dispatched ?? 0; at < sink.events.length; at += 1) {
    sink.dispatched = at + 1;
    const event = sink.events[at];
    if (event === undefined) continue;
    if (dispatchedElsewhere.has(event) || collected.has(event)) continue;
    collected.add(event);
    const seq = state.nextSeq;
    state.nextSeq += 1;
    state.dispatch.push({ id: `e${seq}`, seq, event });
  }
}

/** Whether an event's own trap dispatch is unfinished, so the frontier may not advance (§10.3). */
function trapsStillOwed(state: GameState): boolean {
  return state.triggerQueue.some((entry) => entry.hook === OWED_TO_TRAPS);
}

/**
 * Turn the frontier into trap firings and queue entries (§10.3 steps B, C, D), oldest event first,
 * taking each event off `state.dispatch` before offering it so no event is ever offered twice.
 *
 * The frontier stops advancing while the event at its head cannot be finished: a prompt is open (or
 * the game is over), or the previous event's traps have not all seen it — an `OWED_TO_TRAPS` entry
 * says so, and `settle` pops that before this runs again. Both cases are the same rule: the traps
 * see the events in the order they were emitted, so a later event waits in state rather than
 * jumping the queue or, as it did while the frontier lived on the sink, being dropped on a pause.
 */
function dispatchNewEvents(sink: SettleSink): void {
  // Collect first and unconditionally, so a pause below leaves nothing owed on the sink (§9.3).
  collectEvents(sink);
  while (sink.state.dispatch.length > 0) {
    if (sink.state.pending !== null || sink.state.result !== null) return;
    if (trapsStillOwed(sink.state)) return;
    const next = sink.state.dispatch.shift();
    if (next !== undefined) dispatchEvent(sink, next.event);
    collectEvents(sink);
  }
}

/**
 * The resolution loop of §10.3: dispatch, drain parked work, state check, pop one trigger, repeat
 * until the queue is empty and no prompt is open. Call it after any action, after any answer, and
 * anywhere §2.2 opens a window — the end-of-turn trap window is just the `turnEnded` event reaching
 * `traps.runTrapWindow`, and R62's delayed effects are `turn.ts`'s, on either side of it.
 *
 * Safe to call more than once on the same sink, and safe to call on a fresh sink over a state a
 * previous action left mid-dispatch: `dispatched` keeps this sink from copying an event twice, and
 * `state.dispatch` holds the events still owed, so nothing is offered twice and nothing is skipped.
 */
export function settle(sink: SettleSink, options: SettleOptions = {}): void {
  // §4.5: the check follows something that resolved. Held, it waits until this loop has resolved a
  // piece of owed work or a queued trigger (a trap runs its own check as it fires, `traps.fireTrap`).
  let checkDue = options.holdCheck !== true;
  for (let pass = 0; pass < SETTLE_PASS_CAP; pass += 1) {
    // First, so a pause below leaves nothing owed on the sink (§9.3).
    dispatchNewEvents(sink);
    if (sink.state.result !== null) return;
    // Waiting on an answer: the queue keeps its place and the `answer` action settles again.
    if (sink.state.pending !== null) return;

    // A sequence a prompt interrupted finishes before the queue moves on: it is inside the trigger
    // that is already running (§10.6).
    if (sink.state.work.length > 0) {
      const parked = sink.state.work.length;
      drainWork(sink);
      checkDue = true;
      if (sink.state.work.length < parked) continue;
    }

    if (checkDue) {
      const emitted = sink.events.length;
      stateCheck(sink);
      if (sink.state.result !== null) return;
      // Deaths, Reborn and Death triggers spoke: their events are dispatched before anything pops.
      if (sink.events.length > emitted) continue;
    }

    const next = sink.state.triggerQueue.shift();
    if (next === undefined) return;
    runQueuedTrigger(sink, next);
    checkDue = true;
  }
  throw new Error(`the resolution loop did not settle in ${SETTLE_PASS_CAP} passes (§10.3)`);
}

export type SettleOptions = {
  /**
   * §10.5 step 4's loop, which runs so that a trap answering the play (Sheepish) fires before the
   * Cry (R17). Nothing has resolved yet when it starts — the play resolves at step 5 — and §4.5 runs
   * the state check "after every resolved action, every fully resolved effect or trigger … and every
   * combat", so this loop runs it only once something has: a trap (which checks as it fires), owed
   * work, or a queued trigger. A card that arrives at 0 or less health — a 6/1 Bigot under #46
   * Suppressive Aura — therefore still resolves its Cry, and the check after step 6 collects it:
   * R118 loses the Cry only where a trap has taken the card off the field.
   */
  holdCheck?: boolean;
};
